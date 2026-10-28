'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { db } = require('../server/db');
const {
    archiveMissingSourceDocuments,
    canArchiveMissing,
    buildDeletionPreview,
    resolveDeletionProtection,
    approveKnowledgeSourceDeletion,
    syncKnowledgeSource,
    assertKnowledgeSourcePathAllowed,
    createKnowledgeSourceSyncScheduler,
    normalizeLocalDirectoryConfig,
    normalizeSourceConfig,
    walkDirectory
} = require('../server/services/knowledge-sources');
const { createKnowledgeArticle } = require('../server/services/knowledge-content');
const { normalizeTemplateInput } = require('../server/services/knowledge-database-templates');
const { archiveSelectedExternalWikiPages } = require('../server/services/knowledge-wiki-markdown');

function cleanup(dir) {
    fs.rmSync(dir, { recursive: true, force: true });
}

test('未完整扫描或大比例缺失时禁止同步删除', async () => {
    const docs = Array.from({ length: 10 }, (_, i) => ({ canonical_uri: `doc-${i}` }));
    assert.equal(canArchiveMissing(docs, new Set(['doc-0']), false, true), false);
    assert.equal(canArchiveMissing(docs, new Set(['doc-0']), true, true), false);
    assert.equal(canArchiveMissing(docs, new Set(docs.slice(0, 9).map(item => item.canonical_uri)), true, true), true);
    assert.equal(canArchiveMissing(docs, new Set(), true, false), false);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-kb-limit-'));
    try {
        fs.writeFileSync(path.join(root, 'a.md'), 'a');
        fs.writeFileSync(path.join(root, 'b.md'), 'b');
        const files = await walkDirectory(root, { maxFiles: 1, recursive: true, extensions: ['.md'] });
        assert.equal(files.length, 1);
        assert.equal(files.scanComplete, false);
    } finally { cleanup(root); }
});

test('WebDAV 范围变化后的首次完整同步不归档旧范围资料', async () => {
    let admin = db.prepare("SELECT id, username, role FROM users WHERE username = 'admin'").get();
    if (!admin) {
        const id = Number(db.prepare("INSERT INTO users (username, password_hash, nickname, role, status, created_at) VALUES ('admin', 'hash', '管理员', 'admin', 'active', datetime('now', '+8 hours'))").run().lastInsertRowid);
        admin = { id, username: 'admin', role: 'admin' };
    }
    const sourceId = Number(db.prepare("INSERT INTO knowledge_sources (user_id, name, kind, config_json, status, sync_cursor, created_at, updated_at) VALUES (?, '测试目录', 'webdav', ?, 'active', '{}', datetime('now', '+8 hours'), datetime('now', '+8 hours'))").run(admin.id, JSON.stringify({ url: 'https://example.test/old/', syncDeletes: true })).lastInsertRowid);
    const article = await createKnowledgeArticle({ user: admin, title: '保留资料', content: '用于验证连接范围变更时不得误归档。' });
    db.prepare('UPDATE knowledge_documents SET source_id = ?, canonical_uri = ? WHERE id = ?').run(sourceId, 'https://example.test/old/1.md', article.document.id);
    const deps = { listWebdavFiles: async () => ({ items: [], complete: true }) };
    const first = await syncKnowledgeSource({ sourceId, user: admin, deps });
    assert.equal(first.deletionBlocked, true);
    assert.equal(first.archived, 0);
    db.prepare('UPDATE knowledge_sources SET config_json = ? WHERE id = ?').run(JSON.stringify({ url: 'https://example.test/new/', syncDeletes: true }), sourceId);
    const changed = await syncKnowledgeSource({ sourceId, user: admin, deps });
    assert.equal(changed.scopeChanged, true);
    assert.equal(changed.archived, 0);
    assert.notEqual(db.prepare('SELECT lifecycle_status FROM knowledge_documents WHERE id = ?').get(article.document.id).lifecycle_status, 'archived');
    const repeated = await syncKnowledgeSource({ sourceId, user: admin, deps });
    assert.equal(repeated.scopeChanged, false);
    assert.equal(repeated.archived, 0, '旧范围资料不能被新目录扫描归档');
});

test('删除审批绑定完整扫描快照、管理员、有效期与一次使用', async () => {
    let admin = db.prepare("SELECT id, username, role FROM users WHERE username = 'admin'").get();
    if (!admin) {
        const id = Number(db.prepare("INSERT INTO users (username, password_hash, nickname, role, status, created_at) VALUES ('admin', 'hash', '管理员', 'admin', 'active', datetime('now', '+8 hours'))").run().lastInsertRowid);
        admin = { id, username: 'admin', role: 'admin' };
    }
    const ownerId = Number(db.prepare("INSERT INTO users (username, password_hash, nickname, role, status, created_at) VALUES (?, 'hash', '所有者', 'user', 'active', datetime('now', '+8 hours'))").run(`delete_approval_${Date.now()}`).lastInsertRowid);
    const sourceId = Number(db.prepare("INSERT INTO knowledge_sources (user_id, name, kind, config_json, status, created_at, updated_at) VALUES (?, '审批来源', 'local_dir', '{}', 'active', datetime('now', '+8 hours'), datetime('now', '+8 hours'))").run(ownerId).lastInsertRowid);
    const source = { id: sourceId, user_id: ownerId, kind: 'local_dir', config_json: '{}' };
    const docs = Array.from({ length: 10 }, (_, i) => ({ id: i + 1, title: `文件${i}`, canonical_uri: `file-${i}`, updated_at: '2026-01-01T00:00:00Z', lifecycle_status: 'published' }));
    const seen = new Set(['file-0']);
    const preview = buildDeletionPreview(source, docs, seen);
    const summary = JSON.stringify({ scanComplete: true, deletionBlocked: true, deletionPreview: preview });
    const runId = Number(db.prepare("INSERT INTO knowledge_source_sync_runs (source_id, status, summary_json, created_at, updated_at) VALUES (?, 'partial', ?, datetime('now', '+8 hours'), datetime('now', '+8 hours'))").run(sourceId, summary).lastInsertRowid);
    await assert.rejects(() => approveKnowledgeSourceDeletion({ sourceId, runId, user: { id: ownerId, role: 'user' } }), /系统管理员/);
    const approval = await approveKnowledgeSourceDeletion({ sourceId, runId, user: admin });
    const changed = await resolveDeletionProtection({ source, existing: docs, seen: new Set(['file-0', 'file-1']), scanComplete: true, enabled: true, approvalId: approval.id, actor: admin });
    assert.equal(changed.allowed, false);
    assert.equal(changed.approvalRejected, true);
    const incomplete = await resolveDeletionProtection({ source, existing: docs, seen, scanComplete: false, enabled: true, approvalId: approval.id, actor: admin });
    assert.equal(incomplete.allowed, false);
    const approved = await resolveDeletionProtection({ source, existing: docs, seen, scanComplete: true, enabled: true, approvalId: approval.id, actor: admin });
    assert.equal(approved.allowed, true);
    assert.equal((await resolveDeletionProtection({ source, existing: docs, seen, scanComplete: true, enabled: true, approvalId: approval.id, actor: admin })).allowed, false);
});

test('外部 Wiki 归档审批同时绑定文档和页面及其版本', async () => {
    const source = { id: 91, kind: 'wiki_markdown', config_json: '{}' };
    const docs = Array.from({ length: 6 }, (_, i) => ({ id: i + 1, title: `文档${i}`, canonical_uri: `doc-${i}`, updated_at: '2026-01-01T00:00:00Z', lifecycle_status: 'published' }));
    const pages = Array.from({ length: 6 }, (_, i) => ({ id: i + 1, title: `页面${i}`, canonical_uri: `doc-${i}`, content_hash: `hash-${i}`, updated_at: '2026-01-01T00:00:00Z' }));
    const preview = buildDeletionPreview(source, docs, new Set(), pages);
    assert.equal(preview.count, 12);
    assert.equal(preview.documentCount, 6);
    assert.equal(preview.wikiPageCount, 6);
    assert.notEqual(buildDeletionPreview(source, docs, new Set(), [{ ...pages[0], content_hash: 'changed' }, ...pages.slice(1)]).snapshotHash, preview.snapshotHash);
    const blocked = await resolveDeletionProtection({ source, existing: docs, externalPages: pages, seen: new Set(), scanComplete: true, enabled: true, actor: { id: 1, role: 'user' } });
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.preview.wikiPageCount, 6);
});

test('Wiki 审批只允许归档审批时未发生变化的页面', async () => {
    const suffix = Date.now().toString(36);
    const owner = Number(db.prepare("INSERT INTO users (username, password_hash, nickname, role, status, created_at) VALUES (?, 'hash', ?, 'user', 'active', datetime('now', '+8 hours'))").run(`wiki_approve_${suffix}`, suffix).lastInsertRowid);
    const sourceId = Number(db.prepare("INSERT INTO knowledge_sources (user_id, name, kind, config_json, status, created_at, updated_at) VALUES (?, '外部 Wiki', 'wiki_markdown', '{}', 'active', datetime('now', '+8 hours'), datetime('now', '+8 hours'))").run(owner).lastInsertRowid);
    const id = Number(db.prepare("INSERT INTO knowledge_wiki_external_pages (source_id, canonical_uri, title, content_hash, status, created_at, updated_at) VALUES (?, 'a.md', '页面甲', 'old', 'active', datetime('now', '+8 hours'), datetime('now', '+8 hours'))").run(sourceId).lastInsertRowid);
    const original = db.prepare('SELECT id, content_hash, updated_at::text AS stable_updated_at FROM knowledge_wiki_external_pages WHERE id = ?').get(id);
    db.prepare("UPDATE knowledge_wiki_external_pages SET content_hash = 'new' WHERE id = ?").run(id);
    assert.equal(await archiveSelectedExternalWikiPages(sourceId, [original]), 0);
    assert.equal(db.prepare('SELECT status FROM knowledge_wiki_external_pages WHERE id = ?').get(id).status, 'active');
    const current = db.prepare('SELECT id, content_hash, updated_at::text AS stable_updated_at FROM knowledge_wiki_external_pages WHERE id = ?').get(id);
    assert.equal(await archiveSelectedExternalWikiPages(sourceId, [current]), 1);
});

test('外部 Wiki 完整清单可以由管理员审批一次，页面变更会使审批失效', async () => {
    let admin = db.prepare("SELECT id, username, role FROM users WHERE username = 'admin'").get();
    if (!admin) {
        const id = Number(db.prepare("INSERT INTO users (username, password_hash, nickname, role, status, created_at) VALUES ('admin', 'hash', '管理员', 'admin', 'active', datetime('now', '+8 hours'))").run().lastInsertRowid);
        admin = { id, username: 'admin', role: 'admin' };
    }
    const suffix = Date.now().toString(36);
    const owner = Number(db.prepare("INSERT INTO users (username, password_hash, nickname, role, status, created_at) VALUES (?, 'hash', ?, 'user', 'active', datetime('now', '+8 hours'))").run(`wiki_review_${suffix}`, suffix).lastInsertRowid);
    const sourceId = Number(db.prepare("INSERT INTO knowledge_sources (user_id, name, kind, config_json, status, created_at, updated_at) VALUES (?, '测试 Wiki', 'wiki_markdown', '{}', 'active', datetime('now', '+8 hours'), datetime('now', '+8 hours'))").run(owner).lastInsertRowid);
    const source = { id: sourceId, user_id: owner, kind: 'wiki_markdown', config_json: '{}' };
    const pages = Array.from({ length: 6 }, (_, i) => ({ id: i + 1, title: `页面${i}`, canonical_uri: `page-${i}`, content_hash: `hash-${i}`, stable_updated_at: '2026-01-01 00:00:00+00' }));
    const seen = new Set();
    const preview = buildDeletionPreview(source, [], seen, pages);
    const runId = Number(db.prepare("INSERT INTO knowledge_source_sync_runs (source_id, status, summary_json, created_at, updated_at) VALUES (?, 'partial', ?, datetime('now', '+8 hours'), datetime('now', '+8 hours'))").run(sourceId, JSON.stringify({ scanComplete: true, deletionBlocked: true, deletionPreview: preview })).lastInsertRowid);
    const approval = await approveKnowledgeSourceDeletion({ sourceId, runId, user: admin });
    const changed = await resolveDeletionProtection({ source, existing: [], externalPages: [{ ...pages[0], content_hash: 'changed' }, ...pages.slice(1)], seen, scanComplete: true, enabled: true, approvalId: approval.id, actor: admin });
    assert.equal(changed.allowed, false);
    const approved = await resolveDeletionProtection({ source, existing: [], externalPages: pages, seen, scanComplete: true, enabled: true, approvalId: approval.id, actor: admin });
    assert.equal(approved.allowed, true);
    assert.equal((await resolveDeletionProtection({ source, existing: [], externalPages: pages, seen, scanComplete: true, enabled: true, approvalId: approval.id, actor: admin })).allowed, false);
});

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
