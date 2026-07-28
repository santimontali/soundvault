/**
 * bench-indexing.js — Diagnostic benchmark for SoundVault indexing pipeline
 * 
 * Measures per-stage timing to isolate bottlenecks:
 *   1. ffmpeg decode (spawn vs fluent-ffmpeg, 10s vs 30s)
 *   2. CLAP preprocessing
 *   3. CLAP inference (FP32 vs quantized)
 *   4. Spectral extraction
 *   5. DB insert
 *   6. ONNX thread count comparison (1 vs N-1 cores)
 * 
 * Usage: npx electron . --bench
 *   (must run under Electron for accurate environment matching)
 * 
 * Or standalone: node src/bench-indexing.js <folder_with_wavs>
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

// ═══ Config ═══
const SAMPLE_SIZE = 20; // Number of files to benchmark
const WAV_FOLDER = process.argv[2] || null;

// ═══ Detect environment ═══
console.log('╔══════════════════════════════════════════════════╗');
console.log('║     SoundVault Indexing Pipeline Benchmark       ║');
console.log('╚══════════════════════════════════════════════════╝');
console.log(`CPU: ${os.cpus()[0].model} (${os.cpus().length} cores)`);
console.log(`RAM: ${(os.totalmem() / 1073741824).toFixed(1)} GB`);
console.log(`Node: ${process.version}`);
console.log(`process.release.name: ${process.release.name}`);
console.log(`Platform: ${process.platform} ${process.arch}`);
console.log('');

// ═══ Check ONNX backend ═══
async function checkONNXBackend() {
    console.log('── ONNX Backend Detection ──');
    
    let nodeAvailable = false;
    try {
        const ortNode = require('onnxruntime-node');
        console.log(`  onnxruntime-node: INSTALLED (${Object.keys(ortNode).length} exports)`);
        nodeAvailable = true;
    } catch (e) {
        console.log(`  onnxruntime-node: NOT AVAILABLE (${e.message})`);
    }

    try {
        const ortWeb = require('onnxruntime-web');
        console.log(`  onnxruntime-web:  INSTALLED`);
    } catch (e) {
        console.log(`  onnxruntime-web:  NOT AVAILABLE`);
    }

    // Check what Transformers.js actually selects
    const isNode = typeof process !== 'undefined' && process?.release?.name === 'node';
    console.log(`  process.release.name = '${process?.release?.name}'`);
    console.log(`  Transformers.js will select: ${isNode ? 'onnxruntime-node (NATIVE C++)' : 'onnxruntime-web (WASM)'}`);
    console.log('');
    
    return nodeAvailable;
}

// ═══ Find test WAV files ═══
function findWavFiles(folder, max) {
    const results = [];
    function walk(dir) {
        if (results.length >= max) return;
        try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                if (results.length >= max) return;
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) walk(full);
                else if (entry.name.toLowerCase().endsWith('.wav')) results.push(full);
            }
        } catch (e) { /* skip inaccessible dirs */ }
    }
    walk(folder);
    return results;
}

// ═══ ffmpeg decode via child_process.spawn ═══
function decodeWithSpawn(filePath, maxDuration, ffmpegPath) {
    return new Promise((resolve, reject) => {
        const args = [
            '-hide_banner', '-loglevel', 'error',
            '-i', filePath,
            '-t', String(maxDuration),
            '-ar', '48000', '-ac', '1', '-f', 'f32le',
            'pipe:1'
        ];
        const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'ignore'] });
        const chunks = [];
        proc.stdout.on('data', chunk => chunks.push(chunk));
        proc.on('close', (code) => {
            if (code !== 0) { reject(new Error(`exit ${code}`)); return; }
            const buf = Buffer.concat(chunks);
            resolve(new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4));
        });
        proc.on('error', reject);
    });
}

// ═══ ffmpeg decode via fluent-ffmpeg ═══
function decodeWithFluent(filePath, maxDuration, ffmpegPath) {
    const ffmpeg = require('fluent-ffmpeg');
    ffmpeg.setFfmpegPath(ffmpegPath);
    return new Promise((resolve, reject) => {
        const chunks = [];
        ffmpeg(filePath)
            .duration(maxDuration)
            .audioFrequency(48000).audioChannels(1).format('f32le')
            .on('error', reject)
            .on('end', () => {
                const buf = Buffer.concat(chunks);
                resolve(new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4));
            })
            .pipe().on('data', chunk => chunks.push(chunk));
    });
}

// ═══ Benchmark helper ═══
function avg(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }
function med(arr) { const s = [...arr].sort((a,b) => a-b); return s[Math.floor(s.length/2)]; }
function fmt(ms) { return ms.toFixed(1).padStart(7) + 'ms'; }

// ═══ Main benchmark ═══
async function runBenchmark() {
    await checkONNXBackend();

    // Find WAV files
    let wavFolder = WAV_FOLDER;
    if (!wavFolder) {
        // Try to read vaults from the app's userData  
        const appDataPath = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
        const userDataPath = path.join(appDataPath, 'soundvault');
        const vaultsFile = path.join(userDataPath, 'vaults.json');
        if (fs.existsSync(vaultsFile)) {
            const vaults = JSON.parse(fs.readFileSync(vaultsFile, 'utf8'));
            wavFolder = vaults[0]?.path;
            console.log(`Found vault: ${wavFolder}`);
        }
        if (!wavFolder) {
            console.log('Usage: node src/bench-indexing.js <folder_with_wavs>');
            console.log('No WAV folder provided and no vaults.json found.');
            process.exit(1);
        }
    }

    console.log(`──  Finding ${SAMPLE_SIZE} WAV files in: ${wavFolder}`);
    const wavFiles = findWavFiles(wavFolder, SAMPLE_SIZE);
    console.log(`    Found ${wavFiles.length} files`);
    if (wavFiles.length === 0) { console.log('No WAV files found!'); process.exit(1); }
    console.log('');

    const ffmpegPath = require('ffmpeg-static');
    console.log(`ffmpeg: ${ffmpegPath}`);
    console.log('');

    // ═══ Test 1: ffmpeg decode comparison ═══
    console.log('══ TEST 1: ffmpeg Decode Speed ══');
    
    const spawn10Times = [];
    const spawn30Times = [];
    const fluentTimes = [];

    for (const file of wavFiles) {
        // spawn 10s
        let t0 = Date.now();
        await decodeWithSpawn(file, 10, ffmpegPath);
        spawn10Times.push(Date.now() - t0);

        // spawn 30s
        t0 = Date.now();
        await decodeWithSpawn(file, 30, ffmpegPath);
        spawn30Times.push(Date.now() - t0);

        // fluent-ffmpeg 10s
        t0 = Date.now();
        await decodeWithFluent(file, 10, ffmpegPath);
        fluentTimes.push(Date.now() - t0);
    }

    console.log(`  spawn(10s):       avg=${fmt(avg(spawn10Times))}  med=${fmt(med(spawn10Times))}`);
    console.log(`  spawn(30s):       avg=${fmt(avg(spawn30Times))}  med=${fmt(med(spawn30Times))}`);
    console.log(`  fluent-ffmpeg(10s): avg=${fmt(avg(fluentTimes))}  med=${fmt(med(fluentTimes))}`);
    console.log('');

    // ═══ Test 2: CLAP model loading ═══
    console.log('══ TEST 2: CLAP Model Loading ══');
    const { env, AutoProcessor, ClapAudioModelWithProjection } = require('@xenova/transformers');

    // FP32 (no quantization flag)
    console.log('  Loading FP32 model...');
    let t0 = Date.now();
    const processorFP32 = await AutoProcessor.from_pretrained('Xenova/clap-htsat-unfused');
    const modelFP32 = await ClapAudioModelWithProjection.from_pretrained('Xenova/clap-htsat-unfused', { quantized: false });
    const fp32LoadTime = Date.now() - t0;
    console.log(`    FP32 load time: ${fp32LoadTime}ms`);

    // Quantized
    console.log('  Loading quantized model...');
    t0 = Date.now();
    const modelQ = await ClapAudioModelWithProjection.from_pretrained('Xenova/clap-htsat-unfused', { quantized: true });
    const qLoadTime = Date.now() - t0;
    console.log(`    Quantized load time: ${qLoadTime}ms`);
    console.log('');

    // ═══ Test 3: CLAP inference with different configs ═══
    console.log('══ TEST 3: CLAP Inference (per-file) ══');
    
    // Decode 5 files for inference testing
    const testAudios = [];
    for (let i = 0; i < Math.min(5, wavFiles.length); i++) {
        testAudios.push(await decodeWithSpawn(wavFiles[i], 10, ffmpegPath));
    }

    // Test with different thread counts
    for (const threads of [1, 2, 4, Math.max(1, os.cpus().length - 1)]) {
        env.backends.onnx.wasm.numThreads = threads;
        const times = [];

        for (const audio of testAudios) {
            const clapAudio = audio.subarray(0, Math.min(audio.length, 48000 * 10));
            
            // Preprocessing
            const tPre = Date.now();
            const inputs = await processorFP32(clapAudio);
            const preTime = Date.now() - tPre;

            // Inference (FP32)
            const tInf = Date.now();
            const { audio_embeds } = await modelFP32(inputs);
            const infTime = Date.now() - tInf;

            times.push({ pre: preTime, inf: infTime, total: preTime + infTime });
        }

        console.log(`  Threads=${threads}: preprocess avg=${fmt(avg(times.map(t=>t.pre)))}  inference avg=${fmt(avg(times.map(t=>t.inf)))}  total=${fmt(avg(times.map(t=>t.total)))}`);
    }

    // Test quantized model inference
    console.log('');
    console.log('  Quantized model inference:');
    const qTimes = [];
    for (const audio of testAudios) {
        const clapAudio = audio.subarray(0, Math.min(audio.length, 48000 * 10));
        const inputs = await processorFP32(clapAudio);
        const tInf = Date.now();
        await modelQ(inputs);
        qTimes.push(Date.now() - tInf);
    }
    console.log(`    Quantized: inference avg=${fmt(avg(qTimes))}  med=${fmt(med(qTimes))}`);
    console.log('');

    // ═══ Test 4: Spectral extraction ═══
    console.log('══ TEST 4: Spectral Extraction ══');
    const { SpectralFingerprinter, compressMatrix } = require('../src/spectral-engine');
    const fp = new SpectralFingerprinter();
    const spectralTimes = [];
    
    for (let i = 0; i < Math.min(5, wavFiles.length); i++) {
        const audio30 = await decodeWithSpawn(wavFiles[i], 30, ffmpegPath);
        const tSpec = Date.now();
        const { matrix, numWindows } = fp.extract(audio30, 48000);
        fp.computeSummary(matrix, numWindows);
        compressMatrix(matrix);
        spectralTimes.push(Date.now() - tSpec);
    }
    console.log(`  Spectral (30s audio): avg=${fmt(avg(spectralTimes))}  med=${fmt(med(spectralTimes))}`);
    console.log('');

    // ═══ Summary ═══
    console.log('══════════════════════════════════════════');
    console.log('          SUMMARY PER FILE                ');
    console.log('══════════════════════════════════════════');
    
    const bestFFmpeg = med(spawn10Times);
    const bestInference = med(qTimes);
    const bestSpectral = med(spectralTimes);
    const totalPerFile = bestFFmpeg + bestInference + bestSpectral + 2; // +2ms for DB
    const filesPerMin = Math.round(60000 / totalPerFile);

    console.log(`  ffmpeg decode (10s): ${fmt(bestFFmpeg)}`);
    console.log(`  CLAP inference (Q):  ${fmt(bestInference)}`);
    console.log(`  Spectral extract:    ${fmt(bestSpectral)}`);
    console.log(`  DB insert:              ~2ms`);
    console.log(`  ──────────────────────────────`);
    console.log(`  TOTAL per file:      ${fmt(totalPerFile)}`);
    console.log(`  Estimated rate:      ${filesPerMin} files/min`);
    console.log(`  70k full index:      ~${Math.round(70000 / filesPerMin)} min`);
    console.log('');
    console.log('  With prefetch overlap (ffmpeg parallel):');
    const overlapTotal = Math.max(bestInference + bestSpectral, bestFFmpeg) + 2;
    const overlapRate = Math.round(60000 / overlapTotal);
    console.log(`  TOTAL per file:      ${fmt(overlapTotal)}`);
    console.log(`  Estimated rate:      ${overlapRate} files/min`);
    console.log(`  70k full index:      ~${Math.round(70000 / overlapRate)} min`);
    
    process.exit(0);
}

runBenchmark().catch(err => {
    console.error('Benchmark failed:', err);
    process.exit(1);
});
