'use strict';
// House style: the em dash and the en dash never appear in the project's own
// text (UI copy, docs, comments). Test data that needs them uses escapes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SKIP = new Set(['node_modules', 'dist', 'build-assets', '.git', '.claude', 'build']);
const EXT = new Set(['.js', '.mjs', '.cjs', '.css', '.html', '.md', '.json', '.txt', '.yml', '.lua']);
const BANNED = [String.fromCharCode(0x2014), String.fromCharCode(0x2013)];

function* files(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) { if (!SKIP.has(e.name)) yield* files(path.join(dir, e.name)); continue; }
        if (EXT.has(path.extname(e.name).toLowerCase()) || e.name === '.gitignore' || e.name === '_headers') yield path.join(dir, e.name);
    }
}

test('no stray control characters in text files (a mangled escape such as a backspace)', () => {
    const hits = [];
    for (const f of files(ROOT)) {
        const s = fs.readFileSync(f, 'utf8');
        for (let i = 0; i < s.length; i++) {
            const c = s.charCodeAt(i);
            if (c < 32 && c !== 9 && c !== 10 && c !== 13) { hits.push(`${path.relative(ROOT, f)} (char ${c} at ${i})`); break; }
        }
    }
    assert.deepEqual(hits, []);
});

test('no em or en dashes in the project', () => {
    const hits = [];
    for (const f of files(ROOT)) {
        const lines = fs.readFileSync(f, 'utf8').split('\n');
        lines.forEach((l, i) => { if (BANNED.some(ch => l.includes(ch))) hits.push(`${path.relative(ROOT, f)}:${i + 1}`); });
    }
    assert.deepEqual(hits, [], 'use colons, commas, periods or parentheses (and plain hyphens for ranges)');
});
