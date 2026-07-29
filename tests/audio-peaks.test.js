'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const {
    DEFAULT_NUM_PEAKS,
    peaksFromFloat32,
    extractPeaksFromWAV,
    extractPeaksWithFFmpeg,
} = require('../src/audio/peaks');

const ffmpegStatic = require('ffmpeg-static');
const BASELINE_PATH = path.join(__dirname, 'baselines', 'audio-perf-baseline.json');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'soundvault-audioperf-'));
const DURATION_S = 3;
const SAMPLE_RATE = 48000;

// Generate a handful of formats; AAC is optional (codec may be absent).
const FORMATS = [
    { ext: '.wav',  enc: 'pcm_s16le'  },
    { ext: '.wav',  enc: 'pcm_s24le', suffix: '24' },
    { ext: '.wav',  enc: 'pcm_f32le', suffix: 'f32' },
    { ext: '.mp3',  enc: 'libmp3lame' },
    { ext: '.flac', enc: 'flac' },
    { ext: '.ogg',  enc: 'libvorbis' },
    { ext: '.aiff', enc: 'pcm_s16le' },
];
const OPTIONAL = new Set(['.mp3', '.ogg']); // not strictly required to pass

const generated = new Map(); // key -> filepath

function genKey(f) {
    return [f.ext, f.enc, f.suffix || ''].join('|');
}

before(() => {
    for (const f of FORMATS) {
        const out = path.join(TMP, `sine_${f.suffix || f.ext.slice(1)}.${f.ext.slice(1).replace('aiff', 'aif')}`);
        try {
            execFileSync(ffmpegStatic, [
                '-y', '-hide_banner', '-loglevel', 'error',
                '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=${SAMPLE_RATE}`,
                '-t', String(DURATION_S), '-ac', '1',
                '-c:a', f.enc,
                ...(f.enc === 'aac' ? ['-strict', 'experimental'] : []),
                out,
            ], { stdio: 'ignore' });
            generated.set(genKey(f), out);
        } catch (e) {
            // Skip formats the static ffmpeg can't encode; surfaced in the test below.
        }
    }
    fs.mkdirSync(path.dirname(BASELINE_PATH), { recursive: true });
});

after(() => {
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

test('synthetic audio corpus generated at least the core WAV/FLAC formats', () => {
    const have = [...generated.keys()];
    console.log('GENERATED FORMATS:', have);
    // At minimum: 16-bit WAV, 24-bit WAV, f32 WAV, FLAC. MP3/AAC optional.
    assert.ok(have.some(k => k.startsWith('.wav|pcm_s16le')), '16-bit WAV');
    assert.ok(have.some(k => k.startsWith('.wav|pcm_s24le')), '24-bit WAV');
    assert.ok(have.some(k => k.startsWith('.wav|pcm_f32le')), '32-bit float WAV');
    assert.ok(have.some(k => k.startsWith('.flac|')), 'FLAC');
});

test('peaksFromFloat32 returns DEFAULT_NUM_PEAKS and correct duration', () => {
    const samples = new Float32Array(SAMPLE_RATE * DURATION_S);
    for (let i = 0; i < samples.length; i++) samples[i] = Math.sin(2 * Math.PI * 440 * i / SAMPLE_RATE);
    const { peaks, duration } = peaksFromFloat32(samples, SAMPLE_RATE);
    assert.equal(peaks.length, DEFAULT_NUM_PEAKS);
    assert.ok(Math.abs(duration - DURATION_S) < 0.01, `duration ~${DURATION_S}, got ${duration}`);
    let mx = 0; for (const p of peaks) if (p > mx) mx = p;
    assert.ok(mx > 0.8, `sine peaks should reach near full scale, max=${mx}`);
});

for (const f of FORMATS) {
    const key = genKey(f);
    const name = `${f.ext}/${f.enc}${f.suffix ? '+' + f.suffix : ''}`;
    test(`extractPeaksFromWAV parses ${name} via the direct WAV parser (Tier-2)`, async () => {
        const fp = generated.get(key);
        if (!fp) {
            if (f.ext === '.wav') assert.fail(`required WAV not generated: ${name}`);
            console.warn(`SKIP ${name}: not generated`);
            return;
        }
        if (f.ext !== '.wav') { console.warn(`SKIP (non-WAV) ${name}`); return; }

        const t0 = process.hrtime.bigint();
        const res = await extractPeaksFromWAV(fp);
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;

        assert.ok(res, `${name} parser returned null`);
        assert.equal(res.peaks.length, DEFAULT_NUM_PEAKS);
        assert.ok(Math.abs(res.duration - DURATION_S) < 0.05, `${name} duration ${res.duration} vs expected ${DURATION_S}`);
        let mx = 0; for (const p of res.peaks) if (p > mx) mx = p;
        // ffmpeg's `sine` lavfi source emits a ~0.125-amplitude sine by
        // default; the parser-contract test only cares that real (non-silent,
        // non-garbage) audio was decoded and aligned — not the exact amplitude.
        assert.ok(mx > 0.05, `${name} peak amplitude too low: ${mx}`);
        console.log(`PERF ${name} extractPeaksFromWAV: ${ms.toFixed(2)} ms`);
    });
}

test('extractPeaksWithFFmpeg decodes every non-WAV format (Tier-3) — AAC optional', async () => {
    const metrics = {};
    for (const f of FORMATS) {
        if (f.ext === '.wav') continue;
        const key = genKey(f);
        const fp = generated.get(key);
        if (!fp) {
            if (!OPTIONAL.has(f.ext)) assert.fail(`required non-WAV not generated: ${f.ext}/${f.enc}`);
            console.warn(`SKIP ffmpeg decode ${f.ext}/${f.enc}: not generated`);
            continue;
        }
        const t0 = process.hrtime.bigint();
        try {
            const res = await extractPeaksWithFFmpeg(fp);
            const ms = Number(process.hrtime.bigint() - t0) / 1e6;
            assert.equal(res.peaks.length, DEFAULT_NUM_PEAKS, `${f.ext} peaks`);
            assert.ok(Math.abs(res.duration - DURATION_S) < 0.2, `${f.ext} duration ${res.duration}`);
            metrics[f.ext] = { ms: +ms.toFixed(2), duration: +res.duration.toFixed(3) };
        } catch (e) {
            assert.ok(OPTIONAL.has(f.ext), `required decode failed for ${f.ext}: ${e.message}`);
            console.warn(`OPTIONAL ${f.ext} decode failed: ${e.message}`);
        }
    }
    console.log('PERF ffmpeg-decode metrics:', metrics);
});

test('extractPeaksFromWAV returns null for a non-WAV file and for malformed bytes', async () => {
    const bogus = path.join(TMP, 'bogus.wav');
    fs.writeFileSync(bogus, Buffer.from('NOT A WAV HEADER '));
    const r1 = await extractPeaksFromWAV(bogus);
    // Our parser explicitly validates RIFF/WAVE → null.
    assert.equal(r1, null);

    // Missing file: must reject gracefully (not throw).
    const r2 = await extractPeaksFromWAV(path.join(TMP, 'does_not_exist.wav'));
    assert.equal(r2, null);
});

test('records a performance baseline JSON for regression tracking', async () => {
    const RECORD = process.env.RECORD_BASELINE === '1';
    const wav16 = [...generated.entries()].find(([k]) => k.startsWith('.wav|pcm_s16le|'));
    if (!wav16) { console.warn('SKIP baseline: no 16-bit WAV'); return; }
    const fp = wav16[1];
    const runs = 5;
    const samples = [];
    for (let i = 0; i < runs; i++) {
        const t0 = process.hrtime.bigint();
        await extractPeaksFromWAV(fp);
        samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    const mean = samples.reduce((a, b) => a + b, 0) / runs;
    const p50 = samples.slice().sort((a, b) => a - b)[Math.floor(runs / 2)];
    const before = fs.existsSync(BASELINE_PATH)
        ? JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf-8'))
        : {};
    const baseline = {
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        recordedAt: new Date().toISOString(),
        extractPeaksFromWAV_ms_16bit_3s_48k: {
            mean: +mean.toFixed(3),
            p50: +p50.toFixed(3),
            runs,
            samples: samples.map(s => +s.toFixed(3)),
            // Flatten to a single previous snapshot to avoid an unbounded
            // nested chain accumulating across runs.
            previous_p50_ms: before.extractPeaksFromWAV_ms_16bit_3s_48k
                ? before.extractPeaksFromWAV_ms_16bit_3s_48k.p50
                : null,
        },
    };
    if (RECORD) fs.writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2));
    assert.ok(mean > 0 && p50 > 0);
    console.log(RECORD ? 'BASELINE recorded:' : 'BASELINE measured (RECORD_BASELINE=1 to write):', baseline.extractPeaksFromWAV_ms_16bit_3s_48k);
    // Loose regression guard so a 10x slowdown gets caught by CI.
    if (before.extractPeaksFromWAV_ms_16bit_3s_48k) {
        const prev = before.extractPeaksFromWAV_ms_16bit_3s_48k.p50;
        const ratio = p50 / prev;
        assert.ok(ratio < 10, `gross regression: ${p50.toFixed(2)} vs prev ${prev.toFixed(2)} (${ratio.toFixed(2)}x)`);
        console.log(`vs previous p50 ${prev} (ratio ${ratio.toFixed(2)}x)`);
    }
});