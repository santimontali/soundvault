const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const FFMPEG = path.join(__dirname, '..', '..', 'node_modules', 'ffmpeg-static', 'ffmpeg.exe');
const OUT = path.join(__dirname, '..', 'audio');
const SR = 48000;

if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function biquad(type, freq, q) {
  const w0 = 2 * Math.PI * freq / SR;
  const cw = Math.cos(w0), sw = Math.sin(w0);
  const alpha = sw / (2 * (q || 0.707));
  let b0, b1, b2, a0, a1, a2;
  if (type === 'lowpass') {
    b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = (1 - cw) / 2;
    a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
  } else if (type === 'highpass') {
    b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = (1 + cw) / 2;
    a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
  } else {
    b0 = alpha; b1 = 0; b2 = -alpha;
    a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
  }
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  return function (x) {
    const y = (b0 / a0) * x + (b1 / a0) * x1 + (b2 / a0) * x2 - (a1 / a0) * y1 - (a2 / a0) * y2;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    return y;
  };
}

function noiseBuf(n, seed) {
  const r = mulberry32(seed || 1);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = r() * 2 - 1;
  return out;
}

function envADSR(t, dur, a, d, s, r, peak) {
  peak = peak == null ? 1 : peak;
  const rel = dur - r;
  if (t < a) return peak * (t / a);
  if (t < a + d) return peak * (1 - (1 - s) * ((t - a) / d));
  if (t < rel) return peak * s;
  return peak * s * Math.max(0, 1 - (t - rel) / r);
}

function writeWav(file, data, channels) {
  channels = channels || 1;
  const n = data.length;
  const bytes = 44 + n * 2;
  const buf = Buffer.alloc(bytes);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(bytes - 8, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * channels * 2, 28);
  buf.writeUInt16LE(channels * 2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  let off = 44;
  for (let i = 0; i < n; i++) {
    let v = Math.max(-1, Math.min(1, data[i]));
    buf.writeInt16LE(Math.round(v * 32767), off);
    off += 2;
  }
  fs.writeFileSync(file, buf);
}

function toOgg(name, data, channels) {
  const wav = path.join(OUT, name + '.wav');
  const ogg = path.join(OUT, name + '.ogg');
  writeWav(wav, data, channels);
  execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-i', wav, '-c:a', 'libvorbis', '-q:a', '3', ogg]);
  fs.unlinkSync(wav);
  const kb = (fs.statSync(ogg).size / 1024).toFixed(0);
  console.log(`  ${name}.ogg  ${kb} KB  ${(data.length / SR).toFixed(1)}s`);
}

function addScaled(dst, src, gain, offset) {
  offset = offset || 0;
  for (let i = 0; i < src.length; i++) {
    const j = i + offset;
    if (j < dst.length) dst[j] += src[i] * gain;
  }
}

function normalize(data, peak) {
  peak = peak == null ? 0.9 : peak;
  let m = 0;
  for (let i = 0; i < data.length; i++) m = Math.max(m, Math.abs(data[i]));
  if (m > 0.0001) {
    const g = peak / m;
    for (let i = 0; i < data.length; i++) data[i] *= g;
  }
  return data;
}

const S = SR;

function genRain(dur) {
  const n = dur * S;
  const out = new Float32Array(n);
  const lp = biquad('lowpass', 1400, 0.7);
  const hp = biquad('highpass', 3000, 0.7);
  const noise = noiseBuf(n, 7);
  const r = mulberry32(99);
  for (let i = 0; i < n; i++) {
    const t = i / S;
    const drop = Math.sin(2 * Math.PI * 0.5 * t) * 0.3 + 0.7;
    out[i] = lp(noise[i]) * 0.5 * drop + hp(noise[i]) * 0.12;
    if (r() < 0.0008) {
      const len = Math.floor(0.004 * S);
      for (let k = 0; k < len && i + k < n; k++) {
        out[i + k] += (r() * 2 - 1) * (1 - k / len) * 0.5;
      }
    }
  }
  return normalize(out, 0.75);
}

function genThunder(dur) {
  const n = dur * S;
  const out = new Float32Array(n);
  const lp = biquad('lowpass', 400, 0.6);
  const noise = noiseBuf(n, 21);
  const r = mulberry32(5);
  for (let i = 0; i < n; i++) {
    const t = i / S;
    const crack = t < 0.15 ? Math.exp(-t * 18) : 0;
    const rumble = envADSR(t, dur, 0.25, 0.6, 0.5, 2.2, 1) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 1.7 * t + r()));
    const sub = Math.sin(2 * Math.PI * (50 - t * 6) * t) * envADSR(t, dur, 0.05, 0.4, 0.4, 2.0, 0.8);
    out[i] = lp(noise[i]) * rumble * 0.9 + noise[i] * crack * 0.7 + sub * 0.6;
  }
  return normalize(out, 0.88);
}

function genFootsteps(dur) {
  const n = dur * S;
  const out = new Float32Array(n);
  const r = mulberry32(33);
  const steps = 6;
  for (let s = 0; s < steps; s++) {
    const start = Math.floor((0.15 + s * (dur - 0.4) / steps) * S);
    const len = Math.floor(0.16 * S);
    const lp = biquad('lowpass', 900, 0.8);
    const bp = biquad('bandpass', 2200, 1.0);
    const nb = noiseBuf(len, 40 + s);
    for (let i = 0; i < len && start + i < n; i++) {
      const t = i / S;
      const thump = Math.sin(2 * Math.PI * (120 - t * 300) * t) * Math.exp(-t * 30) * 0.9;
      const crunch = bp(nb[i]) * Math.exp(-t * 40) * 0.6 + lp(nb[i]) * Math.exp(-t * 25) * 0.4;
      out[start + i] += thump + crunch;
    }
  }
  return normalize(out, 0.85);
}

function genLaser(dur) {
  const n = dur * S;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / S;
    const f = 2600 * Math.exp(-t * 6) + 200;
    const v = Math.sin(2 * Math.PI * f * t) + 0.4 * Math.sin(4 * Math.PI * f * t);
    out[i] = v * Math.exp(-t * 5) * 0.6;
  }
  return normalize(out, 0.8);
}

function genExplosion(dur) {
  const n = dur * S;
  const out = new Float32Array(n);
  const lp = biquad('lowpass', 2500, 0.5);
  const lp2 = biquad('lowpass', 300, 0.6);
  const noise = noiseBuf(n, 55);
  for (let i = 0; i < n; i++) {
    const t = i / S;
    const boom = Math.sin(2 * Math.PI * (90 * Math.exp(-t * 1.5) + 28) * t) * Math.exp(-t * 1.4) * 1.0;
    const blast = lp(noise[i]) * Math.exp(-t * 2.2) * 0.9;
    const tail = lp2(noise[i]) * envADSR(t, dur, 0.02, 0.3, 0.35, 1.6, 0.7);
    out[i] = boom + blast + tail;
  }
  return normalize(out, 0.9);
}

function genWhoosh(dur) {
  const n = dur * S;
  const out = new Float32Array(n);
  const noise = noiseBuf(n, 66);
  let bp = null;
  for (let i = 0; i < n; i++) {
    const t = i / S;
    const p = t / dur;
    const f = 250 + 3400 * Math.sin(Math.PI * p);
    if (!bp || i % 480 === 0) bp = biquad('bandpass', f, 1.1);
    out[i] = bp(noise[i]) * Math.sin(Math.PI * p) * 1.3;
  }
  return normalize(out, 0.85);
}

function genMetallic(dur) {
  const n = dur * S;
  const out = new Float32Array(n);
  const partials = [2100, 3160, 4730, 6300, 7900];
  const gains = [0.5, 0.36, 0.26, 0.17, 0.1];
  const decays = [1.4, 1.1, 0.9, 0.7, 0.5];
  for (let i = 0; i < n; i++) {
    const t = i / S;
    let v = 0;
    for (let k = 0; k < partials.length; k++) {
      v += Math.sin(2 * Math.PI * partials[k] * t + 3 * Math.sin(2 * Math.PI * 13 * t)) * Math.exp(-t * decays[k] * 3) * gains[k];
    }
    out[i] = v;
  }
  const hp = biquad('highpass', 3000, 0.7);
  const nb = noiseBuf(n, 77);
  for (let i = 0; i < n; i++) out[i] += hp(nb[i]) * Math.exp(-(i / S) * 30) * 0.4;
  return normalize(out, 0.85);
}

function genForest(dur) {
  const n = dur * S;
  const out = new Float32Array(n);
  const lp = biquad('lowpass', 900, 0.7);
  const noise = noiseBuf(n, 88);
  const r = mulberry32(11);
  for (let i = 0; i < n; i++) out[i] = lp(noise[i]) * 0.14;
  let t = 0.3;
  while (t < dur - 0.4) {
    const chirps = 1 + Math.floor(r() * 3);
    for (let c = 0; c < chirps; c++) {
      const st = Math.floor((t + c * 0.13) * S);
      const len = Math.floor(0.14 * S);
      const f0 = 2400 + r() * 1800;
      for (let i = 0; i < len && st + i < n; i++) {
        const tt = i / S;
        const f = f0 * (1 + 0.3 * Math.sin(2 * Math.PI * 14 * tt));
        const v = Math.sin(2 * Math.PI * f * tt) * envADSR(tt, 0.14, 0.02, 0.03, 0.5, 0.06, 0.35);
        out[st + i] += v;
      }
    }
    t += 0.5 + r() * 1.2;
  }
  return normalize(out, 0.7);
}

function genHeartbeat(dur) {
  const n = dur * S;
  const out = new Float32Array(n);
  const period = 0.9;
  for (let beat = 0; beat * period < dur; beat++) {
    [[0, 0.9], [0.22, 0.55]].forEach(([off, amp]) => {
      const st = Math.floor((beat * period + off) * S);
      const len = Math.floor(0.2 * S);
      for (let i = 0; i < len && st + i < n; i++) {
        const t = i / S;
        out[st + i] += Math.sin(2 * Math.PI * (58 - t * 60) * t) * Math.exp(-t * 16) * amp;
      }
    });
  }
  const lp = biquad('lowpass', 150, 0.7);
  for (let i = 0; i < n; i++) out[i] = lp(out[i]) * 1.6;
  return normalize(out, 0.85);
}

function genClick(dur) {
  const n = dur * S;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / S;
    out[i] = (Math.sin(2 * Math.PI * 1500 * t) * 0.6 + Math.sin(2 * Math.PI * 2600 * t) * 0.3) * Math.exp(-t * 60);
  }
  return normalize(out, 0.8);
}

function genWind(dur) {
  const n = dur * S;
  const out = new Float32Array(n);
  const noise = noiseBuf(n, 101);
  let bp = null;
  for (let i = 0; i < n; i++) {
    const t = i / S;
    const f = 320 + 220 * Math.sin(2 * Math.PI * 0.14 * t) + 120 * Math.sin(2 * Math.PI * 0.05 * t + 1);
    if (!bp || i % 480 === 0) bp = biquad('bandpass', Math.max(80, f), 1.4);
    const swell = 0.5 + 0.5 * Math.sin(2 * Math.PI * 0.09 * t + 0.5);
    out[i] = bp(noise[i]) * (0.4 + 0.9 * swell);
  }
  return normalize(out, 0.8);
}

function genFire(dur) {
  const n = dur * S;
  const out = new Float32Array(n);
  const hp = biquad('highpass', 1000, 0.7);
  const noise = noiseBuf(n, 113);
  const r = mulberry32(17);
  for (let i = 0; i < n; i++) out[i] = hp(noise[i]) * 0.16;
  let t = 0.05;
  while (t < dur - 0.1) {
    const st = Math.floor(t * S);
    const len = Math.floor((0.02 + r() * 0.03) * S);
    const amp = 0.3 + r() * 0.5;
    const hp2 = biquad('highpass', 2400, 0.7);
    const nb = noiseBuf(len, Math.floor(r() * 1000) + 1);
    for (let i = 0; i < len && st + i < n; i++) {
      out[st + i] += hp2(nb[i]) * (1 - i / len) * amp;
    }
    t += 0.03 + r() * 0.12;
  }
  return normalize(out, 0.75);
}

console.log('Generating demo audio (48kHz -> OGG Vorbis q3)...');
const jobs = [
  ['rain-tin', () => genRain(6)],
  ['thunder-crack', () => genThunder(5)],
  ['footsteps-gravel', () => genFootsteps(3)],
  ['laser-blast', () => genLaser(1)],
  ['explosion-distant', () => genExplosion(4)],
  ['whoosh-fast', () => genWhoosh(1.5)],
  ['metallic-hit', () => genMetallic(2)],
  ['forest-ambience', () => genForest(6)],
  ['heartbeat-tense', () => genHeartbeat(4)],
  ['ui-click', () => genClick(0.3)],
  ['wind-howl', () => genWind(6)],
  ['fire-crackle', () => genFire(6)],
];
for (const [name, fn] of jobs) toOgg(name, fn(), 1);
console.log('Done.');
