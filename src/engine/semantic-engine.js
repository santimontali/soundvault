'use strict';
/**
 * SemanticEngine: CLAP text search, collection suggestions and the indexing
 * pipeline. Lives in the engine-host worker thread, never on Electron's main
 * thread.
 *
 *  - The library file list comes from the main process (LibraryIndex); the
 *    engine never walks or stats the library itself.
 *  - Vectors are L2-normalised in memory (VectorStore); the HNSW label of a
 *    vector is its stable DB id, so every add/update/delete is applied to the
 *    index incrementally and the index is persisted with the DB generation it
 *    reflects.
 *  - Indexing is a priority queue served to a single worker (index-worker.js)
 *    in small chunks: new/changed files the user is waiting for first, the
 *    bulk catalog next, the deep pass for long files last. Cancel empties the
 *    queue; the worker exits after a minute idle to give its memory back.
 *  - The host is the only DB writer: results stream back from the worker and
 *    are written in one transaction per batch.
 */
const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const { EventEmitter } = require('events');
const { openDb, EmbeddingsTable } = require('./db');
const { VectorStore, DIM } = require('./vector-store');
const { translateQuery } = require('../search/translate');

const MODEL_ID = 'Xenova/clap-htsat-unfused';
const FULL_MAX_MS = 10500;
const CHUNK = 16;                     // jobs per worker round-trip
const WORKER_IDLE_MS = 60000;
const CHANGE_DEBOUNCE_MS = 800;
const HNSW_SAVE_DELAY_MS = 30000;

const isWin = process.platform === 'win32';
const keyOf = p => { const n = path.resolve(p); return isWin ? n.toLowerCase() : n; };
const stripAccents = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '');
const tick = () => new Promise(r => setImmediate(r));

class LRU {
    constructor(n) { this.n = n; this.m = new Map(); }
    get(k) { const v = this.m.get(k); if (v !== undefined) { this.m.delete(k); this.m.set(k, v); } return v; }
    set(k, v) { this.m.delete(k); this.m.set(k, v); if (this.m.size > this.n) this.m.delete(this.m.keys().next().value); }
}

/** Similarity floor for text→audio results (semantic audit: < 0.30 cosine was ≤ 8% relevant). */
function cutoffFor(top1) {
    return Math.max(Math.min(0.30, top1 - 0.05), top1 - 0.25);
}

class SemanticEngine extends EventEmitter {
    /**
     * @param {object} o
     * @param {string} o.userDataPath
     * @param {boolean} [o.isPackaged]
     * @param {string} [o.resourcesPath]
     * @param {string} [o.ffmpegPath]
     * @param {number} [o.hnswMin]   use HNSW from this many vectors (exact search below)
     * @param {object} [o.echo]      Echo index (spectral fingerprints), optional
     */
    constructor(o) {
        super();
        this.o = o;
        this.db = null;
        this.emb = null;
        this.echo = o.echo || null;
        this.store = new VectorStore({ hnswMin: o.hnswMin ?? 20000 });
        this.root = null;
        this.rootKey = null;
        this.ready = false;
        this.initializing = false;
        this.error = null;
        this.modelsError = null;
        this._tokenizer = null;
        this._textModel = null;
        this._audio = null;              // lazily loaded { processor, model } for Echo queries
        this._qcache = new LRU(128);     // text → normalised Float32Array
        // indexing
        this.queue = { hi: [], a: [], b: [] };
        this.queued = new Map();         // path → job (dedupe; last request wins)
        this.inflight = new Map();       // path → token of the job whose result we accept
        this._seq = 0;
        this.worker = null;
        this._workerReady = null;
        this._runId = 0;
        this._busy = false;
        this._idleTimer = null;
        this.run = null;                 // { total, done, failed, deepTotal, deepDone, file, startedAt }
        this.failures = 0;
        this._pendingChanges = { added: new Map(), removed: new Set() };
        this._changeTimer = null;
        this._saveTimer = null;
        this._hnswFile = null;
    }

    // ── lifecycle ────────────────────────────────────────────────────────
    async init() {
        if (this.ready || this.initializing) return;
        this.initializing = true;
        this._emit();
        try {
            const dir = this.o.userDataPath;
            this.db = openDb(path.join(dir, 'soundvault-semantic.db'));
            this.emb = new EmbeddingsTable(this.db);
            this._hnswFile = path.join(dir, 'soundvault-vectors.hnsw');
            for (const old of ['soundvault-hnsw.idx', 'soundvault-hnsw.idx.key']) {      // pre-2.0 index (wrong labels/metric)
                try { fs.unlinkSync(path.join(dir, old)); } catch (e) { /* not there */ }
            }
            this.failures = this.emb.failures().length;
            if (this.echo) this.echo.attach(this.db);
            if (this._earlyMoves) { this._renamePaths(this._earlyMoves); this._earlyMoves = null; }
            // The text model (mostly native work) loads while the library's vectors
            // and fingerprints stream in from the DB; both settle before we report.
            const store = this.root ? this._loadStore() : Promise.resolve();
            const text = this._loadTextModel();
            store.catch(() => {}); text.catch(() => {});
            await store;
            this._emit();
            await text;
            this.ready = true;
        } catch (e) {
            this.error = String((e && e.message) || e);
            console.error('[Engine] init failed:', e);
        } finally {
            this.initializing = false;
            this._emit();
        }
        // The ANN build starts only now, so it never delays the first search.
        if (this.ready) this._ensureIndex();
        this._flushChanges();
    }

    async _loadTextModel() {
        let tf;
        try {
            tf = require('@xenova/transformers');
        } catch (e) {
            // A quarantined onnxruntime.dll or a missing CRT must never take the
            // library browser down with it: AI features report unavailable.
            this.modelsError = 'Resonance could not load its models (' + e.message + ')';
            throw new Error(this.modelsError);
        }
        this._configureModels(tf.env);
        const t0 = Date.now();
        this._tokenizer = await tf.AutoTokenizer.from_pretrained(MODEL_ID);
        this._textModel = await tf.ClapTextModelWithProjection.from_pretrained(MODEL_ID, { quantized: false });
        console.log(`[Engine] text model ready in ${Date.now() - t0} ms`);
    }

    _configureModels(env) {
        if (this.o.isPackaged && this.o.resourcesPath) {
            env.cacheDir = path.join(this.o.resourcesPath, 'models');
            env.localModelPath = env.cacheDir;
            env.allowRemoteModels = false;
        }
        return env.cacheDir;
    }

    async close() {
        this._stopWorker();
        if (this.echo) { this.echo.releaseMemory(); this.echo.stopMigration(); }
        clearTimeout(this._changeTimer);
        clearTimeout(this._saveTimer);
        try { await this._saveIndex(); } catch (e) { /* best effort */ }
        try { if (this.db) this.db.close(); } catch (e) { /* already closed */ }
        this.db = null;
    }

    // ── library scope ───────────────────────────────────────────────────
    _under(p) { if (!this.rootKey) return false; const k = keyOf(p); return k === this.rootKey || k.startsWith(this.rootKey + path.sep); }

    async setRoot(root) {
        const key = root ? keyOf(root) : null;
        if (key === this.rootKey) return;
        this.root = root || null;
        this.rootKey = key;
        this.cancelIndex();
        if (this.db) { await this._loadStore(); this._emit(); }
    }

    /**
     * Load this library's vectors and fingerprints into memory (chunked; yields
     * so status and searches stay responsive). A catalog diff requested
     * meanwhile waits for it: diffing half-loaded memory would re-queue files
     * that are already analysed.
     */
    async _loadStore() {
        this._storeLoads = (this._storeLoads || 0) + 1;
        try {
            await this._loadStoreNow();
        } finally {
            this._storeLoads--;
            this._runDeferredIndex();
        }
    }

    _runDeferredIndex() {
        const d = this._deferredIndex;
        if (!d || this._storeLoads || (this.echo && this.echo.loading)) return;
        this._deferredIndex = null;
        this.index(d.files, d.o);
    }

    async _loadStoreNow() {
        const t0 = Date.now();
        this.store.dropIndex();
        this.store = new VectorStore({ hnswMin: this.o.hnswMin ?? 20000 });
        if (!this.rootKey) { if (this.echo) this.echo.unload(); return; }
        const store = this.store;
        const deep = [];
        let legacy = 0;
        for (const rows of this.emb.iterate(1000)) {
            if (store !== this.store) return;              // root changed meanwhile
            for (const r of rows) {
                if (!r.vector || r.vector.byteLength !== DIM * 4 || !this._under(r.path)) continue;
                const v = new Float32Array(r.vector.buffer, r.vector.byteOffset, DIM);
                const norm = store.upsert(r.id, r.path, v, r);
                if (r.quality == null) {
                    legacy++;
                    // Mean-pooled vectors were stored unit-length; single inferences are not.
                    if (Math.abs(norm - 1) < 1e-3) { deep.push(r.id); store.metaOf(r.path).quality = 2; }
                }
            }
            await tick();
        }
        if (deep.length) {
            const upd = this.db.prepare('UPDATE embeddings SET quality = 2 WHERE id = ?');
            this.db.transaction(ids => { for (const id of ids) upd.run(id); })(deep);
        }
        if (legacy) console.log(`[Engine] classified ${legacy} legacy vectors (${deep.length} already complete)`);
        console.log(`[Engine] ${store.count} vectors loaded in ${Date.now() - t0} ms`);
        if (this.echo) {
            if (!await this.echo.load(p => this._under(p)) || store !== this.store) return;
            if (this.echo.legacyTable) this.echo.startMigration(res => {
                if (res.error) { console.warn('[Engine] Echo upgrade failed:', res.error); return; }
                // Fingerprints are diffed again now that the converted rows are loaded.
                this.echo.load(p => this._under(p)).then(ok => {
                    if (!ok) return;
                    if (!this._deferredIndex && this._lastFiles) this._deferredIndex = { files: this._lastFiles, o: {} };
                    this._runDeferredIndex();
                    this._emit();
                });
            });
        }
        await this._openIndex();
    }

    // ── Echo ────────────────────────────────────────────────────────────
    _clapAdapter() {
        const store = this.store;
        return {
            neighbours: (p, k) => { const v = store.vector(p); return v ? store.search(v, k + 1).filter(r => r.path !== p) : []; },
            score: (a, b) => {
                const va = store.vector(a), vb = store.vector(b);
                if (!va || !vb) return null;
                let s = 0; for (let d = 0; d < DIM; d++) s += va[d] * vb[d];
                return s;
            },
        };
    }

    async echoQuery(params) {
        if (!this.echo) return { results: [], error: 'unavailable' };
        const raw = params.pcm || params.pcmData;
        const pcm = raw instanceof Float32Array ? raw : new Float32Array(raw.buffer || raw, raw.byteOffset || 0, Math.floor((raw.byteLength || 0) / 4));
        return this.echo.query({ ...params, pcm });
    }

    async echoFile(p, opts = {}) {
        if (!this.echo) return { results: [], error: 'unavailable' };
        return this.echo.similarToFile(p, opts, this.ready ? this._clapAdapter() : null);
    }

    async _openIndex() {
        const store = this.store;
        if (!VectorStore.available || store.count < store.hnswMin) return;
        const side = (() => { try { return JSON.parse(fs.readFileSync(this._hnswFile + '.json', 'utf8')); } catch (e) { return null; } })();
        const gen = this.emb.gen;
        if (side && side.instance === this.emb.instance && side.root === this.rootKey && side.gen <= gen) {
            const t0 = Date.now();
            if (await store.load(this._hnswFile, gen, since => this.emb.idsSince(since))) {
                this.hnswSource = 'loaded';
                console.log(`[Engine] HNSW loaded in ${Date.now() - t0} ms`);
                if (store.dirty) this._scheduleSave();
                return;
            }
        }
        if (this.ready) this._ensureIndex();           // during init: built once the text model is up
    }

    /** Build the ANN index in the background once the library is big enough (searches stay exact meanwhile). */
    _ensureIndex() {
        const store = this.store;
        if (!VectorStore.available || store.hnsw || store.count < store.hnswMin || store.hnswState === 'building' || store.hnswState === 'loading') return;
        store.build().then(ok => {
            if (!ok || store !== this.store) return;
            this.hnswSource = 'built';
            this._scheduleSave(5000);
            this._emit();
        }).catch(e => console.warn('[Engine] HNSW build failed:', e.message));
    }

    _scheduleSave(ms = HNSW_SAVE_DELAY_MS) {
        clearTimeout(this._saveTimer);
        this._saveTimer = setTimeout(() => this._saveIndex().catch(e => console.warn('[Engine] HNSW save failed:', e.message)), ms);
    }

    async _saveIndex() {
        const store = this.store;
        if (!store.hnsw || !store.dirty || !this.emb) return;
        const gen = this.emb.gen;
        if (await store.save(this._hnswFile, gen)) {
            fs.writeFileSync(this._hnswFile + '.json', JSON.stringify({ v: 2, dim: DIM, gen, instance: this.emb.instance, root: this.rootKey, count: store.count, savedAt: Date.now() }));
        }
    }

    // ── status ──────────────────────────────────────────────────────────
    status() {
        const r = this.run;
        const pending = this.queue.hi.length + this.queue.a.length + this.queue.b.length;
        return {
            ready: this.ready,
            initializing: this.initializing,
            error: this.error,
            vectors: this.store.count,
            indexing: !!(r && (pending || this._busy)),
            progress: r ? {
                phase: r.finished ? 'done' : (this.queue.hi.length || this.queue.a.length || (this._busy && r.phase === 'index')) ? 'index' : 'deep',
                done: r.done, total: r.total, failed: r.failed,
                indexTotal: r.indexTotal, indexDone: r.indexDone, deepTotal: r.deepTotal, deepDone: r.deepDone,
                file: r.file || '',
            } : null,
            failures: this.failures,
            hnsw: this.store.hnswState,
            hnswSource: this.hnswSource || null,
            echo: this.echo ? this.echo.count : 0,
            echoUpgrade: this.echo && this.echo.migration ? this.echo.migration : null,
        };
    }

    _emit() {
        const now = Date.now();
        if (this._lastEmit && now - this._lastEmit < 200) {
            if (!this._emitTimer) this._emitTimer = setTimeout(() => { this._emitTimer = null; this._emit(); }, 200);
            return;
        }
        this._lastEmit = now;
        this.emit('status', this.status());
    }

    // ── search ──────────────────────────────────────────────────────────
    async _embedText(text) {
        const key = text;
        let v = this._qcache.get(key);
        if (v) return v;
        const inputs = await this._tokenizer([text], { padding: true, truncation: true });
        const { text_embeds } = await this._textModel(inputs);
        v = new Float32Array(text_embeds.data.subarray ? text_embeds.data.subarray(0, DIM) : text_embeds.data);
        let s = 0; for (let i = 0; i < DIM; i++) s += v[i] * v[i];
        const k = s > 0 ? 1 / Math.sqrt(s) : 0;
        for (let i = 0; i < DIM; i++) v[i] *= k;
        this._qcache.set(key, v);
        return v;
    }

    /**
     * Query vector for a (possibly Spanish) query, with optional per-word
     * weights ({ word: 0..2 }). Stateless: concurrent searches never share state.
     */
    async queryVector(q, weights = null) {
        const tq = translateQuery(q);
        const text = stripAccents(tq.text).trim();
        const base = await this._embedText(text);
        const words = [...new Set(text.toLowerCase().split(/\s+/).filter(w => w.length > 2))];
        if (!weights || words.length < 2) return { vec: base, words: words.length > 1 ? words : [], text, translated: tq.changed };
        const vec = new Float32Array(base);
        let changed = false;
        for (const w of words) {
            const shift = (Number(weights[w]) || 1) - 1;
            if (!shift) continue;
            const wv = await this._embedText(w);
            for (let i = 0; i < DIM; i++) vec[i] += wv[i] * shift;
            changed = true;
        }
        if (changed) {
            let s = 0; for (let i = 0; i < DIM; i++) s += vec[i] * vec[i];
            const k = s > 0 ? 1 / Math.sqrt(s) : 0;
            for (let i = 0; i < DIM; i++) vec[i] *= k;
        }
        return { vec, words, text, translated: tq.changed };
    }

    /**
     * @param {string} q
     * @param {{paths?: string[]|null, topK?: number, weights?: object, raw?: boolean}} o
     * @returns {Promise<{results: {path:string,score:number}[], words: string[], query: string, translated: boolean, cutoff: number}>}
     */
    async search(q, o = {}) {
        if (!this.ready) return { results: [], words: [], notReady: true };
        const t0 = Date.now();
        const { vec, words, text, translated } = await this.queryVector(q, o.weights);
        const topK = Math.max(1, Math.min(5000, o.topK || 500));
        let results = this.store.search(vec, topK, Array.isArray(o.paths) ? o.paths : null);
        let cutoff = 0;
        if (!o.raw && results.length) {
            cutoff = cutoffFor(results[0].score);
            results = results.filter(r => r.score >= cutoff);
        }
        console.log(`[Engine] search "${text}" → ${results.length} (${Date.now() - t0} ms, ${o.paths ? o.paths.length + ' scoped' : this.store.count} vectors)`);
        return { results, words, query: text, translated, cutoff };
    }

    /** Exact similarity of `q` for specific files (hybrid ranking of filename hits). */
    async score(q, paths, o = {}) {
        if (!this.ready || !Array.isArray(paths) || !paths.length) return [];
        const { vec } = await this.queryVector(q, o.weights);
        return this.store.search(vec, paths.length, paths);
    }

    /**
     * Sounds that resonate with a set of files (collection suggestions).
     * Coherent sets use their centroid; mixed sets also pull neighbours of
     * individual members, so a "footsteps + explosions" collection gets both.
     * Exact duplicates (identical vectors) are shown once.
     */
    suggest(paths, topK = 24) {
        if (!this.ready || !Array.isArray(paths) || !paths.length) return [];
        const store = this.store;
        const members = [];
        const memberSet = new Set();
        for (const p of paths) { const v = store.vector(p); if (v) { members.push(v); memberSet.add(p); } }
        if (!members.length) return [];
        const centroid = new Float32Array(DIM);
        for (const v of members) for (let d = 0; d < DIM; d++) centroid[d] += v[d];
        let s = 0; for (let d = 0; d < DIM; d++) s += centroid[d] * centroid[d];
        const inv = s > 0 ? 1 / Math.sqrt(s) : 0;
        for (let d = 0; d < DIM; d++) centroid[d] *= inv;
        // Spread sample of members for the per-member pass (bounded work).
        const sample = members.length <= 16 ? members : Array.from({ length: 16 }, (_, i) => members[Math.floor(i * members.length / 16)]);
        const cand = new Map();
        const take = (list) => { for (const r of list) if (!memberSet.has(r.path) && !cand.has(r.path)) cand.set(r.path, 0); };
        take(store.search(centroid, topK * 3 + members.length));
        if (sample.length > 1) for (const m of sample) take(store.search(m, topK + members.length));
        const dot = (a, b) => { let x = 0; for (let d = 0; d < DIM; d++) x += a[d] * b[d]; return x; };
        const scored = [];
        for (const p of cand.keys()) {
            const v = store.vector(p);
            if (!v) continue;
            let best = 0;
            for (const m of sample) { const x = dot(v, m); if (x > best) best = x; }
            // Nearest member dominates; closeness to the whole set breaks ties.
            scored.push({ path: p, score: 0.7 * best + 0.3 * dot(v, centroid), v });
        }
        scored.sort((a, b) => b.score - a.score);
        const out = [], picked = [];
        for (const c of scored) {
            if (out.length >= topK) break;
            if (members.some(m => dot(c.v, m) > 0.9995) || picked.some(v => dot(c.v, v) > 0.9995)) continue;
            picked.push(c.v);
            out.push({ path: c.path, score: c.score });
        }
        return out;
    }

    /** Audio → vector for Echo queries (audio model loaded on first use). */
    async embedAudio(samples48k) {
        if (!this._audio) {
            const tf = require('@xenova/transformers');
            this._configureModels(tf.env);
            this._audio = {
                processor: await tf.AutoProcessor.from_pretrained(MODEL_ID).then(p => { require('./clap-fbank').patchProcessor(p); return p; }),
                model: await tf.ClapAudioModelWithProjection.from_pretrained(MODEL_ID, { quantized: false }),
            };
        }
        const WIN = 480000;
        // CLAP's extractor random-crops inputs longer than 10 s: embed fixed
        // windows instead and average them (deterministic results).
        const starts = samples48k.length <= WIN ? [0] : Array.from({ length: Math.min(5, Math.ceil(samples48k.length / WIN)) }, (_, i, a) => Math.round((samples48k.length - WIN) * (a.length === 1 ? 0 : i / (a.length - 1))));
        const mean = new Float32Array(DIM);
        for (const st of starts) {
            const { audio_embeds } = await this._audio.model(await this._audio.processor(samples48k.subarray(st, st + WIN)));
            const v = audio_embeds.data;
            let s = 0; for (let d = 0; d < DIM; d++) s += v[d] * v[d];
            const k = s > 0 ? 1 / Math.sqrt(s) : 0;
            for (let d = 0; d < DIM; d++) mean[d] += v[d] * k;
        }
        let s = 0; for (let d = 0; d < DIM; d++) s += mean[d] * mean[d];
        const k = s > 0 ? 1 / Math.sqrt(s) : 0;
        for (let d = 0; d < DIM; d++) mean[d] *= k;
        return mean;
    }

    // ── indexing: catalog run ───────────────────────────────────────────
    /**
     * Bring the index up to date with the library.
     * @param {{path:string, mtime:number, size?:number}[]} files every audio file in the library (from main)
     * @param {{retryFailed?: boolean}} [o]
     * @returns {{queued:number, deep:number, removed:number, renamed:number}}
     */
    index(files, o = {}) {
        if (!this.db || !this.rootKey) return { queued: 0, deep: 0, removed: 0, renamed: 0 };
        this._lastFiles = files;
        if (this._storeLoads || (this.echo && this.echo.loading)) {
            this._deferredIndex = { files, o };                       // runs when the load finishes
            return { queued: 0, deep: 0, removed: 0, renamed: 0, deferred: true };
        }
        const t0 = Date.now();
        const marks = [];                                              // stage timings, logged when slow
        const mark = label => marks.push(label + ' ' + (Date.now() - t0));
        if (o.retryFailed) { this.emb.clearFailures(); this.failures = 0; }
        const cur = new Map();
        for (const f of files || []) if (f && f.path) cur.set(keyOf(f.path), f);
        mark('list');
        // The library moved (new drive letter, copied to another disk)? Re-key the
        // previous root's rows by relative path instead of re-analysing everything.
        const lastRoot = this.emb.getMeta('root');
        if (cur.size) this.emb.setMeta('root', this.root);
        if (lastRoot && keyOf(lastRoot) !== this.rootKey && cur.size) {
            const n = this._relink(lastRoot, cur);
            if (n) {
                this._deferredIndex = { files, o };
                this._loadStore().then(() => this._emit(), e => console.warn('[Engine] reload after relink failed:', e.message));
                return { queued: 0, deep: 0, removed: 0, renamed: 0, relinked: n };
            }
        }
        mark('root');
        const failures = new Map(this.emb.failures().map(r => [r.path, r]));
        mark('failures');
        // While the pre-2.0 Echo table is being converted its rows are not loaded
        // yet: fingerprints are diffed again once the conversion finishes.
        const echo = this.echo && !this.echo.legacyTable ? this.echo : null;
        const removed = [], renames = [], jobsA = [], jobsB = [], sizes = [];
        const seen = new Set();
        // Diffed against the rows already in memory (loaded with their DB fields
        // and kept in step with every write): no DB scan, so it costs the same
        // on an HDD as on an SSD. Rows without a usable vector are not loaded;
        // their files count as new and are re-analysed.
        const store = this.store;
        for (let row = 0; row < store.count; row++) {
            const p = store.paths[row], m = store.meta[row];
            const r = { id: store.ids[row], path: p, mtime: m.mtime, quality: m.quality, durationMs: m.durationMs, size: m.size };
            const k = keyOf(p);
            const f = cur.get(k);
            if (!f) { removed.push(r.path); continue; }
            seen.add(k);
            if (r.size == null && f.size && f.mtime === r.mtime) sizes.push([f.size, r.id]);
            if (f.path !== r.path) renames.push({ from: r.path, to: f.path });
            const mtime = f.mtime || r.mtime;
            const fail = failures.get(f.path);
            if (fail && fail.mtime === mtime) continue;
            if (f.mtime && f.mtime !== r.mtime) { jobsA.push({ path: f.path, mtime: f.mtime, size: f.size, clap: true, spectral: !!echo }); continue; }
            const needSpectral = echo && echo.needs(f.path, mtime, r.durationMs);
            if (needSpectral) jobsA.push({ path: f.path, mtime, size: f.size, clap: false, spectral: true });
            if (r.quality !== 2) jobsB.push({ path: f.path, mtime, size: f.size, duration: r.durationMs != null ? r.durationMs / 1000 : null });
        }
        mark('rows');
        for (const [k, f] of cur) {
            if (seen.has(k)) continue;
            const fail = failures.get(f.path);
            if (fail && (!f.mtime || fail.mtime === f.mtime)) continue;
            jobsA.push({ path: f.path, mtime: f.mtime || 0, size: f.size, clap: true, spectral: !!echo });
        }
        // Fingerprints without a vector row: 1.x leftovers of deleted files go,
        // the rest follow the library's exact spelling of their path.
        mark('new');
        const echoGone = [], echoFix = [];
        if (echo && cur.size) {
            for (const p of echo.paths) {
                if (store.rowByPath.has(p)) continue;
                const f = cur.get(keyOf(p));
                if (!f) echoGone.push(p); else if (f.path !== p) echoFix.push({ from: p, to: f.path });
            }
        }
        mark('echo');
        // Never wipe the catalog because the library list came back empty
        // (unplugged drive, failed scan): deletions need a non-empty library.
        if (sizes.length) {                                               // lets Explorer moves keep their vectors
            this.emb.fillSizes(sizes);
            for (const [size, id] of sizes) { const row = store.rowById.get(id); if (row !== undefined) store.meta[row].size = size; }
        }
        if (cur.size && removed.length) this._removePaths(removed);
        if (renames.length) this._renamePaths(renames);
        if (echoGone.length) this.echo.remove(echoGone);
        if (echoFix.length) this.echo.rename(echoFix);
        mark('apply');
        // Folder order: neighbouring files are neighbours on disk (far fewer HDD seeks),
        // and each pack becomes fully searchable in turn.
        const byPath = (x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0);
        jobsA.sort(byPath);
        jobsB.sort(byPath);
        mark('sort');
        this._enqueue(jobsA, 'a');
        this._enqueue(jobsB, 'b');
        mark('queue');
        const ms = Date.now() - t0;
        console.log(`[Engine] catalog diff in ${ms} ms: ${jobsA.length} to analyze, ${jobsB.length} to refine, ${removed.length} removed, ${renames.length} renamed`
            + (echoGone.length || echoFix.length ? `, ${echoGone.length + echoFix.length} fingerprints tidied` : '') + (ms > 1000 ? ` [${marks.join(', ')}]` : ''));
        this._emit();
        return { queued: jobsA.length, deep: jobsB.length, removed: removed.length, renamed: renames.length };
    }

    /**
     * Move rows of `oldRoot` to the current root when the same relative paths
     * (and sizes, where known) exist there. Requires a real match (≥ 30% of
     * the old rows) so two unrelated libraries are never merged. Copies keep
     * the modification time only up to the target's precision (FAT 2 s, exFAT
     * 10 ms, many copy tools 1 ms): within 2 s it is the same file and the new
     * time is adopted; beyond that the file is relinked and re-analysed.
     */
    _relink(oldRoot, cur) {
        const oldKey = keyOf(oldRoot);
        const moves = [];
        let under = 0;
        for (const r of this.emb.allMeta()) {
            const k = keyOf(r.path);
            if (!k.startsWith(oldKey + path.sep)) continue;
            under++;
            const rel = path.resolve(r.path).slice(oldKey.length + 1);
            const f = cur.get(keyOf(path.join(this.root, rel)));
            if (!f || (f.size && r.size && f.size !== r.size)) continue;
            const same = f.mtime && r.mtime && f.mtime !== r.mtime && Math.abs(f.mtime - r.mtime) <= 2000;
            moves.push(same ? { from: r.path, to: f.path, mtime: f.mtime } : { from: r.path, to: f.path });
        }
        if (!moves.length || moves.length < under * 0.3) return 0;
        const relinked = moves.length;
        // Files that could not be decoded move too, so they are not retried.
        for (const r of this.emb.failures()) {
            if (!keyOf(r.path).startsWith(oldKey + path.sep)) continue;
            const f = cur.get(keyOf(path.join(this.root, path.resolve(r.path).slice(oldKey.length + 1))));
            if (f) moves.push(f.mtime && r.mtime && Math.abs(f.mtime - r.mtime) <= 2000 ? { from: r.path, to: f.path, mtime: f.mtime } : { from: r.path, to: f.path });
        }
        this._renamePaths(moves);
        console.log(`[Engine] library moved: ${relinked} of ${under} analysed files relinked from ${oldRoot} to ${this.root}`);
        return relinked;
    }

    cancelIndex() {
        for (const q of Object.values(this.queue)) { for (const j of q) this._drop(j); q.length = 0; }
        this.queued.clear();
        this.inflight.clear();
        if (this.worker && this._busy) this.worker.postMessage({ type: 'cancel', runId: this._runId });
        if (this.run) this.run.cancelled = true;
        this._emit();
        return true;
    }

    _enqueue(jobs, lane) {
        if (!jobs.length) return;
        if (!this.run || this.run.finished) {
            this.run = { total: 0, done: 0, failed: 0, indexTotal: 0, indexDone: 0, deepTotal: 0, deepDone: 0, file: '', startedAt: Date.now() };
        }
        for (const j of jobs) {
            const prev = this.queued.get(j.path);
            if (prev) {
                // First-pass requests merge; a first pass supersedes a queued deep job.
                if (prev.lane !== 'b' && lane !== 'b') { prev.clap = prev.clap || j.clap; prev.spectral = prev.spectral || j.spectral; prev.mtime = j.mtime || prev.mtime; continue; }
                if (prev.lane !== 'b' && lane === 'b') continue;
                this._drop(prev);
            }
            j.kind = lane === 'b' ? 'b' : 'a';
            j.lane = lane;
            j.token = ++this._seq;
            this.queued.set(j.path, j);
            this.queue[lane].push(j);
            this.run.total++;
            if (lane === 'b') this.run.deepTotal++; else this.run.indexTotal++;
        }
        this._pump();
    }

    _drop(j) {
        if (j.dropped) return;
        j.dropped = true;
        if (this.queued.get(j.path) === j) this.queued.delete(j.path);
        if (this.run && !this.run.finished) {
            this.run.total--;
            if (j.kind === 'b') this.run.deepTotal--; else this.run.indexTotal--;
        }
    }

    _next(n) {
        const out = [];
        for (const lane of ['hi', 'a', 'b']) {
            const q = this.queue[lane];
            while (q.length && out.length < n) {
                const j = q.shift();
                if (j.dropped || this.queued.get(j.path) !== j) continue;
                this.queued.delete(j.path);
                this.inflight.set(j.path, j);
                out.push(j);
            }
            if (out.length) break;          // never mix lanes in one chunk
        }
        return out;
    }

    async _pump() {
        if (this._busy || this._pumping) return;
        this._pumping = true;
        try {
            const pending = this.queue.hi.length + this.queue.a.length + this.queue.b.length;
            if (!pending) { this._finishRun(); return; }
            clearTimeout(this._idleTimer);
            const w = await this._ensureWorker();
            if (!w) return;
            const jobs = this._next(CHUNK);
            if (!jobs.length) { this._finishRun(); return; }
            this._busy = true;
            this._runId++;
            this.run.phase = jobs[0].kind === 'b' ? 'deep' : 'index';
            w.postMessage({ type: 'run', runId: this._runId, jobs: jobs.map(j => ({ path: j.path, mtime: j.mtime, size: j.size, kind: j.kind, clap: !!j.clap, spectral: !!j.spectral, duration: j.duration ?? null, token: j.token })) });
            this._emit();
        } finally {
            this._pumping = false;
        }
    }

    _finishRun() {
        if (this.run && !this.run.finished) {
            this.run.finished = true;
            this.run.phase = 'done';
            const ms = Date.now() - this.run.startedAt;
            console.log(`[Engine] catalog run done: ${this.run.done} files (${this.run.failed} failed) in ${(ms / 1000).toFixed(1)} s`);
            this._ensureIndex();
            this._scheduleSave(3000);
            this._emit();
        }
        clearTimeout(this._idleTimer);
        this._idleTimer = setTimeout(() => this._stopWorker(), WORKER_IDLE_MS);
    }

    _ensureWorker() {
        if (this._workerReady) return this._workerReady;
        const file = path.join(__dirname, 'index-worker.js');
        const w = new Worker(file, { resourceLimits: { maxOldGenerationSizeMb: 2048 } });
        this.worker = w;
        // Packaged builds read the bundled models offline; dev keeps download-on-first-use.
        const cacheDir = this.o.isPackaged && this.o.resourcesPath ? path.join(this.o.resourcesPath, 'models') : null;
        this._workerReady = new Promise(resolve => {
            const onMsg = msg => {
                if (!msg) return;
                if (msg.type === 'ready') { resolve(w); return; }
                if (msg.type === 'init-error') {
                    console.error('[Engine] index worker failed to start:', msg.error);
                    this.error = 'Indexing is unavailable: ' + msg.error;
                    resolve(null);
                    this._stopWorker();
                    this.cancelIndex();
                    return;
                }
                if (msg.type === 'items') this._onItems(msg.items);
                else if (msg.type === 'progress') { if (this.run) { this.run.file = msg.file; this._emit(); } }
                else if (msg.type === 'run-done') { this._busy = false; if (msg.error) console.warn('[Engine] worker run failed:', msg.error); this._pump(); }
            };
            w.on('message', onMsg);
            w.on('error', e => console.error('[Engine] index worker error:', e));
            w.on('exit', code => {
                if (this.worker !== w) return;
                this.worker = null; this._workerReady = null;
                const wasBusy = this._busy;
                this._busy = false;
                if (code !== 0 && !this._stopping) {
                    console.warn('[Engine] index worker exited with code', code);
                    resolve(null);
                    // Requeue what was in flight (the crash may be one bad file: it is
                    // retried once, then recorded as a failure).
                    if (wasBusy) this._requeueInflight();
                    setTimeout(() => this._pump(), 1000);
                }
            });
        });
        w.postMessage({ type: 'init', ffmpegPath: this.o.ffmpegPath || null, cacheDir });
        return this._workerReady;
    }

    _requeueInflight() {
        const again = [];
        this._crashes = this._crashes || new Map();
        for (const [p, j] of this.inflight) {
            const n = this._crashes.get(p) || 0;
            if (this.run && !this.run.finished) { this.run.total--; if (j.kind === 'b') this.run.deepTotal--; else this.run.indexTotal--; }
            if (n >= 1) { this.emb.addFailure(p, j.mtime || 0, 'crash', 'The decoder crashed on this file'); this.failures++; continue; }
            this._crashes.set(p, n + 1);
            again.push({ path: p, mtime: j.mtime, size: j.size, clap: j.clap, spectral: j.spectral, duration: j.duration });
        }
        this.inflight.clear();
        this._enqueue(again, 'hi');
    }

    _stopWorker() {
        clearTimeout(this._idleTimer);
        const w = this.worker;
        if (!w) return;
        this._stopping = true;
        this.worker = null; this._workerReady = null; this._busy = false;
        w.terminate().catch(() => {}).finally(() => { this._stopping = false; });
    }

    /** Results from the worker: one transaction per batch, then memory + HNSW. */
    _onItems(items) {
        if (!this.db) return;
        const writes = [], fingerprints = [];
        for (const it of items) {
            const job = this.inflight.get(it.path);
            if (!job || job.token !== it.token) continue;              // superseded / removed meanwhile
            this.inflight.delete(it.path);
            if (this.run) { this.run.done++; if (it.kind === 'b') this.run.deepDone++; else this.run.indexDone++; }
            if (it.error) {
                this.emb.addFailure(it.path, it.mtime, it.kind === 'b' ? 'deep' : 'decode', it.error);
                this.failures++;
                if (this.run) this.run.failed++;
                continue;
            }
            const durationMs = it.duration != null ? Math.round(it.duration * 1000) : null;
            if (it.vector) writes.push({ path: it.path, mtime: it.mtime, size: it.size ?? null, vector: it.vector, quality: it.quality, durationMs });
            else if (it.quality) writes.push({ path: it.path, mtime: it.mtime, quality: it.quality, durationMs });
            if (it.spectral && this.echo) fingerprints.push(it);
        }
        if (writes.length) {
            const tw = Date.now();
            const { rows } = this.emb.writeBatch(writes);
            if (Date.now() - tw > 500) console.warn(`[Engine] slow DB write: ${Date.now() - tw} ms for ${writes.length} rows (WAL checkpoint on a slow disk?)`);
            // Memory mirrors the DB row exactly (the catalog diff reads it).
            for (const r of rows) {
                if (!this._under(r.path)) continue;
                const prev = this.store.metaOf(r.path);
                this.store.upsert(r.id, r.path, r.vector, { mtime: r.mtime, quality: r.quality, durationMs: r.durationMs, size: r.size ?? (prev ? prev.size : null) });
            }
            for (const w of writes) {
                if (w.vector) continue;
                const m = this.store.metaOf(w.path);                        // quality-only update (same mtime)
                if (m && m.mtime === w.mtime) { m.quality = w.quality; if (w.durationMs != null) m.durationMs = w.durationMs; }
            }
            // Long files got a first-10-s vector: their deep pass follows automatically.
            const deep = writes.filter(w => w.vector && w.quality === 1).map(w => ({ path: w.path, mtime: w.mtime, size: w.size, duration: w.durationMs != null ? w.durationMs / 1000 : null }));
            if (deep.length) this._enqueue(deep, 'b');
        }
        if (fingerprints.length) this.echo.write(fingerprints);
        if (writes.length || fingerprints.length) this._scheduleSave();
        this._emit();
    }

    // ── incremental changes (watcher, imports, deletes, moves) ─────────
    filesChanged({ added = [], removed = [] } = {}) {
        const pc = this._pendingChanges;
        for (const a of added) { const p = a && (a.path || a); if (typeof p === 'string') { pc.added.set(p, typeof a === 'object' ? a : { path: p }); pc.removed.delete(p); } }
        for (const p of removed) { if (typeof p === 'string') { pc.removed.add(p); pc.added.delete(p); } }
        clearTimeout(this._changeTimer);
        this._changeTimer = setTimeout(() => this._flushChanges(), CHANGE_DEBOUNCE_MS);
    }

    _flushChanges() {
        if (!this.db) return;
        const pc = this._pendingChanges;
        if (!pc.added.size && !pc.removed.size) return;
        const added = [...pc.added.values()].filter(a => this._under(a.path));
        const removed = [...pc.removed].filter(p => this._under(p));
        pc.added.clear(); pc.removed.clear();
        // An Explorer move/rename arrives as delete + create: match by (size, mtime)
        // so the vector and fingerprint follow the file instead of re-analysing it.
        const renames = [], gone = [];
        if (removed.length && added.length) {
            const bySig = new Map();
            for (const a of added) if (a.size && a.mtime) { const k = a.size + ':' + a.mtime; bySig.set(k, bySig.has(k) ? null : a); }
            const used = new Set();
            for (const p of removed) {
                const row = this.emb.byPath(p);
                const k = row && row.size && row.mtime ? row.size + ':' + row.mtime : null;
                const a = k ? bySig.get(k) : null;
                if (a && !used.has(a.path)) { used.add(a.path); renames.push({ from: p, to: a.path }); }
                else gone.push(p);
            }
            for (let i = added.length - 1; i >= 0; i--) if (used.has(added[i].path)) added.splice(i, 1);
        } else gone.push(...removed);
        if (renames.length) this._renamePaths(renames);
        if (gone.length) this._removePaths(gone);
        const jobs = [];
        for (const a of added) {
            const row = this.emb.byPath(a.path);
            if (row && a.mtime && row.mtime === a.mtime) continue;       // benign touch (antivirus, indexer)
            jobs.push({ path: a.path, mtime: a.mtime || 0, size: a.size, clap: true, spectral: !!this.echo });
        }
        this._enqueue(jobs, 'hi');
        this._emit();
    }

    /** Moves/renames done by the app itself (file ops): keep vectors, just re-key. */
    pathsMoved(moves = []) {
        const list = (moves || []).filter(m => m && !m.dir && typeof m.from === 'string' && typeof m.to === 'string' && m.from !== m.to);
        if (!list.length) return;
        // Cancel the delete+add pair the same operation queued through filesChanged.
        const pc = this._pendingChanges;
        for (const m of list) { pc.removed.delete(m.from); pc.added.delete(m.to); }
        if (this.db) this._renamePaths(list);
        else (this._earlyMoves = this._earlyMoves || []).push(...list);
    }

    _renamePaths(moves) {
        for (const m of moves) if (keyOf(m.from) !== keyOf(m.to)) this.store.remove(m.to);   // a stale row at the destination loses
        const done = this.emb.renamePaths(moves);
        for (const m of done) {
            if (this._under(m.to)) {
                if (this.store.rename(m.from, m.to) && m.mtime != null) this.store.metaOf(m.to).mtime = m.mtime;
            } else this.store.remove(m.from);
            const j = this.queued.get(m.from);
            if (j) { this.queued.delete(m.from); j.dropped = true; this._enqueue([{ ...j, path: m.to, dropped: false }], j.lane); }
            if (this.inflight.has(m.from)) this.inflight.delete(m.from);       // re-analysed later if needed
        }
        if (this.echo) this.echo.rename(moves);
        if (done.length) this._scheduleSave();
    }

    _removePaths(paths) {
        this.emb.deletePaths(paths);
        for (const p of paths) {
            this.store.remove(p);
            const j = this.queued.get(p);
            if (j) { j.dropped = true; this.queued.delete(p); }
            this.inflight.delete(p);
        }
        if (this.echo) this.echo.remove(paths);
        this._scheduleSave();
    }

    failuresList() { return this.emb ? this.emb.failures() : []; }
}

module.exports = { SemanticEngine, cutoffFor, keyOf };
