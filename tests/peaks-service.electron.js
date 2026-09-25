// Run: ELECTRON_RUN_AS_NODE=1 electron tests/peaks-service.electron.js <libDir>
const fs = require('fs'), os = require('os'), path = require('path');
const { PeaksService } = require('../src/main/peaks-service');
const { resolveFfmpegPath } = require('../src/packaging/ffmpeg-path');
(async () => {
  const lib = process.argv[2];
  const files = [];
  (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (!['.git','node_modules'].includes(e.name)) walk(p); } else if (/\.wav$/i.test(e.name)) files.push(p); } })(lib);
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sv-pk-')), 'peaks.db');
  const svc = new PeaksService({ dbPath, ffmpegPath: resolveFfmpegPath(require('ffmpeg-static')) });
  const items = files.map(p => { const st = fs.statSync(p); return { path: p, mtime: st.mtimeMs, size: st.size }; });
  let t0 = Date.now();
  const r1 = await svc.get(items);
  const cold = Date.now() - t0;
  t0 = Date.now();
  const r2 = await svc.get(items);
  const warm = Date.now() - t0;
  const ok = Object.values(r1).filter(Boolean).length, nulls = Object.entries(r1).filter(([, v]) => !v).map(([k]) => path.relative(lib, k));
  console.log(JSON.stringify({ files: files.length, ok, nulls, coldMs: cold, warmMs: warm, sameAsCache: ok === Object.values(r2).filter(Boolean).length }, null, 1));
  const long = Object.entries(r1).filter(([k]) => /180s/.test(k))[0];
  if (long) console.log('180s file:', long[1] && { duration: long[1].duration, sr: long[1].sampleRate, ch: long[1].channels, bits: long[1].bits, peaksLen: long[1].peaks.length });
  const tiny = Object.entries(r1).filter(([k]) => /005ms/.test(k))[0];
  if (tiny) console.log('5ms file:', tiny[1] && { duration: tiny[1].duration, nonZero: [...tiny[1].peaks].filter(v => v > 0).length });
  await svc.stop();
})().catch(e => { console.error(e); process.exit(1); });
