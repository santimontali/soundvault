'use strict';
/**
 * Deterministic fixture library for the editor E2E scenarios.
 *
 *   node tests/fixtures/make-editor-fixtures.js <outDir> [--user-data <dir>]
 *
 * --user-data also writes an isolated soundvault-config.json there (library = <outDir>,
 * renders = <outDir>-renders, no auto-play, Sound mode) so E2E runs never write
 * renders into the user's Documents. Then:
 *   electron tests/e2e/harness.js --lib <outDir> --user-data <dir> --scenario tests/e2e/scenarios/editor-picture.js --out <out>
 *
 * Every signal is designed so that a specific editor bug is measurable:
 *   ramp_st_48k_2s        L = monotonic ramp → any offset / reversal is visible sample-exactly
 *   markers_mono_48k_4s   short bursts at known times/levels → picture ⇄ audio alignment
 *   markers_st_44k_10s    44.1 kHz source → exports must stay 44.1 kHz
 *   hf_96k_1k+30k_2s      96 kHz / 24-bit with a 30 kHz tone → exports must stay 96 kHz and keep it
 *   sine_0dbfs_48k_1s     full-scale sine → gain > 0 dB must export as float, CLIP must show
 *   rightonly_st_48k_1s   silent left, loud right → the picture must not use channel 0 only
 *   short_125ms_loudtail  6000 samples, loud last 20 ms → tails must be drawn
 *   tiny_5ms_loudtail     240 samples
 *   sine_220_48k_2s       low tone → zero-crossing snap is measurable
 *   pad_st_48k_30s        30 s stereo → playback latency must not depend on length
 * Writes <outDir>/Editor/*.wav and <outDir>/editor-fixtures.json.
 */
const fs = require('fs');
const path = require('path');

function writeWav(file, chans, sr, fmt) {
    const nc = chans.length, n = chans[0].length;
    const bps = fmt === 'f32' ? 4 : fmt === 'pcm24' ? 3 : 2;
    const dataSize = n * nc * bps;
    const buf = Buffer.alloc(44 + dataSize);
    buf.write('RIFF', 0); buf.writeUInt32LE(36 + dataSize, 4); buf.write('WAVE', 8);
    buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(fmt === 'f32' ? 3 : 1, 20); buf.writeUInt16LE(nc, 22);
    buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * nc * bps, 28); buf.writeUInt16LE(nc * bps, 32); buf.writeUInt16LE(bps * 8, 34);
    buf.write('data', 36); buf.writeUInt32LE(dataSize, 40);
    let o = 44;
    for (let i = 0; i < n; i++) for (let c = 0; c < nc; c++) {
        const v = chans[c][i], s = Math.max(-1, Math.min(1, v));
        if (fmt === 'f32') { buf.writeFloatLE(v, o); o += 4; }
        else if (fmt === 'pcm16') { buf.writeInt16LE(Math.round(s * 32767), o); o += 2; }
        else { let q = Math.round(s * 8388607); if (q < 0) q += 16777216; buf[o] = q & 255; buf[o + 1] = (q >> 8) & 255; buf[o + 2] = (q >> 16) & 255; o += 3; }
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, buf);
}
function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const burst = (a, sr, t, dur, amp, f = 1000) => { const s = Math.round(t * sr), n = Math.round(dur * sr); for (let i = 0; i < n && s + i < a.length; i++) a[s + i] += amp * Math.sin(2 * Math.PI * f * i / sr); };

function build(outDir) {
    const dir = path.join(outDir, 'Editor');
    const r = rng(1234);
    const files = [];
    const add = (name, chans, sr, fmt, extra = {}) => { writeWav(path.join(dir, name), chans, sr, fmt); files.push({ name, rel: 'Editor/' + name, sr, channels: chans.length, frames: chans[0].length, duration: chans[0].length / sr, fmt, ...extra }); };
    { const sr = 48000, n = 96000, L = new Float32Array(n), R = new Float32Array(n); for (let i = 0; i < n; i++) { L[i] = -0.5 + i / (n - 1); R[i] = 0.25 * Math.sin(2 * Math.PI * 440 * i / sr); } add('ramp_st_48k_2s.wav', [L, R], sr, 'f32'); }
    { const sr = 48000, n = 4 * sr, a = new Float32Array(n); for (let i = 0; i < n; i++) a[i] = 0.02 * (r() * 2 - 1); const marks = [[0.5, 0.9], [1.0, 0.6], [2.0, 0.3], [3.5, 0.75]]; for (const [t, amp] of marks) burst(a, sr, t, 0.01, amp); add('markers_mono_48k_4s.wav', [a], sr, 'f32', { marks }); }
    { const sr = 44100, n = 10 * sr, L = new Float32Array(n), R = new Float32Array(n); for (let i = 0; i < n; i++) { L[i] = 0.02 * (r() * 2 - 1); R[i] = L[i]; } for (const t of [1, 3, 6, 9]) { burst(L, sr, t, 0.02, 0.8); burst(R, sr, t, 0.02, 0.8); } add('markers_st_44k_10s.wav', [L, R], sr, 'pcm16', { marks: [1, 3, 6, 9] }); }
    { const sr = 96000, n = 2 * sr, L = new Float32Array(n), R = new Float32Array(n); for (let i = 0; i < n; i++) { const v = 0.3 * Math.sin(2 * Math.PI * 1000 * i / sr) + 0.3 * Math.sin(2 * Math.PI * 30000 * i / sr); L[i] = v; R[i] = v; } add('hf_96k_1k+30k_2s.wav', [L, R], sr, 'pcm24'); }
    { const sr = 48000, n = sr, a = new Float32Array(n); for (let i = 0; i < n; i++) a[i] = 0.999 * Math.sin(2 * Math.PI * 1000 * i / sr); add('sine_0dbfs_48k_1s.wav', [a], sr, 'f32'); }
    { const sr = 48000, n = sr, L = new Float32Array(n), R = new Float32Array(n); for (let i = 0; i < n; i++) R[i] = 0.8 * (r() * 2 - 1); add('rightonly_st_48k_1s.wav', [L, R], sr, 'f32'); }
    { const sr = 48000, n = 6000, a = new Float32Array(n); for (let i = 0; i < n; i++) a[i] = 0.1 * (r() * 2 - 1); for (let i = 5040; i < n; i++) a[i] = 0.9 * Math.sin(2 * Math.PI * 1000 * i / sr); add('short_125ms_loudtail.wav', [a], sr, 'f32'); }
    { const sr = 48000, n = 240, a = new Float32Array(n); for (let i = 0; i < n; i++) a[i] = (i < 120 ? 0.05 : 0.9) * Math.sin(2 * Math.PI * 2000 * i / sr); add('tiny_5ms_loudtail.wav', [a], sr, 'f32'); }
    { const sr = 48000, n = 2 * sr, a = new Float32Array(n); for (let i = 0; i < n; i++) a[i] = 0.7 * Math.sin(2 * Math.PI * 220 * i / sr + 0.4); add('sine_220_48k_2s.wav', [a], sr, 'f32'); }
    { const sr = 48000, n = 30 * sr, L = new Float32Array(n), R = new Float32Array(n); for (let i = 0; i < n; i++) { const t = i / sr, e = 0.25 + 0.15 * Math.sin(2 * Math.PI * 0.2 * t); L[i] = e * (Math.sin(2 * Math.PI * 110 * t) * 0.6 + Math.sin(2 * Math.PI * 165 * t) * 0.3) + 0.01 * (r() * 2 - 1); R[i] = e * (Math.sin(2 * Math.PI * 110.5 * t) * 0.6 + Math.sin(2 * Math.PI * 220 * t) * 0.25); } add('pad_st_48k_30s.wav', [L, R], sr, 'pcm16'); }
    fs.writeFileSync(path.join(outDir, 'editor-fixtures.json'), JSON.stringify({ generatedBy: 'tests/fixtures/make-editor-fixtures.js', files }, null, 1));
    return files;
}

/** Isolated app settings for E2E runs (library + renders outside the user's folders). */
function writeConfig(userDataDir, libDir) {
    fs.mkdirSync(userDataDir, { recursive: true });
    const cfg = { libraryPath: path.resolve(libDir), rendersDir: path.resolve(libDir) + '-renders', autoPlay: false, lastState: { mode: 'sounds', folder: '', collection: null } };
    fs.writeFileSync(path.join(userDataDir, 'soundvault-config.json'), JSON.stringify(cfg, null, 1));
    return cfg;
}

module.exports = { build, writeWav, writeConfig };
if (require.main === module) {
    const out = process.argv[2];
    if (!out || out.startsWith('--')) { console.error('usage: node tests/fixtures/make-editor-fixtures.js <outDir> [--user-data <dir>]'); process.exit(2); }
    const files = build(path.resolve(out));
    console.log(`wrote ${files.length} fixtures to ${path.resolve(out)}`);
    const i = process.argv.indexOf('--user-data');
    if (i > 0 && process.argv[i + 1]) { const c = writeConfig(process.argv[i + 1], out); console.log('isolated settings →', path.join(process.argv[i + 1], 'soundvault-config.json'), 'renders →', c.rendersDir); }
}
