'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
    dotRow,
    cosineSim,
    bruteCosineTopK,
    applyThreshold,
    dedupeByPath,
} = require('../src/search/vector-search');

const DIM = 8;

function randUnit(dim, seed) {
    // Deterministic L2-normalized pseudo-random vector.
    const v = new Float32Array(dim);
    let s = seed;
    let sum = 0;
    for (let i = 0; i < dim; i++) {
        s = (s * 9301 + 49297) % 233280;
        v[i] = (s / 233280) * 2 - 1;
        sum += v[i] * v[i];
    }
    const m = Math.sqrt(sum);
    for (let i = 0; i < dim; i++) v[i] /= m;
    return v;
}

test('cosineSim: identical vectors = 1, orthogonal = 0, opposite = -1', () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([1, 0]);
    assert.equal(Math.round(cosineSim(a, b) * 1e6) / 1e6, 1);

    const c = new Float32Array([0, 1]);
    assert.ok(Math.abs(cosineSim(a, c)) < 1e-6);

    const d = new Float32Array([-1, 0]);
    assert.ok(Math.abs(cosineSim(a, d) - (-1)) < 1e-6);
});

test('cosineSim: zero vector returns 0 (no NaN)', () => {
    const z = new Float32Array([0, 0, 0]);
    const nz = new Float32Array([1, 1, 1]);
    assert.equal(cosineSim(z, nz), 0);
});

test('dotRow matches a direct dot product computation', () => {
    const dim = DIM;
    const rows = 4;
    const matrix = new Float32Array(rows * dim);
    for (let i = 0; i < rows; i++) {
        const v = randUnit(dim, (i + 1) * 7);
        matrix.set(v, i * dim);
    }
    const q = randUnit(dim, 123);
    for (let i = 0; i < rows; i++) {
        let expected = 0;
        for (let j = 0; j < dim; j++) expected += q[j] * matrix[i * dim + j];
        const got = dotRow(q, matrix, i, dim);
        assert.ok(Math.abs(got - expected) < 1e-5);
    }
});

test('bruteCosineTopK returns results sorted by score desc and ties handled', () => {
    const dim = DIM;
    const paths = ['a.wav', 'b.wav', 'c.wav', 'd.wav'];
    const matrix = new Float32Array(paths.length * dim);
    for (let i = 0; i < paths.length; i++) {
        matrix.set(randUnit(dim, (i + 1) * 13), i * dim);
    }
    // Query = copy of 'b.wav' so it must be the top hit with score ~1.
    const q = matrix.subarray(1 * dim, 2 * dim);
    const hits = bruteCosineTopK(new Float32Array(q), matrix, paths, paths.length, dim, 3);
    assert.equal(hits.length, 3);
    assert.equal(hits[0].path, 'b.wav');
    assert.ok(Math.abs(hits[0].score - 1) < 1e-5, `top score ~1, got ${hits[0].score}`);
    for (let i = 1; i < hits.length; i++) {
        assert.ok(hits[i - 1].score >= hits[i].score, 'must be sorted desc');
    }
});

test('bruteCosineTopK computes a Precision@1 of 1.0 on a labelled synthetic set', () => {
    // 50 vectors: 5 labelled "kick" cluster-centres + the rest random.
    // Query is the kick centroid; top result must be one of the kick members.
    const dim = 16;
    const members = 5;
    const noise = 45;
    const total = members + noise;
    const paths = new Array(total);
    const matrix = new Float32Array(total * dim);
    const kickCentroid = randUnit(dim, 999);
    for (let i = 0; i < members; i++) {
        // member = centroid + tiny perturbation, renormalized
        const v = new Float32Array(dim);
        for (let j = 0; j < dim; j++) v[j] = kickCentroid[j] + 0.01 * ((i + j) % 5 - 2);
        let s = 0; for (let j = 0; j < dim; j++) s += v[j] * v[j];
        const m = Math.sqrt(s); for (let j = 0; j < dim; j++) v[j] /= m;
        matrix.set(v, i * dim);
        paths[i] = `kick_${i}.wav`;
    }
    for (let i = 0; i < noise; i++) {
        matrix.set(randUnit(dim, 1000 + i), (members + i) * dim);
        paths[members + i] = `noise_${i}.wav`;
    }
    const hits = bruteCosineTopK(kickCentroid, matrix, paths, total, dim, 5);
    // Precision@5: fraction of top-5 that are kick members.
    const relevant = hits.filter(h => h.path.startsWith('kick_')).length;
    const pAt5 = relevant / 5;
    assert.equal(pAt5, 1, `expected P@5 = 1, got ${pAt5}`);
});

test('precision/recall helper: applyThreshold filters, preserves order, disabled at 0', () => {
    const results = [
        { path: 'a', score: 0.9 },
        { path: 'b', score: 0.5 },
        { path: 'c', score: 0.2 },
    ];
    const kept = applyThreshold(results, 0.5);
    assert.equal(kept.length, 2);
    assert.equal(kept[0].path, 'a');   // order preserved
    assert.equal(kept[1].path, 'b');

    assert.equal(applyThreshold(results, 0).length, 3, 'threshold 0 = disabled');
    assert.equal(applyThreshold([], 0.9).length, 0);
    assert.equal(applyThreshold(results, 1.5).length, 0, 'unreachable threshold drops all');
});

test('bruteCosineTopK handles edge cases (empty, topK > n, null guards)', () => {
    assert.deepEqual(bruteCosineTopK(new Float32Array(DIM), new Float32Array(0), [], 0, DIM), []);
    assert.deepEqual(bruteCosineTopK(null, new Float32Array(4), ['x'], 1, 4), []);
    const dim = 3;
    const m = new Float32Array([1, 0, 0, 0, 1, 0]);
    const hits = bruteCosineTopK(new Float32Array([1, 0, 0]), m, ['p0', 'p1'], 2, dim, 50);
    assert.equal(hits.length, 2, 'topK larger than n is clamped to n');
});

// ─────────────────────────────────────────────────────────────────────
// Regression: duplicate-path entries in the engine's in-memory cache
// (https://local-bug — "explorer shows the same file twice").
// `SemanticEngine._appendToCache` blindly pushed the path on every
// watcher-driven re-index, so `_paths[]` (and thus `bruteCosineTopK`'s
// output) could contain the same `path` twice with slightly different
// scores. renderer → grid renders one row per array index → duplicate.
// ─────────────────────────────────────────────────────────────────────

test('REGRESSION: bruteCosineTopK propagates duplicate paths when paths[] has them (anchors the bug)', () => {
    // Two rows with the SAME path but different vectors → two different scores.
    const dim = 4;
    const paths = ['kick.wav', 'kick.wav', 'snare.wav'];
    const matrix = new Float32Array([
        0.9, 0.1, 0.0, 0.0, // kick.wav entry #1 (higher score against the query below)
        0.5, 0.5, 0.5, 0.0, // kick.wav entry #2 (lower score)
        0.0, 0.0, 0.0, 1.0, // snare.wav
    ]);
    const q = new Float32Array([1, 0, 0, 0]);
    const hits = bruteCosineTopK(q, matrix, paths, 3, dim, 50);
    const kickRows = hits.filter(h => h.path === 'kick.wav');
    // Without an IPC-layer dedup this is what the engine returns today — TWO
    // rows for the same file. This test anchors the upstream contamination so
    // we can prove the IPC-layer fix collapses them.
    assert.equal(kickRows.length, 2, 'upstream bruteCosineTopK currently emits dupes (the bug)');
});

test('dedupeByPath collapses duplicate-path results preserving the higher score (sorted desc assumption)', () => {
    // Mirrors what `semantic-search` IPC sees when the cache is contaminated:
    // bruteCosineTopK already returns sorted-desc; same-path entries are
    // adjacent and the FIRST occurrence carries the highest score.
    const ranked = [
        { path: 'kick.wav',  score: 0.92 },
        { path: 'kick.wav',  score: 0.71 }, // dupe (older vector)
        { path: 'snare.wav', score: 0.55 },
        { path: 'kick.wav',  score: 0.30 }, // dupe further down
        { path: 'hat.wav',   score: 0.10 },
    ];
    const out = dedupeByPath(ranked);
    assert.equal(out.length, 3);
    assert.deepEqual(out.map(r => r.path), ['kick.wav', 'snare.wav', 'hat.wav']);
    // Kept entry is the FIRST (= highest score) occurrence.
    assert.equal(out[0].score, 0.92);
});

test('dedupeByPath preserves order and scores for cleanly unique input (no-op when clean)', () => {
    const ranked = [
        { path: 'a.wav', score: 0.9 },
        { path: 'b.wav', score: 0.5 },
        { path: 'c.wav', score: 0.2 },
    ];
    assert.deepEqual(dedupeByPath(ranked), ranked);
});

test('dedupeByPath handles empty and single-element input', () => {
    assert.deepEqual(dedupeByPath([]), []);
    assert.deepEqual(dedupeByPath([{ path: 'x', score: 1 }]), [{ path: 'x', score: 1 }]);
});

test('dedupeByPath does NOT mutate the input array', () => {
    const input = [{ path: 'a', score: 1 }, { path: 'a', score: 0.5 }, { path: 'b', score: 0.3 }];
    const snapshot = JSON.stringify(input);
    dedupeByPath(input);
    assert.equal(JSON.stringify(input), snapshot, 'input array must be left untouched');
});