'use strict';
// Unit tests for the editor DSP (src/renderer/js/audio/edit-dsp.js, ESM).
// The golden tests compare the module against an INDEPENDENT reference written
// from the editor's spec (see REF below), not from the module's code.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { pathToFileURL } = require('url');

let M;
test.before(async () => {
    M = await import(pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', 'js', 'audio', 'edit-dsp.js')).href);
});

// ── deterministic helpers ───────────────────────────────────────────────
function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const SR = 48000;
function ramp(n) { const x = new Float32Array(n); for (let i = 0; i < n; i++) x[i] = -0.5 + i / (n - 1); return x; }
function sine(n, f, amp = 0.5, sr = SR) { const x = new Float32Array(n); for (let i = 0; i < n; i++) x[i] = amp * Math.sin(2 * Math.PI * f * i / sr); return x; }
function noise(n, amp, seed) { const r = rng(seed), x = new Float32Array(n); for (let i = 0; i < n; i++) x[i] = amp * (r() * 2 - 1); return x; }
function goertzel(x, f, sr = SR, skip = 0) {
    const d = x.subarray(skip, x.length - skip);
    const w = 2 * Math.PI * f / sr, cw = 2 * Math.cos(w); let s1 = 0, s2 = 0;
    for (let i = 0; i < d.length; i++) { const s = d[i] + cw * s1 - s2; s2 = s1; s1 = s; }
    return 2 * Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - cw * s1 * s2)) / d.length;
}
const dB = (a, b) => 20 * Math.log10(a / b);
const maxErr = (a, b) => { assert.strictEqual(a.length, b.length, `length ${a.length} vs ${b.length}`); let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i])); return m; };

// ── REF: the editor's intended semantics, written from the spec ─────────
// Visual axis = region, mirrored when reverse. Output = visual cropStart…cropEnd
// left→right; fades at the output edges (curve(t), min of in/out); gain; then
// varispeed by linear interpolation (the preview resampler).
const REF = {
    curve(t, shape, k) {
        if (t <= 0) return 0; if (t >= 1) return 1;
        const warp = Math.pow(t, Math.pow(10, k));
        if (shape === 'equal') return Math.sin(Math.PI / 2 * warp);
        if (shape === 'scurve') { const a = 2 * Math.pow(4, k); return Math.pow(t, a) / (Math.pow(t, a) + Math.pow(1 - t, a)); }
        return warp;
    },
    render(chans, sr, offset, e) {
        const D = e.duration;
        const u0 = e.reverse ? D - e.cropEnd : e.cropStart, u1 = e.reverse ? D - e.cropStart : e.cropEnd;
        const a = Math.round((offset + u0) * sr), b = Math.round((offset + u1) * sr), len = b - a;
        const FI = (e.fadeInEnd - e.cropStart) * sr, FO = (e.cropEnd - e.fadeOutStart) * sr, g = Math.pow(10, e.gainDb / 20);
        const out = chans.map(src => {
            const o = new Float32Array(len);
            for (let k = 0; k < len; k++) {
                let env = 1;
                if (FI > 0 && k < FI) env = REF.curve(k / FI, e.fadeInShape, e.fadeInTension);
                if (FO > 0 && len - 1 - k < FO) env = Math.min(env, REF.curve((len - 1 - k) / FO, e.fadeOutShape, e.fadeOutTension));
                o[k] = src[e.reverse ? b - 1 - k : a + k] * env * g;
            }
            return o;
        });
        if (!e.semitones) return out;
        const rate = Math.pow(2, e.semitones / 12), nl = Math.round(len / rate);
        return out.map(x => { const o = new Float32Array(nl); for (let m = 0; m < nl; m++) { const p = m * rate, i = Math.floor(p), f = p - i; const s0 = i < len ? x[i] : 0, s1 = i + 1 < len ? x[i + 1] : 0; o[m] = s0 + f * (s1 - s0); } return o; });
    },
};

// ── fade curves ─────────────────────────────────────────────────────────
test('fade curves: endpoints, monotonic, power/equal/scurve definitions', () => {
    for (const shape of M.FADE_SHAPES) for (const k of [-1, -0.5, 0, 0.5, 1]) {
        assert.strictEqual(M.fadeGain(0, shape, k), 0); assert.strictEqual(M.fadeGain(1, shape, k), 1);
        assert.strictEqual(M.fadeGain(-0.2, shape, k), 0); assert.strictEqual(M.fadeGain(1.3, shape, k), 1);
        let prev = 0;
        for (let i = 1; i <= 1000; i++) { const v = M.fadeGain(i / 1000, shape, k); assert.ok(v >= prev - 1e-12, `${shape}/${k} not monotonic at ${i}`); prev = v; }
    }
    for (let t = 0.05; t < 1; t += 0.05) assert.ok(Math.abs(M.fadeGain(t, 'power', 0) - t) < 1e-12, 'linear at tension 0');
    assert.ok(M.fadeGain(0.5, 'power', 0.5) < 0.5 && M.fadeGain(0.5, 'power', -0.5) > 0.5, 'tension bends the power curve');
});

test('S-curve is a real S at tension 0 and symmetric for every tension', () => {
    assert.ok(M.fadeGain(0.25, 'scurve', 0) < 0.2, 'slow start');
    assert.ok(M.fadeGain(0.75, 'scurve', 0) > 0.8, 'slow end');
    assert.ok(Math.abs(M.fadeGain(0.5, 'scurve', 0) - 0.5) < 1e-12, 'midpoint');
    for (const k of [-1, -0.3, 0, 0.4, 1]) for (let t = 0.01; t < 1; t += 0.01) {
        assert.ok(Math.abs(M.fadeGain(t, 'scurve', k) + M.fadeGain(1 - t, 'scurve', k) - 1) < 1e-9, `symmetry ${k} ${t}`);
    }
    assert.ok(M.fadeGain(0.1, 'scurve', 1) < M.fadeGain(0.1, 'scurve', 0), 'more tension = steeper S');
});

test('equal-power curve: fade-in² + fade-out² = 1 across a crossfade', () => {
    for (let t = 0; t <= 1.0001; t += 0.01) {
        const a = M.fadeGain(t, 'equal', 0), b = M.fadeGain(1 - t, 'equal', 0);
        assert.ok(Math.abs(a * a + b * b - 1) < 1e-9, `t=${t}`);
    }
    for (const p of M.FADE_PRESETS) assert.ok(M.FADE_SHAPES.includes(p.shape) && p.label && p.id, 'presets are well-formed');
});

// ── handle order (single normalize function) ────────────────────────────
test('normalizeEdit: property test, any input, any moved handle → ordered, bounded, idempotent', () => {
    const r = rng(7);
    const junk = () => { const x = r(); return x < 0.05 ? NaN : x < 0.1 ? -5 : x < 0.15 ? 99 : x < 0.2 ? undefined : (r() * 1.4 - 0.2) * 3; };
    for (let i = 0; i < 20000; i++) {
        const D = r() < 0.02 ? 0 : r() < 0.05 ? 0.0004 : 0.001 + r() * 3;
        const moved = [null, 'cropStart', 'cropEnd', 'fadeInEnd', 'fadeOutStart'][Math.floor(r() * 5)];
        const e = M.normalizeEdit({ duration: D, cropStart: junk(), cropEnd: junk(), fadeInEnd: junk(), fadeOutStart: junk(), fadeInTension: junk(), gainDb: junk() * 100, semitones: junk() * 100, fadeInShape: r() < 0.5 ? 'bogus' : 'equal' }, moved);
        assert.ok(M.isOrdered(e), `not ordered: ${JSON.stringify(e)} moved=${moved}`);
        for (const k of M.HANDLES) assert.ok(Number.isFinite(e[k]) && e[k] >= 0 && e[k] <= D + 1e-12, k);
        assert.ok(e.fadeInTension >= -1 && e.fadeInTension <= 1 && e.gainDb >= M.GAIN_MIN && e.gainDb <= M.GAIN_MAX && e.semitones >= M.PITCH_MIN && e.semitones <= M.PITCH_MAX);
        assert.ok(M.FADE_SHAPES.includes(e.fadeInShape));
        assert.ok(M.editsEqual(M.normalizeEdit(e, moved), e), 'idempotent');
    }
});

test('moved handle wins and pushes the others (no deadlocks, no fade outside the crop)', () => {
    const base = M.createEdit(4, { cropStart: 0.8, cropEnd: 3.4, fadeInEnd: 1.4, fadeOutStart: 2.8 });
    // crop start dragged past the fade-out start (audit UC-19): both fades are pushed
    let e = M.moveHandle(base, 'cropStart', 3.2);
    assert.strictEqual(e.cropStart, 3.2); assert.ok(e.fadeInEnd >= 3.2 && e.fadeOutStart >= e.fadeInEnd && M.isOrdered(e));
    // crop end dragged before the fade-in end (audit UC-20)
    e = M.moveHandle(base, 'cropEnd', 1.0);
    assert.strictEqual(e.cropEnd, 1.0); assert.ok(e.fadeOutStart <= 1.0 && e.fadeInEnd <= e.fadeOutStart && M.isOrdered(e));
    // fades crossing push each other instead of blocking
    e = M.moveHandle(base, 'fadeInEnd', 3.0);
    assert.strictEqual(e.fadeInEnd, 3.0); assert.strictEqual(e.fadeOutStart, 3.0);
    // stacked at the crop end (audit deadlock) → both directions still move something
    const stacked = M.createEdit(4, { cropStart: 0.8, cropEnd: 3.4, fadeInEnd: 3.4, fadeOutStart: 3.4 });
    assert.ok(M.moveHandle(stacked, 'fadeInEnd', 2.0).fadeInEnd === 2.0, 'fade-in can leave the stack');
    assert.ok(M.moveHandle(stacked, 'fadeOutStart', 3.0).fadeOutStart === 3.0, 'fade-out can leave the stack');
    // minimum crop length is kept whatever is dragged
    assert.ok(M.cropLength(M.moveHandle(base, 'cropStart', 99)) >= M.MIN_CROP - 1e-12);
    assert.ok(M.cropLength(M.moveHandle(base, 'cropEnd', -9)) >= M.MIN_CROP - 1e-12);
});

test('slip and link keep lengths and stay inside the region', () => {
    const e = M.createEdit(4, { cropStart: 1, cropEnd: 2, fadeInEnd: 1.2, fadeOutStart: 1.7 });
    const s = M.slipEdit(e, 10);
    assert.ok(Math.abs(s.cropEnd - 4) < 1e-12 && Math.abs(M.cropLength(s) - 1) < 1e-12 && Math.abs(s.fadeInEnd - s.cropStart - 0.2) < 1e-12);
    const l = M.linkEdit(e, 'in', -0.5);
    assert.ok(Math.abs(l.cropStart - 0.5) < 1e-12 && Math.abs(l.fadeInEnd - 0.7) < 1e-12);
    const l2 = M.linkEdit(e, 'in', 5);     // cannot pass the fade-out start
    assert.ok(l2.fadeInEnd <= l2.fadeOutStart + 1e-12 && M.isOrdered(l2));
    const r = M.linkEdit(e, 'out', 9);
    assert.ok(Math.abs(r.cropEnd - 4) < 1e-12 && Math.abs(r.cropEnd - r.fadeOutStart - 0.3) < 1e-12);
});

// ── golden renders against REF ──────────────────────────────────────────
test('render matches the reference for every combination (crop, fades, shapes, gain, reverse, varispeed)', () => {
    const n = 96000, chans = [ramp(n), sine(n, 440, 0.25)];
    const offset = 0.1, D = 1.6;
    const cases = [
        {},
        { cropStart: 0.2, cropEnd: 1.1 },
        { cropStart: 0.2, cropEnd: 1.1, fadeInEnd: 0.4, fadeOutStart: 0.9 },
        { cropStart: 0.2, cropEnd: 1.1, fadeInEnd: 0.4, fadeOutStart: 0.9, fadeInTension: 0.7, fadeOutTension: -0.5 },
        { cropStart: 0.2, cropEnd: 1.1, fadeInEnd: 0.4, fadeOutStart: 0.9, fadeInShape: 'scurve', fadeOutShape: 'scurve', fadeInTension: 0.3 },
        { cropStart: 0.2, cropEnd: 1.1, fadeInEnd: 0.4, fadeOutStart: 0.9, fadeInShape: 'equal', fadeOutShape: 'equal' },
        { gainDb: 6 }, { gainDb: -24 },
        { reverse: true },
        { reverse: true, cropStart: 0.15, cropEnd: 1.3, fadeInEnd: 0.5, fadeOutStart: 0.9, fadeInTension: 0.6, fadeOutShape: 'scurve', gainDb: 3 },
        { fadeInEnd: 0.8, fadeOutStart: 0.8 },
        { fadeInEnd: 0.8, fadeInTension: 1 }, { fadeInEnd: 0.8, fadeInTension: -1 },
        { semitones: 12 }, { semitones: -12 }, { semitones: 7.31 },
        { reverse: true, cropStart: 0.1, cropEnd: 1.4, fadeInEnd: 0.4, fadeOutStart: 1.0, semitones: -5 },
    ];
    for (const c of cases) {
        const e = M.createEdit(D, c);
        const got = M.renderEdit({ channels: chans, sampleRate: SR, offset }, e, { resampler: 'linear' });
        const want = REF.render(chans, SR, offset, e);
        for (let ch = 0; ch < 2; ch++) assert.ok(maxErr(got.channels[ch], want[ch]) < 2e-6, `case ${JSON.stringify(c)} ch${ch}`);
        let pk = 0; for (const w of want) for (const v of w) pk = Math.max(pk, Math.abs(v));
        assert.ok(Math.abs(got.peak - pk) < 1e-6, 'peak');
    }
});

test('fades are applied after reverse (at the output edges) and before varispeed', () => {
    const n = 48000, x = [new Float32Array(n).fill(1)];
    const e = M.createEdit(1, { reverse: true, fadeInEnd: 0.25 });   // fade-in 0.25 s at the OUTPUT start
    const out = M.renderEdit({ channels: x, sampleRate: SR }, e, { resampler: 'linear' }).channels[0];
    assert.ok(out[0] === 0 && Math.abs(out[6000] - 0.5) < 1e-3 && out[20000] === 1, 'fade-in at the output start even when reversed');
    const slow = M.renderEdit({ channels: x, sampleRate: SR }, M.normalizeEdit({ ...e, semitones: -12 }), { resampler: 'linear' }).channels[0];
    assert.strictEqual(slow.length, 96000);
    assert.ok(Math.abs(slow[12000] - 0.5) < 2e-3, 'fade length doubles with the tape-style slowdown');
});

// ── reverse mapping ─────────────────────────────────────────────────────
test('reverse mirrors the crop, keeps the same audio and the fade lengths', () => {
    const n = 96000, chans = [ramp(n), noise(n, 0.3, 3)];
    const e = M.createEdit(2, { cropStart: 0.3, cropEnd: 1.5, fadeInEnd: 0.5, fadeOutStart: 1.1, fadeOutShape: 'equal' });
    const r = M.toggleReverse(e);
    const near = (a, b, what) => { for (const k of Object.keys(b)) assert.ok(Math.abs(a[k] - b[k]) < 1e-12, `${what}.${k}: ${a[k]} vs ${b[k]}`); };
    near(M.sourceRange(r), M.sourceRange(e), 'same audio kept');
    near(M.fadeLengths(r), M.fadeLengths(e), 'fade lengths kept');
    assert.ok(M.editsEqual(M.toggleReverse(r), e, 1e-12), 'double toggle = identity');
    // without fades: reversed render == time-reverse of the forward render
    const plain = M.createEdit(2, { cropStart: 0.3, cropEnd: 1.5 });
    const f = M.renderEdit({ channels: chans, sampleRate: SR }, plain).channels;
    const b = M.renderEdit({ channels: chans, sampleRate: SR }, M.toggleReverse(plain)).channels;
    for (let c = 0; c < 2; c++) assert.strictEqual(maxErr(b[c], Float32Array.from(f[c]).reverse()), 0);
    // with fades: reversed render == fades applied on top of the reversed plain audio
    const withFades = M.renderEdit({ channels: chans, sampleRate: SR }, r).channels[0];
    const want = Float32Array.from(f[0]).reverse();
    const FI = 0.2 * SR, FO = 0.4 * SR, len = want.length;
    for (let k = 0; k < len; k++) { let env = 1; if (k < FI) env = M.fadeGain(k / FI); if (len - 1 - k < FO) env = Math.min(env, M.fadeGain((len - 1 - k) / FO, 'equal')); want[k] *= env; }
    assert.ok(maxErr(withFades, want) < 1e-6);
});

// ── varispeed resampler sanity ──────────────────────────────────────────
test('sinc varispeed: tones land on the right frequency at the right level', () => {
    const n = 48000, x = sine(n, 1000, 0.5);
    for (const [st, f] of [[12, 2000], [-12, 500], [7, 1000 * Math.pow(2, 7 / 12)], [-3.5, 1000 * Math.pow(2, -3.5 / 12)]]) {
        const rate = Math.pow(2, st / 12), outLen = Math.round(n / rate);
        const y = M.resampleSinc(x, rate, outLen);
        assert.strictEqual(y.length, outLen);
        const a = goertzel(y, f, SR, 2000);
        assert.ok(Math.abs(dB(a, 0.5)) < 0.1, `${st} st: ${f.toFixed(1)} Hz at ${dB(a, 0.5).toFixed(3)} dB`);
        assert.ok(goertzel(y, 1000, SR, 2000) < 0.5 * 1e-3 || Math.abs(f - 1000) < 1, 'original frequency gone');
    }
});

test('sinc varispeed: aliases and images stay below -60 dB (linear interpolation does not)', () => {
    const n = 48000, x = sine(n, 15000, 0.5);
    // speed up ×2: 15 kHz → 30 kHz is above Nyquist; must be filtered, not folded to 18 kHz
    const up = M.resampleSinc(x, 2, 24000);
    assert.ok(dB(goertzel(up, 18000, SR, 1000) + 1e-12, 0.5) < -60, 'alias at 18 kHz');
    // slow down ×2: 15 kHz → 7.5 kHz; the interpolation image at 16.5 kHz must be gone
    const down = M.resampleSinc(x, 0.5, 96000);
    assert.ok(Math.abs(dB(goertzel(down, 7500, SR, 2000), 0.5)) < 0.5, 'wanted 7.5 kHz');
    assert.ok(dB(goertzel(down, 16500, SR, 2000) + 1e-12, 0.5) < -60, 'image at 16.5 kHz');
    // the linear preview resampler really is worse (documents why exports use sinc)
    assert.ok(dB(goertzel(M.resampleLinear(x, 2, 24000), 18000, SR, 1000), 0.5) > -20);
});

test('export render uses sinc by default, preview can use linear; lengths follow the rate', () => {
    const n = 48000, chans = [sine(n, 15000, 0.5)];
    const e = M.createEdit(1, { semitones: 12 });
    const exp = M.renderEdit({ channels: chans, sampleRate: SR }, e);
    const pre = M.renderEdit({ channels: chans, sampleRate: SR }, e, { resampler: 'linear' });
    assert.strictEqual(exp.frames, 24000); assert.strictEqual(pre.frames, 24000);
    assert.ok(goertzel(exp.channels[0], 18000, SR, 1000) < goertzel(pre.channels[0], 18000, SR, 1000) / 1000);
    assert.throws(() => M.renderEdit({ channels: chans, sampleRate: SR }, M.createEdit(1, { semitones: -48 }), { maxSamples: 100000 }), /too long/);
});

test('renderEditAsync yields and can be cancelled', async () => {
    const n = 480000, chans = [sine(n, 440)];
    const e = M.createEdit(10, { semitones: 3 });
    let calls = 0;
    const r = await M.renderEditAsync({ channels: chans, sampleRate: SR }, e, { cancelled: () => ++calls > 3, sliceMs: 1 });
    assert.strictEqual(r, null);
    const ok = await M.renderEditAsync({ channels: [sine(4800, 440)], sampleRate: SR }, M.createEdit(0.1, {}), {});
    assert.strictEqual(ok.frames, 4800);
});

// ── normalize / clip ────────────────────────────────────────────────────
test('normalize puts the edited peak at -0.1 dBFS; boosts beyond 0 dBFS are reported as peak > 1', () => {
    const n = 48000, chans = [sine(n, 1000, 0.2), noise(n, 0.05, 9)];
    const e = M.createEdit(1, { cropStart: 0.1, cropEnd: 0.8, fadeInEnd: 0.2, fadeOutStart: 0.5 });
    const g = M.normalizeGainDb({ channels: chans, sampleRate: SR }, e);
    const r = M.renderEdit({ channels: chans, sampleRate: SR }, M.normalizeEdit({ ...e, gainDb: g }));
    assert.ok(Math.abs(M.gainToDb(r.peak) - -0.1) < 1e-3, `peak ${M.gainToDb(r.peak)}`);
    const hot = M.renderEdit({ channels: [sine(n, 1000, 0.999)], sampleRate: SR }, M.createEdit(1, { gainDb: 12 }));
    assert.ok(hot.peak > 3.9, 'peak above full scale is kept (the UI exports float)');
    assert.strictEqual(M.normalizeGainDb({ channels: [new Float32Array(100)], sampleRate: SR }, M.createEdit(100 / SR, { gainDb: 3 })), 3, 'silence keeps gain');
});

// ── zero crossings ──────────────────────────────────────────────────────
test('nearestZeroCrossing finds the closest sign change of the channel sum', () => {
    const x = sine(4800, 440, 0.8);
    for (const target of [100, 777, 2000, 3333]) {
        const i = M.nearestZeroCrossing([x], target, 200);
        const straddle = (x[i - 1] <= 0 && x[i] >= 0) || (x[i - 1] >= 0 && x[i] <= 0) || (x[i] <= 0 && x[i + 1] >= 0) || (x[i] >= 0 && x[i + 1] <= 0);
        assert.ok(straddle, `index ${i} is at a crossing`);
        assert.ok(Math.abs(x[i]) <= 0.8 * Math.sin(Math.PI * 440 / SR) + 1e-6, 'closest sample to zero');
        assert.ok(Math.abs(i - target) <= SR / 440 / 2 + 1, 'nearest one');
    }
    const dc = new Float32Array(1000).fill(0.3); dc[600] = 0.01;
    assert.strictEqual(M.nearestZeroCrossing([dc], 590, 50), 600, 'falls back to the quietest sample');
    const st = [sine(4800, 440, 0.5), sine(4800, 440, -0.5)];   // L+R cancel everywhere → any index is a crossing
    assert.ok(Math.abs(M.nearestZeroCrossing(st, 1234, 50) - 1234) <= 1);
});

// ── waveform index (picture) ────────────────────────────────────────────
test('waveform pyramid queries are exact (brute force) and never lose a transient', () => {
    const r = rng(11);
    const n = 100000, x = noise(n, 0.1, 5), y = noise(n, 0.2, 6);
    const ix = M.buildWaveIndex([x, y], 1000, 91000, 64);
    for (let t = 0; t < 300; t++) {
        const a = Math.floor(r() * 90000), b = a + 1 + Math.floor(r() * (90000 - a));
        const [lo, hi, q, k] = M.rangeStats(ix, 1, a, b);
        let blo = Infinity, bhi = -Infinity, bq = 0;
        for (let i = a; i < b; i++) { const v = y[1000 + i]; blo = Math.min(blo, v); bhi = Math.max(bhi, v); bq += v * v; }
        assert.ok(lo === blo && hi === bhi && k === b - a && Math.abs(q - bq) < 1e-3 * Math.max(1, bq), `range ${a}-${b}`);
    }
    for (let t = 0; t < 50; t++) {
        const imp = new Float32Array(50000); const at = Math.floor(r() * 50000); imp[at] = 0.99;
        const cols = 237;
        const w = M.waveColumns(M.buildWaveIndex([imp]), 0, 50000, cols);
        const col = Math.floor(at / (50000 / cols));
        const v99 = Math.fround(0.99);
        assert.ok(w.max[0][Math.min(cols - 1, col)] === v99 || w.max[0][Math.min(cols - 1, col + 1)] === v99 || w.max[0][Math.max(0, col - 1)] === v99, `impulse at ${at}`);
        assert.strictEqual(w.max[0].filter(v => v === v99).length, 1, 'exactly one column shows it');
    }
});

test('waveform columns: short files covered to the last sample, stereo combined, reverse mirrors', () => {
    for (const n of [240, 6000, 7999]) {
        const x = new Float32Array(n).fill(0.05); for (let i = n - Math.ceil(n / 6); i < n; i++) x[i] = 0.9;
        const w = M.waveColumns(M.buildWaveIndex([x]), 0, n, 235);
        assert.strictEqual(w.max[0][234], Math.fround(0.9), `n=${n} tail visible`);
        assert.ok(w.max[0][0] < 0.1, `n=${n} head quiet`);
        const rv = M.waveColumns(M.buildWaveIndex([x]), 0, n, 235, { reverse: true });
        assert.strictEqual(rv.max[0][0], Math.fround(0.9), 'reversed: tail drawn first');
    }
    const n = 4800, L = new Float32Array(n), R = noise(n, 0.8, 4);
    const mono = M.waveColumns(M.buildWaveIndex([L, R]), 0, n, 100);
    assert.ok(Math.min(...mono.max[0]) > 0.3, 'right-only stereo is not drawn flat');
    const lanes = M.waveColumns(M.buildWaveIndex([L, R]), 0, n, 100, { perChannel: true });
    assert.strictEqual(lanes.lanes, 2); assert.strictEqual(Math.max(...lanes.max[0]), 0); assert.ok(Math.max(...lanes.max[1]) > 0.7);
});

// ── region changes ──────────────────────────────────────────────────────
test('trimToCrop / rebaseEdit keep the same audio', () => {
    const n = 96000, chans = [ramp(n), noise(n, 0.3, 8)];
    const region = { start: 0.25, end: 1.75 };
    for (const rev of [false, true]) {
        const e0 = M.createEdit(1.5, { cropStart: 0.2, cropEnd: 1.1, fadeInEnd: 0.3, fadeOutStart: 0.9, fadeOutShape: 'scurve' });
        const e = rev ? M.toggleReverse(e0) : e0;
        const before = M.renderEdit({ channels: chans, sampleRate: SR, offset: region.start }, e).channels;
        const t = M.trimToCrop(e, region);
        assert.ok(Math.abs(t.edit.duration - (t.region.end - t.region.start)) < 1e-12 && t.edit.cropStart === 0);
        const after = M.renderEdit({ channels: chans, sampleRate: SR, offset: t.region.start }, t.edit).channels;
        for (let c = 0; c < 2; c++) assert.ok(maxErr(after[c], before[c]) < 1e-6, `trim rev=${rev}`);
        const wider = { start: 0.1, end: 1.9 };
        const rb = M.rebaseEdit(e, region, wider);
        const again = M.renderEdit({ channels: chans, sampleRate: SR, offset: wider.start }, rb).channels;
        for (let c = 0; c < 2; c++) assert.ok(maxErr(again[c], before[c]) < 1e-6, `rebase rev=${rev}`);
    }
});

test('export keys change with every parameter and ignore float noise', () => {
    const e = M.createEdit(2, { cropStart: 0.1, cropEnd: 1.9, fadeInEnd: 0.3 });
    const k0 = M.hashKey(M.editSignature(e));
    assert.match(k0, /^[0-9a-f]{16}$/);
    assert.strictEqual(M.hashKey(M.editSignature({ ...e, cropStart: e.cropStart + 1e-9 })), k0);
    const variants = [{ cropStart: 0.2 }, { cropEnd: 1.8 }, { fadeInEnd: 0.4 }, { fadeOutStart: 1.5 }, { fadeInShape: 'equal' }, { fadeOutShape: 'scurve' }, { fadeInTension: 0.2 }, { fadeOutTension: -0.2 }, { gainDb: 1 }, { semitones: 0.5 }, { reverse: true }];
    const seen = new Set([k0]);
    for (const v of variants) { const k = M.hashKey(M.editSignature(M.normalizeEdit({ ...e, ...v }))); assert.ok(!seen.has(k), JSON.stringify(v)); seen.add(k); }
});

test('envelopeSamples follow envelopeAt (live preview control signal)', () => {
    const e = M.createEdit(1, { cropStart: 0.1, cropEnd: 0.9, fadeInEnd: 0.3, fadeOutStart: 0.6, fadeInShape: 'scurve', fadeOutShape: 'equal' });
    const rate = 3000, s = M.envelopeSamples(e, rate);
    assert.strictEqual(s.length, Math.ceil(0.8 * rate) + 1);
    for (let i = 0; i < s.length; i += 7) assert.ok(Math.abs(s[i] - M.envelopeAt(e, Math.min(e.cropEnd, e.cropStart + i / rate))) < 1e-6);
    assert.ok(s[0] === 0 && s[s.length - 1] === 0 && s[1500] === 1);
    assert.strictEqual(M.envelopeMax(e, 0.35, 0.4), 1);
    assert.ok(Math.abs(M.envelopeMax(e, 0.1, 0.2) - M.envelopeAt(e, 0.2)) < 1e-12);
});
