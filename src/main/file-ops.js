'use strict';
/**
 * File operations on the library. Every operation:
 *   - validates names and keeps all targets inside the library root,
 *   - never overwrites existing audio (unique " (2)" names, COPYFILE_EXCL),
 *   - deletes via the OS Recycle Bin (never permanent),
 *   - updates the LibraryIndex incrementally (no full rescans),
 *   - returns a change summary { added, removed, moves } so the caller can
 *     update collections, the semantic DB and the renderer.
 */
const fs = require('fs');
const path = require('path');
const P = require('./paths');

class FileOps {
    /**
     * @param {object} deps
     * @param {import('./library-index').LibraryIndex} deps.library
     * @param {(p:string)=>Promise<void>} deps.trashItem  electron shell.trashItem
     */
    constructor({ library, trashItem }) {
        this.library = library;
        this.trashItem = trashItem;
    }

    get root() { return this.library.root; }

    _abs(rel) { return P.fromRel(this.root, rel || ''); }

    // ── import ──────────────────────────────────────────────────────────
    /**
     * Copy audio files and/or whole folders into `targetRel`.
     * Folder structure below a dropped folder is preserved.
     * @param {string[]} sources absolute paths (files or directories)
     * @param {string} targetRel library-relative destination folder
     * @param {(p:{done:number,total:number,file:string})=>void} [onProgress]
     */
    async importPaths(sources, targetRel, onProgress) {
        if (!this.root) throw new Error('No library folder configured');
        const targetDir = this._abs(targetRel);
        await fs.promises.mkdir(targetDir, { recursive: true });

        // 1) Expand sources into [src, destDir] jobs
        const jobs = [];
        const result = { imported: [], skipped: [], failed: [], renamed: 0, ignored: 0 };
        for (const src of sources || []) {
            if (typeof src !== 'string' || !src) continue;
            let st;
            try { st = await fs.promises.stat(src); } catch (e) { result.failed.push({ path: src, error: 'Not found' }); continue; }
            if (st.isDirectory()) {
                if (P.isInside(src, targetDir)) { result.failed.push({ path: src, error: 'Cannot import a folder into itself' }); continue; }
                const base = path.basename(src);
                const stack = [[src, path.join(targetDir, base)]];
                while (stack.length) {
                    const [dir, dest] = stack.pop();
                    let list;
                    try { list = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (e) { continue; }
                    for (const d of list) {
                        const full = path.join(dir, d.name);
                        if (d.isDirectory()) { if (!P.isIgnoredDir(d.name)) stack.push([full, path.join(dest, d.name)]); }
                        else if (P.isAudioFile(d.name)) jobs.push([full, dest]);
                        else result.ignored++;
                    }
                }
            } else if (P.isAudioFile(path.basename(src))) {
                jobs.push([src, targetDir]);
            } else {
                result.ignored++;
            }
        }

        // 2) Copy (bounded concurrency, never overwrite)
        const taken = new Set();
        const added = [];
        let done = 0;
        const total = jobs.length;
        const runOne = async ([src, destDir]) => {
            try {
                if (P.isInside(this.root, src) && P.key(path.dirname(src)) === P.key(destDir)) {
                    result.skipped.push({ path: src, reason: 'Already in this folder' });
                    return;
                }
                await fs.promises.mkdir(destDir, { recursive: true });
                const name = path.basename(src);
                const direct = path.join(destDir, name);
                // Same name + same size already there → treat as duplicate, skip.
                const existing = await fs.promises.stat(direct).catch(() => null);
                const srcSt = await fs.promises.stat(src);
                if (existing && existing.size === srcSt.size) { result.skipped.push({ path: src, reason: 'Duplicate' }); return; }
                const dest = P.uniquePath(destDir, name, taken);
                if (dest !== direct) result.renamed++;
                await fs.promises.copyFile(src, dest, fs.constants.COPYFILE_EXCL);
                const e = this.library.upsert(dest);
                if (e) { added.push(e); result.imported.push(dest); }
            } catch (e) {
                result.failed.push({ path: src, error: e.code === 'EBUSY' ? 'File is locked by another program' : e.message });
            } finally {
                done++;
                if (onProgress && (done === total || done % 8 === 0)) onProgress({ done, total, file: path.basename(src) });
            }
        };
        const queue = jobs.slice();
        const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
            while (queue.length) await runOne(queue.shift());
        });
        await Promise.all(workers);
        this.library.notify(added, []);
        return { ...result, added: added.map(e => e.path), removed: [], moves: [] };
    }

    // ── folders ─────────────────────────────────────────────────────────
    async createFolder(parentRel, name) {
        const err = P.validateName(name);
        if (err) return { ok: false, error: err };
        const dir = path.join(this._abs(parentRel), name);
        if (!P.isInside(this.root, dir)) return { ok: false, error: 'Invalid location' };
        if (fs.existsSync(dir)) return { ok: false, error: 'A folder with that name already exists' };
        await fs.promises.mkdir(dir, { recursive: true });
        const rel = P.toRel(this.root, dir);
        this.library._ensureDirChain(rel);
        this.library._invalidate();
        return { ok: true, rel };
    }

    async renameFolder(rel, newName) {
        const err = P.validateName(newName);
        if (err) return { ok: false, error: err };
        if (!rel) return { ok: false, error: 'Cannot rename the library root' };
        const from = this._abs(rel);
        const to = path.join(path.dirname(from), newName);
        if (!P.isInside(this.root, to)) return { ok: false, error: 'Invalid location' };
        const caseOnly = P.key(from) === P.key(to);
        if (!caseOnly && fs.existsSync(to)) return { ok: false, error: 'A folder with that name already exists' };
        try {
            if (caseOnly) { const tmp = from + '.sv-rename-' + Date.now(); await fs.promises.rename(from, tmp); await fs.promises.rename(tmp, to); }
            else await fs.promises.rename(from, to);
        } catch (e) {
            return { ok: false, error: e.code === 'EPERM' || e.code === 'EBUSY' ? 'The folder is in use by another program' : e.message };
        }
        const moves = this._remapDirInIndex(from, to);
        return { ok: true, rel: P.toRel(this.root, to), moves, dirMove: { from, to, dir: true } };
    }

    async trashFolder(rel) {
        if (!rel) return { ok: false, error: 'Cannot delete the library root' };
        const dir = this._abs(rel);
        try { await this.trashItem(dir); }
        catch (e) { return { ok: false, error: 'Could not move the folder to the Recycle Bin: ' + e.message }; }
        const removed = this.library.removeDir(dir);
        this.library._dropDirMeta(P.toRel(this.root, dir));
        this.library._invalidate();
        this.library.notify([], removed);
        return { ok: true, removed: removed.map(e => e.path) };
    }

    // ── files ───────────────────────────────────────────────────────────
    async trashFiles(paths) {
        const removed = [], failed = [];
        for (const p of paths || []) {
            if (!P.isInside(this.root, p)) { failed.push({ path: p, error: 'Outside the library' }); continue; }
            try {
                await this.trashItem(p);
                const e = this.library.remove(p);
                if (e) removed.push(e);
            } catch (e) {
                failed.push({ path: p, error: e.message });
            }
        }
        this.library.notify([], removed);
        return { ok: failed.length === 0, removed: removed.map(e => e.path), failed };
    }

    async moveFiles(paths, targetRel) {
        const targetDir = this._abs(targetRel);
        await fs.promises.mkdir(targetDir, { recursive: true });
        const moves = [], failed = [], added = [], removed = [];
        const taken = new Set();
        for (const src of paths || []) {
            if (!P.isInside(this.root, src)) { failed.push({ path: src, error: 'Outside the library' }); continue; }
            if (P.key(path.dirname(src)) === P.key(targetDir)) continue;
            const dest = P.uniquePath(targetDir, path.basename(src), taken);
            try {
                await fs.promises.rename(src, dest).catch(async e => {
                    if (e.code !== 'EXDEV') throw e; // cross-volume: copy + delete
                    await fs.promises.copyFile(src, dest, fs.constants.COPYFILE_EXCL);
                    await fs.promises.unlink(src);
                });
                const old = this.library.remove(src);
                if (old) removed.push(old);
                const e = this.library.upsert(dest);
                if (e) added.push(e);
                moves.push({ from: src, to: dest });
            } catch (e) {
                failed.push({ path: src, error: e.code === 'EBUSY' || e.code === 'EPERM' ? 'The file is in use by another program' : e.message });
            }
        }
        this.library.notify(added, removed);
        return { ok: failed.length === 0, moves, failed };
    }

    async renameFile(p, newName) {
        if (!P.isInside(this.root, p)) return { ok: false, error: 'Outside the library' };
        let name = String(newName || '').trim();
        if (name && !P.isAudioFile(name)) name += path.extname(p);
        const err = P.validateName(name);
        if (err) return { ok: false, error: err };
        const dest = path.join(path.dirname(p), name);
        if (P.key(dest) !== P.key(p) && fs.existsSync(dest)) return { ok: false, error: 'A file with that name already exists' };
        try { await fs.promises.rename(p, dest); }
        catch (e) { return { ok: false, error: e.code === 'EBUSY' || e.code === 'EPERM' ? 'The file is in use by another program' : e.message }; }
        const old = this.library.remove(p);
        const e = this.library.upsert(dest);
        this.library.notify(e ? [e] : [], old ? [old] : []);
        return { ok: true, path: dest, moves: [{ from: p, to: dest }] };
    }

    /** Re-key index entries under a renamed directory without touching disk. */
    _remapDirInIndex(fromDir, toDir) {
        const prefix = P.key(fromDir) + path.sep;
        const moved = [];
        // Directory metadata (used for tree + reconcile) follows the rename.
        const fromRel = P.toRel(this.root, fromDir), toRel = P.toRel(this.root, toDir);
        for (const [k, v] of [...this.library.dirs]) {
            if (k === fromRel || k.startsWith(fromRel + '/')) { this.library.dirs.delete(k); this.library.dirs.set(toRel + k.slice(fromRel.length), { ...v, m: 0 }); }
        }
        this.library._ensureDirChain(toRel);
        for (const [k, e] of [...this.library.entries]) {
            if (!k.startsWith(prefix)) continue;
            const to = path.join(toDir, path.resolve(e.path).slice(path.resolve(fromDir).length));
            this.library.entries.delete(k);
            const ne = this.library._makeEntry(to, { size: e.size, mtimeMs: e.mtime });
            this.library.entries.set(P.key(to), ne);
            moved.push({ from: e.path, to });
        }
        this.library._invalidate();
        this.library.emit('changed', { reset: true });
        return moved;
    }
}

module.exports = { FileOps };
