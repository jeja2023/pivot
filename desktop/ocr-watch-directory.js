'use strict';

const fs = require('fs');
const path = require('path');

const OCR_WATCH_EXTENSIONS = new Set(['.pdf', '.ofd', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);
const MAX_OCR_WATCH_FILE_BYTES = 50 * 1024 * 1024;

function watchError(message, code = 'OCR_WATCH_INVALID', status = 400) {
    const error = new Error(message);
    error.code = code;
    error.status = status;
    return error;
}

function resolveWatchFile(grant, fileName) {
    const directory = path.resolve(String(grant?.path || ''));
    const safeName = path.basename(String(fileName || ''));
    if (!directory || !safeName || safeName !== String(fileName || '')) throw watchError('授权目录文件名无效。', 'OCR_WATCH_FILE_INVALID');
    const target = path.resolve(directory, safeName);
    const relative = path.relative(directory, target);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw watchError('文件不在授权目录中。', 'OCR_WATCH_OUTSIDE_GRANT', 403);
    return target;
}

async function readWatchFile(grant, fileName, { minStableMs = 1500 } = {}) {
    const target = resolveWatchFile(grant, fileName);
    const ext = path.extname(target).toLowerCase();
    if (!OCR_WATCH_EXTENSIONS.has(ext)) throw watchError('授权目录中发现不支持的文件类型。', 'OCR_WATCH_UNSUPPORTED_FILE');
    const first = await fs.promises.stat(target);
    if (!first.isFile() || first.size <= 0 || first.size > MAX_OCR_WATCH_FILE_BYTES) throw watchError('授权目录文件为空或超过安全大小限制。', 'OCR_WATCH_FILE_SIZE', 413);
    await new Promise(resolve => setTimeout(resolve, minStableMs));
    const second = await fs.promises.stat(target);
    if (second.size !== first.size || second.mtimeMs !== first.mtimeMs) throw watchError('文件仍在写入中，稍后会再次检查。', 'OCR_WATCH_FILE_UNSTABLE', 409);
    const bytes = await fs.promises.readFile(target);
    return {
        originalName: path.basename(target),
        mimeType: ext === '.pdf' ? 'application/pdf' : (ext === '.ofd' ? 'application/ofd' : `image/${ext.slice(1) === 'jpg' ? 'jpeg' : ext.slice(1)}`),
        size: bytes.length,
        dataBase64: bytes.toString('base64')
    };
}

function watchAuthorizedDirectory(grant, onCandidate) {
    const directory = path.resolve(String(grant?.path || ''));
    if (!directory || !fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) throw watchError('已授权 OCR 目录不可用。', 'OCR_WATCH_DIRECTORY_MISSING', 404);
    const pending = new Map();
    const watcher = fs.watch(directory, { persistent: false }, (_eventType, fileName) => {
        const name = String(fileName || '');
        if (!name || !OCR_WATCH_EXTENSIONS.has(path.extname(name).toLowerCase())) return;
        clearTimeout(pending.get(name));
        pending.set(name, setTimeout(() => {
            pending.delete(name);
            onCandidate(name);
        }, 1800));
    });
    return () => {
        pending.forEach(timer => clearTimeout(timer));
        watcher.close();
    };
}

module.exports = { OCR_WATCH_EXTENSIONS, readWatchFile, resolveWatchFile, watchAuthorizedDirectory, watchError };
