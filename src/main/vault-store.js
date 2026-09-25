'use strict';
/**
 * Vaults & collections, persisted atomically in soundvault-vaults.json.
 *
 * File format is unchanged from 1.0 (backward compatible):
 *   { activeVaultId, vaults: [{ id, name, color, description, createdAt,
 *                               collections: { [name]: string[] },
 *                               collectionColors: { [name]: string } }] }
 *
 * New in 1.1: validation, case-insensitive de-duplication of paths, batch
 * add/remove, and path remapping across ALL vaults when files or folders are
 * moved/renamed inside the app (so collections never silently break).
 */
const fs = require('fs');
const path = require('path');
const { JsonStore } = require('./json-store');
const P = require('./paths');

const DEFAULT_COLOR = '#c8f76d';
const COLOR_RE = /^#[0-9a-f]{6}$/i;

function genId() {
    return 'v_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

function validateCollectionName(name) {
    if (typeof name !== 'string' || !name.trim()) return 'Name is required';
    if (name.trim() === '__colors') return 'Reserved name';
    if (name.trim().length > 80) return 'Name is too long';
    return null;
}

class VaultStore {
    /**
     * @param {string} file soundvault-vaults.json path
     * @param {() => string|null} legacyLibraryPath for one-time migration of
     *        <library>/.soundvault-collections.json (SoundVault ≤0.9)
     */
    constructor(file, legacyLibraryPath = () => null) {
        this.store = new JsonStore(file, () => this._fresh(legacyLibraryPath()), { migrate: d => this._normalize(d, legacyLibraryPath) });
    }

    _fresh(libraryPath) {
        let collections = {}, collectionColors = {};
        try {
            const legacy = libraryPath && path.join(libraryPath, '.soundvault-collections.json');
            if (legacy && fs.existsSync(legacy)) {
                const old = JSON.parse(fs.readFileSync(legacy, 'utf8'));
                collectionColors = old.__colors || {};
                delete old.__colors;
                collections = old;
            }
        } catch (e) { /* ignore unreadable legacy file */ }
        const id = genId();
        return { activeVaultId: id, vaults: [{ id, name: 'Main Vault', color: DEFAULT_COLOR, description: '', createdAt: Date.now(), collections, collectionColors }] };
    }

    _normalize(d, legacyLibraryPath) {
        if (!d || !Array.isArray(d.vaults) || !d.vaults.length) d = this._fresh(legacyLibraryPath());
        for (const v of d.vaults) {
            v.id = v.id || genId();
            v.name = typeof v.name === 'string' && v.name.trim() ? v.name : 'Vault';
            v.color = COLOR_RE.test(v.color || '') ? v.color : DEFAULT_COLOR;
            v.description = typeof v.description === 'string' ? v.description : '';
            v.collections = v.collections && typeof v.collections === 'object' ? v.collections : {};
            v.collectionColors = v.collectionColors && typeof v.collectionColors === 'object' ? v.collectionColors : {};
            delete v.collections.__colors;
            for (const [k, arr] of Object.entries(v.collections)) if (!Array.isArray(arr)) v.collections[k] = [];
        }
        if (!d.vaults.some(v => v.id === d.activeVaultId)) d.activeVaultId = d.vaults[0].id;
        return d;
    }

    flush() { this.store.flush(); }

    // ── vaults ──────────────────────────────────────────────────────────
    _data() { return this.store.get(); }
    active() { const d = this._data(); return d.vaults.find(v => v.id === d.activeVaultId) || d.vaults[0]; }

    listVaults() {
        const d = this._data();
        return {
            activeVaultId: d.activeVaultId,
            vaults: d.vaults.map(v => ({
                id: v.id, name: v.name, color: v.color, description: v.description, createdAt: v.createdAt,
                collectionCount: Object.keys(v.collections).length,
                soundCount: Object.values(v.collections).reduce((s, a) => s + a.length, 0),
            })),
        };
    }

    createVault(name, color) {
        const id = genId();
        this.store.update(d => d.vaults.push({
            id, name: (name || '').trim() || 'New Vault', color: COLOR_RE.test(color || '') ? color : DEFAULT_COLOR,
            description: '', createdAt: Date.now(), collections: {}, collectionColors: {},
        }));
        return id;
    }

    switchVault(id) {
        return this.store.update(d => { if (!d.vaults.some(v => v.id === id)) return false; d.activeVaultId = id; return true; });
    }

    updateVault(id, patch = {}) {
        return this.store.update(d => {
            const v = d.vaults.find(x => x.id === id);
            if (!v) return false;
            if (typeof patch.name === 'string' && patch.name.trim()) v.name = patch.name.trim().slice(0, 80);
            if (typeof patch.description === 'string') v.description = patch.description.slice(0, 2000);
            if (COLOR_RE.test(patch.color || '')) v.color = patch.color;
            return true;
        });
    }

    deleteVault(id) {
        return this.store.update(d => {
            if (d.vaults.length <= 1) return false;
            const before = d.vaults.length;
            d.vaults = d.vaults.filter(v => v.id !== id);
            if (d.vaults.length === before) return false;
            if (d.activeVaultId === id) d.activeVaultId = d.vaults[0].id;
            return true;
        });
    }

    duplicateVault(id) {
        const src = this._data().vaults.find(v => v.id === id);
        if (!src) return null;
        const nid = genId();
        this.store.update(d => d.vaults.push({
            ...JSON.parse(JSON.stringify(src)), id: nid, name: src.name + ' (copy)', createdAt: Date.now(),
        }));
        return nid;
    }

    // ── collections (active vault) ──────────────────────────────────────
    collections() {
        const v = this.active();
        return Object.keys(v.collections)
            .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
            .map(name => ({ name, color: v.collectionColors[name] || '', count: v.collections[name].length }));
    }

    collectionPaths(name) {
        const v = this.active();
        return v.collections[name] ? v.collections[name].slice() : null;
    }

    /** Every path referenced by any collection of the active vault. */
    vaultPaths() {
        const set = new Set();
        for (const arr of Object.values(this.active().collections)) for (const p of arr) set.add(p);
        return [...set];
    }

    /** Every path referenced by any collection of any vault. */
    allPaths() {
        const set = new Set();
        for (const v of this.store.get().vaults) for (const arr of Object.values(v.collections)) for (const p of arr) set.add(p);
        return [...set];
    }

    createCollection(name) {
        const err = validateCollectionName(name);
        if (err) return { ok: false, error: err };
        const n = name.trim();
        return this.store.update(d => {
            const v = d.vaults.find(x => x.id === d.activeVaultId);
            if (Object.keys(v.collections).some(k => k.toLowerCase() === n.toLowerCase())) return { ok: false, error: 'A collection with that name already exists' };
            v.collections[n] = [];
            return { ok: true, name: n };
        });
    }

    renameCollection(oldName, newName) {
        const err = validateCollectionName(newName);
        if (err) return { ok: false, error: err };
        const n = newName.trim();
        return this.store.update(d => {
            const v = d.vaults.find(x => x.id === d.activeVaultId);
            if (!v.collections[oldName]) return { ok: false, error: 'Collection not found' };
            if (n !== oldName && Object.keys(v.collections).some(k => k !== oldName && k.toLowerCase() === n.toLowerCase())) return { ok: false, error: 'A collection with that name already exists' };
            const items = v.collections[oldName];
            delete v.collections[oldName];
            v.collections[n] = items;
            if (v.collectionColors[oldName]) { v.collectionColors[n] = v.collectionColors[oldName]; delete v.collectionColors[oldName]; }
            return { ok: true, name: n };
        });
    }

    deleteCollection(name) {
        return this.store.update(d => {
            const v = d.vaults.find(x => x.id === d.activeVaultId);
            if (!v.collections[name]) return false;
            delete v.collections[name];
            delete v.collectionColors[name];
            return true;
        });
    }

    setCollectionColor(name, color) {
        return this.store.update(d => {
            const v = d.vaults.find(x => x.id === d.activeVaultId);
            if (!v.collections[name]) return false;
            if (color && COLOR_RE.test(color)) v.collectionColors[name] = color; else delete v.collectionColors[name];
            return true;
        });
    }

    /** Add paths (deduped, case-insensitive). Creates the collection if missing. Returns number added. */
    addToCollection(name, paths) {
        const list = (Array.isArray(paths) ? paths : [paths]).filter(p => typeof p === 'string' && p);
        return this.store.update(d => {
            const v = d.vaults.find(x => x.id === d.activeVaultId);
            if (!v.collections[name]) {
                if (validateCollectionName(name)) return 0;
                v.collections[name] = [];
            }
            const arr = v.collections[name];
            const seen = new Set(arr.map(P.key));
            let added = 0;
            for (const p of list) { const k = P.key(p); if (!seen.has(k)) { seen.add(k); arr.push(p); added++; } }
            return added;
        });
    }

    removeFromCollection(name, paths) {
        const drop = new Set((Array.isArray(paths) ? paths : [paths]).map(P.key));
        return this.store.update(d => {
            const v = d.vaults.find(x => x.id === d.activeVaultId);
            if (!v.collections[name]) return 0;
            const before = v.collections[name].length;
            v.collections[name] = v.collections[name].filter(p => !drop.has(P.key(p)));
            return before - v.collections[name].length;
        });
    }

    /**
     * Rewrite references after a move/rename, across ALL vaults.
     * @param {Array<{from:string,to:string,dir?:boolean}>} moves
     */
    remapPaths(moves) {
        if (!moves || !moves.length) return 0;
        const files = new Map();
        const dirs = [];
        for (const m of moves) {
            if (m.dir) dirs.push({ from: P.key(m.from) + path.sep, fromLen: path.resolve(m.from).length, to: path.resolve(m.to) });
            else files.set(P.key(m.from), m.to);
        }
        let changed = 0;
        this.store.update(d => {
            for (const v of d.vaults) {
                for (const [name, arr] of Object.entries(v.collections)) {
                    for (let i = 0; i < arr.length; i++) {
                        const k = P.key(arr[i]);
                        const f = files.get(k);
                        if (f) { arr[i] = f; changed++; continue; }
                        for (const dm of dirs) {
                            if (k.startsWith(dm.from)) { arr[i] = dm.to + path.resolve(arr[i]).slice(dm.fromLen); changed++; break; }
                        }
                    }
                    // Collapse duplicates a remap might have produced
                    const seen = new Set();
                    v.collections[name] = arr.filter(p => { const k = P.key(p); if (seen.has(k)) return false; seen.add(k); return true; });
                }
            }
        });
        return changed;
    }
}

module.exports = { VaultStore, validateCollectionName, DEFAULT_COLOR };
