const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');

const MAX_INLINE_BYTES = 64 * 1024;

function blobRoot() {
    return path.resolve(process.env.AGENT_BLOB_DIR || path.join(process.env.DATA_DIR || path.join(__dirname, '../../data'), 'agent-blobs'));
}

async function putAgentBlob(value, options = {}) {
    const serialized = typeof value === 'string' ? value : JSON.stringify(value ?? {});
    const bytes = Buffer.byteLength(serialized, 'utf8');
    if (bytes <= MAX_INLINE_BYTES) return { inline: true, bytes, ref: null };
    const digest = crypto.createHash('sha256').update(serialized).digest('hex');
    const runId = String(options.runId || 'unassigned').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'unassigned';
    const root = path.join(blobRoot(), runId);
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const filePath = path.join(root, `${digest}.json`);
    try {
        await fs.access(filePath);
    } catch (_) {
        await fs.writeFile(filePath, serialized, { encoding: 'utf8', mode: 0o600 });
    }
    return { inline: false, bytes, ref: `agent-blob://${runId}/${digest}`, filePath };
}

module.exports = { MAX_INLINE_BYTES, putAgentBlob };
