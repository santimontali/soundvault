// Interface color. Sound mode uses the user's accent exactly. In Vault mode the
// active vault's color drives the whole interface (buttons, selection, focus
// rings, progress, active nav, links, the play button), as a tint that works on
// the dark UI:
//  • lightness kept readable (a navy vault gets a lighter blue, a white one a
//    soft grey) and chroma capped, so neon picks do not glare;
//  • never mistaken for danger: errors and destructive actions keep their own
//    red, so a red vault gets a light rose instead;
//  • the ink on top is whichever of the two inks contrasts more.
// The identity marks (logo lock, mode word) keep the vault's hue (--mode-color);
// swatches show the exact color. Canvases re-tint only when the accent really
// changes, and only the visible ones at once (the rest when next drawn).
import { hexToRgb } from './util.js';
import { state, bus, activeVault } from './store.js';
import { setPalette } from './ui/waveform.js';

const DEFAULT_ACCENT = '#c8f76d';
const DANGER = '#ff6b6b';                  // tokens.css --danger
const INKS = ['#11140b', '#f6f6f2'];       // dark and light ink (tokens.css --accent-ink)
const L_MIN = 0.68, L_MAX = 0.92, C_MAX = 0.2;       // the default lime sits at 0.92 / 0.17
const APART = 0.11;                        // OKLab distance kept from the danger red

// ── OKLab (Björn Ottosson) ─────────────────────────────────────────────
const toLin = c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toSrgb = c => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
function oklab(hex) {
    const { r, g, b } = hexToRgb(hex);
    const R = toLin(r / 255), G = toLin(g / 255), B = toLin(b / 255);
    const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
    const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
    const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
    return [0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s, 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s];
}
function rgbOf(L, a, b) {
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3, m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3, s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
    return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s];
}
const inGamut = rgb => rgb.every(c => c >= -1e-4 && c <= 1 + 1e-4);
const lch = hex => { const [L, a, b] = oklab(hex); return { L, C: Math.hypot(a, b), h: Math.atan2(b, a) }; };
/** OKLCH to hex; chroma is reduced until the color fits sRGB (hue and lightness kept). */
function hexOf(L, C, h) {
    const at = c => rgbOf(L, c * Math.cos(h), c * Math.sin(h));
    let lo = 0, hi = C;
    if (!inGamut(at(C))) for (let i = 0; i < 20; i++) { const mid = (lo + hi) / 2; if (inGamut(at(mid))) lo = mid; else hi = mid; }
    else lo = C;
    return '#' + at(lo).map(c => Math.round(Math.min(1, Math.max(0, toSrgb(c))) * 255).toString(16).padStart(2, '0')).join('');
}
const distance = (x, y) => { const p = oklab(x), q = oklab(y); return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]); };
const luminance = hex => { const { r, g, b } = hexToRgb(hex); return 0.2126 * toLin(r / 255) + 0.7152 * toLin(g / 255) + 0.0722 * toLin(b / 255); };
const contrast = (x, y) => { const a = luminance(x), b = luminance(y); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); };

/** The vault color as a tint the dark interface can use (same hue). */
export function legible(hex) {
    const { L, C, h } = lch(hex);
    if (L >= L_MIN && L <= L_MAX && C <= C_MAX) return hex.toLowerCase();     // already fine: exact
    const L2 = Math.min(L_MAX, Math.max(L_MIN, L));
    // A dark color looks more saturated than its chroma says: lifted, it keeps some of that (greys stay grey).
    const C2 = L2 > L && C > 0.02 ? C * (L2 / L) ** 0.6 : C;
    return hexOf(L2, Math.min(C2, C_MAX), h);
}

/** The interactive accent for a vault color: legible, and clearly apart from the danger red. */
export function vaultAccent(hex) {
    const out = legible(hex);
    if (distance(out, DANGER) >= APART) return out;
    // Reds and corals: lighter and softer, the hue turned a little away from danger
    // (toward rose, or toward peach for orange-reds), as far as it takes.
    const { L, C, h } = lch(out), d = lch(DANGER);
    const side = Math.sin(h - d.h) > Math.sin(0.21) ? 1 : -1;       // more than ~12° on the orange side
    let best = out;
    for (let deg = 12; deg <= 45; deg += 3) {
        best = hexOf(Math.max(L, 0.8), Math.min(C, 0.13), d.h + side * deg * Math.PI / 180);
        if (distance(best, DANGER) >= APART) break;
    }
    return best;
}

/** Near-black or near-white, whichever reads better on `hex`. */
export const inkOn = hex => (contrast(hex, INKS[0]) >= contrast(hex, INKS[1]) ? INKS[0] : INKS[1]);

let applied = { accent: null, mode: null };
/**
 * Apply the colors of the current mode and vault. Cheap when nothing changed;
 * `accent` fires (canvases re-tint) only when the interactive accent changed.
 */
export function refreshColors(force = false) {
    const global = state.settings?.accentColor || DEFAULT_ACCENT;
    const v = state.mode === 'vault' ? activeVault() : null;
    const accent = v && v.color ? vaultAccent(v.color) : global;
    const mode = v && v.color ? legible(v.color) : global;
    if (!force && accent === applied.accent && mode === applied.mode) return;
    const changed = force || accent !== applied.accent;
    applied = { accent, mode };
    state.accent = accent;
    const { r, g, b } = hexToRgb(accent);
    const root = document.documentElement.style;
    root.setProperty('--accent', accent);
    root.setProperty('--accent-rgb', `${r}, ${g}, ${b}`);
    root.setProperty('--accent-ink', inkOn(accent));
    root.setProperty('--mode-color', mode);
    if (changed) { setPalette(accent); bus.emit('accent', accent); }
}
