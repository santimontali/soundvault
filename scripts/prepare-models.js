'use strict';
/**
 * Build step: make sure build-assets/models holds the models the installer
 * ships, with the CLAP TEXT model's weights stored as float16.
 *
 * Why: text_model.onnx is 64% of the installer. Storing its MatMul/Gemm/
 * Gather weights as FLOAT16 (+ a Cast back to FLOAT that ONNX Runtime folds
 * at load) halves the file (501 → 251 MB) and saves ~440 MB of RAM, with
 * identical search results on a 70k-file library (build audit: cosine
 * 1.00000 vs FP32, top-1 identical for 70/70 queries). The audio model is
 * untouched, so stored embeddings stay valid (no re-index).
 *
 *   node scripts/prepare-models.js            convert if needed (idempotent)
 *   node scripts/prepare-models.js --check    exit 1 unless ready
 *
 * The FP32 original is kept as build-assets/text_model.fp32.onnx.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MODEL_DIR = path.join(ROOT, 'build-assets', 'models', 'Xenova', 'clap-htsat-unfused');
const TEXT = path.join(MODEL_DIR, 'onnx', 'text_model.onnx');
const AUDIO = path.join(MODEL_DIR, 'onnx', 'audio_model.onnx');
const BACKUP = path.join(ROOT, 'build-assets', 'text_model.fp32.onnx');
const FLOAT = 1, FLOAT16 = 10;

function isFp16(file) {
    // FP16 build is ~251 MB, FP32 ~501 MB.
    try { return fs.statSync(file).size < 350e6; } catch (e) { return false; }
}

const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
/** float32 → float16 bits, round to nearest even. */
function toHalf(v) {
    f32[0] = v; const x = u32[0];
    const sign = (x >>> 16) & 0x8000; const exp = (x >>> 23) & 0xff; let mant = x & 0x7fffff;
    if (exp === 0xff) return sign | 0x7c00 | (mant ? 0x200 : 0);
    const e = exp - 127 + 15;
    if (e >= 0x1f) return sign | 0x7c00;
    if (e <= 0) {
        if (e < -10) return sign;
        mant |= 0x800000; const shift = 14 - e; let h = mant >>> shift;
        const rem = mant & ((1 << shift) - 1), half = 1 << (shift - 1);
        if (rem > half || (rem === half && (h & 1))) h++;
        return sign | h;
    }
    let h = sign | (e << 10) | (mant >>> 13);
    const rem = mant & 0x1fff;
    if (rem > 0x1000 || (rem === 0x1000 && (h & 1))) h++;
    return h;
}

function convert(inFile, outFile) {
    const { onnx } = require('onnx-proto');
    const Long = require('long');
    const t0 = Date.now();
    const model = onnx.ModelProto.decode(fs.readFileSync(inFile));
    const g = model.graph;
    const consumers = new Map();
    for (const n of g.node) n.input.forEach((inp, idx) => { if (!consumers.has(inp)) consumers.set(inp, []); consumers.get(inp).push({ n, idx }); });
    const castTo = onnx.AttributeProto.create({ name: 'to', type: onnx.AttributeProto.AttributeType.INT, i: Long.fromNumber(FLOAT) });
    const casts = [], keep = [];
    let converted = 0;
    for (const t of g.initializer) {
        const bytes = t.rawData ? t.rawData.length : 0;
        const kinds = new Set((consumers.get(t.name) || []).map(c => c.n.opType + '#' + c.idx));
        const isWeight = t.dataType === FLOAT && t.dims.length === 2 && bytes > 64 * 1024 && kinds.size &&
            [...kinds].every(k => k === 'MatMul#1' || k === 'Gather#0' || k === 'Gemm#1');
        if (!isWeight) { keep.push(t); continue; }
        const w = new Float32Array(t.rawData.buffer.slice(t.rawData.byteOffset, t.rawData.byteOffset + bytes));
        const h = new Uint16Array(w.length);
        for (let i = 0; i < w.length; i++) h[i] = toHalf(w[i]);
        const q = onnx.TensorProto.create({ name: t.name + '__fp16', dims: t.dims, dataType: FLOAT16, rawData: Buffer.from(h.buffer) });
        keep.push(q);
        casts.push(onnx.NodeProto.create({ name: 'cast_' + t.name, opType: 'Cast', input: [q.name], output: [t.name], attribute: [castTo] }));
        converted++;
    }
    g.initializer = keep;
    g.node = [...casts, ...g.node];
    const out = onnx.ModelProto.encode(model).finish();
    const tmp = outFile + '.part';
    fs.writeFileSync(tmp, out);
    fs.renameSync(tmp, outFile);
    return { converted, mb: +(out.length / 1e6).toFixed(1), ms: Date.now() - t0 };
}

function main() {
    const check = process.argv.includes('--check');
    for (const f of [TEXT, AUDIO]) {
        if (!fs.existsSync(f)) {
            console.error(`[models] missing ${path.relative(ROOT, f)}, copy the Xenova/clap-htsat-unfused model folder into build-assets/models first.`);
            process.exit(1);
        }
    }
    if (isFp16(TEXT)) { console.log('[models] text model already float16, ready'); return; }
    if (check) { console.error('[models] text model is float32, run: node scripts/prepare-models.js'); process.exit(1); }
    if (!fs.existsSync(BACKUP)) fs.copyFileSync(TEXT, BACKUP);
    const r = convert(BACKUP, TEXT);
    console.log(`[models] text model → float16: ${r.converted} weight tensors, ${r.mb} MB in ${(r.ms / 1000).toFixed(1)} s (FP32 kept at ${path.relative(ROOT, BACKUP)})`);
}

if (require.main === module) main();
module.exports = { convert, toHalf };
