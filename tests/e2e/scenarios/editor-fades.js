'use strict';
// Fades you can see and grab, with TRUSTED mouse input:
//  • list selection: dots on the top corners set fade-in/out (a gain line and a
//    veil show them), double-click removes a fade, the edge grips below the dot
//    band still resize, too-narrow selections hide the dots;
//  • editor: the readouts draw each fade's curve and the curve menu shows every
//    shape as a picture.
// Requires --lib from make-editor-fixtures.js.
const fs = require('fs');
const path = require('path');
const H = require('../editor-helpers');

async function shotRect(ctx, name, rect, zoom = 1) {
    ctx.wc.invalidate(); await ctx.wait(150);
    let img = await ctx.wc.capturePage(rect);
    if (zoom !== 1) img = img.resize({ width: Math.round(rect.width * zoom), quality: 'best' });
    fs.writeFileSync(path.join(ctx.out, name + '.png'), img.toPNG());
    ctx.log('shot', name);
}

module.exports = async (ctx) => {
    const C = H.checker(ctx);
    await H.boot(ctx);
    const name = 'markers_mono_48k_4s.wav';
    const s0 = await H.selectByDrag(ctx, name, 0.2, 0.8);
    C.check('a drag on the row waveform makes a selection', s0 && s0.end - s0.start > 2, s0);

    // geometry of the selected row: selection box, fade dots, edge grips
    const box = () => ctx.exec(() => {
        const sel = document.querySelector('.row .sel:not(.hidden)');
        const rr = el => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
        return {
            sel: rr(sel), wf: rr(sel.parentElement),
            fkIn: rr(sel.querySelector('.fk.in')), fkOut: rr(sel.querySelector('.fk.out')),
            hL: rr(sel.querySelector('.h.l')), hR: rr(sel.querySelector('.h.r')),
            zeroIn: sel.querySelector('.fk.in').classList.contains('zero'),
            dotsShown: getComputedStyle(sel.querySelector('.fk.in')).display !== 'none',
            svgNoIn: sel.querySelector('svg.fades').classList.contains('no-in'),
            svgNoOut: sel.querySelector('svg.fades').classList.contains('no-out'),
        };
    });
    const sel = () => ctx.exec(() => ({ ...window.__sv.selection.get() }));
    let b = await box();
    C.check('both fade dots are shown (hollow: no fade yet) and no fade is drawn', b.dotsShown && b.zeroIn && b.svgNoIn && b.svgNoOut, b);
    C.check('edge grips start below the dot band (the two never overlap)', b.hL.top >= b.fkIn.bottom - 1 && b.hR.top >= b.fkOut.bottom - 1, { hTop: b.hL.top, dotBottom: b.fkIn.bottom });
    const rowRect = { x: Math.floor(b.wf.left) - 6, y: Math.floor(b.wf.top) - 8, width: Math.ceil(b.wf.width) + 12, height: Math.ceil(b.wf.height) + 16 };
    await shotRect(ctx, 'fades-01-selection', rowRect, 2);

    // drag the fade-in dot 25 % into the selection, the fade-out dot 20 % in from the end
    const cy = r => r.top + r.height / 2;
    await H.T.drag(ctx, b.fkIn.left + b.fkIn.width / 2, cy(b.fkIn), b.sel.left + b.sel.width * 0.25, cy(b.fkIn));
    await ctx.wait(120);
    let s = await sel();
    const len = s.end - s.start;
    C.check('dragging the left dot sets the fade-in (25 % of the selection)', Math.abs(s.fadeIn / len - 0.25) < 0.02 && s.start === s0.start && s.end === s0.end, { fadeIn: s.fadeIn, len });
    b = await box();
    await H.T.drag(ctx, b.fkOut.left + b.fkOut.width / 2, cy(b.fkOut), b.sel.right - b.sel.width * 0.2, cy(b.fkOut));
    await ctx.wait(120);
    s = await sel();
    C.check('dragging the right dot sets the fade-out (20 %), the fade-in is kept', Math.abs(s.fadeOut / len - 0.2) < 0.02 && Math.abs(s.fadeIn / len - 0.25) < 0.02, { fadeIn: s.fadeIn, fadeOut: s.fadeOut });
    b = await box();
    C.check('both fades are drawn and the dots are solid at the fade ends', !b.svgNoIn && !b.svgNoOut && !b.zeroIn && Math.abs((b.fkIn.left + b.fkIn.width / 2) - (b.sel.left + b.sel.width * 0.25)) < 3, b);
    await shotRect(ctx, 'fades-02-fades', rowRect, 2);

    // the edge grip below the dot band still resizes the selection
    await H.T.drag(ctx, b.hR.left + b.hR.width / 2, b.wf.top + b.wf.height * 0.7, b.sel.right - b.sel.width * 0.1, b.wf.top + b.wf.height * 0.7);
    await ctx.wait(120);
    const s2 = await sel();
    C.check('the right edge grip (lower part) still resizes the selection', s2.end < s.end - 0.1 && s2.start === s.start && s2.fadeIn > 0, { endBefore: s.end, endAfter: s2.end });

    // double-click the fade-in dot removes the fade-in only
    b = await box();
    await H.T.dblclick(ctx, b.fkIn.left + b.fkIn.width / 2, cy(b.fkIn));
    await ctx.wait(150);
    const s3 = await sel();
    C.check('double-clicking the fade-in dot removes the fade-in (the fade-out stays)', s3.fadeIn === 0 && s3.fadeOut > 0, { fadeIn: s3.fadeIn, fadeOut: s3.fadeOut });
    await shotRect(ctx, 'fades-03-after-reset', rowRect, 2);

    // restore a fade-in for the editor checks, then open the editor on this selection
    await ctx.exec(() => window.__sv.selection.update({ fadeIn: 0.3 }));
    await H.openEditor(ctx);
    const read = await ctx.exec(() => {
        const kvs = [...document.querySelectorAll('#editor .ed-readouts .fade-kv')];
        return kvs.map(k => ({ text: k.textContent.replace(/\s+/g, ' ').trim(), glyph: !!k.querySelector('svg.fade-glyph') }));
    });
    C.check('editor readouts draw both fade curves next to their lengths', read.length === 2 && read.every(r => r.glyph), read);
    await H.shotEditor(ctx, 'fades-04-editor');

    // right-click inside the fade-in zone: the curve menu shows every shape as a picture
    const g = await ctx.exec(() => window.__sv.E.geometry());
    await H.T.rclick(ctx, g.left + (g.cropStart + g.fadeInEnd) / 2, g.top + g.height * 0.55);
    await ctx.wait(200);
    const menu = await ctx.exec(() => {
        const m = document.querySelector('.menu');
        if (!m) return null;
        return { rows: [...m.querySelectorAll('.mi')].filter(r => r.querySelector('svg.fade-glyph')).map(r => r.textContent.trim()), header: !!m.querySelector('.hd svg.fade-glyph') };
    });
    C.check('the fade curve menu shows a picture of every shape (and of the current one)', menu && menu.rows.length === 5 && menu.header, menu);
    const mr = await ctx.exec(() => { const r = document.querySelector('.menu').getBoundingClientRect(); return { x: Math.floor(r.left) - 4, y: Math.floor(r.top) - 4, width: Math.ceil(r.width) + 8, height: Math.ceil(r.height) + 8 }; });
    await shotRect(ctx, 'fades-05-curve-menu', mr, 2);
    // pick "S-curve" from the menu: the edit and its readout follow
    await ctx.exec(() => [...document.querySelectorAll('.menu .mi')].find(r => r.textContent.includes('S-curve')).click());
    await ctx.wait(200);
    const e = await ctx.exec(() => window.__sv.E.edit());
    C.check('choosing a shape from the pictures applies it', e.fadeInShape === 'scurve', { shape: e.fadeInShape });
    await H.T.key(ctx, 'Escape');
    await ctx.wait(200);

    // a very narrow selection hides the dots (fades stay on Shift + edges)
    await ctx.exec(() => { const s = window.__sv.selection.get(); window.__sv.selection.set({ path: s.path, start: 1, end: 1.04, duration: s.duration }); });
    await ctx.wait(150);
    const narrow = await ctx.exec(() => { const sel = document.querySelector('.row .sel:not(.hidden)'); return sel ? { narrow: sel.classList.contains('narrow'), px: sel.getBoundingClientRect().width } : null; });
    C.check('a selection narrower than two dots hides them', narrow && (narrow.px >= 34 || narrow.narrow), narrow);

    C.done();
};
