'use strict';
/**
 * Builds the image vocabulary: the UCS sound categories (753 subcategories)
 * embedded with the SigLIP 2 TEXT encoder, so the app only ships the image
 * encoder and compares a picture with these vectors (zero-shot).
 *
 * Each concept averages several phrasings ("this is a photo of …": its name,
 * category + subcategory, the UCS explanation, its first synonyms), lowercased
 * and padded to 64 tokens as SigLIP 2 was trained. Each concept also keeps its
 * distinctive UCS synonyms ("tiger", "lion", "cheetah" for wild cats): the app
 * matches them against file names.
 *
 *   node scripts/run-electron-node.js scripts/build-image-vocabulary.js
 *
 * In:  build-assets/vocab-build/UCS v8.2.1 Full List.xlsx (public domain, universalcategorysystem.com)
 *      build-assets/vocab-build/siglip2-base-patch16-224-ONNX/onnx/text_model_int8.onnx
 *      (build-assets/vocab-build/siglip2-tokenizer/ is derived from its tokenizer on the first run)
 * Out: build-assets/models/siglip2/concepts.json + concepts.f16 (N × 768 float16, row per concept)
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const UCS = path.join(ROOT, 'build-assets', 'vocab-build', 'UCS v8.2.1 Full List.xlsx');
const HF = path.join(ROOT, 'build-assets', 'vocab-build', 'siglip2-base-patch16-224-ONNX');
const TOK_DIR = path.join(ROOT, 'build-assets', 'vocab-build', 'siglip2-tokenizer');
const OUT_DIR = path.join(ROOT, 'build-assets', 'models', 'siglip2');
const DIM = 768;

// ── xlsx (zip + XML), no dependencies ──────────────────────────────────
function unzip(b) {
    let e = b.length - 22; while (e >= 0 && b.readUInt32LE(e) !== 0x06054b50) e--;
    const n = b.readUInt16LE(e + 10); let o = b.readUInt32LE(e + 16); const files = {};
    for (let i = 0; i < n; i++) {
        const method = b.readUInt16LE(o + 10), csize = b.readUInt32LE(o + 20), nlen = b.readUInt16LE(o + 28), xlen = b.readUInt16LE(o + 30), clen = b.readUInt16LE(o + 32), lo = b.readUInt32LE(o + 42);
        const name = b.toString('utf8', o + 46, o + 46 + nlen);
        const ds = lo + 30 + b.readUInt16LE(lo + 26) + b.readUInt16LE(lo + 28);
        const data = b.subarray(ds, ds + csize);
        files[name] = method === 8 ? zlib.inflateRawSync(data) : data;
        o += 46 + nlen + xlen + clen;
    }
    return files;
}
function readUcs(file) {
    const f = unzip(fs.readFileSync(file));
    const dec = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
    const strings = [...f['xl/sharedStrings.xml'].toString('utf8').matchAll(/<si>([\s\S]*?)<\/si>/g)]
        .map(m => dec([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(t => t[1]).join('')));
    const rows = [...f['xl/worksheets/sheet1.xml'].toString('utf8').matchAll(/<row [^>]*>([\s\S]*?)<\/row>/g)].map(m => {
        const r = {};
        for (const c of m[1].matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
            const v = c[3] && /<v>([\s\S]*?)<\/v>/.exec(c[3]), is = c[3] && /<t[^>]*>([\s\S]*?)<\/t>/.exec(c[3]);
            r[c[1]] = v ? (/t="s"/.test(c[2]) ? strings[+v[1]] : dec(v[1])) : is ? dec(is[1]) : '';
        }
        return r;
    });
    const head = rows.findIndex(r => r.A === 'Category' && r.C === 'CatID');
    return rows.slice(head + 1).filter(r => r.A && r.B && r.C).map(r => ({
        cat: r.A.trim(), sub: r.B.trim(), catId: r.C.trim(), catShort: (r.D || '').trim(),
        explanation: (r.E || '').trim(), synonyms: (r.F || '').split(',').map(s => s.trim()).filter(Boolean),
    }));
}

// ── labels and phrasings ────────────────────────────────────────────────
// A label is what the user reads on a chip and what CLAP hears as a query:
// "helicopter", "boat door", "metal impact", "antique vehicle", "rain".
const GENERIC = new Set(['GENERAL', 'MISC', 'MISCELLANEOUS', 'OTHER']);
// Categories that are materials: their subcategories are actions ("metal impact").
const MATERIALS = new Set(['CERAMICS', 'CHAINS', 'CLOTH', 'DIRT & SAND', 'GLASS', 'ICE', 'LEATHER', 'LIQUID & MUD', 'METAL', 'PAPER', 'PLASTIC', 'ROCKS', 'ROPE', 'RUBBER', 'SNOW', 'WOOD']);
// Subcategories that read as adjectives: they go before the noun ("antique vehicle").
const ADJECTIVE = new Set(['ANTIQUE', 'ELECTRIC', 'ELECTRONIC', 'MILITARY', 'MODERN', 'INDUSTRIAL', 'DOMESTIC', 'HITECH', 'DESIGNED', 'REAL', 'COMMERCIAL', 'RECREATIONAL',
    'TRADITIONAL', 'AIR POWERED', 'HIGH SPEED', 'LARGE', 'SMALL', 'DIGITAL', 'ANALOG', 'MECHANICAL', 'HYDRAULIC & PNEUMATIC', 'PNEUMATIC', 'TACTICAL', 'EXPERIMENTAL',
    'ANGRY', 'CHILDREN', 'WILD', 'DOMESTIC', 'AQUATIC', 'AVIAN', 'EVIL', 'ANGELIC', 'ELEMENTAL', 'TONAL', 'TURBULENT', 'HUMAN', 'ANIMAL', 'CREATURE', 'INSECT']);
const NOUN = {
    AIRCRAFT: 'aircraft', ALARMS: 'alarm', AMBIENCE: 'ambience', ANIMALS: 'animal', BEEPS: 'beep', BELLS: 'bell', BIRDS: 'bird', BOATS: 'boat', BULLETS: 'bullet',
    CARTOON: 'cartoon', CHAINS: 'chain', CHEMICALS: 'chemical', CLOCKS: 'clock', COMMUNICATIONS: 'communications', COMPUTERS: 'computer', CREATURES: 'creature',
    CROWDS: 'crowd', DOORS: 'door', DRAWERS: 'drawer', EXPLOSIONS: 'explosion', FIREWORKS: 'firework', FOOTSTEPS: 'footsteps', GAMES: 'game', GUNS: 'gun', HORNS: 'horn',
    LASERS: 'laser', MACHINES: 'machine', MOTORS: 'motor', OBJECTS: 'object', ROBOTS: 'robot', ROCKS: 'rock', SCIFI: 'sci-fi', SPORTS: 'sports', SWOOSHES: 'swoosh',
    TOOLS: 'tool', TOYS: 'toy', TRAINS: 'train', 'USER INTERFACE': 'UI', VEHICLES: 'vehicle', VOICES: 'voice', WEAPONS: 'weapon', WHISTLES: 'whistle', WINDOWS: 'window',
    WINGS: 'wings', CERAMICS: 'ceramic',
};
const words = s => s.toLowerCase().replace(/&/g, ' and ').replace(/[/]/g, ' or ').replace(/[^a-z0-9' -]+/g, ' ').replace(/\s+/g, ' ').trim();
let subUse = new Map();                  // subcategory name → number of categories using it
// Materials read as adjectives too ("metal door", "wood drawer").
for (const m of ['METAL', 'WOOD', 'GLASS', 'PLASTIC', 'STONE', 'CONCRETE', 'RUBBER', 'CERAMIC', 'COMPOSITE', 'CLOTH', 'HAND', 'POWER', 'GARDEN', 'VIDEO', 'BOARD', 'INDOOR', 'OUTDOOR']) ADJECTIVE.add(m);
// Categories whose subcategories never stand alone: 'before' = noun first ("laser gun"), 'after' = noun last ("hand tool").
const ALWAYS = { SCIFI: 'before', CLOCKS: 'before', LASERS: 'before', TOOLS: 'after', GAMES: 'after', SPORTS: 'after', MOVEMENT: 'after', FOOTSTEPS: 'after', WINGS: 'after', CROWDS: 'after' };
function labelOf(u) {
    const sub = u.sub.toUpperCase(), cat = u.cat.toUpperCase();
    // "CAT WILD", "DOG DOMESTIC": UCS lists the noun first; people say "wild cat".
    const s = words(u.sub).replace(/^(\w+) (wild|domestic)$/, '$2 $1');
    const noun = NOUN[cat] || words(u.cat);
    if (GENERIC.has(sub)) return words(u.cat);
    if (cat === 'RAIN') return sub === 'INTERIOR' ? 'interior rain' : `rain on ${s}`;
    if (MATERIALS.has(cat)) return `${noun === words(u.cat) ? words(u.cat) : noun} ${s}`;
    if (ALWAYS[cat]) return ALWAYS[cat] === 'before' ? `${noun} ${s}` : `${s} ${noun}`;
    if ((subUse.get(sub) || 0) <= 1 && !ADJECTIVE.has(sub)) return s;                   // specific: "helicopter", "dragon", "desert"
    if (cat === 'AMBIENCE') return `${s} ambience`;
    return ADJECTIVE.has(sub) ? `${s} ${noun}` : `${noun} ${s}`;
}
// Synonyms worth matching in file names: one word, not generic ("atmos",
// "background"), and specific to at most two subcategories ("hit" is in 25).
const GENERIC_SYN = new Set(['atmos', 'atmosphere', 'ambience', 'ambiance', 'background', 'miscellaneous', 'misc', 'general', 'other', 'various']);
let synUse = new Map();
const synonymsOf = u => [...new Set(u.synonyms.map(x => x.toLowerCase()))]
    .filter(x => x.length >= 4 && /^[a-z][a-z-]*$/.test(x) && !GENERIC_SYN.has(x) && (synUse.get(x) || 0) <= 2).slice(0, 40);
function phrasings(u) {
    const label = u.label || labelOf(u);
    const out = [label, `${words(u.sub)} ${words(u.cat)}`];
    const expl = words(u.explanation.split(/[.;(]/)[0] || '').split(' ').slice(0, 14).join(' ');
    if (expl.length > 3) out.push(expl);
    if (u.synonyms.length) out.push(u.synonyms.slice(0, 4).map(words).join(', '));
    return [...new Set(out.filter(Boolean))].map(t => `this is a photo of ${t}.`);
}

// transformers.js 2.x reads BPE merges as "a b" strings; newer tokenizer.json files list them as pairs.
function ensureTokenizer() {
    if (fs.existsSync(path.join(TOK_DIR, 'tokenizer.json'))) return;
    const t = JSON.parse(fs.readFileSync(path.join(HF, 'tokenizer.json'), 'utf8'));
    if (Array.isArray(t.model.merges) && Array.isArray(t.model.merges[0])) t.model.merges = t.model.merges.map(m => m.join(' '));
    fs.mkdirSync(TOK_DIR, { recursive: true });
    fs.writeFileSync(path.join(TOK_DIR, 'tokenizer.json'), JSON.stringify(t));
    for (const f of ['tokenizer_config.json', 'special_tokens_map.json', 'config.json']) fs.copyFileSync(path.join(HF, f), path.join(TOK_DIR, f));
    console.log('[vocab] tokenizer converted for transformers.js → ' + path.relative(ROOT, TOK_DIR));
}

(async () => {
    for (const f of [UCS, path.join(HF, 'onnx', 'text_model_int8.onnx'), path.join(HF, 'tokenizer.json')]) {
        if (!fs.existsSync(f)) { console.error('[vocab] missing ' + path.relative(ROOT, f) + ' (see DISTRIBUTION.md)'); process.exit(1); }
    }
    ensureTokenizer();
    const t0 = Date.now();
    const ucs = readUcs(UCS);
    subUse = new Map();
    for (const u of ucs) subUse.set(u.sub.toUpperCase(), (subUse.get(u.sub.toUpperCase()) || 0) + 1);
    synUse = new Map();
    for (const u of ucs) for (const x of new Set(u.synonyms.map(y => y.toLowerCase()))) synUse.set(x, (synUse.get(x) || 0) + 1);
    // Labels must be unique: a repeated one keeps it only where it is the category itself.
    const labels = ucs.map(labelOf), seen = new Map();
    labels.forEach((l, i) => seen.set(l, (seen.get(l) || 0) + 1));
    ucs.forEach((u, i) => {
        if (seen.get(labels[i]) < 2 || GENERIC.has(u.sub.toUpperCase())) return;
        const noun = NOUN[u.cat.toUpperCase()] || words(u.cat);
        labels[i] = u.cat.toUpperCase() === 'AMBIENCE' ? `${words(u.sub)} ambience` : `${noun} ${words(u.sub)}`;
    });
    ucs.forEach((u, i) => { u.label = labels[i]; });
    if (process.argv.includes('--labels')) { for (const u of ucs) console.log(u.catId.padEnd(12), u.label); return; }
    const ort = require('onnxruntime-node');
    const tf = require('@xenova/transformers');
    tf.env.allowRemoteModels = false;
    tf.env.localModelPath = path.dirname(TOK_DIR) + path.sep;
    const tok = await tf.AutoTokenizer.from_pretrained(path.basename(TOK_DIR));
    const text = await ort.InferenceSession.create(path.join(HF, 'onnx', 'text_model_int8.onnx'));
    const embed = async texts => {
        const e = tok(texts, { padding: 'max_length', max_length: 64, truncation: true });
        const ids = BigInt64Array.from(Array.from(e.input_ids.data, Number), BigInt);
        const r = await text.run({ input_ids: new ort.Tensor('int64', ids, e.input_ids.dims) });
        return r.pooler_output.data;
    };
    const items = [], mat = new Float32Array(ucs.length * DIM);
    for (let i = 0; i < ucs.length; i++) {
        const u = ucs[i], ps = phrasings(u);
        const out = await embed(ps);
        const v = mat.subarray(i * DIM, (i + 1) * DIM);
        for (let p = 0; p < ps.length; p++) {
            const row = out.subarray(p * DIM, (p + 1) * DIM);
            let s = 0; for (let d = 0; d < DIM; d++) s += row[d] * row[d];
            const k = 1 / Math.sqrt(s || 1); for (let d = 0; d < DIM; d++) v[d] += row[d] * k;
        }
        let s = 0; for (let d = 0; d < DIM; d++) s += v[d] * v[d];
        const k = 1 / Math.sqrt(s || 1); for (let d = 0; d < DIM; d++) v[d] *= k;
        items.push({ key: u.catId, label: u.label, cat: u.cat, sub: u.sub, catShort: u.catShort, syn: synonymsOf(u) });
        if (i % 100 === 99) console.log(`[vocab] ${i + 1}/${ucs.length}`);
    }
    // float16 storage (1.2 MB): plenty for cosine ranking
    const f16 = Buffer.alloc(mat.length * 2);
    const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
    for (let i = 0; i < mat.length; i++) {
        f32[0] = mat[i]; const x = u32[0];
        const sign = (x >>> 16) & 0x8000, exp = ((x >>> 23) & 0xff) - 127 + 15, man = x & 0x7fffff;
        let h;
        if (exp <= 0) h = sign | (exp < -10 ? 0 : ((man | 0x800000) >> (1 - exp + 13)));
        else if (exp >= 31) h = sign | 0x7c00;
        else h = sign | (exp << 10) | ((man + 0x1000) >> 13);
        f16.writeUInt16LE(h & 0xffff, i * 2);
    }
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(OUT_DIR, 'concepts.f16'), f16);
    fs.writeFileSync(path.join(OUT_DIR, 'concepts.json'), JSON.stringify({
        v: 2, dim: DIM, count: items.length, model: 'google/siglip2-base-patch16-224', source: 'UCS v8.2.1 (public domain)',
        template: 'this is a photo of {}.', items,
    }));
    console.log(`[vocab] ${items.length} concepts embedded in ${((Date.now() - t0) / 1000).toFixed(1)} s → ${path.relative(ROOT, OUT_DIR)}`);
})().catch(e => { console.error('[vocab] failed:', e); process.exit(1); });
