'use strict';
/**
 * Indexing worker (spawned by the engine host while a catalog run is active).
 *
 * Decodes each file ONCE (native WAV reader + resampler; ffmpeg only for
 * compressed/odd WAVs) and computes what the host asked for:
 *   kind 'a'  first pass  → CLAP embedding of the first 10 s and/or the Echo
 *                           fingerprint, from the same decode
 *   kind 'b'  deep pass   → long files only: CLAP windows spread over the WHOLE
 *                           file (not just the first 2 minutes), mean-pooled
 * It never touches the database: results stream back to the host, which is
 * the single writer (stable ids, consistent in-memory caches).
 *
 * Protocol (host → worker):  init | run {runId, jobs} | cancel {runId} | shutdown
 *           (worker → host):  ready | init-error | items | progress | run-done
 */
const { parentPort } = require('worker_threads');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { decodeWavMono } = require('../audio/decode');
const { readWavInfo } = require('../audio/wav');

const SR = 48000;
const WIN_S = 10;                     // CLAP window
const FULL_MAX_S = 10.5;              // a single window covers the whole file
const SPECTRAL_S = 120;               // Echo fingerprint span (echo.js SPAN_MAX_MS)

let processor = null, audioModel = null, ffmpegPath = null;
let fingerprint = null;               // (samples) => spectral record
const cancelled = new Set();

// ── model / ffmpeg setup ──────────────────────────────────────────────────
function limitOrtThreads(n) {
    // transformers.js 2.x has no session options: cap ORT's intra-op pool so a
    // multi-hour catalog run leaves cores for the UI and live searches.
    try {
        const ort = require('onnxruntime-node');
        const create = ort.InferenceSession.create;
        if (create.__svPatched) return;
        const patched = function (arg, opts) { return create.call(this, arg, { ...(opts || {}), intraOpNumThreads: n, interOpNumThreads: 1 }); };
        patched.__svPatched = true;
        ort.InferenceSession.create = patched;
    } catch (e) { /* ORT not resolvable → defaults */ }
}

async function init({ ffmpegPath: fp, cacheDir, threads }) {
    ffmpegPath = fp || null;
    const n = os.cpus().length;
    limitOrtThreads(threads || Math.max(2, Math.min(n - 2, 8)));
    const { env, AutoProcessor, ClapAudioModelWithProjection } = require('@xenova/transformers');
    if (cacheDir) { env.cacheDir = cacheDir; env.localModelPath = cacheDir; env.allowRemoteModels = false; }
    processor = await AutoProcessor.from_pretrained('Xenova/clap-htsat-unfused');
    require('./clap-fbank').patchProcessor(processor);           // same log-mel, ~2.4× faster
    audioModel = await ClapAudioModelWithProjection.from_pretrained('Xenova/clap-htsat-unfused', { quantized: false });
    const { SpectralFingerprinter } = require('../spectral-engine');
    const core = require('./echo-core');
    const crypto = require('crypto');
    const fpr = new SpectralFingerprinter();
    fingerprint = (samples) => {
        const { matrix, numWindows } = fpr.extractRaw(samples, SR);
        // Audible-window sums let the host keep exact global statistics
        // (subtracted on delete/re-index instead of drifting forever).
        const s = core.fileSummary(matrix, numWindows);
        const data = core.encodeHalf(matrix);
        return {
            data, windows: numWindows, spanMs: Math.round(samples.length / SR * 1000),
            sum: s.sum, sumSq: s.sumSq, counted: s.counted, attack: s.attack,
            hash: crypto.createHash('md5').update(data).digest('hex'),
        };
    };
}

/**
 * A header of zeros is a file whose content never arrived (interrupted
 * download or copy): ffmpeg would guess a format from the noise after it.
 */
async function rejectZeroFilled(fp) {
    const fh = await fs.promises.open(fp, 'r');
    try {
        const b = Buffer.alloc(64);
        const { bytesRead } = await fh.read(b, 0, 64, 0);
        if (!bytesRead) throw new Error('Empty file');
        if (b.subarray(0, bytesRead).every(x => x === 0)) throw new Error('Damaged file: it is filled with zeros (incomplete download or copy)');
    } finally {
        await fh.close();
    }
}

/** Failure reasons as the user reads them in Settings (not ffmpeg log lines). */
function plainError(e) {
    const m = String((e && e.message) || e || 'Unknown error');
    if (/Invalid data found when processing input|does not contain any stream|Error opening output file/i.test(m)) return 'Not a readable WAV file (damaged, or another format renamed to .wav)';
    if (/Not yet implemented in FFmpeg/i.test(m)) return 'Unsupported WAV variant';
    if (/ENOENT/.test(m)) return 'File not found';
    if (/EBUSY|EPERM|EACCES/.test(m)) return 'The file is locked or cannot be read';
    return m;
}

/** ffmpeg fallback: mono f32 @48k from `start` for `max` seconds; parses the full duration from its log. */
function ffmpegDecode(fp, start, max) {
    return new Promise((resolve, reject) => {
        if (!ffmpegPath) { reject(new Error('Unsupported audio format')); return; }
        const { spawn } = require('child_process');
        const args = ['-hide_banner', '-nostdin'];
        if (start > 0) args.push('-ss', String(start));
        args.push('-i', fp);
        if (Number.isFinite(max)) args.push('-t', String(max));
        args.push('-vn', '-ac', '1', '-ar', String(SR), '-f', 'f32le', 'pipe:1');
        const p = spawn(ffmpegPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        const chunks = []; let log = '';
        p.stdout.on('data', c => chunks.push(c));
        p.stderr.on('data', c => { if (log.length < 16000) log += c; });
        p.on('error', reject);
        p.on('close', code => {
            const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(log);
            const duration = m ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) : null;
            const buf = Buffer.concat(chunks);
            const n = Math.floor(buf.byteLength / 4);
            if (!n) {
                const last = log.trim().split(/\r?\n/).filter(l => /error|invalid|could not/i.test(l)).pop();
                reject(new Error(code ? (last || 'Could not decode audio') : 'No audio data'));
                return;
            }
            const samples = new Float32Array(n);
            for (let i = 0; i < n; i++) samples[i] = buf.readFloatLE(i * 4);
            resolve({ samples, duration });
        });
    });
}

async function decode(fp, info, start, max) {
    const r = info ? await decodeWavMono(fp, { rate: SR, startSeconds: start, maxSeconds: max, info }) : null;
    if (r) return r;
    return ffmpegDecode(fp, start, max);
}

/** Window starts (seconds) for the deep pass: start/centre/end, plus quartiles past 30 s. */
function clapOffsets(duration) {
    if (!(duration > FULL_MAX_S)) return [0];
    const n = duration <= 30 ? 3 : 5;
    const last = duration - WIN_S;
    return Array.from({ length: n }, (_, i) => last * i / (n - 1));
}

async function embed(samples) {
    const inputs = await processor(samples.length > SR * WIN_S ? samples.subarray(0, SR * WIN_S) : samples);
    const { audio_embeds } = await audioModel(inputs);
    return new Float32Array(audio_embeds.data);
}

function normalized(v) {
    let s = 0; for (let i = 0; i < v.length; i++) s += v[i] * v[i];
    const k = s > 0 ? 1 / Math.sqrt(s) : 0;
    for (let i = 0; i < v.length; i++) v[i] *= k;
    return v;
}

// ── job pipeline ──────────────────────────────────────────────────────────
/** I/O + decode for one job (issued ahead of inference so disk reads overlap it). */
async function prepare(job) {
    const out = { job, duration: job.duration ?? null, samples: null, windows: null, error: null };
    try {
        if (!job.mtime || !job.size) {
            // The library had not stat-ed this file yet: record its real identity.
            const st = await fs.promises.stat(job.path);
            job.mtime = job.mtime || st.mtimeMs; job.size = job.size || st.size;
        }
        const info = await readWavInfo(job.path);
        if (info) out.duration = info.duration;
        else await rejectZeroFilled(job.path);                        // before spawning ffmpeg on it
        if (job.kind === 'a') {
            const need = Math.max(job.clap ? WIN_S : 0, job.spectral ? SPECTRAL_S : 0);
            const r = await decode(job.path, info, 0, need);
            out.samples = r.samples;
            if (!info && r.duration != null) out.duration = r.duration;
        } else if (!info) {
            // Compressed WAV: ffmpeg reports the duration while decoding the first window.
            const r = await ffmpegDecode(job.path, 0, WIN_S);
            out.duration = r.duration != null ? r.duration : (r.samples.length < WIN_S * SR ? r.samples.length / SR : null);
            if (out.duration == null) { out.error = 'Unknown duration'; return out; }
            if (out.duration <= FULL_MAX_S) return out;
            const offs = clapOffsets(out.duration);
            out.windows = [r.samples];
            for (let i = 1; i < offs.length; i++) out.windows.push((await ffmpegDecode(job.path, offs[i], WIN_S)).samples);
        } else {
            if (out.duration <= FULL_MAX_S) return out;                // short file: nothing to decode
            out.windows = [];
            for (const t of clapOffsets(out.duration)) out.windows.push((await decode(job.path, info, t, WIN_S)).samples);
        }
    } catch (e) {
        out.error = plainError(e);
    }
    return out;
}

async function compute(p) {
    const { job } = p;
    const item = { path: job.path, mtime: job.mtime, size: job.size || null, kind: job.kind, token: job.token, duration: p.duration };
    if (p.error) { item.error = p.error; return item; }
    try {
        if (job.kind === 'a') {
            if (!p.samples || !p.samples.length) throw new Error('No audio data');
            if (job.clap) {
                item.vector = await embed(p.samples);
                item.quality = p.duration != null && p.duration <= FULL_MAX_S ? 2 : 1;
            }
            if (job.spectral) item.spectral = fingerprint(p.samples.length > SPECTRAL_S * SR ? p.samples.subarray(0, SPECTRAL_S * SR) : p.samples);
        } else if (p.windows) {
            const mean = new Float32Array(512);
            let used = 0;
            for (const w of p.windows) {
                if (!w.length) continue;
                const v = normalized(await embed(w));
                for (let d = 0; d < 512; d++) mean[d] += v[d];
                used++;
            }
            if (!used) throw new Error('No audio data');
            item.vector = normalized(mean);
            item.quality = 2;
        } else {
            item.quality = 2;                                          // short file: the first-pass vector is already complete
            item.probeOnly = true;
        }
    } catch (e) {
        item.error = plainError(e);
        delete item.vector; delete item.spectral;
    }
    return item;
}

async function run(runId, jobs) {
    const t0 = Date.now();
    let batch = [], lastFlush = Date.now(), lastProgress = 0, done = 0, failed = 0;
    const flush = () => {
        if (!batch.length) return;
        const transfer = [];
        for (const it of batch) {
            if (it.vector) transfer.push(it.vector.buffer);
            if (it.spectral) transfer.push(it.spectral.data.buffer);
        }
        parentPort.postMessage({ type: 'items', runId, items: batch }, transfer);
        batch = [];
        lastFlush = Date.now();
    };
    let next = jobs.length ? prepare(jobs[0]) : null;
    for (let i = 0; i < jobs.length; i++) {
        if (cancelled.has(runId)) break;
        const p = await next;
        next = i + 1 < jobs.length ? prepare(jobs[i + 1]) : null;     // prefetch while this one computes
        const item = await compute(p);
        if (item.error) failed++;
        batch.push(item);
        done++;
        // Small batches at first so the catalog becomes searchable right away.
        if (batch.length >= (done <= 200 ? 4 : 32) || Date.now() - lastFlush > 1000) flush();
        if (Date.now() - lastProgress > 250) {
            lastProgress = Date.now();
            parentPort.postMessage({ type: 'progress', runId, done, total: jobs.length, file: path.basename(p.job.path) });
        }
    }
    if (next) await next.catch(() => {});
    flush();
    const wasCancelled = cancelled.delete(runId);
    parentPort.postMessage({ type: 'run-done', runId, done, failed, cancelled: wasCancelled, ms: Date.now() - t0 });
}

if (parentPort) parentPort.on('message', async msg => {
    if (!msg) return;
    if (msg.type === 'init') {
        try { await init(msg); parentPort.postMessage({ type: 'ready' }); }
        catch (e) { parentPort.postMessage({ type: 'init-error', error: (e && e.message) || String(e) }); }
    } else if (msg.type === 'run') {
        try { await run(msg.runId, msg.jobs || []); }
        catch (e) { parentPort.postMessage({ type: 'run-done', runId: msg.runId, error: (e && e.message) || String(e) }); }
    } else if (msg.type === 'cancel') {
        cancelled.add(msg.runId);
    } else if (msg.type === 'shutdown') {
        process.exit(0);
    }
});

module.exports = { clapOffsets, _bench: { init, prepare, compute, embed, fingerprintOf: s => fingerprint(s) } };
