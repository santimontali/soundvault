// Editor DSP: pure and DOM-free (imported by the editor UI and by node tests).
//
// Coordinates. Every handle is a time in SECONDS on the editor's displayed
// ("visual") axis, measured from the start of the edited region
// (0 … duration). The visual axis is the region itself, mirrored when
// `reverse` is on:
//     source time u (seconds into the region) = reverse ? duration - v : v
//
// Pipeline (the same for previews, the picture and exports):
//     crop (visual cropStart…cropEnd, played left → right; reverse is implicit
//     in the mapping) → fades at the OUTPUT edges (after reverse) → gain →
//     varispeed (tape style: pitch and length change together).
//
// Handles always satisfy  0 ≤ cropStart ≤ fadeInEnd ≤ fadeOutStart ≤ cropEnd ≤ duration
// (and cropEnd - cropStart ≥ MIN_CROP). normalizeEdit() is the ONLY place that
// enforces it: the handle being moved wins, the others are pushed.

export const DSP_VERSION = 1;
export const MIN_CROP = 0.001;                 // seconds kept at least
export const GAIN_MIN = -60, GAIN_MAX = 48;    // dB (normalize may need a lot on quiet files)
export const PITCH_MIN = -48, PITCH_MAX = 48;  // semitones
export const FADE_SHAPES = ['power', 'scurve', 'equal'];

/** Right-click presets. `tension` bends the curve (drag the curve vertically). */
export const FADE_PRESETS = [
    { id: 'linear', label: 'Linear', shape: 'power', tension: 0 },
    { id: 'fast', label: 'Fast start (log)', shape: 'power', tension: -0.5 },
    { id: 'slow', label: 'Slow start (exp)', shape: 'power', tension: 0.5 },
    { id: 'scurve', label: 'S-curve', shape: 'scurve', tension: 0 },
    { id: 'equal', label: 'Equal power', shape: 'equal', tension: 0 },
];

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const num = (v, d) => (Number.isFinite(+v) ? +v : d);

export const dbToGain = db => Math.pow(10, db / 20);
export const gainToDb = g => (g > 0 ? 20 * Math.log10(g) : -Infinity);
export const rateOf = semitones => Math.pow(2, (semitones || 0) / 12);

/**
 * Fade gain for t ∈ [0, 1] (0 = silent edge, 1 = full level).
 *  power  : t^(10^tension)                    tension 0 = linear, >0 slow start, <0 fast start
 *  scurve : p/(p + q), p = t^a, q = (1-t)^a    a = 2·4^tension (a real S at tension 0)
 *  equal  : sin(π/2 · t^(10^tension))         equal-power (constant-power crossfade) at tension 0
 */
export function fadeGain(t, shape = 'power', tension = 0) {
    if (!(t > 0)) return 0;
    if (t >= 1) return 1;
    const k = clamp(num(tension, 0), -1, 1);
    if (shape === 'scurve') {
        const a = 2 * Math.pow(4, k);
        const p = Math.pow(t, a), q = Math.pow(1 - t, a);
        return p / (p + q);
    }
    const w = k === 0 ? t : Math.pow(t, Math.pow(10, k));
    if (shape === 'equal') return Math.sin(w * Math.PI / 2);
    return w;
}

// ── edit state ──────────────────────────────────────────────────────────
/**
 * @param {number} duration  region length in seconds
 * @param {object} [init]    any subset of the fields below; `fadeIn`/`fadeOut`
 *                           (lengths in seconds) are accepted as a convenience
 */
export function createEdit(duration, init = {}) {
    const D = Math.max(0, num(duration, 0));
    const e = {
        duration: D,
        cropStart: 0, cropEnd: D, fadeInEnd: 0, fadeOutStart: D,
        fadeInShape: 'power', fadeInTension: 0,
        fadeOutShape: 'power', fadeOutTension: 0,
        gainDb: 0, semitones: 0, reverse: false,
        ...init,
    };
    if (init.fadeIn !== undefined && init.fadeInEnd === undefined) e.fadeInEnd = num(e.cropStart, 0) + Math.max(0, num(init.fadeIn, 0));
    if (init.fadeOut !== undefined && init.fadeOutStart === undefined) e.fadeOutStart = num(e.cropEnd, D) - Math.max(0, num(init.fadeOut, 0));
    delete e.fadeIn; delete e.fadeOut;
    return normalizeEdit(e);
}

/**
 * THE handle-order rule. Returns a new, valid edit.
 * `moved` names the handle the user is dragging ('cropStart' | 'cropEnd' |
 * 'fadeInEnd' | 'fadeOutStart'); it keeps its value (clamped to what is
 * possible) and pushes the others. Without `moved`, values are fixed left→right.
 */
export function normalizeEdit(input, moved = null) {
    const e = { ...input };
    const D = Math.max(0, num(e.duration, 0));
    const min = Math.min(MIN_CROP, D);
    let cs = num(e.cropStart, 0), ce = num(e.cropEnd, D), fi = num(e.fadeInEnd, cs), fo = num(e.fadeOutStart, ce);
    if (moved === 'cropEnd') { ce = clamp(ce, min, D); cs = clamp(cs, 0, ce - min); }
    else { cs = clamp(cs, 0, D - min); ce = clamp(ce, cs + min, D); }
    if (moved === 'fadeOutStart' || moved === 'cropEnd') { fo = clamp(fo, cs, ce); fi = clamp(fi, cs, fo); }
    else { fi = clamp(fi, cs, ce); fo = clamp(fo, fi, ce); }
    e.duration = D; e.cropStart = cs; e.cropEnd = ce; e.fadeInEnd = fi; e.fadeOutStart = fo;
    e.fadeInShape = FADE_SHAPES.includes(e.fadeInShape) ? e.fadeInShape : 'power';
    e.fadeOutShape = FADE_SHAPES.includes(e.fadeOutShape) ? e.fadeOutShape : 'power';
    e.fadeInTension = clamp(num(e.fadeInTension, 0), -1, 1);
    e.fadeOutTension = clamp(num(e.fadeOutTension, 0), -1, 1);
    e.gainDb = clamp(num(e.gainDb, 0), GAIN_MIN, GAIN_MAX);
    e.semitones = clamp(num(e.semitones, 0), PITCH_MIN, PITCH_MAX);
    e.reverse = !!e.reverse;
    return e;
}

export const HANDLES = ['cropStart', 'fadeInEnd', 'fadeOutStart', 'cropEnd'];
export function isOrdered(e, eps = 1e-9) {
    return e.cropStart >= -eps && e.cropStart <= e.fadeInEnd + eps && e.fadeInEnd <= e.fadeOutStart + eps &&
        e.fadeOutStart <= e.cropEnd + eps && e.cropEnd <= e.duration + eps && e.cropEnd - e.cropStart >= Math.min(MIN_CROP, e.duration) - eps;
}

export function moveHandle(e, which, value) { return normalizeEdit({ ...e, [which]: value }, which); }

/** Slip: move the kept window (crop + fades) over the audio. */
export function slipEdit(e, delta) {
    const d = clamp(delta, -e.cropStart, e.duration - e.cropEnd);
    return normalizeEdit({ ...e, cropStart: e.cropStart + d, cropEnd: e.cropEnd + d, fadeInEnd: e.fadeInEnd + d, fadeOutStart: e.fadeOutStart + d });
}

/** Link: move one crop edge together with its fade (fade length kept). */
export function linkEdit(e, side, delta) {
    if (side === 'in') {
        const d = clamp(delta, -e.cropStart, e.fadeOutStart - e.fadeInEnd);
        return normalizeEdit({ ...e, cropStart: e.cropStart + d, fadeInEnd: e.fadeInEnd + d });
    }
    const d = clamp(delta, e.fadeInEnd - e.fadeOutStart, e.duration - e.cropEnd);
    return normalizeEdit({ ...e, cropEnd: e.cropEnd + d, fadeOutStart: e.fadeOutStart + d });
}

/**
 * Reverse keeps the SAME audio and the fade lengths at the output edges:
 * the crop is mirrored on the visual axis, fade-in stays the fade-in.
 */
export function toggleReverse(e) {
    const D = e.duration;
    const fiLen = e.fadeInEnd - e.cropStart, foLen = e.cropEnd - e.fadeOutStart;
    const cs = D - e.cropEnd, ce = D - e.cropStart;
    return normalizeEdit({ ...e, reverse: !e.reverse, cropStart: cs, cropEnd: ce, fadeInEnd: cs + fiLen, fadeOutStart: ce - foLen });
}

export const visualToSource = (e, v) => (e.reverse ? e.duration - v : v);
export const sourceToVisual = (e, u) => (e.reverse ? e.duration - u : u);
/** Kept part of the region in SOURCE time (seconds into the region). */
export function sourceRange(e) {
    return e.reverse ? { start: e.duration - e.cropEnd, end: e.duration - e.cropStart } : { start: e.cropStart, end: e.cropEnd };
}
export const fadeLengths = e => ({ fadeIn: e.fadeInEnd - e.cropStart, fadeOut: e.cropEnd - e.fadeOutStart });
export const cropLength = e => e.cropEnd - e.cropStart;
export const outputDuration = e => cropLength(e) / rateOf(e.semitones);

/** Fade envelope (no gain) at visual time v. 0 outside the crop. */
export function envelopeAt(e, v) {
    if (v < e.cropStart || v > e.cropEnd) return 0;
    let g = 1;
    const fi = e.fadeInEnd - e.cropStart, fo = e.cropEnd - e.fadeOutStart;
    if (fi > 0 && v < e.fadeInEnd) g = fadeGain((v - e.cropStart) / fi, e.fadeInShape, e.fadeInTension);
    if (fo > 0 && v > e.fadeOutStart) g = Math.min(g, fadeGain((e.cropEnd - v) / fo, e.fadeOutShape, e.fadeOutTension));
    return g;
}

/** Largest envelope value over the visual interval [v0, v1] (fades are monotonic). */
export function envelopeMax(e, v0, v1) {
    if (v1 < e.cropStart || v0 > e.cropEnd) return 0;
    const a = Math.max(v0, e.cropStart), b = Math.min(v1, e.cropEnd);
    if (a <= e.fadeOutStart && b >= e.fadeInEnd) return 1;
    return Math.max(envelopeAt(e, a), envelopeAt(e, b));
}

/**
 * Envelope sampled along the crop (for the live preview's control signal):
 * value i = envelope at visual time cropStart + i/rate.
 */
export function envelopeSamples(e, rate) {
    const L = cropLength(e);
    const n = Math.max(2, Math.ceil(L * rate) + 1);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = envelopeAt(e, Math.min(e.cropEnd, e.cropStart + i / rate));
    return out;
}

/** Structural equality of two edits (float tolerant). */
export function editsEqual(a, b, eps = 1e-9) {
    if (!a || !b) return a === b;
    for (const k of ['duration', 'cropStart', 'cropEnd', 'fadeInEnd', 'fadeOutStart', 'fadeInTension', 'fadeOutTension', 'gainDb', 'semitones']) if (Math.abs(a[k] - b[k]) > eps) return false;
    return a.fadeInShape === b.fadeInShape && a.fadeOutShape === b.fadeOutShape && !!a.reverse === !!b.reverse;
}

/**
 * The list selection moved (region start/end in FILE seconds): keep the kept
 * audio where it is in the file (clamped to the new region) and the fade lengths.
 */
export function rebaseEdit(e, oldRegion, newRegion) {
    const D = Math.max(0, newRegion.end - newRegion.start);
    const src = sourceRange(e);
    let u0 = oldRegion.start + src.start - newRegion.start, u1 = oldRegion.start + src.end - newRegion.start;
    u0 = clamp(u0, 0, D); u1 = clamp(u1, 0, D);
    if (u1 - u0 < Math.min(MIN_CROP, D)) { u0 = 0; u1 = D; }
    const { fadeIn, fadeOut } = fadeLengths(e);
    const cs = e.reverse ? D - u1 : u0, ce = e.reverse ? D - u0 : u1;
    return normalizeEdit({ ...e, duration: D, cropStart: cs, cropEnd: ce, fadeInEnd: cs + fadeIn, fadeOutStart: ce - fadeOut });
}

/** "Trim selection to crop": the new region is the kept audio; the edit keeps fades/shapes/gain/pitch/reverse. */
export function trimToCrop(e, region) {
    const src = sourceRange(e);
    const next = { start: region.start + src.start, end: region.start + src.end };
    const D = next.end - next.start;
    const { fadeIn, fadeOut } = fadeLengths(e);
    return { region: next, edit: normalizeEdit({ ...e, duration: D, cropStart: 0, cropEnd: D, fadeInEnd: fadeIn, fadeOutStart: D - fadeOut }) };
}

// ── list selections (quick trim in Sound mode) ─────────────────────────
/**
 * A list selection's fades as an edit of the selected region: the editor's own
 * model, so a selection draws, plays and renders exactly like the editor would.
 * s: { start, end, fadeIn, fadeOut (seconds), fadeInShape, fadeInTension,
 * fadeOutShape, fadeOutTension }; missing shapes are linear.
 */
export function selectionEdit(s) {
    return createEdit(Math.max(0, num(s.end, 0) - num(s.start, 0)), {
        fadeIn: Math.max(0, num(s.fadeIn, 0)), fadeOut: Math.max(0, num(s.fadeOut, 0)),
        fadeInShape: s.fadeInShape, fadeInTension: s.fadeInTension, fadeOutShape: s.fadeOutShape, fadeOutTension: s.fadeOutTension,
    });
}

/**
 * One fade's own gain at visual time v: the fade-in rises over [cropStart, fadeInEnd],
 * the fade-out falls over [fadeOutStart, cropEnd], 1 anywhere else. Fades never
 * overlap (normalizeEdit), so fadeAt(in) × fadeAt(out) is envelopeAt inside the crop.
 */
export function fadeAt(e, side, v) {
    if (side === 'in') {
        const L = e.fadeInEnd - e.cropStart;
        return L > 0 && v < e.fadeInEnd ? fadeGain((v - e.cropStart) / L, e.fadeInShape, e.fadeInTension) : 1;
    }
    const L = e.cropEnd - e.fadeOutStart;
    return L > 0 && v > e.fadeOutStart ? fadeGain((e.cropEnd - v) / L, e.fadeOutShape, e.fadeOutTension) : 1;
}

/**
 * A list selection rendered: its region with the fades, sample for sample what
 * renderEdit gives for selectionEdit(s) (no gain, pitch or reverse), only faster:
 * the region is copied and just the fade samples are computed.
 * src: { channels: Float32Array[], sampleRate } of the whole file.
 */
export function renderSelection(src, s) {
    const e = selectionEdit(s), sr = src.sampleRate, n = src.channels.length ? src.channels[0].length : 0;
    const a = clamp(Math.round(num(s.start, 0) * sr), 0, n), b = clamp(Math.round((num(s.start, 0) + e.duration) * sr), a, n);
    const len = b - a, FI = (e.fadeInEnd - e.cropStart) * sr, FO = (e.cropEnd - e.fadeOutStart) * sr;
    const out = src.channels.map(c => c.slice(a, b));
    const env = k => {
        let g = 1;
        if (FI > 0 && k < FI) g = fadeGain(k / FI, e.fadeInShape, e.fadeInTension);
        const back = len - 1 - k;
        if (FO > 0 && back < FO) g = Math.min(g, fadeGain(back / FO, e.fadeOutShape, e.fadeOutTension));
        return g;
    };
    const kIn = Math.min(len, Math.ceil(FI)), kOut = Math.max(kIn, Math.floor(len - 1 - FO));
    for (let k = 0; k < kIn; k++) { const g = env(k); for (const d of out) d[k] *= g; }
    for (let k = kOut; k < len; k++) { const g = env(k); for (const d of out) d[k] *= g; }
    return { channels: out, sampleRate: sr, frames: len };
}

/** n evenly spaced samples of one fade from visual time `from` to `to` (for Web Audio's setValueCurveAtTime). */
export function fadeCurve(e, side, from, to, n) {
    const out = new Float32Array(Math.max(2, n | 0));
    const m = out.length - 1;
    for (let i = 0; i <= m; i++) out[i] = fadeAt(e, side, from + (to - from) * i / m);
    return out;
}

/**
 * The tension that makes a fade pass through gain `g` at relative position `t`
 * (0..1 from the silent edge): how a curve dragged by the pointer follows it.
 * fadeGain is monotonic in the tension for every shape, so a bisection finds it;
 * beyond the model's range the result is clamped to ±1. Returns null where the
 * tension does not move the curve (an S-curve's middle).
 */
export function tensionThrough(shape, t, g) {
    t = clamp(num(t, 0.5), 1e-4, 1 - 1e-4);
    g = clamp(num(g, 0.5), 1e-6, 1 - 1e-6);
    const f = k => fadeGain(t, shape, k);
    let lo = -1, hi = 1;
    const flo = f(lo), fhi = f(hi);
    if (Math.abs(flo - fhi) < 1e-9) return null;
    const falling = flo > fhi;                           // gain falls as the tension rises (the usual case)
    if (falling ? g >= flo : g <= flo) return lo;
    if (falling ? g <= fhi : g >= fhi) return hi;
    for (let i = 0; i < 60; i++) {
        const mid = (lo + hi) / 2;
        if ((f(mid) > g) === falling) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
}

/** Words for a fade's curve (readouts): "Linear", "Fast start 40%", "Slow start 25%", "S-curve, sharper 30%", "Equal power". */
export function describeFade(shape, tension) {
    const k = clamp(num(tension, 0), -1, 1), pct = Math.round(Math.abs(k) * 100);
    if (shape === 'scurve') return pct < 3 ? 'S-curve' : `S-curve, ${k > 0 ? 'sharper' : 'softer'} ${pct}%`;
    const bend = pct < 3 ? '' : k < 0 ? `fast start ${pct}%` : `slow start ${pct}%`;
    if (shape === 'equal') return bend ? `Equal power, ${bend}` : 'Equal power';
    return bend ? bend.charAt(0).toUpperCase() + bend.slice(1) : 'Linear';
}

// ── hashing (export de-dup keys) ────────────────────────────────────────
/** Deterministic 64-bit FNV-1a (two 32-bit lanes) of any JSON-able value → 16 hex chars. */
export function hashKey(value) {
    const s = typeof value === 'string' ? value : JSON.stringify(value);
    let h1 = 0x811c9dc5, h2 = 0x01000193 ^ 0x5bd1e995;
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
        h2 = Math.imul(h2 ^ c, 0x01000197) >>> 0;
    }
    return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

/** Canonical, rounded parameter list for keys (so float noise never changes a key). */
export function editSignature(e) {
    const r = v => Math.round(v * 1e6) / 1e6;
    return [DSP_VERSION, r(e.duration), r(e.cropStart), r(e.cropEnd), r(e.fadeInEnd), r(e.fadeOutStart), e.fadeInShape, r(e.fadeInTension), e.fadeOutShape, r(e.fadeOutTension), r(e.gainDb), r(e.semitones), e.reverse ? 1 : 0];
}

// ── resamplers (varispeed) ──────────────────────────────────────────────
/** Linear interpolation: what Web Audio's playbackRate does (preview). out[m] = x(m·rate). */
export function resampleLinear(x, rate, outLen) {
    const out = new Float32Array(outLen), n = x.length;
    for (let m = 0; m < outLen; m++) {
        const p = m * rate, i = Math.floor(p), f = p - i;
        const a = i < n ? x[i] : 0, b = i + 1 < n ? x[i + 1] : 0;
        out[m] = a + f * (b - a);
    }
    return out;
}

function besselI0(x) {
    let sum = 1, term = 1;
    const q = (x * x) / 4;
    for (let k = 1; k < 64; k++) { term *= q / (k * k); sum += term; if (term < sum * 1e-17) break; }
    return sum;
}

const SINC = { zeros: 24, beta: 9, oversample: 512, cutoff: 0.91 };
let sincTable = null;
function kernelTable() {
    if (sincTable) return sincTable;
    const { zeros, beta, oversample } = SINC;
    const N = zeros * oversample;
    const tab = new Float32Array(N + 2);
    const i0b = besselI0(beta);
    for (let i = 0; i <= N + 1; i++) {
        const t = i / oversample;                 // distance in zero-crossings
        const x = t / zeros;
        const w = x >= 1 ? 0 : besselI0(beta * Math.sqrt(1 - x * x)) / i0b;
        tab[i] = (t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t)) * w;
    }
    return (sincTable = tab);
}

/**
 * Band-limited varispeed: out[m] = x(m·rate) through a Kaiser-windowed sinc
 * (24 zero crossings, β = 9 ≈ -90 dB stopband) whose cutoff follows the lower of
 * the two Nyquists (anti-aliasing when speeding up, anti-imaging when slowing
 * down). Generator: yields every `chunk` output samples for time slicing.
 */
export function* resampleSincSteps(x, rate, outLen, chunk = 8192) {
    const tab = kernelTable();
    const { zeros, oversample, cutoff } = SINC;
    const fc = cutoff * Math.min(1, 1 / rate);
    const half = zeros / fc;
    const scale = oversample * fc;
    const out = new Float32Array(outLen), n = x.length;
    for (let m = 0; m < outLen; m++) {
        const p = m * rate;
        const j0 = Math.max(0, Math.ceil(p - half)), j1 = Math.min(n - 1, Math.floor(p + half));
        let acc = 0;
        for (let j = j0; j <= j1; j++) {
            const d = (p > j ? p - j : j - p) * scale;
            const i = d | 0;
            acc += x[j] * (tab[i] + (d - i) * (tab[i + 1] - tab[i]));
        }
        out[m] = acc * fc;
        if ((m & (chunk - 1)) === chunk - 1) yield m;
    }
    return out;
}
export function resampleSinc(x, rate, outLen) { const it = resampleSincSteps(x, rate, outLen); let r; while (!(r = it.next()).done); return r.value; }

// ── render ──────────────────────────────────────────────────────────────
/**
 * Render an edit.
 * @param {{channels: Float32Array[], sampleRate: number, offset?: number}} src
 *        full decoded channels; `offset` = region start (seconds) inside them
 * @param {object} e  edit (normalized)
 * @param {{resampler?: 'sinc'|'linear', maxSamples?: number, chunk?: number}} [opts]
 * @returns generator → {channels, sampleRate, frames, peak}
 */
export function* renderSteps(src, e, opts = {}) {
    const resampler = opts.resampler || 'sinc';
    const chunk = opts.chunk || 65536;
    const sr = src.sampleRate, chans = src.channels, nc = chans.length;
    const n = nc ? chans[0].length : 0;
    const off = src.offset || 0;
    const range = sourceRange(e);
    const a = clamp(Math.round((off + range.start) * sr), 0, n);
    const b = clamp(Math.round((off + range.end) * sr), a, n);
    const len = b - a;
    const rev = !!e.reverse;
    const FI = (e.fadeInEnd - e.cropStart) * sr, FO = (e.cropEnd - e.fadeOutStart) * sr;
    const g = dbToGain(e.gainDb);
    const rate = rateOf(e.semitones);
    const outLen = Math.abs(e.semitones) < 1e-6 ? len : Math.max(len ? 1 : 0, Math.round(len / rate));
    const maxSamples = opts.maxSamples || 2 ** 27;
    if (outLen * nc > maxSamples) throw new Error(`The result would be ${(outLen / sr / 60).toFixed(1)} min long, too long to render`);
    // stage 1: crop + reverse + fades + gain
    const stage = [];
    for (let c = 0; c < nc; c++) stage.push(new Float32Array(len));
    for (let k = 0; k < len; k++) {
        let env = 1;
        if (FI > 0 && k < FI) env = fadeGain(k / FI, e.fadeInShape, e.fadeInTension);
        const back = len - 1 - k;
        if (FO > 0 && back < FO) env = Math.min(env, fadeGain(back / FO, e.fadeOutShape, e.fadeOutTension));
        env *= g;
        const idx = rev ? b - 1 - k : a + k;
        for (let c = 0; c < nc; c++) stage[c][k] = chans[c][idx] * env;
        if ((k & (chunk - 1)) === chunk - 1) yield k;
    }
    // stage 2: varispeed
    let out = stage;
    if (outLen !== len || Math.abs(e.semitones) >= 1e-6) {
        out = [];
        for (let c = 0; c < nc; c++) {
            if (resampler === 'linear') out.push(resampleLinear(stage[c], rate, outLen));
            else out.push(yield* resampleSincSteps(stage[c], rate, outLen, Math.max(1024, chunk >> 4)));
        }
    }
    let peak = 0;
    for (let c = 0; c < nc; c++) { const d = out[c]; for (let i = 0; i < d.length; i++) { const v = d[i] < 0 ? -d[i] : d[i]; if (v > peak) peak = v; } }
    return { channels: out, sampleRate: sr, frames: outLen, peak };
}

export function renderEdit(src, e, opts = {}) {
    const it = renderSteps(src, e, opts);
    let r;
    while (!(r = it.next()).done);
    return r.value;
}

const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
/** Time-sliced render (keeps the UI responsive). Resolves null when `opts.cancelled()` turns true. */
export async function renderEditAsync(src, e, opts = {}) {
    const it = renderSteps(src, e, opts);
    const slice = opts.sliceMs || 10;
    let t = nowMs();
    for (;;) {
        const r = it.next();
        if (r.done) return r.value;
        if (opts.cancelled && opts.cancelled()) return null;
        if (nowMs() - t > slice) { await new Promise(res => setTimeout(res, 0)); t = nowMs(); if (opts.cancelled && opts.cancelled()) return null; }
    }
}

/** Peak of the edited signal before varispeed and gain (for normalize / clip checks). */
export function editPeak(src, e) {
    const sr = src.sampleRate, chans = src.channels, n = chans.length ? chans[0].length : 0, off = src.offset || 0;
    const range = sourceRange(e);
    const a = clamp(Math.round((off + range.start) * sr), 0, n), b = clamp(Math.round((off + range.end) * sr), a, n);
    const len = b - a, FI = (e.fadeInEnd - e.cropStart) * sr, FO = (e.cropEnd - e.fadeOutStart) * sr;
    let peak = 0;
    for (let k = 0; k < len; k++) {
        let env = 1;
        if (FI > 0 && k < FI) env = fadeGain(k / FI, e.fadeInShape, e.fadeInTension);
        const back = len - 1 - k;
        if (FO > 0 && back < FO) env = Math.min(env, fadeGain(back / FO, e.fadeOutShape, e.fadeOutTension));
        if (env === 0) continue;
        const idx = e.reverse ? b - 1 - k : a + k;
        for (let c = 0; c < chans.length; c++) { const v = Math.abs(chans[c][idx]) * env; if (v > peak) peak = v; }
    }
    return peak;
}

/** Gain (dB) that puts the edit's peak at `targetDb` dBFS. Returns the current gain when silent. */
export function normalizeGainDb(src, e, targetDb = -0.1) {
    const p = editPeak(src, e);
    if (!(p > 1e-9)) return e.gainDb;
    return clamp(targetDb - gainToDb(p), GAIN_MIN, GAIN_MAX);
}

// ── zero crossings ──────────────────────────────────────────────────────
/**
 * Nearest zero crossing of the channel sum to sample `index` (within ±radius).
 * Returns the sample (of the two straddling the crossing) closest to zero, or
 * the quietest sample in the window when the signal never crosses zero there.
 */
export function nearestZeroCrossing(channels, index, radius) {
    const n = channels.length ? channels[0].length : 0;
    if (!n) return index;
    const i0 = clamp(Math.round(index), 0, n - 1);
    const sum = i => { let s = 0; for (let c = 0; c < channels.length; c++) s += channels[c][i]; return s; };
    const r = Math.max(1, Math.round(radius));
    let best = -1, bestD = Infinity, quiet = i0, quietV = Math.abs(sum(i0));
    for (let d = 0; d <= r; d++) {
        for (const i of d ? [i0 - d, i0 + d] : [i0]) {
            if (i < 1 || i >= n) continue;
            const a = sum(i - 1), b = sum(i);
            const av = Math.abs(b);
            if (av < quietV) { quietV = av; quiet = i; }
            if ((a <= 0 && b >= 0) || (a >= 0 && b <= 0)) {
                const pick = Math.abs(a) < Math.abs(b) ? i - 1 : i;
                if (d < bestD) { bestD = d; best = pick; }
            }
        }
        if (best >= 0) break;
    }
    return best >= 0 ? best : quiet;
}

// ── waveform index (min/max/RMS pyramid) ────────────────────────────────
/**
 * Pyramid over samples [start, end) of each channel: level 0 blocks of `base`
 * samples, every level above halves the block count. Queries are exact: full
 * blocks come from the pyramid, partial blocks from the raw samples.
 */
export function buildWaveIndex(channels, start = 0, end = channels.length ? channels[0].length : 0, base = 64) {
    const nc = channels.length, len = Math.max(0, end - start);
    const levels = [];
    let n = Math.ceil(len / base);
    const L0 = { n, min: [], max: [], sq: [] };
    for (let c = 0; c < nc; c++) {
        const x = channels[c], mn = new Float32Array(n), mx = new Float32Array(n), sq = new Float32Array(n);
        for (let bi = 0; bi < n; bi++) {
            const s = start + bi * base, e = Math.min(end, s + base);
            let lo = Infinity, hi = -Infinity, q = 0;
            for (let i = s; i < e; i++) { const v = x[i]; if (v < lo) lo = v; if (v > hi) hi = v; q += v * v; }
            mn[bi] = lo; mx[bi] = hi; sq[bi] = q;
        }
        L0.min.push(mn); L0.max.push(mx); L0.sq.push(sq);
    }
    levels.push(L0);
    while (n > 1) {
        const prev = levels[levels.length - 1], m = Math.ceil(n / 2);
        const Lk = { n: m, min: [], max: [], sq: [] };
        for (let c = 0; c < nc; c++) {
            const pm = prev.min[c], px = prev.max[c], pq = prev.sq[c];
            const mn = new Float32Array(m), mx = new Float32Array(m), sq = new Float32Array(m);
            for (let j = 0; j < m; j++) {
                const a = 2 * j, b = a + 1;
                if (b < n) { mn[j] = Math.min(pm[a], pm[b]); mx[j] = Math.max(px[a], px[b]); sq[j] = pq[a] + pq[b]; }
                else { mn[j] = pm[a]; mx[j] = px[a]; sq[j] = pq[a]; }
            }
            Lk.min.push(mn); Lk.max.push(mx); Lk.sq.push(sq);
        }
        levels.push(Lk);
        n = m;
    }
    return { channels, start, end, base, nc, len, levels };
}

/** Exact [min, max, sumSq, count] of channel c over index-relative samples [a, b). */
export function rangeStats(ix, c, a, b) {
    a = clamp(Math.floor(a), 0, ix.len); b = clamp(Math.floor(b), a, ix.len);
    const x = ix.channels[c], off = ix.start, base = ix.base;
    let lo = Infinity, hi = -Infinity, q = 0;
    const raw = (s, e) => { for (let i = s; i < e; i++) { const v = x[off + i]; if (v < lo) lo = v; if (v > hi) hi = v; q += v * v; } };
    const f0 = Math.ceil(a / base), f1 = Math.floor(b / base);
    if (f0 >= f1) raw(a, b);
    else {
        raw(a, f0 * base);
        let s = f0, e = f1, l = 0;
        while (s < e) {
            const L = ix.levels[l];
            if (s & 1) { if (L.min[c][s] < lo) lo = L.min[c][s]; if (L.max[c][s] > hi) hi = L.max[c][s]; q += L.sq[c][s]; s++; }
            if (e & 1) { e--; if (L.min[c][e] < lo) lo = L.min[c][e]; if (L.max[c][e] > hi) hi = L.max[c][e]; q += L.sq[c][e]; }
            s >>= 1; e >>= 1; l++;
        }
        raw(f1 * base, b);
    }
    return [lo === Infinity ? 0 : lo, hi === -Infinity ? 0 : hi, q, b - a];
}

/**
 * Columns for drawing: `cols` equal slices of index-relative samples [s0, s1).
 * perChannel → arrays per channel; otherwise channels are combined
 * (min of mins, max of maxes, mean power). `reverse` flips the column order
 * (s0/s1 are always SOURCE positions).
 */
export function waveColumns(ix, s0, s1, cols, { perChannel = false, reverse = false } = {}) {
    const lanes = perChannel ? ix.nc : 1;
    const min = [], max = [], rms = [];
    for (let l = 0; l < lanes; l++) { min.push(new Float32Array(cols)); max.push(new Float32Array(cols)); rms.push(new Float32Array(cols)); }
    const spc = (s1 - s0) / cols;
    for (let i = 0; i < cols; i++) {
        const a = s0 + i * spc, b = Math.max(a + 1, s0 + (i + 1) * spc);
        const col = reverse ? cols - 1 - i : i;
        if (b <= 0 || a >= ix.len) continue;
        if (perChannel) {
            for (let c = 0; c < ix.nc; c++) { const [lo, hi, q, k] = rangeStats(ix, c, a, b); min[c][col] = lo; max[c][col] = hi; rms[c][col] = k ? Math.sqrt(q / k) : 0; }
        } else {
            let lo = Infinity, hi = -Infinity, q = 0, k = 0;
            for (let c = 0; c < ix.nc; c++) { const s = rangeStats(ix, c, a, b); if (s[0] < lo) lo = s[0]; if (s[1] > hi) hi = s[1]; q += s[2]; k += s[3]; }
            min[0][col] = lo; max[0][col] = hi; rms[0][col] = k ? Math.sqrt(q / k) : 0;
        }
    }
    return { min, max, rms, lanes };
}
