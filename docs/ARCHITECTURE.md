# SoundVault 2.0: Architecture

## Processes and threads

```
Electron main (src/main.js)          UI never waits on it for heavy work
 ├─ LibraryIndex        persistent file index (soundvault-library.json), reconcile by folder mtime
 ├─ LibraryWatcher      one recursive fs.watch → incremental index updates
 ├─ FileOps / VaultStore / SettingsStore / Renders   validated, atomic JSON writes
 ├─ soundvault:// protocol   streaming with Range (206/416), library-scoped
 ├─ PeaksService ──► peaks worker (src/audio/peaks-worker.js, soundvault-peaks.db)
 └─ EngineClient ──► engine host: Electron utility process (src/engine/engine-host.js)
                       ├─ SemanticEngine   CLAP text model, VectorStore + HNSW, indexing queue
                       │    └─ index worker (spawned while analysing; exits after 60 s idle)
                       └─ EchoIndex        fingerprint summaries in memory; exact sliding
                            │                  matcher in ~8 ms slices on the host thread
                            └─ echo migrate    one-time conversion of the pre-2.0 Echo table
Renderer (src/renderer)   ES modules, virtual list, Web Audio player, editor
```

## Data (in `%APPDATA%\soundvault`)
| File | Content |
|---|---|
| `soundvault-config.json`, `soundvault-vaults.json` | settings, vaults and collections (atomic write + `.bak`) |
| `soundvault-library.json` | persisted library index (per-folder file lists with size/mtime) |
| `soundvault-peaks.db` | waveform peaks/RMS per file (plus a negative cache for unreadable files) |
| `soundvault-semantic.db` | `embeddings` (CLAP vectors, stable ids, quality, generation), `index_failures`, `meta`, `echo_summary`, `echo_features` (float16) |
| `soundvault-vectors.hnsw` + `.json` | ANN index; labels = embedding ids; sidecar holds the DB generation it reflects |

## Library → AI index
1. The **LibraryIndex** is the single source of truth for what exists. Its `changed` events feed the engine (`filesChanged`), and app moves go through `pathsMoved`, so vectors and fingerprints follow files instead of being re-analysed.
2. `runCatalog()` sends the full file list to the engine. The engine diffs it against the rows it holds in memory (each vector keeps its DB fields: mtime, quality, duration, size, mirrored on every write), so the diff never scans the DB: ~0.35 s for 70k files on any disk. It finds new, changed, removed and renamed files and legacy rows to refine, and queues jobs by priority: user changes, then first pass, then deep pass. A diff requested while the library's data is still loading waits for it.
   If the library folder itself moved (other drive letter, copied to another disk), rows are relinked by relative path (same size; modification time equal within 2 s, the precision FAT/exFAT and copy tools keep), together with fingerprints, failures and collection items: nothing is re-analysed.
3. The **index worker** decodes each WAV once, natively (ffmpeg only as a fallback). From that decode it computes:
   - the CLAP vector of the first 10 s,
   - the Echo fingerprint of up to 120 s.

   Long files then get a deep pass: CLAP windows spread over the whole file, mean-pooled.
4. The host writes each batch in one transaction and updates memory and the HNSW index incrementally. Failures are recorded by (path, mtime) and not retried.

## Why the engine is a utility process
In Electron's worker threads every ArrayBuffer allocation goes through a page allocator (kernel calls): 400k small buffers take 6.3 s in a worker against 0.6 s on a main thread, and the gap grows with the heap (loading a 70k-file library: 167 s in a worker, 2.2 s on a main thread, same code and data). The engine host therefore runs on the main thread of its own utility process: the library opens in ~2 s instead of minutes, and a crash there never touches the window. The index worker stays a worker thread (it allocates little per file compared with its ~0.5 s of inference); Echo's fine stage moved onto the host thread, where reading and preparing ~400 candidates takes 31 ms instead of 156 ms. Under plain Node (tests) the host falls back to a worker thread.

## Startup
The UI opens on the persisted library index (no engine wait). In the engine host, the text model loads while vectors and fingerprint summaries stream in from the DB in pages (the thread keeps answering between pages). Search is available once both are in. The HNSW index is then loaded from disk, or built in ~30 ms slices when missing (~20 s for 70k vectors); searches stay exact until it is ready.

## Search
- **Lexical**: word-boundary matching over name, folder and vendor, with stems, UCS aliases, a partial-match fallback, and Spanish→English expansion.
- **AI**: the query is translated if Spanish, embedded (LRU cache), and ranked by cosine. The search is exact inside a scope, and uses HNSW for the whole library once it reaches 20k files. A calibrated floor drops weak results.
- **Hybrid** (in main): name matches come first, ordered by AI similarity, then AI-only results.

## Echo
- Features: 44-D per 25 ms window (MFCC, Δ, ΔΔ, centroid, flatness, bandwidth, log-RMS, ZCR). Stored raw, as float16.
- One z-space: global mean/std from exact per-file sums (no drift). Snapshots are versioned and shared by the query and the candidates.
- Fragment query: extracted with ±50 ms of real context. Coarse candidates are the union of the top-250 by z-mean and the top-250 by attack window (150 each for selections of 2.5 s or more). Fine stage: exact sliding cosine with a pruning floor. Score: calibrated against chance for the query length.
- File query ("more like this"): CLAP neighbours (88% sibling@10 on the real library), with exact duplicates grouped by fingerprint hash.

## Invariants worth keeping
- Nothing heavy runs on Electron's main thread; the renderer never blocks on IPC.
- Never write to the library except through FileOps (unique names, `COPYFILE_EXCL`, Recycle Bin).
- Renders are staged and only promoted when dragged; previews never pile up.
- The real user data folder is never used by tests (the harness refuses it).
