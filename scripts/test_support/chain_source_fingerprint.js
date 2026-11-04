'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function chainSourceFingerprint(root) {
    const hash = crypto.createHash('sha256');
    const visit = relative => {
        const target = path.join(root, relative);
        for (const entry of fs.readdirSync(target, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
            const child = path.posix.join(relative, entry.name);
            if (entry.isDirectory()) visit(child);
            else if (entry.isFile() && /\.(js|json|css|html|md)$/.test(entry.name)) hash.update(child).update('\0').update(fs.readFileSync(path.join(root, child), 'utf8').replace(/\r\n/g, '\n')).update('\0');
        }
    };
    for (const directory of ['server', 'client', 'desktop', 'scripts', 'tests']) visit(directory);
    hash.update(fs.readFileSync(path.join(root, 'package.json')));
    return hash.digest('hex');
}

module.exports = { chainSourceFingerprint };
