'use strict';
/**
 * Builds the app icon from the SoundVault vault mark (the chest of
 * src/renderer/js/ui/logo.js), rendered by Chromium for perfect anti-aliasing:
 *   build/icon.ico, 16, 20, 24, 32, 40, 48, 64, 128, 256 px (PNG frames)
 *   build/icon.png, 512 px (Linux / docs)
 * The chest IS the icon: a full-bleed solid silhouette on a transparent canvas
 * (no backing tile). The mark's outline becomes a fine light rim around a dark
 * body, with the lid seam, the lid waveform and the lime lock plate inside. A
 * faint dark keyline keeps the edge visible on light taskbars and wallpapers.
 * 128 px and up scale the mark into a box 240/256 of the canvas wide; the 16 to
 * 64 px frames are drawn on the pixel grid by hand so they stay crisp (16 px:
 * 3 one-pixel bars; 16 and 20 px: 1 px keyhole slot, relatively bigger lock).
 * Rim and seam per frame: 1 px up to 24 px, 2 px at 32 to 48, 3 px at 64,
 * 1.4/26 of the chest width above (6.5 px at 128, 12.9 px at 256).
 *
 *   npx electron scripts/make-icon.js
 */
const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '..', 'build');
const SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const RIM = ['#f4f3ee', '#c9c7bf'];     // rim, seam and bars: top-lit light
const BODY = ['#2b2b33', '#131316'];    // chest body (and the gap ring around the lock)
const ACCENT = '#c8f76d', PLATE = ['#d3fa82', '#bff063'], INK = '#16161a';

// The mark in its own units, relative to the chest's outer top-left corner:
// logo.js draws rect 4.15,4.65 23.7x22.7 rx5.2 stroked 2.3, so the outer box is
// 26x25 with r6.35; seam, bars, plate and keyhole below share that origin.
// The icon's rim and lid seam are finer than the logo's stroke (1.4 instead of
// 2.3, about 60%): same silhouette, the dark body takes the space the rim gives up.
const MARK = {
    w: 26, h: 25, r: 6.35, rim: 1.4, seam: [15.2, 16.6],
    bars: [[6.2, 6.8, 1.9, 2.4], [9.3, 5.5, 1.9, 5.0], [12.05, 4.3, 1.9, 7.4], [15.1, 6.0, 1.9, 4.0], [18.2, 7.1, 1.9, 1.8]],
    plate: [9.8, 12.8, 6.4, 7.2], plateR: 1.8, ring: 0.8,
    hole: { cx: 13, cy: 15.45, r: 1.05, nh: 0.62, ny: 16.3, bh: 0.94, by: 18.25 },
};

const n = v => +(+v).toFixed(3);

// Classic keyhole: round top (centre cx,cy radius r) opening into a slot whose
// half-width goes from nh at y=ny (on the circle) to bh at y=by.
function keyhole({ cx, cy, r, nh, ny, bh, by }) {
    return `M${n(cx)} ${n(cy - r)}A${n(r)} ${n(r)} 0 0 1 ${n(cx + nh)} ${n(ny)}L${n(cx + bh)} ${n(by)}`
        + `H${n(cx - bh)}L${n(cx - nh)} ${n(ny)}A${n(r)} ${n(r)} 0 0 1 ${n(cx)} ${n(cy - r)}Z`;
}

// Small frames drawn on the pixel grid (px, edges): box = chest outer edge
// [x0,y0,x1,y1], bars/plate = [x0,y0,x1,y1(,rx)]. Odd chest widths where 1 or
// 3 px features must sit on the centre line, even ones for 2 or 4 px bars.
const PIXEL = {
    16: { box: [0, 1, 15, 15], r: 3.5, rim: 1, seam: [9, 10],                  // 15x14, 3 bars
        bars: [[5, 4, 6, 6, 0], [7, 3, 8, 7, 0], [9, 4, 10, 6, 0]],
        plate: [5, 8, 10, 13], plateR: 1, ring: 1, hole: 'M7 9.5h1v2.5h-1z' },
    20: { box: [0, 1, 19, 19], r: 4.5, rim: 1, seam: [12, 13],                 // 19x18, 1 px bars
        bars: [[5, 6, 6, 7, 0], [7, 5, 8, 8, 0], [9, 4, 10, 9, 0], [11, 5, 12, 8, 0], [13, 6, 14, 7, 0]],
        plate: [7, 10, 12, 16], plateR: 1.2, ring: 1, hole: 'M9 11.5h1v3h-1z' },
    24: { box: [1, 1, 23, 22], r: 5.5, rim: 1, seam: [14, 15],                 // 22x21, 2 px bars
        bars: [[5, 7, 7, 9, 1], [8, 6, 10, 10, 1], [11, 5, 13, 11, 1], [14, 6, 16, 10, 1], [17, 7, 19, 9, 1]],
        plate: [9, 12, 15, 18], plateR: 1.5, ring: 1, hole: keyhole({ cx: 12, cy: 14.2, r: 1, nh: 0.55, ny: 15.04, bh: 0.9, by: 16.6 }) },
    32: { box: [1, 1, 31, 30], r: 7, rim: 2, seam: [18, 20],                   // 30x29
        bars: [[9, 9, 11, 11, 1], [12, 7, 14, 13, 1], [15, 6, 17, 14, 1], [18, 8, 20, 12, 1], [21, 9, 23, 11, 1]],
        plate: [12, 16, 20, 24], plateR: 2, ring: 1, hole: keyhole({ cx: 16, cy: 19, r: 1.5, nh: 0.8, ny: 20.27, bh: 1, by: 22 }) },
    40: { box: [1, 2, 38, 38], r: 9, rim: 2, seam: [24, 26],                   // 37x36, 3 px bars
        bars: [[8, 11, 11, 15, 1.5], [13, 9, 16, 17, 1.5], [18, 8, 21, 18, 1.5], [23, 10, 26, 16, 1.5], [28, 12, 31, 14, 1]],
        plate: [15, 20, 24, 30], plateR: 2.5, ring: 1, hole: keyhole({ cx: 19.5, cy: 24, r: 1.5, nh: 0.9, ny: 25.2, bh: 1.35, by: 28 }) },
    48: { box: [1, 2, 46, 45], r: 11, rim: 2, seam: [28, 30],                  // 45x43, 3 px bars
        bars: [[12, 13, 15, 18, 1.5], [17, 11, 20, 20, 1.5], [22, 9, 25, 22, 1.5], [27, 12, 30, 19, 1.5], [32, 14, 35, 17, 1.5]],
        plate: [18, 24, 29, 36], plateR: 3, ring: 1.5, hole: keyhole({ cx: 23.5, cy: 28.6, r: 1.8, nh: 1.05, ny: 30.06, bh: 1.6, by: 33.4 }) },
    64: { box: [2, 3, 62, 61], r: 14.5, rim: 3, seam: [39, 42],                // 60x58, 4 px bars
        bars: [[16, 19, 20, 25, 2], [23, 16, 27, 28, 2], [30, 13, 34, 31, 2], [37, 17, 41, 27, 2], [44, 20, 48, 24, 2]],
        plate: [25, 33, 39, 50], plateR: 4, ring: 2, hole: keyhole({ cx: 32, cy: 39, r: 2.5, nh: 1.45, ny: 41.04, bh: 2.1, by: 45.5 }) },
};

// 128 px and up: the mark scaled into a centred box 240/256 of the canvas wide.
function geometry(size) {
    if (PIXEL[size]) return PIXEL[size];
    const k = size * 240 / 256 / MARK.w, x0 = (size - MARK.w * k) / 2, y0 = (size - MARK.h * k) / 2;
    const X = u => x0 + u * k, Y = u => y0 + u * k, h = MARK.hole, [px, py, pw, ph] = MARK.plate;
    return {
        box: [x0, y0, X(MARK.w), Y(MARK.h)], r: MARK.r * k, rim: MARK.rim * k, seam: MARK.seam.map(Y),
        bars: MARK.bars.map(([x, y, w, hh]) => [X(x), Y(y), X(x + w), Y(y + hh), w * k / 2]),
        plate: [X(px), Y(py), X(px + pw), Y(py + ph)], plateR: MARK.plateR * k, ring: MARK.ring * k,
        hole: keyhole({ cx: X(h.cx), cy: Y(h.cy), r: h.r * k, nh: h.nh * k, ny: Y(h.ny), bh: h.bh * k, by: Y(h.by) }),
    };
}

function svgFor(size) {
    const g = geometry(size);
    const [x0, y0, x1, y1] = g.box, [p0, q0, p1, q1] = g.plate, t = g.rim, e = g.ring;
    const rect = (a, b, c, d, r, fill) => `<rect x="${n(a)}" y="${n(b)}" width="${n(c - a)}" height="${n(d - b)}" rx="${n(Math.max(0, r))}" fill="${fill}"/>`;
    const grad = (id, [c0, c1], ya, yb) => `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="0" y1="${n(ya)}" x2="0" y2="${n(yb)}">`
        + `<stop offset="0" stop-color="${c0}"/><stop offset="1" stop-color="${c1}"/></linearGradient>`;
    const plateFill = size >= 40 ? 'url(#plate)' : ACCENT;
    const kw = size <= 128 ? 1 : size / 128;            // keyline width
    // The keyline sits on the rim's outer pixel. On 1 to 2 px rims it is kept
    // light so the rim stays bright on dark taskbars; wider rims take 20%.
    const ka = g.rim <= 2 ? 0.12 : 0.2;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">`
        + `<defs>${grad('rim', RIM, y0, y1)}${grad('body', BODY, y0, y1)}${size >= 40 ? grad('plate', PLATE, q0, q1) : ''}</defs>`
        + rect(x0, y0, x1, y1, g.r, 'url(#rim)')                                   // silhouette = rim
        + rect(x0 + t, y0 + t, x1 - t, y1 - t, g.r - t, 'url(#body)')             // dark body
        + rect(x0 + t - 0.5, g.seam[0], x1 - t + 0.5, g.seam[1], 0, 'url(#rim)')  // lid seam
        + g.bars.map(([a, b, c, d, r]) => rect(a, b, c, d, r, 'url(#rim)')).join('')
        + rect(p0 - e, q0 - e, p1 + e, q1 + e, g.plateR + e, 'url(#body)')        // gap ring cuts the seam
        + rect(p0, q0, p1, q1, g.plateR, plateFill)
        + `<path d="${g.hole}" fill="${INK}"/>`
        + `<rect x="${n(x0 + kw / 2)}" y="${n(y0 + kw / 2)}" width="${n(x1 - x0 - kw)}" height="${n(y1 - y0 - kw)}" rx="${n(g.r - kw / 2)}"`
        + ` fill="none" stroke="rgba(0,0,0,${ka})" stroke-width="${n(kw)}"/>`
        + '</svg>';
}

function buildIco(frames) {
    // ICONDIR + ICONDIRENTRY[] + PNG payloads (PNG-compressed entries, Vista+)
    const header = Buffer.alloc(6);
    header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(frames.length, 4);
    const dir = Buffer.alloc(16 * frames.length);
    let offset = 6 + dir.length;
    frames.forEach(({ size, png }, i) => {
        const o = i * 16;
        dir.writeUInt8(size >= 256 ? 0 : size, o);
        dir.writeUInt8(size >= 256 ? 0 : size, o + 1);
        dir.writeUInt8(0, o + 2); dir.writeUInt8(0, o + 3);
        dir.writeUInt16LE(1, o + 4); dir.writeUInt16LE(32, o + 6);
        dir.writeUInt32LE(png.length, o + 8); dir.writeUInt32LE(offset, o + 12);
        offset += png.length;
    });
    return Buffer.concat([header, dir, ...frames.map(f => f.png)]);
}

async function main() {
    const { app, BrowserWindow } = require('electron');
    setTimeout(() => { console.error('make-icon: timed out'); app.exit(2); }, 60000).unref();
    await app.whenReady();
    const win = new BrowserWindow({ show: false, width: 600, height: 600 });
    await win.loadURL('about:blank');
    const render = async size => {
        const svg = svgFor(size);
        const dataUrl = await win.webContents.executeJavaScript(`new Promise((res, rej) => {
            const img = new Image();
            img.onload = () => { const c = document.createElement('canvas'); c.width = ${size}; c.height = ${size};
                const x = c.getContext('2d'); x.imageSmoothingQuality = 'high'; x.drawImage(img, 0, 0, ${size}, ${size}); res(c.toDataURL('image/png')); };
            img.onerror = rej;
            img.src = 'data:image/svg+xml;base64,' + ${JSON.stringify(Buffer.from(svg).toString('base64'))};
        })`);
        return Buffer.from(dataUrl.split(',')[1], 'base64');
    };
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const frames = [];
    for (const size of SIZES) frames.push({ size, png: await render(size) });
    // Largest frame first (convention; some shells read only the first entry).
    fs.writeFileSync(path.join(OUT_DIR, 'icon.ico'), buildIco(frames.slice().sort((a, b) => b.size - a.size)));
    fs.writeFileSync(path.join(OUT_DIR, 'icon.png'), await render(512));
    console.log(`icon.ico (${SIZES.join(', ')} px) + icon.png (512 px) → ${OUT_DIR}`);
    app.quit();
}

// Under Electron the entry script is NOT require.main, so detect the runtime.
if (process.versions.electron && process.type === 'browser') {
    main().catch(e => { console.error(e); process.exit(1); });
}

module.exports = { svgFor, buildIco, SIZES };
