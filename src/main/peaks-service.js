'use strict';
/** Main-process client for the peaks worker (lazy start, auto-restart). */
const path = require('path');
const { Worker } = require('worker_threads');

class PeaksService {
    constructor({ dbPath, ffmpegPath }) {
        this.dbPath = dbPath;
        this.ffmpegPath = ffmpegPath;
        this._w = null;
        this._ready = null;
        this._seq = 0;
        this._waiters = new Map();
    }

    _start() {
        if (this._ready) return this._ready;
        const w = new Worker(path.join(__dirname, '..', 'audio', 'peaks-worker.js'));
        this._w = w;
        this._ready = new Promise((resolve, reject) => {
            const onMsg = m => {
                if (m.type === 'ready') resolve(w);
                else if (m.type === 'result') {
                    const res = this._waiters.get(m.id);
                    if (res) { this._waiters.delete(m.id); res(m.results || {}); }
                }
            };
            w.on('message', onMsg);
            w.on('error', e => { console.error('[Peaks] worker error:', e.message); reject(e); });
            w.on('exit', code => {
                // Resolve outstanding requests empty and allow a lazy restart
                for (const res of this._waiters.values()) res({});
                this._waiters.clear();
                this._w = null; this._ready = null;
                if (code !== 0) console.warn('[Peaks] worker exited with code', code);
            });
            w.postMessage({ type: 'init', dbPath: this.dbPath, ffmpegPath: this.ffmpegPath });
        });
        return this._ready;
    }

    /** @param {Array<{path:string,mtime?:number,size?:number}>} items */
    async get(items) {
        if (!items || !items.length) return {};
        const w = await this._start();
        const id = ++this._seq;
        return new Promise(resolve => {
            this._waiters.set(id, resolve);
            w.postMessage({ type: 'get', id, items });
        });
    }

    forget(paths) { if (this._w && paths && paths.length) this._w.postMessage({ type: 'forget', paths }); }

    async stop() {
        if (!this._w) return;
        const w = this._w;
        w.postMessage({ type: 'shutdown' });
        await new Promise(r => { w.once('exit', r); setTimeout(r, 1500); });
    }
}

module.exports = { PeaksService };
