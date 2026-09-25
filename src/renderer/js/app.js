// App controller: owns the current view, wires list ⇄ player ⇄ panels,
// global keyboard shortcuts, drops and live updates from the main process.
import { h, icon, count, stripExt, debounce, isEditableTarget, clamp } from './util.js';
import { state, bus, activeVault, setView } from './store.js';
import { player, decode } from './audio/engine.js';
import { peaksFor, dropPeaks } from './audio/peaks.js';
import { list } from './ui/list.js';
import { selection, position as positionSelToolbar } from './ui/selection.js';
import { renderHeader, refreshHeader, sortButton, actionBtn, iconAction, setBanner, renderCollectBar, setEmpty, renderResonance, setLoading } from './ui/panel.js';
import { focusSearch, setSearchText, effectiveScope, afterMotion, isMoving } from './ui/titlebar.js';
import { revealFolder, menuForVaults } from './ui/sidebar.js';
import { toast, isDialogOpen, pickDialog } from './ui/overlays.js';
import { initBrief, showBrief, refreshBrief, openSuggestions } from './ui/brief.js';
import { refreshColors } from './theme.js';
import * as A from './actions.js';
import { dragFiles, dragRegion, prerenderRegion, regionChannels } from './drag.js';

const sv = window.sv;
let loadSeq = 0;
let collectTarget = null;

// ── settings / persistence ─────────────────────────────────────────────
export async function setSettings(patch) {
    state.settings = await sv.settings.set(patch);
    if ('loop' in patch) player.setLoop(state.settings.loop);
    bus.emit('settings', state.settings);
}
const persistLastState = debounce(() => sv.settings.set({ lastState: { mode: state.mode, folder: state.view.kind === 'folder' ? state.view.folder : (state.lastFolder || ''), collection: state.lastCollection || null } }), 400);

// ── mode ───────────────────────────────────────────────────────────────
// A mode switch gives the brand morph the frames to itself: colors and the
// sidebar change at once (cheap), the content area shows a calm stand-in, and
// the view's data is requested and drawn only once the morph is over
// (afterMotion). The views below follow that rule for any load started while
// the mark moves, so a click during the morph cannot stutter it either.
export async function setMode(mode, { restore = true } = {}) {
    if (mode !== 'vault' && mode !== 'sounds') return;
    const changed = state.mode !== mode;
    state.mode = mode;
    selection.clear();
    refreshColors();
    bus.emit('mode', mode);
    if (!changed && !restore) return;
    if (state.view.query) { await runSearch({ q: state.view.query }); persistLastState(); return; }
    if (mode === 'sounds') await openFolder(state.lastFolder || '');
    else if (state.lastCollection && state.collections.some(c => c.name === state.lastCollection)) await openCollection(state.lastCollection);
    else showVaultHome();
    persistLastState();
}

/** Enter Sound mode from a view that needs it (locate, a folder from the tree). */
function enterSounds() {
    if (state.mode === 'sounds') return;
    state.mode = 'sounds';
    selection.clear();
    refreshColors();
    bus.emit('mode', 'sounds');
}

/**
 * A folder's sounds. Packed on the wire (a long list is cheap to receive) and
 * rebuilt here; the last one is kept, so going back to it (a mode round trip)
 * costs one tiny request while the library is unchanged (main's version).
 */
let lastList = null;                                  // { key, v, items }
async function folderItems(rel) {
    const key = `${rel}\0${state.view.recursive}\0${state.view.sort}`;
    const known = lastList && lastList.key === key ? lastList.v : undefined;
    const res = await sv.library.listPacked({ folder: rel, recursive: state.view.recursive, sort: state.view.sort, known });
    if (res.same && lastList && lastList.key === key) return lastList.items;
    const paths = res.n ? res.paths.split('\0') : [], out = new Array(res.n);
    for (let i = 0; i < res.n; i++) {
        const p = paths[i];
        out[i] = { path: p, name: p.slice(Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/')) + 1), dir: res.dirs[res.dir[i]], size: res.size[i], mtime: res.mtime[i] };
    }
    lastList = { key, v: res.v, items: out };
    return out;
}

// ── views ──────────────────────────────────────────────────────────────
export async function openFolder(rel, { keepScroll = false, cursorPath } = {}) {
    const seq = ++loadSeq;
    state.lastFolder = rel;
    setView({ kind: 'folder', folder: rel, collection: null, query: '' });
    if (!keepScroll) setSearchText('');
    renderResonance(null);
    setBanner('missing', null);
    const parts = rel ? rel.split('/') : [];
    const header = n => renderHeader({
        crumbs: [{ label: 'Library', onClick: () => openFolder('') }, ...parts.slice(0, -1).map((p, i) => ({ label: p, onClick: () => openFolder(parts.slice(0, i + 1).join('/')) }))],
        title: parts.length ? parts[parts.length - 1] : 'All sounds',
        countText: n === null ? '' : count(n, 'sound'),
        actions: [sortButton(), actionBtn('import', 'Import', () => A.importDialog(rel), 'Copy WAV files into this folder')],
    });
    if (isMoving()) { header(null); setLoading(true); await afterMotion(); if (seq !== loadSeq) return; }
    const items = await folderItems(rel);
    if (seq !== loadSeq) return;
    list.setItems(items, { baseDir: rel, keepScroll, cursorPath });
    header(items.length);
    setEmpty(!state.library.exists ? libraryMissingEmpty() : {
        icon: 'folder', title: rel ? 'This folder has no sounds' : 'Your library is empty',
        text: 'Drop WAV files or whole folders here, or import them. Files are copied: originals stay where they are, and nothing is ever overwritten.',
        actions: [h('button.btn.primary', { onclick: () => A.importDialog(rel) }, icon('import'), 'Import sounds'), !rel ? h('button.btn', { onclick: () => bus.emit('settings:choose-library') }, icon('folder'), 'Choose another folder') : null],
    });
    setLoading(false);
    persistLastState();
}

export async function openCollection(name, { keepScroll = false } = {}) {
    const seq = ++loadSeq;
    state.lastCollection = name;
    try { const m = JSON.parse(localStorage.getItem('sv.lastCollectionByVault') || '{}'); m[state.vaults.activeVaultId] = name; localStorage.setItem('sv.lastCollectionByVault', JSON.stringify(m)); } catch (e) {}
    setView({ kind: 'collection', collection: name, folder: '', query: '', scope: state.view.scope === 'collection' ? 'collection' : 'auto' });
    if (!keepScroll) setSearchText('');
    const header = n => {
        renderHeader({
            crumbs: [{ label: activeVault()?.name || 'Vault', onClick: () => showVaultHome() }],
            title: name,
            countText: n === null ? '' : count(n, 'sound'),
            actions: [
                iconAction('collection-plus', collectTarget === name ? 'Collecting into this collection' : 'Collect into this collection', () => setCollectTarget(collectTarget === name ? null : name), 'C'),
                iconAction('more', 'Collection options', e => A.collectionMenu({ name, x: e.currentTarget.getBoundingClientRect().left, y: e.currentTarget.getBoundingClientRect().bottom + 4 })),
            ],
        });
        const c = state.collections.find(x => x.name === name);
        if (c && c.color) document.querySelector('.crumbs h1')?.prepend(h('span.dot', { style: { background: c.color, display: 'inline-block', marginRight: '8px', verticalAlign: '2px' } }));
    };
    if (isMoving()) { header(null); renderResonance(null); setBanner('missing', null); setLoading(true); await afterMotion(); if (seq !== loadSeq) return; }
    const res = await sv.collections.sounds(name);
    if (seq !== loadSeq) return;
    list.setItems(res.sounds, { baseDir: '', keepScroll });
    header(res.sounds.length);
    setBanner('missing', res.missing.length ? h('div.banner.warn', {}, icon('warn'), h('span.grow', { text: `${count(res.missing.length, 'sound')} in this collection can’t be found (moved or deleted outside SoundVault).` }),
        h('button.btn.sm', { text: 'Remove missing', onclick: async () => { await sv.collections.removeItems(name, res.missing); await A.refreshCollections(); openCollection(name, { keepScroll: true }); toast('Removed missing sounds'); } })) : null);
    setEmpty({ icon: 'collection', title: 'This collection is empty', text: 'Browse your library in Sound mode and press C, drag sounds onto the collection in the sidebar, or use Echo to find sounds that belong here.', actions: [h('button.btn', { onclick: () => { setCollectTarget(name); setMode('sounds'); } }, icon('collection-plus'), 'Collect from the library')] });
    setLoading(false);
    persistLastState();
    loadResonance(name);
}

/** The vault's home: its collections, and the Brief's suggestions when asked for (it is also where the app reopens next time). */
function showVaultHome() {
    ++loadSeq;
    state.lastCollection = null;
    try { const m = JSON.parse(localStorage.getItem('sv.lastCollectionByVault') || '{}'); delete m[state.vaults.activeVaultId]; localStorage.setItem('sv.lastCollectionByVault', JSON.stringify(m)); } catch (e) {}
    setView({ kind: 'brief', collection: null, folder: '', query: '' });
    list.setItems([]);
    renderResonance(null);
    setBanner('missing', null);
    setLoading(false);
    showBrief();
    persistLastState();
}

function libraryMissingEmpty() {
    return { icon: 'warn', title: 'Library folder not found', text: `SoundVault can’t reach “${state.library.root || ''}”. If it’s on an external or network drive, connect it and press Rescan, or choose another folder.`,
        actions: [h('button.btn.primary', { onclick: () => bus.emit('settings:choose-library') }, icon('folder'), 'Choose folder'), h('button.btn', { onclick: () => rescan() }, icon('refresh'), 'Rescan')] };
}

async function loadResonance(name) {
    renderResonance(null);
    if (!state.engine.ready || !state.engine.vectors) return;
    const c = state.collections.find(x => x.name === name);
    if (!c || !c.count) return;
    const seq = loadSeq;
    const items = await sv.engine.suggest(name, 16).catch(() => []);
    if (seq === loadSeq && state.view.collection === name) renderResonance(items, name);
}

// ── search ─────────────────────────────────────────────────────────────
export async function runSearch({ q, weights = undefined } = {}) {
    const query = String(q ?? state.view.query ?? '').trim();
    if (!query) {
        const had = state.view.query;
        state.view.query = '';
        bus.emit('search:words', []);
        if (!had && state.view.kind !== 'search') return;
        if (state.mode === 'sounds') return openFolder(state.lastFolder || '');
        if (state.lastCollection && state.collections.some(c => c.name === state.lastCollection)) return openCollection(state.lastCollection);
        return showVaultHome();
    }
    const seq = ++loadSeq;
    const scope = effectiveScope();
    const ai = state.view.ai && state.engine.ready;
    const prevKind = state.view.kind;
    if (weights === undefined && query !== state.view.query) state.view.weights = null;
    setView({ kind: 'search', query, scopeUsed: scope, prevKind });
    const clear = () => actionBtn('x', 'Clear', () => { setSearchText(''); runSearch({ q: '' }); });
    if (isMoving()) {
        renderHeader({ crumbs: [{ label: ai ? 'Describe' : 'Search', onClick: () => {} }], title: `“${query}”`, countText: '', actions: [clear()] });
        setLoading(true); await afterMotion(); if (seq !== loadSeq) return;
    }
    const opts = { q: query, scope, folder: state.lastFolder || '', collection: state.lastCollection || state.view.collection, limit: 2000 };
    let items = [], words = [], total = 0, note = '';
    const t0 = performance.now();
    if (ai) {
        const res = await sv.engine.search(query, { ...opts, weights: state.view.weights || null, limit: 500 });
        if (res.notReady || res.error) {
            items = await sv.library.search(opts);
            if (seq === loadSeq) toast(res.notReady ? 'Resonance is still starting: showing file-name matches' : 'Resonance could not search: showing file-name matches', { icon: 'info' });
        } else {
            items = res.results || []; words = res.words || []; total = res.total || items.length;
            if (res.translated && res.query) note = `searching for “${res.query}”`;
        }
    } else {
        items = await sv.library.search(opts);
    }
    if (!total) total = items.length;
    if (items.length && items.every(i => i.partial)) note = 'no name has every word: closest matches';
    if (seq !== loadSeq) return;
    const ms = Math.round(performance.now() - t0);
    list.setItems(items, { baseDir: '', query: ai ? '' : query, showScore: ai, scoreKind: 'ai' });
    bus.emit('search:words', ai ? words : []);
    const where = scope === 'folder' ? `in “${(state.lastFolder || '').split('/').pop()}”` : scope === 'collection' ? `in “${opts.collection}”` : scope === 'vault' ? `in ${activeVault()?.name || 'the vault'}` : 'in the library';
    renderHeader({
        crumbs: [{ label: ai ? 'Describe' : 'Search', onClick: () => {} }],
        title: `“${query}”`,
        countText: `${total > items.length || items.length >= (ai ? 500 : 2000) ? `best ${items.length.toLocaleString('en-US')} of ${total > items.length ? total.toLocaleString('en-US') : items.length.toLocaleString('en-US') + '+'}` : count(items.length, 'result')} ${where}${note ? ' · ' + note : ''} · ${ms} ms`,
        actions: [clear()],
    });
    renderResonance(null);
    setBanner('missing', null);
    setLoading(false);
    setEmpty({ icon: 'search', title: `No sounds match “${query}”`,
        text: ai ? 'Try describing the sound differently (“short metallic hit”, “distant thunder”), or widen the scope.' : state.engine.ready && state.engine.vectors ? 'Nothing in the file names matches. Describe finds sounds by how they sound.' : 'Nothing in the file names matches. Check the spelling or widen the scope.',
        actions: [!ai && state.engine.ready && state.engine.vectors ? h('button.btn.primary', { onclick: () => toggleAI(true) }, icon('resonance'), 'Try Describe') : null, scope !== 'library' ? h('button.btn', { onclick: () => { setView({ scope: 'library' }); runSearch({ q: query }); } }, icon('library'), 'Search entire library') : null] });
}

function toggleAI(on = !state.view.ai) {
    if (on && !state.engine.ready) { toast('Resonance is still starting…', { icon: 'info' }); return; }
    if (on && !state.engine.vectors) { toast('Describe becomes available as your sounds are analysed', { icon: 'info', action: { label: 'Details', onClick: () => bus.emit('settings:open', 'catalog') } }); return; }
    setView({ ai: on });
    if (state.view.query) runSearch({ q: state.view.query });
}

// ── playback ───────────────────────────────────────────────────────────
function playItem(item, from = 0) {
    if (!item) return;
    if (player.isCurrent(item.path) && player.mode === 'stream' && !player.segment && player.sound) {
        player.seek(from);
        if (!player.playing) player.resume();
        return;
    }
    player.play(item, { at: from });
}

/** Space: pause if anything plays; otherwise play the selection / cursor row / resume. */
function togglePlay() {
    if (player.playing) { player.pause(); return; }
    if (player.loading) { player.stop(); return; }   // cancel a start that hasn't sounded yet
    const s = selection.get();
    const cur = list.current();
    if (s && (!cur || cur.path === s.path)) {
        const seg = player.isCurrent(s.path) && player.segment;
        if (seg && Math.abs(seg.start - s.start) < 1e-6 && Math.abs(seg.end - s.end) < 1e-6) { player.resume(); return; }
        return playSelection(s);
    }
    if (cur && !player.isCurrent(cur.path)) return playItem(cur, 0);
    if (player.sound) { player.resume(); return; }
    if (cur) playItem(cur, 0);
}

function playSelection(s) {
    const item = list.get(s.path) || (player.sound && player.sound.path === s.path ? player.sound : { path: s.path, name: s.path.split(/[\\/]/).pop() });
    if (player.isCurrent(s.path) && player.segment && player.segment.start === s.start && player.segment.end === s.end && player.playing) { player.pause(); return; }
    player.play(item, { start: s.start, end: s.end, fades: { in: s.fadeIn, out: s.fadeOut } });
}

function stepList(delta, play = true) {
    if (!list.items.length) return;
    const i = list.cursor < 0 ? 0 : clamp(list.cursor + delta, 0, list.items.length - 1);
    list.setCursor(i, { play: play && state.settings.autoPlay });
    if (play && !state.settings.autoPlay && player.playing) playItem(list.items[i], 0);
}

// ── collect target (fast "C" gathering) ────────────────────────────────
function setCollectTarget(name) {
    collectTarget = name;
    renderCollectBar(name);
    if (state.view.kind === 'collection') openCollection(state.view.collection, { keepScroll: true });
}
async function collect(items) {
    if (!items.length) return;
    if (!collectTarget) {
        const name = await A.addToCollectionFlow(items, 'Collect into');
        if (name) setCollectTarget(name);
        return;
    }
    await A.addToCollection(collectTarget, items);
}

// ── Echo & editor bridges (modules loaded lazily) ─────────────────────
async function echoSelection() {
    const s = selection.get();
    if (!s) { const cur = list.current(); if (cur) bus.emit('echo:file', cur); return; }
    const item = list.get(s.path) || { path: s.path, name: s.path.split(/[\\/]/).pop() };
    const { openEchoForRegion } = await import('./ui/echo.js');
    openEchoForRegion(item, s);
}

async function openEditor() {
    const s = selection.get();
    if (!s) return toast('Select a region on a waveform first', { icon: 'info' });
    const item = list.get(s.path) || (player.sound && player.sound.path === s.path ? player.sound : null);
    if (!item) return;
    const { openEditorFor } = await import('./ui/editor.js');
    openEditorFor(item, s);
}

async function saveSelection() {
    const s = selection.get();
    if (!s) return;
    const item = list.get(s.path);
    if (!item) return;
    const r = await regionChannels(item, s);
    if (!r) return toast('Could not read the selection', { kind: 'error' });
    const res = await sv.audio.saveToLibrary({ sourcePath: item.path, channels: r.channels, sampleRate: r.sampleRate, bitDepth: 24, name: `${stripExt(item.name)} (${s.start.toFixed(2)}-${s.end.toFixed(2)}s)` });
    if (res.error) return toast(res.error, { kind: 'error' });
    toast(`Saved “${stripExt(res.path.split(/[\\/]/).pop())}” next to the original`, { action: { label: 'Show', onClick: () => locate({ path: res.path, dir: item.dir, name: res.path.split(/[\\/]/).pop() }) } });
}

// ── locate a sound in its library folder ───────────────────────────────
export async function locate(item) {
    if (!item || item.external) return;
    enterSounds();
    const dir = item.dir || '';
    revealFolder(dir);
    await openFolder(dir, { cursorPath: item.path });
    requestAnimationFrame(() => list.scrollToPath(item.path));
}

async function rescan() {
    const t = toast('Rescanning library…', { timeout: 0 });
    await sv.library.rescan();
    t.close();
    await reloadTree();
    reloadView(true);
}

// ── live updates ───────────────────────────────────────────────────────
export async function reloadTree() {
    state.tree = await sv.library.tree();
    bus.emit('tree', state.tree);
}

function reloadView(keepScroll = true) {
    const v = state.view;
    if (v.kind === 'folder') return openFolder(v.folder, { keepScroll });
    if (v.kind === 'collection') return openCollection(v.collection, { keepScroll });
    if (v.kind === 'search') return runSearch({ q: v.query, weights: v.weights });
    if (v.kind === 'brief') return refreshBrief();
}

const onLibraryChanged = debounce(async () => {
    state.library = await sv.library.status();
    bus.emit('library-status', state.library);
    await reloadTree();
    await A.refreshCollections();
    reloadView(true);
}, 350);

// ── keyboard ───────────────────────────────────────────────────────────
function onKey(e) {
    if (e.defaultPrevented || isDialogOpen()) return;
    const k = e.key, ctrl = e.ctrlKey || e.metaKey;
    const inField = isEditableTarget(e.target);
    if (ctrl && (k === 'f' || k === 'F')) { e.preventDefault(); focusSearch(); return; }
    if (ctrl && (k === 'i' || k === 'I')) { e.preventDefault(); toggleAI(); return; }
    if (ctrl && k === 'Tab') { e.preventDefault(); setMode(state.mode === 'vault' ? 'sounds' : 'vault'); return; }
    if (ctrl && k === '1') { e.preventDefault(); setMode('vault'); return; }
    if (ctrl && k === '2') { e.preventDefault(); setMode('sounds'); return; }
    if (ctrl && (k === 'b' || k === 'B')) { e.preventDefault(); bus.emit('sidebar:toggle'); return; }
    if (ctrl && k === ',') { e.preventDefault(); bus.emit('settings:open'); return; }
    if (inField) return;
    if (e.target.closest && e.target.closest('#editor, .echo')) return;
    if (ctrl && (k === 'e' || k === 'E')) { e.preventDefault(); echoSelection(); return; }
    if (k === '/') { e.preventDefault(); focusSearch(); return; }
    if (k === ' ') { e.preventDefault(); togglePlay(); return; }
    if (k === 'Escape') { if (selection.get()) { selection.clear(); e.preventDefault(); } return; }
    if (k === 'ArrowLeft' || k === 'ArrowRight') {
        if (!player.sound) return;
        e.preventDefault();
        const d = player.fileDuration || player.duration || 0;
        const step = Math.max(0.1, Math.min(5, d * 0.1));
        player.seek(player.position() + (k === 'ArrowLeft' ? -step : step));
        return;
    }
    if (ctrl) return;
    if (k === 'e' || k === 'E') { e.preventDefault(); openEditor(); return; }
    if (k === 'c' || k === 'C') { e.preventDefault(); collect(list.selectedItems()); return; }
    if (k === 'l' || k === 'L') { e.preventDefault(); setSettings({ loop: !state.settings.loop }); return; }
    if (k === 'F2') { const it = list.current(); if (it && !it.external) { e.preventDefault(); A.renameFile(it); } return; }
    if (k === 'Delete') { const items = list.selectedItems().filter(i => !i.external); if (items.length) { e.preventDefault(); A.trashFiles(items); } return; }
    if (k === '?') { e.preventDefault(); bus.emit('settings:open', 'shortcuts'); }
}

// ── wiring ─────────────────────────────────────────────────────────────
export function wireApp() {
    list.on('play', ({ item, from, force }) => { if (force || state.settings.autoPlay || from > 0 || !player.sound || player.playing) playItem(item, from || 0); });
    list.on('toggle', item => { if (player.isCurrent(item.path) && (player.playing || player.mode)) player.toggle(); else playItem(item, 0); });
    list.on('select', item => { if (state.settings.autoPlay && !player.isCurrent(item.path)) playItem(item, 0); });
    list.on('play-selection', s => playSelection(s));
    list.on('selection-done', s => {
        if (!s) return;
        const item = list.get(s.path);
        if (state.settings.autoPlay) playSelection(s);
        if (item) prerenderRegion(item, s);
    });
    list.on('context', A.rowMenu);
    list.on('drag-out', ({ items }) => dragFiles(items));
    list.on('cursor', item => { if (item && selection.get() && selection.get().path !== item.path) selection.clear(); });
    list.on('items', () => {
        const s = selection.get();
        if (s && !list.index.has(s.path)) selection.clear();
        requestAnimationFrame(positionSelToolbar);
    });

    selection.on('change', ({ cur }) => { if (!cur && player.segment) { /* keep playing file */ } });
    selection.on('action', a => {
        const s = selection.get();
        if (!s) return;
        const item = list.get(s.path);
        if (a === 'play') playSelection(s);
        else if (a === 'edit') openEditor();
        else if (a === 'echo') echoSelection();
        else if (a === 'save') saveSelection();
        else if (a === 'drag' && item) { if (!dragRegion(item, s)) toast('Preparing the selection. Drag again if nothing happened', { icon: 'info', timeout: 1800 }); }
        else if (a === 'clear') selection.clear();
    });

    player.on('error', ({ message }) => toast(message, { kind: 'error' }));

    bus.on('mode:toggle', () => setMode(state.mode === 'vault' ? 'sounds' : 'vault'));
    bus.on('sidebar:toggle', () => {
        const app = document.getElementById('app');
        app.classList.toggle('sidebar-collapsed');
        try { localStorage.setItem('sv.sidebar', app.classList.contains('sidebar-collapsed') ? '0' : '1'); } catch (e) {}
        refreshHeader();
    });
    try { if (localStorage.getItem('sv.sidebar') === '0') document.getElementById('app').classList.add('sidebar-collapsed'); } catch (e) {}
    bus.on('nav:folder', rel => { enterSounds(); openFolder(rel); });
    bus.on('nav:collection', name => openCollection(name));
    bus.on('nav:brief', opts => {
        if (state.view.query) { setSearchText(''); setView({ query: '' }); bus.emit('search:words', []); }
        state.lastCollection = null;
        if (opts && opts.suggest) openSuggestions();
        if (state.mode !== 'vault') setMode('vault'); else showVaultHome();
    });
    bus.on('view:sort', sort => { setView({ sort }); setSettings({ sort }); reloadView(false); });
    bus.on('view:recursive', recursive => { setView({ recursive }); setSettings({ recursive }); reloadView(false); });
    bus.on('view:reload', () => reloadView(true));
    bus.on('tree:reload', reloadTree);
    bus.on('search:run', ({ q }) => runSearch({ q }));
    bus.on('search:toggle-ai', () => toggleAI());
    bus.on('search:scope', scope => { setView({ scope }); if (state.view.query) runSearch({ q: state.view.query }); });
    bus.on('search:weights', w => { state.view.weights = w; runSearch({ q: state.view.query, weights: w }); });
    bus.on('list:focus', () => { list.el.focus(); if (list.cursor < 0 && list.items.length) list.setCursor(0, { play: false }); });
    bus.on('list:step', d => stepList(d, true));
    bus.on('list:toggle-item', item => { if (player.isCurrent(item.path)) player.toggle(); else playItem(item, 0); });
    bus.on('player:toggle', togglePlay);
    bus.on('play:item', item => playItem(item, 0));
    bus.on('locate', locate);
    bus.on('settings:set', setSettings);
    bus.on('settings:toggle-watcher', () => setSettings({ watcher: !state.settings.watcher }).then(async () => { state.library = await sv.library.status(); bus.emit('library-status', state.library); toast(state.settings.watcher ? 'Watching the library for new files' : 'Folder watcher off'); }));
    bus.on('files:import-dialog', () => A.importDialog());
    bus.on('folder:new', rel => A.newFolder(rel));
    bus.on('folder:menu', A.folderMenu);
    bus.on('folder:renamed', ({ from, to }) => { if (state.view.kind === 'folder' && (state.view.folder === from || state.view.folder.startsWith(from + '/'))) openFolder(to + state.view.folder.slice(from.length)); });
    bus.on('folder:deleted', rel => { if (state.view.kind === 'folder' && (state.view.folder === rel || state.view.folder.startsWith(rel + '/'))) openFolder(''); });
    bus.on('collection:new', () => A.newCollection());
    bus.on('collection:menu', A.collectionMenu);
    bus.on('collection:color', ({ name }) => A.colorDialog(name));
    bus.on('collection:add', ({ name, items }) => A.addToCollection(name, items).then(() => { if (state.view.collection === name) openCollection(name, { keepScroll: true }); }));
    bus.on('collection:renamed', ({ from, to }) => { if (state.lastCollection === from) state.lastCollection = to; if (collectTarget === from) setCollectTarget(to); if (state.view.collection === from) openCollection(to, { keepScroll: true }); });
    bus.on('collection:deleted', name => { if (collectTarget === name) setCollectTarget(null); if (state.view.collection === name) { state.lastCollection = null; showVaultHome(); } });
    bus.on('collect:set', setCollectTarget);
    bus.on('collect:clear', () => setCollectTarget(null));
    bus.on('collect:pick', async () => { const name = await pickDialog({ title: 'Collect into', items: state.collections.map(c => ({ label: c.name, value: c.name, color: c.color, count: c.count })), create: 'New collection' }); if (!name) return; if (typeof name === 'object') { const r = await sv.collections.create(name.create); if (!r.ok) return toast(r.error, { kind: 'error' }); await A.refreshCollections(); setCollectTarget(r.name); } else setCollectTarget(name); });
    bus.on('vault:menu', anchor => menuForVaults(anchor, A.vaultHandlers));
    bus.on('vault:switched', () => {
        setCollectTarget(null);
        let last = null;
        try { last = JSON.parse(localStorage.getItem('sv.lastCollectionByVault') || '{}')[state.vaults.activeVaultId] || null; } catch (e) {}
        state.lastCollection = last && state.collections.some(c => c.name === last) ? last : null;
        refreshColors();
        bus.emit('mode', state.mode);
        if (state.mode === 'vault') { if (state.lastCollection) openCollection(state.lastCollection); else showVaultHome(); }
    });
    bus.on('echo:file', async item => { const { openEchoForFile } = await import('./ui/echo.js'); openEchoForFile(item); });
    bus.on('echo:collect', items => collect(items));
    bus.on('editor:open', openEditor);
    bus.on('drop', async ({ target, paths, source }) => {
        const root = (state.library.root || '').toLowerCase().replace(/[\\/]+$/, '') + '\\';
        const inLib = state.library.root ? paths.filter(p => p.toLowerCase().startsWith(root)) : [];
        const outside = paths.filter(p => !inLib.includes(p));
        if (target.kind === 'folder') {
            // Library files are only MOVED when dropped on an explicit folder in
            // the tree. Dropping them back on the list is almost always an
            // accidental release of a drag-to-DAW, so it is ignored.
            if (inLib.length && source === 'tree') await A.moveFiles(inLib.map(p => ({ path: p, name: p.split(/[\\/]/).pop() })), target.rel);
            else if (inLib.length && !outside.length) toast('Those sounds are already in your library', { icon: 'info' });
            if (outside.length) await A.importPaths(outside, target.rel);
            await reloadTree();
            if (state.view.kind === 'folder') reloadView(true);
        } else if (target.kind === 'collection') {
            let added = inLib;
            if (outside.length) {
                const res = await A.importPaths(outside, 'Imported');
                if (res) added = added.concat(res.imported);
            }
            if (added.length) await A.addToCollection(target.name, added.map(p => ({ path: p, name: p.split(/[\\/]/).pop() })));
            if (state.view.collection === target.name) openCollection(target.name, { keepScroll: true });
        }
    });
    sv.library.onChanged(() => onLibraryChanged());
    sv.collections.onChanged(async () => { await A.refreshCollections(); if (state.view.kind === 'collection') openCollection(state.view.collection, { keepScroll: true }); });
    sv.engine.onStatus(st => {
        const wasReady = state.engine.ready && state.engine.vectors;
        state.engine = st;
        bus.emit('engine', st);
        if (!wasReady && st.ready && st.vectors && state.view.kind === 'collection') loadResonance(state.view.collection);
    });
    sv.settings.onChanged(async s => { state.settings = s; bus.emit('settings', s); state.library = await sv.library.status(); bus.emit('library-status', state.library); await reloadTree(); reloadView(false); });
    document.addEventListener('keydown', onKey);
    document.getElementById('main').addEventListener('scroll', positionSelToolbar, true);
    initBrief();
}

export { playItem, togglePlay, toggleAI, rescan, collect, setCollectTarget };
