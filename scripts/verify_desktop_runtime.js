const expectedPlatform = String(process.argv[2] || '');
const expectedArch = String(process.argv[3] || '');

if (expectedPlatform && process.platform !== expectedPlatform) {
    throw new Error(`Electron 运行平台不匹配：${process.platform} != ${expectedPlatform}`);
}
if (expectedArch && process.arch !== expectedArch) {
    throw new Error(`Electron 运行架构不匹配：${process.arch} != ${expectedArch}`);
}

let sqliteDriver = '';
try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(':memory:');
    db.prepare('SELECT 1').get();
    db.close();
    sqliteDriver = 'node:sqlite';
} catch (_) {
    const Database = require('better-sqlite3');
    const db = new Database(':memory:');
    db.prepare('SELECT 1').get();
    db.close();
    sqliteDriver = 'better-sqlite3';
}

require('@duckdb/node-api');
const sharp = require('sharp');
if (!sharp?.versions?.vips) throw new Error('Sharp/libvips 未正确加载。');
require('unzipper');

console.log(JSON.stringify({
    ok: true,
    platform: process.platform,
    arch: process.arch,
    sqlite: sqliteDriver,
    sharp: sharp.versions.sharp,
    vips: sharp.versions.vips
}));
