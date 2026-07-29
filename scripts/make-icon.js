'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 256;
const SS = 4;
const BG = [0x18, 0x18, 0x1c, 0xff];
const WHITE = [0xf4, 0xf4, 0xf2, 0xff];
const ACCENT = [0xc8, 0xf7, 0x6d, 0xff];

function crc32(buf) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) {
        crc ^= buf[i];
        for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
    }
    return (crc ^ 0xFFFFFFFF) | 0;
}

function pngChunk(type, data) {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4);
    data.copy(out, 8);
    out.writeInt32BE(crc32(Buffer.concat([Buffer.from(type), data])), 8 + data.length);
    return out;
}

function rrHit(x, y, x0, y0, w, h, r) {
    if (x < x0 || x > x0 + w || y < y0 || y > y0 + h) return false;
    const cx = x < x0 + r ? x0 + r : x > x0 + w - r ? x0 + w - r : x;
    const cy = y < y0 + r ? y0 + r : y > y0 + h - r ? y0 + h - r : y;
    const dx = x - cx, dy = y - cy;
    return dx * dx + dy * dy <= r * r;
}

function rrStroke(x, y, x0, y0, w, h, r, t) {
    return rrHit(x, y, x0, y0, w, h, r) &&
        !rrHit(x, y, x0 + t, y0 + t, w - 2 * t, h - 2 * t, Math.max(0.5, r - t));
}

function capsuleHit(x, y, cx, top, bot, halfW) {
    if (x < cx - halfW || x > cx + halfW) return false;
    const r = halfW;
    if (y < top + r) { const d = y - (top + r); const dx = x - cx; return dx * dx + d * d <= r * r; }
    if (y > bot - r) { const d = y - (bot - r); const dx = x - cx; return dx * dx + d * d <= r * r; }
    return y >= top + r && y <= bot - r;
}

const BARS = [0.30, 0.52, 0.74, 0.92, 1.00, 0.80, 0.58, 0.40, 0.24];

function colorAt(x, y, S) {
    const m = S * 0.085;
    const ox = m, oy = m, ow = S - 2 * m, oh = S - 2 * m;
    const R = S * 0.205;
    const stroke = S * 0.030;

    if (!rrHit(x, y, ox, oy, ow, oh, R)) return null;

    const divY = oy + oh * 0.645;
    const waveTop = oy + stroke + S * 0.055;
    const waveBot = divY - S * 0.035;
    const waveMid = (waveTop + waveBot) / 2;
    const waveH = waveBot - waveTop;

    const n = BARS.length;
    const barW = S * 0.034;
    const gap = (ow - stroke * 2 - S * 0.10 - n * barW) / (n - 1);
    const barsX0 = ox + stroke + S * 0.05;

    const lockW = S * 0.175, lockH = S * 0.135;
    const lockX = (S - lockW) / 2, lockY = divY + S * 0.052;
    const lockR = S * 0.030;
    const shW = S * 0.105, shT = S * 0.026;
    const shX = (S - shW) / 2;
    const shCY = lockY - S * 0.012;
    const shR = shW / 2;
    const shTop = shCY - shR;

    if (rrStroke(x, y, ox, oy, ow, oh, R, stroke)) return WHITE;

    const divT = stroke;
    if (x >= ox + stroke + S * 0.045 && x <= ox + ow - stroke - S * 0.045 &&
        y >= divY - divT / 2 && y <= divY + divT / 2) return WHITE;

    for (let b = 0; b < n; b++) {
        const cx = barsX0 + b * (barW + gap) + barW / 2;
        const h = BARS[b] * waveH;
        if (capsuleHit(x, y, cx, waveMid - h / 2, waveMid + h / 2, barW / 2)) return WHITE;
    }

    const dxC = x - S / 2;
    if (y >= shTop && y <= shCY) {
        const d = Math.sqrt(dxC * dxC + (y - shCY) * (y - shCY));
        if (d <= shR && d >= shR - shT) return ACCENT;
    }
    if (y >= shCY && y <= lockY + S * 0.012) {
        if ((x >= shX && x <= shX + shT) || (x >= shX + shW - shT && x <= shX + shW)) return ACCENT;
    }

    if (rrHit(x, y, lockX, lockY, lockW, lockH, lockR)) {
        const holeR = S * 0.020;
        const holeCY = lockY + lockH * 0.42;
        const slotW = S * 0.012, slotH = S * 0.030;
        const inHole = (dxC * dxC + (y - holeCY) * (y - holeCY)) <= holeR * holeR;
        const inSlot = x >= S / 2 - slotW / 2 && x <= S / 2 + slotW / 2 && y >= holeCY && y <= holeCY + slotH;
        if (inHole || inSlot) return BG;
        return ACCENT;
    }

    return BG;
}

function renderPng(size) {
    const big = size * SS;
    const acc = new Float32Array(big * big * 4);

    for (let by = 0; by < big; by++) {
        for (let bx = 0; bx < big; bx++) {
            const fx = (bx + 0.5) / SS;
            const fy = (by + 0.5) / SS;
            const c = colorAt(fx, fy, size);
            const o = (by * big + bx) * 4;
            if (c) { acc[o] = c[0]; acc[o + 1] = c[1]; acc[o + 2] = c[2]; acc[o + 3] = c[3]; }
        }
    }

    const raw = Buffer.alloc(size * (1 + size * 4));
    for (let y = 0; y < size; y++) {
        const rowOff = y * (1 + size * 4);
        raw[rowOff] = 0;
        for (let x = 0; x < size; x++) {
            let r = 0, g = 0, b = 0, a = 0;
            for (let sy = 0; sy < SS; sy++) {
                for (let sx = 0; sx < SS; sx++) {
                    const o = ((y * SS + sy) * big + (x * SS + sx)) * 4;
                    r += acc[o]; g += acc[o + 1]; b += acc[o + 2]; a += acc[o + 3];
                }
            }
            const n = SS * SS;
            const px = rowOff + 1 + x * 4;
            raw[px] = Math.round(r / n);
            raw[px + 1] = Math.round(g / n);
            raw[px + 2] = Math.round(b / n);
            raw[px + 3] = Math.round(a / n);
        }
    }

    const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
    ihdr.writeUInt8(8, 8);
    ihdr.writeUInt8(6, 9);
    ihdr.writeUInt8(0, 10);
    ihdr.writeUInt8(0, 11);
    ihdr.writeUInt8(0, 12);
    const idat = zlib.deflateSync(raw, { level: 9 });
    return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
}

function pngToIco(png) {
    const header = Buffer.alloc(6);
    header.writeUInt16LE(0, 0);
    header.writeUInt16LE(1, 2);
    header.writeUInt16LE(1, 4);
    const entry = Buffer.alloc(16);
    entry.writeUInt8(0, 0);
    entry.writeUInt8(0, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(6 + 16, 12);
    return Buffer.concat([header, entry, png]);
}

const outDir = path.join(__dirname, '..', 'build');
fs.mkdirSync(outDir, { recursive: true });
const png = renderPng(SIZE);
const ico = pngToIco(png);
const out = path.join(outDir, 'icon.ico');
fs.writeFileSync(out, ico);
console.log(`[make-icon] wrote ${out} (${ico.length} bytes, PNG frame ${png.length} bytes, ${SS}x SSAA)`);
