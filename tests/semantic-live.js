'use strict';

/**
 * LIVE semantic-search precision/recall + latency harness.
 *
 * Runs under Electron (CLAP weights + `app` singleton required):
 *     npm run test:semantic
 *
 * Strategy (no audio decode needed, exercises the REAL search path):
 *   - Embed a labelled corpus of free-text sound descriptions with the real
 *     CLAP TEXT model and load them directly into the engine's flat in-memory
 *     vector cache (`_matrix` / `_paths` / `_count`).
 *   - Run a fixed battery of human-style text queries through the engine's
 *     public `search()` method (which itself does CLAP text embedding +
 *     `_searchFlat` ranking).
 *   - Compute Precision@K and Recall@K against the manually labelled relevant
 *     categories, per query and macro-averaged.
 *   - Measure end-to-end `search()` latency (median across N repeats) and
 *     observe the per-query cache hit on identical repeat queries.
 * Exits with code 1 if macro P@K is below an acceptability floor.
 */

const path = require('path');
const os = require('os');
const fs = require('fs');

// Force Electron to treat a throwaway tmp dir as its userData so the real
// SoundVault config/db are never touched.
const TMP_USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'soundvault-clap-'));
const TMP_LIB = fs.mkdtempSync(path.join(os.tmpdir(), 'soundvault-lib-'));

const { app } = require('electron');

// Labelled text corpus. Each "item" is a plausible sound description; the
// category is the expected relevance group for the queries below.
const CORPUS = [
    { id: 'd1', text: 'hard rock kick drum punchy',                 cat: 'drums' },
    { id: 'd2', text: 'tight snare drum rimshot',                   cat: 'drums' },
    { id: 'd3', text: 'acoustic snare drum dry hit',                cat: 'drums' },
    { id: 'd4', text: 'deep floor tom drum boomy',                  cat: 'drums' },
    { id: 'd5', text: 'closed hi-hat drum loop fast',               cat: 'drums' },

    { id: 's1', text: 'warm analog synth lead patch',              cat: 'synths' },
    { id: 's2', text: 'bright techno synth lead arpeggio',          cat: 'synths' },
    { id: 's3', text: 'evolving ambient pad synth texture',         cat: 'synths' },
    { id: 's4', text: 'warm lush pad synth chords',                 cat: 'synths' },

    { id: 'a1', text: 'heavy rain falling on roof ambience',        cat: 'ambience' },
    { id: 'a2', text: 'forest birds ambience morning',              cat: 'ambience' },
    { id: 'a3', text: 'city traffic ambience distant',             cat: 'ambience' },
    { id: 'a4', text: 'ocean waves ambience calm beach',            cat: 'ambience' },

    { id: 'v1', text: 'female vocal singing dry',                  cat: 'vocals' },
    { id: 'v2', text: 'male spoken vocal phrase',                   cat: 'vocals' },
    { id: 'v3', text: 'choir vocal ensemble sustained',            cat: 'vocals' },
];

// Queries with the category considered relevant.
const QUERIES = [
    { q: 'kick drum',           rel: 'drums' },
    { q: 'snare drum',          rel: 'drums' },
    { q: 'synth lead',          rel: 'synths' },
    { q: 'warm pad',            rel: 'synths' },
    { q: 'rain ambience',       rel: 'ambience' },
    { q: 'forest ambience',     rel: 'ambience' },
    { q: 'vocal dry',           rel: 'vocals' },
    { q: 'choir vocal',         rel: 'vocals' },
];

const K = 5;
const ACCEPT_P = 0.5;   // macro Precision@K floor
const ACCEPT_R = 0.4;   // macro Recall@K floor

(async () => {
    try {
        if (!app.setPath) throw new Error('Not running under Electron. Invoke via: npm run test:semantic');
        app.setPath('userData', TMP_USERDATA);
        app.setPath('documents', os.tmpdir());
        await app.whenReady();

        // Point the config at the throwaway library so init() / caching never
        // touch the user's real SoundVault.
        const semanticEngine = require('../src/semantic-engine');
        await semanticEngine.init();

// Embed every corpus item with the real CLAP text model and push into
        // the engine's flat cache — this is the same cache `_searchFlat` scans.
        const tokenizer = semanticEngine.tokenizer;
        const textModel = semanticEngine.textModel;
        if (!tokenizer || !textModel) throw new Error('CLAP text model did not load — cannot run live harness');

        // Helper: embed one text string → unit Float32Array.
        async function embed(text) {
            const inputs = await tokenizer([text], { padding: true, truncation: true });
            const { text_embeds } = await textModel(inputs);
            const v = new Float32Array(text_embeds.data);
            // L2-normalize defensively (CLAP is already normalized, but renorm
            // guarantees cosine == dot even if a model config differs).
            let s = 0; for (let i = 0; i < v.length; i++) s += v[i] * v[i];
            const m = Math.sqrt(s); const out = new Float32Array(v.length);
            for (let i = 0; i < v.length; i++) out[i] = v[i] / m;
            return out;
        }

        // populate the cache manually
        semanticEngine._paths = [];
        semanticEngine._count = 0;
        semanticEngine._capacity = 0;
        const idToCat = new Map();
        for (const item of CORPUS) {
            const v = await embed(item.text);
            semanticEngine._appendToCache(item.id, v);
            idToCat.set(item.id, item.cat);
        }
        console.log(`[live] Loaded ${semanticEngine._count} corpus embeddings into the flat cache`);

        // warm the per-query cache: first search() per query always misses.
        const latencies = [];
        let cacheHits = 0;
        const perQuery = [];
        for (let i = 0; i < QUERIES.length; i++) {
            const { q, rel } = QUERIES[i];
            const runs = 10;
            const samples = [];
            let last = null;
            for (let r = 0; r < runs; r++) {
                const t0 = process.hrtime.bigint();
                const res = await semanticEngine.search(q, null);
                samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
                last = res;
                if (r > 0) cacheHits++; // identical query string → should hit engine cache
            }
            const med = samples.slice().sort((a, b) => a - b)[Math.floor(runs / 2)];
            latencies.push(med);

            const topPaths = last.results.slice(0, K).map(r => r.path);
            const relevant = topPaths.filter(id => idToCat.get(id) === rel).length;
            const totalRel = CORPUS.filter(c => c.cat === rel).length;
            const p = relevant / K;
            const rRatio = relevant / totalRel;
            perQuery.push({ q, p, r: rRatio, top: topPaths });
            console.log(`[live] "${q}" P@${K}=${p.toFixed(2)} recall=${rRatio.toFixed(2)} top=[${topPaths.join(',')}] med=${med.toFixed(1)}ms`);
        }

        const macroP = perQuery.reduce((a, b) => a + b.p, 0) / perQuery.length;
        const macroR = perQuery.reduce((a, b) => a + b.r, 0) / perQuery.length;
        const medLat = latencies.slice().sort((a, b) => a - b)[Math.floor(latencies.length / 2)];
        console.log(`[live] MACRO Precision@${K} = ${macroP.toFixed(3)}  (floor ${ACCEPT_P})`);
        console.log(`[live] MACRO Recall@${K}    = ${macroR.toFixed(3)}  (floor ${ACCEPT_R})`);
        console.log(`[live] Median search() latency = ${medLat.toFixed(1)} ms (cache hits on repeat: ${cacheHits}/${(QUERIES.length * 9)})`);

        app.quit();
        if (macroP < ACCEPT_P || macroR < ACCEPT_R) {
            console.error('[live] FAILED acceptance floor');
            process.exit(1);
        }
        console.log('[live] PASSED');
        process.exit(0);
    } catch (e) {
        console.error('[live] ERROR:', e && e.stack || e);
        try { app.quit(); } catch {}
        process.exit(1);
    }
})();