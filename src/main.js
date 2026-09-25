'use strict';
/**
 * SoundVault: main process bootstrap.
 * Heavy work lives elsewhere: peaks in a worker, CLAP/Echo in the engine
 * host worker, audio rendering is a single typed-array pass. This file wires
 * modules together and exposes a validated IPC surface.
 */
const { app, BrowserWindow, ipcMain, dialog, shell, protocol, nativeImage, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');

const audioProtocol = require('./main/audio-protocol');
audioProtocol.registerPrivileges(protocol);   // must precede app 'ready'

const { createMainWindow } = require('./main/window');
const { SettingsStore } = require('./main/settings-store');
const { VaultStore } = require('./main/vault-store');
const { LibraryIndex } = require('./main/library-index');
const { LibraryWatcher } = require('./main/library-watcher');
const { FileOps } = require('./main/file-ops');
const { Renders } = require('./main/renders');
const { PeaksService } = require('./main/peaks-service');
const { createEngine } = require('./main/engine-client');
const P = require('./main/paths');
const { searchSounds, tokenizeEntry } = require('./search/lexical-search');
const { translateQuery } = require('./search/translate');
const { resolveFfmpegPath } = require('./packaging/ffmpeg-path');

nativeTheme.themeSource = 'dark';
if (process.platform === 'win32') app.setAppUserModelId('com.soundvault.app');
// Auditioning must start on the first click/keypress (and auto-play on arrow keys).
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
}

const USER_DATA = app.getPath('userData');
const settings = new SettingsStore(path.join(USER_DATA, 'soundvault-config.json'), { documentsDir: app.getPath('documents') });
const vaults = new VaultStore(path.join(USER_DATA, 'soundvault-vaults.json'), () => settings.get().libraryPath);
const library = new LibraryIndex({ tokenizeEntry, cacheFile: path.join(USER_DATA, 'soundvault-library.json') });
const watcher = new LibraryWatcher(library);
const fileOps = new FileOps({ library, trashItem: p => shell.trashItem(p) });
const renders = new Renders(() => settings.rendersDir);
const FFMPEG = resolveFfmpegPath(require('ffmpeg-static'));
const peaks = new PeaksService({ dbPath: path.join(USER_DATA, 'soundvault-peaks.db'), ffmpegPath: FFMPEG });
const engine = createEngine({ userData: USER_DATA, isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, ffmpegPath: FFMPEG });

let mainWindow = null;
const send = (channel, data) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, data); };

// ── library lifecycle ──────────────────────────────────────────────────
async function openLibrary(root) {
    watcher.stop();
    // Only the default library (Documents\SoundVault) is created on demand. A
    // user-chosen folder that is missing (unplugged drive, renamed folder) is
    // reported as "Library not found" instead of being silently re-created empty.
    const isDefault = P.key(root || '') === P.key(path.join(app.getPath('documents'), 'SoundVault'));
    if (isDefault) { try { fs.mkdirSync(root, { recursive: true }); } catch (e) { /* reported via status */ } }
    const stats = await library.setRoot(root);
    if (settings.get().watcher) watcher.start();
    engine.setLibrary(root);
    send('library:status', libraryStatus());
    return stats;
}

function libraryStatus() {
    return {
        root: library.root,
        exists: !!library.root && library.rootExists,
        ready: library.ready,
        scanning: !!library.scanning,
        syncing: !!library.background,
        progress: library.progress,
        count: library.size,
        scan: library.scanStats,
        watching: watcher.enabled,
    };
}

// The library index is the single source of truth for what exists on disk:
// every change (watcher, reconcile, imports, deletes, saves) reaches the AI
// engine through here. Moves/renames additionally go through applyMoves() so
// vectors and fingerprints follow the file instead of being re-analysed.
library.on('changed', ev => {
    send('library:changed', ev);
    if (ev.reset) { scheduleCatalog(); return; }
    const added = (ev.added || []).map(p => { const e = library.get(p); return e ? { path: e.path, mtime: e.mtime, size: e.size } : { path: p }; });
    if (added.length || (ev.removed && ev.removed.length)) engine.filesChanged({ added, removed: ev.removed || [] });
});
library.on('stats-filled', () => scheduleCatalog());
library.on('progress', p => send('library:progress', p));
let engineWasReady = false;
engine.onStatus(st => {
    send('engine:status', st);
    // Started or restarted after a crash (a new host has an empty queue): catch up.
    if (st.ready && !engineWasReady) scheduleCatalog(500);
    engineWasReady = !!st.ready;
});

// ── AI catalog ─────────────────────────────────────────────────────────
let catalogTimer = null;
let catalogFor = null;                              // library version + engine host of the last automatic diff
function scheduleCatalog(delay = 2000) {
    clearTimeout(catalogTimer);
    if (settings.get().autoCatalog === false) return;
    catalogTimer = setTimeout(() => runCatalog({ auto: true }).catch(e => console.warn('[catalog]', e.message)), delay);
}
/**
 * Diff the whole library against the AI index (~0.4 s of engine time for 70k
 * files). Automatic runs are skipped when neither the library nor the engine
 * host changed since the last one (startup used to diff twice in a row).
 */
async function runCatalog(opts = {}) {
    if (!library.root || !library.ready) return null;
    if (library.scanning) await library.scanning;
    if (!engine.status().ready) return null;        // the engine's ready status schedules one
    const key = library.version + ':' + engine.hostGen();
    if (opts.auto && key === catalogFor) return null;
    const all = library.all();
    const n = all.length;
    const files = { paths: new Array(n), mtimes: new Float64Array(n), sizes: new Float64Array(n) };
    for (let i = 0; i < n; i++) { const e = all[i]; files.paths[i] = e.path; files.mtimes[i] = e.mtime || 0; files.sizes[i] = e.size || 0; }
    const res = await engine.index(files, { retryFailed: !!opts.retryFailed });
    if (res && !res.deferred) catalogFor = key;
    return res;
}

/** Propagate moves/renames to collections (all vaults), the engine DB and peaks cache. */
function applyMoves(moves) {
    if (!moves || !moves.length) return;
    vaults.remapPaths(moves);
    engine.pathsMoved(moves);
    watcher.suppress(moves.flatMap(m => [m.from, m.to]));
    send('collections:changed', {});
}

// ── helpers ────────────────────────────────────────────────────────────
const str = v => typeof v === 'string' ? v : '';
const strArr = v => Array.isArray(v) ? v.filter(x => typeof x === 'string' && x) : [];
const pub = e => LibraryIndex.public(e);

function scopeEntries({ scope, folder, collection, recursive = true } = {}) {
    if (scope === 'folder') return library.list({ folder: str(folder), recursive, sort: 'name' });
    if (scope === 'collection') return library.resolvePaths(vaults.collectionPaths(str(collection)) || []);
    if (scope === 'vault') return library.resolvePaths(vaults.vaultPaths());
    return library.all();
}

function isPathAllowed(p) {
    return (library.root && P.isInside(library.root, p)) || P.isInside(settings.rendersDir, p) || library.has(p)
        || vaults.vaultPaths().some(v => P.key(v) === P.key(p));
}

// ── IPC: app & settings ───────────────────────────────────────────────
ipcMain.handle('app:info', () => ({ version: app.getVersion(), platform: process.platform, userData: USER_DATA, isPackaged: app.isPackaged }));
ipcMain.handle('settings:get', () => settings.public());
ipcMain.handle('settings:set', (_e, patch) => {
    const before = settings.get();
    const was = { watcher: before.watcher, autoCatalog: before.autoCatalog };
    const out = settings.set(patch && typeof patch === 'object' ? patch : {});
    if (was.watcher !== out.watcher) { if (out.watcher) watcher.start(); else watcher.stop(); send('library:status', libraryStatus()); }
    if (was.autoCatalog === false && out.autoCatalog !== false) scheduleCatalog(500);       // resumed: catch up
    return out;
});
ipcMain.handle('settings:choose-library', async () => {
    const r = await dialog.showOpenDialog(mainWindow, { title: 'Choose your sound library folder', properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths[0]) return null;
    const root = r.filePaths[0];
    if (P.isInside(root, settings.rendersDir)) return { error: 'The renders folder cannot be inside the library.' };
    const prevRoot = settings.get().libraryPath;
    settings.setInternal(d => { d.libraryPath = root; d.lastState = { mode: d.lastState.mode, folder: '', collection: d.lastState.collection }; });
    await openLibrary(root);
    const relinked = relinkCollections(prevRoot, root);
    send('settings:changed', settings.public());
    return { ...settings.public(), relinked };
});

/**
 * The library moved (new drive letter, copied to another disk): collection
 * items that exist at the same relative path under the new root follow it.
 * (The AI engine relinks its own data the same way on the next catalog.)
 */
function relinkCollections(prevRoot, root) {
    if (!prevRoot || P.key(prevRoot) === P.key(root)) return 0;
    const moves = [];
    let stranded = 0;
    for (const p of vaults.allPaths()) {
        if (!P.isInside(prevRoot, p) || library.has(p)) continue;
        stranded++;
        const to = path.join(root, path.relative(prevRoot, p));
        if (library.has(to)) moves.push({ from: p, to });
    }
    // A moved library matches (nearly) everything; a different library that
    // happens to share a few relative paths is left alone.
    if (!moves.length || moves.length < stranded * 0.3) return 0;
    vaults.remapPaths(moves);
    send('collections:changed', {});
    return moves.length;
}
ipcMain.handle('settings:choose-renders-dir', async () => {
    const r = await dialog.showOpenDialog(mainWindow, { title: 'Folder for rendered selections and edits', properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths[0]) return null;
    if (library.root && P.isInside(library.root, r.filePaths[0])) return { error: 'Choose a folder outside the library so renders are not indexed.' };
    settings.setInternal(d => { d.rendersDir = r.filePaths[0]; });
    send('settings:changed', settings.public());
    return settings.public();
});
ipcMain.handle('settings:open-folder', async (_e, which) => {
    const target = which === 'renders' ? settings.rendersDir : which === 'data' ? USER_DATA : library.root;
    if (!target) return false;
    fs.mkdirSync(target, { recursive: true });
    return (await shell.openPath(target)) === '';
});

// ── IPC: library ───────────────────────────────────────────────────────
ipcMain.handle('library:status', () => libraryStatus());
ipcMain.handle('library:tree', async () => { if (library.scanning) await library.scanning; return library.tree(); });
ipcMain.handle('library:list', async (_e, opts = {}) => {
    if (library.scanning) await library.scanning;
    const list = library.list({ folder: str(opts.folder), recursive: opts.recursive !== false, sort: str(opts.sort) || 'name' });
    return list.map(pub);
});
/**
 * File-name search. Spanish queries also search their English translation
 * ("pasos grava" → footsteps gravel): libraries are named in English.
 */
function lexical(pool, q, limit) {
    const res = searchSounds(pool, q, { limit });
    const tq = translateQuery(q);
    if (!tq.changed) return res;
    const extra = searchSounds(pool, tq.text, { limit });
    const full = res.filter(r => !r.partial);
    const seen = new Set(full.map(r => r.path));
    for (const r of extra) if (!r.partial && !seen.has(r.path)) { full.push(r); seen.add(r.path); }
    if (full.length) return full.slice(0, limit);
    return res.length ? res : extra;
}
ipcMain.handle('library:search', async (_e, opts = {}) => {
    if (library.scanning) await library.scanning;
    const q = str(opts.q).slice(0, 300);
    const pool = scopeEntries(opts);
    const limit = Math.max(1, Math.min(5000, opts.limit | 0 || 2000));
    return lexical(pool, q, limit).map(r => ({ ...pub(r), score: r.score, partial: !!r.partial }));
});
ipcMain.handle('library:resolve', (_e, paths) => library.resolvePaths(strArr(paths)).map(pub));
ipcMain.handle('library:rescan', async () => { await library.rescan(); library.save(); scheduleCatalog(500); return libraryStatus(); });

// ── IPC: file operations ───────────────────────────────────────────────
ipcMain.handle('files:import', async (_e, paths, targetRel) => {
    const sources = strArr(paths);
    const res = await fileOps.importPaths(sources, str(targetRel), p => send('files:progress', { op: 'import', ...p }));
    watcher.suppress(res.added);
    return res;
});
ipcMain.handle('files:import-dialog', async (_e, targetRel) => {
    const r = await dialog.showOpenDialog(mainWindow, { title: 'Import sounds', properties: ['openFile', 'multiSelections'], filters: [{ name: 'WAV audio', extensions: ['wav'] }] });
    if (r.canceled || !r.filePaths.length) return null;
    const res = await fileOps.importPaths(r.filePaths, str(targetRel), p => send('files:progress', { op: 'import', ...p }));
    watcher.suppress(res.added);
    return res;
});
ipcMain.handle('files:move', async (_e, paths, targetRel) => {
    const res = await fileOps.moveFiles(strArr(paths), str(targetRel));
    applyMoves(res.moves);
    return res;
});
ipcMain.handle('files:rename', async (_e, p, name) => {
    const res = await fileOps.renameFile(str(p), str(name));
    if (res.ok) applyMoves(res.moves);
    return res;
});
ipcMain.handle('files:trash', async (_e, paths) => {
    const res = await fileOps.trashFiles(strArr(paths));
    watcher.suppress(res.removed);
    peaks.forget(res.removed);
    return res;
});
ipcMain.handle('files:mkdir', (_e, parentRel, name) => fileOps.createFolder(str(parentRel), str(name)));
ipcMain.handle('files:rename-folder', async (_e, rel, name) => {
    const res = await fileOps.renameFolder(str(rel), str(name));
    if (res.ok) { applyMoves([res.dirMove]); engine.pathsMoved(res.moves); peaks.forget(res.moves.map(m => m.from)); }
    return res;
});
ipcMain.handle('files:trash-folder', async (_e, rel) => {
    const res = await fileOps.trashFolder(str(rel));
    if (res.ok) { watcher.suppress(res.removed); peaks.forget(res.removed); }
    return res;
});
ipcMain.handle('files:reveal', (_e, p) => { if (str(p)) shell.showItemInFolder(p); return true; });
ipcMain.handle('files:open-folder', async (_e, rel) => {
    try { const dir = P.fromRel(library.root, str(rel)); return (await shell.openPath(dir)) === ''; } catch (e) { return false; }
});

// ── IPC: audio ─────────────────────────────────────────────────────────
ipcMain.handle('audio:peaks', async (_e, items) => {
    if (!Array.isArray(items)) return {};
    const clean = [];
    for (const it of items.slice(0, 400)) {
        const p = typeof it === 'string' ? it : it && str(it.path);
        if (!p) continue;
        let e = library.get(p);
        if (e && !e.mtime) {   // first run: sizes/dates are filled lazily
            const st = await fs.promises.stat(p).catch(() => null);
            if (st) { e.size = st.size; e.mtime = st.mtimeMs; }
        }
        clean.push({ path: p, mtime: e ? e.mtime : (it.mtime || 0), size: e ? e.size : (it.size || 0) });
    }
    return peaks.get(clean);
});
function channelsFrom(arr) {
    return (Array.isArray(arr) ? arr : []).map(c => c instanceof Float32Array ? c : new Float32Array(c.buffer || c, c.byteOffset || 0, (c.byteLength || c.length * 4) / 4));
}
ipcMain.handle('audio:render', async (_e, o = {}) => {
    const channels = channelsFrom(o.channels);
    if (!channels.length || !channels[0].length || !(o.sampleRate > 0)) return { error: 'Nothing to render' };
    return renders.render({ channels, sampleRate: o.sampleRate | 0, bitDepth: o.float ? 32 : o.bitDepth === 16 ? 16 : 24, float: !!o.float, baseName: str(o.baseName), suffix: str(o.suffix), key: str(o.key) || undefined });
});
ipcMain.handle('audio:save-to-library', async (_e, o = {}) => {
    const src = str(o.sourcePath);
    const channels = channelsFrom(o.channels);
    if (!channels.length || !channels[0].length || !(o.sampleRate > 0)) return { error: 'Nothing to save' };
    const dir = src && library.root && P.isInside(library.root, src) ? path.dirname(src) : P.fromRel(library.root, str(o.folder));
    const name = (str(o.name) || path.basename(src, path.extname(src)) + ' edit').replace(/\.wav$/i, '') + '.wav';
    const err = P.validateName(name);
    if (err) return { error: err };
    const dest = P.uniquePath(dir, name);
    const { encodeWav } = require('./audio/wav');
    await fs.promises.writeFile(dest, encodeWav({ channels, sampleRate: o.sampleRate | 0, bitDepth: o.float ? 32 : o.bitDepth === 16 ? 16 : 24, float: !!o.float }));
    const e = library.upsert(dest);
    watcher.suppress([dest]);
    if (e) library.notify([e], []);
    return { path: dest };
});

// ── drag out (sync, must happen inside the renderer's dragstart) ──────
const DRAG_FALLBACK_ICON = nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==');
ipcMain.on('drag:start', (event, payload) => {
    // A staged render (selection / editor preview) becomes a permanent file in
    // the Renders folder only now that it is actually being dragged.
    const files = renders.promote(strArr(payload && payload.paths)).filter(p => fs.existsSync(p));
    if (!files.length) return;
    let icon = DRAG_FALLBACK_ICON;
    if (payload && typeof payload.icon === 'string' && payload.icon.startsWith('data:image/')) {
        try { const ni = nativeImage.createFromDataURL(payload.icon); if (!ni.isEmpty()) icon = ni; } catch (e) { /* fallback */ }
    }
    try { event.sender.startDrag(files.length === 1 ? { file: files[0], icon } : { file: files[0], files, icon }); }
    catch (e) { try { event.sender.startDrag({ file: files[0], icon: DRAG_FALLBACK_ICON }); } catch (e2) { console.error('[drag] failed:', e2.message); } }
});

// ── IPC: vaults & collections ──────────────────────────────────────────
ipcMain.handle('vaults:list', () => vaults.listVaults());
ipcMain.handle('vaults:create', (_e, name, color) => vaults.createVault(str(name), str(color)));
ipcMain.handle('vaults:switch', (_e, id) => vaults.switchVault(str(id)));
ipcMain.handle('vaults:update', (_e, id, patch) => vaults.updateVault(str(id), patch && typeof patch === 'object' ? patch : {}));
ipcMain.handle('vaults:remove', (_e, id) => vaults.deleteVault(str(id)));
ipcMain.handle('vaults:duplicate', (_e, id) => vaults.duplicateVault(str(id)));
ipcMain.handle('collections:list', () => vaults.collections());
ipcMain.handle('collections:create', (_e, name) => vaults.createCollection(str(name)));
ipcMain.handle('collections:rename', (_e, a, b) => vaults.renameCollection(str(a), str(b)));
ipcMain.handle('collections:remove', (_e, name) => vaults.deleteCollection(str(name)));
ipcMain.handle('collections:set-color', (_e, name, color) => vaults.setCollectionColor(str(name), str(color)));
ipcMain.handle('collections:add', (_e, name, paths) => vaults.addToCollection(str(name), strArr(paths)));
ipcMain.handle('collections:remove-items', (_e, name, paths) => vaults.removeFromCollection(str(name), strArr(paths)));
ipcMain.handle('collections:sounds', async (_e, name) => {
    if (library.scanning) await library.scanning;
    const paths = vaults.collectionPaths(str(name)) || [];
    const sounds = [], missing = [];
    for (const p of paths) {
        const e = library.get(p);
        if (e) { sounds.push(pub(e)); continue; }
        // Outside the library (or not scanned yet) but still on disk → still usable
        const st = await fs.promises.stat(p).catch(() => null);
        if (st && st.isFile()) sounds.push({ path: p, name: path.basename(p), dir: path.dirname(p), size: st.size, mtime: st.mtimeMs, external: true });
        else missing.push(p);
    }
    return { sounds, missing };
});

// ── IPC: engine (semantic search, suggestions, echo, indexing) ────────
ipcMain.handle('engine:status', () => engine.status());
ipcMain.handle('engine:index', (_e, opts = {}) => runCatalog({ retryFailed: !!(opts && opts.retryFailed) }));
ipcMain.handle('engine:cancel-index', () => engine.cancelIndex());
ipcMain.handle('engine:failures', async () => (await engine.failures()).map(f => ({ path: f.path, name: path.basename(f.path), error: f.error })));
/**
 * AI search. Ranking (semantic audit, P@20 0.52 AI-only → 0.77): files whose
 * NAME matches come first, ordered by how much they sound like the query;
 * then sounds found only by listening. Name matches the model considers
 * unrelated (below its similarity floor) drop behind the AI results.
 */
ipcMain.handle('engine:search', async (_e, query, opts = {}) => {
    const q = str(query).slice(0, 300).trim();
    if (!q) return { results: [], words: [] };
    if (library.scanning) await library.scanning;
    const scoped = !!(opts && opts.scope && opts.scope !== 'library');
    const pool = scopeEntries(opts);
    const limit = Math.max(1, Math.min(2000, opts.limit | 0 || 500));
    const weights = opts.weights && typeof opts.weights === 'object' ? opts.weights : null;
    const ai = await engine.search(q, { paths: scoped ? pool.map(e => e.path) : null, weights, topK: limit });
    if (ai.notReady || ai.error) return { results: [], words: [], error: ai.error || null, notReady: !!ai.notReady };
    const names = lexical(pool, q, 5000).filter(r => !r.partial);
    const aiScore = new Map();
    if (names.length) for (const r of await engine.score(q, names.map(r => r.path), { weights })) aiScore.set(r.path, r.score);
    const floor = ai.cutoff || 0;
    const strong = [], weak = [];
    names.forEach((r, i) => { const sc = aiScore.get(r.path); (sc == null || sc >= floor ? strong : weak).push({ path: r.path, score: sc ?? null, i }); });
    const byScore = (a, b) => ((b.score ?? -2) - (a.score ?? -2)) || a.i - b.i;
    strong.sort(byScore); weak.sort(byScore);
    const out = [], seen = new Set();
    const add = (p, score, match) => { if (seen.has(p)) return; const e = library.get(p); if (!e) return; seen.add(p); out.push({ ...pub(e), score, match }); };
    for (const r of strong) add(r.path, r.score, 'name');
    for (const r of ai.results) add(r.path, r.score, aiScore.has(r.path) ? 'name' : 'ai');
    for (const r of weak) add(r.path, r.score, 'name');
    return { results: out.slice(0, limit), total: out.length, words: ai.words, query: ai.query, translated: !!ai.translated, nameMatches: names.length };
});
// ── IPC: vault brief (suggested collections) ───────────────────────────
// The brief describes the project (words, reference sounds, images); the
// engine turns it into suggested collections. Words also match file NAMES
// (cached per library version: the brief is recomputed on every edit).
const BRIEF_DIR = path.join(USER_DATA, 'brief');
const nameCache = { version: -1, map: new Map() };
function namesFor(q) {
    if (nameCache.version !== library.version) { nameCache.version = library.version; nameCache.map.clear(); }
    const k = q.toLowerCase();
    if (!nameCache.map.has(k)) {
        // Files named with every word; with fewer than 5 of those, also the ones
        // named with most of the words ("footsteps" + "wood" for "footsteps on wet wood").
        const all = lexical(library.all(), q, 3000), full = all.filter(r => !r.partial);
        nameCache.map.set(k, (full.length >= 5 ? full : all).map(r => r.path));
    }
    return nameCache.map.get(k);
}
// The image vocabulary's distinctive UCS synonyms per concept ("tiger", "lion" for wild cats), read once.
const IMAGE_MODEL_DIR = app.isPackaged ? path.join(process.resourcesPath, 'models', 'siglip2') : path.join(__dirname, '..', 'build-assets', 'models', 'siglip2');
let conceptSyn = null;
function synonymsFor(key) {
    if (!conceptSyn) {
        conceptSyn = new Map();
        try {
            for (const it of JSON.parse(fs.readFileSync(path.join(IMAGE_MODEL_DIR, 'concepts.json'), 'utf8')).items) if (Array.isArray(it.syn)) conceptSyn.set(it.key, it.syn);
        } catch (e) { /* no vocabulary: CatIDs and labels only */ }
    }
    return conceptSyn.get(key) || [];
}
// Files named for a concept seen in a picture: its UCS CatID ("AMBSea_Rockpool 02.wav",
// the most precise), its label, or one of its synonyms in the name or folder ("Bengal_Tiger_purr").
// { all, exact }: all lift the ranking, exact (CatID or label) also prove the card.
function conceptNames(c) {
    const k = 'concept:' + String(c.key).toLowerCase();
    if (nameCache.version !== library.version) { nameCache.version = library.version; nameCache.map.clear(); }
    if (!nameCache.map.has(k)) {
        const prefix = String(c.key).toLowerCase() + '_', syn = new Set(synonymsFor(c.key));
        const hasSyn = f => f && f.list.some(t => syn.has(t));
        const byCatId = [], bySyn = [];
        for (const e of library.all()) {
            if (e.name.toLowerCase().startsWith(prefix)) byCatId.push(e.path);
            else if (syn.size && e._tokens && (hasSyn(e._tokens.name) || hasSyn(e._tokens.folder))) bySyn.push(e.path);
        }
        const exact = [...new Set([...byCatId, ...namesFor(c.label)])];
        nameCache.map.set(k, { all: [...new Set([...exact, ...bySyn])].slice(0, 3000), exact: exact.slice(0, 3000) });
    }
    return nameCache.map.get(k);
}
const imageType = buf => (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP' ? 'webp'
    : buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG' ? 'png' : buf[0] === 0xff && buf[1] === 0xd8 ? 'jpg' : null);
const briefKey = s => String(s).toLowerCase();

function briefState() {
    const v = vaults.active(), b = vaults.brief();
    const images = b.images.map(im => {
        let thumb = '';
        try { thumb = `data:image/${im.file.endsWith('.jpg') ? 'jpeg' : im.file.split('.').pop()};base64,` + fs.readFileSync(path.join(BRIEF_DIR, im.file)).toString('base64'); } catch (e) { /* file gone: shown as a placeholder */ }
        return { id: im.id, name: im.name, palette: im.palette, concepts: im.concepts, analyzed: im.analyzed, thumb };
    });
    const refs = b.refs.map(p => { const e = library.get(p); return e ? pub(e) : { path: p, name: path.basename(p), dir: '', missing: true }; });
    return {
        vaultId: v.id, name: v.name, color: v.color, description: v.description,
        words: b.words, refs, images, pinned: b.pinned, removed: b.removed, dismissed: b.dismissed, created: b.created,
        imageModel: engine.status().imageModel === 'ready' ? 'ready' : 'unavailable',
    };
}

ipcMain.handle('brief:get', () => briefState());
ipcMain.handle('brief:update', (_e, patch = {}) => {
    const p = patch && typeof patch === 'object' ? patch : {};
    const clean = {};
    for (const k of ['words', 'pinned', 'removed', 'dismissed']) if (Array.isArray(p[k])) clean[k] = strArr(p[k]);
    if (Array.isArray(p.refs)) clean.refs = strArr(p.refs).filter(x => library.has(x));   // references are library sounds
    // created: { key: name } marks a suggestion as turned into a collection; { key: null } undoes it.
    if (p.created && typeof p.created === 'object') clean.created = Object.fromEntries(Object.entries(p.created).map(([k, v]) => [str(k), typeof v === 'string' && v ? v : null]));
    vaults.updateBrief(clean);
    if (typeof p.description === 'string') vaults.updateVault(vaults.active().id, { description: p.description });
    return briefState();
});
// 224x224 RGB of the picture (the renderer squashes it as SigLIP does) → concepts, stored on the image.
const pixelsOf = p => (p && p.buffer && p.byteLength === 224 * 224 * 3 ? new Uint8Array(p.buffer, p.byteOffset || 0, p.byteLength) : null);
async function analyzeBriefImage(id, pixels) {
    if (!pixels || engine.status().imageModel !== 'ready') return;
    const r = await engine.imageConcepts(pixels);
    // A failed analysis (engine restarting) leaves the image unanalyzed, so it can be retried.
    if (!r.error && Array.isArray(r.concepts)) vaults.setBriefImageConcepts(id, r.concepts);
}
ipcMain.handle('brief:analyze-image', async (_e, id, pixels) => { await analyzeBriefImage(str(id), pixelsOf(pixels)); return briefState(); });
ipcMain.handle('brief:add-image', async (_e, img = {}) => {
    const bytes = img && img.bytes;
    const buf = bytes && bytes.buffer ? Buffer.from(bytes.buffer, bytes.byteOffset || 0, bytes.byteLength) : null;
    if (!buf || buf.length < 64 || buf.length > 4 * 1024 * 1024) return { ...briefState(), error: 'That image could not be added (too large or unreadable).' };
    const ext = imageType(buf);
    if (!ext) return { ...briefState(), error: 'Only PNG, JPEG and WebP images can be added.' };
    const file = require('crypto').createHash('sha1').update(buf).digest('hex') + '.' + ext;
    const dest = path.join(BRIEF_DIR, file);
    try {
        fs.mkdirSync(BRIEF_DIR, { recursive: true });
        if (!fs.existsSync(dest)) { fs.writeFileSync(dest + '.tmp', buf); fs.renameSync(dest + '.tmp', dest); }
    } catch (e) { return { ...briefState(), error: 'The image could not be saved: ' + e.message }; }
    vaults.addBriefImage({ file, name: str(img.name).slice(0, 120), palette: strArr(img.palette) });
    await analyzeBriefImage(file.slice(0, 12), pixelsOf(img.pixels));
    return briefState();
});
ipcMain.handle('brief:remove-image', (_e, id) => {
    const orphan = vaults.removeBriefImage(str(id));
    if (orphan) { try { fs.unlinkSync(path.join(BRIEF_DIR, orphan)); } catch (e) { /* already gone */ } }
    return briefState();
});
ipcMain.handle('brief:suggest', async (_e, opts = {}) => {
    if (library.scanning) await library.scanning;
    const v = vaults.active(), b = vaults.brief();
    const pinned = new Set(b.pinned.map(briefKey)), removed = new Set(b.removed.map(briefKey));
    const refs = b.refs.filter(p => library.has(p));
    const queries = [];
    for (const w of b.words) {
        const key = 'w:' + briefKey(w);
        queries.push({ key, title: w, kind: 'word', text: w, weight: 0.6, pinned: pinned.has(key), names: namesFor(w) });
    }
    for (const im of b.images) for (const c of im.concepts) {
        const key = 'c:' + briefKey(c.key);
        if (removed.has(key) || queries.some(q => q.key === key)) continue;
        const named = conceptNames(c);
        queries.push({ key, title: c.label, kind: 'concept', text: c.label, weight: 0.3 + 0.7 * c.score, pinned: pinned.has(key), names: named.all, exact: named.exact });
    }
    for (const p of refs) {
        const key = 's:' + P.key(p), nm = path.parse(library.get(p).name).name;
        queries.push({ key, title: 'Like ' + nm, label: nm, kind: 'sound', path: p, weight: 0.7, pinned: pinned.has(key) });
    }
    if (!queries.length) return { cards: [], empty: true };
    const res = await engine.brief({ queries, context: v.description, exclude: [...vaults.vaultPaths(), ...refs], perCard: 24, maxCards: 14 });
    if (res.notReady || res.error) return { cards: [], notReady: !!res.notReady, error: res.error || null };
    const hidden = new Set([...b.dismissed.map(briefKey), ...Object.keys(b.created).map(briefKey)]);
    const max = Math.max(1, Math.min(12, (opts && opts.max) | 0 || 8));
    const open = res.cards.filter(c => !hidden.has(briefKey(c.key)));
    const cards = open.slice(0, max).map(c => ({ ...c, candidates: c.candidates.map(x => { const e = library.get(x.path); return e ? { ...pub(e), score: x.score } : null; }).filter(Boolean) }));
    return { cards, more: (res.more || 0) + open.length - cards.length, unmatched: res.unmatched || [], ms: res.ms };
});
ipcMain.handle('brief:more', async () => {
    const inVault = new Set(vaults.vaultPaths().map(P.key));
    const out = [];
    for (const c of vaults.collections().filter(c => c.count > 0).slice(0, 8)) {
        const res = await engine.suggest(vaults.collectionPaths(c.name) || [], 16);
        const suggestions = res.filter(r => !inVault.has(P.key(r.path))).map(r => { const e = library.get(r.path); return e ? { ...pub(e), score: r.score } : null; }).filter(Boolean).slice(0, 12);
        if (suggestions.length) out.push({ name: c.name, color: c.color, count: c.count, suggestions });
    }
    return { collections: out };
});
ipcMain.handle('brief:create', (_e, o = {}) => {
    const title = str(o && o.title).trim() || 'Suggested';
    const base = title.charAt(0).toUpperCase() + title.slice(1);
    let name = base, n = 2;
    while (vaults.collections().some(c => c.name.toLowerCase() === name.toLowerCase())) name = `${base} ${n++}`;
    const r = vaults.createCollection(name);
    if (!r.ok) return r;
    if (/^#[0-9a-f]{6}$/i.test(str(o && o.color))) vaults.setCollectionColor(r.name, str(o.color));
    const added = vaults.addToCollection(r.name, strArr(o && o.paths).filter(p => library.has(p)));
    if (str(o && o.key)) vaults.updateBrief({ created: { [str(o.key)]: r.name } });
    send('collections:changed', {});
    return { ok: true, name: r.name, added };
});

ipcMain.handle('engine:suggest', async (_e, name, limit) => {
    const paths = vaults.collectionPaths(str(name)) || [];
    const res = await engine.suggest(paths, Math.min(100, limit | 0 || 24));
    return res.map(r => { const e = library.get(r.path); return e ? { ...pub(e), score: r.score } : null; }).filter(Boolean);
});
const decorate = r => {
    const e = library.get(r.path);
    return { ...r, ...(e ? pub(e) : { name: path.basename(r.path), dir: '' }), copies: (r.copies || []).filter(p => library.has(p)) };
};
ipcMain.handle('engine:echo', async (_e, params = {}) => {
    const raw = params && params.pcm;
    const pcm = raw instanceof Float32Array ? raw : raw && raw.buffer ? new Float32Array(raw.buffer, raw.byteOffset || 0, (raw.byteLength / 4) | 0) : null;
    if (!pcm || !pcm.length || !(params.sampleRate > 0)) return { results: [], error: 'too-short' };
    const res = await engine.echo({
        pcm, sampleRate: params.sampleRate | 0, pre: Math.max(0, params.pre | 0), post: Math.max(0, params.post | 0),
        weights: params.weights && typeof params.weights === 'object' ? params.weights : null,
        exclude: strArr(params.exclude), maxResults: Math.max(1, Math.min(100, params.maxResults | 0 || 50)),
    });
    return { ...res, results: (res.results || []).filter(r => library.has(r.path)).map(decorate) };
});
ipcMain.handle('engine:echo-file', async (_e, p, opts = {}) => {
    const res = await engine.echoFile(str(p), { weights: opts && opts.weights, maxResults: Math.max(1, Math.min(100, (opts && opts.maxResults) | 0 || 50)) });
    return { ...res, results: (res.results || []).filter(r => library.has(r.path)).map(decorate) };
});

// ── lifecycle ──────────────────────────────────────────────────────────
app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
});

app.whenReady().then(async () => {
    audioProtocol.handle(protocol, isPathAllowed);
    const bootAt = Date.now();
    setTimeout(() => renders.pruneStaging({ before: bootAt }), 5000);   // previews never dragged last session (not this one's)
    mainWindow = createMainWindow({
        preload: path.join(__dirname, 'preload.js'),
        indexHtml: path.join(__dirname, 'renderer', 'index.html'),
        state: settings.get().window,
        onStateChange: st => settings.setInternal(d => { d.window = st; }),
        icon: path.join(__dirname, '..', 'build', 'icon.ico'),
    });
    if (process.argv.includes('--dev')) mainWindow.webContents.openDevTools({ mode: 'detach' });
    const root = settings.get().libraryPath;
    const scan = openLibrary(root);
    engine.start(root).catch(e => console.error('[engine] start failed:', e));      // ready status → catalog
    await scan;
});

let quitting = false;
app.on('before-quit', async e => {
    if (quitting) return;
    quitting = true;
    e.preventDefault();
    try { settings.flush(); vaults.flush(); library.save(); renders.pruneStaging(); } catch (err) { console.error('[quit] flush failed', err); }
    watcher.stop();
    await Promise.race([Promise.all([engine.stop(), peaks.stop()]), new Promise(r => setTimeout(r, 3000))]);
    app.exit(process.exitCode || 0);
});
app.on('window-all-closed', () => app.quit());
