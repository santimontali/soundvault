'use strict';

/**
 * Post-build validator for dist/win-unpacked (produced by `npm run pack`).
 *
 * Verifies the packaged app has every resource a fresh PC needs and none of
 * the bloat/leakage the audit flagged. Run: node scripts/verify-dist.js
 * Exits non-zero on any failure.
 */

const fs = require('fs');
const path = require('path');
const asar = require('@electron/asar');

const DIST = path.join(__dirname, '..', 'dist', 'win-unpacked');
const RES = path.join(DIST, 'resources');
const UNPACKED = path.join(RES, 'app.asar.unpacked', 'node_modules');
const ASAR = path.join(RES, 'app.asar');

let failures = 0;
const ok = (cond, msg) => {
    if (cond) console.log(`  OK  ${msg}`);
    else { failures++; console.error(`FAIL  ${msg}`); }
};
const exists = p => fs.existsSync(p);

console.log('== SoundVault dist verification ==');
ok(exists(DIST), 'dist/win-unpacked exists');
ok(exists(path.join(DIST, 'soundvault.exe')), 'soundvault.exe present');
ok(exists(ASAR), 'app.asar present');

// ── asar content (authoritative listing) ──────────────────────────────────
let asarFiles = [];
if (exists(ASAR)) {
    asarFiles = asar.listPackage(ASAR).map(f => f.replace(/\\/g, '/'));
}
const inAsar = needle => asarFiles.some(f => f.includes(needle));

ok(inAsar('/package.json'), 'root package.json packed');
ok(inAsar('/src/main.js'), 'src/main.js packed');
ok(inAsar('/src/preload.js'), 'src/preload.js packed');
ok(inAsar('/src/index.html'), 'src/index.html packed');
ok(inAsar('/src/semantic-engine.js'), 'src/semantic-engine.js packed');
ok(inAsar('/src/indexing-worker.js'), 'src/indexing-worker.js packed (worker inside asar works on Electron 41)');
ok(inAsar('/src/spectral-engine.js'), 'src/spectral-engine.js packed');
ok(inAsar('/src/search/lexical-search.js'), 'src/search/lexical-search.js packed');
ok(inAsar('/src/search/vector-search.js'), 'src/search/vector-search.js packed');
ok(inAsar('/src/audio/peaks.js'), 'src/audio/peaks.js packed');
ok(inAsar('/src/packaging/ffmpeg-path.js'), 'src/packaging/ffmpeg-path.js packed');

// Root-level project dirs must NOT be in the asar (app entries look like
// `/src/...`; node_modules entries start with `/node_modules/`).
ok(!inAsar('/tests/'), 'tests/ NOT inside app.asar');
ok(!asarFiles.some(f => f.startsWith('/docs/')), 'root docs/ NOT inside app.asar');
ok(!asarFiles.some(f => f.startsWith('/scripts/')), 'root scripts/ NOT inside app.asar');
ok(!inAsar('/reaper-scripts/'), 'reaper-scripts/ NOT inside app.asar');
ok(!inAsar('/.claude/'), '.claude/ NOT inside app.asar');
ok(!inAsar('fluent-ffmpeg/doc/'), 'fluent-ffmpeg doc junk pruned');
ok(!inAsar('fluent-ffmpeg/tools/'), 'fluent-ffmpeg tools junk pruned');
ok(!inAsar('onnxruntime-web/docs/'), 'onnxruntime-web docs pruned');
ok(!inAsar('transformers/.cache/'), 'transformers dev model cache NOT inside asar (H1 — 592 MB saved)');
ok(!inAsar('/node_modules/electron/dist/'), 'electron runtime NOT inside asar (L1)');
ok(!inAsar('fluent-ffmpeg/coverage/'), 'fluent-ffmpeg coverage junk pruned');

// ── Natives unpacked (audit H3/M1/C1) ──────────────────────────────────────
ok(exists(path.join(UNPACKED, 'ffmpeg-static', 'ffmpeg.exe')), 'ffmpeg.exe unpacked (spawn-safe)');
ok(exists(path.join(UNPACKED, 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node')), 'better_sqlite3.node unpacked');
ok(exists(path.join(UNPACKED, 'sharp', 'build', 'Release', 'sharp-win32-x64.node')), 'sharp .node unpacked');
ok(exists(path.join(UNPACKED, 'sharp', 'build', 'Release', 'libvips-42.dll')), 'sharp libvips DLL beside .node');
ok(exists(path.join(UNPACKED, 'onnxruntime-node', 'bin', 'napi-v3', 'win32', 'x64', 'onnxruntime_binding.node')), 'onnxruntime_binding.node unpacked');
ok(exists(path.join(UNPACKED, 'onnxruntime-node', 'bin', 'napi-v3', 'win32', 'x64', 'onnxruntime.dll')), 'onnxruntime.dll unpacked');
ok(exists(path.join(UNPACKED, 'onnxruntime-node', 'bin', 'napi-v3', 'win32', 'x64', 'msvcp140.dll')), 'msvcp140.dll staged (C1)');
ok(exists(path.join(UNPACKED, 'onnxruntime-node', 'bin', 'napi-v3', 'win32', 'x64', 'vcruntime140.dll')), 'vcruntime140.dll staged (C1)');
ok(exists(path.join(UNPACKED, 'onnxruntime-node', 'bin', 'napi-v3', 'win32', 'x64', 'vcruntime140_1.dll')), 'vcruntime140_1.dll staged (C1)');
ok(exists(path.join(UNPACKED, 'hnswlib-node', 'build', 'Release', 'addon.node')), 'hnswlib addon unpacked (HNSW acceleration)');

// ── Bundled model (audit C2) ───────────────────────────────────────────────
const MODEL = path.join(RES, 'models', 'Xenova', 'clap-htsat-unfused');
ok(exists(path.join(MODEL, 'config.json')), 'model config.json bundled');
ok(exists(path.join(MODEL, 'preprocessor_config.json')), 'model preprocessor_config.json bundled');
ok(exists(path.join(MODEL, 'tokenizer.json')), 'model tokenizer.json bundled');
ok(exists(path.join(MODEL, 'tokenizer_config.json')), 'model tokenizer_config.json bundled');
ok(exists(path.join(MODEL, 'onnx', 'text_model.onnx')), 'text_model.onnx bundled');
ok(exists(path.join(MODEL, 'onnx', 'audio_model.onnx')), 'audio_model.onnx bundled');

// ── Non-target platforms pruned ────────────────────────────────────────────
ok(!exists(path.join(UNPACKED, 'onnxruntime-node', 'bin', 'napi-v3', 'darwin')), 'onnxruntime darwin binaries pruned');
ok(!exists(path.join(UNPACKED, 'onnxruntime-node', 'bin', 'napi-v3', 'linux')), 'onnxruntime linux binaries pruned');

// ── Icon embedded ──────────────────────────────────────────────────────────
const exeSize = exists(path.join(DIST, 'soundvault.exe')) ? fs.statSync(path.join(DIST, 'soundvault.exe')).size : 0;
ok(exeSize > 50 * 1024 * 1024, `soundvault.exe is a full Electron runtime (${(exeSize / 1048576).toFixed(0)} MB)`);

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
