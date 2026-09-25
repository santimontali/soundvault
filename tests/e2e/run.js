'use strict';
/**
 * End-to-end runner: builds the synthetic fixture library, then runs each
 * scenario in the real app with its own isolated user-data folder (the real
 * %APPDATA%\soundvault is never touched), and cleans up.
 *
 *   node tests/e2e/run.js [scenario ...] [--all] [--keep] [--dir <tmp root>]
 * Default scenarios: smoke, engine.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const electron = require('electron');
const { build } = require('../fixtures/make-library');

const argv = process.argv.slice(2);
const keep = argv.includes('--keep');
const di = argv.indexOf('--dir');
const root = di >= 0 ? argv[di + 1] : fs.mkdtempSync(path.join(os.tmpdir(), 'sv-e2e-'));
const names = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--dir');
const scenarios = names.length ? names : ['smoke', 'engine'];

const all = argv.includes('--all');
const list = all ? fs.readdirSync(path.join(__dirname, 'scenarios')).filter(f => f.endsWith('.js')).map(f => f.slice(0, -3)) : scenarios;
const lib = path.join(root, 'lib');
if (!fs.existsSync(lib)) build(lib, { families: 4 });
const editorLib = path.join(root, 'editor-lib');
let failed = 0;
for (const name of list) {
    const scenario = path.join(__dirname, 'scenarios', name.endsWith('.js') ? name : name + '.js');
    const ud = path.join(root, 'ud-' + path.basename(scenario, '.js'));
    const out = path.join(root, 'out-' + path.basename(scenario, '.js'));
    fs.rmSync(ud, { recursive: true, force: true });
    let useLib = lib;
    if (path.basename(scenario).startsWith('editor-')) {
        // Editor scenarios use their own deterministic fixtures and an isolated
        // config whose renders folder lives next to them (never in Documents).
        useLib = editorLib;
        spawnSync(process.execPath, [path.join(__dirname, '..', 'fixtures', 'make-editor-fixtures.js'), editorLib, '--user-data', ud], { stdio: 'inherit' });
    }
    console.log(`\n▶ ${path.basename(scenario)}`);
    const r = spawnSync(electron, [path.join(__dirname, 'harness.js'), '--lib', useLib, '--user-data', ud, '--scenario', scenario, '--out', out, '--timeout', '900'], { stdio: 'inherit' });
    // The report is authoritative (a crash before it is written still fails).
    let bad = true;
    try {
        const rep = JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8'));
        bad = rep.exitCode !== 0 || !!(rep.failed && rep.failed.length);
    } catch (e) { bad = true; }
    if (!bad && r.status !== 0) console.log(`  (app exited with status ${r.status} after a passing run)`);
    if (bad) { failed++; console.log(`✖ ${path.basename(scenario)} failed`); }
}
if (!keep) fs.rmSync(root, { recursive: true, force: true }); else console.log('kept', root);
console.log(failed ? `\n${failed} scenario(s) failed` : '\nall scenarios passed');
process.exit(failed ? 1 : 0);
