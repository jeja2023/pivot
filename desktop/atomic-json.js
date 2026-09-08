const fs = require('fs');
const path = require('path');

function writeJsonAtomic(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(tempPath, 0o600); } catch (_) {}
    try { fs.rmSync(filePath, { force: true }); } catch (_) {}
    fs.renameSync(tempPath, filePath);
    try { fs.chmodSync(filePath, 0o600); } catch (_) {}
}

module.exports = { writeJsonAtomic };
