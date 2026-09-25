// Dialogs, menus, toasts and tooltips, all keyboard-accessible, no native
// confirm()/alert(), no innerHTML with user data.
import { h, icon, clamp, fill } from '../util.js';

const layer = () => document.getElementById('layer-overlays');
let openDialogs = 0;
export const isDialogOpen = () => openDialogs > 0 || !!document.querySelector('.menu');

function trapFocus(root, e) {
    if (e.key !== 'Tab') return;
    const f = [...root.querySelectorAll('button, input, textarea, [tabindex]:not([tabindex="-1"])')].filter(x => !x.disabled && x.offsetParent !== null);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { last.focus(); e.preventDefault(); }
    else if (!e.shiftKey && document.activeElement === last) { first.focus(); e.preventDefault(); }
}

/**
 * Generic modal. `build(close)` returns { body, footer, initialFocus, onEnter }.
 * Resolves with whatever `close(value)` receives (undefined on Esc / backdrop).
 */
export function modal({ title, icon: ic, wide = false, cls = '' }, build) {
    return new Promise(resolve => {
        const prevFocus = document.activeElement;
        let done = false;
        const scrim = h('div.scrim');
        const dlg = h('div.dialog' + (wide ? '.wide' : '') + (cls ? '.' + cls : ''), { role: 'dialog', 'aria-modal': 'true', 'aria-label': title });
        const close = v => {
            if (done) return; done = true; openDialogs--;
            scrim.remove(); document.removeEventListener('keydown', onKey, true);
            if (prevFocus && prevFocus.focus) prevFocus.focus();
            resolve(v);
        };
        const parts = build(close);
        fill(dlg,                                           // body and footer are optional (a picker has no footer)
            h('div.dlg-head', {}, ic ? icon(ic) : null, h('h3', { text: title }), h('button.icon-btn.sm', { 'aria-label': 'Close', onclick: () => close(undefined) }, icon('x'))),
            parts.body ? h('div.dlg-body', {}, parts.body) : null,
            parts.footer ? h('div.dlg-foot', {}, parts.footer) : null,
        );
        scrim.appendChild(dlg);
        scrim.addEventListener('mousedown', e => { if (e.target === scrim) close(undefined); });
        const onKey = e => {
            if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); close(undefined); return; }
            if (e.key === 'Enter' && parts.onEnter && !(e.target.tagName === 'TEXTAREA' && !e.ctrlKey)) { e.preventDefault(); e.stopPropagation(); parts.onEnter(); return; }
            trapFocus(dlg, e);
            e.stopPropagation();
        };
        document.addEventListener('keydown', onKey, true);
        openDialogs++;
        layer().appendChild(scrim);
        requestAnimationFrame(() => { const f = parts.initialFocus || dlg.querySelector('.dlg-foot .primary, .dlg-foot .danger') || dlg; f.focus && f.focus(); if (f.select) f.select(); });
    });
}

export function confirmDialog({ title, message, detail, confirm = 'OK', cancel = 'Cancel', danger = false }) {
    return modal({ title, icon: danger ? 'warn' : 'info' }, close => {
        const ok = h('button.btn' + (danger ? '.danger' : '.primary'), { text: confirm, onclick: () => close(true) });
        return {
            body: [h('p', { text: message }), detail ? h('p.muted', { text: detail }) : null],
            footer: [h('button.btn', { text: cancel, onclick: () => close(false) }), ok],
            initialFocus: ok,
            onEnter: () => close(true),
        };
    }).then(v => v === true);
}

export function promptDialog({ title, label, value = '', placeholder = '', confirm = 'OK', validate = null, multiline = false }) {
    return modal({ title, icon: 'pencil' }, close => {
        const input = multiline ? h('textarea.input', { placeholder, spellcheck: 'false' }) : h('input.input', { type: 'text', placeholder, spellcheck: 'false', maxlength: '200' });
        input.value = value;
        const err = h('div.err');
        const submit = () => {
            const v = input.value.trim();
            const e = !v ? 'Required' : validate ? validate(v) : null;
            if (e) { err.textContent = e; input.focus(); return; }
            close(v);
        };
        input.addEventListener('input', () => { err.textContent = ''; });
        return {
            body: [h('div.field', {}, label ? h('label', { text: label }) : null, input), err],
            footer: [h('button.btn', { text: 'Cancel', onclick: () => close(null) }), h('button.btn.primary', { text: confirm, onclick: submit })],
            initialFocus: input,
            onEnter: submit,
        };
    }).then(v => (typeof v === 'string' ? v : null));
}

/**
 * Pick from a list with type-to-filter.
 * items: [{label, value, color?, count?}] · create: label for "+ New …" (returns {create: name})
 */
export function pickDialog({ title, items, create = null, placeholder = 'Filter…' }) {
    return modal({ title, icon: 'collection' }, close => {
        const input = h('input.input', { type: 'text', placeholder, spellcheck: 'false' });
        const list = h('div.pick-list', { role: 'listbox' });
        let kb = 0, shown = [];
        const render = () => {
            const q = input.value.trim().toLowerCase();
            shown = items.filter(it => !q || it.label.toLowerCase().includes(q));
            const exact = items.some(it => it.label.toLowerCase() === q);
            list.replaceChildren(...shown.map((it, i) => h('div.pick-item' + (i === kb ? '.kb' : ''), { role: 'option', onclick: () => close(it.value) },
                it.color !== undefined ? h('span.dot', { style: { background: it.color || 'var(--bg-4)' } }) : null,
                h('span.n', { text: it.label }), it.count !== undefined ? h('span.c', { text: String(it.count) }) : null)));
            if (create && q && !exact) list.appendChild(h('div.pick-item' + (kb === shown.length ? '.kb' : ''), { onclick: () => close({ create: input.value.trim() }) }, icon('plus'), h('span.n', { text: `${create} “${input.value.trim()}”` })));
            else if (create && !q) list.appendChild(h('div.pick-item.muted', { onclick: () => input.focus() }, icon('plus'), h('span.n', { text: `Type a name to create a new ${create.toLowerCase().replace(/^new /, '')}` })));
        };
        input.addEventListener('input', () => { kb = 0; render(); });
        input.addEventListener('keydown', e => {
            const max = shown.length + (create && input.value.trim() ? 1 : 0) - 1;
            if (e.key === 'ArrowDown') { kb = clamp(kb + 1, 0, Math.max(0, max)); render(); e.preventDefault(); }
            if (e.key === 'ArrowUp') { kb = clamp(kb - 1, 0, Math.max(0, max)); render(); e.preventDefault(); }
        });
        render();
        return {
            body: [input, list],
            initialFocus: input,
            onEnter: () => {
                if (kb < shown.length) close(shown[kb].value);
                else if (create && input.value.trim()) close({ create: input.value.trim() });
            },
        };
    });
}

// ── Context menu ───────────────────────────────────────────────────────
// A menu opened from a button belongs to it: the same button closes it again
// (aria-expanded follows), a press anywhere else closes it.
let activeMenu = null, activeAnchor = null;
export function closeMenu() {
    if (!activeMenu) return;
    activeMenu.remove(); activeMenu = null;
    if (activeAnchor) activeAnchor.setAttribute('aria-expanded', 'false');
    activeAnchor = null;
    document.removeEventListener('keydown', menuKeys, true);
}
function menuKeys(e) {
    if (!activeMenu) return;
    const items = [...activeMenu.querySelectorAll('.mi:not(.disabled)')];
    let i = items.findIndex(x => x.classList.contains('kb'));
    if (e.key === 'Escape') { closeMenu(); e.preventDefault(); e.stopPropagation(); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        i = e.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
        items.forEach(x => x.classList.remove('kb')); items[i].classList.add('kb');
        e.preventDefault(); e.stopPropagation();
    }
    if (e.key === 'Enter' && i >= 0) { items[i].click(); e.preventDefault(); e.stopPropagation(); }
}

/**
 * items: [{label, icon, kbd, onClick, danger, disabled, checked}] | 'sep' | {header}
 * `at` = {x, y} or an element to anchor below (a toggle: calling it again for
 * the same element closes the menu and returns null).
 */
export function showMenu(at, items) {
    const anchor = at instanceof Element ? at : null;
    if (anchor && activeMenu && activeAnchor === anchor) { closeMenu(); return null; }
    closeMenu();
    const m = h('div.menu', { role: 'menu' });
    for (const it of items) {
        if (!it) continue;
        if (it === 'sep') { m.appendChild(h('div.sep')); continue; }
        if (it.header) { m.appendChild(h('div.hd', {}, h('span', { text: it.header }), it.graphic || null)); continue; }
        const row = h('div.mi' + (it.danger ? '.danger' : '') + (it.disabled ? '.disabled' : '') + (it.checked ? '.checked' : ''), { role: 'menuitem' },
            it.graphic ? it.graphic : it.color !== undefined ? h('span.dot', { style: { background: it.color || 'var(--bg-4)' } }) : it.icon ? icon(it.icon) : h('span', { style: { width: '16px' } }),
            h('span.n', { text: it.label }), it.kbd ? h('span.k', { text: it.kbd }) : null);
        row.addEventListener('click', e => { e.stopPropagation(); closeMenu(); it.onClick && it.onClick(); });
        m.appendChild(row);
    }
    document.body.appendChild(m);
    const r = m.getBoundingClientRect();
    let x, y;
    if (at instanceof Element) { const a = at.getBoundingClientRect(); x = a.left; y = a.bottom + 4; if (x + r.width > innerWidth - 8) x = a.right - r.width; }
    else { x = at.x; y = at.y; }
    m.style.left = clamp(x, 8, innerWidth - r.width - 8) + 'px';
    m.style.top = (y + r.height > innerHeight - 8 ? Math.max(8, y - r.height) : y) + 'px';
    activeMenu = m;
    activeAnchor = anchor;
    if (anchor) { anchor.setAttribute('aria-haspopup', 'menu'); anchor.setAttribute('aria-expanded', 'true'); }
    document.addEventListener('keydown', menuKeys, true);
    return m;
}
// A press on the menu's own button is left to its click, which closes the menu (toggle).
document.addEventListener('mousedown', e => { if (activeMenu && !activeMenu.contains(e.target) && !(activeAnchor && activeAnchor.contains(e.target))) closeMenu(); }, true);
window.addEventListener('blur', closeMenu);
window.addEventListener('resize', closeMenu);

// ── Toasts ─────────────────────────────────────────────────────────────
/** toast('Imported 12 sounds', {kind:'ok'|'error'|'warn', action:{label,onClick} | actions:[{label,onClick}], timeout, progress}) */
export function toast(message, opts = {}) {
    const root = document.getElementById('toasts');
    const kindIcon = opts.kind === 'error' ? 'warn' : opts.kind === 'warn' ? 'warn' : opts.icon || 'check';
    const msg = h('span.msg', { text: message });
    const bar = opts.progress !== undefined ? h('span.progress', {}, h('i')) : null;
    const actions = opts.actions || (opts.action ? [opts.action] : []);
    const el = h('div.toast' + (opts.kind ? '.' + opts.kind : ''), { role: 'status' }, icon(kindIcon), msg, bar,
        ...actions.map(a => h('button.act', { text: a.label, onclick: () => { a.onClick(); close(); } })));
    root.appendChild(el);
    while (root.children.length > 4) root.firstChild.remove();
    let timer = null;
    const close = () => { clearTimeout(timer); el.classList.add('out'); setTimeout(() => el.remove(), 220); };
    const arm = ms => { clearTimeout(timer); if (ms > 0) timer = setTimeout(close, ms); };
    arm(opts.timeout ?? (actions.length ? 6000 : 2600));
    const handle = {
        update(text, pct, ms) { if (text) msg.textContent = text; if (bar && pct !== undefined) bar.firstChild.style.width = clamp(pct, 0, 100) + '%'; if (ms !== undefined) arm(ms); },
        close,
    };
    if (bar) handle.update(null, opts.progress);
    return handle;
}

// ── Tooltips (data-tip / data-kbd attributes, delegated) ───────────────
let tipEl = null, tipTimer = null, tipFor = null;
function hideTip() { clearTimeout(tipTimer); tipFor = null; if (tipEl) { tipEl.remove(); tipEl = null; } }
document.addEventListener('mouseover', e => {
    const t = e.target.closest && e.target.closest('[data-tip]');
    if (t === tipFor) return;
    hideTip();
    if (!t) return;
    tipFor = t;
    tipTimer = setTimeout(() => {
        if (!t.isConnected) return;
        tipEl = h('div.tip', {}, t.dataset.tip, t.dataset.kbd ? h('span.kbd', { text: t.dataset.kbd }) : null);
        document.body.appendChild(tipEl);
        const a = t.getBoundingClientRect(), r = tipEl.getBoundingClientRect();
        let top = a.bottom + 6;
        if (top + r.height > innerHeight - 6) top = a.top - r.height - 6;
        tipEl.style.left = clamp(a.left + a.width / 2 - r.width / 2, 6, innerWidth - r.width - 6) + 'px';
        tipEl.style.top = top + 'px';
    }, 450);
});
document.addEventListener('mousedown', hideTip, true);
document.addEventListener('wheel', hideTip, { passive: true, capture: true });
