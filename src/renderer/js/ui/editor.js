// Audio editor: a resizable bottom drawer inside #main (the list stays visible
// above it). Non-destructive: it edits a copy of the list selection.
//
//  • Picture: exact min/max/RMS pyramid of the decoded audio with the edit
//    applied (fades × gain, mirrored when reversed), what you see is what you
//    hear. Stereo lanes on demand, time ruler, clip indicator, minimap.
//  • Gestures: crop edges (zero-crossing snap, Alt = free), fade squares, bend a
//    fade curve vertically, double-click resets, right-click = curve presets,
//    drag inside a fade = move edge + fade together, drag the middle = slip,
//    click = cursor. Contextual legend, tooltips and a "?" sheet.
//  • Playback: a live Web Audio graph (nothing is rendered before playing): the
//    fade envelope rides on a control source locked to the audio source, so
//    gain and pitch change live and loops are seamless. One voice, generation
//    token, and mutual exclusion with the global player.
//  • Export: rendered at the file's NATIVE rate ~250 ms after edits settle
//    (24-bit, or 32-bit float when the peak exceeds 0 dBFS), so the drag button
//    starts the OS drag synchronously inside dragstart.
import { h, icon, setIcon, clamp, debounce, formatFormat, stripExt, baseName, isEditableTarget } from '../util.js';
import { bus } from '../store.js';
import { audioCtx, masterNode, decode, decodeNative, player } from '../audio/engine.js';
import { peaksFor, requestPeaks } from '../audio/peaks.js';
import { selection } from './selection.js';
import { list } from './list.js';
import { toast, showMenu, isDialogOpen } from './overlays.js';
import { ghostIcon } from '../drag.js';
import * as D from '../audio/edit-dsp.js';
import { fadeGlyph } from './fade-glyph.js';

const MIN_H = 230, DEF_H = 330;
const TOP_BAND = 22;                  // px: fade squares live in the top band of the stage
const CURVE_TOP = 22, CURVE_BOT = 4;  // px: vertical extent of the drawn fade curves
const SNAP_MIN = 0.001, SNAP_MAX = 0.010;
const EXPORT_DEBOUNCE = 250;
const KEEP_CHANNELS_MAX = 16e6;       // keep rendered channels for "Save as new" below this many samples
let autoRenderBytes = 192 * 1024 * 1024;       // above this (native decode or result), exports render on request

const lsGet = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } };

// ── state ──────────────────────────────────────────────────────────────
const S = {
    mounted: false, open: false,
    item: null, region: null, edit: null,
    buf: null, rbuf: null, chans: null, sr: 48000, ix: null, miniCols: null,
    view: { start: 0, end: 1 }, cursor: null,
    stereo: lsGet('sv.editor.stereo') === '1', loop: lsGet('sv.editor.loop') === '1', help: false,
    hover: null, drag: null,
    hist: { undo: [], redo: [] }, coalesce: null,
    loadGen: 0, internalSel: false, detached: false,
    memory: new Map(),                // path → { region, edit, hist } (session memory)
    last: null,                       // last drawn picture (test hook / clip marks)
    pal: null, dirty: { wave: false, over: false, ruler: false, mini: false }, raf: 0,
};
const P = { gen: 0, src: null, ctl: null, env: null, amp: null, playing: false, segs: [], L: 0, cs: 0, loop: false, raf: 0, needsRestart: false, startedAt: 0 };
const X = { gen: 0, readyKey: null, path: null, preparing: false, error: null, float: false, sr: 0, frames: 0, peak: 0, channels: null, waiters: [] };
let els = {};

// ── public entry ───────────────────────────────────────────────────────
export async function openEditorFor(item, sel) {
    if (!item || !sel) return;
    mount();
    if (S.open && S.item && S.item.path === item.path && sameRegion(S.region, sel)) { focusEditor(); return; }
    if (S.open) { stop(); remember(); }
    const region = { start: sel.start, end: sel.end };
    const mem = S.memory.get(item.path);
    const restored = mem && sameRegion(mem.region, region);
    S.item = item; S.region = region; S.detached = false;
    S.edit = restored ? mem.edit : D.createEdit(region.end - region.start, { fadeIn: sel.fadeIn || 0, fadeOut: sel.fadeOut || 0 });
    S.hist = restored ? mem.hist : { undo: [], redo: [] };
    S.view = { start: 0, end: S.edit.duration }; S.cursor = null; S.help = false;
    S.buf = S.rbuf = S.chans = S.ix = S.miniCols = null;
    X.gen++; X.readyKey = X.path = null; X.channels = null; X.error = null; X.manual = false; X.preparing = false; X.pendingKey = null;
    show();
    renderHead(); renderLegend(); updateControls(); setLoading(true);
    const gen = ++S.loadGen;
    const [buf] = await Promise.all([decode(item.path), peaksFor(item.path) === undefined ? requestPeaks(item) : null]);
    if (gen !== S.loadGen || !S.open) return;
    if (!buf) { toast('Could not decode this file', { kind: 'error' }); closeEditor(); return; }
    S.buf = buf; S.sr = buf.sampleRate;
    S.chans = []; for (let c = 0; c < buf.numberOfChannels; c++) S.chans.push(buf.getChannelData(c));
    rebuildIndex();
    renderHead(); setLoading(false); updateControls();
    requestDraw('all');
    schedulePrerender();
    focusEditor();
    keepRowVisible();
}

export function closeEditor() {
    if (!S.open) return;
    stop();
    remember();
    X.gen++; X.channels = null; X.icon = null; X.preparing = false; X.pendingKey = null;
    S.open = false; S.loadGen++;
    els.root.remove();
    S.buf = S.rbuf = S.chans = S.ix = S.miniCols = null;
    if (list.el) list.el.focus({ preventScroll: true });
}

export const isEditorOpen = () => S.open;

// ── mount / DOM ────────────────────────────────────────────────────────
function mount() {
    if (S.mounted) return;
    S.mounted = true;
    const tb = (ic, tip, kbd, onClick) => h('button.icon-btn.sm', { 'data-tip': tip, 'data-kbd': kbd || null, 'aria-label': tip, onclick: onClick }, icon(ic));
    const sep = () => h('span.ed-sep');
    els.undo = tb('undo', 'Undo', 'Ctrl+Z', () => undo());
    els.redo = tb('redo', 'Redo', 'Ctrl+Shift+Z', () => redo());
    els.zoomCrop = tb('zoom-crop', 'Zoom to crop', 'Z', () => zoomToCrop());
    els.zoomAll = tb('zoom-out', 'Show the whole selection', 'Shift+Z', () => setView(0, S.edit.duration));
    els.trim = h('button.btn.sm.ghost', { 'data-tip': 'Make the list selection match the crop', 'data-kbd': 'T', onclick: () => trimSelection() }, icon('crop', 'sm'), h('span', { text: 'Trim selection' }));
    els.rev = tb('reverse', 'Reverse (keeps the same audio)', 'R', () => doReverse());
    els.norm = tb('normalize', 'Normalize peak to -0.1 dBFS', 'N', () => normalize());
    els.loopBtn = tb('loop', 'Loop playback', 'L', () => setLoop(!S.loop));
    els.stereoBtn = tb('stereo', 'Show channels separately', 'S', () => setStereo(!S.stereo));
    els.helpBtn = tb('help', 'All gestures and shortcuts', '?', () => setHelp(!S.help));
    els.closeBtn = tb('x', 'Close editor (keeps the selection)', 'Esc', () => closeEditor());
    els.name = h('div.ed-name.ellipsis');
    els.range = h('span.ed-range.tnum');
    els.fmt = h('span.chip.ed-fmt');
    els.detached = h('span.chip.ed-detached.hidden', { 'data-tip': 'The list selection changed. The editor keeps its own range', text: 'Detached' });
    const head = h('div.ed-head', {}, icon('scissors'), els.name, els.range, els.fmt, els.detached, h('div.ed-grow'),
        h('div.ed-tools', { role: 'toolbar', 'aria-label': 'Editor tools' }, els.undo, els.redo, sep(), els.zoomCrop, els.zoomAll, els.trim, sep(), els.rev, els.norm, sep(), els.loopBtn, els.stereoBtn, sep(), els.helpBtn, els.closeBtn));

    els.rulerCv = h('canvas');
    els.ruler = h('div.ed-ruler', { 'aria-label': 'Time ruler: click to set the play cursor' }, els.rulerCv);
    els.wave = h('canvas.ed-wave'); els.played = h('canvas.ed-played'); els.over = h('canvas.ed-over');
    els.ph = h('div.ed-ph'); els.clip = h('div.ed-clip.hidden');
    els.loading = h('div.ed-loading', {}, h('span', { text: 'Decoding…' }));
    els.stage = h('div.ed-stage', { 'aria-label': 'Waveform' }, els.wave, els.played, els.over, els.ph, els.clip, els.loading);
    els.miniCv = h('canvas');
    els.mini = h('div.ed-mini', { 'data-tip': 'Overview: drag to scroll, drag the edges to zoom, double-click to zoom to the crop' }, els.miniCv);

    els.play = h('button.ed-play', { 'aria-label': 'Play edit', 'data-tip': 'Play / stop', 'data-kbd': 'Space', onclick: () => togglePlay() }, icon('play'));
    els.clock = h('span.ed-clock.tnum');
    els.readouts = h('div.ed-readouts.tnum');
    els.gain = h('input.slider.accent', { type: 'range', min: '-30', max: '30', step: '0.1', 'aria-label': 'Gain (dB)' });
    els.gainN = h('input.ed-num', { type: 'text', inputmode: 'decimal', spellcheck: 'false', 'aria-label': 'Gain in dB' });
    els.pitch = h('input.slider.accent', { type: 'range', min: '-24', max: '24', step: '0.01', 'aria-label': 'Pitch (semitones)' });
    els.pitchN = h('input.ed-num', { type: 'text', inputmode: 'decimal', spellcheck: 'false', 'aria-label': 'Pitch in semitones' });
    els.save = h('button.btn.sm.ed-save', { 'data-tip': 'Write the edit as a new file next to the original', 'aria-label': 'Save as new sound', onclick: () => saveAsNew() }, icon('save', 'sm'), h('span.ed-save-t', { text: 'Save as new' }));
    els.dragLabel = h('span', { text: 'Drag' });
    els.drag = h('div.btn.sm.primary.ed-drag', { draggable: 'true', role: 'button', 'aria-label': 'Drag the edited sound to your DAW' }, icon('grip', 'sm'), els.dragLabel);
    const foot = h('div.ed-foot', {}, els.play, els.clock, els.readouts,
        h('div.ed-ctl', { 'data-tip': 'Gain · Alt+wheel on the waveform · double-click resets' }, h('span', { text: 'Gain' }), els.gain, els.gainN),
        h('div.ed-ctl', { 'data-tip': 'Pitch (varispeed: length changes too) · ←/→ 1 st, Shift 0.1 st · double-click resets' }, h('span', { text: 'Pitch' }), els.pitch, els.pitchN),
        els.save, els.drag);
    els.legend = h('div.ed-legend', { 'aria-live': 'polite' });
    els.help = buildHelp();
    els.resize = h('div.ed-resize', { 'aria-hidden': 'true' });
    els.root = h('section.ed', { id: 'editor', tabindex: '-1', role: 'region', 'aria-label': 'Audio editor' }, els.resize, head, els.ruler, els.stage, els.mini, foot, els.legend, els.help);
    const hh = +lsGet('sv.editor.h');
    els.root.style.height = (hh >= MIN_H ? hh : DEF_H) + 'px';
    wire();
}

function show() {
    const main = document.getElementById('main');
    if (!els.root.isConnected) main.appendChild(els.root);
    S.open = true;
    fitHeight();
    requestAnimationFrame(fitHeight);   // after layout: the list's real height is known
}

const LIST_MIN = 150;   // the list above always keeps at least this much height
/** Tallest the drawer may be right now without squeezing the list below LIST_MIN. */
function maxHeight() {
    const cur = els.root.isConnected ? els.root.getBoundingClientRect().height : (parseFloat(els.root.style.height) || DEF_H);
    const listH = list.el ? list.el.clientHeight : 400;
    return Math.max(MIN_H, Math.floor(cur + listH - LIST_MIN));
}
function fitHeight() {
    const cur = parseFloat(els.root.style.height) || DEF_H;
    const max = maxHeight();
    if (cur > max) els.root.style.height = max + 'px';
}

function focusEditor() {
    if (!els.root) return;
    const a = document.activeElement;
    if (a && els.root.contains(a) && a !== els.root) return;
    els.root.focus({ preventScroll: true });
}

function keepRowVisible() {
    requestAnimationFrame(() => requestAnimationFrame(() => {
        if (!S.item || !list.el) return;
        const i = list.index.get(S.item.path);
        if (i !== undefined) list.scrollToIndex(i);
    }));
}

function buildHelp() {
    const row = (keys, text) => [h('div.keys', {}, ...keys.map(k => h('span.kbd', { text: k }))), h('div', { text })];
    const gest = (what, text) => [h('div.keys', {}, h('b', { text: what })), h('div', { text })];
    const grid = h('div.kbd-grid', {},
        ...gest('Crop edges', 'The bright lines with grips. Drag to trim. Snaps to the nearest zero crossing; hold Alt for free placement. Double-click: back to the selection edge.'),
        ...gest('Top squares', 'Fade lengths. Double-click removes the fade.'),
        ...gest('Fade curve', 'Drag up/down to bend it. Double-click: straight. Right-click: Linear, Fast, Slow, S-curve, Equal power.'),
        ...gest('Inside a fade', 'Drag sideways: move the edge and its fade together.'),
        ...gest('Middle', 'Drag: slip the kept part over the audio. Click: set the play cursor.'),
        ...gest('Outside the crop', 'Drag: draw a new crop. Click: set the cursor.'),
        ...gest('Ruler', 'Click: set the cursor (playback starts there).'),
        ...gest('Overview strip', 'Drag to scroll, drag its edges to zoom, double-click: zoom to crop.'),
        ...row(['Space'], 'Play / stop (from the cursor)'),
        ...row(['L'], 'Loop on/off (seamless, fades on every pass)'),
        ...row(['Ctrl', 'Wheel'], 'Zoom at the mouse'),
        ...row(['Wheel'], 'Scroll (Shift+Wheel too)'),
        ...row(['Alt', 'Wheel'], 'Gain (fine on touchpads)'),
        ...row(['Z'], 'Zoom to crop   ·   Shift+Z: whole selection'),
        ...row(['R'], 'Reverse (same audio, fades stay at the ends)'),
        ...row(['N'], 'Normalize peak to -0.1 dBFS'),
        ...row(['T'], 'Trim the list selection to the crop'),
        ...row(['S'], 'Stereo lanes on/off'),
        ...row(['Ctrl', 'Z'], 'Undo   ·   Ctrl+Shift+Z / Ctrl+Y: redo'),
        ...row(['Home', 'End'], 'Cursor to crop start / end'),
        ...row(['Esc'], 'Close a menu, then the editor (the selection stays)'),
    );
    return h('div.ed-help.hidden', { role: 'dialog', 'aria-label': 'Editor gestures and shortcuts' },
        h('div.ed-help-head', {}, h('h4', { text: 'Editor gestures & shortcuts' }), h('button.icon-btn.sm', { 'aria-label': 'Close help', onclick: () => setHelp(false) }, icon('x'))),
        grid,
        h('p.muted', { text: 'Nothing here changes your file. Drag or “Save as new” writes a new WAV at the file’s own sample rate.' }));
}

// ── events ─────────────────────────────────────────────────────────────
function wire() {
    els.root.addEventListener('keydown', onKey);
    els.root.addEventListener('mousedown', e => { if (!isEditableTarget(e.target) && !e.target.closest('button') && e.target.tagName !== 'INPUT') focusEditor(); });
    // stage
    els.stage.addEventListener('mousemove', onStageHover);
    els.stage.addEventListener('mouseleave', () => { if (!S.drag) setHover(null); });
    els.stage.addEventListener('mousedown', onStageDown);
    els.stage.addEventListener('dblclick', onStageDbl);
    els.stage.addEventListener('contextmenu', onStageContext);
    els.stage.addEventListener('wheel', onWheel, { passive: false });
    els.ruler.addEventListener('wheel', onWheel, { passive: false });
    els.ruler.addEventListener('mousedown', onRulerDown);
    // minimap
    els.mini.addEventListener('mousedown', onMiniDown);
    els.mini.addEventListener('mousemove', onMiniHover);
    els.mini.addEventListener('dblclick', () => zoomToCrop());
    els.mini.addEventListener('wheel', onWheel, { passive: false });
    // drawer resize
    els.resize.addEventListener('mousedown', onResizeDown);
    // sliders
    const sliderGesture = (input, apply) => {
        input.addEventListener('pointerdown', () => { S.coalesce = null; input._before = snapshot(); });
        input.addEventListener('input', () => apply(+input.value, true));
        input.addEventListener('change', () => { commit(input._before || null); input._before = null; });
        input.addEventListener('dblclick', () => { const b = snapshot(); apply(0, false); commit(b); });
        input.addEventListener('keydown', e => {
            if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
            e.preventDefault(); e.stopPropagation();
            const dir = e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 1;
            const step = input === els.pitch ? (e.shiftKey ? 0.1 : e.altKey ? 0.01 : 1) : (e.shiftKey ? 0.1 : 0.5);
            coalesced(() => apply((input === els.pitch ? S.edit.semitones : S.edit.gainDb) + dir * step, false));
        });
    };
    sliderGesture(els.gain, v => setEdit(D.normalizeEdit({ ...S.edit, gainDb: v })));
    sliderGesture(els.pitch, v => setEdit(D.normalizeEdit({ ...S.edit, semitones: v })));
    const numField = (input, key) => input.addEventListener('change', () => {
        const v = parseFloat(String(input.value).replace(',', '.').replace('−', '-').replace(/[^0-9+\-.eE]/g, ''));
        if (!Number.isFinite(v)) { updateControls(); return; }
        const b = snapshot(); setEdit(D.normalizeEdit({ ...S.edit, [key]: v })); commit(b);
    });
    numField(els.gainN, 'gainDb'); numField(els.pitchN, 'semitones');
    for (const n of [els.gainN, els.pitchN]) n.addEventListener('keydown', e => {
        e.stopPropagation();                                   // typing never triggers editor/app shortcuts
        if (e.key === 'Enter') { e.preventDefault(); els.root.focus({ preventScroll: true }); }                  // blur commits via 'change'
        else if (e.key === 'Escape') { e.preventDefault(); syncNumbers(); els.root.focus({ preventScroll: true }); }   // revert first → no 'change'
    });
    // export
    els.drag.addEventListener('dragstart', onDragStart);
    els.drag.addEventListener('click', () => { if (!exportReady() && (X.manual || X.error)) { X.error = null; prerender({ force: true }); } });
    // global coupling
    player.on('state', s => { if (P.playing && (s.playing || s.loading)) stop(); });
    selection.on('change', onSelectionChange);
    bus.on('accent', () => { S.pal = null; requestDraw('all'); });
    new ResizeObserver(() => { if (S.open) requestDraw('all'); }).observe(els.stage);
    window.addEventListener('resize', () => { if (S.open) fitHeight(); });
}

function onKey(e) {
    if (isDialogOpen()) return;                        // menus own their keys (Esc closes the menu first)
    const k = e.key, ctrl = e.ctrlKey || e.metaKey;
    const t = e.target;
    const inNumber = t && t.classList && t.classList.contains('ed-num');
    if (ctrl && (k === 'z' || k === 'Z')) { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if (ctrl && (k === 'y' || k === 'Y')) { e.preventDefault(); redo(); return; }
    if (k === 'Escape') {
        e.preventDefault(); e.stopPropagation();
        if (S.help) setHelp(false);
        else if (S.drag) cancelDrag();
        else closeEditor();
        return;
    }
    if (inNumber) return;
    if (k === ' ') { e.preventDefault(); togglePlay(); return; }
    if (ctrl || e.altKey || !S.buf) return;
    const acts = {
        l: () => setLoop(!S.loop), r: () => doReverse(), n: () => normalize(), t: () => trimSelection(), s: () => setStereo(!S.stereo),
        z: () => (e.shiftKey ? setView(0, S.edit.duration) : zoomToCrop()), '?': () => setHelp(!S.help),
        Home: () => setCursor(S.edit.cropStart), End: () => setCursor(S.edit.cropEnd),
        '+': () => zoomBy(0.5), '=': () => zoomBy(0.5), '-': () => zoomBy(2),
        Enter: () => play(S.cursor),
    };
    const fn = acts[k] || acts[k.toLowerCase && k.length === 1 ? k.toLowerCase() : k];
    if (fn && !(t && t.tagName === 'INPUT' && (k === 'Home' || k === 'End'))) { e.preventDefault(); fn(); }
}

// ── geometry ───────────────────────────────────────────────────────────
function stageSize() { return { W: els.stage.clientWidth || 1, H: els.stage.clientHeight || 1 }; }
const span = () => Math.max(1e-9, S.view.end - S.view.start);
const xOf = (v, W = stageSize().W) => (v - S.view.start) / span() * W;
const vOf = (x, W = stageSize().W) => S.view.start + x / W * span();
const curveY = (env, H) => CURVE_TOP + (1 - env) * (H - CURVE_TOP - CURVE_BOT);

function hitTest(x, y) {
    if (!S.edit || !S.buf) return null;
    const { W, H } = stageSize();
    const e = S.edit;
    const xcs = xOf(e.cropStart, W), xce = xOf(e.cropEnd, W), xfi = xOf(e.fadeInEnd, W), xfo = xOf(e.fadeOutStart, W);
    if (y <= TOP_BAND) {
        const di = Math.abs(x - xfi), dO = Math.abs(x - xfo);
        if (Math.min(di, dO) <= 8) {
            if (Math.abs(xfi - xfo) < 2) return { kind: 'fadeStack' };
            return di <= dO ? { kind: 'fadeIn' } : { kind: 'fadeOut' };
        }
    }
    const dcs = Math.abs(x - xcs), dce = Math.abs(x - xce);
    if (Math.min(dcs, dce) <= 6) return dcs <= dce ? { kind: 'cropStart' } : { kind: 'cropEnd' };
    const v = vOf(x, W);
    if (x > xcs && x < xfi && xfi - xcs >= 4) {
        const cy = curveY(D.envelopeAt(e, v), H);
        return Math.abs(y - cy) <= 9 ? { kind: 'bendIn' } : { kind: 'linkIn' };
    }
    if (x > xfo && x < xce && xce - xfo >= 4) {
        const cy = curveY(D.envelopeAt(e, v), H);
        return Math.abs(y - cy) <= 9 ? { kind: 'bendOut' } : { kind: 'linkOut' };
    }
    if (x >= xcs && x <= xce) return { kind: 'slip' };
    return { kind: 'outside' };
}

const CURSORS = { fadeIn: 'ew-resize', fadeOut: 'ew-resize', fadeStack: 'ew-resize', cropStart: 'col-resize', cropEnd: 'col-resize', bendIn: 'ns-resize', bendOut: 'ns-resize', linkIn: 'grab', linkOut: 'grab', slip: 'grab', outside: 'crosshair' };
const HINTS = {
    cropStart: ['Crop start', 'drag to trim · snaps to zero crossings (Alt: free) · double-click: reset'],
    cropEnd: ['Crop end', 'drag to trim · snaps to zero crossings (Alt: free) · double-click: reset'],
    fadeIn: ['Fade-in length', 'drag · double-click: no fade · right-click: curve'],
    fadeOut: ['Fade-out length', 'drag · double-click: no fade · right-click: curve'],
    fadeStack: ['Fade handles', 'drag left: fade-in · drag right: fade-out'],
    bendIn: ['Fade-in curve', 'drag up/down to bend · double-click: straight · right-click: presets'],
    bendOut: ['Fade-out curve', 'drag up/down to bend · double-click: straight · right-click: presets'],
    linkIn: ['Fade-in zone', 'drag sideways: move the start edge with its fade · right-click: curve'],
    linkOut: ['Fade-out zone', 'drag sideways: move the end edge with its fade · right-click: curve'],
    slip: ['Kept audio', 'drag: slip over the sound · click: set cursor · double-click: zoom to crop'],
    outside: ['Cropped out', 'drag: draw a new crop · click: set cursor'],
};

function setHover(t) {
    const k = t ? t.kind : null;
    if ((S.hover && S.hover.kind) === k) return;
    S.hover = t;
    els.stage.style.cursor = CURSORS[k] || 'default';
    renderLegend();
    requestDraw('over');
}

function renderLegend() {
    const t = S.hover && HINTS[S.hover.kind];
    if (t) { els.legend.replaceChildren(h('b', { text: t[0] }), h('span', { text: t[1] })); return; }
    const kv = (k, text) => [h('span.kbd', { text: k }), h('span', { text })];
    els.legend.replaceChildren(
        h('span', { text: 'Edges: trim · top squares: fades · drag a curve ↕: bend · right-click a fade: shape · drag middle: slip · click: cursor' }),
        h('span.ed-grow'), ...kv('Space', 'play'), ...kv('Ctrl+Wheel', 'zoom'), ...kv('Alt+Wheel', 'gain'), ...kv('?', 'help'));
}

// ── stage gestures ─────────────────────────────────────────────────────
function localPoint(ev, el = els.stage) { const r = el.getBoundingClientRect(); return { x: ev.clientX - r.left, y: ev.clientY - r.top, W: r.width, H: r.height }; }

function onStageHover(ev) { if (!S.drag) setHover(hitTest(localPoint(ev).x, localPoint(ev).y)); }

function onStageDown(ev) {
    if (ev.button !== 0 || !S.buf) return;
    ev.preventDefault();
    focusEditor();
    const p = localPoint(ev);
    const t = hitTest(p.x, p.y);
    if (!t) return;
    S.drag = { kind: t.kind, x0: ev.clientX, y0: ev.clientY, v0: clamp(vOf(p.x, p.W), 0, S.edit.duration), e0: S.edit, before: snapshot(), moved: false, W: p.W };
    const move = me => onDragMove(me);
    const up = me => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); onDragEnd(me); };
    S.drag.cleanup = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
}

function onDragMove(me) {
    const d = S.drag;
    if (!d) return;
    const dx = me.clientX - d.x0, dy = me.clientY - d.y0;
    if (!d.moved && Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
    d.moved = true;
    const r = els.stage.getBoundingClientRect();
    const v = clamp(vOf(me.clientX - r.left, r.width), 0, S.edit.duration);
    const dv = dx / r.width * span();
    const free = me.altKey;
    let next = null;
    switch (d.kind) {
        case 'fadeStack': d.kind = dx < 0 ? 'fadeIn' : 'fadeOut'; return onDragMove(me);
        case 'cropStart': case 'cropEnd': next = D.moveHandle(d.e0, d.kind, free ? v : snapTime(v, d.kind)); break;
        case 'fadeIn': next = D.moveHandle(d.e0, 'fadeInEnd', v); break;
        case 'fadeOut': next = D.moveHandle(d.e0, 'fadeOutStart', v); break;
        case 'bendIn': next = D.normalizeEdit({ ...d.e0, fadeInTension: d.e0.fadeInTension + dy / 120 }); break;
        case 'bendOut': next = D.normalizeEdit({ ...d.e0, fadeOutTension: d.e0.fadeOutTension + dy / 120 }); break;
        case 'linkIn': next = D.linkEdit(d.e0, 'in', dv); break;
        case 'linkOut': next = D.linkEdit(d.e0, 'out', dv); break;
        case 'slip': next = D.slipEdit(d.e0, dv); break;
        case 'outside': {
            let a = Math.min(d.v0, v), b = Math.max(d.v0, v);
            if (!free) { a = snapTime(a, 'cropStart'); b = snapTime(b, 'cropEnd'); }
            const fl = D.fadeLengths(d.e0);
            next = D.normalizeEdit({ ...d.e0, cropStart: a, cropEnd: b, fadeInEnd: a + Math.min(fl.fadeIn, (b - a) / 2), fadeOutStart: b - Math.min(fl.fadeOut, (b - a) / 2) });
            break;
        }
    }
    if (next) setEdit(next, { gesture: true });
}

function onDragEnd(me) {
    const d = S.drag;
    S.drag = null;
    if (!d) return;
    if (!d.moved) {
        if (d.kind !== 'fadeIn' && d.kind !== 'fadeOut' && d.kind !== 'fadeStack') setCursor(d.v0, { restart: true });
    } else commit(d.before);
    if (P.needsRestart) { P.needsRestart = false; restartAtCurrent(); }
    const p = localPoint(me);
    if (p.x >= 0 && p.y >= 0 && p.x <= p.W && p.y <= p.H) setHover(hitTest(p.x, p.y)); else setHover(null);
}

function cancelDrag() {
    const d = S.drag;
    if (!d) return;
    d.cleanup(); S.drag = null;
    setEdit(d.e0);
}

function onStageDbl(ev) {
    const p = localPoint(ev);
    const t = hitTest(p.x, p.y);
    if (!t) return;
    const e = S.edit, b = snapshot();
    let next = null;
    switch (t.kind) {
        case 'cropStart': next = D.moveHandle(e, 'cropStart', 0); break;
        case 'cropEnd': next = D.moveHandle(e, 'cropEnd', e.duration); break;
        case 'fadeIn': next = D.moveHandle(e, 'fadeInEnd', e.cropStart); break;
        case 'fadeOut': next = D.moveHandle(e, 'fadeOutStart', e.cropEnd); break;
        case 'bendIn': case 'linkIn': next = D.normalizeEdit({ ...e, fadeInTension: 0 }); break;
        case 'bendOut': case 'linkOut': next = D.normalizeEdit({ ...e, fadeOutTension: 0 }); break;
        case 'slip': zoomToCrop(); return;
        default: return;
    }
    setEdit(next); commit(b);
}

function onStageContext(ev) {
    ev.preventDefault();
    if (!S.buf) return;
    const p = localPoint(ev);
    const t = hitTest(p.x, p.y) || { kind: 'outside' };
    const v = clamp(vOf(p.x, p.W), 0, S.edit.duration);
    const side = /In$/.test(t.kind) ? 'in' : /Out$/.test(t.kind) ? 'out' : null;
    if (side) return showMenu({ x: ev.clientX, y: ev.clientY }, fadeMenu(side));
    const e = S.edit;
    showMenu({ x: ev.clientX, y: ev.clientY }, [
        { label: 'Play from here', icon: 'play', kbd: 'Enter', onClick: () => { setCursor(v); play(v); } },
        { label: 'Crop start here', icon: 'crop', onClick: () => { const b = snapshot(); setEdit(D.moveHandle(e, 'cropStart', snapTime(v, 'cropStart'))); commit(b); } },
        { label: 'Crop end here', icon: 'crop', onClick: () => { const b = snapshot(); setEdit(D.moveHandle(e, 'cropEnd', snapTime(v, 'cropEnd'))); commit(b); } },
        'sep',
        { label: 'Zoom to crop', icon: 'zoom-crop', kbd: 'Z', onClick: zoomToCrop },
        { label: 'Show whole selection', icon: 'zoom-out', kbd: 'Shift+Z', onClick: () => setView(0, e.duration) },
        'sep',
        { label: 'Trim selection to crop', icon: 'crop', kbd: 'T', onClick: trimSelection },
        { label: 'Reverse', icon: 'reverse', kbd: 'R', checked: e.reverse, onClick: doReverse },
        { label: 'Normalize to -0.1 dBFS', icon: 'normalize', kbd: 'N', onClick: normalize },
        'sep',
        { label: 'Reset all edits', icon: 'undo', onClick: () => { const b = snapshot(); setEdit(D.createEdit(e.duration)); commit(b); } },
    ]);
}

function fadeMenu(side) {
    const e = S.edit;
    const shape = side === 'in' ? e.fadeInShape : e.fadeOutShape, ten = side === 'in' ? e.fadeInTension : e.fadeOutTension;
    const len = side === 'in' ? e.fadeInEnd - e.cropStart : e.cropEnd - e.fadeOutStart;
    const set = patch => { const b = snapshot(); setEdit(D.normalizeEdit({ ...S.edit, ...patch })); commit(b); };
    const key = side === 'in' ? ['fadeInShape', 'fadeInTension'] : ['fadeOutShape', 'fadeOutTension'];
    return [
        { header: side === 'in' ? 'Fade-in curve' : 'Fade-out curve', graphic: fadeGlyph(shape, ten, side, { w: 44, h: 18 }) },
        ...D.FADE_PRESETS.map(p => ({ label: p.label, graphic: fadeGlyph(p.shape, p.tension, side), checked: shape === p.shape && Math.abs(ten - p.tension) < 1e-6, onClick: () => set({ [key[0]]: p.shape, [key[1]]: p.tension }) })),
        'sep',
        { label: 'Straighten (reset bend)', disabled: Math.abs(ten) < 1e-6, onClick: () => set({ [key[1]]: 0 }) },
        { label: side === 'in' ? 'Remove fade-in' : 'Remove fade-out', disabled: len <= 0, danger: true, onClick: () => set(side === 'in' ? { fadeInEnd: S.edit.cropStart } : { fadeOutStart: S.edit.cropEnd }) },
        { label: 'Copy curve to the other fade', onClick: () => set(side === 'in' ? { fadeOutShape: shape, fadeOutTension: ten } : { fadeInShape: shape, fadeInTension: ten }) },
    ];
}

/** Snap a visual time to the nearest zero crossing (crop edges), in the preview buffer. */
function snapTime(v, which) {
    if (!S.chans || !S.region) return v;
    const e = S.edit;
    const u = D.visualToSource(e, v);
    const s0 = S.region.start * S.sr;
    const pxS = span() / Math.max(1, stageSize().W);
    const rad = clamp(3 * pxS, SNAP_MIN, SNAP_MAX) * S.sr;
    const j = D.nearestZeroCrossing(S.chans, s0 + u * S.sr, rad);
    // the crop edge that is the SOURCE end must sit one sample after the zero sample (last output sample = source[end - 1])
    const isSourceEnd = (which === 'cropEnd') !== e.reverse;
    const u2 = clamp((j + (isSourceEnd ? 1 : 0) - s0) / S.sr, 0, e.duration);
    return D.sourceToVisual(e, u2);
}

// ── wheel / ruler / minimap / resize ───────────────────────────────────
function onWheel(ev) {
    if (!S.buf) return;
    ev.preventDefault();
    const W = stageSize().W;
    if (ev.altKey) {
        const b = S.coalesce ? null : snapshot();
        const delta = -(ev.deltaY || ev.deltaX) / 100 * 0.5;
        coalesced(() => setEdit(D.normalizeEdit({ ...S.edit, gainDb: Math.round((S.edit.gainDb + delta) * 100) / 100 })), b);
        return;
    }
    if (ev.ctrlKey || ev.metaKey) {
        const r = els.stage.getBoundingClientRect();
        const x = clamp(ev.clientX - r.left, 0, W);
        zoomAt(vOf(x, W), Math.exp(ev.deltaY * 0.0022));
        return;
    }
    const d = Math.abs(ev.deltaX) > Math.abs(ev.deltaY) ? ev.deltaX : ev.deltaY;
    const s = span();
    setView(S.view.start + d / W * s, S.view.end + d / W * s);
}

function zoomAt(v, factor) {
    const Dd = S.edit.duration;
    const minSpan = Math.min(Dd, Math.max(24 / S.sr, 0.0002));
    const s = clamp(span() * factor, minSpan, Dd);
    const f = (v - S.view.start) / span();
    setView(v - f * s, v - f * s + s);
}
const zoomBy = factor => zoomAt(S.cursor != null ? S.cursor : (S.view.start + S.view.end) / 2, factor);

function setView(a, b) {
    const Dd = S.edit.duration;
    let s = clamp(b - a, Math.min(Dd, Math.max(24 / S.sr, 0.0002)), Dd);
    a = clamp(a, 0, Dd - s);
    S.view = { start: a, end: a + s };
    requestDraw('all');
}

function zoomToCrop() {
    const e = S.edit, m = (e.cropEnd - e.cropStart) * 0.04;
    setView(e.cropStart - m, e.cropEnd + m);
}

function onRulerDown(ev) {
    if (ev.button !== 0 || !S.buf) return;
    ev.preventDefault(); focusEditor();
    const set = me => { const p = localPoint(me, els.ruler); setCursor(clamp(vOf(p.x, p.W), 0, S.edit.duration), { restart: false }); };
    set(ev);
    const up = () => { window.removeEventListener('mousemove', set); window.removeEventListener('mouseup', up); if (P.playing) play(S.cursor); };
    window.addEventListener('mousemove', set); window.addEventListener('mouseup', up);
}

function miniGeom() { const W = els.mini.clientWidth || 1, Dd = S.edit.duration; return { W, a: S.view.start / Dd * W, b: S.view.end / Dd * W, Dd }; }
function onMiniHover(ev) {
    if (!S.buf) return;
    const { a, b } = miniGeom(), x = localPoint(ev, els.mini).x;
    els.mini.style.cursor = Math.abs(x - a) <= 5 || Math.abs(x - b) <= 5 ? 'ew-resize' : x > a && x < b ? 'grab' : 'pointer';
}
function onMiniDown(ev) {
    if (ev.button !== 0 || !S.buf) return;
    ev.preventDefault(); focusEditor();
    const g = miniGeom(), x0 = localPoint(ev, els.mini).x;
    const toV = x => x / g.W * g.Dd;
    let mode = Math.abs(x0 - g.a) <= 5 ? 'l' : Math.abs(x0 - g.b) <= 5 ? 'r' : x0 > g.a && x0 < g.b ? 'pan' : 'jump';
    if (mode === 'jump') { const s = span(), c = toV(x0); setView(c - s / 2, c + s / 2); mode = 'pan'; }
    const v0 = { ...S.view }, start = toV(x0);
    const move = me => {
        const v = toV(localPoint(me, els.mini).x);
        if (mode === 'pan') setView(v0.start + v - start, v0.end + v - start);
        else if (mode === 'l') setView(Math.min(v, v0.end - 1e-4), v0.end);
        else setView(v0.start, Math.max(v, v0.start + 1e-4));
    };
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
}

function onResizeDown(ev) {
    if (ev.button !== 0) return;
    ev.preventDefault();
    const h0 = els.root.getBoundingClientRect().height, y0 = ev.clientY;
    const max = maxHeight();
    els.resize.classList.add('dragging');
    const move = me => { els.root.style.height = clamp(h0 - (me.clientY - y0), MIN_H, max) + 'px'; };
    const up = () => {
        window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up);
        els.resize.classList.remove('dragging');
        lsSet('sv.editor.h', String(Math.round(els.root.getBoundingClientRect().height)));
        keepRowVisible();
    };
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
}

// ── edit application / history ─────────────────────────────────────────
const snapshot = () => (S.edit ? { edit: { ...S.edit }, region: { ...S.region } } : null);
const sameRegion = (a, b) => !!a && !!b && Math.abs(a.start - b.start) < 1e-6 && Math.abs(a.end - b.end) < 1e-6;

function commit(before) {
    if (!before || !S.edit) return;
    if (D.editsEqual(before.edit, S.edit) && sameRegion(before.region, S.region)) return;
    S.hist.undo.push(before);
    if (S.hist.undo.length > 200) S.hist.undo.shift();
    S.hist.redo = [];
    updateControls();
}

/** Group bursts (wheel, arrow keys) into one undo step. */
function coalesced(fn, before = null) {
    if (!S.coalesce) S.coalesce = { before: before || snapshot(), timer: null };
    fn();
    clearTimeout(S.coalesce.timer);
    S.coalesce.timer = setTimeout(() => { const c = S.coalesce; S.coalesce = null; if (c) commit(c.before); }, 600);
}

function undo() { const s = S.hist.undo.pop(); if (!s) return; S.hist.redo.push(snapshot()); restore(s); }
function redo() { const s = S.hist.redo.pop(); if (!s) return; S.hist.undo.push(snapshot()); restore(s); }
function restore(s) {
    if (!sameRegion(s.region, S.region)) { syncListSelection(s.region, s.edit); applyRegion(s.region, s.edit); }
    else setEdit(s.edit);
    updateControls();
}

/**
 * The one way to change the edit. Structural changes restart playback at the
 * same spot (deferred until the end of a drag); gain/pitch are applied live.
 */
function setEdit(next, { gesture = false } = {}) {
    const prev = S.edit;
    S.edit = next;
    requestDraw(prev && (prev.reverse !== next.reverse) ? 'all' : 'edit');
    updateControls();
    schedulePrerender();
    if (!P.playing || !prev) return;
    const structural = ['cropStart', 'cropEnd', 'fadeInEnd', 'fadeOutStart', 'fadeInTension', 'fadeOutTension', 'duration'].some(k => Math.abs(prev[k] - next[k]) > 1e-12)
        || prev.fadeInShape !== next.fadeInShape || prev.fadeOutShape !== next.fadeOutShape || prev.reverse !== next.reverse;
    if (structural) { if (gesture) P.needsRestart = true; else restartAtCurrent(); return; }
    if (prev.gainDb !== next.gainDb && P.amp) P.amp.gain.setTargetAtTime(D.dbToGain(next.gainDb), audioCtx().currentTime, 0.008);
    if (prev.semitones !== next.semitones) liveRate(D.rateOf(next.semitones));
}

function applyRegion(region, edit) {
    S.region = { start: region.start, end: region.end };
    S.edit = edit;
    S.view = { start: 0, end: edit.duration };
    S.cursor = null;
    S.rbuf = null;
    rebuildIndex();
    renderHead();
    requestDraw('all'); updateControls(); schedulePrerender();
    if (P.playing) restartAtCurrent();
}

function syncListSelection(region, edit) {
    const fl = D.fadeLengths(edit);
    const patch = { start: region.start, end: region.end, fadeIn: edit.reverse ? fl.fadeOut : fl.fadeIn, fadeOut: edit.reverse ? fl.fadeIn : fl.fadeOut };
    S.internalSel = true;
    try {
        const cur = selection.get();
        if (cur && cur.path === S.item.path) selection.update(patch);
        else selection.set({ path: S.item.path, duration: (peaksFor(S.item.path) || {}).duration || S.buf.duration, ...patch });
    } finally { S.internalSel = false; }
    S.detached = false; renderHead();
}

function onSelectionChange({ cur }) {
    if (!S.open || S.internalSel || !S.item) return;
    if (cur && cur.path === S.item.path) {
        if (S.detached) { S.detached = false; renderHead(); }
        if (!sameRegion(cur, S.region) && S.buf) {
            const b = snapshot();
            applyRegion({ start: cur.start, end: cur.end }, D.rebaseEdit(S.edit, S.region, cur));
            commit(b);
        }
    } else if (!S.detached) { S.detached = true; renderHead(); }
}

function trimSelection() {
    if (!S.buf) return;
    const b = snapshot();
    const t = D.trimToCrop(S.edit, S.region);
    if (sameRegion(t.region, S.region)) { toast('The selection already matches the crop', { icon: 'info' }); return; }
    syncListSelection(t.region, t.edit);
    applyRegion(t.region, t.edit);
    commit(b);
    keepRowVisible();
}

function doReverse() { if (!S.buf) return; const b = snapshot(); setEdit(D.toggleReverse(S.edit)); commit(b); }

function normalize() {
    if (!S.buf) return;
    const b = snapshot();
    const g = D.normalizeGainDb({ channels: S.chans, sampleRate: S.sr, offset: S.region.start }, S.edit, -0.1);
    setEdit(D.normalizeEdit({ ...S.edit, gainDb: Math.round(g * 100) / 100 }));
    commit(b);
    toast(`Normalized: gain ${fmtDb(S.edit.gainDb)}`, { timeout: 1600 });
}

function setCursor(v, { restart = false } = {}) {
    S.cursor = v == null ? null : clamp(v, 0, S.edit.duration);
    requestDraw('cursor');
    updateClock();
    if (restart && P.playing) play(S.cursor);
}

function setLoop(on) {
    S.loop = !!on; lsSet('sv.editor.loop', S.loop ? '1' : '0');
    els.loopBtn.classList.toggle('on', S.loop);
    els.loopBtn.setAttribute('aria-pressed', String(S.loop));
    if (P.playing) restartAtCurrent();
}
function setStereo(on) {
    S.stereo = !!on; lsSet('sv.editor.stereo', S.stereo ? '1' : '0');
    els.stereoBtn.classList.toggle('on', S.stereo);
    requestDraw('all');
}
function setHelp(on) { S.help = !!on; els.help.classList.toggle('hidden', !S.help); els.helpBtn.classList.toggle('on', S.help); }
function setLoading(on) { els.loading.classList.toggle('hidden', !on); els.root.classList.toggle('loading', !!on); }

// ── playback: one live voice ───────────────────────────────────────────
function playbackBuffer() {
    const e = S.edit;
    if (!e.reverse) return { buffer: S.buf, base: S.region.start };
    if (!S.rbuf) {
        const c = audioCtx();
        const s0 = Math.max(0, Math.round(S.region.start * S.sr)), s1 = Math.min(S.buf.length, Math.round(S.region.end * S.sr));
        const n = Math.max(1, s1 - s0);
        const rb = c.createBuffer(S.buf.numberOfChannels, n, S.sr);
        for (let ch = 0; ch < S.buf.numberOfChannels; ch++) {
            const src = S.chans[ch], dst = rb.getChannelData(ch);
            for (let k = 0; k < n; k++) dst[k] = src[s1 - 1 - k];
        }
        S.rbuf = rb;
    }
    return { buffer: S.rbuf, base: 0 };
}

function play(fromV = S.cursor) {
    if (!S.buf || !S.open) return;
    const gen = ++P.gen;
    stopVoice();
    if (player.playing || player.loading) player.stop();
    const c = audioCtx();
    const e = S.edit, L = e.cropEnd - e.cropStart;
    let p0 = fromV != null ? fromV - e.cropStart : 0;
    if (!(p0 >= 0 && p0 < L - 1e-4)) p0 = 0;
    const { buffer, base } = playbackBuffer();
    const rate = D.rateOf(e.semitones);
    const src = c.createBufferSource();
    src.buffer = buffer; src.playbackRate.value = rate;
    const env = c.createGain(), amp = c.createGain();
    amp.gain.value = D.dbToGain(e.gainDb);
    src.connect(env); env.connect(amp); amp.connect(masterNode());
    const hasFades = e.fadeInEnd > e.cropStart || e.cropEnd > e.fadeOutStart;
    const when = c.currentTime;
    let ctl = null;
    if (hasFades) {
        // fade envelope as a control signal locked to the buffer timeline (follows live pitch changes and loops)
        const ctlRate = clamp(Math.ceil(4096 / Math.max(L, 1e-4)), 3000, 96000);
        const data = D.envelopeSamples(e, ctlRate);
        const cb = c.createBuffer(1, data.length, ctlRate);
        cb.copyToChannel(data, 0);
        ctl = c.createBufferSource();
        ctl.__svControl = true;
        ctl.buffer = cb; ctl.playbackRate.value = rate;
        env.gain.value = 0;
        ctl.connect(env.gain);
        if (S.loop) { ctl.loop = true; ctl.loopStart = 0; ctl.loopEnd = L; ctl.start(when, p0); }
        else ctl.start(when, p0, L - p0);
    }
    if (S.loop) { src.loop = true; src.loopStart = base + e.cropStart; src.loopEnd = base + e.cropEnd; src.start(when, base + e.cropStart + p0); }
    else src.start(when, base + e.cropStart + p0, L - p0);
    src.onended = () => { if (gen !== P.gen || P.src !== src) return; finish(); };
    Object.assign(P, { src, ctl, env, amp, playing: true, L, cs: e.cropStart, loop: S.loop, segs: [{ t: when, p: p0, r: rate }], startedAt: performance.now() });
    els.root.classList.add('playing');
    setIcon(els.play.firstChild, 'stop');
    els.play.setAttribute('aria-label', 'Stop');
    tick();
}

function stopVoice() {
    for (const n of [P.src, P.ctl]) if (n) { n.onended = null; try { n.stop(); } catch (e) { /* not started */ } n.disconnect(); }
    for (const n of [P.env, P.amp]) if (n) n.disconnect();
    P.src = P.ctl = P.env = P.amp = null;
}

function stop() {
    P.gen++;
    stopVoice();
    finish();
}

function finish() {
    P.playing = false;
    stopVoice();
    cancelAnimationFrame(P.raf); P.raf = 0;
    if (!els.root) return;
    els.root.classList.remove('playing');
    setIcon(els.play.firstChild, 'play');
    els.play.setAttribute('aria-label', 'Play edit');
    els.played.style.clipPath = 'inset(0 100% 0 0)';
    updateClock();
}

function togglePlay() { if (P.playing) stop(); else play(S.cursor); }

/** Crop position (seconds of buffer) now; raw (not wrapped) for loops. */
function rawPos(t = audioCtx().currentTime) {
    const s = P.segs[P.segs.length - 1];
    return s ? s.p + Math.max(0, t - s.t) * s.r : 0;
}
function playPos() { const p = rawPos(); return P.loop && P.L > 0 ? p % P.L : Math.min(p, P.L); }

function liveRate(r) {
    if (!P.playing || !P.src) return;
    const t = audioCtx().currentTime;
    const p = rawPos(t);
    P.src.playbackRate.setValueAtTime(r, t);
    if (P.ctl) P.ctl.playbackRate.setValueAtTime(r, t);
    P.segs.push({ t, p, r });
}

function restartAtCurrent() {
    if (!P.playing) return;
    const v = P.cs + playPos();
    play(v >= S.edit.cropStart && v < S.edit.cropEnd ? v : S.edit.cropStart);
}

function tick() {
    cancelAnimationFrame(P.raf);
    const step = () => {
        if (!P.playing) return;
        const v = P.cs + playPos();
        const { W } = stageSize();
        const x = xOf(v, W);
        els.ph.style.transform = `translateX(${x}px)`;
        els.ph.style.opacity = x >= 0 && x <= W ? '' : '0';
        const l = clamp(xOf(S.edit.cropStart, W) / W * 100, 0, 100), r = clamp(100 - x / W * 100, 0, 100);
        els.played.style.clipPath = `inset(0 ${r}% 0 ${l}%)`;
        updateClock(v);
        P.raf = requestAnimationFrame(step);
    };
    P.raf = requestAnimationFrame(step);
}

// ── export: native-rate pre-render + synchronous drag ──────────────────
function nativeRate() { const pk = peaksFor(S.item.path); return pk && pk.sampleRate > 0 ? pk.sampleRate : 0; }
function exportKey() {
    if (!S.item || !S.edit) return null;
    const r6 = v => Math.round(v * 1e6) / 1e6;
    return D.hashKey([S.item.path, S.item.mtime || 0, S.item.size || 0, r6(S.region.start), r6(S.region.end), nativeRate(), ...D.editSignature(S.edit)]);
}
const schedulePrerender = debounce(() => prerender(), EXPORT_DEBOUNCE);
function exportReady() { return !!(X.path && X.readyKey && X.readyKey === exportKey()); }
/** Huge files (e.g. 10 min at 96 kHz ≈ 460 MB decoded) are not decoded behind the user's back. */
function autoRenderOk() {
    const pk = peaksFor(S.item.path);
    if (!pk || !(pk.sampleRate > 0)) return true;
    const perSec = pk.sampleRate * (pk.channels || 2) * 4;
    return pk.duration * perSec <= autoRenderBytes && D.outputDuration(S.edit) * perSec <= autoRenderBytes;
}

async function renderNative(edit, isCancelled) {
    const sr = nativeRate();
    const buf = sr ? await decodeNative(S.item.path, sr) : S.buf;
    if (!buf || isCancelled()) return null;
    const chans = [];
    for (let c = 0; c < buf.numberOfChannels; c++) chans.push(buf.getChannelData(c));
    return D.renderEditAsync({ channels: chans, sampleRate: buf.sampleRate, offset: S.region.start }, edit, { cancelled: isCancelled });
}

async function prerender({ force = false } = {}) {
    if (!S.open || !S.buf) return;
    const key = exportKey();
    if (exportReady()) { updateExportUI(); return; }
    X.manual = !autoRenderOk();
    if (X.manual && !force) { X.gen++; X.preparing = false; X.error = null; updateExportUI(); return; }
    const gen = ++X.gen;
    const edit = { ...S.edit }, item = S.item;
    X.preparing = true; X.error = null; X.channels = null; X.pendingKey = key;
    updateExportUI();
    try {
        const r = await renderNative(edit, () => gen !== X.gen);
        if (!r || gen !== X.gen) return;
        const float = r.peak > 1;
        const res = await window.sv.audio.render({ channels: r.channels, sampleRate: r.sampleRate, bitDepth: 24, float, baseName: stripExt(item.name), suffix: `[edit ${key.slice(0, 6)}]`, key });
        if (gen !== X.gen) return;
        if (!res || res.error || !res.path) throw new Error((res && res.error) || 'Render failed');
        Object.assign(X, { readyKey: key, path: res.path, float, sr: r.sampleRate, frames: r.frames, peak: r.peak, channels: r.frames * r.channels.length <= KEEP_CHANNELS_MAX ? r.channels : null, preparing: false });
        // the drag image is built now, so dragstart only has to send the path (keeps the OS drag synchronous and instant)
        X.icon = ghostIcon({ data: peaksFor(item.path) || null, badge: true });
    } catch (err) {
        if (gen !== X.gen) return;
        X.preparing = false; X.error = err.message || String(err);
    }
    updateExportUI();
    const w = X.waiters; X.waiters = [];
    for (const f of w) f();
}

function whenExportReady() {
    if (exportReady()) return Promise.resolve(true);
    return new Promise(res => {
        X.waiters.push(() => res(exportReady()));
        schedulePrerender.cancel();
        if (!(X.preparing && X.pendingKey === exportKey())) prerender({ force: true });   // else: already rendering this edit
    });
}

function updateExportUI() {
    if (!els.drag) return;
    const ready = exportReady();
    const manual = !ready && X.manual && !X.preparing && !X.error;
    const preparing = !ready && !X.error && !manual;
    els.drag.classList.toggle('preparing', preparing);
    els.drag.classList.toggle('failed', !!X.error && !ready);
    els.drag.setAttribute('draggable', ready ? 'true' : 'false');
    els.drag.setAttribute('aria-disabled', ready ? 'false' : 'true');
    els.drag.classList.toggle('manual', manual);
    els.dragLabel.textContent = ready ? 'Drag' : X.error ? 'Export failed' : manual ? 'Prepare drag' : 'Preparing…';
    const sr = X.sr || nativeRate();
    els.drag.dataset.tip = ready
        ? `Drag the edited sound into your DAW: ${fmtRate(sr)} · ${X.float ? '32-bit float (peaks above 0 dBFS are kept)' : '24-bit'}`
        : X.error ? `Could not render: ${X.error}` : manual ? 'Long, high-rate file: click to render the edit for dragging (it is not done automatically to save memory)' : 'Rendering the edit at the file’s own sample rate…';
    els.save.disabled = !S.buf;
}

function onDragStart(ev) {
    ev.preventDefault();
    if (exportReady()) {
        const t0 = performance.now();
        window.sv.drag.start([X.path], X.icon || ghostIcon({ data: peaksFor(S.item.path) || null, badge: true }));
        X.lastDrag = { at: t0, ms: performance.now() - t0, path: X.path };
        return;
    }
    if (X.manual && !X.preparing) { toast('Click “Prepare drag” to render this long edit first', { icon: 'info', timeout: 2400 }); return; }
    toast('Preparing the edit. Drag again in a moment', { icon: 'info', timeout: 1800 });
    schedulePrerender.flush();
}

async function saveAsNew() {
    if (!S.buf) return;
    const item = S.item, edit = { ...S.edit }, key = exportKey();
    const t = toast('Saving the edit…', { timeout: 0 });
    try {
        let chans = null, sr = 0, float = false;
        if (exportReady() && X.readyKey === key && X.channels) { chans = X.channels; sr = X.sr; float = X.float; }
        else {
            const r = await renderNative(edit, () => false);
            if (!r) throw new Error('Could not render the edit');
            chans = r.channels; sr = r.sampleRate; float = r.peak > 1;
        }
        const res = await window.sv.audio.saveToLibrary({ sourcePath: item.path, channels: chans, sampleRate: sr, bitDepth: 24, float, name: `${stripExt(item.name)} edit` });
        t.close();
        if (!res || res.error) { toast((res && res.error) || 'Could not save', { kind: 'error' }); return; }
        const name = baseName(res.path);
        toast(`Saved “${stripExt(name)}” next to the original`, { action: { label: 'Show', onClick: () => bus.emit('locate', { path: res.path, dir: item.dir, name }) } });
        return res.path;
    } catch (err) {
        t.close();
        toast(err.message || 'Could not save', { kind: 'error' });
    }
}

// ── controls / readouts ────────────────────────────────────────────────
const fmtRate = sr => (sr ? (sr % 1000 === 0 ? sr / 1000 : (sr / 1000).toFixed(1)) + ' kHz' : '');
const fmtDb = db => (db > 0 ? '+' : db < 0 ? '-' : '') + Math.abs(db).toFixed(1) + ' dB';
function fmtT(s) {
    if (!Number.isFinite(s)) return '-';
    const a = Math.abs(s), sign = s < 0 ? '-' : '';
    if (a < 1) return sign + (a * 1000).toFixed(a < 0.01 ? 2 : 1) + ' ms';
    if (a < 60) return sign + a.toFixed(3) + ' s';
    const m = Math.floor(a / 60);
    return sign + m + ':' + (a - m * 60).toFixed(3).padStart(6, '0');
}

function renderHead() {
    if (!S.item) return;
    els.name.textContent = stripExt(S.item.name);
    els.name.title = S.item.path;
    els.range.textContent = S.region ? `${fmtT(S.region.start)} to ${fmtT(S.region.end)}` : '';
    const pk = peaksFor(S.item.path);
    els.fmt.textContent = pk ? formatFormat(pk) : '';
    els.fmt.classList.toggle('hidden', !pk);
    els.detached.classList.toggle('hidden', !S.detached);
}

function updateControls() {
    if (!els.root || !S.edit) return;
    const e = S.edit;
    els.undo.disabled = !S.hist.undo.length; els.redo.disabled = !S.hist.redo.length;
    els.rev.classList.toggle('on', e.reverse); els.rev.setAttribute('aria-pressed', String(e.reverse));
    els.loopBtn.classList.toggle('on', S.loop);
    els.stereoBtn.classList.toggle('on', S.stereo);
    els.stereoBtn.disabled = !S.buf || S.buf.numberOfChannels < 2;
    if (document.activeElement !== els.gain) { els.gain.value = String(clamp(e.gainDb, -30, 30)); }
    if (document.activeElement !== els.pitch) { els.pitch.value = String(clamp(e.semitones, -24, 24)); }
    els.gain.style.setProperty('--pct', ((clamp(e.gainDb, -30, 30) + 30) / 60 * 100) + '%');
    els.pitch.style.setProperty('--pct', ((clamp(e.semitones, -24, 24) + 24) / 48 * 100) + '%');
    if (document.activeElement !== els.gainN && document.activeElement !== els.pitchN) syncNumbers();
    const fl = D.fadeLengths(e);
    const peak = S.ix ? cropPeak() : 0;
    const outLen = D.outputDuration(e);
    const kv = (k, v, cls = '', tip = null) => h('span' + (cls ? '.' + cls : ''), { 'data-tip': tip }, h('i', { text: k }), h('b', { text: v }));
    const fade = s => (s > 0 ? fmtT(s) : 'Off');
    // Fades show their curve; clicking one opens the curve shapes.
    const fadeKv = side => {
        const len = side === 'in' ? fl.fadeIn : fl.fadeOut;
        const el = h('span.fade-kv', { role: 'button', tabindex: '0', 'data-tip': len > 0 ? 'Click to change the curve' : 'Drag a top square on the waveform to add a fade' },
            h('i', { text: side === 'in' ? 'Fade in' : 'Fade out' }),
            len > 0 ? fadeGlyph(side === 'in' ? e.fadeInShape : e.fadeOutShape, side === 'in' ? e.fadeInTension : e.fadeOutTension, side, { w: 22, h: 12 }) : null,
            h('b', { text: fade(len) }));
        const open = () => { if (len > 0) showMenu(el, fadeMenu(side)); };
        el.addEventListener('click', open);
        el.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(); } });
        return el;
    };
    els.readouts.replaceChildren(...[
        kv('Crop', fmtT(D.cropLength(e)), '', 'Length of the kept audio'),
        fadeKv('in'),
        fadeKv('out'),
        S.ix ? (peak > 1 ? kv('CLIP', '+' + D.gainToDb(peak).toFixed(1) + ' dB', 'clip', 'The edit exceeds 0 dBFS, so it is exported as 32-bit float. Lower the gain or normalize') : kv('Peak', peak > 0 ? D.gainToDb(peak).toFixed(1) + ' dBFS' : '-∞', '', 'Peak of the edited sound')) : null,
        Math.abs(e.semitones) > 1e-6 ? kv('Result', fmtT(outLen), '', 'Length of the exported file (varispeed changes it)') : null,
    ].filter(Boolean));
    els.clip.classList.toggle('hidden', !(peak > 1));
    if (peak > 1) els.clip.textContent = `CLIP +${D.gainToDb(peak).toFixed(1)} dB`;
    updateClock();
    updateExportUI();
}

function updateClock(v = null) {
    if (!els.clock || !S.edit) return;
    const e = S.edit;
    const pos = v != null ? v : S.cursor;
    els.clock.textContent = fmtT(pos == null ? 0 : pos - e.cropStart);     // no cursor: play starts at the crop start
    els.clock.dataset.tip = pos == null ? 'Click the ruler or the waveform to set the play cursor' : (P.playing ? 'Playback position (from the crop start)' : 'Cursor (from the crop start). Space plays from here');
}

function syncNumbers() {
    const e = S.edit;
    if (!e || !els.gainN) return;
    els.gainN.value = (e.gainDb > 0 ? '+' : '') + e.gainDb.toFixed(1) + ' dB';
    els.pitchN.value = (e.semitones > 0 ? '+' : '') + (Math.round(e.semitones * 100) / 100).toFixed(Math.abs(e.semitones % 1) > 1e-9 ? 2 : 0) + ' st';
}

/** Peak of the edited crop (fades × gain), from the pyramid, for the CLIP indicator and readouts. */
function cropPeak() {
    const e = S.edit, cols = 1024, r = D.sourceRange(e), sr = S.sr;
    const w = D.waveColumns(S.ix, r.start * sr, r.end * sr, cols, { reverse: e.reverse });
    const L = e.cropEnd - e.cropStart;
    let p = 0;
    for (let i = 0; i < cols; i++) {
        const v0 = e.cropStart + L * i / cols, v1 = e.cropStart + L * (i + 1) / cols;
        const a = Math.max(Math.abs(w.min[0][i]), Math.abs(w.max[0][i])) * D.envelopeMax(e, v0, v1);
        if (a > p) p = a;
    }
    return p * D.dbToGain(e.gainDb);
}

// ── drawing ────────────────────────────────────────────────────────────
function rebuildIndex() {
    if (!S.buf || !S.region) { S.ix = null; return; }
    const s0 = clamp(Math.round(S.region.start * S.sr), 0, S.buf.length), s1 = clamp(Math.round(S.region.end * S.sr), s0, S.buf.length);
    S.ix = D.buildWaveIndex(S.chans, s0, s1, 64);
    S.miniCols = null;
}

function requestDraw(what = 'all') {
    if (what === 'all' || what === 'edit') Object.assign(S.dirty, { wave: true, over: true, ruler: true, mini: what === 'all' || S.dirty.mini });
    if (what === 'edit') S.dirty.mini = true;
    if (what === 'over' || what === 'cursor') { S.dirty.over = true; S.dirty.ruler = true; }
    if (S.raf) return;
    S.raf = requestAnimationFrame(() => {
        S.raf = 0;
        if (!S.open) return;
        const d = S.dirty; S.dirty = { wave: false, over: false, ruler: false, mini: false };
        if (d.wave) drawWave();
        if (d.over) drawOverlay();
        if (d.ruler) drawRuler();
        if (d.mini) drawMini();
    });
}

function fit(cv) {
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth, hh = cv.clientHeight;
    if (!w || !hh) return null;
    const W = Math.round(w * dpr), H = Math.round(hh * dpr);
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    const c = cv.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, hh);
    return [w, hh, c];
}

function palette() {
    if (S.pal) return S.pal;
    const cs = getComputedStyle(els.root);
    const v = n => cs.getPropertyValue(n).trim();
    const rgb = v('--accent-rgb') || '200, 247, 109';
    return (S.pal = {
        accent: v('--accent') || '#c8f76d', rgb, wave: v('--ed-wave') || '#5a5963', rms: v('--ed-rms') || '#8a8893', dim: v('--ed-dim') || '#2b2b31', dimRms: v('--ed-dim-rms') || '#3a3a42',
        fg1: v('--fg-1'), fg2: v('--fg-2'), fg3: v('--fg-3'), fg4: v('--fg-4'), line: v('--line'), line2: v('--line-2'), danger: v('--danger') || '#ff6b6b', bg0: v('--bg-0'),
    });
}

function lanesOf() { return S.stereo && S.ix && S.ix.nc > 1 ? Math.min(8, S.ix.nc) : 1; }

function drawWave() {
    const fw = fit(els.wave), fp = fit(els.played);
    if (!fw || !fp || !S.ix) { S.last = null; return; }
    const [W, H, c] = fw, cp = fp[2];
    const e = S.edit, pal = palette(), g = D.dbToGain(e.gainDb), sr = S.sr;
    const vs = S.view.start, ve = S.view.end, sp = ve - vs;
    const lanes = lanesOf(), laneH = H / lanes;
    const cols = Math.max(1, Math.round(W));
    const u0 = e.reverse ? e.duration - ve : vs, u1 = e.reverse ? e.duration - vs : ve;
    const spc = (u1 - u0) * sr / cols;
    const xcs = xOf(e.cropStart, W), xce = xOf(e.cropEnd, W);
    const scale = new Float32Array(cols), inside = new Uint8Array(cols);
    for (let i = 0; i < cols; i++) {
        const v0 = vs + sp * i / cols, v1 = vs + sp * (i + 1) / cols;
        const ins = v1 > e.cropStart && v0 < e.cropEnd;
        inside[i] = ins ? 1 : 0;
        scale[i] = ins ? D.envelopeMax(e, v0, v1) * g : g;
    }
    const last = { W, H, cols, lanes, spc, amp: [], clipCols: [], inside, view: { ...S.view } };
    const clipAt = (x0, x1) => { c.save(); c.beginPath(); c.rect(x0, 0, x1 - x0, H); c.clip(); };
    if (spc >= 2) {
        const w = D.waveColumns(S.ix, u0 * sr, u1 * sr, cols, { perChannel: lanes > 1, reverse: e.reverse });
        for (let l = 0; l < lanes; l++) {
            const mid = laneH * l + laneH / 2, half = laneH / 2 - 2;
            const top = new Float32Array(cols + 1), bot = new Float32Array(cols + 1), rt = new Float32Array(cols + 1), amp = new Float32Array(cols);
            for (let i = 0; i < cols; i++) {
                const k = scale[i];
                let hi = w.max[l][i] * k, lo = w.min[l][i] * k, rm = w.rms[l][i] * k;
                if (inside[i] && (hi > 1 || lo < -1)) last.clipCols.push(i);
                hi = clamp(hi, -1, 1); lo = clamp(lo, -1, 1); rm = Math.min(rm, 1);
                const t = mid - hi * half, b = mid - lo * half;
                top[i] = Math.min(t, mid - 0.5); bot[i] = Math.max(b, mid + 0.5);
                rt[i] = Math.min(rm * half, Math.max(0, (b - t) / 2));
                amp[i] = Math.max(Math.abs(hi), Math.abs(lo));
            }
            top[cols] = top[cols - 1]; bot[cols] = bot[cols - 1]; rt[cols] = rt[cols - 1];
            last.amp.push(amp);
            // step shapes: pixel column i shows exactly column i (no half-pixel smear between columns)
            const cw = W / cols;
            const shape = (ctx, a, b) => {
                ctx.beginPath(); ctx.moveTo(0, a[0]);
                for (let i = 0; i < cols; i++) { ctx.lineTo(i * cw, a[i]); ctx.lineTo((i + 1) * cw, a[i]); }
                for (let i = cols - 1; i >= 0; i--) { ctx.lineTo((i + 1) * cw, b[i]); ctx.lineTo(i * cw, b[i]); }
                ctx.closePath(); ctx.fill();
            };
            const core = (ctx) => {
                ctx.beginPath(); ctx.moveTo(0, mid - rt[0]);
                for (let i = 0; i < cols; i++) { ctx.lineTo(i * cw, mid - rt[i]); ctx.lineTo((i + 1) * cw, mid - rt[i]); }
                for (let i = cols - 1; i >= 0; i--) { ctx.lineTo((i + 1) * cw, mid + rt[i]); ctx.lineTo(i * cw, mid + rt[i]); }
                ctx.closePath(); ctx.fill();
            };
            // outside the crop: dim, unfaded (context); inside: the edited picture
            for (const [x0, x1] of [[0, Math.max(0, xcs)], [Math.min(W, xce), W]]) {
                if (x1 - x0 < 0.5) continue;
                clipAt(x0, x1); c.fillStyle = pal.dim; shape(c, top, bot); c.fillStyle = pal.dimRms; core(c); c.restore();
            }
            const a = clamp(xcs, 0, W), b = clamp(xce, 0, W);
            if (b - a > 0) {
                clipAt(a, b); c.fillStyle = pal.wave; shape(c, top, bot); c.fillStyle = pal.rms; core(c); c.restore();
                cp.save(); cp.beginPath(); cp.rect(a, 0, b - a, H); cp.clip();
                cp.fillStyle = `rgba(${pal.rgb}, .45)`; shape(cp, top, bot); cp.fillStyle = pal.accent; core(cp); cp.restore();
            }
        }
    } else {
        // sample level: draw the samples themselves
        const s0 = Math.floor(u0 * sr) - 1, s1 = Math.ceil(u1 * sr) + 1;
        for (let l = 0; l < lanes; l++) {
            const mid = laneH * l + laneH / 2, half = laneH / 2 - 2;
            const amp = new Float32Array(cols);
            const pts = [];
            for (let s = Math.max(0, s0); s <= Math.min(S.ix.len - 1, s1); s++) {
                const u = (s + 0.5) / sr, v = e.reverse ? e.duration - u : u;
                const x = (v - vs) / sp * W;
                let val = 0;
                if (lanes > 1) val = S.chans[l][S.ix.start + s];
                else { let m = 0; for (let ch = 0; ch < S.ix.nc; ch++) { const q = S.chans[ch][S.ix.start + s]; if (Math.abs(q) > Math.abs(m)) m = q; } val = m; }
                const ins = v >= e.cropStart && v <= e.cropEnd;
                const k = ins ? D.envelopeAt(e, v) * g : g;
                const y = clamp(val * k, -1, 1);
                pts.push([x, mid - y * half, ins]);
                const ci = Math.floor(x / W * cols);
                if (ci >= 0 && ci < cols) amp[ci] = Math.max(amp[ci], Math.abs(y));
                if (ins && Math.abs(val * k) > 1 && ci >= 0 && ci < cols) last.clipCols.push(ci);
            }
            pts.sort((p, q) => p[0] - q[0]);
            last.amp.push(amp);
            for (const [ctx, color] of [[c, pal.rms], [cp, pal.accent]]) {
                ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = 1.25; ctx.beginPath();
                pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
                ctx.stroke();
                if (sp * sr < W / 6) { ctx.fillStyle = color; for (const [x, y] of pts) { ctx.beginPath(); ctx.arc(x, y, 1.8, 0, Math.PI * 2); ctx.fill(); } }
                ctx.restore();
            }
        }
    }
    S.last = last;
}

function drawOverlay() {
    const f = fit(els.over);
    if (!f || !S.edit) return;
    const [W, H, c] = f;
    const e = S.edit, pal = palette(), hov = S.drag ? S.drag.kind : S.hover && S.hover.kind;
    const x = v => xOf(v, W);
    const xcs = x(e.cropStart), xce = x(e.cropEnd), xfi = x(e.fadeInEnd), xfo = x(e.fadeOutStart);
    // lanes: centre lines and separators
    const lanes = lanesOf(), laneH = H / lanes;
    c.fillStyle = pal.line;
    for (let l = 0; l < lanes; l++) { c.fillRect(0, Math.round(laneH * l + laneH / 2), W, 1); if (l) c.fillRect(0, Math.round(laneH * l), W, 1); }
    // cropped-out shade
    c.fillStyle = 'rgba(6, 6, 8, .5)';
    if (xcs > 0) c.fillRect(0, 0, Math.min(W, xcs), H);
    if (xce < W) c.fillRect(Math.max(0, xce), 0, W - Math.max(0, xce), H);
    // fade zones + curves
    const zone = (a, b, dir, hot) => {
        const x0 = clamp(a, 0, W), x1 = clamp(b, 0, W);
        if (x1 - x0 < 0.5) return;
        const gr = c.createLinearGradient(a, 0, b, 0);
        const s = hot ? 0.2 : 0.11;
        gr.addColorStop(dir > 0 ? 0 : 1, `rgba(${pal.rgb}, ${s})`); gr.addColorStop(dir > 0 ? 1 : 0, `rgba(${pal.rgb}, 0)`);
        c.fillStyle = gr; c.fillRect(x0, 0, x1 - x0, H);
    };
    zone(xcs, xfi, 1, /In$/.test(hov || '')); zone(xfo, xce, -1, /Out$/.test(hov || ''));
    const curve = (a, b, hot) => {
        const x0 = Math.max(0, Math.floor(a)), x1 = Math.min(W, Math.ceil(b));
        if (x1 - x0 < 1) return;
        c.beginPath();
        for (let px = x0; px <= x1; px++) { const y = curveY(D.envelopeAt(e, clamp(vOf(px, W), e.cropStart, e.cropEnd)), H); px === x0 ? c.moveTo(px, y) : c.lineTo(px, y); }
        c.strokeStyle = hot ? pal.accent : `rgba(${pal.rgb}, .85)`; c.lineWidth = hot ? 2.2 : 1.5; c.stroke();
    };
    curve(xcs, xfi, hov === 'bendIn'); curve(xfo, xce, hov === 'bendOut');
    // fade handles (squares in the top band) + guide lines
    const square = (px, hot) => {
        if (px < -8 || px > W + 8) return;
        c.save(); c.setLineDash([2, 3]); c.strokeStyle = `rgba(${pal.rgb}, .35)`; c.lineWidth = 1;
        c.beginPath(); c.moveTo(Math.round(px) + 0.5, TOP_BAND - 4); c.lineTo(Math.round(px) + 0.5, H); c.stroke(); c.restore();
        const s = hot ? 11 : 9;
        c.fillStyle = pal.accent; c.strokeStyle = pal.bg0; c.lineWidth = 1.5;
        c.beginPath(); c.roundRect(px - s / 2, 11 - s / 2, s, s, 2); c.fill(); c.stroke();
    };
    square(xfi, hov === 'fadeIn' || hov === 'fadeStack'); square(xfo, hov === 'fadeOut' || hov === 'fadeStack');
    // crop edges with grab tabs (skipped when off-screen: nothing is pinned to the view edges)
    const edge = (px, hot, dir) => {
        if (px < -6 || px > W + 6) return;
        c.fillStyle = hot ? pal.fg1 : pal.accent;
        c.fillRect(Math.round(px) - 1, 0, 2, H);
        const tw = 7, th = 26, ty = H / 2 - th / 2;
        c.beginPath(); c.roundRect(dir > 0 ? px : px - tw, ty, tw, th, 3); c.fill();
        c.fillStyle = pal.bg0; for (let i = -1; i <= 1; i++) c.fillRect((dir > 0 ? px + 3 : px - 4), H / 2 + i * 5 - 0.5, 1, 1.5);
    };
    edge(xcs, hov === 'cropStart', 1); edge(xce, hov === 'cropEnd', -1);
    // clip marks
    if (S.last && S.last.clipCols.length) {
        c.fillStyle = pal.danger;
        const cw = W / S.last.cols;
        for (const i of S.last.clipCols) { c.fillRect(i * cw, 0, Math.max(1, cw), 2); c.fillRect(i * cw, H - 2, Math.max(1, cw), 2); }
    }
    // cursor
    if (S.cursor != null) {
        const xc = x(S.cursor);
        if (xc >= 0 && xc <= W) { c.fillStyle = pal.fg2; c.fillRect(Math.round(xc), 0, 1, H); }
    }
    if (hov === 'slip' && S.drag) { c.fillStyle = `rgba(${pal.rgb}, .06)`; c.fillRect(clamp(xfi, 0, W), 0, clamp(xfo, 0, W) - clamp(xfi, 0, W), H); }
}

const NICE = [0.0001, 0.0002, 0.0005, 0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
function drawRuler() {
    const f = fit(els.rulerCv);
    if (!f || !S.edit) return;
    const [W, H, c] = f;
    const pal = palette(), e = S.edit, sp = span();
    // crop range bar
    const a = clamp(xOf(e.cropStart, W), 0, W), b = clamp(xOf(e.cropEnd, W), 0, W);
    c.fillStyle = `rgba(${pal.rgb}, .16)`; c.fillRect(a, H - 4, b - a, 4);
    const step = NICE.find(s => s / sp * W >= 84) || NICE[NICE.length - 1];
    const minor = step / 5;
    c.font = '10.5px ' + getComputedStyle(els.root).fontFamily;
    c.textBaseline = 'top';
    const first = Math.floor(S.view.start / minor) * minor;
    for (let t = first; t <= S.view.end + minor; t += minor) {
        const px = xOf(t, W);
        if (px < -1 || px > W + 1) continue;
        const major = Math.abs(t / step - Math.round(t / step)) < 1e-6;
        c.fillStyle = major ? pal.fg4 : pal.line2;
        c.fillRect(Math.round(px), major ? H - 9 : H - 5, 1, major ? 9 : 5);
        if (major) { c.fillStyle = pal.fg3; c.fillText(rulerLabel(Math.max(0, t), step), Math.round(px) + 3, 3); }
    }
    if (S.cursor != null) {
        const xc = xOf(S.cursor, W);
        if (xc >= -5 && xc <= W + 5) { c.fillStyle = pal.fg1; c.beginPath(); c.moveTo(xc - 5, 0); c.lineTo(xc + 5, 0); c.lineTo(xc, 7); c.closePath(); c.fill(); }
    }
}
function rulerLabel(t, step) {
    if (step < 0.001) return (t * 1000).toFixed(2) + ' ms';
    if (step < 0.1 && t < 1) return (t * 1000).toFixed(step < 0.01 ? 1 : 0) + ' ms';
    if (t < 60) return t.toFixed(step < 0.01 ? 3 : step < 0.1 ? 2 : step < 1 ? 1 : 0) + ' s';
    const m = Math.floor(t / 60), s = t - m * 60;
    return m + ':' + (step < 1 ? s.toFixed(1).padStart(4, '0') : String(Math.round(s)).padStart(2, '0'));
}

function drawMini() {
    const f = fit(els.miniCv);
    if (!f || !S.ix) return;
    const [W, H, c] = f;
    const pal = palette(), e = S.edit;
    const cols = Math.max(1, Math.round(W));
    if (!S.miniCols || S.miniCols.cols !== cols || S.miniCols.rev !== e.reverse) {
        const w = D.waveColumns(S.ix, 0, S.ix.len, cols, { reverse: e.reverse });
        const a = new Float32Array(cols);
        for (let i = 0; i < cols; i++) a[i] = Math.max(Math.abs(w.min[0][i]), Math.abs(w.max[0][i]));
        let m = 0; for (const v of a) m = Math.max(m, v);
        S.miniCols = { cols, rev: e.reverse, a, norm: m > 0 ? 1 / m : 1 };
    }
    const { a, norm } = S.miniCols, mid = H / 2, half = H / 2 - 1.5;
    const Dd = e.duration, xa = e.cropStart / Dd * W, xb = e.cropEnd / Dd * W;
    for (let i = 0; i < cols; i++) {
        const hh = Math.max(0.5, a[i] * norm * half);
        c.fillStyle = i >= xa && i <= xb ? pal.rms : pal.dim;
        c.fillRect(i, mid - hh, 1, hh * 2);
    }
    const va = S.view.start / Dd * W, vb = S.view.end / Dd * W;
    c.fillStyle = `rgba(${pal.rgb}, .1)`; c.fillRect(va, 0, vb - va, H);
    c.strokeStyle = `rgba(${pal.rgb}, .7)`; c.lineWidth = 1; c.strokeRect(va + 0.5, 0.5, Math.max(1, vb - va - 1), H - 1);
}

// ── session memory ─────────────────────────────────────────────────────
function remember() {
    if (S.item && S.edit && S.region) S.memory.set(S.item.path, { region: { ...S.region }, edit: { ...S.edit }, hist: S.hist });
    if (S.memory.size > 50) S.memory.delete(S.memory.keys().next().value);
}

// ── test hooks (E2E scenarios import this module in the page) ──────────
export const __editorTest = {
    isOpen: () => S.open,
    ready: () => !!(S.open && S.buf && S.ix),
    edit: () => (S.edit ? { ...S.edit } : null),
    region: () => (S.region ? { ...S.region } : null),
    view: () => ({ ...S.view }),
    cursor: () => S.cursor,
    setView: (a, b) => setView(a, b),
    setEdit: (patch, withHistory = true) => { const b = snapshot(); setEdit(D.normalizeEdit({ ...S.edit, ...patch })); if (withHistory) commit(b); return { ...S.edit }; },
    stereo: on => setStereo(on),
    loop: on => (on === undefined ? S.loop : setLoop(on)),
    history: () => ({ undo: S.hist.undo.length, redo: S.hist.redo.length }),
    playing: () => P.playing,
    voices: () => (P.src ? 1 : 0),
    playStartedAt: () => P.startedAt,
    live: () => (P.src ? { rate: P.src.playbackRate.value, gain: P.amp.gain.value, loop: P.src.loop, control: !!P.ctl, gen: P.gen } : null),
    position: () => (P.playing ? P.cs + playPos() : null),
    geometry: () => { const r = els.stage.getBoundingClientRect(); const e = S.edit; const W = r.width; return { left: r.left, top: r.top, width: r.width, height: r.height, cropStart: xOf(e.cropStart, W), cropEnd: xOf(e.cropEnd, W), fadeInEnd: xOf(e.fadeInEnd, W), fadeOutStart: xOf(e.fadeOutStart, W), topBand: TOP_BAND }; },
    xOf: v => xOf(v), hit: (x, y) => hitTest(x, y),
    picture: () => S.last && { W: S.last.W, H: S.last.H, cols: S.last.cols, lanes: S.last.lanes, spc: S.last.spc, amp: S.last.amp.map(a => Array.from(a)), inside: Array.from(S.last.inside), clipCols: S.last.clipCols.length, view: S.last.view },
    renderPreview: () => D.renderEdit({ channels: S.chans, sampleRate: S.sr, offset: S.region.start }, S.edit, { resampler: 'linear' }),
    exportInfo: () => ({ key: exportKey(), readyKey: X.readyKey, path: X.path, ready: exportReady(), preparing: X.preparing, float: X.float, sr: X.sr, frames: X.frames, peak: X.peak, error: X.error, lastDrag: X.lastDrag || null, dragLabel: els.dragLabel && els.dragLabel.textContent, draggable: els.drag && els.drag.getAttribute('draggable') }),
    whenExportReady: () => whenExportReady(),
    renderExport: () => renderNative({ ...S.edit }, () => false),
    autoRenderLimit: bytes => { const prev = autoRenderBytes; if (bytes > 0) autoRenderBytes = bytes; return prev; },
    save: () => saveAsNew(),
    close: () => closeEditor(),
};
