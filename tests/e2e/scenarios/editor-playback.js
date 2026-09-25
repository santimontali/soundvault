'use strict';
// Editor E2E: playback lifecycle: ≤ 1 live voice at any time, Space → sound latency,
// live gain/pitch (no restart), seamless loop, play from cursor, mutual exclusion
// with the global player, stop on close. Requires --lib from make-editor-fixtures.js.
const H = require('../editor-helpers');

module.exports = async (ctx) => {
    const C = H.checker(ctx);
    await H.boot(ctx);
    await H.instrumentSources(ctx);
    // track the maximum number of simultaneously live editor/list voices for the whole run
    await ctx.exec(() => { window.__maxLive = 0; setInterval(() => { window.__maxLive = Math.max(window.__maxLive, window.__src.live.size); }, 5); });
    const live = () => ctx.exec(() => window.__src.live.size);
    const st = () => ctx.exec(() => ({ playing: window.__sv.E.playing(), live: window.__src.live.size, starts: window.__src.starts, player: window.__sv.engine.player.playing || window.__sv.engine.player.loading, pos: window.__sv.E.position(), node: window.__sv.E.live() }));

    await H.selectExact(ctx, 'pad_st_48k_30s.wav', 2, 26);
    await H.openEditor(ctx);

    // 1. Space → sound latency (handler → AudioBufferSourceNode.start), in-page and with a trusted key
    const lat = await ctx.exec(async () => {
        const root = document.getElementById('editor'); root.focus();
        const n0 = window.__src.log.length, t0 = performance.now();
        root.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true, cancelable: true }));
        const t1 = window.__src.log[n0];
        return { ms: t1 !== undefined ? t1 - t0 : null, started: window.__src.log.length - n0 };
    });
    C.check('Space → source.start < 30 ms (24 s edit, no render before playing)', lat.ms !== null && lat.ms < 30 && lat.started === 1, lat);
    await ctx.wait(300);
    let s = await st();
    C.check('playing with exactly one live voice', s.playing && s.live === 1, s);
    await H.T.key(ctx, 'Space');
    s = await st();
    C.check('Space again stops (0 live)', !s.playing && s.live === 0, s);
    const trusted = await (async () => {
        const n0 = await ctx.exec(() => window.__src.log.length);
        const tSend = Date.now();
        ctx.wc.sendInputEvent({ type: 'keyDown', keyCode: 'Space' }); ctx.wc.sendInputEvent({ type: 'char', keyCode: ' ' }); ctx.wc.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
        await ctx.wait(150);
        const tStart = await ctx.exec((n0) => window.__src.log[n0] !== undefined ? performance.timeOrigin + window.__src.log[n0] : null, n0);
        return { ms: tStart ? Math.round(tStart - tSend) : null };
    })();
    C.check('trusted Space keypress → sound < 30 ms', trusted.ms !== null && trusted.ms < 30, trusted);
    await H.T.key(ctx, 'Space');

    // 2. hammering play: rapid trusted presses and a burst of synthetic ones never overlap voices
    for (let i = 0; i < 5; i++) { ctx.wc.sendInputEvent({ type: 'keyDown', keyCode: 'Space' }); ctx.wc.sendInputEvent({ type: 'char', keyCode: ' ' }); ctx.wc.sendInputEvent({ type: 'keyUp', keyCode: 'Space' }); }
    await ctx.wait(300);
    s = await st();
    C.check('5 rapid Space presses → ≤ 1 live voice (odd count ends playing)', s.live <= 1 && s.playing === (s.live === 1), s);
    const wasPlaying = s.playing;
    await ctx.exec(() => { const r = document.getElementById('editor'); for (let i = 0; i < 6; i++) r.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true })); });
    await ctx.wait(200);
    s = await st();
    C.check('6 synthetic Space presses in one task → same state as before, ≤ 1 live', s.playing === wasPlaying && s.live === (wasPlaying ? 1 : 0), { wasPlaying, ...s });

    // 3. live gain & pitch while playing (no restart)
    if (!s.playing) await H.T.key(ctx, 'Space');
    await ctx.wait(200);
    const s0 = await st();
    await ctx.exec(() => { const g = document.querySelector('#editor input.slider[aria-label^="Gain"]'); g.value = '-12'; g.dispatchEvent(new Event('input', { bubbles: true })); g.dispatchEvent(new Event('change', { bubbles: true })); });
    await ctx.wait(250);
    const s1 = await st();
    C.check('gain changes live (same voice, gain ≈ -12 dB)', s1.starts === s0.starts && s1.live === 1 && Math.abs(s1.node.gain - Math.pow(10, -12 / 20)) < 0.02, { before: s0.node, after: s1.node, starts: [s0.starts, s1.starts] });
    await ctx.exec(() => document.querySelector('#editor input.slider[aria-label^="Pitch"]').focus());
    await H.T.key(ctx, 'Right');
    await H.T.key(ctx, 'Right');
    await ctx.wait(150);
    const s2 = await st();
    C.check('pitch changes live (+2 st: rate 1.1225, same voice)', s2.starts === s0.starts && s2.live === 1 && Math.abs(s2.node.rate - Math.pow(2, 2 / 12)) < 1e-3, { rate: s2.node.rate, starts: s2.starts });
    // Space while a slider has focus still plays/stops (old editor ignored it)
    await H.T.key(ctx, 'Space');
    s = await st();
    C.check('Space with a slider focused stops playback', !s.playing && s.live === 0, s);

    // 4. structural edit while playing → restart at the same spot, still one voice
    await ctx.exec(() => document.getElementById('editor').focus());
    await H.T.key(ctx, 'Space');
    await ctx.wait(400);
    const p0 = (await st()).pos;
    await H.T.key(ctx, 'R');
    await ctx.wait(60);
    s = await st();
    C.check('reverse while playing: one voice, continues near the same spot', s.playing && s.live === 1 && Math.abs(s.pos - p0) < 0.6, { p0, p1: s.pos, live: s.live });
    await H.T.key(ctx, 'R');
    await H.T.key(ctx, 'Space');

    // 5. seamless loop on a short crop: one source for many passes
    await ctx.exec(() => window.__sv.E.setEdit({ semitones: 0, gainDb: 0, cropStart: 1.0, cropEnd: 1.3, fadeInEnd: 1.02, fadeOutStart: 1.25 }));
    await H.T.key(ctx, 'L');
    const l0 = await st();
    await H.T.key(ctx, 'Space');
    await ctx.wait(1300);
    const l1 = await st();
    C.check('loop: still playing after 4+ passes with a single source (seamless)', l1.playing && l1.live === 1 && l1.starts === l0.starts + 1 && l1.node.loop && l1.node.control, { starts: [l0.starts, l1.starts], node: l1.node });
    C.check('loop: position stays inside the crop', l1.pos >= 1.0 - 1e-3 && l1.pos <= 1.3 + 1e-3, l1.pos);
    await H.T.key(ctx, 'Space');
    await H.T.key(ctx, 'L');

    // 6. play from cursor: click the ruler at 60 %, Space starts there
    await ctx.exec(() => window.__sv.E.setEdit({ cropStart: 0, cropEnd: 24, fadeInEnd: 0, fadeOutStart: 24 }));
    const rb = await ctx.exec(() => { const r = document.querySelector('#editor .ed-ruler').getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; });
    await H.T.click(ctx, rb.left + rb.width * 0.6, rb.top + rb.height / 2);
    const cur = await ctx.exec(() => window.__sv.E.cursor());
    await H.T.key(ctx, 'Space');
    await ctx.wait(100);
    s = await st();
    C.check('ruler click sets the cursor; Space plays from it', Math.abs(cur - 0.6 * 24) < 0.1 && s.playing && Math.abs(s.pos - cur) < 0.4, { cursor: cur, pos: s.pos });

    // 7. the global player starting stops the editor
    await ctx.exec(() => { const p = window.__sv.selection.get().path; const item = window.__sv.list.get(p); window.__sv.engine.player.play(item, { at: 0 }); });
    await ctx.wait(400);
    s = await st();
    C.check('global player starts → editor stops', !s.playing && s.player, s);
    // 8. the editor starting stops the global player
    await ctx.exec(() => document.getElementById('editor').focus());
    await H.T.key(ctx, 'Space');
    await ctx.wait(200);
    s = await st();
    C.check('editor starts → global player stops; one live voice', s.playing && !s.player && s.live === 1, s);

    // 9. close while playing (Esc): silence, selection kept
    await H.T.key(ctx, 'Escape');
    await ctx.wait(150);
    const c = await ctx.exec(() => ({ open: window.__sv.E.isOpen(), playing: window.__sv.E.playing(), live: window.__src.live.size, sel: !!window.__sv.selection.get() }));
    C.check('Esc closes the editor, stops audio, keeps the list selection', !c.open && !c.playing && c.live === 0 && c.sel, c);
    // 10. close while a (re)open is decoding → nothing plays later
    await H.openEditor(ctx);
    await H.T.key(ctx, 'Space');
    await ctx.exec(() => window.__sv.E.close());
    await ctx.wait(300);
    C.check('play then close immediately → no ghost voice', (await live()) === 0);
    const maxLive = await ctx.exec(() => window.__maxLive);
    C.check('never more than one live voice during the whole run', maxLive <= 1, maxLive);
    C.done();
};
