# SoundVault: "ECHO VAULT" Feature RFC
## Fragment-Level Audio Similarity Search System

### Technical Investigation, Architecture Design & Implementation Plan

---

## 1. Naming Exploration

Before diving into the technical analysis, a brief semantic exploration of naming candidates, blending the morphological roots of **VAULT** (chamber, resonance, space, protection) and **SOUND** (wave, echo, tone, vibration):

| Candidate | Concept | Why It Works |
|---|---|---|
| **Echo Vault** | Echo = acoustic reflection + Vault = chamber of sounds | The strongest candidate. Implies acoustic memory: finding the "echo" of a selection across the vault. Natural verb form: "Echo this." |
| **Resonance** | Already used in SoundVault for AI suggestions | Extends naturally. A fragment "resonates" with other fragments. |
| **Sound Mirror** | Reflection, finding the acoustic mirror image | Evocative but passive: implies identity, not similarity. |
| **Sonic Kin** | Family of sounds, timbral relatives | Creative but possibly too informal for a pro tool. |
| **Harmonic Vault** | Harmony between fragments | Slightly misleading: implies pitch relationship specifically. |

**Recommendation:** **"Echo Vault"**, with the verb action **"Echo"** (e.g., right-click → "Echo this selection"). It semantically implies: *find where this sound reverberates across the vault*. The UI button/action can simply read **ECHO**.

---

## 2. Analysis of the Current CLAP System

### 2.1 Architecture Summary

SoundVault uses `Xenova/clap-htsat-unfused` via `@xenova/transformers` (ONNX Runtime). The system comprises:

**Audio Encoder Pipeline:**
- ffmpeg decodes audio → mono, 48kHz, raw f32le
- First 10 seconds only (`.duration(10)`)
- `AutoProcessor` converts to mel spectrogram
- `ClapAudioModelWithProjection` produces 512-D L2-normalized embedding
- Embedding cached as 2048-byte BLOB in SQLite (keyed by `file_path` + `mtime`)

**Text Encoder Pipeline:**
- `AutoTokenizer` tokenizes text
- `ClapTextModelWithProjection` produces 512-D embedding
- Supports multi-word vector shifting for interactive weight adjustment

**Search Infrastructure:**
- Flat contiguous `Float32Array` matrix: all embeddings in a single buffer
- Brute-force dot product with 8-way loop unrolling (dot product = cosine similarity because vectors are L2-normalized)
- Performance: ~5-8ms for 70k vectors (matrix scan) + ~2ms sort
- `suggestForCollection()` already computes centroid-based audio-to-audio similarity

### 2.2 What CLAP Can and Cannot Do for Fragment Similarity

**What CLAP embeddings capture (strengths):**
- High-level semantic class ("explosion", "rain", "footstep", "guitar strum")
- Coarse timbral texture (bright vs. dark, noisy vs. tonal)
- Spectral energy distribution (broadband vs. narrowband)
- Acoustic environment characteristics (reverberant, dry, outdoors)

**What CLAP embeddings fail to capture (critical limitations):**
- **Temporal microstructure:** Two sounds with identical CLAP embeddings can have completely different transient shapes, attack envelopes, and rhythmic phrasing. CLAP was trained on whole-clip semantic labels, not sub-second temporal patterns.
- **Fine-grained timbre:** CLAP distinguishes "guitar" from "piano" but struggles to distinguish *which* guitar, a nylon classical vs. a distorted electric playing the same note. The 512-D space conflates many timbral nuances that a sound designer considers distinct.
- **Pitch and harmonic content:** CLAP embeddings are largely pitch-invariant by design (it's a classification model). Two sounds at different pitches but identical timbre will be very close in CLAP space, sometimes desirable, sometimes not.
- **Sub-clip granularity:** The current system processes only the first 10 seconds of each file as a single embedding. There's no temporal axis within the embedding, a file that starts with silence and ends with a crash gets the same embedding as one that starts with a crash.
- **Rhythmic / "phrasing" similarity:** CLAP has no concept of onset pattern, rhythmic structure, or temporal articulation. Two drum fills with the same kit but different patterns will have near-identical CLAP embeddings.

### 2.3 The Fundamental Problem

The user selects a *fragment* of audio (e.g., 0.3 seconds of a metallic transient within a 5-second file) and wants to find *similar fragments* across the entire library. This is a fundamentally different problem from what current CLAP solves:

| Dimension | Current CLAP Search | Echo Vault Requirement |
|---|---|---|
| Query source | Text string | Audio selection (Float32Array) |
| Query granularity | Whole file (~10s) | Sub-second fragment |
| Target granularity | Whole file embedding | Sub-second regions within files |
| Similarity meaning | "Same semantic category" | "Sounds alike in timbre, texture, envelope" |
| Result format | Ranked file list | File + time offset + duration |

---

## 3. Alternative Approaches: Research Survey

### 3.1 Approach A: CLAP Sliding Window (Semantic Coarse Filter)

**Concept:** Use CLAP's audio encoder on short audio segments via a sliding window. Already validated by the CAF-Score paper (2025), which demonstrated that applying a sliding-window strategy to audio and pooling CLAP scores produces better correlation with human judgments than naive truncation.

**How it works for Echo Vault:**
1. User selects a fragment → extract raw audio → run through CLAP audio encoder → get query embedding (512-D)
2. For each file in library, pre-compute N embeddings via sliding window (e.g., 2-second windows with 1-second hop) and store in an extended index
3. Dot product against all segment embeddings → return top matches with time offsets

**Pros:**
- Reuses existing CLAP infrastructure entirely
- Query embedding is instant (one inference call ~50ms)
- Coarse semantic matching works well for "find another explosion" type queries
- Same flat-buffer brute-force approach scales

**Cons:**
- Storage explosion: N windows per file × 2048 bytes. For 70k files × 5 windows = 350k embeddings (700MB RAM)
- CLAP inference per window is ~50-100ms. Pre-indexing 350k windows = ~5-10 hours
- Still doesn't capture fine-grained timbre or temporal shape
- 2-second minimum window (CLAP performs poorly on very short clips due to mel spectrogram padding/repetition design)

**Verdict:** Useful as a **coarse pre-filter** (Stage 1), not as the sole similarity engine.

### 3.2 Approach B: Mel-Spectrogram / MFCC Feature Fingerprinting (Perceptual Fine-Grained)

**Concept:** Extract classical audio features from the query fragment and compare against pre-computed features of library segments. This is the traditional MIR (Music Information Retrieval) approach.

**Feature Set for Sound Design Similarity:**
- **MFCCs (13 coefficients + deltas):** Capture spectral envelope ≈ timbral "color." Coefficients 2-12 encode texture and timbre details.
- **Spectral Centroid:** Brightness measure (Hz). Critical for distinguishing bright vs. dark sounds.
- **Spectral Flatness:** Noisiness measure (0=tonal, 1=noise). Essential for SFX work.
- **Zero-Crossing Rate:** Proxy for noisiness and pitch.
- **RMS Envelope (windowed):** Energy contour, captures attack/decay shape.
- **Onset Strength:** Transient detection, captures "punchiness" and rhythmic articulation.
- **Spectral Bandwidth:** Width of spectral energy distribution.

**How it works:**
1. Per-file indexing: Extract features in 50ms windows, 25ms hop. Store as a compact per-file feature matrix.
2. Query: Extract same features from user's selection.
3. Matching: Use Dynamic Time Warping (DTW) or normalized cosine distance on feature sequences.

**Pros:**
- Captures exactly what sound designers care about: timbre, texture, envelope shape, transient character
- Sub-millisecond feature extraction in pure JS (FFT + mel filter bank = trivial computation)
- Compact storage: ~100 bytes per 50ms window (13 MFCCs + 5 spectral features × 4 bytes ≈ 72 bytes)
- Works beautifully on very short fragments (even 50ms)
- Can be computed entirely in the Electron main process using raw math, no ML models needed

**Cons:**
- DTW is O(N×M) per comparison, scanning every window of every file is prohibitive for 70k files
- Requires pre-computed feature matrices for the entire library (significant initial indexing)
- No "semantic" understanding: won't find a "similar but different" explosion; only timbral matches
- Sensitive to pitch differences (two identical timbres at different pitches score poorly unless pitch-normalized)

**Verdict:** Excellent as the **fine-grained ranking engine** (Stage 2), but needs a pre-filter to avoid scanning the entire library.

### 3.3 Approach C: Hybrid CLAP + Spectral Fingerprint (Recommended)

**This is the approach I recommend for SoundVault.** It combines the strengths of both:

**Stage 1: CLAP Coarse Filter:**
- Use the existing CLAP embedding to narrow down candidates from 70k files to ~200-500 files
- The user's selected fragment is embedded via CLAP audio encoder
- Dot product against the full file embeddings (already cached) → top 200-500 candidates
- Time: ~50ms inference + ~5ms vector search = ~55ms

**Stage 2: Spectral Fingerprint Fine Search:**
- For each candidate file, compute or retrieve the pre-computed spectral feature matrix
- Use a fast similarity measure (windowed cosine distance, not full DTW) to find the best-matching sub-segment within each file
- Return results ranked by fine-grained spectral similarity, with exact time offsets

**Stage 3-(Optional) Temporal Envelope Matching:**
- For the top ~50 results from Stage 2, apply an envelope-shape correlation
- This captures "phrasing": the rhythmic/dynamic contour of the sound
- Implemented as normalized cross-correlation of the RMS envelope curves

### 3.4 Approach D: Audio Fingerprinting (Chromaprint / Panako)

**Concept:** Classical audio fingerprinting (as used by Shazam, AcoustID) identifies *near-identical* audio.

**Why it doesn't fit Echo Vault:**
- Designed for exact-match identification, not perceptual similarity
- Two different thunder sounds would score 0% similarity despite being perceptually identical
- Extremely robust to encoding artifacts but useless for creative similarity search
- Would only work for finding literal duplicates or copies

**Verdict:** Rejected. Wrong problem space entirely.

### 3.5 Approach E: Unsupervised Embedding Networks (Cochlea-style)

**Concept:** Train a custom neural network to produce dense embeddings of short audio segments such that perceptually similar segments cluster together. Uses triplet loss with audio deformations (pitch shift, time stretch, noise addition) as positive pairs.

**Pros:** Could produce the most accurate similarity space possible.

**Cons:**
- Requires training a custom model, weeks of work, needs curated dataset
- Adds another ML model to ship (increased binary size, memory)
- Not feasible for a desktop app without GPU
- The CLAP + spectral hybrid achieves 80-90% of the quality with zero training

**Verdict:** Interesting for a future version, but the hybrid approach is the pragmatic choice.

---

## 4. Recommended Architecture: Hybrid "Echo Vault"

### 4.1 System Overview

```
User selects audio fragment
        │
        ▼
┌─────────────────────────┐
│  CLAP Audio Encoder     │  ← ~50ms (one inference)
│  512-D query embedding  │
└──────────┬──────────────┘
           │
           ▼
┌─────────────────────────┐
│  Stage 1: Coarse Filter │  ← ~5ms (dot product vs 70k)
│  Top 500 candidate files│
└──────────┬──────────────┘
           │
           ▼
┌─────────────────────────┐
│  Stage 2: Spectral      │  ← ~200ms (feature comparison)
│  Fingerprint Search     │
│  Per-file segment match │
│  Returns time offsets   │
└──────────┬──────────────┘
           │
           ▼
┌─────────────────────────┐
│  Stage 3: Envelope      │  ← ~20ms (top 50 only)
│  Shape Correlation      │
│  Final ranking          │
└──────────┬──────────────┘
           │
           ▼
┌─────────────────────────┐
│  Results: File + offset │
│  + duration + score     │
│  Rendered in UI         │
└─────────────────────────┘
```

**Total latency target: < 350ms** for a complete Echo search.

### 4.2 Data Structures

#### 4.2.1 Extended SQLite Schema

```sql
-- Existing table (unchanged)
CREATE TABLE embeddings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_path TEXT UNIQUE,
    mtime INTEGER,
    vector BLOB  -- 512-D CLAP embedding, 2048 bytes
);

-- New table: Spectral fingerprint segments
CREATE TABLE spectral_index (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_path TEXT,
    mtime INTEGER,
    feature_matrix BLOB,  -- Compressed feature matrix for entire file
    duration_ms INTEGER,
    window_count INTEGER,
    UNIQUE(file_path)
);

-- Index for fast lookup
CREATE INDEX idx_spectral_path ON spectral_index(file_path);
```

#### 4.2.2 In-Memory Spectral Cache

```javascript
// Compact per-file spectral fingerprint
// Features per window: 13 MFCCs + spectral_centroid + spectral_flatness
//                    + spectral_bandwidth + rms + zcr = 18 floats
// Window: 50ms, hop: 25ms → 40 windows/sec
// 5-second file → 200 windows × 18 floats × 4 bytes = 14,400 bytes
// 70k files → ~1 GB (too large for RAM-resident)
// Solution: Load on-demand during Stage 2, LRU cache of ~2000 files (~28 MB)
```

### 4.3 Spectral Feature Extraction Engine

This is the core DSP component. It runs in the **main process** (or a Worker Thread) and operates purely on raw Float32Array PCM data.

```javascript
// Pseudocode for the feature extractor
class SpectralFingerprinter {
    constructor() {
        this.FFT_SIZE = 2048;       // ~42ms at 48kHz
        this.HOP_SIZE = 1200;       // 25ms hop
        this.SAMPLE_RATE = 48000;
        this.N_MELS = 64;           // Mel filter bank bands
        this.N_MFCC = 13;           // MFCC coefficients to keep
        this.FEATURES_PER_WINDOW = 18; // 13 MFCC + 5 spectral
        
        // Pre-compute mel filter bank (one-time)
        this.melFilters = this._buildMelFilterBank();
        // Pre-compute DCT matrix for MFCC
        this.dctMatrix = this._buildDCTMatrix();
        // Pre-compute Hann window
        this.hannWindow = this._buildHannWindow();
    }

    // Extract feature matrix from raw PCM audio
    extract(pcmFloat32, sampleRate = 48000) {
        // Resample if necessary
        const audio = sampleRate === this.SAMPLE_RATE 
            ? pcmFloat32 
            : this._resample(pcmFloat32, sampleRate, this.SAMPLE_RATE);
        
        const numWindows = Math.floor(
            (audio.length - this.FFT_SIZE) / this.HOP_SIZE
        ) + 1;
        
        // Output: Float32Array of numWindows × FEATURES_PER_WINDOW
        const matrix = new Float32Array(numWindows * this.FEATURES_PER_WINDOW);
        
        for (let w = 0; w < numWindows; w++) {
            const offset = w * this.HOP_SIZE;
            const frame = audio.subarray(offset, offset + this.FFT_SIZE);
            
            // Apply window → FFT → magnitude spectrum
            const spectrum = this._windowedFFT(frame);
            
            // Mel filter bank → log mel spectrum
            const melSpec = this._applyMelFilters(spectrum);
            
            // DCT → MFCCs (first 13)
            const mfccs = this._computeMFCC(melSpec);
            
            // Spectral features from magnitude spectrum
            const centroid = this._spectralCentroid(spectrum);
            const flatness = this._spectralFlatness(spectrum);
            const bandwidth = this._spectralBandwidth(spectrum, centroid);
            const rms = this._rms(frame);
            const zcr = this._zeroCrossingRate(frame);
            
            // Pack into matrix row
            const rowOffset = w * this.FEATURES_PER_WINDOW;
            matrix.set(mfccs, rowOffset);          // [0..12] MFCCs
            matrix[rowOffset + 13] = centroid;      // [13]
            matrix[rowOffset + 14] = flatness;      // [14]
            matrix[rowOffset + 15] = bandwidth;     // [15]
            matrix[rowOffset + 16] = rms;           // [16]
            matrix[rowOffset + 17] = zcr;           // [17]
        }
        
        return { matrix, numWindows, windowMs: 50, hopMs: 25 };
    }
}
```

### 4.4 Segment Matching Algorithm

The core matching uses a **sliding window cosine distance**, not full DTW (which is too slow). This works by comparing the query's feature sequence against every possible alignment within a candidate file.

```javascript
// Find best matching segment within a candidate file
function findBestSegment(queryMatrix, queryLen, fileMatrix, fileLen, featureDim) {
    let bestScore = -Infinity;
    let bestOffset = 0;
    
    // Slide query window across the file
    for (let offset = 0; offset <= fileLen - queryLen; offset++) {
        let score = 0;
        for (let w = 0; w < queryLen; w++) {
            // Cosine similarity between query window w and file window (offset + w)
            const qOff = w * featureDim;
            const fOff = (offset + w) * featureDim;
            
            let dot = 0, qNorm = 0, fNorm = 0;
            for (let d = 0; d < featureDim; d++) {
                const q = queryMatrix[qOff + d];
                const f = fileMatrix[fOff + d];
                dot += q * f;
                qNorm += q * q;
                fNorm += f * f;
            }
            score += dot / (Math.sqrt(qNorm) * Math.sqrt(fNorm) + 1e-8);
        }
        score /= queryLen; // Average similarity across windows
        
        if (score > bestScore) {
            bestScore = score;
            bestOffset = offset;
        }
    }
    
    return { score: bestScore, offsetWindows: bestOffset };
}
```

**Performance Analysis:**
- Query: 0.5 seconds = 20 windows
- Candidate file: 5 seconds = 200 windows
- Iterations: (200 - 20) × 20 × 18 = 64,800 float operations per file
- 500 candidate files: 32.4M operations → ~15ms on modern CPU
- This is well within the latency budget.

### 4.5 Feature Weighting System

Sound designers may want to emphasize different aspects of similarity. Echo Vault should expose controllable weights:

```javascript
const FEATURE_WEIGHTS = {
    timbre: 1.0,      // MFCCs 2-12 weight multiplier
    brightness: 1.0,  // Spectral centroid weight
    texture: 1.0,     // Spectral flatness weight (noisy vs tonal)
    energy: 0.5,      // RMS envelope weight
    transient: 0.8    // ZCR + onset weight
};
```

These can be exposed as small draggable controls in the UI (consistent with SoundVault's handle-based interaction model).

---

## 5. UX / UI Design for Echo Vault

### 5.1 Triggering an Echo Search

**Primary trigger: Context menu on selection:**
When a user has an active selection on a waveform, the context menu (right-click) includes:

```
  ┌──────────────────────────┐
  │  Play Selection     ▶    │
  │  Edit Selection     ✎    │
  │  ─────────────────────── │
  │  Echo ◉ Find Similar     │  ← New action
  │  ─────────────────────── │
  │  Export Selection   ↓    │
  │  Drag to DAW       ≋    │
  └──────────────────────────┘
```

**Secondary trigger: Keyboard shortcut:** `Cmd+E` / `Ctrl+E` (E for Echo) while a selection is active.

**Tertiary trigger: Selection toolbar button:** A small `◉` icon added to the existing global selection toolbar (next to Play, Drag, Edit, Clear).

### 5.2 Results Panel

Results appear in a **dedicated panel** that slides in from the right side of the application, overlaying the sound list but not the editor/waveform area. The panel is dismissible and persistent until closed.

```
┌─ Echo Results ──────────────────────────────────┐
│                                                  │
│  Query: "explosion_debris_01.wav" [0.3s-0.8s]   │
│  ┌─ Similarity Axes ──────────┐                 │
│  │  Timbre  ████████░░  80%   │  ← Draggable    │
│  │  Texture ██████████ 100%   │                  │
│  │  Energy  ████░░░░░░  40%   │                  │
│  └────────────────────────────┘                  │
│                                                  │
│  ┌─ Result 1 ─ Score: 0.94 ──────────────────┐  │
│  │  debris_metal_03.wav                       │  │
│  │  ▓▓▓░░░░░░▒▒▒▒▒░░░░░░░░░░░░░             │  │
│  │       ╔══════╗  ← Highlighted match region │  │
│  │  [▶] [+ Collection] [Echo Again]           │  │
│  └────────────────────────────────────────────┘  │
│                                                  │
│  ┌─ Result 2 ─ Score: 0.89 ──────────────────┐  │
│  │  impact_rock_07.wav                        │  │
│  │  ░░▓▓▓▓░░░░▒▒▒▒▒▒░░░░░                   │  │
│  │    ╔════════╗                              │  │
│  │  [▶] [+ Collection] [Echo Again]           │  │
│  └────────────────────────────────────────────┘  │
│                                                  │
│  ... (scrollable, lazy-loaded)                   │
│                                                  │
│  Showing 24 of 147 matches                       │
└──────────────────────────────────────────────────┘
```

### 5.3 Waveform Highlighting

Each result shows a **miniature waveform** of the source file with the matched region visually highlighted. The highlight uses:
- A colored overlay (using the vault's accent color at 30% opacity) 
- Small triangular markers at the match boundaries (similar to existing crop handles but smaller)
- The matched region "pulses" gently on hover (opacity animation, 0.3 → 0.5)

### 5.4 Inline Playback

Clicking the `[▶]` button on a result plays **only the matched region** of that file, not the entire file. This allows rapid A/B comparison:
- Clicking `[▶]` on the query plays the original selection
- Clicking `[▶]` on a result plays the matched segment
- Keyboard shortcut `Space` toggles between the two most recently played

### 5.5 "Echo Again": Chained Exploration

Each result has an "Echo Again" button that uses the *matched region of that result* as a new query. This enables exploratory chains:

```
Original Selection → Echo → Result 3 → Echo Again → Result 7 → Echo Again → ...
```

This creates a powerful **serendipitous discovery** workflow that sound designers will love, the ability to "walk" through the library along timbral similarity paths.

### 5.6 Drag-to-Collection / Drag-to-DAW

Results are directly draggable to collections (existing workflow) and to the DAW (via existing `startDrag` IPC). The drag source is the **matched segment** rendered as a temporary WAV file (using existing `render-selection-wav` IPC).

---

## 6. Implementation Plan: Phased Approach

### Phase 1: Foundation: Spectral Feature Engine (Est. 3-5 days)

**Goal:** Build and test the DSP pipeline independent of UI.

**Files modified:** `semantic-engine.js`, `main.js`, `preload.js`

**Tasks:**

1.1 **Implement `SpectralFingerprinter` class** in a new file `spectral-engine.js`:
   - Pure JavaScript FFT implementation (radix-2 Cooley-Tukey)
   - Mel filter bank construction
   - DCT matrix for MFCC computation
   - Hann window function
   - Feature extraction pipeline (MFCC + spectral features)
   - Unit tests: verify MFCC output against reference implementation

1.2 **Add spectral indexing to SQLite:**
   - New `spectral_index` table
   - Feature matrix stored as compressed (zlib) BLOB
   - Integrate with existing `startIndexing()` flow, compute spectral features alongside CLAP embeddings
   - Estimated index size: ~20 bytes/window × 40 windows/sec × 5 sec avg × 70k files = ~280 MB on disk (compressed: ~70 MB)

1.3 **Implement `LRUFeatureCache`:**
   - In-memory LRU cache for decompressed spectral matrices
   - Capacity: ~2000 files (~28 MB)
   - Cache misses load from SQLite on demand (~2ms per file)

1.4 **IPC channel:** `echo-extract-features`, takes raw PCM Float32Array, returns feature matrix

### Phase 2: Search Pipeline (Est. 3-4 days)

**Goal:** End-to-end search from audio selection to ranked results.

**Files modified:** `semantic-engine.js`, `spectral-engine.js`, `main.js`, `preload.js`

**Tasks:**

2.1 **Implement CLAP audio-to-audio query:**
   - New method `searchByAudio(pcmFloat32, sampleRate)` in `SemanticEngine`
   - Extracts CLAP embedding from the provided audio fragment
   - Runs `_searchFlat()` against existing embedding cache
   - Returns top 500 candidates with scores

2.2 **Implement spectral segment matching:**
   - New method `findSimilarSegments(queryFeatures, candidatePaths, topK)` in `SpectralEngine`
   - For each candidate: load feature matrix (cache or SQLite) → sliding window comparison → best match offset + score
   - Returns results sorted by spectral similarity: `{ path, score, offsetMs, durationMs }`

2.3 **Implement envelope correlation (Stage 3):**
   - Normalized cross-correlation of RMS envelopes
   - Applied only to top 50 results from Stage 2
   - Final score = weighted combination of CLAP score, spectral score, and envelope score

2.4 **IPC channel:** `echo-search`, takes `{ pcmData, sampleRate, selectionDuration, weights }`, returns ranked results

2.5 **IPC channel:** `echo-search-progress`, for long searches, provides progress updates

### Phase 3: UI Integration (Est. 4-6 days)

**Goal:** Complete interactive Echo Vault UI.

**Files modified:** `index.html` (renderer)

**Tasks:**

3.1 **Echo trigger integration:**
   - Add `◉` button to global selection toolbar
   - Context menu entry "Echo: Find Similar"
   - Keyboard shortcut binding (`Cmd+E`)
   - Capture current selection's PCM data from `AudioBuffer`

3.2 **Results panel implementation:**
   - Slide-in panel (CSS transform, right-side)
   - Lazy-rendered result cards with mini-waveforms
   - Match region highlighting via Canvas overlay
   - Score badge with similarity percentage

3.3 **Mini-waveform rendering:**
   - Reuse existing `drawWf()` function adapted for smaller canvases
   - Add highlight overlay for matched region
   - Click-to-play matched segment

3.4 **Similarity axes controls:**
   - Vertical-drag handles for each axis (timbre, texture, energy)
   - Live re-ranking on weight change (re-runs Stage 2 + 3 without Stage 1)

3.5 **"Echo Again" chain:**
   - Button on each result → triggers new search with that result's matched segment as query
   - Breadcrumb trail showing echo chain history

3.6 **Integration with existing workflows:**
   - Drag result to collection
   - Drag matched segment to DAW (via temp WAV render)
   - Click result name to load in main editor

### Phase 4: Performance Optimization (Est. 2-3 days)

**Goal:** Meet the <350ms latency target for all library sizes.

**Tasks:**

4.1 **Worker Thread offloading:**
   - Move Stage 2 (spectral matching) to a dedicated Worker Thread
   - Main thread remains responsive during search
   - Progress reporting via `parentPort.postMessage()`

4.2 **Batch feature loading:**
   - Pre-load spectral matrices for top-500 candidates in a single SQLite query
   - Decompress in parallel using Worker Thread pool

4.3 **SIMD-style optimization of feature comparison:**
   - Loop unrolling for the 18-feature cosine distance
   - Pre-normalize feature vectors during indexing

4.4 **Incremental indexing:**
   - Spectral features computed alongside CLAP during `startIndexing()`
   - Changed/new files only
   - Background re-indexing doesn't block search

### Phase 5: Polish & Edge Cases (Est. 2-3 days)

**Tasks:**

5.1 **Handle edge cases:**
   - Very short selections (<100ms), pad or warn
   - Very long selections (>5s), truncate or subsample
   - Files with silence: skip segments below noise floor
   - Missing spectral index: fall back to CLAP-only results

5.2 **Empty state UX:**
   - "No similar sounds found" state
   - "Indexing in progress" state (spectral indexing may take longer)
   - "Select audio to echo" instruction state

5.3 **Persistence:**
   - Remember last echo results when switching views
   - Remember similarity axis weights per session

---

## 7. Technical Details: DSP Implementation Notes

### 7.1 FFT in Pure JavaScript

Since SoundVault avoids external dependencies where possible, the FFT can be implemented as a radix-2 Cooley-Tukey in ~80 lines of JS. For a 2048-point FFT at 48kHz:

- Frequency resolution: 48000/2048 ≈ 23.4 Hz
- Time resolution per window: 2048/48000 ≈ 42.7ms
- With 25ms hop: ~40 windows per second

Performance: A 2048-point radix-2 FFT in optimized JS takes ~0.02ms on modern hardware. Extracting features for a 5-second file (200 windows) takes ~10ms total.

### 7.2 Mel Filter Bank Construction

```javascript
// Convert Hz to Mel scale
function hzToMel(hz) { return 2595 * Math.log10(1 + hz / 700); }
function melToHz(mel) { return 700 * (Math.pow(10, mel / 2595) - 1); }

// Build triangular filter bank
function buildMelFilterBank(nFilters, fftSize, sampleRate) {
    const fMin = 0, fMax = sampleRate / 2;
    const melMin = hzToMel(fMin), melMax = hzToMel(fMax);
    const melPoints = new Float64Array(nFilters + 2);
    for (let i = 0; i < nFilters + 2; i++) {
        melPoints[i] = melMin + (melMax - melMin) * i / (nFilters + 1);
    }
    // Convert back to Hz and then to FFT bin indices
    const binPoints = melPoints.map(m => 
        Math.floor((fftSize + 1) * melToHz(m) / sampleRate)
    );
    // Build triangular filters...
}
```

### 7.3 Feature Normalization Strategy

Features must be normalized to comparable scales before combining into a similarity score. During indexing:
- MFCCs: Z-score normalize using running mean/std across the library
- Spectral features: Min-max normalize to [0, 1]
- RMS: Log-scale, then normalize

Store normalization parameters in SQLite metadata table to ensure consistency.

### 7.4 Compression of Feature Matrices

Feature matrices are compressed before SQLite storage using Node.js `zlib.deflateSync()`:
- Raw: 200 windows × 18 features × 4 bytes = 14,400 bytes
- Compressed: ~3,000-5,000 bytes (audio features are highly correlated across adjacent windows)
- Decompression time: ~0.5ms per file

---

## 8. Memory & Storage Budget

| Component | Per File | 70k Files | Notes |
|---|---|---|---|
| CLAP embeddings (existing) | 2,048 B | 137 MB RAM | Contiguous Float32Array |
| Spectral index (SQLite) | ~4,000 B | ~270 MB disk | Compressed BLOBs |
| Spectral LRU cache | ~14,400 B | 28 MB RAM | 2000 files cached |
| **Total new RAM** |: | **~28 MB** | Minimal additional footprint |
| **Total new disk** |: | **~270 MB** | SQLite file |

---

## 9. API Contract: IPC Channels

### New Channels (preload.js additions):

```javascript
// Echo Vault API
echoSearch: (pcmData, sampleRate, duration, weights) => 
    ipcRenderer.invoke('echo-search', { pcmData, sampleRate, duration, weights }),

echoGetProgress: () => 
    ipcRenderer.invoke('echo-get-progress'),

echoExtractFeatures: (pcmData, sampleRate) => 
    ipcRenderer.invoke('echo-extract-features', { pcmData, sampleRate }),

// Spectral indexing (integrated with existing semantic indexing)
spectralIsReady: () => 
    ipcRenderer.invoke('spectral-is-ready'),

spectralGetProgress: () => 
    ipcRenderer.invoke('spectral-get-progress'),
```

### Response Format:

```javascript
// echo-search response
{
    results: [
        {
            path: "/path/to/file.wav",
            name: "file.wav",
            folder: "impacts/metal",
            score: 0.94,           // Combined similarity score [0, 1]
            clapScore: 0.87,       // Stage 1 CLAP score
            spectralScore: 0.96,   // Stage 2 spectral score
            envelopeScore: 0.91,   // Stage 3 envelope score
            matchOffsetMs: 1250,   // Where the match starts in the file
            matchDurationMs: 500,  // How long the matched segment is
        },
        // ... more results
    ],
    queryDurationMs: 500,
    searchTimeMs: 287,
    totalCandidates: 500,
    totalMatches: 147
}
```

---

## 10. Risk Assessment & Mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| Spectral indexing takes too long for large libraries | Medium | Background indexing with progress bar. Echo works with CLAP-only fallback while indexing. |
| FFT implementation has numerical precision issues | Low | Verify against known FFT test vectors. Use Float64 internally for FFT, cast to Float32 for storage. |
| Feature normalization statistics skewed by library composition | Medium | Use robust statistics (median/IQR instead of mean/std). Re-normalize periodically. |
| CLAP coarse filter misses relevant candidates | Medium | Allow user to increase candidate pool (200 → 1000) via a "Deep Echo" mode. |
| Memory pressure from LRU cache on low-RAM machines | Low | Configurable cache size. Minimum: 500 files (~7 MB). |
| Very short selections (<100ms) produce poor matches | Medium | Minimum selection length warning. Auto-extend to nearest zero-crossing. |

---

## 11. Future Extensions

### 11.1 Temporal Pattern Matching
Implement onset-pattern matching for rhythmic similarity. Extract onset strength curves and use normalized cross-correlation.

### 11.2 Pitch-Invariant Mode
Apply pitch normalization (shift all audio to a reference fundamental) before feature extraction. Allows finding "same timbre, different note" matches.

### 11.3 Batch Echo
Select multiple files/fragments → compute centroid features → find sounds that match the "average" of the batch. Extension of the existing `suggestForCollection` concept.

### 11.4 Echo Map Visualization
A 2D t-SNE/UMAP projection of the spectral feature space, rendered as an interactive Canvas map where users can browse the library spatially.

### 11.5 Live Echo
As the user drags a selection, continuously update results in real-time. Requires sub-100ms search latency: achievable with pre-warmed caches.

---

## 12. Glossary

| Term | Definition |
|---|---|
| **CLAP** | Contrastive Language-Audio Pretraining: neural model that embeds audio and text into a shared 512-D vector space |
| **MFCC** | Mel-Frequency Cepstral Coefficients: compact representation of spectral envelope, captures timbre |
| **DTW** | Dynamic Time Warping: alignment algorithm for time-series comparison (too slow for our use) |
| **Mel Scale** | Perceptual frequency scale that approximates human pitch perception |
| **Spectral Centroid** | The "center of mass" of the frequency spectrum, correlates with perceived brightness |
| **Spectral Flatness** | Ratio of geometric to arithmetic mean of spectrum, measures noisiness vs. tonality |
| **L2 Normalization** | Scaling a vector to unit length, enables dot product to equal cosine similarity |
| **LRU Cache** | Least Recently Used eviction strategy for bounded in-memory caches |

---

*Document version: 1.0: March 2026*
*Author: SoundVault Architecture Team*
*Status: RFC: Ready for Implementation Review*
