'use strict';
/**
 * Echo core: pure math shared by the engine host, the matching worker, the
 * indexer and the migration. No I/O, unit-tested.
 *
 * Features are the 44-D windows of SpectralFingerprinter (2048-pt FFT, 25 ms
 * hop at 48 kHz): 0-12 MFCC · 13-25 Δ · 26-38 ΔΔ · 39 centroid · 40 flatness ·
 * 41 bandwidth · 42 ln(RMS) · 43 ZCR. They are stored RAW; every comparison
 * happens in one "z-space": raw features standardised with the library's
 * global mean/std, the same snapshot for the query and the candidates
 * (Echo audit C1/C2: mixing per-file and global normalisation broke recall).
 */
const F = 44;
const HOP_MS = 25;
const RMS_DIM = 42;
const FEATURE_VERSION = 2;
// Windows below -80 dBFS (ln 1e-4) carry no identity: digital silence is the
// same vector in every file and would match itself perfectly.
const SILENCE = Math.log(1e-4);

// ── float16 storage (half the size of float32, exact enough for z-scoring) ─
const _f32 = new Float32Array(1), _u32 = new Uint32Array(_f32.buffer);
function toHalf(v) {
    _f32[0] = v;
    const x = _u32[0];
    const sign = (x >>> 16) & 0x8000;
    let exp = (x >>> 23) & 0xff;
    let mant = x & 0x7fffff;
    if (exp === 0xff) return sign | 0x7c00 | (mant ? 0x200 : 0);          // inf / nan
    exp = exp - 127 + 15;
    if (exp >= 0x1f) return sign | 0x7bff;                                 // clamp to max finite
    if (exp <= 0) {
        if (exp < -10) return sign;                                        // underflow → ±0
        mant |= 0x800000;
        const shift = 14 - exp;
        let h = mant >> shift;
        if ((mant >> (shift - 1)) & 1) h++;                                // round half up
        return sign | h;
    }
    let h = sign | (exp << 10) | (mant >> 13);
    if (mant & 0x1000) h++;                                                // round to nearest
    return h;
}
const HALF = new Float32Array(65536);
for (let h = 0; h < 65536; h++) {
    const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, m = h & 0x3ff;
    HALF[h] = e === 0 ? s * m * 2 ** -24 : e === 31 ? (m ? NaN : s * Infinity) : s * (1 + m / 1024) * 2 ** (e - 15);
}
/** Float32Array → Uint8Array of little-endian halfs. */
function encodeHalf(arr) {
    const out = new Uint16Array(arr.length);
    for (let i = 0; i < arr.length; i++) out[i] = toHalf(arr[i]);
    return new Uint8Array(out.buffer);
}
/** Bytes (Buffer/Uint8Array) of halfs → Float32Array. */
function decodeHalf(bytes) {
    const n = bytes.byteLength >> 1;
    const u = (bytes.byteOffset & 1) === 0 ? new Uint16Array(bytes.buffer, bytes.byteOffset, n) : new Uint16Array(Uint8Array.from(bytes).buffer, 0, n);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = HALF[u[i]];
    return out;
}

// ── per-file summary ─────────────────────────────────────────────────────
/**
 * Sums over the non-silent windows (for exact global statistics) and the raw
 * "attack" window (loudest window) used for coarse search.
 */
function fileSummary(raw, W) {
    const sum = new Float64Array(F), sumSq = new Float64Array(F);
    let counted = 0, best = 0, bestR = -Infinity;
    for (let w = 0; w < W; w++) {
        const o = w * F, r = raw[o + RMS_DIM];
        if (r > bestR) { bestR = r; best = w; }
        if (!(r >= SILENCE)) continue;
        counted++;
        for (let d = 0; d < F; d++) { const v = raw[o + d]; sum[d] += v; sumSq[d] += v * v; }
    }
    return { sum, sumSq, counted, attack: raw.slice(best * F, best * F + F), loud: bestR >= SILENCE };
}

/** Rows stored by the pre-2.0 per-file z-scoring bug: every dim mean≈0 and std≈1 (or 0). */
function looksPerFileNormalised(raw, W) {
    if (W < 2) return false;
    let ones = 0;
    for (let d = 0; d < F; d++) {
        let s = 0, s2 = 0;
        for (let w = 0; w < W; w++) { const v = raw[w * F + d]; s += v; s2 += v * v; }
        const mu = s / W, sd = Math.sqrt(Math.max(0, s2 / W - mu * mu));
        if (Math.abs(mu) > 1e-3) return false;
        if (Math.abs(sd - 1) < 1e-3) ones++; else if (sd > 1e-6) return false;
    }
    return ones > 0;
}

// ── global statistics ────────────────────────────────────────────────────
/** Exact running global mean/std from per-file sums (add/remove, never drifts). */
class GlobalStats {
    constructor() { this.sum = new Float64Array(F); this.sumSq = new Float64Array(F); this.n = 0; this.files = 0; }
    add(s, sign = 1) {
        if (!s || s.counted < 2) return;                   // single-window files would skew the spread
        for (let d = 0; d < F; d++) { this.sum[d] += sign * s.sum[d]; this.sumSq[d] += sign * s.sumSq[d]; }
        this.n += sign * s.counted;
        this.files += sign;
    }
    remove(s) { this.add(s, -1); }
    snapshot(version) {
        const mean = new Float32Array(F), std = new Float32Array(F);
        const n = Math.max(1, this.n);
        for (let d = 0; d < F; d++) {
            const mu = this.sum[d] / n;
            mean[d] = mu;
            const sd = Math.sqrt(Math.max(0, this.sumSq[d] / n - mu * mu));
            std[d] = sd > 1e-6 ? sd : 1;
        }
        return { mean, std, version, files: this.files, windows: this.n };
    }
}

// ── z-space vectors ──────────────────────────────────────────────────────
function zUnitInto(out, o, raw, ro, st, fw) {
    let mag = 0;
    for (let d = 0; d < F; d++) {
        const v = (raw[ro + d] - st.mean[d]) / st.std[d] * (fw ? fw[d] : 1);
        out[o + d] = v; mag += v * v;
    }
    const k = mag > 0 ? 1 / Math.sqrt(mag) : 0;
    for (let d = 0; d < F; d++) out[o + d] *= k;
}

/** Unit z-space mean of a file (from its sums), the coarse "what it sounds like on average" vector. */
function meanVector(sum, counted, st, out = new Float32Array(F), o = 0) {
    if (!counted) { out.fill(0, o, o + F); return out; }
    const tmp = new Float32Array(F);
    for (let d = 0; d < F; d++) tmp[d] = sum[d] / counted;
    zUnitInto(out, o, tmp, 0, st, null);
    return out;
}

/**
 * Per-window unit vectors of (weights ∘ z(raw)) plus a silence mask.
 * @returns {{U: Float32Array, silent: Uint8Array, W: number}}
 */
function prepare(raw, W, st, fw) {
    const U = new Float32Array(W * F), silent = new Uint8Array(W);
    for (let w = 0; w < W; w++) {
        const o = w * F;
        silent[w] = raw[o + RMS_DIM] >= SILENCE ? 0 : 1;
        zUnitInto(U, o, raw, o, st, fw);
    }
    return { U, silent, W };
}

/**
 * Exact sliding match: mean per-window cosine of the query's audible windows
 * against every alignment in the candidate. Early exit is exact (each
 * remaining window can add at most 1).
 * When the query is longer than the candidate the candidate slides over the
 * query instead (never compare just a prefix), scaled by coverage in
 * fragment mode so a 0.2 s blip cannot "fully match" a 3 s selection.
 * @returns {{score:number, off:number, len:number, swapped:boolean}} off/len in candidate windows
 */
function match(q, c, { coverage = true, floor = -Infinity } = {}) {
    if (q.W <= c.W) {
        const r = slide(q.U, q.silent, q.W, c.U, c.W, floor);
        return { score: r.score, off: r.off, len: q.W, swapped: false };
    }
    const r = slide(c.U, c.silent, c.W, q.U, q.W);
    const cov = coverage ? c.W / q.W : 1;
    return { score: r.score * cov, off: 0, len: c.W, swapped: true, qOff: r.off };
}

/**
 * @param {number} floor  scores at or below it are not needed (the caller
 *   already holds enough better candidates): alignments stop as soon as they
 *   cannot beat max(best so far, floor). Results above the floor are exact.
 */
function slide(aU, aSilent, aW, bU, bW, floor = -Infinity) {
    const act = [];
    for (let w = 0; w < aW; w++) if (!aSilent[w]) act.push(w);
    const n = act.length;
    if (!n) return { score: -1, off: 0 };
    let best = -Infinity, bestOff = 0;
    const maxOff = bW - aW;
    for (let off = 0; off <= maxOff; off++) {
        let s = 0, k = 0, alive = true;
        for (; k < n; k++) {
            const w = act[k], ao = w * F, bo = (off + w) * F;
            let dot = 0;
            for (let d = 0; d < F; d += 4) dot += aU[ao + d] * bU[bo + d] + aU[ao + d + 1] * bU[bo + d + 1] + aU[ao + d + 2] * bU[bo + d + 2] + aU[ao + d + 3] * bU[bo + d + 3];
            s += dot;
            if (k >= 3 && (s + (n - k - 1)) / n <= (best > floor ? best : floor)) { alive = false; break; }
        }
        if (alive) { const v = s / n; if (v > best) { best = v; bestOff = off; } }
    }
    return { score: best === -Infinity ? floor : best, off: bestOff };
}

// ── calibration ──────────────────────────────────────────────────────────
// 90th percentile of the best WRONG match per query length, measured on the
// real 70k library (Echo audit §C6). A score at τ is "as good as chance".
const TAU = [[50, 0.975], [150, 0.904], [400, 0.900], [1000, 0.866], [3000, 0.830], [30000, 0.80]];
function tau(ms) {
    if (!(ms > TAU[0][0])) return TAU[0][1];
    for (let i = 1; i < TAU.length; i++) {
        const [m1, t1] = TAU[i];
        if (ms <= m1) {
            const [m0, t0] = TAU[i - 1];
            const f = (Math.log(ms) - Math.log(m0)) / (Math.log(m1) - Math.log(m0));
            return t0 + (t1 - t0) * f;
        }
    }
    return TAU[TAU.length - 1][1];
}
/** 0..1: how far a match sits above chance for a query of `ms` (never rank-normalised). */
function confidence(score, ms) {
    const t = tau(ms);
    return Math.max(0, Math.min(1, (score - t) / (1 - t)));
}
const IDENTICAL = 0.97;

module.exports = {
    F, HOP_MS, RMS_DIM, FEATURE_VERSION, SILENCE, IDENTICAL,
    toHalf, encodeHalf, decodeHalf,
    fileSummary, looksPerFileNormalised, GlobalStats,
    zUnitInto, meanVector, prepare, match, tau, confidence,
};
