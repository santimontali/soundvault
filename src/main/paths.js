'use strict';
/**
 * Path helpers shared by the library index and file operations.
 * Pure (fs only for existence checks) so they are unit-testable.
 */
const fs = require('fs');
const path = require('path');

const AUDIO_EXT = '.wav';
const IGNORED_DIRS = new Set(['node_modules', '.git', '$recycle.bin', 'system volume information']);

function isAudioFile(name) {
    return typeof name === 'string' && name.toLowerCase().endsWith(AUDIO_EXT) && !name.startsWith('~$');
}

function isIgnoredDir(name) {
    return IGNORED_DIRS.has(String(name).toLowerCase());
}

/** Normalized comparison key (Windows paths are case-insensitive). */
function key(p) {
    const n = path.resolve(p);
    return process.platform === 'win32' ? n.toLowerCase() : n;
}

/** True when `p` is `root` itself or lies inside it (no `..` escapes). */
function isInside(root, p) {
    if (!root || !p) return false;
    const rel = path.relative(path.resolve(root), path.resolve(p));
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Library-relative path using forward slashes ('' for the root). */
function toRel(root, p) {
    const rel = path.relative(root, p);
    return rel.split(path.sep).join('/');
}

/** Absolute path from a library-relative path; throws if it would escape the root. */
function fromRel(root, rel) {
    const clean = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
    const abs = path.resolve(root, ...clean.split('/').filter(Boolean));
    if (!isInside(root, abs)) throw new Error('Path escapes the library');
    return abs;
}

const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
// eslint-disable-next-line no-control-regex
const INVALID_CHARS = /[<>:"/\\|?*\u0000-\u001f]/;

/**
 * Validate a single file/folder name segment for Windows + POSIX.
 * @returns {string|null} Error message, or null when valid.
 */
function validateName(name) {
    if (typeof name !== 'string') return 'Name is required';
    const n = name.trim();
    if (!n) return 'Name is required';
    if (n !== name) return 'Name cannot start or end with spaces';
    if (n === '.' || n === '..') return 'Invalid name';
    if (INVALID_CHARS.test(n)) return 'Name cannot contain < > : " / \\ | ? *';
    if (/[. ]$/.test(n)) return 'Name cannot end with a dot or space';
    if (RESERVED.test(n)) return `"${n}" is a reserved name on Windows`;
    if (n.length > 200) return 'Name is too long';
    return null;
}

/**
 * First non-existing path for `dir/base.ext`, appending " (2)", " (3)"…
 * `taken` lets callers reserve names within a batch before they exist.
 */
function uniquePath(dir, fileName, taken = new Set()) {
    const ext = path.extname(fileName);
    const base = path.basename(fileName, ext);
    let candidate = path.join(dir, fileName);
    let n = 2;
    while (fs.existsSync(candidate) || taken.has(key(candidate))) {
        candidate = path.join(dir, `${base} (${n})${ext}`);
        n++;
    }
    taken.add(key(candidate));
    return candidate;
}

module.exports = { AUDIO_EXT, IGNORED_DIRS, isAudioFile, isIgnoredDir, key, isInside, toRel, fromRel, validateName, uniquePath };
