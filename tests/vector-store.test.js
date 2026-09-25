'use strict';
// VectorStore: cosine ranking, incremental edits, stable-label HNSW and its persistence.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { VectorStore, DIM } = require('../src/engine/vector-store');

let seed = 42;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5;
const vec = (scale = 1) => { const v = new Float32Array(DIM); for (let i = 0; i < DIM; i++) v[i] = rnd() * scale; return v; };
const unit = v => { let s = 0; for (const x of v) s += x * x; return Float32Array.from(v, x => x / Math.sqrt(s)); };
const near = (v, eps) => Float32Array.from(v, x => x + rnd() * eps);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-vs-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('ranks by cosine, not by vector length (CLAP norms vary 1-9)', () => {
    const s = new VectorStore({ hnswMin: 1e9 });
    const q = vec();
    s.upsert(1, 'close-short', near(q, 0.05));           // same direction, norm ~1×
    s.upsert(2, 'far-long', vec(40));                    // unrelated, huge norm
    const r = s.search(unit(q), 2);
    assert.equal(r[0].path, 'close-short');
    assert.ok(r[0].score <= 1.0001 && r[0].score > 0.9);
});

test('upsert replaces by path, remove swaps, rename keeps the vector', () => {
    const s = new VectorStore({ hnswMin: 1e9 });
    const a = vec(), b = vec(), c = vec();
    s.upsert(1, 'a', a); s.upsert(2, 'b', b); s.upsert(3, 'c', c);
    s.upsert(1, 'a', b);                                 // re-index a
    assert.equal(s.count, 3);
    assert.ok(s.search(unit(b), 3).filter(r => r.score > 0.999).length === 2);
    s.remove('a');
    assert.equal(s.count, 2);
    assert.ok(!s.search(unit(b), 3).some(r => r.path === 'a'));
    assert.ok(s.rename('c', 'c2'));
    assert.equal(s.search(unit(c), 1)[0].path, 'c2');
});

test('scoped search ranks exactly within the given paths', () => {
    const s = new VectorStore({ hnswMin: 1e9 });
    const q = vec();
    for (let i = 0; i < 200; i++) s.upsert(i + 1, 'p' + i, i === 7 ? near(q, 0.01) : vec());
    const r = s.search(unit(q), 5, ['p3', 'p7', 'p150']);
    assert.deepEqual(r.map(x => x.path).sort(), ['p150', 'p3', 'p7']);
    assert.equal(r[0].path, 'p7');
});

const hnsw = VectorStore.available ? test : test.skip;

hnsw('HNSW: incremental add/update/delete never returns stale or duplicate labels', async () => {
    const s = new VectorStore({ hnswMin: 50 });
    const vs = [];
    for (let i = 0; i < 400; i++) { vs.push(vec()); s.upsert(i + 1, 'f' + i, vs[i]); }
    assert.ok(await s.build());
    for (let i = 0; i < 100; i++) s.remove('f' + i);                            // deletes
    for (let i = 100; i < 150; i++) { vs[i] = vec(); s.upsert(i + 1, 'f' + i, vs[i]); }   // updates (same id)
    for (let i = 400; i < 500; i++) { vs.push(vec()); s.upsert(i + 1, 'f' + i, vs[i]); }  // adds
    s.upsert(1000, 'f200', vs[200]);                                            // same path, new id
    for (const i of [120, 200, 450, 499]) {
        const r = s.search(unit(vs[i]), 10);
        assert.equal(r[0].path, 'f' + i, 'exact hit for f' + i);
        assert.equal(new Set(r.map(x => x.path)).size, r.length, 'no duplicate paths');
        assert.ok(r.every(x => !/^f([0-9]|[1-9][0-9])$/.test(x.path)), 'deleted rows never returned');
    }
});

hnsw('HNSW: edits made while the index builds are replayed once, without re-adding every row', async () => {
    const s = new VectorStore({ hnswMin: 50 });
    const vs = [];
    for (let i = 0; i < 1500; i++) { vs.push(vec()); s.upsert(i + 1, 'b' + i, vs[i]); }
    let updates = 0;
    const building = s.build();
    // The build yields every ~30 ms: land edits mid-build.
    await new Promise(r => setImmediate(r));
    for (let i = 0; i < 10; i++) { vs[i] = vec(); s.upsert(i + 1, 'b' + i, vs[i]); }          // updated vectors
    for (let i = 20; i < 30; i++) s.remove('b' + i);                                          // removed rows
    for (let i = 1500; i < 1510; i++) { vs.push(vec()); s.upsert(i + 1, 'b' + i, vs[i]); }    // new rows
    const add = s._hnswAdd.bind(s);
    s._hnswAdd = (id, row) => { updates++; return add(id, row); };
    assert.ok(await building);
    assert.ok(updates <= 30, `only the edited rows are replayed (got ${updates})`);
    for (const i of [3, 1505, 700]) assert.equal(s.search(unit(vs[i]), 1)[0].path, 'b' + i, 'exact hit for b' + i);
    for (let i = 20; i < 30; i++) {
        const r = s.hnsw.searchKnn(Array.from(unit(vs[i])), 1, l => l === i + 1);
        assert.equal(r.neighbors.length, 0, 'removed row is not live in the index');
    }
});

hnsw('HNSW: persisted index replays rows written after its generation', async () => {
    const file = path.join(tmp, 'v.hnsw');
    const s = new VectorStore({ hnswMin: 50 });
    const vs = [];
    for (let i = 0; i < 300; i++) { vs.push(vec()); s.upsert(i + 1, 'g' + i, vs[i]); }
    assert.ok(await s.build());
    assert.ok(await s.save(file, 5));
    // Next session: DB has 20 new rows (gen 6) and lost row 0
    const t = new VectorStore({ hnswMin: 50 });
    for (let i = 1; i < 300; i++) t.upsert(i + 1, 'g' + i, vs[i]);
    const extra = [];
    for (let i = 0; i < 20; i++) { extra.push(vec()); t.upsert(1000 + i, 'n' + i, extra[i]); }
    const loaded = await t.load(file, 6, since => { assert.equal(since, 5); return extra.map((_, i) => 1000 + i); });
    assert.ok(loaded && t.hnswState === 'ready');
    assert.equal(t.search(unit(extra[7]), 1)[0].path, 'n7', 'replayed row is searchable');
    assert.ok(!t.search(unit(vs[0]), 5).some(r => r.path === 'g0'), 'row gone from the DB is not returned');
});
