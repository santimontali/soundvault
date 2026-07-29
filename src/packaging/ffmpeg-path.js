'use strict';

/**
 * Pure helper: resolve the ffmpeg-static binary path for both dev and
 * packaged (electron-builder ASAR) environments.
 *
 * Problem (packaging audit H2): in a packaged app the binary lives in
 * `resources/app.asar.unpacked/...`, but `ffmpeg-static`'s index.js returns
 * the `app.asar/...` path. `child_process.spawn` (used by fluent-ffmpeg)
 * cannot execute binaries from inside an asar archive — and libuv does NOT
 * follow the transparent asar→asar.unpacked redirect that `fs` enjoys, so the
 * literal path string itself must be rewritten.
 *
 * In dev the path contains no `app.asar` segment, so the rewrite is a no-op —
 * one call site, both environments, no Electron import required (keeps
 * `src/audio/peaks.js` pure and unit-testable).
 *
 * @param {string|null|undefined} p Path returned by require('ffmpeg-static').
 * @returns {string|null|undefined} The executable path on the real filesystem.
 */
function resolveFfmpegPath(p) {
    if (!p) return p;
    // Replace every `app.asar` segment (both slash styles) with
    // `app.asar.unpacked`. Only matches the exact directory name — never a
    // file like `app.asar.unpacked/...` itself, and never a dev path.
    return String(p).replace(/app\.asar([\\/])/g, 'app.asar.unpacked$1');
}

module.exports = { resolveFfmpegPath };
