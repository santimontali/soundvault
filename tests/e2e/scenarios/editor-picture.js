'use strict';
// Editor E2E: the picture is the audio.
// For each case, the waveform canvas PIXELS are measured column by column and
// correlated with the peaks of the audio the editor actually produces
// (renderPreview = crop → reverse → fades → gain at the preview rate).
// Requires --lib built by tests/fixtures/make-editor-fixtures.js.
const H = require('../editor-helpers');

// In-page measurement (serialized into the renderer).
function measure(lane, lanes) {
    const E = window.__sv.E;
    const cv = document.querySelector('#editor .ed-wave');
    const dpr = cv.width / cv.clientWidth;
    const W = cv.clientWidth, Hh = cv.clientHeight;
    const img = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    const laneH = Hh / lanes, mid = laneH * lane + laneH / 2, half = laneH / 2 - 2;
    const y0 = Math.floor(laneH * lane * dpr), y1 = Math.floor(laneH * (lane + 1) * dpr);
    const see = [];
    for (let x = 0; x < W; x++) {
        const px = Math.floor((x + 0.5) * dpr);
        let t = -1, b = -1;
        for (let y = y0; y < y1; y++) if (img[(y * cv.width + px) * 4 + 3] > 40) { if (t < 0) t = y; b = y; }
        see.push(t < 0 ? 0 : Math.min(1, Math.max(mid - t / dpr, (b + 1) / dpr - mid) / half));
    }
    // audio actually produced by the editor
    const e = E.edit(), v = E.view(), out = E.renderPreview();
    const sr = out.sampleRate, n = out.frames, span = v.end - v.start;
    const spc = span * sr / W;
    const hear = [], idx = [];
    for (let x = 0; x < W; x++) {
        const va = v.start + span * x / W, vb = v.start + span * (x + 1) / W;
        if (va < e.cropStart + span * 2 / W || vb > e.cropEnd - span * 2 / W) continue;     // skip the crop edge columns
        // same column boundaries as the drawing (floor/floor); the sample-level polyline also touches the neighbours
        let k0 = Math.floor((v.start - e.cropStart) * sr + x * spc), k1 = Math.floor((v.start - e.cropStart) * sr + (x + 1) * spc);
        if (spc < 2) { k0 -= 1; k1 += 1; }
        let m = 0;
        const chans = lanes > 1 ? [out.channels[lane]] : out.channels;
        for (const ch of chans) for (let k = Math.max(0, k0); k < Math.min(n, Math.max(k1, k0 + 1)); k++) { const a = Math.abs(ch[k]); if (a > m) m = a; }
        hear.push(Math.min(1, m)); idx.push(x);
    }
    const s = idx.map(x => see[x]);
    const mean = a => a.reduce((p, q) => p + q, 0) / a.length;
    const ms = mean(s), mh = mean(hear);
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < s.length; i++) { sxy += (s[i] - ms) * (hear[i] - mh); sxx += (s[i] - ms) ** 2; syy += (hear[i] - mh) ** 2; }
    const corr = sxx && syy ? sxy / Math.sqrt(sxx * syy) : (sxx === syy ? 1 : 0);
    let mad = 0; for (let i = 0; i < s.length; i++) mad += Math.abs(s[i] - hear[i]);
    const argmax = a => a.reduce((bi, q, i) => (q > a[bi] ? i : bi), 0);
    return { cols: s.length, corr: +corr.toFixed(4), meanAbsDiff: +(mad / Math.max(1, s.length)).toFixed(4), seePeak: +Math.max(...s).toFixed(3), hearPeak: +Math.max(...hear).toFixed(3), seeArg: idx[argmax(s)], hearArg: idx[argmax(hear)], spc: +spc.toFixed(3), see: s, hear, idx };
}

module.exports = async (ctx) => {
    const C = H.checker(ctx);
    await H.boot(ctx);
    const run = async (label, { lane = 0, lanes = 1 } = {}) => {
        await ctx.wait(200);
        const m = await ctx.exec(measure, lane, lanes);
        const { see, hear, idx, ...summary } = m;
        ctx.log(label, JSON.stringify(summary));
        return m;
    };
    const featureVisible = (m) => {
        // every loud event (run of columns where the audio exceeds 0.25) must be drawn at its level
        let worst = 1, i = 0;
        while (i < m.hear.length) {
            if (m.hear[i] <= 0.25) { i++; continue; }
            let j = i, hp = 0, sp = 0;
            while (j < m.hear.length && m.hear[j] > 0.25) { hp = Math.max(hp, m.hear[j]); j++; }
            for (let k = Math.max(0, i - 1); k <= Math.min(m.see.length - 1, j); k++) sp = Math.max(sp, m.see[k]);
            worst = Math.min(worst, sp / hp);
            i = j;
        }
        return +worst.toFixed(3);
    };

    // 1. markers: four short bursts, incl. the loudest one the old editor dropped
    await H.selectExact(ctx, 'markers_mono_48k_4s.wav', 0, 4);
    await H.openEditor(ctx);
    let m = await run('markers full');
    C.check('markers: picture ⇄ audio correlation ≥ 0.95', m.corr >= 0.95, m.corr);
    C.check('markers: every burst is drawn (≥ 80% of its audio peak)', featureVisible(m) >= 0.8, featureVisible(m));
    C.check('markers: loudest drawn column = loudest heard column (±2 px)', Math.abs(m.seeArg - m.hearArg) <= 2, [m.seeArg, m.hearArg]);
    await H.shotEditor(ctx, 'picture-01-markers');

    // 2. with edits: crop, bent fade-in, S-curve fade-out, -3 dB
    await ctx.exec(() => window.__sv.E.setEdit({ cropStart: 0.3, cropEnd: 3.7, fadeInEnd: 0.8, fadeOutStart: 2.9, fadeInTension: 0.4, fadeOutShape: 'scurve', gainDb: -3 }));
    m = await run('markers edited');
    C.check('edited (crop + fades + gain): correlation ≥ 0.95', m.corr >= 0.95, m.corr);
    C.check('edited: bursts inside fades are drawn attenuated like they sound', m.meanAbsDiff < 0.03, m.meanAbsDiff);
    await H.shotEditor(ctx, 'picture-02-edited');

    // 3. reverse (same audio, mirrored)
    await H.T.key(ctx, 'R');
    m = await run('markers reversed');
    C.check('reversed: correlation ≥ 0.95', m.corr >= 0.95, m.corr);
    C.check('reversed: bursts still drawn', featureVisible(m) >= 0.8, featureVisible(m));

    // 4. zoomed 10x around the 2.0 s burst
    await ctx.exec(() => { const E = window.__sv.E; E.setEdit({ reverse: false, cropStart: 0, cropEnd: 4, fadeInEnd: 0, fadeOutStart: 4, gainDb: 0, fadeInTension: 0, fadeOutShape: 'power' }); E.setView(1.8, 2.2); });
    m = await run('markers zoomed');
    C.check('zoomed 10x: correlation ≥ 0.95', m.corr >= 0.95, m.corr);
    await H.shotEditor(ctx, 'picture-03-zoomed');

    // 5. short file whose loud part is the tail
    await H.selectExact(ctx, 'short_125ms_loudtail.wav', 0, 0.125);
    await H.openEditor(ctx);
    m = await run('short 125 ms');
    C.check('short 125 ms: correlation ≥ 0.95', m.corr >= 0.95, m.corr);
    C.check('short 125 ms: the loud tail is drawn', featureVisible(m) >= 0.8, featureVisible(m));

    // 6. tiny 5 ms (sample-level drawing)
    await H.selectExact(ctx, 'tiny_5ms_loudtail.wav', 0, 0.005);
    await H.openEditor(ctx);
    m = await run('tiny 5 ms');
    C.check('tiny 5 ms (sample level): correlation ≥ 0.95', m.corr >= 0.95, m.corr);
    await H.shotEditor(ctx, 'picture-04-tiny');

    // 7. stereo with a silent left channel
    await H.selectExact(ctx, 'rightonly_st_48k_1s.wav', 0.05, 0.95);
    await H.openEditor(ctx);
    await ctx.exec(() => window.__sv.E.stereo(false));
    // (uniform noise: per-column peaks barely vary, so the check is level agreement, not correlation)
    m = await run('right-only, combined view');
    C.check('right-only stereo, combined view: drawn at the right channel’s level (not flat)', m.seePeak > 0.5 && m.meanAbsDiff <= 0.02, [m.seePeak, m.meanAbsDiff]);
    await ctx.exec(() => window.__sv.E.stereo(true));
    const l0 = await run('right-only, lane L', { lane: 0, lanes: 2 });
    const l1 = await run('right-only, lane R', { lane: 1, lanes: 2 });
    C.check('stereo lanes: L drawn silent, R drawn at its level', l0.seePeak < 0.05 && l1.seePeak > 0.5 && l1.meanAbsDiff <= 0.03, [l0.seePeak, l1.seePeak, l1.meanAbsDiff]);
    await H.shotEditor(ctx, 'picture-05-stereo-lanes');
    // structured stereo: L = ramp (|x| is a V), R = steady sine
    await H.selectExact(ctx, 'ramp_st_48k_2s.wav', 0, 2);
    await H.openEditor(ctx);
    const rl = await run('ramp, lane L', { lane: 0, lanes: 2 });
    const rr = await run('ramp, lane R', { lane: 1, lanes: 2 });
    C.check('stereo lanes (ramp): L correlation ≥ 0.95, R level agreement', rl.corr >= 0.95 && rr.meanAbsDiff <= 0.03, [rl.corr, rr.meanAbsDiff]);
    await ctx.exec(() => window.__sv.E.stereo(false));

    // 8. gain beyond 0 dBFS → drawn clipped + CLIP indicator
    await H.selectExact(ctx, 'sine_0dbfs_48k_1s.wav', 0.1, 0.9);
    await H.openEditor(ctx);
    await ctx.exec(() => window.__sv.E.setEdit({ gainDb: 6 }));
    await ctx.wait(200);
    const clip = await ctx.exec(() => ({ badge: !document.querySelector('#editor .ed-clip').classList.contains('hidden'), text: document.querySelector('#editor .ed-clip').textContent, readout: document.querySelector('#editor .ed-readouts').textContent, marks: window.__sv.E.picture().clipCols }));
    C.check('gain +6 dB on a 0 dBFS sine: CLIP badge + clip marks', clip.badge && /CLIP \+6\.\d dB/.test(clip.text) && clip.marks > 10 && /CLIP/.test(clip.readout), clip);
    await H.shotEditor(ctx, 'picture-06-clip');

    // 9. Trim selection to crop: the list selection follows, the file's peaks are untouched (old Confirm-Crop bug)
    await H.selectExact(ctx, 'markers_mono_48k_4s.wav', 0.2, 3.8);
    await H.openEditor(ctx);
    const before = await ctx.exec(() => { const p = window.__sv.selection.get().path; return { dur: window.__sv.peaks.peaksFor(p).duration, row: window.__sv.list.pool.find(r => r.path === p)?.refs.dur.textContent }; });
    await ctx.exec(() => window.__sv.E.setEdit({ cropStart: 1.0, cropEnd: 2.2, fadeInEnd: 1.1, fadeOutStart: 2.0 }));
    await H.T.key(ctx, 'T');
    await ctx.wait(300);
    const after = await ctx.exec(() => { const s = window.__sv.selection.get(); return { sel: { start: s.start, end: s.end, fadeIn: s.fadeIn, fadeOut: s.fadeOut }, region: window.__sv.E.region(), edit: window.__sv.E.edit(), dur: window.__sv.peaks.peaksFor(s.path).duration, row: window.__sv.list.pool.find(r => r.path === s.path)?.refs.dur.textContent }; });
    C.check('trim: list selection = crop in file time (1.2 s … 2.4 s)', Math.abs(after.sel.start - 1.2) < 1e-6 && Math.abs(after.sel.end - 2.4) < 1e-6, after.sel);
    C.check('trim: fades carried to the list selection', Math.abs(after.sel.fadeIn - 0.1) < 1e-6 && Math.abs(after.sel.fadeOut - 0.2) < 1e-6, after.sel);
    C.check('trim: the file’s peaks/duration are untouched (row still 4.0 s)', after.dur === before.dur && after.dur === 4 && after.row === before.row, { before, after: { dur: after.dur, row: after.row } });
    m = await run('after trim');
    C.check('after trim: correlation ≥ 0.95', m.corr >= 0.95, m.corr);
    await H.shotEditor(ctx, 'picture-07-after-trim', true);
    C.done();
};
