// Central app state + event bus. Modules read `state` and subscribe to bus
// events; mutations go through the small setters below so every change is
// announced exactly once.
import { Emitter } from './util.js';

export const bus = new Emitter();

export const state = {
    settings: null,          // public settings from main
    mode: 'vault',           // 'vault' (collections) | 'sounds' (library folders)
    library: { root: null, exists: true, ready: false, count: 0, watching: false },
    engine: { ready: false, indexing: false, progress: null, vectors: 0, error: null },
    vaults: { activeVaultId: null, vaults: [] },
    collections: [],         // [{name, color, count}]
    view: {                  // what the list is showing
        kind: 'none',        // 'folder' | 'collection' | 'search' | 'brief' (vault home) | 'none' (booting)
        folder: '',          // library-relative (folder views)
        collection: null,    // collection name
        query: '',           // search text
        ai: false,           // semantic search on/off
        scope: 'auto',       // 'auto' | 'library' | 'folder' | 'collection' | 'vault'
        sort: 'name',
        recursive: true,
    },
    accent: '#c8f76d',       // interface accent in effect (theme.js keeps it current)
};

export function activeVault() {
    return state.vaults.vaults.find(v => v.id === state.vaults.activeVaultId) || state.vaults.vaults[0] || null;
}

/** Accent in effect: derived from the vault's color in Vault mode, the global accent in Sound mode. */
export function modeAccent() {
    return state.accent;
}

export function setView(patch) {
    Object.assign(state.view, patch);
    bus.emit('view', state.view);
}
