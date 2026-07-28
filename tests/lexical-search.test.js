'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
    tokenize,
    searchSounds,
    legacySubstringSearch,
} = require('../src/search/lexical-search');

// Curated corpus that mirrors the shape of `initSoundCache()` entries.
// Paths are arbitrary; only name / folder / topLevel / dateAdded drive search.
function corpus() {
    return [
        { name: 'Kick_Drum_Hard.wav',      folder: 'Drums/Kicks',    topLevel: 'Drums',    dateAdded: 100 },
        { name: 'drum_kick_soft.wav',       folder: 'Drums',          topLevel: 'Drums',    dateAdded: 200 },
        { name: 'kick.wav',                 folder: 'Drums/Soft',     topLevel: 'Drums',    dateAdded: 150 },
        { name: 'vocal_dry_01.wav',         folder: 'Vox',             topLevel: 'Vocals',   dateAdded: 300 },
        { name: 'Synth_Lead_Warm.wav',      folder: 'Synths/Leads',   topLevel: 'Synths',   dateAdded: 250 },
        { name: 'synth-pad-evolving.wav',   folder: 'Synths',         topLevel: 'Synths',   dateAdded: 180 },
        { name: 'rain_hard_loop.wav',       folder: 'Ambience',       topLevel: 'Ambience', dateAdded: 90 },
        { name: 'forest_rain_light.wav',    folder: 'Ambience/Rain',  topLevel: 'Ambience', dateAdded: 120 },
        { name: 'README.txt',               folder: '',              topLevel: 'Docs',     dateAdded: 1 },
    ];
}

test('tokenize splits on whitespace and filename separators', () => {
    assert.deepEqual(tokenize('kick drum'), ['kick', 'drum']);
    assert.deepEqual(tokenize('Kick_Drum_01.wav'), ['kick', 'drum', '01', 'wav']);
    assert.deepEqual(tokenize('  synth-pad(evolving) '), ['synth', 'pad', 'evolving']);
    assert.deepEqual(tokenize(''), []);
    assert.deepEqual(tokenize(null), []);
    assert.deepEqual(tokenize('...---___'), []);
});

test('REGRESSION: legacy substring search returns NOTHING for two-word queries that are not adjacent in one field', () => {
    // The reported bug: queries like "kick drum" return 0 results even though
    // perfectly-matching files exist, because legacy treats the whole query
    // as one literal substring and requires it inside a single field.
    const c = corpus();
    const hits = legacySubstringSearch(c, 'kick drum');
    assert.equal(hits.length, 0, 'expected the legacy algorithm to fail here (regression anchor)');

    assert.equal(legacySubstringSearch(c, 'synth lead').length, 0);
    assert.equal(legacySubstringSearch(c, 'vocal dry').length, 0);
});

test('two-word queries match across fields and out-of-order tokens (the fix)', () => {
    const c = corpus();
    const hits = searchSounds(c, 'kick drum');
    assert.equal(hits.length, 3, 'all three kick/drum files should match');
    assert.ok(hits.some(h => h.name === 'Kick_Drum_Hard.wav'));
    assert.ok(hits.some(h => h.name === 'drum_kick_soft.wav')); // reversed order in filename
    assert.ok(hits.some(h => h.name === 'kick.wav'));          // "drum" matches folder Drums
});

test('ranking prefers exact name matches over folder/topLevel matches', () => {
    const c = corpus();
    const hits = searchSounds(c, 'kick drum');
    // Exact-name hit (Kick_Drum_Hard) should outrank folder-only hit (kick.wav
    // whose "drum" token only matches the folder "Drums").
    const hardIdx = hits.findIndex(h => h.name === 'Kick_Drum_Hard.wav');
    const softIdx = hits.findIndex(h => h.name === 'drum_kick_soft.wav');
    const folderOnlyIdx = hits.findIndex(h => h.name === 'kick.wav');
    assert.ok(hardIdx < folderOnlyIdx, 'exact name hit should rank above folder-only hit');
    assert.ok(softIdx < folderOnlyIdx, 'two name matches should rank above a folder-only match');
});

test('query words split across field + filename still match (cross-field AND)', () => {
    const c = corpus();
    const hits = searchSounds(c, 'synth lead');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].name, 'Synth_Lead_Warm.wav');
});

test('single-word prefix matching works (e.g. "vocal" matches "vocal_dry_01")', () => {
    const c = corpus();
    const hits = searchSounds(c, 'vocal');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].name, 'vocal_dry_01.wav');
});

test('rain matches both rain files via different fields', () => {
    const c = corpus();
    const hits = searchSounds(c, 'rain');
    assert.equal(hits.length, 2);
});

test('two-word "rain forest" matches the cross-token file even though no field contains both adjacent', () => {
    const c = corpus();
    // rain_hard_loop has "rain" in name; forest_rain_light has both tokens
    // split between name and folder. Both qualify under AND tokenization.
    const hits = searchSounds(c, 'rain forest');
    const names = hits.map(h => h.name);
    assert.ok(names.includes('forest_rain_light.wav'));
    assert.ok(!names.includes('rain_hard_loop.wav'), '"loop" file lacks the "forest" token');
});

test('AND semantics avoid excessive false positives', () => {
    const c = corpus();
    // "kick vocal" — no file has both, expect zero
    assert.equal(searchSounds(c, 'kick vocal').length, 0);
    // "synth drum" — no file has both
    assert.equal(searchSounds(c, 'synth drum').length, 0);
});

test('non-matching query returns empty', () => {
    const c = corpus();
    assert.equal(searchSounds(c, 'explosion').length, 0);
});

test('empty query returns empty (UI handles blank separately)', () => {
    const c = corpus();
    assert.equal(searchSounds(c, '').length, 0);
    assert.equal(searchSounds(c, '   ').length, 0);
});

test('limit caps the result set', () => {
    const big = [];
    for (let i = 0; i < 500; i++) big.push({ name: `kick_${i}.wav`, folder: 'Drums', topLevel: 'Drums', dateAdded: i });
    const hits = searchSounds(big, 'kick', { limit: 17 });
    assert.equal(hits.length, 17);
});

test('results are decorated with a numeric score and do not mutate cache entries', () => {
    const c = corpus();
    const before = JSON.stringify(c[0]);
    const hits = searchSounds(c, 'kick drum');
    assert.ok(typeof hits[0].score === 'number' && hits[0].score > 0);
    assert.equal(JSON.stringify(c[0]), before, 'cache entry objects must not be mutated');
});

test('handles empty cache and null query safely', () => {
    assert.deepEqual(searchSounds([], 'kick'), []);
    assert.deepEqual(searchSounds(null, 'kick'), []);
    assert.deepEqual(searchSounds(corpus(), null), []);
});

test('case-insensitive', () => {
    const c = corpus();
    assert.equal(searchSounds(c, 'KICK DRUM').length, 3);
    assert.equal(searchSounds(c, 'SyNtH lEaD').length, 1);
});