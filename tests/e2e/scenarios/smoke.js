'use strict';
module.exports = async (ctx) => {
    const t0 = Date.now();
    await ctx.waitFor(() => !document.getElementById('splash'), 60000, 'splash gone');
    ctx.log('UI ready after', Date.now() - t0, 'ms');
    await ctx.wait(500);
    await ctx.shot('01-vault-home');
    await ctx.exec(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: '2', ctrlKey: true, bubbles: true })));   // Sound mode
    await ctx.waitFor(() => document.querySelectorAll('.node[data-kind="folder"]').length > 3, 10000, 'tree');
    await ctx.wait(900);
    await ctx.shot('02-sound-mode-all');
    await ctx.exec(() => { const n = [...document.querySelectorAll('.node[data-kind="folder"]')].find(e => e.textContent.startsWith('Families')); n && n.click(); });
    await ctx.wait(1200);
    await ctx.shot('03-families');
    // keyboard: down arrow twice (auto-play)
    await ctx.exec(() => { document.querySelector('.list').focus(); });
    await ctx.exec(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
    await ctx.wait(300);
    await ctx.exec(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
    await ctx.wait(700);
    await ctx.shot('04-playing');
    const st = await ctx.exec(() => ({ rows: document.querySelectorAll('.row').length, playing: !!document.querySelector('.row.playing'), title: document.querySelector('.now .t').textContent }));
    ctx.log('state', JSON.stringify(st));
    // selection drag on the cursor row
    await ctx.exec(async () => {
        const row = document.querySelector('.row.cursor');
        const wf = row.querySelector('.wf'); const r = wf.getBoundingClientRect();
        const ev = (t, x) => new MouseEvent(t, { bubbles: true, clientX: x, clientY: r.top + r.height / 2, button: 0 });
        wf.dispatchEvent(ev('mousedown', r.left + r.width * .2));
        document.dispatchEvent(ev('mousemove', r.left + r.width * .3));
        document.dispatchEvent(ev('mousemove', r.left + r.width * .6));
        document.dispatchEvent(ev('mouseup', r.left + r.width * .6));
    });
    await ctx.wait(900);
    await ctx.shot('05-selection');
    await ctx.exec(() => { const i = document.querySelector('.search input'); i.value = 'kick'; i.dispatchEvent(new Event('input', { bubbles: true })); });
    await ctx.wait(900);
    await ctx.shot('06-search');
    await ctx.exec(() => document.querySelector('.tb-right .icon-btn').click());
    await ctx.wait(600);
    await ctx.shot('07-settings');
    ctx.report.state = st;
};
