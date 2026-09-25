'use strict';
/**
 * WAV I/O without subprocesses:
 *   readWavInfo(path)        RIFF/RF64 chunk walker (seeks; handles BWF/iXML/JUNK
 *                            of any size, odd-sized chunks, bogus data sizes)
 *   computeWavPeaks(path, n) streaming peak+RMS buckets (bounded memory)
 *   encodeWav(opts)          fast PCM16/PCM24/Float32 encoder (typed arrays)
 * All functions are pure Node (no Electron) and unit-tested.
 */
const fs = require('fs');

const FMT_PCM = 1, FMT_FLOAT = 3, FMT_EXTENSIBLE = 0xFFFE;

/**
 * @returns {Promise<null|{format:number,channels:number,sampleRate:number,bitsPerSample:number,
 *   blockAlign:number,dataOffset:number,dataSize:number,frames:number,duration:number,fileSize:number}>}
 */
async function readWavInfo(fp) {
    let fh;
    try {
        fh = await fs.promises.open(fp, 'r');
        const { size: fileSize } = await fh.stat();
        if (fileSize < 12) return null;
        const hdr = Buffer.alloc(12);
        await fh.read(hdr, 0, 12, 0);
        const riff = hdr.toString('ascii', 0, 4);
        if ((riff !== 'RIFF' && riff !== 'RF64') || hdr.toString('ascii', 8, 12) !== 'WAVE') return null;

        let pos = 12, fmt = null, dataOffset = -1, dataSize = 0, ds64DataSize = null;
        const ch = Buffer.alloc(8);
        for (let guard = 0; guard < 4096 && pos + 8 <= fileSize; guard++) {
            await fh.read(ch, 0, 8, pos);
            const id = ch.toString('ascii', 0, 4);
            let size = ch.readUInt32LE(4);
            const body = pos + 8;
            if (id === 'ds64' && size >= 16) {
                const b = Buffer.alloc(16); await fh.read(b, 0, 16, body);
                ds64DataSize = Number(b.readBigUInt64LE(8));
            } else if (id === 'fmt ') {
                const len = Math.min(size, 64);
                const b = Buffer.alloc(len); await fh.read(b, 0, len, body);
                if (len < 16) return null;
                let format = b.readUInt16LE(0);
                const channels = b.readUInt16LE(2), sampleRate = b.readUInt32LE(4);
                const blockAlign = b.readUInt16LE(12), bitsPerSample = b.readUInt16LE(14);
                if (format === FMT_EXTENSIBLE && len >= 26) format = b.readUInt16LE(24);
                fmt = { format, channels, sampleRate, blockAlign, bitsPerSample };
            } else if (id === 'data') {
                dataOffset = body;
                if (riff === 'RF64' && size === 0xFFFFFFFF && ds64DataSize != null) size = ds64DataSize;
                // Streaming writers leave 0/0xFFFFFFFF; truncated files report more than exists.
                dataSize = (size === 0 || size === 0xFFFFFFFF || body + size > fileSize) ? fileSize - body : size;
                if (fmt) break;
            }
            if (id === 'data' && size >= 0xFFFFFFFF) break;
            pos = body + size + (size & 1);
        }
        if (!fmt || dataOffset < 0) return null;
        if (fmt.format !== FMT_PCM && fmt.format !== FMT_FLOAT) return null;
        if (!fmt.channels || !fmt.sampleRate || !fmt.bitsPerSample) return null;
        const blockAlign = fmt.blockAlign || (fmt.channels * fmt.bitsPerSample / 8);
        const frames = Math.floor(dataSize / blockAlign);
        return { ...fmt, blockAlign, dataOffset, dataSize: frames * blockAlign, frames, duration: frames / fmt.sampleRate, fileSize };
    } catch (e) {
        return null;
    } finally {
        if (fh) await fh.close().catch(() => {});
    }
}

/** Sample decoder factory: returns (buf, byteOffset) => float in [-1, 1]. */
function sampleReader(format, bits) {
    if (format === FMT_FLOAT && bits === 32) return (b, o) => b.readFloatLE(o);
    if (format === FMT_FLOAT && bits === 64) return (b, o) => b.readDoubleLE(o);
    if (format !== FMT_PCM) return null;
    switch (bits) {
        case 8: return (b, o) => (b[o] - 128) / 128;
        case 16: return (b, o) => b.readInt16LE(o) / 32768;
        case 24: return (b, o) => { let v = b[o] | (b[o + 1] << 8) | (b[o + 2] << 16); if (v & 0x800000) v |= ~0xFFFFFF; return v / 8388608; };
        case 32: return (b, o) => b.readInt32LE(o) / 2147483648;
        default: return null;
    }
}

/**
 * Stream the data chunk and reduce it to `buckets` (peak, rms) pairs.
 * Memory is bounded by the read chunk size regardless of file length.
 * @returns {Promise<null|{peaks:Float32Array,rms:Float32Array,maxPeak:number,info:object}>}
 */
async function computeWavPeaks(fp, buckets = 1024, info = null) {
    info = info || await readWavInfo(fp);
    if (!info || !info.frames) return info ? { peaks: new Float32Array(buckets), rms: new Float32Array(buckets), maxPeak: 0, info } : null;
    const read = sampleReader(info.format, info.bitsPerSample);
    if (!read) return null;
    const { channels: nc, blockAlign, frames } = info;
    const bytesPerSample = info.bitsPerSample / 8;
    const peaks = new Float32Array(buckets);
    const sumSq = new Float64Array(buckets);
    const counts = new Uint32Array(buckets);
    const framesPerChunk = Math.max(1, Math.floor((1 << 20) / blockAlign)); // ~1 MB reads
    const buf = Buffer.alloc(framesPerChunk * blockAlign);
    // Decimate very long files: inspecting every frame of a 10-minute file is
    // wasteful for 1024 buckets. Keep ≥ 1 sample per 8 frames per bucket window.
    const stride = Math.max(1, Math.floor(frames / (buckets * 2048)));
    let fh;
    try {
        fh = await fs.promises.open(fp, 'r');
        let maxPeak = 0;
        for (let f0 = 0; f0 < frames; f0 += framesPerChunk) {
            const nf = Math.min(framesPerChunk, frames - f0);
            const { bytesRead } = await fh.read(buf, 0, nf * blockAlign, info.dataOffset + f0 * blockAlign);
            const got = Math.floor(bytesRead / blockAlign);
            if (!got) break;
            for (let i = (stride - (f0 % stride)) % stride; i < got; i += stride) {
                const frame = f0 + i;
                const bIdx = Math.min(buckets - 1, Math.floor(frame * buckets / frames));
                const base = i * blockAlign;
                let fp_ = 0, fs_ = 0;
                for (let c = 0; c < nc; c++) {
                    const v = read(buf, base + c * bytesPerSample);
                    const a = v < 0 ? -v : v;
                    if (a > fp_) fp_ = a;
                    fs_ += v * v;
                }
                if (fp_ > peaks[bIdx]) peaks[bIdx] = fp_;
                if (fp_ > maxPeak) maxPeak = fp_;
                sumSq[bIdx] += fs_ / nc;
                counts[bIdx]++;
            }
            if (got < nf) break;
        }
        const rms = new Float32Array(buckets);
        for (let i = 0; i < buckets; i++) rms[i] = counts[i] ? Math.sqrt(sumSq[i] / counts[i]) : 0;
        // Very short files have fewer frames than buckets: spread instead of leaving gaps.
        if (frames < buckets) fillGaps(peaks, rms, counts);
        return { peaks, rms, maxPeak: Math.min(1, maxPeak), info };
    } catch (e) {
        return null;
    } finally {
        if (fh) await fh.close().catch(() => {});
    }
}

function fillGaps(peaks, rms, counts) {
    let last = -1;
    for (let i = 0; i < peaks.length; i++) {
        if (counts[i]) { last = i; continue; }
        if (last >= 0) { peaks[i] = peaks[last]; rms[i] = rms[last]; }
    }
}

/** Reduce mono/stereo Float32 PCM (already decoded) to peak+RMS buckets. */
function peaksFromChannels(channels, buckets = 1024) {
    const n = channels[0] ? channels[0].length : 0;
    const peaks = new Float32Array(buckets), rms = new Float32Array(buckets);
    if (!n) return { peaks, rms, maxPeak: 0 };
    const sumSq = new Float64Array(buckets), counts = new Uint32Array(buckets);
    const nc = channels.length;
    let maxPeak = 0;
    for (let i = 0; i < n; i++) {
        const b = Math.min(buckets - 1, Math.floor(i * buckets / n));
        let p = 0, s = 0;
        for (let c = 0; c < nc; c++) { const v = channels[c][i]; const a = v < 0 ? -v : v; if (a > p) p = a; s += v * v; }
        if (p > peaks[b]) peaks[b] = p;
        if (p > maxPeak) maxPeak = p;
        sumSq[b] += s / nc; counts[b]++;
    }
    for (let i = 0; i < buckets; i++) rms[i] = counts[i] ? Math.sqrt(sumSq[i] / counts[i]) : 0;
    if (n < buckets) fillGaps(peaks, rms, counts);
    return { peaks, rms, maxPeak: Math.min(1, maxPeak) };
}

/**
 * Encode planar Float32 channels as a WAV file buffer.
 * @param {{channels: Float32Array[], sampleRate: number, bitDepth?: 16|24|32, float?: boolean}} o
 */
function encodeWav({ channels, sampleRate, bitDepth = 24, float = false }) {
    const nc = channels.length;
    if (!nc) throw new Error('encodeWav: no channels');
    const n = channels[0].length;
    for (const c of channels) if (c.length !== n) throw new Error('encodeWav: channel length mismatch');
    if (float) bitDepth = 32;
    if (![16, 24, 32].includes(bitDepth)) throw new Error('encodeWav: unsupported bit depth ' + bitDepth);
    const bps = bitDepth / 8, blockAlign = nc * bps, dataSize = n * blockAlign;
    const ab = new ArrayBuffer(44 + dataSize);
    const buf = Buffer.from(ab);
    buf.write('RIFF', 0, 'ascii'); buf.writeUInt32LE(36 + dataSize, 4); buf.write('WAVE', 8, 'ascii');
    buf.write('fmt ', 12, 'ascii'); buf.writeUInt32LE(16, 16);
    buf.writeUInt16LE(float ? FMT_FLOAT : FMT_PCM, 20); buf.writeUInt16LE(nc, 22);
    buf.writeUInt32LE(sampleRate, 24); buf.writeUInt32LE(sampleRate * blockAlign, 28);
    buf.writeUInt16LE(blockAlign, 32); buf.writeUInt16LE(bitDepth, 34);
    buf.write('data', 36, 'ascii'); buf.writeUInt32LE(dataSize, 40);
    const clamp = v => (v > 1 ? 1 : v < -1 ? -1 : (v !== v ? 0 : v)); // NaN → 0
    if (float) {
        // Float keeps values above 0 dBFS (that is why float is chosen); only NaN is scrubbed.
        const out = new Float32Array(ab, 44, n * nc);
        for (let i = 0, k = 0; i < n; i++) for (let c = 0; c < nc; c++) { const v = channels[c][i]; out[k++] = v !== v ? 0 : v; }
    } else if (bitDepth === 16) {
        const out = new Int16Array(ab, 44, n * nc);
        for (let i = 0, k = 0; i < n; i++) for (let c = 0; c < nc; c++) { const v = clamp(channels[c][i]); out[k++] = v < 0 ? Math.round(v * 32768) : Math.round(v * 32767); }
    } else if (bitDepth === 24) {
        const out = new Uint8Array(ab, 44, dataSize);
        for (let i = 0, k = 0; i < n; i++) for (let c = 0; c < nc; c++) {
            const v = clamp(channels[c][i]);
            let s = v < 0 ? Math.round(v * 8388608) : Math.round(v * 8388607);
            if (s < 0) s += 0x1000000;
            out[k++] = s & 0xFF; out[k++] = (s >> 8) & 0xFF; out[k++] = (s >> 16) & 0xFF;
        }
    } else {
        const out = new Int32Array(ab, 44, n * nc);
        for (let i = 0, k = 0; i < n; i++) for (let c = 0; c < nc; c++) { const v = clamp(channels[c][i]); out[k++] = v < 0 ? Math.round(v * 2147483648) : Math.round(v * 2147483647); }
    }
    return buf;
}

module.exports = { readWavInfo, computeWavPeaks, peaksFromChannels, encodeWav, sampleReader, FMT_PCM, FMT_FLOAT, FMT_EXTENSIBLE };
