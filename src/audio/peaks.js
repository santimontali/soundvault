'use strict';

/**
 * Audio peak/waveform extraction, extracted from `src/main.js` so it can run
 * under plain Node (no Electron `app` import) and be profiled/benchmarked
 * directly by the test suite.
 *
 * Three-tier resolution lives in `src/main.js::get-peaks` (SQLite cache →
 * direct WAV parser → ffmpeg fallback); the two non-cache tiers are pure and
 * live here.
 */

const fs = require('fs');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');

ffmpeg.setFfmpegPath(ffmpegStatic);

const DEFAULT_NUM_PEAKS = 4000;
const WAVE_FORMAT_EXTENSIBLE = 0xFFFE;

/**
 * Reduce a full mono float PCM buffer to `numPeaks` per-window max-amplitude
 * peaks. Shared by the WAV and ffmpeg paths.
 *
 * @param {Float32Array} samples Mono f32 PCM.
 * @param {number} sampleRate
 * @param {number} [numPeaks=4000]
 * @returns {{peaks:Float32Array, duration:number}}
 */
function peaksFromFloat32(samples, sampleRate, numPeaks = DEFAULT_NUM_PEAKS) {
    const n = samples.length;
    const duration = n / sampleRate;
    const spp = Math.max(1, Math.floor(n / numPeaks));
    const peaks = new Float32Array(numPeaks);
    for (let i = 0; i < numPeaks; i++) {
        let max = 0;
        const offset = i * spp;
        for (let j = 0; j < spp && offset + j < n; j++) {
            const v = Math.abs(samples[offset + j]);
            if (v > max) max = v;
        }
        peaks[i] = max;
    }
    return { peaks, duration };
}

/**
 * Parse a WAV file header and extract peaks directly from PCM data.
 * Reads raw bytes from disk — no subprocess, no decode overhead.
 * Supports 16-bit, 24-bit, 32-bit PCM (format tag 1) and 32-bit IEEE float
 * (format tag 3).
 *
 * @param {string} fp Absolute path to a .wav file.
 * @param {number} [numPeaks=4000]
 * @returns {Promise<{peaks:Float32Array, duration:number}|null>}
 */
async function extractPeaksFromWAV(fp, numPeaks = DEFAULT_NUM_PEAKS) {
    let fd;
    try {
        fd = await fs.promises.open(fp, 'r');
        const headerBuf = Buffer.alloc(128);
        await fd.read(headerBuf, 0, 128, 0);

        if (headerBuf.toString('ascii', 0, 4) !== 'RIFF' || headerBuf.toString('ascii', 8, 12) !== 'WAVE') {
            return null;
        }

        let fmtOffset = -1, dataOffset = -1, dataSize = 0;
        let pos = 12;
        const scanBuf = Buffer.alloc(4096);
        await fd.read(scanBuf, 0, 4096, 0);
        const scanLen = 4096;

        while (pos < scanLen - 8) {
            const chunkId = scanBuf.toString('ascii', pos, pos + 4);
            const chunkSize = scanBuf.readUInt32LE(pos + 4);

            if (chunkId === 'fmt ') {
                fmtOffset = pos + 8;
            } else if (chunkId === 'data') {
                dataOffset = pos + 8;
                dataSize = chunkSize;
                break;
            }
            pos += 8 + chunkSize;
            if (chunkSize % 2 !== 0) pos++; // word-aligned
        }

        if (fmtOffset === -1 || dataOffset === -1 || dataSize === 0) return null;

        let audioFormat = scanBuf.readUInt16LE(fmtOffset);     // 1 = PCM, 3 = float
        const numChannels = scanBuf.readUInt16LE(fmtOffset + 2);
        const sampleRate = scanBuf.readUInt32LE(fmtOffset + 4);
        const bitsPerSample = scanBuf.readUInt16LE(fmtOffset + 14);
        const bytesPerSample = bitsPerSample / 8;
        const blockAlign = numChannels * bytesPerSample;

        // WAVE_FORMAT_EXTENSIBLE (0xFFFE): the real format tag lives in the
        // first 2 bytes of the SubFormat GUID at fmtOffset+24. ffmpeg & most
        // modern DAWs emit EXTENSIBLE for 24-bit / 32-bit-float WAVs, so decode
        // it here to keep these common files on the fast Tier-2 direct parser
        // path instead of the slow ffmpeg subprocess (Tier-3) fallback.
        if (audioFormat === WAVE_FORMAT_EXTENSIBLE) {
            if (fmtOffset + 26 > scanLen) return null; // truncated fmt chunk
            audioFormat = scanBuf.readUInt16LE(fmtOffset + 24);
            if (audioFormat !== 1 && audioFormat !== 3) return null;
        }

        if (audioFormat !== 1 && audioFormat !== 3) return null;
        if (numChannels < 1 || sampleRate < 1) return null;

        const totalSamples = Math.floor(dataSize / blockAlign);
        const duration = totalSamples / sampleRate;

        const dataBuf = Buffer.alloc(dataSize);
        const { bytesRead } = await fd.read(dataBuf, 0, dataSize, dataOffset);
        const actualSamples = Math.floor(bytesRead / blockAlign);

        const spp = Math.max(1, Math.floor(actualSamples / numPeaks));
        const peaks = new Float32Array(numPeaks);

        if (audioFormat === 3 && bitsPerSample === 32) {
            for (let i = 0; i < numPeaks; i++) {
                let max = 0;
                const startSample = i * spp;
                for (let j = 0; j < spp && (startSample + j) < actualSamples; j++) {
                    const byteOff = (startSample + j) * blockAlign;
                    const v = Math.abs(dataBuf.readFloatLE(byteOff));
                    if (v > max) max = v;
                }
                peaks[i] = max;
            }
        } else if (bitsPerSample === 16) {
            for (let i = 0; i < numPeaks; i++) {
                let max = 0;
                const startSample = i * spp;
                for (let j = 0; j < spp && (startSample + j) < actualSamples; j++) {
                    const byteOff = (startSample + j) * blockAlign;
                    const v = Math.abs(dataBuf.readInt16LE(byteOff) / 32768);
                    if (v > max) max = v;
                }
                peaks[i] = max;
            }
        } else if (bitsPerSample === 24) {
            for (let i = 0; i < numPeaks; i++) {
                let max = 0;
                const startSample = i * spp;
                for (let j = 0; j < spp && (startSample + j) < actualSamples; j++) {
                    const byteOff = (startSample + j) * blockAlign;
                    let val = dataBuf[byteOff] | (dataBuf[byteOff + 1] << 8) | (dataBuf[byteOff + 2] << 16);
                    if (val & 0x800000) val |= ~0xFFFFFF; // sign extend
                    const v = Math.abs(val / 8388608);
                    if (v > max) max = v;
                }
                peaks[i] = max;
            }
        } else if (bitsPerSample === 32 && audioFormat === 1) {
            for (let i = 0; i < numPeaks; i++) {
                let max = 0;
                const startSample = i * spp;
                for (let j = 0; j < spp && (startSample + j) < actualSamples; j++) {
                    const byteOff = (startSample + j) * blockAlign;
                    const v = Math.abs(dataBuf.readInt32LE(byteOff) / 2147483648);
                    if (v > max) max = v;
                }
                peaks[i] = max;
            }
        } else {
            return null; // unsupported bit depth
        }

        return { peaks, duration };
    } catch (e) {
        return null;
    } finally {
        if (fd) await fd.close().catch(() => {});
    }
}

/**
 * ffmpeg fallback for non-WAV formats (FLAC, AIFF, OGG, MP3, AAC, etc.).
 * Spawns ffmpeg to decode to f32le @ 48 kHz mono and extracts peaks from the
 * stream. Also handles malformed WAVs that the direct parser rejected.
 *
 * @param {string} fp
 * @param {number} [numPeaks=4000]
 * @returns {Promise<{peaks:Float32Array, duration:number}>}
 */
function extractPeaksWithFFmpeg(fp, numPeaks = DEFAULT_NUM_PEAKS) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let settled = false;
        const doResolve = () => {
            if (settled) return;
            settled = true;
            const buf = Buffer.concat(chunks);
            if (buf.byteLength < 4) { reject(new Error('No audio data')); return; }
            const samples = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
            resolve(peaksFromFloat32(samples, 48000, numPeaks));
        };
        ffmpeg(fp)
            .setFfmpegPath(ffmpegStatic)
            .audioFrequency(48000)
            .audioChannels(1)
            .format('f32le')
            .on('error', err => {
                if (err.message && err.message.includes('Output stream closed')) { doResolve(); return; }
                if (!settled) { settled = true; reject(err); }
            })
            .on('end', () => doResolve())
            .pipe()
            .on('data', chunk => chunks.push(chunk));
    });
}

module.exports = {
    DEFAULT_NUM_PEAKS,
    peaksFromFloat32,
    extractPeaksFromWAV,
    extractPeaksWithFFmpeg,
};