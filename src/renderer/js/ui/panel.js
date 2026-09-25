// Main panel chrome: header (breadcrumbs, count, sort, actions), banners
// (collect target, missing files, library missing), empty states, drop zone,
// the loading stand-in and the Resonance suggestions strip for collections.
import { h, icon, count, stripExt, fill } from '../util.js';
import { state, bus, activeVault } from '../store.js';
import { showMenu } from './overlays.js';
import { list } from './list.js';
import { player } from '../audio/engine.js';

let els = {};
let lastHeader = null;
/** Re-render the header (e.g. after the sidebar is shown/hidden). */
export function refreshHeader() { if (lastHeader) renderHeader(lastHeader); }

// Stand-in rows: the list's own grid and row height, so the real rows take their place without a jump.
const NAME_W = [44, 31, 52, 38, 27, 47, 35], SUB_W = [24, 17, 30, 21, 14], DUR_W = [34, 28, 38, 30];
const skelRow = i => h('div.sk-row', {}, h('i.sk-pb'), h('div.sk-meta', {}, h('i', { style: { width: NAME_W[i % 7] + '%' } }), h('i.sub', { style: { width: SUB_W[i % 5] + '%' } })), h('i.sk-wf'), h('i.sk-du', { style: { width: DUR_W[i % 4] + 'px' } }));

export function mountPanel(main) {
    const crumbs = h('div.crumbs');
    const actions = h('div.head-actions');
    const head = h('div.panel-head', {}, crumbs, actions);
    const banners = h('div.banners');
    const listEl = h('div.list', { 'aria-label': 'Sounds' });
    const empty = h('div.list-empty.hidden');
    const drop = h('div.dropzone', {}, h('div.t'), h('div.s'));
    const skel = h('div.skel', { 'aria-hidden': 'true' }, ...Array.from({ length: 18 }, (_, i) => skelRow(i)));
    const wrap = h('div', { style: { position: 'relative', flex: '1', minHeight: '0', display: 'flex', flexDirection: 'column' } }, listEl, empty, drop, skel);
    const reso = h('div.resonance.hidden', {}, h('div.rs-head', {}, icon('resonance'), h('span.rs-t', { text: 'Resonance' }), h('span.muted.rs-c'), icon('chev-d', 'sm chev')), h('div.rs-list'));
    main.append(head, banners, wrap, reso);
    els = { main, crumbs, actions, head, banners, listEl, empty, drop, wrap, reso };
    reso.querySelector('.rs-head').addEventListener('click', () => { reso.classList.toggle('open'); try { localStorage.setItem('sv.resoOpen', reso.classList.contains('open') ? '1' : '0'); } catch (e) {} });
    try { if (localStorage.getItem('sv.resoOpen') !== '0') reso.classList.add('open'); } catch (e) { reso.classList.add('open'); }
    wireDropZone(wrap);
    list.on('items', () => renderEmpty());
    return listEl;
}

// ── header ──────────────────────────────────────────────────────────────
export function renderHeader({ crumbs = [], title = '', countText = '', actions = [] }) {
    els.crumbs.replaceChildren();
    if (document.getElementById('app').classList.contains('sidebar-collapsed')) {
        els.crumbs.append(h('button.icon-btn.sm', { style: { alignSelf: 'center', marginRight: '4px' }, 'data-tip': 'Show sidebar', 'data-kbd': 'Ctrl+B', 'aria-label': 'Show sidebar', onclick: () => bus.emit('sidebar:toggle') }, icon('sidebar')));
    }
    for (const c of crumbs) {
        els.crumbs.append(h('span.crumb', { text: c.label, onclick: c.onClick }), h('span.sep', { text: '›' }));
    }
    els.crumbs.append(h('h1', { text: title, title }));
    if (countText) els.crumbs.append(h('span.count', { text: countText }));
    lastHeader = { crumbs, title, countText, actions };
    els.actions.replaceChildren(...actions.filter(Boolean));
}

export function sortButton() {
    const labels = { name: 'Name', date: 'Newest', size: 'Size', path: 'Folder' };
    const b = h('button.btn', { 'data-tip': 'Sort' }, icon('sort'), labels[state.view.sort] || 'Name');
    b.addEventListener('click', () => showMenu(b, [
        { header: 'Sort by' },
        ...Object.entries(labels).map(([k, l]) => ({ label: l, checked: state.view.sort === k, onClick: () => bus.emit('view:sort', k) })),
        'sep',
        { label: 'Include subfolders', checked: state.view.recursive, onClick: () => bus.emit('view:recursive', !state.view.recursive) },
    ]));
    return b;
}

export const actionBtn = (ic, label, onClick, tip) => h('button.btn', { 'data-tip': tip || null, onclick: onClick }, icon(ic), label);
export const iconAction = (ic, tip, onClick, kbd) => h('button.icon-btn', { 'data-tip': tip, 'data-kbd': kbd || null, 'aria-label': tip, onclick: onClick }, icon(ic));

// ── banners ─────────────────────────────────────────────────────────────
const bannerMap = new Map();
export function setBanner(id, node) {
    const prev = bannerMap.get(id);
    if (prev) prev.remove();
    if (node) { bannerMap.set(id, node); els.banners.appendChild(node); } else bannerMap.delete(id);
}

export function renderCollectBar(target) {
    if (!target) return setBanner('collect', null);
    const v = activeVault();
    setBanner('collect', h('div.banner.accent', {},
        h('span.dot', { style: { background: v ? v.color : 'var(--accent)' } }),
        h('span.grow.ellipsis', {}, 'Collecting into ', h('b', { text: target }), h('span.muted', { text: `  ·  press C to add the focused sound (${v ? v.name : 'vault'})` })),
        h('button.btn.sm', { text: 'Change', onclick: () => bus.emit('collect:pick') }),
        h('button.icon-btn.sm', { 'aria-label': 'Stop collecting', 'data-tip': 'Stop collecting', onclick: () => bus.emit('collect:clear') }, icon('x', 'sm'))));
}

// ── loading ─────────────────────────────────────────────────────────────
/** While a view's sounds load after a mode switch: the header in place, stand-in rows below. */
export function setLoading(on) { els.main.classList.toggle('loading', !!on); }

// ── empty states ────────────────────────────────────────────────────────
let emptyContent = null;
export function setEmpty(content) { emptyContent = content; renderEmpty(); }
function renderEmpty() {
    const show = !list.items.length && emptyContent;
    els.empty.classList.toggle('hidden', !show);
    if (!show) return;
    const c = emptyContent;
    fill(els.empty,
        c.art ? c.art() : icon(c.icon || 'library', 'art'),
        h('h2', { text: c.title }),
        c.text ? h('p', { text: c.text }) : null,
        c.actions && c.actions.length ? h('div.actions', {}, ...c.actions) : null);
}

// ── drop zone (Explorer → library / collection) ─────────────────────────
function wireDropZone(wrap) {
    let depth = 0;
    const has = e => e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');
    wrap.addEventListener('dragenter', e => {
        if (!has(e)) return;
        e.preventDefault(); depth++;
        const t = dropTarget();
        els.drop.classList.add('show');
        els.drop.classList.toggle('disabled', !t.ok);
        els.drop.querySelector('.t').textContent = t.title;
        els.drop.querySelector('.s').textContent = t.sub;
    });
    wrap.addEventListener('dragover', e => { if (!has(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = dropTarget().ok ? 'copy' : 'none'; });
    wrap.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) els.drop.classList.remove('show'); });
    wrap.addEventListener('drop', e => {
        if (!has(e)) return;
        e.preventDefault(); depth = 0; els.drop.classList.remove('show');
        const t = dropTarget();
        if (!t.ok) return;
        const paths = [...e.dataTransfer.files].map(f => window.sv.pathForFile(f)).filter(Boolean);
        if (paths.length) bus.emit('drop', { target: t.target, paths });
    });
}

function dropTarget() {
    const v = state.view;
    if (!state.library.exists) return { ok: false, title: 'Library folder not found', sub: 'Choose a library folder in Settings first' };
    if (v.kind === 'collection') return { ok: true, target: { kind: 'collection', name: v.collection }, title: `Add to “${v.collection}”`, sub: 'Sounds outside the library are imported first' };
    if (v.kind === 'folder') return { ok: true, target: { kind: 'folder', rel: v.folder }, title: 'Drop sounds or folders', sub: `Copied into ${v.folder ? '“' + v.folder.split('/').pop() + '”' : 'the library root'} · existing files are never overwritten` };
    if (state.mode === 'sounds') return { ok: true, target: { kind: 'folder', rel: '' }, title: 'Drop sounds or folders', sub: 'Copied into the library root' };
    return { ok: false, title: 'Open a collection or folder first', sub: 'Then drop sounds here' };
}

// ── Resonance (collection suggestions) ──────────────────────────────────
export function renderResonance(items, collection) {
    const r = els.reso;
    if (!items || !items.length || !collection) { r.classList.add('hidden'); return; }
    r.classList.remove('hidden');
    r.querySelector('.rs-c').textContent = `· ${items.length} sounds that fit “${collection}”`;
    const listEl = r.querySelector('.rs-list');
    listEl.replaceChildren(...items.map(it => {
        const add = h('button.add', { 'aria-label': 'Add to collection', 'data-tip': `Add to “${collection}”` }, icon('plus', 'sm'));
        const el = h('div.rs-item' + (player.isCurrent(it.path) ? '.playing' : ''), { title: it.dir ? it.dir + '/' + it.name : it.name }, icon('play', 'xs'), h('span.n', { text: stripExt(it.name) }), add);
        el.addEventListener('click', e => { if (e.target.closest('.add')) return; bus.emit('play:item', it); });
        add.addEventListener('click', e => { e.stopPropagation(); bus.emit('collection:add', { name: collection, items: [it] }); el.remove(); });
        return el;
    }));
}
export const countText = (n, noun = 'sound') => count(n, noun);
