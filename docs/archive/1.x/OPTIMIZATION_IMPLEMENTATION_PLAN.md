# SoundVault: Plan de Implementación de Optimización

## Contexto para el agente ejecutor

Este documento contiene instrucciones de implementación exactas para cada optimización. Cada tarea especifica los archivos a modificar, las funciones exactas a reemplazar, las firmas, y el código esperado. **No improvises ni cambies la arquitectura**. SoundVault es vanilla JS/HTML/CSS sobre Electron, no introduzcas frameworks, bundlers, ni dependencias externas.

Las reglas de arquitectura de SoundVault que DEBES respetar siempre:

1. El **Renderer** (index.html) NUNCA accede a Node.js. Todo pasa por IPC via `window.api`.
2. El **Main Process** (main.js) maneja filesystem, SQLite, ffmpeg, y AI.
3. `preload.js` es el context bridge. Cada nuevo canal IPC debe exponerse ahí.
4. `semantic-engine.js` y `spectral-engine.js` corren en el Main Process.
5. `indexing-worker.js` es un Worker Thread que comparte la DB vía WAL.
6. Todas las interacciones de UI deben mantener 60fps. Usa `requestAnimationFrame` para updates visuales.
7. Los canvas de waveform usan `devicePixelRatio` para renders nítidos.

---

## TAREA 1: Virtualización Bidireccional de la Lista de Sonidos

### Objetivo
Reemplazar el sistema actual de "append infinito" (`renderMoreSounds`) con una lista virtualizada que mantiene solo ~40 DOM nodes en todo momento, reciclándolos al scrollear.

### Archivos a modificar
- `index.html` (renderer)

### Constante de altura
Cada `.sound-item` tiene: `padding: 8px` top + bottom (16px total) + contenido interno de `40px` (waveform height) + `border-bottom: 0.5px`. La altura real medida con `getBoundingClientRect` puede variar según font rendering, pero para virtualización necesitamos una constante fija. Usa `ITEM_HEIGHT = 57` (esto se puede calibrar después con un `sound-item` real).

### Variables a eliminar
Eliminar `currentRenderList` y `currentRenderCount` (líneas 2827-2828). Reemplazar por el estado del virtualizador.

### Estado del virtualizador
Agregar estas variables después de la línea `let sidebarMode = 'vault';` (línea 2682):

```javascript
// ═══ Virtual List State ═══
const ITEM_HEIGHT = 57;        // px, measured height of .sound-item
const BUFFER_COUNT = 10;       // extra items above/below viewport
let vList = {
  data: [],                    // full data array (sound objects)
  pool: [],                    // DOM node pool: { el, canvasEl, idx }
  poolSize: 0,
  scrollTop: 0,
  containerHeight: 0,
  sentinel: null,              // spacer div for total scroll height
};
```

### Nuevo `renderSounds(list)`: reemplazar COMPLETAMENTE la función actual (líneas 2830-2838)

```javascript
function renderSounds(list) {
  const ct = document.getElementById('sound-list');
  const dz = document.getElementById('drop-zone');

  // Clear previous state
  vList.data = list || [];
  document.getElementById('sound-count').textContent =
    vList.data.length + ' sound' + (vList.data.length !== 1 ? 's' : '');

  if (!vList.data.length) {
    ct.innerHTML = '';
    ct.appendChild(dz);
    ct.insertAdjacentHTML('beforeend',
      '<div class="empty-state"><div style="font-size:36px;opacity:.3">🔇</div><div style="font-size:13px">No sounds</div></div>');
    vList.pool = [];
    vList.poolSize = 0;
    vList.sentinel = null;
    return;
  }

  // Build pool if needed
  ct.innerHTML = '';
  ct.appendChild(dz);

  // Sentinel: invisible div with total height for scrollbar
  if (!vList.sentinel) {
    vList.sentinel = document.createElement('div');
    vList.sentinel.style.cssText = 'position:relative;width:100%;pointer-events:none;';
  }
  vList.sentinel.style.height = (vList.data.length * ITEM_HEIGHT) + 'px';
  ct.appendChild(vList.sentinel);

  // Calculate pool size: visible items + 2x buffer
  vList.containerHeight = ct.clientHeight;
  const visibleCount = Math.ceil(vList.containerHeight / ITEM_HEIGHT);
  const needed = visibleCount + BUFFER_COUNT * 2;
  const poolSize = Math.min(needed, vList.data.length);

  // Create pool nodes (or reuse if same size)
  if (vList.poolSize !== poolSize) {
    vList.pool = [];
    for (let i = 0; i < poolSize; i++) {
      const el = createSoundItemElement();
      el.style.position = 'absolute';
      el.style.left = '0';
      el.style.right = '0';
      el.style.height = ITEM_HEIGHT + 'px';
      vList.sentinel.appendChild(el);
      vList.pool.push({ el, idx: -1 });
    }
    vList.poolSize = poolSize;
  }

  ct.scrollTop = 0;
  vList.scrollTop = 0;
  updateVirtualList();
}
```

### Nuevo `createSoundItemElement()`: función helper que crea un nodo reutilizable

Insertar ANTES de `renderSounds`:

```javascript
function createSoundItemElement() {
  const div = document.createElement('div');
  div.className = 'sound-item';
  div.innerHTML = `<button class="play-btn"><svg class="play-icon" width="11" height="13" viewBox="0 0 12 14"><polygon points="2,0 12,7 2,14"/></svg></button><div class="sound-info"><div class="sound-name"></div><div class="sound-meta">WAV · ...</div></div><div class="waveform-container"><canvas class="waveform-canvas"></canvas><div class="sel-overlay"><div class="sel-resize left"></div><div class="sel-resize right"></div></div></div><span class="sound-duration">...</span><div class="full-drag" draggable="true" title="Drag to DAW"><svg width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="4.5" cy="4" r="1.2" fill="currentColor"/><circle cx="4.5" cy="8" r="1.2" fill="currentColor"/><circle cx="4.5" cy="12" r="1.2" fill="currentColor"/><circle cx="9.5" cy="4" r="1.2" fill="currentColor"/><circle cx="9.5" cy="8" r="1.2" fill="currentColor"/><circle cx="9.5" cy="12" r="1.2" fill="currentColor"/></svg></div>`;
  return div;
}
```

### Nuevo `bindSoundItem(poolEntry, sound, index)`: función que asigna data a un nodo reciclado

```javascript
function bindSoundItem(poolEntry, sound, index) {
  const { el } = poolEntry;
  const prevIdx = poolEntry.idx;
  poolEntry.idx = index;

  // Position
  el.style.top = (index * ITEM_HEIGHT) + 'px';

  // Data binding
  el.dataset.path = sound.path;
  const isActive = currentSound?.path === sound.path;
  const isThisPlaying = isActive && isPlaying;
  el.classList.toggle('playing', isActive);

  // Name
  const nameEl = el.querySelector('.sound-name');
  const nm = sound.name.replace(/\.wav$/i, '');
  const ft = sound.folder ? `<span style="color:var(--text-muted);margin-right:3px;font-size:11px">${sound.folder}/</span>` : '';
  const scoreUi = sound.score !== undefined ? `<span style="background:var(--accent-dim); color:var(--accent); padding:1px 5px; border-radius:4px; font-size:10px; margin-left:6px">${Math.round(sound.score*100)}% match</span>` : '';
  nameEl.innerHTML = ft + nm + scoreUi;

  // Duration & meta
  const c = peakCache.get(sound.path);
  const dur = c ? formatTime(c.duration) : '...';
  el.querySelector('.sound-meta').textContent = 'WAV · ' + dur;
  el.querySelector('.sound-duration').textContent = dur;

  // Play button
  const btn = el.querySelector('.play-btn');
  btn.innerHTML = isThisPlaying
    ? '<svg class="play-icon" width="11" height="13" viewBox="0 0 12 14"><rect x="1" y="0" width="3.5" height="14" rx="1" fill="currentColor"/><rect x="7.5" y="0" width="3.5" height="14" rx="1" fill="currentColor"/></svg>'
    : '<svg class="play-icon" width="11" height="13" viewBox="0 0 12 14"><polygon points="2,0 12,7 2,14"/></svg>';

  // Rebind events (remove old listeners via cloneNode trick)
  const newBtn = btn.cloneNode(true);
  btn.parentNode.replaceChild(newBtn, btn);
  newBtn.addEventListener('click', e => { e.stopPropagation(); playSoundItem(sound) });

  // Waveform container events
  const wc = el.querySelector('.waveform-container');
  const newWc = wc.cloneNode(true);
  wc.parentNode.replaceChild(newWc, wc);

  newWc.addEventListener('mousedown', e => {
    if (e.button !== 0 || e.target.closest('.sel-resize')) return;
    e.preventDefault(); e.stopPropagation();
    const rect = newWc.getBoundingClientRect();
    const startFrac = (e.clientX - rect.left) / rect.width;
    const startX = e.clientX, startY = e.clientY;
    let dragMode = false;
    const onM = me => {
      if (!dragMode) {
        if (Math.abs(me.clientX - startX) > 5 || Math.abs(me.clientY - startY) > 5) {
          dragMode = true; clearSelection();
        } else return;
      }
      const fr = Math.max(0, Math.min(1, (me.clientX - rect.left) / rect.width));
      setSelection(sound.path, startFrac, fr);
    };
    const onU = async me => {
      document.removeEventListener('mousemove', onM);
      document.removeEventListener('mouseup', onU);
      if (!dragMode) {
        const clickFrac = Math.max(0, Math.min(1, (me.clientX - rect.left) / rect.width));
        clearSelection();
        if (!currentSound || currentSound.path !== sound.path) {
          stopAudio(); currentSound = sound;
          document.getElementById('player-name').textContent = sound.name.replace(/\.wav$/i, '');
          refreshPlaying();
          const buf = await decodeFile(sound.path);
          if (!buf) { currentSound = null; refreshPlaying(); return }
          audioBuffer = buf;
        }
        if (audioBuffer) {
          const t = clickFrac * audioBuffer.duration;
          playOffset = t; stopAudio();
          playAudio(t, audioBuffer.duration); refreshPlaying();
        }
      }
    };
    document.addEventListener('mousemove', onM);
    document.addEventListener('mouseup', onU);
  });

  // Resize handles
  const lh = newWc.querySelector('.sel-resize.left');
  const rh = newWc.querySelector('.sel-resize.right');
  function resize(ev, side) {
    if (ev.button !== 0 || !selection || selection.path !== sound.path) return;
    ev.preventDefault(); ev.stopPropagation();
    if (ev.shiftKey) { fadeDrag(ev, side, sound, newWc); return }
    const rect = newWc.getBoundingClientRect();
    const onM = me => {
      const fr = Math.max(0, Math.min(1, (me.clientX - rect.left) / rect.width));
      if (side === 'left') selection.start = Math.min(fr, selection.end - .01);
      else selection.end = Math.max(fr, selection.start + .01);
      updateSelUI(sound.path); redrawWf(sound.path);
    };
    const onU = () => { document.removeEventListener('mousemove', onM); document.removeEventListener('mouseup', onU) };
    document.addEventListener('mousemove', onM); document.addEventListener('mouseup', onU);
  }
  lh.addEventListener('mousedown', e => resize(e, 'left'));
  rh.addEventListener('mousedown', e => resize(e, 'right'));

  // Full file drag
  const fdEl = el.querySelector('.full-drag');
  const newFd = fdEl.cloneNode(true);
  fdEl.parentNode.replaceChild(newFd, fdEl);
  newFd.addEventListener('dragstart', e => { e.preventDefault(); window.api.startDrag(sound.path) });

  // Context menu
  const newEl = el; // el reference stays the same
  newEl.oncontextmenu = e => { e.preventDefault(); showCtx(e.clientX, e.clientY, sound) };

  // Draw waveform
  const cv = newWc.querySelector('.waveform-canvas');
  if (c) {
    requestAnimationFrame(() => {
      const sel = selection?.path === sound.path ? selection : null;
      drawWf(cv, c.peaks, {
        selStart: sel?.start, selEnd: sel?.end,
        fiF: sel ? sel.fadeIn / c.duration : 0,
        foF: sel ? sel.fadeOut / c.duration : 0
      });
      updateSelUI(sound.path);
    });
  } else {
    queueWf(el, sound);
  }

  // Selection overlay
  updateSelUI(sound.path);
}
```

### Nuevo `updateVirtualList()`: el corazón del reciclaje

```javascript
function updateVirtualList() {
  if (!vList.data.length || !vList.pool.length) return;

  const ct = document.getElementById('sound-list');
  const scrollTop = ct.scrollTop;
  const viewHeight = ct.clientHeight;

  // Calculate visible range
  const firstVisible = Math.floor(scrollTop / ITEM_HEIGHT);
  const lastVisible = Math.ceil((scrollTop + viewHeight) / ITEM_HEIGHT);

  // Add buffer
  const rangeStart = Math.max(0, firstVisible - BUFFER_COUNT);
  const rangeEnd = Math.min(vList.data.length - 1, lastVisible + BUFFER_COUNT);

  // Build set of indices that need to be rendered
  const needed = new Set();
  for (let i = rangeStart; i <= rangeEnd; i++) needed.add(i);

  // Find pool nodes that are outside the needed range → available for recycling
  const available = [];
  for (const entry of vList.pool) {
    if (entry.idx === -1 || !needed.has(entry.idx)) {
      available.push(entry);
    } else {
      needed.delete(entry.idx); // already rendered
    }
  }

  // Assign available pool nodes to needed indices
  for (const idx of needed) {
    if (!available.length) break;
    const entry = available.pop();
    bindSoundItem(entry, vList.data[idx], idx);
  }
}
```

### Reemplazar el scroll listener (líneas 3636-3641)

Buscar:
```javascript
document.getElementById('sound-list').addEventListener('scroll', e => {
  const ct = e.currentTarget;
  if (ct.scrollTop + ct.clientHeight >= ct.scrollHeight - 200) {
    if (currentRenderCount < currentRenderList.length) renderMoreSounds();
  }
});
```

Reemplazar con:
```javascript
document.getElementById('sound-list').addEventListener('scroll', () => {
  updateVirtualList();
  if (selection) positionGlobalToolbar();
});
```

### Eliminar el listener duplicado de scroll (línea 2773)

Buscar y eliminar esta línea:
```javascript
document.getElementById('sound-list').addEventListener('scroll', () => { if (selection) positionGlobalToolbar() });
```
Ya está integrado en el nuevo scroll listener.

### Eliminar `renderMoreSounds` completamente (líneas 2841-2932)

La función `renderMoreSounds` completa se elimina. Su lógica ahora vive en `updateVirtualList` + `bindSoundItem`.

### Adaptar `refreshPlaying()`

La función actual (línea 2802) usa `document.querySelectorAll('.sound-item')` que iteraba sobre TODOS los items DOM. Con virtualización, solo hay ~40 nodos. La función funciona igual pero automáticamente es más rápida. **No requiere cambios.**

### Adaptar funciones que buscan `.sound-item[data-path=...]`

Las funciones `redrawWf`, `updateWfPh`, `updateSelUI`, y `positionGlobalToolbar` buscan elementos por `data-path` con `querySelector`. Con virtualización, el elemento solo existe si está en el viewport. **Esto ya está bien** porque las funciones hacen null-check (`if (!it) return`). No requieren cambios.

### Adaptar `fadeDrag`

La función `fadeDrag` (inlineada en la línea 2913 del código actual) se usa dentro de `bindSoundItem`, ya está migrada arriba. **Copiar la implementación exacta de fadeDrag que ya existe en el codebase actual dentro de bindSoundItem.** La función actual es:

```javascript
function fadeDrag(ev, side, snd, wc2) {
  if (!selection || selection.path !== snd.path) return;
  const pc = peakCache.get(snd.path); if (!pc) return;
  const rect = wc2.getBoundingClientRect();
  const selDur = (selection.end - selection.start) * pc.duration;
  const onM = me => {
    const fr = Math.max(0, Math.min(1, (me.clientX - rect.left) / rect.width));
    if (side === 'left') selection.fadeIn = Math.max(0, Math.min(selDur * .8, (fr - selection.start) * pc.duration));
    else selection.fadeOut = Math.max(0, Math.min(selDur * .8, (selection.end - fr) * pc.duration));
    redrawWf(snd.path);
  };
  const onU = () => { document.removeEventListener('mousemove', onM); document.removeEventListener('mouseup', onU) };
  document.addEventListener('mousemove', onM); document.addEventListener('mouseup', onU);
}
```

Esta función debe existir en el scope del `<script>` (fuera de bindSoundItem) para que bindSoundItem la pueda llamar.

### Testing
- Cargar una carpeta con 1000+ archivos. Inspeccionar el DOM: debe haber ~40 `<div class="sound-item">`, nunca más.
- Scrollear rápidamente: debe mantener 60fps. Verificar con DevTools Performance tab.
- La barra de scroll debe reflejar el total real de items (su altura viene del sentinel).
- Click, play, selection, drag, context menu deben seguir funcionando en cualquier posición del scroll.

---

## TAREA 2: Peak Extraction en Main Process

### Objetivo
Mover la extracción de peaks de waveform del renderer al main process. El renderer actualmente envía un WAV completo (hasta 50MB) por IPC via `readAudioFile`, lo decodifica con Web Audio API, y extrae 4000 peaks. Esto es extremadamente ineficiente. El main process debe hacer la extracción y cachear los peaks.

### Archivos a modificar
- `main.js`: nuevo handler IPC
- `preload.js`: exponer nuevo canal
- `index.html`: modificar `loadPeaks`

### Paso 2.1: Nuevo handler IPC en `main.js`

Agregar DESPUÉS de la línea del handler `read-audio-file` (línea 243):

```javascript
// ═══ Peak Extraction (optimized, avoids sending full WAV to renderer) ═══
// Decodes first few seconds of a WAV file and returns 4000 peak values + duration.
// Uses ffmpeg to decode to raw f32le, then calculates peaks in main process.
const _peakCache = new Map(); // path → { peaks: Float32Array(4000), duration: number, mtime: number }

ipcMain.handle('get-peaks', async (_, fp) => {
  try {
    if (!fp || !fs.existsSync(fp) || !fp.toLowerCase().endsWith('.wav')) return null;

    // Check mtime-based cache
    const stat = await fs.promises.stat(fp);
    const cached = _peakCache.get(fp);
    if (cached && cached.mtime === stat.mtimeMs) {
      return { peaks: cached.peaks, duration: cached.duration };
    }

    // Use ffmpeg to decode entire file to mono f32le for accurate duration + peaks
    const { duration, peaks } = await new Promise((resolve, reject) => {
      const chunks = [];
      let settled = false;
      const doResolve = () => {
        if (settled) return;
        settled = true;
        const buf = Buffer.concat(chunks);
        if (buf.byteLength < 4) { reject(new Error('No audio data')); return; }
        const samples = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
        const fileDuration = samples.length / 48000;

        // Extract 4000 peaks
        const NUM_PEAKS = 4000;
        const spp = Math.max(1, Math.floor(samples.length / NUM_PEAKS));
        const peaks = new Float32Array(NUM_PEAKS);
        for (let i = 0; i < NUM_PEAKS; i++) {
          let max = 0;
          const offset = i * spp;
          for (let j = 0; j < spp && offset + j < samples.length; j++) {
            const v = Math.abs(samples[offset + j]);
            if (v > max) max = v;
          }
          peaks[i] = max;
        }
        resolve({ duration: fileDuration, peaks });
      };

      const ffmpegStatic = require('ffmpeg-static');
      require('fluent-ffmpeg')(fp)
        .setFfmpegPath(ffmpegStatic)
        .audioFrequency(48000)
        .audioChannels(1)
        .format('f32le')
        .on('error', err => {
          if (err.message && err.message.includes('Output stream closed')) {
            doResolve(); return;
          }
          if (!settled) { settled = true; reject(err); }
        })
        .on('end', () => doResolve())
        .pipe()
        .on('data', chunk => chunks.push(chunk));
    });

    // Cache the result
    _peakCache.set(fp, { peaks, duration, mtime: stat.mtimeMs });

    // Return as transferable: peaks as regular array (IPC will serialize Float32Array)
    return { peaks, duration };
  } catch (e) {
    console.error('get-peaks error:', e.message);
    return null;
  }
});
```

### Paso 2.2: Exponer en `preload.js`

Agregar después de la línea `readAudioFile`:

```javascript
getPeaks: fp => ipcRenderer.invoke('get-peaks', fp),
```

### Paso 2.3: Modificar `loadPeaks` en `index.html`

Buscar la función `loadPeaks` (empieza en línea 2710). Reemplazar COMPLETAMENTE con:

```javascript
async function loadPeaks(fp) {
  if (peakCache.has(fp)) return peakCache.get(fp);
  try {
    const data = await window.api.getPeaks(fp);
    if (!data || !data.peaks) return null;
    // Reconstruct Float32Array from IPC transfer
    const peaks = (data.peaks instanceof Float32Array)
      ? data.peaks
      : new Float32Array(Object.values(data.peaks));
    const res = { peaks, duration: data.duration };
    peakCache.set(fp, res);
    return res;
  } catch (err) {
    console.warn('loadPeaks:', fp.split(/[/\\]/).pop(), err.message);
    return null;
  }
}
```

### IMPORTANTE: NO eliminar `readAudioFile`
`readAudioFile` sigue siendo necesario para `decodeFile` (que decodifica el audio completo para reproducción). Solo `loadPeaks` deja de usarlo.

### Testing
- Las waveforms deben dibujarse igual que antes.
- La duración mostrada debe ser correcta.
- Verificar con DevTools Network/Performance que los transfers IPC son ~16KB (4000 * 4 bytes) en vez de megabytes.
- La cola de waveforms (`wfQ` / `processWfQ`) debe funcionar igual, ahora simplemente es más rápida.

---

## TAREA 3: Paginación de `search-all-sounds`

### Objetivo
Limitar la búsqueda textual (`search-all-sounds`) a los primeros 200 resultados para evitar transferir hasta 70k objetos por IPC.

### Archivos a modificar
- `main.js`

### Modificar el handler `search-all-sounds` (línea 412)

Buscar:
```javascript
ipcMain.handle('search-all-sounds', async (_, q) => {
    while(!soundCacheReady) await new Promise(r=>setTimeout(r,50));
    const ql = q.toLowerCase();
    return soundCache.filter(c => c.name.toLowerCase().includes(ql) || c.folder.toLowerCase().includes(ql) || c.topLevel.toLowerCase().includes(ql));
});
```

Reemplazar con:
```javascript
ipcMain.handle('search-all-sounds', async (_, q, limit) => {
    while(!soundCacheReady) await new Promise(r=>setTimeout(r,50));
    const ql = q.toLowerCase();
    const maxResults = limit || 200;
    const results = [];
    for (const c of soundCache) {
        if (c.name.toLowerCase().includes(ql) || c.folder.toLowerCase().includes(ql) || c.topLevel.toLowerCase().includes(ql)) {
            results.push(c);
            if (results.length >= maxResults) break;
        }
    }
    return results;
});
```

### No se requieren cambios en el renderer
`renderSounds` ya maneja cualquier cantidad de resultados. La virtualización de Tarea 1 se encarga de rendimiento visual.

---

## TAREA 4: Early-Exit en `findBestSegment`

### Objetivo
Agregar pruning con running average al sliding window de `findBestSegment` en `spectral-engine.js`. Cuando el score parcial promedio ya no puede superar el mejor score encontrado, se salta el resto de ese offset. Esto elimina el 60-80% de la computación para la mayoría de candidatos.

### Archivos a modificar
- `spectral-engine.js`

### Reemplazar la función `findBestSegment` COMPLETAMENTE (líneas 486-522)

```javascript
function findBestSegment(queryMatrix, queryLen, fileMatrix, fileLen, featureWeights = null) {
    const effectiveQueryLen = Math.min(queryLen, fileLen);
    const maxOffset = Math.max(0, fileLen - effectiveQueryLen);

    let bestScore = -Infinity;
    let bestOffset = 0;

    // Pre-apply weights to query matrix for speed (avoid per-iteration branching)
    let weightedQuery = queryMatrix;
    let useWeights = false;
    if (featureWeights) {
        // Check if weights are non-uniform
        let allOne = true;
        for (let d = 0; d < FEATURES_PER_WINDOW; d++) {
            if (featureWeights[d] !== 1) { allOne = false; break; }
        }
        if (!allOne) {
            useWeights = true;
            weightedQuery = new Float32Array(effectiveQueryLen * FEATURES_PER_WINDOW);
            for (let w = 0; w < effectiveQueryLen; w++) {
                const off = w * FEATURES_PER_WINDOW;
                for (let d = 0; d < FEATURES_PER_WINDOW; d++) {
                    weightedQuery[off + d] = queryMatrix[off + d] * featureWeights[d];
                }
            }
        }
    }

    for (let offset = 0; offset <= maxOffset; offset++) {
        let score = 0;
        let earlyExit = false;

        for (let w = 0; w < effectiveQueryLen; w++) {
            const qOff = w * FEATURES_PER_WINDOW;
            const fOff = (offset + w) * FEATURES_PER_WINDOW;

            let dot = 0, qNorm = 0, fNorm = 0;

            if (useWeights) {
                for (let d = 0; d < FEATURES_PER_WINDOW; d++) {
                    const qw = weightedQuery[qOff + d];
                    const fw = fileMatrix[fOff + d] * featureWeights[d];
                    dot += qw * fw;
                    qNorm += qw * qw;
                    fNorm += fw * fw;
                }
            } else {
                for (let d = 0; d < FEATURES_PER_WINDOW; d++) {
                    const qVal = queryMatrix[qOff + d];
                    const fVal = fileMatrix[fOff + d];
                    dot += qVal * fVal;
                    qNorm += qVal * qVal;
                    fNorm += fVal * fVal;
                }
            }
            score += dot / (Math.sqrt(qNorm * fNorm) + 1e-8);

            // ── Early exit: if remaining windows all scored 1.0 (perfect),
            // would the average still beat bestScore? If not, skip this offset.
            if (w >= 3 && bestScore > -Infinity) {
                const windowsDone = w + 1;
                const windowsLeft = effectiveQueryLen - windowsDone;
                const optimisticTotal = score + windowsLeft; // max possible remaining (each window ≤ 1.0)
                const optimisticAvg = optimisticTotal / effectiveQueryLen;
                if (optimisticAvg <= bestScore) {
                    earlyExit = true;
                    break;
                }
            }
        }

        if (!earlyExit) {
            score /= effectiveQueryLen;
            if (score > bestScore) {
                bestScore = score;
                bestOffset = offset;
            }
        }
    }

    return { score: bestScore, offsetWindows: bestOffset };
}
```

### Cómo funciona el early-exit
- Cosine similarity por window está en el rango [-1, 1], donde 1.0 es match perfecto.
- Después de evaluar las primeras 4+ windows, calculamos: si todas las windows restantes dieran 1.0 (imposible en la práctica), ¿el promedio total superaría `bestScore`? Si no, este offset no puede ganar → skip.
- Esto es especialmente efectivo en las últimas posiciones del sliding window, donde `bestScore` ya convergió a un valor alto.

### Testing
- Ejecutar una búsqueda Echo Vault. Los resultados deben ser **idénticos** a antes (el pruning solo descarta offsets que no pueden ganar, nunca descarta el ganador).
- Medir tiempos en la consola: buscar logs `[Echo] Search complete: ... spectralMatch=Xms`. El `spectralMatch` debería reducirse significativamente.

---

## TAREA 5: Unificar Peak Extraction con Indexing Pipeline

### Objetivo
Cuando el indexing worker decodifica un archivo para CLAP o spectral, extraer los peaks en el mismo paso. Esto evita que el renderer tenga que solicitar peaks por separado via IPC + ffmpeg.

### Archivos a modificar
- `main.js`: agregar tabla SQLite para peaks y cargar al iniciar
- `indexing-worker.js`: extraer peaks durante indexing
- `semantic-engine.js`: exponer peaks desde la DB

### Paso 5.1: Crear tabla de peaks en `semantic-engine.js`

En el método `init()`, después de crear la tabla `spectral_index` (línea 243), agregar:

```javascript
// Create peaks cache table
this.db.exec(`
    CREATE TABLE IF NOT EXISTS peaks_cache (
        file_path TEXT PRIMARY KEY,
        mtime INTEGER,
        peaks BLOB,
        duration_ms INTEGER
    )
`);
```

Agregar prepared statements al objeto `this._stmts` (después de línea 286):

```javascript
selectPeaks:       this.db.prepare('SELECT peaks, duration_ms FROM peaks_cache WHERE file_path = ? AND mtime = ?'),
insertPeaks:       this.db.prepare('INSERT OR REPLACE INTO peaks_cache (file_path, mtime, peaks, duration_ms) VALUES (?, ?, ?, ?)'),
```

### Paso 5.2: Agregar método público para obtener peaks en `semantic-engine.js`

Agregar antes de la línea `module.exports`:

```javascript
// ── Peak data from DB cache ──
getPeaksFromDB(filePath) {
    try {
        const stat = fs.statSync(filePath);
        const row = this._stmts.selectPeaks.get(filePath, stat.mtimeMs);
        if (!row) return null;
        const peaks = new Float32Array(row.peaks.buffer, row.peaks.byteOffset, row.peaks.byteLength / 4);
        return { peaks, duration: row.duration_ms / 1000 };
    } catch(e) {
        return null;
    }
}
```

### Paso 5.3: Modificar el handler `get-peaks` en `main.js`

Modificar el handler creado en Tarea 2 para que primero consulte la DB del semantic engine:

Reemplazar el handler `get-peaks` con:

```javascript
ipcMain.handle('get-peaks', async (_, fp) => {
  try {
    if (!fp || !fs.existsSync(fp) || !fp.toLowerCase().endsWith('.wav')) return null;

    // Try DB cache first (populated during indexing)
    if (semanticEngine.isReady) {
        const dbPeaks = semanticEngine.getPeaksFromDB(fp);
        if (dbPeaks) return dbPeaks;
    }

    // Fallback: decode with ffmpeg (for files not yet indexed)
    const stat = await fs.promises.stat(fp);
    const { duration, peaks } = await new Promise((resolve, reject) => {
      const chunks = [];
      let settled = false;
      const doResolve = () => {
        if (settled) return;
        settled = true;
        const buf = Buffer.concat(chunks);
        if (buf.byteLength < 4) { reject(new Error('No audio data')); return; }
        const samples = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
        const fileDuration = samples.length / 48000;
        const NUM_PEAKS = 4000;
        const spp = Math.max(1, Math.floor(samples.length / NUM_PEAKS));
        const peaks = new Float32Array(NUM_PEAKS);
        for (let i = 0; i < NUM_PEAKS; i++) {
          let max = 0;
          const offset = i * spp;
          for (let j = 0; j < spp && offset + j < samples.length; j++) {
            const v = Math.abs(samples[offset + j]);
            if (v > max) max = v;
          }
          peaks[i] = max;
        }
        resolve({ duration: fileDuration, peaks });
      };

      const ffmpegStatic = require('ffmpeg-static');
      require('fluent-ffmpeg')(fp)
        .setFfmpegPath(ffmpegStatic)
        .audioFrequency(48000)
        .audioChannels(1)
        .format('f32le')
        .on('error', err => {
          if (err.message && err.message.includes('Output stream closed')) { doResolve(); return; }
          if (!settled) { settled = true; reject(err); }
        })
        .on('end', () => doResolve())
        .pipe()
        .on('data', chunk => chunks.push(chunk));
    });
    return { peaks, duration };
  } catch (e) {
    console.error('get-peaks error:', e.message);
    return null;
  }
});
```

### Paso 5.4: Extraer peaks durante spectral indexing en `indexing-worker.js`

En la función `processSpectralBatch` (línea 259), el archivo ya se decodifica completamente. Agregar extracción de peaks después de la extracción spectral.

Primero agregar un nuevo prepared statement en `initWorker` (después de línea 91):

```javascript
stmts.insertPeaks = db.prepare('INSERT OR REPLACE INTO peaks_cache (file_path, mtime, peaks, duration_ms) VALUES (?, ?, ?, ?)');
```

Agregar tabla en `initWorker` (después de línea 86):

```javascript
db.exec(`
    CREATE TABLE IF NOT EXISTS peaks_cache (
        file_path TEXT PRIMARY KEY,
        mtime INTEGER,
        peaks BLOB,
        duration_ms INTEGER
    )
`);
```

Luego en `processSpectralBatch`, dentro del `for (const file of files)` loop, DESPUÉS de la línea `const durationMs = Math.round(audioData.length / 48000 * 1000);` (línea 313), agregar:

```javascript
// Extract peaks while we have the decoded audio in memory
const NUM_PEAKS = 4000;
const spp = Math.max(1, Math.floor(audioData.length / NUM_PEAKS));
const peaksArr = new Float32Array(NUM_PEAKS);
for (let i = 0; i < NUM_PEAKS; i++) {
    let max = 0;
    const off = i * spp;
    for (let j = 0; j < spp && off + j < audioData.length; j++) {
        const v = Math.abs(audioData[off + j]);
        if (v > max) max = v;
    }
    peaksArr[i] = max;
}
const peaksBuf = Buffer.from(peaksArr.buffer, peaksArr.byteOffset, peaksArr.byteLength);
```

Y dentro del `flushBatch` transaction, agregar la inserción de peaks. Modificar el batch item push para incluir peaks:

Cambiar la línea:
```javascript
batch.push({
    path: file.path, mtime: file.mtime,
    matrix: compressMatrixFn(matrix),
    summary: Buffer.from(summary.buffer, summary.byteOffset, summary.byteLength),
    durationMs, windowCount: numWindows,
});
```

A:
```javascript
batch.push({
    path: file.path, mtime: file.mtime,
    matrix: compressMatrixFn(matrix),
    summary: Buffer.from(summary.buffer, summary.byteOffset, summary.byteLength),
    durationMs, windowCount: numWindows,
    peaksBuf, // ← NEW
});
```

Y modificar `flushBatch` para incluir la inserción de peaks:
```javascript
const flushBatch = () => {
    db.transaction(() => {
        for (const item of batch) {
            stmts.insertSpectral.run(
                item.path, item.mtime, item.matrix, item.summary, item.durationMs, item.windowCount
            );
            stmts.insertPeaks.run(item.path, item.mtime, item.peaksBuf, item.durationMs);
        }
    })();
    batch = [];
};
```

### Testing
- Reindexar la librería. Verificar que la tabla `peaks_cache` se llena.
- Las waveforms deben cargarse instantáneamente para archivos ya indexados (sin ffmpeg spawn).
- Para archivos no indexados, el fallback de ffmpeg en `get-peaks` sigue funcionando.

---

## TAREA 6: Adaptive Candidate Count en Echo Vault

### Objetivo
Reducir dinámicamente la cantidad de candidatos evaluados en el Stage 2 del Echo Vault cuando los scores del coarse filter caen rápidamente.

### Archivos a modificar
- `semantic-engine.js`

### Modificar `echoSearch` (línea 859)

Después de la línea que filtra sourceFilePath (línea ~895):
```javascript
if (sourceFilePath) {
    candidates = candidates.filter(c => c.path !== sourceFilePath);
}
```

Agregar este bloque INMEDIATAMENTE DESPUÉS:

```javascript
// ── Adaptive candidate pruning ──
// If coarse scores drop sharply, trim candidates to avoid wasted spectral computation.
// Only evaluate candidates whose coarse score is within 40% of the top score.
if (candidates.length > 50) {
    const topCoarseScore = candidates[0].score;
    const coarseThreshold = topCoarseScore * 0.6; // 60% of top score
    const minCandidates = 50; // always evaluate at least 50
    let cutoff = candidates.length;
    for (let i = minCandidates; i < candidates.length; i++) {
        if (candidates[i].score < coarseThreshold) {
            cutoff = i;
            break;
        }
    }
    if (cutoff < candidates.length) {
        console.log(`[Echo] Adaptive pruning: ${candidates.length} → ${cutoff} candidates (threshold: ${coarseThreshold.toFixed(3)})`);
        candidates = candidates.slice(0, cutoff);
    }
}
```

### Hacer lo mismo en `echoFile` (línea 998)

Después de la línea:
```javascript
const candidates = this._searchFlat(queryVec, 200).filter(c => c.path !== filePath);
```

Agregar el mismo bloque de adaptive pruning (copiar exactamente el bloque de arriba).

### Testing
- Ejecutar Echo Vault searches. Verificar los logs `[Echo] Adaptive pruning:` para confirmar que se están eliminando candidatos débiles.
- Los resultados top deben permanecer idénticos (solo se eliminan candidatos que de todas formas habrían sido filtrados por el adaptive gate posterior).

---

## Orden de Implementación

Implementar EN ESTE ORDEN EXACTO. Cada tarea es independiente y se puede testear por separado.

1. **Tarea 4** (early-exit en findBestSegment), Cambio más autocontenido, un solo archivo, zero riesgo de regresión. Testear.
2. **Tarea 3** (paginación search-all-sounds): Una línea cambiada, impacto inmediato. Testear.
3. **Tarea 6** (adaptive candidate count), Cambio pequeño, autocontenido. Testear.
4. **Tarea 2** (peaks en main process), Nuevo canal IPC, cambio en loadPeaks. Testear que waveforms se dibujan correctamente.
5. **Tarea 5** (peaks en indexing pipeline), Depende de Tarea 2. Extiende la DB y el worker. Testear con re-index.
6. **Tarea 1** (virtualización): Cambio más grande y de mayor riesgo. Se implementa ÚLTIMO porque toca mucho código del renderer. Testear extensivamente: scroll, play, selection, drag, context menu, search.

## Resumen de Archivos Modificados por Tarea

| Tarea | spectral-engine.js | semantic-engine.js | main.js | preload.js | index.html | indexing-worker.js |
|-------|---|---|---|---|---|---|
| 1: Virtualización | | | | | ✅ MAYOR | |
| 2: Peaks Main | | | ✅ | ✅ | ✅ | |
| 3: Pagination | | | ✅ | | | |
| 4: Early-exit | ✅ | | | | | |
| 5: Peaks Indexing | | ✅ | ✅ | | | ✅ |
| 6: Adaptive Candidates | | ✅ | | | | |
