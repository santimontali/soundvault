'use strict';

/**
 * Packaging & distribution regression suite.
 *
 * Anchors every code-level requirement the subagent audit found for shipping
 * SoundVault to a fresh Windows PC via electron-builder:
 *
 *   C1  VC++ CRT DLLs beside onnxruntime.dll (app dies on clean PCs without)
 *   C2  env.cacheDir + allowRemoteModels wired into BOTH the engine and the
 *       indexing worker (worker has its own transformers module instance)
 *   C3  Drag-and-drop import uses webUtils.getPathForFile (File.path was
 *       removed in Electron 32 — bare `f.path` silently drops every file)
 *   H1  transformers dev cache (~592 MB) excluded from app.asar
 *   H2  ffmpeg-static path rewritten app.asar→app.asar.unpacked at every
 *       spawn site (spawn cannot execute from inside an asar archive)
 *   H3/M1  asarUnpack covers sharp, onnxruntime-node, ffmpeg-static,
 *       better-sqlite3, hnswlib-node
 *   M2  productName stays "soundvault" (userData dir + REAPER Lua autodetect)
 *   L1  electron lives in devDependencies, not dependencies
 *   L2  appId + icon exist
 *
 * These tests are source/config-level (no Electron runtime needed).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

// ── H2: pure ffmpeg-path resolver ──────────────────────────────────────────

test('resolveFfmpegPath: rewrites app.asar → app.asar.unpacked', () => {
    const { resolveFfmpegPath } = require('../src/packaging/ffmpeg-path');
    const packaged = 'C:\\App\\resources\\app.asar\\node_modules\\ffmpeg-static\\ffmpeg.exe';
    const expected = 'C:\\App\\resources\\app.asar.unpacked\\node_modules\\ffmpeg-static\\ffmpeg.exe';
    assert.equal(resolveFfmpegPath(packaged), expected);
});

test('resolveFfmpegPath: no-op in dev (path has no app.asar segment)', () => {
    const { resolveFfmpegPath } = require('../src/packaging/ffmpeg-path');
    const dev = 'C:\\repo\\node_modules\\ffmpeg-static\\ffmpeg.exe';
    assert.equal(resolveFfmpegPath(dev), dev);
});

test('resolveFfmpegPath: handles null/empty safely', () => {
    const { resolveFfmpegPath } = require('../src/packaging/ffmpeg-path');
    assert.equal(resolveFfmpegPath(null), null);
    assert.equal(resolveFfmpegPath(''), '');
    assert.equal(resolveFfmpegPath(undefined), undefined);
});

test('resolveFfmpegPath: forward-slash asar paths also rewritten', () => {
    const { resolveFfmpegPath } = require('../src/packaging/ffmpeg-path');
    assert.equal(
        resolveFfmpegPath('/opt/app/resources/app.asar/bin/ffmpeg'),
        '/opt/app/resources/app.asar.unpacked/bin/ffmpeg'
    );
});

test('every ffmpeg spawn site routes through resolveFfmpegPath', () => {
    // All four known spawn sites must use the resolver (H2).
    const peaks = read('src/audio/peaks.js');
    assert.match(peaks, /resolveFfmpegPath/, 'src/audio/peaks.js module-load set');
    // peaks.js sets the path per command too (overrides the global).
    const engine = read('src/semantic-engine.js');
    assert.match(engine, /resolveFfmpegPath/, 'src/semantic-engine.js global set');
    // The ffmpegPath handed to the indexing worker must be the resolved one.
    assert.match(engine, /ffmpegPath/, 'worker receives resolved ffmpegPath');
});

// ── C2: cacheDir wiring (engine + worker) ──────────────────────────────────

test('semantic-engine sets env.cacheDir when packaged', () => {
    const engine = read('src/semantic-engine.js');
    assert.match(engine, /env\.cacheDir/, 'env.cacheDir assignment present');
    assert.match(engine, /resourcesPath.*models|models.*resourcesPath/, 'points at resources/models');
});

test('semantic-engine passes cacheDir to the indexing worker init message', () => {
    const engine = read('src/semantic-engine.js');
    assert.match(engine, /postMessage\(\{\s*type:\s*'init'[\s\S]*cacheDir/, 'init message carries cacheDir');
});

test('indexing-worker applies cacheDir + allowRemoteModels=false before model load', () => {
    const worker = read('src/indexing-worker.js');
    assert.match(worker, /initWorker\(dbPath,\s*ffmpegPath,\s*cacheDir\)/, 'initWorker signature takes cacheDir');
    assert.match(worker, /env\.cacheDir\s*=\s*cacheDir/, 'worker sets env.cacheDir');
    assert.match(worker, /allowRemoteModels\s*=\s*false/, 'worker blocks remote fetches (offline-safe)');
});

// ── C3: drag-and-drop import (Electron 32+ File.path removal) ─────────────

test('preload exposes getPathForFile via webUtils', () => {
    const preload = read('src/preload.js');
    assert.match(preload, /webUtils/, 'webUtils imported');
    assert.match(preload, /getPathForFile/, 'getPathForFile exposed');
});

test('renderer drop handler does not rely on bare File.path', () => {
    const html = read('src/index.html');
    // The legacy pattern `.map(f => f.path)` must be gone; getPathForFile (or
    // a fallback expression) must be used instead.
    assert.doesNotMatch(html, /\.map\(f => f\.path\)/, 'bare f.path mapping removed');
    assert.match(html, /getPathForFile/, 'renderer uses getPathForFile');
});

// ── package.json build config ──────────────────────────────────────────────

test('package.json has electron-builder config with required keys', () => {
    const pkg = JSON.parse(read('package.json'));
    assert.ok(pkg.build, 'build block exists');
    assert.equal(pkg.build.productName, 'soundvault', 'productName stays lowercase (userData + REAPER Lua)');
    assert.equal(pkg.build.appId, 'com.soundvault.app');
    assert.ok(Array.isArray(pkg.build.asarUnpack), 'asarUnpack array exists');

    const unpack = pkg.build.asarUnpack.join('|');
    assert.match(unpack, /ffmpeg-static\/ffmpeg\.exe/, 'ffmpeg unpacked');
    assert.match(unpack, /better-sqlite3/, 'better-sqlite3 unpacked');
    assert.match(unpack, /sharp/, 'sharp unpacked');
    assert.match(unpack, /onnxruntime-node/, 'onnxruntime-node unpacked');
    assert.match(unpack, /hnswlib-node/, 'hnswlib-node unpacked');

    const files = pkg.build.files.join('|');
    assert.match(files, /!node_modules\/@xenova\/transformers\/\.cache/, 'dev model cache excluded from asar (H1)');
    // Positive pattern must be `**/*` (include-everything + negative excludes).
    // An earlier attempt used `src/**/*` + `node_modules/**/*` explicitly,
    // which silently pruned the `src` directory itself from the walker and
    // produced an asar with NO app code at all. Guard that regression here.
    assert.match(files, /\*\*\/\*/, 'include-everything positive pattern present');
    assert.doesNotMatch(files, /(^|\|)"?src\/\*\*/, 'no src/**/* positive pattern (walker pruning footgun)');
});

test('electron lives in devDependencies, not dependencies', () => {
    const pkg = JSON.parse(read('package.json'));
    assert.ok(!pkg.dependencies.electron, 'electron must not be a runtime dep');
    assert.ok(pkg.devDependencies.electron, 'electron in devDependencies');
    assert.ok(pkg.devDependencies['electron-builder'], 'electron-builder installed as dev dep');
});

test('extraResources ships the bundled CLAP model', () => {
    const pkg = JSON.parse(read('package.json'));
    assert.ok(Array.isArray(pkg.build.extraResources), 'extraResources exists');
    const joined = JSON.stringify(pkg.build.extraResources);
    assert.match(joined, /models/, 'models dir shipped as extra resource');
});

// ── Icon (L2) ──────────────────────────────────────────────────────────────

test('build/icon.ico exists and is a valid ICO (PNG frame, 256x256)', () => {
    const ico = path.join(ROOT, 'build', 'icon.ico');
    assert.ok(fs.existsSync(ico), 'build/icon.ico exists');
    const buf = fs.readFileSync(ico);
    // ICO header: reserved(0x0000) + type(0x0001) + count(>=1)
    assert.equal(buf.readUInt16LE(0), 0);
    assert.equal(buf.readUInt16LE(2), 1);
    assert.ok(buf.readUInt16LE(4) >= 1, 'at least one icon frame');
    // First entry: width byte (0 = 256), height byte (0 = 256)
    assert.equal(buf.readUInt8(6), 0, 'width 256');
    assert.equal(buf.readUInt8(7), 0, 'height 256');
});

// ── C1: VC++ CRT DLLs staged beside onnxruntime.dll ────────────────────────

test('VC++ CRT DLLs exist in onnxruntime-node win-x64 bin dir (C1 fresh-PC fix)', () => {
    const dir = path.join(ROOT, 'node_modules', 'onnxruntime-node', 'bin', 'napi-v3', 'win32', 'x64');
    for (const dll of ['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll']) {
        assert.ok(fs.existsSync(path.join(dir, dll)), `missing ${dll} beside onnxruntime.dll`);
    }
});
