// Brief images: decode whatever the browser can read, shrink it to at most
// 640 px on the long side, encode WebP, pull a small palette (k-means on a
// downsampled copy) and the 224x224 RGB views the image model reads. It all
// happens here, on this computer.
const MAX_SIDE = 640;
const QUALITY = 0.86;
const SAMPLE = 48;                  // the palette looks at a 48x48 copy
export const MODEL_SIDE = 224;      // what the image model reads

export const isImageFile = f => !!f && (/^image\//.test(f.type || '') || /\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(f.name || ''));

/** Blob/File → { bytes (WebP, PNG where WebP is unavailable), palette: string[], pixels (224x224 RGB views), width, height } */
export async function prepareImage(blob) {
    const bmp = await createImageBitmap(blob);
    try {
        const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
        const w = Math.max(1, Math.round(bmp.width * scale)), h = Math.max(1, Math.round(bmp.height * scale));
        const cv = new OffscreenCanvas(w, h);
        const cx = cv.getContext('2d');
        cx.imageSmoothingEnabled = true;
        cx.imageSmoothingQuality = 'high';
        cx.drawImage(bmp, 0, 0, w, h);
        const out = await cv.convertToBlob({ type: 'image/webp', quality: QUALITY });
        return { bytes: new Uint8Array(await out.arrayBuffer()), palette: paletteOf(bmp), pixels: modelViews(bmp), width: w, height: h };
    } finally {
        bmp.close();
    }
}

/**
 * What the image model looks at: the whole picture squashed (not cropped) to
 * 224x224, as SigLIP's processor does, plus crops so small things are not
 * lost: the centre square, both ends of a wide or tall picture and a zoom on
 * the middle. Each is 224x224 RGB bytes, row-major.
 */
export function modelViews(src) {
    const W = src.width, H = src.height, s = Math.min(W, H), r = W / H;
    const rects = [[0, 0, W, H]];
    if (r > 1.1 || r < 0.9) rects.push([(W - s) / 2, (H - s) / 2, s, s]);
    if (r > 1.25) rects.push([0, 0, s, s], [W - s, 0, s, s]);
    else if (r < 0.8) rects.push([0, 0, s, s], [0, H - s, s, s]);
    rects.push([W / 4, H / 4, W / 2, H / 2]);
    return rects.map(rc => modelPixels(src, rc));
}

/** One view: the rectangle [x, y, w, h] of `src` (all of it by default) squashed to 224x224 RGB. */
export function modelPixels(src, rc = [0, 0, src.width, src.height]) {
    const cv = new OffscreenCanvas(MODEL_SIDE, MODEL_SIDE);
    const cx = cv.getContext('2d', { willReadFrequently: true });
    cx.imageSmoothingEnabled = true;
    cx.imageSmoothingQuality = 'high';
    cx.drawImage(src, rc[0], rc[1], rc[2], rc[3], 0, 0, MODEL_SIDE, MODEL_SIDE);
    const d = cx.getImageData(0, 0, MODEL_SIDE, MODEL_SIDE).data;
    const out = new Uint8Array(MODEL_SIDE * MODEL_SIDE * 3);
    for (let i = 0, j = 0; i < d.length; i += 4, j += 3) { out[j] = d[i]; out[j + 1] = d[i + 1]; out[j + 2] = d[i + 2]; }
    return out;
}

/** Model views of an image already in the brief (its stored copy, a data: URL). */
export async function pixelsFromDataUrl(url) {
    const bytes = bytesFromDataUrl(url);
    if (!bytes) return null;
    const m = /^data:([^;,]+)/.exec(url);
    const bmp = await createImageBitmap(new Blob([bytes], { type: m ? m[1] : 'image/webp' }));
    try { return modelViews(bmp); } finally { bmp.close(); }
}

/** The stored image back to bytes (a data: URL from the brief), e.g. to undo a removal. */
export function bytesFromDataUrl(url) {
    const i = String(url || '').indexOf(',');
    if (i < 0) return null;
    const bin = atob(url.slice(i + 1));
    const out = new Uint8Array(bin.length);
    for (let k = 0; k < bin.length; k++) out[k] = bin.charCodeAt(k);
    return out;
}

/** 4 or 5 colors (hex) from an image source, most present first. */
export function paletteOf(src, count = 5) {
    const cv = new OffscreenCanvas(SAMPLE, SAMPLE);
    const cx = cv.getContext('2d', { willReadFrequently: true });
    cx.drawImage(src, 0, 0, SAMPLE, SAMPLE);
    const d = cx.getImageData(0, 0, SAMPLE, SAMPLE).data;
    const px = [];
    for (let i = 0; i < d.length; i += 4) if (d[i + 3] >= 128) px.push(d[i], d[i + 1], d[i + 2]);
    return paletteFromPixels(Float32Array.from(px), count);
}

/**
 * k-means over RGB pixels (flat array), deterministic: maximin seeding from the
 * pixel nearest the mean, then Lloyd iterations. Clusters are ranked by size
 * (colorful ones weigh a little more), softened into colors that read well on
 * the dark UI (they may become the vault or a collection color) and deduplicated.
 */
export function paletteFromPixels(px, count = 5, k = 7, iters = 12) {
    const n = Math.floor(px.length / 3);
    if (!n) return [];
    k = Math.min(k, n);
    const d2 = (i, r, g, b) => { const x = px[i * 3] - r, y = px[i * 3 + 1] - g, z = px[i * 3 + 2] - b; return x * x + y * y + z * z; };
    const C = new Float64Array(k * 3);
    let mr = 0, mg = 0, mb = 0;
    for (let i = 0; i < n; i++) { mr += px[i * 3]; mg += px[i * 3 + 1]; mb += px[i * 3 + 2]; }
    mr /= n; mg /= n; mb /= n;
    let first = 0, fd = Infinity;
    for (let i = 0; i < n; i++) { const d = d2(i, mr, mg, mb); if (d < fd) { fd = d; first = i; } }
    C[0] = px[first * 3]; C[1] = px[first * 3 + 1]; C[2] = px[first * 3 + 2];
    const minD = new Float64Array(n).fill(Infinity);
    for (let c = 1; c < k; c++) {
        let far = -1, farD = 0;
        for (let i = 0; i < n; i++) {
            const d = d2(i, C[(c - 1) * 3], C[(c - 1) * 3 + 1], C[(c - 1) * 3 + 2]);
            if (d < minD[i]) minD[i] = d;
            if (minD[i] > farD) { farD = minD[i]; far = i; }
        }
        if (far < 0) { k = c; break; }                       // fewer distinct colors than k
        C[c * 3] = px[far * 3]; C[c * 3 + 1] = px[far * 3 + 1]; C[c * 3 + 2] = px[far * 3 + 2];
    }
    const assign = new Int32Array(n).fill(-1);
    const sum = new Float64Array(k * 3), cnt = new Int32Array(k);
    for (let it = 0; it < iters; it++) {
        sum.fill(0); cnt.fill(0);
        let moved = 0;
        for (let i = 0; i < n; i++) {
            let bi = 0, bv = Infinity;
            for (let c = 0; c < k; c++) { const d = d2(i, C[c * 3], C[c * 3 + 1], C[c * 3 + 2]); if (d < bv) { bv = d; bi = c; } }
            if (assign[i] !== bi) { moved++; assign[i] = bi; }
            cnt[bi]++; sum[bi * 3] += px[i * 3]; sum[bi * 3 + 1] += px[i * 3 + 1]; sum[bi * 3 + 2] += px[i * 3 + 2];
        }
        for (let c = 0; c < k; c++) if (cnt[c]) { C[c * 3] = sum[c * 3] / cnt[c]; C[c * 3 + 1] = sum[c * 3 + 1] / cnt[c]; C[c * 3 + 2] = sum[c * 3 + 2] / cnt[c]; }
        if (!moved) break;
    }
    const minCount = Math.max(2, n * 0.008);
    const clusters = [];
    for (let c = 0; c < k; c++) {
        if (cnt[c] < minCount) continue;
        const hsl = rgbToHsl(C[c * 3], C[c * 3 + 1], C[c * 3 + 2]);
        clusters.push({ ...hsl, w: cnt[c] * (0.35 + Math.min(1, hsl.s * 1.6)) });
    }
    clusters.sort((a, b) => b.w - a.w);
    const out = [];
    for (const c of clusters) {
        const hex = soften(c);
        if (out.some(o => near(o, hex))) continue;
        out.push(hex);
        if (out.length >= count) break;
    }
    return out;
}

// Neutrals stay neutral; colors keep their hue but land in a readable range.
function soften({ h, s, l }) {
    if (s < 0.1) return hslToHex(h, s * 0.5, clamp(l, 0.55, 0.74));
    return hslToHex(h, clamp(s, 0.26, 0.6), clamp(l, 0.52, 0.68));
}

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

function near(a, b) {
    const x = parseInt(a.slice(1), 16), y = parseInt(b.slice(1), 16);
    const dr = (x >> 16) - (y >> 16), dg = ((x >> 8) & 255) - ((y >> 8) & 255), db = (x & 255) - (y & 255);
    return dr * dr + dg * dg + db * db < 26 * 26;
}

function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
    if (!d) return { h: 0, s: 0, l };
    const s = d / (1 - Math.abs(2 * l - 1));
    let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h = (h * 60 + 360) % 360;
    return { h, s: Math.min(1, s), l };
}

function hslToHex(h, s, l) {
    const a = s * Math.min(l, 1 - l);
    const f = n => { const k = (n + h / 30) % 12; const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); return Math.round(c * 255).toString(16).padStart(2, '0'); };
    return '#' + f(0) + f(8) + f(4);
}
