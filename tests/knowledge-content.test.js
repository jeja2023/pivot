'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { db } = require('../server/db');
const {
    archiveDocument,
    createArticleDraftVersion,
    createKnowledgeArticle,
    createKnowledgeComment,
    getDocumentVersionDiff,
    getCitationForChunkForUser,
    getKnowledgeBlockForUser,
    getKnowledgeCitationSummary,
    getProductDocumentForUser,
    listKnowledgeComments,
    publishDocumentVersion,
    refreshKnowledgeFreshness,
    recordCitationEvent,
    reviewDocumentVersion,
    resolveKnowledgeComment,
    setProductDocumentPermission,
    submitDocumentVersionForReview,
    updateDocumentGovernance,
    verifyKnowledgeDocument
} = require('../server/services/knowledge-content');

function insertUser(username, unit = '知识库测试部') {
    return db.prepare(`
        INSERT INTO users (username, password_hash, nickname, unit, role, status, created_at)
        VALUES (?, 'hash', ?, ?, 'user', 'active', datetime('now', '+8 hours'))
    `).run(username, username, unit).lastInsertRowid;
}

test('知识文章遵循草稿、审核、发布、原子切换、引用授权与归档生命周期', async () => {
    const suffix = Date.now().toString(36);
    const ownerId = insertUser(`knowledge_owner_${suffix}`);
    const reviewerId = insertUser(`knowledge_reviewer_${suffix}`);
    const readerId = insertUser(`knowledge_reader_${suffix}`, '外部单位');
    const owner = { id: Number(ownerId), role: 'user', unit: '知识库测试部' };
    const reviewer = { id: Number(reviewerId), role: 'user', unit: '知识库测试部' };
    const reader = { id: Number(readerId), role: 'user', unit: '外部单位' };
    let article = null;
    let draft = null;
    try {
        article = await createKnowledgeArticle({
            user: owner,
            title: '采购审批指南',
            content: '采购审批需提交申请单、预算依据和合同草案。',
            summary: '第一版'
        });
        assert.ok(article?.document?.id);
        assert.equal(db.prepare('SELECT status FROM knowledge_docs WHERE id = ?').get(article.document.legacy_doc_id).status, 'draft');
        assert.equal(db.prepare('SELECT is_enabled FROM knowledge_docs WHERE id = ?').get(article.document.legacy_doc_id).is_enabled, 0);

        assert.equal(await publishDocumentVersion({ versionId: article.version.id, actor: owner }), null, '首版草稿不应跳过审核');
        const firstSubmitted = await submitDocumentVersionForReview({ versionId: article.version.id, actor: owner, reviewerUserId: reviewer.id });
        assert.equal(firstSubmitted.status, 'review');
        const firstReviewed = await reviewDocumentVersion({ versionId: article.version.id, actor: reviewer, approved: true, note: '首版准确' });
        assert.equal(firstReviewed.approved, true);
        const firstPublication = await publishDocumentVersion({ versionId: article.version.id, actor: owner });
        assert.equal(firstPublication.status, 'published');
        assert.deepEqual(db.prepare('SELECT status, is_enabled FROM knowledge_docs WHERE id = ?').get(article.document.legacy_doc_id), { status: 'lexical_ready', is_enabled: 1 });

        draft = await createArticleDraftVersion({
            documentId: article.document.id,
            actor: owner,
            title: '采购审批指南（修订）',
            content: '采购审批需提交申请单、预算依据、合同草案和风险评估。',
            summary: '增加风险评估要求'
        });
        assert.equal(db.prepare('SELECT status FROM knowledge_docs WHERE id = ?').get(draft.version.legacy_doc_id).status, 'draft');
        assert.equal(await publishDocumentVersion({ versionId: draft.version.id, actor: owner }), null, '已提交审核前的草稿不应绕过审核发布');

        const submitted = await submitDocumentVersionForReview({ versionId: draft.version.id, actor: owner, reviewerUserId: reviewer.id });
        assert.equal(submitted.status, 'review');
        const reviewed = await reviewDocumentVersion({ versionId: draft.version.id, actor: reviewer, approved: true, note: '内容准确' });
        assert.equal(reviewed.approved, true);
        const published = await publishDocumentVersion({ versionId: draft.version.id, actor: owner });
        assert.equal(published.status, 'published');
        assert.equal(db.prepare('SELECT is_enabled FROM knowledge_docs WHERE id = ?').get(article.document.legacy_doc_id).is_enabled, 0, '旧版本检索投影必须被关闭');
        assert.deepEqual(db.prepare('SELECT status, is_enabled FROM knowledge_docs WHERE id = ?').get(draft.version.legacy_doc_id), { status: 'lexical_ready', is_enabled: 1 });

        assert.equal(await getProductDocumentForUser(article.document.id, reader), null, '未授权用户不可读取产品文档');
        const permission = await setProductDocumentPermission({
            documentId: article.document.id,
            actor: owner,
            principalType: 'user',
            principalId: reader.id,
            permission: 'viewer'
        });
        assert.equal(permission.permission, 'viewer');
        assert.ok(await getProductDocumentForUser(article.document.id, reader), '文档级 viewer 授权后可读取');
        const citation = await getCitationForChunkForUser(draft.chunk.id, owner);
        assert.equal(citation.document.id, article.document.id);
        assert.match(citation.quotedText, /风险评估/);
        assert.equal(citation.openUrl, `/api/knowledge/documents/${article.document.id}/versions/${draft.version.id}/blocks/${draft.block.id}`);
        const block = await getKnowledgeBlockForUser({
            documentId: article.document.id,
            versionId: draft.version.id,
            blockId: draft.block.id,
            user: reader
        });
        assert.match(block.content, /风险评估/);
        assert.ok(await getCitationForChunkForUser(draft.chunk.id, reader), '文档级 viewer 授权后也可预览引用');
        assert.equal((await recordCitationEvent({ citationKey: citation.citationKey, user: reader, eventType: 'open' })).eventType, 'open');
        assert.equal((await recordCitationEvent({ citationKey: citation.citationKey, user: reader, eventType: 'helpful' })).eventType, 'helpful');
        assert.deepEqual(await getKnowledgeCitationSummary(reader.id), {
            opens: 1, helpful: 1, unhelpful: 0, incorrect: 0, feedbackTotal: 1, helpfulRate: 1
        });
        const comment = await createKnowledgeComment({ documentId: article.document.id, versionId: draft.version.id, user: reader, kind: 'correction', content: '建议补充风险评估模板。' });
        assert.equal(comment.status, 'open');
        assert.equal((await listKnowledgeComments({ documentId: article.document.id, user: owner })).length, 1);
        assert.deepEqual(await resolveKnowledgeComment({ commentId: comment.id, actor: owner }), { id: Number(comment.id), status: 'resolved' });
        const diff = await getDocumentVersionDiff({ documentId: article.document.id, fromVersionId: article.version.id, toVersionId: draft.version.id, user: owner });
        assert.ok(diff.changed > 0);
        assert.ok(diff.changes.some(item => /风险评估/.test(item.text)));
        const governed = await updateDocumentGovernance({
            documentId: article.document.id,
            actor: owner,
            contentOwnerUserId: owner.id,
            verifierUserId: reviewer.id,
            verifiedStatus: 'verified',
            freshnessPolicy: '30d'
        });
        assert.equal(governed.verified_status, 'verified');
        assert.equal(governed.freshness_policy, '30d');
        db.prepare("UPDATE knowledge_documents SET review_due_at = (NOW() AT TIME ZONE 'Asia/Shanghai') - INTERVAL '1 day' WHERE id = ?").run(article.document.id);
        assert.deepEqual(await refreshKnowledgeFreshness(), { scanned: 1, expired: 1 });
        assert.equal(db.prepare('SELECT lifecycle_status FROM knowledge_documents WHERE id = ?').get(article.document.id).lifecycle_status, 'expired');
        assert.equal(db.prepare('SELECT is_enabled FROM knowledge_docs WHERE id = ?').get(draft.version.legacy_doc_id).is_enabled, 0);
        const verification = await verifyKnowledgeDocument({ documentId: article.document.id, actor: reviewer });
        assert.equal(verification.verifiedStatus, 'verified');
        assert.equal(db.prepare('SELECT lifecycle_status FROM knowledge_documents WHERE id = ?').get(article.document.id).lifecycle_status, 'published');
        assert.equal(db.prepare('SELECT is_enabled FROM knowledge_docs WHERE id = ?').get(draft.version.legacy_doc_id).is_enabled, 1);
        const archived = await archiveDocument({ documentId: article.document.id, actor: owner });
        assert.equal(archived.status, 'archived');
        assert.equal(db.prepare('SELECT is_enabled FROM knowledge_docs WHERE id = ?').get(draft.version.legacy_doc_id).is_enabled, 0);
    } finally {
        const productId = article?.document?.id;
        const legacyIds = productId
            ? db.prepare('SELECT id FROM knowledge_docs WHERE product_document_id = ?').all(productId).map(row => row.id)
            : [];
        if (productId) {
            db.prepare("DELETE FROM knowledge_permissions WHERE resource_type = 'document' AND resource_id = ?").run(productId);
            db.prepare('DELETE FROM knowledge_documents WHERE id = ?').run(productId);
        }
        legacyIds.forEach(id => {
            db.prepare('DELETE FROM knowledge_chunks WHERE doc_id = ?').run(id);
            db.prepare('DELETE FROM knowledge_docs WHERE id = ?').run(id);
        });
        [ownerId, reviewerId, readerId].forEach(id => db.prepare('DELETE FROM knowledge_sources WHERE user_id = ?').run(id));
        [ownerId, reviewerId, readerId].forEach(id => db.prepare('DELETE FROM users WHERE id = ?').run(id));
    }
});
