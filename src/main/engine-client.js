'use strict';
/**
 * Engine client: the ONLY way the main process talks to the semantic/Echo
 * engine (src/engine/engine-host.js).
 *
 * The host runs in its own Electron utility process. Not a worker thread:
 * in Electron's worker threads every ArrayBuffer allocation goes through a
 * page allocator (kernel calls), ~10× slower than on a main thread and
 * ~400× once the heap holds a 70k-file library. Loading such a library took
 * minutes in a worker and takes ~2 s on the utility process's main thread.
 * Plain Node (tests) has no utility processes and falls back to a worker.
 *
 * Every call is async and never throws to callers; a crashed host is
 * restarted on the next call and re-initialised with the current library.
 */
const path = require('path');
const { Worker } = require('worker_threads');
const { EventEmitter } = require('events');

let utilityProcess = null;
try { const el = require('electron'); if (el && typeof el === 'object' && el.utilityProcess) utilityProcess = el.utilityProcess; } catch (e) { /* plain Node */ }

const HOST = path.join(__dirname, '..', 'engine', 'engine-host.js');

/** { post, onMessage, onExit, kill } over a utility process or, without Electron, a worker thread. */
function spawnHost(config) {
    if (utilityProcess) {
        const child = utilityProcess.fork(HOST, [], {
            serviceName: 'SoundVault AI engine',
            stdio: 'pipe',
            env: { ...process.env, SV_ENGINE_CONFIG: JSON.stringify(config) },
        });
        // The host's log joins the app's (an inherited handle is lost when stdout is a pipe).
        if (child.stdout) child.stdout.on('data', d => process.stdout.write(d));
        if (child.stderr) child.stderr.on('data', d => process.stderr.write(d));
        return {
            post: msg => child.postMessage(msg),
            onMessage: cb => child.on('message', cb),
            onExit: cb => child.once('exit', cb),
            kill: () => { try { child.kill(); } catch (e) { /* already gone */ } },
        };
    }
    const w = new Worker(HOST, { workerData: config, resourceLimits: { maxOldGenerationSizeMb: 4096 } });
    w.on('error', e => console.error('[EngineClient] host error:', e));
    return {
        post: msg => w.postMessage(msg),
        onMessage: cb => w.on('message', cb),
        onExit: cb => w.once('exit', cb),
        kill: () => w.terminate().catch(() => {}),
    };
}

function createEngine({ userData, isPackaged, resourcesPath, ffmpegPath, hnswMin }) {
    const bus = new EventEmitter();
    let worker = null, seq = 0, root = null, stopping = false, started = false, hostGen = 0;
    const waiters = new Map();
    let last = { ready: false, initializing: false, error: null, indexing: false, progress: null, vectors: 0 };

    function spawn() {
        if (worker) return worker;
        const host = worker = spawnHost({ userDataPath: userData, isPackaged, resourcesPath, ffmpegPath, hnswMin });
        hostGen++;
        host.onMessage(msg => {
            if (!msg) return;
            if (msg.event === 'status') { last = msg.data; bus.emit('status', last); return; }
            const w = waiters.get(msg.id);
            if (!w) return;
            waiters.delete(msg.id);
            if (msg.error) w.reject(new Error(msg.error)); else w.resolve(msg.result);
        });
        host.onExit(code => {
            if (worker === host) worker = null;
            for (const w of waiters.values()) w.reject(new Error('Engine stopped'));
            waiters.clear();
            if (!stopping) {
                console.warn('[EngineClient] engine host exited with code', code);
                last = { ...last, ready: false, indexing: false, initializing: false, error: code ? 'Resonance stopped unexpectedly. It restarts on the next search.' : null };
                bus.emit('status', last);
            }
        });
        return host;
    }

    function send(w, method, args) {
        const id = ++seq;
        return new Promise((resolve, reject) => {
            waiters.set(id, { resolve, reject });
            w.post({ id, method, args });
        });
    }

    function post(method, ...args) {
        const fresh = !worker;
        const w = spawn();
        // A host restarted after a crash comes back with the library it was serving.
        if (fresh && started && method !== 'init') send(w, 'init', [root]).catch(() => {});
        return send(w, method, args);
    }
    const safe = (method, fallback) => async (...args) => {
        try { return await post(method, ...args); }
        catch (e) { console.warn(`[EngineClient] ${method}:`, e.message); return typeof fallback === 'function' ? fallback(e) : fallback; }
    };
    /** Fire-and-forget (only when the host is running; changes before start are re-diffed on index). */
    const tell = (method, ...args) => { if (worker) worker.post({ id: null, method, args }); };

    return {
        onStatus(cb) { bus.on('status', cb); return () => bus.off('status', cb); },
        status: () => last,
        /** Changes whenever a new host starts (its indexing queue starts empty). */
        hostGen: () => hostGen,
        async start(r) { root = r; started = true; return safe('init', () => last)(r); },
        setLibrary(r) { root = r; if (worker) tell('setRoot', r); },
        /** files: {paths, mtimes: Float64Array, sizes: Float64Array} */
        index: safe('index', null),
        cancelIndex: safe('cancelIndex', false),
        search: safe('search', e => ({ results: [], words: [], error: e.message })),
        score: safe('score', []),
        suggest: safe('suggest', []),
        echo: safe('echo', e => ({ results: [], error: e.message })),
        echoFile: safe('echoFile', e => ({ results: [], error: e.message })),
        failures: safe('failures', []),
        filesChanged(ch) { tell('filesChanged', ch); },
        pathsMoved(moves) { tell('pathsMoved', moves); },
        async stop() {
            if (!worker) return;
            stopping = true;
            const w = worker;
            const exited = new Promise(r => w.onExit(r));
            try { await Promise.race([post('shutdown'), new Promise(r => setTimeout(r, 2500))]); } catch (e) { /* exiting */ }
            await Promise.race([exited, new Promise(r => setTimeout(r, 1000))]);
            await w.kill();
        },
    };
}

module.exports = { createEngine };
