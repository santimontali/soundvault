'use strict';
/**
 * soundvault-semantic.db, schema, migrations and the write helpers used by
 * the engine host (the ONLY writer).
 *
 * embeddings     one CLAP vector per file. `id` is stable across re-indexes
 *                (UPSERT keeps it) and doubles as the HNSW label.
 *                quality: 1 = first 10 s of a longer file (deep pass pending)
 *                         2 = complete (short file, or mean of windows)
 *                         NULL = legacy row, classified on load
 *                gen: value of meta.gen when the row was last written, so a
 *                persisted HNSW index can replay only what changed since.
 * index_failures files that could not be decoded, keyed by (path, mtime) so
 *                they are not retried on every run.
 * meta           gen counter, DB instance id.
 */
const Database = require('better-sqlite3');
const crypto = require('crypto');

function hasColumn(db, table, col) {
    return db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col);
}

function migrate(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS embeddings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            file_path TEXT UNIQUE,
            mtime INTEGER,
            vector BLOB
        );
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
        CREATE TABLE IF NOT EXISTS index_failures (
            file_path TEXT PRIMARY KEY,
            mtime INTEGER,
            stage TEXT,
            error TEXT,
            attempts INTEGER NOT NULL DEFAULT 1,
            at INTEGER
        );
    `);
    // ADD COLUMN with a constant default is O(1) in SQLite (rows are not rewritten).
    if (!hasColumn(db, 'embeddings', 'quality')) db.exec('ALTER TABLE embeddings ADD COLUMN quality INTEGER');
    if (!hasColumn(db, 'embeddings', 'duration_ms')) db.exec('ALTER TABLE embeddings ADD COLUMN duration_ms INTEGER');
    if (!hasColumn(db, 'embeddings', 'size')) db.exec('ALTER TABLE embeddings ADD COLUMN size INTEGER');
    if (!hasColumn(db, 'embeddings', 'gen')) db.exec('ALTER TABLE embeddings ADD COLUMN gen INTEGER NOT NULL DEFAULT 0');
    db.exec('CREATE INDEX IF NOT EXISTS idx_embeddings_gen ON embeddings(gen)');
    const inst = db.prepare("SELECT value FROM meta WHERE key = 'instance'").get();
    if (!inst) db.prepare("INSERT INTO meta (key, value) VALUES ('instance', ?)").run(crypto.randomUUID());
    db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('gen', '0')").run();
}

function openDb(file, { readonly = false } = {}) {
    const db = new Database(file, readonly ? { readonly: true, fileMustExist: true } : {});
    if (!readonly) {
        db.pragma('journal_mode = WAL');
        db.pragma('synchronous = NORMAL');
    }
    db.pragma('cache_size = -64000');
    db.pragma('temp_store = MEMORY');
    db.pragma('busy_timeout = 5000');
    if (!readonly) migrate(db);
    return db;
}

/** Prepared statements + transactional helpers around the embeddings table. */
class EmbeddingsTable {
    constructor(db) {
        this.db = db;
        const s = this.s = {
            meta: db.prepare('SELECT value FROM meta WHERE key = ?'),
            setMeta: db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
            bumpGen: db.prepare("UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'gen' RETURNING CAST(value AS INTEGER) AS gen"),
            upsert: db.prepare(`INSERT INTO embeddings (file_path, mtime, vector, quality, duration_ms, size, gen)
                                VALUES (@path, @mtime, @vector, @quality, @durationMs, @size, @gen)
                                ON CONFLICT(file_path) DO UPDATE SET mtime = excluded.mtime, vector = excluded.vector,
                                    quality = excluded.quality, duration_ms = excluded.duration_ms,
                                    size = COALESCE(excluded.size, embeddings.size), gen = excluded.gen
                                RETURNING id`),
            setQuality: db.prepare('UPDATE embeddings SET quality = ?, duration_ms = COALESCE(?, duration_ms), gen = ? WHERE file_path = ? AND mtime = ?'),
            del: db.prepare('DELETE FROM embeddings WHERE file_path = ? RETURNING id'),
            delTarget: db.prepare('DELETE FROM embeddings WHERE file_path = ? AND file_path <> ?'),
            rename: db.prepare('UPDATE embeddings SET file_path = ?, mtime = COALESCE(?, mtime) WHERE file_path = ? RETURNING id'),
            idsSince: db.prepare('SELECT id FROM embeddings WHERE gen > ?'),
            byPath: db.prepare('SELECT id, mtime, quality, duration_ms AS durationMs, size FROM embeddings WHERE file_path = ?'),
            all: db.prepare('SELECT id, file_path AS path, mtime, quality, duration_ms AS durationMs, size, vector FROM embeddings WHERE id > ? ORDER BY id LIMIT ?'),
            allMeta: db.prepare('SELECT id, file_path AS path, mtime, quality, duration_ms AS durationMs, size FROM embeddings'),
            count: db.prepare('SELECT COUNT(*) AS n FROM embeddings'),
            failure: db.prepare('SELECT mtime, stage, error, attempts FROM index_failures WHERE file_path = ?'),
            allFailures: db.prepare('SELECT file_path AS path, mtime, stage, error FROM index_failures'),
            addFailure: db.prepare(`INSERT INTO index_failures (file_path, mtime, stage, error, attempts, at) VALUES (?, ?, ?, ?, 1, ?)
                                    ON CONFLICT(file_path) DO UPDATE SET mtime = excluded.mtime, stage = excluded.stage, error = excluded.error,
                                        attempts = CASE WHEN index_failures.mtime = excluded.mtime THEN index_failures.attempts + 1 ELSE 1 END, at = excluded.at`),
            clearFailure: db.prepare('DELETE FROM index_failures WHERE file_path = ?'),
            clearFailures: db.prepare('DELETE FROM index_failures'),
            renameFailure: db.prepare('UPDATE OR REPLACE index_failures SET file_path = ?, mtime = COALESCE(?, mtime) WHERE file_path = ?'),
            setSize: db.prepare('UPDATE embeddings SET size = ? WHERE id = ?'),
        };
        this._fillSizes = db.transaction(pairs => { for (const [size, id] of pairs) s.setSize.run(size, id); });
        this._writeBatch = db.transaction(items => {
            const gen = s.bumpGen.get().gen;
            const out = [];
            for (const it of items) {
                if (it.vector) {
                    const row = s.upsert.get({
                        path: it.path, mtime: it.mtime, vector: Buffer.from(it.vector.buffer, it.vector.byteOffset, it.vector.byteLength),
                        quality: it.quality ?? null, durationMs: it.durationMs ?? null, size: it.size ?? null, gen,
                    });
                    out.push({ ...it, id: row.id });
                } else if (it.quality) {
                    s.setQuality.run(it.quality, it.durationMs ?? null, gen, it.path, it.mtime);
                }
                s.clearFailure.run(it.path);
            }
            return { gen, rows: out };
        });
        this._delete = db.transaction(paths => {
            const ids = [];
            for (const p of paths) { const r = s.del.get(p); if (r) ids.push(r.id); s.clearFailure.run(p); }
            return ids;
        });
        this._rename = db.transaction(moves => {
            const out = [];
            for (const m of moves) {
                s.delTarget.run(m.to, m.from);                   // a stale row at the destination loses
                const r = s.rename.get(m.to, m.mtime ?? null, m.from);          // mtime: relinked copies
                s.renameFailure.run(m.to, m.mtime ?? null, m.from);
                if (r) out.push({ from: m.from, to: m.to, id: r.id, mtime: m.mtime });
            }
            return out;
        });
    }
    get gen() { return +this.s.meta.get('gen').value; }
    get instance() { return this.s.meta.get('instance').value; }
    getMeta(k) { const r = this.s.meta.get(k); return r ? r.value : null; }
    setMeta(k, v) { this.s.setMeta.run(k, String(v)); }
    count() { return this.s.count.get().n; }
    byPath(p) { return this.s.byPath.get(p) || null; }
    /** Iterate all rows (with vectors) in id order, `chunk` at a time. */
    *iterate(chunk = 4000) {
        let last = 0;
        for (;;) {
            const rows = this.s.all.all(last, chunk);
            if (!rows.length) return;
            yield rows;
            last = rows[rows.length - 1].id;
        }
    }
    allMeta() { return this.s.allMeta.all(); }
    idsSince(gen) { return this.s.idsSince.all(gen).map(r => r.id); }
    /** items: [{path, mtime, size?, vector?: Float32Array, quality, durationMs}] → {gen, rows:[{...item, id}]} */
    writeBatch(items) { return this._writeBatch(items); }
    deletePaths(paths) { return this._delete(paths); }
    renamePaths(moves) { return this._rename(moves); }
    failures() { return this.s.allFailures.all(); }
    /** pairs: [[size, id]], sizes for legacy rows (used to recognise moved files). */
    fillSizes(pairs) { this._fillSizes(pairs); }
    addFailure(p, mtime, stage, error) { this.s.addFailure.run(p, mtime, stage, String(error || '').slice(0, 300), Date.now()); }
    clearFailures() { this.s.clearFailures.run(); }
}

module.exports = { openDb, migrate, EmbeddingsTable };
