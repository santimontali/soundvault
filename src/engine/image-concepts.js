'use strict';
/**
 * Image understanding for the vault Brief: a picture → the UCS sound concepts
 * it shows ("rain", "ship", "cannon", "forest"...).
 *
 * SigLIP 2 ViT-B/16 image encoder (int8, patch embedding in float for ORT 1.14:
 * scripts/prepare-image-model.js) compared with the UCS vocabulary embedded
 * offline by its text encoder (scripts/build-image-vocabulary.js), so only
 * the image half ships. Zero-shot, no training, no network.
 *
 * Input: 224×224 RGB bytes (the renderer squashes the picture to 224×224 the
 * way SigLIP's processor does). Loaded on first use, released after 2 idle
 * minutes (the model takes ~200 MB of RAM).
 */
const fs = require('fs');
const path = require('path');

const SIZE = 224, DIM = 768;
const IDLE_MS = 2 * 60000;

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
        this._loading = null;
        this._idle = null;
    }

    get available() {
        return !!this.dir && ['vision_model.onnx', 'concepts.json', 'concepts.f16'].every(f => fs.existsSync(path.join(this.dir, f)));
    }

    async _load() {
        if (this.session) return;
        if (!this._loading) this._loading = (async () => {
            const meta = JSON.parse(fs.readFileSync(path.join(this.dir, 'concepts.json'), 'utf8'));
            const raw = fs.readFileSync(path.join(this.dir, 'concepts.f16'));
            if (meta.dim !== DIM || raw.length !== meta.count * DIM * 2) throw new Error('image vocabulary does not match the model');
            const m = new Float32Array(meta.count * DIM);
            for (let i = 0; i < m.length; i++) m[i] = halfToFloat(raw.readUInt16LE(i * 2));
            const ort = require('onnxruntime-node');
            const threads = Math.max(1, Math.min(4, require('os').cpus().length - 2));
            this.session = await ort.InferenceSession.create(path.join(this.dir, 'vision_model.onnx'), { intraOpNumThreads: threads, graphOptimizationLevel: 'all' });
            this.ort = ort;
            this.items = meta.items;
            this.matrix = m;
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
        const px = pixels instanceof Uint8Array ? pixels : new Uint8Array(pixels.buffer || pixels);
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

    /** Every visual concept's cosine with this image, best first, with its z-score within the image. */
    async rank(pixels) {
        const v = await this.embed(pixels);
        const n = this.items.length, m = this.matrix, cos = new Float32Array(n);
        let sum = 0, sq = 0;
        for (let i = 0; i < n; i++) {
            let s = 0; const o = i * DIM;
            for (let d = 0; d < DIM; d++) s += v[d] * m[o + d];
            cos[i] = s; sum += s; sq += s * s;
        }
        const mean = sum / n, sd = Math.sqrt(Math.max(1e-12, sq / n - mean * mean));
        const out = [];
        for (let i = 0; i < n; i++) if (visual(this.items[i])) out.push({ ...this.items[i], cos: cos[i], z: (cos[i] - mean) / sd });
        return out.sort((a, b) => b.cos - a.cos);
    }

    /**
     * The concepts a picture clearly shows. Scores are relative to the picture
     * itself (z against all 753 concepts): a concept counts when it stands out
     * (z ≥ 2.8) and is not far below the best one; a picture where nothing stands
     * out (best z < 3.2: logos, abstract artwork, flat colour, covers that are
     * mostly lettering) gives no concepts rather than noise. A material shows
     * once ("paper flutter", not also "paper rip" and "paper impact"): the
     * picture shows the material, not what happens to it. Calibrated on 45
     * pictures (pack covers, landscapes, abstract wallpapers): "blood, gore
     * splat, gore" for a gore library, "animals, wild animal, beast, wild cat"
     * (and a stray "leather") for a tiger, "lakeside, tundra, alpine" for a
     * mountain lake, nothing for most abstract art.
     */
    async concepts(pixels, max = 6) {
        const r = await this.rank(pixels);
        if (!r.length || r[0].z < 3.2) return [];
        const floor = Math.max(2.8, r[0].z - 1.8);
        const perCat = new Map(), out = [];
        for (const c of r) {
            if (c.z < floor || out.length >= max) break;
            const cat = String(c.cat).toUpperCase(), n = perCat.get(cat) || 0;
            if (n >= (MATERIAL_CATS.has(cat) ? 1 : 3)) continue;
            perCat.set(cat, n + 1);
            out.push({ key: c.key, label: c.label, score: +Math.max(0, Math.min(1, (c.z - 2.2) / 2.5)).toFixed(3) });
        }
        return out;
    }
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
