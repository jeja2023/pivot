const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { PDFDocument } = require('pdf-lib');
const { decryptPdfToBuffer, getQpdfHealth, isPdfEncrypted, optimizePdf, protectPdf } = require('../server/services/document-processing/pdf/engines/qpdf');
const { runVeraPdf } = require('../server/services/document-processing/pdf/engines/verapdf');

test('PDF 加密探测异步等待进程并解释 qpdf 状态码', async () => {
    const spawnProcess = (_command, args) => {
        assert.deepEqual(args, ['--is-encrypted', 'file.pdf']);
        const child = new EventEmitter();
        setImmediate(() => child.emit('close', 2));
        return child;
    };
    assert.equal(await isPdfEncrypted('file.pdf', { health: { available: true, command: 'qpdf' }, spawnProcess }), false);
    assert.equal(await isPdfEncrypted('file.pdf', { health: { available: false } }), null);
});

test('veraPDF 进程超时会终止并报告超时错误', async () => {
    await assert.rejects(runVeraPdf(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 100 }), { code: 'VERAPDF_TIMEOUT' });
});

test('真实 qpdf 可解密、优化和重新保护 PDF，并支持特殊 Unicode 密码', async t => {
    const health = await getQpdfHealth({ refresh: true });
    if (!health.available) return t.skip('本机未安装 qpdf');
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pivot-qpdf-test-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const source = path.join(directory, 'source.pdf');
    const encrypted = path.join(directory, 'encrypted.pdf');
    const output = path.join(directory, 'protected.pdf');
    const doc = await PDFDocument.create();
    doc.addPage();
    await fs.writeFile(source, await doc.save());
    execFileSync(health.command, ['--encrypt', 'old', 'old-owner', '256', '--', source, encrypted], { stdio: 'ignore' });
    const decrypted = await decryptPdfToBuffer({ sourcePath: encrypted, password: 'old', userId: 1 });
    assert.ok((await PDFDocument.load(decrypted)).getPageCount() === 1);
    const optimized = await optimizePdf({ sourcePath: encrypted, password: 'old', userId: 1 });
    assert.ok(optimized.length > 0);
    const protectedPdf = await protectPdf({ sourcePath: encrypted, inputPassword: 'old', userId: 1,
        userPassword: '--密码😀', ownerPassword: '--owner', permissions: { print: false, modify: false } });
    await fs.writeFile(output, protectedPdf);
    const result = spawnSync(health.command, ['--password-file=-', '--check', output], { input: '--密码😀\n', encoding: 'utf8' });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /print high resolution: not allowed/);
    assert.match(result.stdout, /modify anything: not allowed/);
    await assert.rejects(decryptPdfToBuffer({ sourcePath: output, password: 'bad', userId: 1 }), { code: 'PDF_PASSWORD_INVALID' });
    await assert.rejects(decryptPdfToBuffer({ sourcePath: path.join(directory, 'secret-sensitive-path.pdf'), password: 'old', userId: 1 }), error => {
        assert.equal(error.code, 'QPDF_EXECUTION_FAILED');
        assert.doesNotMatch(error.message, /secret-sensitive-path/);
        return true;
    });
});
