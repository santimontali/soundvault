'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { build, makeWav, gen } = require('./fixtures/make-library');
const { readWavInfo, computeWavPeaks, encodeWav, peaksFromChannels } = require('../src/audio/wav');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-wav-'));
const manifest = build(dir, { families: 1 });
const byRel = Object.fromEntries(manifest.files.map(f => [f.rel, f]));
const abs = rel => path.join(dir, rel);

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('readWavInfo parses every supported encoding with exact duration', async () => {
    const cases = {
        'Formats/pcm16_mono_48k.wav': [1, 16, 48000, 1],
        'Formats/pcm16_stereo_44k.wav': [1, 16, 44100, 2],
        'Formats/pcm24_stereo_96k.wav': [1, 24, 96000, 2],
        'Formats/pcm24_extensible.wav': [1, 24, 48000, 2],
        'Formats/float32.wav': [3, 32, 48000, 1],
        'Formats/float32_extensible.wav': [3, 32, 48000, 2],
        'Formats/pcm32_int.wav': [1, 32, 48000, 1],
        'Formats/pcm8_unsigned.wav': [1, 8, 48000, 1],
        'Formats/UPPERCASE_EXT.WAV': [1, 16, 48000, 1],
    };
    for (const [rel, [format, bits, sr, ch]] of Object.entries(cases)) {
        const info = await readWavInfo(abs(rel));
        assert.ok(info, rel);
        assert.strictEqual(info.format, format, rel + ' format');
        assert.strictEqual(info.bitsPerSample, bits, rel + ' bits');
        assert.strictEqual(info.sampleRate, sr, rel + ' sr');
        assert.strictEqual(info.channels, ch, rel + ' channels');
        assert.ok(Math.abs(info.duration - byRel[rel].durationS) < 1e-3, `${rel} duration ${info.duration} vs ${byRel[rel].durationS}`);
    }
});

test('readWavInfo finds data behind large metadata chunks and odd-sized chunks', async () => {
    for (const rel of ['Metadata/bext_ixml_24kb_before_data.wav', 'Metadata/junk_8kb_before_fmt.wav', 'Metadata/odd_sized_chunk_pad.wav', 'Metadata/list_info_after_data.wav', 'Metadata/huge_ixml_200kb.wav']) {
        const info = await readWavInfo(abs(rel));
        assert.ok(info, rel);
        assert.ok(Math.abs(info.duration - byRel[rel].durationS) < 1e-3, rel);
    }
});

test('broken files never throw; recoverable ones report the readable length', async () => {
    assert.strictEqual(await readWavInfo(abs('Broken/zero_bytes.wav')), null);
    assert.strictEqual(await readWavInfo(abs('Broken/text_renamed.wav')), null);
    assert.strictEqual(await readWavInfo(abs('Broken/rifx_header.wav')), null);
    const trunc = await readWavInfo(abs('Broken/truncated_data.wav'));
    assert.ok(trunc && trunc.duration > 0.5 && trunc.duration < 2, 'truncated → partial duration');
    const ffff = await readWavInfo(abs('Broken/data_size_ffffffff.wav'));
    assert.ok(ffff && Math.abs(ffff.duration - 1) < 1e-3, 'bogus 0xFFFFFFFF size → real length');
    const zero = await readWavInfo(abs('Broken/zero_length_data.wav'));
    assert.ok(zero && zero.frames === 0);
    assert.strictEqual(await readWavInfo(abs('does/not/exist.wav')), null);
});

test('computeWavPeaks: bucket count, range, silence and very short files', async () => {
    const r = await computeWavPeaks(abs('Formats/pcm24_stereo_96k.wav'), 512);
    assert.strictEqual(r.peaks.length, 512);
    assert.ok(r.maxPeak > 0.5 && r.maxPeak <= 1);
    for (let i = 0; i < 512; i++) assert.ok(r.rms[i] <= r.peaks[i] + 1e-6);
    const s = await computeWavPeaks(abs('Durations/silence_2s.wav'), 256);
    assert.strictEqual(s.maxPeak, 0);
    const tiny = await computeWavPeaks(abs('Durations/dur_005ms.wav'), 1024);
    assert.ok(tiny.peaks.every(v => Number.isFinite(v)));
    assert.ok(tiny.peaks.filter(v => v > 0).length > 200, 'short files are spread over all buckets, not a single spike');
    const z = await computeWavPeaks(abs('Broken/zero_length_data.wav'), 64);
    assert.ok(z && z.maxPeak === 0);
});

test('computeWavPeaks matches peaksFromChannels on known PCM16 content', async () => {
    const sig = gen.sine(48000, 0.5, 440, 0.5);
    const file = path.join(dir, 'ref_sine.wav');
    fs.writeFileSync(file, makeWav({ channels: [sig], sr: 48000, bits: 16 }));
    const a = await computeWavPeaks(file, 128);
    const b = peaksFromChannels([sig], 128);
    for (let i = 0; i < 128; i++) assert.ok(Math.abs(a.peaks[i] - b.peaks[i]) < 2e-4, 'bucket ' + i);
});

test('encodeWav round-trips 16/24/32f within quantization error', async () => {
    const l = gen.chirp(44100, 0.25, 100, 8000), r = gen.sine(44100, 0.25, 330, 0.3);
    for (const [bits, float, tol] of [[16, false, 1 / 32767], [24, false, 1 / 8388607], [32, true, 1e-7]]) {
        const file = path.join(dir, `enc_${bits}${float ? 'f' : ''}.wav`);
        fs.writeFileSync(file, encodeWav({ channels: [l, r], sampleRate: 44100, bitDepth: bits, float }));
        const info = await readWavInfo(file);
        assert.strictEqual(info.channels, 2); assert.strictEqual(info.sampleRate, 44100);
        assert.strictEqual(info.frames, l.length);
        const p = await computeWavPeaks(file, 64);
        const ref = peaksFromChannels([l, r], 64);
        for (let i = 0; i < 64; i++) assert.ok(Math.abs(p.peaks[i] - ref.peaks[i]) <= tol * 2 + 1e-6, `${bits} bucket ${i}`);
    }
    // Clipping + NaN safety
    const hot = new Float32Array([2, -2, NaN, 0.5]);
    const buf = encodeWav({ channels: [hot], sampleRate: 48000, bitDepth: 16 });
    assert.strictEqual(buf.readInt16LE(44), 32767);
    assert.strictEqual(buf.readInt16LE(46), -32768);
    assert.strictEqual(buf.readInt16LE(48), 0);
});
