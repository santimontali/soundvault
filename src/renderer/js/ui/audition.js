// Auditionable sounds outside the virtual list (Brief cards, reference tiles,
// the review sheet): lazy mini waveforms, play/pause state, playback progress.
//  • Peaks are requested only when a waveform scrolls into view.
//  • Canvases are drawn once per size (hiding and showing a page redraws
//    nothing); progress is a clip-path, as in the list.
//  • One rAF loop runs only while something plays.
import { h, setIcon, formatDuration } from '../util.js';
import { bus } from '../store.js';
import { player } from '../audio/engine.js';
import { peaksFor, requestPeaks } from '../audio/peaks.js';
import { drawPair, setProgress, retint } from './waveform.js';

const waves = new Set();            // live .mw elements
let current = [];                   // .mw elements of the sound that is playing
let currentPath = null;
let raf = null;

const io = new IntersectionObserver(entries => {
    for (const e of entries) {
        if (!e.isIntersecting) continue;
        io.unobserve(e.target);
        load(e.target);
    }
}, { rootMargin: '120px 0px' });

const ro = new ResizeObserver(entries => {
    for (const e of entries) {
        const el = e.target, w = Math.round(e.contentRect.width), h = Math.round(e.contentRect.height);
        if (el._pk === undefined || !el.isConnected || !w || !h) continue;   // hidden: keep the pixels
        if (w + 'x' + h !== el._size) draw(el, [w, h]);
    }
});

/**
 * Mini waveform for `item` (path, mtime, size). `onPeaks(pk)` runs once the
 * peaks are known (pk is null for unreadable files), e.g. to show the duration.
 */
export function miniWave(item, onPeaks = null) {
    const el = h('span.mw', { 'aria-hidden': 'true' }, h('canvas'), h('canvas.played'));
    // Small canvases stay on the CPU: painted with the page instead of one GPU layer
    // each (hundreds of them made every frame's compositing update slow).
    for (const cv of el.children) cv.getContext('2d', { willReadFrequently: true });
    el._item = item;
    el._onPeaks = onPeaks;
    waves.add(el);
    io.observe(el);
    ro.observe(el);
    if (item.path === currentPath) current.push(el);
    return el;
}

/** Duration text for an item once its peaks are known ('' until then). */
export const durationOf = pk => (pk ? formatDuration(pk.duration) : pk === null ? 'unreadable' : '');

function load(el) {
    const it = el._item;
    const pk = peaksFor(it.path);
    if (pk !== undefined) return paint(el, pk);
    requestPeaks(it).then(d => paint(el, d));
}

// Peaks arrive in batches: their waves are drawn together on the next frame,
// every size read first (one layout), so a batch never forces a layout per canvas.
const queued = new Set();
let flushing = 0;
function paint(el, pk) {
    el._pk = pk;
    if (el._onPeaks) { try { el._onPeaks(pk); } catch (e) { console.warn('[audition]', e); } }
    queued.add(el);
    if (!flushing) flushing = requestAnimationFrame(flush);
}

function flush() {
    flushing = 0;
    const els = [...queued].filter(el => el.isConnected);
    queued.clear();
    const sizes = els.map(el => [el.clientWidth, el.clientHeight]);
    els.forEach((el, i) => draw(el, sizes[i]));
}

function draw(el, size) {
    if (!size[0] || !size[1]) return;        // hidden: drawn once it shows (the size observer sees it)
    const [base, played] = el.children;
    drawPair(base, played, el._pk, { size });
    el._size = size[0] + 'x' + size[1];
    if (el._item.path === currentPath) progress();
    else setProgress(played, 0);
}

/** Forget waveforms that left the DOM (call after re-rendering a region). */
export function sweep() {
    for (const el of waves) {
        if (el.isConnected) continue;
        io.unobserve(el); ro.unobserve(el); waves.delete(el);
    }
    current = current.filter(el => el.isConnected);
}

/** The accent changed: the playing sound's copies re-tint now, the others when they play. */
function retintCurrent() {
    for (const el of current) if (el._pk !== undefined && el.isConnected) retint(el.children[1], el._pk);
}

/** Play `item`, or pause / resume it when it is already the current sound. */
export function audition(item) {
    if (!item || item.missing) return;
    bus.emit('list:toggle-item', item);
}

/**
 * Mark the auditionable elements under `root` (class `aud`, with `_item`):
 * .playing while the sound plays or loads (as list rows do), and the
 * play/pause glyph of an `.pb-i` icon inside.
 */
export function paintPlaying(root) {
    if (!root) return;
    const cur = player.sound ? player.sound.path : null;
    const live = !!cur && (player.playing || player.loading);
    for (const el of root.querySelectorAll('.aud')) {
        const mine = !!cur && !!el._item && el._item.path === cur;
        el.classList.toggle('playing', mine && live);
        const ic = el.querySelector('.pb-i');
        if (ic) setIcon(ic, mine && player.playing ? 'pause' : 'play');
        const btn = ic && ic.closest('button');
        if (btn) btn.setAttribute('aria-label', mine && player.playing ? 'Pause' : 'Play');
    }
}

function progress() {
    if (!player.sound) return;
    const pk = peaksFor(player.sound.path);
    const d = (pk && pk.duration) || player.fileDuration || player.duration;
    if (!(d > 0)) return;
    const f = player.position() / d;
    for (const el of current) if (el.isConnected) setProgress(el.children[1], f);
}

function onState() {
    const path = player.sound ? player.sound.path : null;
    if (path !== currentPath) {
        for (const el of current) setProgress(el.children[1], 0);
        currentPath = path;
        current = path ? [...waves].filter(el => el._item.path === path && el.isConnected) : [];
        retintCurrent();
    }
    progress();
    if (raf || !(player.playing || player.loading)) return;
    const tick = () => {
        raf = null;
        progress();
        if (player.playing || player.loading) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
}
player.on('state', onState);
bus.on('accent', retintCurrent);
