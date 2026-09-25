'use strict';
/**
 * Indexing benchmark: per-stage timing of the real indexing pipeline
 * (src/engine/index-worker.js) on a sample of WAV files. Read-only.
 *
 *   node scripts/run-electron-node.js scripts/bench-indexing.js <folder> [sampleSize]
 */
const fs = require('fs');
const path = require('path');
const W = require('../src/engine/index-worker.js')._bench;
const { resolveFfmpegPath } = require('../src/packaging/ffmpeg-path');

const root = process.argv[2];
const N = +(process.argv[3] || 100);
if (!root || !fs.existsSync(root)) { console.error('usage: bench-indexing.js <folder> [sampleSize]'); process.exit(1); }

(async () => {
    const all = [];
    (function rec(d) {
        let l; try { l = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
        for (const e of l) { const p = path.join(d, e.name); if (e.isDirectory()) rec(p); else if (/\.wav$/i.test(e.name)) all.push(p); }
    })(root);
    let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const pick = [], used = new Set();
    while (pick.length < Math.min(N, all.length)) { const i = Math.floor(rnd() * all.length); if (!used.has(i)) { used.add(i); pick.push(all[i]); } }
    console.log(`${all.length} WAV files under ${root}; timing ${pick.length}`);
    await W.init({ ffmpegPath: resolveFfmpegPath(require('ffmpeg-static')), cacheDir: null });
    const t = { decode: 0, clap: 0, spectral: 0, deep: 0 };
    let n = 0, longN = 0, failed = 0;
    const t0 = Date.now();
    for (const p of pick) {
        const st = fs.statSync(p);
        const job = { path: p, mtime: st.mtimeMs, size: st.size, kind: 'a', clap: true, spectral: true, token: 1 };
        let a = Date.now(); const pr = await W.prepare(job); t.decode += Date.now() - a;
        if (pr.error) { failed++; continue; }
        a = Date.now(); await W.embed(pr.samples.subarray(0, 480000)); t.clap += Date.now() - a;
        a = Date.now(); W.fingerprintOf(pr.samples); t.spectral += Date.now() - a;
        if (pr.duration > 10.5) {
            longN++;
            a = Date.now(); await W.compute(await W.prepare({ path: p, mtime: st.mtimeMs, size: st.size, kind: 'b', token: 1 })); t.deep += Date.now() - a;
        }
        n++;
    }
    const wall = Date.now() - t0;
    console.log(JSON.stringify({
        files: n, failed, longFiles: longN, perFileMs: Math.round(wall / Math.max(1, n)), filesPerMinute: Math.round(n / wall * 60000),
        msPerFile: { decode: +(t.decode / n).toFixed(1), clap: +(t.clap / n).toFixed(1), spectral: +(t.spectral / n).toFixed(1) },
        deepPassPerLongFileMs: longN ? Math.round(t.deep / longN) : 0,
    }, null, 1));
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
