'use strict';
/**
 * Persistent renders for drag-to-DAW (selections and editor edits).
 *
 * Why persistent: DAWs usually reference dragged media in place. The old
 * implementation wrote `<name>_sel.wav` into %TEMP%, reusing the same name on
 * every drag, a second drag silently changed audio already placed in a
 * project, and %TEMP% cleanup could break projects later.
 *
 * Renders are prepared ahead of the drag (so dragstart can hand the OS a
 * finished file) into `<renders>/.staging/`, and only become permanent when
 * they are actually dragged: promote() moves them next to the other renders
 * with a unique, human-readable name. Undragged previews (every settled edit
 * in the editor) never pile up, the staging folder is emptied on start and
 * quit. Identical renders (same source state + params) are de-duplicated by key.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { encodeWav } = require('../audio/wav');
const P = require('./paths');

const STAGING = '.staging';

class Renders {
    constructor(dirFn) {
        this._dirFn = dirFn;           // () => absolute renders dir (configurable)
        this._byKey = new Map();       // key -> path (staged or promoted)
        this._promoted = new Map();    // staged path key -> permanent path
    }

    get dir() { return this._dirFn(); }
    get stagingDir() { return path.join(this.dir, STAGING); }

    static keyFor(parts) {
        return crypto.createHash('sha1').update(JSON.stringify(parts)).digest('hex').slice(0, 16);
    }

    static safeBase(name) {
        const base = String(name || 'render').replace(/\.wav$/i, '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim().slice(0, 120);
        return base.replace(/[. ]+$/, '') || 'render';
    }

    _isStaged(p) { return P.isInside(this.stagingDir, p) && P.key(path.dirname(p)) === P.key(this.stagingDir); }

    /**
     * Prepare a render (staged until dragged).
     * @param {object} o
     * @param {Float32Array[]} o.channels
     * @param {number} o.sampleRate
     * @param {number} [o.bitDepth=24]
     * @param {boolean} [o.float]
     * @param {string} o.baseName   display base, e.g. "Wood Hit 03"
     * @param {string} o.suffix     e.g. "[0.42-1.30 s]" or "[edit]"
     * @param {string} [o.key]      de-dup key (Renders.keyFor({...}))
     */
    async render(o) {
        if (o.key) {
            const hit = this._byKey.get(o.key);
            if (hit && fs.existsSync(hit)) return { path: hit, reused: true };
        }
        const dir = this.stagingDir;
        await fs.promises.mkdir(dir, { recursive: true });
        const fileName = `${Renders.safeBase(o.baseName)} ${o.suffix || ''}`.trim().replace(/\s+/g, ' ') + '.wav';
        const dest = P.uniquePath(dir, fileName);
        const buf = encodeWav({ channels: o.channels, sampleRate: o.sampleRate, bitDepth: o.bitDepth || 24, float: !!o.float });
        const tmp = dest + '.part';
        await fs.promises.writeFile(tmp, buf);
        await fs.promises.rename(tmp, dest);
        if (o.key) this._byKey.set(o.key, dest);
        return { path: dest, reused: false };
    }

    /**
     * Make dragged renders permanent (synchronous: runs inside the drag start).
     * Paths that are not staged renders are returned unchanged.
     */
    promote(paths) {
        return paths.map(p => {
            if (typeof p !== 'string') return p;
            const k = P.key(p);
            const done = this._promoted.get(k);
            if (done && fs.existsSync(done)) return done;
            if (!this._isStaged(p) || !fs.existsSync(p)) return p;
            try {
                const dest = P.uniquePath(this.dir, path.basename(p));
                fs.renameSync(p, dest);
                this._promoted.set(k, dest);
                for (const [key, v] of this._byKey) if (P.key(v) === k) this._byKey.set(key, dest);
                return dest;
            } catch (e) {
                return p;                  // dragging from staging still works this session
            }
        });
    }

    /** Remove staged (never dragged) renders. */
    pruneStaging() {
        let n = 0;
        try {
            for (const d of fs.readdirSync(this.stagingDir, { withFileTypes: true })) {
                if (!d.isFile()) continue;
                try { fs.unlinkSync(path.join(this.stagingDir, d.name)); n++; } catch (e) { /* in use: next time */ }
            }
        } catch (e) { /* no staging dir */ }
        for (const [k, v] of this._byKey) if (!fs.existsSync(v)) this._byKey.delete(k);
        return n;
    }

    async stats() {
        let files = 0, bytes = 0;
        try {
            for (const d of await fs.promises.readdir(this.dir, { withFileTypes: true })) {
                if (!d.isFile() || !/\.wav$/i.test(d.name)) continue;
                const st = await fs.promises.stat(path.join(this.dir, d.name)).catch(() => null);
                if (st) { files++; bytes += st.size; }
            }
        } catch (e) { /* dir may not exist yet */ }
        return { dir: this.dir, files, bytes };
    }
}

module.exports = { Renders };
