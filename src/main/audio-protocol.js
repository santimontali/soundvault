'use strict';
/**
 * soundvault://audio?path=<abs path>, streams WAV files to <audio> with
 * full HTTP Range support, so long files start instantly and seek anywhere
 * without being downloaded/decoded first.
 *
 * `registerPrivileges()` must run before app 'ready'; `handle()` after.
 */
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');

const SCHEME = 'soundvault';

function registerPrivileges(protocol) {
    protocol.registerSchemesAsPrivileged([{
        scheme: SCHEME,
        privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: true },
    }]);
}

function parseRange(header, size) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
    if (!m) return null;
    let start, end;
    if (m[1] === '' && m[2] === '') return null;
    if (m[1] === '') { const n = Number(m[2]); start = Math.max(0, size - n); end = size - 1; }
    else { start = Number(m[1]); end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1); }
    if (!(start >= 0) || start > end || start >= size) return 'invalid';
    return { start, end };
}

/**
 * @param {Electron.Protocol} protocol
 * @param {(p:string)=>boolean} isAllowed  path access policy (library root, renders dir…)
 */
function handle(protocol, isAllowed) {
    protocol.handle(SCHEME, async (req) => {
        try {
            const url = new URL(req.url);
            const fp = url.searchParams.get('path') || '';
            if (!fp || path.extname(fp).toLowerCase() !== '.wav' || !isAllowed(fp)) return new Response('Forbidden', { status: 403 });
            const st = await fs.promises.stat(fp).catch(() => null);
            if (!st || !st.isFile()) return new Response('Not found', { status: 404 });
            const size = st.size;
            const baseHeaders = { 'Content-Type': 'audio/wav', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' };
            const range = parseRange(req.headers.get('range'), size);
            if (range === 'invalid') return new Response(null, { status: 416, headers: { ...baseHeaders, 'Content-Range': `bytes */${size}` } });
            if (range) {
                const stream = Readable.toWeb(fs.createReadStream(fp, { start: range.start, end: range.end, highWaterMark: 256 * 1024 }));
                return new Response(stream, {
                    status: 206,
                    headers: { ...baseHeaders, 'Content-Length': String(range.end - range.start + 1), 'Content-Range': `bytes ${range.start}-${range.end}/${size}` },
                });
            }
            const stream = Readable.toWeb(fs.createReadStream(fp, { highWaterMark: 256 * 1024 }));
            return new Response(stream, { status: 200, headers: { ...baseHeaders, 'Content-Length': String(size) } });
        } catch (e) {
            return new Response('Error: ' + e.message, { status: 500 });
        }
    });
}

function urlFor(p) { return `${SCHEME}://audio/?path=${encodeURIComponent(p)}`; }

module.exports = { SCHEME, registerPrivileges, handle, parseRange, urlFor };
