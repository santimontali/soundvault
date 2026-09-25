'use strict';
// Run a script under Electron's Node (ELECTRON_RUN_AS_NODE=1), so native modules
// built for Electron's ABI (better-sqlite3) load. Cross-platform for npm scripts.
//   node scripts/run-electron-node.js <script.js> [args...]
const { spawnSync } = require('child_process');
const electron = require('electron');           // path to the binary when required from Node
const r = spawnSync(electron, process.argv.slice(2), { stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
process.exit(r.status == null ? 1 : r.status);
