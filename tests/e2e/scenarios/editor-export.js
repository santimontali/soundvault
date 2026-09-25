'use strict';
// Editor E2E: exports: native sample rate (44.1 k / 96 k fixtures), 24-bit vs 32-bit float,
// content = the edit (sample-exact against the native render), "Preparing…" state,
// dragstart → drag IPC < 50 ms once pre-rendered, stable/unique render names, Save as new.
// The real OS drag is neutralized (IPC recorded). Requires --lib from make-editor-fixtures.js
// and a settings file whose rendersDir is outside the user's Documents.
const fs = require('fs');
const path = require('path');
const H = require('../editor-helpers');

// in-page: compare a written WAV (fetched through soundvault://) with the editor's native render
async function compareFile(file) {
    const r = await window.__sv.E.renderExport();
    const ab = await (await fetch(window.sv.audio.url(file))).arrayBuffer();
    const dv = new DataView(ab);
    let pos = 12, fmt = null, data = null;
    while (pos + 8 <= dv.byteLength) {
        const id = String.fromCharCode(dv.getUint8(pos), dv.getUint8(pos + 1), dv.getUint8(pos + 2), dv.getUint8(pos + 3)), size = dv.getUint32(pos + 4, true);
        if (id === 'fmt ') fmt = { tag: dv.getUint16(pos + 8, true), nc: dv.getUint16(pos + 10, true), sr: dv.getUint32(pos + 12, true), bits: dv.getUint16(pos + 22, true) };
        if (id === 'data') { data = { off: pos + 8, size }; break; }
        pos += 8 + size + (size & 1);
    }
    const bps = fmt.bits / 8, frames = data.size / (bps * fmt.nc);
    let maxErr = 0, peak = 0;
    for (let i = 0; i < frames; i++) for (let c = 0; c < fmt.nc; c++) {
        const o = data.off + (i * fmt.nc + c) * bps;
        let v, ref = r.channels[c][i];
        if (fmt.tag === 3) v = dv.getFloat32(o, true);
        else { const q = dv.getUint8(o) | (dv.getUint8(o + 1) << 8) | (dv.getInt8(o + 2) << 16); v = q < 0 ? q / 8388608 : q / 8388607; ref = Math.max(-1, Math.min(1, ref)); }
        maxErr = Math.max(maxErr, Math.abs(v - ref)); peak = Math.max(peak, Math.abs(v));
    }
    return { fmt, frames, renderFrames: r.frames, renderSr: r.sampleRate, maxErr, peak };
}

module.exports = async (ctx) => {
    const C = H.checker(ctx);
    const drags = H.interceptDrag(ctx);
    await H.boot(ctx);
    const info = () => ctx.exec(() => window.__sv.E.exportInfo());
    const ready = async () => { await ctx.exec(() => window.__sv.E.whenExportReady()); return info(); };
    const rendersDir = await ctx.exec(async () => (await window.sv.settings.get()).rendersDir);
    const docs = require('path').join(require('os').homedir(), 'Documents').toLowerCase();
    const testRoot = require('path').dirname(ctx.lib).toLowerCase();
    C.check('renders go to the isolated renders folder (not the user’s Documents)', !!rendersDir && rendersDir.toLowerCase().startsWith(testRoot) && !rendersDir.toLowerCase().startsWith(docs), rendersDir);

    // 1. 44.1 kHz source with every kind of edit (sinc varispeed path)
    await H.selectExact(ctx, 'markers_st_44k_10s.wav', 0.5, 9.5);
    await H.openEditor(ctx);
    await ctx.exec(() => window.__sv.E.setEdit({ cropStart: 0.25, cropEnd: 8.25, fadeInEnd: 0.55, fadeOutStart: 7.75, fadeOutShape: 'equal', gainDb: -2, semitones: 3 }));
    let x = await info();
    C.check('right after an edit the drag button says Preparing… and is not draggable', !x.ready && x.dragLabel === 'Preparing…' && x.draggable === 'false', { ready: x.ready, label: x.dragLabel, draggable: x.draggable });
    const n0 = drags.length;
    await ctx.exec(() => document.querySelector('#editor .ed-drag').dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true })));
    await ctx.wait(300);
    C.check('dragstart while preparing never drags a stale file', drags.length === n0, drags.length - n0);
    x = await ready();
    const h44 = H.readWav(x.path);
    const expFrames = Math.round(Math.round(8 * 44100) / Math.pow(2, 3 / 12));
    C.check('44.1 kHz source → exported at 44.1 kHz, 24-bit PCM, stereo', h44.sr === 44100 && h44.bits === 24 && h44.tag === 1 && h44.nc === 2, { sr: h44.sr, bits: h44.bits, tag: h44.tag, nc: h44.nc });
    C.check('exported length = crop / varispeed rate (±2 frames)', Math.abs(h44.frames - expFrames) <= 2, { frames: h44.frames, expected: expFrames });
    let cmp = await ctx.exec(compareFile, x.path);
    C.check('file content = native render of the edit (≤ ½ LSB at 24-bit)', cmp.maxErr < 1.2e-7 && cmp.frames === cmp.renderFrames && cmp.renderSr === 44100, cmp);
    const tb = (3.0 - 0.75) / Math.pow(2, 3 / 12);          // burst at 3.0 s in the file; crop starts at 0.75 s
    const burst = H.goertzel(h44.channels[0].subarray(Math.round((tb + 0.001) * 44100), Math.round((tb + 0.015) * 44100)), 1000 * Math.pow(2, 3 / 12), 44100);
    C.check('+3 st varispeed moves the 1 kHz burst to 1189 Hz', burst > 0.3, +burst.toFixed(3));

    // 2. dragstart → drag IPC once pre-rendered (synchronous path)
    const t0 = await ctx.exec(() => { const t = Date.now(); document.querySelector('#editor .ed-drag').dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true })); return t; });
    const w0 = Date.now(); while (drags.length === n0 && Date.now() - w0 < 2000) await ctx.wait(2);
    const d = drags[drags.length - 1];
    const inPage = await ctx.exec(() => window.__sv.E.exportInfo().lastDrag);
    C.check('dragstart → drag:start IPC < 50 ms with the pre-rendered file', d && d.t - t0 < 50 && d.paths && d.paths[0] === x.path && d.hasIcon && fs.existsSync(d.paths[0]), d && { ms: d.t - t0, handlerMs: inPage && +inPage.ms.toFixed(2), path: path.basename(d.paths[0]) });
    // trusted drag gesture on the button (Chromium fires a real dragstart)
    const db = await ctx.exec(() => { const r = document.querySelector('#editor .ed-drag').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    const n1 = drags.length;
    await H.T.drag(ctx, db.x, db.y, db.x + 60, db.y - 80, { steps: 6 });
    await ctx.wait(150);
    C.check('a real mouse drag on the button starts the OS drag with the same file', drags.length === n1 + 1 && drags[drags.length - 1].paths[0] === x.path, drags.length - n1);

    // 3. names: different edit → different file; same edit again → the same file (reused)
    const pathA = x.path;
    await ctx.exec(() => window.__sv.E.setEdit({ gainDb: -6 }));
    const xb = await ready();
    await ctx.exec(() => window.__sv.E.setEdit({ gainDb: -2 }));
    const xa = await ready();
    C.check('another edit writes another file; the same edit reuses its file', xb.path !== pathA && xa.path === pathA && fs.existsSync(xb.path), { a: path.basename(pathA), b: path.basename(xb.path), a2: path.basename(xa.path) });

    // 4. 96 kHz / 24-bit source: stays 96 kHz and keeps its ultrasonic content (30 kHz → 15 kHz at -12 st)
    await H.selectExact(ctx, 'hf_96k_1k+30k_2s.wav', 0.1, 1.9);
    await H.openEditor(ctx);
    await ctx.exec(() => window.__sv.E.setEdit({ semitones: -12 }));
    x = await ready();
    const h96 = H.readWav(x.path);
    const a15k = H.goertzel(h96.channels[0], 15000, 96000, 4000), a500 = H.goertzel(h96.channels[0], 500, 96000, 4000), a30k = H.goertzel(h96.channels[0], 30000, 96000, 4000);
    C.check('96 kHz source → exported at 96 kHz / 24-bit', h96.sr === 96000 && h96.bits === 24 && Math.abs(h96.frames - Math.round(1.8 * 96000 * 2)) <= 2, { sr: h96.sr, bits: h96.bits, frames: h96.frames });
    C.check('ultrasonic 30 kHz tone survives: 15 kHz at -12 st (level within 0.5 dB)', Math.abs(20 * Math.log10(a15k / 0.3)) < 0.5 && Math.abs(20 * Math.log10(a500 / 0.3)) < 0.5 && a30k < 0.003, { a15k: +a15k.toFixed(4), a500: +a500.toFixed(4), a30k: +a30k.toFixed(5) });
    cmp = await ctx.exec(compareFile, x.path);
    C.check('96 k file content = native render (≤ ½ LSB)', cmp.maxErr < 1.2e-7 && cmp.renderSr === 96000, cmp);

    // 5. peak above 0 dBFS → 32-bit float, overs preserved
    await H.selectExact(ctx, 'sine_0dbfs_48k_1s.wav', 0.1, 0.9);
    await H.openEditor(ctx);
    await ctx.exec(() => window.__sv.E.setEdit({ gainDb: 6 }));
    x = await ready();
    const hf = H.readWav(x.path);
    let pk = 0; for (const v of hf.channels[0]) pk = Math.max(pk, Math.abs(v));
    C.check('gain +6 dB on 0 dBFS → exported as 32-bit float with the overs kept (peak ≈ 2.0)', hf.tag === 3 && hf.bits === 32 && x.float && Math.abs(pk - 0.999 * Math.pow(10, 6 / 20)) < 0.01, { tag: hf.tag, bits: hf.bits, peak: +pk.toFixed(4) });
    await ctx.exec(() => window.__sv.E.setEdit({ gainDb: -1 }));
    x = await ready();
    C.check('back under 0 dBFS → 24-bit PCM again', H.readWav(x.path).bits === 24 && !x.float);

    // 5b. long / high-rate files are not decoded behind the user's back: "Prepare drag" renders on request
    const prevLimit = await ctx.exec(() => window.__sv.E.autoRenderLimit(1024 * 1024));
    await H.selectExact(ctx, 'pad_st_48k_30s.wav', 1, 21);
    await H.openEditor(ctx);
    await ctx.wait(700);
    x = await info();
    C.check('over the memory budget: no automatic render, the button offers “Prepare drag”', !x.ready && !x.preparing && x.dragLabel === 'Prepare drag' && x.draggable === 'false', { ready: x.ready, preparing: x.preparing, label: x.dragLabel });
    const pb = await ctx.exec(() => { const r = document.querySelector('#editor .ed-drag').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    await H.T.click(ctx, pb.x, pb.y);
    await ctx.waitFor(() => window.__sv.E.exportInfo().ready, 60000, 'manual render');
    x = await info();
    C.check('clicking “Prepare drag” renders it; then it is draggable', x.ready && x.dragLabel === 'Drag' && x.draggable === 'true' && H.readWav(x.path).frames === 20 * 48000, { label: x.dragLabel, frames: x.frames });
    await ctx.exec(l => window.__sv.E.autoRenderLimit(l), prevLimit);

    // 6. Save as new sound (next to the original, native rate) + Show
    await H.selectExact(ctx, 'markers_st_44k_10s.wav', 1.0, 3.5);
    await H.openEditor(ctx);
    await ctx.exec(() => window.__sv.E.setEdit({ fadeInEnd: 0.1, fadeOutStart: 2.2 }));
    const sb = await ctx.exec(() => { const r = document.querySelector('#editor .ed-save').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    await H.T.click(ctx, sb.x, sb.y);
    await ctx.waitFor(() => [...document.querySelectorAll('.toast .msg')].some(m => /^Saved “/.test(m.textContent)), 20000, 'saved toast');
    const saved = path.join(ctx.lib, 'Editor', 'markers_st_44k_10s edit.wav');
    const hs = fs.existsSync(saved) ? H.readWav(saved) : null;
    C.check('Save as new: file next to the original at 44.1 kHz with the edit’s length', hs && hs.sr === 44100 && Math.abs(hs.frames - Math.round(2.5 * 44100)) <= 2, hs && { sr: hs.sr, frames: hs.frames });
    await ctx.exec(() => [...document.querySelectorAll('.toast')].find(t => /^Saved “/.test(t.querySelector('.msg').textContent)).querySelector('.act').click());
    await ctx.waitFor(() => window.__sv.list.current() && /markers_st_44k_10s edit\.wav$/.test(window.__sv.list.current().path), 10000, 'Show locates the new sound').catch(() => null);
    const cur = await ctx.exec(() => window.__sv.list.current() && window.__sv.list.current().name);
    C.check('toast “Show” locates the new sound in the list', cur === 'markers_st_44k_10s edit.wav', cur);
    await H.shotEditor(ctx, 'export-01-saved', true);
    try { fs.unlinkSync(saved); } catch (e) { /* already gone */ }
    C.done();
};
