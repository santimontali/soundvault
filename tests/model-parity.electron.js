// FP16-weight text model must embed queries like the FP32 original.
// Run: ELECTRON_RUN_AS_NODE=1 electron tests/model-parity.electron.js <fp32ModelsDir> <fp16ModelsDir>
'use strict';
const QUERIES = ['rain', 'heavy rain on roof', 'footsteps gravel', 'metal impact', 'sword swing', 'door creak', 'car pass by',
    'explosion', 'whoosh', 'dog barking', 'ocean waves', 'ui click', 'thunder', 'glass break', 'wind howling', 'crowd applause',
    'engine idle', 'gunshot', 'birds chirping', 'fire crackling', 'water drip', 'laser', 'monster growl', 'footsteps on wood'];

async function embedAll(dir) {
    const tf = require('@xenova/transformers');
    tf.env.cacheDir = dir; tf.env.localModelPath = dir; tf.env.allowRemoteModels = false;
    const tok = await tf.AutoTokenizer.from_pretrained('Xenova/clap-htsat-unfused');
    const model = await tf.ClapTextModelWithProjection.from_pretrained('Xenova/clap-htsat-unfused', { quantized: false });
    const out = [];
    const t0 = Date.now();
    for (const q of QUERIES) out.push(Float32Array.from((await model(await tok([q], { padding: true, truncation: true }))).text_embeds.data));
    return { out, ms: (Date.now() - t0) / QUERIES.length, rss: Math.round(process.memoryUsage().rss / 1048576) };
}

(async () => {
    const [a, b] = process.argv.slice(2);
    if (process.argv.includes('--child')) {
        const r = await embedAll(process.argv[process.argv.indexOf('--child') + 1]);
        process.stdout.write(JSON.stringify({ vecs: r.out.map(v => Array.from(v)), ms: r.ms, rss: r.rss }));
        return;
    }
    // Each model in its own process (transformers caches sessions per model id).
    const { execFileSync } = require('child_process');
    const run = dir => JSON.parse(execFileSync(process.execPath, [__filename, '--child', dir], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, maxBuffer: 64 << 20 }).toString());
    const A = run(a), B = run(b);
    let worst = 1;
    for (let i = 0; i < QUERIES.length; i++) {
        const x = A.vecs[i], y = B.vecs[i];
        let d = 0, nx = 0, ny = 0; for (let k = 0; k < x.length; k++) { d += x[k] * y[k]; nx += x[k] * x[k]; ny += y[k] * y[k]; }
        worst = Math.min(worst, d / Math.sqrt(nx * ny));
    }
    console.log(`${worst >= 0.9999 ? 'PASS' : 'FAIL'}  min cosine FP16 vs FP32 over ${QUERIES.length} queries = ${worst.toFixed(6)} · FP32 ${A.ms.toFixed(0)} ms/q, ${A.rss} MB RSS · FP16 ${B.ms.toFixed(0)} ms/q, ${B.rss} MB RSS`);
    process.exit(worst >= 0.9999 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(2); });
