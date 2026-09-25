'use strict';
/**
 * In-memory index of every audio file under the library root, persisted to
 * disk so large libraries open instantly.
 *
 * Why: on a real 70k-file library on a spinning disk, a directory walk takes
 * ~30 s and stat()ing every file several minutes. So:
 *   • startup loads the persisted index (instant) and marks the library ready;
 *   • a background reconcile re-reads ONLY directories whose mtime changed
 *     (NTFS/APFS/ext4 bump a directory's mtime when entries are added,
 *     removed or renamed in it) and stats only new files;
 *   • the first run walks without stat()ing files (fast), shows the library,
 *     then fills sizes/dates in the background;
 *   • "Rescan" forces a full walk.
 * Incremental add/remove/removeDir keep the index exact between scans, the
 * folder tree and listings are cached, and 'changed' events drive live UI.
 */
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const P = require('./paths');

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const FORMAT_VERSION = 1;
const tick = () => new Promise(r => setImmediate(r));

class LibraryIndex extends EventEmitter {
    constructor({ tokenizeEntry, cacheFile = null }) {
        super();
        this.tokenizeEntry = tokenizeEntry;
        this.cacheFile = cacheFile;
        this.root = null;
        this.entries = new Map();        // key(path) -> entry
        this.dirs = new Map();           // rel dir -> { m: mtimeMs, sub: string[] }
        this.ready = false;
        this.rootExists = false;         // probed asynchronously (network roots can hang for seconds)
        this.scanning = null;            // Promise of a blocking (first) scan
        this.background = null;          // Promise of a background reconcile/stat fill
        this.scanStats = null;
        this.progress = null;            // { phase, dirs, files } while scanning
        this._treeCache = null;
        this._listCache = new Map();
        this._arrayCache = null;
        this._generation = 0;
        this._saveTimer = null;
        this._epoch = 0;                 // bumps when the root changes (cancels old work)
        // Bumps on every change the app is told about (listeners run in order, so
        // this is current before anyone else reacts): "has anything changed since…".
        this.version = 0;
        this.on('changed', () => { this.version++; });
        this.on('stats-filled', () => { this.version++; });
    }

    // ── entries ─────────────────────────────────────────────────────────
    _makeEntry(absPath, st) {
        const relFile = P.toRel(this.root, absPath);
        const slash = relFile.lastIndexOf('/');
        const dir = slash === -1 ? '' : relFile.slice(0, slash);
        const e = {
            path: absPath,
            name: relFile.slice(slash + 1),
            dir,                               // library-relative directory ('' = root)
            topLevel: dir ? dir.split('/')[0] : '',
            size: st ? st.size : 0,
            mtime: st ? st.mtimeMs : 0,
        };
        e.folder = dir;                        // field name used by the lexical search module
        e._tokens = this.tokenizeEntry(e);
        return e;
    }

    _invalidate() {
        this._generation++;
        this._treeCache = null;
        this._listCache.clear();
        this._arrayCache = null;
        this._scheduleSave();
    }

    /** Public, IPC-safe projection of an entry (no token arrays). */
    static public(e) {
        return e ? { path: e.path, name: e.name, dir: e.dir, size: e.size, mtime: e.mtime } : null;
    }

    get size() { return this.entries.size; }
    get(absPath) { return this.entries.get(P.key(absPath)) || null; }
    has(absPath) { return this.entries.has(P.key(absPath)); }
    all() {
        if (!this._arrayCache) this._arrayCache = [...this.entries.values()];
        return this._arrayCache;
    }

    // ── persistence ─────────────────────────────────────────────────────
    _scheduleSave() {
        if (!this.cacheFile || !this.ready) return;
        clearTimeout(this._saveTimer);
        this._saveTimer = setTimeout(() => this.save(), 4000);
    }

    save() {
        clearTimeout(this._saveTimer);
        if (!this.cacheFile || !this.root || !this.ready) return;
        const dirs = {};
        for (const [rel, d] of this.dirs) dirs[rel] = { m: d.m, d: d.sub, f: [] };
        for (const e of this.entries.values()) {
            (dirs[e.dir] || (dirs[e.dir] = { m: 0, d: [], f: [] })).f.push([e.name, e.size, e.mtime]);
        }
        const json = JSON.stringify({ v: FORMAT_VERSION, root: this.root, savedAt: Date.now(), dirs });
        try {
            const tmp = this.cacheFile + '.tmp';
            fs.writeFileSync(tmp, json);
            fs.renameSync(tmp, this.cacheFile);
        } catch (e) { console.warn('[Library] could not persist index:', e.message); }
    }

    async _load() {
        if (!this.cacheFile || !fs.existsSync(this.cacheFile)) return false;
        let data;
        try { data = JSON.parse(await fs.promises.readFile(this.cacheFile, 'utf8')); } catch (e) { return false; }
        if (!data || data.v !== FORMAT_VERSION || P.key(data.root || '') !== P.key(this.root) || !data.dirs) return false;
        const entries = new Map(), dirs = new Map();
        let n = 0;
        for (const [rel, d] of Object.entries(data.dirs)) {
            dirs.set(rel, { m: d.m || 0, sub: Array.isArray(d.d) ? d.d : [] });
            const base = rel ? path.join(this.root, ...rel.split('/')) : this.root;
            for (const [name, size, mtime] of d.f || []) {
                const e = this._makeEntry(path.join(base, name), { size, mtimeMs: mtime });
                entries.set(P.key(e.path), e);
                if (++n % 4000 === 0) await tick();
            }
        }
        this.entries = entries;
        this.dirs = dirs;
        return true;
    }

    // ── lifecycle ───────────────────────────────────────────────────────
    /**
     * Open a library root. Resolves when the index is usable: immediately after
     * loading the persisted index, or after a stat-free first walk.
     */
    /** Is the root a reachable directory? Async and time-boxed: never blocks the main thread. */
    static probe(root, ms = 4000) {
        return Promise.race([
            fs.promises.stat(root).then(st => st.isDirectory(), () => false),
            new Promise(r => setTimeout(() => r(false), ms)),
        ]);
    }

    async setRoot(root) {
        const epoch = ++this._epoch;
        this.root = root ? path.resolve(root) : null;
        this.entries = new Map(); this.dirs = new Map();
        this.ready = false; this._invalidate();
        this.rootExists = this.root ? await LibraryIndex.probe(this.root) : false;
        if (epoch !== this._epoch) return this.scanStats;
        if (!this.rootExists) {
            this.ready = true; this._invalidate();
            this.scanStats = { files: 0, dirs: 0, ms: 0, missingRoot: !!this.root };
            this.emit('changed', { reset: true });
            return this.scanStats;
        }
        const t0 = Date.now();
        const loaded = await this._load();
        if (epoch !== this._epoch) return this.scanStats;
        if (loaded) {
            this.ready = true; this._invalidate();
            this.scanStats = { files: this.entries.size, dirs: this.dirs.size, ms: Date.now() - t0, fromCache: true };
            this.emit('changed', { reset: true });
            this.background = this.reconcile().catch(e => console.warn('[Library] reconcile failed:', e.message)).finally(() => { this.background = null; });
            return this.scanStats;
        }
        const run = this._walk({ statFiles: false, epoch }).finally(() => { if (this.scanning === run) this.scanning = null; });
        this.scanning = run;
        const stats = await run;
        if (epoch === this._epoch) this.background = this._fillStats(epoch).finally(() => { this.background = null; });
        return stats;
    }

    /** Full walk (Rescan). statFiles=true refreshes every size/mtime. */
    rescan() {
        const epoch = ++this._epoch;
        const run = this._walk({ statFiles: true, epoch }).finally(() => { if (this.scanning === run) this.scanning = null; });
        this.scanning = run;
        return run;
    }

    async _walk({ statFiles, epoch }) {
        const t0 = Date.now();
        const root = this.root;
        const prev = this.entries;
        const next = new Map(), dirs = new Map();
        let nDirs = 0, errors = 0;
        const stack = [''];
        const files = [];
        this.progress = { phase: 'walk', dirs: 0, files: 0 };
        let lastEmit = Date.now();
        while (stack.length) {
            if (epoch !== this._epoch) return this.scanStats;
            const rel = stack.pop();
            const abs = rel ? path.join(root, ...rel.split('/')) : root;
            let list, dst;
            try { [list, dst] = await Promise.all([fs.promises.readdir(abs, { withFileTypes: true }), fs.promises.stat(abs)]); }
            catch (e) { errors++; continue; }
            nDirs++;
            const sub = [];
            for (const d of list) {
                if (d.isDirectory()) { if (!P.isIgnoredDir(d.name)) { sub.push(d.name); stack.push(rel ? rel + '/' + d.name : d.name); } }
                else if ((d.isFile() || d.isSymbolicLink()) && P.isAudioFile(d.name)) files.push(path.join(abs, d.name));
            }
            dirs.set(rel, { m: dst.mtimeMs, sub });
            if (Date.now() - lastEmit > 500) { lastEmit = Date.now(); this.progress = { phase: 'walk', dirs: nDirs, files: files.length }; this.emit('progress', this.progress); }
        }
        for (let i = 0; i < files.length; i++) {
            const f = files[i];
            const old = prev.get(P.key(f));
            let st = null;
            if (statFiles) st = await fs.promises.stat(f).catch(() => null);
            if (statFiles && (!st || !st.isFile())) continue;
            const e = this._makeEntry(f, st || (old ? { size: old.size, mtimeMs: old.mtime } : null));
            next.set(P.key(f), e);
            if (i % 2000 === 1999) {
                await tick();
                if (epoch !== this._epoch) return this.scanStats;
                if (statFiles && Date.now() - lastEmit > 500) { lastEmit = Date.now(); this.progress = { phase: 'stat', dirs: nDirs, files: i }; this.emit('progress', this.progress); }
            }
        }
        if (epoch !== this._epoch) return this.scanStats;
        this.entries = next;
        this.dirs = dirs;
        this.ready = true;
        this.progress = null;
        this._invalidate();
        this.scanStats = { files: next.size, dirs: nDirs, errors, ms: Date.now() - t0, full: statFiles };
        this.emit('changed', { reset: true });
        return this.scanStats;
    }

    /** Background: stat files that have no size/mtime yet (first run). */
    async _fillStats(epoch) {
        const todo = [...this.entries.values()].filter(e => !e.mtime);
        const gone = [];
        let i = 0;
        const worker = async () => {
            while (i < todo.length) {
                if (epoch !== this._epoch) return;
                const e = todo[i++];
                const st = await fs.promises.stat(e.path).catch(err => err);
                if (st instanceof Error) { if (st.code === 'ENOENT') gone.push(e); }
                else { e.size = st.size; e.mtime = st.mtimeMs; }
                if (i % 1000 === 0) { this._listCache.clear(); this._scheduleSave(); }
            }
        };
        await Promise.all(Array.from({ length: 8 }, worker));
        if (epoch !== this._epoch) return;
        // Files deleted between the walk and their stat must not linger as ghosts.
        const removed = gone.filter(e => this.entries.get(P.key(e.path)) === e);
        for (const e of removed) this.entries.delete(P.key(e.path));
        if (removed.length) { this._invalidate(); this.notify([], removed); }
        this._listCache.clear(); this.save(); this.emit('stats-filled');
    }

    /**
     * Incremental sync with the disk: only directories whose mtime changed are
     * re-read; new sub-directories are walked; vanished ones are dropped.
     */
    async reconcile() {
        const epoch = this._epoch;
        const root = this.root;
        const t0 = Date.now();
        const added = [], removed = [];
        const stack = [''];
        let readDirs = 0;
        // dir → entries, built once (avoids O(files × changed dirs))
        const byDir = new Map();
        for (const e of this.entries.values()) { const a = byDir.get(e.dir); if (a) a.push(e); else byDir.set(e.dir, [e]); }
        while (stack.length) {
            if (epoch !== this._epoch) return null;
            const rel = stack.pop();
            const abs = rel ? path.join(root, ...rel.split('/')) : root;
            const known = this.dirs.get(rel);
            const dst = await fs.promises.stat(abs).catch(() => null);
            if (!dst || !dst.isDirectory()) {
                removed.push(...this.removeDir(abs, { quiet: true }));
                this._dropDirMeta(rel);
                continue;
            }
            if (known && Math.abs(known.m - dst.mtimeMs) < 1) {
                for (const s of known.sub) stack.push(rel ? rel + '/' + s : s);
                continue;
            }
            // Changed (or new) directory: diff its direct children.
            readDirs++;
            let list;
            try { list = await fs.promises.readdir(abs, { withFileTypes: true }); } catch (e) { continue; }
            const sub = [], fileNames = new Set();
            for (const d of list) {
                if (d.isDirectory()) { if (!P.isIgnoredDir(d.name)) sub.push(d.name); }
                else if ((d.isFile() || d.isSymbolicLink()) && P.isAudioFile(d.name)) fileNames.add(d.name);
            }
            for (const e of byDir.get(rel) || []) {
                if (!fileNames.has(e.name)) { this.entries.delete(P.key(e.path)); removed.push(e); }
            }
            for (const name of fileNames) {
                const full = path.join(abs, name);
                if (this.entries.has(P.key(full))) continue;
                const st = await fs.promises.stat(full).catch(() => null);
                if (!st || !st.isFile()) continue;
                const e = this._makeEntry(full, st);
                this.entries.set(P.key(full), e);
                added.push(e);
            }
            const oldSub = known ? known.sub : [];
            for (const s of oldSub) if (!sub.includes(s)) { const r = rel ? rel + '/' + s : s; removed.push(...this.removeDir(path.join(abs, s), { quiet: true })); this._dropDirMeta(r); }
            this.dirs.set(rel, { m: dst.mtimeMs, sub });
            for (const s of sub) stack.push(rel ? rel + '/' + s : s);
        }
        if (added.length || removed.length) { this._invalidate(); this.notify(added, removed); }
        else this._scheduleSave();
        this.scanStats = { ...(this.scanStats || {}), reconciledMs: Date.now() - t0, readDirs, added: added.length, removed: removed.length };
        return { added, removed };
    }

    _dropDirMeta(rel) {
        const prefix = rel + '/';
        for (const k of [...this.dirs.keys()]) if (k === rel || k.startsWith(prefix)) this.dirs.delete(k);
    }

    // ── incremental updates ─────────────────────────────────────────────
    /** Add or refresh one file. Returns the entry, or null when not indexable. */
    upsert(absPath, st = null) {
        if (!this.root || !P.isInside(this.root, absPath) || !P.isAudioFile(path.basename(absPath))) return null;
        try { st = st || fs.statSync(absPath); } catch (e) { return null; }
        if (!st.isFile()) return null;
        const k = P.key(absPath);
        const prev = this.entries.get(k);
        if (prev && prev.mtime === st.mtimeMs && prev.size === st.size && prev.path === absPath) return prev;
        const e = this._makeEntry(absPath, st);
        this.entries.set(k, e);
        this._ensureDirChain(e.dir);
        this._invalidate();
        return e;
    }

    /** Register a directory chain so reconcile() walks into it next time. */
    _ensureDirChain(rel) {
        if (!rel) { if (!this.dirs.has('')) this.dirs.set('', { m: 0, sub: [] }); return; }
        const parts = rel.split('/');
        let parent = '';
        for (let i = 0; i < parts.length; i++) {
            const cur = parts.slice(0, i + 1).join('/');
            const p = this.dirs.get(parent) || { m: 0, sub: [] };
            if (!p.sub.includes(parts[i])) { p.sub = [...p.sub, parts[i]]; p.m = 0; }
            this.dirs.set(parent, p);
            if (!this.dirs.has(cur)) this.dirs.set(cur, { m: 0, sub: [] });
            parent = cur;
        }
    }

    remove(absPath) {
        const k = P.key(absPath);
        const e = this.entries.get(k);
        if (!e) return null;
        this.entries.delete(k);
        const d = this.dirs.get(e.dir); if (d) d.m = 0;
        this._invalidate();
        return e;
    }

    /** Remove every entry under a directory. Returns removed entries. */
    removeDir(absDir, { quiet = false } = {}) {
        const prefix = P.key(absDir) + path.sep;
        const removed = [];
        for (const [k, e] of this.entries) {
            if (k.startsWith(prefix)) { removed.push(e); this.entries.delete(k); }
        }
        if (removed.length && !quiet) this._invalidate();
        return removed;
    }

    /** Scan a (new) directory and add all audio files beneath it. */
    async addDir(absDir) {
        const added = [];
        const stack = [absDir];
        while (stack.length) {
            const dir = stack.pop();
            let list;
            try { list = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (e) { continue; }
            for (const d of list) {
                const full = path.join(dir, d.name);
                if (d.isDirectory()) { if (!P.isIgnoredDir(d.name)) stack.push(full); }
                else if (P.isAudioFile(d.name)) {
                    const st = await fs.promises.stat(full).catch(() => null);
                    const e = st && this.upsert(full, st);
                    if (e) added.push(e);
                }
            }
        }
        return added;
    }

    /** Notify listeners about a batch of incremental changes. */
    notify(added = [], removed = []) {
        if (!added.length && !removed.length) return;
        this.emit('changed', { added: added.map(e => e.path), removed: removed.map(e => e.path) });
    }

    // ── queries ─────────────────────────────────────────────────────────
    /**
     * Folder tree: [{ name, rel, count, children }], counts are recursive.
     * Children sorted naturally. Cached until the next mutation.
     */
    tree() {
        if (this._treeCache) return this._treeCache;
        const rootNode = { name: '', rel: '', count: 0, direct: 0, children: new Map() };
        for (const e of this.entries.values()) {
            rootNode.count++;
            if (!e.dir) { rootNode.direct++; continue; }
            let node = rootNode;
            let rel = '';
            for (const part of e.dir.split('/')) {
                rel = rel ? rel + '/' + part : part;
                let child = node.children.get(part);
                if (!child) { child = { name: part, rel, count: 0, direct: 0, children: new Map() }; node.children.set(part, child); }
                child.count++;
                node = child;
            }
            node.direct++;
        }
        // Known directories without audio (e.g. a folder just created in the
        // app) still appear, with a count of 0.
        for (const rel of this.dirs.keys()) {
            if (!rel) continue;
            let node = rootNode, acc = '';
            for (const part of rel.split('/')) {
                acc = acc ? acc + '/' + part : part;
                let child = node.children.get(part);
                if (!child) { child = { name: part, rel: acc, count: 0, direct: 0, children: new Map() }; node.children.set(part, child); }
                node = child;
            }
        }
        const finalize = n => ({
            name: n.name, rel: n.rel, count: n.count, direct: n.direct,
            children: [...n.children.values()].sort((a, b) => collator.compare(a.name, b.name)).map(finalize),
        });
        this._treeCache = finalize(rootNode);
        return this._treeCache;
    }

    static _sorter(sort) {
        switch (sort) {
            case 'date': return (a, b) => (b.mtime - a.mtime) || collator.compare(a.name, b.name);
            case 'size': return (a, b) => (b.size - a.size) || collator.compare(a.name, b.name);
            case 'path': return (a, b) => collator.compare(a.dir, b.dir) || collator.compare(a.name, b.name);
            case 'name':
            default: return (a, b) => collator.compare(a.name, b.name) || collator.compare(a.dir, b.dir);
        }
    }

    /**
     * Files in a folder. `folder` is library-relative ('' = whole library).
     * recursive=true includes all descendants (the classic flattened view).
     */
    list({ folder = '', recursive = true, sort = 'name' } = {}) {
        const f = String(folder || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
        const cacheKey = `${f}\u0000${recursive ? 1 : 0}\u0000${sort}`;
        const hit = this._listCache.get(cacheKey);
        if (hit) return hit;
        const lf = f.toLowerCase();
        const prefix = lf ? lf + '/' : '';
        const out = [];
        for (const e of this.entries.values()) {
            const d = e.dir.toLowerCase();
            if (!lf) { if (recursive || d === '') out.push(e); continue; }
            if (d === lf || (recursive && d.startsWith(prefix))) out.push(e);
        }
        out.sort(LibraryIndex._sorter(sort));
        this._listCache.set(cacheKey, out);
        if (this._listCache.size > 24) this._listCache.delete(this._listCache.keys().next().value);
        return out;
    }

    /** Entries matching a set of absolute paths, in the given order (missing ones skipped). */
    resolvePaths(paths) {
        const out = [];
        for (const p of paths || []) {
            const e = this.entries.get(P.key(p));
            if (e) out.push(e);
        }
        return out;
    }
}

module.exports = { LibraryIndex, collator };
