// Accent handling: global accent in Sound mode, the vault's own color in
// Vault mode. Updates CSS variables and re-tints every canvas once.
import { hexToRgb, inkFor } from './util.js';
import { modeAccent, state, bus } from './store.js';
import { refreshPalette } from './ui/waveform.js';

let applied = null;
/**
 * One interactive accent (the user's choice) everywhere; the vault's color is
 * identity only (logo lock, mode word, vault dot, collect bar) so a red vault
 * never turns play/selection/progress into "danger" red.
 */
export function refreshColors(force = false) {
    const accent = state.settings?.accentColor || '#c8f76d';
    const mode = modeAccent();
    const key = accent + '|' + mode;
    if (key === applied && !force) return;
    const accentChanged = !applied || applied.split('|')[0] !== accent;
    applied = key;
    const { r, g, b } = hexToRgb(accent);
    const root = document.documentElement.style;
    root.setProperty('--accent', accent);
    root.setProperty('--accent-rgb', `${r}, ${g}, ${b}`);
    root.setProperty('--accent-ink', inkFor(accent));
    root.setProperty('--mode-color', mode);
    if (accentChanged || force) { refreshPalette(); bus.emit('accent', accent); }
}
