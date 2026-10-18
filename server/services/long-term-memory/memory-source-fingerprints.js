'use strict';

const crypto = require('crypto');
const { query, queryOne, transaction } = require('../../db/client');
const { getBeijingTimestamp } = require('../../time');
const { MEMORY_STATUS } = require('./memory-utils');
const { invalidateMemoryQualityCache } = require('./memory-quality');
const { bumpMemoryRevision } = require('./memory-gate');

const MIN_FINGERPRINT_SECRET_BYTES = 32;

function sourceFingerprintSecret(env = process.env) {
    const secret = String(env.PIVOT_MEMORY_SOURCE_FINGERPRINT_SECRET || '').trim();
    if (Buffer.byteLength(secret, 'utf8') < MIN_FINGERPRINT_SECRET_BYTES) return '';
    if (secret === String(env.JWT_SECRET || '').trim() || secret === String(env.DATA_ENCRYPTION_KEY || '').trim()) return '';
    return secret;
}

function sourceFingerprint({ sourceKind = 'message', sourceRef = '', content = '', version = '' } = {}, env = process.env) {
    const secret = sourceFingerprintSecret(env);
    // 来源正文通常很短且可被猜测，不能把裸 SHA-256 写入数据库。缺少独立密钥时
    // 不记录可用于离线猜测的摘要；生产配置校验会阻止这种降级部署。
    if (!secret) return '';
    return crypto.createHmac('sha256', secret)
        .update(`${String(sourceKind || '').trim()}:${String(sourceRef || '').trim()}:${String(version || '').trim()}:${String(content || '')}`)
        .digest('hex');
}

function normalizeSourceRef(value, max = 255) { return String(value || '').trim().slice(0, max); }

function sourceReviewError(message, code, statusCode = 409) {
    const error = new Error(message);
    error.code = code;
    error.statusCode = statusCode;
    return error;
}

function normalizeSourceKind(value) {
    const kind = String(value || '').trim().slice(0, 24);
    if (!/^[a-z][a-z0-9_]{1,23}$/i.test(kind)) {
        throw sourceReviewError('来源类型必须是 2 至 24 位的字母、数字或下划线。', 'MEMORY_SOURCE_KIND_INVALID', 400);
    }
    return kind;
}

async function attachMemorySourceEvidence(userId, memoryId, input = {}, deps = {}) {
    const id = Number.parseInt(memoryId, 10);
    const kind = normalizeSourceKind(input.sourceKind || input.source_kind);
    const ref = normalizeSourceRef(input.sourceRef || input.source_ref);
    if (!Number.isSafeInteger(id) || id <= 0 || !ref) {
        throw sourceReviewError('记忆 ID 与来源引用为必填项。', 'MEMORY_SOURCE_INPUT_INVALID', 400);
    }
    const content = String(input.sourceContent ?? input.source_content ?? '').slice(0, 500000);
    const version = String(input.sourceVersion ?? input.source_version ?? '').slice(0, 255);
    const fingerprint = sourceFingerprint({ sourceKind: kind, sourceRef: ref, content, version }, deps.env || process.env);
    if (!fingerprint) {
        throw sourceReviewError('未配置独立的 PIVOT_MEMORY_SOURCE_FINGERPRINT_SECRET，不能登记可追溯来源。', 'MEMORY_SOURCE_FINGERPRINT_SECRET_MISSING', 503);
    }
    const evidenceExcerpt = String(input.evidenceExcerpt ?? input.evidence_excerpt ?? '').replace(/\s+/g, ' ').trim().slice(0, 2000);
    const assertedBy = String(input.assertedBy ?? input.asserted_by ?? 'user').trim().slice(0, 24) || 'user';
    const run = async trx => {
        const memory = await trx.queryOne(`
            SELECT id FROM memories WHERE id = ? AND user_id = ? AND status <> ? FOR UPDATE
        `, [id, Number(userId), MEMORY_STATUS.deleted]);
        if (!memory) throw sourceReviewError('记忆不存在、已删除或无权关联来源。', 'MEMORY_SOURCE_MEMORY_NOT_FOUND', 404);
        const now = getBeijingTimestamp();
        await trx.execute(`
            INSERT INTO memory_source_evidence (
                memory_id, user_id, source_kind, source_ref, source_fingerprint,
                asserted_by, evidence_excerpt, review_required_at, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)
            ON CONFLICT (memory_id, source_kind, source_ref) WHERE source_ref <> '' DO UPDATE SET
                source_fingerprint = EXCLUDED.source_fingerprint,
                asserted_by = EXCLUDED.asserted_by,
                evidence_excerpt = CASE WHEN EXCLUDED.evidence_excerpt <> '' THEN EXCLUDED.evidence_excerpt ELSE memory_source_evidence.evidence_excerpt END,
                review_required_at = NULL,
                reviewed_at = NULL,
                reviewed_by_user_id = NULL
        `, [id, Number(userId), kind, ref, fingerprint, assertedBy, evidenceExcerpt, now]);
        return { memoryId: id, sourceKind: kind, sourceRef: ref };
    };
    const result = deps.executor ? await run(deps.executor) : await transaction(run);
    invalidateMemoryQualityCache(userId);
    return result;
}

async function attachKnowledgeDocumentSource(userId, memoryId, documentId, deps = {}) {
    const row = await resolvePublishedKnowledgeDocument(userId, documentId, deps);
    return await attachMemorySourceEvidence(userId, memoryId, {
        sourceKind: 'knowledge_document', sourceRef: `knowledge_document:${row.id}`,
        sourceContent: String(row.source_hash || ''), sourceVersion: String(row.version_id),
        assertedBy: 'user', evidenceExcerpt: String(row.title || '').slice(0, 2000)
    }, deps);
}

async function resolvePublishedKnowledgeDocument(userId, documentId, deps = {}) {
    const id = Number.parseInt(documentId, 10);
    if (!Number.isSafeInteger(id) || id <= 0) {
        throw sourceReviewError('知识文档 ID 无效。', 'MEMORY_KNOWLEDGE_DOCUMENT_INVALID', 400);
    }
    const row = await (deps.queryOne || queryOne)(`
        SELECT d.id, d.title, v.id AS version_id, v.source_hash
        FROM knowledge_documents d
        JOIN knowledge_document_versions v ON v.id = d.current_version_id
        WHERE d.id = ? AND d.owner_user_id = ? AND d.deleted_at IS NULL
          AND d.lifecycle_status = 'published' AND v.status = 'published'
    `, [id, Number(userId)]);
    if (!row) throw sourceReviewError('知识文档不存在、未发布或无权作为记忆来源。', 'MEMORY_KNOWLEDGE_DOCUMENT_NOT_FOUND', 404);
    return row;
}

async function approveKnowledgeDocumentSourceReview(userId, memoryId, sourceRef, deps = {}) {
    const match = String(sourceRef || '').trim().match(/^knowledge_document:(\d+)$/);
    if (!match) throw sourceReviewError('知识文档来源引用无效。', 'MEMORY_KNOWLEDGE_SOURCE_REF_INVALID', 400);
    const document = await resolvePublishedKnowledgeDocument(userId, match[1], deps);
    return await approveMemorySourceReview(userId, memoryId, {
        sourceKind: 'knowledge_document', sourceRef: `knowledge_document:${document.id}`,
        sourceContent: String(document.source_hash || ''), sourceVersion: String(document.version_id)
    }, deps);
}

async function resolvePublishedWorkflow(userId, workflowId, deps = {}) {
    const id = Number.parseInt(workflowId, 10);
    if (!Number.isSafeInteger(id) || id <= 0) throw sourceReviewError('工作流 ID 无效。', 'MEMORY_WORKFLOW_INVALID', 400);
    const row = await (deps.queryOne || queryOne)(`
        SELECT w.id, w.name, v.id AS version_id, v.version, v.dag_spec
        FROM agent_workflows w
        JOIN agent_workflow_versions v ON v.id = w.published_version_id
        WHERE w.id = ? AND w.user_id = ? AND w.deleted_at IS NULL
    `, [id, Number(userId)]);
    if (!row) throw sourceReviewError('工作流不存在、未发布或无权作为记忆来源。', 'MEMORY_WORKFLOW_NOT_FOUND', 404);
    return row;
}

async function attachWorkflowSource(userId, memoryId, workflowId, deps = {}) {
    const row = await resolvePublishedWorkflow(userId, workflowId, deps);
    return await attachMemorySourceEvidence(userId, memoryId, {
        sourceKind: 'agent_workflow', sourceRef: `agent_workflow:${Number.parseInt(workflowId, 10)}`,
        sourceContent: String(row.dag_spec || ''), sourceVersion: String(row.version_id),
        assertedBy: 'user', evidenceExcerpt: String(row.name || '').slice(0, 2000)
    }, deps);
}

async function approveWorkflowSourceReview(userId, memoryId, sourceRef, deps = {}) {
    const match = String(sourceRef || '').trim().match(/^agent_workflow:(\d+)$/);
    if (!match) throw sourceReviewError('工作流来源引用无效。', 'MEMORY_WORKFLOW_SOURCE_REF_INVALID', 400);
    const workflow = await resolvePublishedWorkflow(userId, match[1], deps);
    return await approveMemorySourceReview(userId, memoryId, {
        sourceKind: 'agent_workflow', sourceRef: `agent_workflow:${match[1]}`,
        sourceContent: String(workflow.dag_spec || ''), sourceVersion: String(workflow.version_id)
    }, deps);
}

async function resolveAuthorizedWorkspaceSource(user, input = {}, deps = {}) {
    const connector = deps.connector || require('../agent-local-connector');
    const lifecycle = deps.workspaceLifecycle || require('../workspace-memory-source-lifecycle');
    const worktreeName = String(input.worktreeName || input.worktree_name || '').trim();
    const deviceId = await (deps.resolveConnectorDeviceForTool || connector.resolveConnectorDeviceForTool)(
        user, 'workspace.inspect', { deviceId: input.deviceId || input.device_id }, 'local_workspace'
    );
    const result = await (deps.executeConnectorTool || connector.executeConnectorTool)('workspace.inspect', { deviceId, worktreeName }, user);
    const revision = lifecycle.workspaceResultRevision(result);
    if (!revision) throw sourceReviewError('受控工作区快照缺少版本摘要，不能作为记忆来源。', 'MEMORY_WORKSPACE_REVISION_REQUIRED', 422);
    const sourceRef = lifecycle.workspaceMemorySourceReference(deviceId, worktreeName);
    if (!sourceRef) throw sourceReviewError('受控工作区来源引用无效。', 'MEMORY_WORKSPACE_SOURCE_REF_INVALID', 400);
    return { sourceRef, revision, worktreeName: worktreeName || 'primary' };
}

async function attachWorkspaceSource(user, memoryId, input = {}, deps = {}) {
    const source = await resolveAuthorizedWorkspaceSource(user, input, deps);
    return await attachMemorySourceEvidence(user.id, memoryId, {
        sourceKind: 'workspace', sourceRef: source.sourceRef,
        sourceContent: source.revision, sourceVersion: source.revision,
        assertedBy: 'user', evidenceExcerpt: '已授权代码工作区快照'
    }, deps);
}

async function approveWorkspaceSourceReview(user, memoryId, sourceRef, deps = {}) {
    const match = String(sourceRef || '').trim().match(/^workspace:([A-Za-z0-9._-]{1,64}):([A-Za-z0-9._-]{1,64})$/);
    if (!match) throw sourceReviewError('代码工作区来源引用无效。', 'MEMORY_WORKSPACE_SOURCE_REF_INVALID', 400);
    const source = await resolveAuthorizedWorkspaceSource(user, { deviceId: match[1], worktreeName: match[2] === 'primary' ? '' : match[2] }, deps);
    if (source.sourceRef !== sourceRef) throw sourceReviewError('代码工作区来源与当前授权范围不一致。', 'MEMORY_WORKSPACE_SOURCE_MISMATCH', 403);
    return await approveMemorySourceReview(user.id, memoryId, {
        sourceKind: 'workspace', sourceRef: source.sourceRef,
        sourceContent: source.revision, sourceVersion: source.revision
    }, deps);
}

async function markMemoriesForChangedSource(userId, { sourceKind = '', sourceRef = '', sourceFingerprint: currentFingerprint = '', reason = 'source_changed' } = {}, deps = {}) {
    const kind = String(sourceKind || '').trim().slice(0, 24);
    const ref = normalizeSourceRef(sourceRef);
    const fingerprint = String(currentFingerprint || '').trim().slice(0, 64);
    if (!userId || !kind || !ref || !fingerprint) return { reviewed: 0, memoryIds: [] };
    const run = async trx => {
        const rows = await trx.query(`
            SELECT m.id
            FROM memories m
            WHERE m.user_id = ?
              AND m.status IN (?, ?)
              AND EXISTS (
                  SELECT 1 FROM memory_source_evidence e
                  WHERE e.memory_id = m.id AND e.user_id = m.user_id
                    AND e.source_kind = ? AND e.source_ref = ?
                    AND e.source_fingerprint <> '' AND e.source_fingerprint <> ?
              )
            FOR UPDATE
        `, [Number(userId), MEMORY_STATUS.active, MEMORY_STATUS.pending, kind, ref, fingerprint]);
        if (!rows.length) return { reviewed: 0, memoryIds: [] };
        const now = getBeijingTimestamp();
        await bumpMemoryRevision(userId, trx);
        const ids = rows.map(row => Number(row.id)).filter(Number.isSafeInteger);
        await trx.execute(`
            UPDATE memories SET status = ?, revocation_reason = ?, updated_at = ?
            WHERE user_id = ? AND id IN (${ids.map(() => '?').join(',')})
        `, [MEMORY_STATUS.reviewRequired, `source_changed:${String(reason || 'source_changed').slice(0, 60)}`, now, Number(userId), ...ids]);
        await trx.execute(`
            UPDATE memory_source_evidence SET review_required_at = ?
            WHERE user_id = ? AND source_kind = ? AND source_ref = ? AND source_fingerprint <> ?
        `, [now, Number(userId), kind, ref, fingerprint]);
        return { reviewed: ids.length, memoryIds: ids };
    };
    const result = deps.executor ? await run(deps.executor) : await transaction(run);
    if (result.reviewed) invalidateMemoryQualityCache(userId);
    return result;
}

async function markMemoriesForSourceReview(userId, { sourceKind = '', sourceRef = '', reason = 'source_review_required' } = {}, deps = {}) {
    const kind = String(sourceKind || '').trim().slice(0, 24);
    const ref = normalizeSourceRef(sourceRef);
    if (!userId || !kind || !ref) return { reviewed: 0, memoryIds: [] };
    const run = async trx => {
        const rows = await trx.query(`
            SELECT m.id
            FROM memories m
            WHERE m.user_id = ? AND m.status IN (?, ?)
              AND EXISTS (
                  SELECT 1 FROM memory_source_evidence e
                  WHERE e.memory_id = m.id AND e.user_id = m.user_id
                    AND e.source_kind = ? AND e.source_ref = ?
              )
            FOR UPDATE
        `, [Number(userId), MEMORY_STATUS.active, MEMORY_STATUS.pending, kind, ref]);
        const ids = rows.map(row => Number(row.id)).filter(Number.isSafeInteger);
        if (!ids.length) return { reviewed: 0, memoryIds: [] };
        const now = getBeijingTimestamp();
        await bumpMemoryRevision(userId, trx);
        await trx.execute(`
            UPDATE memories SET status = ?, revocation_reason = ?, updated_at = ?
            WHERE user_id = ? AND id IN (${ids.map(() => '?').join(',')})
        `, [MEMORY_STATUS.reviewRequired, `source_changed:${String(reason || 'source_review_required').slice(0, 60)}`, now, Number(userId), ...ids]);
        await trx.execute(`
            UPDATE memory_source_evidence
            SET review_required_at = ?, reviewed_at = NULL, reviewed_by_user_id = NULL
            WHERE user_id = ? AND source_kind = ? AND source_ref = ?
        `, [now, Number(userId), kind, ref]);
        return { reviewed: ids.length, memoryIds: ids };
    };
    const result = deps.executor ? await run(deps.executor) : await transaction(run);
    if (result.reviewed) invalidateMemoryQualityCache(userId);
    return result;
}

async function approveMemorySourceReview(userId, memoryId, input = {}, deps = {}) {
    const id = Number.parseInt(memoryId, 10);
    const kind = String(input.sourceKind || input.source_kind || '').trim().slice(0, 24);
    const ref = normalizeSourceRef(input.sourceRef || input.source_ref);
    if (!Number.isSafeInteger(id) || id <= 0 || !kind || !ref) {
        throw sourceReviewError('记忆、来源类型和来源引用为必填项。', 'MEMORY_SOURCE_REVIEW_INPUT_INVALID', 400);
    }
    const run = async trx => {
        const evidence = await trx.query(`
            SELECT e.id, e.message_id, e.source_kind, e.source_ref, m.status
            FROM memory_source_evidence e
            JOIN memories m ON m.id = e.memory_id AND m.user_id = e.user_id
            WHERE e.memory_id = ? AND e.user_id = ? AND e.source_kind = ? AND e.source_ref = ?
              AND e.review_required_at IS NOT NULL
            FOR UPDATE OF e, m
        `, [id, Number(userId), kind, ref]);
        if (!evidence.length) {
            throw sourceReviewError('该来源当前不需要复核，或已不存在。', 'MEMORY_SOURCE_REVIEW_NOT_REQUIRED', 404);
        }
        let content = '';
        if (kind === 'message') {
            const messageId = Number(evidence[0].message_id);
            const message = Number.isSafeInteger(messageId)
                ? await trx.queryOne('SELECT content FROM messages WHERE id = ? AND user_id = ? AND deleted_at IS NULL', [messageId, Number(userId)])
                : null;
            if (!message) throw sourceReviewError('原始消息已不可用，不能确认该来源。', 'MEMORY_SOURCE_REVIEW_MESSAGE_UNAVAILABLE');
            content = String(message.content || '');
        } else if (Object.prototype.hasOwnProperty.call(input, 'sourceContent') || Object.prototype.hasOwnProperty.call(input, 'source_content')) {
            content = String(input.sourceContent ?? input.source_content ?? '').slice(0, 500000);
        } else {
            throw sourceReviewError('非消息来源必须由受控连接器提供当前来源内容。', 'MEMORY_SOURCE_REVIEW_CONTENT_REQUIRED', 400);
        }
        const fingerprint = sourceFingerprint({
            sourceKind: kind, sourceRef: ref, content,
            version: String(input.sourceVersion ?? input.source_version ?? '').slice(0, 255)
        }, deps.env || process.env);
        if (!fingerprint) {
            throw sourceReviewError('未配置独立的 PIVOT_MEMORY_SOURCE_FINGERPRINT_SECRET，不能确认来源复核。', 'MEMORY_SOURCE_FINGERPRINT_SECRET_MISSING', 503);
        }
        const now = getBeijingTimestamp();
        const reviewed = await trx.execute(`
            UPDATE memory_source_evidence
            SET source_fingerprint = ?, review_required_at = NULL, reviewed_at = ?, reviewed_by_user_id = ?
            WHERE memory_id = ? AND user_id = ? AND source_kind = ? AND source_ref = ? AND review_required_at IS NOT NULL
        `, [fingerprint, now, Number(userId), id, Number(userId), kind, ref]);
        const remaining = await trx.queryOne(`
            SELECT COUNT(*)::int AS count FROM memory_source_evidence
            WHERE memory_id = ? AND user_id = ? AND review_required_at IS NOT NULL
        `, [id, Number(userId)]);
        const reviewRemaining = Number(remaining?.count || 0);
        if (reviewRemaining === 0) {
            await bumpMemoryRevision(userId, trx);
            await trx.execute(`
                UPDATE memories SET status = ?, revocation_reason = '', updated_at = ?
                WHERE id = ? AND user_id = ? AND status = ?
            `, [MEMORY_STATUS.active, now, id, Number(userId), MEMORY_STATUS.reviewRequired]);
        }
        return { memoryId: id, reviewed, reviewRemaining, activated: reviewRemaining === 0 };
    };
    const result = deps.executor ? await run(deps.executor) : await transaction(run);
    invalidateMemoryQualityCache(userId);
    return result;
}

async function refreshMessageSourceFingerprints(userId, messageIds = [], deps = {}) {
    const ids = [...new Set((Array.isArray(messageIds) ? messageIds : [messageIds]).map(Number).filter(Number.isSafeInteger))].slice(0, 100);
    if (!userId || !ids.length) return { reviewed: 0, memoryIds: [] };
    const rows = await (deps.query || query)(`
        SELECT id, content FROM messages WHERE user_id = ? AND id IN (${ids.map(() => '?').join(',')}) AND deleted_at IS NULL
    `, [Number(userId), ...ids]);
    const results = [];
    for (const row of rows) {
        const ref = `message:${row.id}`;
        results.push(await markMemoriesForChangedSource(userId, {
            sourceKind: 'message', sourceRef: ref,
            sourceFingerprint: sourceFingerprint({ sourceKind: 'message', sourceRef: ref, content: row.content || '' }),
            reason: 'message_content_changed'
        }, deps));
    }
    return { reviewed: results.reduce((sum, item) => sum + Number(item.reviewed || 0), 0), memoryIds: results.flatMap(item => item.memoryIds || []) };
}

module.exports = {
    approveWorkspaceSourceReview,
    approveWorkflowSourceReview,
    approveKnowledgeDocumentSourceReview,
    attachKnowledgeDocumentSource,
    attachMemorySourceEvidence,
    attachWorkflowSource,
    attachWorkspaceSource,
    approveMemorySourceReview,
    markMemoriesForChangedSource,
    markMemoriesForSourceReview,


    normalizeSourceRef,
    refreshMessageSourceFingerprints,
    sourceFingerprintSecret,
    sourceFingerprint
};
