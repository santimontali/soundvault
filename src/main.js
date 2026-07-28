const { app, BrowserWindow, ipcMain, dialog, shell, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const zlib = require('zlib');
const semanticEngine = require('./semantic-engine');
// Pure, Electron-free search/audio modules (Phase 2/3 refactor: extracted so
// the logic is unit-testable in plain Node and has a single source of truth).
const { searchSounds } = require('./search/lexical-search');
const { dedupeByPath } = require('./search/vector-search');
const audioPeaks = require('./audio/peaks');
const extractPeaksFromWAV = audioPeaks.extractPeaksFromWAV;
const extractPeaksWithFFmpeg = audioPeaks.extractPeaksWithFFmpeg;

const CONFIG_PATH = path.join(app.getPath('userData'), 'soundvault-config.json');

// Allow AudioContext to work without user gesture — needed for waveform peak extraction on startup
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
function getConfig() { try { if (fs.existsSync(CONFIG_PATH)) return JSON.parse(fs.readFileSync(CONFIG_PATH,'utf-8')); } catch(e){} return { libraryPath: path.join(app.getPath('documents'),'SoundVault') }; }
function saveConfig(c) { fs.writeFileSync(CONFIG_PATH, JSON.stringify(c,null,2)); }
function ensureDir(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }

// ═══ Create a VALID 1x1 PNG file on disk ═══
// Electron's startDrag needs an icon file that actually loads as an image.
const DRAG_ICON_PATH = path.join(app.getPath('userData'), 'sv-drag.png');
function createDragIcon() {
  if (fs.existsSync(DRAG_ICON_PATH)) return;
  // Construct a valid 1x1 RGBA PNG manually
  const width = 1, height = 1;
  // Raw pixel data: 1 filter byte (0=None) + 4 bytes RGBA per pixel
  const rawData = Buffer.from([0, 0, 0, 0, 0]); // filter=0, R=0, G=0, B=0, A=0 (transparent)
  const compressed = zlib.deflateSync(rawData);
  const png = Buffer.alloc(8 + 25 + (12 + compressed.length) + 12);
  let off = 0;
  // PNG signature
  Buffer.from([137,80,78,71,13,10,26,10]).copy(png, off); off += 8;
  // IHDR chunk
  png.writeUInt32BE(13, off); off += 4;
  png.write('IHDR', off); off += 4;
  png.writeUInt32BE(width, off); off += 4;
  png.writeUInt32BE(height, off); off += 4;
  png.writeUInt8(8, off++); // bit depth
  png.writeUInt8(6, off++); // color type RGBA
  png.writeUInt8(0, off++); // compression
  png.writeUInt8(0, off++); // filter
  png.writeUInt8(0, off++); // interlace
  const ihdrData = png.slice(off - 17, off);
  const crc1 = crc32(Buffer.concat([Buffer.from('IHDR'), ihdrData.slice(4)]));
  png.writeInt32BE(crc1, off); off += 4;
  // IDAT chunk
  png.writeUInt32BE(compressed.length, off); off += 4;
  png.write('IDAT', off); off += 4;
  compressed.copy(png, off); off += compressed.length;
  const crc2 = crc32(Buffer.concat([Buffer.from('IDAT'), compressed]));
  png.writeInt32BE(crc2, off); off += 4;
  // IEND chunk
  png.writeUInt32BE(0, off); off += 4;
  png.write('IEND', off); off += 4;
  const crc3 = crc32(Buffer.from('IEND'));
  png.writeInt32BE(crc3, off); off += 4;
  fs.writeFileSync(DRAG_ICON_PATH, png.slice(0, off));
}
// CRC32 for PNG chunks
function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
  }
  return (crc ^ 0xFFFFFFFF) | 0;
}

// ═══ Vaults System ═══
// Vaults are curatorial layers over the shared library. Each vault has its own collections.
// The library (libraryPath) is shared — vaults only differ in which collections they hold.
const VAULTS_PATH = path.join(app.getPath('userData'), 'soundvault-vaults.json');

function loadVaultsData() {
  try { if (fs.existsSync(VAULTS_PATH)) return JSON.parse(fs.readFileSync(VAULTS_PATH, 'utf-8')); } catch(e){}
  return null;
}
function saveVaultsData(data) { fs.writeFileSync(VAULTS_PATH, JSON.stringify(data, null, 2)); }

function generateVaultId() {
  return 'v_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

function initVaults() {
  let data = loadVaultsData();
  if (data && data.vaults && data.vaults.length > 0) return data;
  // First run or migration: create default vault, migrate old collections if they exist
  const defaultId = generateVaultId();
  let collections = {};
  let collectionColors = {};
  // Migrate from old .soundvault-collections.json
  const oldColPath = path.join(getConfig().libraryPath, '.soundvault-collections.json');
  try {
    if (fs.existsSync(oldColPath)) {
      const old = JSON.parse(fs.readFileSync(oldColPath, 'utf-8'));
      collectionColors = old.__colors || {};
      delete old.__colors;
      collections = old;
    }
  } catch(e) {}
  data = {
    activeVaultId: defaultId,
    vaults: [{
      id: defaultId,
      name: 'Main Vault',
      color: '#c8f76d',
      description: '',
      createdAt: Date.now(),
      collections: collections,
      collectionColors: collectionColors
    }]
  };
  saveVaultsData(data);
  return data;
}

function getActiveVault() {
  const data = initVaults();
  return data.vaults.find(v => v.id === data.activeVaultId) || data.vaults[0];
}

// Collections now read/write from active vault
function loadCollections() {
  const vault = getActiveVault();
  if (!vault) return {};
  const result = { ...vault.collections };
  result.__colors = vault.collectionColors || {};
  return result;
}
function saveCollections(cols) {
  const data = initVaults();
  const vault = data.vaults.find(v => v.id === data.activeVaultId);
  if (!vault) return;
  const colors = cols.__colors || {};
  delete cols.__colors;
  vault.collections = cols;
  vault.collectionColors = colors;
  saveVaultsData(data);
}

let mainWindow;
function createWindow() {
  mainWindow = new BrowserWindow({ width:1100, height:700, minWidth:800, minHeight:500, backgroundColor:'#1a1a1e', titleBarStyle:'hiddenInset', trafficLightPosition:{x:15,y:15},
    webPreferences:{ nodeIntegration:false, contextIsolation:true, sandbox:false, preload:path.join(__dirname,'preload.js') }
  });
  mainWindow.loadFile(path.join(__dirname,'index.html'));
  if (process.argv.includes('--dev')) mainWindow.webContents.openDevTools();
}

function registerProtocol() {
  protocol.handle('soundvault', req => {
    const url=new URL(req.url), fp=decodeURIComponent(url.searchParams.get('path')||'');
    if(!fp||!fs.existsSync(fp)) return new Response('Not found',{status:404});
    if(!fp.toLowerCase().endsWith('.wav')) return new Response('Forbidden',{status:403});
    return net.fetch('file://'+fp);
  });
}

let soundCache = [];
let soundCacheReady = false;
async function initSoundCache() {
  soundCacheReady = false;
  const lib = getConfig().libraryPath;
  try {
    const arr = await fs.promises.readdir(lib, { recursive: true, withFileTypes: true });
    soundCache = [];
    const batch = [];
    for (const p of arr) {
      if (!p.isFile() || !p.name.toLowerCase().endsWith('.wav')) continue;
      // Skip node_modules etc
      if (p.parentPath.includes('node_modules') || p.parentPath.includes('.git')) continue;
      const fullPath = path.join(p.parentPath, p.name);
      const rel = path.relative(lib, fullPath);
      batch.push({
        name: p.name,
        path: fullPath,
        folder: path.dirname(rel).replace(/\\/g, '/'),
        topLevel: rel.split(path.sep)[0]
      });
    }
    
    // Async stat chunks to prevent blocking event loop for 70k files
    const chunkSize = 2500;
    for (let i = 0; i < batch.length; i += chunkSize) {
      const chunk = batch.slice(i, i + chunkSize);
      await Promise.all(chunk.map(async (item) => {
        try {
          const st = await fs.promises.stat(item.path);
          item.size = st.size;
          item.dateAdded = st.mtimeMs;
        } catch(e) { item.size = 0; item.dateAdded = 0; }
      }));
      soundCache.push(...chunk);
    }
    soundCache.sort((a,b) => b.dateAdded - a.dateAdded);
  } catch(e) { console.error('Cache init fail', e); }
  soundCacheReady = true;
}

app.whenReady().then(async () => {
  createDragIcon();
  registerProtocol();
  createWindow();
  ensureDir(getConfig().libraryPath);
  
  // Initialize Vaults system (migrates old collections if needed)
  initVaults();
  
  // Initialize Cache in background
  initSoundCache();
  
  // Initialize AI Semantic Engine in background
  try {
    await semanticEngine.init();
    console.log("Semantic Engine initialized in main process.");
    // Start watching library for incremental indexing (Phase C — fs.watch recursive)
    const lib = getConfig().libraryPath;
    if (lib) semanticEngine.startWatching(lib);
  } catch(e) {
    console.error("Failed to initialize Semantic Engine:", e);
  }
});
app.on('window-all-closed', () => { if(process.platform!=='darwin') app.quit(); });
app.on('activate', () => { if(BrowserWindow.getAllWindows().length===0) createWindow(); });

// ═══ IPC ═══
ipcMain.handle('get-library-path', ()=>getConfig().libraryPath);
ipcMain.handle('set-library-path', async()=>{const r=await dialog.showOpenDialog(mainWindow,{properties:['openDirectory']});if(!r.canceled&&r.filePaths[0]){const c=getConfig();c.libraryPath=r.filePaths[0];saveConfig(c);ensureDir(c.libraryPath);initSoundCache();if(semanticEngine.isReady) semanticEngine.startWatching(c.libraryPath);return c.libraryPath;}return null;});
ipcMain.handle('set-watcher', (_,enabled)=>{ const lib=getConfig().libraryPath; if(!lib||!semanticEngine.isReady) return; if(enabled) semanticEngine.startWatching(lib); else semanticEngine.stopWatching(); return enabled; });
ipcMain.handle('get-folders', async ()=>{ 
    while(!soundCacheReady) await new Promise(r=>setTimeout(r,50));
    const counts = {};
    for (const c of soundCache) counts[c.topLevel] = (counts[c.topLevel]||0) + 1;
    return Object.keys(counts).map(name => ({name, count: counts[name]})).sort((a,b)=>a.name.localeCompare(b.name));
});
ipcMain.handle('create-folder',(_,n)=>{const p=path.join(getConfig().libraryPath,n);if(!fs.existsSync(p)){fs.mkdirSync(p,{recursive:true});return true;}return false;});
ipcMain.handle('rename-folder',(_,o,n)=>{const c=getConfig().libraryPath;if(fs.existsSync(path.join(c,o))&&!fs.existsSync(path.join(c,n))){fs.renameSync(path.join(c,o),path.join(c,n));initSoundCache();return true;}return false;});
ipcMain.handle('delete-folder',async(_,n)=>{const fp=path.join(getConfig().libraryPath,n);const r=await dialog.showMessageBox(mainWindow,{type:'warning',buttons:['Cancel','Delete'],defaultId:0,message:`Delete "${n}"?`,detail:'Cannot be undone.'});if(r.response===1){fs.rmSync(fp,{recursive:true,force:true});initSoundCache();return true;}return false;});
ipcMain.handle('get-sounds', async (_,f)=>{
    while(!soundCacheReady) await new Promise(r=>setTimeout(r,50));
    return soundCache.filter(c => c.topLevel === f);
});
ipcMain.handle('delete-sound',async(_,fp)=>{const r=await dialog.showMessageBox(mainWindow,{type:'warning',buttons:['Cancel','Delete'],defaultId:0,message:'Delete this sound?',detail:'Cannot be undone.'});if(r.response===1&&fs.existsSync(fp)){fs.unlinkSync(fp);soundCache=soundCache.filter(s=>s.path!==fp);return true;}return false;});
ipcMain.handle('move-sound',(_,fp,tf)=>{const d=path.join(getConfig().libraryPath,tf,path.basename(fp));if(fs.existsSync(fp)&&!fs.existsSync(d)){fs.renameSync(fp,d);initSoundCache();return true;}return false;});
ipcMain.handle('import-files',async(_,tf)=>{const r=await dialog.showOpenDialog(mainWindow,{properties:['openFile','multiSelections'],filters:[{name:'WAV',extensions:['wav']}]});if(!r.canceled){const tp=path.join(getConfig().libraryPath,tf);ensureDir(tp);const res=r.filePaths.map(fp=>{const d=path.join(tp,path.basename(fp));fs.copyFileSync(fp,d);return d;});initSoundCache();return res;}return[];});
ipcMain.handle('drop-files',(_,fps,tf)=>{console.log('[IPC] drop-files called, fps:', JSON.stringify(fps), 'tf:', tf);const tp=path.join(getConfig().libraryPath,tf);ensureDir(tp);const res=(fps||[]).filter(fp=>fp&&typeof fp==='string'&&fp.toLowerCase().endsWith('.wav')&&fs.existsSync(fp)).map(fp=>{const d=path.join(tp,path.basename(fp));fs.copyFileSync(fp,d);console.log('[IPC] Copied',fp,'->',d);return d;});initSoundCache();return res;});
ipcMain.handle('read-audio-file',async(_,fp)=>{try{if(!fp||!fs.existsSync(fp)||!fp.toLowerCase().endsWith('.wav'))return null;return await fs.promises.readFile(fp);}catch(e){return null;}});

// ═══ Peak Extraction (optimized) ═══
// Three-tier peak extraction:
//   1. SQLite DB cache (populated during indexing) — instant
//   2. Direct WAV parser (reads PCM bytes from disk, no ffmpeg) — ~1-5ms
//   3. ffmpeg fallback (for non-WAV formats: FLAC, AIFF, OGG, MP3) — ~30-80ms
const WAV_EXTENSIONS = new Set(['.wav']);

// The Tier-2 (direct WAV parser) and Tier-3 (ffmpeg fallback) implementations
// live in `./audio/peaks` — pure, unit-tested, and now also support
// WAVE_FORMAT_EXTENSIBLE 24-bit / 32-bit-float WAVs (which previously fell
// through to the slow ffmpeg subprocess). See `tests/audio-peaks.test.js`.
// `extractPeaksFromWAV` / `extractPeaksWithFFmpeg` are imported above.

ipcMain.handle('get-peaks', async (_, fp) => {
    try {
        if (!fp || !fs.existsSync(fp)) return null;

        // Tier 1: SQLite DB cache (instant — populated during indexing)
        if (semanticEngine.isReady) {
            const dbPeaks = semanticEngine.getPeaksFromDB(fp);
            if (dbPeaks) return dbPeaks;
        }

        // Tier 2: Direct WAV parser (fast — no subprocess)
        const ext = path.extname(fp).toLowerCase();
        if (WAV_EXTENSIONS.has(ext)) {
            const result = await extractPeaksFromWAV(fp);
            if (result) return result;
            // If WAV parsing failed (corrupted header), fall through to ffmpeg
        }

        // Tier 3: ffmpeg fallback (for non-WAV or corrupted WAV files)
        return await extractPeaksWithFFmpeg(fp);
    } catch (e) {
        console.error('get-peaks error:', e.message);
        return null;
    }
});

// Collections
ipcMain.handle('get-collections', () => loadCollections());
ipcMain.handle('create-collection', (_, name) => { if(name==='__colors')return false; const c=loadCollections(); if(!c[name]){c[name]=[];saveCollections(c);return true;} return false; });
ipcMain.handle('delete-collection', (_, name) => { if(name==='__colors')return false; const c=loadCollections(); if(c[name]!==undefined){delete c[name];if(c.__colors)delete c.__colors[name];saveCollections(c);return true;} return false; });
ipcMain.handle('rename-collection', (_, old, nu) => { const c=loadCollections(); if(c[old]!==undefined&&!c[nu]){c[nu]=c[old];delete c[old];if(c.__colors&&c.__colors[old]){c.__colors[nu]=c.__colors[old];delete c.__colors[old]}saveCollections(c);return true;} return false; });
ipcMain.handle('set-collection-color', (_, name, color) => { const c=loadCollections(); if(!c.__colors)c.__colors={};if(color)c.__colors[name]=color;else delete c.__colors[name];saveCollections(c);return true; });
ipcMain.handle('add-to-collection', (_, name, filePath) => { const c=loadCollections(); if(!c[name])c[name]=[]; if(!c[name].includes(filePath)){c[name].push(filePath);saveCollections(c);return true;} return false; });
ipcMain.handle('remove-from-collection', (_, name, filePath) => { const c=loadCollections(); if(c[name]){c[name]=c[name].filter(p=>p!==filePath);saveCollections(c);return true;} return false; });
ipcMain.handle('get-collection-sounds', (_, name) => {
  const c=loadCollections(); const paths=(c[name]&&name!=='__colors'?c[name]:[]);
  return paths.filter(p=>fs.existsSync(p)).map(p=>{const st=fs.statSync(p);return{name:path.basename(p),path:p,size:st.size,dateAdded:st.mtimeMs};});
});

// ═══ Vault IPC ═══
ipcMain.handle('get-vaults', () => {
  const data = initVaults();
  return {
    activeVaultId: data.activeVaultId,
    vaults: data.vaults.map(v => ({
      id: v.id,
      name: v.name,
      color: v.color,
      description: v.description || '',
      createdAt: v.createdAt,
      collectionCount: Object.keys(v.collections || {}).length,
      soundCount: Object.values(v.collections || {}).reduce((sum, arr) => sum + arr.length, 0)
    }))
  };
});
ipcMain.handle('create-vault', (_, name, color) => {
  const data = initVaults();
  const id = generateVaultId();
  data.vaults.push({
    id,
    name: name || 'New Vault',
    color: color || '#c8f76d',
    description: '',
    createdAt: Date.now(),
    collections: {},
    collectionColors: {}
  });
  saveVaultsData(data);
  return id;
});
ipcMain.handle('switch-vault', (_, id) => {
  const data = initVaults();
  const vault = data.vaults.find(v => v.id === id);
  if (!vault) return false;
  data.activeVaultId = id;
  saveVaultsData(data);
  return true;
});
ipcMain.handle('rename-vault', (_, id, newName) => {
  const data = initVaults();
  const vault = data.vaults.find(v => v.id === id);
  if (!vault) return false;
  vault.name = newName;
  saveVaultsData(data);
  return true;
});
ipcMain.handle('set-vault-color', (_, id, color) => {
  const data = initVaults();
  const vault = data.vaults.find(v => v.id === id);
  if (!vault) return false;
  vault.color = color;
  saveVaultsData(data);
  return true;
});
ipcMain.handle('delete-vault', (_, id) => {
  const data = initVaults();
  if (data.vaults.length <= 1) return false; // always keep at least one vault
  data.vaults = data.vaults.filter(v => v.id !== id);
  if (data.activeVaultId === id) data.activeVaultId = data.vaults[0].id;
  saveVaultsData(data);
  return true;
});
ipcMain.handle('duplicate-vault', (_, id) => {
  const data = initVaults();
  const source = data.vaults.find(v => v.id === id);
  if (!source) return null;
  const newId = generateVaultId();
  data.vaults.push({
    id: newId,
    name: source.name + ' (copy)',
    color: source.color,
    description: source.description || '',
    createdAt: Date.now(),
    collections: JSON.parse(JSON.stringify(source.collections)),
    collectionColors: JSON.parse(JSON.stringify(source.collectionColors || {}))
  });
  saveVaultsData(data);
  return newId;
});
ipcMain.handle('set-vault-description', (_, id, description) => {
  const data = initVaults();
  const vault = data.vaults.find(v => v.id === id);
  if (!vault) return false;
  vault.description = description || '';
  saveVaultsData(data);
  return true;
});

// Render selection WAV
ipcMain.handle('render-selection-wav', (_, { channelData, sampleRate, numChannels, bitDepth, fileName }) => {
  try {
    const tmpDir=path.join(os.tmpdir(),'soundvault-temp');ensureDir(tmpDir);
    const tmpPath=path.join(tmpDir,fileName||'selection.wav');
    const channels=channelData.map(ch=>new Float32Array(ch.buffer,ch.byteOffset,ch.byteLength/4));
    const ns=channels[0].length,bps=bitDepth/8,dataSize=ns*numChannels*bps,buf=Buffer.alloc(44+dataSize);
    buf.write('RIFF',0);buf.writeUInt32LE(36+dataSize,4);buf.write('WAVE',8);buf.write('fmt ',12);buf.writeUInt32LE(16,16);buf.writeUInt16LE(1,20);buf.writeUInt16LE(numChannels,22);buf.writeUInt32LE(sampleRate,24);buf.writeUInt32LE(sampleRate*numChannels*bps,28);buf.writeUInt16LE(numChannels*bps,32);buf.writeUInt16LE(bitDepth,34);buf.write('data',36);buf.writeUInt32LE(dataSize,40);
    let off=44;
    for(let i=0;i<ns;i++){for(let ch=0;ch<numChannels;ch++){const s=Math.max(-1,Math.min(1,channels[ch][i]||0));
    if(bitDepth===16){buf.writeInt16LE(Math.round(s*32767),off);off+=2}
    else if(bitDepth===24){let v=Math.round(s*8388607);v=Math.max(-8388608,Math.min(8388607,v));const u=v<0?v+16777216:v;buf.writeUInt8(u&0xFF,off);buf.writeUInt8((u>>8)&0xFF,off+1);buf.writeUInt8((u>>16)&0xFF,off+2);off+=3}}}
    fs.writeFileSync(tmpPath,buf);return tmpPath;
  }catch(e){console.error('render-selection-wav:',e);return null;}
});

// Overwrite audio file (used by Scissors crop)
ipcMain.handle('overwrite-audio-file', (_, { filePath, channelData, sampleRate, numChannels, bitDepth }) => {
  try {
    if (!fs.existsSync(filePath)) return false;
    const channels=channelData.map(ch=>new Float32Array(ch.buffer,ch.byteOffset,ch.byteLength/4));
    const ns=channels[0].length,bps=bitDepth/8,dataSize=ns*numChannels*bps,buf=Buffer.alloc(44+dataSize);
    buf.write('RIFF',0);buf.writeUInt32LE(36+dataSize,4);buf.write('WAVE',8);buf.write('fmt ',12);buf.writeUInt32LE(16,16);buf.writeUInt16LE(1,20);buf.writeUInt16LE(numChannels,22);buf.writeUInt32LE(sampleRate,24);buf.writeUInt32LE(sampleRate*numChannels*bps,28);buf.writeUInt16LE(numChannels*bps,32);buf.writeUInt16LE(bitDepth,34);buf.write('data',36);buf.writeUInt32LE(dataSize,40);
    let off=44;
    for(let i=0;i<ns;i++){for(let ch=0;ch<numChannels;ch++){const s=Math.max(-1,Math.min(1,channels[ch][i]||0));
    if(bitDepth===16){buf.writeInt16LE(Math.round(s*32767),off);off+=2}
    else if(bitDepth===24){let v=Math.round(s*8388607);v=Math.max(-8388608,Math.min(8388607,v));const u=v<0?v+16777216:v;buf.writeUInt8(u&0xFF,off);buf.writeUInt8((u>>8)&0xFF,off+1);buf.writeUInt8((u>>16)&0xFF,off+2);off+=3}}}
    fs.writeFileSync(filePath,buf);return true;
  }catch(e){console.error('overwrite-audio-file:',e);return false;}
});

// Create new audio version (used by Scissors crop)
ipcMain.handle('create-new-audio-version', (_, { originalPath, suffix, channelData, sampleRate, numChannels, bitDepth }) => {
  try {
    const ext = path.extname(originalPath);
    const base = path.basename(originalPath, ext);
    const dir = path.dirname(originalPath);
    let newName = `${base}${suffix}${ext}`;
    let newPath = path.join(dir, newName);
    let counter = 1;
    while(fs.existsSync(newPath)) {
      newName = `${base}${suffix}_${counter}${ext}`;
      newPath = path.join(dir, newName);
      counter++;
    }
    const channels=channelData.map(ch=>new Float32Array(ch.buffer,ch.byteOffset,ch.byteLength/4));
    const ns=channels[0].length,bps=bitDepth/8,dataSize=ns*numChannels*bps,buf=Buffer.alloc(44+dataSize);
    buf.write('RIFF',0);buf.writeUInt32LE(36+dataSize,4);buf.write('WAVE',8);buf.write('fmt ',12);buf.writeUInt32LE(16,16);buf.writeUInt16LE(1,20);buf.writeUInt16LE(numChannels,22);buf.writeUInt32LE(sampleRate,24);buf.writeUInt32LE(sampleRate*numChannels*bps,28);buf.writeUInt16LE(numChannels*bps,32);buf.writeUInt16LE(bitDepth,34);buf.write('data',36);buf.writeUInt32LE(dataSize,40);
    let off=44;
    for(let i=0;i<ns;i++){for(let ch=0;ch<numChannels;ch++){const s=Math.max(-1,Math.min(1,channels[ch][i]||0));
    if(bitDepth===16){buf.writeInt16LE(Math.round(s*32767),off);off+=2}
    else if(bitDepth===24){let v=Math.round(s*8388607);v=Math.max(-8388608,Math.min(8388607,v));const u=v<0?v+16777216:v;buf.writeUInt8(u&0xFF,off);buf.writeUInt8((u>>8)&0xFF,off+1);buf.writeUInt8((u>>16)&0xFF,off+2);off+=3}}}
    fs.writeFileSync(newPath,buf);return newPath;
  }catch(e){console.error('create-new-audio-version:',e);return null;}
});

// Drag — uses the valid PNG file on disk
ipcMain.on('ondragstart', (event, filePath) => {
  if (fs.existsSync(filePath)) {
    event.sender.startDrag({ file: filePath, icon: DRAG_ICON_PATH });
  }
});

ipcMain.handle('reveal-in-finder',(_,fp)=>shell.showItemInFolder(fp));

ipcMain.handle('search-all-sounds', async (_, q, limit) => {
    while(!soundCacheReady) await new Promise(r=>setTimeout(r,50));
    // Tokenized AND search over name/folder/topLevel with relevance ranking,
    // routed through the pure `src/search/lexical-search` module. Fixes the
    // multi-word query bug (e.g. "kick drum") that the old whole-query literal
    // substring match silently dropped. See tests/lexical-search.test.js.
    return searchSounds(soundCache, q, { limit: limit || 200 });
});

// ═══ Semantic Search IPC ═══
ipcMain.handle('semantic-is-ready', () => semanticEngine.isReady);
ipcMain.handle('semantic-get-progress', () => semanticEngine.progress);
ipcMain.handle('semantic-start-indexing', () => {
    if (!semanticEngine.isReady) return false;
    const lib = getConfig().libraryPath;
    semanticEngine.startIndexing(lib).catch(e => console.error("Indexing error:", e));
    return true;
});
ipcMain.handle('semantic-search', async (_, queryText, weights) => {
    if (!semanticEngine.isReady) return { results: [], words: [] };
    
    try {
        const res = await semanticEngine.search(queryText, weights);
        if (!res || !Array.isArray(res.results)) return { results: [], words: res?.words || [] };

        // Defense-in-depth: collapse duplicate-path rows so the renderer never
        // sees the same file twice. The engine's in-memory `_paths[]` cache can
        // duplicate entries on watcher-triggered re-index (see the root-cause
        // fix in `SemanticEngine._appendToCache`); even with that fix, this
        // guard protects against any cache drift across releases/sessions.
        // `res.results` is already sorted desc by score, so the FIRST copy of
        // any duplicate path is the highest-score one and is the one kept.
        const ranked = dedupeByPath(res.results);

        const cacheMap = new Map();
        for (const s of soundCache) cacheMap.set(s.path, s);

        const finalResults = [];
        for (const r of ranked) {
            const cached = cacheMap.get(r.path);
            if (cached) {
                finalResults.push({
                    name: cached.name,
                    path: cached.path,
                    folder: cached.folder,
                    size: cached.size,
                    dateAdded: cached.dateAdded,
                    score: r.score
                });
            }
        }
        return { results: finalResults, words: res.words || [] };
    } catch(e) {
        console.error('semantic-search error:', e);
        return { results: [], words: [] };
    }
});

// Semantic suggestions for a collection (centroid-based)
ipcMain.handle('semantic-suggest', async (_, collectionName) => {
    if (!semanticEngine.isReady) return [];
    try {
        const cols = loadCollections();
        const paths = (cols[collectionName] && collectionName !== '__colors') ? cols[collectionName] : [];
        if (!paths.length) return [];
        
        const suggestions = semanticEngine.suggestForCollection(paths, 12);
        
        const cacheMap = new Map();
        for (const s of soundCache) cacheMap.set(s.path, s);
        
        return suggestions.map(r => {
            const cached = cacheMap.get(r.path);
            if (!cached) return null;
            return { name: cached.name, path: cached.path, folder: cached.folder, size: cached.size, dateAdded: cached.dateAdded, score: r.score };
        }).filter(Boolean);
    } catch(e) {
        console.error('semantic-suggest error:', e);
        return [];
    }
});

// ═══ Echo Vault IPC ═══
ipcMain.handle('echo-search', async (_, params) => {
    if (!semanticEngine.isReady) return { results: [], searchTimeMs: 0, totalCandidates: 0, totalMatches: 0 };
    try {
        // Reconstruct Float32Array robustly.
        // Electron's contextBridge serializes TypedArrays via structured clone, which means
        // a Float32Array from the renderer may arrive as a Uint8Array, a Node Buffer, or in
        // rare edge-cases as a plain object (e.g. when the ArrayBuffer was already detached).
        // We must handle all cases to avoid "Cannot read properties of undefined (reading 'buffer')".
        const raw = params.pcmData;
        if (!raw) throw new Error('echo-search: pcmData is missing. lastSearchParams must be of type "fragment".');
        let pcmData;
        if (raw instanceof Float32Array) {
            // Already correct (same-process path or future Electron behaviour)
            pcmData = raw;
        } else if (raw.buffer instanceof ArrayBuffer && raw.byteLength > 0) {
            // Standard IPC path: arrives as Uint8Array with a valid backing ArrayBuffer
            pcmData = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
        } else if (Buffer.isBuffer(raw)) {
            // Node Buffer — copy into a fresh Float32Array to avoid alignment issues
            const ab = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
            pcmData = new Float32Array(ab);
        } else {
            // Fallback: plain/array-like object (detached buffer, or unusual serialisation).
            // Copy values element-by-element into a new Float32Array.
            const len = raw.length ?? (raw.byteLength != null ? Math.floor(raw.byteLength / 4) : 0);
            if (!len) throw new Error('echo-search: pcmData has zero length or unrecognised format.');
            pcmData = new Float32Array(len);
            for (let i = 0; i < len; i++) pcmData[i] = raw[i] ?? 0;
        }
        const res = await semanticEngine.echoSearch({
            pcmData,
            sampleRate: params.sampleRate,
            duration: params.duration,
            weights: params.weights || null,
            maxResults: params.maxResults || 50,
            sourceFilePath: params.sourceFilePath || null,
        });

        // Enrich results with sound cache metadata
        const cacheMap = new Map();
        for (const s of soundCache) cacheMap.set(s.path, s);

        // Defense-in-depth: dedup by path (same root-cause / engine cache drift
        // pattern as `semantic-search`). Echo results render in the #echo-results
        // panel, not the explorer grid, but the same guard belongs here.
        res.results = dedupeByPath(res.results).map(r => {
            const cached = cacheMap.get(r.path);
            return {
                ...r,
                name: cached ? cached.name : path.basename(r.path),
                folder: cached ? cached.folder : '',
                topLevel: cached ? cached.topLevel : '',
                size: cached ? cached.size : 0,
                dateAdded: cached ? cached.dateAdded : 0,
            };
        });
        return res;
    } catch(e) {
        console.error('echo-search error:', e);
        return { results: [], searchTimeMs: 0, totalCandidates: 0, totalMatches: 0 };
    }
});

ipcMain.handle('echo-file', async (_, filePath, weights) => {
    if (!semanticEngine.isReady) return { results: [], searchTimeMs: 0, totalCandidates: 0, totalMatches: 0 };
    try {
        const res = await semanticEngine.echoFile(filePath, weights || null);

        const cacheMap = new Map();
        for (const s of soundCache) cacheMap.set(s.path, s);

        // Defense-in-depth: dedup by path — see `semantic-search` for rationale.
        res.results = dedupeByPath(res.results).map(r => {
            const cached = cacheMap.get(r.path);
            return {
                ...r,
                name: cached ? cached.name : path.basename(r.path),
                folder: cached ? cached.folder : '',
                topLevel: cached ? cached.topLevel : '',
                size: cached ? cached.size : 0,
                dateAdded: cached ? cached.dateAdded : 0,
            };
        });
        return res;
    } catch(e) {
        console.error('echo-file error:', e);
        return { results: [], searchTimeMs: 0, totalCandidates: 0, totalMatches: 0 };
    }
});

ipcMain.handle('spectral-is-ready', () => semanticEngine.spectralReady);
ipcMain.handle('spectral-get-progress', () => semanticEngine.spectralProgress);

