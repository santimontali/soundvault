'use strict';

/**
 * Stages the VC++ 2015-2022 x64 redistributable DLLs beside onnxruntime.dll.
 *
 * Audit finding C1: onnxruntime-node's native binaries import
 * msvcp140.dll / vcruntime140.dll / vcruntime140_1.dll, which a CLEAN Windows
 * install does NOT have (Electron/Chromium links the CRT statically, so the
 * packaged app provides nothing). Without these, `require('onnxruntime-node')`
 * throws at module load — which kills the WHOLE app at startup, not just the
 * AI features (the require chain is top-level).
 *
 * Node loads .node addons with LOAD_WITH_ALTERED_SEARCH_PATH, so DLLs placed
 * beside the binding are found without touching the system PATH. These three
 * DLLs are redistributable per the VS redist license.
 *
 * Idempotent. Run automatically via npm `predist`/`prepack` scripts, or
 * manually: node scripts/stage-crt-dlls.js
 */

const fs = require('fs');
const path = require('path');

const DLLS = ['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll'];
const TARGET = path.join(__dirname, '..', 'node_modules', 'onnxruntime-node', 'bin', 'napi-v3', 'win32', 'x64');
const SYSTEM32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');

let missing = [];
for (const dll of DLLS) {
    const dest = path.join(TARGET, dll);
    if (fs.existsSync(dest)) { console.log(`  ok   ${dll} already staged`); continue; }
    const src = path.join(SYSTEM32, dll);
    if (!fs.existsSync(src)) { missing.push(dll); continue; }
    fs.copyFileSync(src, dest);
    console.log(`  copy ${dll}  ${src} -> ${dest}`);
}

if (missing.length) {
    console.warn(`\nWARNING: could not find ${missing.join(', ')} in ${SYSTEM32}.`);
    console.warn('The packaged app will crash on PCs without the VC++ 2015-2022 x64 redistributable.');
    console.warn('Install "vc_redist.x64.exe" on THIS build machine and re-run, or copy the DLLs manually into:');
    console.warn(`  ${TARGET}`);
    process.exitCode = 1;
} else {
    console.log('CRT staging complete.');
}
