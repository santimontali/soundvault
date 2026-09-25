'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeWav, gen } = require('./fixtures/make-library');
const { JsonStore } = require('../src/main/json-store');
const P = require('../src/main/paths');
const { LibraryIndex } = require('../src/main/library-index');
const { VaultStore } = require('../src/main/vault-store');
const { FileOps } = require('../src/main/file-ops');
const { LibraryWatcher } = require('../src/main/library-watcher');
const { parseRange } = require('../src/main/audio-protocol');
const { Renders } = require('../src/main/renders');
const { tokenizeEntry } = require('../src/search/lexical-search');

const made = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-main-')); made.push(d); return d; };
test.after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
const wav = (file, secs = 0.2) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, makeWav({ channels: [gen.sine(48000, secs, 440)], sr: 48000 })); };
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(cond, ms = 8000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (cond()) return true; await wait(50); } return cond(); }

test('JsonStore: atomic write, .bak fallback on corruption, defaults', () => {
    const d = tmp(), f = path.join(d, 's.json');
    const s = new JsonStore(f, () => ({ n: 0 }));
    assert.deepStrictEqual(s.get(), { n: 0 });
    s.update(x => { x.n = 1; }); s.flush();
    s.update(x => { x.n = 2; }); s.flush();
    assert.strictEqual(JSON.parse(fs.readFileSync(f, 'utf8')).n, 2);
    assert.strictEqual(JSON.parse(fs.readFileSync(f + '.bak', 'utf8')).n, 1);
    assert.ok(!fs.existsSync(f + '.tmp'));
    fs.writeFileSync(f, '{"n": 3, trunc');                  // simulate a torn write
    assert.strictEqual(new JsonStore(f, () => ({ n: 0 })).get().n, 1, 'falls back to .bak');
    fs.writeFileSync(f, ''); fs.rmSync(f + '.bak');
    assert.strictEqual(new JsonStore(f, () => ({ n: 9 })).get().n, 9, 'falls back to defaults');
});

test('paths: validation, containment, unique names', () => {
    for (const bad of ['', ' a', 'a ', 'a.', '..', '.', 'a/b', 'a\\b', 'c:x', 'CON', 'lpt1.txt', 'x?', 'x*']) assert.ok(P.validateName(bad), 'should reject ' + JSON.stringify(bad));
    for (const ok of ['Foley & Footsteps', "door 'old' #2", 'ñandú', '日本語', '100% wet']) assert.strictEqual(P.validateName(ok), null, ok);
    assert.ok(P.isInside('C:\\lib', 'C:\\lib\\a\\b.wav'));
    assert.ok(!P.isInside('C:\\lib', 'C:\\lib2\\x.wav'));
    assert.ok(!P.isInside('C:\\lib', 'C:\\lib\\..\\x.wav'));
    assert.throws(() => P.fromRel('C:\\lib', '../x'));
    const d = tmp(); wav(path.join(d, 'a.wav'));
    const taken = new Set();
    assert.strictEqual(path.basename(P.uniquePath(d, 'a.wav', taken)), 'a (2).wav');
    assert.strictEqual(path.basename(P.uniquePath(d, 'a.wav', taken)), 'a (3).wav', 'batch reservations respected');
    assert.ok(P.isAudioFile('X.WAV') && !P.isAudioFile('x.mp3') && !P.isAudioFile('~$lock.wav'));
});

test('LibraryIndex: scan skips ignored dirs, builds tree with recursive counts, natural sort', async () => {
    const d = tmp();
    for (const f of ['A/x 10.wav', 'A/x 2.wav', 'A/sub/y.wav', 'B/z.WAV', 'root.wav', 'node_modules/n.wav', '.git/g.wav', 'A/readme.txt']) {
        if (f.endsWith('.txt')) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), 'x'); }
        else wav(path.join(d, f));
    }
    const lib = new LibraryIndex({ tokenizeEntry });
    const stats = await lib.setRoot(d);
    assert.strictEqual(stats.files, 5);
    const t = lib.tree();
    assert.strictEqual(t.count, 5);
    assert.deepStrictEqual(t.children.map(c => [c.name, c.count]), [['A', 3], ['B', 1]]);
    assert.deepStrictEqual(t.children[0].children.map(c => c.name), ['sub']);
    assert.deepStrictEqual(lib.list({ folder: 'A', recursive: false }).map(e => e.name), ['x 2.wav', 'x 10.wav']);
    assert.strictEqual(lib.list({ folder: 'A' }).length, 3);
    assert.strictEqual(lib.list({ folder: '', recursive: false }).length, 1);
    assert.ok(!('_tokens' in LibraryIndex.public(lib.all()[0])), 'public projection has no token arrays');
    const missing = new LibraryIndex({ tokenizeEntry });
    const ms = await missing.setRoot(path.join(d, 'nope'));
    assert.ok(ms.missingRoot && missing.size === 0);
});

test('VaultStore: collections validation, dedupe, remap across vaults, legacy-compatible file', () => {
    const d = tmp(), f = path.join(d, 'vaults.json');
    const vs = new VaultStore(f, () => null);
    assert.ok(vs.createCollection('Kicks').ok);
    assert.ok(!vs.createCollection('kicks').ok, 'case-insensitive duplicate rejected');
    assert.ok(!vs.createCollection('__colors').ok);
    assert.ok(!vs.createCollection('  ').ok);
    assert.strictEqual(vs.addToCollection('Kicks', ['C:\\L\\a.wav', 'c:\\l\\A.wav', 'C:\\L\\b.wav']), 2);
    const v2 = vs.createVault('Game B');
    vs.switchVault(v2);
    vs.addToCollection('Hits', ['C:\\L\\dir\\c.wav']);
    const n = vs.remapPaths([{ from: 'C:\\L\\a.wav', to: 'C:\\L\\moved\\a.wav' }, { from: 'C:\\L\\dir', to: 'C:\\L\\dir2', dir: true }]);
    assert.strictEqual(n, 2);
    assert.deepStrictEqual(vs.collectionPaths('Hits'), [path.resolve('C:\\L\\dir2\\c.wav')]);
    vs.flush();
    const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
    assert.ok(Array.isArray(raw.vaults) && raw.vaults[0].collections.Kicks.includes('C:\\L\\moved\\a.wav'), '1.0 file format preserved');
    assert.ok(vs.renameCollection('Hits', 'Impacts').ok);
    assert.ok(!vs.deleteVault('nope'));
});

test('FileOps: import files+folders without overwriting, rename/move/trash keep index in sync', async () => {
    const lib = tmp(), ext = tmp();
    wav(path.join(lib, 'Target', 'kick.wav'), 0.3);
    wav(path.join(ext, 'kick.wav'), 0.5);                 // same name, different size → renamed copy
    wav(path.join(ext, 'dup.wav'), 0.2);
    wav(path.join(ext, 'Pack', 'A', 'a1.wav'));
    wav(path.join(ext, 'Pack', 'b1.wav'));
    fs.writeFileSync(path.join(ext, 'Pack', 'notes.txt'), 'x');
    const index = new LibraryIndex({ tokenizeEntry });
    await index.setRoot(lib);
    const trashed = [];
    const ops = new FileOps({ library: index, trashItem: async p => { trashed.push(p); fs.rmSync(p, { recursive: true, force: true }); } });
    const r = await ops.importPaths([path.join(ext, 'kick.wav'), path.join(ext, 'dup.wav'), path.join(ext, 'Pack')], 'Target');
    assert.strictEqual(r.imported.length, 4);
    assert.strictEqual(r.renamed, 1);
    assert.strictEqual(r.ignored, 1);
    assert.ok(fs.existsSync(path.join(lib, 'Target', 'kick (2).wav')), 'collision renamed, original kept');
    assert.strictEqual(fs.statSync(path.join(lib, 'Target', 'kick.wav')).size < fs.statSync(path.join(lib, 'Target', 'kick (2).wav')).size, true);
    assert.ok(fs.existsSync(path.join(lib, 'Target', 'Pack', 'A', 'a1.wav')), 'folder structure preserved');
    const again = await ops.importPaths([path.join(ext, 'dup.wav')], 'Target');
    assert.strictEqual(again.skipped.length, 1, 'identical re-import skipped');
    assert.strictEqual(index.size, 5);

    const bad = await ops.createFolder('', '..');
    assert.ok(!bad.ok);
    assert.ok((await ops.createFolder('', 'New')).ok);
    const rf = await ops.renameFolder('Target/Pack', 'Pack v2');
    assert.ok(rf.ok && rf.moves.length === 2);
    assert.ok(index.has(path.join(lib, 'Target', 'Pack v2', 'A', 'a1.wav')));
    const mv = await ops.moveFiles([path.join(lib, 'Target', 'dup.wav')], 'New');
    assert.ok(mv.ok && index.has(path.join(lib, 'New', 'dup.wav')));
    const rn = await ops.renameFile(path.join(lib, 'New', 'dup.wav'), 'renamed');
    assert.ok(rn.ok && rn.path.endsWith('renamed.wav'));
    const tr = await ops.trashFiles([rn.path]);
    assert.ok(tr.ok && trashed.length === 1 && !index.has(rn.path));
    const out = await ops.trashFiles(['C:\\Windows\\win.ini']);
    assert.ok(!out.ok, 'refuses paths outside the library');
    assert.ok(!(await ops.trashFolder('')).ok, 'refuses to delete the root');
});

test('LibraryWatcher: external add, delete, and directory rename are reconciled', async () => {
    const lib = tmp();
    wav(path.join(lib, 'Dir', 'one.wav'));
    const index = new LibraryIndex({ tokenizeEntry });
    await index.setRoot(lib);
    const w = new LibraryWatcher(index, { debounceMs: 150 });
    const batches = [];
    w.on('changes', c => batches.push(c));
    assert.ok(w.start());
    try {
        wav(path.join(lib, 'Dir', 'two.wav'));
        assert.ok(await until(() => index.has(path.join(lib, 'Dir', 'two.wav'))), 'external add picked up');
        fs.renameSync(path.join(lib, 'Dir'), path.join(lib, 'Dir Renamed'));
        assert.ok(await until(() => index.has(path.join(lib, 'Dir Renamed', 'one.wav')) && !index.has(path.join(lib, 'Dir', 'one.wav'))), 'renamed dir reconciled');
        fs.rmSync(path.join(lib, 'Dir Renamed', 'two.wav'));
        assert.ok(await until(() => !index.has(path.join(lib, 'Dir Renamed', 'two.wav'))), 'external delete picked up');
        assert.ok(batches.length >= 1, 'change batches emitted');
    } finally { w.stop(); }
});

test('LibraryIndex: persisted index loads instantly and reconcile picks up offline changes', async () => {
    const lib = tmp(), cache = path.join(tmp(), 'lib.json');
    wav(path.join(lib, 'A', 'a1.wav')); wav(path.join(lib, 'A', 'a2.wav')); wav(path.join(lib, 'B', 'C', 'c1.wav'));
    const i1 = new LibraryIndex({ tokenizeEntry, cacheFile: cache });
    const s1 = await i1.setRoot(lib);
    assert.strictEqual(s1.files, 3); assert.ok(!s1.fromCache);
    await until(() => !i1.background);
    i1.save();
    // offline changes while the app is closed
    await wait(30);
    fs.rmSync(path.join(lib, 'A', 'a2.wav'));
    wav(path.join(lib, 'B', 'C', 'c2.wav'));
    fs.mkdirSync(path.join(lib, 'D')); wav(path.join(lib, 'D', 'd1.wav'));
    fs.rmSync(path.join(lib, 'B', 'C'), { recursive: true, force: true }) ; wav(path.join(lib, 'B', 'b1.wav'));
    const i2 = new LibraryIndex({ tokenizeEntry, cacheFile: cache });
    const changes = [];
    i2.on('changed', c => changes.push(c));
    const s2 = await i2.setRoot(lib);
    assert.ok(s2.fromCache, 'loaded from cache');
    assert.strictEqual(i2.size, 3, 'cached content served immediately');
    await until(() => !i2.background);
    const names = i2.all().map(e => e.dir + '/' + e.name).sort();
    assert.deepStrictEqual(names, ['A/a1.wav', 'B/b1.wav', 'D/d1.wav']);
    assert.ok(i2.scanStats.readDirs >= 1 && i2.scanStats.readDirs < 6, 'only changed dirs re-read: ' + i2.scanStats.readDirs);
    assert.ok(changes.some(c => c.added && c.removed), 'incremental change event emitted');
});

test('audio protocol: Range header parsing', () => {
    assert.deepStrictEqual(parseRange('bytes=0-99', 1000), { start: 0, end: 99 });
    assert.deepStrictEqual(parseRange('bytes=900-', 1000), { start: 900, end: 999 });
    assert.deepStrictEqual(parseRange('bytes=-100', 1000), { start: 900, end: 999 });
    assert.deepStrictEqual(parseRange('bytes=0-5000', 1000), { start: 0, end: 999 });
    assert.strictEqual(parseRange('bytes=2000-', 1000), 'invalid');
    assert.strictEqual(parseRange(null, 1000), null);
});

test('Renders: unique persistent names and de-dup by key', async () => {
    const d = tmp();
    const r = new Renders(() => d);
    const ch = [gen.sine(48000, 0.1, 440)];
    const key = Renders.keyFor({ src: 'x', a: 1 });
    const a = await r.render({ channels: ch, sampleRate: 48000, baseName: 'Wood Hit: 03', suffix: '[0.10-0.20 s]', key });
    const b = await r.render({ channels: ch, sampleRate: 48000, baseName: 'Wood Hit: 03', suffix: '[0.10-0.20 s]', key });
    const c = await r.render({ channels: ch, sampleRate: 48000, baseName: 'Wood Hit: 03', suffix: '[0.10-0.20 s]' });
    assert.strictEqual(a.path, b.path); assert.ok(b.reused);
    assert.notStrictEqual(a.path, c.path, 'no overwrite without key');
    assert.ok(!path.basename(a.path).includes(':'));
    // Renders are staged until dragged: nothing permanent yet.
    assert.strictEqual((await r.stats()).files, 0);
    const [p1] = r.promote([a.path]);
    assert.strictEqual(path.dirname(p1), d, 'promoted next to the other renders');
    assert.ok(fs.existsSync(p1) && !fs.existsSync(a.path));
    assert.deepStrictEqual(r.promote([a.path]), [p1], 'dragging the same render again reuses the file');
    const again = await r.render({ channels: ch, sampleRate: 48000, baseName: 'Wood Hit: 03', suffix: '[0.10-0.20 s]', key });
    assert.strictEqual(again.path, p1, 'key de-dup follows the promoted file');
    assert.deepStrictEqual(r.promote(['C:\\elsewhere\\x.wav']), ['C:\\elsewhere\\x.wav'], 'non-staged paths untouched');
    assert.strictEqual((await r.stats()).files, 1);
    // Startup prune: only the previous session's previews, never one this session is preparing.
    const bootAt = Date.now() - 1000;
    const fresh = await r.render({ channels: ch, sampleRate: 48000, baseName: 'Fresh', suffix: '[edit]' });
    const old = path.join(r.stagingDir, 'Old preview [edit].wav');
    fs.writeFileSync(old, 'x');
    fs.utimesSync(old, new Date(bootAt - 60000), new Date(bootAt - 60000));
    assert.strictEqual(r.pruneStaging({ before: bootAt }), 1, 'only the old preview goes at startup');
    assert.ok(fs.existsSync(fresh.path) && !fs.existsSync(old), 'the render made this session stays');
    assert.strictEqual(r.pruneStaging(), 2, 'on quit every undragged preview is removed');
    assert.ok(fs.existsSync(p1), 'dragged renders are never pruned');
});
