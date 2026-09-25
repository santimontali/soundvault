// Sidebar: Sound mode = library folder tree; Vault mode = vault switcher +
// collections. Emits navigation intents on the bus; the app controller acts.
import { h, icon, count } from '../util.js';
import { state, bus, activeVault } from '../store.js';
import { showMenu } from './overlays.js';

const EXPANDED_KEY = 'sv.expanded';
let expanded = new Set();
try { expanded = new Set(JSON.parse(localStorage.getItem(EXPANDED_KEY) || '[]')); } catch (e) { /* private storage */ }
const saveExpanded = () => { try { localStorage.setItem(EXPANDED_KEY, JSON.stringify([...expanded].slice(-400))); } catch (e) {} };

let root = null, tree = null;
const marks = new Map();                // collection name -> classes kept across re-renders

export function mountSidebar(el) {
    root = el;
    bus.on('mode', render);
    bus.on('view', highlight);
    bus.on('tree', t => { tree = t; if (state.mode === 'sounds') render(); });
    bus.on('collections', () => { if (state.mode === 'vault') render(); });
    bus.on('vaults', () => { if (state.mode === 'vault') render(); });
    bus.on('library-status', () => { if (state.mode === 'sounds') renderFoot(); });
    render();
}

function render() {
    if (!root) return;
    root.replaceChildren();
    if (state.mode === 'sounds') renderLibrary(); else renderVault();
    highlight();
}

// ── Sound mode ──────────────────────────────────────────────────────────
function renderLibrary() {
    root.append(
        h('div.sb-head', {},
            h('span.sb-title', { text: 'Library' }),
            h('button.icon-btn.sm', { 'data-tip': 'New folder', 'aria-label': 'New folder', onclick: () => bus.emit('folder:new', state.view.kind === 'folder' ? state.view.folder : '') }, icon('folder-plus')),
            h('button.icon-btn.sm', { style: { marginLeft: '0' }, 'data-tip': 'Import sounds', 'aria-label': 'Import sounds', onclick: () => bus.emit('files:import-dialog') }, icon('import')),
            collapseBtn()),
    );
    const scroll = h('div.sb-scroll', { role: 'tree', 'aria-label': 'Folders' });
    root.appendChild(scroll);
    const t = tree;
    if (!t) { scroll.appendChild(h('div.node.muted', { style: { paddingLeft: '12px' } }, 'Scanning…')); }
    else {
        scroll.appendChild(folderNode({ name: 'All sounds', rel: '', count: t.count, children: [] }, 0, true));
        for (const c of t.children) appendFolder(scroll, c, 0);
        if (!t.children.length && !t.count) scroll.appendChild(h('div.node.muted', { style: { paddingLeft: '12px', cursor: 'default' } }, 'No sounds yet'));
    }
    root.appendChild(h('div.sb-foot', { id: 'sb-foot' }));
    renderFoot();
}

function appendFolder(parent, node, depth) {
    parent.appendChild(folderNode(node, depth));
    if (node.children.length && expanded.has(node.rel)) for (const c of node.children) appendFolder(parent, c, depth + 1);
}

function folderNode(node, depth, isRoot = false) {
    const hasKids = node.children && node.children.length > 0;
    const open = expanded.has(node.rel);
    const tw = h('span.tw' + (hasKids ? '' : '.leaf'), { 'aria-hidden': 'true' }, icon(open ? 'chev-d' : 'chev-r', 'xs'));
    const el = h('div.node', { role: 'treeitem', 'aria-expanded': hasKids ? String(open) : null, tabindex: '-1', dataset: { rel: node.rel, kind: 'folder' }, style: { paddingLeft: (isRoot ? 4 : 4 + depth * 14) + 'px' } },
        isRoot ? h('span.tw.leaf') : tw,
        icon(isRoot ? 'library' : 'folder', 'ico'),
        h('span.name', { text: node.name, title: node.rel || 'Whole library' }),
        h('span.cnt', { text: node.count.toLocaleString('en-US') }));
    tw.addEventListener('mousedown', e => { e.stopPropagation(); if (!hasKids) return; if (open) expanded.delete(node.rel); else expanded.add(node.rel); saveExpanded(); render(); });
    el.addEventListener('click', () => {
        bus.emit('nav:folder', node.rel);
        if (hasKids && !open) { expanded.add(node.rel); saveExpanded(); render(); }
    });
    el.addEventListener('contextmenu', e => { e.preventDefault(); bus.emit('folder:menu', { rel: node.rel, name: node.name, isRoot, x: e.clientX, y: e.clientY }); });
    wireDrop(el, { kind: 'folder', rel: node.rel });
    return el;
}

function renderFoot() {
    const foot = root && root.querySelector('#sb-foot');
    if (!foot) return;
    const lib = state.library;
    foot.replaceChildren(
        icon(lib.exists ? 'folder' : 'warn'),
        h('span.path.ellipsis', { text: lib.root || 'No library folder', title: 'Change library folder…', onclick: () => bus.emit('settings:choose-library') }),
        h('button.icon-btn.sm' + (lib.watching ? '.on' : ''), { 'data-tip': lib.watching ? 'Watching for new files' : 'Folder watcher off', 'aria-label': 'Toggle folder watcher', onclick: () => bus.emit('settings:toggle-watcher') }, icon('eye')),
    );
}

// ── Vault mode ──────────────────────────────────────────────────────────
function renderVault() {
    const v = activeVault();
    const totalSounds = v ? (state.vaults.vaults.find(x => x.id === v.id)?.soundCount ?? 0) : 0;
    const sw = h('div.vault-switch', { role: 'button', tabindex: '0', 'aria-label': 'Switch vault' },
        h('span.dot', { style: { background: v ? v.color : 'var(--accent)' } }),
        h('div', { style: { minWidth: '0', flex: '1' } }, h('div.vs-name.ellipsis', { text: v ? v.name : 'Vault' }), h('div.vs-sub', { text: `${count(state.collections.length, 'collection')} · ${count(totalSounds, 'sound')}` })),
        icon('chev-d', 'sm'));
    sw.addEventListener('click', () => bus.emit('vault:menu', sw));
    sw.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); bus.emit('vault:menu', sw); } });
    // The Brief: the vault's home (its collections; suggestions only when asked for)
    const brief = h('div.node.brief-node', { role: 'button', tabindex: '0', 'aria-label': 'Brief', dataset: { kind: 'brief' } }, icon('board', 'ico'), h('span.name', { text: 'Brief' }));
    brief.addEventListener('click', () => bus.emit('nav:brief'));
    brief.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); bus.emit('nav:brief'); } });
    root.append(sw, brief,
        h('div.sb-head', {},
            h('span.sb-title', { text: 'Collections' }),
            h('button.icon-btn.sm', { 'data-tip': 'New collection', 'aria-label': 'New collection', onclick: () => bus.emit('collection:new') }, icon('plus')),
            collapseBtn()));
    const scroll = h('div.sb-scroll', { role: 'list', 'aria-label': 'Collections' });
    if (!state.collections.length) {
        scroll.appendChild(h('div', { style: { padding: '10px 10px', color: 'var(--fg-3)', fontSize: '12px', lineHeight: '1.5' } },
            'Collections gather sounds from anywhere in your library. Create one, then drag sounds onto it or press ', h('span.kbd', { text: 'C' }), ' while browsing.'));
    }
    for (const c of state.collections) {
        const dot = h('span.col-color' + (c.color ? '' : '.none'), { style: c.color ? { background: c.color } : null, 'data-tip': 'Color', role: 'button', 'aria-label': 'Collection color' });
        const el = h('div.node', { role: 'listitem', tabindex: '-1', dataset: { col: c.name, kind: 'collection' }, style: { paddingLeft: '10px' } },
            dot, h('span.name', { text: c.name }), h('span.cnt', { text: c.count.toLocaleString('en-US') }));
        for (const cls of marks.get(c.name) || []) el.classList.add(cls);
        dot.addEventListener('click', e => { e.stopPropagation(); bus.emit('collection:color', { name: c.name, anchor: dot }); });
        el.addEventListener('click', () => bus.emit('nav:collection', c.name));
        el.addEventListener('contextmenu', e => { e.preventDefault(); bus.emit('collection:menu', { name: c.name, x: e.clientX, y: e.clientY }); });
        wireDrop(el, { kind: 'collection', name: c.name });
        scroll.appendChild(el);
    }
    root.appendChild(scroll);
}

/** The sidebar node of a collection (vault mode), or null. */
export function collectionNode(name) {
    return (root && [...root.querySelectorAll('.node[data-kind="collection"]')].find(n => n.dataset.col === name)) || null;
}

/** Add or remove a class on a collection node that survives re-renders (arriving, landed, bump). */
export function markCollection(name, cls, on = true) {
    let s = marks.get(name);
    if (on) { if (!s) marks.set(name, (s = new Set())); s.add(cls); }
    else if (s) { s.delete(cls); if (!s.size) marks.delete(name); }
    const n = collectionNode(name);
    if (n) n.classList.toggle(cls, on);
}

function collapseBtn() {
    return h('button.icon-btn.sm', { style: { marginLeft: '0' }, 'data-tip': 'Hide sidebar', 'data-kbd': 'Ctrl+B', 'aria-label': 'Hide sidebar', onclick: () => bus.emit('sidebar:toggle') }, icon('sidebar'));
}

// ── active highlight ───────────────────────────────────────────────────
function highlight() {
    if (!root) return;
    const v = state.view;
    for (const n of root.querySelectorAll('.node[data-kind]')) {
        const on = (n.dataset.kind === 'folder' && v.kind === 'folder' && n.dataset.rel === v.folder)
            || (n.dataset.kind === 'collection' && v.kind === 'collection' && n.dataset.col === v.collection)
            || (n.dataset.kind === 'brief' && v.kind === 'brief');
        n.classList.toggle('active', on);
        if (on) n.setAttribute('aria-current', 'true'); else n.removeAttribute('aria-current');
    }
}

/** Reveal a folder in the tree (expand ancestors), used by "Show in folder". */
export function revealFolder(rel) {
    const parts = String(rel || '').split('/').filter(Boolean);
    let acc = '';
    for (const p of parts.slice(0, -1)) { acc = acc ? acc + '/' + p : p; expanded.add(acc); }
    if (parts.length > 1) { saveExpanded(); if (state.mode === 'sounds') render(); }
    requestAnimationFrame(() => { const n = root && root.querySelector(`.node[data-rel="${CSS.escape(rel)}"]`); if (n) n.scrollIntoView({ block: 'nearest' }); });
}

// ── drop targets (files from Explorer or rows dragged out of the list) ──
function wireDrop(el, target) {
    let depth = 0;
    el.addEventListener('dragenter', e => { if (!hasFiles(e)) return; e.preventDefault(); depth++; el.classList.add('drop-target'); });
    el.addEventListener('dragover', e => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
    el.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) el.classList.remove('drop-target'); });
    el.addEventListener('drop', e => {
        if (!hasFiles(e)) return;
        e.preventDefault(); e.stopPropagation();
        depth = 0; el.classList.remove('drop-target');
        const paths = [...e.dataTransfer.files].map(f => window.sv.pathForFile(f)).filter(Boolean);
        if (paths.length) bus.emit('drop', { target, paths, source: 'tree' });
    });
}
const hasFiles = e => e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');

export function menuForVaults(anchor, handlers) {
    const items = [{ header: 'Vaults' }];
    for (const v of state.vaults.vaults) items.push({ label: v.name, color: v.color, checked: v.id === state.vaults.activeVaultId, onClick: () => handlers.switch(v.id) });
    items.push('sep',
        { label: 'New vault…', icon: 'plus', onClick: handlers.create },
        { label: 'Edit vault…', icon: 'pencil', onClick: handlers.edit },
        { label: 'Duplicate vault', icon: 'collection', onClick: handlers.duplicate },
        { label: 'Delete vault…', icon: 'trash', danger: true, disabled: state.vaults.vaults.length <= 1, onClick: handlers.remove });
    showMenu(anchor, items);
}
