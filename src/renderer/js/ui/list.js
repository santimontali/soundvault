// Virtualized sound list.
//  • Recycled row pool positioned with transforms; all events delegated.
//  • Keyboard: ↑/↓ (auto-play), Enter, Space, ←/→ seek, Home/End, PgUp/PgDn,
//    Ctrl+A, Shift/Ctrl multi-select, Delete, F2.
//  • Waveform: click = play from there, drag = time selection (auto-plays),
//    drag the edges = resize, drag the dots on the top corners = fades
//    (double-click a dot removes its fade; Shift+edge still works too).
//  • One rAF loop updates the playing row's progress (clip-path), no redraws.
import { h, icon, setIcon, formatDuration, formatFormat, stripExt, clamp, Emitter, isEditableTarget } from '../util.js';
import { player } from '../audio/engine.js';
import { peaksFor, requestPeaks } from '../audio/peaks.js';
import { drawPair, setProgress, fitCanvas } from './waveform.js';
import { selection } from './selection.js';
import { isDialogOpen } from './overlays.js';

const ROW_H = 56;
const OVERSCAN = 8;
const SVG_NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, cls) => { const e = document.createElementNS(SVG_NS, tag); if (cls) e.setAttribute('class', cls); return e; };

/**
 * Fades drawn the way DAWs draw them: a gain line from silence (bottom
 * corner) to full level, with a veil over the part the fade takes away.
 * One SVG per row, stretched to the selection (strokes stay 1.25 px).
 */
function makeFadeLayer() {
    const svg = svgEl('svg', 'fades');
    svg.setAttribute('viewBox', '0 0 100 100');
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('aria-hidden', 'true');
    const parts = { veilIn: svgEl('polygon', 'veil in'), lineIn: svgEl('line', 'fl in'), veilOut: svgEl('polygon', 'veil out'), lineOut: svgEl('line', 'fl out') };
    svg.append(parts.veilIn, parts.veilOut, parts.lineIn, parts.lineOut);
    return { svg, ...parts };
}

class SoundList extends Emitter {
    constructor() {
        super();
        this.el = null; this.spacer = null;
        this.items = [];
        this.index = new Map();          // path -> index
        this.pool = [];                  // [{el, refs, idx, path}]
        this.cursor = -1;
        this.multi = new Set();          // multi-selected paths
        this.anchor = -1;                // shift-select anchor
        this.opts = { baseDir: '', query: '', showScore: false };
        this._lastW = 0;
        this._raf = null;
    }

    mount(el) {
        this.el = el;
        el.tabIndex = 0;
        el.setAttribute('role', 'listbox');
        el.setAttribute('aria-multiselectable', 'true');
        this.spacer = h('div.spacer');
        el.appendChild(this.spacer);
        el.addEventListener('scroll', () => this.render(), { passive: true });
        new ResizeObserver(() => {
            const w = el.clientWidth;
            const widthChanged = w !== this._lastW;
            this._lastW = w;
            this.render(widthChanged);
        }).observe(el);
        el.addEventListener('mousedown', e => this._onMouseDown(e));
        el.addEventListener('mousemove', e => this._onHover(e));
        el.addEventListener('dblclick', e => this._onDblClick(e));
        el.addEventListener('contextmenu', e => this._onContext(e));
        el.addEventListener('dragstart', e => this._onDragStart(e));
        document.addEventListener('keydown', e => this._onKey(e));
        player.on('state', () => { this._refreshPlaying(); this._loop(); });
        selection.on('change', ({ prev, cur }) => { if (prev) this.refreshPath(prev.path); if (cur) this.refreshPath(cur.path); });
        this._loop();
    }

    // ── data ──────────────────────────────────────────────────────────
    /**
     * opts: baseDir (dirs shown relative to it), query (highlight), showScore,
     * scoreKind, keepScroll (live refresh of the same view), cursorPath.
     */
    setItems(items, opts = {}) {
        const prevCursorPath = this.current()?.path || null;
        this.items = items || [];
        this.index = new Map(this.items.map((it, i) => [it.path, i]));
        this.opts = { baseDir: '', query: '', showScore: false, ...opts };
        this.multi = opts.keepScroll ? new Set([...this.multi].filter(p => this.index.has(p))) : new Set();
        const want = opts.cursorPath !== undefined ? opts.cursorPath : (opts.keepScroll ? prevCursorPath : null);
        this.cursor = want && this.index.has(want) ? this.index.get(want) : -1;
        this.anchor = this.cursor;
        if (!opts.keepScroll) this.el.scrollTop = 0;
        this.spacer.style.height = this.items.length * ROW_H + 'px';
        for (const r of this.pool) { r.idx = -1; r.path = null; }
        this.render(true);
        this.emit('items', this.items);
    }

    get(path) { const i = this.index.get(path); return i === undefined ? null : this.items[i]; }
    current() { return this.cursor >= 0 ? this.items[this.cursor] : null; }
    selectedItems() {
        if (this.multi.size) return this.items.filter(it => this.multi.has(it.path));
        const c = this.current();
        return c ? [c] : [];
    }

    /** Replace an item in place (e.g. after rename) without resetting scroll. */
    patchItem(path, next) {
        const i = this.index.get(path);
        if (i === undefined) return;
        this.items[i] = next;
        this.index.delete(path); this.index.set(next.path, i);
        if (this.multi.delete(path)) this.multi.add(next.path);
        this.refreshIndex(i);
    }

    removePaths(paths) {
        const drop = new Set(paths);
        if (!this.items.some(it => drop.has(it.path))) return;
        const cur = this.current();
        this.setItems(this.items.filter(it => !drop.has(it.path)), { ...this.opts, keepScroll: true, cursorPath: cur && !drop.has(cur.path) ? cur.path : null });
    }

    // ── rendering ─────────────────────────────────────────────────────
    _makeRow() {
        const pbtn = h('button.pbtn', { 'aria-label': 'Play', tabindex: '-1' }, icon('play'));
        const nm = h('div.nm');
        const dir = h('span.dir'), fmt = h('span.fmt'), score = h('span.score');
        const sub = h('div.sub', {}, dir, fmt, score);
        const base = h('canvas'), played = h('canvas.played');
        const ph = h('div.ph'), hover = h('div.hover-line');
        const fades = makeFadeLayer();
        const fkIn = h('div.fk.in', { 'data-tip': 'Fade in: drag · double-click removes it' });
        const fkOut = h('div.fk.out', { 'data-tip': 'Fade out: drag · double-click removes it' });
        const ftag = h('div.ftag');
        const sel = h('div.sel.hidden', {}, fades.svg, h('div.h.l'), h('div.h.r'), fkIn, fkOut, ftag);
        const wf = h('div.wf', {}, base, played, sel, ph, hover);
        const dur = h('div.dur');
        const grip = h('div.grip', { draggable: 'true', 'data-tip': 'Drag to your DAW or a folder / collection' }, icon('grip'));
        const el = h('div.row', { role: 'option' }, pbtn, h('div.meta', {}, nm, sub), wf, dur, grip);
        el.style.transform = 'translateY(-9999px)';
        this.spacer.appendChild(el);
        return { el, idx: -1, path: null, drawnKey: '', refs: { pbtn, nm, dir, fmt, score, base, played, ph, hover, sel, wf, dur, grip, fades, fkIn, fkOut, ftag } };
    }

    render(force = false) {
        if (!this.el) return;
        const top = this.el.scrollTop, hgt = this.el.clientHeight || 600;
        const first = Math.max(0, Math.floor(top / ROW_H) - OVERSCAN);
        const last = Math.min(this.items.length - 1, Math.ceil((top + hgt) / ROW_H) + OVERSCAN);
        const need = Math.max(0, last - first + 1);
        while (this.pool.length < need) this.pool.push(this._makeRow());
        const byIdx = new Map();
        const free = [];
        for (const r of this.pool) { if (r.idx >= first && r.idx <= last && r.path === this.items[r.idx]?.path) byIdx.set(r.idx, r); else free.push(r); }
        for (let i = first; i <= last; i++) {
            let r = byIdx.get(i);
            if (!r) { r = free.pop(); this._bind(r, i); }
            else if (force) this._bind(r, i, true);
        }
        for (const r of free) { r.idx = -1; r.path = null; r.el.style.transform = 'translateY(-9999px)'; r.el.setAttribute('aria-hidden', 'true'); r.el.classList.remove('playing', 'cursor', 'multi'); }
    }

    refreshIndex(i) { const r = this.pool.find(x => x.idx === i); if (r) this._bind(r, i, true); }
    refreshPath(path) { const i = this.index.get(path); if (i !== undefined) this.refreshIndex(i); }
    refreshAll() { this.render(true); }

    _bind(r, i, keepCanvas = false) {
        const it = this.items[i];
        if (!it) return;
        const pathChanged = r.path !== it.path;
        r.idx = i; r.path = it.path;
        const { el, refs } = r;
        el.style.transform = `translateY(${i * ROW_H}px)`;
        el.removeAttribute('aria-hidden');
        el.dataset.i = i;
        el.classList.toggle('cursor', i === this.cursor);
        el.classList.toggle('multi', this.multi.has(it.path));
        el.classList.toggle('missing', !!it.missing);
        el.classList.toggle('bad', peaksFor(it.path) === null);
        el.setAttribute('aria-selected', this.multi.has(it.path) || i === this.cursor ? 'true' : 'false');
        // name (+ query highlight, built with text nodes only)
        const name = stripExt(it.name);
        if (refs.nm._v !== name + '\u0000' + this.opts.query) {
            refs.nm._v = name + '\u0000' + this.opts.query;
            refs.nm.replaceChildren(...highlight(name, this.opts.query));
            refs.nm.title = name;
        }
        refs.dir.textContent = relDir(it.dir, this.opts.baseDir);
        paintScore(refs.score, it, this.opts);
        const pk = peaksFor(it.path);
        refs.fmt.textContent = pk ? formatFormat(pk) : '';
        refs.dur.textContent = pk ? formatDuration(pk.duration) : pk === null ? 'unreadable' : it.missing ? 'missing' : '';
        if (pk === undefined) {
            if (pathChanged || !keepCanvas) this._clearWave(r);
            requestPeaks(it).then(d => { if (r.path === it.path) this._bind(r, r.idx, false); });
        } else {
            const key = it.path + '|' + (pk ? 1 : 0) + '|' + refs.base.clientWidth;
            if (r.drawnKey !== key || !keepCanvas) { drawPair(refs.base, refs.played, pk); r.drawnKey = key; }
        }
        this._paintPlaying(r);
        this._paintSelection(r, pk);
    }

    _clearWave(r) {
        const f1 = fitCanvas(r.refs.base), f2 = fitCanvas(r.refs.played);
        if (f1) f1[2].clearRect(0, 0, f1[0], f1[1]);
        if (f2) f2[2].clearRect(0, 0, f2[0], f2[1]);
        r.drawnKey = '';
    }

    _paintPlaying(r) {
        const isCur = player.isCurrent(r.path);
        r.el.classList.toggle('playing', isCur && (player.playing || player.loading));
        setIcon(r.refs.pbtn.firstChild, isCur && player.playing ? 'pause' : 'play');
        r.refs.pbtn.setAttribute('aria-label', isCur && player.playing ? 'Pause' : 'Play');
        if (!isCur) { setProgress(r.refs.played, 0); r.refs.ph.style.transform = 'translateX(-10px)'; }
    }

    _paintSelection(r, pk) {
        const s = selection.get();
        const sel = r.refs.sel;
        const dur = pk && pk.duration;
        if (!s || s.path !== r.path || !dur) { sel.classList.add('hidden'); return; }
        sel.classList.remove('hidden');
        const widthPct = Math.max(0.002, (s.end - s.start) / dur) * 100;
        sel.style.left = (s.start / dur * 100) + '%';
        sel.style.width = widthPct + '%';
        const len = s.end - s.start;
        const fi = len > 0 ? clamp(s.fadeIn / len, 0, 1) * 100 : 0, fo = len > 0 ? clamp(s.fadeOut / len, 0, 1) * 100 : 0;
        const { fades, fkIn, fkOut } = r.refs;
        fades.veilIn.setAttribute('points', `0,0 ${fi},0 0,100`);
        fades.lineIn.setAttribute('x1', 0); fades.lineIn.setAttribute('y1', 100); fades.lineIn.setAttribute('x2', fi); fades.lineIn.setAttribute('y2', 0);
        fades.veilOut.setAttribute('points', `${100 - fo},0 100,0 100,100`);
        fades.lineOut.setAttribute('x1', 100 - fo); fades.lineOut.setAttribute('y1', 0); fades.lineOut.setAttribute('x2', 100); fades.lineOut.setAttribute('y2', 100);
        fades.svg.classList.toggle('no-in', !(fi > 0));
        fades.svg.classList.toggle('no-out', !(fo > 0));
        fkIn.style.left = fi + '%';
        fkOut.style.left = (100 - fo) + '%';
        fkIn.classList.toggle('zero', !(fi > 0));
        fkOut.classList.toggle('zero', !(fo > 0));
        // Too narrow for two dots next to the edge grips: fades stay on Shift+edges.
        const px = r.refs.wf.clientWidth * widthPct / 100;
        sel.classList.toggle('narrow', px > 0 && px < 34);
    }

    _refreshPlaying() { for (const r of this.pool) if (r.idx >= 0) this._paintPlaying(r); }

    _loop() {
        if (this._raf) return;
        const tick = () => {
            this._raf = null;
            if (!player.sound) return;
            const i = this.index.get(player.sound.path);
            const r = i === undefined ? null : this.pool.find(x => x.idx === i);
            if (r) {
                const pk = peaksFor(r.path);
                const fd = (pk && pk.duration) || player.fileDuration || player.duration;
                if (fd > 0) {
                    const pos = player.position();
                    const frac = pos / fd;
                    setProgress(r.refs.played, frac);
                    r.refs.ph.style.transform = `translateX(${frac * r.refs.wf.clientWidth}px)`;
                }
            }
            this.emit('tick');
            if (player.playing || player.loading) this._raf = requestAnimationFrame(tick);
        };
        this._raf = requestAnimationFrame(tick);
    }

    // ── cursor / multi-select ─────────────────────────────────────────
    setCursor(i, { play = false, scroll = true, extend = false, toggle = false } = {}) {
        if (!this.items.length) return;
        i = clamp(i, 0, this.items.length - 1);
        const prev = this.cursor;
        this.cursor = i;
        const path = this.items[i].path;
        if (extend) {
            const a = this.anchor >= 0 ? this.anchor : (prev >= 0 ? prev : i);
            this.anchor = a;
            this.multi = new Set(this.items.slice(Math.min(a, i), Math.max(a, i) + 1).map(x => x.path));
        } else if (toggle) {
            if (this.multi.has(path)) this.multi.delete(path); else this.multi.add(path);
            if (prev >= 0 && !this.multi.size) this.multi.add(path);
            this.anchor = i;
        } else {
            if (this.multi.size) this.multi.clear();
            this.anchor = i;
        }
        if (scroll) this.scrollToIndex(i);
        this.render(true);
        this.emit('cursor', this.items[i]);
        if (play) this.emit('play', { item: this.items[i], from: 0 });
    }

    scrollToIndex(i, center = false) {
        const top = i * ROW_H, bottom = top + ROW_H;
        const st = this.el.scrollTop, hgt = this.el.clientHeight;
        if (center) this.el.scrollTop = Math.max(0, top - hgt / 2 + ROW_H / 2);
        else if (top < st) this.el.scrollTop = top;
        else if (bottom > st + hgt) this.el.scrollTop = bottom - hgt;
    }

    scrollToPath(path, { flash = true } = {}) {
        const i = this.index.get(path);
        if (i === undefined) return false;
        this.setCursor(i, { scroll: false });
        this.scrollToIndex(i, true);
        if (flash) requestAnimationFrame(() => {
            const r = this.pool.find(x => x.idx === i);
            if (r) r.el.animate([{ background: 'rgba(var(--accent-rgb), .22)' }, { background: 'transparent' }], { duration: 1200, easing: 'ease-out' });
        });
        return true;
    }

    // ── events ────────────────────────────────────────────────────────
    _rowFromEvent(e) {
        const row = e.target.closest && e.target.closest('.row');
        if (!row) return null;
        const r = this.pool.find(x => x.el === row);
        return r && r.idx >= 0 ? r : null;
    }

    _onHover(e) {
        const wf = e.target.closest && e.target.closest('.wf');
        if (!wf) return;
        const line = wf.querySelector('.hover-line');
        const rect = wf.getBoundingClientRect();
        line.style.transform = `translateX(${e.clientX - rect.left}px)`;
    }

    _onMouseDown(e) {
        if (e.button !== 0) return;
        const r = this._rowFromEvent(e);
        if (!r) { if (e.target === this.el || e.target === this.spacer) selection.clear(); return; }
        const it = this.items[r.idx];
        this.el.focus({ preventScroll: true });
        if (e.target.closest('.pbtn')) {
            e.preventDefault();
            this.setCursor(r.idx, { scroll: false });
            this.emit('toggle', it);
            return;
        }
        if (e.target.closest('.grip')) return;               // dragstart handles it
        if (e.target.closest('.wf')) { this._waveDown(e, r, it); return; }
        // meta / empty area: cursor + multi-select semantics
        e.preventDefault();
        if (e.shiftKey) this.setCursor(r.idx, { extend: true, scroll: false });
        else if (e.ctrlKey || e.metaKey) this.setCursor(r.idx, { toggle: true, scroll: false });
        else {
            this.setCursor(r.idx, { scroll: false });
            this.emit('select', it);
        }
    }

    _onDblClick(e) {
        const r = this._rowFromEvent(e);
        const knob = r && e.target.closest('.fk');
        if (knob) {                                          // double-click a fade dot: no fade
            const s = selection.get();
            const isIn = knob.classList.contains('in');
            if (s && s.path === r.path && (isIn ? s.fadeIn : s.fadeOut) > 0) {
                selection.update(isIn ? { fadeIn: 0 } : { fadeOut: 0 });
                this.emit('selection-done', selection.get());
            }
            return;
        }
        if (!r || e.target.closest('.wf') || e.target.closest('.pbtn') || e.target.closest('.grip')) return;
        this.emit('play', { item: this.items[r.idx], from: 0 });
    }

    _waveDown(e, r, it) {
        e.preventDefault();
        const wf = r.refs.wf;
        const rect = wf.getBoundingClientRect();
        const pk = peaksFor(it.path);
        const dur = (pk && pk.duration) || (player.isCurrent(it.path) ? player.fileDuration : 0);
        const tAt = x => dur ? clamp((x - rect.left) / rect.width, 0, 1) * dur : 0;
        const handle = e.target.closest('.h');
        const knob = e.target.closest('.fk');
        const cur = selection.get();
        this.setCursor(r.idx, { scroll: false });

        if (knob && cur && cur.path === it.path) {
            const isIn = knob.classList.contains('in');
            const before = isIn ? cur.fadeIn : cur.fadeOut;
            const tag = r.refs.ftag;
            knob.classList.add('active');
            const onMove = me => {
                const t = tAt(me.clientX), len = cur.end - cur.start;
                if (isIn) selection.update({ fadeIn: clamp(t - cur.start, 0, len * 0.9 - (cur.fadeOut || 0)) });
                else selection.update({ fadeOut: clamp(cur.end - t, 0, len * 0.9 - (cur.fadeIn || 0)) });
                const v = isIn ? cur.fadeIn : cur.fadeOut;
                tag.textContent = (isIn ? 'Fade in ' : 'Fade out ') + (v > 0 ? formatDuration(v) : 'off');
                tag.style.left = knob.style.left;
                tag.classList.toggle('out', !isIn);
                tag.classList.add('show');
            };
            const onUp = () => {
                document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp);
                knob.classList.remove('active'); tag.classList.remove('show');
                const now = selection.get();
                if (now && (isIn ? now.fadeIn : now.fadeOut) !== before) this.emit('selection-done', now);   // hear the new fade
            };
            document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp);
            return;
        }

        if (handle && cur && cur.path === it.path) {
            const left = handle.classList.contains('l');
            const fade = e.shiftKey;
            const onMove = me => {
                const t = tAt(me.clientX);
                if (fade) {
                    const len = cur.end - cur.start;
                    if (left) selection.update({ fadeIn: clamp(t - cur.start, 0, len * 0.9 - (cur.fadeOut || 0)) });
                    else selection.update({ fadeOut: clamp(cur.end - t, 0, len * 0.9 - (cur.fadeIn || 0)) });
                } else if (left) selection.update({ start: Math.min(t, cur.end - 0.001) });
                else selection.update({ end: Math.max(t, cur.start + 0.001) });
            };
            const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); this.emit('selection-done', selection.get()); };
            document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp);
            return;
        }

        const x0 = e.clientX, t0 = tAt(x0);
        let dragging = false;
        const onMove = me => {
            if (!dragging && Math.abs(me.clientX - x0) < 4) return;
            if (!dur) return;
            if (!dragging) { dragging = true; selection.set({ path: it.path, start: t0, end: t0, duration: dur }); }
            const t = tAt(me.clientX);
            selection.update({ start: Math.min(t0, t), end: Math.max(t0, t) });
        };
        const onUp = me => {
            document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp);
            if (dragging) {
                const s = selection.get();
                if (s && s.end - s.start < 0.003) { selection.clear(); return; }
                this.emit('selection-done', s);
                return;
            }
            // plain click: inside the selection → play selection, elsewhere → play file from here
            const t = tAt(me.clientX);
            const s = selection.get();
            if (s && s.path === it.path && t >= s.start && t <= s.end) { this.emit('play-selection', s); return; }
            if (s && s.path === it.path) selection.clear();
            this.emit('play', { item: it, from: t });
        };
        document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp);
    }

    _onContext(e) {
        const r = this._rowFromEvent(e);
        if (!r) return;
        e.preventDefault();
        const it = this.items[r.idx];
        if (!this.multi.has(it.path)) this.setCursor(r.idx, { scroll: false });
        this.emit('context', { item: it, items: this.selectedItems(), x: e.clientX, y: e.clientY });
    }

    _onDragStart(e) {
        const r = this._rowFromEvent(e);
        if (!r || !e.target.closest('.grip')) return;
        e.preventDefault();
        const it = this.items[r.idx];
        const items = this.multi.has(it.path) ? this.selectedItems() : [it];
        this.emit('drag-out', { items, item: it });
    }

    _onKey(e) {
        if (!this.el || isEditableTarget(e.target) || isDialogOpen() || e.defaultPrevented) return;
        if (e.target.closest && e.target.closest('#editor, .echo')) return;
        const n = this.items.length;
        const k = e.key;
        const pageRows = Math.max(1, Math.floor(this.el.clientHeight / ROW_H) - 1);
        const move = (i, extend) => { e.preventDefault(); this.setCursor(i, { extend, play: !extend && !e.ctrlKey }); };
        if (k === 'ArrowDown' && n) return move(this.cursor < 0 ? 0 : this.cursor + 1, e.shiftKey);
        if (k === 'ArrowUp' && n) return move(this.cursor < 0 ? 0 : this.cursor - 1, e.shiftKey);
        if (k === 'PageDown' && n) return move(this.cursor + pageRows, e.shiftKey);
        if (k === 'PageUp' && n) return move(this.cursor - pageRows, e.shiftKey);
        if (k === 'Home' && n) return move(0, e.shiftKey);
        if (k === 'End' && n) return move(n - 1, e.shiftKey);
        if (k === 'Enter' && this.current()) { e.preventDefault(); this.emit('play', { item: this.current(), from: 0, force: true }); return; }
        if ((k === 'a' || k === 'A') && (e.ctrlKey || e.metaKey) && n) { e.preventDefault(); this.multi = new Set(this.items.map(x => x.path)); this.render(true); this.emit('multi', this.multi); return; }
        if (k === 'Escape' && !selection.get() && this.multi.size) { this.multi.clear(); this.render(true); return; }
    }
}

// ── helpers ─────────────────────────────────────────────────────────────
function relDir(dir, base) {
    if (!dir) return '';
    if (!base) return dir.replace(/\//g, ' › ');
    const b = base.toLowerCase();
    const d = dir.toLowerCase();
    if (d === b) return '';
    if (d.startsWith(b + '/')) return dir.slice(base.length + 1).replace(/\//g, ' › ');
    return dir.replace(/\//g, ' › ');
}

// CLAP text→audio cosines live in ~0.2-0.6, so a raw "45%" reads as weak even
// for a perfect hit. Four levels calibrated on a real 70k library (semantic
// audit: precision falls quickly below 0.45).
const LEVELS = ['', 'weak', 'fair', 'good', 'strong'];
function paintScore(el, it, opts) {
    if (!opts.showScore || it.score === undefined || opts.scoreKind !== 'ai') {
        if (el.childElementCount || el.textContent) { el.replaceChildren(); el.removeAttribute('data-l'); el.title = ''; }
        return;
    }
    const s = it.score;
    const l = s == null ? 0 : s >= 0.55 ? 4 : s >= 0.45 ? 3 : s >= 0.36 ? 2 : 1;
    if (el.childElementCount !== 4) el.replaceChildren(h('i'), h('i'), h('i'), h('i'));
    el.dataset.l = String(l);
    el.title = (it.match === 'name' ? 'File name matches · ' : 'Found by sound · ') + (s == null ? 'not analysed yet' : LEVELS[l] + ' match');
}

/** Split `text` into text nodes and <mark> nodes for every query token (case/accents-insensitive). */
function highlight(text, query) {
    const toks = String(query || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/[^\p{L}\p{N}]+/u).filter(t => t.length >= 2);
    if (!toks.length) return [document.createTextNode(text)];
    const folded = text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    if (folded.length !== text.length) return [document.createTextNode(text)];
    const marks = new Uint8Array(text.length);
    for (const t of toks) { let i = folded.indexOf(t); while (i !== -1) { marks.fill(1, i, i + t.length); i = folded.indexOf(t, i + t.length); } }
    const out = [];
    let i = 0;
    while (i < text.length) {
        const m = marks[i]; let j = i;
        while (j < text.length && marks[j] === m) j++;
        const seg = text.slice(i, j);
        out.push(m ? h('mark', { text: seg }) : document.createTextNode(seg));
        i = j;
    }
    return out;
}

export const list = new SoundList();
export { ROW_H, relDir };
