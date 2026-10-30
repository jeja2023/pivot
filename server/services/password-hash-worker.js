const { parentPort } = require('worker_threads');
const bcrypt = require('bcryptjs');

parentPort.once('message', (payload = {}) => {
    try {
        if (payload.action === 'compare') {
            parentPort.postMessage({ ok: true, match: bcrypt.compareSync(String(payload.password), String(payload.hash)) });
            return;
        }
        const rounds = Math.min(Math.max(Number(payload.rounds) || 10, 8), 15);
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
