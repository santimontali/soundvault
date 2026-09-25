'use strict';
/**
 * Native WAV → mono Float32 decoding at a target rate, for analysis
 * (CLAP embeddings, Echo fingerprints). Replaces one ffmpeg process per file
 * (~40-80 ms of spawn overhead on Windows) with a direct read + windowed-sinc
 * resampler. Callers fall back to ffmpeg when this returns null (compressed
 * or broken WAVs).
 *
 * Downmix matches ffmpeg's `-ac 1` for float output (L+R)·√½ so vectors stay
 * comparable with the ones indexed by earlier versions.
 */
const fs = require('fs');
const { readWavInfo, FMT_PCM, FMT_FLOAT } = require('./wav');

// ── resampler ─────────────────────────────────────────────────────────────
const ZERO_CROSSINGS = 12;
const ROLLOFF = 0.9;
const KAISER_BETA = 8;

function besselI0(x) {
    let sum = 1, term = 1;
    const q = x * x / 4;
    for (let k = 1; k < 64; k++) { term *= q / (k * k); sum += term; if (term < sum * 1e-12) break; }
    return sum;
}

function gcd(a, b) { while (b) { const t = a % b; a = b; b = t; } return a; }

const kernels = new Map();

/**
 * Exact polyphase filter bank for inRate → outRate:
 *   L phases (outRate/g), each `taps` long, stepping M (inRate/g) input samples per L outputs.
 */
function polyphase(inRate, outRate) {
    const k = inRate + ':' + outRate;
    let f = kernels.get(k);
    if (f) return f;
    const g = gcd(inRate, outRate);
    const L = outRate / g, M = inRate / g;
    if (L > 4096) return null;
    const cutoff = Math.min(1, outRate / inRate) * ROLLOFF;       // relative to the input Nyquist
    const half = Math.ceil(ZERO_CROSSINGS / cutoff);                // half-width in input samples
    const taps = 2 * half;
    const i0b = besselI0(KAISER_BETA);
    const bank = new Float32Array(L * taps);
    for (let p = 0; p < L; p++) {
        // output sample n (phase p) sits at input time t = n·M/L; frac = (p·M mod L)/L
        const frac = ((p * M) % L) / L;
        let sum = 0;
        for (let j = 0; j < taps; j++) {
            const x = (j - half + 1) - frac;                        // input offset relative to t
            const r = x / (half);                                    // -1 … 1
            let h = 0;
            if (Math.abs(r) < 1) {
                const w = besselI0(KAISER_BETA * Math.sqrt(1 - r * r)) / i0b;
                const s = x === 0 ? 1 : Math.sin(Math.PI * cutoff * x) / (Math.PI * cutoff * x);
                h = cutoff * s * w;
            }
            bank[p * taps + j] = h;
            sum += h;
        }
        if (sum) for (let j = 0; j < taps; j++) bank[p * taps + j] /= sum;   // unity DC gain per phase
    }
    f = { L, M, taps, half, bank };
    kernels.set(k, f);
    return f;
}

/** Resample mono Float32 PCM. Returns the input unchanged when the rates match. */
function resample(input, inRate, outRate) {
    if (inRate === outRate || !input.length) return input;
    const f = polyphase(inRate, outRate);
    const outLen = Math.max(1, Math.floor(input.length * outRate / inRate));
    const out = new Float32Array(outLen);
    const n = input.length;
    if (f) {
        const { L, M, taps, half, bank } = f;
        for (let o = 0; o < outLen; o++) {
            const num = o * M;
            const base = Math.floor(num / L) - half + 1;             // first input index under the kernel
            const p = o % L;
            const k0 = p * taps;
            let acc = 0;
            if (base >= 0 && base + taps <= n) {
                for (let j = 0; j < taps; j++) acc += input[base + j] * bank[k0 + j];
            } else {
                for (let j = 0; j < taps; j++) { const i = base + j; if (i >= 0 && i < n) acc += input[i] * bank[k0 + j]; }
            }
            out[o] = acc;
        }
        return out;
    }
    // Unusual rate pair (huge phase count): linear interpolation between neighbours
    // after a simple moving-average anti-alias when downsampling.
    const step = inRate / outRate;
    for (let o = 0; o < outLen; o++) {
        const t = o * step, i = Math.floor(t), fr = t - i;
        const a = input[Math.min(i, n - 1)], b = input[Math.min(i + 1, n - 1)];
        out[o] = a + (b - a) * fr;
    }
    return out;
}

// ── decoding ──────────────────────────────────────────────────────────────
/** Interleaved PCM bytes → mono floats written at dst[at…]. Returns false for unsupported layouts. */
function decodeInto(dst, at, buf, frames, info) {
    const nc = info.channels, bits = info.bitsPerSample, fmt = info.format;
    const gain = nc === 1 ? 1 : nc === 2 ? Math.SQRT1_2 : 1 / Math.sqrt(nc);
    const ab = buf.buffer, off = buf.byteOffset;
    if (fmt === FMT_PCM && bits === 16 && off % 2 === 0) {
        const s = new Int16Array(ab, off, frames * nc);
        const g = gain / 32768;
        for (let i = 0, k = 0; i < frames; i++) { let v = 0; for (let c = 0; c < nc; c++) v += s[k++]; dst[at + i] = v * g; }
    } else if (fmt === FMT_PCM && bits === 24) {
        const g = gain / 8388608;
        for (let i = 0, o = 0; i < frames; i++) {
            let v = 0;
            for (let c = 0; c < nc; c++, o += 3) v += (buf[o] | (buf[o + 1] << 8) | (buf[o + 2] << 24) >> 8);
            dst[at + i] = v * g;
        }
    } else if (fmt === FMT_FLOAT && bits === 32 && off % 4 === 0) {
        const s = new Float32Array(ab, off, frames * nc);
        for (let i = 0, k = 0; i < frames; i++) { let v = 0; for (let c = 0; c < nc; c++) { const x = s[k++]; if (x === x) v += x; } dst[at + i] = v * gain; }
    } else if (fmt === FMT_PCM && bits === 32 && off % 4 === 0) {
        const s = new Int32Array(ab, off, frames * nc);
        const g = gain / 2147483648;
        for (let i = 0, k = 0; i < frames; i++) { let v = 0; for (let c = 0; c < nc; c++) v += s[k++]; dst[at + i] = v * g; }
    } else if (fmt === FMT_PCM && bits === 8) {
        const g = gain / 128;
        for (let i = 0, k = 0; i < frames; i++) { let v = 0; for (let c = 0; c < nc; c++) v += buf[k++] - 128; dst[at + i] = v * g; }
    } else {
        // Unaligned views or 64-bit float: DataView path
        const dv = new DataView(ab, off, frames * info.blockAlign);
        const bps = bits / 8;
        for (let i = 0; i < frames; i++) {
            let v = 0;
            for (let c = 0; c < nc; c++) {
                const o = i * info.blockAlign + c * bps;
                let x;
                if (fmt === FMT_FLOAT) x = bits === 64 ? dv.getFloat64(o, true) : dv.getFloat32(o, true);
                else if (bits === 16) x = dv.getInt16(o, true) / 32768;
                else if (bits === 32) x = dv.getInt32(o, true) / 2147483648;
                else return false;
                if (x === x) v += x;
            }
            dst[at + i] = v * gain;
        }
    }
    return true;
}

function supported(info) {
    if (!info || info.channels < 1 || info.channels > 32) return false;
    if (info.blockAlign !== info.channels * info.bitsPerSample / 8) return false;   // padded containers → ffmpeg
    if (info.format === FMT_FLOAT) return info.bitsPerSample === 32 || info.bitsPerSample === 64;
    return info.format === FMT_PCM && [8, 16, 24, 32].includes(info.bitsPerSample);
}

const CHUNK_BYTES = 4 << 20;

/**
 * Decode up to `maxSeconds` from `startSeconds` of a WAV as mono Float32 at `rate`.
 * Reads in 4 MB chunks, so memory stays at ~one native-rate mono copy.
 * @returns {Promise<null|{samples:Float32Array, rate:number, duration:number, info:object}>}
 *   `duration` is the full file duration (from the header), not the decoded length.
 */
async function decodeWavMono(fp, { rate = 48000, maxSeconds = Infinity, startSeconds = 0, info = null } = {}) {
    info = info || await readWavInfo(fp);
    if (!supported(info)) return null;
    const startFrame = Math.min(info.frames, Math.max(0, Math.floor(startSeconds * info.sampleRate)));
    const frames = Math.min(info.frames - startFrame, Number.isFinite(maxSeconds) ? Math.ceil(maxSeconds * info.sampleRate) : Infinity);
    if (!(frames > 0)) return { samples: new Float32Array(0), rate, duration: info.duration, info };
    if (frames > 400e6) return null;                                  // absurd sizes → ffmpeg path
    const mono = new Float32Array(frames);
    const framesPerChunk = Math.max(1, Math.floor(CHUNK_BYTES / info.blockAlign));
    const buf = Buffer.allocUnsafe(Math.min(frames, framesPerChunk) * info.blockAlign);
    let fh, done = 0;
    try {
        fh = await fs.promises.open(fp, 'r');
        const base = info.dataOffset + startFrame * info.blockAlign;
        while (done < frames) {
            const nf = Math.min(framesPerChunk, frames - done);
            const want = nf * info.blockAlign;
            let got = 0;
            while (got < want) {
                const { bytesRead } = await fh.read(buf, got, want - got, base + done * info.blockAlign + got);
                if (!bytesRead) break;
                got += bytesRead;
            }
            const whole = Math.floor(got / info.blockAlign);
            if (!decodeInto(mono, done, buf, whole, info)) return null;
            done += whole;
            if (whole < nf) break;                                    // truncated file
        }
    } catch (e) {
        return null;
    } finally {
        if (fh) await fh.close().catch(() => {});
    }
    const native = done < frames ? mono.subarray(0, done) : mono;
    return { samples: resample(native, info.sampleRate, rate), rate, duration: info.duration, info };
}

module.exports = { decodeWavMono, resample, polyphase, supported };
