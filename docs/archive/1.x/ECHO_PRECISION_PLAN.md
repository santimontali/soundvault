# SoundVault: Echo Precision Plan

## Context

Echo Vault search suffers from false positives (ambiences, tails from unrelated sounds) caused by two issues:
1. CLAP max-pooling for long files inflates embeddings, making them match too many queries.
2. No filtering of candidates that pass the CLAP coarse filter but have weak spectral matches.

This plan has two phases. Phase A is urgent (pre-presentation, runtime-only, no re-index). Phase B is post-presentation (requires re-index).

---

## PHASE A: Adaptive Spectral Gate (implement now)

**File**: `src/semantic-engine.js`  
**Impact**: Runtime only. No re-indexing needed. Works immediately with existing DB.

### Edit 1: Change `const` to `let` in `echoSearch`

On line 884, change:
```javascript
        const results = [];
```
to:
```javascript
        let results = [];
```

### Edit 2: Insert adaptive gate in `echoSearch`

Between line 915 (`results.sort(...)`) and line 917 (`// ── Phase 4: Rank-Normalization`), insert this block:

```javascript

        // ── Adaptive Spectral Gate ──
        // Filter out bottom quartile by spectral score.
        // Percentile-based: adapts to query type (tight transients produce high gate,
        // diffuse tails/ambiences produce permissive gate). Floor at 0.15 absolute.
        if (results.length > 4) {
            const p25 = results[Math.floor(results.length * 0.75)].spectralScore; // sorted desc, so index 75% = P25
            const gate = Math.max(p25, 0.15);
            const beforeGate = results.length;
            results = results.filter(r => r.spectralScore >= gate);
            if (results.length < beforeGate) {
                console.log(`[Echo] Adaptive gate: ${gate.toFixed(3)} (P25), removed ${beforeGate - results.length}/${beforeGate} candidates`);
            }
        }

```

The surrounding code after insertion should read:
```
        results.sort((a, b) => b.spectralScore - a.spectralScore);

        // ── Adaptive Spectral Gate ──
        // ... (new block) ...

        // ── Phase 4: Rank-Normalization for Score Calibration ──
```

### Edit 3: Change `const` to `let` in `echoFile`

On line 1003, change:
```javascript
        const results = [];
```
to:
```javascript
        let results = [];
```

### Edit 4: Insert adaptive gate in `echoFile`

Between line 1029 (`results.sort(...)`) and the Phase 4 comment block, insert the same gate block:

```javascript

        // ── Adaptive Spectral Gate ──
        if (results.length > 4) {
            const p25 = results[Math.floor(results.length * 0.75)].spectralScore;
            const gate = Math.max(p25, 0.15);
            const beforeGate = results.length;
            results = results.filter(r => r.spectralScore >= gate);
            if (results.length < beforeGate) {
                console.log(`[Echo] Adaptive gate: ${gate.toFixed(3)} (P25), removed ${beforeGate - results.length}/${beforeGate} candidates`);
            }
        }

```

The surrounding code after insertion should read:
```
        // Rank-normalize spectral scores
        results.sort((a, b) => b.spectralScore - a.spectralScore);

        // ── Adaptive Spectral Gate ──
        // ... (new block) ...

        // ── Phase 4: Rank-Normalization for Score Calibration ──
```

### Verification

After implementing, restart SoundVault and trigger an Echo search. Console should show:
```
[Echo] Adaptive gate: 0.XXX (P25), removed N/M candidates
```

---

## PHASE B: Mean-Pool CLAP Aggregation (implement post-presentation)

**File**: `src/indexing-worker.js`  
**Impact**: Changes how CLAP embeddings are computed for files >10s. Requires re-indexing.

### Edit 5: Replace max-pool with mean-pool in `processClapBatch`

In `processClapBatch`, replace the `else` block (lines 144-169), the entire block from `// Long file, strategic sampling + max-pooling` through the closing of the `if (offsets.length > 1)` log.

Replace:
```javascript
            } else {
                // Long file: strategic sampling + max-pooling
                const offsets = selectClapOffsets(totalSamples, CLAP_WINDOW);
                const maxPool = new Float32Array(DIM).fill(-Infinity);

                for (const offset of offsets) {
                    const chunk = audioData.subarray(offset, offset + CLAP_WINDOW);
                    const inputs = await processor(chunk);
                    const { audio_embeds } = await audioModel(inputs);
                    const embed = audio_embeds.data;

                    for (let d = 0; d < DIM; d++) {
                        if (embed[d] > maxPool[d]) maxPool[d] = embed[d];
                    }
                }

                // L2-normalize the max-pooled vector
                let norm = 0;
                for (let d = 0; d < DIM; d++) norm += maxPool[d] * maxPool[d];
                norm = Math.sqrt(norm) || 1;
                for (let d = 0; d < DIM; d++) maxPool[d] /= norm;

                finalVector = maxPool;
                if (offsets.length > 1) {
                    console.log(`[IndexWorker] CLAP sampled: ${offsets.length} segments for ${path.basename(file.path)} (${(totalSamples/48000).toFixed(1)}s)`);
                }
```

With:
```javascript
            } else {
                // Long file: strategic sampling + mean-pooling
                const offsets = selectClapOffsets(totalSamples, CLAP_WINDOW);
                const meanPool = new Float32Array(DIM);

                for (const offset of offsets) {
                    const chunk = audioData.subarray(offset, offset + CLAP_WINDOW);
                    const inputs = await processor(chunk);
                    const { audio_embeds } = await audioModel(inputs);
                    const embed = audio_embeds.data;

                    for (let d = 0; d < DIM; d++) {
                        meanPool[d] += embed[d];
                    }
                }

                // Average
                const numChunks = offsets.length;
                for (let d = 0; d < DIM; d++) meanPool[d] /= numChunks;

                // L2-normalize
                let norm = 0;
                for (let d = 0; d < DIM; d++) norm += meanPool[d] * meanPool[d];
                norm = Math.sqrt(norm) || 1;
                for (let d = 0; d < DIM; d++) meanPool[d] /= norm;

                finalVector = meanPool;
                if (numChunks > 1) {
                    console.log(`[IndexWorker] CLAP mean-pooled: ${numChunks} segments for ${path.basename(file.path)} (${(totalSamples/48000).toFixed(1)}s)`);
                }
```

### Edit 6: Update comment header

On line 115, change:
```javascript
// Files ≤10s: single CLAP inference. Files >10s: strategic sampling + max-pooling.
```
to:
```javascript
// Files ≤10s: single CLAP inference. Files >10s: strategic sampling + mean-pooling.
```

### Post-Phase B: Re-indexing

After implementing Edit 5 and Edit 6:
1. Close SoundVault.
2. Delete `soundvault-semantic.db` (and `.db-wal`, `.db-shm` if present) from the app userData directory.
3. Relaunch SoundVault and run "Catalog Library" to re-index from scratch with mean-pooled embeddings.

The spectral pass will also re-run since the DB was deleted. This is the cleanest path, the full re-index with the 3-tier system (Quick → Deep → Spectral) ensures all data is consistent.

---

## Summary

| Phase | File | What changes | Re-index? | When |
|-------|------|-------------|-----------|------|
| A (Edits 1-4) | `semantic-engine.js` | Adaptive spectral gate in `echoSearch` + `echoFile` | No | Now |
| B (Edits 5-6) | `indexing-worker.js` | max-pool → mean-pool in `processClapBatch` | Yes | Post-presentation |
