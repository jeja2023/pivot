'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const MAX_INPUT_FILE_BYTES = 50 * 1024 * 1024;

function checkInputSize(name, bytes) {
    if (bytes > MAX_INPUT_FILE_BYTES) throw Object.assign(new Error(`文件「${name}」超过完整制作的单文件上限 50 MiB，请压缩后重试。`),
        { status: 413, statusCode: 413, code: 'PPT_MASTER_INPUT_TOO_LARGE', expose: true });
}

async function saveInputSnapshot(directory, name, buffer) {
    if ((await fs.lstat(directory)).isSymbolicLink()) throw new Error('输入目录已变化，请核对任务工作区。');
    const file = path.join(directory, name);
    async function existingMatches() {
        let info;
        try { info = await fs.lstat(file); }
        catch (error) { if (error.code === 'ENOENT') return false; throw error; }
        if (info.isFile() && !info.isSymbolicLink() && info.size === buffer.length && (await fs.readFile(file)).equals(buffer)) return true;
        throw Object.assign(new Error('输入快照已变化，请核对原材料。'), { status: 409, code: 'PPT_MASTER_INPUT_CHANGED' });
    }
    if (await existingMatches()) return;
    const temporary = path.join(path.dirname(path.dirname(directory)), '.input-' + randomUUID());
    // 临时文件与最终快照同卷，完整落盘后独占登记。并发重试只接受内容相同的快照。
    const handle = await fs.open(temporary, 'wx', 0o600);
    try {
        try {
            await handle.writeFile(buffer);
            await handle.chmod(0o444);
            await handle.sync();
        } finally { await handle.close(); }
        if (!(await fs.readFile(temporary)).equals(buffer)) throw new Error('输入快照写入校验失败，请重试。');
        try { await fs.link(temporary, file); }
        catch (error) {
            if (error.code !== 'EEXIST' || !await existingMatches()) throw error;
        }
    } finally { await fs.unlink(temporary); }
}

module.exports = { MAX_INPUT_FILE_BYTES, checkInputSize, saveInputSnapshot };
