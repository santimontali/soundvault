(() => {
  'use strict';
  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];
  const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const ACCENT = '#c8f76d';
  const ACCENT_RGB = '200,247,109';

  const soundList = $('#sound-list');
  const searchBox = $('#search-box');
  const semanticToggle = $('#semantic-toggle');
  const playerToggle = $('#player-toggle');
  const playerTime = $('#player-time');
  const playerProgress = $('#player-progress');
  const playerProgressWrap = $('#player-progress-wrap');
  const playerName = $('#player-name');
  const playerVolume = $('#player-volume');
  const playerSelBadge = $('#player-sel-badge');
  const soundCount = $('#sound-count');
  const panelTitle = $('#panel-title');
  const navLabel = $('#nav-label');
  const navDot = $('#nav-dot');
  const ambient = $('#ambient');
  const gtb = $('#sel-toolbar-global');
  const edPanel = $('#editor-panel');
  const echoPlaySelBtn = $('#echo-play-sel');
  let ambG = null, ambW = 0, ambH = 0;

  let currentId = null, isPlaying = false, semanticOn = true, activeColl = null, query = '';
  let selection = null;
  let activeCanvas = null, lastTimeText = '';
  let echoPlaying = false, echoSelOn = false;

  const editor = { open: false, id: null, viewStart: 0, viewEnd: 1, gain: 0, pitch: 0, reversed: false, playing: false };

  const dbToLin = db => Math.pow(10, db / 20);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const fmt = s => { if (!s || isNaN(s) || !isFinite(s)) return '0:00'; return Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0'); };

  /* ───── Perlin 3D ───── */
  const Perlin = (() => {
    const perm = new Uint8Array(512);
    const base = new Uint8Array(256);
    for (let i = 0; i < 256; i++) base[i] = i;
    let s = 1337;
    const rnd = () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
    for (let i = 255; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const t = base[i]; base[i] = base[j]; base[j] = t; }
    for (let i = 0; i < 512; i++) perm[i] = base[i & 255];
    const fade = t => t * t * t * (t * (t * 6 - 15) + 10);
    const lerp = (a, b, t) => a + t * (b - a);
    function grad(h, x, y, z) {
      h &= 15;
      const u = h < 8 ? x : y;
      const v = h < 4 ? y : (h === 12 || h === 14 ? x : z);
      return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v);
    }
    return {
      noise(x, y, z) {
        const X = Math.floor(x) & 255, Y = Math.floor(y) & 255, Z = Math.floor(z) & 255;
        x -= Math.floor(x); y -= Math.floor(y); z -= Math.floor(z);
        const u = fade(x), v = fade(y), w = fade(z);
        const A = perm[X] + Y, AA = perm[A] + Z, AB = perm[A + 1] + Z;
        const B = perm[X + 1] + Y, BA = perm[B] + Z, BB = perm[B + 1] + Z;
        return lerp(
          lerp(lerp(grad(perm[AA], x, y, z), grad(perm[BA], x - 1, y, z), u),
               lerp(grad(perm[AB], x, y - 1, z), grad(perm[BB], x - 1, y - 1, z), u), v),
          lerp(lerp(grad(perm[AA + 1], x, y, z - 1), grad(perm[BA + 1], x - 1, y, z - 1), u),
               lerp(grad(perm[AB + 1], x, y - 1, z - 1), grad(perm[BB + 1], x - 1, y - 1, z - 1), u), v), w);
      },
    };
  })();

  /* ───── Particle field (single color, mouse + audio reactive) ───── */
  let waveP = [], depthP = [], zOffset = 0, energy = 0;
  let targetPos = { x: -9999, y: -9999 }, smoothPos = { x: -9999, y: -9999 };

  function initParticles() {
    if (!ambW) return;
    const narrow = ambW < 720;
    const spacing = narrow ? 26 : 18;
    const rows = narrow ? 7 : 10;
    const cols = Math.ceil(ambW / spacing);
    waveP = [];
    for (let c = 0; c < cols; c++) {
      for (let r = 0; r < rows; r++) {
        const baseX = c * spacing + spacing / 2;
        const baseY = ambH / 2 + (r - rows / 2) * spacing;
        waveP.push({ x: baseX, y: baseY, baseX, baseY, density: 8 + Math.random() * 12 });
      }
    }
    depthP = [];
    const dn = narrow ? 16 : 28;
    for (let i = 0; i < dn; i++) {
      const z = Math.random() * 0.8 + 0.2;
      depthP.push({ x: Math.random() * ambW, y: Math.random() * ambH, z, speed: z * 0.25, size: (1 - z) * 1.6 + 0.5, alpha: 0.05 + z * 0.12 });
    }
  }

  function fitAmbient() {
    if (!ambient) return;
    ambG = fit(ambient); ambW = ambient.clientWidth; ambH = ambient.clientHeight;
    initParticles();
  }

  function drawAmbient() {
    if (!ambG || !ambW || !waveP.length) return;
    const g = ambG; const d = dpr(); g.setTransform(d, 0, 0, d, 0, 0); g.clearRect(0, 0, ambW, ambH);
    energy += (((isPlaying || echoPlaying) ? 1 : 0) - energy) * 0.07;
    zOffset += 0.0035;
    smoothPos.x += (targetPos.x - smoothPos.x) * 0.12;
    smoothPos.y += (targetPos.y - smoothPos.y) * 0.12;

    for (let i = 0; i < depthP.length; i++) {
      const dp = depthP[i];
      dp.y += dp.speed; dp.x += Math.sin(zOffset * 0.8 + dp.z * 10) * 0.3;
      if (dp.y > ambH + 10) dp.y = -10;
      if (dp.x > ambW + 10) dp.x = -10; else if (dp.x < -10) dp.x = ambW + 10;
      g.beginPath(); g.arc(dp.x, dp.y, dp.size, 0, Math.PI * 2);
      g.fillStyle = `rgba(${ACCENT_RGB},${dp.alpha.toFixed(3)})`; g.fill();
    }

    const landH = 52 + energy * 46;
    const ns = 0.0019;
    for (let i = 0; i < waveP.length; i++) {
      const p = waveP[i];
      const nv = Perlin.noise(p.baseX * ns, p.baseY * ns, zOffset);
      const n01 = nv * 0.5 + 0.5;
      const targetY = p.baseY + nv * landH;
      let fx = -(p.x - p.baseX) / 12;
      let fy = -(p.y - targetY) / 12;
      const mdx = smoothPos.x - p.x, mdy = smoothPos.y - p.y;
      const md = Math.sqrt(mdx * mdx + mdy * mdy);
      const rad = 130;
      if (md < rad && md > 0.001) {
        const mf = (rad - md) / rad;
        fx -= (mdx / md) * mf * p.density * 0.9;
        fy -= (mdy / md) * mf * p.density * 0.9;
      }
      p.x += fx; p.y += fy;
      const size = 1.0 + n01 * 1.1 + energy * 0.5;
      const alpha = 0.08 + n01 * 0.42 + energy * 0.12;
      g.beginPath(); g.arc(p.x, p.y, size, 0, Math.PI * 2);
      g.fillStyle = `rgba(${ACCENT_RGB},${alpha.toFixed(3)})`; g.fill();
    }
  }

  if (ambient) {
    window.addEventListener('mousemove', e => {
      const r = ambient.getBoundingClientRect();
      targetPos = { x: e.clientX - r.left, y: e.clientY - r.top };
    }, { passive: true });
    window.addEventListener('touchmove', e => {
      if (!e.touches.length) return;
      const r = ambient.getBoundingClientRect();
      targetPos = { x: e.touches[0].clientX - r.left, y: e.touches[0].clientY - r.top };
    }, { passive: true });
  }

  /* ───── canvas helpers ───── */
  function dpr() { return Math.min(2, window.devicePixelRatio || 1); }
  function fit(c) {
    const d = dpr(); const r = c.getBoundingClientRect();
    c.width = Math.max(1, Math.round(r.width * d)); c.height = Math.max(1, Math.round(r.height * d));
    const g = c.getContext('2d'); g.setTransform(d, 0, 0, d, 0, 0); return g;
  }
  function rr(g, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
  }
  function drawWave(c, peaks, o) {
    o = o || {};
    const g = c.getContext('2d'); const w = c.clientWidth, h = c.clientHeight;
    g.setTransform(dpr(), 0, 0, dpr(), 0, 0); g.clearRect(0, 0, w, h);
    if (!peaks || !peaks.length) return;
    const n = peaks.length, slot = w / n, bw = Math.max(1, slot - (slot > 3 ? 1 : 0.4)), mid = h / 2;
    const prog = o.progress != null ? o.progress : -1;
    for (let i = 0; i < n; i++) {
      const bh = Math.max(1.5, peaks[i] * (h - 4)), x = i * slot;
      g.fillStyle = (prog >= 0 && i / n <= prog) ? (o.played || ACCENT) : (o.dim || 'rgba(224,221,213,.20)');
      rr(g, x, mid - bh / 2, bw, bh, Math.min(1.5, bw / 2)); g.fill();
    }
    if (o.highlight) {
      const [a, b] = o.highlight;
      g.fillStyle = `rgba(${ACCENT_RGB},.14)`; g.fillRect(a * w, 0, (b - a) * w, h);
      g.strokeStyle = `rgba(${ACCENT_RGB},.6)`; g.strokeRect(a * w + .5, .5, Math.max(1, (b - a) * w - 1), h - 1);
    }
    if (prog >= 0) { g.fillStyle = '#e0ddd5'; g.fillRect(prog * w - 0.5, 0, 1, h); }
  }
  function drawErrorLine(c) {
    const g = fit(c); const w = c.clientWidth, h = c.clientHeight;
    g.strokeStyle = 'rgba(226,75,74,.5)'; g.setLineDash([4, 4]); g.beginPath(); g.moveTo(0, h / 2); g.lineTo(w, h / 2); g.stroke();
  }
  function peakAt(peaks, frac) {
    if (!peaks || !peaks.length) return 0;
    const x = clamp(frac, 0, 1) * (peaks.length - 1), i = Math.floor(x), f = x - i;
    return peaks[i] * (1 - f) + (peaks[Math.min(i + 1, peaks.length - 1)] || 0) * f;
  }

  const PLAY_ICON = '<svg width="11" height="12" viewBox="0 0 12 14" aria-hidden="true"><polygon points="2.5,0 12,7 2.5,14" class="play-icon"/></svg>';
  const PAUSE_ICON = '<svg width="11" height="12" viewBox="0 0 12 14" aria-hidden="true"><rect x="1.5" y="0" width="3.2" height="14" rx="1" class="play-icon"/><rect x="7.3" y="0" width="3.2" height="14" rx="1" class="play-icon"/></svg>';
  const PLAYER_PLAY = '<svg width="18" height="18" viewBox="0 0 16 16" aria-hidden="true"><polygon points="3,1 13,8 3,15" style="fill:var(--accent)"/></svg>';
  const PLAYER_PAUSE = '<svg width="18" height="18" viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="2" width="3.5" height="12" rx="1" style="fill:var(--accent)"/><rect x="9.5" y="2" width="3.5" height="12" rx="1" style="fill:var(--accent)"/></svg>';
  const GRIP = '<svg class="full-drag" width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true"><circle cx="4.5" cy="3" r="1.2"/><circle cx="9.5" cy="3" r="1.2"/><circle cx="4.5" cy="7" r="1.2"/><circle cx="9.5" cy="7" r="1.2"/><circle cx="4.5" cy="11" r="1.2"/><circle cx="9.5" cy="11" r="1.2"/></svg>';

  function scoreSound(s, tokens) {
    if (!tokens.length) return 1;
    const hay = (s.name + ' ' + s.tags.join(' ') + ' ' + s.cat).toLowerCase();
    let hit = 0; for (const t of tokens) if (hay.includes(t)) hit++; return hit / tokens.length;
  }
  function semanticIds(tokens) {
    const set = new Set();
    for (const key in SEMANTIC_MAP) {
      const keys = key.split(',');
      if (tokens.some(t => keys.some(k => k.includes(t) || t.includes(k)))) SEMANTIC_MAP[key].forEach(id => set.add(id));
    }
    return set;
  }

  function rowHTML(s) {
    const playing = isPlaying && currentId === s.id;
    const sel = selection && selection.id === s.id;
    return `<div class="sound-item${playing ? ' playing' : ''}${sel ? ' selected' : ''}" data-id="${s.id}">
      <button class="play-btn" data-play="${s.id}" aria-label="Reproducir ${s.name}">${playing ? PAUSE_ICON : PLAY_ICON}</button>
      <div class="sound-info"><div class="sound-name"><span class="sn-text">${s.name}</span></div><div class="sound-meta">—</div></div>
      <div class="waveform-container" data-wf="${s.id}"><canvas></canvas><div class="sel-overlay"></div></div>
      ${GRIP}</div>`;
  }

  function getFiltered() {
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    const semIds = (semanticOn && tokens.length) ? semanticIds(tokens) : new Set();
    let list = SOUNDS.map(s => {
      let score = scoreSound(s, tokens); const sem = semIds.has(s.id);
      if (sem && tokens.length) score = Math.max(score, 0.92);
      return { s, score, sem };
    });
    if (activeColl) { const ids = COLLS.find(c => c.id === activeColl).ids; list = list.filter(x => ids.includes(x.s.id)); }
    if (tokens.length) { list = list.filter(x => x.score > 0 || x.sem); if (semanticOn) list.sort((a, b) => b.score - a.score); }
    return { list, tokens };
  }

  function drawRowWave(s) {
    const c = soundList.querySelector(`[data-wf="${s.id}"] canvas`); if (!c) return;
    const p = AudioEngine.getPeaks(s.id);
    if (p) { fit(c); drawWave(c, p, { progress: (isPlaying && currentId === s.id) ? lastFileFrac() : -1 }); }
    else drawErrorLine(c);
  }
  function updateRowMeta(s, err) {
    const m = soundList.querySelector(`.sound-item[data-id="${s.id}"] .sound-meta`); if (!m) return;
    if (err) { m.textContent = 'could not load'; return; }
    const d = AudioEngine.getDuration(s.id);
    m.textContent = (d ? fmt(d) : '—') + ' · 48kHz · ogg';
  }

  function renderSoundList() {
    const { list } = getFiltered();
    if (!list.length) {
      soundList.innerHTML = '';
      const empty = document.createElement('div'); empty.className = 'empty-state';
      const l1 = document.createElement('div'); l1.textContent = `No results for "${query}".`;
      const l2 = document.createElement('span'); l2.className = 'mono'; l2.textContent = 'try another word — or toggle semantic search';
      empty.appendChild(l1); empty.appendChild(l2); soundList.appendChild(empty);
    } else {
      soundList.innerHTML = list.map(({ s }) => rowHTML(s)).join('');
    }
    soundCount.textContent = `· ${list.length} ${list.length === 1 ? 'sound' : 'sounds'}`;
    activeCanvas = null;
    requestAnimationFrame(() => {
      list.forEach(({ s }) => { drawRowWave(s); updateRowMeta(s, !AudioEngine.isLoaded(s.id) && contentReady); });
      if (selection) { if (soundList.querySelector(`.sound-item[data-id="${selection.id}"]`)) { updateSelOverlay(); positionGtb(); } else gtb.classList.remove('visible'); }
    });
    bindRows();
  }

  function bindRows() {
    $$('#sound-list .play-btn').forEach(btn => btn.addEventListener('click', e => { e.stopPropagation(); togglePlay(btn.dataset.play); }));
    $$('#sound-list .waveform-container').forEach(wf => {
      const id = wf.dataset.wf, canvas = wf.querySelector('canvas'), overlay = wf.querySelector('.sel-overlay');
      let down = false, moved = false, startX = 0;
      const reset = () => { down = false; moved = false; };
      wf.addEventListener('pointerdown', e => { if (!e.isPrimary || e.button !== 0) return; down = true; moved = false; startX = e.clientX; wf.setPointerCapture(e.pointerId); });
      wf.addEventListener('pointermove', e => {
        if (!down) return;
        if (Math.abs(e.clientX - startX) > 4) moved = true;
        if (moved) {
          const r = canvas.getBoundingClientRect();
          const a = clamp((startX - r.left) / r.width, 0, 1), b = clamp((e.clientX - r.left) / r.width, 0, 1);
          overlay.style.display = 'block'; overlay.style.left = (Math.min(a, b) * 100) + '%'; overlay.style.width = (Math.abs(b - a) * 100) + '%';
        }
      });
      wf.addEventListener('pointerup', e => {
        if (!down) return; reset();
        if (!moved) { overlay.style.display = 'none'; clearSelection(); const r = canvas.getBoundingClientRect(); seekPlay(id, clamp((e.clientX - r.left) / r.width, 0, 1)); }
        else { const left = parseFloat(overlay.style.left) / 100, width = parseFloat(overlay.style.width) / 100; setSelection(id, left, left + width); }
      });
      wf.addEventListener('pointercancel', () => { reset(); overlay.style.display = 'none'; });
    });
  }

  function setSelection(id, a, b) {
    a = clamp(a, 0, 1); b = clamp(b, 0, 1); if (b - a < 0.01) b = Math.min(1, a + 0.01);
    const span = b - a, pad = Math.min(0.05, span * 0.25);
    selection = { id, a, b, fi: a + pad, fo: b - pad };
    if (editor.open && editor.id !== id) closeEditor();
    updateSelOverlay(); updateSelBadge(); positionGtb();
    requestAnimationFrame(() => requestAnimationFrame(positionGtb));
    if (editor.open && editor.id === id) drawEditor();
  }
  function clearSelection() {
    selection = null; gtb.classList.remove('visible');
    $$('#sound-list .sel-overlay').forEach(o => o.style.display = 'none');
    $$('#sound-list .sound-item').forEach(r => r.classList.remove('selected'));
    updateSelBadge(); if (editor.open) closeEditor();
  }
  function updateSelOverlay() {
    $$('#sound-list .sound-item').forEach(row => {
      const ov = row.querySelector('.sel-overlay'); if (!ov) return;
      const on = selection && row.dataset.id === selection.id;
      row.classList.toggle('selected', !!on);
      if (on) { ov.style.display = 'block'; ov.style.left = (selection.a * 100) + '%'; ov.style.width = ((selection.b - selection.a) * 100) + '%'; }
      else ov.style.display = 'none';
    });
  }
  function updateSelBadge() { playerSelBadge.classList.toggle('visible', !!(selection && isPlaying && currentId === selection.id)); }

  function positionGtb() {
    if (!selection) { gtb.classList.remove('visible'); return; }
    const wf = soundList.querySelector(`[data-wf="${selection.id}"]`);
    if (!wf) { gtb.classList.remove('visible'); return; }
    const rect = wf.getBoundingClientRect(), listRect = soundList.getBoundingClientRect();
    if (rect.bottom < listRect.top || rect.top > listRect.bottom || listRect.bottom < 0 || listRect.top > window.innerHeight) { gtb.classList.remove('visible'); return; }
    gtb.classList.add('visible');
    const midX = rect.left + rect.width * ((selection.a + selection.b) / 2);
    const tbW = gtb.offsetWidth || 140;
    gtb.style.left = clamp(midX - tbW / 2, 4, window.innerWidth - tbW - 4) + 'px';
    gtb.style.top = clamp(rect.top - 34, 4, window.innerHeight - 40) + 'px';
  }
  soundList.addEventListener('scroll', positionGtb, { passive: true });
  window.addEventListener('scroll', positionGtb, { passive: true });

  function lastFileFrac() {
    if (!AudioEngine.active) return 0;
    const p = AudioEngine.position();
    if (AudioEngine.active.mode === 'rel' && selection && AudioEngine.active.id === selection.id) return selection.a + p * (selection.b - selection.a);
    return p;
  }

  function finishPlayback() {
    const id = currentId;
    isPlaying = false; editor.playing = false;
    updatePlayingUI(); updateEditorPlayBtn(); setGtbPlayIcon(false);
    playerProgress.style.transform = 'scaleX(0)'; $('#editor-playhead').classList.remove('active');
    if (id) { const s = SOUNDS.find(x => x.id === id); if (s) drawRowWave(s); const d = AudioEngine.getDuration(id); playerTime.textContent = fmt(d) + ' / ' + fmt(d); }
    activeCanvas = null; updateSelBadge();
  }

  function startAbs(id, offset) {
    const s = SOUNDS.find(x => x.id === id); if (!s) return;
    stopEchoAll();
    if (!AudioEngine.isLoaded(id)) { AudioEngine.load(id, s.ogg).then(() => { if (AudioEngine.isLoaded(id)) { drawRowWave(s); updateRowMeta(s); startAbs(id, offset); } }); return; }
    AudioEngine.play(id, { offset, loop: false, mode: 'abs', onend: finishPlayback });
    currentId = id; isPlaying = true; editor.playing = false; playerName.textContent = s.name;
    updatePlayingUI(); updateEditorPlayBtn(); setGtbPlayIcon(false); $('#editor-playhead').classList.remove('active');
    activeCanvas = soundList.querySelector(`[data-wf="${id}"] canvas`); lastTimeText = '';
  }

  function startRel(id, a, b, fiDur, foDur, useEd) {
    const s = SOUNDS.find(x => x.id === id); if (!s) return;
    stopEchoAll();
    if (!AudioEngine.isLoaded(id)) { AudioEngine.load(id, s.ogg).then(() => { if (AudioEngine.isLoaded(id)) { drawRowWave(s); updateRowMeta(s); startRel(id, a, b, fiDur, foDur, useEd); } }); return; }
    const dur = AudioEngine.getDuration(id);
    const gain = useEd ? dbToLin(editor.gain) : 1, rate = useEd ? Math.pow(2, editor.pitch / 12) : 1, rev = useEd ? editor.reversed : false;
    AudioEngine.play(id, { start: a * dur, end: b * dur, fadeIn: fiDur * dur, fadeOut: foDur * dur, gain, rate, reverse: rev, mode: 'rel', onend: useEd ? finishPlayback : (() => { isPlaying = false; updatePlayingUI(); setGtbPlayIcon(false); updateSelBadge(); playerProgress.style.transform = 'scaleX(0)'; activeCanvas = null; if (s) drawRowWave(s); }) });
    currentId = id; isPlaying = true; editor.playing = useEd; playerName.textContent = s.name;
    updatePlayingUI(); updateEditorPlayBtn(); setGtbPlayIcon(true); if (!useEd) $('#editor-playhead').classList.remove('active');
    activeCanvas = soundList.querySelector(`[data-wf="${id}"] canvas`); lastTimeText = '';
  }

  function togglePlay(id) { if (currentId === id && isPlaying) { AudioEngine.stop(); finishPlayback(); } else startAbs(id, 0); }
  function seekPlay(id, frac) {
    const s = SOUNDS.find(x => x.id === id);
    if (!AudioEngine.isLoaded(id)) { if (s) AudioEngine.load(id, s.ogg).then(() => { if (AudioEngine.isLoaded(id)) { drawRowWave(s); updateRowMeta(s); startAbs(id, frac * AudioEngine.getDuration(id)); } }); return; }
    startAbs(id, frac * AudioEngine.getDuration(id));
  }
  function setGtbPlayIcon(on) { const b = $('#gtb-play'); if (b) b.innerHTML = on ? '<svg viewBox="0 0 12 14"><rect x="1" y="0" width="3.5" height="14" rx="1" fill="currentColor"/><rect x="7.5" y="0" width="3.5" height="14" rx="1" fill="currentColor"/></svg>' : '<svg viewBox="0 0 12 14"><polygon points="1,0 11,7 1,14" fill="currentColor" stroke="none"/></svg>'; }

  function updatePlayingUI() {
    playerToggle.innerHTML = isPlaying ? PLAYER_PAUSE : PLAYER_PLAY;
    $$('#sound-list .sound-item').forEach(row => {
      const on = isPlaying && row.dataset.id === currentId;
      row.classList.toggle('playing', on);
      const b = row.querySelector('.play-btn');
      if (b) { b.innerHTML = on ? PAUSE_ICON : PLAY_ICON; b.setAttribute('aria-label', (on ? 'Pausar ' : 'Reproducir ') + (row.querySelector('.sn-text')?.textContent || '').trim()); }
    });
  }

  playerToggle.addEventListener('click', () => {
    if (isPlaying) { AudioEngine.stop(); finishPlayback(); }
    else if (currentId) startAbs(currentId, 0);
    else { const f = getFiltered().list[0]; if (f) startAbs(f.s.id, 0); }
  });
  playerProgressWrap.addEventListener('click', e => { if (!currentId) return; const r = playerProgressWrap.getBoundingClientRect(); startAbs(currentId, clamp((e.clientX - r.left) / r.width, 0, 1) * AudioEngine.getDuration(currentId)); });
  playerVolume.addEventListener('input', () => AudioEngine.setVolume(parseFloat(playerVolume.value)));

  let searchT = null;
  searchBox.addEventListener('input', () => { clearTimeout(searchT); searchT = setTimeout(() => { query = searchBox.value.trim(); renderSoundList(); }, 120); });
  document.addEventListener('keydown', e => {
    if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey && document.activeElement !== searchBox) { e.preventDefault(); searchBox.focus(); searchBox.select(); }
    if (e.key === 'Escape') { if (editor.open) { closeEditor(); return; } if (document.activeElement === searchBox) { searchBox.value = ''; query = ''; renderSoundList(); searchBox.blur(); } }
  });
  semanticToggle.addEventListener('click', () => { semanticOn = !semanticOn; semanticToggle.classList.toggle('active', semanticOn); semanticToggle.setAttribute('aria-pressed', String(semanticOn)); renderSoundList(); });

  function renderCollections() {
    $('#col-list').innerHTML = COLLS.map(c => `<button class="col-item${activeColl === c.id ? ' active' : ''}" data-coll="${c.id}"><span class="col-color-dot" style="background:${c.color}"></span>${c.name}<span class="item-count">${c.ids.length}</span></button>`).join('');
    $$('#col-list .col-item').forEach(el => el.addEventListener('click', () => {
      activeColl = activeColl === el.dataset.coll ? null : el.dataset.coll;
      const c = COLLS.find(x => x.id === activeColl);
      panelTitle.textContent = c ? c.name : 'All sounds'; navLabel.textContent = c ? c.name : 'Main Vault'; navDot.style.background = c ? c.color : ACCENT;
      renderCollections(); renderSoundList();
    }));
  }
  $('#sidebar-nav-btn').addEventListener('click', function () { this.classList.toggle('open'); });
  $('#sidebar-toggle').addEventListener('click', () => $('#sidebar').classList.toggle('collapsed'));
  $('#refresh-btn').addEventListener('click', () => renderSoundList());

  const logoWord = $('#logo-word'); let logoState = 'VAULT';
  $('#logo-interactive').addEventListener('click', () => {
    logoWord.classList.add('swap-out');
    setTimeout(() => { logoState = logoState === 'VAULT' ? 'SOUND' : 'VAULT'; logoWord.textContent = logoState; logoWord.classList.remove('swap-out'); logoWord.classList.add('swap-in'); setTimeout(() => logoWord.classList.remove('swap-in'), 320); }, 160);
  });

  /* ───── Selection toolbar ───── */
  $('#gtb-play').addEventListener('click', () => {
    if (!selection) return;
    if (isPlaying && currentId === selection.id && AudioEngine.active && AudioEngine.active.mode === 'rel') { AudioEngine.stop(); finishPlayback(); return; }
    const useEd = editor.open && editor.id === selection.id;
    startRel(selection.id, selection.a, selection.b, selection.fi - selection.a, selection.b - selection.fo, useEd);
  });
  $('#gtb-edit').addEventListener('click', () => { if (selection) { editor.open ? closeEditor() : openEditor(selection.id); } });
  $('#gtb-clear').addEventListener('click', clearSelection);
  $('#gtb-echo').addEventListener('click', () => {
    if (!selection) return;
    document.getElementById('echo').scrollIntoView({ behavior: REDUCED ? 'auto' : 'smooth' });
    const src = SOUNDS.find(s => s.id === ECHO_SOURCE_ID);
    if (src) { sel = [selection.a, selection.b]; echoPeaks = AudioEngine.getPeaks(ECHO_SOURCE_ID) || echoPeaks; drawEcho(); updateEchoSelBtn(); runEchoSearch(); }
  });

  /* ───── Editor ───── */
  function toScreen(f) { return clamp(((f - editor.viewStart) / (editor.viewEnd - editor.viewStart)) * 100, -20, 120); }
  function edFileFromX(clientX) { const r = $('#editor-waveform-wrap').getBoundingClientRect(); return clamp(editor.viewStart + ((clientX - r.left) / r.width) * (editor.viewEnd - editor.viewStart), 0, 1); }

  function openEditor(id) {
    const s = SOUNDS.find(x => x.id === id); if (!s) return;
    if (!AudioEngine.isLoaded(id)) { AudioEngine.load(id, s.ogg).then(() => { if (AudioEngine.isLoaded(id)) openEditor(id); }); return; }
    editor.id = id; editor.open = true; editor.viewStart = 0; editor.viewEnd = 1; editor.reversed = false; editor.gain = 0; editor.pitch = 0; editor.playing = false;
    if (!selection || selection.id !== id) setSelection(id, 0, 1);
    $('#editor-title').textContent = s.name;
    $('#ed-gain-slider').value = 0; $('#ed-gain-val').textContent = '0 dB'; $('#ed-gain-overlay').textContent = '0 dB';
    $('#ed-pitch-slider').value = 0; $('#ed-pitch-val').textContent = '0.00 st';
    $('#ed-ctrl-rev').classList.remove('active'); $('#ed-ctrl-cut').classList.remove('active');
    $('#gtb-edit').classList.add('active');
    edPanel.classList.add('visible');
    requestAnimationFrame(() => { centerEditor(); drawMinimap(); drawEditor(); updateEditorPlayBtn(); });
  }
  function closeEditor() {
    if (!editor.open) return;
    const wasPlaying = editor.playing;
    if (wasPlaying) AudioEngine.stop();
    editor.open = false; editor.playing = false;
    edPanel.classList.remove('visible'); $('#gtb-edit').classList.remove('active');
    $('#editor-playhead').classList.remove('active'); updateEditorPlayBtn();
    if (wasPlaying) finishPlayback();
  }
  function centerEditor() { edPanel.style.left = '50%'; edPanel.style.top = '50%'; edPanel.style.transform = 'translate(-50%, -50%)'; }
  function updateEditorPlayBtn() {
    const b = $('#editor-play-btn'); if (!b) return;
    b.classList.toggle('playing', editor.playing);
    b.innerHTML = editor.playing ? '<svg width="10" height="12" viewBox="0 0 12 14"><rect x="2" y="0" width="3" height="14" rx="1" class="ed-play-icon" style="fill:var(--accent)"/><rect x="7" y="0" width="3" height="14" rx="1" class="ed-play-icon" style="fill:var(--accent)"/></svg>' : '<svg width="10" height="12" viewBox="0 0 12 14"><polygon class="ed-play-icon" points="2,0 12,7 2,14" style="fill:var(--accent)"/></svg>';
  }
  function drawEditor() {
    if (!editor.open || !selection) return;
    const c = $('#editor-canvas'); const g = fit(c); const w = c.clientWidth, h = c.clientHeight;
    const peaks = AudioEngine.getPeaks(editor.id); if (!peaks) return;
    const { a, b, fi, fo } = selection, mid = h / 2; g.clearRect(0, 0, w, h);
    for (let x = 0; x < w; x++) {
      const f = editor.viewStart + (x / w) * (editor.viewEnd - editor.viewStart);
      const pk = peakAt(peaks, f), bh = Math.max(1.5, pk * (h - 6));
      g.fillStyle = 'rgba(224,221,213,.22)'; rr(g, x, mid - bh / 2, 1.4, bh, 0.7); g.fill();
      if (f >= a && f <= b) {
        let v = 1; if (f < fi) v = (fi - a) > 0.0001 ? (f - a) / (fi - a) : 1; if (f > fo) v = Math.min(v, (b - fo) > 0.0001 ? (b - f) / (b - fo) : 1);
        const eh = Math.max(1.5, bh * v); g.fillStyle = ACCENT; rr(g, x, mid - eh / 2, 1.4, eh, 0.7); g.fill();
      }
    }
    const L = toScreen(a), R = toScreen(b), FI = toScreen(fi), FO = toScreen(fo);
    $('#ed-crop-left-region').style.width = Math.max(0, L) + '%';
    $('#ed-crop-right-region').style.width = Math.max(0, 100 - R) + '%';
    $('#ed-crop-start-handle').style.left = L + '%'; $('#ed-crop-end-handle').style.left = R + '%';
    $('#ed-fi-handle').style.left = FI + '%'; $('#ed-fo-handle').style.left = FO + '%';
    const fir = $('#ed-fi-region'); fir.style.left = L + '%'; fir.style.width = Math.max(0, FI - L) + '%';
    const forr = $('#ed-fo-region'); forr.style.left = FO + '%'; forr.style.width = Math.max(0, R - FO) + '%';
    const dur = AudioEngine.getDuration(editor.id);
    $('#ed-t-start').textContent = fmt(a * dur); $('#ed-t-end').textContent = fmt(b * dur); $('#ed-t-mid').textContent = fmt((a + b) / 2 * dur);
    $('#ed-minimap-viewport').style.left = (editor.viewStart * 100) + '%'; $('#ed-minimap-viewport').style.width = ((editor.viewEnd - editor.viewStart) * 100) + '%';
    $('#ed-minimap-overlay-left').style.width = (editor.viewStart * 100) + '%'; $('#ed-minimap-overlay-right').style.width = ((1 - editor.viewEnd) * 100) + '%';
    const rd = (b - a) * dur; $('#editor-time-display').textContent = fmt(0) + ' / ' + fmt(rd);
  }
  function drawMinimap() {
    const c = $('#ed-minimap-canvas'); const g = fit(c); const w = c.clientWidth, h = c.clientHeight;
    const peaks = AudioEngine.getPeaks(editor.id); if (!peaks) return;
    g.clearRect(0, 0, w, h); const n = peaks.length, slot = w / n, mid = h / 2; g.fillStyle = 'rgba(200,247,109,.5)';
    for (let i = 0; i < n; i++) { const bh = Math.max(1, peaks[i] * (h - 2)); g.fillRect(i * slot, mid - bh / 2, Math.max(1, slot - 0.5), bh); }
  }
  function edHandleDrag(el, kind) {
    el.addEventListener('pointerdown', e => {
      if (e.button !== 0) return; e.preventDefault(); el.setPointerCapture(e.pointerId); el.classList.add('dragging');
      const move = ev => {
        const f = edFileFromX(ev.clientX);
        if (kind === 'cs') { selection.a = clamp(f, 0, selection.b - 0.002); selection.fi = clamp(selection.fi, selection.a, selection.fo); }
        else if (kind === 'ce') { selection.b = clamp(f, selection.a + 0.002, 1); selection.fo = clamp(selection.fo, selection.fi, selection.b); }
        else if (kind === 'fi') { selection.fi = clamp(f, selection.a, selection.fo); }
        else if (kind === 'fo') { selection.fo = clamp(f, selection.fi, selection.b); }
        drawEditor(); updateSelOverlay(); positionGtb();
      };
      const up = () => { el.classList.remove('dragging'); el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); };
      el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
    });
  }
  edHandleDrag($('#ed-crop-start-handle'), 'cs'); edHandleDrag($('#ed-crop-end-handle'), 'ce');
  edHandleDrag($('#ed-fi-handle'), 'fi'); edHandleDrag($('#ed-fo-handle'), 'fo');
  $('#editor-waveform-wrap').addEventListener('wheel', e => {
    if (!editor.open) return; e.preventDefault();
    editor.gain = clamp(editor.gain - Math.sign(e.deltaY) * 0.5, -24, 12);
    const t = editor.gain.toFixed(1).replace('.0', '') + ' dB'; $('#ed-gain-slider').value = editor.gain; $('#ed-gain-val').textContent = t; $('#ed-gain-overlay').textContent = t;
  }, { passive: false });
  $('#ed-gain-slider').addEventListener('input', e => { editor.gain = parseFloat(e.target.value); const t = editor.gain.toFixed(1).replace('.0', '') + ' dB'; $('#ed-gain-val').textContent = t; $('#ed-gain-overlay').textContent = t; });
  $('#ed-pitch-slider').addEventListener('input', e => { editor.pitch = parseFloat(e.target.value); $('#ed-pitch-val').textContent = editor.pitch.toFixed(2) + ' st'; });
  function toggleRev() { editor.reversed = !editor.reversed; $('#ed-ctrl-rev').classList.toggle('active', editor.reversed); }
  function toggleCut() {
    const on = $('#ed-ctrl-cut').classList.toggle('active');
    if (on && selection) { editor.viewStart = selection.a; editor.viewEnd = selection.b; } else { editor.viewStart = 0; editor.viewEnd = 1; }
    drawEditor();
  }
  $('#ed-ctrl-rev').addEventListener('click', toggleRev);
  $('#ed-ctrl-rev').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleRev(); } });
  $('#ed-ctrl-cut').addEventListener('click', toggleCut);
  $('#ed-ctrl-cut').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleCut(); } });
  $('#editor-close').addEventListener('click', closeEditor);
  $('#editor-play-btn').addEventListener('click', () => {
    if (!selection) return;
    if (editor.playing) { AudioEngine.stop(); finishPlayback(); return; }
    startRel(selection.id, selection.a, selection.b, selection.fi - selection.a, selection.b - selection.fo, true);
  });
  (() => {
    const hdr = $('#editor-header'); let drag = false, ox = 0, oy = 0;
    hdr.addEventListener('pointerdown', e => {
      if (e.target.closest('#editor-close')) return;
      drag = true; hdr.setPointerCapture(e.pointerId);
      const r = edPanel.getBoundingClientRect();
      edPanel.style.transform = 'none'; edPanel.style.left = r.left + 'px'; edPanel.style.top = r.top + 'px';
      ox = e.clientX - r.left; oy = e.clientY - r.top;
    });
    hdr.addEventListener('pointermove', e => { if (!drag) return; edPanel.style.left = clamp(e.clientX - ox, 4, window.innerWidth - edPanel.offsetWidth - 4) + 'px'; edPanel.style.top = clamp(e.clientY - oy, 4, window.innerHeight - 60) + 'px'; });
    hdr.addEventListener('pointerup', () => { drag = false; });
    hdr.addEventListener('pointercancel', () => { drag = false; });
  })();

  /* ───── Echo Vault (real source + real echoes) ───── */
  const echoC = $('#echoCanvas'); const echoStatus = $('#echoStatus');
  let echoPeaks = null, lastEchoSet = 0;
  let sel = null, eDragging = false, eMoved = false, eStart = 0, echoGen = 0, echoTimers = [];

  function drawEcho(progress) {
    if (!echoPeaks) echoPeaks = AudioEngine.getPeaks(ECHO_SOURCE_ID);
    drawWave(echoC, echoPeaks || [], { dim: 'rgba(224,221,213,.22)', highlight: sel, progress: progress != null ? progress : -1 });
    drawEchoZones();
  }
  function drawEchoZones() {
    const g = echoC.getContext('2d'), w = echoC.clientWidth, h = echoC.clientHeight;
    g.setTransform(dpr(), 0, 0, dpr(), 0, 0); g.save(); g.strokeStyle = 'rgba(200,247,109,.15)'; g.lineWidth = 1; g.setLineDash([3, 5]);
    ECHO_ZONES.forEach(z => { const x = z * w; g.beginPath(); g.moveTo(x, 4); g.lineTo(x, h - 4); g.stroke(); }); g.restore();
  }
  function echoFrac(e) { const r = echoC.getBoundingClientRect(); return clamp((e.clientX - r.left) / r.width, 0, 1); }
  function clearEchoTimers() { echoTimers.forEach(clearTimeout); echoTimers = []; }
  function updateEchoSelBtn() {
    if (!echoPlaySelBtn) return;
    echoPlaySelBtn.hidden = !sel;
    echoPlaySelBtn.classList.toggle('on', echoSelOn);
    echoPlaySelBtn.textContent = echoSelOn ? '■ detener selección' : '▶ escuchar selección';
  }

  function stopEchoAll() {
    if (!echoPlaying && !echoSelOn) return;
    AudioEngine.stop(); echoPlaying = false; echoSelOn = false;
    $$('#echoResults .echo-item').forEach(it => { it.classList.remove('playing'); const b = it.querySelector('.echo-play'); if (b) b.innerHTML = PLAY_ICON; });
    updateEchoSelBtn();
  }
  function resetEchoItemsVisual() { $$('#echoResults .echo-item').forEach(it => { it.classList.remove('playing'); const b = it.querySelector('.echo-play'); if (b) b.innerHTML = PLAY_ICON; }); }

  echoC.addEventListener('pointerdown', e => {
    if (!e.isPrimary || e.button !== 0) return;
    stopEchoAll();
    eDragging = true; eMoved = false; echoGen++; clearEchoTimers(); echoC.setPointerCapture(e.pointerId);
    eStart = echoFrac(e);
  });
  echoC.addEventListener('pointermove', e => {
    if (!eDragging) return;
    const f = echoFrac(e);
    if (!eMoved && Math.abs(f - eStart) > 0.012) {
      eMoved = true; $('#echoResults').innerHTML = ''; $('#echoMs').textContent = '';
      echoStatus.textContent = '▸ seleccionando fragmento…'; echoStatus.className = 'echo-status'; updateEchoSelBtn();
    }
    if (eMoved) { sel = [Math.min(eStart, f), Math.max(eStart, f)]; drawEcho(); }
  });
  echoC.addEventListener('pointerup', e => {
    if (!eDragging) return; eDragging = false;
    const f = echoFrac(e);
    if (eMoved) {
      if (sel && sel[1] - sel[0] >= 0.02) { updateEchoSelBtn(); runEchoSearch(); }
      else { sel = null; updateEchoSelBtn(); drawEcho(); echoStatus.textContent = '▸ arrastra sobre la onda · sonidos reales de tu librería'; echoStatus.className = 'echo-status'; }
    } else {
      const prev = sel;
      if (prev && prev[1] - prev[0] >= 0.02 && f >= prev[0] && f <= prev[1]) playEchoSelection();
      else playEchoSourceFrom(f);
    }
  });
  echoC.addEventListener('pointercancel', () => { eDragging = false; });

  function playEchoSourceFrom(frac) {
    const s = SOUNDS.find(x => x.id === ECHO_SOURCE_ID); if (!s) return;
    if (isPlaying) { AudioEngine.stop(); finishPlayback(); }
    else if (echoPlaying) AudioEngine.stop();
    echoPlaying = false; echoSelOn = false; resetEchoItemsVisual(); updateEchoSelBtn();
    const fire = () => { const cur = AudioEngine.play(ECHO_SOURCE_ID, { offset: frac * AudioEngine.getDuration(ECHO_SOURCE_ID), mode: 'abs', onend: () => { echoPlaying = false; } }); if (cur) { echoPlaying = true; currentId = null; } };
    if (AudioEngine.isLoaded(ECHO_SOURCE_ID)) fire(); else AudioEngine.load(ECHO_SOURCE_ID, s.ogg).then(() => fire());
  }

  function playEchoSelection() {
    if (!sel) return;
    const wasOn = echoSelOn;
    if (isPlaying) { AudioEngine.stop(); finishPlayback(); }
    else if (echoPlaying) AudioEngine.stop();
    echoPlaying = false; echoSelOn = false; resetEchoItemsVisual(); updateEchoSelBtn();
    if (wasOn) return;
    const dur = AudioEngine.getDuration(ECHO_SOURCE_ID);
    const fire = () => {
      const cur = AudioEngine.play(ECHO_SOURCE_ID, { start: sel[0] * dur, end: sel[1] * dur, fadeIn: 0.01 * dur, fadeOut: 0.01 * dur, mode: 'rel', onend: () => { echoPlaying = false; echoSelOn = false; updateEchoSelBtn(); } });
      if (cur) { echoPlaying = true; echoSelOn = true; currentId = null; updateEchoSelBtn(); }
    };
    if (AudioEngine.isLoaded(ECHO_SOURCE_ID)) fire(); else AudioEngine.load(ECHO_SOURCE_ID, SOUNDS.find(s => s.id === ECHO_SOURCE_ID).ogg).then(() => fire());
  }
  if (echoPlaySelBtn) echoPlaySelBtn.addEventListener('click', playEchoSelection);

  function runEchoSearch() {
    const gen = ++echoGen; clearEchoTimers();
    echoStatus.className = 'echo-status busy'; echoStatus.textContent = '⚙ generando embedding del fragmento (512-D)…';
    echoTimers.push(setTimeout(() => {
      if (gen !== echoGen) return;
      echoStatus.textContent = '⚙ consultando índice HNSW · 70.234 regiones…';
      echoTimers.push(setTimeout(() => {
        if (gen !== echoGen) return;
        const ms = (Math.random() * 4 + 3).toFixed(1).replace('.', ',');
        echoStatus.textContent = `✓ 4 ecos encontrados en ${ms} ms — similitud coseno sobre embeddings CLAP`;
        echoStatus.className = 'echo-status done'; $('#echoMs').textContent = ms + ' ms'; renderEchoResults();
      }, 620));
    }, 520));
  }

  function playEchoPreview(btn, item, previewId) {
    const wasThis = echoPlaying && !echoSelOn && item.classList.contains('playing');
    if (isPlaying) { AudioEngine.stop(); finishPlayback(); }
    else if (echoPlaying) AudioEngine.stop();
    echoPlaying = false; echoSelOn = false; resetEchoItemsVisual(); updateEchoSelBtn();
    if (wasThis) return;
    const fire = () => {
      if (!document.contains(item)) return;
      const cur = AudioEngine.play(previewId, { mode: 'abs', onend: () => { echoPlaying = false; if (document.contains(item)) { item.classList.remove('playing'); btn.innerHTML = PLAY_ICON; } } });
      if (cur) { echoPlaying = true; currentId = null; item.classList.add('playing'); btn.innerHTML = PAUSE_ICON; }
      else { item.classList.remove('playing'); btn.innerHTML = PLAY_ICON; }
    };
    if (AudioEngine.isLoaded(previewId)) fire();
    else { const s = SOUNDS.find(x => x.id === previewId); if (s) AudioEngine.load(previewId, s.ogg).then(() => fire()); }
  }

  function renderEchoResults() {
    const mid = (sel[0] + sel[1]) / 2; const setIdx = mid < ECHO_ZONES[0] ? 0 : mid < ECHO_ZONES[1] ? 1 : 2; lastEchoSet = setIdx;
    const ECHOES = ECHO_SETS[setIdx]; const jitter = Math.round((sel[0] * 13 + (sel[1] - sel[0]) * 7) % 5) - 2;
    const box = $('#echoResults');
    box.innerHTML = ECHOES.map((e, i) => {
      const simNum = clamp(e.sim + jitter * (1 - i * 0.2), 55, 99); const simTxt = simNum.toFixed(1).replace('.', ',');
      return `<div class="echo-item" data-i="${i}" style="animation-delay:${i * 0.08}s">
        <button class="play-btn echo-play" data-i="${i}" aria-label="Reproducir ${e.name}">${PLAY_ICON}</button>
        <div class="echo-name"><b>${e.name}</b><span>${e.file}</span></div>
        <canvas class="echo-wave" data-ew="${i}"></canvas>
        <div class="echo-sim"><b>${simTxt}%</b><span class="sbar"><i style="width:${simNum.toFixed(1)}%"></i></span></div></div>`;
    }).join('');
    requestAnimationFrame(() => ECHOES.forEach((e, i) => {
      const c = box.querySelector(`canvas[data-ew="${i}"]`); if (!c) return;
      const p = AudioEngine.getPeaks(e.preview);
      fit(c); if (p) drawWave(c, p, { dim: 'rgba(224,221,213,.22)', highlight: e.reg }); else drawErrorLine(c);
    }));
    $$('#echoResults .echo-play').forEach(btn => btn.addEventListener('click', () => { const e = ECHOES[+btn.dataset.i]; playEchoPreview(btn, btn.closest('.echo-item'), e.preview); }));
  }

  const floatnav = $('#floatnav');
  window.addEventListener('scroll', () => { floatnav.classList.toggle('show', window.scrollY > window.innerHeight * 0.7); }, { passive: true });
  const io = new IntersectionObserver(entries => { entries.forEach(e => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }); }, { threshold: 0.15 });
  $$('.reveal').forEach(el => io.observe(el));

  function echoInView() { const r = echoC.getBoundingClientRect(); return r.bottom > 0 && r.top < window.innerHeight; }

  function frame() {
    requestAnimationFrame(frame);
    const hero = document.querySelector('.hero');
    if (!REDUCED && hero && window.scrollY < hero.offsetHeight + 200) drawAmbient();
    if (isPlaying && AudioEngine.active) {
      const ff = lastFileFrac();
      playerProgress.style.transform = 'scaleX(' + ff + ')';
      const dur = AudioEngine.getDuration(currentId);
      const disp = AudioEngine.active.mode === 'rel' ? ff * dur : AudioEngine.elapsed();
      const txt = fmt(disp) + ' / ' + fmt(dur);
      if (txt !== lastTimeText) { playerTime.textContent = txt; lastTimeText = txt; }
      if (!activeCanvas || activeCanvas.isConnected === false) activeCanvas = soundList.querySelector(`[data-wf="${currentId}"] canvas`);
      const p = AudioEngine.getPeaks(currentId);
      if (activeCanvas && p) drawWave(activeCanvas, p, { progress: ff });
      if (editor.open && currentId === editor.id && AudioEngine.active.mode === 'rel' && selection) {
        const ph = $('#editor-playhead'); ph.classList.add('active'); ph.style.left = toScreen(ff) + '%';
        const rd = (selection.b - selection.a) * dur; $('#editor-time-display').textContent = fmt(AudioEngine.position() * rd) + ' / ' + fmt(rd);
      }
    }
    if (echoPlaying && echoSelOn && sel && AudioEngine.active && AudioEngine.active.id === ECHO_SOURCE_ID && echoInView()) {
      const ff = sel[0] + AudioEngine.position() * (sel[1] - sel[0]);
      drawEcho(ff);
    }
  }

  function refitEchoResults() {
    $$('#echoResults canvas[data-ew]').forEach((c, i) => {
      if (c.clientWidth < 2) return;
      const e = ECHO_SETS[lastEchoSet][i]; const p = AudioEngine.getPeaks(e.preview);
      fit(c); if (p) drawWave(c, p, { dim: 'rgba(224,221,213,.22)', highlight: e.reg });
    });
  }
  let resizeT = null;
  window.addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(() => { fitAmbient(); renderSoundList(); fit(echoC); drawEcho(); refitEchoResults(); if (editor.open) { drawMinimap(); drawEditor(); } positionGtb(); }, 150); });

  let contentReady = false, skipRequested = false, splashHidden = false;
  function hideSplash() { if (splashHidden) return; splashHidden = true; $('#splash').classList.add('hide'); }
  $('#splash-skip').addEventListener('click', () => { skipRequested = true; if (contentReady) hideSplash(); });

  async function init() {
    const status = $('#splash-status');
    renderCollections(); playerToggle.innerHTML = PLAYER_PLAY; fitAmbient();
    window.addEventListener('load', () => { fitAmbient(); drawEcho(); });
    if (window.ResizeObserver) new ResizeObserver(() => fitAmbient()).observe(document.querySelector('.hero'));

    status.textContent = 'loading your sounds';
    const loads = SOUNDS.map(s => AudioEngine.load(s.id, s.ogg).then(buf => {
      if (contentReady) { if (buf) { drawRowWave(s); updateRowMeta(s); } else { drawRowWave(s); updateRowMeta(s, true); } }
      return buf;
    }));
    await Promise.race([Promise.allSettled(loads), new Promise(r => setTimeout(r, 7000))]);
    status.textContent = 'decoding waveforms'; await new Promise(r => setTimeout(r, REDUCED ? 30 : 300));
    status.textContent = 'indexing embeddings'; await new Promise(r => setTimeout(r, REDUCED ? 30 : 350));

    echoPeaks = AudioEngine.getPeaks(ECHO_SOURCE_ID);
    renderSoundList(); fit(echoC); drawEcho(); updateEchoSelBtn(); requestAnimationFrame(frame);
    contentReady = true;
    if (skipRequested) hideSplash(); else { await new Promise(r => setTimeout(r, REDUCED ? 60 : 450)); hideSplash(); }
  }
  init();
})();
