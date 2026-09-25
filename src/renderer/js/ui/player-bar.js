// Player bar: transport, now-playing, waveform scrubber, auto-play, loop, volume.
import { h, icon, setIcon, formatClock, stripExt, clamp } from '../util.js';
import { state, bus } from '../store.js';
import { player, setVolume, getVolume } from '../audio/engine.js';
import { peaksFor, requestPeaks } from '../audio/peaks.js';
import { drawPair, setProgress } from './waveform.js';
import { relDir } from './list.js';

let els = {}, drawnFor = null, raf = null;

export function mountPlayerBar(el) {
    const prev = h('button.icon-btn', { 'aria-label': 'Previous sound', 'data-tip': 'Previous', 'data-kbd': '↑' }, icon('prev'));
    const play = h('button.big-play', { 'aria-label': 'Play', 'data-tip': 'Play / pause', 'data-kbd': 'Space' }, icon('play', 'lg'));
    const next = h('button.icon-btn', { 'aria-label': 'Next sound', 'data-tip': 'Next', 'data-kbd': '↓' }, icon('next'));
    const title = h('div.t.ellipsis', { text: 'Nothing playing' });
    const sub = h('div.p.ellipsis');
    const now = h('div.now.idle', { 'data-tip': 'Show in list' }, title, sub);
    const t0 = h('span.t0', { text: '0:00.0' }), t1 = h('span.t1', { text: '0:00.0' });
    const base = h('canvas'), played = h('canvas.played', { style: { clipPath: 'inset(0 100% 0 0)' } });
    const head = h('div.head'), hoverT = h('div.hover-t');
    const track = h('div.track', { role: 'slider', 'aria-label': 'Seek', tabindex: '-1' }, base, played, head, hoverT);
    const scrub = h('div.scrub', {}, t0, track, t1);
    const auto = h('button.icon-btn.pl-toggle', { 'aria-label': 'Auto-play', 'data-tip': 'Auto-play when browsing with ↑/↓' }, icon('autoplay'));
    const loop = h('button.icon-btn.pl-toggle', { 'aria-label': 'Loop', 'data-tip': 'Loop', 'data-kbd': 'L' }, icon('loop'));
    const mute = h('button.icon-btn', { 'aria-label': 'Mute' }, icon('volume'));
    const vol = h('input.slider', { type: 'range', min: '0', max: '1', step: '0.01', 'aria-label': 'Volume' });
    el.append(h('div.transport', {}, prev, play, next), now, scrub, h('div.pl-right', {}, auto, loop, mute, vol));
    els = { prev, play, next, title, sub, now, t0, t1, base, played, head, hoverT, track, scrub, auto, loop, mute, vol };

    play.addEventListener('click', () => bus.emit('player:toggle'));
    prev.addEventListener('click', () => bus.emit('list:step', -1));
    next.addEventListener('click', () => bus.emit('list:step', 1));
    now.addEventListener('click', () => { if (player.sound) bus.emit('locate', player.sound); });
    auto.addEventListener('click', () => bus.emit('settings:set', { autoPlay: !state.settings.autoPlay }));
    loop.addEventListener('click', () => bus.emit('settings:set', { loop: !state.settings.loop }));

    let lastVol = 0.8;
    const applyVol = v => { v = clamp(v, 0, 1); setVolume(v); vol.value = v; vol.style.setProperty('--pct', v * 100 + '%'); setIcon(mute.firstChild, v === 0 ? 'mute' : 'volume'); };
    vol.addEventListener('input', () => applyVol(+vol.value));
    vol.addEventListener('change', () => bus.emit('settings:set', { volume: +vol.value }));
    mute.addEventListener('click', () => { const v = getVolume(); if (v > 0) { lastVol = v; applyVol(0); } else applyVol(lastVol || 0.8); bus.emit('settings:set', { volume: getVolume() }); });
    applyVol(state.settings?.volume ?? 0.8);

    // Scrub: click/drag to seek, hover shows time
    const fracAt = e => { const r = track.getBoundingClientRect(); return clamp((e.clientX - r.left) / r.width, 0, 1); };
    const fileDur = () => (player.sound && peaksFor(player.sound.path)?.duration) || player.fileDuration || player.duration || 0;
    track.addEventListener('mousemove', e => { const d = fileDur(); if (!d) return; const f = fracAt(e); hoverT.textContent = formatClock(f * d, d); hoverT.style.left = f * 100 + '%'; });
    track.addEventListener('mousedown', e => {
        if (!player.sound || e.button !== 0) return;
        e.preventDefault();
        const seek = ev => { const d = fileDur(); if (d) { player.seek(fracAt(ev) * d); paint(); } };
        seek(e);
        if (!player.playing) player.resume();
        const up = () => { document.removeEventListener('mousemove', seek); document.removeEventListener('mouseup', up); };
        document.addEventListener('mousemove', seek); document.addEventListener('mouseup', up);
    });

    player.on('state', onState);
    bus.on('settings', renderToggles);
    new ResizeObserver(() => { drawnFor = null; drawScrub(); }).observe(track);
    renderToggles();
    onState();
}

function renderToggles() {
    const s = state.settings || {};
    els.auto.classList.toggle('on', !!s.autoPlay);
    els.auto.setAttribute('aria-pressed', String(!!s.autoPlay));
    els.loop.classList.toggle('on', !!s.loop);
    els.loop.setAttribute('aria-pressed', String(!!s.loop));
}

function onState() {
    const snd = player.sound;
    setIcon(els.play.firstChild, player.playing ? 'pause' : 'play');
    els.play.setAttribute('aria-label', player.playing ? 'Pause' : 'Play');
    els.now.classList.toggle('idle', !snd);
    els.scrub.classList.toggle('has-sound', !!snd);
    els.title.textContent = snd ? stripExt(snd.name) : 'Nothing playing';
    els.sub.replaceChildren();
    if (snd) {
        els.sub.append(document.createTextNode(relDir(snd.dir || '', '') || (snd.external ? snd.path : 'Library root')));
        if (player.segment) els.sub.append(h('span.sel-badge', { text: 'SELECTION' }));
    }
    drawScrub();
    if (!raf) raf = requestAnimationFrame(tick);
}

function drawScrub() {
    const snd = player.sound;
    if (!snd) { drawPair(els.base, els.played, null); setProgress(els.played, 0); els.t0.textContent = '0:00.0'; els.t1.textContent = '0:00.0'; drawnFor = null; return; }
    const pk = peaksFor(snd.path);
    if (pk === undefined) { requestPeaks(snd).then(() => { drawnFor = null; drawScrub(); }); return; }
    const key = snd.path + '|' + els.base.clientWidth;
    if (drawnFor !== key) { drawPair(els.base, els.played, pk); drawnFor = key; }
    paint();
}

function paint() {
    const snd = player.sound;
    if (!snd) return;
    const pk = peaksFor(snd.path);
    const d = (pk && pk.duration) || player.fileDuration || player.duration || 0;
    const pos = player.position();
    els.t0.textContent = formatClock(pos, d);
    els.t1.textContent = formatClock(d, d);
    const f = d ? pos / d : 0;
    setProgress(els.played, f);
    els.head.style.left = clamp(f, 0, 1) * 100 + '%';
}

function tick() {
    raf = null;
    paint();
    if (player.playing || player.loading) raf = requestAnimationFrame(tick);
}
