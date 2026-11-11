'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const { readRegulationSource, verifiedRegulationSource } = require('../server/services/regulations/extraction');
const { deriveArticleLocations } = require('../server/services/regulations/locations');

test('法规拒绝遗漏页和失败页，客户端伪造的提取证明不能被复用', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pivot-regulation-coverage-')), file = path.join(directory, 'source.pdf');
    await fs.writeFile(file, '合成文件');
    try {
        for (const status of ['omitted', 'unavailable']) {
            await assert.rejects(readRegulationSource(file, 'source.pdf', { extractText: async (_path, _mime, _name, options) => {
                options.onCoverage({ sourcePageCount: 11, coverageComplete: false, pages: [{ pageNumber: 1, text: '第一条 已识别正文', source: 'ocr' }, { pageNumber: 11, text: '', source: status }] });
                return '第一条 已识别正文';
            } }), error => error.code === 'REGULATION_SOURCE_INCOMPLETE' && error.status === 422 && error.message.includes('11'));
        }
        assert.equal(verifiedRegulationSource({ text: '伪造正文', sourceHash: 'hash' }, 'hash'), null);
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('真实两页 PDF 提取与跨页条文定位保留原页码，证明绑定原文件摘要', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pivot-regulation-pages-')), file = path.join(directory, 'source.pdf');
    try {
        const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica);
        for (const text of ['Article one.', 'Article two.']) pdf.addPage().drawText(text, { x: 40, y: 700, font, size: 14 });
        await fs.writeFile(file, await pdf.save());
        const source = await readRegulationSource(file, 'source.pdf');
        assert.equal(source.sourcePageCount, 2);
        assert.equal(verifiedRegulationSource(source, source.sourceHash), source);
        assert.equal(verifiedRegulationSource(source, 'other-file'), null);
        const locations = deriveArticleLocations([{ sortOrder: 1, content: 'Article one.' }, { sortOrder: 2, content: 'Article two.' }], source.text, source.pageSpans);
        assert.deepEqual(locations.map(location => location.pageNumber), [1, 2]);
        const crossing = deriveArticleLocations([{ sortOrder: 1, content: 'Article one.\nArticle two.' }], source.text, source.pageSpans);
        assert.equal(crossing[0].pageNumber, 1); assert.equal(crossing[0].pageEnd, 2); assert.equal(crossing[0].confidence, 1);
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('已保存的法规版本重建定位时仍使用持久化的真实页跨度', { skip: !process.env.DATABASE_URL }, async () => {
    const { queryOne, execute, query } = require('../server/db/client');
    const mutations = require('../server/services/regulations/mutations');
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pivot-regulation-version-')), file = path.join(directory, 'version.pdf');
    let documentId;
    try {
        const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica);
        for (const text of ['Article one.', 'Article two.']) pdf.addPage().drawText(text, { x: 40, y: 700, font, size: 14 });
        await fs.writeFile(file, await pdf.save());
        const user = await queryOne("SELECT id FROM users WHERE username='admin'");
        const created = await mutations.createRegulationDocumentFromUpload({ userId: user.id, file: { path: file, originalname: 'version.pdf' }, metadata: { title: '页跨度持久回归' } });
        documentId = created.document.id;
        assert.equal(created.version.extraction_coverage_json.complete, true);
        assert.equal(created.version.extraction_coverage_json.sourcePageCount, 2);
        await mutations.rebuildRegulationArticleLocations({ documentId, versionId: created.version.id });
        const rows = await query('SELECT page_start,page_end FROM regulation_articles WHERE version_id=?', [created.version.id]);
        assert.ok(rows.some(row => Number(row.page_end) === 2));
    } finally {
        if (documentId) await execute('DELETE FROM regulation_documents WHERE id=?', [documentId]);
        await fs.rm(directory, { recursive: true, force: true });
    }
});

test('长文本前缀的空白归一化不能掩盖尾部被截断的事实', async () => {
    const { getKnowledgeLimits } = require('../server/services/resource-limits');
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pivot-regulation-limit-')), file = path.join(directory, 'long.txt');
    try {
        await fs.writeFile(file, '正文\n' + ' '.repeat(getKnowledgeLimits().extractMaxChars + 10) + '尾部条文');
        await assert.rejects(readRegulationSource(file, 'long.txt'), error => error.code === 'REGULATION_SOURCE_INCOMPLETE');
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('连续空白归一化具有受控执行时间，不由回溯正则阻塞主服务', { timeout: 15000 }, async () => {
    const { promisify } = require('node:util');
    const run = promisify(require('node:child_process').execFile);
    const modulePath = require.resolve('../server/services/regulations/extraction');
    const code = "const normalize=require(process.argv[1]).normalizeRegulationText; const text='正文'+ ' '.repeat(500000)+'尾部'; const result=normalize(text); if(result!==text)process.exit(2);";
    await run(process.execPath, ['-e', code, modulePath], { timeout: 10000, windowsHide: true });
});
