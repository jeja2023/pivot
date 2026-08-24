const { parentPort } = require('worker_threads');
const bcrypt = require('bcryptjs');

parentPort.once('message', (payload = {}) => {
    try {
        const rounds = Math.min(Math.max(Number(payload.rounds) || 10, 8), 14);
        const entries = Array.isArray(payload.entries) ? payload.entries : [];
        const results = entries.map(entry => ({
            index: entry.index,
            hash: bcrypt.hashSync(String(entry.password || ''), rounds)
        }));
        parentPort.postMessage({ ok: true, results });
    } catch (error) {
        parentPort.postMessage({ ok: false, error: String(error?.message || error) });
    }
});
