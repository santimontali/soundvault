const os = require('os');
const { env, AutoProcessor, ClapAudioModelWithProjection } = require('@xenova/transformers');
const ffmpeg = require('fluent-ffmpeg');
ffmpeg.setFfmpegPath(require('ffmpeg-static'));

const WAV = process.argv[2] || 'benchmark-wavs';
const fs = require('fs');
const path = require('path');

// Find a WAV file
let wavFile = WAV;
if (fs.statSync(WAV).isDirectory()) {
    const files = fs.readdirSync(WAV).filter(f => f.endsWith('.wav'));
    wavFile = path.join(WAV, files[0]);
}
console.log(`Test file: ${wavFile}`);
console.log(`CPU: ${os.cpus()[0].model} (${os.cpus().length} cores)\n`);

async function decodeAudio(filePath) {
    return new Promise((res, rej) => {
        const chunks = [];
        ffmpeg(filePath).duration(10).audioFrequency(48000).audioChannels(1).format('f32le')
            .on('error', rej)
            .on('end', () => {
                const buf = Buffer.concat(chunks);
                res(new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4));
            })
            .pipe().on('data', c => chunks.push(c));
    });
}

async function testThreads(threads, processor, model, audioData) {
    env.backends.onnx.wasm.numThreads = threads;

    // Warmup
    const w = await processor(audioData.subarray(0, Math.min(audioData.length, 480000)));
    await model(w);

    // Measure 15 inferences
    const times = [];
    for (let i = 0; i < 15; i++) {
        const t = performance.now();
        const inp = await processor(audioData.subarray(0, Math.min(audioData.length, 480000)));
        const { audio_embeds } = await model(inp);
        Array.from(audio_embeds.data); // force materialization
        times.push(performance.now() - t);
    }
    const sorted = [...times].sort((a, b) => a - b);
    const med = sorted[7];
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    const p25 = sorted[3];
    const p75 = sorted[11];
    
    console.log(`threads=${String(threads).padStart(2)}: median=${med.toFixed(1).padStart(7)}ms  avg=${avg.toFixed(1).padStart(7)}ms  p25=${p25.toFixed(1).padStart(7)}ms  p75=${p75.toFixed(1).padStart(7)}ms  rate=${Math.round(60000/med).toString().padStart(4)} files/min`);
    return med;
}

(async () => {
    const audioData = await decodeAudio(wavFile);
    console.log(`Audio: ${audioData.length} samples (${(audioData.length/48000).toFixed(1)}s)\n`);

    // Load model once  
    const processor = await AutoProcessor.from_pretrained('Xenova/clap-htsat-unfused');
    const model = await ClapAudioModelWithProjection.from_pretrained('Xenova/clap-htsat-unfused', { quantized: false });
    console.log('Model loaded.\n');

    console.log('── ONNX numThreads comparison ──');
    const results = {};
    for (const t of [1, 2, 3, 4, os.cpus().length - 1]) {
        results[t] = await testThreads(t, processor, model, audioData);
    }

    console.log('\n── Summary ──');
    const best = Math.min(...Object.values(results));
    const bestThreads = Object.entries(results).find(([k, v]) => v === best)[0];
    console.log(`Best: threads=${bestThreads} at ${best.toFixed(1)}ms (${Math.round(60000/best)} files/min theoretical)`);
    
    const worst = Math.max(...Object.values(results));
    console.log(`Worst/Best ratio: ${(worst/best).toFixed(2)}x`);

    process.exit(0);
})();
