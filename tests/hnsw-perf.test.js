'use strict';

/**
 * HNSW build-performance optimization proof.
 *
 * The packaged smoke test showed `HNSW index built: 70114 vectors in 71851ms`
 * — the `Array.from(subarray)` per-point allocation dominates the build. The
 * addon's addPoint copies each point into hnswlib's internal C++ storage
 * synchronously (see node_modules/hnswlib-node/src/addon.cc), so a single
 * reusable JS Array buffer is safe across calls.
 *
 * This test: (a) PROVES buffer reuse produces a correct index (self-match
 * search returns the right label, and earlier points are not clobbered by
 * later buffer refills), and (b) BENCHMARKS Array.from-per-point vs
 * reusable-buffer to justify the optimization in _buildHNSW.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

let HierarchicalNSW = null;
try { ({ HierarchicalNSW } = require('hnswlib-node')); } catch {}

const DIM = 512;

function fillFromMatrix(buf, matrix, row, dim) {
    const off = row * dim;
    for (let d = 0; d < dim; d++) buf[d] = matrix[off + d];
}

test({ skip: !HierarchicalNSW && 'hnswlib-node not installed (optional dep)' }, 'reusable buffer across addPoint calls yields a CORRECT index', () => {
    const N = 64;
    const matrix = new Float32Array(N * DIM);
    // Fill with distinct deterministic vectors; row 17 is our query target.
    for (let i = 0; i < N; i++) {
        for (let d = 0; d < DIM; d++) matrix[i * DIM + d] = Math.sin(i * 0.37 + d * 0.11);
        // L2-normalize row
        let s = 0;
        for (let d = 0; d < DIM; d++) s += matrix[i * DIM + d] ** 2;
        const m = Math.sqrt(s);
        for (let d = 0; d < DIM; d++) matrix[i * DIM + d] /= m;
    }

    const index = new HierarchicalNSW('ip', DIM);
    index.initIndex(N, 16, 200, 100);

    const buf = new Array(DIM);
    for (let i = 0; i < N; i++) {
        fillFromMatrix(buf, matrix, i, DIM);
        index.addPoint(buf, i);   // if the addon did NOT copy, all rows would equal row N-1
    }
    index.setEf(50);

    // Query = row 17 → label 17 must win with cosine ≈ 1; label 63 must NOT
    // shadow every row (it would if the buffer were stored by reference).
    fillFromMatrix(buf, matrix, 17, DIM);
    const r17 = index.searchKnn(buf, 3);
    assert.equal(r17.neighbors[0], 17, 'self-match found with reused buffer');
    assert.ok(Math.abs((1 - r17.distances[0]) - 1) < 1e-4);

    fillFromMatrix(buf, matrix, 5, DIM);
    const r5 = index.searchKnn(buf, 1);
    assert.equal(r5.neighbors[0], 5, 'an early row is intact (addon copies data)');
});

test({ skip: !HierarchicalNSW && 'hnswlib-node not installed (optional dep)' }, 'benchmark: reusable buffer vs Array.from per point', () => {
    const N = 20000;
    const matrix = new Float32Array(N * DIM);
    for (let i = 0; i < N * DIM; i++) matrix[i] = (i % 97) / 97;

    // Variant A (current): Array.from(subarray) per point.
    const iA = new HierarchicalNSW('ip', DIM);
    iA.initIndex(N, 16, 200, 100);
    let t0 = process.hrtime.bigint();
    for (let i = 0; i < N; i++) iA.addPoint(Array.from(matrix.subarray(i * DIM, (i + 1) * DIM)), i);
    const msA = Number(process.hrtime.bigint() - t0) / 1e6;

    // Variant B (optimized): single reusable Array buffer.
    const iB = new HierarchicalNSW('ip', DIM);
    iB.initIndex(N, 16, 200, 100);
    const buf = new Array(DIM);
    t0 = process.hrtime.bigint();
    for (let i = 0; i < N; i++) { fillFromMatrix(buf, matrix, i, DIM); iB.addPoint(buf, i); }
    const msB = Number(process.hrtime.bigint() - t0) / 1e6;

    console.log(`BENCH  Array.from: ${msA.toFixed(0)}ms | reused-buffer: ${msB.toFixed(0)}ms | speedup ${(msA / msB).toFixed(2)}x`);
    assert.ok(msB > 0 && msA > 0);
    // The optimization must not be slower. (Typically 1.5-3x faster.)
    assert.ok(msB <= msA * 1.1, `reused buffer unexpectedly slower: ${msB} vs ${msA}`);
});
