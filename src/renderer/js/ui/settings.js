// Settings sheet: library, AI catalog (live progress), playback, renders,
// appearance, keyboard shortcuts.
import { h, icon, count, clamp } from '../util.js';
import { state, bus } from '../store.js';
import { modal, toast } from './overlays.js';
import { PALETTE } from '../actions.js';

const sv = window.sv;
const SHORTCUTS = [
    ['Space', 'Play / pause'], ['↑ ↓', 'Previous / next sound (auto-plays)'], ['← →', 'Seek'], ['Enter', 'Play from the start'],
    ['Drag on waveform', 'Select a region'], ['Drag the top-corner dots', 'Fade in / out'], ['E', 'Edit selection'], ['Ctrl + E', 'Echo: find similar'],
    ['C', 'Collect into the current target'], ['L', 'Loop'], ['Ctrl + F  or  /', 'Search'], ['Ctrl + I', 'Describe on / off'],
    ['Ctrl + Tab', 'Switch Vault / Sound mode'], ['Ctrl + A', 'Select all'], ['Shift / Ctrl + click', 'Multi-select'],
    ['F2', 'Rename'], ['Delete', 'Move to Recycle Bin'], ['Ctrl + B', 'Toggle sidebar'], ['Esc', 'Clear selection / close'],
];

export function openSettings(section = null) {
    let offEngine = null, offSettings = null;
    const p = modal({ title: 'Settings', icon: 'gear', wide: true, cls: 'settings' }, close => {
        const body = h('div');
        const render = () => {
            const s = state.settings, lib = state.library, e = state.engine;
            const libSec = h('div.set-sec', { id: 'set-library' },
                h('h4', { text: 'Library' }),
                h('div.set-row', {}, h('div.path-box', {}, icon(lib.exists ? 'folder' : 'warn'), h('span.ellipsis', { text: lib.root || 'No folder', title: lib.root || '' })),
                    h('button.btn', { text: 'Change…', onclick: () => bus.emit('settings:choose-library') }),
                    h('button.icon-btn', { 'data-tip': 'Open in Explorer', 'aria-label': 'Open library folder', onclick: () => sv.settings.openFolder('library') }, icon('reveal'))),
                h('div.set-row', {}, h('div.lbl', { text: `${count(lib.count, 'sound')}${lib.scan ? ` · scanned in ${(lib.scan.ms / 1000).toFixed(1)} s` : ''}` }),
                    h('button.btn', { onclick: () => bus.emit('library:rescan') }, icon('refresh'), 'Rescan')),
                row('Watch for new files', 'New or changed WAVs appear (and get cataloged) automatically.', s.watcher, v => bus.emit('settings:set', { watcher: v })));

            const done = e.vectors || 0, failed = e.failures || 0, pending = Math.max(0, lib.count - done - failed);
            const status = e.error ? 'Resonance unavailable' : !e.ready ? 'Starting Resonance…'
                : `${count(done, 'sound')} analysed${pending ? ` · ${pending.toLocaleString('en-US')} to go` : ''}${failed ? ` · ${failed.toLocaleString('en-US')} unreadable` : ''}`;
            const action = e.indexing
                ? h('button.btn', { onclick: () => sv.engine.cancelIndex() }, icon('pause'), 'Pause')
                : h('button.btn.primary', { disabled: !e.ready, onclick: () => sv.engine.index().then(r => { if (r && !r.deferred && !r.relinked && !r.queued && !r.deep) toast('Everything is already analysed', { icon: 'check' }); }) }, icon('resonance'), 'Analyse now');
            const cat = h('div.set-sec', { id: 'set-catalog' },
                h('h4', {}, icon('resonance', 'h4i'), 'Resonance'),
                h('div.set-row', {},
                    h('div.lbl', {}, status, h('small', { text: e.error ? String(e.error) : 'Resonance listens to every sound once, in the background. Describe, Echo and suggestions use each sound as soon as it is analysed.' })),
                    action),
                row('Analyse new sounds automatically', 'Keeps Describe and Echo up to date as files are added or changed.', s.autoCatalog !== false, v => bus.emit('settings:set', { autoCatalog: v })),
                failed && !e.indexing ? h('div.set-row', {}, h('div.lbl', {}, `${count(failed, 'file')} could not be read`, h('small', { text: 'Damaged or unsupported files are skipped until they change.' })),
                    h('button.btn', { onclick: () => showFailures() }, 'Show'),
                    h('button.btn', { onclick: () => sv.engine.index({ retryFailed: true }) }, icon('refresh'), 'Retry')) : null,
                e.echoUpgrade ? upgradeCard(e.echoUpgrade) : e.indexing && e.progress ? progressCard(e.progress) : null);

            const play = h('div.set-sec', { id: 'set-playback' },
                h('h4', { text: 'Playback' }),
                row('Auto-play', 'Play sounds as you move through the list with ↑/↓ or click them.', s.autoPlay, v => bus.emit('settings:set', { autoPlay: v })),
                row('Loop', 'Loop the playing sound or selection.', s.loop, v => bus.emit('settings:set', { loop: v })));

            const rend = h('div.set-sec', { id: 'set-renders' },
                h('h4', { text: 'Renders (dragged selections & edits)' }),
                h('div.set-row', {}, h('div.path-box', {}, icon('folder'), h('span.ellipsis', { text: s.rendersDir, title: s.rendersDir })),
                    h('button.btn', { text: 'Change…', onclick: async () => { const r = await sv.settings.chooseRendersDir(); if (r && r.error) toast(r.error, { kind: 'error' }); } }),
                    h('button.icon-btn', { 'data-tip': 'Open in Explorer', 'aria-label': 'Open renders folder', onclick: () => sv.settings.openFolder('renders') }, icon('reveal'))),
                h('div.set-row', {}, h('div.lbl', {}, h('small', { text: 'Your DAW may reference these files directly, so SoundVault never overwrites or deletes them.' }))));

            const swatches = h('div.swatches');
            for (const c of PALETTE.slice(0, 10)) swatches.appendChild(h('div.swatch' + (c === s.accentColor ? '.on' : ''), { style: { background: c }, onclick: () => bus.emit('settings:set', { accentColor: c }) }));
            const custom = h('input', { type: 'color', value: s.accentColor, 'aria-label': 'Custom accent color', style: { width: '28px', height: '24px', border: '0', background: 'none', cursor: 'pointer' } });
            custom.addEventListener('change', () => bus.emit('settings:set', { accentColor: custom.value }));
            const look = h('div.set-sec', { id: 'set-appearance' }, h('h4', { text: 'Appearance' }),
                h('div.set-row', {}, h('div.lbl', {}, 'Accent color', h('small', { text: 'Used in Sound mode. Each vault has its own color in Vault mode.' })), swatches, custom));

            const keys = h('div.set-sec', { id: 'set-shortcuts' }, h('h4', { text: 'Keyboard' }),
                h('div.kbd-grid', {}, ...SHORTCUTS.flatMap(([k, d]) => [h('div.keys', {}, ...k.split('  or  ').flatMap((part, i) => [i ? h('span.muted', { text: 'or' }) : null, h('span.kbd', { text: part })])), h('div', { text: d })])));

            body.replaceChildren(libSec, cat, play, rend, look, keys);
        };
        render();
        offEngine = sv.engine.onStatus(() => setTimeout(render, 0));
        offSettings = bus.on('settings', () => render());
        const offLib = bus.on('library-status', () => render());
        const prevOff = offSettings;
        offSettings = () => { prevOff(); offLib(); };
        if (section) requestAnimationFrame(() => { const t = body.querySelector('#set-' + section); if (t) t.scrollIntoView({ block: 'start' }); });
        return { body, footer: [h('button.btn.primary', { text: 'Done', onclick: () => close() })] };
    });
    p.finally(() => { offEngine && offEngine(); offSettings && offSettings(); });
    return p;
}

function row(label, sub, on, onChange) {
    const t = h('div.switch' + (on ? '.on' : ''), { role: 'switch', tabindex: '0', 'aria-checked': String(!!on), 'aria-label': label });
    const flip = () => onChange(!on);
    t.addEventListener('click', flip);
    t.addEventListener('keydown', e => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); flip(); } });
    return h('div.set-row', {}, h('div.lbl', {}, label, sub ? h('small', { text: sub }) : null), t);
}

function progressCard(p) {
    const phases = [['index', 'Analyse sounds', p.indexDone, p.indexTotal], ['deep', 'Refine long sounds', p.deepDone, p.deepTotal]];
    return h('div.index-card', {},
        ...phases.map(([id, label, cur, total]) => {
            const active = id === p.phase, finished = total > 0 && cur >= total;
            const pct = total ? clamp(cur / total * 100, 0, 100) : 0;
            return h('div.ph' + (active ? '.active' : finished ? '.done' : ''), {}, h('span', { text: label }), h('div.bar', {}, h('i', { style: { width: pct + '%' } })),
                h('span.cnt', { text: total ? (finished ? '✓' : `${(cur || 0).toLocaleString('en-US')} / ${total.toLocaleString('en-US')}`) : '-' }));
        }),
        h('div.note', { text: p.file ? 'Now: ' + p.file : 'Working…' }));
}

function upgradeCard(u) {
    const pct = clamp(100 * (u.done || 0) / Math.max(1, u.total || 1), 0, 100);
    return h('div.index-card', {},
        h('div.ph.active', {}, h('span', { text: 'Upgrade Echo index' }), h('div.bar', {}, h('i', { style: { width: pct + '%' } })), h('span.cnt', { text: Math.round(pct) + '%' })),
        h('div.note', { text: 'A one-time conversion to the new, more accurate format. Search keeps working meanwhile.' }));
}

async function showFailures() {
    const list = await sv.engine.failures();
    modal({ title: 'Files that could not be read', icon: 'warn', wide: true }, close => ({
        body: h('div.fail-list', {}, ...list.slice(0, 500).map(f => h('div.fail', {}, h('div.nm.ellipsis', { text: f.name, title: f.path }), h('div.err', { text: f.error })))),
        footer: [h('button.btn.primary', { text: 'Close', onclick: () => close() })],
    }));
}
