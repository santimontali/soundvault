// Waveform rendering: mirrored filled peak envelope with an RMS core.
// Canvases are drawn once per (data, size, color), playback progress is a
// clip-path on a second, accent-colored canvas, so nothing redraws per frame.
// A played canvas remembers the accent it was drawn with: when the accent
// changes only the visible ones are re-tinted at once, the others (fully
// clipped until they play) when they next show progress.
import { amp } from '../audio/peaks.js';
import { hexToRgb } from '../util.js';

let palette = null, neutrals = null, version = 0;
/** New accent (theme.js). No style read: the neutral wave colors are constants, read once. */
export function setPalette(accent) {
    if (!neutrals) {
        const cs = getComputedStyle(document.documentElement);
        neutrals = { wave: cs.getPropertyValue('--wave').trim(), rms: cs.getPropertyValue('--wave-rms').trim(), dim: cs.getPropertyValue('--wave-dim').trim() };
    }
    const { r, g, b } = hexToRgb(accent);
    palette = { ...neutrals, accentPeak: `rgba(${r}, ${g}, ${b}, .5)`, accentRms: accent };
    version++;
}
export const colors = () => { if (!palette) setPalette('#c8f76d'); return palette; };

/**
 * Ensure the canvas backing store matches its CSS size × DPR. Returns [w, h] in CSS px or null.
 * `size` ([w, h], already measured) spares the layout read when many canvases are drawn in a row.
 */
export function fitCanvas(cv, size = null) {
    const dpr = window.devicePixelRatio || 1;
    const w = size ? size[0] : cv.clientWidth, h = size ? size[1] : cv.clientHeight;
    if (!w || !h) return null;
    const W = Math.round(w * dpr), H = Math.round(h * dpr);
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    const c = cv.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    return [w, h, c];
}

/**
 * @param {HTMLCanvasElement} cv
 * @param {{peaks:Uint8Array, rms:Uint8Array, maxPeak:number}} data
 * @param {object} o
 *   o.from/o.to  fraction window of the file to show (zoom), default 0..1
 *   o.peak/o.rms fill colors
 *   o.normalize  scale quiet files up (max +18 dB), default true
 *   o.envelope   optional fn(frac) → gain 0..1 (fades preview)
 *   o.gain       linear display gain (editor gain preview)
 *   o.size       the canvas's CSS size when already known ([w, h])
 */
export function drawWave(cv, data, o = {}) {
    const fit = fitCanvas(cv, o.size);
    if (!fit) return false;
    const [w, h, c] = fit;
    c.clearRect(0, 0, w, h);
    if (!data || !data.peaks || !data.peaks.length) {
        c.fillStyle = colors().dim; c.fillRect(0, Math.floor(h / 2), w, 1);
        return true;
    }
    const pal = colors();
    const n = data.peaks.length;
    const from = o.from ?? 0, to = o.to ?? 1, span = Math.max(1e-9, to - from);
    const norm = o.normalize === false || !(data.maxPeak > 0) ? 1 : Math.min(1 / data.maxPeak, 8);
    const g = norm * (o.gain ?? 1);
    const mid = h / 2, half = h / 2 - 1;
    const cols = Math.max(1, Math.round(w));
    const top = new Float32Array(cols + 1), core = new Float32Array(cols + 1);
    for (let x = 0; x <= cols; x++) {
        const f0 = from + span * (x / cols), f1 = from + span * ((x + 1) / cols);
        let b0 = Math.floor(f0 * n), b1 = Math.max(b0 + 1, Math.floor(f1 * n));
        if (b0 >= n || f0 < 0) { top[x] = 0; core[x] = 0; continue; }
        b1 = Math.min(n, b1);
        let p = 0, r = 0;
        for (let b = b0; b < b1; b++) { if (data.peaks[b] > p) p = data.peaks[b]; if (data.rms[b] > r) r = data.rms[b]; }
        let env = o.envelope ? o.envelope((x + 0.5) / cols * span + from) : 1;
        const pv = Math.min(1, amp(p) * g * env), rv = Math.min(pv, amp(r) * g * env);
        top[x] = Math.max(pv * half, 0.5);
        core[x] = rv * half;
    }
    const shape = arr => {
        c.beginPath();
        c.moveTo(0, mid - arr[0]);
        for (let x = 1; x <= cols; x++) c.lineTo(x * (w / cols), mid - arr[x]);
        for (let x = cols; x >= 0; x--) c.lineTo(x * (w / cols), mid + arr[x]);
        c.closePath();
        c.fill();
    };
    c.fillStyle = o.peak || pal.wave; shape(top);
    c.fillStyle = o.rms || pal.rms; shape(core);
    return true;
}

/** Draw the pair used by list rows / scrubbers: base canvas + accent "played" canvas. */
export function drawPair(base, played, data, o = {}) {
    const pal = colors();
    drawWave(base, data, { ...o, peak: pal.wave, rms: pal.rms });
    if (played) drawPlayed(played, data, o);
}

/** The accent copy alone. */
export function drawPlayed(played, data, o = {}) {
    const pal = colors();
    if (drawWave(played, data, { ...o, peak: pal.accentPeak, rms: pal.accentRms })) played._tint = version;
}

/** Re-tint a played canvas drawn with an older accent (cheap no-op when current or never drawn). */
export function retint(played, data, o = {}) {
    if (played && played._tint !== undefined && played._tint !== version) drawPlayed(played, data, o);
}

/**
 * Set progress (0..1) on a played canvas via clip-path, no redraw. `from` (0..1)
 * is where the colored part starts: a selection that plays colors only itself,
 * the rest of the file stays neutral.
 */
export function setProgress(played, frac, from = 0) {
    if (!played) return;
    const a = Math.max(0, Math.min(1, from)) * 100;
    const pct = Math.max(a, Math.min(100, frac * 100));
    played.style.clipPath = `inset(0 ${100 - pct}% 0 ${a}%)`;
}

/** Where a player's colored progress starts in its file (0..1): the playing selection's start, or 0. */
export function progressFrom(player, fileDuration) {
    return player.segment && fileDuration > 0 ? player.segment.start / fileDuration : 0;
}
