// Review sheet for the Brief: every candidate of a suggestion (or every sound
// suggested for an existing collection) in a keyboard-first drawer, the same
// pattern as Echo. ↑/↓ move · Space plays · Enter keeps or drops · Del drops ·
// Ctrl+Enter confirms · Esc closes. Everything starts selected.
import { h, icon, count, stripExt, clamp } from '../util.js';
import { state, bus } from '../store.js';
import { player } from '../audio/engine.js';
import { relDir } from './list.js';
import { isDialogOpen } from './overlays.js';
import { miniWave, durationOf, audition, paintPlaying, sweep } from './audition.js';

let root = null, scrim = null, els = {};
let R = null;          // { opts, items, kept: Set<path>, cursor, rows }

function mount() {
    if (root) return;
    scrim = h('div.rv-scrim');
    root = h('aside.rv', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Review' });
    document.body.append(scrim, root);
    scrim.addEventListener('mousedown', () => closeReview());
    root.addEventListener('keydown', onKey);
    // Esc closes the sheet even when the focus has wandered off (menus and dialogs close first).
    document.addEventListener('keydown', e => { if (R && e.key === 'Escape' && !e.defaultPrevented && !isDialogOpen()) { e.preventDefault(); closeReview(); } });
    player.on('state', () => { if (R) paintPlaying(els.list); });
}

export const isReviewOpen = () => !!R;

/**
 * opts: {
 *   title, color (hex or null), items: Sound[],
 *   reasons?: Node[] (chips under the title) or note?: string,
 *   listLabel, noun ('candidate' | 'sound'),
 *   confirm: n => button label, onConfirm: items => void, opener?: Element (gets focus back)
 * }
 */
export function openReview(opts) {
    mount();
    const items = opts.items.slice();
    R = { opts, items, kept: new Set(items.map(it => it.path)), cursor: 0, rows: [] };
    const sub = h('div.rv-sub');
    const list = h('div.rv-list', { tabindex: '0', role: 'listbox', 'aria-multiselectable': 'true', 'aria-label': opts.listLabel });
    const go = h('button.btn.primary', { 'data-tip': 'Confirm', 'data-kbd': 'Ctrl+Enter', onclick: () => confirm() });
    root.style.setProperty('--rv-color', opts.color || 'transparent');
    root.setAttribute('aria-label', `Review ${opts.title}`);
    root.replaceChildren(
        h('div.rv-head', {}, h('span.c-color' + (opts.color ? '' : '.none')), h('h3', { text: opts.title, title: opts.title }),
            h('button.icon-btn', { 'aria-label': 'Close', 'data-tip': 'Close', 'data-kbd': 'Esc', onclick: () => closeReview() }, icon('x'))),
        sub,
        opts.reasons ? h('div.rv-why', {}, ...opts.reasons) : h('div.rv-why.note', { text: opts.note || '' }),
        h('div.rv-tools', {}, h('span', { text: opts.listLabel }), h('span.grow'),
            h('button.btn.sm.ghost', { text: 'Select all', onclick: () => setAll(true) }),
            h('button.btn.sm.ghost', { text: 'Clear', onclick: () => setAll(false) })),
        list,
        h('div.rv-foot', {}, legend(), go));
    els = { sub, list, go };
    R.rows = items.map((it, i) => row(it, i));
    list.append(...R.rows);
    sweep();
    paint();
    paintPlaying(list);
    requestAnimationFrame(() => { root.classList.add('open'); scrim.classList.add('show'); });
    setTimeout(() => { if (R) list.focus({ preventScroll: true }); }, 60);
}

export function closeReview({ restoreFocus = true } = {}) {
    if (!R) return;
    const opener = R.opts.opener;
    R = null;
    root.classList.remove('open');
    scrim.classList.remove('show');
    if (restoreFocus && opener && opener.isConnected) opener.focus({ preventScroll: true });
}

function legend() {
    const k = t => h('span.kbd', { text: t });
    return h('div.keys', { 'aria-hidden': 'true' },
        k('↑'), k('↓'), h('span', { text: 'Move' }), h('span.gap'),
        k('Space'), h('span', { text: 'Play' }), h('span.gap'),
        k('Enter'), h('span', { text: 'Keep or drop' }), h('span.gap'),
        k('Del'), h('span', { text: 'Drop' }));
}

function row(it, i) {
    const ck = h('span.ck', { 'aria-hidden': 'true' }, icon('check'));
    const pb = h('button.pb', { tabindex: '-1', 'aria-label': 'Play' }, icon('play', 'pb-i'));
    const du = h('span.du');
    const name = stripExt(it.name);
    const el = h('div.rr.aud', { role: 'option', id: 'rv-o' + i, 'aria-selected': 'true', 'aria-label': name }, ck, pb,
        h('div.mt', {}, h('div.nm', { text: name, title: name }), h('div.dir', { text: relDir(it.dir || '', '') || 'Library root' })),
        miniWave(it, pk => { du.textContent = durationOf(pk); }), du);
    el._item = it;
    ck.addEventListener('click', e => { e.stopPropagation(); setCursor(i); setKeep(i); });
    pb.addEventListener('click', e => { e.stopPropagation(); setCursor(i); audition(it); });
    el.addEventListener('click', () => { setCursor(i); audition(it); els.list.focus({ preventScroll: true }); });
    return el;
}

function paint() {
    if (!R) return;
    const n = R.kept.size;
    els.sub.replaceChildren(document.createTextNode(`${count(R.items.length, R.opts.noun || 'candidate')} · `), h('b', { text: String(n) }), document.createTextNode(' selected'));
    els.go.textContent = R.opts.confirm(n);
    els.go.disabled = !n;
    R.rows.forEach((el, i) => {
        const kept = R.kept.has(R.items[i].path);
        el.classList.toggle('kept', kept);
        el.classList.toggle('cursor', i === R.cursor);
        el.setAttribute('aria-selected', String(kept));
    });
    els.list.setAttribute('aria-activedescendant', 'rv-o' + R.cursor);
}

function setCursor(i) {
    R.cursor = clamp(i, 0, R.items.length - 1);
    const el = R.rows[R.cursor];
    if (el) el.scrollIntoView({ block: 'nearest' });
    paint();
}

/** Something from this sheet is playing (moving the cursor keeps auditioning). */
const auditioning = () => player.playing && R.items.some(it => player.isCurrent(it.path));

function move(to) {
    const i = clamp(to, 0, R.items.length - 1);
    if (i === R.cursor) return;
    const follow = auditioning() || state.settings?.autoPlay;
    setCursor(i);
    if (follow) bus.emit('play:item', R.items[i]);
}

function setKeep(i, keep, advance = false) {
    const p = R.items[i].path;
    if (keep === undefined) keep = !R.kept.has(p);
    if (keep) R.kept.add(p); else R.kept.delete(p);
    if (advance && i < R.items.length - 1) move(i + 1);
    paint();
}

function setAll(on) {
    R.kept = on ? new Set(R.items.map(it => it.path)) : new Set();
    paint();
}

async function confirm() {
    if (!R || !R.kept.size) return;
    const items = R.items.filter(it => R.kept.has(it.path));
    const { onConfirm } = R.opts;
    closeReview({ restoreFocus: false });
    await new Promise(r => setTimeout(r, matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 280));   // the sheet slides out first
    onConfirm(items);
}

function onKey(e) {
    if (!R) return;
    const k = e.key;
    if (k === 'Escape') { e.preventDefault(); e.stopPropagation(); closeReview(); return; }
    if (k === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); e.stopPropagation(); confirm(); return; }
    // Buttons keep their own Enter / Space; the list takes the rest.
    if (e.target !== els.list && !(e.target.closest && e.target.closest('.rr'))) return;
    if (k === 'ArrowDown' || k === 'ArrowUp') move(R.cursor + (k === 'ArrowDown' ? 1 : -1));
    else if (k === 'Home' || k === 'End') move(k === 'Home' ? 0 : R.items.length - 1);
    else if (k === 'PageDown' || k === 'PageUp') move(R.cursor + (k === 'PageDown' ? 8 : -8));
    else if (k === ' ') audition(R.items[R.cursor]);
    else if (k === 'Enter') setKeep(R.cursor, undefined, true);
    else if (k === 'Delete' || k === 'Backspace') setKeep(R.cursor, false, true);
    else if ((k === 'a' || k === 'A') && (e.ctrlKey || e.metaKey)) setAll(true);
    else return;
    e.preventDefault();
    e.stopPropagation();
}
