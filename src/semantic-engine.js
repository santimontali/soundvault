const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');

const { app } = require('electron');
const { Worker } = require('worker_threads');

const { 
    env,
    AutoTokenizer, 
    AutoProcessor, 
    ClapTextModelWithProjection, 
    ClapAudioModelWithProjection
} = require('@xenova/transformers');

// Configure ONNX WASM to use all available CPU cores for tensor math
env.backends.onnx.wasm.numThreads = Math.max(1, os.cpus().length - 1);

const {
    SpectralFingerprinter,
    LRUFeatureCache,
    findBestSegment,
    compressMatrix,
    decompressMatrix,
    buildFeatureWeights,
    applyGlobalNorm,
    FEATURES_PER_WINDOW,
    HOP_SIZE,
    SAMPLE_RATE: SPECTRAL_SR,
} = require('./spectral-engine');

// Pure cosine top-K + similarity-threshold primitives (Phase 2.2 refactor).
// The engine delegates its brute-force ranking here so the math is unit-
// testable in plain Node (tests/vector-search.test.js) without the CLAP model.
const { bruteCosineTopK, applyThreshold } = require('./search/vector-search');

// Packaged-app safe ffmpeg path: child_process.spawn cannot execute binaries
// from inside an asar archive; resolveFfmpegPath rewrites app.asar→
// app.asar.unpacked when packaged and is a no-op in dev. See
// src/packaging/ffmpeg-path.js (pure, unit-tested).
const { resolveFfmpegPath } = require('./packaging/ffmpeg-path');
const ffmpegPath = resolveFfmpegPath(ffmpegStatic);
ffmpeg.setFfmpegPath(ffmpegPath);

// Model cache wiring for packaged installs (audit C2): the CLAP model ships
// bundled under resources/models via electron-builder extraResources. Without
// this, @xenova/transformers defaults its cache into app.asar and either
// re-downloads 592 MB on every launch or stalls offline. `allowRemoteModels`
// is only locked when packaged — dev keeps the normal download-on-first-use.
if (app && app.isPackaged) {
    env.cacheDir = path.join(process.resourcesPath, 'models');
    env.allowRemoteModels = false;
    // Keep localModelPath off the asar-internal default — otherwise
    // FileCache.match probes `<models>/<absolute app.asar path>` on every
    // model file load (benign but noisy stderr warnings from Electron's asar
    // interceptor). Point it at the real bundled dir.
    env.localModelPath = env.cacheDir;
}

const DIM = 512; // CLAP embedding dimensionality
const HNSW_THRESHOLD = 50000; // Build HNSW index when vectors exceed this count

// ═══ Optional HNSW (graceful fallback if native build unavailable) ═══
let HierarchicalNSW = null;
try {
    HierarchicalNSW = require('hnswlib-node').HierarchicalNSW;
    console.log('[SemanticEngine] HNSW acceleration available');
} catch (e) {
    console.log('[SemanticEngine] HNSW not available — using brute-force search (still fast for <50k vectors)');
}

class SemanticEngine {
    constructor() {
        this.db = null;
        this._dbPath = null;
        this.textModel = null;
        this.audioModel = null;
        this.tokenizer = null;
        this.processor = null;
        this.isReady = false;
        this.isIndexing = false;
        this.progress = { total: 0, current: 0 };

        // ═══ Flat Vector Cache ═══
        // All embeddings live in a single contiguous Float32Array for cache-friendly iteration
        this._paths = [];           // parallel array: _paths[i] = file_path of vector i
        this._matrix = null;        // Float32Array of length _count * DIM
        this._count = 0;            // number of vectors currently cached
        this._capacity = 0;         // allocated capacity (in vectors)
        this._pathIndex = new Map();

        // ═══ Echo Vault — Spectral Engine ═══
        this._fingerprinter = new SpectralFingerprinter();
        this._spectralCache = new LRUFeatureCache(2000);
        this._spectralReady = false;
        this._spectralProgress = { total: 0, current: 0 };

        // Spectral summary vectors for coarse filter (short-fragment fallback)
        // Flat Float32Array: _summaryMatrix[i * FEATURES_PER_WINDOW .. (i+1) * FEATURES_PER_WINDOW - 1]
        this._summaryPaths = [];    // parallel array
        this._summaryMatrix = null;
        this._summaryCount = 0;
        this._summaryPathIndex = new Map();

        // ═══ HNSW Index (Phase 6) ═══
        this._hnsw = null;      // Built lazily when vector count > HNSW_THRESHOLD
        this._hnswCount = 0;    // snapshot count the current index was built from
        this._hnswBuilding = false; // build-in-progress guard (coalesces requests)

        // ── Similarity threshold (Phase 2.2) ──
        // Cosine floor for `search()` results; 0 = disabled (preserves legacy
        // "always top-200" behaviour). Tune at runtime without touching code:
        //   SOUNVAULT_SEMANTIC_THRESHOLD=0.15 npm start
        this._similarityThreshold = parseFloat(process.env.SOUNVAULT_SEMANTIC_THRESHOLD || '0');

        // ═══ File Watcher (Phase C) ═══
        this._watcher = null;
        this._indexQueue = [];
        this._indexTimer = null;
        this._indexWorker = null;

        // ═══ Global CMVN Stats ═══
        this._globalMean = null;  // Float32Array(18) or null
        this._globalStd = null;   // Float32Array(18) or null
    }

    // ── Cache Management ──────────────────────────────────────────────
    _ensureCapacity(needed) {
        if (needed <= this._capacity) return;
        const newCap = Math.max(needed, this._capacity * 2, 1024);
        const newBuf = new Float32Array(newCap * DIM);
        if (this._matrix) newBuf.set(this._matrix.subarray(0, this._count * DIM));
        this._matrix = newBuf;
        this._capacity = newCap;
    }

    _appendToCache(filePath, vectorBuffer) {
        // Root-cause fix for the "explorer shows the same file twice" bug.
        // Previously this method blindly `push()`ed `filePath` on every call,
        // so a watcher-triggered re-index of an already-cached file appended
        // a SECOND row to `_paths`/`_matrix` with a freshly re-computed vector.
        // The DB stayed deduped (`INSERT OR REPLACE` + `UNIQUE` at the call
        // site), but the in-memory cache diverged — and `_searchFlat`/`_paths`
        // fed both rows to the renderer as duplicate result entries.
        //
        // Now: if `filePath` already has a row, REPLACE its vector in place and
        // leave `_count`/`_paths.length` unchanged. The O(N) `indexOf` cost is
        // bounded — this method is only called from `_indexFileFull`, which is
        // only invoked by the file watcher's 3 s-debounced queue (one file at
        // a time); the bulk indexer path uses the worker + `_loadCacheFromDB`
        // full reset, never this method.
        const existing = this._pathIndex.has(filePath) ? this._pathIndex.get(filePath) : -1;
        const vec = new Float32Array(vectorBuffer.buffer, vectorBuffer.byteOffset, vectorBuffer.byteLength / 4);
        if (existing !== -1) {
            this._matrix.set(vec, existing * DIM);
            return;
        }
        this._ensureCapacity(this._count + 1);
        this._matrix.set(vec, this._count * DIM);
        this._paths.push(filePath);
        this._count++;
        this._pathIndex.set(filePath, this._count - 1);
    }

    _loadCacheFromDB() {
        const rows = this._stmts.selectAllEmbeddings.all();

        this._paths = [];
        this._count = 0;
        this._ensureCapacity(rows.length);

        for (const row of rows) {
            const vec = new Float32Array(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength / 4);
            this._matrix.set(vec, this._count * DIM);
            this._paths.push(row.file_path);
            this._count++;
        }
        this._pathIndex = new Map();
        for (let i = 0; i < this._count; i++) this._pathIndex.set(this._paths[i], i);
        console.log(`[SemanticEngine] Cache loaded: ${this._count} vectors (${(this._count * DIM * 4 / 1048576).toFixed(1)} MB)`);

        // Build HNSW index if library is large enough
        this._buildHNSW();
    }

    // ── HNSW Index Builder ────────────────────────────────────────────
    // Builds ASYNCHRONOUSLY in event-loop slices so a >50k library never
    // freezes the main thread (a synchronous 70k build measured ~72s — a full
    // UI freeze). While the build runs (or no index exists), `_searchFlat`
    // transparently uses brute-force; the finished index hot-swaps in.
    // The build works on a snapshot (count + matrix reference): if the cache
    // mutates mid-build, the stale build is discarded and restarted.
    _buildHNSW() {
        if (!HierarchicalNSW || this._count < HNSW_THRESHOLD) {
            this._hnsw = null;
            this._hnswCount = 0;
            return;
        }
        if (this._hnswBuilding) return;

        const dbStat = fs.statSync(this._dbPath);
        const cacheKey = this._count + ':' + dbStat.mtimeMs;
        const hnswPath = path.join(path.dirname(this._dbPath), 'soundvault-hnsw.idx');

        const count = this._count;
        const matrix = this._matrix;

        if (fs.existsSync(hnswPath)) {
            try {
                const index = new HierarchicalNSW('ip', DIM);
                index.readIndex(hnswPath);
                index.setEf(200);
                let storedKey = '';
                try { storedKey = fs.readFileSync(hnswPath + '.key', 'utf8'); } catch(e) {}
                if (index.getCurrentCount() === count && storedKey === cacheKey) {
                    this._hnsw = index;
                    this._hnswCount = count;
                    console.log(`[SemanticEngine] HNSW index loaded from disk: ${count} vectors`);
                    return;
                }
            } catch(e) {}
        }

        const t0 = Date.now();
        this._hnswBuilding = true;

        (async () => {
            try {
                const index = new HierarchicalNSW('ip', DIM);
                index.initIndex(count, 16, 200, 100);

                const buf = new Array(DIM);
                const CHUNK = 500;
                for (let start = 0; start < count; start += CHUNK) {
                    const end = Math.min(start + CHUNK, count);
                    for (let i = start; i < end; i++) {
                        const off = i * DIM;
                        for (let d = 0; d < DIM; d++) buf[d] = matrix[off + d];
                        index.addPoint(buf, i);
                    }
                    await new Promise(r => setImmediate(r));
                }

                index.setEf(200);

                if (this._count === count && this._matrix === matrix) {
                    this._hnsw = index;
                    this._hnswCount = count;
                    console.log(`[SemanticEngine] HNSW index built: ${count} vectors in ${Date.now() - t0}ms (background)`);
                    try { index.writeIndex(hnswPath); fs.writeFileSync(hnswPath + '.key', cacheKey); } catch(e) { console.warn('[SemanticEngine] HNSW persist failed:', e.message); }
                } else {
                    console.log('[SemanticEngine] Cache changed during HNSW build — rebuilding against fresh snapshot');
                }
            } catch (e) {
                console.error('[SemanticEngine] HNSW build failed, using brute-force:', e.message);
                this._hnsw = null;
                this._hnswCount = 0;
            } finally {
                this._hnswBuilding = false;
                if (this._hnswCount !== this._count && this._count >= HNSW_THRESHOLD) {
                    this._buildHNSW();
                }
            }
        })();
    }

    // ── Optimized Search (HNSW or brute-force) ───────────────────────
    // CLAP embeddings are L2-normalized, so dot product = cosine similarity.
    // Uses HNSW for O(log N) search when available, falls back to brute-force.
    _searchFlat(queryVec, topK = 200) {
        // ── HNSW fast path (~0.2ms for 70k vectors) ──
        // _hnswCount guard: only use the index when it was built from the
        // CURRENT snapshot — vectors appended/removed after the build (watcher
        // re-index, deletions) fall back to brute-force until the next rebuild,
        // preventing label→path misalignment (stale wrong-path results).
        if (this._hnsw && this._hnswCount === this._count && this._count >= HNSW_THRESHOLD) {
            try {
                const k = Math.min(topK, this._count);
                // Same v3 contract as _buildHNSW: searchKnn requires number[].
                const result = this._hnsw.searchKnn(Array.from(queryVec), k);
                const results = new Array(result.neighbors.length);
                for (let i = 0; i < result.neighbors.length; i++) {
                    const idx = result.neighbors[i];
                    // hnswlib returns distance (1 - ip) for inner product, so score = 1 - distance
                    results[i] = { path: this._paths[idx], score: 1 - result.distances[i] };
                }
                // Already sorted by distance (ascending), which means score descending
                return results;
            } catch (e) {
                // Fallback to brute-force on HNSW error
                console.warn('[SemanticEngine] HNSW search failed, falling back to brute-force:', e.message);
            }
        }

        // ── Brute-force fallback (~5-8ms for 70k × 512) ──
        // Delegated to the pure, unit-tested `bruteCosineTopK` (8x loop unroll
        // + TimSort top-K). Single source of truth for the cosine ranking math.
        return bruteCosineTopK(queryVec, this._matrix, this._paths, this._count, DIM, topK);
    }

    // ── Init ──────────────────────────────────────────────────────────
    async init() {
        if (this.isReady) return;
        console.log('[SemanticEngine] Initializing...');

        const userDataPath = app ? app.getPath('userData') : path.join(__dirname, '..', '..');
        const dbPath = path.join(userDataPath, 'soundvault-semantic.db');
        this._dbPath = dbPath;
        
        // ═══ better-sqlite3: synchronous, WAL mode, tuned pragmas ═══
        this.db = new Database(dbPath);
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('synchronous = NORMAL');
        this.db.pragma('cache_size = -64000'); // 64MB page cache
        this.db.pragma('temp_store = MEMORY');
        
        // Create CLAP embeddings table
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS embeddings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                file_path TEXT UNIQUE,
                mtime INTEGER,
                vector BLOB
            )
        `);

        // Create spectral index table (Echo Vault)
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS spectral_index (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                file_path TEXT UNIQUE,
                mtime INTEGER,
                feature_matrix BLOB,
                summary_vector BLOB,
                duration_ms INTEGER,
                window_count INTEGER
            )
        `);
        // Create peaks cache table
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS peaks_cache (
                file_path TEXT PRIMARY KEY,
                mtime INTEGER,
                peaks BLOB,
                duration_ms INTEGER
            )
        `);

        // Create global CMVN stats table
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS spectral_stats (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                global_mean BLOB,
                global_std BLOB,
                total_windows INTEGER,
                computed_at INTEGER
            )
        `);

        // Migrate spectral_stats table to include running sums
        try {
            this.db.exec('ALTER TABLE spectral_stats ADD COLUMN running_sum BLOB');
            this.db.exec('ALTER TABLE spectral_stats ADD COLUMN running_sum_sq BLOB');
            console.log('[SemanticEngine] Migrated spectral_stats table with running sums');
        } catch(e) {
            // Columns already exist — ignore
        }

        // ═══ Prepared Statements (compiled once, reused everywhere) ═══
        this._stmts = {
            selectAllEmbeddings:   this.db.prepare('SELECT file_path, vector FROM embeddings'),
            selectAllSpectral:     this.db.prepare('SELECT file_path, summary_vector FROM spectral_index'),
            selectEmbMtime:        this.db.prepare('SELECT mtime FROM embeddings WHERE file_path = ?'),
            selectSpecMtime:       this.db.prepare('SELECT mtime FROM spectral_index WHERE file_path = ?'),
            insertEmbedding:       this.db.prepare('INSERT OR REPLACE INTO embeddings (file_path, mtime, vector) VALUES (?, ?, ?)'),
            insertSpectral:        this.db.prepare('INSERT OR REPLACE INTO spectral_index (file_path, mtime, feature_matrix, summary_vector, duration_ms, window_count) VALUES (?, ?, ?, ?, ?, ?)'),
            selectSpectralFeatures: this.db.prepare('SELECT feature_matrix, window_count, duration_ms FROM spectral_index WHERE file_path = ?'),
            selectGlobalStats:     this.db.prepare('SELECT global_mean, global_std, total_windows FROM spectral_stats WHERE id = 1'),
            selectPeaks:       this.db.prepare('SELECT peaks, duration_ms FROM peaks_cache WHERE file_path = ? AND mtime = ?'),
            insertPeaks:       this.db.prepare('INSERT OR REPLACE INTO peaks_cache (file_path, mtime, peaks, duration_ms) VALUES (?, ?, ?, ?)'),
            deleteEmbedding:   this.db.prepare('DELETE FROM embeddings WHERE file_path = ?'),
            deleteSpectral:    this.db.prepare('DELETE FROM spectral_index WHERE file_path = ?'),
            deleteStats:       this.db.prepare('DELETE FROM spectral_stats WHERE id = 1'),
        };

        // Load CLAP models — FP32 is FASTER than INT8 on CPUs without VNNI (i5-9400)
        // (INT8 DequantizeLinear overhead > computation savings without hardware INT8 support)
        console.log('[SemanticEngine] Loading CLAP models (FP32)...');
        try {
            this.tokenizer = await AutoTokenizer.from_pretrained('Xenova/clap-htsat-unfused');
            this.textModel = await ClapTextModelWithProjection.from_pretrained('Xenova/clap-htsat-unfused', { quantized: false });
            this.processor = await AutoProcessor.from_pretrained('Xenova/clap-htsat-unfused');
            this.audioModel = await ClapAudioModelWithProjection.from_pretrained('Xenova/clap-htsat-unfused', { quantized: false });
        } catch (e) {
            console.error('[SemanticEngine] Failed to load models:', e);
            throw e;
        }

        // Preload vector cache from SQLite into flat buffer
        this._loadCacheFromDB();

        // Preload spectral summary vectors for Echo coarse filter
        this._loadSpectralSummaries();

        // Load global CMVN stats
        this._loadGlobalStats();

        this.isReady = true;
        this._spectralReady = true;
        console.log('[SemanticEngine] Ready.');
    }

    // ── Audio Extraction ──────────────────────────────────────────────
    // Handles fluent-ffmpeg race condition: PassThrough 'close' can fire
    // before ffmpeg 'exit', emitting spurious "Output stream closed" error.
    async getAudioData(filePath, maxDuration = 10) {
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

            ffmpeg(filePath)
                .duration(maxDuration)
                .audioFrequency(48000)
                .audioChannels(1)
                .format('f32le')
                .on('error', (err) => {
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

    // ── Unified Indexing (Phase 2: single ffmpeg decode) ──────────────
    async _indexFileFull(filePath, mtime, needsClap, needsSpectral) {
        try {
            // Single ffmpeg decode — 30s max, used for both CLAP and spectral
            const maxDur = needsSpectral ? 30 : 10;
            const audioData = await this.getAudioData(filePath, maxDur);

            if (needsClap) {
                // CLAP uses first 10s (480000 samples at 48kHz)
                const clapAudio = audioData.subarray(0, Math.min(audioData.length, 48000 * 10));
                const inputs = await this.processor(clapAudio);
                const { audio_embeds } = await this.audioModel(inputs);
                
                const vectorArray = Array.from(audio_embeds.data);
                const buffer = Buffer.from(new Float32Array(vectorArray).buffer);

                this._stmts.insertEmbedding.run(filePath, mtime, buffer);
                this._appendToCache(filePath, buffer);
            }

            if (needsSpectral) {
                const { matrix, numWindows } = this._fingerprinter.extractRaw(audioData, 48000);
                const summary = this._fingerprinter.computeSummary(matrix, numWindows);
                const durationMs = Math.round(audioData.length / 48000 * 1000);

                const compressedMatrix = compressMatrix(matrix);
                const summaryBuf = Buffer.from(summary.buffer, summary.byteOffset, summary.byteLength);

                this._stmts.insertSpectral.run(filePath, mtime, compressedMatrix, summaryBuf, durationMs, numWindows);
            }
        } catch (e) {
            console.error(`[SemanticEngine] Error indexing ${filePath}:`, e);
        }
    }

    // Load spectral summary vectors into flat buffer for fast coarse search
    _loadSpectralSummaries() {
        const rows = this._stmts.selectAllSpectral.all();

        this._summaryPaths = [];
        this._summaryCount = 0;
        this._summaryMatrix = new Float32Array(rows.length * FEATURES_PER_WINDOW);
        let staleCount = 0;

        for (const row of rows) {
            if (!row.summary_vector) continue;
            const vec = new Float32Array(row.summary_vector.buffer, row.summary_vector.byteOffset, row.summary_vector.byteLength / 4);
            // Backward compatibility: skip old 18-feature vectors
            if (vec.length !== FEATURES_PER_WINDOW) {
                staleCount++;
                continue;
            }
            this._summaryMatrix.set(vec, this._summaryCount * FEATURES_PER_WINDOW);
            this._summaryPaths.push(row.file_path);
            this._summaryCount++;
        }
        this._summaryPathIndex = new Map();
        for (let i = 0; i < this._summaryCount; i++) this._summaryPathIndex.set(this._summaryPaths[i], i);
        console.log(`[SemanticEngine] Spectral summaries loaded: ${this._summaryCount} files`);
        if (staleCount > 0) {
            console.warn(`[SemanticEngine] ⚠ ${staleCount} files have old 18-feature index — re-index required for full Echo coverage`);
        }
    }

    // Load global CMVN stats from SQLite
    _loadGlobalStats() {
        try {
            const row = this._stmts.selectGlobalStats.get();
            if (row && row.global_mean && row.global_std) {
                this._globalMean = new Float32Array(row.global_mean.buffer, row.global_mean.byteOffset, row.global_mean.byteLength / 4);
                this._globalStd = new Float32Array(row.global_std.buffer, row.global_std.byteOffset, row.global_std.byteLength / 4);
                console.log(`[SemanticEngine] Global CMVN stats loaded (${row.total_windows} windows)`);
            } else {
                this._globalMean = null;
                this._globalStd = null;
                console.log('[SemanticEngine] No global CMVN stats found — using per-file normalization fallback');
            }
        } catch(e) {
            this._globalMean = null;
            this._globalStd = null;
            console.warn('[SemanticEngine] Failed to load global stats:', e.message);
        }
    }

    async startIndexing(libraryPath) {
        console.log("[SemanticEngine] startIndexing called. isReady:", this.isReady, "isIndexing:", this.isIndexing, "Library path:", libraryPath);
        if (!this.isReady || this.isIndexing) return;
        this.isIndexing = true;
        this.progress = {
            total: 0, current: 0,
            phase: 'scanning',       // scanning | clap-quick | clap-deep | spectral | done
            phaseCurrent: 0, phaseTotal: 0,
            clapTotal: 0, spectralTotal: 0,
            tier: 0                  // 0=quick CLAP, 1=deep CLAP, 2=spectral
        };
        
        try {
            const allWavs = [];
            try {
                const entries = await fs.promises.readdir(libraryPath, { recursive: true, withFileTypes: true });
                for (const e of entries) {
                    if (!e.isFile() || !e.name.toLowerCase().endsWith('.wav')) continue;
                    if (e.parentPath.includes('node_modules') || e.parentPath.includes('.git')) continue;
                    const fullPath = path.join(e.parentPath, e.name);
                    try {
                        const st = await fs.promises.stat(fullPath);
                        allWavs.push({ path: fullPath, mtime: st.mtimeMs });
                    } catch(err) {}
                }
            } catch(e) { console.warn('[SemanticEngine] Scan error:', e.message); }
            console.log(`[SemanticEngine] Found ${allWavs.length} total wavs in ${libraryPath}`);
            
            // ── Batch mtime preload (main thread — 2 queries) ────────
            const clapMtimeMap = new Map();
            for (const row of this.db.prepare('SELECT file_path, mtime FROM embeddings').all()) {
                clapMtimeMap.set(row.file_path, row.mtime);
            }
            const spectralMtimeMap = new Map();
            for (const row of this.db.prepare('SELECT file_path, mtime FROM spectral_index').all()) {
                spectralMtimeMap.set(row.file_path, row.mtime);
            }
            console.log(`[SemanticEngine] mtime maps loaded: CLAP=${clapMtimeMap.size}, spectral=${spectralMtimeMap.size}`);

            // ── Delta indexing (main thread — fast) ──────────────────
            const onDiskPaths = new Set(allWavs.map(f => f.path));
            const staleClap = [...clapMtimeMap.keys()].filter(p => !onDiskPaths.has(p));
            const staleSpectral = [...spectralMtimeMap.keys()].filter(p => !onDiskPaths.has(p));

            if (staleClap.length > 0 || staleSpectral.length > 0) {
                const delEmb = this.db.prepare('DELETE FROM embeddings WHERE file_path = ?');
                const delSpec = this.db.prepare('DELETE FROM spectral_index WHERE file_path = ?');
                this.db.transaction(() => {
                    for (const p of staleClap) delEmb.run(p);
                    for (const p of staleSpectral) delSpec.run(p);
                })();
                console.log(`[SemanticEngine] Delta cleanup: removed ${staleClap.length} CLAP + ${staleSpectral.length} spectral stale entries`);
            }

            // ── Build work queue with tiers ──────────────────────────
            const filesToIndex = [];
            for (const file of allWavs) {
                const needsClap = clapMtimeMap.get(file.path) !== file.mtime;
                const needsSpectral = spectralMtimeMap.get(file.path) !== file.mtime;
                if (needsClap || needsSpectral) {
                    filesToIndex.push({ ...file, needsClap, needsSpectral });
                }
            }

            const alreadyDone = allWavs.length - filesToIndex.length;
            console.log(`[SemanticEngine] ${filesToIndex.length} files need indexing (${alreadyDone} already up-to-date)`);

            if (filesToIndex.length === 0) {
                if (staleClap.length > 0 || staleSpectral.length > 0) {
                    this._loadCacheFromDB();
                    this._loadSpectralSummaries();
                } else {
                    console.log('[SemanticEngine] No changes — skipping cache reload');
                }
                return;
            }

            // ── Tier 0: Quick CLAP (single inference, first 10s only) ──
            // All files that need CLAP get a fast single-inference pass first.
            // This enables semantic search ASAP.
            const tier0Files = filesToIndex.filter(f => f.needsClap);

            // ── Tier 1: Deep CLAP (strategic sampling for long files) ──
            // Re-index long files with multi-segment sampling for better embeddings.
            // Only files >10s benefit from this (short files already complete in Tier 0).
            const tier1Files = filesToIndex.filter(f => f.needsClap).filter(f => {
                // Estimate duration from file size: 48kHz × 16bit × mono = ~96KB/s
                // Files larger than ~960KB are likely >10s
                try {
                    const stat = fs.statSync(f.path);
                    return stat.size > 960000;
                } catch(e) { return false; }
            });

            // ── Tier 2: Spectral fingerprinting ──
            const tier2Files = filesToIndex.filter(f => f.needsSpectral);

            this.progress = {
                total: allWavs.length,
                current: alreadyDone,
                phase: 'clap-quick',
                phaseCurrent: 0,
                phaseTotal: tier0Files.length,
                clapTotal: tier0Files.length,
                spectralTotal: tier2Files.length,
                tier: 0
            };

            // Reuse the module-level resolved ffmpegPath (packaged-app safe) — do NOT
            // re-require ffmpeg-static here, or the worker would spawn from an
            // asar-internal path and every CLAP/spectral decode would fail.
            await new Promise((resolve, reject) => {
                let worker;
                if (this._indexWorker) {
                    worker = this._indexWorker;
                } else {
                    worker = new Worker(path.join(__dirname, 'indexing-worker.js'));
                    this._indexWorker = worker;
                }
                let currentTier = -1; // -1 = not started

                const startNextTier = () => {
                    if (currentTier < 0 && tier0Files.length > 0) {
                        // ── Tier 0: Quick CLAP ──
                        currentTier = 0;
                        this.progress.phase = 'clap-quick';
                        this.progress.phaseTotal = tier0Files.length;
                        this.progress.phaseCurrent = 0;
                        console.log(`[SemanticEngine] Tier 0: Quick CLAP (${tier0Files.length} files)...`);
                        worker.postMessage({ type: 'index-clap-quick', files: tier0Files });
                    } else if (currentTier <= 0 && tier1Files.length > 0) {
                        // ── Tier 1: Deep CLAP (only long files) ──
                        currentTier = 1;
                        this.progress.phase = 'clap-deep';
                        this.progress.phaseTotal = tier1Files.length;
                        this.progress.phaseCurrent = 0;
                        console.log(`[SemanticEngine] Tier 1: Deep CLAP (${tier1Files.length} long files)...`);
                        worker.postMessage({ type: 'index-clap', files: tier1Files });
                    } else if (currentTier <= 1 && tier2Files.length > 0) {
                        // ── Tier 2: Spectral ──
                        currentTier = 2;
                        this.progress.phase = 'spectral';
                        this.progress.phaseTotal = tier2Files.length;
                        this.progress.phaseCurrent = 0;
                        console.log(`[SemanticEngine] Tier 2: Spectral (${tier2Files.length} files)...`);
                        worker.postMessage({ type: 'index-spectral', files: tier2Files });
                    } else {
                        // All tiers done
                        this.progress.phase = 'done';
                        resolve();
                    }
                };

                worker.on('message', (msg) => {
                    if (msg.type === 'ready') {
                        startNextTier();
                    }
                    if (msg.type === 'progress') {
                        this.progress.phaseCurrent = msg.current;
                        // Accumulate overall progress across tiers
                        let base = alreadyDone;
                        if (currentTier > 0) base += tier0Files.length;
                        if (currentTier > 1) base += tier1Files.length;
                        this.progress.current = base + msg.current;
                        this._spectralProgress = { total: allWavs.length, current: this.progress.current };
                    }
                    if (msg.type === 'batch-complete') {
                        console.log(`[SemanticEngine] Tier ${currentTier} complete (${msg.rate} files/min).`);

                        if (currentTier === 0) {
                            // Tier 0 done — reload CLAP cache, search is now functional
                            console.log('[SemanticEngine] Quick CLAP done — reloading cache for immediate search...');
                            this._loadCacheFromDB();
                        } else if (currentTier === 1) {
                            // Tier 1 done — reload to get improved embeddings
                            console.log('[SemanticEngine] Deep CLAP done — reloading improved embeddings...');
                            this._loadCacheFromDB();
                        } else if (currentTier === 2) {
                            // Tier 2 done — reload spectral data
                            console.log('[SemanticEngine] Spectral done — reloading summaries + stats...');
                            this._loadSpectralSummaries();
                            this._loadGlobalStats();
                            this._spectralCache.clear();
                        }

                        // Advance to next tier
                        startNextTier();
                    }
                    if (msg.type === 'error') {
                        console.error('[SemanticEngine] Worker error:', msg.error);
                        this._indexWorker = null;
                        worker.postMessage({ type: 'shutdown' });
                        this._loadCacheFromDB();
                        this._loadSpectralSummaries();
                        this._loadGlobalStats();
                        this._spectralCache.clear();
                        resolve();
                    }
                });

                worker.on('error', (err) => {
                    console.error('[SemanticEngine] Worker thread error:', err);
                    this._indexWorker = null;
                    resolve();
                });

                worker.on('exit', (code) => {
                    if (code !== 0) console.warn(`[SemanticEngine] Worker exited with code ${code}`);
                    this._indexWorker = null;
                });

                // cacheDir: the worker has its OWN @xenova/transformers module instance
                // (audit C2) — it must point at the bundled model itself.
                worker.postMessage({ type: 'init', dbPath: this._dbPath, ffmpegPath, cacheDir: env.cacheDir });
            });
        } finally {
            this.isIndexing = false;
        }
    }

    // ── Search (Optimized) ────────────────────────────────────────────
    async search(queryText, weights = null) {
        if (!this.isReady || this._count === 0) return { results: [], words: [] };

        const t0 = Date.now();
        const words = [...new Set(queryText.toLowerCase().trim().split(/\s+/).filter(w => w.length > 2))];

        if (this._lastQueryText !== queryText) {
            // 1. Get text embedding from CLAP (~50ms)
            const inputs = await this.tokenizer([queryText], { padding: true, truncation: true });
            const { text_embeds } = await this.textModel(inputs);
            this._lastBaseVector = new Float32Array(text_embeds.data); // 512D
            
            // Cache individual word vectors for live shifting later
            this._lastWordVectors = {};
            if (words.length > 1) {
                for (const w of words) {
                    const wInput = await this.tokenizer([w], { padding: true, truncation: true });
                    const wEmbed = await this.textModel(wInput);
                    this._lastWordVectors[w] = new Float32Array(wEmbed.text_embeds.data);
                }
            }
            this._lastQueryText = queryText;
        }

        let queryVec = new Float32Array(this._lastBaseVector);

        // Vector shifting if weights are provided
        if (weights && words.length > 1) {
            for (const [w, wVal] of Object.entries(weights)) {
                const vec = this._lastWordVectors[w];
                if (vec) {
                    const shift = parseFloat(wVal) - 1.0;
                    if (shift !== 0) {
                        for (let i = 0; i < 512; i++) {
                            queryVec[i] += vec[i] * shift;
                        }
                    }
                }
            }
            // Re-normalize shifted vector (L2 norm)
            let sumSq = 0;
            for (let i = 0; i < 512; i++) sumSq += queryVec[i] * queryVec[i];
            const mag = Math.sqrt(sumSq);
            if (mag > 0) {
                for (let i = 0; i < 512; i++) queryVec[i] /= mag;
            }
        }

        const t1 = Date.now();

        // 2. Flat brute-force / HNSW top-K over the contiguous cache.
        const rawResults = this._searchFlat(queryVec);
        // Phase 2.2: drop sub-threshold (weak/irrelevant) hits. With the
        // default threshold of 0 this is a no-op, preserving legacy behaviour.
        const results = applyThreshold(rawResults, this._similarityThreshold);

        const t2 = Date.now();
        const dropped = rawResults.length - results.length;
        console.log(`[SemanticEngine] Search "${queryText}": inference=${t1-t0}ms, vectorSearch=${t2-t1}ms, total=${t2-t0}ms (${this._count} vectors, threshold=${this._similarityThreshold}, dropped=${dropped})`);

        return { results, words: words.length > 1 ? words : [] };
    }

    // ── Collection Centroid Suggestions ────────────────────────────────
    // Given a list of file paths, computes the centroid of their embeddings
    // and returns the top-N closest sounds NOT in the input list.
    suggestForCollection(collectionPaths, topK = 12) {
        if (!this.isReady || this._count === 0 || !collectionPaths.length) return [];

        const t0 = Date.now();
        // Build a Set of collection paths for fast lookup
        const colSet = new Set(collectionPaths);
        
        // Find indices of collection members in the cache
        const memberIndices = [];
        for (let i = 0; i < this._count; i++) {
            if (colSet.has(this._paths[i])) memberIndices.push(i);
        }
        if (memberIndices.length === 0) return [];

        // Compute centroid vector (average of all member embeddings)
        const centroid = new Float32Array(DIM);
        for (const idx of memberIndices) {
            const offset = idx * DIM;
            for (let d = 0; d < DIM; d++) centroid[d] += this._matrix[offset + d];
        }
        const n = memberIndices.length;
        for (let d = 0; d < DIM; d++) centroid[d] /= n;

        // L2-normalize the centroid
        let sumSq = 0;
        for (let d = 0; d < DIM; d++) sumSq += centroid[d] * centroid[d];
        const mag = Math.sqrt(sumSq);
        if (mag > 0) for (let d = 0; d < DIM; d++) centroid[d] /= mag;

        // Dot product against all vectors, excluding collection members
        const pairs = [];
        for (let i = 0; i < this._count; i++) {
            if (colSet.has(this._paths[i])) continue;
            const offset = i * DIM;
            let dot = 0;
            for (let d = 0; d < DIM; d++) dot += centroid[d] * this._matrix[offset + d];
            pairs.push({ idx: i, score: dot });
        }

        pairs.sort((a, b) => b.score - a.score);
        const k = Math.min(topK, pairs.length);
        const results = new Array(k);
        for (let i = 0; i < k; i++) {
            results[i] = { path: this._paths[pairs[i].idx], score: pairs[i].score };
        }

        console.log(`[SemanticEngine] Suggest: ${memberIndices.length} members → ${k} suggestions in ${Date.now() - t0}ms`);
        return results;
    }

    // ═══════════════════════════════════════════════════════════════════
    //  ECHO VAULT — Audio-to-Audio Similarity Search
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Stage 1: CLAP audio-to-audio query.
     * Embeds the provided audio fragment via CLAP and searches the flat cache.
     * @param {Float32Array} pcmFloat32 - Mono audio samples (48kHz)
     * @param {number} topK - Number of candidates to return
     * @returns {Promise<Array<{ path: string, score: number }>>}
     */
    async searchByAudio(pcmFloat32, topK = 500) {
        if (!this.isReady || this._count === 0) return [];

        const inputs = await this.processor(pcmFloat32);
        const { audio_embeds } = await this.audioModel(inputs);
        const queryVec = new Float32Array(audio_embeds.data);

        return this._searchFlat(queryVec, topK);
    }

    /**
     * Spectral summary coarse search — fast 18-D dot-product scan.
     * Used as fallback for short fragments (<1s) where CLAP is unreliable.
     * @param {Float32Array} querySummary - 18-D L2-normalized summary vector
     * @param {number} topK - Number of candidates
     * @returns {Array<{ path: string, score: number }>}
     */
    _searchSpectralSummary(querySummary, topK = 500) {
        const n = this._summaryCount;
        const m = this._summaryMatrix;
        const dim = FEATURES_PER_WINDOW;
        const pairs = [];

        for (let i = 0; i < n; i++) {
            const offset = i * dim;
            let dot = 0;
            for (let d = 0; d < dim; d++) {
                dot += querySummary[d] * m[offset + d];
            }
            pairs.push({ idx: i, score: dot });
        }

        pairs.sort((a, b) => b.score - a.score);
        const k = Math.min(topK, n);
        const results = new Array(k);
        for (let i = 0; i < k; i++) {
            results[i] = { path: this._summaryPaths[pairs[i].idx], score: pairs[i].score };
        }
        return results;
    }

    /**
     * Load spectral feature matrix for a file (from LRU cache or SQLite).
     * @param {string} filePath
     * @returns {Promise<{ matrix: Float32Array, numWindows: number, durationMs: number } | null>}
     */
    _loadSpectralFeatures(filePath) {
        // Check LRU cache first
        const cached = this._spectralCache.get(filePath);
        if (cached) return cached;

        // Load from SQLite (synchronous prepared statement)
        const row = this._stmts.selectSpectralFeatures.get(filePath);

        if (!row || !row.feature_matrix) return null;

        const matrix = decompressMatrix(row.feature_matrix);

        // Apply global CMVN normalization if stats are available
        if (this._globalMean && this._globalStd) {
            applyGlobalNorm(matrix, row.window_count, this._globalMean, this._globalStd);
        }

        const entry = { matrix, numWindows: row.window_count, durationMs: row.duration_ms };

        // Cache for next time
        this._spectralCache.set(filePath, entry);
        return entry;
    }

    _getEchoWorker() {
        if (this._echoWorker) return Promise.resolve(this._echoWorker);
        return new Promise((resolve) => {
            const w = new Worker(path.join(__dirname, 'echo-worker.js'));
            w.on('message', (msg) => {
                if (msg.type === 'ready') {
                    this._echoWorker = w;
                    resolve(w);
                }
            });
            w.postMessage({ type: 'init', dbPath: this._dbPath });
        });
    }

    _runEchoMatch(queryMatrix, queryNumWindows, candidates, featureWeights) {
        return new Promise(async (resolve) => {
            const w = await this._getEchoWorker();
            const jobId = Date.now() + Math.random();
            const handler = (msg) => {
                if (msg.type === 'result' && msg.jobId === jobId) {
                    w.removeListener('message', handler);
                    resolve(msg.results);
                }
            };
            w.on('message', handler);
            w.postMessage({
                type: 'match',
                jobId,
                queryMatrix: Buffer.from(queryMatrix.buffer, queryMatrix.byteOffset, queryMatrix.byteLength),
                queryNumWindows,
                candidates: candidates.map(c => ({ path: c.path, score: c.score })),
                featureWeights,
                globalMean: this._globalMean ? Buffer.from(this._globalMean.buffer) : null,
                globalStd: this._globalStd ? Buffer.from(this._globalStd.buffer) : null,
            });
        });
    }

    destroyEchoWorker() {
        if (this._echoWorker) {
            this._echoWorker.postMessage({ type: 'shutdown' });
            this._echoWorker = null;
        }
    }

    /**
     * Full Echo search pipeline.
     * 
     * @param {Object} params
     * @param {Float32Array} params.pcmData - Mono audio samples of the query fragment
     * @param {number} params.sampleRate - Sample rate of pcmData
     * @param {number} params.duration - Duration of selection in seconds
     * @param {Object} [params.weights] - Similarity axes weights
     * @param {number} [params.maxResults=50] - Maximum results to return
     * @param {string} [params.sourceFilePath] - Path of the file the selection is from (excluded from results)
     * @returns {Promise<Object>} Search results
     */
    async echoSearch({ pcmData, sampleRate, duration, weights, maxResults = 50, sourceFilePath = null }) {
        if (!this.isReady) return { results: [], searchTimeMs: 0, totalCandidates: 0, totalMatches: 0 };

        const t0 = Date.now();

        // Extract spectral features from the query fragment
        // Use extractRaw + global norm if available, otherwise fall back to per-file norm
        let queryFeatures;
        if (this._globalMean && this._globalStd) {
            queryFeatures = this._fingerprinter.extractRaw(pcmData, sampleRate);
            applyGlobalNorm(queryFeatures.matrix, queryFeatures.numWindows, this._globalMean, this._globalStd);
        } else {
            queryFeatures = this._fingerprinter.extract(pcmData, sampleRate);
        }
        const querySummary = this._fingerprinter.computeSummary(queryFeatures.matrix, queryFeatures.numWindows);
        const featureWeights = buildFeatureWeights(weights);

        const t1 = Date.now();

        // ── Stage 1: Coarse Filter ──
        let candidates;
        const isShortFragment = duration < 1.0;

        if (isShortFragment) {
            // Short fragment: CLAP is unreliable, use spectral summary search instead
            console.log(`[Echo] Short fragment (${(duration * 1000).toFixed(0)}ms) — using spectral summary coarse filter`);
            candidates = this._searchSpectralSummary(querySummary, 500);
        } else {
            // Normal: use CLAP audio-to-audio
            console.log(`[Echo] Normal fragment (${(duration * 1000).toFixed(0)}ms) — using CLAP coarse filter`);
            candidates = await this.searchByAudio(pcmData, 500);
        }

        // Exclude source file
        if (sourceFilePath) {
            candidates = candidates.filter(c => c.path !== sourceFilePath);
        }

        // ── Adaptive candidate pruning ──
        // If coarse scores drop sharply, trim candidates to avoid wasted spectral computation.
        // Only evaluate candidates whose coarse score is within 40% of the top score.
        if (candidates.length > 50) {
            const topCoarseScore = candidates[0].score;
            const coarseThreshold = topCoarseScore * 0.6; // 60% of top score
            const minCandidates = 50; // always evaluate at least 50
            let cutoff = candidates.length;
            for (let i = minCandidates; i < candidates.length; i++) {
                if (candidates[i].score < coarseThreshold) {
                    cutoff = i;
                    break;
                }
            }
            if (cutoff < candidates.length) {
                console.log(`[Echo] Adaptive pruning: ${candidates.length} → ${cutoff} candidates (threshold: ${coarseThreshold.toFixed(3)})`);
                candidates = candidates.slice(0, cutoff);
            }
        }

        const t2 = Date.now();

        // ── Stage 2: Spectral Fingerprint Fine Search ──
        let results = await this._runEchoMatch(
            queryFeatures.matrix, queryFeatures.numWindows,
            candidates, featureWeights
        );
        const scanned = results.length;

        // Sort by spectral score (Stage 2 is the authority)
        results.sort((a, b) => b.spectralScore - a.spectralScore);

        // ── Adaptive Spectral Gate ──
        // Filter out bottom quartile by spectral score.
        // Percentile-based: adapts to query type (tight transients produce high gate,
        // diffuse tails/ambiences produce permissive gate). Floor at 0.15 absolute.
        if (results.length > 4) {
            const p25 = results[Math.floor(results.length * 0.75)].spectralScore; // sorted desc, so index 75% = P25
            const gate = Math.max(p25, 0.15);
            const beforeGate = results.length;
            results = results.filter(r => r.spectralScore >= gate);
            if (results.length < beforeGate) {
                console.log(`[Echo] Adaptive gate: ${gate.toFixed(3)} (P25), removed ${beforeGate - results.length}/${beforeGate} candidates`);
            }
        }

        // ── Phase 4: Rank-Normalization for Score Calibration ──
        // Rank-normalize CLAP and Spectral scores independently to [0,1],
        // making them statistically comparable before blending.
        const n = results.length;
        if (n > 0) {
            // Rank-normalize spectral scores (already sorted by spectral desc)
            for (let i = 0; i < n; i++) {
                results[i]._spectralRank = (n - i) / n;  // rank 1 → 1.0, rank N → 1/N
            }

            // Rank-normalize CLAP scores (sort indices by clap desc)
            const clapOrder = results.map((_, i) => i).sort((a, b) => results[b].clapScore - results[a].clapScore);
            for (let rank = 0; rank < n; rank++) {
                results[clapOrder[rank]]._clapRank = (n - rank) / n;
            }

            // Blend using rank-normalized scores
            const clapWeight = isShortFragment ? 0.0 : 0.3;
            const spectralWeight = 1.0 - clapWeight;
            for (const r of results) {
                r.score = r._clapRank * clapWeight + r._spectralRank * spectralWeight;
                delete r._clapRank;
                delete r._spectralRank;
            }
        }

        // Re-sort by combined score
        results.sort((a, b) => b.score - a.score);

        const finalResults = results.slice(0, maxResults);

        const t3 = Date.now();
        console.log(`[Echo] Search complete: featureExtract=${t1 - t0}ms, coarseFilter=${t2 - t1}ms, spectralMatch=${t3 - t2}ms, total=${t3 - t0}ms, candidates=${candidates.length}, scanned=${scanned}, results=${finalResults.length}`);

        return {
            results: finalResults,
            queryDurationMs: Math.round(duration * 1000),
            searchTimeMs: t3 - t0,
            totalCandidates: candidates.length,
            totalMatches: finalResults.length,
        };
    }

    /**
     * File Echo — find files similar to an entire file.
     * Uses existing CLAP embedding (no need to re-encode) + spectral summary.
     * @param {string} filePath - Path of the source file
     * @param {Object} [weights] - Similarity axes weights
     * @param {number} [maxResults=50]
     * @returns {Promise<Object>}
     */
    async echoFile(filePath, weights = null, maxResults = 50) {
        if (!this.isReady) return { results: [], searchTimeMs: 0, totalCandidates: 0, totalMatches: 0 };

        const t0 = Date.now();

        const fileIdx = this._pathIndex.has(filePath) ? this._pathIndex.get(filePath) : -1;
        if (fileIdx === -1) return { results: [], searchTimeMs: 0, totalCandidates: 0, totalMatches: 0 };

        // Extract query vector from flat cache
        const queryVec = this._matrix.subarray(fileIdx * DIM, (fileIdx + 1) * DIM);
        const candidates = this._searchFlat(queryVec, 200).filter(c => c.path !== filePath);

        // ── Adaptive candidate pruning ──
        // If coarse scores drop sharply, trim candidates to avoid wasted spectral computation.
        // Only evaluate candidates whose coarse score is within 40% of the top score.
        if (candidates.length > 50) {
            const topCoarseScore = candidates[0].score;
            const coarseThreshold = topCoarseScore * 0.6; // 60% of top score
            const minCandidates = 50; // always evaluate at least 50
            let cutoff = candidates.length;
            for (let i = minCandidates; i < candidates.length; i++) {
                if (candidates[i].score < coarseThreshold) {
                    cutoff = i;
                    break;
                }
            }
            if (cutoff < candidates.length) {
                console.log(`[Echo] Adaptive pruning: ${candidates.length} → ${cutoff} candidates (threshold: ${coarseThreshold.toFixed(3)})`);
                candidates = candidates.slice(0, cutoff);
            }
        }

        const t1 = Date.now();

        // Load source file spectral features for fine matching
        const sourceFeatures = this._loadSpectralFeatures(filePath);
        if (!sourceFeatures) {
            // Fallback: CLAP-only results
            return {
                results: candidates.slice(0, maxResults).map(c => ({
                    path: c.path,
                    score: c.score,
                    clapScore: c.score,
                    spectralScore: 0,
                    matchOffsetMs: 0,
                    matchDurationMs: 0,
                })),
                searchTimeMs: Date.now() - t0,
                totalCandidates: candidates.length,
                totalMatches: Math.min(candidates.length, maxResults),
            };
        }

        const featureWeights = buildFeatureWeights(weights);
        let results = await this._runEchoMatch(
            sourceFeatures.matrix, sourceFeatures.numWindows,
            candidates, featureWeights
        );

        // Rank-normalize spectral scores
        results.sort((a, b) => b.spectralScore - a.spectralScore);

        // ── Adaptive Spectral Gate ──
        if (results.length > 4) {
            const p25 = results[Math.floor(results.length * 0.75)].spectralScore;
            const gate = Math.max(p25, 0.15);
            const beforeGate = results.length;
            results = results.filter(r => r.spectralScore >= gate);
            if (results.length < beforeGate) {
                console.log(`[Echo] Adaptive gate: ${gate.toFixed(3)} (P25), removed ${beforeGate - results.length}/${beforeGate} candidates`);
            }
        }

        // ── Phase 4: Rank-Normalization for Score Calibration ──
        const n = results.length;
        if (n > 0) {
            for (let i = 0; i < n; i++) {
                results[i]._spectralRank = (n - i) / n;
            }
            // Rank-normalize CLAP scores
            const clapOrder = results.map((_, i) => i).sort((a, b) => results[b].clapScore - results[a].clapScore);
            for (let rank = 0; rank < n; rank++) {
                results[clapOrder[rank]]._clapRank = (n - rank) / n;
            }
            // Blend
            for (const r of results) {
                r.score = r._clapRank * 0.3 + r._spectralRank * 0.7;
                delete r._clapRank;
                delete r._spectralRank;
            }
        }

        results.sort((a, b) => b.score - a.score);

        const t2 = Date.now();
        console.log(`[Echo] File echo: coarse=${t1 - t0}ms, spectral=${t2 - t1}ms, total=${t2 - t0}ms`);

        return {
            results: results.slice(0, maxResults),
            searchTimeMs: t2 - t0,
            totalCandidates: candidates.length,
            totalMatches: Math.min(results.length, maxResults),
        };
    }

    // Echo Vault status helpers
    get spectralReady() { return this._spectralReady; }
    get spectralProgress() { return this._spectralProgress; }

    // ═══════════════════════════════════════════════════════════════════
    //  PHASE C — Incremental File Watcher (native fs.watch recursive)
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Start watching a library path for new/changed/deleted WAV files.
     * Uses native fs.watch with recursive:true (single ReadDirectoryChangesW
     * handle on Windows — instant startup, near-zero overhead).
     *
     * Safety rules:
     * 1. Aggressive debounce (3s) to batch rapid file copies
     * 2. Immediate .wav extension filter
     * 3. existsSync guard: files that don't exist → removeFromCaches
     */
    startWatching(libraryPath) {
        if (this._watcher) this.stopWatching();
        if (!libraryPath || !fs.existsSync(libraryPath)) return;

        this._watchRoot = libraryPath;
        console.log(`[SemanticEngine] Starting file watcher on: ${libraryPath}`);

        try {
            this._watcher = fs.watch(libraryPath, { recursive: true }, (eventType, filename) => {
                if (!filename) return;

                // Rule 2: Filter by extension immediately
                if (!filename.toLowerCase().endsWith('.wav')) return;

                const fullPath = path.join(libraryPath, filename);

                // Rule 3: Check existence — rename fires for both create and delete
                if (fs.existsSync(fullPath)) {
                    this._queueForIndex(fullPath);
                } else {
                    this._removeFromCaches(fullPath);
                }
            });
            console.log(`[SemanticEngine] File watcher ready (watching for changes).`);
        } catch (err) {
            console.error('[Watcher] Failed to start:', err.message);
        }
    }

    stopWatching() {
        if (this._watcher) {
            this._watcher.close();
            this._watcher = null;
            this._watchRoot = null;
            console.log('[SemanticEngine] File watcher stopped.');
        }
        this.destroyEchoWorker();
    }

    /**
     * Queue a file for incremental indexing.
     * Rule 1: Aggressive debounce — resets timer on each new event.
     * Waits 3s of silence after the last event before processing.
     */
    _queueForIndex(filePath) {
        if (!this._indexQueue.includes(filePath)) {
            this._indexQueue.push(filePath);
        }

        // Reset debounce timer on every event (aggressive debounce)
        if (this._indexTimer) clearTimeout(this._indexTimer);

        this._indexTimer = setTimeout(async () => {
            this._indexTimer = null;
            const queue = this._indexQueue.splice(0);
            if (queue.length === 0 || !this.isReady || this.isIndexing) return;

            console.log(`[Watcher] Incremental indexing ${queue.length} file(s)...`);
            // CPU optimization: skip per-file work if the DB already holds the
            // same mtime for BOTH CLAP and spectral. `fs.watch` can fire on
            // benign events (antivirus scan, editor touch, access-time updates)
            // that don't change the file content — we don't want to re-run
            // CLAP inference (~50ms each) for those. Mirrors the bulk indexer's
            // mtime-skip pattern at the top of `startIndexing`.
            const getClapMtime = this._stmts.selectEmbMtime;
            const getSpectralMtime = this._stmts.selectSpecMtime;
            for (const fp of queue) {
                try {
                    if (!fs.existsSync(fp)) continue; // Re-check: file may be gone
                    const stat = fs.statSync(fp);
                    const storedClap = getClapMtime.get(fp);
                    const storedSpec = getSpectralMtime.get(fp);
                    const needsClap = !storedClap || storedClap.mtime !== stat.mtimeMs;
                    const needsSpectral = !storedSpec || storedSpec.mtime !== stat.mtimeMs;
                    if (!needsClap && !needsSpectral) continue; // benign event, skip
                    if (this._indexWorker) {
                        await new Promise((resolve) => {
                            const handler = (msg) => {
                                if ((msg.type === 'single-done' || msg.type === 'single-error') && msg.filePath === fp) {
                                    this._indexWorker.removeListener('message', handler);
                                    if (msg.type === 'single-done' && msg.vector) {
                                        this._appendToCache(fp, msg.vector);
                                    }
                                    resolve();
                                }
                            };
                            this._indexWorker.on('message', handler);
                            this._indexWorker.postMessage({ type: 'index-single', filePath: fp, mtime: stat.mtimeMs, needsClap, needsSpectral });
                        });
                    } else {
                        await this._indexFileFull(fp, stat.mtimeMs, needsClap, needsSpectral);
                    }
                } catch (e) {
                    console.warn(`[Watcher] Skip ${path.basename(fp)}: ${e.message}`);
                }
            }
            console.log(`[Watcher] Incremental indexing complete (${queue.length} files).`);
        }, 3000);
    }

    /**
     * Remove a file from all caches and DB when it's deleted from disk.
     * Uses swap-remove on flat arrays to avoid costly splice operations.
     */
    _removeFromCaches(filePath) {
        try { this._stmts.deleteEmbedding.run(filePath); } catch(e) {}

        const clapIdx = this._pathIndex.has(filePath) ? this._pathIndex.get(filePath) : -1;
        if (clapIdx !== -1 && this._count > 0) {
            const lastIdx = this._count - 1;
            if (clapIdx !== lastIdx) {
                this._paths[clapIdx] = this._paths[lastIdx];
                const src = lastIdx * DIM;
                const dst = clapIdx * DIM;
                this._matrix.copyWithin(dst, src, src + DIM);
                this._pathIndex.set(this._paths[clapIdx], clapIdx);
            }
            this._paths.pop();
            this._count--;
            this._pathIndex.delete(filePath);
        }

        try { this._stmts.deleteSpectral.run(filePath); } catch(e) {}

        try { this._stmts.deleteStats.run(); } catch(e) {}

        const specIdx = this._summaryPathIndex.has(filePath) ? this._summaryPathIndex.get(filePath) : -1;
        if (specIdx !== -1 && this._summaryCount > 0) {
            const lastIdx = this._summaryCount - 1;
            if (specIdx !== lastIdx) {
                this._summaryPaths[specIdx] = this._summaryPaths[lastIdx];
                const src = lastIdx * FEATURES_PER_WINDOW;
                const dst = specIdx * FEATURES_PER_WINDOW;
                this._summaryMatrix.copyWithin(dst, src, src + FEATURES_PER_WINDOW);
                this._summaryPathIndex.set(this._summaryPaths[specIdx], specIdx);
            }
            this._summaryPaths.pop();
            this._summaryCount--;
            this._summaryPathIndex.delete(filePath);
        }

        if (this._spectralCache && this._spectralCache._map) {
            this._spectralCache._map.delete(filePath);
        }

        this._hnsw = null;
        this._hnswCount = 0;
        const hnswPath = path.join(path.dirname(this._dbPath), 'soundvault-hnsw.idx');
        try { fs.unlinkSync(hnswPath); fs.unlinkSync(hnswPath + '.key'); } catch(e) {}

        console.log(`[Watcher] Removed from caches: ${path.basename(filePath)}`);
    }

    // ── Peak data from DB cache ──
    getPeaksFromDB(filePath) {
        try {
            const stat = fs.statSync(filePath);
            const row = this._stmts.selectPeaks.get(filePath, stat.mtimeMs);
            if (!row) return null;
            const peaks = new Float32Array(row.peaks.buffer, row.peaks.byteOffset, row.peaks.byteLength / 4);
            return { peaks, duration: row.duration_ms / 1000 };
        } catch(e) {
            return null;
        }
    }
}

module.exports = new SemanticEngine();
