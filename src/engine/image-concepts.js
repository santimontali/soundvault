'use strict';
/**
 * Image understanding for the vault Brief: a picture → what it shows, in words
 * that lead to UCS sound categories ("tiger" → wild cat, "sneakers" → feet,
 * "glacier" → tundra).
 *
 * SigLIP 2 ViT-B/16 image encoder (int8, patch embedding in float for ORT 1.14:
 * scripts/prepare-image-model.js) compared with two vocabularies embedded
 * offline by its text encoder (scripts/build-image-vocabulary.js), so only the
 * image half ships. Zero-shot, no training, no network:
 *   - visual terms: every UCS synonym (~10k concrete words), each linked to the
 *     subcategories that list it. Pictures match words far better than
 *     category names, and the words lead back to UCS;
 *   - concepts: the 753 UCS subcategories themselves. They confirm a word
 *     ("tiger" means wild cat only when the picture also looks like one) and
 *     can stand on their own when a picture clearly shows a category.
 *
 * Input: views of the picture as 224×224 RGB bytes (the renderer squashes the
 * whole picture, as SigLIP's processor does, and adds crops: the centre, both
 * ends and a zoom, so small things are not lost). Loaded on first use, released
 * after 2 idle minutes (~200 MB of RAM).
 */
const fs = require('fs');
const path = require('path');

const SIZE = 224, DIM = 768;
const IDLE_MS = 2 * 60000;

// Calibrated on ~50 pictures (photos, pack covers, game art, abstract wallpapers):
const TERM_Z = 3.4;        // a word stands out among the ~10k (z within the picture, best view)
const CONCEPT_Z = 1.5;     // ...and the picture itself supports its category
const GENERIC_LINKS = 3;   // a word listed in more subcategories than this ("animal", "night")...
const GENERIC_Z = 2.5;     // ...only counts where the picture supports it strongly
const ALONE_Z = 3.2;       // a category the picture shows clearly counts without a word
const MIN_EVIDENCE = 4.8;  // word z + half its category's z (or 1.5 × a category alone): below, too faint to suggest

function halfToFloat(h) {
    const s = (h & 0x8000) ? -1 : 1, e = (h >> 10) & 0x1f, m = h & 0x3ff;
    if (e === 0) return s * Math.pow(2, -14) * (m / 1024);
    if (e === 31) return m ? NaN : s * Infinity;
    return s * Math.pow(2, e - 15) * (1 + m / 1024);
}

class ImageConcepts {
    constructor(dir) {
        this.dir = dir;
        this.session = null;
        this.items = null;
        this.matrix = null;
        this.terms = null;          // [{ t, cats: [item index] }]
        this.termQ = null;          // Int8Array N×DIM
        this.termScale = null;      // Float32Array N
        this._loading = null;
        this._idle = null;
    }

    get available() {
        return !!this.dir && ['vision_model.onnx', 'concepts.json', 'concepts.f16'].every(f => fs.existsSync(path.join(this.dir, f)));
    }

    async _load() {
        if (this.session) return;
        if (!this._loading) this._loading = (async () => {
            if (!this.items) {
                const meta = JSON.parse(fs.readFileSync(path.join(this.dir, 'concepts.json'), 'utf8'));
                const raw = fs.readFileSync(path.join(this.dir, 'concepts.f16'));
                if (meta.dim !== DIM || raw.length !== meta.count * DIM * 2) throw new Error('image vocabulary does not match the model');
                const m = new Float32Array(meta.count * DIM);
                for (let i = 0; i < m.length; i++) m[i] = halfToFloat(raw.readUInt16LE(i * 2));
                this.items = meta.items;
                this.visual = meta.items.map(visual);
                this.matrix = m;
                const q8 = path.join(this.dir, 'terms.q8');
                if (meta.terms && fs.existsSync(q8)) {
                    const n = meta.terms.count, buf = fs.readFileSync(q8);
                    if (buf.length !== n * 4 + n * DIM) throw new Error('visual terms do not match the vocabulary');
                    this.termScale = new Float32Array(n);
                    for (let i = 0; i < n; i++) this.termScale[i] = buf.readFloatLE(i * 4);
                    this.termQ = new Int8Array(buf.buffer, buf.byteOffset + n * 4, n * DIM);
                    this.terms = meta.terms.list.map(([t, cats]) => ({ t, cats }));
                    this.termSet = new Set(this.terms.map(x => x.t));
                }
            }
            const ort = require('onnxruntime-node');
            const threads = Math.max(1, Math.min(4, require('os').cpus().length - 2));
            this.session = await ort.InferenceSession.create(path.join(this.dir, 'vision_model.onnx'), { intraOpNumThreads: threads, graphOptimizationLevel: 'all' });
            this.ort = ort;
        })().finally(() => { this._loading = null; });
        await this._loading;
    }

    _touch() {
        clearTimeout(this._idle);
        this._idle = setTimeout(() => this.release(), IDLE_MS);
    }

    release() {
        clearTimeout(this._idle);
        if (this.session && this.session.release) { try { this.session.release(); } catch (e) { /* already gone */ } }
        this.session = null;
    }

    /** Unit image embedding (768-D) for 224×224 RGB (or RGBA) bytes. */
    async embed(pixels) {
        await this._load();
        this._touch();
        const px = asBytes(pixels);
        const ch = px.length === SIZE * SIZE * 4 ? 4 : 3;
        if (px.length !== SIZE * SIZE * ch) throw new Error('expected 224×224 RGB pixels');
        const x = new Float32Array(3 * SIZE * SIZE), plane = SIZE * SIZE;
        for (let i = 0; i < plane; i++) {
            // rescale to 0..1, normalize with mean 0.5 / std 0.5 → -1..1 (preprocessor_config.json)
            x[i] = px[i * ch] / 127.5 - 1;
            x[plane + i] = px[i * ch + 1] / 127.5 - 1;
            x[2 * plane + i] = px[i * ch + 2] / 127.5 - 1;
        }
        const out = await this.session.run({ pixel_values: new this.ort.Tensor('float32', x, [1, 3, SIZE, SIZE]) });
        const v = Float32Array.from(out.pooler_output.data);
        let s = 0; for (let d = 0; d < DIM; d++) s += v[d] * v[d];
        const k = 1 / Math.sqrt(s || 1); for (let d = 0; d < DIM; d++) v[d] *= k;
        return v;
    }

    /**
     * z-scores within the picture, best view first: for the 753 concepts
     * (against all of them) and for the visual terms (against all terms).
     */
    async analyze(views) {
        const list = (Array.isArray(views) ? views : [views]).map(asBytes).filter(v => v.length);
        if (!list.length) throw new Error('expected 224×224 RGB pixels');
        await this._load();
        const C = this.items.length, N = this.terms ? this.terms.length : 0;
        const conceptZ = new Float32Array(C).fill(-Infinity), termZ = new Float32Array(N).fill(-Infinity);
        const zInto = (cos, best) => {
            let sum = 0, sq = 0;
            for (let i = 0; i < cos.length; i++) { sum += cos[i]; sq += cos[i] * cos[i]; }
            const mean = sum / cos.length, sd = Math.sqrt(Math.max(1e-12, sq / cos.length - mean * mean));
            for (let i = 0; i < cos.length; i++) { const z = (cos[i] - mean) / sd; if (z > best[i]) best[i] = z; }
        };
        for (const px of list) {
            const v = await this.embed(px);
            const cc = new Float32Array(C), m = this.matrix;
            for (let i = 0; i < C; i++) { let s = 0; const o = i * DIM; for (let d = 0; d < DIM; d++) s += v[d] * m[o + d]; cc[i] = s; }
            zInto(cc, conceptZ);
            if (N) {
                const tc = new Float32Array(N), q = this.termQ;
                for (let i = 0; i < N; i++) { let s = 0; const o = i * DIM; for (let d = 0; d < DIM; d++) s += v[d] * q[o + d]; tc[i] = s * this.termScale[i]; }
                zInto(tc, termZ);
            }
        }
        return { conceptZ, termZ };
    }

    /**
     * What a picture shows, as brief concepts: [{ key (UCS CatID), label (the
     * word seen, or the category's name), ucs (the category's name), score 0..1 }].
     * A word counts when it stands out among the ~10k and the picture also looks
     * like the category it leads to; each word goes to one category (the one the
     * picture supports most). A material shows once, by its plain name ("plastic",
     * not "polypropylene": the picture shows the material, not whether it
     * rips), other categories at most twice. Flat pictures give nothing. On
     * the calibration set: "tiger" (wild cat) for a tiger, "sneakers" and
     * "shoe" for a footsteps cover, "gore" and "blood" for a gore library,
     * "lakewater", "lagoon" and "iceberg" for mountain lakes, "boardgame" and
     * "baccarat" for a casual game UI pack, shimmer and laser words for
     * glowing abstract art.
     */
    async concepts(views, max = 6) {
        const list = (Array.isArray(views) ? views : [views]).map(asBytes);
        if (!list.length || isFlat(list[0])) return [];
        const { conceptZ: zc, termZ: zt } = await this.analyze(list);
        const cand = new Map();                                    // item index → best evidence
        const offer = (c, term, sc) => { const cur = cand.get(c); if (!cur || sc > cur.sc) cand.set(c, { c, term, sc }); };
        if (this.terms) {
            for (let i = 0; i < this.terms.length; i++) {
                if (zt[i] < TERM_Z) continue;
                const { t, cats } = this.terms[i];
                let best = -1;
                for (const c of cats) if (this.visual[c] && zc[c] >= CONCEPT_Z && (best < 0 || zc[c] > zc[best])) best = c;
                if (best < 0 || (cats.length > GENERIC_LINKS && zc[best] < GENERIC_Z)) continue;
                offer(best, t, zt[i] + 0.5 * zc[best]);
            }
        }
        for (let c = 0; c < zc.length; c++) if (this.visual[c] && zc[c] >= ALONE_Z && !cand.has(c)) offer(c, null, 1.5 * zc[c]);
        const out = [], perCat = new Map(), labels = [];
        for (const x of [...cand.values()].sort((a, b) => b.sc - a.sc)) {
            if (out.length >= max || x.sc < MIN_EVIDENCE) break;
            const material = MATERIAL_CATS.has(String(this.items[x.c].cat).toUpperCase());
            // a material reads as itself ("plastic", not "polypropylene" or "plastic break")
            const it = material ? this._generalOf(x.c) : this.items[x.c], cat = String(it.cat).toUpperCase(), n = perCat.get(cat) || 0;
            if (n >= (material ? 1 : 2)) continue;
            const word = x.term && this._singular(x.term);
            const label = word && (!material || it.label.split(' ').includes(word)) ? word : it.label;   // "mud", not "liquid and mud"
            // one chip per thing: "lake" adds nothing after "lakewater", nor "shimmer" after "shimmering"
            if (labels.some(l => l.startsWith(label) || label.startsWith(l))) continue;
            perCat.set(cat, n + 1); labels.push(label);
            out.push({ key: it.key, label, ucs: it.label, score: +Math.max(0, Math.min(1, (x.sc - 4.5) / 4)).toFixed(3) });
        }
        return out;
    }

    /** The category's general entry (PLASTIC → "plastic", PLASMisc), or the entry itself. */
    _generalOf(c) {
        const cat = this.items[c].cat;
        return this.items.find(it => it.cat === cat && /^(MISC|GENERAL)$/i.test(it.sub)) || this.items[c];
    }

    /** "tigers" → "tiger", "beaches" → "beach" when the vocabulary has the singular. */
    _singular(t) {
        const forms = [t.replace(/ies$/, 'y'), t.replace(/(ch|sh|x|ss)es$/, '$1'), t.replace(/s$/, '')];
        for (const f of forms) if (f !== t && this.termSet && this.termSet.has(f)) return f;
        return t;
    }
}

const asBytes = p => (p instanceof Uint8Array ? p : p && p.buffer ? new Uint8Array(p.buffer, p.byteOffset || 0, p.byteLength) : new Uint8Array(0));
// A flat picture (one colour, a gradient) shows nothing: without this, z-scores find noise.
function isFlat(px) {
    let sum = 0, sq = 0, n = 0;
    for (let i = 0; i < px.length; i += 3 * 7) { const y = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]; sum += y; sq += y * y; n++; }
    const mean = sum / n;
    return Math.sqrt(Math.max(0, sq / n - mean * mean)) < 6;
}

// Categories that are materials: their subcategories are what happens to them (impact, rip, flutter).
const MATERIAL_CATS = new Set(['CERAMICS', 'CHAINS', 'CLOTH', 'DIRT & SAND', 'GLASS', 'ICE', 'LEATHER', 'LIQUID & MUD', 'METAL', 'PAPER', 'PLASTIC', 'ROCKS', 'ROPE', 'RUBBER', 'SNOW', 'WATER', 'WOOD']);
// Production-only UCS entries ("trademarked", "pfx", "mix", "designed source"...) are not things a picture shows.
const NOT_VISUAL_CATS = new Set(['ARCHIVED', 'DESIGNED']);
const NOT_VISUAL_SUBS = /^(SOURCE|TRADEMARKED|PFX|ADR|MIX|REFERENCE|BOUNCE|IMPULSE RESPONSE|LOOP GROUP|ASSET|SYNTHETIC|SYNTHESIZED|GRANULAR|TONAL|DESIGNED)$/;
// "Animal bell", "creature footsteps", "human movement": a picture shows the animal, not which of its sounds the project needs.
const AGENT_SUBS = /^(ANIMAL|CREATURE|HUMAN|INSECT|CROWD|BIRD|HORSE)$/;
const AGENT_HOME = new Set(['ANIMALS', 'CREATURES', 'HUMAN', 'AMBIENCE']);
const visual = it => {
    const cat = String(it.cat).toUpperCase(), sub = String(it.sub).toUpperCase();
    return !NOT_VISUAL_CATS.has(cat) && !NOT_VISUAL_SUBS.test(sub) && !(AGENT_SUBS.test(sub) && !AGENT_HOME.has(cat));
};

module.exports = { ImageConcepts, SIZE };
