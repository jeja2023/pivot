const fs = require('fs');
const path = require('path');

function checkpointPath(workspace, taskId) {
    return path.join(path.resolve(workspace), `${String(taskId).replace(/[^a-zA-Z0-9._-]/g, '_')}.checkpoint.json`);
}

function writeCheckpoint(workspace, taskId, state = {}) {
    const target = checkpointPath(workspace, taskId);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), state }), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temp, target);
    return target;
}

function readCheckpoint(workspace, taskId) {
    try { return JSON.parse(fs.readFileSync(checkpointPath(workspace, taskId), 'utf8')); } catch (_) { return null; }
}

module.exports = { checkpointPath, readCheckpoint, writeCheckpoint };
