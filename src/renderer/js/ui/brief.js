// Vault Brief: the home of a vault. The project described with words,
// reference sounds and images; Resonance suggests collections from the
// user's own library, each created in one click or reviewed first.
//  • Every edit is saved at once and the suggestions refresh (debounced,
//    stale answers dropped); while waiting the cards shimmer, never a spinner.
//  • Images: dropped, pasted (Ctrl+V) or picked; shrunk and encoded here. They
//    add their colors (the palette) and, when the image model is installed, the
//    concepts it recognises (chips that pin or go away like words).
import { h, icon, count, stripExt, debounce, throttleRaf, isEditableTarget } from '../util.js';
import { state, bus, activeVault } from '../store.js';
import { player } from '../audio/engine.js';
import { toast, showMenu, confirmDialog, isDialogOpen } from './overlays.js';
import { refreshColors } from '../theme.js';
import { dragFiles } from '../drag.js';
import { relDir } from './list.js';
import * as A from '../actions.js';
import { setBriefCount, markCollection, collectionNode } from './sidebar.js';
import { miniWave, durationOf, audition, paintPlaying, sweep } from './audition.js';
import { openReview, closeReview } from './brief-review.js';
import { prepareImage, pixelsFromDataUrl, bytesFromDataUrl, isImageFile } from '../brief-image.js';

const sv = window.sv;
const ROWS = 4;                                  // candidates shown on a card
const MAX_WORDS = 40, MAX_REFS = 24, MAX_IMAGES = 12;
const FIRST_MAX = 6, MORE_MAX = 12;              // suggestions requested (3 per row)
const EXAMPLES = ['rainy harbour at night', 'retro arcade UI', 'forest dawn'];
const LOCAL = 'Analysed locally · nothing leaves your computer';
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

const B = {
    root: null, els: {}, box: null, sugg: null,
    visible: false, vaultId: null,
    state: null,                                  // BriefState from main
    mode: null,                                   // 'empty' | 'box' (what the brief section shows)
    cards: [], more: 0, unmatched: [], status: 'idle', max: FIRST_MAX,
    pending: false, timer: null,
    seq: 0, updSeq: 0, loadSeq: 0, moreSeq: 0,
    moreCols: [],
    busy: new Set(),                              // card keys being created
    shots: [],                                    // images being prepared [{ id, name, url }]
    analysing: new Set(),                         // image ids the model is reading now
    tried: new Set(),                             // image ids re-read this session (never retried twice)
    analysingRun: false,
    editingDesc: false,
    quietUntil: 0,
};
let tmpId = 0;

/** Collections changed elsewhere (sidebar, drag and drop): what the vault holds is excluded from suggestions. */
const collectionsChanged = debounce(() => { if (B.visible) { scheduleSuggest(0); loadMore(); } }, 600);
/** The Brief's own changes to collections refresh explicitly; skip the echo of their events. */
const quiet = () => { B.quietUntil = Date.now() + 2500; };

// ── keys and small helpers ─────────────────────────────────────────────
const wordKey = w => 'w:' + String(w).toLowerCase();
const refKey = p => 's:' + String(p).toLowerCase();
const conceptKey = c => 'c:' + String(c.key).toLowerCase();
const cap = t => (t ? t.charAt(0).toUpperCase() + t.slice(1) : '');
const folderOf = dir => String(dir || '').split('/').filter(Boolean).pop() || 'Library';
const pinnedSet = () => new Set((B.state ? B.state.pinned : []).map(k => String(k).toLowerCase()));
const removedSet = () => new Set((B.state ? B.state.removed : []).map(k => String(k).toLowerCase()));
const conceptsOf = im => (im.concepts || []).filter(c => !removedSet().has(conceptKey(c)));
const isEmpty = st => !st || (!st.words.length && !st.refs.length && !st.images.length);
const hasQueries = st => !!st && (st.words.length > 0 || st.refs.some(r => !r.missing) || st.images.some(im => conceptsOf(im).length > 0));
const sameVault = vid => vid === B.vaultId && vid === state.vaults.activeVaultId;
function hash(s) { let x = 2166136261; for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619); } return x >>> 0; }
const svgEl = (tag, attrs = {}) => { const e = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };
const libraryRoot = () => (state.library.root || '').toLowerCase().replace(/[\\/]+$/, '') + '\\';
const inLibrary = p => !!state.library.root && String(p).toLowerCase().startsWith(libraryRoot());
const sidebarShown = () => !document.getElementById('app').classList.contains('sidebar-collapsed');
/** replaceChildren that skips null / false, like h() does. */
const fill = (el, ...kids) => el.replaceChildren(...kids.filter(k => k !== null && k !== undefined && k !== false));

/** Colors from the images, round-robin so every image contributes (max 6). */
function palette() {
    const lists = (B.state ? B.state.images : []).map(im => im.palette || []), out = [];
    for (let k = 0; k < 5; k++) for (const l of lists) if (l[k] && !out.some(c => c.toLowerCase() === l[k].toLowerCase())) out.push(l[k]);
    return out.slice(0, 6);
}
function imageOfConcept(key) {
    key = String(key).toLowerCase();
    return (B.state ? B.state.images : []).find(im => (im.concepts || []).some(c => conceptKey(c) === key)) || null;
}
/** Cards are tinted by the moodboard; a created collection takes that color. */
function tintFor(card) {
    const pal = palette();
    if (!pal.length) return null;
    for (const r of card.reasons || []) if (r.kind === 'concept') { const im = imageOfConcept(r.key); if (im && im.palette && im.palette[0]) return im.palette[0]; }
    return pal[hash(card.key) % pal.length];
}

// ── public API ──────────────────────────────────────────────────────────
/** Wire the global listeners once (the DOM is built on first show). */
export function initBrief() {
    engineWas = { ready: state.engine.ready, indexing: state.engine.indexing, model: state.engine.imageModel === 'ready' };
    bus.on('view', v => { if (v.kind !== 'brief') hide(); });
    bus.on('collections', () => { if (!B.visible) return; paintHeaderFacts(); if (Date.now() > B.quietUntil) collectionsChanged(); });
    bus.on('vaults', () => { if (B.visible) { paintHeaderFacts(); paintPalette(); } });
    bus.on('sidebar:toggle', () => { if (B.visible && !B.editingDesc) renderHeader(); });
    bus.on('engine', onEngine);
    bus.on('brief:changed', st => {
        if (B.visible && st && st.vaultId === B.vaultId) { adopt(st); scheduleSuggest(); } else countSoon();
    });
    bus.on('vault:switched', () => { closeReview({ restoreFocus: false }); if (!B.visible) { setBriefCount(null); countSoon(); } });
    player.on('state', () => { if (B.visible) paintPlaying(B.root); });
    document.addEventListener('paste', onPaste);
    window.addEventListener('resize', throttleRaf(fitStrip));
    countSoon();
}

/** Show the Brief of the active vault (the vault's home). */
export async function showBrief() {
    mount();
    B.els.main.classList.add('brief-on');
    B.visible = true;
    const vid = state.vaults.activeVaultId;
    if (vid !== B.vaultId) reset(vid);
    renderHeader();
    const seq = ++B.loadSeq;
    let st = null;
    try { st = await sv.brief.get(); } catch (e) { console.warn('[brief]', e); }
    if (seq !== B.loadSeq || !B.visible || !st || st.vaultId !== B.vaultId) return;
    B.state = st;
    renderHeader();
    renderBrief();
    renderSugg();
    runSuggest();
    loadMore();
    analyseOlderImages();
}

/** Library or brief changed underneath (files moved, rescans): refresh in place. */
export async function refreshBrief() {
    if (!B.visible) return;
    const vid = B.vaultId;
    const st = await sv.brief.get().catch(() => null);
    if (st && sameVault(vid)) { adopt(st); scheduleSuggest(); loadMore(); }
}

function hide() {
    if (!B.visible) return;
    B.visible = false;
    B.els.main.classList.remove('brief-on');
    closeReview({ restoreFocus: false });
}

function reset(vid) {
    B.vaultId = vid;
    B.state = null; B.mode = null;
    B.cards = []; B.more = 0; B.unmatched = []; B.status = 'idle'; B.max = FIRST_MAX;
    B.moreCols = []; B.shots = []; B.busy.clear(); B.analysing.clear();
    B.seq++; B.updSeq++; B.moreSeq++;
    clearTimeout(B.timer); B.timer = null; B.pending = false;
    B.els.secBrief.replaceChildren();
    B.sugg.cards.replaceChildren();
    B.els.secMore.replaceChildren();
    B.els.scroll.scrollTop = 0;
    closeReview({ restoreFocus: false });
    sweep();
}

// ── DOM skeleton and delegated events ──────────────────────────────────
function mount() {
    if (B.root) return;
    const main = document.getElementById('main');
    const head = h('header.bhead');
    const secBrief = h('section.sec', { 'aria-label': 'Brief' });
    const secSugg = h('section.sec', { 'aria-label': 'Suggested collections' });
    const secMore = h('section.sec', { 'aria-label': 'More for your collections' });
    const scroll = h('div.bscroll', {}, secBrief, secSugg, secMore);
    const file = h('input', { type: 'file', accept: 'image/*,.wav', multiple: true, hidden: true, tabindex: '-1', 'aria-hidden': 'true' });
    file.addEventListener('change', () => { const f = [...file.files]; file.value = ''; if (f.length) addFiles(f); });
    B.root = h('div.bv', {}, head, scroll, file);
    main.appendChild(B.root);
    B.els = { main, head, scroll, secBrief, secSugg, secMore, file };
    buildSugg();

    const root = B.root;
    // Sounds anywhere in the Brief: click / Enter / Space audition, right-click
    // opens the usual sound menu, dragging goes to a DAW or a collection.
    root.addEventListener('click', e => {
        const aud = e.target.closest('.aud');
        if (!aud || !aud._item || e.target.closest('button:not(.pb)')) return;
        audition(aud._item);
    });
    root.addEventListener('keydown', e => {
        const t = e.target;
        if (!t.classList || !t.classList.contains('aud') || (e.key !== 'Enter' && e.key !== ' ')) return;
        e.preventDefault();
        audition(t._item);
    });
    root.addEventListener('contextmenu', e => {
        const aud = e.target.closest('.aud');
        if (!aud || !aud._item || aud._item.missing) return;
        e.preventDefault();
        A.rowMenu({ item: aud._item, items: [aud._item], x: e.clientX, y: e.clientY });
    });
    root.addEventListener('dragstart', e => {
        const aud = e.target.closest && e.target.closest('.aud[draggable="true"]');
        if (!aud) return;
        e.preventDefault();
        dragFiles([aud._item]);
    });
    // Drops: images from Explorer, library sounds (as references), text (as words).
    let depth = 0;
    const accepts = e => { const t = [...((e.dataTransfer && e.dataTransfer.types) || [])]; return t.includes('Files') || t.includes('text/plain'); };
    const zone = () => B.els.secBrief.firstElementChild;
    root.addEventListener('dragenter', e => { if (!accepts(e)) return; e.preventDefault(); depth++; zone() && zone().classList.add('over'); });
    root.addEventListener('dragover', e => { if (!accepts(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
    root.addEventListener('dragleave', e => { if (!accepts(e)) return; depth = Math.max(0, depth - 1); if (!depth && zone()) zone().classList.remove('over'); });
    root.addEventListener('drop', e => {
        if (!accepts(e)) return;
        e.preventDefault();
        depth = 0;
        if (zone()) zone().classList.remove('over');
        const files = [...e.dataTransfer.files];
        if (files.length) { addFiles(files); return; }
        const txt = e.dataTransfer.getData('text/plain');
        if (txt && txt.trim()) addWords(txt);
    });
}

// ── header ─────────────────────────────────────────────────────────────
function renderHeader() {
    const v = activeVault();
    const st = B.state && B.state.vaultId === B.vaultId ? B.state : null;
    const name = (st ? st.name : v && v.name) || 'Vault';
    const full = (st ? st.description : v && v.description) || '';
    const line = full.replace(/\s*\n+\s*/g, ' ').trim();
    const desc = h('button.desc' + (line ? '' : '.empty'), { 'aria-label': line ? `Description: ${line}. Click to edit` : 'Add a one-line description', title: line.length > 90 ? line : null },
        h('span.dt', { text: line || 'Add a one-line description' }), icon('pencil', 'sm'));
    desc.addEventListener('click', () => editDescription(desc, full));
    fill(B.els.head,
        sidebarShown() ? null : h('button.icon-btn.sm.sb-show', { 'data-tip': 'Show sidebar', 'data-kbd': 'Ctrl+B', 'aria-label': 'Show sidebar', onclick: () => bus.emit('sidebar:toggle') }, icon('sidebar')),
        h('div.id', {}, h('div.l1', {}, h('span.vdot'), h('h1', { text: name, title: name }), h('span.count', { text: count(state.collections.length, 'collection') })), desc),
        h('div.head-actions', {},
            h('button.btn', { onclick: () => A.newCollection() }, icon('plus'), 'New collection'),
            h('button.icon-btn', { 'aria-label': 'Vault options', 'data-tip': 'Vault options', onclick: e => headMenu(e.currentTarget) }, icon('more'))));
}

/** Name and collection count only (safe while the description is being edited). */
function paintHeaderFacts() {
    const v = activeVault();
    const h1 = B.els.head.querySelector('h1'), c = B.els.head.querySelector('.count');
    if (h1 && v) { h1.textContent = v.name; h1.title = v.name; }
    if (c) c.textContent = count(state.collections.length, 'collection');
}

function editDescription(btn, full) {
    if (full.trim().includes('\n')) { A.vaultHandlers.edit(); return; }   // several lines: the full editor
    const inp = h('input', { type: 'text', maxlength: '300', spellcheck: 'false', placeholder: 'One line about the project', 'aria-label': 'Vault description' });
    inp.value = full.trim();
    btn.replaceWith(h('div.desc.editing', {}, inp));
    B.editingDesc = true;
    inp.focus();
    inp.select();
    let done = false;
    const finish = async (save, refocus) => {
        if (done) return;
        done = true;
        B.editingDesc = false;
        const val = inp.value.replace(/\s+/g, ' ').trim();
        const vid = B.vaultId;
        if (save && val !== full.trim() && B.state) {
            B.state = { ...B.state, description: val };
            renderHeader();
            const st = await sv.brief.update({ description: val }).catch(() => null);
            if (st && sameVault(vid)) adopt(st);
            quiet();
            await A.refreshCollections();
            scheduleSuggest();                    // the description tints the suggestions a little
        } else renderHeader();
        if (refocus) { const d = B.els.head.querySelector('.desc'); if (d) d.focus(); }
    };
    inp.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); finish(true, true); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false, true); }
    });
    inp.addEventListener('blur', () => finish(true, false));
}

function headMenu(anchor) {
    const st = B.state;
    const dismissed = st ? st.dismissed.length : 0;
    showMenu(anchor, [
        { label: 'Edit vault…', icon: 'pencil', onClick: () => A.vaultHandlers.edit() },
        dismissed ? { label: `Restore dismissed suggestions (${dismissed})`, icon: 'undo', onClick: () => restoreDismissed() } : null,
        'sep',
        { label: 'Clear brief…', icon: 'trash', danger: true, disabled: isEmpty(st), onClick: () => clearBrief() },
    ]);
}

// ── brief section: empty hero or the filled box ────────────────────────
function renderBrief({ anim = false } = {}) {
    const st = B.state;
    const mode = !st ? null : isEmpty(st) && !B.shots.length ? 'empty' : 'box';
    const sec = B.els.secBrief;
    if (mode !== B.mode) {
        const hadFocus = !!(document.activeElement && document.activeElement.classList && document.activeElement.classList.contains('words-in') && B.root.contains(document.activeElement));
        B.mode = mode;
        B.box = null;
        sec.replaceChildren(...(mode === 'empty' ? [emptyZone()] : mode === 'box' ? [briefBox()] : []));
        sweep();
        if (anim && sec.firstElementChild && !reduced()) sec.firstElementChild.classList.add('in');
        if (hadFocus) { const i = sec.querySelector('.words-in'); if (i) i.focus({ preventScroll: true }); }
    }
    if (mode === 'box') updateBox();
}

function dropHint(title) {
    return h('div.drop-hint', { 'aria-hidden': 'true' }, h('div.t', { text: title }), h('div.s', { text: 'Images, or sounds from your library' }));
}

function wordsInput(placeholder, label) {
    const inp = h('input.words-in', { type: 'text', autocomplete: 'off', spellcheck: 'false', placeholder, 'aria-label': label });
    inp.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault();
            const v = inp.value.trim();
            if (v) { inp.value = ''; addWords(v); }
        } else if (e.key === 'Backspace' && !inp.value && B.state && B.state.words.length) {
            e.preventDefault();
            removeWord(B.state.words[B.state.words.length - 1]);
        } else if (e.key === 'Escape') {
            if (inp.value) { inp.value = ''; e.preventDefault(); } else inp.blur();
        }
    });
    return inp;
}

function emptyZone() {
    const inp = wordsInput('Type a few words…', 'Describe the project in a few words');
    const field = h('div.ez-field', {}, icon('text'), inp, h('span.kbd', { text: 'Enter', 'aria-hidden': 'true' }));
    field.addEventListener('mousedown', e => { if (e.target !== inp) { e.preventDefault(); inp.focus(); } });
    const bars = svgEl('svg', { class: 'bars', viewBox: '0 0 28 22', 'aria-hidden': 'true' });
    [6, 11, 18, 9, 14, 7, 4].forEach((v, i) => bars.appendChild(svgEl('rect', { x: 1 + i * 3.8, y: (22 - v) / 2, width: 2.3, height: v, rx: 1.15, fill: i === 2 ? 'var(--accent)' : 'currentColor' })));
    return h('div.ezone', {},
        h('div.ez-art', { 'aria-hidden': 'true' }, h('span.t.t1', {}, icon('image')), h('span.t.t2', {}, bars), h('span.t.t3', { text: 'Aa' })),
        h('h2', { text: 'Start with a brief' }),
        h('p', {}, 'Drop images, sounds or words that describe this project, or ', h('button.link', { onclick: () => B.els.file.click() }, 'browse your files'), '. Collections from your library are suggested as you go.'),
        field,
        h('div.ez-try', {}, h('span', { text: 'Try' }), ...EXAMPLES.map(t => h('button.ex', { onclick: () => addWords(t) }, t))),
        h('div.local', {}, icon('lock'), LOCAL),
        dropHint('Drop to start the brief'));
}

function briefBox() {
    const addBtn = h('button.tile.add', { onclick: () => B.els.file.click() });
    const addcol = h('div.addcol', {}, addBtn);
    const strip = h('div.strip', {}, addcol);
    strip.addEventListener('scroll', fitStrip, { passive: true });
    const note = h('div.img-note.hidden', {}, icon('image'), 'For now, images add their colors to the brief.');
    const wordsIn = wordsInput('Add words…', 'Add words that describe the project');
    const words = h('div.words', {}, icon('text'), wordsIn);
    words.addEventListener('mousedown', e => { if (e.target === words || (e.target.closest && e.target.closest('svg.i') && !e.target.closest('.cc'))) { e.preventDefault(); wordsIn.focus(); } });
    const pal = h('div.palette');
    const box = h('div.brief', {},
        h('div.bb-top', {}, h('span.lbl', { text: 'Brief' }), h('span.hint', { text: 'Drop images, sounds or words that describe this project' }), h('span.local', {}, icon('lock'), LOCAL)),
        strip, note,
        h('div.bb-row', {}, words, pal),
        dropHint('Drop to add to the brief'));
    B.box = { box, strip, addcol, addBtn, note, words, wordsIn, pal, addMode: null };
    return box;
}

function updateBox() {
    const st = B.state, bx = B.box;
    if (!st || !bx) return;
    // strip: images, images being prepared, reference sounds. Keyed: existing
    // tiles are never moved or rebuilt (no flicker, focus stays where it was).
    const want = [
        ...st.images.map(im => ({ k: 'img:' + im.id, make: () => imageTile(im), sig: imageSig(im), paint: el => paintConcepts(el, im) })),
        ...B.shots.map(s => ({ k: 'tmp:' + s.id, make: () => shotTile(s), sig: 'tmp' })),
        ...st.refs.map(r => ({ k: 'ref:' + r.path.toLowerCase(), make: () => refTile(r), sig: refSig(r), paint: el => paintRefPin(el, r) })),
    ];
    const keys = new Set(want.map(w => w.k));
    const live = new Map();
    for (const el of bx.strip.querySelectorAll(':scope > .tile:not(.out)')) {
        if (keys.has(el.dataset.k)) { live.set(el.dataset.k, el); continue; }
        if (reduced() || !B.visible || el.dataset.k.startsWith('tmp:')) el.remove();   // a stored image takes the placeholder's place
        else { el.classList.add('out'); setTimeout(() => el.remove(), 200); }
    }
    let next = bx.addcol;                        // walk backwards: a new tile goes before its successor
    for (let i = want.length - 1; i >= 0; i--) {
        const w = want[i];
        let el = live.get(w.k);
        if (!el || el._sig !== w.sig) {
            const fresh = w.make();
            fresh._sig = w.sig;
            if (el) el.replaceWith(fresh);
            else {
                bx.strip.insertBefore(fresh, next);
                if (B.visible && !reduced()) fresh.classList.add('in');
            }
            el = fresh;
        }
        if (w.paint) w.paint(el);
        next = el;
    }
    // the Add tile: a column next to media, a slim row when the brief has only words
    const media = want.length > 0;
    bx.strip.classList.toggle('none', !media);
    if (bx.addMode !== media) {
        bx.addMode = media;
        bx.addBtn.replaceChildren(...(media
            ? [h('span.plus', {}, icon('plus')), h('span.t', { text: 'Add' }), h('small', { text: 'Image or sound' })]
            : [h('span.plus', {}, icon('image')), h('small', { text: 'Add images or reference sounds to sharpen the suggestions. Drop, browse or paste.' })]));
        bx.addBtn.setAttribute('aria-label', 'Add images or reference sounds');
        if (media) bx.addBtn.dataset.tip = 'Or paste an image with Ctrl+V'; else delete bx.addBtn.dataset.tip;
    }
    bx.note.classList.toggle('hidden', !(st.images.length && st.imageModel === 'unavailable'));
    updateWords();
    paintPalette();
    sweep();
    paintPlaying(bx.strip);
    requestAnimationFrame(fitStrip);
}

const imageSig = im => (im.thumb ? im.thumb.length : 0) + '/' + im.name;
const refSig = r => (r.missing ? 'missing' : 'ok');

function imageTile(im) {
    const media = h('div.media', {},
        im.thumb ? h('img', { src: im.thumb, alt: '', draggable: 'false' }) : h('span', { style: { position: 'absolute', inset: '0', display: 'grid', placeItems: 'center', color: 'var(--fg-4)' } }, icon('image')),
        h('span.tname', { text: im.name || 'Image' }),
        h('button.rm', { 'aria-label': `Remove ${im.name || 'image'} from the brief`, 'data-tip': 'Remove from brief', onclick: () => removeImage(im) }, icon('x')));
    return h('div.tile.img', { dataset: { k: 'img:' + im.id } }, media, h('div.concepts'));
}

/** What the image model recognised: chips; pending pills while it reads; a quiet line when nothing stands out. */
function paintConcepts(el, im) {
    const box = el.querySelector('.concepts');
    if (!box) return;
    const busy = B.analysing.has(im.id);
    el.classList.toggle('analysing', busy);
    const media = el.querySelector('.media');
    if (busy) {
        if (!box.querySelector('.pending')) box.replaceChildren(...pendingPills());
        if (media && !media.querySelector('.shim') && !reduced()) media.appendChild(h('span.shim'));
        return;
    }
    for (const x of box.querySelectorAll('.pending, .cc-none')) x.remove();
    const list = conceptsOf(im);
    const quiet = new Set(B.unmatched.map(t => String(t).toLowerCase()));
    syncChips(box, list.map(c => ({ key: conceptKey(c), label: c.label, quiet: quiet.has(String(c.label).toLowerCase()), onRemove: () => removeConcept(c) })));
    if (wasRead(im) && !(im.concepts || []).length) box.appendChild(h('span.cc-none', { text: 'Nothing recognizable' }));
}

/** The image model looked at this image (older backends: it has concepts, or was re-read this session). */
const wasRead = im => (typeof im.analyzed === 'boolean' ? im.analyzed : (im.concepts || []).length > 0 || B.tried.has(im.id));

const pendingPills = () => [46, 70, 38].map(w => h('span.pending', { style: { width: w + 'px' }, 'aria-hidden': 'true' }));

function paintRefPin(el, r) {
    const b = el.querySelector('.tpin');
    if (!b) return;
    const name = stripExt(r.name), on = pinnedSet().has(refKey(r.path));
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
    b.setAttribute('aria-label', on ? `Unpin ${name}` : `Pin ${name}`);
    b.dataset.tip = on ? 'Pinned: click to unpin' : 'Pin to weigh it more';
}

function shotTile(s) {
    return h('div.tile.img.analysing', { dataset: { k: 'tmp:' + s.id }, 'aria-label': `Adding ${s.name}` },
        h('div.media', {}, h('img', { src: s.url, alt: '', draggable: 'false' }), reduced() ? null : h('span.shim')),
        B.state && B.state.imageModel === 'ready' ? h('div.concepts', {}, ...pendingPills()) : null);
}

function refTile(r) {
    const name = stripExt(r.name);
    const meta = h('div.s-meta', { text: r.missing ? 'Missing file' : folderOf(r.dir) });
    const wave = r.missing ? h('span.mw') : miniWave(r, pk => { meta.textContent = [durationOf(pk), folderOf(r.dir)].filter(Boolean).join(' · '); });
    const media = h('div.media' + (r.missing ? '' : '.aud'), {},
        h('div.s-top', {}, h('button.pb', { 'aria-label': 'Play', disabled: r.missing || null }, icon('play', 'pb-i')), h('span.kind', { text: 'Reference' })),
        h('div.s-wave', {}, wave),
        h('div.s-name', { text: name, title: relDir(r.dir || '', '') ? `${relDir(r.dir, '')} › ${name}` : name }),
        meta,
        h('button.tpin', { onclick: () => togglePin(refKey(r.path)) }, icon('pin')),
        h('button.rm', { 'aria-label': `Remove ${name} from the brief`, 'data-tip': 'Remove from brief', onclick: () => removeRef(r) }, icon('x')));
    if (!r.missing) { media._item = r; media.draggable = true; }
    return h('div.tile.snd' + (r.missing ? '.missing' : ''), { dataset: { k: 'ref:' + r.path.toLowerCase() } }, media);
}

/** A chip: the label pins it (it weighs more), the x removes it. */
function chip(label, key, onRemove) {
    const t = h('button.cc-t', { onclick: () => togglePin(key) }, icon('pin', 'pin'), h('span', { text: label }));
    t.addEventListener('keydown', e => { if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); onRemove(); } });
    const x = h('button.x', { tabindex: '-1', 'aria-label': `Remove ${label}`, onclick: e => { e.stopPropagation(); onRemove(); } }, icon('x'));
    const el = h('span.cc', {}, t, x);
    el.dataset.key = key;
    paintChip(el, label);
    return el;
}

/** Pinned state; `quiet` marks an image concept that found no strong matches in the library. */
function paintChip(el, label, quiet = false) {
    const on = pinnedSet().has(el.dataset.key), t = el.firstElementChild;
    el.classList.toggle('pinned', on);
    el.classList.toggle('quiet', quiet && !on);
    t.setAttribute('aria-pressed', String(on));
    t.setAttribute('aria-label', `${label}${on ? ', pinned' : quiet ? ', no strong matches yet' : ''}. Delete removes it`);
    t.dataset.tip = on ? 'Pinned: click to unpin' : quiet ? 'No strong matches in your library yet. Click to pin it anyway' : 'Click to pin: it weighs more';
}

/**
 * Keyed chip list: stale chips go, existing ones are repainted in place (never
 * moved, so focus survives), new ones are inserted before their successor.
 */
function syncChips(box, entries, before = null) {
    const live = new Map([...box.querySelectorAll(':scope > .cc')].map(el => [el.dataset.key, el]));
    const keys = new Set(entries.map(e => e.key));
    for (const [k, el] of live) if (!keys.has(k)) el.remove();
    let next = before;
    for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i];
        let el = live.get(e.key);
        if (el) paintChip(el, e.label, e.quiet);
        else {
            el = chip(e.label, e.key, e.onRemove);
            if (e.quiet) paintChip(el, e.label, true);
            box.insertBefore(el, next);
            if (B.visible && !reduced()) el.classList.add('in');
        }
        next = el;
    }
}

function updateWords() {
    const bx = B.box, st = B.state;
    if (!bx) return;
    syncChips(bx.words, st.words.map(w => ({ key: wordKey(w), label: w, onRemove: () => removeWord(w) })), bx.wordsIn);
    bx.wordsIn.placeholder = st.words.length ? 'Add words…' : 'Add words that describe the project…';
}

function flashChip(key) {
    const el = B.root && [...B.root.querySelectorAll('.words .cc')].find(c => c.dataset.key === key);
    if (!el) return;
    el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
}

function paintPalette() {
    const bx = B.box;
    if (!bx) return;
    const pal = palette();
    const cur = ((activeVault() || {}).color || '').toLowerCase();
    if (!pal.length) { bx.pal.replaceChildren(); return; }
    const inUse = pal.some(c => c.toLowerCase() === cur);
    bx.pal.replaceChildren(
        h('span.swatches-row', { role: 'group', 'aria-label': 'Colors from your images' }, ...pal.map(c => h('button.sw' + (c.toLowerCase() === cur ? '.on' : ''), { style: { background: c }, 'aria-label': `Use ${c} as the vault color`, 'data-tip': 'Use as vault color', onclick: () => setVaultColor(c, true) }))),
        inUse
            ? h('button.btn.sm.ghost.used', { 'data-tip': 'The vault color comes from your images. Click for the next one', onclick: () => useImageColors() }, icon('check', 'sm'), 'Image colors')
            : h('button.btn.sm', { 'data-tip': 'Make the vault color match the moodboard', onclick: () => useImageColors() }, 'Use image colors'));
}

function fitStrip() {
    const s = B.box && B.box.strip;
    if (!s || !s.isConnected) return;
    s.classList.toggle('overflowing', s.scrollWidth > s.clientWidth + 1);
    s.classList.toggle('at-end', s.scrollLeft + s.clientWidth >= s.scrollWidth - 2);
    s.classList.toggle('at-start', s.scrollLeft <= 1);
}

// ── edits ──────────────────────────────────────────────────────────────
/** Save a patch; the answer replaces the local state if nothing newer was sent since. */
async function commit(patch, { suggest = true } = {}) {
    const seq = ++B.updSeq, vid = B.vaultId;
    if (suggest) scheduleSuggest();
    let st = null;
    try { st = await sv.brief.update(patch); } catch (e) { toast('The brief could not be saved: ' + e.message, { kind: 'error' }); return null; }
    if (seq === B.updSeq && sameVault(vid)) adopt(st);
    return st;
}

function adopt(st, { anim = false } = {}) {
    if (!st || st.vaultId !== B.vaultId) return;
    const prev = B.state;
    B.state = st;
    if (!B.editingDesc && (!prev || prev.name !== st.name || prev.description !== st.description)) renderHeader();
    renderBrief({ anim });
    renderSugg();
    analyseOlderImages();
}

/**
 * Images the model never looked at (added while it was unavailable, or while
 * the engine restarted): read each of them again, one at a time, at most once
 * per session.
 */
async function analyseOlderImages() {
    if (B.analysingRun || !B.state || B.state.imageModel !== 'ready' || typeof sv.brief.analyzeImage !== 'function') return;
    B.analysingRun = true;
    try {
        for (;;) {
            const vid = B.vaultId;
            const im = B.state && B.state.images.find(x => x.thumb && !B.tried.has(x.id) && (x.analyzed === false || (x.analyzed === undefined && !(x.concepts || []).length)));
            if (!im || !sameVault(vid)) break;
            B.tried.add(im.id);
            B.analysing.add(im.id);
            renderBrief();
            let st = null;
            try {
                const pixels = await pixelsFromDataUrl(im.thumb);
                if (pixels) st = await sv.brief.analyzeImage(im.id, pixels);
            } catch (e) { console.warn('[brief] image analysis', e); }
            B.analysing.delete(im.id);
            if (!sameVault(vid)) break;
            if (st && !st.error && st.vaultId === B.vaultId) {
                const found = (st.images.find(x => x.id === im.id) || {}).concepts;
                B.state = st;
                renderBrief();
                renderSugg();
                if (found && found.length) scheduleSuggest();
            } else renderBrief();
        }
    } finally {
        B.analysingRun = false;
    }
}

/** Local change first (instant), then saved. */
function change(patch, { anim = false } = {}) {
    const wasEmpty = isEmpty(B.state);
    B.state = { ...B.state, ...patch };
    renderBrief({ anim: anim || wasEmpty !== isEmpty(B.state) });
    renderSugg();
    const out = {};
    for (const [k, v] of Object.entries(patch)) out[k] = k === 'refs' ? v.filter(r => !r.missing).map(r => r.path) : v;
    return commit(out);
}

function addWords(text) {
    if (!B.state) return;
    const parts = String(text).split(/[,\n;]+/).map(s => s.replace(/\s+/g, ' ').trim().slice(0, 60)).filter(Boolean);
    const words = B.state.words.slice();
    const have = new Set(words.map(w => w.toLowerCase()));
    let added = 0;
    for (const p of parts) {
        if (have.has(p.toLowerCase())) { flashChip(wordKey(p)); continue; }
        if (words.length >= MAX_WORDS) { toast(`A brief holds up to ${MAX_WORDS} words`, { icon: 'info' }); break; }
        words.push(p); have.add(p.toLowerCase()); added++;
    }
    if (added) change({ words });
}

function removeWord(w) {
    if (!B.state) return;
    const key = wordKey(w);
    change({ words: B.state.words.filter(x => x !== w), pinned: B.state.pinned.filter(k => k.toLowerCase() !== key) });
}

/** Put a word back in the field to edit it. */
function editWord(w) {
    removeWord(w);
    requestAnimationFrame(() => {
        const inp = B.els.secBrief.querySelector('.words-in');
        if (!inp) return;
        inp.value = w;
        inp.focus();
        inp.select();
    });
}

function togglePin(key) {
    if (!B.state) return;
    key = key.toLowerCase();
    const on = B.state.pinned.some(k => k.toLowerCase() === key);
    change({ pinned: on ? B.state.pinned.filter(k => k.toLowerCase() !== key) : [...B.state.pinned, key] });
}

function removeConcept(c) {
    if (!B.state) return;
    const key = conceptKey(c), vid = B.vaultId;
    change({ removed: [...B.state.removed, key], pinned: B.state.pinned.filter(k => k.toLowerCase() !== key) });
    toast(`Removed “${c.label}”`, { icon: 'info', action: { label: 'Undo', onClick: () => { if (sameVault(vid)) change({ removed: B.state.removed.filter(k => k.toLowerCase() !== key) }); } } });
}

async function addRefs(paths) {
    if (!B.state) return;
    const have = new Set(B.state.refs.map(r => r.path.toLowerCase()));
    const add = paths.filter(p => !have.has(p.toLowerCase()));
    if (!add.length) { toast(paths.length === 1 ? 'That sound is already a reference' : 'Those sounds are already references', { icon: 'info' }); return; }
    const room = MAX_REFS - B.state.refs.length;
    if (room <= 0) { toast(`A brief holds up to ${MAX_REFS} reference sounds`, { icon: 'info' }); return; }
    if (add.length > room) toast(`A brief holds up to ${MAX_REFS} reference sounds`, { icon: 'info' });
    await commit({ refs: [...B.state.refs.filter(r => !r.missing).map(r => r.path), ...add.slice(0, room)] });
}

function removeRef(r) {
    if (!B.state) return;
    const vid = B.vaultId, key = refKey(r.path);
    const idx = B.state.refs.findIndex(x => x.path === r.path);
    change({ refs: B.state.refs.filter(x => x.path !== r.path), pinned: B.state.pinned.filter(k => k.toLowerCase() !== key) });
    toast(`Removed “${stripExt(r.name)}” from the brief`, { icon: 'info', action: { label: 'Undo', onClick: () => {
        if (!sameVault(vid) || r.missing) return;
        const cur = B.state.refs.filter(x => !x.missing).map(x => x.path);
        cur.splice(Math.min(idx, cur.length), 0, r.path);
        commit({ refs: cur });
    } } });
}

/** Files from a drop, a paste or the file picker: images, and library sounds as references. */
async function addFiles(files) {
    if (!B.state) return;
    const images = files.filter(isImageFile);
    const refs = [];
    let outside = 0, other = 0;
    for (const f of files) {
        if (images.includes(f)) continue;
        const p = sv.pathForFile(f);
        if (/\.wav$/i.test(f.name || p) && p) { if (inLibrary(p)) refs.push(p); else outside++; }
        else other++;
    }
    if (refs.length) await addRefs(refs);
    if (images.length) await addImages(images);
    if (outside) toast('Only sounds from your library can be references. Import them first.', { icon: 'info' });
    else if (other) toast('Only images and sounds from your library can go in the brief', { icon: 'info' });
}

/** Every image shows at once (a placeholder with a short shimmer), then they are prepared one by one. */
async function addImages(files) {
    const room = MAX_IMAGES - B.state.images.length - B.shots.length;
    if (room <= 0 || files.length > room) toast(`A brief holds up to ${MAX_IMAGES} images`, { icon: 'info' });
    const shots = files.slice(0, Math.max(0, room)).map(file => ({ id: ++tmpId, file, name: file.name || 'Pasted image', url: URL.createObjectURL(file) }));
    if (!shots.length) return;
    B.shots.push(...shots);
    renderBrief();
    requestAnimationFrame(() => { const s = B.box && B.box.strip; if (s) s.scrollTo({ left: s.scrollWidth }); });
    for (const shot of shots) await addImage(shot);
}

async function addImage(shot) {
    const vid = B.vaultId, file = shot.file;
    const t0 = performance.now();
    let st = null, error = null;
    try {
        const img = await prepareImage(file);
        st = await sv.brief.addImage({ name: shot.name, bytes: img.bytes, palette: img.palette, pixels: img.pixels });
        if (st && st.error) error = st.error;
    } catch (e) {
        error = `“${shot.name}” could not be read as an image`;
    }
    const left = (reduced() ? 0 : 750) - (performance.now() - t0);    // let the shimmer finish (under a second)
    if (left > 0) await new Promise(r => setTimeout(r, left));
    B.shots = B.shots.filter(s => s !== shot);
    URL.revokeObjectURL(shot.url);
    if (!sameVault(vid)) return;
    if (st && !st.error) adopt(st); else renderBrief();
    if (error) toast(error, { kind: 'error' });
    else scheduleSuggest();
}

async function removeImage(im) {
    if (!B.state) return;
    const vid = B.vaultId;
    B.state = { ...B.state, images: B.state.images.filter(x => x.id !== im.id) };
    renderBrief({ anim: isEmpty(B.state) });
    renderSugg();
    const st = await sv.brief.removeImage(im.id).catch(() => null);
    if (st && sameVault(vid)) { adopt(st); scheduleSuggest(); }
    toast(`Removed “${im.name || 'image'}” from the brief`, { icon: 'info', action: { label: 'Undo', onClick: async () => {
        const bytes = bytesFromDataUrl(im.thumb);
        if (!bytes || !sameVault(vid)) return;
        const pixels = await pixelsFromDataUrl(im.thumb).catch(() => null);
        const back = await sv.brief.addImage({ name: im.name, bytes, palette: im.palette || [], pixels: pixels || undefined }).catch(() => null);
        if (back && !back.error && sameVault(vid)) { adopt(back); scheduleSuggest(); }
    } } });
}

async function clearBrief() {
    const snap = B.state && JSON.parse(JSON.stringify(B.state));
    if (!snap || isEmpty(snap)) return;
    const ok = await confirmDialog({ title: 'Clear the brief?', message: 'Its words, reference sounds and images are removed. Collections you created stay in the vault.', confirm: 'Clear brief', danger: true });
    if (!ok || !sameVault(snap.vaultId)) return;
    let st = await sv.brief.update({ words: [], refs: [], pinned: [], removed: [] });
    for (const im of snap.images) st = await sv.brief.removeImage(im.id);
    if (sameVault(snap.vaultId)) { adopt(st, { anim: true }); scheduleSuggest(0); }
    toast('Brief cleared', { icon: 'info', action: { label: 'Undo', onClick: async () => {
        if (!sameVault(snap.vaultId)) return;
        let back = await sv.brief.update({ words: snap.words, refs: snap.refs.filter(r => !r.missing).map(r => r.path), pinned: snap.pinned, removed: snap.removed });
        for (const im of snap.images) {
            const bytes = bytesFromDataUrl(im.thumb);
            if (!bytes) continue;
            const pixels = await pixelsFromDataUrl(im.thumb).catch(() => null);
            back = await sv.brief.addImage({ name: im.name, bytes, palette: im.palette || [], pixels: pixels || undefined });
        }
        if (sameVault(snap.vaultId)) { adopt(back, { anim: true }); scheduleSuggest(0); }
    } } });
}

function restoreDismissed() {
    if (!B.state || !B.state.dismissed.length) return;
    change({ dismissed: [] });
    toast('Dismissed suggestions are back', { icon: 'info' });
}

// ── vault color from the moodboard ─────────────────────────────────────
async function setVaultColor(color, withUndo) {
    const v = activeVault();
    if (!v || !color || v.color.toLowerCase() === color.toLowerCase()) return;
    const prev = v.color;
    quiet();
    await sv.vaults.update(v.id, { color });
    await A.refreshCollections();
    refreshColors();
    if (B.state && B.state.vaultId === v.id) B.state = { ...B.state, color };
    paintPalette();
    if (withUndo) toast('Vault color updated', { action: { label: 'Undo', onClick: () => setVaultColor(prev, false) } });
}

function useImageColors() {
    const pal = palette();
    if (!pal.length) return;
    const cur = ((activeVault() || {}).color || '').toLowerCase();
    const i = pal.findIndex(c => c.toLowerCase() === cur);
    if (i >= 0) { setVaultColor(pal[(i + 1) % pal.length], false); return; }
    const prev = (activeVault() || {}).color;
    setVaultColor(pal[0], false).then(() => toast('The vault now uses a color from your images', { action: { label: 'Undo', onClick: () => setVaultColor(prev, false) } }));
}

// ── suggestions ────────────────────────────────────────────────────────
function scheduleSuggest(delay = 300) {
    clearTimeout(B.timer);
    B.pending = true;
    paintPending();
    B.timer = setTimeout(runSuggest, delay);
}

async function runSuggest() {
    clearTimeout(B.timer);
    B.timer = null;
    const seq = ++B.seq, vid = B.vaultId;
    if (!B.state) { B.pending = false; return; }
    if (!hasQueries(B.state)) {
        Object.assign(B, { pending: false, status: 'empty', cards: [], more: 0, unmatched: [] });
        renderSugg({ animate: true });
        publishCount();
        return;
    }
    B.pending = true;
    B.lastRun = Date.now();
    if (!B.cards.length && B.status !== 'notReady') B.status = 'loading';
    renderSugg();
    let res;
    try { res = await sv.brief.suggest({ max: B.max }); } catch (e) { res = { cards: [], error: e.message }; }
    if (seq !== B.seq || !sameVault(vid)) return;                 // a newer request or another vault
    B.pending = false;
    if (res.empty) Object.assign(B, { status: 'empty', cards: [], more: 0, unmatched: [] });
    else if (res.notReady) B.status = 'notReady';
    else if (res.error) { B.status = B.cards.length ? 'ready' : 'error'; console.warn('[brief] suggest', res.error); }
    else Object.assign(B, { status: 'ready', cards: res.cards || [], more: res.more || 0, unmatched: openUnmatched(res.unmatched || []) });
    renderSugg({ animate: true });
    if (B.box) updateBox();                       // image concepts without matches turn quiet
    publishCount();
}

/** Brief items with no strong matches, leaving out the ones already turned into a collection or dismissed. */
function openUnmatched(titles) {
    const st = B.state;
    const done = new Set([...Object.keys(st.created || {}), ...(st.dismissed || [])].map(k => String(k).toLowerCase()));
    const seen = new Set();
    return titles.filter(t => {
        const k = String(t).toLowerCase();
        if (seen.has(k)) return false;                // a word and an image concept can share a label
        seen.add(k);
        const w = st.words.find(x => x.toLowerCase() === String(t).toLowerCase());
        if (w) return !done.has(wordKey(w));
        const r = String(t).startsWith('Like ') && st.refs.find(x => stripExt(x.name) === String(t).slice(5));
        if (r) return !done.has(refKey(r.path));
        return true;
    });
}

function publishCount() {
    setBriefCount(B.status === 'ready' || B.status === 'empty' ? B.cards.length : null);
}

/** The sidebar count while the Brief is not shown (boot, vault switch, a reference added elsewhere). */
const countSoon = debounce(async () => {
    if (B.visible || state.mode !== 'vault' || !state.engine.ready) return;
    const vid = state.vaults.activeVaultId;
    const st = await sv.brief.get().catch(() => null);
    if (!st || B.visible || vid !== state.vaults.activeVaultId) return;
    if (!hasQueries(st)) { setBriefCount(0); return; }
    const res = await sv.brief.suggest({ max: FIRST_MAX }).catch(() => null);
    if (res && !B.visible && vid === state.vaults.activeVaultId) setBriefCount(res.cards && !res.notReady && !res.error ? res.cards.length : null);
}, 900);

let engineWas = { ready: false, indexing: false, model: false };
function onEngine(st) {
    const becameReady = st.ready && !engineWas.ready;
    const doneIndexing = engineWas.indexing && !st.indexing;
    const startedIndexing = !engineWas.indexing && st.indexing;
    const model = st.imageModel === 'ready', modelChanged = model !== engineWas.model;
    engineWas = { ready: st.ready, indexing: st.indexing, model };
    // The brief state carries the image model status too: read it again (older images get analysed).
    if (becameReady || modelChanged) { if (B.visible) refreshBrief(); else countSoon(); return; }
    if (doneIndexing) { if (B.visible) { scheduleSuggest(0); loadMore(); } else countSoon(); return; }
    if (!B.visible) return;
    // While a library is analysed for the first time, suggestions grow with it.
    if (st.indexing && hasQueries(B.state) && !B.pending && Date.now() - (B.lastRun || 0) > 20000) scheduleSuggest(0);
    else if (startedIndexing) renderSugg();
}

function buildSugg() {
    const mark = icon('resonance');
    const sub = h('span.sub');
    const head = h('div.sec-head', {}, h('h2', {}, mark, 'Suggested collections'), sub);
    const ghost = h('div.ghost-cards', { 'aria-hidden': 'true' }, ...[0, 1, 2].map(i => h('div.gcard', {},
        h('i', { style: { width: [46, 38, 52][i] + '%' } }), h('i', { style: { width: [30, 40, 26][i] + '%', height: '6px', opacity: '.7' } }),
        h('i', { style: { width: '88%', marginTop: '10px' } }), h('i', { style: { width: '74%' } }), h('i', { style: { width: '82%' } }), h('i', { style: { width: '64%' } }))));
    const cards = h('div.cards');
    const empty = h('div.cards-empty.hidden');
    const foot = h('div.cards-foot');
    B.els.secSugg.replaceChildren(head, ghost, cards, empty, foot);
    B.sugg = { mark, sub, head, ghost, cards, empty, foot };
}

function fromText() {
    const st = B.state;
    const im = st.images.filter(x => conceptsOf(x).length).length, so = st.refs.filter(r => !r.missing).length, wo = st.words.length;
    if (!im && !so && wo && wo <= 2) return 'From ' + st.words.map(w => `“${w}”`).join(' and ');
    const p = [];
    if (im) p.push(count(im, 'image'));
    if (so) p.push(count(so, 'sound'));
    if (wo) p.push(count(wo, 'word'));
    return p.length ? 'From ' + (p.length > 1 ? p.slice(0, -1).join(', ') + ' and ' + p[p.length - 1] : p[0]) : '';
}

function paintPending() {
    if (!B.sugg) return;
    const on = B.pending && hasQueries(B.state);
    B.sugg.mark.classList.toggle('listening', on);
    B.sugg.cards.classList.toggle('pending', on);
}

function renderSugg({ animate = false } = {}) {
    const s = B.sugg, st = B.state;
    if (!s) return;
    const sec = B.els.secSugg;
    const queries = hasQueries(st);
    const analysing = !!state.engine.indexing || (state.engine.ready && !state.engine.vectors);
    const waiting = queries && !B.cards.length && (B.status === 'loading' || B.status === 'notReady' || B.status === 'idle' || (analysing && B.status !== 'error'));
    sec.classList.toggle('ghost', !queries);
    sec.classList.toggle('waiting', waiting);
    s.ghost.classList.toggle('hidden', queries && !waiting);
    let sub = '';
    if (!st) sub = '';
    else if (!queries) sub = st.images.length ? 'Add words or reference sounds to get suggestions' : 'Appear here as you add to the brief';
    else if (B.status === 'notReady') sub = 'Resonance is starting. Suggestions appear in a moment';
    else if (waiting && analysing) sub = 'Your library is still being analysed. Suggestions appear as it goes';
    else if (waiting) sub = 'Listening to your library…';
    else {
        sub = fromText();
        if (state.engine.indexing) sub += ' · your library is still being analysed';
    }
    s.sub.textContent = sub;
    syncCards(queries && !waiting ? B.cards : [], animate && B.visible && !reduced());
    paintPending();
    // nothing to show: say why, calmly
    const showEmpty = queries && !waiting && !B.cards.length;
    s.empty.classList.toggle('hidden', !showEmpty);
    if (!showEmpty) s.empty.replaceChildren();
    s.foot.replaceChildren();
    if (showEmpty) {
        if (B.status === 'error') {
            s.empty.replaceChildren(h('b', { text: 'Suggestions are unavailable right now' }), 'Resonance could not answer. Try again in a moment.', h('div', {}, h('button.btn.sm', { onclick: () => scheduleSuggest(0) }, icon('refresh', 'sm'), 'Try again')));
        } else if (typedUnmatched().length) {
            s.empty.replaceChildren(h('b', { text: 'Nothing to suggest yet' }), unmatchedLine(typedUnmatched()));
        } else if (B.unmatched.length) {
            s.empty.replaceChildren(h('b', { text: 'Nothing to suggest yet' }), 'What the images show has no strong matches in your library yet. A few words help.');
        } else {
            const d = st.dismissed.length;
            fill(s.empty, h('b', { text: 'Nothing new to suggest' }), 'Add words, images or reference sounds, or pin what matters most.',
                d ? h('div', {}, h('button.btn.sm', { onclick: () => restoreDismissed() }, icon('undo', 'sm'), `Restore ${count(d, 'dismissed suggestion')}`)) : null);
        }
    } else if (queries && !waiting) {
        if (typedUnmatched().length) s.foot.append(unmatchedLine(typedUnmatched()));
        if (B.more > 0 && B.max < MORE_MAX) s.foot.append(h('button.btn.sm.ghost.show-more', { onclick: () => { B.max = MORE_MAX; scheduleSuggest(0); } }, `Show ${Math.min(B.more, MORE_MAX - B.max)} more`));
    }
}

/** Unmatched words and references (image concepts show it on their own chips instead). */
function typedUnmatched() {
    const st = B.state;
    return B.unmatched.filter(t => st.words.some(w => w.toLowerCase() === String(t).toLowerCase()) || (String(t).startsWith('Like ') && st.refs.some(r => stripExt(r.name) === String(t).slice(5))));
}

/** "No strong matches yet for: a, b. Try other words." Each item opens a small menu. */
function unmatchedLine(titles) {
    const st = B.state;
    const parts = [];
    titles.forEach((t, i) => {
        if (i) parts.push(', ');
        parts.push(h('button.um', { text: t, 'aria-label': `${t}: edit or remove`, 'aria-haspopup': 'menu', onclick: e => unmatchedMenu(e.currentTarget, t) }));
    });
    const anyWord = titles.some(t => st.words.includes(t));
    return h('div.unmatched', {}, icon('info'), h('span', {}, 'No strong matches yet for: ', ...parts, anyWord ? '. Try other words.' : '.'));
}

function unmatchedMenu(anchor, t) {
    const st = B.state;
    const w = st.words.find(x => x === t) || st.words.find(x => x.toLowerCase() === t.toLowerCase());
    if (w) return showMenu(anchor, [{ label: 'Edit word', icon: 'pencil', onClick: () => editWord(w) }, { label: 'Remove word', icon: 'x', onClick: () => removeWord(w) }]);
    const r = t.startsWith('Like ') && st.refs.find(x => stripExt(x.name) === t.slice(5));
    if (r) return showMenu(anchor, [{ label: 'Remove reference', icon: 'x', onClick: () => removeRef(r) }]);
    for (const im of st.images) {
        const c = (im.concepts || []).find(x => x.label === t);
        if (c) return showMenu(anchor, [{ label: `Remove “${c.label}”`, icon: 'x', onClick: () => removeConcept(c) }]);
    }
}

// ── cards ──────────────────────────────────────────────────────────────
const cardSig = c => [tintFor(c) || '', c.weak ? 1 : 0, c.candidates.length, c.total, (c.reasons || []).map(r => r.key + (pinnedSet().has(String(r.key).toLowerCase()) ? '*' : '') + r.label).join('|'), c.candidates.slice(0, ROWS).map(x => x.path).join('|')].join('/');

function cardEl(c) {
    const el = h('article.card');
    el.dataset.key = c.key;
    fillCard(el, c);
    return el;
}

function fillCard(el, c) {
    const tint = tintFor(c);
    const n = c.candidates.length;
    const title = cap(c.title);
    el.style.setProperty('--tint', tint || 'transparent');
    el.classList.toggle('weak', !!c.weak);
    el.setAttribute('aria-label', `Suggested collection: ${title}, ${count(n, 'candidate')}`);
    const countTip = c.weak ? 'Pinned: shown although the matches are loose' : c.total > n ? `The best ${n} of ${c.total} matches` : null;
    el.replaceChildren(
        h('header.c-head', {}, h('span.c-color' + (tint ? '' : '.none')), h('h3', { text: title, title }), h('span.c-count', { text: count(n, 'candidate'), 'data-tip': countTip })),
        h('div.why', {}, ...(c.reasons || []).map(reasonChip)),
        h('div.c-rows', {}, ...c.candidates.slice(0, ROWS).map((it, i) => soundRow(it, i))),
        h('footer.c-foot', {},
            h('button.btn.primary', { 'data-act': 'create', 'data-tip': `Creates it with ${count(n, 'sound')}`, onclick: () => createFromCard(el._card) }, 'Create collection'),
            h('button.btn', { 'data-act': 'review', 'data-tip': `Go through all ${n}`, onclick: e => reviewCard(el._card, e.currentTarget) }, 'Review'),
            h('button.btn.ghost.dismiss', { 'data-act': 'dismiss', onclick: () => dismiss(el._card) }, 'Dismiss')));
    el._card = c;
    el._sig = cardSig(c);
}

/** Why a card exists: the word, reference sound or image concept behind it. */
function reasonChip(r) {
    const pinned = pinnedSet().has(String(r.key).toLowerCase());
    let mark = null, tip;
    if (r.kind === 'sound') { mark = h('span.src.s', {}, icon('wave')); tip = `Sounds like the reference “${r.label}”`; }
    else if (r.kind === 'concept') {
        const im = imageOfConcept(r.key);
        if (im && im.thumb) mark = h('span.src', { style: { backgroundImage: `url("${im.thumb}")` } });
        tip = im ? `From ${im.name || 'an image'}` : 'From an image';
    } else tip = 'From your words';
    if (pinned) { mark = icon('pin', 'pin'); tip += ' · pinned'; }
    return h('span.wc' + (pinned ? '.pinned' : ''), { 'data-tip': tip }, mark, h('span.l', { text: r.label }));
}

/** A candidate row: rank, name, mini waveform, duration (+ an optional trailing control). */
function soundRow(it, i, extra = null) {
    const du = h('span.du');
    const name = stripExt(it.name);
    const row = h('div.c-row.aud', { role: 'button', tabindex: '0', draggable: 'true', title: relDir(it.dir || '', '') || 'Library root', 'aria-label': `Play ${name}` },
        h('span.pb', { 'aria-hidden': 'true' }, h('span.rank', { text: String(i + 1) }), icon('play', 'play'), icon('pause', 'pause'), h('span.eq', {}, h('i'), h('i'), h('i'))),
        h('span.nm', { text: name }),
        miniWave(it, pk => { du.textContent = durationOf(pk); }),
        du, extra);
    row._item = it;
    return row;
}

/** Diff the grid: leavers fade out of flow, stayers slide (FLIP), newcomers rise in. */
function syncCards(next, animate) {
    const grid = B.sugg.cards;
    const live = [...grid.querySelectorAll(':scope > .card:not(.leaving)')];
    const first = animate ? new Map(live.map(e => [e, e.getBoundingClientRect()])) : null;
    const g = animate ? grid.getBoundingClientRect() : null;
    const keys = new Set(next.map(c => c.key));
    for (const e of live) {
        if (keys.has(e.dataset.key)) continue;
        if (!animate || e.classList.contains('flown')) { e.remove(); continue; }
        const r = first.get(e);
        e.classList.add('leaving');
        Object.assign(e.style, { position: 'absolute', left: r.left - g.left + 'px', top: r.top - g.top + 'px', width: r.width + 'px', height: r.height + 'px' });
        e.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(.96)' }], { duration: 220, easing: 'ease-in', fill: 'forwards' }).onfinish = () => e.remove();
    }
    const entering = [];
    const byKey = new Map(live.filter(e => keys.has(e.dataset.key)).map(e => [e.dataset.key, e]));
    let at = grid.firstElementChild;
    for (const c of next) {
        let e = byKey.get(c.key);
        if (!e) { e = cardEl(c); entering.push(e); }
        else if (e._sig !== cardSig(c)) { fillCard(e, c); if (animate) shimmer(e); }
        else e._card = c;
        while (at && at !== e && at.classList.contains('leaving')) at = at.nextElementSibling;
        if (at !== e) grid.insertBefore(e, at);
        else at = at.nextElementSibling;
    }
    sweep();
    paintPlaying(grid);
    if (!animate) return;
    for (const e of grid.querySelectorAll(':scope > .card:not(.leaving)')) {
        const r0 = first.get(e);
        if (!r0) continue;
        const r1 = e.getBoundingClientRect(), dx = r0.left - r1.left, dy = r0.top - r1.top;
        if (dx || dy) e.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 420, easing: 'cubic-bezier(.2,.8,.2,1)' });
    }
    entering.forEach((e, k) => e.animate([{ opacity: 0, transform: 'translateY(10px) scale(.985)' }, { opacity: 1, transform: 'none' }], { duration: 440, delay: 80 + k * 70, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'backwards' }));
}

function shimmer(el) {
    if (reduced()) return;
    const s = h('span.shim');
    el.appendChild(s);
    setTimeout(() => s.remove(), 800);
}

const cardElFor = key => [...B.sugg.cards.querySelectorAll(':scope > .card:not(.leaving)')].find(e => e.dataset.key === key) || null;

function reviewCard(card, opener) {
    if (!card) return;
    openReview({
        title: cap(card.title), color: tintFor(card), items: card.candidates,
        reasons: (card.reasons || []).map(reasonChip),
        listLabel: 'Candidates, best first', noun: 'candidate',
        confirm: n => (n ? `Create collection with ${count(n, 'sound')}` : 'Create collection'),
        onConfirm: items => createFromCard(card, items),
        opener,
    });
}

async function createFromCard(card, chosen = null) {
    if (!card || B.busy.has(card.key)) return;
    B.busy.add(card.key);
    const vid = B.vaultId, key = card.key;
    const tint = tintFor(card);
    const paths = (chosen || card.candidates).map(x => x.path);
    let res = null;
    try { res = await sv.brief.create({ key, title: cap(card.title), paths }); } catch (e) { res = { ok: false, error: e.message }; }
    if (!res || !res.ok) { B.busy.delete(key); toast((res && res.error) || 'The collection could not be created', { kind: 'error' }); return; }
    const name = res.name;
    quiet();
    if (tint) await sv.collections.setColor(name, tint).catch(() => {});
    markCollection(name, 'arriving', true);                // hidden until the card lands
    await A.refreshCollections();
    if (B.state && sameVault(vid)) B.state = { ...B.state, created: { ...B.state.created, [key]: name } };
    B.cards = B.cards.filter(c => c.key !== key);
    const el = cardElFor(key), node = collectionNode(name);
    if (el && node && B.visible && sidebarShown() && !reduced() && onScreen(el)) {
        node.scrollIntoView({ block: 'nearest' });
        await fly(el, node, { name, color: tint, count: res.added });
    } else if (el) el.classList.add('flown');
    markCollection(name, 'arriving', false);
    markCollection(name, 'landed', true);
    setTimeout(() => markCollection(name, 'landed', false), 1900);
    syncCards(B.cards, B.visible && !reduced());
    publishCount();
    B.busy.delete(key);
    toast(`Created “${name}” with ${count(res.added, 'sound')}`, { actions: [
        { label: 'Open', onClick: () => bus.emit('nav:collection', name) },
        { label: 'Undo', onClick: () => undoCreate(vid, name, key) },
    ] });
    scheduleSuggest();
    loadMore();
}

async function undoCreate(vid, name, key) {
    if (vid !== state.vaults.activeVaultId) { toast('Switch back to that vault to undo', { icon: 'info' }); return; }
    quiet();
    await sv.collections.remove(name);
    const st = await sv.brief.update({ created: { [key]: null } }).catch(() => null);
    await A.refreshCollections();
    bus.emit('collection:deleted', name);
    if (st && sameVault(vid)) { adopt(st); scheduleSuggest(0); loadMore(); } else countSoon();
}

function dismiss(card) {
    if (!card || !B.state) return;
    const vid = B.vaultId, key = card.key;
    B.cards = B.cards.filter(c => c.key !== key);
    syncCards(B.cards, B.visible && !reduced());
    publishCount();
    change({ dismissed: [...B.state.dismissed, key] });
    toast(`Dismissed “${cap(card.title)}”`, { icon: 'info', action: { label: 'Undo', onClick: () => {
        if (sameVault(vid)) change({ dismissed: B.state.dismissed.filter(k => k !== key) });
    } } });
}

const onScreen = el => { const r = el.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight && r.width > 0; };

/** The card (or a More tile) folds into its sidebar node. */
function fly(fromEl, toEl, col, withSnapshot = true) {
    return new Promise(resolve => {
        const a = fromEl.getBoundingClientRect(), b = toEl.getBoundingClientRect();
        const g = h('div.fly');
        let snap = null;
        if (withSnapshot) {
            snap = fromEl.cloneNode(true);
            snap.classList.remove('flown', 'leaving');
            Object.assign(snap.style, { width: a.width + 'px', height: a.height + 'px' });
            const src = fromEl.querySelectorAll('canvas'), dst = snap.querySelectorAll('canvas');
            src.forEach((c, i) => { const d = dst[i]; if (!d || !c.width || !c.height) return; d.width = c.width; d.height = c.height; d.getContext('2d').drawImage(c, 0, 0); });
            g.appendChild(snap);
        }
        const node = h('div.fly-node', {}, h('span.col-color' + (col.color ? '' : '.none'), { style: col.color ? { background: col.color } : null }), h('span.name', { text: col.name }), h('span.cnt', { text: String(col.count) }));
        g.appendChild(node);
        Object.assign(g.style, { left: a.left + 'px', top: a.top + 'px', width: a.width + 'px', height: a.height + 'px' });
        document.body.appendChild(g);
        if (withSnapshot) fromEl.classList.add('flown');
        const dur = 720, px = v => v + 'px';
        const anim = g.animate([
            { left: px(a.left), top: px(a.top), width: px(a.width), height: px(a.height), borderRadius: '12px', easing: 'cubic-bezier(.45,0,.25,1)' },
            { left: px(a.left + 10), top: px(a.top + 8), width: px(Math.max(120, Math.min(a.width - 20, 230))), height: '34px', borderRadius: '8px', offset: 0.36, easing: 'cubic-bezier(.55,0,.15,1)' },
            { left: px(b.left), top: px(b.top), width: px(b.width), height: px(b.height), borderRadius: '6px' },
        ], { duration: dur, fill: 'forwards' });
        if (snap) snap.animate([{ opacity: 1 }, { opacity: 0, offset: 0.3 }, { opacity: 0 }], { duration: dur, fill: 'forwards' });
        node.animate([{ opacity: withSnapshot ? 0 : 1 }, { opacity: withSnapshot ? 0 : 1, offset: 0.22 }, { opacity: 1, offset: 0.4 }, { opacity: 1 }], { duration: dur, fill: 'forwards' });
        const done = () => { g.remove(); resolve(); };
        anim.onfinish = done;
        anim.oncancel = done;
    });
}

// ── More for your collections ──────────────────────────────────────────
async function loadMore() {
    const seq = ++B.moreSeq, vid = B.vaultId;
    let res = null;
    try { res = await sv.brief.more(); } catch (e) { res = null; }
    if (seq !== B.moreSeq || !sameVault(vid)) return;
    B.moreCols = ((res && res.collections) || []).filter(c => c.suggestions && c.suggestions.length);
    renderMore();
}

function renderMore() {
    const sec = B.els.secMore;
    if (!B.moreCols.length) { sec.replaceChildren(); sweep(); return; }
    sec.replaceChildren(
        h('div.sec-head', {}, h('h2', { text: 'More for your collections' }), h('span.sub', { text: 'Sounds from your library that resonate with what they already hold' })),
        h('div.more', {}, ...B.moreCols.map(moreTile)));
    sweep();
    paintPlaying(sec);
}

function moreTile(col) {
    const el = h('div.mc', { role: 'group', 'aria-label': `More for ${col.name}` });
    el._col = col;
    fillMore(el);
    return el;
}

function fillMore(el) {
    const col = el._col, n = col.suggestions.length;
    const add = it => h('button.icon-btn.sm.add', { 'aria-label': `Add ${stripExt(it.name)} to ${col.name}`, 'data-tip': `Add to ${col.name}`, onclick: e => { e.stopPropagation(); addToMore(el, [it]); } }, icon('plus', 'sm'));
    el.replaceChildren(
        h('div.mc-head', {}, h('span.col-color' + (col.color ? '' : '.none'), { style: col.color ? { background: col.color } : null }), h('span.mc-name', { text: col.name, title: col.name }), h('span.mc-sub', {}, h('b', { text: '+' + n }), ' that resonate')),
        h('div.c-rows', {}, ...col.suggestions.slice(0, 3).map((it, i) => soundRow(it, i, add(it)))),
        h('div.c-foot', {},
            h('button.btn.primary', { 'data-tip': `Adds all ${n} to ${col.name}`, onclick: () => addToMore(el, col.suggestions.slice(), true) }, n > 1 ? `Add all ${n}` : 'Add it'),
            h('button.btn', { 'data-tip': `Go through all ${n}`, onclick: e => reviewMore(el, e.currentTarget) }, 'Review')));
    if (el.isConnected) { sweep(); paintPlaying(el); }     // a new tile is swept once it is in the page
}

function reviewMore(el, opener) {
    const col = el._col;
    openReview({
        title: col.name, color: col.color || null, items: col.suggestions,
        note: `Sounds from your library that resonate with the ${count(col.count, 'sound')} already in this collection.`,
        listLabel: 'Suggested additions', noun: 'sound',
        confirm: n => (n ? `Add ${count(n, 'sound')} to ${col.name}` : 'Add to collection'),
        onConfirm: items => addToMore(el, items, items.length > 1),
        opener,
    });
}

/** Add suggestions to an existing collection (one row, the reviewed ones, or all). */
async function addToMore(el, items, flyIt = false) {
    const col = el._col, vid = B.vaultId;
    if (!items.length) return;
    const paths = items.map(i => i.path);
    quiet();
    const n = await sv.collections.add(col.name, paths).catch(() => 0);
    await A.refreshCollections();
    if (!sameVault(vid)) return;
    const node = collectionNode(col.name);
    col.suggestions = col.suggestions.filter(s => !paths.includes(s.path));
    col.count += n;
    if (!col.suggestions.length) {
        if (flyIt && node && el.isConnected && B.visible && sidebarShown() && !reduced() && onScreen(el)) await fly(el, node, { name: col.name, color: col.color, count: '+' + n }, false);
        removeMoreTile(el);
    } else fillMore(el);
    if (node) { markCollection(col.name, 'bump', true); setTimeout(() => markCollection(col.name, 'bump', false), 700); }
    const one = items.length === 1;
    const msg = !n ? (one ? `Already in ${col.name}` : `All already in ${col.name}`) : one ? `Added “${stripExt(items[0].name)}” to ${col.name}` : `Added ${count(n, 'sound')} to ${col.name}`;
    toast(msg, n ? { actions: [
        { label: 'Open', onClick: () => bus.emit('nav:collection', col.name) },
        { label: 'Undo', onClick: async () => { if (vid !== state.vaults.activeVaultId) return; quiet(); await sv.collections.removeItems(col.name, paths); await A.refreshCollections(); if (B.visible) { loadMore(); scheduleSuggest(); } } },
    ] } : { icon: 'info' });
    scheduleSuggest();                       // those sounds now belong to the vault
}

function removeMoreTile(el) {
    const grid = el.parentElement;
    B.moreCols = B.moreCols.filter(c => c !== el._col);
    if (!grid || !B.moreCols.length) { renderMore(); return; }
    const others = [...grid.children].filter(x => x !== el);
    const first = new Map(others.map(x => [x, x.getBoundingClientRect()]));
    el.remove();
    if (reduced()) return;
    for (const x of others) {
        const r0 = first.get(x), r1 = x.getBoundingClientRect();
        if (r0.left !== r1.left || r0.top !== r1.top) x.animate([{ transform: `translate(${r0.left - r1.left}px, ${r0.top - r1.top}px)` }, { transform: 'none' }], { duration: 380, easing: 'cubic-bezier(.2,.8,.2,1)' });
    }
}

// ── paste: images become moodboard items, text becomes words ───────────
function onPaste(e) {
    if (!B.visible || !B.state || isDialogOpen()) return;
    const t = e.target;
    const inWords = !!(t && t.classList && t.classList.contains('words-in'));
    if (isEditableTarget(t) && !inWords) return;
    const cd = e.clipboardData;
    if (!cd) return;
    let files = [...cd.files];
    if (!files.length) files = [...cd.items].filter(i => i.kind === 'file').map(i => i.getAsFile()).filter(Boolean);
    if (files.length) { e.preventDefault(); addFiles(files); return; }
    if (inWords) return;                      // text pasted into the field stays there until Enter
    const txt = cd.getData('text/plain');
    if (txt && txt.trim()) { e.preventDefault(); addWords(txt); }
}
