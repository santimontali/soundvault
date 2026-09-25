// Drag-out to DAWs / Explorer.
// • Whole files: synchronous startDrag with a waveform "ghost" chip.
// • Selections / edits: rendered to a persistent, uniquely named WAV in the
//   background as soon as the selection settles, so the OS drag can start
//   synchronously inside dragstart (async-then-drag is unreliable on Windows).
import { hexToRgb, stripExt, formatDuration } from './util.js';
import { decode, decodeNative } from './audio/engine.js';
import { peaksFor, amp } from './audio/peaks.js';
import { selectionEdit, renderSelection } from './audio/edit-dsp.js';
import { modeAccent } from './store.js';

export function ghostIcon({ data = null, color = modeAccent(), count = 1, badge = false } = {}) {
    try {
        const W = 28, H = 28, S = 2;
        const cv = document.createElement('canvas');
        cv.width = W * S; cv.height = H * S;
        const c = cv.getContext('2d');
        c.scale(S, S);
        const { r, g, b } = hexToRgb(color);
        const rr = (x, y, w, h, rad) => { c.beginPath(); c.roundRect(x, y, w, h, rad); };
        if (count > 1) { rr(3.5, 1.5, W - 5, H - 5, 6.5); c.fillStyle = '#1b1b20'; c.fill(); c.strokeStyle = `rgba(${r},${g},${b},.35)`; c.lineWidth = 1; c.stroke(); }
        rr(.5, 3.5, W - 4, H - 4, 6.5);
        const bg = c.createLinearGradient(0, 0, 0, H); bg.addColorStop(0, '#27272e'); bg.addColorStop(1, '#131317');
        c.fillStyle = bg; c.fill(); c.lineWidth = 1; c.strokeStyle = `rgba(${r},${g},${b},.55)`; c.stroke();
        const n = 5, bw = 2.2, gap = 1.6, maxH = 13, mid = 3.5 + (H - 4) / 2, x0 = .5 + ((W - 4) - (n * bw + (n - 1) * gap)) / 2;
        let bars = [.5, .85, 1, .6, .9];
        if (data && data.peaks && data.peaks.length) {
            bars = [];
            const step = data.peaks.length / n;
            for (let i = 0; i < n; i++) { let m = 0; for (let j = Math.floor(i * step); j < Math.floor((i + 1) * step); j++) m = Math.max(m, data.peaks[j]); bars.push(amp(m)); }
            const mx = Math.max(...bars); if (mx > 0.001) bars = bars.map(v => v / mx);
        }
        c.fillStyle = color;
        bars.forEach((v, i) => { const bh = Math.max(2.5, v * maxH); c.globalAlpha = .55 + .45 * v; rr(x0 + i * (bw + gap), mid - bh / 2, bw, bh, 1.1); c.fill(); });
        c.globalAlpha = 1;
        if (badge || count > 1) {
            c.beginPath(); c.arc(W - 4.5, 5.5, count > 1 ? 5 : 2.6, 0, Math.PI * 2); c.fillStyle = color; c.fill();
            if (count > 1) { c.fillStyle = '#111'; c.font = '700 7px Segoe UI'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(count > 99 ? '99+' : String(count), W - 4.5, 5.8); }
        }
        return cv.toDataURL('image/png');
    } catch (e) { return null; }
}

export function dragFiles(items) {
    const paths = items.map(i => i.path);
    if (!paths.length) return;
    window.sv.drag.start(paths, ghostIcon({ data: peaksFor(paths[0]) || null, count: paths.length }));
}

// ── Region renders (selection) ──────────────────────────────────────────
let pre = { key: null, promise: null, path: null };

export function regionKey(sound, s) {
    const e = selectionEdit(s), f = v => v.toFixed(4);
    return [sound.path, sound.mtime || 0, f(s.start), f(s.end), f(e.fadeInEnd), e.fadeInShape, f(e.fadeInTension), f(e.cropEnd - e.fadeOutStart), e.fadeOutShape, f(e.fadeOutTension)].join('|');
}

/**
 * Slice + fades with their curves: the editor's render (edit-dsp), the same law
 * playback uses. Renders use the file's NATIVE sample rate (96/192 kHz libraries
 * must not be downsampled on export); `opts.preview` uses the 48 kHz playback
 * decode instead (Echo).
 */
export async function regionChannels(sound, s, opts = {}) {
    const pk = peaksFor(sound.path);
    const buf = opts.preview || !(pk && pk.sampleRate) ? await decode(sound.path) : await decodeNative(sound.path, pk.sampleRate);
    if (!buf) return null;
    const sr = buf.sampleRate;
    const chans = [];
    for (let c = 0; c < buf.numberOfChannels; c++) chans.push(buf.getChannelData(c));
    const r = renderSelection({ channels: chans, sampleRate: sr }, s);
    if (r.frames < 2) return null;
    return { channels: r.channels, sampleRate: sr, duration: r.frames / sr };
}

export function prerenderRegion(sound, s) {
    const key = regionKey(sound, s);
    if (pre.key === key && pre.promise) return pre.promise;
    pre = { key, path: null, promise: null };
    pre.promise = (async () => {
        const r = await regionChannels(sound, s);
        if (!r || pre.key !== key) return null;
        // Keep the source format: float stays float (nothing clipped above 0 dBFS),
        // 16-bit stays 16-bit, everything else 24-bit. The rate is always native.
        const pk = peaksFor(sound.path);
        let peak = 0;
        for (const c of r.channels) for (let i = 0; i < c.length; i++) { const v = c[i] < 0 ? -c[i] : c[i]; if (v > peak) peak = v; }
        const float = (pk && pk.format === 3) || peak > 1;
        const res = await window.sv.audio.render({
            channels: r.channels, sampleRate: r.sampleRate, bitDepth: pk && pk.bits === 16 && !float ? 16 : 24, float,
            baseName: stripExt(sound.name), suffix: `[${fmtT(s.start)}-${fmtT(s.end)}]`, key,
        });
        if (pre.key === key && res && res.path) pre.path = res.path;
        return res && res.path;
    })();
    return pre.promise;
}

/** Start dragging a region. Returns true when the drag started synchronously. */
export function dragRegion(sound, s) {
    const key = regionKey(sound, s);
    const icon = ghostIcon({ data: peaksFor(sound.path) || null, badge: true });
    if (pre.key === key && pre.path) { window.sv.drag.start([pre.path], icon); return true; }
    // Not ready yet: finish rendering and start the drag as soon as possible.
    prerenderRegion(sound, s).then(p => { if (p) window.sv.drag.start([p], icon); });
    return false;
}

const fmtT = t => (t < 60 ? t.toFixed(2) + 's' : formatDuration(t).replace(':', 'm') + 's');
