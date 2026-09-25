'use strict';

/**
 * Post-build validator for the unpacked app (produced by `npm run pack` /
 * `npm run dist`). Structure only: the packaged smoke run is separate.
 *   node scripts/verify-dist.js [dist/win-unpacked]
 * Exits non-zero on any failure.
 */

const fs = require('fs');
const path = require('path');
const asar = require('@electron/asar');

const DIST = path.resolve(process.argv[2] || path.join(__dirname, '..', 'dist', 'win-unpacked'));
const RES = path.join(DIST, 'resources');
const UNPACKED = path.join(RES, 'app.asar.unpacked', 'node_modules');
const ASAR = path.join(RES, 'app.asar');
const ORT = path.join(UNPACKED, 'onnxruntime-node', 'bin', 'napi-v3', 'win32', 'x64');

let failures = 0;
const ok = (cond, msg) => {
    if (cond) console.log(`  OK  ${msg}`);
    else { failures++; console.error(`FAIL  ${msg}`); }
};
const exists = p => fs.existsSync(p);
const mb = p => (exists(p) ? fs.statSync(p).size / 1048576 : 0);

console.log(`== SoundVault dist verification: ${DIST} ==`);
ok(exists(path.join(DIST, 'soundvault.exe')), 'soundvault.exe present');
ok(mb(path.join(DIST, 'soundvault.exe')) > 50, 'soundvault.exe is a full Electron runtime');
ok(exists(ASAR), 'app.asar present');

const files = exists(ASAR) ? asar.listPackage(ASAR).map(f => f.replace(/\\/g, '/')) : [];
const has = p => files.includes(p);
const any = re => files.some(f => re.test(f));

// ── app code ─────────────────────────────────────────────────────────────
for (const f of ['/package.json', '/src/main.js', '/src/preload.js', '/src/renderer/index.html', '/src/renderer/js/main.js',
    '/src/engine/engine-host.js', '/src/engine/semantic-engine.js', '/src/engine/index-worker.js', '/src/engine/echo.js',
    '/src/engine/echo-migrate.js', '/src/engine/echo-core.js', '/src/engine/vector-store.js',
    '/src/engine/db.js', '/src/engine/clap-fbank.js', '/src/audio/peaks-worker.js', '/src/audio/decode.js', '/src/audio/wav.js',
    '/src/spectral-engine.js', '/src/search/lexical-search.js', '/src/search/translate.js', '/src/packaging/ffmpeg-path.js']) {
    ok(has(f), f + ' packed');
}
ok(!any(/^\/src\/(semantic-engine|indexing-worker|echo-worker)\.js$|^\/src\/index\.html$/), 'no pre-2.0 engine or renderer files');

// ── nothing that belongs to the repo only ──────────────────────────────────
for (const dir of ['tests', 'docs', 'scripts', 'reaper-scripts', 'packaging', 'web', 'build-assets', '.claude']) ok(!any(new RegExp('^/' + dir + '/')), dir + '/ not packed');
ok(!any(/^\/[^/]+\.md$/), 'no root *.md');
ok(!any(/transformers\/\.cache\//), 'transformers dev model cache not packed');
ok(!any(/transformers\/dist\//), 'transformers wasm/browser builds not packed');
ok(!any(/^\/node_modules\/electron\//), 'electron runtime not packed');
ok(!any(/^\/node_modules\/(bare-|prebuild-install|onnx-proto|protobufjs|fluent-ffmpeg)/), 'install-time/unused dependencies not packed');
ok(mb(ASAR) < 5, `app.asar is small (${mb(ASAR).toFixed(1)} MB)`);

// ── stubs (transformers imports these at load; the real ones are ~50 MB) ────
ok(has('/node_modules/sharp/index.js') && !any(/^\/node_modules\/sharp\/(lib|build|vendor)\//), 'sharp is the stub');
ok(has('/node_modules/onnxruntime-web/index.js') && !any(/^\/node_modules\/onnxruntime-web\/(dist|lib)\//), 'onnxruntime-web is the stub');
ok(!exists(path.join(UNPACKED, 'sharp')), 'no unpacked sharp natives');

// ── natives unpacked ───────────────────────────────────────────────────────
ok(exists(path.join(UNPACKED, 'ffmpeg-static', 'ffmpeg.exe')), 'ffmpeg.exe unpacked (spawn-safe)');
ok(exists(path.join(UNPACKED, 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node')), 'better_sqlite3.node unpacked');
ok(exists(path.join(UNPACKED, 'hnswlib-node', 'build', 'Release', 'addon.node')), 'hnswlib addon unpacked');
for (const f of ['onnxruntime_binding.node', 'onnxruntime.dll', 'msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll']) ok(exists(path.join(ORT, f)), f + ' beside the ONNX binding');
ok(!exists(path.join(UNPACKED, 'onnxruntime-node', 'bin', 'napi-v3', 'darwin')) && !exists(path.join(UNPACKED, 'onnxruntime-node', 'bin', 'napi-v3', 'linux')), 'non-Windows ONNX binaries pruned');

// ── bundled models (offline) ───────────────────────────────────────────────
const MODEL = path.join(RES, 'models', 'Xenova', 'clap-htsat-unfused');
for (const f of ['config.json', 'preprocessor_config.json', 'tokenizer.json', 'tokenizer_config.json']) ok(exists(path.join(MODEL, f)), 'model ' + f);
ok(mb(path.join(MODEL, 'onnx', 'audio_model.onnx')) > 100, 'audio model bundled');
const text = mb(path.join(MODEL, 'onnx', 'text_model.onnx'));
ok(text > 200 && text < 300, `text model bundled as float16 (${text.toFixed(0)} MB)`);

// ── locales trimmed ────────────────────────────────────────────────────────
const locales = exists(path.join(DIST, 'locales')) ? fs.readdirSync(path.join(DIST, 'locales')) : [];
ok(locales.length > 0 && locales.length <= 4, `locales trimmed (${locales.join(', ')})`);

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
