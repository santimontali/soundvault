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
const splashMark = createMark('vault', 96);
splashMark.classList.add('thump');
const splashStatus = h('div.status', { text: 'Opening the vault' });
splash.append(splashMark, h('div.name', { text: 'SOUNDVAULT' }), splashStatus);
const t0 = performance.now();

function revealApp() {
    document.getElementById('app').removeAttribute('aria-hidden');
    const wait = Math.max(0, 650 - (performance.now() - t0));   // avoid a flash on very fast boots
    setTimeout(() => {
        splashMark.classList.remove('thump');
        setMarkMode(splashMark, 'sounds');
        setTimeout(() => { splash.classList.add('gone'); setTimeout(() => splash.remove(), 600); }, 380);
    }, wait);
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
