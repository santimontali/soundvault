'use strict';
const { parentPort } = require('worker_threads');
const Database = require('better-sqlite3');
const {
    findBestSegment,
    decompressMatrix,
    applyGlobalNorm,
    HOP_SIZE,
    SAMPLE_RATE: SPECTRAL_SR,
} = require('./spectral-engine');

let db = null;
let selectStmt = null;

parentPort.on('message', (msg) => {
    if (msg.type === 'init') {
        db = new Database(msg.dbPath, { readonly: true });
        db.pragma('journal_mode = WAL');
        db.pragma('cache_size = -32000');
        selectStmt = db.prepare('SELECT feature_matrix, window_count, duration_ms FROM spectral_index WHERE file_path = ?');
        parentPort.postMessage({ type: 'ready' });
        return;
    }

    if (msg.type === 'match') {
        const { jobId, queryMatrix, queryNumWindows, candidates, featureWeights, globalMean, globalStd } = msg;
        const qMatrix = new Float32Array(queryMatrix.buffer, queryMatrix.byteOffset, queryMatrix.byteLength / 4);
        const gMean = globalMean ? new Float32Array(globalMean.buffer, globalMean.byteOffset, globalMean.byteLength / 4) : null;
        const gStd = globalStd ? new Float32Array(globalStd.buffer, globalStd.byteOffset, globalStd.byteLength / 4) : null;
        const results = [];

        for (const candidate of candidates) {
            try {
                const row = selectStmt.get(candidate.path);
                if (!row || !row.feature_matrix) continue;
                const matrix = decompressMatrix(row.feature_matrix);
                if (gMean && gStd) applyGlobalNorm(matrix, row.window_count, gMean, gStd);
                const match = findBestSegment(qMatrix, queryNumWindows, matrix, row.window_count, featureWeights);
                const hopMs = Math.round(HOP_SIZE / SPECTRAL_SR * 1000);
                results.push({
                    path: candidate.path,
                    clapScore: candidate.score,
                    spectralScore: match.score,
                    matchOffsetMs: match.offsetWindows * hopMs,
                    matchDurationMs: row.duration_ms,
                });
            } catch (e) {}
        }

        parentPort.postMessage({ type: 'result', jobId, results });
    }

    if (msg.type === 'shutdown') {
        if (db) db.close();
        process.exit(0);
    }
});
