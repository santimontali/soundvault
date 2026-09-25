// Echo ("find sounds like this"): a right-side drawer driven by a region of a
// sound (selection) or a whole file. Results show where the match is; ↑/↓
// audition the matched span; Echo Again chains queries (breadcrumbs go back).
import { h, icon, setIcon, stripExt, formatDuration, debounce, clamp } from '../util.js';
import { state, bus } from '../store.js';
import { player, decode } from '../audio/engine.js';
import { peaksFor, requestPeaks, peaksFromBuffer } from '../audio/peaks.js';
import { drawWave, colors } from './waveform.js';
import { toast } from './overlays.js';
import { dragFiles } from '../drag.js';
import { relDir } from './list.js';

const AXES = [
    ['timbre', 'Timbre'], ['brightness', 'Brightness'], ['texture', 'Texture'], ['energy', 'Energy'], ['transient', 'Attack'],
];
const DEFAULTS = { timbre: 1, brightness: 1, texture: 1, energy: 0.5, transient: 0.8 };
const PRESETS = {
    Balanced: DEFAULTS,
    Tone: { timbre: 1.8, brightness: 1.2, texture: 0.6, energy: 0.3, transient: 0.4 },
    Texture: { timbre: 0.8, brightness: 1.2, texture: 2, energy: 0.4, transient: 0.6 },
    Punch: { timbre: 0.8, brightness: 0.8, texture: 0.6, energy: 1.6, transient: 2 },
};
const CONTEXT_S = 0.05;          // real audio around the selection (Δ features need neighbours)
const MAX_QUERY_S = 20;

const S = {
    el: null, open: false, token: 0, loading: false,
    weights: { ...DEFAULTS }, results: [], cursor: -1, note: '',
    chain: [],          // [{ label, query }], query = { kind, item, start, end }
    axesOpen: false,
};
let els = {};

function mount() {
    if (S.el) return;
    S.el = document.getElementById('echo');
    const close = h('button.icon-btn.sm', { 'aria-label': 'Close Echo', 'data-tip': 'Close', 'data-kbd': 'Esc', onclick: closeEcho }, icon('x'));
    const stats = h('span.stats');
    const qn = h('div.qn.ellipsis'), qm = h('div.qm'), qcv = h('canvas');
    const locate = h('button.icon-btn.sm', { 'data-tip': 'Show the query sound in the library', 'aria-label': 'Locate query', onclick: () => { const q = cur(); if (q && q.item) bus.emit('locate', q.item); } }, icon('folder'));
    const query = h('div.ec-query', {}, h('div', { style: { minWidth: '0' } }, qn, qm), locate, qcv);
    const chain = h('div.ec-chain', { role: 'navigation', 'aria-label': 'Echo history' });
    const axes = h('div.ec-axes' + (S.axesOpen ? '' : '.collapsed'));
    const note = h('div.ec-note');
    const listEl = h('div.ec-list', { tabindex: '0', role: 'listbox', 'aria-label': 'Similar sounds' });
    const foot = h('div.ec-foot', {}, h('span.grow', { text: '↑ ↓ audition · Enter play · E echo again · C collect' }));
    S.el.append(h('div.ec-head', {}, h('div.ttl', {}, icon('echo'), 'Echo'), stats, close), query, chain, axes, note, listEl, foot);
    els = { stats, qn, qm, qcv, chain, axes, note, listEl };
    renderAxes();
    listEl.addEventListener('keydown', onKey);
    S.el.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeEcho(); } });
    player.on('state', paintPlaying);
}

const cur = () => S.chain[S.chain.length - 1]?.query || null;

export function isEchoOpen() { return S.open; }

function openPanel() {
    mount();
    S.open = true;
    S.el.classList.add('open');
    document.getElementById('app').classList.add('echo-open');
    requestAnimationFrame(() => els.listEl.focus({ preventScroll: true }));
}

export function closeEcho() {
    if (!S.el || !S.open) return;
    S.open = false;
    S.token++;
    S.el.classList.remove('open');
    document.getElementById('app').classList.remove('echo-open');
}

/** Echo from a selection (seconds within `item`). */
export function openEchoForRegion(item, sel) {
    const q = { kind: 'region', item, start: sel.start, end: Math.min(sel.end, sel.start + MAX_QUERY_S) };
    S.chain = [{ label: `${stripExt(item.name)} ${fmtRange(q.start, q.end)}`, query: q }];
    if (sel.end - sel.start > MAX_QUERY_S) toast(`Echo uses the first ${MAX_QUERY_S} s of the selection`, { icon: 'info' });
    openPanel();
    run();
}

/** Echo from a whole file ("more like this"). */
export function openEchoForFile(item) {
    S.chain = [{ label: stripExt(item.name), query: { kind: 'file', item } }];
    openPanel();
    run();
}

const fmtRange = (a, b) => `[${fmtT(a)}-${fmtT(b)}]`;
const fmtT = s => (s < 60 ? +s.toFixed(s < 10 ? 2 : 1) + 's' : formatDuration(s));

/**
 * Mono query audio at the playback rate with up to 50 ms of the real
 * surrounding audio on each side (the engine trims it back after analysis).
 * The downmix matches the indexer's, so query and library share one scale.
 */
async function queryAudio(item, start, end) {
    const buf = await decode(item.path);
    if (!buf) return null;
    const sr = buf.sampleRate, n = buf.length;
    const a = clamp(Math.floor(start * sr), 0, n), b = clamp(Math.ceil(end * sr), 0, n);
    if (b - a < 2) return null;
    const pre = Math.min(a, Math.round(CONTEXT_S * sr)), post = Math.min(n - b, Math.round(CONTEXT_S * sr));
    const from = a - pre, to = b + post, len = to - from;
    const nc = buf.numberOfChannels;
    const gain = nc === 1 ? 1 : nc === 2 ? Math.SQRT1_2 : 1 / Math.sqrt(nc);
    const pcm = new Float32Array(len);
    for (let c = 0; c < nc; c++) { const d = buf.getChannelData(c); for (let i = 0; i < len; i++) pcm[i] += d[from + i] * gain; }
    return { pcm, sampleRate: sr, pre, post, selection: pcm.subarray(pre, len - post) };
}

async function run() {
    const q = cur();
    if (!q) return;
    const token = ++S.token;
    S.loading = true; S.results = []; S.cursor = -1; S.note = '';
    renderQuery(); renderChain(); renderList(); renderNote();
    const eng = state.engine;
    if (!eng.ready) return finish(token, 'Resonance is still starting. Echo will be available in a moment.');
    if (eng.echoUpgrade) return finish(token, `Echo is upgrading its index (${Math.round(100 * (eng.echoUpgrade.done || 0) / Math.max(1, eng.echoUpgrade.total || 1))}%). This happens once, in the background.`);
    if (!eng.echo) return finish(token, 'Nothing to compare with yet: Echo works on analysed sounds, and your library is still being analysed (see the status in the title bar).');
    const t0 = performance.now();
    let res;
    try {
        if (q.kind === 'file') {
            res = await window.sv.engine.echoFile(q.item.path, { weights: { ...S.weights }, maxResults: 60 });
        } else {
            const qa = q.audio || (q.audio = await queryAudio(q.item, q.start, q.end));
            if (token !== S.token) return;
            if (!qa) return finish(token, 'Could not read that sound.');
            res = await window.sv.engine.echo({ pcm: qa.pcm, sampleRate: qa.sampleRate, pre: qa.pre, post: qa.post, weights: { ...S.weights }, maxResults: 60, exclude: [q.item.path] });
        }
    } catch (e) { res = { results: [], error: e.message }; }
    if (token !== S.token || res.cancelled) return;
    S.results = (res.results || []).filter(r => r.path !== q.item.path);
    els.stats.textContent = `${S.results.length} match${S.results.length === 1 ? '' : 'es'} · ${Math.round(res.searchTimeMs ?? (performance.now() - t0))} ms`;
    const notes = [];
    if (res.shortQuery) notes.push('Very short selection: matches are approximate.');
    if (res.clapOnly) notes.push('This sound has not been fingerprinted yet, so these sounds are similar in meaning.');
    S.note = notes.join(' ');
    finish(token, errorText(res));
}

function errorText(res) {
    switch (res.error) {
        case undefined: case null: case '': return null;
        case 'silent': return 'The selection is silent. Select part of the sound itself.';
        case 'too-short': return 'The selection is too short to compare. Select at least a few milliseconds of sound.';
        case 'empty': return 'Nothing to compare with yet: your library is still being analysed.';
        case 'upgrading': return 'Echo is upgrading its index. This happens once, in the background.';
        case 'loading': return 'Echo is still opening your library. Try again in a moment.';
        case 'not-indexed': return 'This sound has not been analysed yet. It will be shortly.';
        default: return 'Echo failed: ' + res.error;
    }
}

function finish(token, message) {
    if (token !== S.token) return;
    S.loading = false;
    renderList(message);
    renderNote();
}

// ── rendering ───────────────────────────────────────────────────────────
function renderQuery() {
    const q = cur();
    if (!q) return;
    els.qn.textContent = stripExt(q.item.name);
    els.qm.textContent = q.kind === 'file' ? 'Whole file' : `${fmtRange(q.start, q.end)} · ${formatDuration(q.end - q.start)} selection`;
    requestAnimationFrame(async () => {
        if (q.kind === 'region') {
            const qa = q.audio || (q.audio = await queryAudio(q.item, q.start, q.end));
            if (!qa || cur() !== q) return;
            const sel = qa.selection;
            const fake = { numberOfChannels: 1, length: sel.length, sampleRate: qa.sampleRate, getChannelData: () => sel };
            drawWave(els.qcv, peaksFromBuffer(fake, 0, sel.length, 512), { peak: colors().accentPeak, rms: colors().accentRms });
        } else {
            const pk = peaksFor(q.item.path) ?? await requestPeaks(q.item);
            if (cur() === q) drawWave(els.qcv, pk, { peak: colors().accentPeak, rms: colors().accentRms });
        }
    });
}

function renderChain() {
    els.chain.replaceChildren(...S.chain.map((c, i) => {
        const last = i === S.chain.length - 1;
        const b = h(last ? 'span.crumb.cur' : 'button.crumb', { text: (i ? '→ ' : '') + c.label, title: last ? c.label : 'Back to ' + c.label });
        if (!last) b.addEventListener('click', () => { S.chain = S.chain.slice(0, i + 1); run(); });
        return b;
    }));
    els.chain.style.display = S.chain.length > 1 ? '' : 'none';
}

function renderNote() {
    els.note.textContent = S.note;
    els.note.style.display = S.note ? '' : 'none';
}

function renderAxes() {
    const toggle = () => { S.axesOpen = !S.axesOpen; renderAxes(); };
    const head = h('div.ax-head', {},
        h('button.ax-toggle', { onclick: toggle, 'aria-expanded': String(S.axesOpen) }, icon(S.axesOpen ? 'chev-d' : 'chev-r', 'xs'), 'Match on'),
        h('span.presets', {}, ...Object.entries(PRESETS).map(([name, w]) => h('button.chip' + (sameWeights(w) ? '.on' : ''), { text: name, onclick: () => { S.weights = { ...w }; renderAxes(); rerun(); } }))));
    const rows = AXES.flatMap(([k, label]) => {
        const v = h('span.val', { text: S.weights[k].toFixed(1) });
        const s = h('input.slider.accent', { type: 'range', min: '0', max: '2', step: '0.1', value: String(S.weights[k]), 'aria-label': label });
        s.style.setProperty('--pct', (S.weights[k] / 2 * 100) + '%');
        s.addEventListener('input', () => { S.weights[k] = +s.value; v.textContent = (+s.value).toFixed(1); s.style.setProperty('--pct', (+s.value / 2 * 100) + '%'); markPresets(); rerun(); });
        s.addEventListener('dblclick', () => { S.weights[k] = DEFAULTS[k]; renderAxes(); rerun(); });
        return [h('span', { text: label }), s, v];
    });
    els.axes.replaceChildren(head, ...rows);
    els.axes.classList.toggle('collapsed', !S.axesOpen);
}
function markPresets() {
    const chips = els.axes.querySelectorAll('.presets .chip');
    Object.values(PRESETS).forEach((w, i) => chips[i] && chips[i].classList.toggle('on', sameWeights(w)));
}
const sameWeights = w => AXES.every(([k]) => Math.abs((w[k] ?? 1) - S.weights[k]) < 1e-6);
const rerun = debounce(() => run(), 300);

function renderList(message = null) {
    const L = els.listEl;
    if (S.loading) { L.replaceChildren(h('div.ec-loading', { 'aria-busy': 'true' }, ...Array.from({ length: 6 }, () => h('i')))); return; }
    if (message) { L.replaceChildren(h('div.ec-empty', {}, h('h3', { text: 'Echo' }), message)); return; }
    if (!S.results.length) { L.replaceChildren(h('div.ec-empty', {}, h('h3', { text: 'No similar sounds found' }), 'Try a longer or cleaner selection, or change what to match on.')); return; }
    const firstWeak = S.results.findIndex(r => r.weak);
    const rows = S.results.map((r, i) => row(r, i));
    // Loose matches stay listed (true sources can score low) but read as such.
    if (firstWeak > 0) rows.splice(firstWeak, 0, h("div.ec-sep", { text: "Loosely similar" }));
    else if (firstWeak === 0) rows.unshift(h("div.ec-sep", { text: "No close matches, only loosely similar sounds" }));
    L.replaceChildren(...rows);
    paintPlaying();
}

function simBadge(r) {
    if (r.identical) return h('div.sim.identical', { title: 'Identical audio' + (r.copies && r.copies.length ? ` (${r.copies.length + 1} copies in the library)` : '') }, 'Identical');
    if (r.score == null) {                              // semantic-only result (not fingerprinted)
        const pct = Math.round(clamp(((r.clap ?? 0) - 0.5) / 0.45, 0, 1) * 100);
        return h('div.sim.soft', { title: 'Semantically similar (not fingerprinted yet)' }, h('span.bar', {}, h('i', { style: { width: pct + '%' } })), '~');
    }
    if (r.weak) return h('div.sim.weak', { title: 'Loosely similar: no closer match was found' }, h('span.bar', {}, h('i', { style: { width: '8%' } })), 'Weak');
    const pct = Math.max(1, Math.round(clamp(r.score, 0, 1) * 100));
    return h('div.sim', { title: `Match confidence ${pct}% (how far above a chance match)` }, h('span.bar', {}, h('i', { style: { width: pct + '%' } })), `${pct}%`);
}

function row(r, i) {
    const pb = h('button.pb', { 'aria-label': 'Play match', tabindex: '-1' }, icon('play'));
    const cv = h('canvas');
    const match = h('div.match', { style: { display: 'none' } });
    const copies = r.copies && r.copies.length ? h('span.copies', { text: `+${r.copies.length}`, title: 'Identical copies:\n' + r.copies.join('\n') }) : null;
    const acts = h('div.acts', {},
        h('button.icon-btn', { 'data-tip': 'Echo again from this match', 'data-kbd': 'E', 'aria-label': 'Echo again', onclick: e => { e.stopPropagation(); echoAgain(r); } }, icon('echo')),
        h('button.icon-btn', { 'data-tip': 'Add to collection', 'data-kbd': 'C', 'aria-label': 'Add to collection', onclick: e => { e.stopPropagation(); bus.emit('echo:collect', [itemOf(r)]); } }, icon('collection-plus')),
        h('button.icon-btn', { 'data-tip': 'Show in library', 'aria-label': 'Locate', onclick: e => { e.stopPropagation(); bus.emit('locate', itemOf(r)); } }, icon('folder')),
        (() => { const g = h('div.icon-btn', { draggable: 'true', 'data-tip': 'Drag to your DAW', 'aria-label': 'Drag' }, icon('grip')); g.addEventListener('dragstart', e => { e.preventDefault(); dragFiles([itemOf(r)]); }); return g; })());
    const el = h('div.er' + (r.weak ? '.weak' : ''), { role: 'option', dataset: { i } }, pb,
        h('div.nm', { title: r.path }, stripExt(r.name || r.path.split(/[\\/]/).pop()), copies), simBadge(r),
        h('div.wfc', {}, cv, match), acts);
    el.insertBefore(h('div.dir', { text: relDir(r.dir || '', '') }), el.children[2]);
    el.addEventListener('click', () => { setCursor(i); playMatch(r); });
    pb.addEventListener('click', e => { e.stopPropagation(); setCursor(i); if (player.isCurrent(r.path) && player.playing) player.pause(); else playMatch(r); });
    // mini waveform + where the match is
    const draw = pk => {
        if (!pk || !el.isConnected) return;
        drawWave(cv, pk);
        const d = pk.duration || 0;
        if (d > 0 && r.durationMs > 0 && r.durationMs < d * 1000 - 5) {
            const a = (r.offsetMs || 0) / 1000 / d, w = r.durationMs / 1000 / d;
            match.style.display = ''; match.style.left = clamp(a, 0, 1) * 100 + '%'; match.style.width = Math.max(0.6, clamp(w, 0, 1 - a) * 100) + '%';
        }
    };
    const pk = peaksFor(r.path);
    if (pk !== undefined) requestAnimationFrame(() => draw(pk)); else requestPeaks(itemOf(r)).then(draw);
    return el;
}

const itemOf = r => ({ path: r.path, name: r.name || r.path.split(/[\\/]/).pop(), dir: r.dir || '', size: r.size || 0, mtime: r.mtime || 0 });

/** The matched span of a result, in seconds (whole file when the match covers it). */
function segmentOf(r) {
    const start = Math.max(0, (r.offsetMs || 0) / 1000);
    const len = r.durationMs > 0 ? r.durationMs / 1000 : 0;
    return { start, end: len ? start + len : undefined };
}

function playMatch(r) {
    const seg = segmentOf(r);
    if (!seg.end) player.play(itemOf(r), { at: 0 });
    else player.play(itemOf(r), { start: seg.start, end: seg.end });
}

function echoAgain(r) {
    const seg = segmentOf(r);
    const item = itemOf(r);
    const pk = peaksFor(item.path);
    const end = seg.end ?? (pk && pk.duration) ?? seg.start + 3;
    if (end - seg.start < 0.02) return toast('That match is too short to echo from', { icon: 'info' });
    const q = { kind: 'region', item, start: seg.start, end: Math.min(end, seg.start + MAX_QUERY_S) };
    S.chain.push({ label: `${stripExt(item.name)} ${fmtRange(q.start, q.end)}`, query: q });
    run();
}

function setCursor(i) {
    S.cursor = clamp(i, 0, S.results.length - 1);
    for (const el of els.listEl.querySelectorAll('.er')) el.classList.toggle('cursor', +el.dataset.i === S.cursor);
    const el = els.listEl.querySelector(`.er[data-i="${S.cursor}"]`);
    if (el) el.scrollIntoView({ block: 'nearest' });
}

function paintPlaying() {
    if (!els.listEl) return;
    for (const el of els.listEl.querySelectorAll('.er')) {
        const r = S.results[+el.dataset.i];
        const on = !!(r && player.isCurrent(r.path) && (player.playing || player.loading));
        el.classList.toggle('playing', on);
        setIcon(el.querySelector('.pb .i'), on && player.playing ? 'pause' : 'play');
    }
}

function onKey(e) {
    const n = S.results.length;
    if (!n) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault(); e.stopPropagation();
        setCursor(S.cursor < 0 ? 0 : S.cursor + (e.key === 'ArrowDown' ? 1 : -1));
        if (state.settings.autoPlay) playMatch(S.results[S.cursor]);
    } else if (e.key === 'Enter' && S.cursor >= 0) { e.preventDefault(); e.stopPropagation(); playMatch(S.results[S.cursor]); }
    else if (e.key === ' ') { e.preventDefault(); e.stopPropagation(); if (player.playing) player.pause(); else if (S.cursor >= 0) playMatch(S.results[S.cursor]); }
    else if ((e.key === 'e' || e.key === 'E') && S.cursor >= 0) { e.preventDefault(); e.stopPropagation(); echoAgain(S.results[S.cursor]); }
    else if ((e.key === 'c' || e.key === 'C') && S.cursor >= 0) { e.preventDefault(); e.stopPropagation(); bus.emit('echo:collect', [itemOf(S.results[S.cursor])]); }
}
