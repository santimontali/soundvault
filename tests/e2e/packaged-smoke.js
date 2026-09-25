'use strict';
/**
 * Smoke test of the BUILT app (dist/win-unpacked/soundvault.exe): isolated
 * user data + fixture library, driven over the DevTools protocol.
 * Checks: boots offline with the bundled models, analyses the library, AI
 * search, Echo, the vault Brief with the bundled image model, and exits
 * cleanly within 10 s of closing the window.
 *
 *   node tests/e2e/packaged-smoke.js [path\to\soundvault.exe]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { build } = require('../fixtures/make-library');

const exe = path.resolve(process.argv[2] || path.join(__dirname, '..', '..', 'dist', 'win-unpacked', 'soundvault.exe'));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-pkg-'));
const lib = path.join(root, 'lib'), ud = path.join(root, 'ud');
const port = 9400 + Math.floor(Math.random() * 400);
const results = [];
const ok = (name, cond, info = '') => { results.push({ name, ok: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${info ? ': ' + info : ''}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
    build(lib, { families: 4 });
    fs.mkdirSync(ud, { recursive: true });
    fs.writeFileSync(path.join(ud, 'soundvault-config.json'), JSON.stringify({ libraryPath: lib }));
    const t0 = Date.now();
    const child = spawn(exe, [`--user-data-dir=${ud}`, `--remote-debugging-port=${port}`, '--remote-allow-origins=*'], { stdio: 'ignore' });
    let exitedAt = null;
    child.on('exit', () => { exitedAt = Date.now(); });

    // attach to the page target
    let ws = null;
    for (let i = 0; i < 120 && !ws; i++) {
        await sleep(500);
        try {
            const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
            const page = list.find(t => t.type === 'page' && /renderer[\\/]index\.html/.test(t.url));
            if (page) ws = new WebSocket(page.webSocketDebuggerUrl);
        } catch (e) { /* not up yet */ }
    }
    if (!ws) throw new Error('could not attach to the app');
    await new Promise(r => ws.addEventListener('open', r, { once: true }));
    let id = 0;
    const pending = new Map();
    ws.addEventListener('message', ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
    const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    const evaluate = async expr => {
        const r = await send('Runtime.evaluate', { expression: `(async () => (${expr}))()`, awaitPromise: true, returnByValue: true });
        if (r.result && r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300));
        return r.result && r.result.result ? r.result.result.value : undefined;
    };
    const waitFor = async (expr, ms, label) => { const s = Date.now(); while (Date.now() - s < ms) { try { const v = await evaluate(expr); if (v) return v; } catch (e) { /* retry */ } await sleep(500); } throw new Error('timeout: ' + label); };

    await waitFor(`!document.getElementById('splash') && !!window.sv`, 60000, 'ui');
    ok('packaged app boots to a usable UI', true, `${Date.now() - t0} ms`);
    await waitFor(`window.sv.engine.status().then(s => s.ready)`, 180000, 'engine');
    const tReady = Date.now() - t0;
    const st0 = await evaluate(`window.sv.engine.status()`);
    ok('AI engine loads the bundled (offline) models', st0.ready && !st0.error, `${tReady} ms`);
    await waitFor(`window.sv.engine.status().then(s => s.vectors > 80 && !s.indexing)`, 900000, 'catalog');
    const st = await evaluate(`window.sv.engine.status()`);
    ok('library analysed automatically (indexing worker + ffmpeg inside the package)', st.vectors > 80 && st.echo > 80, `vectors ${st.vectors}, echo ${st.echo}, failures ${st.failures}`);
    const ai = await evaluate(`window.sv.engine.search('rain', { limit: 5 })`);
    ok('AI search', ai.results && ai.results.length > 0, ai.results && ai.results.map(r => r.name).join(', '));
    const echo = await evaluate(`(async () => {
        const l = await window.sv.library.list({ folder: 'Families/fam01' });
        const src = l.find(x => x.name.includes('orig'));
        const ab = await (await fetch(window.sv.audio.url(src.path))).arrayBuffer();
        const buf = await new OfflineAudioContext(1, 1, 48000).decodeAudioData(ab);
        const d = buf.getChannelData(0), a = Math.round(0.1 * buf.sampleRate), b = Math.round(0.5 * buf.sampleRate), pad = 2400;
        const res = await window.sv.engine.echo({ pcm: d.slice(a - pad, b + pad), sampleRate: buf.sampleRate, pre: pad, post: pad, exclude: [src.path] });
        return (res.results || []).slice(0, 5).map(r => r.name);
    })()`);
    ok('Echo inside the package', echo.filter(n => /fam01_/.test(n)).length >= 2, echo.join(', '));
    const brief = await evaluate(`(async () => {
        let st = await window.sv.brief.update({ words: ['rain'] });
        const model = st.imageModel;
        // a generated picture: whether it shows anything is not the point, that the image model runs is
        const c = new OffscreenCanvas(320, 200), g = c.getContext('2d');
        const grad = g.createLinearGradient(0, 0, 320, 200); grad.addColorStop(0, '#3a6ea5'); grad.addColorStop(1, '#e0c080');
        g.fillStyle = grad; g.fillRect(0, 0, 320, 200);
        const bytes = new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer());
        const s = new OffscreenCanvas(224, 224), sg = s.getContext('2d'); sg.drawImage(c, 0, 0, 224, 224);
        const rgba = sg.getImageData(0, 0, 224, 224).data, pixels = new Uint8Array(224 * 224 * 3);
        for (let i = 0; i < 224 * 224; i++) { pixels[i * 3] = rgba[i * 4]; pixels[i * 3 + 1] = rgba[i * 4 + 1]; pixels[i * 3 + 2] = rgba[i * 4 + 2]; }
        const t = performance.now();
        st = await window.sv.brief.addImage({ name: 'gradient.png', bytes, palette: ['#3a6ea5'], pixels });
        const ms = Math.round(performance.now() - t);
        const res = await window.sv.brief.suggest();
        return { model, analyzed: st.images.length === 1 && st.images[0].analyzed, ms, cards: (res.cards || []).map(c => c.title) };
    })()`);
    ok('the image model ships and runs inside the package', brief.model === 'ready' && brief.analyzed, `analyzed in ${brief.ms} ms`);
    ok('the vault Brief suggests collections inside the package', brief.cards.includes('rain'), brief.cards.join(', '));
    const tClose = Date.now();
    await evaluate(`window.close(), true`).catch(() => {});
    for (let i = 0; i < 60 && !exitedAt; i++) await sleep(500);
    ok('exits cleanly after closing the window', exitedAt && exitedAt - tClose < 10000, exitedAt ? `${exitedAt - tClose} ms` : 'still running after 30 s');
    if (!exitedAt) child.kill();
    try { ws.close(); } catch (e) { /* closed */ }
    await sleep(1000);
    fs.rmSync(root, { recursive: true, force: true });
    const failed = results.filter(r => !r.ok).length;
    console.log(`\n${results.length - failed}/${results.length} passed`);
    process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
