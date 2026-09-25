'use strict';
/** App settings (soundvault-config.json): backward compatible with 1.0. */
const path = require('path');
const { JsonStore } = require('./json-store');

const COLOR_RE = /^#[0-9a-f]{6}$/i;

const DEFAULTS = {
    libraryPath: null,
    accentColor: '#c8f76d',
    rendersDir: null,          // null → <Documents>/SoundVault Renders
    autoPlay: true,
    loop: false,
    volume: 0.8,
    watcher: true,
    autoCatalog: true,         // keep the AI catalog up to date in the background
    sort: 'name',
    recursive: true,
    lastState: { mode: 'vault', folder: '', collection: null },
    window: null,
};

class SettingsStore {
    constructor(file, { documentsDir }) {
        this.documentsDir = documentsDir;
        this.store = new JsonStore(file, () => ({ ...DEFAULTS, libraryPath: path.join(documentsDir, 'SoundVault') }), {
            migrate: d => {
                const out = { ...DEFAULTS, ...d };
                if (!out.libraryPath) out.libraryPath = path.join(documentsDir, 'SoundVault');
                if (!COLOR_RE.test(out.accentColor || '')) out.accentColor = DEFAULTS.accentColor;
                out.lastState = { ...DEFAULTS.lastState, ...(d.lastState && typeof d.lastState === 'object' && !Array.isArray(d.lastState) ? d.lastState : {}) };
                if (!['vault', 'sounds'].includes(out.lastState.mode)) out.lastState.mode = 'vault';
                return out;
            },
        });
    }

    get() { return this.store.get(); }

    get rendersDir() { return this.get().rendersDir || path.join(this.documentsDir, 'SoundVault Renders'); }

    /** Apply a validated partial update; returns the public settings. */
    set(patch = {}) {
        this.store.update(d => {
            if (typeof patch.accentColor === 'string' && COLOR_RE.test(patch.accentColor)) d.accentColor = patch.accentColor;
            for (const k of ['autoPlay', 'loop', 'watcher', 'recursive', 'autoCatalog']) if (typeof patch[k] === 'boolean') d[k] = patch[k];
            if (Number.isFinite(patch.volume)) d.volume = Math.max(0, Math.min(1, patch.volume));
            if (['name', 'date', 'size', 'path', 'duration'].includes(patch.sort)) d.sort = patch.sort;
            if (patch.lastState && typeof patch.lastState === 'object') {
                const ls = patch.lastState;
                if (['vault', 'sounds'].includes(ls.mode)) d.lastState.mode = ls.mode;
                if (typeof ls.folder === 'string') d.lastState.folder = ls.folder;
                if (ls.collection === null || typeof ls.collection === 'string') d.lastState.collection = ls.collection;
            }
        });
        return this.public();
    }

    setInternal(fn) { this.store.update(fn); }
    flush() { this.store.flush(); }

    public() {
        const d = this.get();
        return {
            libraryPath: d.libraryPath, accentColor: d.accentColor, rendersDir: this.rendersDir,
            autoPlay: d.autoPlay, loop: d.loop, volume: d.volume, watcher: d.watcher, autoCatalog: d.autoCatalog !== false, sort: d.sort, recursive: d.recursive,
            lastState: { ...d.lastState },
        };
    }
}

module.exports = { SettingsStore, DEFAULTS };
