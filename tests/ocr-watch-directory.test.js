const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { readWatchFile, resolveWatchFile, watchAuthorizedDirectory } = require('../desktop/ocr-watch-directory');

test('OCR 监控目录仅读取授权根目录内稳定且支持的文件', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-ocr-watch-'));
    const source = path.join(directory, '材料.png');
    fs.writeFileSync(source, Buffer.from('safe fixture'));
    try {
        const result = await readWatchFile({ path: directory }, '材料.png', { minStableMs: 1 });
        assert.equal(result.originalName, '材料.png');
        assert.equal(Buffer.from(result.dataBase64, 'base64').toString(), 'safe fixture');
        assert.throws(() => resolveWatchFile({ path: directory }, '../outside.png'), /无效|授权目录/);
        await assert.rejects(() => readWatchFile({ path: directory }, '材料.exe', { minStableMs: 1 }), /不支持/);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('OCR 监控目录监听可撤销且不保留持久文件句柄', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-ocr-watch-events-'));
    const names = [];
    const stop = watchAuthorizedDirectory({ path: directory }, name => names.push(name));
    try {
        fs.writeFileSync(path.join(directory, '后续材料.pdf'), '%PDF-fixture');
        await new Promise(resolve => setTimeout(resolve, 2000));
        assert.deepEqual(names, ['后续材料.pdf']);
    } finally {
        stop();
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
