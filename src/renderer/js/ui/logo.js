// The SoundVault mark. One object, two states:
//   vault, a chest whose lid carries a waveform, locked with an accent plate
//   sound, the lid's waveform grows into the full mark; the lock's accent
//           moves to the tallest bar. ("the sound comes out of the vault")
const NS = 'http://www.w3.org/2000/svg';
const VAULT = [[9.2, 10.3, 1.9, 2.4], [12.3, 9.0, 1.9, 5.0], [15.05, 7.8, 1.9, 7.4], [18.1, 9.5, 1.9, 4.0], [21.2, 10.6, 1.9, 1.8]];
const SOUND = [[3.2, 11, 3.4, 10], [9.1, 6.5, 3.4, 19], [14.3, 3.5, 3.4, 25], [19.5, 8.5, 3.4, 15], [25.4, 12.5, 3.4, 7]];

export function createMark(mode = 'vault', size = 22) {
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 32 32');
    svg.setAttribute('width', size); svg.setAttribute('height', size);
    svg.setAttribute('class', 'mark');
    svg.setAttribute('aria-hidden', 'true');
    const shell = document.createElementNS(NS, 'g');
    shell.setAttribute('class', 'shell');
    const body = document.createElementNS(NS, 'rect');
    body.setAttribute('x', '4.15'); body.setAttribute('y', '4.65'); body.setAttribute('width', '23.7'); body.setAttribute('height', '22.7'); body.setAttribute('rx', '5.2');
    const seam = document.createElementNS(NS, 'path');
    seam.setAttribute('d', 'M4.15 19.4h23.7');
    shell.append(body, seam);
    svg.appendChild(shell);
    for (let i = 0; i < 5; i++) {
        const r = document.createElementNS(NS, 'rect');
        r.setAttribute('class', 'bar b' + (i + 1));
        svg.appendChild(r);
    }
    const lock = document.createElementNS(NS, 'g');
    lock.setAttribute('class', 'lock');
    const plate = document.createElementNS(NS, 'rect');
    plate.setAttribute('class', 'plate');
    plate.setAttribute('x', '12.8'); plate.setAttribute('y', '16.3'); plate.setAttribute('width', '6.4'); plate.setAttribute('height', '7.2'); plate.setAttribute('rx', '1.8');
    const hole = document.createElementNS(NS, 'path');
    hole.setAttribute('class', 'hole');
    // classic keyhole: round top + tapered slot
    hole.setAttribute('d', 'M16 17.9a1.05 1.05 0 0 1 .62 1.9l.32 1.95h-1.88l.32-1.95A1.05 1.05 0 0 1 16 17.9z');
    lock.append(plate, hole);
    svg.appendChild(lock);
    setMarkMode(svg, mode, false);
    return svg;
}

/** Morph the mark. Geometry is set via CSS properties so transitions animate it. */
export function setMarkMode(svg, mode, animate = true) {
    const geo = mode === 'sounds' || mode === 'sound' ? SOUND : VAULT;
    const bars = svg.querySelectorAll('.bar');
    bars.forEach((r, i) => {
        if (!animate) r.style.transition = 'none';
        const [x, y, w, hh] = geo[i];
        r.style.x = x + 'px'; r.style.y = y + 'px'; r.style.width = w + 'px'; r.style.height = hh + 'px'; r.style.rx = (w / 2) + 'px';
        if (!animate) { r.getBoundingClientRect(); r.style.transition = ''; }
    });
    svg.classList.toggle('sound', geo === SOUND);
}
