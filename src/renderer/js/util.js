// Small, dependency-free helpers shared by all renderer modules.

/** Hyperscript-style element builder. Text is always set via textContent (no HTML injection). */
export function h(tag, props = {}, ...children) {
    const [name, ...classes] = tag.split('.');
    const el = document.createElement(name || 'div');
    if (classes.length) el.className = classes.join(' ');
    for (const [k, v] of Object.entries(props || {})) {
        if (v === undefined || v === null || v === false) continue;
        if (k === 'class') el.className += (el.className ? ' ' : '') + v;
        else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
        else if (k === 'dataset') Object.assign(el.dataset, v);
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (k === 'text') el.textContent = v;
        else if (v === true) el.setAttribute(k, '');
        else el.setAttribute(k, v);
    }
    for (const c of children.flat()) {
        if (c === null || c === undefined || c === false) continue;
        el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
/** <svg class="i"><use href="#i-name"/></svg> */
export function icon(name, cls = '') {
    const s = document.createElementNS(SVG_NS, 'svg');
    s.setAttribute('class', 'i' + (cls ? ' ' + cls : ''));
    s.setAttribute('aria-hidden', 'true');
    const u = document.createElementNS(SVG_NS, 'use');
    u.setAttribute('href', '#i-' + name);
    s.appendChild(u);
    return s;
}

export function setIcon(svg, name) {
    const u = svg && svg.querySelector('use');
    if (u && u.getAttribute('href') !== '#i-' + name) u.setAttribute('href', '#i-' + name);
}

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const $ = (sel, root = document) => root.querySelector(sel);

/**
 * Duration for humans. Sub-second sounds matter (half of a pro library):
 *   0.042 → "42 ms", 0.42 → "0.42 s", 4.8 → "4.8 s", 75 → "1:15", 3725 → "1:02:05"
 */
export function formatDuration(s) {
    if (!Number.isFinite(s) || s < 0) return '-';
    if (s < 0.1) return Math.max(1, Math.round(s * 1000)) + ' ms';
    if (s < 1) return s.toFixed(2) + ' s';
    if (s < 10) return s.toFixed(1) + ' s';
    if (s < 60) return Math.round(s) + ' s';
    const t = Math.round(s), hh = Math.floor(t / 3600), mm = Math.floor((t % 3600) / 60), ss = t % 60;
    return (hh ? hh + ':' + String(mm).padStart(2, '0') : mm) + ':' + String(ss).padStart(2, '0');
}

/** Playback clock: 0:04.2 / 1:15.0 (tenths while short). */
export function formatClock(s, total = s) {
    if (!Number.isFinite(s) || s < 0) s = 0;
    const m = Math.floor(s / 60), sec = s - m * 60;
    if (total < 600) return m + ':' + sec.toFixed(1).padStart(4, '0');
    return m + ':' + String(Math.floor(sec)).padStart(2, '0');
}

export function formatBytes(n) {
    if (!Number.isFinite(n)) return '';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
    if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';
}

export function formatFormat(p) {
    if (!p || !p.sampleRate) return '';
    const khz = p.sampleRate % 1000 === 0 ? p.sampleRate / 1000 : (p.sampleRate / 1000).toFixed(1);
    const ch = p.channels === 1 ? 'Mono' : p.channels === 2 ? 'Stereo' : p.channels ? p.channels + ' ch' : '';
    const bits = p.bits ? (p.format === 3 ? p.bits + '-bit float' : p.bits + '-bit') : '';
    return [khz + ' kHz', bits, ch].filter(Boolean).join(' · ');
}

export const count = (n, one, many = one + 's') => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
export const baseName = p => String(p || '').split(/[\\/]/).pop();
export const stripExt = n => String(n || '').replace(/\.wav$/i, '');

export function debounce(fn, ms) {
    let t = null;
    const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
    d.cancel = () => clearTimeout(t);
    d.flush = (...a) => { clearTimeout(t); fn(...a); };
    return d;
}

export function throttleRaf(fn) {
    let queued = false, lastArgs;
    return (...a) => { lastArgs = a; if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; fn(...lastArgs); }); };
}

export function hexToRgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    const n = m ? parseInt(m[1], 16) : 0xc8f76d;
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function isEditableTarget(t) {
    return !!(t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)));
}

/** Tiny event emitter for module-to-module notifications. */
export class Emitter {
    constructor() { this._m = new Map(); }
    on(ev, fn) { if (!this._m.has(ev)) this._m.set(ev, new Set()); this._m.get(ev).add(fn); return () => this._m.get(ev).delete(fn); }
    emit(ev, data) { const s = this._m.get(ev); if (s) for (const fn of [...s]) { try { fn(data); } catch (e) { console.error(`[${ev}]`, e); } } }
}
