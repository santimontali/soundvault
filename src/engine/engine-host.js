'use strict';
/**
 * Engine host: runs the SemanticEngine (CLAP text search, vector index,
 * indexing queue) and the EchoIndex away from the Electron main process, so
 * it never blocks on models, inference, SQLite or matching. Normally an
 * Electron utility process (see engine-client.js for why not a worker
 * thread); a worker thread under plain Node (tests).
 *
 * RPC over the parent port:
 *   → { id, method, args }        ← { id, result } | { id, error }
 *   ← { event: 'status', data }   pushed on every state change (throttled)
 */
const wt = require('worker_threads');
const path = require('path');
const { SemanticEngine } = require('./semantic-engine');
const { EchoIndex } = require('./echo');
const { SpectralFingerprinter, buildFeatureWeights } = require('../spectral-engine');

const utility = !!process.parentPort;
const port = utility ? process.parentPort : wt.parentPort;
const wd = utility ? JSON.parse(process.env.SV_ENGINE_CONFIG || '{}') : (wt.workerData || {});
const reply = msg => port.postMessage(msg);
console.log(`[EngineHost] running in ${utility ? 'a utility process' : 'a worker thread'} (pid ${process.pid})`);
const echo = new EchoIndex({
    dbPath: path.join(wd.userDataPath, 'soundvault-semantic.db'),
    fingerprinter: new SpectralFingerprinter(),
    buildWeights: buildFeatureWeights,
});
const engine = new SemanticEngine({
    userDataPath: wd.userDataPath,
    isPackaged: !!wd.isPackaged,
    resourcesPath: wd.resourcesPath,
    ffmpegPath: wd.ffmpegPath,
    hnswMin: wd.hnswMin,
    echo,
    imageModelDir: wd.isPackaged && wd.resourcesPath ? path.join(wd.resourcesPath, 'models', 'siglip2') : path.join(__dirname, '..', '..', 'build-assets', 'models', 'siglip2'),
});
engine.on('status', s => reply({ event: 'status', data: s }));

/** Compact file list from main ({paths, mtimes, sizes}) → objects. */
function expandFiles(f) {
    if (Array.isArray(f)) return f;
    if (!f || !Array.isArray(f.paths)) return [];
    const out = new Array(f.paths.length);
    for (let i = 0; i < f.paths.length; i++) out[i] = { path: f.paths[i], mtime: f.mtimes ? f.mtimes[i] : 0, size: f.sizes ? f.sizes[i] : 0 };
    return out;
}

const methods = {
    async init(root) {
        if (root) await engine.setRoot(root);
        await engine.init();
        return engine.status();
    },
    status: () => engine.status(),
    setRoot: root => engine.setRoot(root),
    index: (files, opts) => engine.index(expandFiles(files), opts || {}),
    cancelIndex: () => engine.cancelIndex(),
    search: (q, opts) => engine.search(q, opts || {}),
    score: (q, paths, opts) => engine.score(q, paths, opts || {}),
    suggest: (paths, k) => engine.suggest(paths, k),
    brief: o => engine.brief(o || {}),
    imageConcepts: pixels => engine.imageConcepts(pixels),
    echo: params => engine.echoQuery(params || {}),
    echoFile: (p, opts) => engine.echoFile(p, opts || {}),
    filesChanged: ch => engine.filesChanged(ch || {}),
    pathsMoved: moves => engine.pathsMoved(moves || []),
    failures: () => engine.failuresList(),
    async shutdown() {
        await engine.close();
        setTimeout(() => process.exit(0), 20);
        return true;
    },
};

port.on('message', async ev => {
    const msg = utility ? ev.data : ev;
    if (!msg || typeof msg.method !== 'string') return;
    const fn = methods[msg.method];
    if (!fn) { reply({ id: msg.id, error: 'Unknown method ' + msg.method }); return; }
    try {
        const result = await fn(...(msg.args || []));
        if (msg.id != null) reply({ id: msg.id, result });
    } catch (e) {
        console.error(`[EngineHost] ${msg.method} failed:`, e);
        if (msg.id != null) reply({ id: msg.id, error: String((e && e.message) || e) });
    }
});
