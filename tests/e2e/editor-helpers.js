'use strict';
// Shared helpers for tests/e2e/scenarios/editor-*.js. Setup (renders must not land in the user's Documents):
//   node tests/fixtures/make-editor-fixtures.js <lib> --user-data <ud>
//   electron tests/e2e/harness.js --lib <lib> --user-data <ud> --scenario tests/e2e/scenarios/editor-export.js --out <out>
const fs = require('fs');
const path = require('path');

function assert(cond, msg, extra) {
    if (!cond) { const e = new Error('ASSERTION FAILED: ' + msg + (extra !== undefined ? ': ' + JSON.stringify(extra).slice(0, 600) : '')); e.assertion = true; throw e; }
}

/** Collects named checks into ctx.report.checks; throws at the end if any failed. */
function checker(ctx) {
    const checks = [];
    ctx.report.checks = checks;
    return {
        check(name, cond, detail) {
            checks.push({ name, pass: !!cond, detail });
            ctx.log((cond ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? ' ' + JSON.stringify(detail).slice(0, 400) : ''));
            return !!cond;
        },
        done() {
            const failed = checks.filter(c => !c.pass);
            ctx.log(`RESULT ${checks.length - failed.length}/${checks.length} checks passed`);
            if (failed.length) throw new Error('ASSERTIONS FAILED: ' + failed.map(f => f.name).join(' | '));
        },
    };
}

// Trusted input (Chromium hit-testing, default actions, dblclick/contextmenu, keyboard)
const T = {
    move(ctx, x, y, mods = []) { ctx.wc.sendInputEvent({ type: 'mouseMove', x: Math.round(x), y: Math.round(y), modifiers: mods }); },
    async drag(ctx, x0, y0, x1, y1, { steps = 10, mods = [] } = {}) {
        T.move(ctx, x0, y0, mods);
        ctx.wc.sendInputEvent({ type: 'mouseDown', x: Math.round(x0), y: Math.round(y0), button: 'left', clickCount: 1, modifiers: mods });
        for (let i = 1; i <= steps; i++) { T.move(ctx, x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps, ['leftButtonDown', ...mods]); await ctx.wait(10); }
        ctx.wc.sendInputEvent({ type: 'mouseUp', x: Math.round(x1), y: Math.round(y1), button: 'left', clickCount: 1, modifiers: mods });
        await ctx.wait(80);
    },
    async click(ctx, x, y, { button = 'left', mods = [], clickCount = 1 } = {}) {
        T.move(ctx, x, y, mods);
        ctx.wc.sendInputEvent({ type: 'mouseDown', x: Math.round(x), y: Math.round(y), button, clickCount, modifiers: mods });
        ctx.wc.sendInputEvent({ type: 'mouseUp', x: Math.round(x), y: Math.round(y), button, clickCount, modifiers: mods });
        await ctx.wait(80);
    },
    async dblclick(ctx, x, y) { await T.click(ctx, x, y); await T.click(ctx, x, y, { clickCount: 2 }); await ctx.wait(60); },
    async rclick(ctx, x, y) { await T.click(ctx, x, y, { button: 'right' }); ctx.wc.sendInputEvent({ type: 'contextMenu', x: Math.round(x), y: Math.round(y) }); await ctx.wait(120); },
    async key(ctx, keyCode, mods = []) {
        ctx.wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers: mods });
        if (keyCode.length === 1 || keyCode === 'Space') ctx.wc.sendInputEvent({ type: 'char', keyCode: keyCode === 'Space' ? ' ' : keyCode, modifiers: mods });
        ctx.wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers: mods });
        await ctx.wait(80);
    },
};

/** Boot → Sound mode → "Editor" folder; mute output; expose module handles on window.__sv. */
async function boot(ctx) {
    await ctx.waitFor(() => !document.getElementById('splash'), 90000, 'splash gone');
    const rd = await ctx.exec(async () => (await window.sv.settings.get()).rendersDir);
    const home = require('os').homedir().toLowerCase();
    if (!rd || rd.toLowerCase().startsWith(path.join(home, 'documents').toLowerCase()) || rd.toLowerCase().startsWith(path.join(home, 'onedrive').toLowerCase())) {
        throw new Error(`refusing to run: renders would be written to ${rd}. Seed the user-data dir first: node tests/fixtures/make-editor-fixtures.js <lib> --user-data <ud>`);
    }
    ctx.wc.focus();
    await ctx.exec(async () => {
        const [editor, sel, list, engine, peaks, overlays] = await Promise.all([
            import('./js/ui/editor.js'), import('./js/ui/selection.js'), import('./js/ui/list.js'), import('./js/audio/engine.js'), import('./js/audio/peaks.js'), import('./js/ui/overlays.js')]);
        window.__sv = { editor, E: editor.__editorTest, selection: sel.selection, list: list.list, engine, peaks, overlays };
        engine.setVolume(0);
        return true;
    });
    const mode = await ctx.exec(() => document.querySelector('.brand .word') && document.querySelector('.brand .word').textContent);
    if (mode !== 'Sound') { await ctx.exec(() => document.querySelector('.brand').click()); await ctx.wait(600); }
    await ctx.waitFor(() => [...document.querySelectorAll('.node[data-kind="folder"]')].some(n => n.textContent.includes('Editor')), 20000, 'Editor folder in tree');
    await ctx.exec(() => [...document.querySelectorAll('.node[data-kind="folder"]')].find(n => n.textContent.includes('Editor')).click());
    await ctx.waitFor(() => window.__sv.list.items.length >= 5 && document.querySelectorAll('.row').length >= 5, 20000, 'rows');
    await ctx.wait(500);
}

const libPath = (ctx, name) => path.join(ctx.lib, 'Editor', name);

/** Make a list selection by dragging on the row waveform (trusted input) from fraction f0 to f1. */
async function selectByDrag(ctx, name, f0, f1) {
    const p = libPath(ctx, name);
    const box = await ctx.exec(async (p) => {
        const L = window.__sv.list;
        const i = L.index.get(p);
        L.scrollToIndex(i, true);
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        await window.__sv.peaks.requestPeaks(L.items[i]);
        L.refreshIndex(i);
        const row = L.pool.find(r => r.idx === i);
        const r = row.refs.wf.getBoundingClientRect();
        return { left: r.left, top: r.top, width: r.width, height: r.height };
    }, p);
    const y = box.top + box.height / 2;
    await T.drag(ctx, box.left + box.width * f0, y, box.left + box.width * f1, y);
    await ctx.wait(150);
    return ctx.exec(() => { const s = window.__sv.selection.get(); return s && { ...s }; });
}

/** Precise selection (seconds) through the selection module, as the list would set it. */
async function selectExact(ctx, name, start, end, fades = {}) {
    const p = libPath(ctx, name);
    return ctx.exec(async (p, start, end, fades) => {
        const L = window.__sv.list; const i = L.index.get(p);
        L.setCursor(i, { scroll: true });
        const pk = await window.__sv.peaks.requestPeaks(L.items[i]);
        window.__sv.selection.set({ path: p, start, end, duration: pk.duration, fadeIn: fades.fadeIn || 0, fadeOut: fades.fadeOut || 0 });
        return { ...window.__sv.selection.get() };
    }, p, start, end, fades);
}

/** Open the editor like a user: focus the list and press E. */
async function openEditor(ctx) {
    await ctx.exec(() => window.__sv.list.el.focus());
    await T.key(ctx, 'E');
    await ctx.waitFor(() => window.__sv.E.ready(), 20000, 'editor ready');
    await ctx.wait(250);
}

async function stageBox(ctx) { return ctx.exec(() => window.__sv.E.geometry()); }

/** Neutralize the real OS drag and record the IPC (with timestamps). */
function interceptDrag(ctx) {
    const { ipcMain } = require('electron');
    ipcMain.removeAllListeners('drag:start');
    const log = [];
    ipcMain.on('drag:start', (_e, payload) => log.push({ t: Date.now(), paths: payload && payload.paths, hasIcon: !!(payload && payload.icon) }));
    return log;
}

/** Instrument AudioBufferSourceNode in the page: live audio voices (control sources excluded). */
async function instrumentSources(ctx) {
    await ctx.exec(() => {
        if (window.__src) return;
        const live = new Set(); let starts = 0; const log = [];
        const Pt = AudioBufferSourceNode.prototype, os = Pt.start, op = Pt.stop;
        Pt.start = function () { if (!this.__svControl) { starts++; live.add(this); log.push(performance.now()); this.addEventListener('ended', () => live.delete(this)); } return os.apply(this, arguments); };
        Pt.stop = function () { live.delete(this); return op.apply(this, arguments); };
        window.__src = { live, get starts() { return starts; }, log };
    });
}

function readWav(file) {
    const b = fs.readFileSync(file);
    let pos = 12, fmt = null, data = null;
    while (pos + 8 <= b.length) {
        const id = b.toString('ascii', pos, pos + 4), size = b.readUInt32LE(pos + 4);
        if (id === 'fmt ') fmt = { tag: b.readUInt16LE(pos + 8), nc: b.readUInt16LE(pos + 10), sr: b.readUInt32LE(pos + 12), bits: b.readUInt16LE(pos + 22) };
        if (id === 'data') { data = { off: pos + 8, size }; break; }
        pos += 8 + size + (size & 1);
    }
    const bps = fmt.bits / 8, frames = Math.floor(data.size / (bps * fmt.nc));
    const ch = []; for (let c = 0; c < fmt.nc; c++) ch.push(new Float32Array(frames));
    let o = data.off;
    for (let i = 0; i < frames; i++) for (let c = 0; c < fmt.nc; c++) {
        let v;
        if (fmt.tag === 3) v = b.readFloatLE(o);
        else if (fmt.bits === 24) { let q = b[o] | (b[o + 1] << 8) | (b[o + 2] << 16); if (q & 0x800000) q |= ~0xFFFFFF; v = q / 8388608; }
        else v = b.readInt16LE(o) / 32768;
        ch[c][i] = v; o += bps;
    }
    return { ...fmt, frames, channels: ch };
}

function goertzel(x, f, sr, skip = 0) {
    const d = x.subarray(skip, x.length - skip);
    const w = 2 * Math.PI * f / sr, cw = 2 * Math.cos(w); let s1 = 0, s2 = 0;
    for (let i = 0; i < d.length; i++) { const s = d[i] + cw * s1 - s2; s2 = s1; s1 = s; }
    return 2 * Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - cw * s1 * s2)) / d.length;
}

/** Screenshot of the editor drawer only (hidden windows composite lazily → capture twice). */
async function shotEditor(ctx, name, full = false) {
    ctx.wc.invalidate(); await ctx.wait(120);
    const rect = full ? null : await ctx.exec(() => { const e = document.getElementById('editor'); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.floor(r.left), y: Math.max(0, Math.floor(r.top) - 2), width: Math.ceil(r.width), height: Math.ceil(r.height) + 2 }; });
    await (rect ? ctx.wc.capturePage(rect) : ctx.wc.capturePage());
    await ctx.wait(180); ctx.wc.invalidate(); await ctx.wait(80);
    const img = rect ? await ctx.wc.capturePage(rect) : await ctx.wc.capturePage();
    const file = path.join(ctx.out, name + '.png');
    fs.writeFileSync(file, img.toPNG());
    ctx.log('shot', name, JSON.stringify(img.getSize()));
    return file;
}

module.exports = { assert, checker, T, boot, libPath, selectByDrag, selectExact, openEditor, stageBox, interceptDrag, instrumentSources, readWav, goertzel, shotEditor };
