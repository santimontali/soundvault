// Time selection on a single sound (seconds, not fractions, so it never
// drifts when durations are refined) + the floating selection toolbar.
import { h, icon, setIcon, Emitter, formatDuration, clamp } from '../util.js';
import { player } from '../audio/engine.js';

class Selection extends Emitter {
    constructor() { super(); this._s = null; }
    get() { return this._s; }
    set(s) {
        const prev = this._s;
        this._s = s ? { fadeIn: 0, fadeOut: 0, ...s } : null;
        this.emit('change', { prev, cur: this._s });
    }
    update(patch) {
        if (!this._s) return;
        const prev = { ...this._s };
        Object.assign(this._s, patch);
        const s = this._s, len = s.end - s.start;
        s.fadeIn = clamp(s.fadeIn || 0, 0, len);
        s.fadeOut = clamp(s.fadeOut || 0, 0, len - s.fadeIn);
        this.emit('change', { prev, cur: this._s });
    }
    clear() { if (this._s) this.set(null); }
    isOn(path) { return !!(this._s && this._s.path === path); }
}
export const selection = new Selection();

// ── floating toolbar ────────────────────────────────────────────────────
let bar = null, lenEl = null, playBtn = null;
export function mountSelectionToolbar() {
    const btn = (ic, tip, kbd, action, extra = {}) => h('button.icon-btn', { 'data-tip': tip, 'data-kbd': kbd || null, 'aria-label': tip, onclick: e => { e.stopPropagation(); selection.emit('action', action); }, ...extra }, icon(ic));
    lenEl = h('span.len');
    playBtn = btn('play', 'Play selection', 'Space', 'play');
    const grip = h('div.icon-btn.grip-drag', { draggable: 'true', 'data-tip': 'Drag selection to your DAW', 'aria-label': 'Drag selection' }, icon('grip'));
    grip.addEventListener('dragstart', e => { e.preventDefault(); selection.emit('action', 'drag'); });
    bar = h('div.sel-toolbar', { role: 'toolbar', 'aria-label': 'Selection' },
        lenEl, playBtn,
        btn('scissors', 'Edit selection', 'E', 'edit'),
        btn('echo', 'Echo: find similar', 'Ctrl+E', 'echo'),
        btn('collection-plus', 'Save selection as new sound', null, 'save'),
        grip,
        btn('x', 'Clear selection', 'Esc', 'clear'));
    bar.addEventListener('mousedown', e => e.stopPropagation());
    document.body.appendChild(bar);
    selection.on('change', () => requestAnimationFrame(position));
    player.on('state', () => {
        const s = selection.get();
        const playingSel = !!(s && player.isCurrent(s.path) && player.playing && player.segment);
        setIcon(playBtn.firstChild, playingSel ? 'pause' : 'play');
    });
    window.addEventListener('resize', position);
    document.addEventListener('scroll', position, true);
}

export function position() {
    if (!bar) return;
    const s = selection.get();
    const selEl = s && document.querySelector('.row .sel:not(.hidden)');
    if (!s || !selEl) { bar.classList.remove('show'); return; }
    const r = selEl.getBoundingClientRect();
    const list = selEl.closest('.list');
    const lr = list ? list.getBoundingClientRect() : { top: 0, bottom: innerHeight };
    if (r.bottom < lr.top + 4 || r.top > lr.bottom - 4 || r.width <= 0) { bar.classList.remove('show'); return; }
    lenEl.textContent = formatDuration(s.end - s.start);
    const bw = bar.offsetWidth || 220;
    const left = clamp(r.left + r.width / 2 - bw / 2, 8, innerWidth - bw - 8);
    let top = r.top - bar.offsetHeight - 8;
    if (top < lr.top + 2) top = r.bottom + 8;
    bar.style.left = left + 'px';
    bar.style.top = top + 'px';
    bar.classList.add('show');
}
