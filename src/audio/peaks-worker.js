'use strict';
/**
 * Peaks worker (worker_thread). Computes list waveforms off the main thread
 * and caches them in soundvault-peaks.db (~2 KB per file):
 *   peaks/rms: BUCKETS × Uint8 each, sqrt-companded (more resolution for
 *   quiet material), plus max peak, duration and WAV format info.
 *
 * Protocol (parentPort):
 *   → { type:'init', dbPath, ffmpegPath }            ← { type:'ready' }
 *   → { type:'get', id, items:[{path,mtime,size}] }  ← { type:'result', id, results:{[path]:data|null} }
 *   → { type:'forget', paths:[...] }
 *   → { type:'shutdown' }
 * Newest requests are served first (visible rows win while scrolling).
 */
const { parentPort } = require('worker_threads');
const { computeWavPeaks, peaksFromChannels, readWavInfo } = require('./wav');

const BUCKETS = 1024;
let db = null, stmts = null, ffmpegPath = null;

function q8(arr) {
    const out = new Uint8Array(arr.length);
    for (let i = 0; i < arr.length; i++) out[i] = Math.min(255, Math.round(Math.sqrt(Math.max(0, arr[i])) * 255));
    return out;
}

function init(msg) {
    const Database = require('better-sqlite3');
    db = new Database(msg.dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.exec(`CREATE TABLE IF NOT EXISTS peaks (
        path TEXT PRIMARY KEY, mtime REAL, size INTEGER, buckets INTEGER,
        peaks BLOB, rms BLOB, max_peak REAL, duration REAL,
        sample_rate INTEGER, channels INTEGER, bits INTEGER, format INTEGER)`);
    stmts = {
        get: db.prepare('SELECT * FROM peaks WHERE path = ?'),
        put: db.prepare('INSERT OR REPLACE INTO peaks (path, mtime, size, buckets, peaks, rms, max_peak, duration, sample_rate, channels, bits, format) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'),
        del: db.prepare('DELETE FROM peaks WHERE path = ?'),
    };
    ffmpegPath = msg.ffmpegPath || null;
}

function rowToData(r) {
    return {
        peaks: new Uint8Array(r.peaks), rms: new Uint8Array(r.rms), maxPeak: r.max_peak,
        duration: r.duration, sampleRate: r.sample_rate, channels: r.channels, bits: r.bits, format: r.format,
    };
}

function ffmpegDecode(fp) {
    return new Promise((resolve, reject) => {
        if (!ffmpegPath) return reject(new Error('ffmpeg unavailable'));
        const { spawn } = require('child_process');
        const p = spawn(ffmpegPath, ['-v', 'error', '-i', fp, '-ac', '1', '-ar', '48000', '-f', 'f32le', 'pipe:1'], { windowsHide: true });
        const chunks = [];
        let bytes = 0;
        p.stdout.on('data', c => { chunks.push(c); bytes += c.length; if (bytes > 48000 * 4 * 1800) p.kill(); });
        p.on('error', reject);
        p.on('close', () => {
            const buf = Buffer.concat(chunks);
            if (buf.length < 4) return reject(new Error('no audio'));
            const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + (buf.length - buf.length % 4));
            resolve(new Float32Array(ab));
        });
    });
}

async function compute(item) {
    const fp = item.path;
    let info = await readWavInfo(fp);
    let res = info ? await computeWavPeaks(fp, BUCKETS, info) : null;
    if (!res) {
        // Tier 3: formats the direct parser can't read (ADPCM, µ-law, MP3-in-WAV…)
        try {
            const samples = await ffmpegDecode(fp);
            const r = peaksFromChannels([samples], BUCKETS);
            res = { ...r, info: { duration: samples.length / 48000, sampleRate: info?.sampleRate || 0, channels: info?.channels || 0, bitsPerSample: info?.bitsPerSample || 0, format: info?.format || 0 } };
        } catch (e) {
            // Negative cache: remember unreadable files (keyed by mtime+size)
            // so they are not re-decoded with ffmpeg on every scroll.
            try { stmts.put.run(fp, item.mtime || 0, item.size || 0, 0, Buffer.alloc(0), Buffer.alloc(0), 0, 0, 0, 0, 0, 0); } catch (e2) {}
            return null;
        }
    }
    const data = {
        peaks: q8(res.peaks), rms: q8(res.rms), maxPeak: res.maxPeak,
        duration: res.info.duration, sampleRate: res.info.sampleRate, channels: res.info.channels,
        bits: res.info.bitsPerSample, format: res.info.format,
    };
    try {
        stmts.put.run(fp, item.mtime || 0, item.size || 0, BUCKETS, Buffer.from(data.peaks), Buffer.from(data.rms),
            data.maxPeak, data.duration, data.sampleRate, data.channels, data.bits, data.format);
    } catch (e) { /* cache write failures are non-fatal */ }
    return data;
}

// ── scheduling: LIFO over requests, bounded parallel I/O ─────────────
const pending = [];          // stack of { id, items, results, left }
const inflight = new Map();  // path -> Promise<data>
let active = 0;
const MAX_ACTIVE = 4;

/** undefined = miss, null = known-unreadable, object = cached peaks */
function cached(item) {
    const r = stmts.get.get(item.path);
    if (!r || Math.abs((r.mtime || 0) - (item.mtime || 0)) >= 1 || (item.size && r.size !== item.size)) return undefined;
    if (r.buckets === 0) return null;
    return r.buckets === BUCKETS ? rowToData(r) : undefined;
}

function pump() {
    while (active < MAX_ACTIVE && pending.length) {
        const job = pending[pending.length - 1];
        const item = job.items.shift();
        if (!item) { pending.pop(); continue; }
        active++;
        let p = inflight.get(item.path);
        if (!p) { p = compute(item).catch(() => null).finally(() => inflight.delete(item.path)); inflight.set(item.path, p); }
        p.then(data => {
            job.results[item.path] = data;
            if (--job.left === 0) parentPort.postMessage({ type: 'result', id: job.id, results: job.results });
        }).finally(() => { active--; pump(); });
    }
}

parentPort.on('message', msg => {
    try {
        if (msg.type === 'init') { init(msg); parentPort.postMessage({ type: 'ready' }); return; }
        if (msg.type === 'get') {
            const results = {};
            const todo = [];
            for (const it of msg.items || []) {
                if (!it || !it.path || results[it.path] !== undefined) continue;
                const c = cached(it);
                if (c !== undefined) results[it.path] = c; else { results[it.path] = null; todo.push(it); }
            }
            if (!todo.length) { parentPort.postMessage({ type: 'result', id: msg.id, results }); return; }
            pending.push({ id: msg.id, items: todo, results, left: todo.length });
            pump();
            return;
        }
        if (msg.type === 'forget') { for (const p of msg.paths || []) stmts.del.run(p); return; }
        if (msg.type === 'shutdown') { try { db && db.close(); } catch (e) {} process.exit(0); }
    } catch (e) {
        if (msg && msg.id) parentPort.postMessage({ type: 'result', id: msg.id, results: {}, error: e.message });
    }
});
