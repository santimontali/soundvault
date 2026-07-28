'use strict';

/**
 * Semantic search tests.
 *
 * The live CLAP model requires the Electron runtime (`semantic-engine.js`
 * imports `electron`'s `app`) plus a ~100 MB ONNX weight download, so it cannot
 * run inside the fast plain-Node `npm test` loop. This file instead pins the
 * pure, deterministic contract that the semantic layer must satisfy:
 *
 *   1. Cosine ranking + similarity threshold drop weak hits (Phase 2.2 fix).
 *   2. Multi-word query "vector shifting" math (per-word weight blend) is
 *      correct and the result stays L2-normalized.
 *   3. Latency budget contract is documented and asserted on synthetic data.
 *
 * A real end-to-end CLAP precision/recall + latency harness lives in
 * `tests/semantic-live.js` and is runnable via `npm run test:semantic`
 * (spawns Electron). It is invoked here as a SKIP'd test with instructions so
 * the suite stays green in CI while still documenting how to exercise the live
 * model.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execSync } = require('child_process');
const {
    bruteCosineTopK,
    cosineSim,
    applyThreshold,
} = require('../src/search/vector-search');

const DIM = 16;

function unit(v) {
    let s = 0; for (let i = 0; i < v.length; i++) s += v[i] * v[i];
    const m = Math.sqrt(s); const o = new Float32Array(v.length);
    for (let i = 0; i < v.length; i++) o[i] = v[i] / m; return o;
}
function rand(dim, seed) {
    const v = new Float32Array(dim); let s = seed;
    for (let i = 0; i < dim; i++) { s = (s * 9301 + 49297) % 233280; v[i] = (s / 233280) * 2 - 1; }
    return unit(v);
}

test('Phase 2.2 — similarity threshold removes irrelevant hits while preserving top-K order', () => {
    const paths = ['near.wav', 'mid.wav', 'far.wav', 'noise.wav'];
    const matrix = new Float32Array(paths.length * DIM);
    matrix.set(rand(DIM, 1), 0 * DIM);     // near
    matrix.set(rand(DIM, 2), 1 * DIM);     // mid
    matrix.set(rand(DIM, 3), 2 * DIM);     // far
    matrix.set(rand(DIM, 99), 3 * DIM);    // noise
    const q = new Float32Array(matrix.subarray(0 * DIM, 1 * DIM)); // == near.wav
    const ranked = bruteCosineTopK(q, matrix, paths, paths.length, DIM, 200);
    assert.equal(ranked[0].path, 'near.wav');
    assert.ok(Math.abs(ranked[0].score - 1) < 1e-5);

    // Apply a 0.3 floor: weak hits gone, but the perfect self-match remains #1.
    const filtered = applyThreshold(ranked, 0.3);
    assert.ok(filtered.length <= ranked.length);
    assert.equal(filtered[0].path, 'near.wav');
    // A floor of 0.9999 keeps ONLY the near-perfect self match.
    const strict = applyThreshold(ranked, 0.9999);
    assert.equal(strict.length, 1);
    assert.equal(strict[0].path, 'near.wav');
});

test('multi-word vector shifting keeps the query vector L2-normalized and monotonic', () => {
    // Replicates SemanticEngine.search()'s weight-shift math without the CLAP
    // model: queryVec = baseVec + sum_k (weight_k - 1) * wordVec_k, then renorm.
    const base = rand(DIM, 11);
    const wA = rand(DIM, 22);
    const wB = rand(DIM, 33);

    function shift(weights) {
        const out = new Float32Array(base);
        for (const [w, val] of Object.entries(weights)) {
            const wv = w === 'a' ? wA : wB;
            const sh = val - 1.0;
            if (sh !== 0) for (let i = 0; i < DIM; i++) out[i] += wv[i] * sh;
        }
        return unit(out);
    }
    // neutral weights => equal to base vector.
    const neutral = shift({ a: 1, b: 1 });
    assert.ok(Math.abs(cosineSim(neutral, base) - 1) < 1e-5);

    // boosted weight moves the query toward that word's direction.
    const aBoost = shift({ a: 2, b: 1 });
    assert.ok(cosineSim(aBoost, wA) > cosineSim(neutral, wA),
        'boosting word A must move the query closer to A');

    // result must always be unit norm.
    function norm(v) { let s = 0; for (const x of v) s += x * x; return Math.sqrt(s); }
    for (const w of [{ a: 1, b: 1 }, { a: 2, b: 1 }, { a: 1.5, b: 0.3 }, { a: 0, b: 3 }]) {
        const v = shift(w);
        assert.ok(Math.abs(norm(v) - 1) < 1e-5);
    }
});

test('latency budget contract: brute-force top-200 over a 10k-vector corpus completes < 250 ms', () => {
    const N = 10000;
    const paths = new Array(N);
    const matrix = new Float32Array(N * DIM);
    for (let i = 0; i < N; i++) { matrix.set(rand(DIM, i + 1), i * DIM); paths[i] = `s${i}.wav`; }
    const q = rand(DIM, 42);
    const t0 = process.hrtime.bigint();
    const hits = bruteCosineTopK(q, matrix, paths, N, DIM, 200);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.equal(hits.length, 200);
    for (let i = 1; i < hits.length; i++) assert.ok(hits[i - 1].score >= hits[i].score);
    assert.ok(ms < 250, `bruteCosineTopK(10k x 16) too slow: ${ms.toFixed(2)} ms`);
    console.log(`PERF bruteCosineTopK 10k×16: ${ms.toFixed(2)} ms`);
});

// Live CLAP harness — deliberately SKIP'd in the fast loop.
test.skip('LIVE: CLAP precision/recall + latency on a small corpus (run via `npm run test:semantic`)', () => {
    // Sanity check that the harness file exists; the actual Electron run is
    // triggered by package.json `test:semantic`. Assert here only that the
    // electron binary is installed.
    assert.ok(execSync('node -e "require.resolve(\'electron\')"', { stdio: 'pipe' }).toString().trim());
});