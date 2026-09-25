'use strict';
// Editor E2E: keyboard (trusted key events only): shortcuts, undo/redo (Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y),
// layered Esc (menu → help → editor; the list selection survives), keys never leak to the app,
// number fields accept "-4,5", slider arrows step in semitones. Requires --lib from make-editor-fixtures.js.
const H = require('../editor-helpers');

module.exports = async (ctx) => {
    const C = H.checker(ctx);
    await H.boot(ctx);
    const E = fn => ctx.exec(fn);
    await H.selectExact(ctx, 'ramp_st_48k_2s.wav', 0.1, 1.9);
    await H.openEditor(ctx);
    const focus = await E(() => document.activeElement && document.activeElement.id);
    C.check('opening the editor focuses it', focus === 'editor', focus);
    await E(() => window.__sv.E.setEdit({ cropStart: 0.2, cropEnd: 1.4, fadeInEnd: 0.3, fadeOutStart: 1.2 }));

    // R / undo / redo
    const src0 = await E(() => { const e = window.__sv.E.edit(); return e.reverse ? [e.duration - e.cropEnd, e.duration - e.cropStart] : [e.cropStart, e.cropEnd]; });
    await H.T.key(ctx, 'R');
    let e = await E(() => window.__sv.E.edit());
    const src1 = e.reverse ? [e.duration - e.cropEnd, e.duration - e.cropStart] : [e.cropStart, e.cropEnd];
    C.check('R reverses and keeps the same audio (source range unchanged)', e.reverse && Math.abs(src1[0] - src0[0]) < 1e-9 && Math.abs(src1[1] - src0[1]) < 1e-9, { src0, src1 });
    await H.T.key(ctx, 'Z', ['control']);
    C.check('Ctrl+Z undoes reverse', !(await E(() => window.__sv.E.edit())).reverse);
    await H.T.key(ctx, 'Z', ['control', 'shift']);
    C.check('Ctrl+Shift+Z redoes it', (await E(() => window.__sv.E.edit())).reverse);
    await H.T.key(ctx, 'Z', ['control']);
    await H.T.key(ctx, 'Y', ['control']);
    C.check('Ctrl+Y redoes too', (await E(() => window.__sv.E.edit())).reverse);
    await H.T.key(ctx, 'Z', ['control']);

    // N normalize (+ undo)
    const g0 = (await E(() => window.__sv.E.edit())).gainDb;
    await H.T.key(ctx, 'N');
    const pk = await E(() => { const r = window.__sv.E.renderPreview(); return 20 * Math.log10(r.peak); });
    const readout = await E(() => document.querySelector('#editor .ed-readouts').textContent);
    C.check('N normalizes the edit to -0.1 dBFS (and the readout says so)', Math.abs(pk + 0.1) < 0.02 && /Peak-0\.1dBFS/.test(readout.replace(/\s/g, '')) && !/null/.test(readout), { peakDb: +pk.toFixed(3), readout });
    await H.T.key(ctx, 'Z', ['control']);
    C.check('Ctrl+Z restores the gain', Math.abs((await E(() => window.__sv.E.edit())).gainDb - g0) < 1e-9);

    // L, S, Z, Shift+Z, Home, End
    const loop0 = await E(() => window.__sv.E.loop());
    await H.T.key(ctx, 'L');
    C.check('L toggles loop', (await E(() => window.__sv.E.loop())) === !loop0);
    await H.T.key(ctx, 'L');
    await H.T.key(ctx, 'S');
    const lanes = await E(() => window.__sv.E.picture().lanes);
    C.check('S shows stereo lanes', lanes === 2, lanes);
    await H.T.key(ctx, 'S');
    await H.T.key(ctx, 'Z');
    let v = await E(() => window.__sv.E.view());
    C.check('Z zooms to the crop (+4 % margins)', Math.abs(v.start - (0.2 - 0.048)) < 1e-3 && Math.abs(v.end - (1.4 + 0.048)) < 1e-3, v);
    await H.T.key(ctx, 'Z', ['shift']);
    v = await E(() => window.__sv.E.view());
    C.check('Shift+Z shows the whole selection', v.start === 0 && Math.abs(v.end - 1.8) < 1e-9, v);
    await H.T.key(ctx, 'End');
    const cEnd = await E(() => window.__sv.E.cursor());
    await H.T.key(ctx, 'Home');
    const cHome = await E(() => window.__sv.E.cursor());
    C.check('Home / End put the cursor on the crop edges', Math.abs(cHome - 0.2) < 1e-9 && Math.abs(cEnd - 1.4) < 1e-9, { cHome, cEnd });

    // number field: "-4,5" + Enter (locale-proof), Esc in the field reverts and returns focus
    await E(() => { const n = document.querySelector('#editor input.ed-num[aria-label="Gain in dB"]'); n.focus(); n.select(); });
    for (const ch of ['-', '4', ',', '5']) { ctx.wc.sendInputEvent({ type: 'keyDown', keyCode: ch }); ctx.wc.sendInputEvent({ type: 'char', keyCode: ch }); ctx.wc.sendInputEvent({ type: 'keyUp', keyCode: ch }); }
    await H.T.key(ctx, 'Enter');
    let gdb = (await E(() => window.__sv.E.edit())).gainDb;
    const back = await E(() => document.activeElement && document.activeElement.id);
    C.check('typing “-4,5” + Enter in the gain field sets -4.5 dB and returns focus to the editor', Math.abs(gdb + 4.5) < 1e-9 && back === 'editor', { gdb, back });
    await E(() => { const n = document.querySelector('#editor input.ed-num[aria-label="Gain in dB"]'); n.focus(); n.select(); });
    for (const ch of ['9', '9']) { ctx.wc.sendInputEvent({ type: 'keyDown', keyCode: ch }); ctx.wc.sendInputEvent({ type: 'char', keyCode: ch }); ctx.wc.sendInputEvent({ type: 'keyUp', keyCode: ch }); }
    await H.T.key(ctx, 'Escape');
    gdb = (await E(() => window.__sv.E.edit())).gainDb;
    const shown = await E(() => document.querySelector('#editor input.ed-num[aria-label="Gain in dB"]').value);
    C.check('Esc in the field discards the typing (editor stays open)', Math.abs(gdb + 4.5) < 1e-9 && /-4\.5 dB/.test(shown) && await E(() => window.__sv.E.isOpen()), { gdb, shown });

    // pitch slider arrows: → = +1 st, Shift+→ = +0.1 st
    await E(() => document.querySelector('#editor input.slider[aria-label^="Pitch"]').focus());
    await H.T.key(ctx, 'Right');
    await H.T.key(ctx, 'Right', ['shift']);
    const st = (await E(() => window.__sv.E.edit())).semitones;
    C.check('pitch slider: → +1 st, Shift+→ +0.1 st', Math.abs(st - 1.1) < 1e-9, st);
    await E(() => document.getElementById('editor').focus());

    // T trims the list selection; Ctrl+Z restores it
    const sel0 = await E(() => { const s = window.__sv.selection.get(); return [s.start, s.end]; });
    await H.T.key(ctx, 'T');
    const sel1 = await E(() => { const s = window.__sv.selection.get(); return [s.start, s.end]; });
    await H.T.key(ctx, 'Z', ['control']);
    const sel2 = await E(() => { const s = window.__sv.selection.get(); return [s.start, s.end]; });
    C.check('T trims the list selection to the crop; Ctrl+Z restores it', Math.abs(sel1[0] - 0.3) < 1e-9 && Math.abs(sel1[1] - 1.5) < 1e-9 && Math.abs(sel2[0] - sel0[0]) < 1e-9 && Math.abs(sel2[1] - sel0[1]) < 1e-9, { sel0, sel1, sel2 });

    // keys do not leak into the app while the editor is focused
    await H.T.key(ctx, 'C');
    await H.T.key(ctx, 'E');
    const leak = await E(() => ({ dialog: !!document.querySelector('.scrim, .menu'), open: window.__sv.E.isOpen() }));
    C.check('C / E inside the editor do not trigger app actions', !leak.dialog && leak.open, leak);

    // layered Esc: menu → help → editor (selection kept)
    const g = await H.stageBox(ctx);
    await H.T.rclick(ctx, g.left + g.width * 0.5, g.top + g.height * 0.8);
    const menu = await E(() => !!document.querySelector('.menu'));
    await H.T.key(ctx, 'Escape');
    const afterMenu = await E(() => ({ menu: !!document.querySelector('.menu'), open: window.__sv.E.isOpen() }));
    C.check('Esc #1 closes only the context menu', menu && !afterMenu.menu && afterMenu.open, { menu, ...afterMenu });
    await E(() => document.getElementById('editor').focus());
    await H.T.key(ctx, '?');
    const helpOpen = await E(() => !document.querySelector('#editor .ed-help').classList.contains('hidden'));
    await H.shotEditor(ctx, 'keyboard-01-help');
    await H.T.key(ctx, 'Escape');
    const afterHelp = await E(() => ({ help: !document.querySelector('#editor .ed-help').classList.contains('hidden'), open: window.__sv.E.isOpen() }));
    C.check('? opens the help sheet; Esc #2 closes only the sheet', helpOpen && !afterHelp.help && afterHelp.open, { helpOpen, ...afterHelp });
    await H.T.key(ctx, 'Escape');
    const closed = await E(() => ({ open: window.__sv.E.isOpen(), sel: !!window.__sv.selection.get(), focus: document.activeElement && document.activeElement.className }));
    C.check('Esc #3 closes the editor, keeps the list selection and gives focus back to the list', !closed.open && closed.sel && /\blist\b/.test(closed.focus), closed);

    // with the editor closed, Space belongs to the global player again
    await H.T.key(ctx, 'Space');
    await ctx.wait(300);
    const gp = await E(() => ({ player: window.__sv.engine.player.playing || window.__sv.engine.player.loading, editor: window.__sv.E.playing() }));
    C.check('editor closed: Space plays the list (global player), not the editor', gp.player && !gp.editor, gp);
    await E(() => window.__sv.engine.player.stop());
    // reopening restores the session edit (memory)
    await H.openEditor(ctx);
    e = await E(() => window.__sv.E.edit());
    C.check('reopening the same selection restores the edit (session memory)', Math.abs(e.gainDb + 4.5) < 1e-9 && Math.abs(e.semitones - 1.1) < 1e-9, { gain: e.gainDb, st: e.semitones });
    C.done();
};
