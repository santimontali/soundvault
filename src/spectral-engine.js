/**
 * SoundVault: Spectral Fingerprint Engine
 * 
 * Pure-JS DSP pipeline for fragment-level audio similarity search.
 * Extracts MFCCs + delta/delta-delta + spectral features from raw PCM audio.
 * Used by Echo Vault (Stage 2) for fine-grained timbral matching.
 * 
 * Features per window (44 floats):
 *   [0..12]   MFCCs (13 coefficients), static spectral shape
 *   [13..25]  Δ-MFCCs (13 coefficients), velocity of spectral change
 *   [26..38]  ΔΔ-MFCCs (13 coefficients), acceleration of spectral change
 *   [39]      Spectral Centroid (normalized)
 *   [40]      Spectral Flatness
 *   [41]      Spectral Bandwidth (normalized)
 *   [42]      RMS Energy (log-scale)
 *   [43]      Zero-Crossing Rate
 */


// ═══════════════════════════════════════════════════════════════════
//  Constants
// ═══════════════════════════════════════════════════════════════════

const FFT_SIZE = 2048;          // ~42.7ms at 48kHz
const HOP_SIZE = 1200;          // 25ms hop
const SAMPLE_RATE = 48000;
const N_MELS = 64;              // Mel filter bank bands
const N_MFCC = 13;              // MFCC coefficients to keep
const FEATURES_PER_WINDOW = 44; // 13 MFCC + 13 Δ + 13 ΔΔ + 5 spectral
const HALF_FFT = FFT_SIZE / 2 + 1; // 1025 bins

// ═══════════════════════════════════════════════════════════════════
//  Radix-2 Cooley-Tukey FFT (in-place, iterative)
// ═══════════════════════════════════════════════════════════════════

// Real FFT of FFT_SIZE through one complex FFT of half the size (even/odd
// packing), half the work of a full complex transform, identical output.
const _H = FFT_SIZE / 2;
const _bitRev = new Uint32Array(_H);
const _twRe = new Float64Array(_H / 2), _twIm = new Float64Array(_H / 2);
const _wRe = new Float64Array(_H + 1), _wIm = new Float64Array(_H + 1);
(function precomputeFFT() {
    const bits = Math.log2(_H);
    for (let i = 0; i < _H; i++) {
        let rev = 0;
        for (let b = 0; b < bits; b++) rev = (rev << 1) | ((i >> b) & 1);
        _bitRev[i] = rev;
    }
    for (let k = 0; k < _H / 2; k++) { _twRe[k] = Math.cos(-2 * Math.PI * k / _H); _twIm[k] = Math.sin(-2 * Math.PI * k / _H); }
    for (let k = 0; k <= _H; k++) { _wRe[k] = Math.cos(-2 * Math.PI * k / FFT_SIZE); _wIm[k] = Math.sin(-2 * Math.PI * k / FFT_SIZE); }
})();

// Reusable buffers for FFT computation (avoid GC pressure)
const _fftRe = new Float64Array(_H);
const _fftIm = new Float64Array(_H);

/**
 * Compute magnitude spectrum of a windowed frame.
 * Returns Float64Array of length HALF_FFT (magnitude, not power).
 * @param {Float32Array} frame - Windowed audio frame of length FFT_SIZE
 * @param {Float64Array} outMag - Output buffer of length HALF_FFT
 */
function fftMagnitude(frame, outMag) {
    for (let n = 0; n < _H; n++) {
        const j = _bitRev[n];
        _fftRe[j] = frame[2 * n];
        _fftIm[j] = frame[2 * n + 1];
    }
    for (let size = 2; size <= _H; size *= 2) {
        const half = size / 2, step = _H / size;
        for (let i = 0; i < _H; i += size) {
            for (let j = 0; j < half; j++) {
                const t = j * step, a = i + j, b = a + half;
                const tRe = _twRe[t] * _fftRe[b] - _twIm[t] * _fftIm[b];
                const tIm = _twRe[t] * _fftIm[b] + _twIm[t] * _fftRe[b];
                _fftRe[b] = _fftRe[a] - tRe; _fftIm[b] = _fftIm[a] - tIm;
                _fftRe[a] += tRe; _fftIm[a] += tIm;
            }
        }
    }
    // X[k] = E[k] + W^k·O[k], with E/O recovered from Z[k] and conj(Z[H-k])
    for (let k = 0; k <= _H; k++) {
        const k1 = k === _H ? 0 : k, k2 = k === 0 ? 0 : _H - k;
        const zr = _fftRe[k1], zi = _fftIm[k1], cr = _fftRe[k2], ci = -_fftIm[k2];
        const er = (zr + cr) * 0.5, ei = (zi + ci) * 0.5;
        const or = (zi - ci) * 0.5, oi = (cr - zr) * 0.5;
        const xr = er + _wRe[k] * or - _wIm[k] * oi;
        const xi = ei + _wRe[k] * oi + _wIm[k] * or;
        outMag[k] = Math.sqrt(xr * xr + xi * xi);
    }
}

// ═══════════════════════════════════════════════════════════════════
//  Hann Window (pre-computed)
// ═══════════════════════════════════════════════════════════════════

const _hannWindow = new Float32Array(FFT_SIZE);
for (let i = 0; i < FFT_SIZE; i++) {
    _hannWindow[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (FFT_SIZE - 1)));
}

// Reusable windowed frame buffer
const _windowedFrame = new Float32Array(FFT_SIZE);

// ═══════════════════════════════════════════════════════════════════
//  Mel Filter Bank (pre-computed)
// ═══════════════════════════════════════════════════════════════════

function hzToMel(hz) { return 2595 * Math.log10(1 + hz / 700); }
function melToHz(mel) { return 700 * (Math.pow(10, mel / 2595) - 1); }

/**
 * Build triangular mel filter bank.
 * Returns array of { startBin, endBin, weights[] } for each filter.
 */
function buildMelFilterBank() {
    const fMin = 0, fMax = SAMPLE_RATE / 2;
    const melMin = hzToMel(fMin), melMax = hzToMel(fMax);

    // N_MELS + 2 equally spaced points in mel scale
    const melPoints = new Float64Array(N_MELS + 2);
    for (let i = 0; i < N_MELS + 2; i++) {
        melPoints[i] = melMin + (melMax - melMin) * i / (N_MELS + 1);
    }

    // Convert to FFT bin indices
    const binPoints = new Uint32Array(N_MELS + 2);
    for (let i = 0; i < N_MELS + 2; i++) {
        binPoints[i] = Math.floor((FFT_SIZE + 1) * melToHz(melPoints[i]) / SAMPLE_RATE);
    }

    // Build sparse triangular filters
    const filters = [];
    for (let m = 0; m < N_MELS; m++) {
        const start = binPoints[m];
        const center = binPoints[m + 1];
        const end = binPoints[m + 2];
        const len = end - start + 1;
        const weights = new Float64Array(len);

        for (let k = start; k <= center; k++) {
            weights[k - start] = center > start ? (k - start) / (center - start) : 0;
        }
        for (let k = center + 1; k <= end; k++) {
            weights[k - start] = end > center ? (end - k) / (end - center) : 0;
        }

        filters.push({ startBin: start, endBin: end, weights });
    }
    return filters;
}

const _melFilters = buildMelFilterBank();

// Reusable buffers for mel/MFCC computation
const _melSpec = new Float64Array(N_MELS);
const _logMelSpec = new Float64Array(N_MELS);
const _mfccs = new Float64Array(N_MFCC);
const _magSpectrum = new Float64Array(HALF_FFT);

// ═══════════════════════════════════════════════════════════════════
//  DCT Matrix (Type-II, pre-computed for MFCC)
// ═══════════════════════════════════════════════════════════════════

const _dctMatrix = new Float64Array(N_MFCC * N_MELS);
for (let k = 0; k < N_MFCC; k++) {
    for (let n = 0; n < N_MELS; n++) {
        _dctMatrix[k * N_MELS + n] = Math.cos(Math.PI * k * (n + 0.5) / N_MELS);
    }
}

// ═══════════════════════════════════════════════════════════════════
//  SpectralFingerprinter
// ═══════════════════════════════════════════════════════════════════

class SpectralFingerprinter {
    /**
     * Extract RAW feature matrix (no normalization).
     * Used during indexing: normalization is applied later with global stats.
     * 
     * @param {Float32Array} pcmFloat32 - Mono audio samples
     * @param {number} [sampleRate=48000] - Sample rate of input
     * @returns {{ matrix: Float32Array, numWindows: number, windowMs: number, hopMs: number }}
     */
    extractRaw(pcmFloat32, sampleRate = SAMPLE_RATE) {
        // Resample if necessary (simple linear interpolation)
        let audio = pcmFloat32;
        if (sampleRate !== SAMPLE_RATE) {
            audio = this._resample(pcmFloat32, sampleRate, SAMPLE_RATE);
        }

        const numWindows = Math.max(1, Math.floor((audio.length - FFT_SIZE) / HOP_SIZE) + 1);
        const matrix = new Float32Array(numWindows * FEATURES_PER_WINDOW);

        for (let w = 0; w < numWindows; w++) {
            const offset = w * HOP_SIZE;
            const rowOffset = w * FEATURES_PER_WINDOW;

            // Apply Hann window
            const frameEnd = Math.min(offset + FFT_SIZE, audio.length);
            for (let i = 0; i < FFT_SIZE; i++) {
                _windowedFrame[i] = (offset + i < frameEnd) ? audio[offset + i] * _hannWindow[i] : 0;
            }

            // FFT → magnitude spectrum
            fftMagnitude(_windowedFrame, _magSpectrum);

            // Mel filter bank → log mel spectrum
            for (let m = 0; m < N_MELS; m++) {
                const f = _melFilters[m];
                let sum = 0;
                for (let k = 0; k < f.weights.length; k++) {
                    const bin = f.startBin + k;
                    if (bin < HALF_FFT) {
                        sum += _magSpectrum[bin] * f.weights[k];
                    }
                }
                _melSpec[m] = sum;
                _logMelSpec[m] = Math.log(Math.max(sum, 1e-10));
            }

            // DCT → MFCCs
            for (let k = 0; k < N_MFCC; k++) {
                let sum = 0;
                const dctRow = k * N_MELS;
                for (let n = 0; n < N_MELS; n++) {
                    sum += _logMelSpec[n] * _dctMatrix[dctRow + n];
                }
                matrix[rowOffset + k] = sum;
            }

            // Spectral Centroid (normalized to [0, 1] relative to Nyquist)
            let magSum = 0, weightedSum = 0;
            for (let i = 0; i < HALF_FFT; i++) {
                magSum += _magSpectrum[i];
                weightedSum += i * _magSpectrum[i];
            }
            const centroid = magSum > 1e-10 ? (weightedSum / magSum) / HALF_FFT : 0;
            matrix[rowOffset + 39] = centroid;  // slot 39

            // Spectral Flatness: geometric mean / arithmetic mean
            let logSum = 0;
            let arithmeticSum = 0;
            let validBins = 0;
            for (let i = 1; i < HALF_FFT; i++) {  // skip DC
                if (_magSpectrum[i] > 1e-10) {
                    logSum += Math.log(_magSpectrum[i]);
                    arithmeticSum += _magSpectrum[i];
                    validBins++;
                }
            }
            const flatness = validBins > 0
                ? Math.exp(logSum / validBins) / (arithmeticSum / validBins + 1e-10)
                : 0;
            matrix[rowOffset + 40] = flatness;  // slot 40

            // Spectral Bandwidth (normalized)
            let bwSum = 0;
            if (magSum > 1e-10) {
                const centroidBin = centroid * HALF_FFT;
                for (let i = 0; i < HALF_FFT; i++) {
                    const diff = i - centroidBin;
                    bwSum += diff * diff * _magSpectrum[i];
                }
                bwSum = Math.sqrt(bwSum / magSum) / HALF_FFT;
            }
            matrix[rowOffset + 41] = bwSum;  // slot 41

            // RMS Energy (log-scale)
            let rmsSum = 0;
            const frameLen = Math.min(FFT_SIZE, frameEnd - offset);
            for (let i = 0; i < frameLen; i++) {
                const s = audio[offset + i];
                rmsSum += s * s;
            }
            const rms = Math.sqrt(rmsSum / Math.max(frameLen, 1));
            matrix[rowOffset + 42] = Math.log(Math.max(rms, 1e-10));  // slot 42

            // Zero-Crossing Rate
            let zcr = 0;
            for (let i = 1; i < frameLen; i++) {
                if ((audio[offset + i] >= 0) !== (audio[offset + i - 1] >= 0)) zcr++;
            }
            matrix[rowOffset + 43] = zcr / Math.max(frameLen - 1, 1);  // slot 43
        }

        // ── Compute Δ and ΔΔ MFCCs (temporal dynamics) ──
        // Delta = weighted regression over ±DELTA_CTX windows
        // ΔΔ = delta of deltas
        const DELTA_CTX = 2;
        const deltaDenom = 2 * (1*1 + 2*2); // = 10 for ctx=2

        // First pass: compute Δ-MFCCs and store in slots [13..25]
        for (let w = 0; w < numWindows; w++) {
            const rowOff = w * FEATURES_PER_WINDOW;
            for (let k = 0; k < N_MFCC; k++) {
                let delta = 0;
                for (let n = 1; n <= DELTA_CTX; n++) {
                    const wPrev = Math.max(0, w - n);
                    const wNext = Math.min(numWindows - 1, w + n);
                    delta += n * (matrix[wNext * FEATURES_PER_WINDOW + k] - matrix[wPrev * FEATURES_PER_WINDOW + k]);
                }
                matrix[rowOff + N_MFCC + k] = delta / deltaDenom;  // slots 13..25
            }
        }

        // Second pass: compute ΔΔ-MFCCs from deltas, store in slots [26..38]
        for (let w = 0; w < numWindows; w++) {
            const rowOff = w * FEATURES_PER_WINDOW;
            for (let k = 0; k < N_MFCC; k++) {
                let deltaDelta = 0;
                for (let n = 1; n <= DELTA_CTX; n++) {
                    const wPrev = Math.max(0, w - n);
                    const wNext = Math.min(numWindows - 1, w + n);
                    deltaDelta += n * (matrix[wNext * FEATURES_PER_WINDOW + N_MFCC + k] - matrix[wPrev * FEATURES_PER_WINDOW + N_MFCC + k]);
                }
                matrix[rowOff + 2 * N_MFCC + k] = deltaDelta / deltaDenom;  // slots 26..38
            }
        }

        // NO normalization here: raw features returned
        return { matrix, numWindows, windowMs: Math.round(FFT_SIZE / SAMPLE_RATE * 1000), hopMs: Math.round(HOP_SIZE / SAMPLE_RATE * 1000) };
    }

    /**
     * Simple linear interpolation resampler.
     */
    _resample(input, fromRate, toRate) {
        const ratio = fromRate / toRate;
        const outLen = Math.floor(input.length / ratio);
        const output = new Float32Array(outLen);
        for (let i = 0; i < outLen; i++) {
            const srcIdx = i * ratio;
            const idx0 = Math.floor(srcIdx);
            const frac = srcIdx - idx0;
            const idx1 = Math.min(idx0 + 1, input.length - 1);
            output[i] = input[idx0] * (1 - frac) + input[idx1] * frac;
        }
        return output;
    }
}

// ═══════════════════════════════════════════════════════════════════
//  Build Feature Weight Vector from User Axes
// ═══════════════════════════════════════════════════════════════════

/**
 * Convert user-facing similarity axes into a 18-D weight vector.
 * @param {{ timbre?: number, brightness?: number, texture?: number, energy?: number, transient?: number }} axes
 * @returns {Float32Array} - 18-D weight vector
 */
function buildFeatureWeights(axes = {}) {
    const w = new Float32Array(FEATURES_PER_WINDOW);
    const timbre = axes.timbre ?? 1.0;
    const brightness = axes.brightness ?? 1.0;
    const texture = axes.texture ?? 1.0;
    const energy = axes.energy ?? 0.5;
    const transient = axes.transient ?? 0.8;

    // Static MFCCs [0..12]: timbre
    w[0] = energy;          // MFCC[0] is overall energy
    for (let i = 1; i < N_MFCC; i++) w[i] = timbre;

    // Δ-MFCCs [13..25]: temporal dynamics → transient weight
    w[13] = energy;         // Δ-MFCC[0], energy change rate
    for (let i = 1; i < N_MFCC; i++) w[N_MFCC + i] = transient;

    // ΔΔ-MFCCs [26..38]: acceleration → slightly reduced transient weight
    w[26] = energy * 0.7;   // ΔΔ-MFCC[0], energy acceleration
    for (let i = 1; i < N_MFCC; i++) w[2 * N_MFCC + i] = transient * 0.7;

    // Spectral features [39..43]
    w[39] = brightness;    // Spectral Centroid
    w[40] = texture;       // Spectral Flatness
    w[41] = brightness;    // Spectral Bandwidth
    w[42] = energy;        // RMS
    w[43] = transient;     // ZCR

    return w;
}

// ═══════════════════════════════════════════════════════════════════
//  Exports
// ═══════════════════════════════════════════════════════════════════

module.exports = {
    SpectralFingerprinter,
    buildFeatureWeights,
    FEATURES_PER_WINDOW,
    HOP_SIZE,
    FFT_SIZE,
    SAMPLE_RATE,
};
