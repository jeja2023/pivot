'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { extractPdfTextWithPageFallback } = require('../server/services/document-processing/text-extraction');
const { db } = require('../server/db');
const { createKnowledgeIndexStage, swapKnowledgeIndexStage } = require('../server/services/rag-index-staging');
const { queryOne } = require('../server/db/client');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createKnowledgeDocumentFromUpload, processKnowledgeDocument, readKnowledgeDocumentFromPath } = require('../server/services/rag-documents');
const { getKnowledgeLimits } = require('../server/services/resource-limits');
const ocrPages = require('../server/repositories/knowledge-ocr-pages');
const { buildPdfPageSpans, pagesForChunk } = require('../server/services/knowledge-page-locator');

test('PDF 原生文字不限于 OCR 前十页，扫描页预算与失败均记录', async () => {
    const nativePages = Array.from({ length: 15 }, (_, i) => ({ pageNumber: i + 1, text: [2, 12, 13].includes(i + 1) ? '' : `第${i + 1}页正文` }));
    const result = await extractPdfTextWithPageFallback('fixture.pdf', {
        maxOcrPages: 2,
        extractPdfTextByPage: async () => nativePages,
        renderPdfPages: async (_path, options) => [{ page: options.first, data: Buffer.from('image') }],
        ocrImageFile: async imagePath => {
            if (imagePath.includes('0012')) throw new Error('OCR 故障');
            return '扫描页文字';
        }
    });
    assert.equal(result.pages.length, 15);
    assert.equal(result.pages[14].text, '第15页正文');
    assert.equal(result.pages[1].text, '扫描页文字');
    assert.equal(result.pages[11].source, 'unavailable');
    assert.deepEqual(result.omittedPages, [13]);
    assert.equal(result.coverageComplete, false);
});

test('扫描 PDF 每次处理下一批未完成页，并保留已完成结果', async () => {
    const cache = new Map();
    const calls = [];
    const options = {
        maxOcrPages: 2, cachedOcrPages: cache,
        extractPdfTextByPage: async () => Array.from({ length: 5 }, (_, i) => ({ pageNumber: i + 1, text: '' })),
        renderPdfPages: async (_path, input) => { calls.push(input.first); return [{ data: Buffer.from('image') }]; },
        ocrImageFile: async file => `扫描正文${path.basename(file)}`,
        onOcrPage: async (page, text) => cache.set(page, text)
    };
    assert.deepEqual((await extractPdfTextWithPageFallback('a.pdf', options)).omittedPages, [3, 4, 5]);
    assert.deepEqual((await extractPdfTextWithPageFallback('a.pdf', options)).omittedPages, [5]);
    assert.equal((await extractPdfTextWithPageFallback('a.pdf', options)).coverageComplete, true);
    assert.deepEqual(calls, [1, 2, 3, 4, 5]);
});

test('页码定位基于真实提取文本范围，跨页与截断明确标记', () => {
    const spans = buildPdfPageSpans([{ pageNumber: 1, text: '甲乙丙' }, { pageNumber: 2, text: '' }, { pageNumber: 3, text: '丁戊己' }], 7);
    assert.deepEqual(spans, [{ page: 1, start: 0, end: 3 }, { page: 3, start: 5, end: 7 }]);
    assert.deepEqual(pagesForChunk(spans, 1, 6), [1, 3]);
    assert.deepEqual(pagesForChunk(spans, null, 6), []);
});

test('长制度可分轮扩大索引覆盖并保留已覆盖前文', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-long-kb-'));
    const file = path.join(root, '制度.txt');
    const limit = getKnowledgeLimits().extractMaxChars;
    fs.writeFileSync(file, '甲'.repeat(limit) + '尾部条款');
    try {
        let firstCoverage, secondCoverage;
        const first = await readKnowledgeDocumentFromPath(file, '制度.txt', { onCoverage: item => { firstCoverage = item; } });
        const second = await readKnowledgeDocumentFromPath(file, '制度.txt', { maxIndexChars: limit * 2, onCoverage: item => { secondCoverage = item; } });
        assert.equal(firstCoverage.truncated, true);
        assert.equal(secondCoverage.truncated, false);
        assert.ok(second.startsWith(first));
        assert.ok(second.endsWith('尾部条款'));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('OCR 页面缓存按文档所有者和文件哈希隔离', async () => {
    const name = `ocr_cache_${Date.now()}`;
    const owner = Number(db.prepare("INSERT INTO users (username, password_hash, nickname, role, status, created_at) VALUES (?, 'hash', ?, 'user', 'active', datetime('now', '+8 hours'))").run(name, name).lastInsertRowid);
    const doc = Number(db.prepare("INSERT INTO knowledge_docs (user_id, name, status, created_at, updated_at) VALUES (?, '扫描.pdf', 'processing', datetime('now', '+8 hours'), datetime('now', '+8 hours'))").run(owner).lastInsertRowid);
    const hash = 'a'.repeat(64);
    const location = { width: 320, height: 240, blocks: [{ text: '属于本人文档的文字', bbox: [[1, 1], [20, 1], [20, 10], [1, 10]] }] };
    await ocrPages.savePage(doc, owner, hash, 1, '属于本人文档的文字', location);
    assert.equal((await ocrPages.loadPages(doc, owner, hash)).get(1), '属于本人文档的文字');
    assert.equal((await ocrPages.loadPages(doc, owner + 1000, hash)).size, 0);
    assert.equal((await ocrPages.loadPages(doc, owner, 'b'.repeat(64))).size, 0);
    assert.deepEqual(await ocrPages.loadLocation(doc, owner, hash, 1), location);
    assert.equal(await ocrPages.loadLocation(doc, owner + 1000, hash, 1), null);
    assert.equal(await ocrPages.loadLocation(doc, owner, 'b'.repeat(64), 1), null);
    await ocrPages.savePage(doc, owner, hash, 2, '旧版扫描页文字');
    assert.deepEqual(await ocrPages.listPagesWithoutLocations(doc, owner, hash), [2]);
    assert.deepEqual(await ocrPages.listPagesWithoutLocations(doc, owner + 1000, hash), []);
});

test('旧扫描页补充坐标时重用未处理页，识别失败保留原文字', async () => {
    const cache = new Map([[1, '旧的扫描正文'], [2, '另一页扫描正文']]);
    const calls = [];
    const result = await extractPdfTextWithPageFallback('fixture.pdf', {
        maxOcrPages: 1, cachedOcrPages: cache, refreshOcrPages: new Set([1, 2]),
        extractPdfTextByPage: async () => [{ pageNumber: 1, text: '' }, { pageNumber: 2, text: '' }],
        renderPdfPages: async (_file, opts) => { calls.push(opts.first); return [{ data: Buffer.from('x') }]; },
        ocrImageFile: async () => { throw new Error('识别服务异常'); }
    });
    assert.deepEqual(calls, [1]);
    assert.equal(result.pages[0].text, '旧的扫描正文');
    assert.equal(result.pages[1].text, '另一页扫描正文');
    assert.equal(result.coverageComplete, true);
});

test('索引切换保存结构化覆盖率与配置指纹，且不会重新启用已停用文档', async () => {
    const name = `coverage_${Date.now()}`;
    const userId = Number(db.prepare("INSERT INTO users (username, password_hash, nickname, role, status, created_at) VALUES (?, 'hash', ?, 'user', 'active', datetime('now', '+8 hours'))").run(name, name).lastInsertRowid);
    const docId = Number(db.prepare("INSERT INTO knowledge_docs (user_id, name, status, is_enabled, created_at, updated_at) VALUES (?, '长文档', 'ready', 0, datetime('now', '+8 hours'), datetime('now', '+8 hours'))").run(userId).lastInsertRowid);
    const stage = await createKnowledgeIndexStage({ doc: { name: '长文档' }, userId });
    const coverage = { sourcePageCount: 15, processedPages: 14, omittedPages: [13], failedPages: [], complete: false };
    await swapKnowledgeIndexStage({ docId, stageId: Number(stage.id), userId, chunkCount: 0, sourceHash: 'hash', extractionCoverage: coverage, indexFingerprint: 'fingerprint', coverageWarning: '正文未完整索引' });
    const row = await queryOne('SELECT is_enabled, extraction_coverage_json, index_fingerprint, error_message FROM knowledge_docs WHERE id = ?', [docId]);
    assert.equal(Number(row.is_enabled), 0);
    assert.deepEqual(typeof row.extraction_coverage_json === 'string' ? JSON.parse(row.extraction_coverage_json) : row.extraction_coverage_json, coverage);
    assert.equal(row.index_fingerprint, 'fingerprint');
    assert.match(row.error_message, /未完整/);
});

test('文件不变时去重可跳过，显式强制重建替换现有分块', async () => {
    const name = `reindex_${Date.now()}`;
    const userId = Number(db.prepare("INSERT INTO users (username, password_hash, nickname, role, status, created_at) VALUES (?, 'hash', ?, 'user', 'active', datetime('now', '+8 hours'))").run(name, name).lastInsertRowid);
    const file = path.join(os.tmpdir(), `${name}.md`);
    fs.writeFileSync(file, '# 重建测试\n这是用于验证知识库重新建立索引的完整正文。');
    const created = await createKnowledgeDocumentFromUpload({ userId, file: { path: file, originalname: '重建测试.md' } });
    await processKnowledgeDocument({ docId: created.docId, userId });
    const before = await queryOne('SELECT id FROM knowledge_chunks WHERE doc_id = ? ORDER BY id LIMIT 1', [created.docId]);
    assert.ok(before?.id);
    db.prepare("UPDATE knowledge_docs SET status = 'ready' WHERE id = ?").run(created.docId);
    const skipped = await processKnowledgeDocument({ docId: created.docId, userId });
    assert.equal(skipped.skipped, true);
    const rebuilt = await processKnowledgeDocument({ docId: created.docId, userId, force: true });
    assert.notEqual(rebuilt.skipped, true);
    const after = await queryOne('SELECT id FROM knowledge_chunks WHERE doc_id = ? ORDER BY id LIMIT 1', [created.docId]);
    assert.notEqual(Number(after.id), Number(before.id));
});
