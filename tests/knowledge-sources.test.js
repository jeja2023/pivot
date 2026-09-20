'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { db } = require('../server/db');
const {
    archiveMissingSourceDocuments,
    assertKnowledgeSourcePathAllowed,
    createKnowledgeSourceSyncScheduler,
    normalizeLocalDirectoryConfig,
    normalizeSourceConfig,
    walkDirectory
} = require('../server/services/knowledge-sources');
const { createKnowledgeArticle } = require('../server/services/knowledge-content');
const { normalizeTemplateInput } = require('../server/services/knowledge-database-templates');

function cleanup(dir) {
    fs.rmSync(dir, { recursive: true, force: true });
}

test('局域网目录来源必须位于白名单内，并只扫描允许的知识文件', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-knowledge-source-'));
    const nested = path.join(root, 'nested');
    fs.mkdirSync(nested);
    fs.writeFileSync(path.join(root, 'guide.md'), '# 指南');
    fs.writeFileSync(path.join(root, 'ignore.exe'), 'binary');
    fs.writeFileSync(path.join(nested, 'policy.txt'), '制度正文');
    try {
        const env = { KNOWLEDGE_LOCAL_SOURCE_ROOTS: root, KNOWLEDGE_SOURCE_MAX_FILES: '20' };
        const config = normalizeLocalDirectoryConfig({ rootPath: root, recursive: false }, { env });
        assert.equal(config.rootPath, path.resolve(root));
        assert.deepEqual((await walkDirectory(root, config)).map(item => item.name), ['guide.md']);
        assert.throws(() => assertKnowledgeSourcePathAllowed(path.dirname(root), { env }), error => error.code === 'KNOWLEDGE_SOURCE_ROOT_DENIED');
        assert.deepEqual(normalizeSourceConfig('lan_http', { url: 'https://kb.internal/manifest', credentialRef: 'KB_TOKEN' }), {
            url: 'https://kb.internal/manifest',
            manifestPath: '',
            credentialRef: 'KB_TOKEN',
            credentialHeader: 'Authorization',
            credentialPrefix: 'Bearer',
            syncDeletes: false
        });
        assert.deepEqual(normalizeSourceConfig('database', { connectionId: 'readonly-db', queryTemplateId: 7 }), {
            connectionId: 'readonly-db', queryTemplateId: 7, syncDeletes: false
        });
        assert.throws(
            () => normalizeSourceConfig('database', { connectionId: 'readonly-db', sql: 'SELECT content FROM policies' }),
            /查询模板/
        );
    } finally {
        cleanup(root);
    }
});

test('数据库知识模板只接受单条只读 SQL，并固定用于内容投影的字段名', () => {
    assert.deepEqual(normalizeTemplateInput({
        connectionId: 'readonly-db', name: '制度导出', sql: 'SELECT title, content, updated_at FROM policy_view',
        titleField: 'title', contentField: 'content', watermarkField: 'updated_at'
    }), {
        connectionId: 'readonly-db', name: '制度导出', sql: 'SELECT title, content, updated_at FROM policy_view',
        titleField: 'title', contentField: 'content', watermarkField: 'updated_at'
    });
    assert.throws(
        () => normalizeTemplateInput({ connectionId: 'readonly-db', name: '危险模板', sql: 'SELECT * FROM policy_view; DELETE FROM policy_view' }),
        /单条 SQL/
    );
});

test('知识来源调度器不会并发重入，并可安全停止', async () => {
    let calls = 0;
    let timer = null;
    const scheduler = createKnowledgeSourceSyncScheduler({
        intervalMs: 10_000,
        sync: async () => { calls += 1; return { scanned: 0, started: 0, failures: [] }; },
        logger: { info() {}, warn() {} },
        setIntervalFn: callback => { timer = { callback, unref() {} }; return timer; },
        clearIntervalFn: cleared => { assert.equal(cleared, timer); }
    });
    await scheduler.start();
    assert.equal(calls, 1);
    await timer.callback();
    assert.equal(calls, 2);
    scheduler.stop();
});

test('删除同步会同时撤下产品文档与旧版检索投影，避免已删资料仍被召回', async () => {
    const suffix = Date.now().toString(36);
    const ownerId = Number(db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, 'hash', ?, '来源测试部', 'user', 'active', datetime('now', '+8 hours'))
    `).run(`knowledge_source_owner_${suffix}`, `知识来源 ${suffix}`).lastInsertRowid);
    let article = null;
    try {
        article = await createKnowledgeArticle({
            user: { id: ownerId, unit: '来源测试部', role: 'user' },
            title: '待删除的同步资料',
            content: '这段内容在数据源删除后不能继续被检索。'
        });
        const source = db.prepare('SELECT * FROM knowledge_sources WHERE id = ?').get(article.document.source_id);
        const result = await archiveMissingSourceDocuments(source, new Set(), { enabled: true });
        assert.equal(result, 1);
        assert.equal(db.prepare('SELECT lifecycle_status FROM knowledge_documents WHERE id = ?').get(article.document.id).lifecycle_status, 'archived');
        assert.deepEqual(
            db.prepare('SELECT is_enabled, lifecycle_status FROM knowledge_docs WHERE id = ?').get(article.document.legacy_doc_id),
            { is_enabled: 0, lifecycle_status: 'archived' }
        );
    } finally {
        const productId = article?.document?.id;
        const legacyIds = productId ? db.prepare('SELECT id FROM knowledge_docs WHERE product_document_id = ?').all(productId).map(row => row.id) : [];
        if (productId) {
            db.prepare("DELETE FROM knowledge_permissions WHERE resource_type = 'document' AND resource_id = ?").run(productId);
            db.prepare('DELETE FROM knowledge_documents WHERE id = ?').run(productId);
        }
        legacyIds.forEach(id => {
            db.prepare('DELETE FROM knowledge_chunks WHERE doc_id = ?').run(id);
            db.prepare('DELETE FROM knowledge_docs WHERE id = ?').run(id);
        });
        db.prepare('DELETE FROM knowledge_sources WHERE user_id = ?').run(ownerId);
        db.prepare('DELETE FROM users WHERE id = ?').run(ownerId);
    }
});
