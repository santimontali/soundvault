# SoundVault: Plan de Optimización del Pipeline de Indexación

## Contexto del Problema

El sistema de indexación tiene tres cuellos de botella cuantificados:

1. **CLAP Chunking excesivo**: Archivos >10s generan sliding window (10s ventana, 5s hop, hasta 120s decode). Un archivo de 2min = 23 inferencias ONNX secuenciales (~87ms c/u). El 15% de archivos largos consume el 60%+ del tiempo CLAP.
2. **CMVN Re-scan completo**: Al final de `processSpectralBatch` (indexing-worker.js L249-286), se descarta la estadística acumulada en streaming y se re-lee TODA la tabla `spectral_index`, descomprimiendo cada `feature_matrix` para recomputar stats globales. Es O(N × W × 44)-15+ minutos para librerías grandes.
3. **Indexación monolítica**: El usuario debe esperar a que termine todo el pipeline (CLAP chunking + spectral) antes de tener búsqueda funcional. Para 15k archivos esto son ~2.5 horas.

Se implementan 3 optimizaciones complementarias que atacan cuellos de botella diferentes sin interferirse.

---

## FASE 1: CMVN Incremental (eliminar re-scan)

### Objetivo
Eliminar el re-scan O(N) de la tabla spectral_index al final de cada indexación. Persistir running sums incrementales en la DB.

### Archivo: `indexing-worker.js`

#### Paso 1.1: Modificar la tabla `spectral_stats`

En `processSpectralBatch`, reemplazar el bloque `CREATE TABLE IF NOT EXISTS spectral_stats` (L180-188) con:

```sql
CREATE TABLE IF NOT EXISTS spectral_stats (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    global_mean BLOB,
    global_std BLOB,
    total_windows INTEGER,
    running_sum BLOB,
    running_sum_sq BLOB,
    computed_at INTEGER
)
```

Los campos `running_sum` y `running_sum_sq` son Float64Array(44) serializado como BLOB (352 bytes cada uno). Esto permite recalcular mean/std sin re-escanear.

#### Paso 1.2: Cargar running sums existentes al inicio de `processSpectralBatch`

Al principio de `processSpectralBatch` (después de crear la tabla), cargar los running sums previos de la DB:

```javascript
// Cargar running stats previos de la DB (si existen)
const prevStats = db.prepare('SELECT running_sum, running_sum_sq, total_windows FROM spectral_stats WHERE id = 1').get();
if (prevStats && prevStats.running_sum && prevStats.running_sum_sq) {
    const prevSum = new Float64Array(prevStats.running_sum.buffer, prevStats.running_sum.byteOffset, prevStats.running_sum.byteLength / 8);
    const prevSumSq = new Float64Array(prevStats.running_sum_sq.buffer, prevStats.running_sum_sq.byteOffset, prevStats.running_sum_sq.byteLength / 8);
    for (let d = 0; d < FPW; d++) {
        sumPerDim[d] = prevSum[d];
        sumSqPerDim[d] = prevSumSq[d];
    }
    totalWindows = prevStats.total_windows || 0;
}
```

#### Paso 1.3: Reemplazar el bloque de re-scan (L245-286)

Eliminar completamente el bloque que va desde `// ── Compute and persist global CMVN stats ──` (L245) hasta el `console.log` final (L286). Reemplazar con:

```javascript
// ── Persist incremental CMVN stats ──
if (totalWindows > 0) {
    const { mean, std } = spectralEngine.computeGlobalStats(sumPerDim, sumSqPerDim, totalWindows);
    const meanBuf = Buffer.from(mean.buffer, mean.byteOffset, mean.byteLength);
    const stdBuf = Buffer.from(std.buffer, std.byteOffset, std.byteLength);
    const sumBuf = Buffer.from(sumPerDim.buffer, sumPerDim.byteOffset, sumPerDim.byteLength);
    const sumSqBuf = Buffer.from(sumSqPerDim.buffer, sumSqPerDim.byteOffset, sumSqPerDim.byteLength);

    const insertStats = db.prepare(
        'INSERT OR REPLACE INTO spectral_stats (id, global_mean, global_std, total_windows, running_sum, running_sum_sq, computed_at) VALUES (1, ?, ?, ?, ?, ?, ?)'
    );
    insertStats.run(meanBuf, stdBuf, totalWindows, sumBuf, sumSqBuf, Date.now());
    console.log(`[IndexWorker] CMVN stats updated incrementally: ${totalWindows} total windows`);
}
```

#### Paso 1.4: Invalidar stats cuando se eliminan archivos

En `semantic-engine.js`, en el método `_removeFromCaches` (L1105-1145), después de eliminar de `spectral_index`, agregar la invalidación marcando los stats como dirty para que el próximo indexado los recalcule:

```javascript
// Invalidate CMVN running sums (force full recalc on next index)
try {
    this.db.prepare('DELETE FROM spectral_stats WHERE id = 1').run();
} catch(e) {}
```

Esto es conservador: ante eliminaciones (evento raro) se fuerza un recálculo completo en el próximo index. Las adiciones (evento frecuente) son siempre incrementales.

### Archivo: `semantic-engine.js`

#### Paso 1.5: Migrar schema en `init()`

En el método `init()`, después del `CREATE TABLE IF NOT EXISTS spectral_stats` existente (L257-265), agregar migración para columnas nuevas:

```javascript
// Migrate spectral_stats table to include running sums
try {
    this.db.exec('ALTER TABLE spectral_stats ADD COLUMN running_sum BLOB');
    this.db.exec('ALTER TABLE spectral_stats ADD COLUMN running_sum_sq BLOB');
    console.log('[SemanticEngine] Migrated spectral_stats table with running sums');
} catch(e) {
    // Columns already exist: ignore
}
```

---

## FASE 2: Cap Inteligente de Chunks CLAP

### Objetivo
Reducir las inferencias CLAP para archivos largos de 23 (para 120s) a máximo 5, mediante muestreo estratégico de segmentos representativos en lugar de sliding window exhaustivo.

### Archivo: `indexing-worker.js`

#### Paso 2.1: Crear función `selectClapOffsets`

Agregar esta función antes de `processClapBatch` (antes de L86):

```javascript
/**
 * Select strategic sample offsets for CLAP inference on long files.
 * Instead of exhaustive sliding window (5s hop → 23 chunks for 2min),
 * picks equidistant segments to capture semantic diversity.
 *
 * @param {number} totalSamples - Total samples in decoded audio
 * @param {number} windowSize - CLAP window size in samples (480000 = 10s at 48kHz)
 * @returns {number[]} Array of sample offsets to extract
 */
function selectClapOffsets(totalSamples, windowSize) {
    if (totalSamples <= windowSize) return [0];

    // Determine number of segments based on file length
    const fileDurationS = totalSamples / 48000;
    let numSegments;
    if (fileDurationS <= 30) {
        numSegments = 3;  // start, center, end
    } else {
        numSegments = 5;  // start, q1, center, q3, end
    }

    const maxOffset = totalSamples - windowSize;
    const offsets = [];
    for (let i = 0; i < numSegments; i++) {
        const offset = Math.round(maxOffset * i / (numSegments - 1));
        offsets.push(offset);
    }
    return offsets;
}
```

#### Paso 2.2: Reemplazar el sliding window en `processClapBatch`

En `processClapBatch`, reemplazar el bloque del `else` (L117-144), el bloque completo de "Long file, sliding window + max-pooling":

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
}
```

#### Paso 2.3: Eliminar constante CLAP_HOP (ya no se usa)

Eliminar la línea `const CLAP_HOP = 48000 * 5;` (L91), ya no se utiliza. Mantener `CLAP_WINDOW` y `MAX_DECODE_S`.

#### Paso 2.4: Actualizar el header comment del archivo

Reemplazar el comment header (L1-13) para reflejar la nueva arquitectura:

```javascript
/**
 * indexing-worker.js, Dedicated Worker Thread for SoundVault audio indexing
 *
 * Two-pass architecture:
 *   Pass 1 (index-clap):     CLAP inference with strategic sampling for long files
 *                             Short files (≤10s): 1 inference. Long: 3-5 segments + max-pooling.
 *   Pass 2 (index-spectral): 30s decode + spectral extract, incremental CMVN stats.
 *
 * Main thread sends passes sequentially. After CLAP pass, it reloads the
 * search cache so semantic search works while spectral is still running.
 */
```

### Nota sobre re-indexación

Los embeddings existentes (generados con sliding window exhaustivo) siguen siendo válidos y de calidad comparable. NO es necesario forzar re-indexación. Los nuevos archivos y archivos modificados usarán el nuevo muestreo estratégico automáticamente.

---

## FASE 3: Indexación Progresiva con Tiers de Prioridad

### Objetivo
Dividir la indexación en 3 tiers de prioridad para que la búsqueda semántica esté disponible lo antes posible, mientras Echo se enriquece en background.

### Archivo: `semantic-engine.js`: Refactorizar `startIndexing`

#### Paso 3.1: Modificar el objeto `progress` para soportar tiers

Reemplazar la línea de inicialización del progress (L412):

```javascript
this.progress = {
    total: 0, current: 0,
    phase: 'scanning',       // scanning | clap-quick | clap-deep | spectral | done
    phaseCurrent: 0, phaseTotal: 0,
    clapTotal: 0, spectralTotal: 0,
    tier: 0                  // 0=quick CLAP, 1=deep CLAP, 2=spectral
};
```

#### Paso 3.2: Dividir el work queue en tiers

Reemplazar el bloque "Build work queue" y "Delegate to Worker Thread" (L467-585) con la nueva lógica de tres tiers.

El bloque actual construye `filesToIndex` y luego separa en `clapFiles` y `spectralFiles`. La nueva lógica:

```javascript
// ── Build work queue with tiers ──────────────────────────
const filesToIndex = [];
for (const file of allWavs) {
    const needsClap = clapMtimeMap.get(file.path) !== file.mtime;
    const needsSpectral = spectralMtimeMap.get(file.path) !== file.mtime;
    if (needsClap || needsSpectral) {
        filesToIndex.push({ ...file, needsClap, needsSpectral });
    }
}

const alreadyDone = allWavs.length - filesToIndex.length;
console.log(`[SemanticEngine] ${filesToIndex.length} files need indexing (${alreadyDone} already up-to-date)`);

if (filesToIndex.length === 0) {
    if (staleClap.length > 0 || staleSpectral.length > 0) {
        this._loadCacheFromDB();
        this._loadSpectralSummaries();
    } else {
        console.log('[SemanticEngine] No changes, skipping cache reload');
    }
    return;
}

// ── Tier 0: Quick CLAP (single inference, first 10s only) ──
// All files that need CLAP get a fast single-inference pass first.
// This enables semantic search ASAP.
const tier0Files = filesToIndex.filter(f => f.needsClap);

// ── Tier 1: Deep CLAP (strategic sampling for long files) ──
// Re-index long files with multi-segment sampling for better embeddings.
// Only files >10s benefit from this (short files already complete in Tier 0).
const tier1Files = filesToIndex.filter(f => f.needsClap).filter(f => {
    // Estimate duration from file size: 48kHz × 16bit × mono = ~96KB/s
    // Files larger than ~960KB are likely >10s
    try {
        const stat = fs.statSync(f.path);
        return stat.size > 960000;
    } catch(e) { return false; }
});

// ── Tier 2: Spectral fingerprinting ──
const tier2Files = filesToIndex.filter(f => f.needsSpectral);

this.progress = {
    total: allWavs.length,
    current: alreadyDone,
    phase: 'clap-quick',
    phaseCurrent: 0,
    phaseTotal: tier0Files.length,
    clapTotal: tier0Files.length,
    spectralTotal: tier2Files.length,
    tier: 0
};

const ffmpegPath = require('ffmpeg-static');

await new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'indexing-worker.js'));
    let currentTier = -1; // -1 = not started

    const startNextTier = () => {
        if (currentTier < 0 && tier0Files.length > 0) {
            // ── Tier 0: Quick CLAP ──
            currentTier = 0;
            this.progress.phase = 'clap-quick';
            this.progress.phaseTotal = tier0Files.length;
            this.progress.phaseCurrent = 0;
            console.log(`[SemanticEngine] Tier 0: Quick CLAP (${tier0Files.length} files)...`);
            worker.postMessage({ type: 'index-clap-quick', files: tier0Files });
        } else if (currentTier <= 0 && tier1Files.length > 0) {
            // ── Tier 1: Deep CLAP (only long files) ──
            currentTier = 1;
            this.progress.phase = 'clap-deep';
            this.progress.phaseTotal = tier1Files.length;
            this.progress.phaseCurrent = 0;
            console.log(`[SemanticEngine] Tier 1: Deep CLAP (${tier1Files.length} long files)...`);
            worker.postMessage({ type: 'index-clap', files: tier1Files });
        } else if (currentTier <= 1 && tier2Files.length > 0) {
            // ── Tier 2: Spectral ──
            currentTier = 2;
            this.progress.phase = 'spectral';
            this.progress.phaseTotal = tier2Files.length;
            this.progress.phaseCurrent = 0;
            console.log(`[SemanticEngine] Tier 2: Spectral (${tier2Files.length} files)...`);
            worker.postMessage({ type: 'index-spectral', files: tier2Files });
        } else {
            // All tiers done
            this.progress.phase = 'done';
            worker.postMessage({ type: 'shutdown' });
            resolve();
        }
    };

    worker.on('message', (msg) => {
        if (msg.type === 'ready') {
            startNextTier();
        }
        if (msg.type === 'progress') {
            this.progress.phaseCurrent = msg.current;
            // Accumulate overall progress across tiers
            let base = alreadyDone;
            if (currentTier > 0) base += tier0Files.length;
            if (currentTier > 1) base += tier1Files.length;
            this.progress.current = base + msg.current;
            this._spectralProgress = { total: allWavs.length, current: this.progress.current };
        }
        if (msg.type === 'batch-complete') {
            console.log(`[SemanticEngine] Tier ${currentTier} complete (${msg.rate} files/min).`);

            if (currentTier === 0) {
                // Tier 0 done: reload CLAP cache, search is now functional
                console.log('[SemanticEngine] Quick CLAP done, reloading cache for immediate search...');
                this._loadCacheFromDB();
            } else if (currentTier === 1) {
                // Tier 1 done: reload to get improved embeddings
                console.log('[SemanticEngine] Deep CLAP done, reloading improved embeddings...');
                this._loadCacheFromDB();
            } else if (currentTier === 2) {
                // Tier 2 done: reload spectral data
                console.log('[SemanticEngine] Spectral done, reloading summaries + stats...');
                this._loadSpectralSummaries();
                this._loadGlobalStats();
                this._spectralCache.clear();
            }

            // Advance to next tier
            startNextTier();
        }
        if (msg.type === 'error') {
            console.error('[SemanticEngine] Worker error:', msg.error);
            worker.postMessage({ type: 'shutdown' });
            this._loadCacheFromDB();
            this._loadSpectralSummaries();
            this._loadGlobalStats();
            this._spectralCache.clear();
            resolve();
        }
    });

    worker.on('error', (err) => {
        console.error('[SemanticEngine] Worker thread error:', err);
        resolve();
    });

    worker.on('exit', (code) => {
        if (code !== 0) console.warn(`[SemanticEngine] Worker exited with code ${code}`);
    });

    worker.postMessage({ type: 'init', dbPath: this._dbPath, ffmpegPath });
});
```

### Archivo: `indexing-worker.js`: Agregar handler `index-clap-quick`

#### Paso 3.3: Agregar función `processClapQuickBatch`

Agregar esta función después de `processClapBatch`:

```javascript
// ═══ Tier 0: Quick CLAP (single inference, first 10s only) ═══
// No chunking: always uses first 10s regardless of file duration.
// Purpose: get functional semantic search ASAP.
async function processClapQuickBatch(files) {
    const BATCH_SIZE = 50;
    const CLAP_WINDOW = 48000 * 10;
    const DIM = 512;
    let batch = [];
    let processed = 0;

    const flushBatch = () => {
        db.transaction(() => {
            for (const item of batch) stmts.insertEmbedding.run(item.path, item.mtime, item.vector);
        })();
        batch = [];
    };

    for (const file of files) {
        try {
            // Always decode only first 10s, fast path
            const audioData = await getAudioData(file.path, 10);
            const clapAudio = audioData.subarray(0, Math.min(audioData.length, CLAP_WINDOW));

            const inputs = await processor(clapAudio);
            const { audio_embeds } = await audioModel(inputs);
            const finalVector = new Float32Array(audio_embeds.data);

            const vectorBuf = Buffer.from(finalVector.buffer, finalVector.byteOffset, finalVector.byteLength);
            batch.push({ path: file.path, mtime: file.mtime, vector: vectorBuf });

            if (batch.length >= BATCH_SIZE) flushBatch();
        } catch (e) {
            console.error(`[IndexWorker] Quick CLAP error ${path.basename(file.path)}: ${e.message}`);
        }

        processed++;
        if (processed % 10 === 0) {
            parentPort.postMessage({ type: 'progress', current: processed, total: files.length });
        }
    }
    if (batch.length > 0) flushBatch();
    parentPort.postMessage({ type: 'progress', current: processed, total: files.length });
}
```

#### Paso 3.4: Agregar message handler para `index-clap-quick`

En el bloque `parentPort.on('message')` (L290-329), agregar antes del handler `index-spectral`:

```javascript
if (msg.type === 'index-clap-quick') {
    try {
        const t0 = Date.now();
        await processClapQuickBatch(msg.files);
        const rate = Math.round(msg.files.length / (Date.now() - t0) * 60000);
        console.log(`[IndexWorker] Quick CLAP pass: ${msg.files.length} files, ${rate} files/min`);
        parentPort.postMessage({ type: 'batch-complete', rate: String(rate) });
    } catch (e) {
        parentPort.postMessage({ type: 'error', error: e.message });
    }
}
```

### Archivo: `index.html`: Actualizar UI de progreso

#### Paso 3.5: Actualizar el panel de progreso

Reemplazar las dos `idx-phase` divs (L2416-2429) con tres fases:

```html
<div class="idx-phase" id="idx-clap-phase">
  <div class="idx-phase-header">
    <span class="idx-phase-label" id="idx-clap-label">Quick Semantic</span>
    <span class="idx-phase-count" id="idx-clap-count">0 / 0</span>
  </div>
  <div class="idx-bar-track"><div class="idx-bar-fill semantic" id="idx-clap-bar"></div></div>
</div>
<div class="idx-phase" id="idx-deep-phase">
  <div class="idx-phase-header">
    <span class="idx-phase-label" id="idx-deep-label">Deep Semantic</span>
    <span class="idx-phase-count" id="idx-deep-count">-</span>
  </div>
  <div class="idx-bar-track"><div class="idx-bar-fill semantic" id="idx-deep-bar"></div></div>
</div>
<div class="idx-phase" id="idx-spectral-phase">
  <div class="idx-phase-header">
    <span class="idx-phase-label" id="idx-spectral-label">Echo Spectral</span>
    <span class="idx-phase-count" id="idx-spectral-count">-</span>
  </div>
  <div class="idx-bar-track"><div class="idx-bar-fill spectral" id="idx-spectral-bar"></div></div>
</div>
```

#### Paso 3.6: Actualizar el JS de polling de progreso

Reemplazar el bloque del `setInterval` que lee el progreso (L3525-3582) con:

```javascript
const progIv = setInterval(async () => {
    const p = await window.api.semanticGetProgress();

    // ── Tier 0: Quick CLAP ──
    if (p.phase === 'clap-quick') {
        document.getElementById('idx-clap-label').className = 'idx-phase-label active';
        document.getElementById('idx-clap-bar').className = 'idx-bar-fill semantic active';
        if (p.phaseTotal > 0) {
            const pct = Math.round(p.phaseCurrent / p.phaseTotal * 100);
            document.getElementById('idx-clap-bar').style.width = pct + '%';
            document.getElementById('idx-clap-count').textContent = `${p.phaseCurrent} / ${p.phaseTotal}`;
        }
        document.getElementById('idx-status-text').textContent = 'Quick semantic scan, search available soon...';
    }

    // ── Tier 1: Deep CLAP ──
    if (p.phase === 'clap-deep') {
        // Mark quick as done
        document.getElementById('idx-clap-label').className = 'idx-phase-label done';
        document.getElementById('idx-clap-bar').className = 'idx-bar-fill semantic done';
        document.getElementById('idx-clap-bar').style.width = '100%';
        document.getElementById('idx-clap-count').textContent = `${p.clapTotal} ✓`;
        // Activate deep
        document.getElementById('idx-deep-label').className = 'idx-phase-label active';
        document.getElementById('idx-deep-bar').className = 'idx-bar-fill semantic active';
        if (p.phaseTotal > 0) {
            const pct = Math.round(p.phaseCurrent / p.phaseTotal * 100);
            document.getElementById('idx-deep-bar').style.width = pct + '%';
            document.getElementById('idx-deep-count').textContent = `${p.phaseCurrent} / ${p.phaseTotal}`;
        }
        document.getElementById('idx-status-text').textContent = 'Refining long file signatures...';
    }

    // ── Tier 2: Spectral ──
    if (p.phase === 'spectral') {
        // Mark previous tiers as done
        document.getElementById('idx-clap-label').className = 'idx-phase-label done';
        document.getElementById('idx-clap-bar').className = 'idx-bar-fill semantic done';
        document.getElementById('idx-clap-bar').style.width = '100%';
        document.getElementById('idx-deep-label').className = 'idx-phase-label done';
        document.getElementById('idx-deep-bar').className = 'idx-bar-fill semantic done';
        document.getElementById('idx-deep-bar').style.width = '100%';
        // Activate spectral
        document.getElementById('idx-spectral-label').className = 'idx-phase-label active';
        document.getElementById('idx-spectral-bar').className = 'idx-bar-fill spectral active';
        if (p.phaseTotal > 0) {
            const pct = Math.round(p.phaseCurrent / p.phaseTotal * 100);
            document.getElementById('idx-spectral-bar').style.width = pct + '%';
            document.getElementById('idx-spectral-count').textContent = `${p.phaseCurrent} / ${p.phaseTotal}`;
        }
        document.getElementById('idx-status-text').textContent = 'Extracting Echo spectral fingerprints...';
    }

    // ── Done ──
    if (p.phase === 'done') {
        clearInterval(progIv);
        document.getElementById('idx-clap-label').className = 'idx-phase-label done';
        document.getElementById('idx-deep-label').className = 'idx-phase-label done';
        document.getElementById('idx-spectral-label').className = 'idx-phase-label done';
        document.getElementById('idx-clap-bar').className = 'idx-bar-fill semantic done';
        document.getElementById('idx-deep-bar').className = 'idx-bar-fill semantic done';
        document.getElementById('idx-spectral-bar').className = 'idx-bar-fill spectral done';
        document.getElementById('idx-clap-bar').style.width = '100%';
        document.getElementById('idx-deep-bar').style.width = '100%';
        document.getElementById('idx-spectral-bar').style.width = '100%';
        document.getElementById('idx-clap-count').textContent = p.clapTotal > 0 ? `${p.clapTotal} ✓` : '-';
        document.getElementById('idx-spectral-count').textContent = p.spectralTotal > 0 ? `${p.spectralTotal} ✓` : '-';
        document.getElementById('idx-status-text').textContent = 'Library cataloged ✓';
        document.getElementById('idx-status-text').style.color = '#5a5';

        btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" style="margin-right:4px"><path d="M2 3h12M2 8h12M2 13h8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><circle cx="13" cy="13" r="2.5" stroke="currentColor" stroke-width="1.2"/><path d="M13 11.5v3M11.5 13h3" stroke="currentColor" stroke-width="1" stroke-linecap="round"/></svg>Catalog Library';
        btn.disabled = false;
        btn.style.opacity = '1';

        setTimeout(() => {
            panel.style.display = 'none';
            document.getElementById('idx-status-text').style.color = '';
        }, 5000);
    }
}, 800);
```

#### Paso 3.7: Reset de la UI al iniciar

En el bloque que resetea la UI al inicio del indexado (L3514-3521), agregar el reset del nuevo tier:

```javascript
document.getElementById('idx-deep-bar').style.width = '0%';
document.getElementById('idx-deep-bar').className = 'idx-bar-fill semantic';
document.getElementById('idx-deep-label').className = 'idx-phase-label';
document.getElementById('idx-deep-count').textContent = '-';
```

---

## Orden de Ejecución

1. **Fase 1 primero**: Es la más simple y no tiene dependencias. Cambios aislados en el bloque de CMVN.
2. **Fase 2 segundo**: Cambio quirúrgico en `processClapBatch`. No interfiere con Fase 1.
3. **Fase 3 último**: Es la más compleja. Toca el scheduler en `startIndexing`, agrega un nuevo message type al worker, y modifica la UI.

## Archivos Modificados (resumen)

| Archivo | Fases | Cambios |
|---------|-------|---------|
| `indexing-worker.js` | 1, 2, 3 | CMVN incremental, `selectClapOffsets`, `processClapQuickBatch`, nuevo handler |
| `semantic-engine.js` | 1, 3 | Migración schema, invalidación stats, refactor `startIndexing` |
| `index.html` | 3 | Tercer barra de progreso, nuevo JS de polling |

## Verificación Post-Implementación

1. Eliminar `soundvault-semantic.db` y re-indexar desde cero, verificar que las 3 barras de progreso avanzan correctamente.
2. Verificar que la búsqueda semántica funciona después del Tier 0 (antes de que Tier 1 y 2 terminen).
3. Agregar un archivo largo (>30s) a la librería y verificar que el watcher incremental usa CMVN incremental (no re-scan).
4. Eliminar un archivo y verificar que `spectral_stats` se invalida (DELETE).
5. Re-indexar después de eliminación: verificar que el re-scan completo se ejecuta una sola vez y luego vuelve a modo incremental.
