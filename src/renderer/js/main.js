// Bootstrap: load state, mount modules, restore the last view, reveal the UI.
// The splash waits only for the library index (fast), AI models load in the
// background and light up search/Echo when ready.
import { h } from './util.js';
import { state, bus, setView } from './store.js';
import { refreshColors } from './theme.js';
import { createMark, setMarkMode } from './ui/logo.js';
import { mountTitlebar } from './ui/titlebar.js';
import { mountSidebar } from './ui/sidebar.js';
import { mountPanel } from './ui/panel.js';
import { list } from './ui/list.js';
import { mountSelectionToolbar } from './ui/selection.js';
import { mountPlayerBar } from './ui/player-bar.js';
import { openSettings } from './ui/settings.js';
import { toast } from './ui/overlays.js';
import { player } from './audio/engine.js';
import * as app from './app.js';

const sv = window.sv;

// ── splash ─────────────────────────────────────────────────────────────
const splash = document.getElementById('splash');
const splashMark = createMark('vault', 64);
const splashStatus = h('div.status', { text: 'Opening the vault' });
splash.append(splashMark, h('div.name', { text: 'SOUNDVAULT' }), splashStatus);
const t0 = performance.now();
// Only a long wait gets motion: after 1.2 s the lid's waveform starts to breathe.
const breathe = setTimeout(() => splashMark.classList.add('breathe'), 1200);

function revealApp() {
    document.getElementById('app').removeAttribute('aria-hidden');
    const wait = Math.max(0, 700 - (performance.now() - t0));   // let the fade-in land on very fast boots
    setTimeout(settleSplash, wait);
}

// The splash mark flies to the titlebar mark and becomes it while the backdrop dissolves.
function settleSplash() {
    clearTimeout(breathe);
    for (const bar of splashMark.querySelectorAll('.bar')) {    // bars caught mid-breath ease back, no snap
        const from = getComputedStyle(bar).transform;
        bar.getAnimations().forEach(a => a.cancel());
        if (from !== 'none') bar.animate([{ transform: from }, { transform: 'none' }], { duration: 220, easing: 'ease-out' });
    }
    splashMark.classList.remove('breathe');
    splash.classList.add('leaving');
    const target = document.querySelector('#titlebar .brand .mark');
    if (!target || matchMedia('(prefers-reduced-motion: reduce)').matches) {
        const fade = splash.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 300, fill: 'forwards' });
        fade.finished.then(() => splash.remove());
        return;
    }
    const a = splashMark.getBoundingClientRect(), b = target.getBoundingClientRect();
    const to = `translate(${b.left - a.left}px, ${b.top - a.top}px) scale(${b.width / a.width})`;
    target.style.visibility = 'hidden';
    setMarkMode(splashMark, state.mode);                              // lands in the app's current mode
    splashMark.querySelector('.shell').style.strokeWidth = '2.3';     // the titlebar's weight
    splashMark.style.transformOrigin = '0 0';
    const flight = splashMark.animate([{ transform: 'none' }, { transform: to }],
        { duration: 600, easing: 'cubic-bezier(.2, 0, 0, 1)', fill: 'forwards' });
    flight.finished.then(() => { target.style.visibility = ''; splash.remove(); });
}

// ── boot ───────────────────────────────────────────────────────────────
async function boot() {
    const [settings, libStatus, vaults, collections, engine] = await Promise.all([
        sv.settings.get(), sv.library.status(), sv.vaults.list(), sv.collections.list(), sv.engine.status(),
    ]);
    state.settings = settings;
    state.library = libStatus;
    state.vaults = vaults;
    state.collections = collections;
    state.engine = engine;
    state.mode = settings.lastState?.mode === 'sounds' ? 'sounds' : 'vault';
    state.lastFolder = settings.lastState?.folder || '';
    state.lastCollection = settings.lastState?.collection || null;
    setView({ sort: settings.sort || 'name', recursive: settings.recursive !== false });
    player.setLoop(!!settings.loop);
    refreshColors(true);

    mountTitlebar(document.getElementById('titlebar'));
    mountSidebar(document.getElementById('sidebar'));
    const listEl = mountPanel(document.getElementById('main'));
    list.mount(listEl);
    mountSelectionToolbar();
    mountPlayerBar(document.getElementById('player'));
    app.wireApp();

    bus.on('settings:open', section => openSettings(section));
    bus.on('settings:choose-library', async () => {
        const r = await sv.settings.chooseLibrary();
        if (r && r.error) toast(r.error, { kind: 'error' });
        else if (r && r.relinked) toast(`${r.relinked.toLocaleString('en-US')} collection item${r.relinked === 1 ? '' : 's'} relinked to the new location`, { icon: 'check' });
    });
    bus.on('library:rescan', () => app.rescan());
    bus.on('accent', () => { for (const r of list.pool) r.drawnKey = ''; list.refreshAll(); });
    bus.on('settings', s => { if (s && s.accentColor) refreshColors(); });

    splashStatus.textContent = libStatus.ready ? 'Opening the vault' : 'Scanning your library';
    await app.reloadTree();
    state.library = await sv.library.status();
    bus.emit('library-status', state.library);
    bus.emit('engine', state.engine);
    bus.emit('mode', state.mode);
    await app.setMode(state.mode, { restore: true });
    revealApp();
    if (state.library.exists && state.library.count && state.engine.ready === false) {
        // Models finish loading in the background; the status pill shows progress.
    }
}

boot().catch(err => {
    console.error('[boot]', err);
    splashStatus.textContent = 'Something went wrong: ' + (err && err.message ? err.message : err);
});
