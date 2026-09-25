'use strict';
/**
 * Crash-safe JSON persistence.
 *
 * Writes go to `<file>.tmp` and are then renamed over the target, so a crash
 * or power loss mid-write can never leave a truncated/corrupt file behind.
 * The previous good version is kept as `<file>.bak` and used as a fallback
 * when the main file fails to parse. Reads are served from memory after the
 * first load; writes are coalesced (debounced) but can be flushed on demand
 * (e.g. on app quit).
 */
const fs = require('fs');
const path = require('path');

class JsonStore {
    /**
     * @param {string} file Absolute path of the JSON file.
     * @param {() => any} defaults Factory for the initial value.
     * @param {{ debounceMs?: number, migrate?: (data:any) => any }} [opts]
     */
    constructor(file, defaults, opts = {}) {
        this.file = file;
        this.defaults = defaults;
        this.debounceMs = opts.debounceMs ?? 120;
        this.migrate = opts.migrate || (d => d);
        this._data = undefined;
        this._timer = null;
        this._dirty = false;
    }

    _readFile(p) {
        const raw = fs.readFileSync(p, 'utf8');
        if (!raw.trim()) throw new Error('empty file');
        return JSON.parse(raw);
    }

    /** Current value (loaded lazily, cached in memory). Mutate via update(). */
    get() {
        if (this._data !== undefined) return this._data;
        let data;
        for (const candidate of [this.file, this.file + '.bak']) {
            try {
                if (fs.existsSync(candidate)) { data = this._readFile(candidate); break; }
            } catch (e) {
                console.warn(`[JsonStore] could not read ${path.basename(candidate)}: ${e.message}`);
            }
        }
        if (data === undefined || data === null || typeof data !== 'object') data = this.defaults();
        this._data = this.migrate(data);
        return this._data;
    }

    /** Apply `fn(draft)` to the in-memory value and schedule a save. Returns fn's result. */
    update(fn) {
        const data = this.get();
        const res = fn(data);
        this._dirty = true;
        this._schedule();
        return res;
    }

    _schedule() {
        if (this._timer) return;
        this._timer = setTimeout(() => { this._timer = null; this.flush(); }, this.debounceMs);
    }

    /** Synchronously persist pending changes (atomic temp-file + rename). */
    flush() {
        if (this._timer) { clearTimeout(this._timer); this._timer = null; }
        if (!this._dirty || this._data === undefined) return;
        const dir = path.dirname(this.file);
        fs.mkdirSync(dir, { recursive: true });
        const tmp = this.file + '.tmp';
        const json = JSON.stringify(this._data, null, 2);
        const fd = fs.openSync(tmp, 'w');
        try {
            fs.writeSync(fd, json);
            fs.fsyncSync(fd);
        } finally {
            fs.closeSync(fd);
        }
        try { if (fs.existsSync(this.file)) fs.copyFileSync(this.file, this.file + '.bak'); } catch (e) { /* best effort */ }
        fs.renameSync(tmp, this.file);
        this._dirty = false;
    }
}

module.exports = { JsonStore };
