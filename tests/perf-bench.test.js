'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { extractPeaksFromWAV, peaksFromFloat32, DEFAULT_NUM_PEAKS } = require('../src/audio/peaks');

const TMP = path.join(os.tmpdir(), 'sv-bench-' + process.pid);

function makeWav(filePath, durationSec, sampleRate = 44100, bitsPerSample = 16, channels = 1) {
    const numSamples = Math.floor(durationSec * sampleRate);
    const bytesPerSample = bitsPerSample / 8;
    const blockAlign = channels * bytesPerSample;
    const dataSize = numSamples * blockAlign;
    const headerSize = 44;
    const buf = Buffer.alloc(headerSize + dataSize);

    buf.write('RIFF', 0);
    buf.writeUInt32LE(36 + dataSize, 4);
    buf.write('WAVE', 8);
    buf.write('fmt ', 12);
    buf.writeUInt32LE(16, 16);
    buf.writeUInt16LE(1, 20);
    buf.writeUInt16LE(channels, 22);
    buf.writeUInt32LE(sampleRate, 24);
    buf.writeUInt32LE(sampleRate * blockAlign, 28);
    buf.writeUInt16LE(blockAlign, 32);
    buf.writeUInt16LE(bitsPerSample, 34);
    buf.write('data', 36);
    buf.writeUInt32LE(dataSize, 40);

    for (let i = 0; i < numSamples; i++) {
        const t = i / sampleRate;
        const val = Math.sin(2 * Math.PI * 440 * t) * 0.8;
        const off = headerSize + i * blockAlign;
        if (bitsPerSample === 16) {
            buf.writeInt16LE(Math.round(val * 32767), off);
        } else if (bitsPerSample === 24) {
            const v = Math.round(val * 8388607);
            buf[off] = v & 0xFF;
            buf[off + 1] = (v >> 8) & 0xFF;
            buf[off + 2] = (v >> 16) & 0xFF;
        } else if (bitsPerSample === 32) {
            buf.writeFloatLE(val, off);
        }
    }
    fs.writeFileSync(filePath, buf);
    return { numSamples, dataSize, headerSize };
}

test.before(() => { fs.mkdirSync(TMP, { recursive: true }); });
test.after(() => { fs.rmSync(TMP, { recursive: true, force: true }); });

test('BENCH peaks: 3s 16-bit WAV (baseline)', async () => {
    const fp = path.join(TMP, 'bench-3s-16.wav');
    makeWav(fp, 3, 44100, 16);
    const t0 = performance.now();
    const result = await extractPeaksFromWAV(fp);
    const ms = performance.now() - t0;
    assert.ok(result);
    assert.strictEqual(result.peaks.length, DEFAULT_NUM_PEAKS);
    console.log(`BENCH  peaks 3s/16-bit: ${ms.toFixed(2)}ms`);
});

test('BENCH peaks: 30s 16-bit WAV', async () => {
    const fp = path.join(TMP, 'bench-30s-16.wav');
    makeWav(fp, 30, 44100, 16);
    const t0 = performance.now();
    const result = await extractPeaksFromWAV(fp);
    const ms = performance.now() - t0;
    assert.ok(result);
    console.log(`BENCH  peaks 30s/16-bit: ${ms.toFixed(2)}ms`);
});

test('BENCH peaks: 5min 16-bit stereo WAV (long file)', async () => {
    const fp = path.join(TMP, 'bench-5min-16-stereo.wav');
    makeWav(fp, 300, 44100, 16, 2);
    const stat = fs.statSync(fp);
    const t0 = performance.now();
    const result = await extractPeaksFromWAV(fp);
    const ms = performance.now() - t0;
    assert.ok(result);
    console.log(`BENCH  peaks 5min/16-bit/stereo: ${ms.toFixed(2)}ms (file: ${(stat.size / 1048576).toFixed(1)}MB)`);
});

test('BENCH peaks: 5min 24-bit WAV (long file)', async () => {
    const fp = path.join(TMP, 'bench-5min-24.wav');
    makeWav(fp, 300, 48000, 24);
    const stat = fs.statSync(fp);
    const t0 = performance.now();
    const result = await extractPeaksFromWAV(fp);
    const ms = performance.now() - t0;
    assert.ok(result);
    console.log(`BENCH  peaks 5min/24-bit: ${ms.toFixed(2)}ms (file: ${(stat.size / 1048576).toFixed(1)}MB)`);
});

test('BENCH peaks: 5min 32-bit float WAV', async () => {
    const fp = path.join(TMP, 'bench-5min-f32.wav');
    makeWav(fp, 300, 48000, 32);
    const stat = fs.statSync(fp);
    const t0 = performance.now();
    const result = await extractPeaksFromWAV(fp);
    const ms = performance.now() - t0;
    assert.ok(result);
    console.log(`BENCH  peaks 5min/f32: ${ms.toFixed(2)}ms (file: ${(stat.size / 1048576).toFixed(1)}MB)`);
});

test('BENCH peaksFromFloat32: 5min mono 48kHz (in-memory)', () => {
    const samples = new Float32Array(300 * 48000);
    for (let i = 0; i < samples.length; i++) samples[i] = Math.sin(2 * Math.PI * 440 * i / 48000) * 0.8;
    const t0 = performance.now();
    const result = peaksFromFloat32(samples, 48000);
    const ms = performance.now() - t0;
    assert.strictEqual(result.peaks.length, DEFAULT_NUM_PEAKS);
    console.log(`BENCH  peaksFromFloat32 5min: ${ms.toFixed(2)}ms`);
});

test('BENCH IPC simulation: 32 sequential peak loads vs batch', async () => {
    const files = [];
    for (let i = 0; i < 32; i++) {
        const fp = path.join(TMP, `batch-${i}.wav`);
        makeWav(fp, 2, 44100, 16);
        files.push(fp);
    }

    const t0 = performance.now();
    for (const fp of files) {
        await extractPeaksFromWAV(fp);
    }
    const sequentialMs = performance.now() - t0;

    const t1 = performance.now();
    await Promise.all(files.map(fp => extractPeaksFromWAV(fp)));
    const parallelMs = performance.now() - t1;

    console.log(`BENCH  32 peaks sequential: ${sequentialMs.toFixed(2)}ms | parallel: ${parallelMs.toFixed(2)}ms | speedup: ${(sequentialMs / parallelMs).toFixed(2)}x`);
    assert.ok(parallelMs < sequentialMs);
});
