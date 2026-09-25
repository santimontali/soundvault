// Audio engine: one 48 kHz AudioContext, a byte-budgeted decode cache, and a
// single player state machine with two backends:
//   • stream, <audio> element on soundvault:// (HTTP Range) for whole files:
//               instant start and seek even for 10-minute files, tiny memory.
//   • buffer, AudioBufferSourceNode for selections / edits / matched
//               segments: sample-accurate start/end, fades, seamless loops.
// Every play() takes a token; async continuations from stale requests are
// dropped, so fast clicking across rows can never play the wrong sound.
import { Emitter } from '../util.js';
import { selectionEdit, fadeCurve } from './edit-dsp.js';

export const SAMPLE_RATE = 48000;
const CACHE_BUDGET = 384 * 1024 * 1024;
const FADE_POINTS_PER_S = 8000, FADE_POINTS_MAX = 1 << 17;   // fade automation: 0.125 ms steps (fades up to 16 s)

/**
 * Automate one fade of a region on `param`: the editor's gain law (edit-dsp), sampled
 * densely over that fade only, from where playback starts (t0, seconds into the region).
 */
function scheduleFade(param, e, side, t0, now) {
    const a = side === 'in' ? e.cropStart : e.fadeOutStart, b = side === 'in' ? e.fadeInEnd : e.cropEnd;
    if (!(b - a > 1e-6)) return;                           // no such fade: the gain stays 1
    const from = Math.max(a, t0);
    if (b - from < 1e-5) { param.value = side === 'in' ? 1 : 0; return; }
    const n = Math.max(2, Math.min(FADE_POINTS_MAX, Math.ceil((b - from) * FADE_POINTS_PER_S) + 1));
    param.setValueCurveAtTime(fadeCurve(e, side, from, b, n), now + (from - t0), b - from);
}

let ctx = null, master = null, volume = 0.8;
export function audioCtx() {
    if (!ctx) {
        ctx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' });
        master = ctx.createGain();
        master.gain.value = volume;
        master.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
}
/** Master output node: modules with their own graphs (editor) connect here. */
export function masterNode() { audioCtx(); return master; }

// ── Native-rate decode (exports keep the source sample rate) ────────────
// ~90% of real libraries are 96/192 kHz. decodeAudioData on the 48 kHz
// playback context would resample; an OfflineAudioContext created at the
// file's own rate decodes without resampling. Small separate cache.
const nativeCache = new Map();
const NATIVE_BUDGET = 256 * 1024 * 1024;
let nativeBytes = 0;
export async function decodeNative(path, sampleRate) {
    const key = path + '@' + sampleRate;
    const hit = nativeCache.get(key);
    if (hit) { nativeCache.delete(key); nativeCache.set(key, hit); return hit; }
    try {
        const res = await fetch(window.sv.audio.url(path));
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const ab = await res.arrayBuffer();
        const sr = sampleRate > 0 ? sampleRate : SAMPLE_RATE;
        const off = new OfflineAudioContext(1, 1, sr);
        const buf = await off.decodeAudioData(ab);
        nativeCache.set(key, buf); nativeBytes += bytesOf(buf);
        for (const [k, v] of nativeCache) { if (nativeBytes <= NATIVE_BUDGET || nativeCache.size <= 1) break; if (k === key) continue; nativeCache.delete(k); nativeBytes -= bytesOf(v); }
        return buf;
    } catch (e) {
        console.warn('[decodeNative]', path, e.message);
        return null;
    }
}

export function setVolume(v) { volume = v; if (master) master.gain.setTargetAtTime(v, ctx.currentTime, 0.015); }
export const getVolume = () => volume;

// ── Decode cache (LRU by bytes, in-flight de-dup) ───────────────────────
const cache = new Map();      // path -> AudioBuffer (Map order = LRU order)
const inflight = new Map();   // path -> Promise<AudioBuffer|null>
let cacheBytes = 0;
const bytesOf = b => b.length * b.numberOfChannels * 4;

export function cachedBuffer(path) {
    const b = cache.get(path);
    if (b) { cache.delete(path); cache.set(path, b); }
    return b || null;
}

export function decode(path) {
    const hit = cachedBuffer(path);
    if (hit) return Promise.resolve(hit);
    if (inflight.has(path)) return inflight.get(path);
    const p = (async () => {
        try {
            const res = await fetch(window.sv.audio.url(path));
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const ab = await res.arrayBuffer();
            const buf = await audioCtx().decodeAudioData(ab);
            cache.set(path, buf);
            cacheBytes += bytesOf(buf);
            for (const [k, v] of cache) {
                if (cacheBytes <= CACHE_BUDGET || cache.size <= 1) break;
                if (k === path) continue;
                cache.delete(k); cacheBytes -= bytesOf(v);
            }
            return buf;
        } catch (e) {
            console.warn('[decode]', path, e.message);
            return null;
        } finally {
            inflight.delete(path);
        }
    })();
    inflight.set(path, p);
    return p;
}

export function forget(path) {
    const b = cache.get(path);
    if (b) { cacheBytes -= bytesOf(b); cache.delete(path); }
}

// ── Player ──────────────────────────────────────────────────────────────
class Player extends Emitter {
    constructor() {
        super();
        this.sound = null;          // { path, name, ... }
        this.playing = false;
        this.loading = false;
        this.mode = null;           // 'stream' | 'buffer'
        this.duration = 0;          // of the playable material (file or segment buffer)
        this.fileDuration = 0;      // of the whole file (for mapping segments onto the waveform)
        this.segment = null;        // { start, end } seconds within the file when playing a region
        this.loop = false;
        this._token = 0;
        this._audio = null; this._mediaNode = null;
        this._src = null; this._srcGain = null;
        this._startedAt = 0; this._offset = 0; this._buffer = null;
        this._pausedAt = 0;
    }

    /** Seconds within the FILE (not within the segment). */
    position() {
        if (this.mode === 'stream' && this._audio) return this._audio.currentTime || 0;
        if (this.mode === 'buffer') {
            const segStart = this.segment ? this.segment.start : 0;
            if (!this.playing) return segStart + this._pausedAt;
            let t = audioCtx().currentTime - this._startedAt + this._offset;
            if (this.loop && this.duration > 0) t %= this.duration;
            return segStart + Math.min(t, this.duration);
        }
        return 0;
    }

    _emit() { this.emit('state', this.snapshot()); }
    snapshot() {
        return { sound: this.sound, playing: this.playing, loading: this.loading, mode: this.mode, duration: this.duration, fileDuration: this.fileDuration, segment: this.segment, loop: this.loop };
    }

    _dropGains() { for (const g of this._srcGain || []) g.disconnect(); this._srcGain = null; }

    _teardown() {
        if (this._src) { this._src.onended = null; try { this._src.stop(); } catch (e) {} this._src.disconnect(); this._src = null; }
        this._dropGains();
        if (this._audio) {
            const a = this._audio;
            a.onended = a.onerror = a.onloadedmetadata = null;
            a.pause(); a.removeAttribute('src'); a.load();
            this._audio = null;
        }
        if (this._mediaNode) { this._mediaNode.disconnect(); this._mediaNode = null; }
    }

    /**
     * Play a sound.
     * opts.start/opts.end (seconds in file) → region via buffer backend.
     * opts.buffer → play an already-built AudioBuffer (editor output).
     * opts.fades (buffer only): a selection's fades { fadeIn, fadeOut (seconds),
     *   fadeInShape, fadeInTension, fadeOutShape, fadeOutTension }, the editor's model.
     * opts.at → start offset for whole-file playback.
     */
    async play(sound, opts = {}) {
        const token = ++this._token;
        this._teardown();
        this.sound = sound;
        this.segment = null;
        this.playing = false;
        this.loading = true;
        this._pausedAt = 0;
        this._emit();
        audioCtx();

        const region = opts.buffer || opts.start !== undefined || opts.end !== undefined || opts.fades;
        if (!region) return this._playStream(sound, opts.at || 0, token);

        let buf = opts.buffer || await decode(sound.path);
        if (token !== this._token) return;
        if (!buf) { this.loading = false; this.sound = null; this._emit(); this.emit('error', { sound, message: 'Could not decode this file' }); return; }
        this.fileDuration = opts.buffer ? (opts.fileDuration || buf.duration) : buf.duration;
        if (!opts.buffer && (opts.start !== undefined || opts.end !== undefined)) {
            const s = Math.max(0, opts.start || 0), e = Math.min(buf.duration, opts.end ?? buf.duration);
            if (e - s < 0.002) { this.loading = false; this._emit(); return; }
            this.segment = { start: s, end: e };
            this._playBuffer(buf, s, e - s, opts.fades, token);
        } else {
            this.segment = opts.segment || null;
            this._playBuffer(buf, 0, buf.duration, opts.fades, token);
        }
    }

    _playBuffer(buf, offset, dur, fades, token, resumeAt = 0) {
        const c = audioCtx();
        this._dropGains();                                   // pause() keeps them; never stack gains
        const src = c.createBufferSource();
        src.buffer = buf;
        // One gain per fade, in series, each automated only over its own span with the
        // editor's law (edit-dsp): what plays is what the drag or "Save" renders.
        const gIn = c.createGain(), gOut = c.createGain();
        src.connect(gIn); gIn.connect(gOut); gOut.connect(master);
        const now = c.currentTime + 0.005;
        const e = fades && ((fades.fadeIn || 0) > 0 || (fades.fadeOut || 0) > 0) ? selectionEdit({ start: 0, end: dur, ...fades }) : null;
        if (e && dur - resumeAt > 0.002) {
            scheduleFade(gIn.gain, e, 'in', resumeAt, now);
            scheduleFade(gOut.gain, e, 'out', resumeAt, now);
        }
        this._buffer = buf; this._bufOffset = offset; this._fades = fades || null;
        this.mode = 'buffer';
        this.duration = dur;
        if (this.loop && !e) {
            src.loop = true; src.loopStart = offset; src.loopEnd = offset + dur;
            src.start(now, offset + resumeAt);
        } else {
            src.start(now, offset + resumeAt, dur - resumeAt);
        }
        src.onended = () => {
            if (token !== this._token || this._src !== src) return;
            if (this.loop) { this._src = null; this._playBuffer(buf, offset, dur, fades, token, 0); return; }
            this.playing = false; this._pausedAt = 0; this._emit(); this.emit('ended', this.sound);
        };
        this._src = src; this._srcGain = [gIn, gOut];
        this._startedAt = now; this._offset = resumeAt;
        this.playing = true; this.loading = false;
        this._emit();
    }

    _playStream(sound, at, token) {
        const c = audioCtx();
        const a = new Audio();
        a.preload = 'auto';
        a.crossOrigin = 'anonymous';
        a.src = window.sv.audio.url(sound.path);
        this._audio = a;
        this._mediaNode = c.createMediaElementSource(a);
        this._mediaNode.connect(master);
        this.mode = 'stream';
        a.loop = this.loop;
        a.onloadedmetadata = () => {
            if (token !== this._token) return;
            this.duration = this.fileDuration = a.duration || 0;
            if (at > 0 && at < a.duration) a.currentTime = at;
            a.play().then(() => {
                if (token !== this._token) return;
                this.playing = true; this.loading = false; this._emit();
            }).catch(err => { if (token === this._token) { this.loading = false; this._emit(); console.warn('[player] play()', err.message); } });
        };
        a.onended = () => {
            if (token !== this._token) return;
            this.playing = false; this._emit(); this.emit('ended', this.sound);
        };
        a.onerror = async () => {
            if (token !== this._token) return;
            // Formats <audio> can't stream (rare WAV codecs): decode instead.
            this._teardown();
            const buf = await decode(sound.path);
            if (token !== this._token) return;
            if (!buf) { this.loading = false; this.sound = null; this._emit(); this.emit('error', { sound, message: 'This file cannot be played' }); return; }
            this.fileDuration = buf.duration;
            this._playBuffer(buf, 0, buf.duration, null, token, Math.min(at, buf.duration));
        };
    }

    pause() {
        if (!this.playing) return;
        if (this.mode === 'stream' && this._audio) { this._audio.pause(); }
        else if (this.mode === 'buffer' && this._src) {
            this._pausedAt = this.position() - (this.segment ? this.segment.start : 0);
            this._src.onended = null; try { this._src.stop(); } catch (e) {}
            this._src.disconnect(); this._src = null;
        }
        this.playing = false;
        this._emit();
    }

    resume() {
        if (this.playing || !this.sound) return;
        const token = this._token;
        if (this.mode === 'stream' && this._audio) {
            if (this._audio.ended) this._audio.currentTime = 0;
            this._audio.play().then(() => { if (token === this._token) { this.playing = true; this._emit(); } }).catch(() => {});
        } else if (this.mode === 'buffer' && this._buffer) {
            const at = this._pausedAt >= this.duration - 0.001 ? 0 : this._pausedAt;
            this._playBuffer(this._buffer, this._bufOffset, this.duration, this._fades, token, at);
        }
    }

    toggle() { if (this.playing) this.pause(); else this.resume(); }

    stop() {
        this._token++;
        this._teardown();
        this.playing = false; this.loading = false; this.mode = null; this.segment = null; this._pausedAt = 0;
        this._emit();
    }

    /** Seek within the file (seconds). Region playback seeks within its segment. */
    seek(t) {
        if (!this.sound) return;
        if (this.mode === 'stream' && this._audio) {
            const d = this._audio.duration || this.fileDuration || 0;
            this._audio.currentTime = Math.max(0, Math.min(d, t));
            this._emit();
            return;
        }
        if (this.mode === 'buffer' && this._buffer) {
            const segStart = this.segment ? this.segment.start : 0;
            const rel = Math.max(0, Math.min(this.duration - 0.001, t - segStart));
            if (this.playing) {
                const token = this._token;
                if (this._src) { this._src.onended = null; try { this._src.stop(); } catch (e) {} this._src.disconnect(); this._src = null; }
                this._dropGains();
                this._playBuffer(this._buffer, this._bufOffset, this.duration, this._fades, token, rel);
            } else { this._pausedAt = rel; this._emit(); }
        }
    }

    setLoop(on) {
        this.loop = !!on;
        if (this._audio) this._audio.loop = this.loop;
        if (this.mode === 'buffer' && this._src && this.playing) {
            // Re-arm the source so the new loop setting applies immediately
            const at = this.position() - (this.segment ? this.segment.start : 0);
            const token = this._token;
            this._src.onended = null; try { this._src.stop(); } catch (e) {} this._src.disconnect(); this._src = null;
            this._playBuffer(this._buffer, this._bufOffset, this.duration, this._fades, token, Math.max(0, at));
        }
        this._emit();
    }

    isCurrent(path) { return !!(this.sound && this.sound.path === path); }
}

export const player = new Player();
