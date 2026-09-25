'use strict';
/**
 * One-time conversion of the pre-2.0 Echo table (spectral_index: deflated
 * float32 features with the summary stored AFTER the blob) into
 * echo_summary + echo_features (float16), in its own thread.
 *
 *  - Rows written per-file z-scored by the old bug (audit C6) cannot be
 *    recovered: they are dropped and simply fingerprinted again.
 *  - Converted rows are deleted from the old table in the same transaction,
 *    so freed pages are reused and the database does not grow.
 *  - INSERT OR IGNORE: a file re-fingerprinted meanwhile keeps its new data.
 *  - Obsolete tables (spectral_index, spectral_stats, peaks_cache) are dropped at the end.
 */
const { parentPort, workerData } = require('worker_threads');
const zlib = require('zlib');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const core = require('./echo-core');
const { SCHEMA } = require('./echo');

const db = new Database(workerData.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('busy_timeout = 10000');
db.pragma('journal_size_limit = 67108864');
db.exec(SCHEMA);

const has = t => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
const F = core.F;

function run() {
    const t0 = Date.now();
    let converted = 0, dropped = 0, failed = 0;
    if (has('spectral_index')) {
        const total = db.prepare('SELECT COUNT(*) AS n FROM spectral_index').get().n;
        const page = db.prepare('SELECT id, file_path, mtime, feature_matrix, window_count, duration_ms FROM spectral_index WHERE id > ? ORDER BY id LIMIT 150');
        const insSum = db.prepare('INSERT OR IGNORE INTO echo_summary (file_path, mtime, version, windows, span_ms, counted, hash, sums, attack) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
        const insFeat = db.prepare('INSERT OR IGNORE INTO echo_features (file_path, windows, data) VALUES (?, ?, ?)');
        const del = db.prepare('DELETE FROM spectral_index WHERE id = ?');
        const commit = db.transaction(batch => {
            for (const b of batch) {
                if (b.ok) {
                    insSum.run(b.path, b.mtime, core.FEATURE_VERSION, b.windows, b.span, b.counted, b.hash, b.sums, b.attack);
                    insFeat.run(b.path, b.windows, b.data);
                }
                del.run(b.id);
            }
        });
        let last = 0, done = 0, lastPost = 0;
        for (;;) {
            const rows = page.all(last);
            if (!rows.length) break;
            const batch = [];
            for (const r of rows) {
                last = r.id;
                const b = { id: r.id, ok: false };
                try {
                    const inflated = zlib.inflateSync(r.feature_matrix);
                    const raw = inflated.byteOffset % 4
                        ? new Float32Array(inflated.buffer.slice(inflated.byteOffset, inflated.byteOffset + (inflated.byteLength & ~3)))
                        : new Float32Array(inflated.buffer, inflated.byteOffset, inflated.byteLength >> 2);
                    const W = r.window_count;
                    if (!W || raw.length < W * F) { failed++; }
                    else if (core.looksPerFileNormalised(raw, W)) { dropped++; }
                    else {
                        const m = raw.subarray(0, W * F);
                        const s = core.fileSummary(m, W);
                        const data = Buffer.from(core.encodeHalf(m));
                        const sums = new Float64Array(2 * F); sums.set(s.sum); sums.set(s.sumSq, F);
                        Object.assign(b, {
                            ok: true, path: r.file_path, mtime: r.mtime, windows: W, span: r.duration_ms | 0, counted: s.counted,
                            hash: crypto.createHash('md5').update(data).digest('hex'),
                            sums: Buffer.from(sums.buffer), attack: Buffer.from(s.attack.buffer, s.attack.byteOffset, s.attack.byteLength), data,
                        });
                        converted++;
                    }
                } catch (e) { failed++; }
                batch.push(b);
            }
            commit(batch);
            done += rows.length;
            if (Date.now() - lastPost > 300) { lastPost = Date.now(); parentPort.postMessage({ type: 'progress', done, total }); }
        }
        db.exec('DROP TABLE IF EXISTS spectral_index');
    }
    for (const t of ['spectral_stats', 'peaks_cache']) if (has(t)) db.exec(`DROP TABLE IF EXISTS ${t}`);
    try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch (e) { /* readers active: the next checkpoint will do */ }
    return { converted, dropped, failed, ms: Date.now() - t0 };
}

try {
    const r = run();
    parentPort.postMessage({ type: 'done', ...r });
} catch (e) {
    parentPort.postMessage({ type: 'error', error: String(e && e.message || e) });
} finally {
    try { db.close(); } catch (e) { /* closing anyway */ }
}
