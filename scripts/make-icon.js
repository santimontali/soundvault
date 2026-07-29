'use strict';

/**
 * Generates build/icon.ico for electron-builder.
 *
 * Pure Node (no dependencies): renders a 256x256 RGBA PNG in memory
 * (dark rounded square + green soundwave, matching the app theme) using the
 * same hand-rolled PNG writer as src/main.js::createDragIcon, then wraps the
 * PNG in an ICO container (Windows Vista+ supports PNG-compressed frames).
 *
 * Run: node scripts/make-icon.js
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 256;
const BG = [0x1a, 0x1a, 0x1e, 0xff];       // #1a1a1e (window bg)
const FG = [0xc8, 0xf7, 0x6d, 0xff];       // #c8f76d (accent green)
const RADIUS = 48;                          // rounded-corner radius (px)

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

function inRoundedSquare(x, y, size, r) {
    const inset = 0;
    if (x < inset || x >= size - inset || y < inset || y >= size - inset) return false;
    // Corner circles
    const corners = [[inset + r, inset + r], [size - inset - r, inset + r],
                     [inset + r, size - inset - r], [size - inset - r, size - inset - r]];
    for (const [cx, cy] of corners) {
        const inCornerX = (cx === inset + r) ? x < cx : x >= cx;
        const inCornerY = (cy === inset + r) ? y < cy : y >= cy;
        if (inCornerX && inCornerY) {
            const dx = x - cx, dy = y - cy;
            if (dx * dx + dy * dy > r * r) return false;
        }
    }
    return true;
}

// Soundwave bar heights (deterministic pseudo-random-ish pattern)
function barHeight(i, n) {
    const t = i / (n - 1);
    // Envelope: rise to center, fall — looks like a waveform
    const env = Math.sin(Math.PI * t);
    const wobble = 0.55 + 0.45 * Math.abs(Math.sin(i * 1.7));
    return 0.15 + 0.75 * env * wobble;
}

function renderPng(size) {
    const raw = Buffer.alloc(size * (1 + size * 4));
    const bars = 9;
    const barW = 12, gap = 14;
    const totalW = bars * barW + (bars - 1) * gap;
    const x0 = Math.floor((size - totalW) / 2);
    const cy = size / 2;

    for (let y = 0; y < size; y++) {
        const rowOff = y * (1 + size * 4);
        raw[rowOff] = 0; // filter: None
        for (let x = 0; x < size; x++) {
            const px = rowOff + 1 + x * 4;
            let col = [0, 0, 0, 0]; // transparent outside
            if (inRoundedSquare(x, y, size, RADIUS)) {
                col = BG;
                // Soundwave bars
                for (let b = 0; b < bars; b++) {
                    const bx = x0 + b * (barW + gap);
                    if (x >= bx && x < bx + barW) {
                        const h = barHeight(b, bars) * size * 0.62;
                        const y0 = cy - h / 2, y1 = cy + h / 2;
                        if (y >= y0 && y < y1) col = FG;
                    }
                }
            }
            raw[px] = col[0]; raw[px + 1] = col[1]; raw[px + 2] = col[2]; raw[px + 3] = col[3];
        }
    }

    const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
    ihdr.writeUInt8(8, 8);   // bit depth
    ihdr.writeUInt8(6, 9);   // color type RGBA
    ihdr.writeUInt8(0, 10);  // compression
    ihdr.writeUInt8(0, 11);  // filter
    ihdr.writeUInt8(0, 12);  // interlace
    const idat = zlib.deflateSync(raw, { level: 9 });
    return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
}

function pngToIco(png) {
    const header = Buffer.alloc(6);
    header.writeUInt16LE(0, 0);      // reserved
    header.writeUInt16LE(1, 2);      // type: ICO
    header.writeUInt16LE(1, 4);      // count: 1

    const entry = Buffer.alloc(16);
    entry.writeUInt8(0, 0);          // width  0 = 256
    entry.writeUInt8(0, 1);          // height 0 = 256
    entry.writeUInt8(0, 2);          // colors (0 = >256)
    entry.writeUInt8(0, 3);          // reserved
    entry.writeUInt16LE(1, 4);       // planes
    entry.writeUInt16LE(32, 6);      // bit count
    entry.writeUInt32LE(png.length, 8);      // image size
    entry.writeUInt32LE(6 + 16, 12);         // data offset

    return Buffer.concat([header, entry, png]);
}

const outDir = path.join(__dirname, '..', 'build');
fs.mkdirSync(outDir, { recursive: true });
const png = renderPng(SIZE);
const ico = pngToIco(png);
const out = path.join(outDir, 'icon.ico');
fs.writeFileSync(out, ico);
console.log(`[make-icon] wrote ${out} (${ico.length} bytes, PNG frame ${png.length} bytes)`);
