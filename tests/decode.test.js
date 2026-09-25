'use strict';
// Native WAV decoding + resampling used by the indexer (src/audio/decode.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { decodeWavMono, resample } = require('../src/audio/decode');
const { encodeWav } = require('../src/audio/wav');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-decode-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function sine(freq, rate, seconds, amp = 0.5) {
    const n = Math.round(rate * seconds);
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = amp * Math.sin(2 * Math.PI * freq * i / rate);
    return x;
}
function rms(x, from = 0, to = x.length) {
    let s = 0; for (let i = from; i < to; i++) s += x[i] * x[i];
    return Math.sqrt(s / (to - from));
}
/** Estimated frequency from zero crossings (ignores the filter edges). */
function freqOf(x, rate) {
    let z = 0; const a = 2000, b = x.length - 2000;
    for (let i = a + 1; i < b; i++) if ((x[i - 1] < 0) !== (x[i] < 0)) z++;
    return z / 2 / ((b - a) / rate);
}

test('96k → 48k keeps a 1 kHz tone (level and pitch)', () => {
    const y = resample(sine(1000, 96000, 1), 96000, 48000);
    assert.equal(y.length, 48000);
    assert.ok(Math.abs(rms(y, 2000, 46000) - 0.5 / Math.SQRT2) < 0.005, 'rms ' + rms(y, 2000, 46000));
    assert.ok(Math.abs(freqOf(y, 48000) - 1000) < 2);
});

test('44.1k → 48k and 192k → 48k keep a tone', () => {
    for (const rate of [44100, 22050, 88200, 176400, 192000, 32000, 8000]) {
        const y = resample(sine(440, rate, 1), rate, 48000);
        assert.ok(Math.abs(y.length - 48000) <= 1, rate + ': length ' + y.length);
        assert.ok(Math.abs(rms(y, 2000, 46000) - 0.5 / Math.SQRT2) < 0.01, rate + ': rms ' + rms(y, 2000, 46000));
        assert.ok(Math.abs(freqOf(y, 48000) - 440) < 2, rate + ': freq ' + freqOf(y, 48000));
    }
});

test('content above the new Nyquist is rejected (no aliasing)', () => {
    // 30 kHz at 96k would alias to 18 kHz at 48k without filtering
    const y = resample(sine(30000, 96000, 1), 96000, 48000);
    const db = 20 * Math.log10(rms(y, 2000, 46000) / (0.5 / Math.SQRT2));
    assert.ok(db < -60, 'alias level ' + db.toFixed(1) + ' dB');
});

test('decodeWavMono: 24-bit stereo → mono (L+R)·√½ at 48k, with seek + max', async () => {
    const L = sine(1000, 96000, 3, 0.4), R = sine(1000, 96000, 3, 0.4);
    const fp = path.join(tmp, 'st24.wav');
    fs.writeFileSync(fp, encodeWav({ channels: [L, R], sampleRate: 96000, bitDepth: 24 }));
    const all = await decodeWavMono(fp);
    assert.equal(all.rate, 48000);
    assert.ok(Math.abs(all.duration - 3) < 1e-6);
    assert.equal(all.samples.length, 144000);
    assert.ok(Math.abs(rms(all.samples, 2000, 140000) - 0.8 * Math.SQRT1_2 / Math.SQRT2) < 0.005);
    const part = await decodeWavMono(fp, { startSeconds: 1, maxSeconds: 1.5 });
    assert.equal(part.samples.length, 72000);
    assert.ok(Math.abs(part.duration - 3) < 1e-6, 'duration is the whole file');
});

test('decodeWavMono: 16-bit mono at 48k is passed through exactly', async () => {
    const x = sine(500, 48000, 0.5, 0.25);
    const fp = path.join(tmp, 'm16.wav');
    fs.writeFileSync(fp, encodeWav({ channels: [x], sampleRate: 48000, bitDepth: 16 }));
    const r = await decodeWavMono(fp);
    assert.equal(r.samples.length, x.length);
    let maxErr = 0; for (let i = 0; i < x.length; i++) maxErr = Math.max(maxErr, Math.abs(r.samples[i] - x[i]));
    assert.ok(maxErr < 1 / 16000, 'max error ' + maxErr);
});

test('decodeWavMono: float32 with NaNs and a truncated data chunk', async () => {
    const x = sine(200, 48000, 1, 0.5); x[100] = NaN;
    const fp = path.join(tmp, 'f32.wav');
    const buf = encodeWav({ channels: [x], sampleRate: 48000, float: true });
    buf.writeUInt32LE(buf.readUInt32LE(40) + 4000, 40);            // header claims more than exists
    fs.writeFileSync(fp, buf);
    const r = await decodeWavMono(fp);
    assert.equal(r.samples.length, 48000);
    assert.ok(Number.isFinite(r.samples[100]));
});

test('decodeWavMono: unsupported encodings return null (ffmpeg fallback)', async () => {
    const fp = path.join(tmp, 'adpcm.wav');
    const buf = encodeWav({ channels: [sine(100, 8000, 0.1)], sampleRate: 8000, bitDepth: 16 });
    buf.writeUInt16LE(2, 20);                                        // WAVE_FORMAT_ADPCM
    fs.writeFileSync(fp, buf);
    assert.equal(await decodeWavMono(fp), null);
    assert.equal(await decodeWavMono(path.join(tmp, 'missing.wav')), null);
});

test('decodeWavMono: empty data chunk → zero samples, not a crash', async () => {
    const fp = path.join(tmp, 'empty.wav');
    fs.writeFileSync(fp, encodeWav({ channels: [new Float32Array(0)], sampleRate: 44100, bitDepth: 16 }));
    const r = await decodeWavMono(fp);
    assert.ok(r && r.samples.length === 0);
});
