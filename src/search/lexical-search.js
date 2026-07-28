'use strict';

/**
 * Pure, side-effect-free lexical (conventional) search for the SoundVault
 * sound library. Electron/IPC-free so it can be unit-tested in plain Node.
 *
 * This module replaces the old in-handler substring search in `src/main.js`
 * (`search-all-sounds`) which matched the WHOLE query as a single literal
 * substring against `name`/`folder`/`topLevel`. That approach returned ZERO
 * results for very common two-word queries such as `"kick drum"` whenever the
 * two words were not adjacent and in the same field — e.g. a file
 * `drum_kick_soft.wav` or `kick.wav` living under a `Drums/` folder.
 *
 * The new algorithm:
 *   1. Tokenizes the query and each document field on whitespace plus the
 *      filename separators `_ - . ( ) [ ]`.
 *   2. Requires ALL query tokens to match (logical AND) — precise, avoids the
 *      excessive false positives an OR strategy would introduce.
 *   3. Matches each query token against document tokens at three rising
 *      weights: exact (3) > prefix (2) > substring (1). A `name` match beats a
 *      `folder` match beats a `topLevel` match (small field bonus).
 *   4. Ranks results by total score (desc), tie-broken by recency (dateAdded).
 */

const SEP_RE = /[\s_.\-()()\[\]]+/;

function tokenize(str) {
    if (!str) return [];
    return String(str)
        .toLowerCase()
        .split(SEP_RE)
        .map(t => t.trim())
        .filter(t => t.length > 0);
}

// Per-field weight bonus applied on top of the match-quality weight.
const FIELD_WEIGHTS = { name: 6, folder: 3, topLevel: 2 };
const MATCH_WEIGHTS = { exact: 3, prefix: 2, substring: 1 };

function bestTokenMatch(qt, docTokens) {
    let best = 0;
    for (let i = 0; i < docTokens.length; i++) {
        const dt = docTokens[i];
        let w = 0;
        if (dt === qt) w = MATCH_WEIGHTS.exact;
        else if (dt.startsWith(qt)) w = MATCH_WEIGHTS.prefix;
        else if (dt.includes(qt)) w = MATCH_WEIGHTS.substring;
        if (w > best) best = w;
    }
    return best;
}

/**
 * Tokenized AND search over an in-memory sound cache.
 *
 * @param {Array<{name?:string, folder?:string, topLevel?:string, dateAdded?:number}>} cache
 *        Sound entries as built by `initSoundCache()` in main.js.
 * @param {string} query Raw user query.
 * @param {object} [opts]
 * @param {number} [opts.limit=200] Max results to return.
 * @param {boolean} [opts.preserveOrder=false] If true and no query tokens,
 *        return cache unchanged (used for empty-query resets).
 * @returns {Array<object>} Ranked results (cache entries, decorated with a
 *          numeric `score`).
 */
function searchSounds(cache, query, opts = {}) {
    const limit = opts.limit || 200;
    const qTokens = tokenize(query);

    if (!cache || cache.length === 0) return [];
    if (qTokens.length === 0) return [];

    const fields = ['name', 'folder', 'topLevel'];
    // Pre-tokenize document fields once per entry to avoid repeated work in
    // the inner loop — also lets us reuse tokens across query tokens.
    const scored = [];
    for (let i = 0; i < cache.length; i++) {
        const entry = cache[i];
        const docTokens = {};
        for (const f of fields) docTokens[f] = tokenize(entry[f]);

        let total = 0;
        let allMatch = true;
        for (const qt of qTokens) {
            let best = 0;
            for (const f of fields) {
                const m = bestTokenMatch(qt, docTokens[f]);
                if (m > 0) best = Math.max(best, m + FIELD_WEIGHTS[f]);
            }
            if (best === 0) { allMatch = false; break; }
            total += best;
        }

        if (allMatch) {
            scored.push({ entry, score: total });
        }
    }

    // Relevance desc, then recency desc (matches the cache's default order).
    scored.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        const ad = a.entry.dateAdded || 0;
        const bd = b.entry.dateAdded || 0;
        return bd - ad;
    });

    const out = new Array(Math.min(limit, scored.length));
    for (let i = 0; i < out.length; i++) {
        const entry = scored[i].entry;
        // Decorate a shallow clone so the IPC handler / renderer can read a
        // relevance score without mutating the shared cache objects.
        out[i] = Object.assign({}, entry, { score: scored[i].score });
    }
    return out;
}

/**
 * Reimplementation of the legacy `search-all-sounds` substring behaviour —
 * the WHOLE query lowercased as a single literal substring tested against
 * `name`/`folder`/`topLevel` with an implicit OR across fields.
 *
 * Kept as a named export purely so the regression test suite can prove the old
 * algorithm fails the multi-word cases the new one fixes.
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
    searchSounds,
    legacySubstringSearch,
    FIELD_WEIGHTS,
    MATCH_WEIGHTS,
};