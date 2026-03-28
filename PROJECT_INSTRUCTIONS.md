# SoundVault - AI Agent Instructions

Welcome, agent. This is the official SoundVault repository. This document serves to give you the necessary context to work on this app efficiently.

## Core Technologies
- **Electron** (Backend, window management, IPC)
- **Vanilla JavaScript, HTML/CSS** (Frontend UI)
- **SQLite** (`better-sqlite3`) (Database for audio metadata and embeddings)
- **ONNX Runtime Web / Transformers.js** (Locally executed ML models like CLAP for audio feature extraction)
- **fluent-ffmpeg / ffmpeg-static** (Audio decoding and processing)

## Key Subsystems
1. **Semantic Search Engine (`src/semantic-engine.js`)**: We implemented a two-stage indexing pipeline. 
   - *Phase 1:* Standard metadata extraction (peaks, durations).
   - *Phase 2:* Audio embedding generation using the CLAP model chunked asynchronously. 
2. **Audio Editor**: An advanced, handle-driven UI for fades and crops.
3. **Database Architecture**: `soundvault-semantic.db` holds everything.

## Historical Documentation
Check the `docs/architecture/` folder for RFCs and previous implementation plans. Key reads:
- `SOUNDVAULT_FIND_SIMILAR_RFC.md` - Core architecture for semantic search.
- `ECHO_PRECISION_PLAN (1).md` - Strategies for improving similarity search accuracy.
- `BENCHMARK_REGRESSION_PLAN.md` - Test plans for heavy processing.

## Current Setup & Testing
- Start app with `npm run dev` or `npm start` (defined in `package.json`).
- Run tests in the `tests/` folder directly via node, e.g. `node tests/test-engine.js`.
- Always use the provided documents and historical context before modifying core components.
