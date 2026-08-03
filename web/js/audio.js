const AudioEngine = (() => {
  let ctx = null, master;
  const buffers = {};
  const peaks = {};
  const pending = {};
  const revCache = {};
  let current = null;

  function ensure() {
    if (ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.8;
    master.connect(ctx.destination);
  }

  function computePeaks(buf, buckets) {
    buckets = buckets || 260;
    const data = buf.getChannelData(0);
    const out = new Float32Array(buckets);
    const step = data.length / buckets;
    for (let i = 0; i < buckets; i++) {
      const s = Math.floor(i * step);
      const e = Math.min(data.length, Math.floor((i + 1) * step) + 1);
      let m = 0;
      for (let j = s; j < e; j += 8) {
        const v = Math.abs(data[j]);
        if (v > m) m = v;
      }
      out[i] = m;
    }
    let mx = 0;
    for (let i = 0; i < buckets; i++) mx = Math.max(mx, out[i]);
    if (mx > 0.001) for (let i = 0; i < buckets; i++) out[i] /= mx;
    return out;
  }

  function getRev(id) {
    if (revCache[id]) return revCache[id];
    const b = buffers[id];
    if (!b) return null;
    const nb = ctx.createBuffer(b.numberOfChannels, b.length, b.sampleRate);
    for (let c = 0; c < b.numberOfChannels; c++) {
      const s = b.getChannelData(c), d = nb.getChannelData(c);
      for (let i = 0; i < s.length; i++) d[i] = s[s.length - 1 - i];
    }
    revCache[id] = nb;
    return nb;
  }

  async function load(id, url) {
    ensure();
    if (buffers[id]) return buffers[id];
    if (pending[id]) return pending[id];
    pending[id] = (async () => {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const arr = await res.arrayBuffer();
        const buf = await ctx.decodeAudioData(arr);
        buffers[id] = buf;
        peaks[id] = computePeaks(buf, 260);
        delete pending[id];
        return buf;
      } catch (e) {
        delete pending[id];
        return null;
      }
    })();
    return pending[id];
  }

  function stop() {
    if (!current) return;
    try { current.source.onended = null; current.source.stop(); } catch (e) {}
    current = null;
  }

  function play(id, opts) {
    opts = opts || {};
    ensure();
    if (ctx.state === 'suspended') ctx.resume();
    if (!buffers[id]) return null;
    stop();
    const reverse = !!opts.reverse;
    const full = buffers[id].duration;
    const src_buf = reverse ? getRev(id) : buffers[id];
    if (!src_buf) return null;

    let start = opts.start != null ? opts.start : (opts.offset || 0);
    let end = opts.end != null ? opts.end : full;
    start = Math.max(0, Math.min(full, start));
    end = Math.max(start, Math.min(full, end));
    const dur = Math.max(0.001, end - start);

    const src = ctx.createBufferSource();
    src.buffer = src_buf;
    const loop = !!opts.loop && !reverse && opts.start == null;
    src.loop = loop;
    if (opts.rate) src.playbackRate.value = opts.rate;

    const g = ctx.createGain();
    const g0 = opts.gain != null ? opts.gain : 1;
    const fadeIn = Math.max(0, opts.fadeIn || 0);
    const fadeOut = Math.max(0, opts.fadeOut || 0);
    const t0 = ctx.currentTime;
    if (fadeIn > 0) {
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.linearRampToValueAtTime(g0, t0 + Math.min(fadeIn, dur));
    } else {
      g.gain.setValueAtTime(g0, t0);
    }
    if (fadeOut > 0) {
      const hold = Math.max(fadeIn, dur - fadeOut);
      g.gain.setValueAtTime(g0, t0 + hold);
      g.gain.linearRampToValueAtTime(0.0001, t0 + dur);
    }
    src.connect(g);
    g.connect(master);

    if (reverse) src.start(0, full - end, loop ? undefined : dur);
    else src.start(0, start, loop ? undefined : dur);

    const mode = opts.mode || 'abs';
    current = {
      id, source: src, gain: g, loop,
      startedAt: t0, duration: dur, mode,
      absDuration: full, reverse, rate: opts.rate || 1,
    };
    src.onended = () => {
      if (current && current.source === src && !current.loop) {
        current = null;
        if (opts.onend) opts.onend();
      }
    };
    return current;
  }

  function position() {
    if (!current) return 0;
    const e = Math.max(0, ctx.currentTime - current.startedAt);
    if (current.mode === 'abs') {
      const t = current.loop ? (e % current.absDuration) : e;
      return Math.max(0, Math.min(1, t / current.absDuration));
    }
    const a = Math.min(current.duration, e * current.rate);
    const f = a / current.duration;
    return current.reverse ? Math.max(0, 1 - f) : Math.min(1, f);
  }

  function elapsed() {
    if (!current) return 0;
    const e = Math.max(0, ctx.currentTime - current.startedAt);
    if (current.mode === 'abs') {
      const t = current.loop ? (e % current.absDuration) : e;
      return Math.min(current.absDuration, t);
    }
    return Math.min(current.duration, e * current.rate);
  }

  function setVolume(v) { ensure(); master.gain.value = v; }

  return {
    load, play, stop, setVolume, position, elapsed,
    getBuffer: id => buffers[id],
    getPeaks: id => peaks[id],
    getDuration: id => buffers[id] ? buffers[id].duration : 0,
    isLoaded: id => !!buffers[id],
    get ctx() { ensure(); return ctx; },
    get active() { return current; },
  };
})();
