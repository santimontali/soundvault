'use strict';
// Editor E2E: layout & integration: bottom drawer inside #main (list stays visible and the selected row
// is scrolled into view), resizable top edge (clamped, persisted), contextual legend + tooltips, narrow
// windows, following list-selection edits of the same sound, "Detached" when the selection moves away.
// Requires --lib from make-editor-fixtures.js.
const H = require('../editor-helpers');

module.exports = async (ctx) => {
    const C = H.checker(ctx);
    await H.boot(ctx);
    const listBox = () => ctx.exec(() => { const r = window.__sv.list.el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: r.height }; });
    const rowBox = name => ctx.exec(n => { const L = window.__sv.list; const i = L.items.findIndex(x => x.name === n); const row = L.pool.find(r => r.idx === i); if (!row) return null; const r = row.el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; }, name);

    // the last row is selected while the list is tall; opening the drawer must keep it in view
    const sel = await H.selectByDrag(ctx, 'tiny_5ms_loudtail.wav', 0.1, 0.9);
    C.check('selection made by dragging on the last row', sel && sel.end > sel.start, sel);
    const lb0 = await listBox();
    await H.openEditor(ctx);
    const inMain = await ctx.exec(() => { const ed = document.getElementById('editor'); return { parent: ed.parentElement.id, last: ed.parentElement.lastElementChild === ed, h: Math.round(ed.getBoundingClientRect().height), bottomGap: Math.round(document.getElementById('player').getBoundingClientRect().top - ed.getBoundingClientRect().bottom) }; });
    C.check('drawer lives at the bottom of #main, right above the player bar', inMain.parent === 'main' && inMain.last && Math.abs(inMain.bottomGap) <= 1 && inMain.h >= 230, inMain);
    const lb1 = await listBox(), rb = await rowBox('tiny_5ms_loudtail.wav');
    C.check('the list stays visible above the drawer (shrinks, never covered)', lb1.height >= 150 && lb1.height < lb0.height, { before: lb0.height, after: lb1.height });
    C.check('the selected row was scrolled into view', rb && rb.top >= lb1.top - 1 && rb.bottom <= lb1.bottom + 1, { row: rb, list: lb1 });
    await ctx.shot('layout-01-drawer-open');

    // resize from the top edge: taller, clamped, persisted
    const edTop = await ctx.exec(() => document.getElementById('editor').getBoundingClientRect().top);
    await H.T.drag(ctx, 640, edTop + 1, 640, edTop - 90, { steps: 8 });
    const h1 = await ctx.exec(() => ({ h: Math.round(document.getElementById('editor').getBoundingClientRect().height), ls: localStorage.getItem('sv.editor.h') }));
    C.check('dragging the top edge up makes the drawer taller and remembers it', h1.h >= 410 && h1.ls === String(h1.h), h1);
    const edTop2 = await ctx.exec(() => document.getElementById('editor').getBoundingClientRect().top);
    await H.T.drag(ctx, 640, edTop2 + 1, 640, edTop2 - 800, { steps: 8 });
    const lb2 = await listBox();
    C.check('it can never cover the list (list keeps ≥ ~150 px)', lb2.height >= 140, lb2.height);
    const edTop3 = await ctx.exec(() => document.getElementById('editor').getBoundingClientRect().top);
    await H.T.drag(ctx, 640, edTop3 + 1, 640, edTop3 + 900, { steps: 8 });
    const h3 = await ctx.exec(() => Math.round(document.getElementById('editor').getBoundingClientRect().height));
    C.check('and never gets smaller than its minimum (230 px)', h3 === 230, h3);
    const rb2 = await rowBox('tiny_5ms_loudtail.wav'), lb3 = await listBox();
    C.check('after resizing, the selected row is still in view', rb2 && rb2.top >= lb3.top - 1 && rb2.bottom <= lb3.bottom + 1, { row: rb2, list: lb3 });
    await ctx.exec(() => { document.getElementById('editor').style.height = '330px'; });
    await ctx.wait(200);

    // discoverability: legend changes with what is under the mouse; every tool has a tooltip
    const legend0 = await ctx.exec(() => document.querySelector('#editor .ed-legend').textContent);
    const g = await H.stageBox(ctx);
    H.T.move(ctx, g.left + g.cropStart + 2, g.top + g.height / 2); await ctx.wait(120);
    const legendEdge = await ctx.exec(() => document.querySelector('#editor .ed-legend').textContent);
    H.T.move(ctx, g.left + g.width * 0.5, g.top + g.height / 2); await ctx.wait(120);
    const legendMid = await ctx.exec(() => document.querySelector('#editor .ed-legend').textContent);
    C.check('legend: general hints, then the gesture under the mouse', /Edges: trim/.test(legend0) && /Crop start.*zero crossings.*Alt/.test(legendEdge) && /slip/.test(legendMid), { legend0, legendEdge, legendMid });
    const tips = await ctx.exec(() => [...document.querySelectorAll('#editor button, #editor .ed-drag')].filter(b => !b.closest('.ed-help')).map(b => ({ label: b.getAttribute('aria-label') || b.textContent.trim(), tip: b.dataset.tip || null })));
    C.check('every editor button has a tooltip (or is the play button with its own)', tips.every(t => t.tip), tips.filter(t => !t.tip));

    // narrow window: nothing overflows the drawer (labels collapse, controls stay)
    ctx.win.setSize(980, 760); await ctx.wait(500);
    const narrow = await ctx.exec(() => { const f = document.querySelector('#editor .ed-foot'), hd = document.querySelector('#editor .ed-head'); return { foot: [f.scrollWidth, f.clientWidth], head: [hd.scrollWidth, hd.clientWidth], save: getComputedStyle(document.querySelector('#editor .ed-save-t')).display }; });
    C.check('narrow window: header and footer fit (container query hides labels)', narrow.foot[0] <= narrow.foot[1] + 1 && narrow.head[0] <= narrow.head[1] + 1 && narrow.save === 'none', narrow);
    await ctx.shot('layout-02-narrow');
    ctx.win.setSize(1280, 800); await ctx.wait(400);

    // the list selection of the same sound is edited in the list → the editor follows (keeps the audio in file time)
    await H.selectExact(ctx, 'markers_mono_48k_4s.wav', 0.5, 3.5);
    await H.openEditor(ctx);
    await ctx.exec(() => window.__sv.E.setEdit({ cropStart: 0.5, cropEnd: 2.5, fadeInEnd: 0.6, fadeOutStart: 2.3 }));
    await ctx.exec(() => window.__sv.selection.update({ start: 0.25, end: 3.75 }));
    await ctx.wait(150);
    const f = await ctx.exec(() => ({ region: window.__sv.E.region(), edit: window.__sv.E.edit() }));
    C.check('list selection resized → editor follows; the kept audio stays at 1.0-3.0 s of the file', Math.abs(f.region.start - 0.25) < 1e-9 && Math.abs(f.region.start + f.edit.cropStart - 1.0) < 1e-6 && Math.abs(f.region.start + f.edit.cropEnd - 3.0) < 1e-6 && Math.abs(f.edit.fadeInEnd - f.edit.cropStart - 0.1) < 1e-6, f);
    // a selection on another sound → the editor keeps its own copy and says so
    await H.selectExact(ctx, 'ramp_st_48k_2s.wav', 0.2, 1.2);
    await ctx.wait(150);
    const det = await ctx.exec(() => ({ open: window.__sv.E.isOpen(), chip: !document.querySelector('#editor .ed-detached').classList.contains('hidden'), region: window.__sv.E.region() }));
    C.check('selection moved to another sound → editor stays on its sound, shows “Detached”', det.open && det.chip && Math.abs(det.region.start - 0.25) < 1e-9, det);
    await H.shotEditor(ctx, 'layout-03-detached');
    await ctx.exec(() => window.__sv.E.close());
    const closed = await ctx.exec(() => ({ ed: !!document.getElementById('editor'), list: window.__sv.list.el.getBoundingClientRect().height }));
    C.check('closing removes the drawer and gives the list its space back', !closed.ed && closed.list > lb1.height + 200, closed);
    C.done();
};
