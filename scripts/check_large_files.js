const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const maxBytes = 50 * 1024 * 1024;
const ignoredDirs = new Set(['node_modules', '.git', 'data', 'uploads', 'logs', 'dist-electron-remote', 'downloads', 'artifacts']);
const failures = [];

function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.') || ignoredDirs.has(entry.name)) continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(fullPath);
        else if (entry.isFile()) {
            const size = fs.statSync(fullPath).size;
            if (size > maxBytes) failures.push({ file: path.relative(rootDir, fullPath), size });
        }
    }
}

walk(rootDir);
if (failures.length) {
    console.error('Large file check failed: source tree contains files over 50 MiB:');
    failures.forEach(({ file, size }) => console.error(' - ' + file + ': ' + (size / 1024 / 1024).toFixed(1) + ' MiB'));
    process.exit(1);
}
console.log('Large file check passed.');
