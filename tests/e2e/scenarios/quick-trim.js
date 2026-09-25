'use strict';
// Quick trim in Sound mode (real app, isolated userData, fixture library, trusted
// mouse input): a selection on a row's waveform is moved by its body, resized by
// its edges, faded by its dots, and each fade's CURVE is bent by dragging it
// (vertical: fast / slow start, sideways: its length) with a readout, and reset
// by a double-click. Every zone has its own cursor. The curve is the editor's
// model: what is drawn, what plays (the Web Audio automation) and what is
// rendered for the drag to a DAW all follow the same gain law. While the
// selection plays only the selection is colored (row and player bar), the
// playing row carries the accent in its control, name and progress (no side
// stripe). Screenshots of every state, including a frame mid-bend.
const fs = require('fs');
const path = require('path');
const { T, checker, readWav } = require('../editor-helpers');

// the editor's fade law, written from the spec (edit-dsp: power / S-curve / equal power, tension -1..1)
const gainLaw = (t, shape, k) => {
    if (t <= 0) return 0; if (t >= 1) return 1;
    const warp = Math.pow(t, Math.pow(10, k));
    if (shape === 'equal') return Math.sin(Math.PI / 2 * warp);
    if (shape === 'scurve') { const a = 2 * Math.pow(4, k); return Math.pow(t, a) / (Math.pow(t, a) + Math.pow(1 - t, a)); }
    return warp;
};

module.exports = async (ctx) => {
    const { check, done } = checker(ctx);
    const crop = async (name, r, pad = 6) => {
        ctx.wc.invalidate(); await ctx.wait(140);
        const rect = { x: Math.max(0, Math.floor(r.x - pad)), y: Math.max(0, Math.floor(r.y - pad)), width: Math.ceil(r.width + 2 * pad), height: Math.ceil(r.height + 2 * pad) };
        await ctx.wc.capturePage(rect); await ctx.wait(100); ctx.wc.invalidate(); await ctx.wait(60);
        fs.writeFileSync(path.join(ctx.out, name + '.png'), (await ctx.wc.capturePage(rect)).toPNG());
        ctx.log('shot', name);
    };
    const shot = async name => { ctx.wc.invalidate(); await ctx.wait(160); return ctx.shot(name); };
    const NAME = 'dur_9s.wav';
    const S = () => ctx.exec(async () => { const { selection } = await import('./js/ui/selection.js'); const s = selection.get(); return s && { ...s }; });
    const geo = () => ctx.exec(async n => {
        const { list } = await import('./js/ui/list.js'), { peaksFor } = await import('./js/audio/peaks.js');
        const i = list.items.findIndex(x => x.name === n), r = list.pool.find(p => p.idx === i);
        if (!r) return null;
        const b = r.refs.wf.getBoundingClientRect(), row = r.el.getBoundingClientRect();
        return { x: b.left, y: b.top, w: b.width, h: b.height, dur: peaksFor(list.items[i].path).duration, row: { x: row.left, y: row.top, width: row.width, height: row.height } };
    }, NAME);
    const cursorAt = (x, y) => ctx.exec((x, y) => { const e = document.elementFromPoint(x, y); const wf = e && e.closest('.wf'); return wf && wf.style.cursor ? wf.style.cursor : getComputedStyle(e).cursor; }, x, y);
    const stop = () => ctx.exec(async () => { (await import('./js/audio/engine.js')).player.stop(); return true; });
    const until = async (fn, args, ms, label) => {
        const end = Date.now() + ms;
        while (Date.now() < end) { try { const v = await ctx.exec(fn, ...args); if (v) return v; } catch (e) { /* keep polling */ } await ctx.wait(150); }
        throw new Error('timeout: ' + label);
    };

    await ctx.waitFor(() => !document.getElementById('splash'), 60000, 'splash gone');
    ctx.wc.focus();
    await ctx.exec(async () => { (await import('./js/audio/engine.js')).setVolume(0); return true; });
    await T.key(ctx, '2', ['control']);
    await ctx.waitFor(() => document.querySelectorAll('.node[data-kind="folder"]').length > 3, 10000, 'tree');
    await ctx.wait(700);
    await ctx.exec(() => { [...document.querySelectorAll('.node[data-kind="folder"]')].find(e => e.textContent.startsWith('Durations')).click(); return true; });
    await until(async n => { const { list } = await import('./js/ui/list.js'); return list.items.some(x => x.name === n) && document.querySelectorAll('.list .row:not([aria-hidden="true"])').length > 5; }, [NAME], 10000, 'rows');
    await ctx.exec(async n => { const { list } = await import('./js/ui/list.js'); list.scrollToIndex(list.items.findIndex(x => x.name === n), true); return true; }, NAME);
    await until(async n => { const { list } = await import('./js/ui/list.js'); const { peaksFor } = await import('./js/audio/peaks.js'); const it = list.items.find(x => x.name === n); return !!peaksFor(it.path) && !!list.pool.find(p => p.idx === list.items.indexOf(it)); }, [NAME], 10000, 'peaks');
    await ctx.wait(500);
    let g = await geo();
    const X = t => g.x + t / g.dur * g.w, Yg = gain => g.y + g.h * (1 - gain);

    // ── 1. a selection, fades by their dots ─────────────────────────────
    await T.drag(ctx, g.x + g.w * 0.2, g.y + g.h * 0.6, g.x + g.w * 0.8, g.y + g.h * 0.6, { steps: 14 });
    await ctx.wait(300);
    await stop();
    let s = await S();
    check('a drag on the waveform makes a selection', s && Math.abs(s.start / g.dur - 0.2) < 0.01 && Math.abs(s.end / g.dur - 0.8) < 0.01, s);
    const selPx = (s.end - s.start) / g.dur * g.w;
    await T.drag(ctx, X(s.start), g.y + 4, X(s.start) + selPx * 0.3, g.y + 4, { steps: 8 });
    await T.drag(ctx, X(s.end), g.y + 4, X(s.end) - selPx * 0.25, g.y + 4, { steps: 8 });
    await ctx.wait(250);
    await stop();
    s = await S();
    check('the fade dots set the fade lengths (the curves start linear)', Math.abs(s.fadeIn / (s.end - s.start) - 0.3) < 0.02 && Math.abs(s.fadeOut / (s.end - s.start) - 0.25) < 0.02 && s.fadeInShape === 'power' && s.fadeInTension === 0, s);
    await crop('01-selection-fades', g.row, 4);

    // ── 2. zones and cursors ────────────────────────────────────────────
    const fiMid = { x: X(s.start + s.fadeIn * 0.5), y: Yg(0.5) };
    const body = { x: X((s.start + s.fadeIn + s.end - s.fadeOut) / 2), y: g.y + g.h * 0.35 };
    const cursors = {};
    for (const [k, p] of Object.entries({ curve: fiMid, body, outside: { x: g.x + g.w * 0.1, y: g.y + g.h / 2 }, edge: { x: X(s.end) - 1, y: g.y + g.h * 0.7 }, dot: { x: X(s.start + s.fadeIn), y: g.y + 5 } })) {
        T.move(ctx, p.x, p.y); await ctx.wait(90);
        cursors[k] = await cursorAt(p.x, p.y);
    }
    check('each zone has its own cursor: curve bends (ns-resize), body moves (grab), edges resize (col-resize), dots fade (ew-resize), outside selects (text)', cursors.curve === 'ns-resize' && cursors.body === 'grab' && cursors.edge === 'col-resize' && cursors.dot === 'ew-resize' && cursors.outside === 'text', cursors);
    T.move(ctx, fiMid.x, fiMid.y); await ctx.wait(90);
    await crop('02-curve-hover', g.row, 4);

    // ── 3. bend the fade-in: down = slow start, the curve follows the pointer ──
    ctx.wc.sendInputEvent({ type: 'mouseDown', x: Math.round(fiMid.x), y: Math.round(fiMid.y), button: 'left', clickCount: 1 });
    for (let i = 1; i <= 8; i++) { T.move(ctx, fiMid.x, fiMid.y + i * 1.5, ['leftButtonDown']); await ctx.wait(16); }
    await ctx.wait(150);
    const mid = await ctx.exec(async () => { const { selection } = await import('./js/ui/selection.js'); const s = selection.get(); const tag = document.querySelector('.row .sel:not(.hidden) .ftag'); return { s: { ...s }, tag: tag && tag.classList.contains('show') ? tag.textContent : null, glyph: !!(tag && tag.querySelector('.fade-glyph')), cursor: getComputedStyle(document.body).cursor }; });
    const pointerGain = 1 - (Math.round(fiMid.y + 12) - g.y) / g.h;
    const u = (fiMid.x - X(mid.s.start)) / (mid.s.fadeIn / g.dur * g.w);
    const drawnGain = gainLaw(u, mid.s.fadeInShape, mid.s.fadeInTension);
    check('mid-bend: the curve passes under the pointer', mid.s.fadeInTension > 0.1 && Math.abs(drawnGain - pointerGain) < 0.04, { tension: mid.s.fadeInTension, drawnGain, pointerGain });
    check('mid-bend: a readout names the shape and the length, with the curve drawn small; the cursor holds', /^Fade in · Slow start \d+% · \d/.test(mid.tag || '') && mid.glyph && mid.cursor === 'ns-resize', mid);
    await crop('03-bend-mid', g.row, 34);
    await shot('03b-bend-mid-full');
    const lenBefore = mid.s.fadeIn;
    for (let i = 1; i <= 8; i++) { T.move(ctx, fiMid.x + i * 3, fiMid.y + 12, ['leftButtonDown']); await ctx.wait(16); }
    ctx.wc.sendInputEvent({ type: 'mouseUp', x: Math.round(fiMid.x + 24), y: Math.round(fiMid.y + 12), button: 'left', clickCount: 1 });
    await ctx.wait(300);
    await stop();
    s = await S();
    const wantLen = lenBefore + (24 - 4) / g.w * g.dur;
    check('sideways (past 4 px of slack) the fade length follows the pointer', Math.abs(s.fadeIn - wantLen) < 0.002 * g.dur, { fadeIn: s.fadeIn, wantLen });
    check('the bend is kept on the selection', s.fadeInTension > 0.1 && s.fadeInShape === 'power', { k: s.fadeInTension });
    const kIn = s.fadeInTension;
    // the fade-out, pulled up: fast start
    const foMid = { x: X(s.end - s.fadeOut * 0.5), y: Yg(0.5) };
    await T.drag(ctx, foMid.x, foMid.y, foMid.x, foMid.y - 12, { steps: 8 });
    await ctx.wait(250);
    await stop();
    s = await S();
    check('pulled up, a curve bends the other way (fast start)', s.fadeOutTension < -0.1 && Math.abs(s.fadeInTension - kIn) < 1e-9, { out: s.fadeOutTension });
    // what is drawn is the law: points of the drawn fade-in path lie on gainLaw
    const drawn = await ctx.exec(() => { const p = document.querySelector('.row .sel:not(.hidden) .fades .fl.in').getAttribute('d'); return p.slice(1).split('L').map(q => q.split(',').map(Number)); });
    const fiPct = s.fadeIn / (s.end - s.start) * 100;
    const drawnErr = Math.max(...drawn.map(([x, y]) => Math.abs((100 - y) / 100 - gainLaw(x / fiPct, s.fadeInShape, s.fadeInTension))));
    check('the drawn curve is the gain law itself', drawn.length > 10 && drawnErr < 1e-3, { points: drawn.length, drawnErr });
    await crop('04-bent', g.row, 4);

    // ── 4. double-click a curve: linear again ───────────────────────────
    const uHalf = Math.pow(0.5, 1 / Math.pow(10, s.fadeOutTension));        // where the bent fade-out crosses half level
    const foNow = { x: X(s.end - s.fadeOut * uHalf), y: Yg(0.5) };
    await T.dblclick(ctx, foNow.x, foNow.y);
    await ctx.wait(250);
    await stop();
    s = await S();
    check('a double-click on a curve resets it to linear (the other fade keeps its bend)', s.fadeOutShape === 'power' && s.fadeOutTension === 0 && Math.abs(s.fadeInTension - kIn) < 1e-9, { out: [s.fadeOutShape, s.fadeOutTension], kIn: s.fadeInTension });

    // ── 5. move the selection by its body ───────────────────────────────
    const before = s;
    const bx = X((s.start + s.fadeIn + s.end - s.fadeOut) / 2), by = g.y + g.h * 0.3;
    await T.drag(ctx, bx, by, bx - g.w * 0.1, by, { steps: 10 });
    await ctx.wait(250);
    await stop();
    s = await S();
    check('dragging the body moves the selection: length, fades and curves kept', Math.abs((before.start - s.start) - 0.1 * g.dur) < 0.005 * g.dur && Math.abs((s.end - s.start) - (before.end - before.start)) < 1e-9 && s.fadeIn === before.fadeIn && s.fadeInTension === before.fadeInTension && s.fadeOut === before.fadeOut, { from: before.start, to: s.start });
    await crop('05-moved', g.row, 4);
    // the edges still resize after a move
    const endBefore = s.end;
    await T.drag(ctx, X(s.end) - 1, g.y + g.h * 0.75, X(s.end) + g.w * 0.05, g.y + g.h * 0.75, { steps: 6 });
    await ctx.wait(250);
    await stop();
    s = await S();
    check('its edges still resize it (unambiguous next to the body)', s.end - endBefore > 0.04 * g.dur && Math.abs(s.start - before.start + 0.1 * g.dur) < 0.01 * g.dur, { endBefore, end: s.end });

    // ── 6. what plays is the drawn curve ────────────────────────────────
    await ctx.exec(() => {
        window.__curves = [];
        if (!window.__svCurveHook) {
            const o = AudioParam.prototype.setValueCurveAtTime;
            AudioParam.prototype.setValueCurveAtTime = function (values, t, d) { window.__curves.push({ values: Array.from(values), d }); return o.apply(this, arguments); };
            window.__svCurveHook = true;
        }
        return true;
    });
    const sb = await ctx.exec(() => { const b = document.querySelector('.row .sel:not(.hidden)').getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; });
    await T.click(ctx, sb.x + sb.w * 0.5, sb.y + sb.h * 0.25);
    await ctx.waitFor(async () => { const { player } = await import('./js/audio/engine.js'); return player.playing && !!player.segment; }, 8000, 'selection playing');
    const curves = await ctx.exec(() => window.__curves);
    const cIn = curves.find(c => c.values[0] === 0 && c.values[c.values.length - 1] === 1);
    let playErr = null;
    if (cIn) { const n = cIn.values.length - 1; playErr = Math.max(...cIn.values.map((v, i) => Math.abs(v - gainLaw(i / n, s.fadeInShape, s.fadeInTension)))); }
    check('playback automates the fade-in with the same law, densely (what you hear is what you drew)', !!cIn && Math.abs(cIn.d - s.fadeIn) < 1e-6 && cIn.values.length > s.fadeIn * 7000 && playErr < 1e-6, { found: !!cIn, d: cIn && cIn.d, n: cIn && cIn.values.length, playErr });

    // ── 7. while it plays, only the selection is colored ────────────────
    await ctx.waitFor(async () => { const { player } = await import('./js/audio/engine.js'); return player.position() > player.segment.start + (player.segment.end - player.segment.start) * 0.4; }, 8000, 'into the selection');
    const colored = await ctx.exec(async n => {
        const { list } = await import('./js/ui/list.js'), { player } = await import('./js/audio/engine.js'), { selection } = await import('./js/ui/selection.js');
        const i = list.items.findIndex(x => x.name === n), r = list.pool.find(p => p.idx === i), s = selection.get();
        const num = v => parseFloat(v);
        const clip = cp => { const m = /inset\(0(?:px)? ([\d.]+)% 0(?:px)? ([\d.]+)%\)/.exec(cp) || /inset\(0px ([\d.]+)% 0px ([\d.]+)%\)/.exec(cp); return m ? { right: num(m[1]), left: num(m[2]) } : { raw: cp }; };
        const d = list.items[i] && (await import('./js/audio/peaks.js')).peaksFor(list.items[i].path).duration;
        const cs = getComputedStyle(r.el), nm = getComputedStyle(r.refs.nm), pb = getComputedStyle(r.refs.pbtn);
        const acc = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
        return {
            row: clip(r.refs.played.style.clipPath), bar: clip(document.querySelector('.scrub .track canvas.played').style.clipPath),
            startPct: s.start / d * 100, posPct: player.position() / d * 100, playing: r.el.classList.contains('playing'),
            shadow: cs.boxShadow, name: nm.color, pbBg: pb.backgroundColor, accent: acc,
        };
    }, NAME);
    ctx.log('colored', JSON.stringify(colored));
    check('while a selection plays, only the selection is colored (row and player bar)', colored.row.left !== undefined && Math.abs(colored.row.left - colored.startPct) < 0.3 && Math.abs(colored.bar.left - colored.startPct) < 0.3 && 100 - colored.row.right > colored.startPct + 1, colored);
    const rgb = hex => `rgb(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)})`;
    check('the playing row carries the accent in its control and name, no side stripe', colored.playing && colored.shadow === 'none' && colored.name === rgb(colored.accent) && colored.pbBg === rgb(colored.accent), colored);
    await crop('06-selection-playing', g.row, 4);
    await crop('06b-player-bar', await ctx.exec(() => { const b = document.getElementById('player').getBoundingClientRect(); return { x: b.left, y: b.top, width: b.width, height: b.height }; }), 0);
    await shot('06c-selection-playing-full');
    await stop();

    // ── 8. the rendered file (dragged to a DAW) has the same fade ───────
    const rendered = await ctx.exec(async n => {
        const { list } = await import('./js/ui/list.js'), { selection } = await import('./js/ui/selection.js'), { prerenderRegion } = await import('./js/drag.js');
        const it = list.items.find(x => x.name === n);
        return { path: await prerenderRegion(it, selection.get()), src: it.path };
    }, NAME);
    let renderErr = null, frames = 0;
    if (rendered.path && fs.existsSync(rendered.path)) {
        const out = readWav(rendered.path), src = readWav(rendered.src);
        const a = Math.round(s.start * src.sr), FI = s.fadeIn * src.sr;
        frames = out.frames;
        renderErr = 0;
        for (let k = 0; k < Math.min(out.frames, Math.ceil(FI) + 200); k += 7) {
            const want = src.channels[0][a + k] * (k < FI ? gainLaw(k / FI, s.fadeInShape, s.fadeInTension) : 1);
            renderErr = Math.max(renderErr, Math.abs(out.channels[0][k] - want));
        }
    }
    check('the render for the drag has the same fade-in, sample for sample (16-bit rounding)', renderErr !== null && renderErr < 2 / 32768 && Math.abs(frames - Math.round((s.end - s.start) * 48000)) <= 1 && rendered.path.toLowerCase().startsWith(ctx.userData.toLowerCase()), { renderErr, frames, path: rendered.path });

    // ── 9. the whole file plays colored from its start, as before ───────
    await T.click(ctx, g.x + g.w * 0.05, g.y + g.h / 2);
    await ctx.waitFor(async () => { const { player } = await import('./js/audio/engine.js'); return player.playing && !player.segment && player.position() > 0.9; }, 8000, 'whole file playing');
    const whole = await ctx.exec(async n => { const { list } = await import('./js/ui/list.js'); const r = list.pool.find(p => p.idx === list.items.findIndex(x => x.name === n)); return { row: r.refs.played.style.clipPath, bar: document.querySelector('.scrub .track canvas.played').style.clipPath, sel: !!(await import('./js/ui/selection.js')).selection.get() }; }, NAME);
    check('with no selection the whole file is colored from its start (as before)', /inset\(0(px)? [\d.]+% 0(px)? 0%\)|inset\(0(px)? [\d.]+% 0(px)?\)/.test(whole.row) && / 0%\)$| 0px\)$/.test(whole.bar) && !whole.sel, whole);
    await crop('07-whole-file-playing', g.row, 4);
    await stop();

    const errors = ctx.report.console.filter(m => m.level === 3 || m.level === 'error').map(m => m.message);
    check('no renderer errors', errors.length === 0, errors.slice(0, 5));
    done();
};
