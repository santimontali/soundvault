'use strict';
// Full app, isolated userData, fixture library: automatic catalog, hybrid AI
// search, Echo (selection + file) through the real IPC path, UI responsiveness.
module.exports = async (ctx) => {
    const t0 = Date.now();
    const checks = [];
    const ok = (name, cond, info = '') => { checks.push({ name, ok: !!cond, info }); ctx.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${info ? ': ' + info : ''}`); };
    await ctx.waitFor(() => !document.getElementById('splash'), 60000, 'splash gone');
    ok('UI usable without waiting for the AI engine', true, `${Date.now() - t0} ms`);
    const rtt = await ctx.exec(async () => { const a = performance.now(); await window.sv.library.status(); return Math.round(performance.now() - a); });
    ok('IPC responsive while models load', rtt < 150, `${rtt} ms`);
    await ctx.waitFor(() => window.sv.engine.status().then(s => s.ready), 120000, 'engine ready');
    ok('engine ready', true, `${Date.now() - t0} ms`);
    // The catalog starts on its own (autoCatalog), wait for it to finish.
    const tIdx = Date.now();
    let maxRtt = 0, sawIndexing = false;
    while (Date.now() - tIdx < 600000) {
        const s = await ctx.exec(async () => { const a = performance.now(); const st = await window.sv.engine.status(); return { st, rtt: performance.now() - a }; });
        maxRtt = Math.max(maxRtt, s.rtt);
        if (s.st.indexing) sawIndexing = true;
        if (sawIndexing && !s.st.indexing && s.st.progress && s.st.progress.phase === 'done') break;
        if (!sawIndexing && Date.now() - tIdx > 20000 && s.st.vectors > 0) break;
        await ctx.wait(1000);
    }
    const st = await ctx.exec(() => window.sv.engine.status());
    ok('automatic catalog finishes', st.vectors > 80 && !st.indexing, `${Math.round((Date.now() - tIdx) / 1000)} s · vectors ${st.vectors} · echo ${st.echo} · failures ${st.failures}`);
    ok('IPC stays responsive during indexing', maxRtt < 250, `max ${Math.round(maxRtt)} ms`);
    const plan = await ctx.exec(() => window.sv.engine.index());
    ok('re-running the catalog is a no-op', plan && plan.queued === 0 && plan.deep === 0, JSON.stringify(plan));
    const pill = await ctx.exec(() => document.querySelector('.status-pill .txt, .status .txt')?.textContent || '');
    ok('status pill reports ready', /Resonance ready|to analyse/.test(pill), pill);

    for (const q of ['rain', 'metal impact', 'kick drum', 'lluvia']) {
        const r = await ctx.exec(q => window.sv.engine.search(q, { limit: 8 }), q);
        ctx.log('AI', JSON.stringify(q), '→', (r.results || []).slice(0, 6).map(x => x.name.replace('.wav', '') + ':' + (x.score == null ? 'n/a' : x.score.toFixed(2)) + ':' + x.match).join(', '), r.translated ? `(as "${r.query}")` : '');
    }
    const kick = await ctx.exec(() => window.sv.engine.search('kick', { limit: 10 }));
    ok('hybrid AI search puts name matches first', kick.results && kick.results[0] && /kick/i.test(kick.results[0].name) && kick.results[0].match === 'name', kick.results && kick.results.slice(0, 3).map(x => x.name).join(', '));
    const scoped = await ctx.exec(() => window.sv.engine.search('rain', { scope: 'folder', folder: 'Impacts', limit: 5 }));
    ok('scoped AI search stays inside the folder', scoped.results.length > 0 && scoped.results.every(x => x.dir.startsWith('Impacts')), scoped.results.map(x => x.dir + '/' + x.name).join(', '));
    const lex = await ctx.exec(() => window.sv.library.search({ q: 'sword swing' }));
    ok('lexical search never errors on natural phrases', Array.isArray(lex));

    // Echo from a selection, exactly like the renderer does it (decode + context + IPC)
    const echo = await ctx.exec(async () => {
        const l = await window.sv.library.list({ folder: 'Families/fam01' });
        const src = l.find(x => x.name.includes('orig'));
        const ab = await (await fetch(window.sv.audio.url(src.path))).arrayBuffer();
        const ac = new OfflineAudioContext(1, 1, 48000);
        const buf = await ac.decodeAudioData(ab);
        const d = buf.getChannelData(0);
        const a = Math.round(0.1 * buf.sampleRate), b = Math.round(0.5 * buf.sampleRate), pad = Math.round(0.05 * buf.sampleRate);
        const pcm = d.slice(a - pad, b + pad);
        const t = performance.now();
        const res = await window.sv.engine.echo({ pcm, sampleRate: buf.sampleRate, pre: pad, post: pad, maxResults: 20, exclude: [src.path] });
        return { ms: Math.round(performance.now() - t), err: res.error || null, top: (res.results || []).slice(0, 6).map(r => ({ name: r.name, score: r.score, off: r.offsetMs, dur: r.durationMs, weak: r.weak })) };
    });
    ok('Echo from a selection finds the family (source excluded)', echo.top.filter(r => /fam01_/.test(r.name)).length >= 2, `${echo.ms} ms · ${echo.top.map(r => r.name + (r.weak ? '(weak)' : ':' + Math.round(r.score * 100) + '%')).join(', ')} ${echo.err || ''}`);
    ok('Echo match spans equal the selection length', echo.top.length && echo.top.filter(r => !r.weak).every(r => Math.abs(r.dur - 400) <= 30 || r.dur < 400), echo.top.map(r => r.dur).join(','));
    const ef = await ctx.exec(async () => { const l = await window.sv.library.list({ folder: 'Families/fam02' }); return window.sv.engine.echoFile(l.find(x => x.name.includes('orig')).path, {}); });
    ok('Echo "more like this file" works', (ef.results || []).length > 0 && !ef.error, (ef.results || []).slice(0, 5).map(r => r.name).join(', '));

    // Echo drawer end to end: select a region on a row and press Ctrl+E
    await ctx.exec(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: '2', ctrlKey: true, bubbles: true })));   // Sound mode, deterministic
    await ctx.wait(400);
    await ctx.exec(() => { const n = [...document.querySelectorAll('.node[data-kind="folder"]')].find(e => e.textContent.startsWith('Families')); n && n.click(); });
    await ctx.waitFor(() => document.querySelectorAll('.row').length > 3, 10000, 'rows');
    // First VISIBLE row whose waveform is known (the virtual list keeps unbound rows in the DOM pool).
    try { await ctx.waitFor(() => [...document.querySelectorAll('.row')].some(r => r.getAttribute('aria-hidden') !== 'true' && r.getBoundingClientRect().top >= 0 && /\d/.test((r.querySelector('.dur') || {}).textContent || '')), 20000, 'peaks'); }
    catch (e) {
        const d = await ctx.exec(async () => ({
            vis: document.visibilityState, raf: await Promise.race([new Promise(r => requestAnimationFrame(() => r(true))), new Promise(r => setTimeout(() => r(false), 1000))]),
            rows: document.querySelectorAll('.row').length, dur: [...document.querySelectorAll('.row .dur')].slice(0, 3).map(x => x.textContent),
            peaks: await window.sv.audio.peaks([document.querySelector('.row') && document.querySelector('.row').dataset.path].filter(Boolean)).then(r => Object.keys(r).length, e => 'err ' + e.message),
        }));
        ctx.log('peaks diag', JSON.stringify(d));
        await ctx.shot('peaks-timeout');
        throw e;
    }
    await ctx.exec(async () => {
        const row = [...document.querySelectorAll('.row')].find(r => r.getAttribute('aria-hidden') !== 'true' && r.getBoundingClientRect().top >= 0 && /\d/.test((r.querySelector('.dur') || {}).textContent || ''));
        const wf = row.querySelector('.wf'); const r = wf.getBoundingClientRect();
        const ev = (t, x) => new MouseEvent(t, { bubbles: true, clientX: x, clientY: r.top + r.height / 2, button: 0 });
        wf.dispatchEvent(ev('mousedown', r.left + r.width * .1));
        document.dispatchEvent(ev('mousemove', r.left + r.width * .3));
        document.dispatchEvent(ev('mouseup', r.left + r.width * .4));
    });
    await ctx.wait(500);
    const selState = await ctx.exec(async () => {
        const { selection } = await import('./js/ui/selection.js');
        const { list } = await import('./js/ui/list.js');
        const row = [...document.querySelectorAll('.row')].find(r => r.getAttribute('aria-hidden') !== 'true' && r.getBoundingClientRect().top >= 0 && /\d/.test((r.querySelector('.dur') || {}).textContent || ''));
        const chain = []; for (let n = row; n && chain.length < 6; n = n.parentElement) chain.push(n.className);
        return { sel: selection.get(), cursor: document.querySelector('.row.cursor .nm')?.textContent || null,
            inPool: !!list.pool.find(x => x.el === row), idx: (list.pool.find(x => x.el === row) || {}).idx, chain, lists: document.querySelectorAll('.list').length };
    });
    await ctx.exec(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', ctrlKey: true, bubbles: true })));
    let drawer = 0;
    try { drawer = await ctx.waitFor(() => { const l = document.querySelectorAll('.echo.open .er'); return l.length ? l.length : 0; }, 30000, 'echo results'); }
    catch (e) {
        const d = await ctx.exec(() => ({ open: !!document.querySelector('.echo.open'), text: (document.querySelector('.echo')?.innerText || '').slice(0, 300) }));
        ctx.log('drawer state', JSON.stringify(d), 'selection', JSON.stringify(selState));
    }
    ok('Echo drawer shows results for a selection', drawer > 0, `${drawer} rows`);
    await ctx.shot && ctx.shot('echo-drawer');
    const fails = checks.filter(c => !c.ok);
    ctx.log(`${checks.length - fails.length}/${checks.length} checks passed`);
    if (fails.length) ctx.report.failed = fails.map(f => f.name);
};
