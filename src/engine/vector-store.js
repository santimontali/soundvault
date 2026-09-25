'use strict';
/**
 * In-memory CLAP vector store + HNSW index with STABLE labels.
 *
 * - Rows are L2-normalized on the way in, so dot product == cosine.
 * - Every row carries its SQLite `embeddings.id`; the HNSW label IS that id,
 *   so adds / updates / deletes are applied to the index incrementally
 *   (addPoint / markDelete) and it never goes stale or needs a full rebuild
 *   because rows moved in the flat matrix.
 * - Removal is swap-remove in the matrix (O(DIM)), O(1) lookups by path/id.
 * - The index is persisted with the DB "generation" it reflects; on load only
 *   the rows written after that generation are replayed.
 * Pure Node (the HNSW addon is optional) so it is unit-testable.
 */
const fs = require('fs');

const DIM = 512;

let HNSW = null;
try { HNSW = require('hnswlib-node').HierarchicalNSW; } catch (e) { HNSW = null; }

function normalizeInto(dst, off, src) {
    let s = 0;
    for (let d = 0; d < DIM; d++) { const v = src[d]; s += v * v; }
    const inv = s > 0 ? 1 / Math.sqrt(s) : 0;
    for (let d = 0; d < DIM; d++) dst[off + d] = src[d] * inv;
    return Math.sqrt(s);
}

class VectorStore {
    // Defaults validated on a 70k-vector copy of a real library (semantic audit R6):
    // recall@20 .996 / @200 .986 at ef 400 in ~1.3 ms; exact search below 20k.
    constructor({ dim = DIM, hnswMin = 20000, ef = 400, m = 12, efConstruction = 100 } = {}) {
        if (dim !== DIM) throw new Error('VectorStore: only DIM=512 supported');
        this.count = 0;
        this.capacity = 0;
        this.matrix = new Float32Array(0);
        this.ids = [];            // row → db id
        this.paths = [];          // row → path
        this.meta = [];           // row → { mtime, quality, durationMs, size } (catalog diff)
        this.rowByPath = new Map();
        this.rowById = new Map();
        this.hnsw = null;         // HierarchicalNSW or null
        this.hnswState = HNSW ? 'none' : 'unavailable';  // none | loading | building | ready | unavailable
        this.hnswMin = hnswMin;
        this.ef = ef; this.m = m; this.efConstruction = efConstruction;
        this.dirty = false;       // index changed since last save
        this._buildToken = 0;
    }

    static get available() { return !!HNSW; }

    _ensure(n) {
        if (n <= this.capacity) return;
        const cap = Math.max(n, Math.ceil(this.capacity * 1.5), 1024);
        const m = new Float32Array(cap * DIM);
        m.set(this.matrix.subarray(0, this.count * DIM));
        this.matrix = m;
        this.capacity = cap;
    }

    /**
     * Insert or replace (by path). `vec` = raw CLAP vector (any norm); `meta` =
     * the row's DB fields { mtime, quality, durationMs, size }. Returns the stored norm.
     */
    upsert(id, path, vec, meta = {}) {
        let row = this.rowByPath.get(path);
        if (row === undefined) {
            this._ensure(this.count + 1);
            row = this.count++;
            this.ids[row] = id; this.paths[row] = path;
            this.rowByPath.set(path, row);
        } else if (this.ids[row] !== id) {
            this.rowById.delete(this.ids[row]);
            if (this._touched) this._touched.add(this.ids[row]);
            if (this.hnsw) { try { this.hnsw.markDelete(this.ids[row]); } catch (e) { /* not in index */ } }
            this.ids[row] = id;
        }
        this.rowById.set(id, row);
        this.meta[row] = { mtime: meta.mtime || 0, quality: meta.quality ?? null, durationMs: meta.durationMs ?? null, size: meta.size ?? null };
        const norm = normalizeInto(this.matrix, row * DIM, vec);
        if (this._touched) this._touched.add(id);
        if (this.hnsw) this._hnswAdd(id, row);
        return norm;
    }

    remove(path) {
        const row = this.rowByPath.get(path);
        if (row === undefined) return false;
        const id = this.ids[row];
        const last = this.count - 1;
        if (row !== last) {
            this.matrix.copyWithin(row * DIM, last * DIM, last * DIM + DIM);
            this.ids[row] = this.ids[last]; this.paths[row] = this.paths[last]; this.meta[row] = this.meta[last];
            this.rowByPath.set(this.paths[row], row);
            this.rowById.set(this.ids[row], row);
        }
        this.ids.length = last; this.paths.length = last; this.meta.length = last;
        this.count = last;
        this.rowByPath.delete(path);
        this.rowById.delete(id);
        if (this._touched) this._touched.add(id);
        if (this.hnsw) { try { this.hnsw.markDelete(id); this.dirty = true; } catch (e) { /* already gone */ } }
        return true;
    }

    rename(from, to) {
        const row = this.rowByPath.get(from);
        if (row === undefined) return false;
        this.rowByPath.delete(from);
        this.paths[row] = to;
        this.rowByPath.set(to, row);
        return true;
    }

    metaOf(path) {
        const row = this.rowByPath.get(path);
        return row === undefined ? null : this.meta[row];
    }

    vector(path) {
        const row = this.rowByPath.get(path);
        return row === undefined ? null : this.matrix.subarray(row * DIM, row * DIM + DIM);
    }

    // ── search ──────────────────────────────────────────────────────────
    /** Exact top-K over all rows or a subset of rows (min-heap). */
    brute(q, topK, rows = null) {
        const n = rows ? rows.length : this.count;
        const k = Math.min(topK, n);
        if (!k) return [];
        const hs = new Float64Array(k), hi = new Int32Array(k);
        let size = 0;
        const M = this.matrix;
        for (let t = 0; t < n; t++) {
            const r = rows ? rows[t] : t;
            const off = r * DIM;
            let dot = 0;
            for (let d = 0; d < DIM; d += 8) {
                dot += q[d] * M[off + d] + q[d + 1] * M[off + d + 1] + q[d + 2] * M[off + d + 2] + q[d + 3] * M[off + d + 3]
                     + q[d + 4] * M[off + d + 4] + q[d + 5] * M[off + d + 5] + q[d + 6] * M[off + d + 6] + q[d + 7] * M[off + d + 7];
            }
            if (size < k) {
                let c = size++;
                hs[c] = dot; hi[c] = r;
                while (c > 0) { const p = (c - 1) >> 1; if (hs[p] <= hs[c]) break; [hs[p], hs[c]] = [hs[c], hs[p]]; [hi[p], hi[c]] = [hi[c], hi[p]]; c = p; }
            } else if (dot > hs[0]) {
                hs[0] = dot; hi[0] = r;
                let p = 0;
                for (;;) {
                    const l = 2 * p + 1, rr = l + 1; let s = p;
                    if (l < size && hs[l] < hs[s]) s = l;
                    if (rr < size && hs[rr] < hs[s]) s = rr;
                    if (s === p) break;
                    [hs[p], hs[s]] = [hs[s], hs[p]]; [hi[p], hi[s]] = [hi[s], hi[p]]; p = s;
                }
            }
        }
        const out = new Array(size);
        for (let i = 0; i < size; i++) out[i] = { path: this.paths[hi[i]], score: hs[i] };
        return out.sort((a, b) => b.score - a.score);
    }

    /**
     * Top-K cosine search. `paths` restricts to a scope (exact brute force for
     * small scopes; HNSW with a label filter for huge ones).
     */
    search(q, topK = 200, paths = null) {
        if (paths) {
            const rows = [];
            for (const p of paths) { const r = this.rowByPath.get(p); if (r !== undefined) rows.push(r); }
            if (rows.length > 25000 && this._hnswUsable()) {
                const allow = new Set(rows.map(r => this.ids[r]));
                const res = this._hnswSearch(q, Math.min(topK, rows.length), l => allow.has(l));
                if (res) return res;
            }
            return this.brute(q, topK, rows);
        }
        if (this._hnswUsable()) {
            const res = this._hnswSearch(q, Math.min(topK, this.count));
            if (res) return res;
        }
        return this.brute(q, topK);
    }

    _hnswUsable() { return this.hnsw && this.hnswState === 'ready' && this.count >= this.hnswMin; }

    _hnswSearch(q, k, filter) {
        try {
            const res = filter ? this.hnsw.searchKnn(Array.from(q), k, filter) : this.hnsw.searchKnn(Array.from(q), k);
            const out = [];
            for (let i = 0; i < res.neighbors.length; i++) {
                const row = this.rowById.get(res.neighbors[i]);
                if (row === undefined) continue;                 // deleted between calls
                out.push({ path: this.paths[row], score: 1 - res.distances[i] });
            }
            if (out.length < Math.min(k, this.count) * 0.9) return null;  // index unhealthy → exact
            return out;
        } catch (e) {
            console.warn('[VectorStore] HNSW search failed, using exact search:', e.message);
            return null;
        }
    }

    // ── HNSW lifecycle ──────────────────────────────────────────────────
    /**
     * Add or update one label. Never calls addPoint(replaceDeleted=true) for a
     * label that already exists: hnswlib would move it to another slot and
     * leave the old slot live under the same label (stale duplicate results).
     */
    _hnswAdd(id, row) {
        const h = this.hnsw;
        const vec = Array.from(this.matrix.subarray(row * DIM, row * DIM + DIM));
        try {
            try {
                h.addPoint(vec, id, false);                 // new label, or in-place update of a live one
            } catch (e) {
                const msg = String(e && e.message || e);
                if (/deleted/i.test(msg)) {                 // label exists but is marked deleted → revive in place
                    h.unmarkDelete(id);
                    h.addPoint(vec, id, false);
                } else if (/exceeds/i.test(msg)) {          // full (label is new): reuse a deleted slot, else grow
                    try { h.addPoint(vec, id, true); }
                    catch (e2) {
                        h.resizeIndex(Math.ceil(h.getMaxElements() * 1.25) + 1024);
                        h.addPoint(vec, id, false);
                    }
                } else throw e;
            }
            this.dirty = true;
        } catch (e) {
            console.warn('[VectorStore] HNSW update failed, exact search until the next rebuild:', e.message);
            this.dropIndex();
        }
    }

    /**
     * Load a persisted index (async), replaying rows written after its
     * generation. Returns true when the index is ready.
     * @param {string} file index path
     * @param {number} dbGen current DB generation
     * @param {(sinceGen:number)=>number[]} changedIdsSince ids with gen > sinceGen
     */
    async load(file, dbGen, changedIdsSince) {
        if (!HNSW || this.count < this.hnswMin) return false;
        let side = null;
        try { side = JSON.parse(fs.readFileSync(file + '.json', 'utf8')); } catch (e) { return false; }
        if (!side || side.v !== 2 || side.dim !== DIM) return false;
        this.hnswState = 'loading';
        const token = ++this._buildToken;
        try {
            const idx = new HNSW('ip', DIM);
            await idx.readIndex(file, true);
            if (token !== this._buildToken) return false;
            idx.setEf(this.ef);
            this.hnsw = idx;
            // Replay: re-add rows written after the snapshot, delete labels that no longer exist.
            if (side.gen !== dbGen) {
                for (const id of changedIdsSince(side.gen)) { const row = this.rowById.get(id); if (row !== undefined) this._hnswAdd(id, row); }
            }
            for (const label of idx.getIdsList()) {
                if (!this.rowById.has(label)) { try { idx.markDelete(label); this.dirty = true; } catch (e) { /* already deleted */ } }
            }
            if (!this.hnsw) return false;
            this.hnswState = 'ready';
            return true;
        } catch (e) {
            console.warn('[VectorStore] could not load HNSW index:', e.message);
            this.hnsw = null; this.hnswState = 'none';
            return false;
        }
    }

    /**
     * Build from scratch in ~30 ms time slices (the host thread keeps serving
     * searches, which stay exact meanwhile). Rows upserted or removed while
     * building are recorded and replayed at the end, never re-add rows that
     * are already in: addPoint on an existing label is a full neighbour
     * re-link (it doubled the build and stalled the thread for tens of seconds).
     */
    async build() {
        if (!HNSW || this.count < this.hnswMin) { this.hnsw = null; this.hnswState = HNSW ? 'none' : 'unavailable'; return false; }
        const token = ++this._buildToken;
        this.hnswState = 'building';
        const touched = this._touched = new Set();
        const idx = new HNSW('ip', DIM);
        idx.initIndex({ maxElements: Math.ceil(this.count * 1.15) + 1024, m: this.m, efConstruction: this.efConstruction, randomSeed: 100, allowReplaceDeleted: true });
        const t0 = Date.now();
        const quit = () => { if (this._touched === touched) this._touched = null; return false; };
        // Snapshot ids; rows may move while we yield, so look them up by id each time.
        const ids = this.ids.slice(0, this.count);
        let slice = Date.now();
        for (let i = 0; i < ids.length; i++) {
            const id = ids[i];
            const row = touched.has(id) ? undefined : this.rowById.get(id);       // touched rows: replayed below
            if (row !== undefined) idx.addPoint(Array.from(this.matrix.subarray(row * DIM, row * DIM + DIM)), id, false);
            if (Date.now() - slice > 30) {
                await new Promise(r => setImmediate(r));
                if (token !== this._buildToken) return quit();
                slice = Date.now();
            }
        }
        idx.setEf(this.ef);
        this.hnsw = idx;
        this._touched = null;
        for (const id of touched) {
            const row = this.rowById.get(id);
            if (row !== undefined) this._hnswAdd(id, row);
            else { try { idx.markDelete(id); } catch (e) { /* never made it in */ } }
            if (this.hnsw !== idx) return false;                                   // replay failed → exact search
        }
        this.hnswState = 'ready'; this.dirty = true;
        console.log(`[VectorStore] HNSW built: ${this.count} vectors in ${Date.now() - t0} ms`);
        return true;
    }

    async save(file, gen) {
        if (!this.hnsw || this.hnswState !== 'ready' || !this.dirty) return false;
        const tmp = file + '.tmp';
        await this.hnsw.writeIndex(tmp);
        fs.renameSync(tmp, file);
        fs.writeFileSync(file + '.json', JSON.stringify({ v: 2, dim: DIM, gen, count: this.count, savedAt: Date.now() }));
        this.dirty = false;
        return true;
    }

    dropIndex() { this._buildToken++; this._touched = null; this.hnsw = null; this.hnswState = HNSW ? 'none' : 'unavailable'; }
}

module.exports = { VectorStore, DIM };
