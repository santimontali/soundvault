// The fast CLAP log-mel must match transformers.js exactly (and be faster).
// Run: ELECTRON_RUN_AS_NODE=1 electron tests/clap-fbank.electron.js
'use strict';
const { patchProcessor } = require('../src/engine/clap-fbank');

(async () => {
    const tf = require('@xenova/transformers');
    const proc = await tf.AutoProcessor.from_pretrained('Xenova/clap-htsat-unfused');
    const fe = proc.feature_extractor;
    const orig = fe._extract_fbank_features.bind(fe);
    let seed = 3; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const signals = {
        noise: Float64Array.from({ length: 480000 }, () => rnd() * 2 - 1),
        tone: Float64Array.from({ length: 480000 }, (_, i) => 0.5 * Math.sin(2 * Math.PI * 440 * i / 48000)),
        silence: new Float64Array(480000),
        transient: Float64Array.from({ length: 480000 }, (_, i) => i < 2000 ? (rnd() * 2 - 1) * Math.exp(-i / 300) : 0),
    };
    const refs = {};
    let t = Date.now();
    for (const [k, x] of Object.entries(signals)) refs[k] = orig(x, fe.mel_filters_slaney, fe.config.nb_max_samples);
    const tOrig = (Date.now() - t) / 4;
    if (!patchProcessor(proc)) throw new Error('patch not applied');
    let worst = 0, fail = 0;
    t = Date.now();
    for (const [k, x] of Object.entries(signals)) {
        const a = refs[k], b = fe._extract_fbank_features(x, fe.mel_filters_slaney, fe.config.nb_max_samples);
        if (a.dims.join() !== b.dims.join()) { console.log('FAIL dims', k, a.dims, b.dims); fail++; continue; }
        let d = 0; for (let i = 0; i < a.data.length; i++) d = Math.max(d, Math.abs(a.data[i] - b.data[i]));
        worst = Math.max(worst, d);
        console.log(`${d < 1e-3 ? 'PASS' : 'FAIL'}  ${k.padEnd(10)} max |Δ| = ${d.toExponential(2)} dB  dims ${b.dims}`);
        if (d >= 1e-3) fail++;
    }
    const tFast = (Date.now() - t) / 4;
    // Whole-model check: identical embeddings through the public processor path.
    const model = await tf.ClapAudioModelWithProjection.from_pretrained('Xenova/clap-htsat-unfused', { quantized: false });
    const short = Float32Array.from({ length: 30000 }, (_, i) => Math.sin(i * 0.03) * Math.exp(-i / 9000));
    const e1 = (await model(await proc(short))).audio_embeds.data;
    fe._extract_fbank_features = fe.__svOriginalFbank;
    const e2 = (await model(await proc(short))).audio_embeds.data;
    let dot = 0, n1 = 0, n2 = 0; for (let i = 0; i < e1.length; i++) { dot += e1[i] * e2[i]; n1 += e1[i] ** 2; n2 += e2[i] ** 2; }
    const cos = dot / Math.sqrt(n1 * n2);
    console.log(`${cos > 0.99999 ? 'PASS' : 'FAIL'}  embedding cosine fast vs original = ${cos.toFixed(7)}`);
    if (!(cos > 0.99999)) fail++;
    console.log(`fbank per 10 s window: original ${tOrig.toFixed(0)} ms → fast ${tFast.toFixed(0)} ms`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
