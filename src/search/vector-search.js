'use strict';

/**
 * Pure, side-effect-free vector (semantic) search primitives, extracted from
 * `SemanticEngine._searchFlat` in `src/semantic-engine.js` so the cosine-math
 * and ranking logic can be unit-tested in plain Node without loading the CLAP
 * ONNX model or the Electron `app` singleton.
 *
 * CLAP embeddings are L2-normalized, so dot product == cosine similarity.
 */

/**
 * Dot product of two equal-length Float32Array segments. 8x loop unroll,
 * mirroring the hand-tuned inner loop from `SemanticEngine._searchFlat` so
 * perf parity is preserved when the engine delegates here.
 *
 * @param {Float32Array} queryVec Query vector (length === dim).
 * @param {Float32Array} matrix Flat matrix: row-major, `count * dim` long.
 * @param {number} row Row index to compare against (0-based).
 * @param {number} dim Vector dimensionality.
 * @returns {number} Dot product (cosine sim when both vectors are normalized).
 */
function dotRow(queryVec, matrix, row, dim) {
    const offset = row * dim;
    let dot = 0;
    let j = 0;
    for (; j <= dim - 8; j += 8) {
        dot += queryVec[j]     * matrix[offset + j]
             + queryVec[j + 1] * matrix[offset + j + 1]
             + queryVec[j + 2] * matrix[offset + j + 2]
             + queryVec[j + 3] * matrix[offset + j + 3]
             + queryVec[j + 4] * matrix[offset + j + 4]
             + queryVec[j + 5] * matrix[offset + j + 5]
             + queryVec[j + 6] * matrix[offset + j + 6]
             + queryVec[j + 7] * matrix[offset + j + 7];
    }
    for (; j < dim; j++) dot += queryVec[j] * matrix[offset + j];
    return dot;
}

/**
 * General cosine similarity for two standalone equal-length vectors. Used by
 * tests / threshold utilities. Not perf-critical (no unroll) but allocation
 * free.
 *
 * @param {Float32Array} a
 * @param {Float32Array} b
 * @param {number} [dim] Defaults to a.length.
 * @returns {number} Cosine similarity in [-1, 1].
 */
function cosineSim(a, b, dim = a.length) {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < dim; i++) {
        const av = a[i], bv = b[i];
        dot += av * bv;
        na += av * av;
        nb += bv * bv;
    }
    if (na === 0 || nb === 0) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Flat brute-force cosine top-K over a row-major Float32Array matrix. Pure
 * port of `SemanticEngine._searchFlat`'s brute-force branch. Returns results
 * sorted by score descending.
 *
 * @param {Float32Array} queryVec Query vector (length === dim), assumed normalized.
 * @param {Float32Array} matrix `[count*dim]` flat matrix.
 * @param {Array<string>} paths `paths[i]` = path of vector i.
 * @param {number} count Number of vectors in the matrix.
 * @param {number} dim Vector dimensionality.
 * @param {number} [topK=200]
 * @returns {Array<{path:string, score:number}>} Top-K results, score desc.
 */
function bruteCosineTopK(queryVec, matrix, paths, count, dim, topK = 200) {
    const n = count;
    if (!n || !matrix || !queryVec) return [];

    const k = Math.min(topK, n);
    const heapIdx = new Int32Array(k);
    const heapScore = new Float64Array(k);
    let size = 0;

    for (let i = 0; i < n; i++) {
        const score = dotRow(queryVec, matrix, i, dim);
        if (size < k) {
            heapIdx[size] = i;
            heapScore[size] = score;
            let c = size;
            while (c > 0) {
                const p = (c - 1) >> 1;
                if (heapScore[p] <= heapScore[c]) break;
                const ts = heapScore[p]; heapScore[p] = heapScore[c]; heapScore[c] = ts;
                const ti = heapIdx[p]; heapIdx[p] = heapIdx[c]; heapIdx[c] = ti;
                c = p;
            }
            size++;
        } else if (score > heapScore[0]) {
            heapIdx[0] = i;
            heapScore[0] = score;
            let p = 0;
            while (true) {
                const l = 2 * p + 1;
                const r = l + 1;
                let smallest = p;
                if (l < size && heapScore[l] < heapScore[smallest]) smallest = l;
                if (r < size && heapScore[r] < heapScore[smallest]) smallest = r;
                if (smallest === p) break;
                const ts = heapScore[p]; heapScore[p] = heapScore[smallest]; heapScore[smallest] = ts;
                const ti = heapIdx[p]; heapIdx[p] = heapIdx[smallest]; heapIdx[smallest] = ti;
                p = smallest;
            }
        }
    }

    const results = new Array(size);
    for (let i = 0; i < size; i++) {
        results[i] = { path: paths[heapIdx[i]], score: heapScore[i] };
    }
    results.sort((a, b) => b.score - a.score);
    return results;
}

/**
 * Drop results whose cosine score is below a similarity floor. Used as the
 * Phase 2.2 fix to keep weak/irrelevant hits out of semantic results.
 *
 * @param {Array<{path:string, score:number}>} results Assumed sorted desc.
 * @param {number} threshold Cosine floor in [-1,1]. Pass 0 to disable.
 * @returns {Array<{path:string, score:number}>} Filtered copy.
 */
function applyThreshold(results, threshold) {
    if (!threshold || !isFinite(threshold) || results.length === 0) return results;
    const out = [];
    for (const r of results) if (r.score >= threshold) out.push(r);
    return out;
}

/**
 * Collapse duplicate-path entries in a ranked search-result list, keeping the
 * FIRST (= highest score) occurrence and dropping the rest. Input is assumed
 * sorted by `score` descending (which is exactly what `bruteCosineTopK` and
 * `SemanticEngine._searchFlat`'s HNSW path already produce).
 *
 * Defense-in-depth for the duplicate-explorer-rows bug: the engine's in-memory
 * `_paths[]` cache can accumulate the same path twice when the file watcher's
 * incremental re-index calls `_appendToCache` for a file already in the cache
 * (DB stays deduped via `INSERT OR REPLACE` + `UNIQUE`, but the in-memory
 * parallel array isn't deduped). Applying this at the IPC boundary guarantees
 * the renderer never sees two rows for the same file, even if the cache ever
 * drifts again. The root cause is also fixed at `_appendToCache` (see
 * `src/semantic-engine.js`).
 *
 * Pure: returns a fresh array, leaves the input untouched.
 *
 * @param {Array<{path:string, score:number}>} results Sorted desc by score.
 * @returns {Array<{path:string, score:number}>} Deduped copy, order preserved.
 */
function dedupeByPath(results) {
    if (!results || results.length <= 1) return results ? results.slice() : [];
    const seen = new Set();
    const out = [];
    for (const r of results) {
        if (seen.has(r.path)) continue;
        seen.add(r.path);
        out.push(r);
    }
    return out;
}

module.exports = {
    dotRow,
    cosineSim,
    bruteCosineTopK,
    applyThreshold,
    dedupeByPath,
};