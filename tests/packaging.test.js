'use strict';

/**
 * Packaging & distribution regression suite (source/config level, no Electron runtime).
 *
 *   - ffmpeg-static paths are rewritten app.asar → app.asar.unpacked wherever
 *     ffmpeg is resolved (spawn cannot execute from inside an asar archive)
 *   - packaged builds read the bundled CLAP models offline, in the engine host
 *     AND the indexing worker (each has its own transformers instance)
 *   - the AI stack is loaded lazily: a broken ONNX runtime never stops the
 *     library browser from starting
 *   - drag-and-drop import uses webUtils.getPathForFile (File.path is gone)
 *   - electron-builder config: dead weight excluded, sharp/onnxruntime-web
 *     replaced by stubs (transformers imports them at load), native modules
 *     unpacked, models shipped as extraResources, productName unchanged
 *   - icon: multi-size ICO, largest frame first
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const walkJs = dir => {
    const out = [];
    (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith('.js')) out.push(p); } })(path.join(ROOT, dir));
    return out;
};

// ── ffmpeg path ────────────────────────────────────────────────────────────
test('resolveFfmpegPath: rewrites app.asar → app.asar.unpacked (both separators), no-op in dev', () => {
    const { resolveFfmpegPath } = require('../src/packaging/ffmpeg-path');
    assert.equal(resolveFfmpegPath('C:\\App\\resources\\app.asar\\node_modules\\ffmpeg-static\\ffmpeg.exe'),
        'C:\\App\\resources\\app.asar.unpacked\\node_modules\\ffmpeg-static\\ffmpeg.exe');
    assert.equal(resolveFfmpegPath('/opt/app/resources/app.asar/bin/ffmpeg'), '/opt/app/resources/app.asar.unpacked/bin/ffmpeg');
    assert.equal(resolveFfmpegPath('C:\\repo\\node_modules\\ffmpeg-static\\ffmpeg.exe'), 'C:\\repo\\node_modules\\ffmpeg-static\\ffmpeg.exe');
    assert.equal(resolveFfmpegPath(null), null);
    assert.equal(resolveFfmpegPath(''), '');
});

test('every file that requires ffmpeg-static resolves it through resolveFfmpegPath', () => {
    for (const f of walkJs('src')) {
        const src = fs.readFileSync(f, 'utf8');
        if (!/require\(['"]ffmpeg-static['"]\)/.test(src)) continue;
        assert.match(src, /resolveFfmpegPath\(/, path.relative(ROOT, f) + ' spawns ffmpeg without the asar rewrite');
    }
    // workers get the resolved path from their parent instead of requiring it
    assert.doesNotMatch(read('src/engine/index-worker.js'), /require\(['"]ffmpeg-static['"]\)/);
    assert.doesNotMatch(read('src/audio/peaks-worker.js'), /require\(['"]ffmpeg-static['"]\)/);
});

// ── models & lazy AI stack ─────────────────────────────────────────────────
test('packaged builds read the bundled models offline in the host and the indexing worker', () => {
    const host = read('src/engine/semantic-engine.js');
    assert.match(host, /resourcesPath, 'models'\)/);
    assert.match(host, /allowRemoteModels = false/);
    const worker = read('src/engine/index-worker.js');
    assert.match(worker, /env\.cacheDir = cacheDir/);
    assert.match(worker, /allowRemoteModels = false/);
});

test('the AI stack is required lazily (never at the top of main or the engine modules)', () => {
    for (const f of ['src/main.js', 'src/engine/engine-host.js', 'src/engine/semantic-engine.js', 'src/engine/echo.js']) {
        const top = read(f).split('\n').filter(l => /^\s*(const|let|var|import)\b.*require\(['"]@xenova\/transformers['"]\)/.test(l) && !/^\s{8,}/.test(l));
        assert.equal(top.length, 0, f + ' loads transformers at module load');
    }
});

// ── drag & drop ────────────────────────────────────────────────────────────
test('dropped files are resolved with webUtils.getPathForFile, never bare File.path', () => {
    assert.match(read('src/preload.js'), /webUtils[\s\S]*getPathForFile/);
    const src = walkJs('src/renderer/js').map(f => fs.readFileSync(f, 'utf8')).join('\n');
    assert.match(src, /sv\.pathForFile\(/);
    assert.doesNotMatch(src, /\.files\)[^;]*\.map\(\s*f\s*=>\s*f\.path\s*\)/);
});

// ── electron-builder config ────────────────────────────────────────────────
const pkg = JSON.parse(read('package.json'));
const b = pkg.build;

test('identity: appId, productName (userData dir + REAPER script depend on it), electron as devDependency', () => {
    assert.equal(b.appId, 'com.soundvault.app');
    assert.equal(b.productName, 'soundvault');
    assert.ok(pkg.devDependencies && pkg.devDependencies.electron);
    assert.ok(!pkg.dependencies || !pkg.dependencies.electron);
});

test('files: dead weight excluded; stubs for sharp and onnxruntime-web come LAST', () => {
    const f = b.files;
    const strings = f.filter(x => typeof x === 'string');
    const sets = f.filter(x => typeof x === 'object');
    assert.equal(f[0], '**/*');
    for (const must of ['!node_modules/sharp/**', '!node_modules/onnxruntime-web/**', '!node_modules/@xenova/transformers/{.cache,dist,types}/**', '!node_modules/electron/**']) {
        assert.ok(strings.includes(must), 'missing exclusion ' + must);
    }
    assert.ok(strings.some(s => s.startsWith('!{tests,docs,scripts') && s.includes('packaging') && s.includes('web')), 'repo-only folders excluded');
    // A FileSet before string patterns makes electron-builder reorder them ahead of "**/*" (exclusions silently stop working).
    const firstSet = f.findIndex(x => typeof x === 'object');
    assert.ok(firstSet > 0 && f.slice(firstSet).every(x => typeof x === 'object'), 'FileSets must be at the end');
    const targets = sets.map(s => s.to);
    assert.deepEqual(targets.sort(), ['node_modules/onnxruntime-web', 'node_modules/sharp']);
    for (const s of sets) assert.ok(fs.existsSync(path.join(ROOT, s.from, 'index.js')), 'stub missing: ' + s.from);
});

test('stubs keep transformers importable (sharp truthy, onnxruntime-web object)', () => {
    const sharp = require(path.join(ROOT, 'packaging', 'stubs', 'sharp'));
    assert.equal(typeof sharp, 'function');
    assert.throws(() => sharp(), /not bundled/);
    assert.deepEqual(require(path.join(ROOT, 'packaging', 'stubs', 'onnxruntime-web')), {});
});

test('native modules and ffmpeg are unpacked; models ship as extraResources', () => {
    const u = b.asarUnpack.join('\n');
    for (const m of ['ffmpeg-static/ffmpeg.exe', 'better_sqlite3.node', 'onnxruntime-node', 'hnswlib-node']) assert.ok(u.includes(m), 'asarUnpack lacks ' + m);
    assert.ok(!u.includes('sharp'), 'sharp is a stub now');
    assert.ok(JSON.stringify(b.extraResources).includes('build-assets/models'));
});

test('Windows targets: installer + zip (no self-extracting portable), uninstall keeps user data', () => {
    const targets = b.win.target.map(t => (typeof t === 'string' ? t : t.target));
    assert.ok(targets.includes('nsis') && targets.includes('zip'));
    assert.ok(!targets.includes('portable'), 'the portable exe re-extracted ~1 GB to %TEMP% on every launch');
    assert.notEqual(b.nsis.deleteAppDataOnUninstall, true, 'would wipe vaults and collections');
});

// ── icon ───────────────────────────────────────────────────────────────────
test('build/icon.ico is a multi-size ICO with the 256 px frame first', () => {
    const ico = path.join(ROOT, 'build', 'icon.ico');
    assert.ok(fs.existsSync(ico), 'run: npm run icon');
    const buf = fs.readFileSync(ico);
    assert.equal(buf.readUInt16LE(0), 0);
    assert.equal(buf.readUInt16LE(2), 1);
    const n = buf.readUInt16LE(4);
    assert.ok(n >= 6, `only ${n} frames`);
    assert.equal(buf.readUInt8(6), 0, 'first frame 256 px (width byte 0)');
    const sizes = Array.from({ length: n }, (_, i) => buf.readUInt8(6 + i * 16) || 256);
    for (const s of [16, 24, 32, 48, 256]) assert.ok(sizes.includes(s), 'missing ' + s + ' px frame');
});

test('VC++ CRT DLLs staged beside onnxruntime.dll (fresh PCs without the redistributable)', { skip: !fs.existsSync(path.join(ROOT, 'node_modules', 'onnxruntime-node')) }, () => {
    const dir = path.join(ROOT, 'node_modules', 'onnxruntime-node', 'bin', 'napi-v3', 'win32', 'x64');
    for (const dll of ['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll']) {
        assert.ok(fs.existsSync(path.join(dir, dll)), `missing ${dll} (run: node scripts/stage-crt-dlls.js)`);
    }
});
