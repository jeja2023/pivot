// @ts-check
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

async function removeClosedBrowserProfile(sessionId, root = '') {
    const id = String(sessionId || '');
    if (!/^browser_[a-f0-9]{32}$/.test(id)) return false;
    const base = path.resolve(root || path.join(os.tmpdir(), 'pivot-agent-browser'));
    const target = path.resolve(base, id);
    if (path.dirname(target) !== base) return false;
    await fs.rm(target, { recursive: true, force: true });
    return true;
}

module.exports = { removeClosedBrowserProfile };
