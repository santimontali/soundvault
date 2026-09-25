'use strict';
/**
 * EchoIndex: "find sounds that contain / resemble this sound".
 *
 *   storage   echo_summary  small per-file row (loads in < 1 s for 70k files):
 *                           audible-window sums (exact global stats), loudest
 *                           window, span, content hash
 *             echo_features raw 44-D windows as float16 (the only big blob)
 *   coarse    z-space mean ∪ z-space attack vector, 250 each (Echo audit §C3-4;
 *             CLAP adds nothing for fragments and costs 0.4 s)
 *   fine      exact sliding cosine on the host thread, in slices, with a
 *             prepared-candidate cache
 *   score     calibrated against chance for the query length (0 = no better
 *             than the best wrong match usually scores; flagged weak, still
 *             listed), never rank-normalised; exact duplicates collapse
 *   file mode CLAP neighbours join the candidates and a 0.3 CLAP rank blend
 *             orders the result (the one place CLAP helps)
 */
const path = require('path');
const fs = require('fs');
const { Worker } = require('worker_threads');
const core = require('./echo-core');
const { resample } = require('../audio/decode');

const { F } = core;
const SR = 48000, HOP = 1200, FFT = 2048;
const SPAN_MAX_MS = 120000;           // analysed span per file (index-worker SPECTRAL_S)
const K = 250;
const CACHE_BYTES = 256 * 1024 * 1024;   // prepared candidates kept between queries
const CACHE_IDLE_MS = 5 * 60000;          // …and released after five idle minutes

const SCHEMA = `
    CREATE TABLE IF NOT EXISTS echo_summary (
        file_path TEXT PRIMARY KEY,
        mtime REAL,
        version INTEGER NOT NULL,
        windows INTEGER NOT NULL,
        span_ms INTEGER NOT NULL,
        counted INTEGER NOT NULL,
        hash TEXT,
        sums BLOB NOT NULL,
        attack BLOB NOT NULL
    );
    CREATE TABLE IF NOT EXISTS echo_features (
        file_path TEXT PRIMARY KEY,
        windows INTEGER NOT NULL,
        data BLOB NOT NULL
    );`;

const f64 = b => new Float64Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
const f32 = b => new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
const buf = ta => Buffer.from(ta.buffer, ta.byteOffset, ta.byteLength);

function topK(q, M, n, k, skip) {
    k = Math.min(k, n);
    if (!k) return [];
    const hs = new Float32Array(k), hi = new Int32Array(k);
    let size = 0;
    for (let i = 0; i < n; i++) {
        if (skip && skip.has(i)) continue;
        const o = i * F;
        let s = 0;
        for (let d = 0; d < F; d += 4) s += q[d] * M[o + d] + q[d + 1] * M[o + d + 1] + q[d + 2] * M[o + d + 2] + q[d + 3] * M[o + d + 3];
        if (size < k) {
            let c = size++; hs[c] = s; hi[c] = i;
            while (c > 0) { const p = (c - 1) >> 1; if (hs[p] <= hs[c]) break; [hs[p], hs[c]] = [hs[c], hs[p]]; [hi[p], hi[c]] = [hi[c], hi[p]]; c = p; }
        } else if (s > hs[0]) {
            hs[0] = s; hi[0] = i;
            let p = 0;
            for (;;) {
                const l = 2 * p + 1, r = l + 1; let m = p;
                if (l < size && hs[l] < hs[m]) m = l;
                if (r < size && hs[r] < hs[m]) m = r;
                if (m === p) break;
                [hs[p], hs[m]] = [hs[m], hs[p]]; [hi[p], hi[m]] = [hi[m], hi[p]]; p = m;
            }
        }
    }
    const out = [];
    for (let i = 0; i < size; i++) out.push([hi[i], hs[i]]);
    return out.sort((a, b) => b[1] - a[1]).map(x => x[0]);
}

class EchoIndex {
    constructor({ dbPath, fingerprinter, buildWeights }) {
        this.dbPath = dbPath;
        this.fpr = fingerprinter;
        this.buildWeights = buildWeights;
        this.db = null;
        this.stats = new core.GlobalStats();
        this.snap = null;
        this._ver = 0;
        this._clear();
        this._cache = new Map();          // path → prepared candidate (fine stage)
        this._cacheBytes = 0;
        this._cacheKey = '';
        this._qid = 0;
        this._latest = 0;
        this._idle = null;
        this.migration = null;            // { done, total } while the pre-2.0 table is converted
        this.loading = true;              // until the first load() finishes
    }

    _clear() {
        this.n = 0; this.cap = 0;
        this.paths = []; this.row = new Map();
        this.mtime = []; this.windows = []; this.span = []; this.counted = []; this.hash = []; this.version = [];
        this.sums = new Float64Array(0);      // n × 88 (sum ‖ sumSq)
        this.attack = new Float32Array(0);    // n × 44 raw
        this.meanZ = new Float32Array(0);     // n × 44 unit
        this.atkZ = new Float32Array(0);      // n × 44 unit
    }

    get count() { return this.n; }

    attach(db) {
        this.db = db;
        db.exec(SCHEMA);
        db.pragma('journal_size_limit = 67108864');
        this.s = {
            page: db.prepare('SELECT rowid AS rid, file_path AS path, mtime, version, windows, span_ms AS span, counted, hash, sums, attack FROM echo_summary WHERE rowid > ? ORDER BY rowid LIMIT ?'),
            upSum: db.prepare(`INSERT INTO echo_summary (file_path, mtime, version, windows, span_ms, counted, hash, sums, attack)
                               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                               ON CONFLICT(file_path) DO UPDATE SET mtime = excluded.mtime, version = excluded.version, windows = excluded.windows,
                                   span_ms = excluded.span_ms, counted = excluded.counted, hash = excluded.hash, sums = excluded.sums, attack = excluded.attack`),
            upFeat: db.prepare(`INSERT INTO echo_features (file_path, windows, data) VALUES (?, ?, ?)
                                ON CONFLICT(file_path) DO UPDATE SET windows = excluded.windows, data = excluded.data`),
            features: db.prepare('SELECT windows, data FROM echo_features WHERE file_path = ?'),
            delSum: db.prepare('DELETE FROM echo_summary WHERE file_path = ?'),
            delFeat: db.prepare('DELETE FROM echo_features WHERE file_path = ?'),
            renSum: db.prepare('UPDATE OR REPLACE echo_summary SET file_path = ?, mtime = COALESCE(?, mtime) WHERE file_path = ?'),
            renFeat: db.prepare('UPDATE OR REPLACE echo_features SET file_path = ? WHERE file_path = ?'),
        };
        this.legacyTable = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'spectral_index'").get();
        if (this.legacyTable) this.s.delLegacy = db.prepare('DELETE FROM spectral_index WHERE file_path = ?');
    }

    // ── memory ──────────────────────────────────────────────────────────
    _ensure(n) {
        if (n <= this.cap) return;
        const cap = Math.max(n, Math.ceil(this.cap * 1.5), 1024);
        const grow = (arr, per) => { const a = new arr.constructor(cap * per); a.set(arr.subarray(0, this.n * per)); return a; };
        this.sums = grow(this.sums, 2 * F); this.attack = grow(this.attack, F);
        this.meanZ = grow(this.meanZ, F); this.atkZ = grow(this.atkZ, F);
        this.cap = cap;
    }

    _summaryOf(i) {
        return { sum: this.sums.subarray(i * 2 * F, i * 2 * F + F), sumSq: this.sums.subarray(i * 2 * F + F, (i + 1) * 2 * F), counted: this.counted[i] };
    }

    _vectors(i) {
        const st = this.snap;
        if (!st) return;
        const s = this._summaryOf(i);
        core.meanVector(s.sum, s.counted, st, this.meanZ, i * F);
        core.zUnitInto(this.atkZ, i * F, this.attack, i * F, st, null);
    }

    _put(p, r) {
        let i = this.row.get(p);
        if (i === undefined) {
            this._ensure(this.n + 1);
            i = this.n++;
            this.paths[i] = p; this.row.set(p, i);
        } else {
            this.stats.remove(this._summaryOf(i));
        }
        this.mtime[i] = r.mtime; this.windows[i] = r.windows; this.span[i] = r.span; this.counted[i] = r.counted;
        this.hash[i] = r.hash || null; this.version[i] = r.version;
        this.sums.set(r.sum, i * 2 * F); this.sums.set(r.sumSq, i * 2 * F + F);
        this.attack.set(r.attack, i * F);
        this.stats.add(this._summaryOf(i));
        this._vectors(i);
        return i;
    }

    _drop(p) {
        const i = this.row.get(p);
        if (i === undefined) return;
        this.stats.remove(this._summaryOf(i));
        const last = this.n - 1;
        if (i !== last) {
            const lp = this.paths[last];
            this.paths[i] = lp; this.row.set(lp, i);
            for (const a of [this.mtime, this.windows, this.span, this.counted, this.hash, this.version]) a[i] = a[last];
            this.sums.copyWithin(i * 2 * F, last * 2 * F, (last + 1) * 2 * F);
            for (const m of [this.attack, this.meanZ, this.atkZ]) m.copyWithin(i * F, last * F, (last + 1) * F);
        }
        this.row.delete(p);
        for (const a of [this.paths, this.mtime, this.windows, this.span, this.counted, this.hash, this.version]) a.length = last;
        this.n = last;
    }

    /** New statistics snapshot when the library drifted (query + candidates must share one). */
    _maybeResnapshot(force = false) {
        const files = this.stats.files;
        // Small or young libraries (first catalog) re-snapshot often, a snapshot
        // taken over a handful of files is not a usable normalisation; large ones
        // every 1% of change (~10 ms for 70k files).
        const need = this.snap && this.snap.files >= 20 ? Math.max(20, Math.round(this.snap.files * 0.01)) : 1;
        if (!force && this.snap && Math.abs(files - this.snap.files) < need) return;
        this.snap = this.stats.snapshot(++this._ver);
        for (let i = 0; i < this.n; i++) this._vectors(i);
    }

    /**
     * Load this library's summaries (filter = path → inside the current
     * library) in pages, yielding between them so the host keeps answering.
     * Writes, renames and removals that land meanwhile stay consistent: an
     * UPSERT keeps its rowid and a new row gets a higher one, so every row is
     * read either before or after its change, never lost. A newer load
     * supersedes this one. Resolves false when superseded.
     */
    async load(filter) {
        const t0 = Date.now();
        const gen = this._loadGen = (this._loadGen || 0) + 1;
        this.loading = true;
        this._clear();
        this.stats = new core.GlobalStats();
        this.snap = null;
        try {
            let last = 0;
            for (;;) {
                const rows = this.s.page.all(last, 4000);
                if (!rows.length) break;
                for (const r of rows) {
                    if (!filter(r.path) || r.version !== core.FEATURE_VERSION) continue;
                    const sums = f64(r.sums);
                    this._put(r.path, { mtime: r.mtime, windows: r.windows, span: r.span, counted: r.counted, hash: r.hash, version: r.version, sum: sums.subarray(0, F), sumSq: sums.subarray(F), attack: f32(r.attack) });
                }
                last = rows[rows.length - 1].rid;
                await new Promise(r => setImmediate(r));
                if (gen !== this._loadGen) return false;
            }
            this._maybeResnapshot(true);
        } finally {
            if (gen === this._loadGen) this.loading = false;
        }
        console.log(`[Echo] ${this.n} fingerprints loaded in ${Date.now() - t0} ms`);
        this.releaseMemory();
        return true;
    }

    /** No library: forget everything (and supersede a load in progress). */
    unload() {
        this._loadGen = (this._loadGen || 0) + 1;
        this._clear();
        this.stats = new core.GlobalStats();
        this.snap = null;
        this.loading = false;
        this.releaseMemory();
    }

    /** Does this file need (re-)fingerprinting? */
    needs(p, mtime, durationMs) {
        const i = this.row.get(p);
        if (i === undefined) return true;
        if (this.mtime[i] !== mtime || this.version[i] !== core.FEATURE_VERSION) return true;
        // Files fingerprinted by the 30 s pre-2.0 indexer get their full span.
        const want = Math.min(durationMs || 0, SPAN_MAX_MS);
        return want - this.span[i] > 1500;
    }

    /** Index-worker results: [{ path, mtime, spectral: {...} }]. One transaction. */
    write(items) {
        const rows = [];
        const tx = this.db.transaction(list => {
            for (const it of list) {
                const s = it.spectral;
                const sums = new Float64Array(2 * F); sums.set(s.sum); sums.set(s.sumSq, F);
                this.s.upSum.run(it.path, it.mtime, core.FEATURE_VERSION, s.windows, s.spanMs, s.counted, s.hash || null, buf(sums), buf(s.attack));
                this.s.upFeat.run(it.path, s.windows, buf(s.data));
                if (this.s.delLegacy) this.s.delLegacy.run(it.path);    // the migration must not overwrite it
                rows.push(it);
            }
        });
        tx(items);
        for (const it of rows) {
            const s = it.spectral;
            this._put(it.path, { mtime: it.mtime, windows: s.windows, span: s.spanMs, counted: s.counted, hash: s.hash, version: core.FEATURE_VERSION, sum: s.sum, sumSq: s.sumSq, attack: s.attack });
        }
        this._maybeResnapshot();
        this._forgetCached(rows.map(r => r.path));
    }

    rename(moves) {
        const tx = this.db.transaction(ms => { for (const m of ms) { this.s.renSum.run(m.to, m.mtime ?? null, m.from); this.s.renFeat.run(m.to, m.from); } });
        tx(moves);
        for (const m of moves) {
            const i = this.row.get(m.from);
            if (i === undefined) continue;
            if (this.row.has(m.to) && m.to !== m.from) this._drop(m.to);
            const j = this.row.get(m.from);
            this.row.delete(m.from); this.paths[j] = m.to; this.row.set(m.to, j);
            if (m.mtime != null) this.mtime[j] = m.mtime;
        }
        this._forgetCached(moves.map(m => m.from));
    }

    remove(paths) {
        const tx = this.db.transaction(ps => { for (const p of ps) { this.s.delSum.run(p); this.s.delFeat.run(p); } });
        tx(paths);
        for (const p of paths) this._drop(p);
        this._forgetCached(paths);
    }

    /** Convert the pre-2.0 table in a worker; `onDone` reloads the summaries. */
    startMigration(onDone) {
        if (!this.legacyTable || this._migrator) return false;
        this.migration = { done: 0, total: 0 };
        const w = new Worker(path.join(__dirname, 'echo-migrate.js'), { workerData: { dbPath: this.dbPath } });
        this._migrator = w;
        let finished = false;
        const finish = (res) => {
            if (finished) return;
            finished = true;
            this._migrator = null;
            this.migration = null;
            if (res && !res.error) { this.legacyTable = false; this.s.delLegacy = null; }
            console.log('[Echo] migration', res && res.error ? 'failed: ' + res.error : `done: ${res.converted} converted, ${res.dropped} dropped (per-file normalised), ${res.failed} unreadable in ${(res.ms / 1000).toFixed(1)} s`);
            onDone && onDone(res || { error: 'stopped' });
        };
        w.on('message', m => {
            if (m.type === 'progress') this.migration = { done: m.done, total: m.total };
            else if (m.type === 'done') finish(m);
            else if (m.type === 'error') finish(m);
        });
        w.on('error', e => finish({ error: e.message }));
        w.on('exit', code => { if (code !== 0) finish({ error: 'exit ' + code }); });
        return true;
    }

    stopMigration() { if (this._migrator) { this._migrator.terminate().catch(() => {}); this._migrator = null; } }

    // ── fine stage ──────────────────────────────────────────────────────
    // Runs on the engine host's own thread in ~8 ms slices (searches interleave).
    // It used to be a worker thread, but Electron's worker threads allocate
    // ArrayBuffers through the kernel: reading and preparing ~400 candidates
    // took 5× longer there (156 vs 31 ms cold) plus ~0.2 s to start the worker.

    /** A candidate's raw windows in the query's z-space; cached per (snapshot, weights). */
    _prepared(p, st, fw) {
        let c = this._cache.get(p);
        if (c) { this._cache.delete(p); this._cache.set(p, c); return c; }
        const row = this.s.features.get(p);
        if (!row || !row.windows) return null;
        c = core.prepare(core.decodeHalf(row.data), row.windows, st, fw);
        c.bytes = c.U.byteLength + c.W + 64;
        this._cache.set(p, c);
        this._cacheBytes += c.bytes;
        while (this._cacheBytes > CACHE_BYTES && this._cache.size > 1) {
            const k = this._cache.keys().next().value;
            this._cacheBytes -= this._cache.get(k).bytes;
            this._cache.delete(k);
        }
        return c;
    }

    /** Frees the prepared-candidate cache (idle, shutdown). */
    releaseMemory() {
        clearTimeout(this._idle);
        this._cache.clear(); this._cacheBytes = 0; this._cacheKey = '';
    }

    _forgetCached(paths) {
        if (!paths) return;
        for (const p of paths) { const c = this._cache.get(p); if (c) { this._cacheBytes -= c.bytes; this._cache.delete(p); } }
    }

    /**
     * Exact sliding match of the query against `cands`, best-first pruning: once
     * `keep` are scored, a candidate that cannot beat the keep-th best stops
     * early (identical top results, far less work). A newer query supersedes it.
     */
    async _match({ query: q, cands, weights: fw, mode, keep }) {
        const id = ++this._qid;
        this._latest = id;
        const t0 = Date.now();
        const st = this.snap;                            // one snapshot for the whole query
        const key = st.version + '|' + Array.prototype.join.call(fw, ',');
        if (key !== this._cacheKey) { this._cache.clear(); this._cacheBytes = 0; this._cacheKey = key; }
        clearTimeout(this._idle);
        this._idle = setTimeout(() => this.releaseMemory(), CACHE_IDLE_MS);
        keep = Math.max(1, keep || 80);
        const heap = [];                                 // min-heap of the best `keep` scores
        const push = v => {
            if (heap.length < keep) { heap.push(v); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p] <= heap[i]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } }
            else if (v > heap[0]) { heap[0] = v; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l] < heap[m]) m = l; if (r < heap.length && heap[r] < heap[m]) m = r; if (m === i) break; [heap[i], heap[m]] = [heap[m], heap[i]]; i = m; } }
        };
        const out = [];
        let slice = Date.now();
        for (let i = 0; i < cands.length; i++) {
            if (Date.now() - slice > 8) {
                await new Promise(r => setImmediate(r));
                if (id !== this._latest || !this.db) return { cancelled: true, results: [] };
                slice = Date.now();
            }
            const c = this._prepared(cands[i], st, fw);
            if (!c) continue;
            const floor = heap.length >= keep ? heap[0] : -Infinity;
            const m = core.match(q, c, { coverage: mode !== 'file', floor });
            if (m.score <= floor) continue;
            push(m.score);
            out.push({ path: cands[i], score: m.score, off: m.off, len: m.len, cW: c.W, swapped: m.swapped });
        }
        return { results: out, ms: Date.now() - t0 };
    }

    // ── queries ─────────────────────────────────────────────────────────
    _status() {
        if (this.migration) return { error: 'upgrading', progress: this.migration };
        if (this.loading) return { error: 'loading' };
        if (!this.n) return { error: 'empty' };
        return null;
    }

    /**
     * Echo a selection.
     * @param {object} o
     * @param {Float32Array} o.pcm       mono audio: [pre context][selection][post context]
     * @param {number} o.sampleRate
     * @param {number} [o.pre]           context samples before the selection
     * @param {number} [o.post]          context samples after it
     * @param {object} [o.weights]       axis weights
     * @param {string[]} [o.exclude]     paths never returned (the source file)
     * @param {number} [o.maxResults]
     */
    async query(o) {
        const busy = this._status();
        if (busy) return { results: [], ...busy };
        const t0 = Date.now();
        let pcm = o.pcm, pre = Math.max(0, o.pre | 0), post = Math.max(0, o.post | 0);
        if (o.sampleRate && o.sampleRate !== SR) {
            const k = SR / o.sampleRate;
            pcm = resample(pcm, o.sampleRate, SR);
            pre = Math.round(pre * k); post = Math.round(post * k);
        }
        const selLen = Math.max(0, pcm.length - pre - post);
        if (selLen < 48) return { results: [], error: 'too-short' };
        const queryMs = selLen / SR * 1000;
        // Δ/ΔΔ need neighbours: features are computed with up to ±50 ms of the
        // real surrounding audio and trimmed back to the selection (audit §C5).
        const { matrix, numWindows } = this.fpr.extractRaw(pcm, SR);
        const Wsel = Math.max(1, Math.floor((selLen - FFT) / HOP) + 1);
        const skip = Math.min(Math.round(pre / HOP), Math.max(0, numWindows - Wsel));
        const W = Math.min(Wsel, numWindows - skip);
        const raw = matrix.slice(skip * F, (skip + W) * F);
        const sum = core.fileSummary(raw, W);
        if (!sum.loud) return { results: [], error: 'silent', queryMs };
        const st = this.snap;
        const qMean = core.meanVector(sum.sum, sum.counted, st);
        const qAtk = new Float32Array(F); core.zUnitInto(qAtk, 0, sum.attack, 0, st, null);
        const skipRows = new Set((o.exclude || []).map(p => this.row.get(p)).filter(i => i !== undefined));
        const cands = new Set();
        // Selections of 2.5 s+ make the coarse stage near-certain (validated: 100% R@10
        // with 150 per list on the real library): fewer candidates, same results.
        const k = queryMs >= 2500 ? 150 : K;
        for (const i of topK(qMean, this.meanZ, this.n, k, skipRows)) cands.add(this.paths[i]);
        for (const i of topK(qAtk, this.atkZ, this.n, k, skipRows)) cands.add(this.paths[i]);
        const fw = this.buildWeights(o.weights || {});
        const q = core.prepare(raw, W, st, fw);
        const tCoarse = Date.now();
        const keep = (o.maxResults || 50) + 30;           // margin for collapsed duplicates
        // Most promising candidates first so the pruning floor rises early.
        const res = await this._match({ query: q, cands: [...cands], weights: fw, mode: 'fragment', keep });
        if (res.cancelled) return { results: [], cancelled: true };
        if (res.error) return { results: [], error: res.error };
        const out = [];
        for (const r of res.results) {
            // Below-chance matches are kept (flagged weak): the calibration is a
            // population statistic and dropping at 0 % hid ~25 % of true sources.
            const conf = core.confidence(r.score, queryMs);
            const i = this.row.get(r.path);
            const spanMs = i !== undefined ? this.span[i] : 0;
            const offsetMs = r.swapped ? 0 : r.off * core.HOP_MS;
            out.push({
                path: r.path, score: conf, similarity: r.score, weak: conf <= 0,
                identical: r.score >= core.IDENTICAL,
                offsetMs,
                durationMs: Math.max(1, Math.round(r.swapped ? spanMs : Math.min(queryMs, spanMs - offsetMs))),
                hash: i !== undefined ? this.hash[i] : null,
            });
        }
        out.sort((a, b) => b.similarity - a.similarity);
        const results = collapse(out).slice(0, o.maxResults || 50);
        return {
            results, queryMs: Math.round(queryMs), candidates: cands.size,
            searchTimeMs: Date.now() - t0, coarseMs: tCoarse - t0, matchMs: res.ms,
            shortQuery: queryMs < 100,
            // Files longer than the analysed span can hide matches past it.
            span: SPAN_MAX_MS,
        };
    }

    /**
     * "More like this file". clap: { neighbours(path, k) → [{path, score}] } over
     * unit CLAP vectors. Ranked by CLAP alone: on the real library's
     * near-duplicate set it finds a numbered sibling in the top 10 for 88% of
     * files, against 58% for a fingerprint blend (the 0.3 blend the Echo audit
     * measured before CLAP vectors were normalised) and 60% for fingerprints
     * alone. Fingerprints still group exact duplicates and flag identical audio.
     */
    async similarToFile(p, o = {}, clap = null) {
        const t0 = Date.now();
        if (!clap) return { results: [], error: 'not-indexed' };
        const max = o.maxResults || 50;
        const list = clap.neighbours(p, max * 3).filter(c => c.path !== p);
        if (!list.length) return { results: [], error: 'not-indexed' };
        const i = this.row.get(p);
        const srcHash = i !== undefined ? this.hash[i] : null;
        const rows = list.map(c => {
            const j = this.row.get(c.path);
            const hash = j !== undefined ? this.hash[j] : null;
            return {
                path: c.path, similarity: c.score, score: fileConfidence(c.score),
                identical: !!(srcHash && hash === srcHash) || c.score >= 0.9995,
                offsetMs: 0, durationMs: 0, hash,
            };
        });
        rows.sort((x, y) => (y.identical - x.identical) || (y.similarity - x.similarity));
        for (const r of rows) r.weak = !r.identical && r.score <= 0;
        return { results: collapse(rows).slice(0, max), candidates: list.length, searchTimeMs: Date.now() - t0, fileMode: true };
    }
}

/**
 * CLAP audio↔audio cosine → 0..1 display confidence. Measured on the real
 * library: numbered siblings p10/p50/p90 = 0.84/0.92/0.96, other top-20
 * neighbours 0.71/0.84/0.92. 0.80 ≈ "no better than an unrelated neighbour".
 */
function fileConfidence(cos) { return Math.max(0, Math.min(1, (cos - 0.80) / 0.20)); }

/** Exact duplicates (same fingerprint hash) are listed once, with their copies attached. */
function collapse(rows) {
    const seen = new Map(), out = [];
    for (const r of rows) {
        if (r.hash && seen.has(r.hash)) { seen.get(r.hash).copies.push(r.path); continue; }
        const row = { ...r, copies: [] };
        delete row.hash;
        if (r.hash) seen.set(r.hash, row);
        out.push(row);
    }
    return out;
}

module.exports = { EchoIndex, SCHEMA, SPAN_MAX_MS, topK };
