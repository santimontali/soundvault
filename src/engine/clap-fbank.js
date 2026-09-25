'use strict';
/**
 * Fast drop-in for transformers.js ClapFeatureExtractor._extract_fbank_features.
 *
 * The library builds a JS Array per frame and multiplies all 513 bins by all
 * 64 mel filters (~33 M multiply-adds per 10 s window): about 95 ms of the
 * ~265 ms each CLAP audio embedding takes. This version computes the same
 * log-mel spectrogram (reflect padding, periodic Hann, |FFT|², Slaney mel
 * bank, 10·log10 with the same floors) with typed arrays, a precomputed
 * radix-2 FFT and each filter's non-zero band only. Output matches the
 * original to float rounding (tests/clap-fbank.electron.js), so embeddings
 * are unchanged.
 */

function patchProcessor(processor) {
    const fe = processor && (processor.feature_extractor || processor);
    if (!fe || typeof fe._extract_fbank_features !== 'function' || fe.__svFast) return false;
    const N = fe.config.fft_window_size, hop = fe.config.hop_length;
    if (!N || (N & (N - 1)) || !fe.window || fe.window.length !== N || !fe.mel_filters_slaney) return false;
    const original = fe._extract_fbank_features.bind(fe);
    const slaney = fe.mel_filters_slaney;
    const bins = (N >> 1) + 1;
    const win = Float64Array.from(fe.window);
    // Sparse filter bank: [start, weights] per filter.
    const bank = slaney.map(f => {
        let a = 0, b = f.length - 1;
        while (a < f.length && !f[a]) a++;
        while (b > a && !f[b]) b--;
        return a > b ? { start: 0, w: new Float64Array(0) } : { start: a, w: Float64Array.from(f.slice(a, Math.min(b + 1, bins))) };
    });
    // Real FFT of size N through one complex FFT of size H = N/2 (even/odd packing).
    const H = N >> 1;
    const levels = Math.log2(H);
    const rev = new Uint32Array(H);
    for (let i = 0; i < H; i++) { let r = 0; for (let b = 0; b < levels; b++) r |= ((i >> b) & 1) << (levels - 1 - b); rev[i] = r; }
    const cosH = new Float64Array(H >> 1), sinH = new Float64Array(H >> 1);
    for (let k = 0; k < H >> 1; k++) { cosH[k] = Math.cos(2 * Math.PI * k / H); sinH[k] = -Math.sin(2 * Math.PI * k / H); }
    const cosN = new Float64Array(H + 1), sinN = new Float64Array(H + 1);
    for (let k = 0; k <= H; k++) { cosN[k] = Math.cos(2 * Math.PI * k / N); sinN[k] = -Math.sin(2 * Math.PI * k / N); }
    const re = new Float64Array(H), im = new Float64Array(H), pw = new Float64Array(bins);

    function fbank(waveform, mel_filters, max_length = null) {
        if (mel_filters !== slaney) return original(waveform, mel_filters, max_length);
        const half = Math.floor((N - 1) / 2) + 1;
        const len = waveform.length, total = len + 2 * half;
        // reflect padding (numpy "reflect": edge sample not repeated)
        const x = new Float64Array(total);
        for (let i = 0; i < len; i++) x[half + i] = waveform[i];
        for (let i = 1; i <= half; i++) { x[half - i] = waveform[reflect(i, len - 1)]; x[half + len - 1 + i] = waveform[reflect(len - 1 - i, len - 1)]; }
        let frames = Math.floor(1 + Math.floor((total - N) / hop));
        if (max_length !== null && max_length < frames) frames = max_length;
        const M = bank.length;
        const out = new Float32Array(frames * M);
        for (let f = 0; f < frames; f++) {
            const off = f * hop;
            for (let n = 0; n < H; n++) { const j = rev[n]; re[j] = x[off + 2 * n] * win[2 * n]; im[j] = x[off + 2 * n + 1] * win[2 * n + 1]; }
            for (let size = 2; size <= H; size <<= 1) {
                const h = size >> 1, step = H / size;
                for (let s = 0; s < H; s += size) {
                    for (let k = 0, t = 0; k < h; k++, t += step) {
                        const a = s + k, b = a + h;
                        const c = cosH[t], sn = sinH[t];
                        const tr = re[b] * c - im[b] * sn;
                        const ti = re[b] * sn + im[b] * c;
                        re[b] = re[a] - tr; im[b] = im[a] - ti;
                        re[a] += tr; im[a] += ti;
                    }
                }
            }
            // Unpack: X[k] = E[k] + W^k·O[k], E/O from Z[k] and conj(Z[H-k]).
            for (let k = 0; k <= H; k++) {
                const k1 = k === H ? 0 : k, k2 = k === 0 ? 0 : H - k;
                const zr = re[k1], zi = im[k1], cr = re[k2], ci = -im[k2];
                const er = (zr + cr) / 2, ei = (zi + ci) / 2;
                const or = (zi - ci) / 2, oi = -(zr - cr) / 2;
                const wr = cosN[k], wi = sinN[k];
                const xr = er + wr * or - wi * oi, xi = ei + wr * oi + wi * or;
                pw[k] = xr * xr + xi * xi;
            }
            const o = f * M;
            for (let m = 0; m < M; m++) {
                const { start, w } = bank[m];
                let s = 0;
                for (let k = 0; k < w.length; k++) s += w[k] * pw[start + k];
                s = s > 1e-10 ? s : 1e-10;
                out[o + m] = 10 * Math.log10(s);
            }
        }
        return { data: out, dims: [frames, M] };
    }
    function reflect(i, w) { const p = 2 * w; if (!w) return 0; i = Math.abs(i) % p; return i > w ? p - i : i; }

    fe._extract_fbank_features = fbank;
    fe.__svFast = true;
    fe.__svOriginalFbank = original;
    return true;
}

module.exports = { patchProcessor };
