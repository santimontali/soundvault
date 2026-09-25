'use strict';

/**
 * Pure, side-effect-free lexical (file-name) search for the SoundVault sound
 * library. Electron/IPC-free so it can be unit-tested in plain Node.
 *
 * Algorithm:
 *   1. Query → tokens (lower-cased, accents folded, split on anything that is
 *      not a letter or digit). English function words are ignored unless the
 *      query is made only of them ("the sound of rain" → rain).
 *   2. Documents are indexed richer than queries: plain tokens, camelCase and
 *      letter/digit splits ("WOODImpt" → wood, impt; "kick01" → kick, 01),
 *      the compound forms, and light English stems (explosions → explosion,
 *      whooshes → whoosh, raining → rain), so plurals and -ing forms match.
 *   3. Per query token the best field wins: exact/stem (3) > alias (2, e.g.
 *      UCS codes impact ↔ IMPT) > prefix (2) > compound tail (1: "wood" in
 *      "firewood", but never "rain" in "train"/"grain"), plus a field bonus
 *      name (6) > folder (3) > top-level (2).
 *   4. ALL tokens must match. When a multi-word query has no full match
 *      ("sword swing"), entries matching most of the words are returned
 *      instead, flagged `partial` so the UI can say so.
 *   5. Ranked by score, then recency, then name. Only the requested `limit`
 *      is sorted (heap selection), so one-letter-ish queries stay cheap.
 */

const SPLIT_RE = /[^\p{L}\p{N}]+/u;
const fold = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '');

const STOP = new Set('a an the of on in at to for with and or by from into onto sound sounds sfx fx'.split(' '));

// Common library abbreviations (UCS category codes and friends), by stem.
const ALIAS_GROUPS = [
    ['impact', 'impt'], ['whoosh', 'whsh', 'swoosh'], ['explosion', 'expl', 'explo'], ['ambience', 'ambient', 'amb', 'ambi', 'atmos', 'atmo'],
    ['designed', 'dsgn'], ['weapon', 'wpn'], ['vehicle', 'veh'], ['creature', 'crea', 'creat'], ['metal', 'mtl', 'metallic'],
    ['water', 'wtr'], ['voice', 'vox', 'vocal'], ['footstep', 'fs', 'ftsp'], ['gunshot', 'gun'],
    ['foley', 'foly'], ['user interface', 'ui', 'gui'], ['electric', 'elec'], ['mechanical', 'mech'], ['magic', 'mgc'],
    ['destruction', 'dstr', 'destr'], ['glass', 'gls'], ['scifi', 'sci'],
];
const ALIASES = new Map();
for (const g of ALIAS_GROUPS) for (const a of g) ALIASES.set(a, g.filter(x => x !== a && !x.includes(' ')));

/** Light English stemmer for plural / -ing / -ed forms (applied to query and documents alike). */
function stem(t) {
    if (t.length <= 3 || /\d/.test(t)) return t;
    if (t.length > 5 && t.endsWith('ing')) return undouble(t.slice(0, -3));
    if (t.length > 4 && t.endsWith('ied')) return t.slice(0, -3) + 'y';
    if (t.length > 4 && t.endsWith('ed') && !t.endsWith('eed')) return undouble(t.slice(0, -2));
    if (t.length > 4 && t.endsWith('ies')) return t.slice(0, -3) + 'y';
    if (/(ss|us|is)$/.test(t)) return t;
    if (/(sh|ch|x|z|ss)es$/.test(t)) return t.slice(0, -2);
    if (t.endsWith('s')) return t.slice(0, -1);
    return t;
}
function undouble(t) { return t.length > 3 && t[t.length - 1] === t[t.length - 2] && !/[aeiouls]/.test(t[t.length - 1]) ? t.slice(0, -1) : t; }

/** Query / generic tokenizer: lower-cased, accent-folded, order preserved. */
function tokenize(str) {
    if (str === null || str === undefined) return [];
    return fold(String(str).toLowerCase()).split(SPLIT_RE).filter(t => t.length > 0);
}

/** Document tokenizer: plain tokens + camelCase / letter-digit sub-tokens + stems. */
function docTokens(str) {
    if (!str) return [];
    const raw = String(str);
    const spaced = raw
        .replace(/([a-z])([A-Z])/g, '$1 $2')          // camelCase
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')     // ACRONYMWord
        .replace(/(\p{L})(\p{N})/gu, '$1 $2')          // kick01
        .replace(/(\p{N})(\p{L})/gu, '$1 $2');         // 01kick
    const out = new Set(tokenize(raw));
    for (const t of tokenize(spaced)) out.add(t);
    for (const t of [...out]) { const s = stem(t); if (s !== t) out.add(s); }
    return [...out];
}

function fieldIndex(tokens) {
    return { set: new Set(tokens), str: ' ' + tokens.join(' ') + ' ', list: tokens };
}

function tokenizeEntry(entry) {
    return {
        name: fieldIndex(docTokens(entry.name)),
        folder: fieldIndex(docTokens(entry.folder)),
        topLevel: fieldIndex(docTokens(entry.topLevel)),
    };
}

// Per-field weight bonus applied on top of the match-quality weight.
const FIELD_WEIGHTS = { name: 6, folder: 3, topLevel: 2 };
const MATCH_WEIGHTS = { exact: 3, alias: 2, prefix: 2, substring: 1 };
const FIELDS = ['name', 'folder', 'topLevel'];

function matchWeight(q, f) {
    if (f.set.has(q.t) || f.set.has(q.stem)) return MATCH_WEIGHTS.exact;
    if (q.alts) for (const a of q.alts) if (f.set.has(a)) return MATCH_WEIGHTS.alias;
    if (f.str.includes(' ' + q.t)) return MATCH_WEIGHTS.prefix;
    if (q.bare && f.str.includes(' ' + q.bare)) return MATCH_WEIGHTS.prefix;      // slide → sliding, close → closing
    // Compound tail ("wood" in "firewood", "shot" in "gunshot"), never a
    // stray infix ("rain" in "train", "ice" in "voice").
    if (q.t.length >= 4 && f.str.includes(q.t)) {
        for (const tok of f.list) { const i = tok.indexOf(q.t, 3); if (i >= 3) return MATCH_WEIGHTS.substring; }
    }
    return 0;
}

function queryTerms(query) {
    let toks = [...new Set(tokenize(query))];
    const content = toks.filter(t => !STOP.has(t));
    if (content.length) toks = content;
    return toks.map(t => {
        const s = stem(t);
        return { t, stem: s, alts: ALIASES.get(s) || ALIASES.get(t) || null, bare: t.length >= 5 && t.endsWith('e') ? t.slice(0, -1) : null };
    });
}

/** Keep the best `k` of `arr` by `better(a, b) < 0` without sorting everything. */
function selectTop(arr, k, cmp) {
    if (arr.length <= k) return arr.sort(cmp);
    // binary min-heap on the "worst kept" element
    const h = [];
    const up = i => { while (i > 0) { const p = (i - 1) >> 1; if (cmp(h[i], h[p]) <= 0) break; [h[i], h[p]] = [h[p], h[i]]; i = p; } };
    const down = i => { for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < h.length && cmp(h[l], h[m]) > 0) m = l; if (r < h.length && cmp(h[r], h[m]) > 0) m = r; if (m === i) return; [h[i], h[m]] = [h[m], h[i]]; i = m; } };
    for (const x of arr) {
        if (h.length < k) { h.push(x); up(h.length - 1); }
        else if (cmp(x, h[0]) < 0) { h[0] = x; down(0); }
    }
    return h.sort(cmp);
}

/**
 * Tokenized AND search over an in-memory sound list.
 *
 * @param {Array<{name?:string, folder?:string, topLevel?:string, mtime?:number, dateAdded?:number, _tokens?:object}>} cache
 * @param {string} query Raw user query.
 * @param {object} [opts]
 * @param {number} [opts.limit=200] Max results to return.
 * @param {boolean} [opts.partial=true] Append partial matches when full matches are few.
 * @returns {Array<object>} Ranked results (shallow clones decorated with `score`, and `partial` when applicable).
 */
function searchSounds(cache, query, opts = {}) {
    const limit = opts.limit || 200;
    if (!cache || cache.length === 0) return [];
    const q = queryTerms(query);
    if (!q.length || q.reduce((n, x) => n + x.t.length, 0) < 2) return [];
    const n = q.length;
    const needPartial = n >= 2 && opts.partial !== false ? Math.ceil(n / 2) : n + 1;
    const full = [], partial = [];
    for (let i = 0; i < cache.length; i++) {
        const entry = cache[i];
        const idx = entry._tokens && entry._tokens.name && entry._tokens.name.list ? entry._tokens : tokenizeEntry(entry);
        let total = 0, matched = 0;
        for (let j = 0; j < n; j++) {
            let best = 0;
            for (const f of FIELDS) {
                const m = matchWeight(q[j], idx[f]);
                if (m > 0 && m + FIELD_WEIGHTS[f] > best) best = m + FIELD_WEIGHTS[f];
            }
            if (best) { total += best; matched++; }
            else if (n - j - 1 + matched < needPartial) break;         // cannot reach a partial match any more
        }
        if (matched === n) full.push({ entry, score: total });
        else if (matched >= needPartial) partial.push({ entry, score: total, matched });
    }
    const recency = e => e.mtime || e.dateAdded || 0;
    const cmp = (a, b) => (b.score - a.score) || (recency(b.entry) - recency(a.entry)) || String(a.entry.name).localeCompare(String(b.entry.name));
    const out = selectTop(full, limit, cmp).map(s => Object.assign({}, s.entry, { score: s.score }));
    // Natural phrases rarely appear verbatim in file names: when nothing matches
    // every word, show the entries that match most of them (flagged partial).
    if (!out.length && partial.length) {
        const pcmp = (a, b) => (b.matched - a.matched) || cmp(a, b);
        for (const s of selectTop(partial, limit - out.length, pcmp)) out.push(Object.assign({}, s.entry, { score: s.score, partial: true }));
    }
    return out;
}

/**
 * Reimplementation of the legacy `search-all-sounds` substring behaviour,
 * the WHOLE query lowercased as a single literal substring tested against
 * `name`/`folder`/`topLevel` with an implicit OR across fields.
 * Kept only so the regression suite can prove the old algorithm failed the
 * multi-word cases the new one fixes.
 */
function legacySubstringSearch(cache, query, limit = 200) {
    if (!cache || cache.length === 0) return [];
    const ql = String(query || '').toLowerCase();
    if (!ql) return [];
    const maxResults = limit || 200;
    const results = [];
    for (const c of cache) {
        if (
            String(c.name || '').toLowerCase().includes(ql) ||
            String(c.folder || '').toLowerCase().includes(ql) ||
            String(c.topLevel || '').toLowerCase().includes(ql)
        ) {
            results.push(c);
            if (results.length >= maxResults) break;
        }
    }
    return results;
}

module.exports = {
    tokenize,
    docTokens,
    tokenizeEntry,
    searchSounds,
    legacySubstringSearch,
    stem,
    FIELD_WEIGHTS,
    MATCH_WEIGHTS,
};
