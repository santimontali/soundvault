'use strict';
/**
 * Prepares the image model (SigLIP 2 ViT-B/16 224 px, image encoder, int8)
 * for the ONNX Runtime the app ships (onnxruntime-node 1.14).
 *
 * The onnx-community int8 export quantizes the patch embedding as a
 * ConvInteger with SIGNED int8 weights, which ORT 1.14 does not implement
 * (it crashes while creating the session). Everything else is standard. This
 * script replaces that one chain (DynamicQuantizeLinear, ConvInteger, Cast,
 * two scale Muls) with a float Conv whose weights are the dequantized int8
 * ones: the same function, 2.4 MB larger, and it loads.
 *
 *   node scripts/prepare-image-model.js              prepare it
 *   node scripts/prepare-image-model.js --if-needed  build step: only when missing or stale, and
 *                                                    fail unless the vocabulary is there too
 *   node scripts/prepare-image-model.js --check      run it once on a test pattern
 *
 * In:  build-assets/vocab-build/siglip2-base-patch16-224-ONNX/onnx/vision_model_int8.onnx
 *      (onnx-community/siglip2-base-patch16-224-ONNX on Hugging Face; see DISTRIBUTION.md)
 * Out: build-assets/models/siglip2/vision_model.onnx (+ preprocessor_config.json)
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'build-assets', 'vocab-build', 'siglip2-base-patch16-224-ONNX');
const SRC = path.join(SRC_DIR, 'onnx', 'vision_model_int8.onnx');
const OUT_DIR = path.join(ROOT, 'build-assets', 'models', 'siglip2');
const OUT = path.join(OUT_DIR, 'vision_model.onnx');

// ── minimal protobuf reader/writer ──────────────────────────────────────
function varint(b, o) { let r = 0n, s = 0n, x; do { x = b[o++]; r |= BigInt(x & 0x7f) << s; s += 7n; } while (x & 0x80); return [r, o]; }
function fields(b, start, end) {
    const out = []; let o = start;
    while (o < end) {
        let key; [key, o] = varint(b, o);
        const f = Number(key >> 3n), wt = Number(key & 7n);
        if (wt === 0) { let v; [v, o] = varint(b, o); out.push({ f, wt, v }); }
        else if (wt === 2) { let len; [len, o] = varint(b, o); out.push({ f, wt, s: o, e: o + Number(len) }); o += Number(len); }
        else if (wt === 1) { out.push({ f, wt, s: o, e: o + 8 }); o += 8; }
        else if (wt === 5) { out.push({ f, wt, s: o, e: o + 4 }); o += 4; }
        else throw new Error('unsupported wire type ' + wt);
    }
    return out;
}
const encVarint = n => { n = BigInt(n); const out = []; do { let b = Number(n & 0x7fn); n >>= 7n; if (n) b |= 0x80; out.push(b); } while (n); return Buffer.from(out); };
const keyOf = (f, wt) => encVarint((BigInt(f) << 3n) | BigInt(wt));
const lenField = (f, bytes) => Buffer.concat([keyOf(f, 2), encVarint(bytes.length), bytes]);
const varField = (f, v) => Buffer.concat([keyOf(f, 0), encVarint(v)]);
const strField = (f, s) => lenField(f, Buffer.from(s, 'utf8'));
function reEmit(b, x) {
    if (x.wt === 0) return varField(x.f, x.v);
    if (x.wt === 2) return lenField(x.f, b.subarray(x.s, x.e));
    return Buffer.concat([keyOf(x.f, x.wt), b.subarray(x.s, x.e)]);
}

function decodeNode(b, x) {
    const n = { inputs: [], outputs: [], attrs: [] };
    for (const y of fields(b, x.s, x.e)) {
        const s = y.wt === 2 ? b.toString('utf8', y.s, y.e) : null;
        if (y.f === 1) n.inputs.push(s); else if (y.f === 2) n.outputs.push(s); else if (y.f === 3) n.name = s; else if (y.f === 4) n.op = s;
        else if (y.f === 5) n.attrs.push(b.subarray(y.s, y.e));
    }
    return n;
}
function decodeTensor(b, x) {
    const t = { dims: [], floats: [], ints: [] };
    for (const y of fields(b, x.s, x.e)) {
        if (y.f === 1) t.dims.push(Number(y.v));
        else if (y.f === 2) t.type = Number(y.v);
        else if (y.f === 8) t.name = b.toString('utf8', y.s, y.e);
        else if (y.f === 9) t.raw = b.subarray(y.s, y.e);
        else if (y.f === 4) {                                              // float_data (packed or single)
            if (y.wt === 5) t.floats.push(b.readFloatLE(y.s)); else for (let o = y.s; o < y.e; o += 4) t.floats.push(b.readFloatLE(o));
        } else if (y.f === 5) {                                            // int32_data (packed varints or single)
            if (y.wt === 0) t.ints.push(Number(BigInt.asIntN(32, y.v)));
            else { let o = y.s; while (o < y.e) { let v; [v, o] = varint(b, o); t.ints.push(Number(BigInt.asIntN(32, v))); } }
        }
    }
    return t;
}
const scalar = t => (t.raw ? (t.type === 1 ? t.raw.readFloatLE(0) : t.type === 3 ? t.raw.readInt8(0) : t.raw.readUInt8(0)) : t.type === 1 ? t.floats[0] : t.ints[0]);

function patch(buf) {
    const top = fields(buf, 0, buf.length);
    const gField = top.find(x => x.f === 7);
    const graph = fields(buf, gField.s, gField.e);
    const nodes = graph.filter(x => x.f === 1).map(x => ({ x, n: decodeNode(buf, x) }));
    const inits = new Map(graph.filter(x => x.f === 5).map(x => { const t = decodeTensor(buf, x); return [t.name, { x, t }]; }));
    const byOutput = new Map(); for (const e of nodes) for (const o of e.n.outputs) byOutput.set(o, e);
    const consumers = name => nodes.filter(e => e.n.inputs.includes(name));

    const conv = nodes.find(e => e.n.op === 'ConvInteger');
    if (!conv) throw new Error('no ConvInteger: nothing to patch (already patched?)');
    const [xq, wq, xzp, wzp] = conv.n.inputs;
    const dql = byOutput.get(xq);
    if (!dql || dql.n.op !== 'DynamicQuantizeLinear' || byOutput.get(xzp) !== dql) throw new Error('unexpected ConvInteger input');
    const cast = consumers(conv.n.outputs[0]);
    if (cast.length !== 1 || cast[0].n.op !== 'Cast') throw new Error('unexpected ConvInteger consumer');
    const outMul = consumers(cast[0].n.outputs[0]);
    if (outMul.length !== 1 || outMul[0].n.op !== 'Mul') throw new Error('unexpected Cast consumer');
    const scaleIn = outMul[0].n.inputs.find(i => i !== cast[0].n.outputs[0]);
    const scaleMul = byOutput.get(scaleIn);
    if (!scaleMul || scaleMul.n.op !== 'Mul' || !scaleMul.n.inputs.includes(dql.n.outputs[1])) throw new Error('unexpected scale chain');
    const wScaleName = scaleMul.n.inputs.find(i => i !== dql.n.outputs[1]);
    for (const [name, users] of [[dql.n.outputs[0], [conv]], [dql.n.outputs[1], [scaleMul]], [dql.n.outputs[2], [conv]], [scaleIn, outMul]]) {
        const c = consumers(name);
        if (c.length !== users.length || c.some(u => !users.includes(u))) throw new Error('shared intermediate ' + name + ': refusing to patch');
    }

    // Dequantized weights: W = (Wq - zp) * scale
    const W = inits.get(wq).t, zp = scalar(inits.get(wzp).t), sc = scalar(inits.get(wScaleName).t);
    if (!W.raw || W.type !== 3) throw new Error('expected raw int8 weights');
    const q = new Int8Array(W.raw.buffer, W.raw.byteOffset, W.raw.length);
    const wf = Buffer.alloc(q.length * 4);
    for (let i = 0; i < q.length; i++) wf.writeFloatLE((q[i] - zp) * sc, i * 4);
    const wName = wq.replace(/_quantized$/, '') + '_dequantized';
    const tensor = Buffer.concat([...W.dims.map(d => varField(1, d)), varField(2, 1), strField(8, wName), lenField(9, wf)]);

    // Float Conv with the same attributes, writing the tensor the old chain wrote.
    const node = Buffer.concat([
        strField(1, dql.n.inputs[0]), strField(1, wName),
        strField(2, outMul[0].n.outputs[0]),
        strField(3, conv.n.name.replace(/_quant$/, '') + '_float'),
        strField(4, 'Conv'),
        ...conv.n.attrs.map(a => lenField(5, a)),
    ]);

    const drop = new Set([dql, conv, cast[0], outMul[0], scaleMul].map(e => e.x));
    const dropInits = new Set([wq, wzp, wScaleName]);
    const parts = [];
    let initDone = false;
    for (const x of graph) {
        if (x.f === 1 && x === conv.x) { parts.push(lenField(1, node)); continue; }
        if (x.f === 1 && drop.has(x)) continue;
        if (x.f === 5 && dropInits.has(decodeTensor(buf, x).name)) continue;
        if (x.f === 5 && !initDone) { parts.push(lenField(5, tensor)); initDone = true; }
        parts.push(reEmit(buf, x));
    }
    if (!initDone) parts.push(lenField(5, tensor));
    const graphOut = Buffer.concat(parts);
    return { model: Buffer.concat(top.map(x => (x === gField ? lenField(7, graphOut) : reEmit(buf, x)))), zp, sc, n: q.length };
}

async function check(file) {
    const ort = require('onnxruntime-node');
    const s = await ort.InferenceSession.create(file);
    const px = new Float32Array(3 * 224 * 224);
    for (let i = 0; i < px.length; i++) px[i] = Math.sin(i * 0.013) * 0.8;
    const r = await s.run({ pixel_values: new ort.Tensor('float32', px, [1, 3, 224, 224]) });
    const out = r.pooler_output || Object.values(r)[0];
    return { inputs: s.inputNames, outputs: s.outputNames, dims: out.dims, first: Array.from(out.data.slice(0, 4)).map(v => +v.toFixed(5)) };
}

(async () => {
    if (process.argv.includes('--check')) { console.log(JSON.stringify(await check(OUT))); return; }
    const ifNeeded = process.argv.includes('--if-needed');
    const fresh = fs.existsSync(OUT) && (!fs.existsSync(SRC) || fs.statSync(OUT).mtimeMs >= fs.statSync(SRC).mtimeMs);
    if (ifNeeded && fresh) console.log(`[image-model] ${path.relative(ROOT, OUT)} is up to date`);
    else {
        if (!fs.existsSync(SRC)) { console.error(`[image-model] missing ${path.relative(ROOT, SRC)}: download onnx-community/siglip2-base-patch16-224-ONNX first (see DISTRIBUTION.md).`); process.exit(1); }
        const t0 = Date.now();
        const { model, zp, sc, n } = patch(fs.readFileSync(SRC));
        fs.mkdirSync(OUT_DIR, { recursive: true });
        fs.writeFileSync(OUT + '.tmp', model); fs.renameSync(OUT + '.tmp', OUT);
        fs.copyFileSync(path.join(SRC_DIR, 'preprocessor_config.json'), path.join(OUT_DIR, 'preprocessor_config.json'));
        console.log(`[image-model] patch embedding dequantized (${n} weights, zero point ${zp}, scale ${sc.toExponential(3)}) → ${path.relative(ROOT, OUT)} (${(model.length / 1e6).toFixed(1)} MB) in ${Date.now() - t0} ms`);
        console.log('[image-model] check:', JSON.stringify(await check(OUT)));
    }
    const vocab = ['concepts.json', 'concepts.f16'].map(f => path.join(OUT_DIR, f));
    if (ifNeeded && !vocab.every(f => fs.existsSync(f))) {
        console.error('[image-model] the image vocabulary is missing: node scripts/run-electron-node.js scripts/build-image-vocabulary.js (see DISTRIBUTION.md)');
        process.exit(1);
    }
})().catch(e => { console.error('[image-model] failed:', e.message); process.exit(1); });
