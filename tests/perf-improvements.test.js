'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { bruteCosineTopK } = require('../src/search/vector-search');
const { tokenizeEntry, searchSounds } = require('../src/search/lexical-search');

function randUnit(dim, seed) {
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

function naiveFullSortTopK(queryVec, matrix, paths, count, dim, topK) {
    const scores = new Array(count);
    for (let i = 0; i < count; i++) {
        let dot = 0;
        const off = i * dim;
        for (let j = 0; j < dim; j++) dot += queryVec[j] * matrix[off + j];
        scores[i] = { path: paths[i], score: dot };
    }
    scores.sort((a, b) => b.score - a.score);
    return scores.slice(0, topK);
}

test('min-heap top-K correctness: bruteCosineTopK matches naive full-sort (5000x512, k=50)', () => {
    const N = 5000;
    const dim = 512;
    const topK = 50;
    const paths = new Array(N);
    const matrix = new Float32Array(N * dim);
    for (let i = 0; i < N; i++) {
        paths[i] = `sound_${i}.wav`;
        matrix.set(randUnit(dim, (i + 1) * 7), i * dim);
    }
    const q = randUnit(dim, 42);

    const heap = bruteCosineTopK(q, matrix, paths, N, dim, topK);
    const naive = naiveFullSortTopK(q, matrix, paths, N, dim, topK);

    assert.equal(heap.length, naive.length);
    for (let i = 0; i < topK; i++) {
        assert.equal(heap[i].path, naive[i].path, `path mismatch at rank ${i}`);
        assert.ok(
            Math.abs(heap[i].score - naive[i].score) < 1e-5,
            `score mismatch at rank ${i}: ${heap[i].score} vs ${naive[i].score}`
        );
    }
});

test('min-heap performance: bruteCosineTopK on 50k x 512 with k=200 completes < 100ms', () => {
    const N = 50000;
    const dim = 512;
    const topK = 200;
    const paths = new Array(N);
    const matrix = new Float32Array(N * dim);
    for (let i = 0; i < N; i++) {
        paths[i] = `sound_${i}.wav`;
        for (let d = 0; d < dim; d++) matrix[i * dim + d] = Math.sin(i * 0.13 + d * 0.07);
    }
    const q = randUnit(dim, 777);

    const t0 = process.hrtime.bigint();
    const hits = bruteCosineTopK(q, matrix, paths, N, dim, topK);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;

    console.log(`BENCH  bruteCosineTopK 50k x 512, k=200: ${ms.toFixed(1)}ms`);
    assert.equal(hits.length, topK);
    assert.ok(ms < 100, `expected < 100ms, got ${ms.toFixed(1)}ms`);
});

test('pre-tokenized lexical search: identical results with or without _tokens', () => {
    const N = 10000;
    const words = ['kick', 'snare', 'hat', 'tom', 'cymbal', 'clap', 'perc', 'bass', 'synth', 'pad'];
    const cache = [];
    for (let i = 0; i < N; i++) {
        cache.push({
            name: `${words[i % 10]}_${words[(i * 3 + 1) % 10]}_${i}.wav`,
            folder: `${words[(i * 7) % 10]}s`,
            topLevel: 'Library',
            dateAdded: i,
        });
    }

    const withTokens = cache.map(e => Object.assign({}, e, { _tokens: tokenizeEntry(e) }));
    const withoutTokens = cache.map(e => Object.assign({}, e));

    const query = 'kick snare';
    const r1 = searchSounds(withTokens, query, { limit: 50 });
    const r2 = searchSounds(withoutTokens, query, { limit: 50 });

    assert.equal(r1.length, r2.length);
    for (let i = 0; i < r1.length; i++) {
        assert.equal(r1[i].name, r2[i].name, `result mismatch at ${i}`);
        assert.equal(r1[i].score, r2[i].score, `score mismatch at ${i}`);
    }
});

test('pre-tokenized lexical search: >= 1.5x faster for 10k corpus', () => {
    const N = 10000;
    const words = ['kick', 'snare', 'hat', 'tom', 'cymbal', 'clap', 'perc', 'bass', 'synth', 'pad'];
    const base = [];
    for (let i = 0; i < N; i++) {
        base.push({
            name: `${words[i % 10]}_${words[(i * 3 + 1) % 10]}_layer_${i}.wav`,
            folder: `${words[(i * 7) % 10]}s_category`,
            topLevel: 'Library',
            dateAdded: i,
        });
    }

    const withTokens = base.map(e => Object.assign({}, e, { _tokens: tokenizeEntry(e) }));
    const withoutTokens = base.map(e => Object.assign({}, e));
    const query = 'kick layer';
    const iters = 20;

    let t0 = process.hrtime.bigint();
    for (let i = 0; i < iters; i++) searchSounds(withoutTokens, query, { limit: 200 });
    const msNoPre = Number(process.hrtime.bigint() - t0) / 1e6;

    t0 = process.hrtime.bigint();
    for (let i = 0; i < iters; i++) searchSounds(withTokens, query, { limit: 200 });
    const msPre = Number(process.hrtime.bigint() - t0) / 1e6;

    const speedup = msNoPre / msPre;
    console.log(`BENCH  lexical search 10k: no-pretoken ${msNoPre.toFixed(1)}ms | pre-tokenized ${msPre.toFixed(1)}ms | speedup ${speedup.toFixed(2)}x`);
    assert.ok(speedup >= 1.5, `expected >= 1.5x speedup, got ${speedup.toFixed(2)}x`);
});

test('Map index O(1) lookup: append, swap-remove, and lookup correctness', () => {
    const paths = [];
    const pathIndex = new Map();

    function append(path) {
        pathIndex.set(path, paths.length);
        paths.push(path);
    }

    function remove(path) {
        const idx = pathIndex.get(path);
        if (idx === undefined) return false;
        const last = paths.length - 1;
        if (idx !== last) {
            paths[idx] = paths[last];
            pathIndex.set(paths[idx], idx);
        }
        paths.pop();
        pathIndex.delete(path);
        return true;
    }

    append('a.wav');
    append('b.wav');
    append('c.wav');
    append('d.wav');

    assert.equal(pathIndex.get('a.wav'), 0);
    assert.equal(pathIndex.get('d.wav'), 3);

    remove('b.wav');
    assert.equal(paths.length, 3);
    assert.equal(pathIndex.has('b.wav'), false);
    assert.equal(pathIndex.get('d.wav'), 1, 'swap-remove moved d.wav into b.wav slot');
    assert.equal(paths[1], 'd.wav');

    remove('a.wav');
    assert.equal(paths.length, 2);
    assert.equal(pathIndex.has('a.wav'), false);
    assert.equal(pathIndex.get('c.wav'), 0);
    assert.equal(pathIndex.get('d.wav'), 1);

    append('e.wav');
    assert.equal(pathIndex.get('e.wav'), 2);
    assert.equal(paths[2], 'e.wav');

    for (let i = 0; i < paths.length; i++) {
        assert.equal(pathIndex.get(paths[i]), i, `index consistent for ${paths[i]}`);
    }
});

test('LRU buffer cache: evicts oldest entries when exceeding BUFFER_CACHE_MAX=12', () => {
    const BUFFER_CACHE_MAX = 12;
    const cache = new Map();

    function lruSet(key, value) {
        if (cache.has(key)) cache.delete(key);
        cache.set(key, value);
        while (cache.size > BUFFER_CACHE_MAX) {
            const oldest = cache.keys().next().value;
            cache.delete(oldest);
        }
    }

    for (let i = 0; i < 20; i++) {
        lruSet(`buf_${i}`, Buffer.alloc(8, i));
    }

    assert.equal(cache.size, BUFFER_CACHE_MAX);

    for (let i = 0; i < 8; i++) {
        assert.equal(cache.has(`buf_${i}`), false, `buf_${i} should have been evicted`);
    }
    for (let i = 8; i < 20; i++) {
        assert.equal(cache.has(`buf_${i}`), true, `buf_${i} should still be cached`);
    }

    lruSet('buf_10', Buffer.alloc(8, 99));
    assert.equal(cache.size, BUFFER_CACHE_MAX);
    const keys = [...cache.keys()];
    assert.equal(keys[keys.length - 1], 'buf_10', 're-access moves to most-recent');
    assert.equal(keys[0], 'buf_8', 'buf_8 is now the oldest');
});

test('AbortController listener cleanup: abort removes listeners', () => {
    const controller = new AbortController();
    const { signal } = controller;
    let callCount = 0;

    const onAbort = () => { callCount++; };
    signal.addEventListener('abort', onAbort);

    assert.equal(signal.aborted, false);
    controller.abort();
    assert.equal(signal.aborted, true);
    assert.equal(callCount, 1, 'listener fired on abort');

    signal.removeEventListener('abort', onAbort);
    controller.abort();
    assert.equal(callCount, 1, 'listener not called after removal');
});
