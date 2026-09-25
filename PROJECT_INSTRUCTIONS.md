# SoundVault: instructions for agents

SoundVault is a Windows desktop sound-library manager for game-audio designers:
browse and audition huge WAV libraries, search by name or by description (CLAP),
find similar sounds (Echo), edit and drag straight into a DAW, organise into
vaults and collections. Read `docs/ARCHITECTURE.md` before touching core code
and `docs/CASOS_DE_USO.md` for the verified behaviour of every use case.

## Stack
- Electron 41 (context isolation, sandboxed preload, `soundvault://` streaming protocol with Range support)
- Renderer: vanilla ES modules under `src/renderer/` (no bundler, strict CSP `script-src 'self'`)
- SQLite via `better-sqlite3` (built for Electron's ABI, run DB scripts with `node scripts/run-electron-node.js <script>`)
- `@xenova/transformers` + `onnxruntime-node` (CLAP `Xenova/clap-htsat-unfused`), `hnswlib-node` (ANN index)
- `ffmpeg-static` only as a fallback decoder (WAV is decoded natively)

## Layout
- `src/main.js`: main-process bootstrap and the validated IPC surface; `src/main/*`, library index, watcher, file ops, vaults, settings, renders, protocol, engine client
- `src/engine/*`: engine host, an Electron utility process (NOT a worker thread: Electron worker threads allocate ArrayBuffers through the kernel, see docs/ARCHITECTURE.md): semantic search, vector store/HNSW, indexing queue (+ `index-worker.js`), Echo (fine stage in time slices on the host thread, + `echo-migrate.js`)
- `src/audio/*`: WAV parsing/peaks/encoding, native decode + resampler, peaks worker
- `src/search/*`: lexical search, Spanish→English query translation
- `src/renderer/*`: UI (`js/app.js` orchestrates; `js/ui/*` components; `js/audio/*` player and editor DSP)
- The pre-2.0 engine (`src/semantic-engine.js`, `src/index.html`, …) is gone; do not revive the spectral reconstruction / synthesis experiments either.

## Conventions
- The AI is called **Resonance** in the UI (tuning-fork mark, sprite symbol `i-resonance`); search by description is **Describe**. No sparkle icons, no "AI" branding in copy.
- Never write the em dash or the en dash characters anywhere (UI copy, docs, comments, commit messages). Use colons, commas, periods or parentheses; plain hyphens for ranges. Test data that must contain them uses escapes (`\u2014`).
- UI copy is English; user-facing docs in `docs/` are Spanish (Rioplatense).

## Tests
- `npm test`: unit tests (plain Node, no Electron needed)
- `npm run test:engine`, full engine on a synthetic library (Electron as Node): catalog, search, Echo, incremental changes, HNSW persistence
- `npm run test:e2e`, the real app on fixtures with an isolated user-data folder (smoke, engine, 7 editor scenarios including fades). The harness refuses to use the real `%APPDATA%\soundvault`.
- `node scripts/run-electron-node.js tests/model-parity.electron.js <fp32Models> <fp16Models>`, FP16 text model parity
- Never run tests against the user's real library or `%APPDATA%\soundvault`; use `tests/fixtures/make-library.js` or copies.

## Build
- `npm run dist` → `dist/soundvault-<v>-Setup.exe` (NSIS, per user) + `dist/soundvault-<v>-x64.zip` (portable). `npm run pack` for `dist/win-unpacked` only; `npm run verify:dist` validates the layout.
- `prepack`/`predist` stage the VC++ CRT DLLs, convert the bundled CLAP text model to float16 (`scripts/prepare-models.js`) and render the icon (`electron scripts/make-icon.js`).
- `build-assets/models/Xenova/clap-htsat-unfused/` (gitignored) must hold the model; copy it from `node_modules/@xenova/transformers/.cache/Xenova` after the first dev run.
- Invariants (tests/packaging.test.js + verify-dist): ffmpeg path rewritten to `app.asar.unpacked`; offline models in the host and the indexing worker; transformers loaded lazily; sharp/onnxruntime-web replaced by stubs; `productName` stays `soundvault` (userData dir and the REAPER script depend on it).
