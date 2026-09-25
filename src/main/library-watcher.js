'use strict';
/**
 * Single recursive fs.watch on the library root that keeps the LibraryIndex
 * in sync with external changes (Explorer copies, DAW renders, renames,
 * deletions, including whole directories) and forwards a debounced change
 * set to listeners (the semantic engine uses it for incremental indexing).
 *
 * fs.watch on Windows reports only `rename`/`change` with a relative
 * filename; a directory rename/move yields events for the directory names
 * only. We therefore reconcile each touched path against the disk:
 *   exists & dir   → scan it and add every audio file below it
 *   exists & file  → upsert (new or modified)
 *   missing        → remove the file, or everything below it if it was a dir
 */
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const P = require('./paths');

class LibraryWatcher extends EventEmitter {
    constructor(library, { debounceMs = 400 } = {}) {
        super();
        this.library = library;
        this.debounceMs = debounceMs;
        this._w = null;
        this._pending = new Set();
        this._timer = null;
        this.enabled = false;
        this._suppress = new Map(); // key(path) -> expiry ts, for our own writes
    }

    start() {
        this.stop();
        const root = this.library.root;
        if (!root || !this.library.rootExists) return false;
        try {
            this._w = fs.watch(root, { recursive: true }, (_type, filename) => {
                // Windows reports a null filename when its change buffer overflows
                // (big copy bursts). Nothing can be trusted then → reconcile.
                if (!filename) this._overflow = true;
                else this._pending.add(path.join(root, filename.toString()));
                if (this._timer) clearTimeout(this._timer);
                this._timer = setTimeout(() => this._flush().catch(e => console.warn('[Watcher] flush failed:', e.message)), this.debounceMs);
            });
            this._w.on('error', e => { console.warn('[Watcher] error:', e.message); this.stop(); this.emit('error', e); });
            this.enabled = true;
            return true;
        } catch (e) {
            console.warn('[Watcher] cannot watch library:', e.message);
            return false;
        }
    }

    stop() {
        if (this._timer) { clearTimeout(this._timer); this._timer = null; }
        if (this._w) { try { this._w.close(); } catch (e) {} this._w = null; }
        this._pending.clear();
        this.enabled = false;
    }

    /** Ignore watcher echoes of changes the app itself just applied. */
    suppress(paths, ms = 4000) {
        const until = Date.now() + ms;
        for (const p of paths) this._suppress.set(P.key(p), until);
    }

    async _flush() {
        this._timer = null;
        if (this._overflow) {
            this._overflow = false;
            this._pending.clear();
            const res = await this.library.reconcile().catch(() => null);
            if (res && (res.added.length || res.removed.length)) {
                this.emit('changes', { added: res.added.map(e => ({ path: e.path, mtime: e.mtime })), removed: res.removed.map(e => e.path) });
            }
            return;
        }
        const touched = [...this._pending];
        this._pending.clear();
        const now = Date.now();
        for (const [k, t] of this._suppress) if (t < now) this._suppress.delete(k);

        const added = [], removed = [];
        const seenDirs = new Set();
        for (const p of touched) {
            if (this._suppress.has(P.key(p))) continue;
            const base = path.basename(p);
            if (P.isIgnoredDir(base) || p.split(path.sep).some(seg => P.isIgnoredDir(seg))) continue;
            let st = null;
            try { st = await fs.promises.stat(p); } catch (e) { st = null; }
            if (st && st.isDirectory()) {
                const k = P.key(p);
                if (seenDirs.has(k)) continue;
                seenDirs.add(k);
                added.push(...await this.library.addDir(p));
            } else if (st && st.isFile()) {
                if (!P.isAudioFile(base)) continue;
                const before = this.library.get(p);
                const e = this.library.upsert(p, st);
                if (e && e !== before) added.push(e);
            } else {
                // Gone: a file, or a directory that contained indexed files
                const e = this.library.remove(p);
                if (e) removed.push(e);
                else removed.push(...this.library.removeDir(p));
            }
        }
        if (!added.length && !removed.length) return;
        this.library.notify(added, removed);
        this.emit('changes', { added: added.map(e => ({ path: e.path, mtime: e.mtime })), removed: removed.map(e => e.path) });
    }
}

module.exports = { LibraryWatcher };
