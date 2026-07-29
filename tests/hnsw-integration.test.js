'use strict';

/**
 * HNSW integration test (hnswlib-node API contract).
 *
 * Regression anchor for the packaged-app bug found in the smoke test:
 *   `[SemanticEngine] HNSW build failed: Invalid the first argument type,
 *    must be an Array.`
 *
 * hnswlib-node v3's native addon checks `IsArray()` on point/query arguments,
 * which is FALSE for TypedArrays. `SemanticEngine._buildHNSW` used to pass
 * Float32Array subarrays of `_matrix` straight into `addPoint`, so HNSW was
 * silently disabled (brute-force fallback) on any library > 50k vectors —
 * including in dev once hnswlib-node got installed via optionalDependencies.
 *
 * The engine now converts with `Array.from(...)`; this suite pins that contract
 * against the REAL native module (N-API — loads fine in plain Node).
 * Skips gracefully if hnswlib-node isn't installed.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

let HierarchicalNSW = null;
try {
    ({ HierarchicalNSW } = require('hnswlib-node'));
} catch {
    // Optional dependency not installed — skip the whole file.
}

const DIM = 16;

function randUnit(dim, seed) {
    const v = new Float32Array(dim);
    let s = seed, sum = 0;
    for (let i = 0; i < dim; i++) {
        s = (s * 9301 + 49297) % 233280;
        v[i] = (s / 233280) * 2 - 1;
        sum += v[i] * v[i];
    }
    const m = Math.sqrt(sum);
    for (let i = 0; i < dim; i++) v[i] /= m;
    return v;
}

test({ skip: !HierarchicalNSW && 'hnswlib-node not installed (optional dep)' }, 'hnswlib-node loads and reports its API', () => {
    assert.equal(typeof HierarchicalNSW, 'function');
    const index = new HierarchicalNSW('ip', DIM);
    assert.ok(index, 'index constructed');
});

test({ skip: !HierarchicalNSW && 'hnswlib-node not installed (optional dep)' }, 'API contract: addPoint REJECTS Float32Array (the original bug)', () => {
    const index = new HierarchicalNSW('ip', DIM);
    index.initIndex(4);
    const vec = randUnit(DIM, 7);
    assert.throws(
        () => index.addPoint(vec, 0),
        /must be an Array/,
        'TypedArray input must throw — this is why the engine converts with Array.from'
    );
});

test({ skip: !HierarchicalNSW && 'hnswlib-node not installed (optional dep)' }, 'API contract: searchKnn REJECTS Float32Array query', () => {
    const index = new HierarchicalNSW('ip', DIM);
    index.initIndex(4);
    index.addPoint(Array.from(randUnit(DIM, 1)), 0);
    assert.throws(
        () => index.searchKnn(randUnit(DIM, 1), 1),
        /must be an Array/
    );
});

test({ skip: !HierarchicalNSW && 'hnswlib-node not installed (optional dep)' }, 'Array.from conversion: build 70k-style index + search returns correct nearest neighbour', () => {
    const N = 200;
    const index = new HierarchicalNSW('ip', DIM);
    index.initIndex(N, 16, 200, 100);

    const target = randUnit(DIM, 42);
    const labels = [];
    for (let i = 0; i < N; i++) {
        const v = i === 77 ? target : randUnit(DIM, 1000 + i);
        labels.push(i);
        index.addPoint(Array.from(v), i);
    }
    index.setEf(50);

    // Query = the target vector itself → label 77 must be the top hit, score ~1.
    const result = index.searchKnn(Array.from(target), 5);
    assert.equal(result.neighbors[0], 77, 'nearest neighbour found');
    assert.ok(Math.abs((1 - result.distances[0]) - 1) < 1e-4, 'ip distance of self ≈ 1.0 cosine');
    assert.equal(result.neighbors.length, 5);
});

test({ skip: !HierarchicalNSW && 'hnswlib-node not installed (optional dep)' }, 'HNSW top-5 agrees with brute-force cosine on a labelled corpus', () => {
    const { bruteCosineTopK } = require('../src/search/vector-search');
    const N = 500;
    const paths = new Array(N);
    const matrix = new Float32Array(N * DIM);
    for (let i = 0; i < N; i++) {
        matrix.set(randUnit(DIM, i + 1), i * DIM);
        paths[i] = `s${i}.wav`;
    }
    const query = matrix.subarray(123 * DIM, 124 * DIM); // == s123.wav

    const index = new HierarchicalNSW('ip', DIM);
    index.initIndex(N, 16, 200, 100);
    for (let i = 0; i < N; i++) index.addPoint(Array.from(matrix.subarray(i * DIM, (i + 1) * DIM)), i);
    index.setEf(100);

    const hnsw = index.searchKnn(Array.from(query), 5).neighbors.map(i => paths[i]);
    const brute = bruteCosineTopK(new Float32Array(query), matrix, paths, N, DIM, 5).map(r => r.path);

    assert.equal(hnsw[0], 's123.wav', 'HNSW finds the self-match first');
    assert.equal(brute[0], 's123.wav', 'brute-force finds the self-match first');
    // Approximate neighbours: top-5 sets should overlap strongly (>= 60%).
    const overlap = hnsw.filter(p => brute.includes(p)).length;
    assert.ok(overlap >= 3, `HNSW/brute top-5 overlap ${overlap}/5`);
});
