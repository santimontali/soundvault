'use strict';
// Echo math: storage format, per-file summaries, exact global stats, matcher, calibration.
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../src/engine/echo-core');
const { SpectralFingerprinter } = require('../src/spectral-engine');

const F = core.F, SR = 48000;
let seed = 9;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
function sound(seconds, kind = 'mix') {
    const n = Math.round(seconds * SR), x = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        const t = i / SR;
        x[i] = kind === 'silence' ? 0
            : 0.3 * Math.sin(2 * Math.PI * (200 + 300 * Math.sin(t * 3)) * t) * Math.exp(-((t % 0.5) * 6)) + 0.05 * (rnd() * 2 - 1);
    }
    return x;
}
const fpr = new SpectralFingerprinter();
const feats = x => fpr.extractRaw(x, SR);

test('float16 storage round-trips features within half precision', () => {
    const v = Float32Array.from([0, 1, -1, 0.333, -1473.2, 65000, 1e-6, 12.5]);
    const back = core.decodeHalf(core.encodeHalf(v));
    for (let i = 0; i < v.length; i++) assert.ok(Math.abs(back[i] - v[i]) <= Math.max(1e-3, Math.abs(v[i]) * 1e-3), `${v[i]} → ${back[i]}`);
});

test('summary skips silent windows and keeps the loudest window as attack', () => {
    const x = new Float32Array(SR * 2);
    x.set(sound(0.5), SR);                               // 1 s silence, 0.5 s sound, 0.5 s silence
    const { matrix, numWindows } = feats(x);
    const s = core.fileSummary(matrix, numWindows);
    assert.ok(s.counted > 10 && s.counted < numWindows - 30, `counted ${s.counted} of ${numWindows}`);
    assert.ok(s.loud);
    assert.ok(s.attack[core.RMS_DIM] > core.SILENCE);
    const quiet = feats(sound(1, 'silence'));
    assert.equal(core.fileSummary(quiet.matrix, quiet.numWindows).loud, false);
});

test('global stats are exact under add / remove (no drift)', () => {
    const a = core.fileSummary(...Object.values(feats(sound(1))).slice(0, 2));
    const b = core.fileSummary(...Object.values(feats(sound(2))).slice(0, 2));
    const g = new core.GlobalStats();
    g.add(a); g.add(b); g.remove(a);
    const only = new core.GlobalStats(); only.add(b);
    const s1 = g.snapshot(1), s2 = only.snapshot(2);
    for (let d = 0; d < F; d++) { assert.ok(Math.abs(s1.mean[d] - s2.mean[d]) < 1e-6); assert.ok(Math.abs(s1.std[d] - s2.std[d]) < 1e-4); }
    assert.equal(g.files, 1);
});

test('matcher finds a fragment at its true offset; pruning floor never changes the winner', () => {
    const x = sound(4);
    const { matrix, numWindows } = feats(x);
    const g = new core.GlobalStats(); g.add(core.fileSummary(matrix, numWindows));
    const st = g.snapshot(1);
    const c = core.prepare(matrix, numWindows, st, null);
    const off = 60;                                           // 1.5 s
    const q = core.prepare(matrix.slice(off * F, (off + 40) * F), 40, st, null);
    const m = core.match(q, c);
    assert.equal(m.off, off);
    assert.ok(m.score > 0.999);
    const pruned = core.match(q, c, { floor: 0.9 });
    assert.equal(pruned.off, off);
    assert.equal(core.match(q, c, { floor: 1.5 }).score, 1.5, 'below-floor candidates report the floor');
});

test('a longer query slides the candidate over it, scaled by coverage', () => {
    const x = sound(3);
    const { matrix, numWindows } = feats(x);
    const g = new core.GlobalStats(); g.add(core.fileSummary(matrix, numWindows));
    const st = g.snapshot(1);
    const q = core.prepare(matrix, numWindows, st, null);
    const short = core.prepare(matrix.slice(10 * F, 30 * F), 20, st, null);
    const m = core.match(q, short);
    assert.ok(m.swapped);
    assert.ok(Math.abs(m.score - 20 / numWindows) < 0.02, 'a 0.5 s blip cannot "fully match" a 3 s selection');
    assert.ok(core.match(q, short, { coverage: false }).score > 0.999);
});

test('calibration: τ(L) falls with query length; confidence is 0 at chance, 1 at identity', () => {
    const lens = [30, 50, 150, 400, 1000, 3000, 10000, 60000];
    const taus = lens.map(core.tau);
    for (let i = 1; i < taus.length; i++) assert.ok(taus[i] <= taus[i - 1] + 1e-9, `τ(${lens[i]})`);
    assert.equal(core.confidence(core.tau(1000), 1000), 0);
    assert.equal(core.confidence(1, 1000), 1);
    assert.ok(core.confidence(0.95, 1000) > 0.5);
});

test('rows stored per-file z-scored by the old bug are detected', () => {
    const { matrix, numWindows } = feats(sound(2));
    assert.equal(core.looksPerFileNormalised(matrix, numWindows), false);
    const z = matrix.slice();
    for (let d = 0; d < F; d++) {
        let s = 0, s2 = 0; for (let w = 0; w < numWindows; w++) { const v = z[w * F + d]; s += v; s2 += v * v; }
        const mu = s / numWindows, sd = Math.sqrt(Math.max(0, s2 / numWindows - mu * mu));
        for (let w = 0; w < numWindows; w++) z[w * F + d] = sd > 1e-6 ? (z[w * F + d] - mu) / sd : 0;
    }
    assert.equal(core.looksPerFileNormalised(z, numWindows), true);
});
