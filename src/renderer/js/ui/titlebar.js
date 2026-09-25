// Titlebar: brand (mode switch), search (scope + AI + word weights), engine status.
import { h, icon, debounce, count, clamp } from '../util.js';
import { state, bus } from '../store.js';
import { createMark, setMarkMode } from './logo.js';
import { showMenu } from './overlays.js';

let els = {};

export function mountTitlebar(el) {
    const mark = createMark(state.mode);
    const word = h('span.word', { text: state.mode === 'sounds' ? 'Sound' : 'Vault' });
    const underline = h('span.underline');
    const brand = h('div.brand', { role: 'button', tabindex: '0', 'data-tip': 'Switch mode', 'data-kbd': 'Ctrl+Tab', 'aria-label': 'Switch between Vault and Sound mode' },
        mark, h('span.word-wrap', {}, word, underline));
    brand.addEventListener('click', () => bus.emit('mode:toggle'));
    brand.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); bus.emit('mode:toggle'); } });
    brand.addEventListener('mouseenter', () => { if (mark.classList.contains('sound')) mark.classList.add('alive'); });
    brand.addEventListener('mouseleave', () => mark.classList.remove('alive'));

    const input = h('input', { type: 'text', placeholder: 'Search…', spellcheck: 'false', 'aria-label': 'Search sounds' });
    const scope = h('button.chip.scope', { 'aria-label': 'Search scope', 'data-tip': 'Where to search' });
    const ai = h('button.chip.ai', { 'aria-pressed': 'false', 'data-tip': 'Describe how it sounds', 'data-kbd': 'Ctrl+I' }, icon('resonance', 'xs'), 'Describe');
    const words = h('span.words');
    const clear = h('button.icon-btn.sm.clear', { 'aria-label': 'Clear search', 'data-tip': 'Clear', 'data-kbd': 'Esc' }, icon('x', 'sm'));
    const box = h('div.search', { role: 'search' }, icon('search'), input, words, clear, scope, ai);

    // Library states show a LED; the engine's own states show Resonance's mark (it "listens" while analysing).
    const pill = h('button.status-pill', { 'aria-label': 'Library status' }, h('span.led'), icon('resonance', 'rz'), h('span.txt'), h('span.meter.hidden', {}, h('i')));
    pill.addEventListener('click', () => bus.emit('settings:open', 'catalog'));
    const gear = h('button.icon-btn', { 'data-tip': 'Settings', 'data-kbd': 'Ctrl+,', 'aria-label': 'Settings' }, icon('gear'));
    gear.addEventListener('click', () => bus.emit('settings:open'));

    el.append(brand, box, h('div.drag-space'), h('div.tb-right', {}, pill, gear));
    els = { mark, word, underline, brand, input, scope, ai, words, clear, box, pill };

    const fire = debounce(() => bus.emit('search:run', { q: input.value, weights: null }), 160);
    const fireAI = debounce(() => bus.emit('search:run', { q: input.value, weights: null }), 450);
    input.addEventListener('input', () => {
        box.classList.toggle('has-text', !!input.value);
        words.replaceChildren();
        (state.view.ai ? fireAI : fire)();
    });
    input.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); fire.cancel(); fireAI.cancel(); bus.emit('search:run', { q: input.value, weights: null, now: true }); }
        else if (e.key === 'Escape') { e.preventDefault(); if (input.value) clearSearch(); else input.blur(); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); input.blur(); bus.emit('list:focus'); }
    });
    clear.addEventListener('click', () => { clearSearch(); input.focus(); });
    ai.addEventListener('click', () => bus.emit('search:toggle-ai'));
    scope.addEventListener('click', () => {
        const opts = scopeOptions();
        showMenu(scope, opts.map(o => ({ label: o.label, icon: o.icon, checked: o.value === effectiveScope(), onClick: () => bus.emit('search:scope', o.value) })));
    });

    bus.on('mode', mode => {
        setMarkMode(mark, mode);
        swapWord(mode === 'sounds' ? 'Sound' : 'Vault');
        brand.setAttribute('data-tip', mode === 'sounds' ? 'Switch to Vault mode' : 'Switch to Sound mode');
        renderSearchChrome();
    });
    bus.on('view', renderSearchChrome);
    bus.on('engine', renderStatus);
    bus.on('library-status', renderStatus);
    bus.on('search:words', renderWords);
    renderSearchChrome();
    renderStatus();
    requestAnimationFrame(() => { underline.style.width = word.offsetWidth - 3 + 'px'; });
}

function clearSearch() {
    els.input.value = '';
    els.box.classList.remove('has-text');
    els.words.replaceChildren();
    bus.emit('search:run', { q: '', now: true });
}

export function focusSearch() { els.input.focus(); els.input.select(); }
export function setSearchText(q) { els.input.value = q; els.box.classList.toggle('has-text', !!q); }

function swapWord(text) {
    const w = els.word;
    if (w.textContent === text) return;
    w.classList.remove('in'); w.classList.add('out');
    setTimeout(() => {
        w.textContent = text;
        w.classList.remove('out'); w.classList.add('in');
        els.underline.style.width = Math.max(0, w.offsetWidth - 3) + 'px';
    }, 160);
}

export function scopeOptions() {
    const v = state.view, out = [];
    if (state.mode === 'vault') {
        out.push({ value: 'vault', label: 'Whole vault', icon: 'vault' });
        if (v.collection) out.push({ value: 'collection', label: `“${v.collection}”`, icon: 'collection' });
        out.push({ value: 'library', label: 'Entire library', icon: 'library' });
    } else {
        out.push({ value: 'library', label: 'Entire library', icon: 'library' });
        if (v.folder) out.push({ value: 'folder', label: `“${v.folder.split('/').pop()}”`, icon: 'folder' });
    }
    return out;
}

/** Scope actually used for the current mode/view ('auto' resolves to the mode default). */
export function effectiveScope() {
    const v = state.view, opts = scopeOptions().map(o => o.value);
    if (v.scope !== 'auto' && opts.includes(v.scope)) return v.scope;
    return state.mode === 'vault' ? 'vault' : 'library';
}

function renderSearchChrome() {
    if (!els.scope) return;
    const sc = effectiveScope();
    const o = scopeOptions().find(x => x.value === sc);
    els.scope.replaceChildren(document.createTextNode(o ? (sc === 'library' ? 'Library' : sc === 'vault' ? 'Vault' : o.label) : 'Library'), icon('chev-d', 'xs'));
    const aiReady = state.engine.ready && state.engine.vectors > 0;
    els.ai.classList.toggle('on', state.view.ai);
    els.ai.classList.toggle('disabled', !aiReady && !state.view.ai);
    els.ai.setAttribute('aria-pressed', String(state.view.ai));
    els.ai.dataset.tip = !state.engine.ready ? 'Resonance is starting…' : !state.engine.vectors ? 'Available once sounds are analysed' : 'Describe how it sounds';
    const where = sc === 'folder' ? 'this folder' : sc === 'collection' ? 'this collection' : sc === 'vault' ? 'the vault' : 'the library';
    els.input.placeholder = state.view.ai ? `Describe a sound… (${where})` : `Search ${where}…`;
}

function renderStatus() {
    if (!els.pill) return;
    const e = state.engine, lib = state.library, pill = els.pill;
    const txt = pill.querySelector('.txt'), meter = pill.querySelector('.meter');
    pill.classList.remove('ready', 'busy', 'warn', 'engine');
    meter.classList.add('hidden');
    if (!lib.exists) { pill.classList.add('warn'); txt.textContent = 'Library folder not found'; return; }
    if (!lib.ready) { pill.classList.add('busy'); txt.textContent = 'Scanning library…'; return; }
    const meterTo = (cur, total) => { meter.classList.remove('hidden'); meter.firstChild.style.width = (total ? clamp(cur / total * 100, 0, 100) : 0) + '%'; };
    pill.classList.add('engine');
    pill.querySelector('.rz').classList.toggle('listening', !!(e.echoUpgrade || (e.indexing && e.progress)));
    if (e.echoUpgrade) {
        const u = e.echoUpgrade;
        pill.classList.add('busy');
        txt.textContent = `Upgrading Echo index ${Math.round(100 * (u.done || 0) / Math.max(1, u.total || 1))}%`;
        meterTo(u.done || 0, u.total || 1);
        return;
    }
    if (e.indexing && e.progress) {
        const p = e.progress;
        const deep = p.phase === 'deep';
        const cur = deep ? p.deepDone : p.indexDone, total = deep ? p.deepTotal : p.indexTotal;
        pill.classList.add('busy');
        txt.textContent = `${deep ? 'Refining long sounds' : 'Analysing'} ${(cur || 0).toLocaleString('en-US')} / ${(total || 0).toLocaleString('en-US')}`;
        meterTo(cur || 0, total || 0);
        return;
    }
    if (e.error) { pill.classList.add('warn'); txt.textContent = 'Resonance unavailable'; return; }
    if (!e.ready) { pill.classList.add('busy'); txt.textContent = `${count(lib.count, 'sound')} · starting Resonance…`; return; }
    const pending = Math.max(0, lib.count - (e.vectors || 0));
    if (!e.vectors && lib.count) { pill.classList.add('warn'); txt.textContent = `${count(lib.count, 'sound')} · not analysed yet`; return; }
    pill.classList.add('ready');
    txt.textContent = pending > (e.failures || 0) ? `${count(lib.count, 'sound')} · ${pending.toLocaleString('en-US')} to analyse` : `${count(lib.count, 'sound')} · Resonance ready`;
}

/** Draggable word chips for multi-word AI queries (vertical drag = weight 0-2). */
function renderWords(words) {
    els.words.replaceChildren();
    if (!words || words.length < 2) return;
    const weights = state.view.weights || {};
    for (const w of words) {
        const val = h('span.w', { text: (weights[w] ?? 1).toFixed(1) });
        const chip = h('span.chip.word-chip', { 'data-tip': 'Drag up/down to weight this word · double-click to reset' }, w, val);
        let y0 = 0, w0 = 1;
        const emitW = debounce(() => bus.emit('search:weights', { ...state.view.weights }), 90);
        chip.addEventListener('mousedown', e => {
            e.preventDefault(); y0 = e.clientY; w0 = state.view.weights?.[w] ?? 1;
            const mv = me => { const nw = clamp(w0 + (y0 - me.clientY) / 80, 0, 2); state.view.weights = { ...(state.view.weights || {}), [w]: nw }; val.textContent = nw.toFixed(1); emitW(); };
            const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); emitW.flush(); };
            document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
        });
        chip.addEventListener('dblclick', () => { state.view.weights = { ...(state.view.weights || {}), [w]: 1 }; val.textContent = '1.0'; bus.emit('search:weights', { ...state.view.weights }); });
        els.words.appendChild(chip);
    }
}
