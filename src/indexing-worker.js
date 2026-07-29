/**
 * indexing-worker.js — Dedicated Worker Thread for SoundVault audio indexing
 *
 * Two-pass architecture:
 *   Pass 1 (index-clap):     CLAP inference with strategic sampling for long files
 *                             Short files (≤10s): 1 inference. Long: 3-5 segments + mean-pooling.
 *   Pass 2 (index-spectral): 30s decode + spectral extract, incremental CMVN stats.
 *
 * Main thread sends passes sequentially. After CLAP pass, it reloads the
 * search cache so semantic search works while spectral is still running.
 */

const { parentPort } = require('worker_threads');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

// ═══ State ═══
let processor = null;
let audioModel = null;
let db = null;
let stmts = null;
let fingerprinter = null;
let compressMatrixFn = null;
let ffmpegModule = null;

// ═══ Audio extraction (fluent-ffmpeg, sequential) ═══
// Handles fluent-ffmpeg race condition: the PassThrough stream 'close' event
// can fire before ffmpeg's 'exit' event, causing a spurious "Output stream closed"
// error even though all audio data was already collected in chunks[].
function getAudioData(filePath, maxDuration = 10) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let settled = false;

        const doResolve = () => {
            if (settled) return;
            const buf = Buffer.concat(chunks);
            if (buf.byteLength < 4) { settled = true; reject(new Error('No audio data')); return; }
            settled = true;
            resolve(new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4));
        };

        ffmpegModule(filePath)
            .duration(maxDuration)
            .audioFrequency(48000)
            .audioChannels(1)
            .format('f32le')
            .on('error', (err) => {
                // Race condition: "Output stream closed" fires after all data
                // has been piped but before ffmpeg process exits. Data is complete.
                if (err.message && err.message.includes('Output stream closed')) {
                    doResolve();
                    return;
                }
                if (!settled) { settled = true; reject(err); }
            })
            .on('end', () => {
                doResolve();
            })
            .pipe()
            .on('data', chunk => chunks.push(chunk));
    });
}

// ═══ Initialization ═══
async function initWorker(dbPath, ffmpegPath, cacheDir) {
    console.log('[IndexWorker] Initializing...');
    const t0 = Date.now();

    // Set up ffmpeg (path received from main thread)
    ffmpegModule = require('fluent-ffmpeg');
    ffmpegModule.setFfmpegPath(ffmpegPath);
    console.log(`[IndexWorker] ffmpeg: ${ffmpegPath}`);

    // Load spectral engine
    const spectralEngine = require('./spectral-engine');
    fingerprinter = new spectralEngine.SpectralFingerprinter();
    compressMatrixFn = spectralEngine.compressMatrix;

    // Open DB connection with WAL
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('cache_size = -32000');
    db.pragma('temp_store = MEMORY');

    db.exec(`
        CREATE TABLE IF NOT EXISTS peaks_cache (
            file_path TEXT PRIMARY KEY,
            mtime INTEGER,
            peaks BLOB,
            duration_ms INTEGER
        )
    `);

    stmts = {
        insertEmbedding: db.prepare('INSERT OR REPLACE INTO embeddings (file_path, mtime, vector) VALUES (?, ?, ?)'),
        insertSpectral:  db.prepare('INSERT OR REPLACE INTO spectral_index (file_path, mtime, feature_matrix, summary_vector, duration_ms, window_count) VALUES (?, ?, ?, ?, ?, ?)'),
        insertPeaks:     db.prepare('INSERT OR REPLACE INTO peaks_cache (file_path, mtime, peaks, duration_ms) VALUES (?, ?, ?, ?)'),
    };

    // Load CLAP audio model — FP32 is FASTER than INT8 on CPUs without VNNI (i5-9400)
    // Benchmark: FP32 ~145ms vs INT8 ~250ms per inference (DequantizeLinear overhead)
    // This worker has its OWN transformers module instance (separate module
    // registry from the main thread), so the cacheDir received via the init
    // message MUST be applied here before any from_pretrained call (audit C2).
    // When packaged, allowRemoteModels=false makes it strictly offline: the
    // bundled model ships inside resources/models.
    const { env, AutoProcessor, ClapAudioModelWithProjection } = require('@xenova/transformers');
    if (cacheDir) {
        env.cacheDir = cacheDir;
        env.allowRemoteModels = false;
        // Same as the main thread: keep localModelPath off the asar-internal
        // default to avoid malformed <models>/<app.asar> probe paths.
        env.localModelPath = cacheDir;
    }
    console.log('[IndexWorker] Loading CLAP audio model (FP32)...');
    processor = await AutoProcessor.from_pretrained('Xenova/clap-htsat-unfused');
    audioModel = await ClapAudioModelWithProjection.from_pretrained('Xenova/clap-htsat-unfused', { quantized: false });

    console.log(`[IndexWorker] Ready in ${Date.now() - t0}ms`);
}

/**
 * Select strategic sample offsets for CLAP inference on long files.
 * Instead of exhaustive sliding window (5s hop → 23 chunks for 2min),
 * picks equidistant segments to capture semantic diversity.
 *
 * @param {number} totalSamples - Total samples in decoded audio
 * @param {number} windowSize - CLAP window size in samples (480000 = 10s at 48kHz)
 * @returns {number[]} Array of sample offsets to extract
 */
function selectClapOffsets(totalSamples, windowSize) {
    if (totalSamples <= windowSize) return [0];

    // Determine number of segments based on file length
    const fileDurationS = totalSamples / 48000;
    let numSegments;
    if (fileDurationS <= 30) {
        numSegments = 3;  // start, center, end
    } else {
        numSegments = 5;  // start, q1, center, q3, end
    }

    const maxOffset = totalSamples - windowSize;
    const offsets = [];
    for (let i = 0; i < numSegments; i++) {
        const offset = Math.round(maxOffset * i / (numSegments - 1));
        offsets.push(offset);
    }
    return offsets;
}

// ═══ Pass 1: CLAP indexing ═══
// Files ≤10s: single CLAP inference. Files >10s: strategic sampling + mean-pooling.
async function processClapBatch(files) {
    const BATCH_SIZE = 50;
    const CLAP_WINDOW = 48000 * 10;  // 10s at 48kHz
    const MAX_DECODE_S = 120;        // Decode up to 120s for sampling
    const DIM = 512;                 // CLAP embedding dim
    let batch = [];
    let processed = 0;

    const flushBatch = () => {
        db.transaction(() => {
            for (const item of batch) stmts.insertEmbedding.run(item.path, item.mtime, item.vector);
        })();
        batch = [];
    };

    for (const file of files) {
        try {
            // Decode enough audio to cover chunking (up to MAX_DECODE_S)
            const audioData = await getAudioData(file.path, MAX_DECODE_S);
            const totalSamples = audioData.length;

            let finalVector;

            if (totalSamples <= CLAP_WINDOW) {
                // Short file — single CLAP inference (fast path)
                const inputs = await processor(audioData);
                const { audio_embeds } = await audioModel(inputs);
                finalVector = new Float32Array(audio_embeds.data);
            } else {
                // Long file — strategic sampling + mean-pooling
                const offsets = selectClapOffsets(totalSamples, CLAP_WINDOW);
                const meanPool = new Float32Array(DIM);

                for (const offset of offsets) {
                    const chunk = audioData.subarray(offset, offset + CLAP_WINDOW);
                    const inputs = await processor(chunk);
                    const { audio_embeds } = await audioModel(inputs);
                    const embed = audio_embeds.data;

                    for (let d = 0; d < DIM; d++) {
                        meanPool[d] += embed[d];
                    }
                }

                // Average
                const numChunks = offsets.length;
                for (let d = 0; d < DIM; d++) meanPool[d] /= numChunks;

                // L2-normalize
                let norm = 0;
                for (let d = 0; d < DIM; d++) norm += meanPool[d] * meanPool[d];
                norm = Math.sqrt(norm) || 1;
                for (let d = 0; d < DIM; d++) meanPool[d] /= norm;

                finalVector = meanPool;
                if (numChunks > 1) {
                    console.log(`[IndexWorker] CLAP mean-pooled: ${numChunks} segments for ${path.basename(file.path)} (${(totalSamples/48000).toFixed(1)}s)`);
                }
            }

            const vectorBuf = Buffer.from(finalVector.buffer, finalVector.byteOffset, finalVector.byteLength);
            batch.push({ path: file.path, mtime: file.mtime, vector: vectorBuf });

            if (batch.length >= BATCH_SIZE) flushBatch();
        } catch (e) {
            console.error(`[IndexWorker] CLAP error ${path.basename(file.path)}: ${e.message}`);
        }

        processed++;
        if (processed % 10 === 0) {
            parentPort.postMessage({ type: 'progress', current: processed, total: files.length });
        }
    }
    if (batch.length > 0) flushBatch();
    parentPort.postMessage({ type: 'progress', current: processed, total: files.length });
}

// ═══ Tier 0: Quick CLAP (single inference, first 10s only) ═══
// No chunking — always uses first 10s regardless of file duration.
// Purpose: get functional semantic search ASAP.
async function processClapQuickBatch(files) {
    const BATCH_SIZE = 50;
    const CLAP_WINDOW = 48000 * 10;
    const DIM = 512;
    let batch = [];
    let processed = 0;

    const flushBatch = () => {
        db.transaction(() => {
            for (const item of batch) stmts.insertEmbedding.run(item.path, item.mtime, item.vector);
        })();
        batch = [];
    };

    for (const file of files) {
        try {
            // Always decode only first 10s — fast path
            const audioData = await getAudioData(file.path, 10);
            const clapAudio = audioData.subarray(0, Math.min(audioData.length, CLAP_WINDOW));

            const inputs = await processor(clapAudio);
            const { audio_embeds } = await audioModel(inputs);
            const finalVector = new Float32Array(audio_embeds.data);

            const vectorBuf = Buffer.from(finalVector.buffer, finalVector.byteOffset, finalVector.byteLength);
            batch.push({ path: file.path, mtime: file.mtime, vector: vectorBuf });

            if (batch.length >= BATCH_SIZE) flushBatch();
        } catch (e) {
            console.error(`[IndexWorker] Quick CLAP error ${path.basename(file.path)}: ${e.message}`);
        }

        processed++;
        if (processed % 10 === 0) {
            parentPort.postMessage({ type: 'progress', current: processed, total: files.length });
        }
    }
    if (batch.length > 0) flushBatch();
    parentPort.postMessage({ type: 'progress', current: processed, total: files.length });
}

// ═══ Pass 2: Spectral-only indexing ═══
// 30s decode + spectral extraction (RAW — no per-file normalization).
// Accumulates running sum/sumSq for global CMVN stats.
async function processSpectralBatch(files) {
    const BATCH_SIZE = 50;
    const spectralEngine = require('./spectral-engine');
    const FPW = spectralEngine.FEATURES_PER_WINDOW;  // 44 (13 MFCC + 13 Δ + 13 ΔΔ + 5 spectral)
    let batch = [];
    let processed = 0;

    // ── Running statistics for Global CMVN ──
    const sumPerDim = new Float64Array(FPW);
    const sumSqPerDim = new Float64Array(FPW);
    let totalWindows = 0;

    // Create spectral_stats table if not exists
    db.exec(`
        CREATE TABLE IF NOT EXISTS spectral_stats (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            global_mean BLOB,
            global_std BLOB,
            total_windows INTEGER,
            running_sum BLOB,
            running_sum_sq BLOB,
            computed_at INTEGER
        )
    `);

    // Cargar running stats previos de la DB (si existen)
    const prevStats = db.prepare('SELECT running_sum, running_sum_sq, total_windows FROM spectral_stats WHERE id = 1').get();
    if (prevStats && prevStats.running_sum && prevStats.running_sum_sq) {
        const prevSum = new Float64Array(prevStats.running_sum.buffer, prevStats.running_sum.byteOffset, prevStats.running_sum.byteLength / 8);
        const prevSumSq = new Float64Array(prevStats.running_sum_sq.buffer, prevStats.running_sum_sq.byteOffset, prevStats.running_sum_sq.byteLength / 8);
        for (let d = 0; d < FPW; d++) {
            sumPerDim[d] = prevSum[d];
            sumSqPerDim[d] = prevSumSq[d];
        }
        totalWindows = prevStats.total_windows || 0;
    }

    const flushBatch = () => {
        db.transaction(() => {
            for (const item of batch) {
                stmts.insertSpectral.run(
                    item.path, item.mtime, item.matrix, item.summary, item.durationMs, item.windowCount
                );
                stmts.insertPeaks.run(item.path, item.mtime, item.peaksBuf, item.durationMs);
            }
        })();
        batch = [];
    };

    for (const file of files) {
        try {
            const audioData = await getAudioData(file.path, 30); // 30s for spectral
            // extractRaw — no per-file normalization
            const { matrix, numWindows } = fingerprinter.extractRaw(audioData, 48000);
            const summary = fingerprinter.computeSummary(matrix, numWindows);
            const durationMs = Math.round(audioData.length / 48000 * 1000);

            // Extract peaks while we have the decoded audio in memory
            const NUM_PEAKS = 4000;
            const spp = Math.max(1, Math.floor(audioData.length / NUM_PEAKS));
            const peaksArr = new Float32Array(NUM_PEAKS);
            for (let i = 0; i < NUM_PEAKS; i++) {
                let max = 0;
                const off = i * spp;
                for (let j = 0; j < spp && off + j < audioData.length; j++) {
                    const v = Math.abs(audioData[off + j]);
                    if (v > max) max = v;
                }
                peaksArr[i] = max;
            }
            const peaksBuf = Buffer.from(peaksArr.buffer, peaksArr.byteOffset, peaksArr.byteLength);

            // ── Accumulate running stats for global CMVN ──
            for (let w = 0; w < numWindows; w++) {
                const off = w * FPW;
                for (let d = 0; d < FPW; d++) {
                    const v = matrix[off + d];
                    sumPerDim[d] += v;
                    sumSqPerDim[d] += v * v;
                }
            }
            totalWindows += numWindows;

            batch.push({
                path: file.path,
                mtime: file.mtime,
                matrix: compressMatrixFn(matrix),
                summary: Buffer.from(summary.buffer, summary.byteOffset, summary.byteLength),
                durationMs,
                windowCount: numWindows,
                peaksBuf, // ← NEW
            });

            if (batch.length >= BATCH_SIZE) flushBatch();
        } catch (e) {
            console.error(`[IndexWorker] Spectral error ${path.basename(file.path)}: ${e.message}`);
        }

        processed++;
        if (processed % 10 === 0) {
            parentPort.postMessage({ type: 'progress', current: processed, total: files.length });
        }
    }
    if (batch.length > 0) flushBatch();
    parentPort.postMessage({ type: 'progress', current: processed, total: files.length });

    // ── Persist incremental CMVN stats ──
    if (totalWindows > 0) {
        const { mean, std } = spectralEngine.computeGlobalStats(sumPerDim, sumSqPerDim, totalWindows);
        const meanBuf = Buffer.from(mean.buffer, mean.byteOffset, mean.byteLength);
        const stdBuf = Buffer.from(std.buffer, std.byteOffset, std.byteLength);
        const sumBuf = Buffer.from(sumPerDim.buffer, sumPerDim.byteOffset, sumPerDim.byteLength);
        const sumSqBuf = Buffer.from(sumSqPerDim.buffer, sumSqPerDim.byteOffset, sumSqPerDim.byteLength);

        const insertStats = db.prepare(
            'INSERT OR REPLACE INTO spectral_stats (id, global_mean, global_std, total_windows, running_sum, running_sum_sq, computed_at) VALUES (1, ?, ?, ?, ?, ?, ?)'
        );
        insertStats.run(meanBuf, stdBuf, totalWindows, sumBuf, sumSqBuf, Date.now());
        console.log(`[IndexWorker] CMVN stats updated incrementally: ${totalWindows} total windows`);
    }
}

// ═══ Message handler ═══
parentPort.on('message', async (msg) => {
    if (msg.type === 'init') {
        try {
            await initWorker(msg.dbPath, msg.ffmpegPath, msg.cacheDir);
            parentPort.postMessage({ type: 'ready' });
        } catch (e) {
            console.error('[IndexWorker] Init error:', e);
            parentPort.postMessage({ type: 'error', error: e.message });
        }
    }

    if (msg.type === 'index-clap') {
        try {
            const t0 = Date.now();
            await processClapBatch(msg.files);
            const rate = Math.round(msg.files.length / (Date.now() - t0) * 60000);
            console.log(`[IndexWorker] CLAP pass: ${msg.files.length} files, ${rate} files/min`);
            parentPort.postMessage({ type: 'batch-complete', rate: String(rate) });
        } catch (e) {
            parentPort.postMessage({ type: 'error', error: e.message });
        }
    }

    if (msg.type === 'index-clap-quick') {
        try {
            const t0 = Date.now();
            await processClapQuickBatch(msg.files);
            const rate = Math.round(msg.files.length / (Date.now() - t0) * 60000);
            console.log(`[IndexWorker] Quick CLAP pass: ${msg.files.length} files, ${rate} files/min`);
            parentPort.postMessage({ type: 'batch-complete', rate: String(rate) });
        } catch (e) {
            parentPort.postMessage({ type: 'error', error: e.message });
        }
    }

    if (msg.type === 'index-spectral') {
        try {
            const t0 = Date.now();
            await processSpectralBatch(msg.files);
            const rate = Math.round(msg.files.length / (Date.now() - t0) * 60000);
            console.log(`[IndexWorker] Spectral pass: ${msg.files.length} files, ${rate} files/min`);
            parentPort.postMessage({ type: 'batch-complete', rate: String(rate) });
        } catch (e) {
            parentPort.postMessage({ type: 'error', error: e.message });
        }
    }

    if (msg.type === 'shutdown') {
        if (db) db.close();
        process.exit(0);
    }
});
