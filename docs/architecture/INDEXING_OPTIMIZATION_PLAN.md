# SoundVault — Plan de Optimización de Indexación
## Para implementar con Antigravity

---

## Estado Actual del Código

```
semantic-engine.js  →  Módulo singleton, corre en main thread
                       Usa: sqlite3 (async/callback), fluent-ffmpeg, @xenova/transformers v2
                       Modelos: FP32 (sin cuantizar, ~400MB cada uno)
                       Indexa secuencialmente: 1 archivo → ffmpeg → CLAP → INSERT → siguiente

main.js             →  Importa semantic-engine, expone IPC handlers
                       semanticEngine.init() carga AMBOS modelos (text + audio) en main thread
                       startIndexing() corre como fire-and-forget vía IPC

package.json        →  sqlite3@^6.0.1, @xenova/transformers@^2.17.2
                       chokidar@^5.0.0 ya está instalado (no se usa para indexación)
                       electron@^41.0.3
```

**Throughput actual medido: ~700 files/min (pre-worker, FP32)**
**Throughput post-worker fallido: ~200 files/min (regresión)**

---

## Objetivo

Llevar de ~700 files/min → ~1500-2000 files/min para full re-index.
Eliminar la necesidad de full re-index para uso normal (incremental).

---

## Plan: 4 Fases Secuenciales

Cada fase es independiente, testeable, y acumula ganancias con la anterior.
No se crean archivos nuevos excepto en Fase 3 (indexing-worker.js).

---

### FASE 1 — Fixes Críticos + SQLite Overhaul
**Impacto: ~700 → ~900-1100 files/min | Esfuerzo: Bajo | Riesgo: Bajo**

#### 1A. Fix cuantización (semantic-engine.js)

En `init()`, cambiar las líneas de carga de modelos:

```javascript
// ANTES (FP32 por defecto — ~400MB por modelo):
this.textModel = await ClapTextModelWithProjection.from_pretrained('Xenova/clap-htsat-unfused');
this.audioModel = await ClapAudioModelWithProjection.from_pretrained('Xenova/clap-htsat-unfused');

// DESPUÉS (INT8 cuantizado — ~100MB por modelo):
this.textModel = await ClapTextModelWithProjection.from_pretrained('Xenova/clap-htsat-unfused', { quantized: true });
this.audioModel = await ClapAudioModelWithProjection.from_pretrained('Xenova/clap-htsat-unfused', { quantized: true });
```

**Nota clave**: `{ quantized: true }` es la API correcta de `@xenova/transformers` v2. NO usar `{ dtype: 'q8' }` — esa es API de v3 y se ignora silenciosamente.

**Verificación**: Al correr `npm run dev`, la consola debe mostrar descarga de `audio_model_quantized.onnx` (~100MB). Si descarga `audio_model.onnx` (~400MB), el fix no funcionó. Borrar la cache en `~/.cache/huggingface/` para forzar re-descarga.

#### 1B. Reemplazar sqlite3 → better-sqlite3 (semantic-engine.js + package.json)

**package.json**:
```diff
- "sqlite3": "^6.0.1"
+ "better-sqlite3": "^11.7.0"
```

**Requiere `electron-rebuild`** después del install:
```bash
npm install better-sqlite3
npx @electron/rebuild
```

**semantic-engine.js** — Reescribir toda la capa DB:

```javascript
// ANTES:
const sqlite3 = require('sqlite3').verbose();
// ...
this.db = new sqlite3.Database(dbPath);
await new Promise((resolve, reject) => {
    this.db.run(`CREATE TABLE IF NOT EXISTS...`, (err) => err ? reject(err) : resolve());
});

// DESPUÉS:
const Database = require('better-sqlite3');
// ...
this.db = new Database(dbPath);
this.db.pragma('journal_mode = WAL');
this.db.pragma('synchronous = NORMAL');
this.db.pragma('cache_size = -64000');
this.db.exec(`CREATE TABLE IF NOT EXISTS embeddings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_path TEXT UNIQUE,
    mtime REAL,
    vector BLOB
)`);
```

**Prepared statements** (crear después de init de DB):
```javascript
this._stmts = {
    insertEmbedding: this.db.prepare(
        'INSERT OR REPLACE INTO embeddings (file_path, mtime, vector) VALUES (?, ?, ?)'
    ),
    selectAllMtimes: this.db.prepare('SELECT file_path, mtime FROM embeddings'),
    selectAllVectors: this.db.prepare('SELECT file_path, vector FROM embeddings'),
    deleteByPath: this.db.prepare('DELETE FROM embeddings WHERE file_path = ?'),
};
```

#### 1C. Batch mtime check + delta indexing (semantic-engine.js → startIndexing)

Reemplazar el loop de mtime checks individuales por un bulk SELECT + Map:

```javascript
async startIndexing(libraryPath) {
    if (!this.isReady || this.isIndexing) return;
    this.isIndexing = true;
    this.progress = { total: 0, current: 0 };

    try {
        // 1. Scan filesystem
        const allWavs = [];
        const scanDir = (dir) => { /* igual que ahora, sin cambios */ };
        scanDir(libraryPath);

        // 2. Batch mtime check — 1 query en vez de 70k
        const mtimeMap = new Map();
        for (const row of this._stmts.selectAllMtimes.iterate()) {
            mtimeMap.set(row.file_path, row.mtime);
        }

        // 3. Determinar qué necesita indexar
        const toIndex = [];
        const onDiskPaths = new Set();
        for (const file of allWavs) {
            onDiskPaths.add(file.path);
            if (mtimeMap.get(file.path) !== file.mtime) {
                toIndex.push(file);
            }
        }

        // 4. Delta cleanup — eliminar entradas de archivos borrados
        const stalePaths = [...mtimeMap.keys()].filter(p => !onDiskPaths.has(p));
        if (stalePaths.length > 0) {
            const deleteBatch = this.db.transaction((paths) => {
                for (const p of paths) this._stmts.deleteByPath.run(p);
            });
            deleteBatch(stalePaths);
            console.log(`[SemanticEngine] Cleaned ${stalePaths.length} stale entries`);
        }

        // 5. Indexar solo lo necesario, con batch INSERT
        this.progress = { total: allWavs.length, current: allWavs.length - toIndex.length };
        const BATCH_SIZE = 50;
        let batch = [];

        for (const file of toIndex) {
            try {
                const audioData = await this.getAudioData(file.path);
                const inputs = await this.processor(audioData);
                const { audio_embeds } = await this.audioModel(inputs);
                const buffer = Buffer.from(new Float32Array(Array.from(audio_embeds.data)).buffer);

                batch.push({ path: file.path, mtime: file.mtime, vector: buffer });

                if (batch.length >= BATCH_SIZE) {
                    this._flushBatch(batch);
                    batch = [];
                }
            } catch (e) {
                console.error(`[SemanticEngine] Error indexing ${file.path}:`, e);
            }
            this.progress.current++;
        }
        if (batch.length > 0) this._flushBatch(batch);

        // 6. Reload cache solo si hubo cambios
        if (toIndex.length > 0 || stalePaths.length > 0) {
            await this._loadCacheFromDB();
        }
    } finally {
        this.isIndexing = false;
    }
}

_flushBatch(batch) {
    const insert = this.db.transaction((items) => {
        for (const item of items) {
            this._stmts.insertEmbedding.run(item.path, item.mtime, item.vector);
        }
    });
    insert(batch);
}
```

#### 1D. Reescribir _loadCacheFromDB para better-sqlite3

```javascript
_loadCacheFromDB() {
    const rows = this._stmts.selectAllVectors.all();
    this._paths = [];
    this._count = 0;
    this._ensureCapacity(rows.length);

    for (const row of rows) {
        const vec = new Float32Array(
            row.vector.buffer, row.vector.byteOffset, row.vector.byteLength / 4
        );
        this._matrix.set(vec, this._count * DIM);
        this._paths.push(row.file_path);
        this._count++;
    }
    console.log(`[SemanticEngine] Cache loaded: ${this._count} vectors`);
}
```

**Nota**: `_loadCacheFromDB` ya no es async — better-sqlite3 es sincrónico. Actualizar las llamadas que le hacen `await`.

#### Verificación Fase 1
```
1. npm install → npx @electron/rebuild → npm run dev
2. Consola debe mostrar: "audio_model_quantized.onnx" descargado (~100MB)
3. Indexar 100 archivos de prueba → verificar que búsqueda semántica funciona
4. Borrar un archivo WAV del disco → re-indexar → verificar que desaparece
5. Cronometrar files/min (esperado: ~900-1100)
```

---

### FASE 2 — Worker Thread para Indexación
**Impacto: ~1100 → ~1100 files/min (misma velocidad, pero UI no se congela) | Esfuerzo: Medio | Riesgo: Medio**

La ganancia aquí NO es throughput — es responsividad de UI. La inferencia CLAP sigue siendo el cuello de botella, pero ahora no bloquea el event loop del main thread.

#### 2A. Crear indexing-worker.js (archivo nuevo)

```javascript
const { parentPort, workerData } = require('worker_threads');
const path = require('path');
const Database = require('better-sqlite3');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const {
    AutoProcessor,
    ClapAudioModelWithProjection
} = require('@xenova/transformers');

ffmpeg.setFfmpegPath(ffmpegStatic);

let audioModel, processor, db, stmts;

async function init() {
    const { dbPath } = workerData;

    // DB connection (WAL permite lecturas concurrentes desde main thread)
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    stmts = {
        insert: db.prepare(
            'INSERT OR REPLACE INTO embeddings (file_path, mtime, vector) VALUES (?, ?, ?)'
        ),
    };

    // Cargar SOLO el audio model (cuantizado) — text model vive en main
    processor = await AutoProcessor.from_pretrained('Xenova/clap-htsat-unfused');
    audioModel = await ClapAudioModelWithProjection.from_pretrained(
        'Xenova/clap-htsat-unfused', { quantized: true }
    );

    parentPort.postMessage({ type: 'ready' });
}

async function getAudioData(filePath) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        ffmpeg(filePath)
            .duration(10)
            .audioFrequency(48000)
            .audioChannels(1)
            .format('f32le')
            .on('error', reject)
            .on('end', () => {
                const buf = Buffer.concat(chunks);
                resolve(new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4));
            })
            .pipe()
            .on('data', chunk => chunks.push(chunk));
    });
}

async function processFiles(files) {
    const BATCH_SIZE = 50;
    let batch = [];
    let processed = 0;

    const flushBatch = () => {
        const insertMany = db.transaction((items) => {
            for (const item of items) stmts.insert.run(item.path, item.mtime, item.vector);
        });
        insertMany(batch);
        batch = [];
    };

    for (const file of files) {
        try {
            const audioData = await getAudioData(file.path);
            const inputs = await processor(audioData);
            const { audio_embeds } = await audioModel(inputs);
            const buffer = Buffer.from(new Float32Array(Array.from(audio_embeds.data)).buffer);

            batch.push({ path: file.path, mtime: file.mtime, vector: buffer });
            if (batch.length >= BATCH_SIZE) flushBatch();
        } catch (e) {
            // Skip errored files silently
        }
        processed++;
        if (processed % 10 === 0) {
            parentPort.postMessage({ type: 'progress', processed });
        }
    }
    if (batch.length > 0) flushBatch();
    parentPort.postMessage({ type: 'done', processed });
}

parentPort.on('message', async (msg) => {
    if (msg.type === 'index') {
        await processFiles(msg.files);
    }
});

init().catch(e => {
    parentPort.postMessage({ type: 'error', message: e.message });
});
```

#### 2B. Modificar semantic-engine.js — Delegación al worker

En `startIndexing`, después de construir `toIndex` y hacer delta cleanup (Fase 1), en lugar de iterar directamente:

```javascript
// Reemplazar el loop de indexación por:
if (toIndex.length > 0) {
    await this._indexViaWorker(toIndex);
    this._loadCacheFromDB(); // Recargar vectores que el worker insertó
}
```

Agregar método:

```javascript
async _indexViaWorker(files) {
    const { Worker } = require('worker_threads');
    const userDataPath = app ? app.getPath('userData') : __dirname;
    const dbPath = path.join(userDataPath, 'soundvault-semantic.db');

    return new Promise((resolve, reject) => {
        const worker = new Worker(path.join(__dirname, 'indexing-worker.js'), {
            workerData: { dbPath }
        });

        worker.on('message', (msg) => {
            if (msg.type === 'ready') {
                worker.postMessage({ type: 'index', files });
            } else if (msg.type === 'progress') {
                this.progress.current = (this.progress.total - files.length) + msg.processed;
            } else if (msg.type === 'done') {
                this.progress.current = this.progress.total;
                worker.terminate();
                resolve();
            } else if (msg.type === 'error') {
                worker.terminate();
                reject(new Error(msg.message));
            }
        });

        worker.on('error', reject);
        worker.on('exit', (code) => {
            if (code !== 0 && code !== 1) reject(new Error(`Worker exited with code ${code}`));
        });
    });
}
```

#### 2C. Remover audioModel del main thread

En `init()` de semantic-engine.js, NO cargar el audioModel:

```javascript
// Main thread solo necesita tokenizer + textModel para búsquedas
this.tokenizer = await AutoTokenizer.from_pretrained('Xenova/clap-htsat-unfused');
this.textModel = await ClapTextModelWithProjection.from_pretrained(
    'Xenova/clap-htsat-unfused', { quantized: true }
);
this.processor = await AutoProcessor.from_pretrained('Xenova/clap-htsat-unfused');
// audioModel se carga SOLO en el worker thread
```

**Ahorro: ~100-200MB de RAM en main thread.**

#### Verificación Fase 2
```
1. npm run dev → trigger "Index AI" desde la UI
2. DURANTE indexación: verificar que la UI responde (scroll, click, play sounds)
3. Verificar que el progreso se reporta correctamente
4. Al finalizar, hacer búsqueda semántica → resultados correctos
5. Verificar en Task Manager que no hay proceso zombie del worker
```

---

### FASE 3 — onnxruntime-node (Inferencia Nativa)
**Impacto: ~1100 → ~1500-2000 files/min | Esfuerzo: Alto | Riesgo: Medio-Alto**

Esta es la fase que rompe el techo de WASM. Reemplaza la inferencia de audio por ONNX Runtime nativo.

#### 3A. Instalar onnxruntime-node

```bash
npm install onnxruntime-node
npx @electron/rebuild
```

`onnxruntime-node` viene con binarios precompilados para Windows/macOS/Linux. `electron-rebuild` los recompila contra los headers de Electron.

#### 3B. Modificar indexing-worker.js — Usar ONNX nativo para audio

El cambio clave: reemplazar `@xenova/transformers` audioModel con `onnxruntime-node` InferenceSession, pero MANTENER `@xenova/transformers` para el preprocessor (que computa mel spectrograms).

```javascript
const ort = require('onnxruntime-node');
const { AutoProcessor } = require('@xenova/transformers');

// En init():
const modelPath = path.join(workerData.modelCachePath, 'onnx', 'audio_model_quantized.onnx');
const session = await ort.InferenceSession.create(modelPath, {
    executionProviders: ['cpu'],
    graphOptimizationLevel: 'all',
    intraOpNumThreads: Math.max(1, os.cpus().length - 2),
    interOpNumThreads: 1,
});
processor = await AutoProcessor.from_pretrained('Xenova/clap-htsat-unfused');
```

**Problema a resolver**: El preprocessor de `@xenova/transformers` produce un tensor con nombre `input_features`. Hay que mapear ese tensor al formato que `onnxruntime-node` espera:

```javascript
async function inferCLAP(audioData) {
    const processed = await processor(audioData);
    // processed contiene tensores con nombres específicos de CLAP
    // Extraer el tensor de features y crear un ORT tensor
    const inputData = processed.input_features.data; // Float32Array
    const dims = processed.input_features.dims;       // [1, ?, ?]
    const tensor = new ort.Tensor('float32', inputData, dims);

    const feeds = { input_features: tensor };
    // Si el modelo necesita is_longer, agregarlo:
    if (processed.is_longer) {
        feeds.is_longer = new ort.Tensor('int64',
            BigInt64Array.from(processed.is_longer.data.map(BigInt)),
            processed.is_longer.dims
        );
    }

    const results = await session.run(feeds);
    // El output embedding está en results.audio_embeds o similar
    // Verificar el nombre exacto con: console.log(Object.keys(results))
    const embeds = Object.values(results)[0];
    return new Float32Array(embeds.data);
}
```

**Nota importante**: Los nombres de input/output tensors del modelo ONNX deben verificarse. Correr esto una vez para ver los nombres:
```javascript
console.log('Inputs:', session.inputNames);
console.log('Outputs:', session.outputNames);
```

#### 3C. Ruta del modelo ONNX

`@xenova/transformers` descarga los modelos a `~/.cache/huggingface/`. El archivo cuantizado está en:
```
~/.cache/huggingface/Xenova/clap-htsat-unfused/onnx/audio_model_quantized.onnx
```

Pasar esta ruta al worker via `workerData.modelCachePath`. En semantic-engine.js:

```javascript
const { env } = require('@xenova/transformers');
const modelCachePath = path.join(env.cacheDir, 'Xenova', 'clap-htsat-unfused');
// Pasar a workerData al crear el Worker
```

**Fallback**: Si el archivo no existe (primera ejecución), dejar que `@xenova/transformers` lo descargue primero vía su mecanismo normal, luego switchear a onnxruntime-node para inferencia.

#### Verificación Fase 3
```
1. npm install onnxruntime-node → npx @electron/rebuild
2. Verificar que el worker logea los inputNames/outputNames correctos
3. Comparar embedding de un mismo archivo entre xenova y ort-node:
   → cosine similarity debe ser > 0.99 (diferencias menores por precision)
4. Cronometrar: esperado ~1500-2000 files/min
5. Verificar que búsqueda semántica sigue dando resultados coherentes
```

---

### FASE 4 — Indexación Incremental (File Watcher)
**Impacto: Elimina la necesidad de re-index manual | Esfuerzo: Bajo | Riesgo: Bajo**

`chokidar@^5.0.0` ya está en package.json. Solo hay que usarlo.

#### 4A. Agregar watcher en semantic-engine.js

```javascript
const chokidar = require('chokidar');

// Llamar después de init() exitoso
startWatching(libraryPath) {
    if (this._watcher) this._watcher.close();

    this._watcher = chokidar.watch(libraryPath, {
        ignored: /(^|[\/\\])\.|node_modules/,
        persistent: true,
        ignoreInitial: true, // No procesar archivos existentes
        awaitWriteFinish: { stabilityThreshold: 1000 }, // Esperar que termine de copiarse
    });

    this._watcher.on('add', (filePath) => {
        if (!filePath.toLowerCase().endsWith('.wav')) return;
        this._queueForIndex(filePath);
    });

    this._watcher.on('change', (filePath) => {
        if (!filePath.toLowerCase().endsWith('.wav')) return;
        this._queueForIndex(filePath);
    });

    this._watcher.on('unlink', (filePath) => {
        if (!filePath.toLowerCase().endsWith('.wav')) return;
        // Eliminar del cache y DB
        this._stmts.deleteByPath.run(filePath);
        const idx = this._paths.indexOf(filePath);
        if (idx !== -1) {
            // Swap-remove del flat cache
            this._paths[idx] = this._paths[this._count - 1];
            this._paths.pop();
            const lastOffset = (this._count - 1) * DIM;
            const targetOffset = idx * DIM;
            this._matrix.copyWithin(targetOffset, lastOffset, lastOffset + DIM);
            this._count--;
        }
    });
}

_indexQueue = [];
_indexTimer = null;

_queueForIndex(filePath) {
    this._indexQueue.push(filePath);
    if (this._indexTimer) return;
    // Debounce: procesar la cola cada 2 segundos
    this._indexTimer = setTimeout(async () => {
        this._indexTimer = null;
        const queue = this._indexQueue.splice(0);
        for (const fp of queue) {
            try {
                const stat = fs.statSync(fp);
                // Usar el worker si está disponible, o indexar directo
                await this.indexFile(fp, stat.mtimeMs);
            } catch(e) { /* archivo desapareció entre detección e indexación */ }
        }
    }, 2000);
}
```

#### 4B. Activar en main.js después de init

```javascript
app.whenReady().then(async () => {
    // ... existing init ...
    await semanticEngine.init();

    // Start watching for new files
    const lib = getConfig().libraryPath;
    semanticEngine.startWatching(lib);
});
```

#### 4C. Importante para Fase 4

Para que `indexFile` funcione desde el watcher sin worker (para archivos individuales), el main thread necesita mantener una copia del audioModel como fallback. Dos opciones:

**Opción A**: Mantener audioModel en main (simple, +100MB RAM):
```javascript
// En init(), cargar audioModel como fallback para indexación incremental de 1-2 archivos
this.audioModel = await ClapAudioModelWithProjection.from_pretrained(
    'Xenova/clap-htsat-unfused', { quantized: true }
);
```

**Opción B** (recomendada): Mantener el worker thread vivo (no terminarlo en Fase 2) y enviarle mensajes individuales. Más eficiente en RAM, pero más complejo.

#### Verificación Fase 4
```
1. npm run dev → esperar que el engine esté listo
2. Copiar un archivo WAV nuevo a la carpeta de librería
3. Esperar ~3 segundos
4. Hacer búsqueda semántica del tipo de sonido → debe aparecer
5. Borrar el archivo → búsqueda no debe devolverlo más
```

---

## Resumen de Impacto Acumulativo

| Fase | Files/min | Full 70k | RAM Main | UI Responsiva |
|------|-----------|----------|----------|---------------|
| Actual (con bugs) | ~200 | ~350 min | ~800MB | No |
| Actual (baseline) | ~700 | ~100 min | ~400MB | No |
| **Fase 1** | ~900-1100 | ~65-78 min | ~200MB | No |
| **Fase 1+2** | ~900-1100 | ~65-78 min | ~100MB | **Sí** |
| **Fase 1+2+3** | ~1500-2000 | ~35-47 min | ~100MB | Sí |
| **Fase 1+2+3+4** | N/A (incremental) | N/A | ~100MB | Sí |

---

## Instrucciones para Antigravity

### Contexto mínimo necesario

> SoundVault es una app Electron (Node 18+, vanilla JS) para diseñadores de audio. Tiene un motor de búsqueda semántica basado en CLAP (Contrastive Language-Audio Pretraining) que genera embeddings 512D de archivos WAV y los almacena en SQLite. El código relevante está en `semantic-engine.js` (motor AI), `main.js` (IPC Electron), y `package.json`.

### Orden de ejecución

1. **Fase 1 primero, siempre.** Es la base sobre la que se construye todo lo demás. Sin better-sqlite3, las fases 2-3 no pueden usar transacciones batch ni WAL.

2. **Fase 2 después de validar Fase 1.** El worker solo tiene sentido si el modelo ya está cuantizado y la DB ya usa better-sqlite3.

3. **Fase 3 es opcional pero transformativa.** Solo implementar si el throughput de Fase 1+2 no es suficiente. Requiere debugging de los tensor names del modelo ONNX, que puede ser tedioso.

4. **Fase 4 se puede implementar en paralelo con cualquier otra fase.** Es independiente y de bajo riesgo.

### Warnings para Antigravity

- **NO usar `dtype: 'q8'`** — es API de Transformers.js v3, se ignora silenciosamente en v2. Usar `{ quantized: true }`.
- **NO usar `@huggingface/transformers`** — el proyecto usa `@xenova/transformers` v2. Son paquetes diferentes con APIs incompatibles.
- **`better-sqlite3` requiere `electron-rebuild`** — sin esto, el módulo nativo crashea al cargar.
- **`_loadCacheFromDB` deja de ser async** — actualizar todas las llamadas con `await` para que sean sincrónicas.
- **WAL mode permite lecturas concurrentes** — main thread puede hacer búsquedas mientras el worker indexa, pero NO puede escribir simultáneamente.
- **El worker thread carga su propia instancia del modelo** — esto es ~100MB de RAM adicional pero es inevitable; ONNX sessions no son thread-safe.
- **Los archivos existentes que ya fueron descargados como FP32 deben borrarse del cache** de Hugging Face para forzar la descarga de la versión cuantizada. La ruta del cache varía por OS:
  - Windows: `%USERPROFILE%\.cache\huggingface\`
  - macOS: `~/.cache/huggingface/`
  - Linux: `~/.cache/huggingface/`
