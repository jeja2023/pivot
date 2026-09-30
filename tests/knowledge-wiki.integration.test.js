'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { db } = require('../server/db');
const {
    createKnowledgeArticle,
    publishDocumentVersion,
    reviewDocumentVersion,
    submitDocumentVersionForReview
} = require('../server/services/knowledge-content');
const {
    createWikiCompileRun,
    createWikiSpace,
    getWikiPage,
    publishWikiPage,
    retrieveWikiContext,
    runWikiCompile
} = require('../server/services/knowledge-wiki');

function insertUser(username, unit = 'Wiki 集成测试部') {
    return Number(db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, 'hash', ?, ?, 'user', 'active', datetime('now', '+8 hours'))
    `).run(username, username, unit).lastInsertRowid);
}

test('Wiki Space 以已发布原始资料编译候选、审核发布并在原文更新后失效', async () => {
    const suffix = Date.now().toString(36);
    const ownerId = insertUser(`wiki_owner_${suffix}`);
    const reviewerId = insertUser(`wiki_reviewer_${suffix}`);
    const owner = { id: ownerId, role: 'user', unit: 'Wiki 集成测试部' };
    const reviewer = { id: reviewerId, role: 'user', unit: 'Wiki 集成测试部' };
    const collectionId = Number(db.prepare(`
        INSERT INTO knowledge_collections (user_id, name, description, scope, allowed_units, allowed_user_ids, created_at, updated_at)
        VALUES (?, ?, '', 'personal', '', '', datetime('now', '+8 hours'), datetime('now', '+8 hours'))
    `).run(ownerId, `Wiki Space ${suffix}`).lastInsertRowid);
    let article = null;
    let space = null;
    try {
        article = await createKnowledgeArticle({
            user: owner, collectionId, title: '差旅报销规则',
            content: '差旅报销需要保留发票，并在出差结束后五个工作日内提交审批。', summary: '差旅制度'
        });
        await submitDocumentVersionForReview({ versionId: article.version.id, actor: owner, reviewerUserId: reviewer.id });
        await reviewDocumentVersion({ versionId: article.version.id, actor: reviewer, approved: true, note: '可发布' });
        await publishDocumentVersion({ versionId: article.version.id, actor: owner });

        space = await createWikiSpace({ user: owner, collectionId, name: `差旅 Wiki ${suffix}` });
        const created = await createWikiCompileRun({ spaceId: space.id, user: owner, modelRef: 'fake-wiki-model' });
        assert.ok(created?.run?.id);
        const compiled = await runWikiCompile({
            runId: created.run.id, user: owner,
            modelRef: 'fake-wiki-model'
        }, {
            modelCfg: { id: 1, name: 'fake-wiki-model', model_name: 'fake-wiki-model' },
            callModelTextWithBudget: async () => ({ content: JSON.stringify({
                pages: [{
                    pageType: 'topic', slug: 'travel-expense', title: '差旅报销', summary: '差旅报销概要',
                    markdown: '## 提交要求\n应保留发票并在五个工作日内提交。',
                    claims: [{
                        sectionAnchor: '提交要求', statement: '应保留发票并在五个工作日内提交。',
                        sourceRefs: [{ documentId: article.document.id, versionId: article.version.id, blockId: article.block.id, chunkId: article.chunk.id, supportType: 'supports' }]
                    }],
                    links: [], conflicts: []
                }]
            }) })
        });
        assert.equal(compiled.status, 'completed');
        const candidate = compiled.pages.find(page => page.slug === 'travel-expense');
        assert.ok(candidate);
        const published = await publishWikiPage({ pageId: candidate.id, user: owner });
        assert.equal(published.page.status, 'published');
        const retrieved = await retrieveWikiContext({ user: owner, queryText: '差旅报销多久提交', spaceId: space.id });
        assert.equal(retrieved.pages.length, 1);
        assert.match(retrieved.context, /原始依据/);

        // 生成失败只能结束本次运行，不能把已审核发布的版本覆盖为失败输出。
        const invalidRun = await createWikiCompileRun({ spaceId: space.id, user: owner, modelRef: 'fake-wiki-model' });
        await assert.rejects(() => runWikiCompile({
            runId: invalidRun.run.id, user: owner, modelRef: 'fake-wiki-model'
        }, {
            modelCfg: { id: 1, name: 'fake-wiki-model', model_name: 'fake-wiki-model' },
            callModelTextWithBudget: async () => ({ content: JSON.stringify({
                pages: [{ title: '伪造来源', markdown: '无效来源不能发布。', claims: [{
                    statement: '无效来源不能发布。',
                    sourceRefs: [{ documentId: 99999, versionId: 1, blockId: 1, supportType: 'supports' }]
                }] }]
            }) })
        }), /wiki_compile_no_valid_candidates/);
        const preserved = await getWikiPage({ pageId: candidate.id, user: owner });
        assert.equal(preserved.page.status, 'published');

        // 直接变更原始文档版本会使已发布综合页失效，不允许继续作为正常检索结果。
        db.prepare(`UPDATE knowledge_documents SET current_version_id = NULL WHERE id = ?`).run(article.document.id);
        const stale = await getWikiPage({ pageId: candidate.id, user: owner });
        assert.equal(stale, null);
    } finally {
        if (space?.id) db.prepare('DELETE FROM knowledge_wiki_spaces WHERE id = ?').run(space.id);
        if (article?.document?.id) db.prepare('DELETE FROM knowledge_documents WHERE id = ?').run(article.document.id);
        db.prepare('DELETE FROM knowledge_collections WHERE id = ?').run(collectionId);
        db.prepare('DELETE FROM knowledge_sources WHERE user_id IN (?, ?)').run(ownerId, reviewerId);
        db.prepare('DELETE FROM users WHERE id IN (?, ?)').run(ownerId, reviewerId);
    }
});
