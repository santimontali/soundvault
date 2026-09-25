'use strict';
// Editor E2E: handles with TRUSTED mouse input: crop edges, fade squares, bend, link, slip,
// new crop outside, double-click resets, right-click presets, stacked handles, zero-crossing snap
// (Alt = free), off-screen handles are not pinned to the view edges, and a seeded fuzz of random
// gestures with the handle-order invariant checked after every one.
// Requires --lib from make-editor-fixtures.js.
const H = require('../editor-helpers');

function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const ordered = e => e.cropStart >= -1e-9 && e.cropStart <= e.fadeInEnd + 1e-9 && e.fadeInEnd <= e.fadeOutStart + 1e-9 && e.fadeOutStart <= e.cropEnd + 1e-9 && e.cropEnd <= e.duration + 1e-9 && e.cropEnd - e.cropStart >= 0.001 - 1e-9;

module.exports = async (ctx) => {
    const C = H.checker(ctx);
    await H.boot(ctx);
    const edit = () => ctx.exec(() => window.__sv.E.edit());
    const geo = () => ctx.exec(() => window.__sv.E.geometry());
    const set = patch => ctx.exec(p => window.__sv.E.setEdit(p), patch);

    await H.selectExact(ctx, 'markers_mono_48k_4s.wav', 0, 4);
    await H.openEditor(ctx);
    let g = await geo();
    const X = f => g.left + f * g.width, midY = () => g.top + g.height / 2, topY = () => g.top + 11;

    // basic handles (Alt = free placement, so positions are exact)
    await H.T.drag(ctx, X(0) + 2, midY(), X(0.2), midY(), { mods: ['alt'] });
    let e = await edit();
    C.check('drag crop start 0 → 20 % (Alt: free)', Math.abs(e.cropStart - 0.8) < 0.01 && ordered(e), e.cropStart);
    await H.T.drag(ctx, X(1) - 2, midY(), X(0.85), midY(), { mods: ['alt'] });
    e = await edit();
    C.check('drag crop end 100 % → 85 %', Math.abs(e.cropEnd - 3.4) < 0.01 && ordered(e), e.cropEnd);
    g = await geo();
    await H.T.drag(ctx, g.left + g.fadeInEnd, topY(), X(0.35), topY());
    await H.T.drag(ctx, g.left + g.fadeOutStart, topY(), X(0.7), topY());
    e = await edit();
    C.check('drag fade squares → fade-in to 35 %, fade-out from 70 %', Math.abs(e.fadeInEnd - 1.4) < 0.01 && Math.abs(e.fadeOutStart - 2.8) < 0.01 && ordered(e), { fi: e.fadeInEnd, fo: e.fadeOutStart });
    await H.shotEditor(ctx, 'handles-01-crop-fades');

    // crop start dragged past the fade-out start: fades are pushed, never outside the crop (old bug UC-19)
    await H.T.drag(ctx, X(0.2), midY(), X(0.8), midY(), { mods: ['alt'] });
    e = await edit();
    C.check('crop start past the fade-out start: order kept, fades pushed, the fade-out starts AT the crop start (not before it)', ordered(e) && Math.abs(e.fadeInEnd - e.cropStart) < 1e-9 && Math.abs(e.fadeOutStart - e.cropStart) < 1e-9, { cs: e.cropStart, fi: e.fadeInEnd, fo: e.fadeOutStart, ce: e.cropEnd });
    await ctx.exec(() => { const E = window.__sv.E; E.setEdit({ cropStart: 0.8, cropEnd: 3.4, fadeInEnd: 1.4, fadeOutStart: 2.8 }); });
    g = await geo();
    // crop end dragged before the fade-in end (old bug UC-20)
    await H.T.drag(ctx, g.left + g.cropEnd - 2, midY(), X(0.3), midY(), { mods: ['alt'] });
    e = await edit();
    C.check('crop end before the fade-in end: order kept, the fade-in now ends AT the crop end (never beyond it)', ordered(e) && Math.abs(e.fadeInEnd - e.cropEnd) < 1e-9 && Math.abs(e.fadeOutStart - e.cropEnd) < 1e-9, { cs: e.cropStart, fi: e.fadeInEnd, fo: e.fadeOutStart, ce: e.cropEnd });

    // stacked fade squares (fi = fo) can always be separated in both directions
    await set({ cropStart: 0.8, cropEnd: 3.4, fadeInEnd: 2.0, fadeOutStart: 2.0 });
    g = await geo();
    await H.T.drag(ctx, g.left + g.fadeInEnd, topY(), X(0.3), topY());
    e = await edit();
    C.check('stacked squares: dragging left takes the fade-in', Math.abs(e.fadeInEnd - 1.2) < 0.01 && Math.abs(e.fadeOutStart - 2.0) < 1e-6, { fi: e.fadeInEnd, fo: e.fadeOutStart });
    await set({ fadeInEnd: 2.0, fadeOutStart: 2.0 });
    g = await geo();
    await H.T.drag(ctx, g.left + g.fadeOutStart, topY(), X(0.7), topY());
    e = await edit();
    C.check('stacked squares: dragging right takes the fade-out', Math.abs(e.fadeOutStart - 2.8) < 0.01 && Math.abs(e.fadeInEnd - 2.0) < 1e-6, { fi: e.fadeInEnd, fo: e.fadeOutStart });
    await set({ fadeInEnd: 3.4, fadeOutStart: 3.4 });   // stacked on the crop end (old deadlock)
    g = await geo();
    await H.T.drag(ctx, g.left + g.fadeInEnd, topY(), X(0.6), topY());
    e = await edit();
    C.check('stacked on the crop end: still separable', Math.abs(e.fadeInEnd - 2.4) < 0.01 && ordered(e), { fi: e.fadeInEnd, fo: e.fadeOutStart });

    // bend, double-click reset, presets, link, slip, new crop
    await set({ cropStart: 0.8, cropEnd: 3.4, fadeInEnd: 1.6, fadeOutStart: 2.6, fadeInTension: 0, fadeInShape: 'power' });
    g = await geo();
    const cx = X(0.3), cy = g.top + 22 + 0.5 * (g.height - 22 - 4);   // t = .5 on a linear fade-in → envelope .5
    await H.T.drag(ctx, cx, cy, cx, cy + 60);
    e = await edit();
    C.check('bend: drag the fade-in curve down 60 px → tension +0.5', Math.abs(e.fadeInTension - 0.5) < 0.02, e.fadeInTension);
    // where the (now bent) curve is at x: envelope t^(10^tension), drawn between 22 px from the top and 4 px from the bottom
    const cy2 = await ctx.exec((x) => { const E = window.__sv.E, gg = E.geometry(), e = E.edit(); const v = (x - gg.left) / gg.width * e.duration; const t = (v - e.cropStart) / (e.fadeInEnd - e.cropStart); const env = Math.pow(t, Math.pow(10, e.fadeInTension)); return gg.top + 22 + (1 - env) * (gg.height - 26); }, cx);
    await H.T.dblclick(ctx, cx, cy2);
    C.check('double-click on the curve straightens it', Math.abs((await edit()).fadeInTension) < 1e-9);
    await H.T.rclick(ctx, cx, cy);
    const items = await ctx.exec(() => [...document.querySelectorAll('.menu .mi .n')].map(n => n.textContent));
    C.check('right-click on a fade: presets menu', ['Linear', 'Fast start (log)', 'Slow start (exp)', 'S-curve', 'Equal power'].every(l => items.includes(l)), items);
    await ctx.exec(() => [...document.querySelectorAll('.menu .mi')].find(m => m.textContent.includes('Equal power')).click());
    C.check('choosing “Equal power” applies it', (await edit()).fadeInShape === 'equal');
    g = await geo();
    const e0 = await edit();
    await H.T.drag(ctx, X(0.25), g.top + 30, X(0.25) + 41.28, g.top + 30);   // inside the fade-in zone, away from the curve
    e = await edit();
    const dv = 41.28 / g.width * 4;
    C.check('link: drag inside the fade zone moves the edge and its fade together', Math.abs(e.cropStart - (e0.cropStart + dv)) < 0.01 && Math.abs((e.fadeInEnd - e.cropStart) - (e0.fadeInEnd - e0.cropStart)) < 1e-6, { cs: [e0.cropStart, e.cropStart], len: e.fadeInEnd - e.cropStart });
    const e1 = await edit();
    await H.T.drag(ctx, X(0.55), midY(), X(0.55) - 100, midY());
    e = await edit();
    C.check('slip: drag the middle keeps every length', Math.abs((e.cropEnd - e.cropStart) - (e1.cropEnd - e1.cropStart)) < 1e-9 && Math.abs((e.fadeOutStart - e.fadeInEnd) - (e1.fadeOutStart - e1.fadeInEnd)) < 1e-9 && e.cropStart < e1.cropStart, { from: e1.cropStart, to: e.cropStart });
    await H.T.drag(ctx, X(0.9), midY(), X(0.97), midY(), { mods: ['alt'] });
    e = await edit();
    C.check('drag outside the crop draws a new crop', Math.abs(e.cropStart - 3.6) < 0.02 && Math.abs(e.cropEnd - 3.88) < 0.02 && ordered(e), { cs: e.cropStart, ce: e.cropEnd });
    g = await geo();
    await H.T.dblclick(ctx, g.left + g.cropStart, midY());
    C.check('double-click a crop edge resets it to the selection edge', (await edit()).cropStart === 0);

    // zoomed in: off-screen handles are not drawn/hit at the view edges (old bug: pinned at the edge)
    await set({ cropStart: 0.4, cropEnd: 3.6, fadeInEnd: 0.6, fadeOutStart: 3.4 });
    await ctx.exec(() => window.__sv.E.setView(1.6, 2.4));
    const edgeHits = await ctx.exec(() => { const E = window.__sv.E, gg = E.geometry(); return [E.hit(1, gg.height / 2), E.hit(gg.width - 1, gg.height / 2), E.hit(gg.width - 2, 8)]; });
    C.check('zoomed: nothing grabbable at the view edges when the crop edges are off-screen', edgeHits.every(h => h && h.kind === 'slip'), edgeHits);
    await ctx.exec(() => window.__sv.E.setView(0, 4));

    // wheel: Ctrl = zoom anchored at the mouse, plain = pan, Alt = gain scaled by delta (one undo step per burst).
    // (synthetic WheelEvents: trusted wheel input is delivered late in a hidden window)
    await ctx.exec(() => window.__sv.E.setView(0, 4));
    const wheel = await ctx.exec(async () => {
        const E = window.__sv.E, st = document.querySelector('#editor .ed-stage'), r = st.getBoundingClientRect();
        const at = (x, o) => st.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: r.left + x * r.width, clientY: r.top + r.height / 2, ...o }));
        const out = {};
        const vUnder = (x, v) => v.start + x * (v.end - v.start);
        const v0 = E.view(); at(0.25, { deltaY: -300, ctrlKey: true }); const v1 = E.view();
        out.zoom = { span0: v0.end - v0.start, span1: v1.end - v1.start, anchor0: vUnder(0.25, v0), anchor1: vUnder(0.25, v1) };
        at(0.5, { deltaY: 100 }); const v2 = E.view();
        out.pan = { from: v1.start, to: v2.start, expected: v1.start + 100 / r.width * (v1.end - v1.start) };
        const h0 = E.history().undo, g0 = E.edit().gainDb;
        at(0.5, { deltaY: -100, altKey: true }); const g1 = E.edit().gainDb;
        at(0.5, { deltaY: -10, altKey: true }); const g2 = E.edit().gainDb;
        for (let i = 0; i < 4; i++) at(0.5, { deltaY: -100, altKey: true });
        await new Promise(res => setTimeout(res, 800));
        out.gain = { g0, afterNotch: g1, afterTinyDelta: g2, final: E.edit().gainDb, undoSteps: E.history().undo - h0 };
        E.setView(0, 4);
        return out;
    });
    C.check('Ctrl+wheel zooms in keeping the time under the mouse fixed', wheel.zoom.span1 < wheel.zoom.span0 * 0.6 && Math.abs(wheel.zoom.anchor1 - wheel.zoom.anchor0) < 1e-6, wheel.zoom);
    C.check('wheel scrolls the zoomed view', Math.abs(wheel.pan.to - wheel.pan.expected) < 1e-6, wheel.pan);
    C.check('Alt+wheel: +0.5 dB per mouse notch, finer for small (touchpad) deltas, one undo step per burst', Math.abs(wheel.gain.afterNotch - wheel.gain.g0 - 0.5) < 1e-9 && Math.abs(wheel.gain.afterTinyDelta - wheel.gain.afterNotch - 0.05) < 1e-9 && wheel.gain.undoSteps === 1, wheel.gain);
    await set({ gainDb: 0 });

    // overview strip (trusted mouse): pan the viewport, resize its edge, click to jump, double-click = zoom to crop
    await ctx.exec(() => window.__sv.E.setView(1, 2));
    const mb = await ctx.exec(() => { const r = document.querySelector('#editor .ed-mini').getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; });
    const mx = t => mb.left + t / 4 * mb.width, my = mb.top + mb.height / 2;
    await H.T.drag(ctx, mx(1.5), my, mx(1.5) + mb.width * 0.25, my);
    let vw = await ctx.exec(() => window.__sv.E.view());
    C.check('overview: dragging the viewport pans (+1 s)', Math.abs(vw.start - 2) < 0.02 && Math.abs(vw.end - 3) < 0.02, vw);
    await H.T.drag(ctx, mx(3) - 1, my, mx(3.5), my);
    vw = await ctx.exec(() => window.__sv.E.view());
    C.check('overview: dragging the viewport edge zooms (end → 3.5 s)', Math.abs(vw.start - 2) < 0.02 && Math.abs(vw.end - 3.5) < 0.03, vw);
    await H.T.click(ctx, mx(0.5), my);
    vw = await ctx.exec(() => window.__sv.E.view());
    C.check('overview: click outside the viewport centres it there', vw.start === 0 && Math.abs(vw.end - 1.5) < 0.03, vw);
    await H.T.dblclick(ctx, mx(2), my);
    vw = await ctx.exec(() => window.__sv.E.view());
    const ce = await edit();
    const mg = (ce.cropEnd - ce.cropStart) * 0.04;
    C.check('overview: double-click zooms to the crop', Math.abs(vw.start - Math.max(0, ce.cropStart - mg)) < 1e-6 && Math.abs(vw.end - Math.min(4, ce.cropEnd + mg)) < 1e-6, { vw, crop: [ce.cropStart, ce.cropEnd] });
    await ctx.exec(() => window.__sv.E.setView(0, 4));

    // zero-crossing snap (default) vs Alt
    await H.selectExact(ctx, 'sine_220_48k_2s.wav', 0, 2);
    await H.openEditor(ctx);
    g = await geo();
    const snaps = [];
    for (const f of [0.137, 0.311, 0.452]) {
        await set({ cropStart: 0, cropEnd: 2, fadeInEnd: 0, fadeOutStart: 2 });
        await H.T.drag(ctx, X(0) + 2, midY(), X(f), midY());
        const r = await ctx.exec(() => { const o = window.__sv.E.renderPreview(); return { first: o.channels[0][0], cs: window.__sv.E.edit().cropStart }; });
        snaps.push({ f, first: +r.first.toFixed(5), cs: +r.cs.toFixed(5) });
    }
    const step = 0.7 * Math.sin(Math.PI * 220 / 48000) * 1.05;   // largest |sample| next to a zero crossing
    C.check('crop edges snap to zero crossings: the edit starts at ~0 (no click)', snaps.every(s => Math.abs(s.first) <= step), { step: +step.toFixed(5), snaps });
    await set({ cropStart: 0, cropEnd: 2, fadeInEnd: 0, fadeOutStart: 2 });
    await H.T.drag(ctx, X(0) + 2, midY(), X(0.311), midY(), { mods: ['alt'] });
    const free = await edit();
    C.check('Alt: free placement (exactly under the mouse, not snapped)', Math.abs(free.cropStart - 0.311 * 2) < 2 / g.width * 2 + 1e-4, free.cropStart);
    // snapped crop END: last sample near zero too
    await H.T.drag(ctx, X(1) - 2, midY(), X(0.8), midY());
    const lastS = await ctx.exec(() => { const o = window.__sv.E.renderPreview(); const d = o.channels[0]; return d[d.length - 1]; });
    C.check('crop end snaps too: the edit ends at ~0', Math.abs(lastS) <= step, +lastS.toFixed(5));

    // fuzz: 40 random trusted gestures aimed mostly at handles (some with Alt/Shift, some double-clicks),
    // the invariant is checked after every one; then undo everything → exactly the start state
    await H.selectExact(ctx, 'markers_mono_48k_4s.wav', 0.2, 3.9);
    await H.openEditor(ctx);
    await set({ cropStart: 0.8, cropEnd: 3.0, fadeInEnd: 1.2, fadeOutStart: 2.6 });
    const start = await edit();
    const h0 = (await ctx.exec(() => window.__sv.E.history())).undo;
    const r = rng(20260924);
    let bad = null, changed = 0;
    for (let i = 0; i < 40; i++) {
        g = await geo();
        const before = await edit();
        const targets = [[g.cropStart, g.height / 2], [g.cropEnd, g.height / 2], [g.fadeInEnd, 11], [g.fadeOutStart, 11], [(g.cropStart + g.fadeInEnd) / 2, g.height * 0.6], [(g.fadeOutStart + g.cropEnd) / 2, g.height * 0.3], [(g.fadeInEnd + g.fadeOutStart) / 2, g.height / 2]];
        let x0, y0;
        if (r() < 0.6) { const t = targets[Math.floor(r() * targets.length)]; x0 = g.left + t[0] + (r() - 0.5) * 6; y0 = g.top + t[1] + (r() - 0.5) * 6; }
        else { x0 = g.left + r() * g.width; y0 = g.top + r() * g.height; }
        const x1 = g.left + (r() * 1.2 - 0.1) * g.width, y1 = y0 + (r() - 0.5) * 120;
        const mods = r() < 0.3 ? ['alt'] : r() < 0.1 ? ['shift'] : [];
        if (r() < 0.1) await H.T.dblclick(ctx, x0, y0); else await H.T.drag(ctx, x0, y0, x1, y1, { steps: 6, mods });
        e = await edit();
        if (JSON.stringify(e) !== JSON.stringify(before)) changed++;
        if (!ordered(e)) { bad = { i, e }; break; }
    }
    C.check('40 random gestures (60 % on handles): cropStart ≤ fadeInEnd ≤ fadeOutStart ≤ cropEnd always', !bad && changed >= 15, { bad, changed });
    const hist = await ctx.exec(() => window.__sv.E.history());
    C.check('every changing gesture is one undo step', hist.undo - h0 >= Math.min(changed, 15), { undo: hist.undo - h0, changed });
    await ctx.exec(() => document.getElementById('editor').focus());
    for (let i = 0; i < hist.undo - h0; i++) await H.T.key(ctx, 'Z', ['control']);
    const back = await edit();
    const same = ['cropStart', 'cropEnd', 'fadeInEnd', 'fadeOutStart', 'fadeInTension', 'fadeOutTension', 'gainDb'].every(k => Math.abs(back[k] - start[k]) < 1e-9) && back.fadeInShape === start.fadeInShape && back.reverse === start.reverse;
    C.check('undoing every step returns exactly to the start state', same, { start, back });
    await H.shotEditor(ctx, 'handles-02-after-fuzz');
    C.done();
};
