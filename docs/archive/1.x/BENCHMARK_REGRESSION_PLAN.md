# SoundVault: Diagnóstico de Regresión 700→250 files/min
## Benchmark Plan para Antigravity

---

## Objetivo

Determinar por qué la indexación CLAP-only bajó de ~700 files/min (State 0, main thread) a ~250 files/min (State 2, worker thread). Ambos usan FP32, onnxruntime-node nativo, y fluent-ffmpeg. La diferencia es 2.8x y no está explicada.

## Hipótesis a testear

| # | Hipótesis | Test |
|---|---|---|
| H1 | El Worker Thread tiene overhead inherente (carga de modelo, IPC) que degrada throughput | Comparar main thread vs worker thread con el mismo código |
| H2 | El modelo CLAP se carga con config diferente en el worker (threads, cache, etc.) | Medir inferencia aislada en ambos contextos |
| H3 | fluent-ffmpeg se comporta diferente en worker (path resolution, buffering) | Medir ffmpeg aislado en ambos contextos |
| H4 | postMessage cada 10 archivos agrega overhead acumulativo | Comparar con/sin progress reporting |
| H5 | better-sqlite3 en el worker tiene contención WAL con el main thread | Medir DB insert aislado vs durante búsqueda concurrente |
| H6 | El main thread (State 0) cargaba el modelo de forma diferente (distinto ONNX config implícito) | Verificar config de ONNX threads en ambos contextos |

---

## Setup

### Carpeta de test

Crear una carpeta con **exactamente 200 archivos WAV** de tu librería:

```bash
mkdir C:\Users\santi\Documents\SoundVault_Tests\benchmark-wavs
```

Copiar 200 archivos WAV variados (diferentes duraciones, 1s-30s). No usar archivos de <0.5s ni >60s. Idealmente de subcarpetas diferentes de tu librería para tener variedad de tamaños.

**Importante**: Usar siempre los mismos 200 archivos en todos los tests para que sean comparables.

### Base de datos limpia por test

Cada test debe empezar con una DB vacía para medir el full-index (no delta). El script crea una DB temporal por test.

---

## El Script de Benchmark

Crear este archivo en la raíz del proyecto como `benchmark-regression.js`. No modifica ningún archivo existente. Se ejecuta standalone con Node.js (no Electron).

```javascript
/**
 * benchmark-regression.js
 * 
 * Diagnóstico de regresión de indexación SoundVault.
 * Ejecutar: node benchmark-regression.js <path-a-carpeta-con-200-wavs>
 * 
 * NO requiere Electron. NO modifica archivos del proyecto.
 * Crea DBs temporales en la carpeta de test.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { Worker } = require('worker_threads');
const Database = require('better-sqlite3');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');

ffmpeg.setFfmpegPath(ffmpegStatic);

// ════════════════════════════════════════════════════════
// CONFIG
// ════════════════════════════════════════════════════════
const TEST_DIR = process.argv[2];
if (!TEST_DIR || !fs.existsSync(TEST_DIR)) {
    console.error('Usage: node benchmark-regression.js <path-to-folder-with-200-wavs>');
    process.exit(1);
}

const RESULTS = {};
const WAVS = [];

// Scan test dir
function scanWavs(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) scanWavs(full);
        else if (entry.name.toLowerCase().endsWith('.wav')) {
            WAVS.push({ path: full, mtime: fs.statSync(full).mtimeMs });
        }
    }
}
scanWavs(TEST_DIR);
console.log(`\n═══ SoundVault Regression Benchmark ═══`);
console.log(`Found ${WAVS.length} WAV files in ${TEST_DIR}`);
console.log(`CPU: ${os.cpus()[0].model} (${os.cpus().length} cores)`);
console.log(`RAM: ${(os.totalmem() / 1073741824).toFixed(1)} GB`);
console.log(`Node: ${process.version}`);
console.log(`═══════════════════════════════════════\n`);

if (WAVS.length < 50) {
    console.error('Need at least 50 WAV files for meaningful benchmark. Got:', WAVS.length);
    process.exit(1);
}

// ════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════
function getAudioData(filePath, maxDuration = 10) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        ffmpeg(filePath)
            .duration(maxDuration)
            .audioFrequency(48000)
            .audioChannels(1)
            .format('f32le')
            .on('error', reject)
            .on('end', () => {
                const buf = Buffer.concat(chunks);
                if (buf.byteLength < 4) { reject(new Error('No audio data')); return; }
                resolve(new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4));
            })
            .pipe()
            .on('data', chunk => chunks.push(chunk));
    });
}

function createTempDB(name) {
    const dbPath = path.join(TEST_DIR, `_benchmark_${name}.db`);
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    // Also clean WAL/SHM files
    if (fs.existsSync(dbPath + '-wal')) fs.unlinkSync(dbPath + '-wal');
    if (fs.existsSync(dbPath + '-shm')) fs.unlinkSync(dbPath + '-shm');
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('cache_size = -64000');
    db.pragma('temp_store = MEMORY');
    db.exec(`CREATE TABLE IF NOT EXISTS embeddings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_path TEXT UNIQUE,
        mtime INTEGER,
        vector BLOB
    )`);
    return { db, dbPath };
}

function cleanupDB(name) {
    const dbPath = path.join(TEST_DIR, `_benchmark_${name}.db`);
    try { if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath); } catch(e) {}
    try { if (fs.existsSync(dbPath + '-wal')) fs.unlinkSync(dbPath + '-wal'); } catch(e) {}
    try { if (fs.existsSync(dbPath + '-shm')) fs.unlinkSync(dbPath + '-shm'); } catch(e) {}
}

// ════════════════════════════════════════════════════════
// TEST 1: ffmpeg decode only (isolate I/O)
// ════════════════════════════════════════════════════════
async function testFfmpegOnly() {
    console.log('\n── TEST 1: ffmpeg decode (10s, sequential) ──');
    const times = [];
    const subset = WAVS.slice(0, 100);

    for (const wav of subset) {
        const t0 = performance.now();
        try {
            await getAudioData(wav.path, 10);
        } catch(e) { continue; }
        times.push(performance.now() - t0);
    }

    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    const med = times.sort((a, b) => a - b)[Math.floor(times.length / 2)];
    const p95 = times[Math.floor(times.length * 0.95)];

    RESULTS['ffmpeg_only'] = { avg: avg.toFixed(1), median: med.toFixed(1), p95: p95.toFixed(1), count: times.length };
    console.log(`  Samples: ${times.length}`);
    console.log(`  Avg: ${avg.toFixed(1)}ms  Median: ${med.toFixed(1)}ms  P95: ${p95.toFixed(1)}ms`);
}

// ════════════════════════════════════════════════════════
// TEST 2: CLAP inference only (model already loaded, no ffmpeg)
// ════════════════════════════════════════════════════════
async function testClapInferenceOnly(processor, audioModel) {
    console.log('\n── TEST 2: CLAP inference only (pre-decoded audio) ──');

    // Pre-decode 50 files
    const audioBuffers = [];
    for (const wav of WAVS.slice(0, 50)) {
        try {
            const data = await getAudioData(wav.path, 10);
            audioBuffers.push(data);
        } catch(e) {}
    }

    // Warm up (first inference is always slower)
    const warmup = await processor(audioBuffers[0].subarray(0, Math.min(audioBuffers[0].length, 480000)));
    await audioModel(warmup);

    const times = [];
    for (const audio of audioBuffers) {
        const clapAudio = audio.subarray(0, Math.min(audio.length, 480000));
        const t0 = performance.now();
        const inputs = await processor(clapAudio);
        const { audio_embeds } = await audioModel(inputs);
        // Force materialization
        const _ = Array.from(audio_embeds.data);
        times.push(performance.now() - t0);
    }

    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    const med = times.sort((a, b) => a - b)[Math.floor(times.length / 2)];
    const p95 = times[Math.floor(times.length * 0.95)];

    RESULTS['clap_inference_only'] = { avg: avg.toFixed(1), median: med.toFixed(1), p95: p95.toFixed(1), count: times.length };
    console.log(`  Samples: ${times.length} (after 1 warmup)`);
    console.log(`  Avg: ${avg.toFixed(1)}ms  Median: ${med.toFixed(1)}ms  P95: ${p95.toFixed(1)}ms`);
}

// ════════════════════════════════════════════════════════
// TEST 3: Full pipeline in main thread (simulates State 0)
// ════════════════════════════════════════════════════════
async function testMainThreadFull(processor, audioModel) {
    console.log('\n── TEST 3: Full pipeline: MAIN THREAD (State 0 simulation) ──');

    const { db, dbPath } = createTempDB('main');
    const stmt = db.prepare('INSERT OR REPLACE INTO embeddings (file_path, mtime, vector) VALUES (?, ?, ?)');
    const subset = WAVS.slice(0, 200);
    
    let processed = 0;
    const t0 = performance.now();
    const perFileTimes = [];

    for (const wav of subset) {
        const ft0 = performance.now();
        try {
            const audioData = await getAudioData(wav.path, 10);
            const clapAudio = audioData.subarray(0, Math.min(audioData.length, 480000));
            const inputs = await processor(clapAudio);
            const { audio_embeds } = await audioModel(inputs);
            const vectorArray = Array.from(audio_embeds.data);
            const buffer = Buffer.from(new Float32Array(vectorArray).buffer);
            stmt.run(wav.path, wav.mtime, buffer);
            processed++;
        } catch(e) { /* skip */ }
        perFileTimes.push(performance.now() - ft0);
    }

    const totalMs = performance.now() - t0;
    const rate = Math.round(processed / totalMs * 60000);
    const avgPerFile = totalMs / processed;
    const medPerFile = perFileTimes.sort((a, b) => a - b)[Math.floor(perFileTimes.length / 2)];

    db.close();
    cleanupDB('main');

    RESULTS['main_thread_full'] = { 
        rate, processed, totalMs: totalMs.toFixed(0), 
        avgPerFile: avgPerFile.toFixed(1), medPerFile: medPerFile.toFixed(1) 
    };
    console.log(`  Files: ${processed}/${subset.length}`);
    console.log(`  Total: ${(totalMs / 1000).toFixed(1)}s`);
    console.log(`  Rate: ${rate} files/min`);
    console.log(`  Avg/file: ${avgPerFile.toFixed(1)}ms  Median/file: ${medPerFile.toFixed(1)}ms`);
}

// ════════════════════════════════════════════════════════
// TEST 4: Full pipeline in main thread WITH batch transactions
// ════════════════════════════════════════════════════════
async function testMainThreadBatched(processor, audioModel) {
    console.log('\n── TEST 4: Full pipeline: MAIN THREAD + batch transactions ──');

    const { db, dbPath } = createTempDB('main_batch');
    const stmt = db.prepare('INSERT OR REPLACE INTO embeddings (file_path, mtime, vector) VALUES (?, ?, ?)');
    const subset = WAVS.slice(0, 200);

    let processed = 0;
    let batch = [];
    const BATCH_SIZE = 50;
    const t0 = performance.now();

    const flushBatch = () => {
        db.transaction(() => { for (const b of batch) stmt.run(b.path, b.mtime, b.vec); })();
        batch = [];
    };

    for (const wav of subset) {
        try {
            const audioData = await getAudioData(wav.path, 10);
            const clapAudio = audioData.subarray(0, Math.min(audioData.length, 480000));
            const inputs = await processor(clapAudio);
            const { audio_embeds } = await audioModel(inputs);
            const vectorArray = Array.from(audio_embeds.data);
            const vec = Buffer.from(new Float32Array(vectorArray).buffer);
            batch.push({ path: wav.path, mtime: wav.mtime, vec });
            if (batch.length >= BATCH_SIZE) flushBatch();
            processed++;
        } catch(e) { /* skip */ }
    }
    if (batch.length > 0) flushBatch();

    const totalMs = performance.now() - t0;
    const rate = Math.round(processed / totalMs * 60000);

    db.close();
    cleanupDB('main_batch');

    RESULTS['main_thread_batched'] = { rate, processed, totalMs: totalMs.toFixed(0) };
    console.log(`  Files: ${processed}/${subset.length}`);
    console.log(`  Total: ${(totalMs / 1000).toFixed(1)}s`);
    console.log(`  Rate: ${rate} files/min`);
}

// ════════════════════════════════════════════════════════
// TEST 5: Full pipeline in WORKER THREAD (simulates State 2)
// ════════════════════════════════════════════════════════
async function testWorkerThread() {
    console.log('\n── TEST 5: Full pipeline: WORKER THREAD (State 2 simulation) ──');

    const { db, dbPath } = createTempDB('worker');
    db.close(); // Worker opens its own connection

    const subset = WAVS.slice(0, 200);
    const ffmpegPath = ffmpegStatic;

    return new Promise((resolve) => {
        const worker = new Worker(path.join(__dirname, 'indexing-worker.js'));
        const t0 = performance.now();

        worker.on('message', (msg) => {
            if (msg.type === 'ready') {
                worker.postMessage({ type: 'index-clap', files: subset });
            }
            if (msg.type === 'batch-complete') {
                const totalMs = performance.now() - t0;
                const rate = parseInt(msg.rate);
                RESULTS['worker_thread'] = { rate, totalMs: totalMs.toFixed(0), workerReportedRate: msg.rate };
                console.log(`  Files: ${subset.length}`);
                console.log(`  Total: ${(totalMs / 1000).toFixed(1)}s (includes worker init)`);
                console.log(`  Worker-reported rate: ${msg.rate} files/min`);
                console.log(`  Wall-clock rate: ${Math.round(subset.length / totalMs * 60000)} files/min`);
                worker.postMessage({ type: 'shutdown' });
            }
            if (msg.type === 'error') {
                console.error('  Worker error:', msg.error);
                worker.postMessage({ type: 'shutdown' });
            }
        });

        worker.on('exit', () => {
            cleanupDB('worker');
            resolve();
        });

        worker.postMessage({ type: 'init', dbPath, ffmpegPath });
    });
}

// ════════════════════════════════════════════════════════
// TEST 6: ONNX thread config diagnostic
// ════════════════════════════════════════════════════════
function testOnnxConfig() {
    console.log('\n── TEST 6: ONNX Runtime configuration ──');
    
    const { env } = require('@xenova/transformers');
    console.log(`  env.backends.onnx.wasm.numThreads: ${env.backends.onnx.wasm.numThreads}`);
    console.log(`  process.release.name: ${process.release.name}`);
    console.log(`  CPU cores: ${os.cpus().length}`);
    console.log(`  Expected ONNX backend: ${process.release.name === 'node' ? 'NATIVE (onnxruntime-node)' : 'WASM'}`);

    // Check if onnxruntime-node is available
    try {
        const ortNode = require('onnxruntime-node');
        console.log(`  onnxruntime-node: FOUND (version in node_modules)`);
    } catch(e) {
        console.log(`  onnxruntime-node: NOT FOUND (using WASM fallback)`);
    }

    RESULTS['onnx_config'] = {
        numThreads: env.backends.onnx.wasm.numThreads,
        backend: process.release.name === 'node' ? 'native' : 'wasm',
        cpuCores: os.cpus().length,
    };
}

// ════════════════════════════════════════════════════════
// MAIN
// ════════════════════════════════════════════════════════
async function main() {
    // Test 1: ffmpeg isolation
    await testFfmpegOnly();

    // Load model once (shared for main-thread tests)
    console.log('\n── Loading CLAP model (FP32) for main-thread tests... ──');
    const { AutoProcessor, ClapAudioModelWithProjection } = require('@xenova/transformers');
    const loadT0 = performance.now();
    const processor = await AutoProcessor.from_pretrained('Xenova/clap-htsat-unfused');
    const audioModel = await ClapAudioModelWithProjection.from_pretrained('Xenova/clap-htsat-unfused', { quantized: false });
    console.log(`  Model loaded in ${((performance.now() - loadT0) / 1000).toFixed(1)}s`);

    // Test 6: ONNX config (before any inference)
    testOnnxConfig();

    // Test 2: Inference isolation
    await testClapInferenceOnly(processor, audioModel);

    // Test 3: Main thread full pipeline (individual inserts, like State 0)
    await testMainThreadFull(processor, audioModel);

    // Test 4: Main thread full pipeline (batched inserts)
    await testMainThreadBatched(processor, audioModel);

    // Test 5: Worker thread full pipeline
    // IMPORTANT: This loads its OWN model instance, tests the real-world scenario
    await testWorkerThread();

    // ════════════════════════════════════════════════════════
    // SUMMARY
    // ════════════════════════════════════════════════════════
    console.log('\n\n═══════════════════════════════════════════════════════');
    console.log('               BENCHMARK RESULTS SUMMARY');
    console.log('═══════════════════════════════════════════════════════\n');
    console.log(JSON.stringify(RESULTS, null, 2));

    console.log('\n── Diagnosis ──');
    const mainRate = RESULTS.main_thread_full?.rate || 0;
    const batchRate = RESULTS.main_thread_batched?.rate || 0;
    const workerRate = RESULTS.worker_thread?.rate || 0;

    console.log(`  Main thread (individual inserts): ${mainRate} files/min`);
    console.log(`  Main thread (batch inserts):      ${batchRate} files/min`);
    console.log(`  Worker thread:                    ${workerRate} files/min`);

    if (mainRate > 0 && workerRate > 0) {
        const ratio = (mainRate / workerRate).toFixed(2);
        console.log(`\n  Main/Worker ratio: ${ratio}x`);
        
        if (parseFloat(ratio) > 1.5) {
            console.log('  ⚠️  SIGNIFICANT WORKER PENALTY DETECTED');
            console.log('     Likely causes:');
            console.log('     - Duplicate model loading (double RAM, cache thrashing)');
            console.log('     - ONNX thread contention (main + worker both using N-1 threads)');
            console.log('     - IPC overhead (postMessage serialization)');
            console.log('     - Worker model initialization overhead amortized over batch');
        } else if (parseFloat(ratio) > 1.1) {
            console.log('  ℹ️  Minor worker overhead (expected, ~10-20%)');
        } else {
            console.log('  ✅ Worker performs comparably to main thread');
        }
    }

    const inferOnly = parseFloat(RESULTS.clap_inference_only?.median || 0);
    const ffmpegOnly = parseFloat(RESULTS.ffmpeg_only?.median || 0);
    const pipelinePerFile = parseFloat(RESULTS.main_thread_full?.medPerFile || 0);
    const overhead = pipelinePerFile - inferOnly - ffmpegOnly;

    console.log(`\n── Pipeline Breakdown ──`);
    console.log(`  ffmpeg decode (median):     ${ffmpegOnly.toFixed(1)}ms`);
    console.log(`  CLAP inference (median):    ${inferOnly.toFixed(1)}ms`);
    console.log(`  Pipeline per file (median): ${pipelinePerFile.toFixed(1)}ms`);
    console.log(`  Overhead (DB + IPC + misc):  ${overhead.toFixed(1)}ms`);
    console.log(`  Theoretical max rate:        ${Math.round(60000 / (inferOnly + ffmpegOnly))} files/min`);
}

main().catch(e => { console.error('Benchmark failed:', e); process.exit(1); });
```

---

## Instrucciones de Ejecución

### 1. Preparar la carpeta de test

```bash
# Copiar 200 WAVs a la carpeta de benchmark
# Puede ser con un script o manualmente
mkdir "C:\Users\santi\Documents\SoundVault_Tests\benchmark-wavs"
# Copiar archivos de tu librería...
```

### 2. Ejecutar el benchmark

```bash
cd C:\Users\santi\Documents\SoundVault_Tests
node benchmark-regression.js "C:\Users\santi\Documents\SoundVault_Tests\benchmark-wavs"
```

**Nota**: Se ejecuta con `node`, NO con `electron`. Esto es intencional: el worker thread usa `onnxruntime-node` nativo independientemente, y queremos aislar la variable Electron. Si los resultados muestran discrepancia con lo que ves en la app, se agrega un test con Electron después.

### 3. Tiempo estimado

| Test | Tiempo estimado |
|---|---|
| Test 1 (ffmpeg) | ~10s |
| Model loading | ~15-30s |
| Test 2 (inference) | ~10s |
| Test 3 (main full) | ~30-50s |
| Test 4 (main batched) | ~30-50s |
| Test 5 (worker full) | ~45-90s (incluye carga de modelo) |
| **Total** | ~3-5 minutos |

### 4. Qué buscar en los resultados

**Escenario A: Worker penalty > 1.5x:**
```
Main/Worker ratio: 2.5x  ⚠️ SIGNIFICANT WORKER PENALTY
```
→ El problema es el worker. Causa más probable: dos instancias de modelo compitiendo por cache L3 (9MB en i5-9400). Solución: no cargar el audioModel en el main thread (ya no se necesita para indexación).

**Escenario B: Worker penalty ~1.0-1.2x, pero Test 3 muestra ~350ms/file:**
```
Main/Worker ratio: 1.1x  ✅ Worker comparable
Pipeline per file: 350ms
```
→ El worker no es el problema. El pipeline completo es lento en ambos contextos. Investigar overhead de ffmpeg (spawn vs fluent), preprocessing CLAP, o materialización de embeddings.

**Escenario C: Main rate es ~350 files/min (no 700):**
```
Main thread rate: 350 files/min
```
→ State 0 era más rápido por razones que ya no existen (config de ONNX diferente, modelo distinto, etc.). El benchmark establece la nueva baseline real.

### 5. Reportar resultados

Copiar el JSON completo del `BENCHMARK RESULTS SUMMARY` y el bloque de `Diagnosis`. Eso es suficiente para determinar el siguiente paso.

---

## Limpieza

El script limpia sus propias DBs temporales. Si quedan archivos `_benchmark_*.db` en la carpeta de test, se pueden borrar manualmente.

No toca ningún archivo del proyecto. No modifica la DB de producción. No importa semantic-engine.js ni main.js.

---

## Después del benchmark

Según los resultados, hay 3 caminos:

**Si el worker es el culpable (Escenario A):**
→ Eliminar la carga del audioModel en el main thread (línea 263 de semantic-engine.js). El main solo necesita tokenizer + textModel para búsquedas. El audioModel solo vive en el worker. Esto reduce la RAM total y elimina la competencia por cache L3.

**Si el pipeline es lento en ambos contextos (Escenario B):**
→ Profiling más fino: medir `processor(clapAudio)` y `audioModel(inputs)` por separado. Verificar que `Array.from(audio_embeds.data)` no es el cuello de botella (puede serlo para tensores grandes, reemplazar con `Buffer.from(audio_embeds.data.buffer)`).

**Si la baseline cambió (Escenario C):**
→ Los 700/min del State 0 probablemente tenían una configuración de ONNX diferente (quizás numThreads distinto o no configurado explícitamente). El Test 6 revela la config actual. Experimentar con `env.backends.onnx.wasm.numThreads = 1` vs `N-1` para ver si el multithreading de ONNX en realidad perjudica para modelos pequeños como CLAP.
