'use strict';
/**
 * Deterministic synthetic sound library for tests, audits and E2E runs.
 *
 *   node tests/fixtures/make-library.js <outDir> [--long] [--families N]
 *
 * Produces WAV edge cases (PCM16/24/32, float32, EXTENSIBLE, 8-bit, big
 * metadata chunks before `data`, odd-sized chunks, truncated / zero-length
 * data, bogus headers), a wide duration range (5 ms → 3 min; 10 min with
 * --long), awkward-but-legal Windows file names, deep nesting, ignored
 * non-WAV files, and "families" of near-duplicates (gain / pitch / noise /
 * crop variants) so similarity search can be scored objectively.
 *
 * A manifest.json describing every file (and the family ground truth) is
 * written to <outDir>/manifest.json.
 */
const fs = require('fs');
const path = require('path');

// ── Deterministic RNG (mulberry32) ─────────────────────────────────────
function rng(seed) {
    let a = seed >>> 0;
    return () => {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// ── Signal generators (mono Float32, [-1, 1]) ──────────────────────────
const gen = {
    sine(sr, dur, f, amp = 0.8) {
        const n = Math.max(1, Math.round(sr * dur)), o = new Float32Array(n);
        for (let i = 0; i < n; i++) o[i] = amp * Math.sin(2 * Math.PI * f * i / sr);
        return o;
    },
    noise(sr, dur, amp, r) {
        const n = Math.max(1, Math.round(sr * dur)), o = new Float32Array(n);
        for (let i = 0; i < n; i++) o[i] = amp * (r() * 2 - 1);
        return o;
    },
    // Percussive "kick": pitch-dropping sine with exponential decay + click
    kick(sr, dur, f0, f1, decay, r) {
        const n = Math.max(1, Math.round(sr * dur)), o = new Float32Array(n);
        let ph = 0;
        for (let i = 0; i < n; i++) {
            const t = i / sr;
            const f = f1 + (f0 - f1) * Math.exp(-t * 30);
            ph += 2 * Math.PI * f / sr;
            o[i] = Math.exp(-t * decay) * Math.sin(ph) * 0.9 + (i < sr * 0.003 ? (r() * 2 - 1) * 0.5 : 0);
        }
        return o;
    },
    // Metallic hit: inharmonic partials with different decays
    metal(sr, dur, base, r) {
        const n = Math.max(1, Math.round(sr * dur)), o = new Float32Array(n);
        const ratios = [1, 2.76, 5.4, 8.93, 13.34];
        for (let i = 0; i < n; i++) {
            const t = i / sr;
            let s = 0;
            for (let k = 0; k < ratios.length; k++) s += Math.exp(-t * (3 + k * 2)) * Math.sin(2 * Math.PI * base * ratios[k] * t) / (k + 1);
            o[i] = 0.5 * s + (i < sr * 0.002 ? (r() * 2 - 1) * 0.3 : 0);
        }
        return o;
    },
    // Whoosh: noise through a sweeping one-pole low-pass, bell envelope
    whoosh(sr, dur, r) {
        const n = Math.max(1, Math.round(sr * dur)), o = new Float32Array(n);
        let y = 0;
        for (let i = 0; i < n; i++) {
            const t = i / n;
            const env = Math.sin(Math.PI * t) ** 2;
            const a = 0.02 + 0.3 * env;
            y += a * ((r() * 2 - 1) - y);
            o[i] = y * env * 2.2;
        }
        return o;
    },
    // Rain-ish ambience: sparse random clicks over soft noise
    rain(sr, dur, r) {
        const n = Math.max(1, Math.round(sr * dur)), o = new Float32Array(n);
        let y = 0;
        for (let i = 0; i < n; i++) {
            y += 0.1 * ((r() * 2 - 1) - y);
            o[i] = y * 0.15 + (r() < 0.0008 ? (r() * 2 - 1) * 0.7 : 0);
        }
        return o;
    },
    chirp(sr, dur, f0, f1) {
        const n = Math.max(1, Math.round(sr * dur)), o = new Float32Array(n);
        let ph = 0;
        for (let i = 0; i < n; i++) {
            const f = f0 * Math.pow(f1 / f0, i / n);
            ph += 2 * Math.PI * f / sr;
            o[i] = 0.7 * Math.sin(ph);
        }
        return o;
    },
    click(sr, dur) {
        const n = Math.max(1, Math.round(sr * dur)), o = new Float32Array(n);
        for (let i = 0; i < Math.min(n, 24); i++) o[i] = (i % 2 ? -1 : 1) * 0.9 * (1 - i / 24);
        return o;
    },
    silence(sr, dur) { return new Float32Array(Math.max(1, Math.round(sr * dur))); },
};

// Variants used to build near-duplicate families
const fx = {
    gain(x, db) { const g = Math.pow(10, db / 20); return x.map(v => Math.max(-1, Math.min(1, v * g))); },
    addNoise(x, amp, r) { return x.map(v => Math.max(-1, Math.min(1, v + amp * (r() * 2 - 1)))); },
    // Varispeed by linear resampling (pitch + duration change together)
    varispeed(x, semis) {
        const rate = Math.pow(2, semis / 12), n = Math.max(1, Math.floor(x.length / rate)), o = new Float32Array(n);
        for (let i = 0; i < n; i++) {
            const s = i * rate, i0 = Math.floor(s), fr = s - i0, i1 = Math.min(i0 + 1, x.length - 1);
            o[i] = x[i0] * (1 - fr) + x[i1] * fr;
        }
        return o;
    },
    padFront(x, sr, secs) { const o = new Float32Array(x.length + Math.round(sr * secs)); o.set(x, Math.round(sr * secs)); return o; },
    concat(...xs) { const n = xs.reduce((a, b) => a + b.length, 0), o = new Float32Array(n); let off = 0; for (const x of xs) { o.set(x, off); off += x.length; } return o; },
    fadeOut(x, frac) { const n = x.length, s = Math.floor(n * (1 - frac)); const o = Float32Array.from(x); for (let i = s; i < n; i++) o[i] *= (n - i) / (n - s); return o; },
};

// ── WAV writer with optional extra chunks / quirks ─────────────────────
function chunk(id, body) {
    const pad = body.length % 2;
    const b = Buffer.alloc(8 + body.length + pad);
    b.write(id, 0, 'ascii');
    b.writeUInt32LE(body.length, 4);
    body.copy(b, 8);
    return b;
}

function encodePCM(channels, bits, float) {
    const nc = channels.length, n = channels[0].length, bps = bits / 8;
    const buf = Buffer.alloc(n * nc * bps);
    let off = 0;
    for (let i = 0; i < n; i++) {
        for (let c = 0; c < nc; c++) {
            const s = Math.max(-1, Math.min(1, channels[c][i]));
            if (float && bits === 32) { buf.writeFloatLE(s, off); }
            else if (bits === 8) { buf.writeUInt8(Math.round((s + 1) * 127.5), off); }
            else if (bits === 16) { buf.writeInt16LE(Math.round(s * 32767), off); }
            else if (bits === 24) { const v = Math.round(s * 8388607); buf.writeIntLE(v, off, 3); }
            else if (bits === 32) { buf.writeInt32LE(Math.round(s * 2147483647), off); }
            off += bps;
        }
    }
    return buf;
}

/**
 * @param {object} o
 * @param {Float32Array[]} o.channels
 * @param {number} o.sr
 * @param {number} [o.bits=16]
 * @param {boolean} [o.float=false]
 * @param {boolean} [o.extensible=false]
 * @param {Array<[string, Buffer]>} [o.before] extra chunks before `fmt `
 * @param {Array<[string, Buffer]>} [o.between] extra chunks between `fmt ` and `data`
 * @param {Array<[string, Buffer]>} [o.after] extra chunks after `data`
 * @param {'none'|'truncate'|'zero-data'|'ffff-size'|'bad-riff'} [o.quirk]
 */
function makeWav(o) {
    const bits = o.bits || 16, float = !!o.float, nc = o.channels.length;
    const bps = bits / 8;
    const fmtTag = float ? 3 : 1;
    let fmt;
    if (o.extensible) {
        fmt = Buffer.alloc(40);
        fmt.writeUInt16LE(0xFFFE, 0);
        fmt.writeUInt16LE(nc, 2);
        fmt.writeUInt32LE(o.sr, 4);
        fmt.writeUInt32LE(o.sr * nc * bps, 8);
        fmt.writeUInt16LE(nc * bps, 12);
        fmt.writeUInt16LE(bits, 14);
        fmt.writeUInt16LE(22, 16);          // cbSize
        fmt.writeUInt16LE(bits, 18);        // valid bits
        fmt.writeUInt32LE(nc === 2 ? 3 : 4, 20); // channel mask
        // SubFormat GUID: first 2 bytes = format tag, rest = KSDATAFORMAT suffix
        fmt.writeUInt16LE(fmtTag, 24);
        Buffer.from([0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xAA, 0x00, 0x38, 0x9B, 0x71]).copy(fmt, 26);
    } else {
        fmt = Buffer.alloc(16);
        fmt.writeUInt16LE(fmtTag, 0);
        fmt.writeUInt16LE(nc, 2);
        fmt.writeUInt32LE(o.sr, 4);
        fmt.writeUInt32LE(o.sr * nc * bps, 8);
        fmt.writeUInt16LE(nc * bps, 12);
        fmt.writeUInt16LE(bits, 14);
    }
    let pcm = encodePCM(o.channels, bits, float);
    const parts = [];
    for (const [id, body] of (o.before || [])) parts.push(chunk(id, body));
    parts.push(chunk('fmt ', fmt));
    for (const [id, body] of (o.between || [])) parts.push(chunk(id, body));
    let dataChunk;
    if (o.quirk === 'zero-data') dataChunk = chunk('data', Buffer.alloc(0));
    else dataChunk = chunk('data', pcm);
    if (o.quirk === 'ffff-size') dataChunk.writeUInt32LE(0xFFFFFFFF, 4);
    parts.push(dataChunk);
    for (const [id, body] of (o.after || [])) parts.push(chunk(id, body));
    let body = Buffer.concat(parts);
    const riff = Buffer.alloc(12);
    riff.write(o.quirk === 'bad-riff' ? 'RIFX' : 'RIFF', 0, 'ascii');
    riff.writeUInt32LE(4 + body.length, 4);
    riff.write('WAVE', 8, 'ascii');
    let file = Buffer.concat([riff, body]);
    if (o.quirk === 'truncate') file = file.subarray(0, Math.floor(file.length * 0.6));
    return file;
}

function bextChunk(desc) {
    const b = Buffer.alloc(602 + 64);
    b.write(desc.slice(0, 256), 0, 'ascii');
    b.write('SoundVault Fixture', 256, 'ascii');
    b.write('2026-01-01', 320, 'ascii');
    b.write('A=PCM,F=48000,W=24,M=stereo\r\n', 602, 'ascii');
    return b;
}
function ixmlChunk(sizeKB) {
    let s = '<?xml version="1.0" encoding="UTF-8"?><BWFXML><IXML_VERSION>1.61</IXML_VERSION><NOTE>';
    while (s.length < sizeKB * 1024) s += 'fixture metadata padding ';
    return Buffer.from(s + '</NOTE></BWFXML>', 'utf8');
}

// ── Library layout ─────────────────────────────────────────────────────
function build(outDir, opts = {}) {
    const r = rng(1234);
    const files = [];
    const families = {};
    const write = (rel, buf, meta = {}) => {
        const full = path.join(outDir, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, buf);
        files.push({ rel, bytes: buf.length, ...meta });
    };
    const wav = (rel, mono, meta = {}, o = {}) => {
        const sr = o.sr || 48000;
        const channels = o.stereo ? [mono, Float32Array.from(mono, (v, i) => v * 0.9)] : [mono];
        write(rel, makeWav({ channels, sr, bits: o.bits, float: o.float, extensible: o.extensible, before: o.before, between: o.between, after: o.after, quirk: o.quirk }), { sr, durationS: mono.length / sr, ...meta });
    };

    // 1) Formats (same content, different encodings), Tier-2 parser coverage
    const tone = gen.chirp(48000, 1.5, 200, 4000);
    wav('Formats/pcm16_mono_48k.wav', tone, { format: 'pcm16' });
    wav('Formats/pcm16_stereo_44k.wav', gen.chirp(44100, 1.5, 200, 4000), { format: 'pcm16' }, { sr: 44100, stereo: true });
    wav('Formats/pcm24_stereo_96k.wav', gen.chirp(96000, 1.5, 200, 4000), { format: 'pcm24' }, { sr: 96000, bits: 24, stereo: true });
    wav('Formats/pcm24_extensible.wav', tone, { format: 'pcm24-ext' }, { bits: 24, extensible: true, stereo: true });
    wav('Formats/float32.wav', tone, { format: 'f32' }, { bits: 32, float: true });
    wav('Formats/float32_extensible.wav', tone, { format: 'f32-ext' }, { bits: 32, float: true, extensible: true, stereo: true });
    wav('Formats/pcm32_int.wav', tone, { format: 'pcm32' }, { bits: 32 });
    wav('Formats/pcm8_unsigned.wav', tone, { format: 'pcm8' }, { bits: 8 });
    wav('Formats/UPPERCASE_EXT.WAV', tone, { format: 'pcm16' });

    // 2) Metadata chunks (BWF/iXML, JUNK, LIST, odd sizes), chunk walker coverage
    const hit = gen.metal(48000, 2.0, 420, r);
    wav('Metadata/bext_ixml_24kb_before_data.wav', hit, { chunks: 'bext+iXML 24KB' }, { bits: 24, stereo: true, between: [['bext', bextChunk('Metal hit with BWF metadata')], ['iXML', ixmlChunk(24)]] });
    wav('Metadata/junk_8kb_before_fmt.wav', hit, { chunks: 'JUNK 8KB' }, { before: [['JUNK', Buffer.alloc(8192)]] });
    wav('Metadata/odd_sized_chunk_pad.wav', hit, { chunks: 'odd chunk' }, { between: [['abcd', Buffer.from('odd')]] });
    wav('Metadata/list_info_after_data.wav', hit, { chunks: 'LIST after data' }, { after: [['LIST', Buffer.from('INFOISFT\x0a\x00\x00\x00SoundVault')]] });
    wav('Metadata/huge_ixml_200kb.wav', hit, { chunks: 'iXML 200KB' }, { between: [['iXML', ixmlChunk(200)]] });

    // 3) Broken / hostile files, must never crash anything
    wav('Broken/truncated_data.wav', gen.whoosh(48000, 2, r), { broken: 'truncated' }, { quirk: 'truncate' });
    wav('Broken/zero_length_data.wav', gen.whoosh(48000, 1, r), { broken: 'zero-data' }, { quirk: 'zero-data' });
    wav('Broken/data_size_ffffffff.wav', gen.whoosh(48000, 1, r), { broken: 'ffff-size' }, { quirk: 'ffff-size' });
    wav('Broken/rifx_header.wav', gen.whoosh(48000, 1, r), { broken: 'bad-riff' }, { quirk: 'bad-riff' });
    write('Broken/zero_bytes.wav', Buffer.alloc(0), { broken: 'empty-file' });
    write('Broken/text_renamed.wav', Buffer.from('this is not audio\n'), { broken: 'not-wav' });
    write('Broken/notes.txt', Buffer.from('ignored'), { ignored: true });
    write('Broken/song.mp3', Buffer.from('ID3fake'), { ignored: true });
    write('.git/hidden_should_be_ignored.wav', makeWav({ channels: [gen.click(48000, 0.1)], sr: 48000 }), { ignored: true });
    write('node_modules/pkg/ignored.wav', makeWav({ channels: [gen.click(48000, 0.1)], sr: 48000 }), { ignored: true });

    // 4) Durations: very short to long
    const durs = [['005ms', 0.005], ['020ms', 0.02], ['050ms', 0.05], ['120ms', 0.12], ['300ms', 0.3], ['800ms', 0.8], ['1s', 1], ['3s', 3], ['9s', 9], ['12s', 12], ['31s', 31], ['75s', 75], ['180s', 180]];
    for (const [label, d] of durs) {
        const sig = d < 1 ? gen.kick(48000, d, 180, 50, 12, r) : gen.rain(48000, d, r);
        wav(`Durations/dur_${label}.wav`, sig, { durationClass: label }, { stereo: d >= 30, bits: d >= 60 ? 24 : 16 });
    }
    if (opts.long) wav('Durations/dur_600s_long.wav', gen.rain(48000, 600, r), { durationClass: '600s' }, { stereo: true, bits: 24 });
    wav('Durations/silence_2s.wav', gen.silence(48000, 2), { silent: true });
    wav('Durations/dc_offset.wav', Float32Array.from(gen.sine(48000, 1, 100, 0.3), v => v + 0.5), { dc: true });
    wav('Durations/clipped_square.wav', Float32Array.from(gen.sine(48000, 1, 220), v => v > 0 ? 1 : -1), { clipped: true });

    // 5) Names: legal on Windows but awkward for HTML/paths/search
    const names = [
        'Foley & Footsteps/steps_gravel & dirt 01.wav',
        "Foley & Footsteps/door creak 'old' #2.wav",
        'Foley & Footsteps/cloth [rustle] (soft) {take 3}.wav',
        'Foley & Footsteps/100% wet splash; big!.wav',
        'Foley & Footsteps/ñandú corriendo \u2014 pasto.wav',  // escaped em dash: real libraries have them
        'Foley & Footsteps/日本語のファイル名.wav',
        'Foley & Footsteps/emoji 🔊 boom.wav',
        'Foley & Footsteps/' + 'very_long_name_'.repeat(12) + 'end.wav',
        'Foley & Footsteps/.leading_dot.wav',
        'Foley & Footsteps/multi.dots.in.name.v2.wav',
        'Foley & Footsteps/kick drum soft.wav',
        'Foley & Footsteps/drum_kick_hard.wav',
    ];
    for (const n of names) wav(n, gen.kick(48000, 0.4, 200, 55, 9, r), { awkwardName: true });
    // Deep nesting
    wav('Deep/a/b/c/d/e/f/g/h/deep_file.wav', gen.click(48000, 0.2), { deep: true });

    // 6) Categories for semantic search sanity (CLAP should separate these)
    const cats = {
        'Impacts/Kicks': i => gen.kick(48000, 0.6, 160 + i * 15, 45 + i * 3, 8 + i, r),
        'Impacts/Metal': i => gen.metal(48000, 1.6, 300 + i * 70, r),
        'Ambiences/Rain': () => gen.rain(48000, 6, r),
        'Whooshes': () => gen.whoosh(48000, 1.2 + r(), r),
        'UI/Clicks': () => gen.click(48000, 0.08),
        'UI/Beeps': i => gen.sine(48000, 0.15, 880 + i * 220, 0.5),
    };
    for (const [folder, fn] of Object.entries(cats)) {
        for (let i = 0; i < 5; i++) {
            const base = folder.split('/').pop().toLowerCase().replace(/s$/, '');
            wav(`${folder}/${base}_${String(i + 1).padStart(2, '0')}.wav`, fn(i), { category: folder });
        }
    }

    // 7) Near-duplicate families: objective ground truth for Echo / similarity
    const nFam = opts.families || 8;
    const makers = [
        () => gen.kick(48000, 0.7, 150 + r() * 60, 40 + r() * 20, 7 + r() * 4, r),
        () => gen.metal(48000, 1.5, 250 + r() * 400, r),
        () => gen.whoosh(48000, 1.5, r),
        () => gen.chirp(48000, 1.0, 100 + r() * 200, 2000 + r() * 4000),
    ];
    for (let f = 0; f < nFam; f++) {
        const src = makers[f % makers.length]();
        const fam = `fam${String(f + 1).padStart(2, '0')}`;
        const variants = {
            [`${fam}_orig`]: src,
            [`${fam}_gain-6`]: fx.gain(src, -6),
            [`${fam}_noise`]: fx.addNoise(src, 0.02, r),
            [`${fam}_pitch+1`]: fx.varispeed(src, 1),
            [`${fam}_padded_in_long`]: fx.concat(gen.rain(48000, 3, r), fx.gain(src, -2), gen.rain(48000, 4, r)),
        };
        families[fam] = [];
        for (const [name, sig] of Object.entries(variants)) {
            const rel = `Families/${fam}/${name}.wav`;
            wav(rel, sig, { family: fam });
            families[fam].push(rel);
        }
    }

    const manifest = { generatedBy: 'tests/fixtures/make-library.js', root: outDir, files, families };
    fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    return manifest;
}

if (require.main === module) {
    const out = process.argv[2];
    if (!out) { console.error('usage: node tests/fixtures/make-library.js <outDir> [--long] [--families N]'); process.exit(1); }
    const fi = process.argv.indexOf('--families');
    const m = build(path.resolve(out), { long: process.argv.includes('--long'), families: fi > 0 ? +process.argv[fi + 1] : undefined });
    const wavs = m.files.filter(f => /\.wav$/i.test(f.rel) && !f.ignored).length;
    console.log(`fixture library → ${m.root}: ${m.files.length} files (${wavs} scannable .wav), ${Object.keys(m.families).length} families`);
}

module.exports = { build, makeWav, gen, fx, rng };
