'use strict';
/**
 * E2E harness: runs the REAL app (src/main.js) against an isolated userData
 * directory and a given library, then executes a scenario that drives the
 * renderer and captures screenshots. Never touches %APPDATA%\soundvault.
 *
 *   electron tests/e2e/harness.js --lib <dir> --scenario <file.js> --out <dir>
 *            [--user-data <dir>] [--show] [--size 1280x800] [--timeout 600]
 *
 * A scenario is `module.exports = async (ctx) => { ... }` where ctx offers:
 *   exec(fnOrCode, ...args)   run in renderer (functions are serialized)
 *   waitFor(fn, ms, label)    poll a renderer predicate until truthy
 *   shot(name)                capture the window to <out>/<name>.png
 *   wait(ms), log(...), main  (require()d main-process modules: engine, etc.)
 *   win, wc, lib, out, userData, consoleLog (array of renderer console lines)
 * Results: <out>/report.json (steps, console, errors, timings).
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');
const electron = require('electron');
const { app } = electron;

function arg(name, def) {
    const i = process.argv.indexOf('--' + name);
    if (i === -1) return def;
    const v = process.argv[i + 1];
    return (v === undefined || v.startsWith('--')) ? true : v;
}

const lib = path.resolve(arg('lib', ''));
const scenarioPath = path.resolve(arg('scenario', ''));
const out = path.resolve(arg('out', path.join(os.tmpdir(), 'sv-e2e-out')));
const userData = path.resolve(arg('user-data', path.join(os.tmpdir(), 'sv-e2e-ud-' + Date.now())));
const show = !!arg('show', false);
const [W, H] = String(arg('size', '1280x800')).split('x').map(Number);
const timeoutS = Number(arg('timeout', 600));

if (!lib || !fs.existsSync(lib)) { console.error('[harness] --lib must exist:', lib); process.exit(2); }
if (!fs.existsSync(scenarioPath)) { console.error('[harness] --scenario not found:', scenarioPath); process.exit(2); }
if (userData.toLowerCase().includes(path.join('appdata', 'roaming', 'soundvault'))) {
    console.error('[harness] refusing to run against the real userData dir'); process.exit(2);
}

fs.mkdirSync(out, { recursive: true });
fs.mkdirSync(userData, { recursive: true });
app.setPath('userData', userData);
// Renders (selection previews, drags) stay in the isolated folder too: the default
// is the user's Documents\SoundVault Renders, whose staging folder the app empties
// on quit (a test run must never delete a running app's previews).
const cfgPath = path.join(userData, 'soundvault-config.json');
const cfg = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : { libraryPath: lib };
if (!cfg.rendersDir) { cfg.rendersDir = path.join(userData, 'renders'); fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2)); }
const docs = app.getPath('documents').toLowerCase();
if (path.resolve(cfg.rendersDir).toLowerCase().startsWith(docs)) { console.error('[harness] refusing to run: renders would be written to', cfg.rendersDir); process.exit(2); }

// Force the app window hidden (unless --show) without touching src/main.js:
// intercept `require('electron')` from src/ and hand back a patched BrowserWindow.
// Never-shown windows get no animation frames (waveforms would never draw), so
// without --show the window is shown fully transparent, click-through, inactive
// and off the taskbar: it renders like a real one but never steals focus or
// appears on screen.
class PatchedBrowserWindow extends electron.BrowserWindow {
    constructor(opts = {}) {
        super({
            ...opts,
            width: W || opts.width, height: H || opts.height,
            show: show ? opts.show : false,
            ...(show ? {} : { opacity: 0, skipTaskbar: true, focusable: false }),
            webPreferences: { ...(opts.webPreferences || {}), backgroundThrottling: false },
        });
        if (!show) { this.setIgnoreMouseEvents(true); super.showInactive(); }
    }
    show() { if (show) super.show(); else super.showInactive(); }
    focus() { if (show) super.focus(); }
}
const srcDir = path.resolve(__dirname, '..', '..', 'src') + path.sep;
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
    const m = origLoad.apply(this, arguments);
    if (request === 'electron' && parent && parent.filename && parent.filename.startsWith(srcDir)) {
        return new Proxy(m, { get(t, p) { return p === 'BrowserWindow' ? PatchedBrowserWindow : t[p]; } });
    }
    return m;
};

const report = { lib, userData, out, scenario: scenarioPath, startedAt: new Date().toISOString(), steps: [], console: [], mainErrors: [], rendererCrashes: [] };
const t0 = Date.now();
const log = (...a) => { const line = a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' '); report.steps.push({ t: Date.now() - t0, line }); console.log('[e2e]', line); };
process.on('uncaughtException', e => { report.mainErrors.push(String(e && e.stack || e)); console.error('[harness] uncaught', e); });
process.on('unhandledRejection', e => { report.mainErrors.push('unhandledRejection: ' + String(e && e.stack || e)); });

const flush = () => { try { fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); } catch (e) {} };

app.on('browser-window-created', (_e, win) => {
    const wc = win.webContents;
    wc.on('console-message', (...args) => {
        // Electron ≥ 35 passes an event object with {level, message, lineNumber, sourceId}
        const ev = args[0] || {};
        const level = ev.level ?? args[1];
        const message = ev.message ?? args[2];
        report.console.push({ t: Date.now() - t0, level, message: String(message).slice(0, 2000) });
    });
    wc.on('render-process-gone', (_ev, details) => { report.rendererCrashes.push(details); log('RENDERER GONE', details); });
    wc.once('did-finish-load', () => runScenario(win).catch(e => { log('SCENARIO ERROR', String(e && e.stack || e)); finish(1); }));
});

let finished = false;
function finish(code) {
    if (finished) return; finished = true;
    report.durationMs = Date.now() - t0;
    report.exitCode = code;
    flush();
    // Quit like a user would (before-quit stops the engine workers cleanly);
    // app.exit() mid-flight can crash native teardown and scramble the code.
    process.exitCode = code;
    setTimeout(() => app.quit(), 200);
    setTimeout(() => app.exit(code), 15000);
}
setTimeout(() => { log('GLOBAL TIMEOUT'); finish(3); }, timeoutS * 1000);

async function runScenario(win) {
    const wc = win.webContents;
    const serialize = (fn, args) => typeof fn === 'function'
        ? `(${fn.toString()})(...${JSON.stringify(args || [])})`
        : String(fn);
    const ctx = {
        win, wc, lib, out, userData, log, report,
        consoleLog: report.console,
        main: {
            get engine() { return require(path.join(srcDir, 'semantic-engine')); },
        },
        wait: ms => new Promise(r => setTimeout(r, ms)),
        async exec(fn, ...args) {
            return wc.executeJavaScript(`(async () => { return await ${serialize(fn, args)}; })()`, true);
        },
        async waitFor(fn, ms = 30000, label = '') {
            const start = Date.now();
            while (Date.now() - start < ms) {
                try { const v = await ctx.exec(fn); if (v) return v; } catch (e) { /* keep polling */ }
                await ctx.wait(150);
            }
            throw new Error('waitFor timeout: ' + (label || fn.toString().slice(0, 120)));
        },
        async shot(name) {
            const img = await wc.capturePage();
            const file = path.join(out, name.endsWith('.png') ? name : name + '.png');
            fs.writeFileSync(file, img.toPNG());
            log('shot', path.basename(file), JSON.stringify(img.getSize()));
            return file;
        },
    };
    const scenario = require(scenarioPath);
    log('scenario start', path.basename(scenarioPath));
    await scenario(ctx);
    log('scenario done');
    finish(0);
}

// Boot the real app last, after all hooks are in place.
require(path.join(srcDir, 'main.js'));
