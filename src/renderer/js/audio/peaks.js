// Renderer-side peaks cache + request batching.
// Peaks come from the main-process peaks worker (disk-cached, ~2 KB/file):
//   { peaks: Uint8Array(1024), rms: Uint8Array(1024), maxPeak, duration, sampleRate, channels, bits, format }
// Values are sqrt-companded bytes: amplitude = (q / 255)².
const cache = new Map();          // path -> data | null (known unreadable)
const MAX = 6000;
let queue = new Map();            // path -> {path, mtime, size}
let waiters = new Map();          // path -> [resolve]
let timer = null;

export function peaksFor(path) { return cache.has(path) ? cache.get(path) : undefined; }

export function setPeaks(path, data) {
    cache.set(path, data);
    if (cache.size > MAX) cache.delete(cache.keys().next().value);
}

export function dropPeaks(path) { cache.delete(path); }

/** Request peaks for an entry; resolves with data (or null if unreadable). Batched per frame. */
export function requestPeaks(entry) {
    const p = entry.path;
    if (cache.has(p)) return Promise.resolve(cache.get(p));
    return new Promise(resolve => {
        if (!waiters.has(p)) waiters.set(p, []);
        waiters.get(p).push(resolve);
        queue.set(p, { path: p, mtime: entry.mtime || 0, size: entry.size || 0 });
        if (!timer) timer = setTimeout(flush, 16);
    });
}

async function flush() {
    timer = null;
    const batch = [...queue.values()].reverse(); // newest first → visible rows win
    queue = new Map();
    for (let i = 0; i < batch.length; i += 200) {
        const part = batch.slice(i, i + 200);
        let res = {};
        try { res = await window.sv.audio.peaks(part); } catch (e) { console.warn('[peaks]', e.message); }
        for (const it of part) {
            const d = res[it.path];
            const data = d ? { ...d, peaks: toU8(d.peaks), rms: toU8(d.rms) } : null;
            if (d !== undefined) setPeaks(it.path, data);
            const ws = waiters.get(it.path);
            waiters.delete(it.path);
            if (ws) for (const w of ws) w(data);
        }
    }
}

const toU8 = v => (v instanceof Uint8Array ? v : v ? new Uint8Array(v.buffer ? v.buffer : v) : new Uint8Array(0));

/** Amplitude from a companded byte. */
export const amp = q => { const x = q / 255; return x * x; };

/** Build peak data from a decoded AudioBuffer region (editor / selection renders). */
export function peaksFromBuffer(buf, start = 0, end = buf.length, buckets = 2048) {
    const nc = buf.numberOfChannels, n = Math.max(1, end - start);
    const ch = []; for (let c = 0; c < nc; c++) ch.push(buf.getChannelData(c));
    const pk = new Float32Array(buckets), rm = new Float32Array(buckets), cnt = new Uint32Array(buckets), sq = new Float64Array(buckets);
    let maxPeak = 0;
    const step = Math.max(1, Math.floor(n / (buckets * 256)));
    for (let i = 0; i < n; i += step) {
        const b = Math.min(buckets - 1, Math.floor(i * buckets / n));
        let p = 0, s = 0;
        for (let c = 0; c < nc; c++) { const v = ch[c][start + i]; const a = v < 0 ? -v : v; if (a > p) p = a; s += v * v; }
        if (p > pk[b]) pk[b] = p;
        if (p > maxPeak) maxPeak = p;
        sq[b] += s / nc; cnt[b]++;
    }
    for (let i = 0; i < buckets; i++) rm[i] = cnt[i] ? Math.sqrt(sq[i] / cnt[i]) : (i ? rm[i - 1] : 0);
    for (let i = 1; i < buckets; i++) if (!cnt[i]) pk[i] = pk[i - 1];
    const q = a => { const o = new Uint8Array(a.length); for (let i = 0; i < a.length; i++) o[i] = Math.min(255, Math.round(Math.sqrt(a[i]) * 255)); return o; };
    return { peaks: q(pk), rms: q(rm), maxPeak: Math.min(1, maxPeak), duration: n / buf.sampleRate };
}
