// End-to-end engine test on the synthetic fixture library, isolated userData.
// Run: ELECTRON_RUN_AS_NODE=1 electron tests/engine.electron.js [--hnsw] [--keep]
//   --hnsw  forces the HNSW path (hnswMin = 10) to exercise stable labels + persistence
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const assert = require('assert/strict');
const { build } = require('./fixtures/make-library');
const { createEngine } = require('../src/main/engine-client');
const { resolveFfmpegPath } = require('../src/packaging/ffmpeg-path');
const { decodeWavMono } = require('../src/audio/decode');

const HNSW = process.argv.includes('--hnsw');
const KEEP = process.argv.includes('--keep');
const results = [];
const ok = (name, cond, info = '') => { results.push({ name, ok: !!cond, info }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${info ? ': ' + info : ''}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function walk(dir) {
    const out = [];
    (function rec(d) {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) { if (!['.git', 'node_modules'].includes(e.name.toLowerCase())) rec(p); }
            else if (/\.wav$/i.test(e.name)) { const st = fs.statSync(p); out.push({ path: p, mtime: st.mtimeMs, size: st.size }); }
        }
    })(dir);
    return out;
}
const compact = files => ({ paths: files.map(f => f.path), mtimes: Float64Array.from(files.map(f => f.mtime)), sizes: Float64Array.from(files.map(f => f.size)) });

(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-eng-'));
    const lib = path.join(tmp, 'lib'), ud = path.join(tmp, 'ud');
    fs.mkdirSync(ud);
    const man = build(lib, { families: 4 });
    let files = walk(lib);
    console.log(`fixture: ${files.length} wav files in ${lib}`);
    const mk = () => createEngine({ userData: ud, isPackaged: false, ffmpegPath: resolveFfmpegPath(require('ffmpeg-static')), hnswMin: HNSW ? 10 : undefined });
    let engine = mk();
    let last = null;
    const track = e => e.onStatus(s => { last = s; });
    track(engine);
    const waitIdle = async (label, timeoutMs = 600000) => {
        const t0 = Date.now();
        await sleep(1500);
        while (Date.now() - t0 < timeoutMs) {
            const s = last || {};
            if (s.progress && s.progress.phase === 'done' && !s.indexing) return Date.now() - t0;
            if (!s.progress && !s.indexing) return Date.now() - t0;
            await sleep(500);
        }
        throw new Error('timeout waiting for ' + label);
    };

    // ── start + catalog ────────────────────────────────────────────────
    let t0 = Date.now();
    const st = await engine.start(lib);
    ok('engine starts and loads models', st && st.ready, `${Date.now() - t0} ms`);
    t0 = Date.now();
    const plan = await engine.index(compact(files));
    ok('catalog diff queues every file', plan && plan.queued === files.length, JSON.stringify(plan));
    const ms = await waitIdle('catalog');
    const s1 = last;
    const brokenCount = man.files.filter(f => f.broken && /\.wav$/i.test(f.rel)).length;
    ok('catalog finishes (phase done)', s1.progress && s1.progress.phase === 'done', `${(ms / 1000).toFixed(1)} s for ${files.length} files`);
    ok('vectors for every decodable file', s1.vectors >= files.length - brokenCount, `vectors ${s1.vectors}, failures ${s1.failures}, echo ${s1.echo}`);
    ok('broken files recorded as failures (not retried)', s1.failures >= 3 && s1.failures <= brokenCount, `failures ${s1.failures} of ${brokenCount} broken`);
    const fails = await engine.failures();
    console.log('   failures:', fails.map(f => path.basename(f.path) + ', ' + f.error).join(' | '));

    // ── second catalog is a no-op ─────────────────────────────────────
    const plan2 = await engine.index(compact(files));
    ok('second catalog run does nothing', plan2 && plan2.queued === 0 && plan2.deep === 0, JSON.stringify(plan2));

    // ── text search (English + Spanish) ───────────────────────────────
    const r1 = await engine.search('rain', { topK: 30 });
    const rainTop = r1.results.slice(0, 5).map(r => path.relative(lib, r.path));
    ok('AI search "rain" returns rain first', rainTop.some(p => /Rain|dur_(1s|3s|9s|12s|31s|75s|180s)/.test(p)), rainTop.join(', '));
    ok('scores are cosine (≤ 1) with a cutoff', r1.results.every(r => r.score <= 1.0001) && r1.cutoff > 0, `top ${r1.results[0] && r1.results[0].score.toFixed(3)}, cutoff ${r1.cutoff && r1.cutoff.toFixed(3)}, n ${r1.results.length}`);
    const r2 = await engine.search('lluvia');
    ok('Spanish query is translated', r2.translated && /rain/.test(r2.query), `query → "${r2.query}"`);
    const [a, b, c] = await Promise.all([engine.search('metal hit'), engine.search('rain'), engine.search('beep')]);
    ok('concurrent searches do not share state', a.query === 'metal hit' && b.query === 'rain' && c.query === 'beep' && a.results[0] && c.results[0] && a.results[0].path !== c.results[0].path);
    const scoped = await engine.search('rain', { paths: files.filter(f => /Impacts/.test(f.path)).map(f => f.path), raw: true });
    ok('scoped search ranks only inside the scope', scoped.results.length > 0 && scoped.results.every(r => /Impacts/.test(r.path)), `${scoped.results.length} results`);

    // ── Echo: fragment of a family original, with context ─────────────
    const famOrig = path.join(lib, 'Families', 'fam01', 'fam01_orig.wav');
    const dec = await decodeWavMono(famOrig);
    const selStart = Math.round(0.05 * 48000), selLen = Math.round(0.4 * 48000), pad = 2400;
    const from = Math.max(0, selStart - pad), to = Math.min(dec.samples.length, selStart + selLen + pad);
    const pcm = dec.samples.slice(from, to);
    t0 = Date.now();
    const e1 = await engine.echo({ pcm, sampleRate: 48000, pre: selStart - from, post: to - (selStart + selLen), maxResults: 20 });
    const e1Top = (e1.results || []).slice(0, 5).map(r => path.relative(lib, r.path));
    ok('Echo finds the source of a 400 ms fragment at the right offset', e1.results && e1.results[0] && e1.results[0].path === famOrig && Math.abs(e1.results[0].offsetMs - 50) <= 50,
        `${Date.now() - t0} ms · ${e1Top.join(', ')} · off ${e1.results && e1.results[0] && e1.results[0].offsetMs} · err ${e1.error || '-'}`);
    ok('Echo match duration equals the selection', e1.results && e1.results[0] && Math.abs(e1.results[0].durationMs - 400) <= 30, e1.results && e1.results[0] && `${e1.results[0].durationMs} ms`);
    ok('Echo scores are calibrated (0..1, not rank-normalised)', (e1.results || []).every(r => r.score > 0 && r.score <= 1));
    const e2 = await engine.echo({ pcm, sampleRate: 48000, pre: selStart - from, post: to - (selStart + selLen), exclude: [famOrig] });
    const famHits = (e2.results || []).slice(0, 10).filter(r => /fam01_/.test(r.path)).length;
    ok('Echo (source excluded) returns its family variants', famHits >= 2, `${famHits} fam01 variants in top 10 · ${(e2.results || []).slice(0, 6).map(r => path.basename(r.path)).join(', ')}`);
    const silentPcm = new Float32Array(48000);
    const e3 = await engine.echo({ pcm: silentPcm, sampleRate: 48000 });
    ok('Echo of silence reports "silent" instead of noise', e3.error === 'silent', e3.error);
    const e44 = await engine.echo({ pcm: (await decodeWavMono(famOrig, { rate: 44100 })).samples.slice(0, 44100 * 0.5), sampleRate: 44100 });
    ok('Echo accepts a 44.1 kHz query', e44.results && e44.results[0] && e44.results[0].path === famOrig, e44.results && e44.results[0] && path.basename(e44.results[0].path));
    const f1 = await engine.echoFile(path.join(lib, 'Families', 'fam02', 'fam02_orig.wav'));
    const f1Fam = (f1.results || []).slice(0, 8).filter(r => /fam02_/.test(r.path)).length;
    // CLAP ranking (validated on the real library: 88% sibling@10). Synthetic
    // families share a generator with unrelated fixtures, so only require the
    // near-identical variant first and part of the family near the top.
    ok('Echo "more like this file" puts the closest variant first', f1.results && f1.results[0] && /fam02_/.test(f1.results[0].path) && f1Fam >= 2,
        `${f1Fam} of top 8 · ${(f1.results || []).slice(0, 5).map(r => path.basename(r.path)).join(', ')}`);
    // ── vault brief: words and a reference sound become suggested collections ─
    const rainRef = path.join(lib, 'Ambiences', 'Rain', 'rain_01.wav');
    const kickRef = path.join(lib, 'Impacts', 'Kicks', 'kick_01.wav');
    const br = await engine.brief({
        queries: [
            { key: 'w:rain', title: 'rain', kind: 'word', text: 'rain', weight: 0.6, names: files.filter(f => /rain/i.test(path.basename(f.path))).map(f => f.path) },
            { key: 'w:whoosh', title: 'whoosh', kind: 'word', text: 'whoosh', weight: 0.6 },
            { key: 's:kick', title: 'Like kick_01', label: 'kick_01', kind: 'sound', path: kickRef, weight: 0.7 },
        ],
        exclude: [rainRef], perCard: 12,
    });
    const all = (br.cards || []).flatMap(c => c.candidates.map(x => x.path));
    const rainCard = (br.cards || []).find(c => c.key === 'w:rain');
    ok('brief: each word and the reference sound get their own card', rainCard && (br.cards || []).some(c => c.reasons.some(r => r.kind === 'sound')),
        (br.cards || []).map(c => `${c.title} (${c.candidates.length})`).join(', ') + (br.unmatched && br.unmatched.length ? ` · no good match: ${br.unmatched.join(', ')}` : ''));
    ok('brief: the rain card leads with rain sounds', rainCard && /rain_0\d/.test(path.basename(rainCard.candidates[0].path)), rainCard && rainCard.candidates.slice(0, 4).map(x => path.basename(x.path)).join(', '));
    ok('brief: a sound is suggested in one card only, excluded sounds never', all.length === new Set(all).size && !all.includes(rainRef) && !all.includes(kickRef), `${all.length} sounds`);
    // Two references that share their neighbours, one pinned: the pinned one takes the shared
    // sounds; the other keeps its own card or joins that one, but never reads as "no good match".
    const kick2 = path.join(lib, 'Impacts', 'Kicks', 'kick_02.wav');
    const br2 = await engine.brief({
        queries: [
            { key: 's:k1', title: 'Like kick_01', label: 'kick_01', kind: 'sound', path: kickRef, weight: 0.7 },
            { key: 's:k2', title: 'Like kick_02', label: 'kick_02', kind: 'sound', path: kick2, weight: 0.7, pinned: true },
        ],
        perCard: 12,
    });
    const k1Card = (br2.cards || []).find(c => c.reasons.some(r => r.key === 's:k1'));
    ok('brief: a reference whose sounds went to a pinned one joins a card, not "unmatched"', k1Card && !(br2.unmatched || []).includes('Like kick_01'),
        (br2.cards || []).map(c => `${c.title} [${c.reasons.map(r => r.label).join(' + ')}] (${c.candidates.length})`).join(', ') + ` · unmatched: ${(br2.unmatched || []).join(', ') || 'none'}`);

    const dupPath = path.join(lib, 'Families', 'fam02', 'fam02_copy.wav');
    fs.copyFileSync(path.join(lib, 'Families', 'fam02', 'fam02_orig.wav'), dupPath);

    // ── incremental: add (copy), rename (Explorer-style), delete ──────
    const stDup = fs.statSync(dupPath);
    engine.filesChanged({ added: [{ path: dupPath, mtime: stDup.mtimeMs, size: stDup.size }], removed: [] });
    await waitIdle('add');
    const f2 = await engine.echoFile(path.join(lib, 'Families', 'fam02', 'fam02_orig.wav'));
    const dupRow = (f2.results || []).find(r => r.path === dupPath || (r.copies || []).includes(dupPath));
    ok('added file is indexed incrementally; exact copy is flagged identical', dupRow && dupRow.identical, dupRow ? `${path.basename(dupRow.path)} identical=${dupRow.identical}` : 'not found');
    const vecBefore = last.vectors;
    const renameFrom = path.join(lib, 'Impacts', 'Metal', 'metal_01.wav');
    const renameTo = path.join(lib, 'Impacts', 'Metal', 'metal_01 renamed.wav');
    const stR = fs.statSync(renameFrom);
    fs.renameSync(renameFrom, renameTo);
    const stR2 = fs.statSync(renameTo);
    engine.filesChanged({ added: [{ path: renameTo, mtime: stR2.mtimeMs, size: stR2.size }], removed: [renameFrom] });
    await sleep(2500);
    ok('Explorer rename keeps the vector (matched by size+mtime, no re-analysis)', last.vectors === vecBefore && !last.indexing && stR.size === stR2.size, `vectors ${last.vectors} (was ${vecBefore}), indexing ${last.indexing}`);
    const rs = await engine.search('metal hit', { topK: 50, raw: true });
    ok('renamed file is searchable under its new path', rs.results.some(r => r.path === renameTo) && !rs.results.some(r => r.path === renameFrom));
    const moveTo = path.join(lib, 'Impacts', 'metal_02 moved.wav');
    fs.renameSync(path.join(lib, 'Impacts', 'Metal', 'metal_02.wav'), moveTo);
    engine.filesChanged({ added: [{ path: moveTo }], removed: [path.join(lib, 'Impacts', 'Metal', 'metal_02.wav')] });
    engine.pathsMoved([{ from: path.join(lib, 'Impacts', 'Metal', 'metal_02.wav'), to: moveTo }]);
    await sleep(2500);
    ok('app move (pathsMoved) re-keys without re-analysis', last.vectors === vecBefore && !last.indexing, `vectors ${last.vectors}`);
    const delPath = path.join(lib, 'UI', 'Beeps', 'beep_01.wav');
    fs.unlinkSync(delPath);
    engine.filesChanged({ added: [], removed: [delPath] });
    await sleep(2000);
    ok('deleted file leaves the index', last.vectors === vecBefore - 1, `vectors ${last.vectors}`);
    const bs = await engine.search('beep', { topK: 50, raw: true });
    ok('deleted file is never returned', !bs.results.some(r => r.path === delPath));

    // ── restart: state persists; catalog is still a no-op ─────────────
    if (HNSW) ok('HNSW built during the session once the library grew', last.hnsw === 'ready', `hnsw ${last.hnsw}`);
    await engine.stop();
    engine = mk(); track(engine);
    t0 = Date.now();
    const st2 = await engine.start(lib);
    files = walk(lib);
    const plan3 = await engine.index(compact(files));
    ok('restart: vectors persisted, nothing to re-index', st2.ready && st2.vectors === vecBefore - 1 && plan3.queued === 0, `ready in ${Date.now() - t0} ms, vectors ${st2.vectors}, plan ${JSON.stringify(plan3)}, hnsw ${st2.hnsw}`);
    const rr = await engine.search('rain', { topK: 5 });
    ok('search after restart', rr.results.length > 0);

    // ── library moved to another disk / drive letter: analysis follows it ─
    const moved = path.join(tmp, 'moved-lib');
    fs.cpSync(lib, moved, { recursive: true, preserveTimestamps: true });
    await engine.stop();
    engine = mk(); track(engine);
    await engine.start(moved);
    const movedFiles = walk(moved);
    const planMoved = await engine.index(compact(movedFiles));
    await sleep(4000);
    const again = await engine.index(compact(movedFiles));
    ok('moved library: analysis is relinked by relative path, nothing re-analysed', planMoved.relinked >= st2.vectors - 1 && again.queued === 0 && last.vectors === st2.vectors,
        `relinked ${planMoved.relinked}, then ${JSON.stringify(again)}, vectors ${last.vectors}`);
    if (HNSW) ok('HNSW index persisted and loaded (not rebuilt)', st2.hnsw === 'ready' && st2.hnswSource === 'loaded', `hnsw ${st2.hnsw} (${st2.hnswSource})`);
    await engine.stop();

    const failed = results.filter(r => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} passed`);
    if (!KEEP) fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); else console.log('kept', tmp);
    process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
