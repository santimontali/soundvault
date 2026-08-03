const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const FFMPEG = path.join(__dirname, '..', '..', 'node_modules', 'ffmpeg-static', 'ffmpeg.exe');
const LIB = path.join('C:', 'Users', 'santi', 'Documents', 'SoundVault');
const OUT = path.join(__dirname, '..', 'audio');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

const JOBS = [
  { id: 'wood-tap',      src: 'Click\\Click_Wood_Double_Tap.wav', t: 1.2 },
  { id: 'wood-high',     src: 'Click\\Wood High_Foley Wood Block Set On Concrete 01.wav - copia.wav', t: 1.2 },
  { id: 'slab-bell',     src: 'Foundation\\ROCKImpt_IMPACT-Concrete Slab Bar Bell 14KG_B00M_CACK.wav', t: 2.6 },
  { id: 'rocks-dry',     src: 'Foundation\\ROCKImpt_IMPACT PROCESSED DRY-Rocks Multiple_B00M_MOCK.wav', t: 2.6 },
  { id: 'rock-tight',    src: 'Foundation\\ROCKImpt_EARTH RAW-Rock Impact Single Tight_B00M_MOCK.wav', t: 2.6 },
  { id: 'rock-mult',     src: 'Foundation\\ROCKImpt_EARTH RAW-Rock Impact Multiple_B00M_MOCK.wav', t: 2.6 },
  { id: 'metal-boom',    src: 'Foundation\\METLImpt_IMPACT-Metal Wood_B00M_CACK.wav', t: 2.6 },
  { id: 'rock-solid',    src: 'Foundation\\ROCKImpt_MATERIAL STONE-Rock Hit Solid_B00M_CUCK.wav', t: 2.6 },
  { id: 'gravel-drop',   src: 'Foundation\\ROCKMvmt_MATERIAL STONE-Gravel Drop_B00M_CUCK.wav', t: 3.5 },
  { id: 'gravel-scrape', src: 'Foundation\\ROCKMvmt_MATERIAL STONE-Gravel Scrape_B00M_CUCK.wav', t: 3.5 },
  { id: 'debris-roll',   src: 'Foundation\\ROCKMvmt_EARTH PROCESSED-Rock Debris Rolling_B00M_MOCK(2).wav', t: 3.5 },
  { id: 'hen-weird',     src: 'Foundation\\Hen_Weird_sound3.wav', t: 3.0 },
];

let total = 0;
for (const j of JOBS) {
  const inFile = path.join(LIB, j.src);
  const outFile = path.join(OUT, j.id + '.ogg');
  if (!fs.existsSync(inFile)) { console.error('  MISSING SRC:', inFile); continue; }
  const af = `silenceremove=start_periods=1:start_duration=0.02:start_threshold=-45dB,atrim=0:${j.t},asetpts=PTS-STARTPTS,loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000`;
  try {
    execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-i', inFile, '-af', af, '-ac', '1', '-c:a', 'libvorbis', '-q:a', '3', outFile]);
    const kb = Math.round(fs.statSync(outFile).size / 1024);
    total += kb;
    console.log(`  ${j.id}.ogg  ${kb} KB  <- ${j.src.split('\\').pop()}`);
  } catch (e) {
    console.error('  FAIL', j.id, e.message);
  }
}
console.log('total ogg:', total, 'KB');
