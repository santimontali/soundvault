// Waveform rendering: mirrored filled peak envelope with an RMS core.
// Canvases are drawn once per (data, size, color), playback progress is a
// clip-path on a second, accent-colored canvas, so nothing redraws per frame.
import { amp } from '../audio/peaks.js';

let palette = null;
export function refreshPalette() {
    const cs = getComputedStyle(document.documentElement);
    const v = n => cs.getPropertyValue(n).trim();
    const rgb = v('--accent-rgb') || '200, 247, 109';
    palette = {
        wave: v('--wave'), rms: v('--wave-rms'), dim: v('--wave-dim'),
        accentPeak: `rgba(${rgb}, .5)`, accentRms: v('--accent'),
    };
    return palette;
}
export const colors = () => palette || refreshPalette();

/** Ensure the canvas backing store matches its CSS size × DPR. Returns [w, h] in CSS px or null. */
export function fitCanvas(cv) {
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth, h = cv.clientHeight;
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
 */
export function drawWave(cv, data, o = {}) {
    const fit = fitCanvas(cv);
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
    if (played) drawWave(played, data, { ...o, peak: pal.accentPeak, rms: pal.accentRms });
}

/** Set progress (0..1) on a played canvas via clip-path, no redraw. */
export function setProgress(played, frac) {
    if (!played) return;
    const pct = Math.max(0, Math.min(1, frac)) * 100;
    played.style.clipPath = `inset(0 ${100 - pct}% 0 0)`;
}
