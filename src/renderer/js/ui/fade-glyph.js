// A fade's curve drawn small: the exact gain law the audio gets (edit-dsp's
// fadeGain), rising for a fade-in and falling for a fade-out. Used in the
// curve menu and the editor readouts so shapes are seen, not just named.
import { fadeGain } from '../audio/edit-dsp.js';

const NS = 'http://www.w3.org/2000/svg';

export function fadeGlyph(shape = 'power', tension = 0, side = 'in', { w = 30, h = 16 } = {}) {
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'fade-glyph');
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.setAttribute('width', w);
    svg.setAttribute('height', h);
    svg.setAttribute('aria-hidden', 'true');
    const pad = 1.5, n = 28, bottom = h - pad, span = h - 2 * pad;
    let d = '';
    for (let i = 0; i <= n; i++) {
        const t = i / n;
        const g = fadeGain(side === 'in' ? t : 1 - t, shape, tension);
        d += (i ? 'L' : 'M') + (pad + t * (w - 2 * pad)).toFixed(2) + ' ' + (bottom - g * span).toFixed(2);
    }
    const area = document.createElementNS(NS, 'path');
    area.setAttribute('class', 'fg-area');
    area.setAttribute('d', `${d}L${w - pad} ${bottom}L${pad} ${bottom}Z`);
    const line = document.createElementNS(NS, 'path');
    line.setAttribute('class', 'fg-line');
    line.setAttribute('d', d);
    svg.append(area, line);
    return svg;
}
