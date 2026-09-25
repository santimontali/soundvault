// Auditionable sounds outside the virtual list (Brief cards, reference tiles,
// the review sheet): lazy mini waveforms, play/pause state, playback progress.
//  • Peaks are requested only when a waveform scrolls into view.
//  • Canvases are drawn once per size; progress is a clip-path, as in the list.
//  • One rAF loop runs only while something plays.
import { h, setIcon, formatDuration } from '../util.js';
import { bus } from '../store.js';
import { player } from '../audio/engine.js';
import { peaksFor, requestPeaks } from '../audio/peaks.js';
import { drawPair, setProgress } from './waveform.js';

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
        const el = e.target;
        if (el._pk === undefined || !el.isConnected) continue;
        const size = el.clientWidth + 'x' + el.clientHeight;
        if (size !== el._size) draw(el);
    }
});

/**
 * Mini waveform for `item` (path, mtime, size). `onPeaks(pk)` runs once the
 * peaks are known (pk is null for unreadable files), e.g. to show the duration.
 */
export function miniWave(item, onPeaks = null) {
    const el = h('span.mw', { 'aria-hidden': 'true' }, h('canvas'), h('canvas.played'));
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

function paint(el, pk) {
    el._pk = pk;
    if (el._onPeaks) { try { el._onPeaks(pk); } catch (e) { console.warn('[audition]', e); } }
    if (el.isConnected) draw(el);
}

function draw(el) {
    const [base, played] = el.children;
    drawPair(base, played, el._pk);
    el._size = el.clientWidth + 'x' + el.clientHeight;
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

/** Redraw everything already drawn (accent color changed). */
export function redrawAll() {
    for (const el of waves) if (el._pk !== undefined && el.isConnected) draw(el);
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
bus.on('accent', redrawAll);
