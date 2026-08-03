const path = require('path');
const { execFileSync } = require('child_process');

const FFMPEG = path.join(__dirname, '..', '..', 'node_modules', 'ffmpeg-static', 'ffmpeg.exe');
const OUT = path.join(__dirname, '..', 'og.png');
const W = 1200, H = 630;

function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

const r = mulberry32(42);
let filter = `color=c=0x111114:s=${W}x${H}:d=1`;

const bars = 48;
const bw = 14, gap = (W - bars * bw) / (bars + 1);
for (let i = 0; i < bars; i++) {
  const amp = 0.25 + 0.75 * Math.abs(Math.sin(i * 0.4 + 1)) * (0.5 + r() * 0.5);
  const bh = Math.round(amp * 300);
  const x = Math.round(gap + i * (bw + gap));
  const y = Math.round((H - bh) / 2) + 40;
  const bright = amp > 0.7 ? '0xc8f76d' : '0x9fbf5a';
  filter += `,drawbox=x=${x}:y=${y}:w=${bw}:h=${bh}:c=${bright}@0.9:t=fill`;
}

filter += `,drawtext=text='SOUNDVAULT':fontfile=C\\:/Windows/Fonts/arialbd.ttf:fontsize=88:fontcolor=0xc8f76d:x=(w-text_w)/2:y=h-190`;
filter += `,drawtext=text='busqueda semantica de sonido - offline':fontfile=C\\:/Windows/Fonts/arial.ttf:fontsize=34:fontcolor=0xe0ddd5:x=(w-text_w)/2:y=h-100`;

execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', filter, '-frames:v', '1', OUT]);
console.log('og.png generado:', OUT);
