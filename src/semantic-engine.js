const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const { app } = require('electron');

const { 
    AutoTokenizer, 
    AutoProcessor, 
    ClapTextModelWithProjection, 
    ClapAudioModelWithProjection
} = require('@xenova/transformers');

ffmpeg.setFfmpegPath(ffmpegStatic);

const DIM = 512; // CLAP embedding dimensionality

class SemanticEngine {
    constructor() {
        this.db = null;
        this.textModel = null;
        this.audioModel = null;
        this.tokenizer = null;
        this.processor = null;
        this.isReady = false;
        this.isIndexing = false;
        this.progress = { total: 0, current: 0 };

        // ═══ Flat Vector Cache ═══
        // All embeddings live in a single contiguous Float32Array for cache-friendly iteration
        this._paths = [];           // parallel array: _paths[i] = file_path of vector i
        this._matrix = null;        // Float32Array of length _count * DIM
        this._count = 0;            // number of vectors currently cached
        this._capacity = 0;         // allocated capacity (in vectors)
    }

    // ── Cache Management ──────────────────────────────────────────────
    _ensureCapacity(needed) {
        if (needed <= this._capacity) return;
        const newCap = Math.max(needed, this._capacity * 2, 1024);
        const newBuf = new Float32Array(newCap * DIM);
        if (this._matrix) newBuf.set(this._matrix.subarray(0, this._count * DIM));
        this._matrix = newBuf;
        this._capacity = newCap;
    }

    _appendToCache(filePath, vectorBuffer) {
        this._ensureCapacity(this._count + 1);
        const vec = new Float32Array(vectorBuffer.buffer, vectorBuffer.byteOffset, vectorBuffer.byteLength / 4);
        this._matrix.set(vec, this._count * DIM);
        this._paths.push(filePath);
        this._count++;
    }

    async _loadCacheFromDB() {
        const rows = await new Promise((resolve, reject) => {
            this.db.all(`SELECT file_path, vector FROM embeddings`, (err, rows) => {
                if (err) reject(err);
                else resolve(rows || []);
            });
        });

        this._paths = [];
        this._count = 0;
        this._ensureCapacity(rows.length);

        for (const row of rows) {
            const vec = new Float32Array(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength / 4);
            this._matrix.set(vec, this._count * DIM);
            this._paths.push(row.file_path);
            this._count++;
        }
        console.log(`[SemanticEngine] Cache loaded: ${this._count} vectors (${(this._count * DIM * 4 / 1048576).toFixed(1)} MB)`);
    }

    // ── Optimized Dot Product (replaces cos_sim) ─────────────────────
    // CLAP embeddings are L2-normalized, so dot product = cosine similarity.
    // Iterates over the flat contiguous buffer with loop unrolling for V8 TurboFan.
    // Returns only the top-K results using V8's native TimSort (O(N log N)).
    _searchFlat(queryVec, topK = 200) {
        const n = this._count;
        const m = this._matrix;

        // Phase 1: Compute all dot products (~3-5ms for 70k × 512)
        const pairs = new Array(n);
        for (let i = 0; i < n; i++) {
            const offset = i * DIM;
            let dot = 0;
            let j = 0;
            for (; j <= DIM - 8; j += 8) {
                dot += queryVec[j]     * m[offset + j]
                     + queryVec[j + 1] * m[offset + j + 1]
                     + queryVec[j + 2] * m[offset + j + 2]
                     + queryVec[j + 3] * m[offset + j + 3]
                     + queryVec[j + 4] * m[offset + j + 4]
                     + queryVec[j + 5] * m[offset + j + 5]
                     + queryVec[j + 6] * m[offset + j + 6]
                     + queryVec[j + 7] * m[offset + j + 7];
            }
            for (; j < DIM; j++) dot += queryVec[j] * m[offset + j];
            pairs[i] = { idx: i, score: dot };
        }

        // Phase 2: Sort descending using V8's optimized TimSort (~2ms for 70k)
        pairs.sort((a, b) => b.score - a.score);

        // Phase 3: Return only top-K
        const k = Math.min(topK, n);
        const results = new Array(k);
        for (let i = 0; i < k; i++) {
            results[i] = { path: this._paths[pairs[i].idx], score: pairs[i].score };
        }
        return results;
    }

    // ── Init ──────────────────────────────────────────────────────────
    async init() {
        if (this.isReady) return;
        console.log('[SemanticEngine] Initializing...');

        const userDataPath = app ? app.getPath('userData') : path.join(__dirname, '..', '..');
        const dbPath = path.join(userDataPath, 'soundvault-semantic.db');
        
        this.db = new sqlite3.Database(dbPath);
        
        await new Promise((resolve, reject) => {
            this.db.run(`
                CREATE TABLE IF NOT EXISTS embeddings (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    file_path TEXT UNIQUE,
                    mtime INTEGER,
                    vector BLOB
                )
            `, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });

        // Load CLAP models
        console.log('[SemanticEngine] Loading CLAP models...');
        try {
            this.tokenizer = await AutoTokenizer.from_pretrained('Xenova/clap-htsat-unfused');
            this.textModel = await ClapTextModelWithProjection.from_pretrained('Xenova/clap-htsat-unfused');
            this.processor = await AutoProcessor.from_pretrained('Xenova/clap-htsat-unfused');
            this.audioModel = await ClapAudioModelWithProjection.from_pretrained('Xenova/clap-htsat-unfused');
        } catch (e) {
            console.error('[SemanticEngine] Failed to load models:', e);
            throw e;
        }

        // Preload vector cache from SQLite into flat buffer
        await this._loadCacheFromDB();

        this.isReady = true;
        console.log('[SemanticEngine] Ready.');
    }

    // ── Audio Extraction ──────────────────────────────────────────────
    async getAudioData(filePath) {
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
                    const floatArr = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
                    resolve(floatArr);
                })
                .pipe()
                .on('data', chunk => chunks.push(chunk));
        });
    }

    // ── Indexing ──────────────────────────────────────────────────────
    async indexFile(filePath, mtime) {
        try {
            const audioData = await this.getAudioData(filePath);
            const inputs = await this.processor(audioData);
            const { audio_embeds } = await this.audioModel(inputs);
            
            const vectorArray = Array.from(audio_embeds.data);
            const buffer = Buffer.from(new Float32Array(vectorArray).buffer);

            await new Promise((resolve, reject) => {
                this.db.run(
                    `INSERT OR REPLACE INTO embeddings (file_path, mtime, vector) VALUES (?, ?, ?)`,
                    [filePath, mtime, buffer],
                    (err) => err ? reject(err) : resolve()
                );
            });

            // Live-update the in-memory cache (no need to reload from DB)
            this._appendToCache(filePath, buffer);
        } catch (e) {
            console.error(`[SemanticEngine] Error indexing ${filePath}:`, e);
        }
    }

    async startIndexing(libraryPath) {
        console.log("[SemanticEngine] startIndexing called. isReady:", this.isReady, "isIndexing:", this.isIndexing, "Library path:", libraryPath);
        if (!this.isReady || this.isIndexing) return;
        this.isIndexing = true;
        this.progress = { total: 0, current: 0 };
        
        try {
            const allWavs = [];
            
            const scanDir = (dir) => {
                if(!fs.existsSync(dir)) return;
                try {
                    const entries = fs.readdirSync(dir, { withFileTypes: true });
                    for (const e of entries) {
                        try {
                            if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'src') continue;
                            const fullPath = path.join(dir, e.name);
                            if (e.isDirectory()) {
                                scanDir(fullPath);
                            } else if (e.name.toLowerCase().endsWith('.wav')) {
                                allWavs.push({ path: fullPath, mtime: fs.statSync(fullPath).mtimeMs });
                            }
                        } catch(err) {
                            console.warn("Skipping file due to error:", err);
                        }
                    }
                } catch(e) { console.warn("Skipping dir due to error:", e); }
            };
            
            scanDir(libraryPath);
            console.log(`[SemanticEngine] Found ${allWavs.length} total wavs in ${libraryPath}`);
            
            this.progress = { total: allWavs.length, current: 0 };
            
            for (const file of allWavs) {
                const isIndexed = await new Promise((resolve) => {
                    this.db.get(`SELECT mtime FROM embeddings WHERE file_path = ?`, [file.path], (err, row) => {
                        if (err || !row) resolve(false);
                        else resolve(row.mtime === file.mtime);
                    });
                });

                if (!isIndexed) {
                    await this.indexFile(file.path, file.mtime);
                }
                this.progress.current++;
            }

            // Rebuild cache to ensure deduplication after batch indexing
            await this._loadCacheFromDB();
        } finally {
            this.isIndexing = false;
        }
    }

    // ── Search (Optimized) ────────────────────────────────────────────
    async search(queryText, weights = null) {
        if (!this.isReady || this._count === 0) return { results: [], words: [] };

        const t0 = Date.now();
        const words = [...new Set(queryText.toLowerCase().trim().split(/\s+/).filter(w => w.length > 2))];

        if (this._lastQueryText !== queryText) {
            // 1. Get text embedding from CLAP (~50ms)
            const inputs = await this.tokenizer([queryText], { padding: true, truncation: true });
            const { text_embeds } = await this.textModel(inputs);
            this._lastBaseVector = new Float32Array(text_embeds.data); // 512D
            
            // Cache individual word vectors for live shifting later
            this._lastWordVectors = {};
            if (words.length > 1) {
                for (const w of words) {
                    const wInput = await this.tokenizer([w], { padding: true, truncation: true });
                    const wEmbed = await this.textModel(wInput);
                    this._lastWordVectors[w] = new Float32Array(wEmbed.text_embeds.data);
                }
            }
            this._lastQueryText = queryText;
        }

        let queryVec = new Float32Array(this._lastBaseVector);

        // Vector shifting if weights are provided
        if (weights && words.length > 1) {
            for (const [w, wVal] of Object.entries(weights)) {
                const vec = this._lastWordVectors[w];
                if (vec) {
                    const shift = parseFloat(wVal) - 1.0;
                    if (shift !== 0) {
                        for (let i = 0; i < 512; i++) {
                            queryVec[i] += vec[i] * shift;
                        }
                    }
                }
            }
            // Re-normalize shifted vector (L2 norm)
            let sumSq = 0;
            for (let i = 0; i < 512; i++) sumSq += queryVec[i] * queryVec[i];
            const mag = Math.sqrt(sumSq);
            if (mag > 0) {
                for (let i = 0; i < 512; i++) queryVec[i] /= mag;
            }
        }

        const t1 = Date.now();

        // 2. Flat brute-force dot product over contiguous cache (~5-8ms for 70k)
        const results = this._searchFlat(queryVec);

        const t2 = Date.now();
        console.log(`[SemanticEngine] Search "${queryText}": inference=${t1-t0}ms, vectorSearch=${t2-t1}ms, total=${t2-t0}ms (${this._count} vectors)`);

        return { results, words: words.length > 1 ? words : [] };
    }
}

module.exports = new SemanticEngine();
