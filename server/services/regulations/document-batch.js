const { execute, query, transaction } = require('../../db/client');
const { getBeijingTimestamp } = require('../../time');
const { logger } = require('../../logger');
const { normalizeRegulationIssuingBodies } = require('./shared');
const { notifyRegulationSubscribersBulk } = require('./governance');
const { getRegulationDocumentById, getRegulationVersionById } = require('./catalog');
const {
    deleteRegulationDocument,
    queueRegulationDocumentsReindex,
    rebuildRegulationArticleLocations,
    updateRegulationDocument,
    updateRegulationVersionGovernance
} = require('./mutations');

const MAX_BATCH_DOCUMENTS = 2000;

// 批量写入的 SQL 统一经事务执行器调用，避免绕过同一连接上的锁与回滚边界。
async function runBatchQuery(trx, statement, params = []) {
    return await trx.query(statement, params);
}

async function runBatchQueryOne(trx, statement, params = []) {
    return await trx.queryOne(statement, params);
}

async function runBatchExecute(trx, statement, params = []) {
    return await trx.execute(statement, params);
}

function validateDocumentIds(documentIds) {
    if (!Array.isArray(documentIds) || !documentIds.length || documentIds.length > MAX_BATCH_DOCUMENTS) {
        throw Object.assign(new Error(`请选择 1 至 ${MAX_BATCH_DOCUMENTS} 个法规文档后重试`), { status: 400 });
    }
    const ids = documentIds.map(value => {
        const validType = typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value));
        const id = validType ? Number(value) : NaN;
        if (!Number.isSafeInteger(id) || id <= 0) {
            throw Object.assign(new Error('法规文档 ID 无效，请刷新列表后重试'), { status: 400 });
        }
        return id;
    });
    return [...new Set(ids)];
}

async function deleteRegulationDocuments({ documentIds, userId }) {
    const uniqueIds = validateDocumentIds(documentIds);
    const deleted = [];
    const failed = [];
    for (const documentId of uniqueIds) {
        try {
            if (await deleteRegulationDocument({ documentId, userId })) {
                deleted.push(documentId);
            } else {
                failed.push({ documentId, message: '法规文档不存在或已删除，请刷新列表' });
            }
        } catch (_error) {
            failed.push({ documentId, message: '删除失败，请稍后重试' });
        }
    }
    return { total: uniqueIds.length, deleted, failed };
}

const BATCH_DOCUMENT_FIELDS = {
    category: { label: '分类', column: 'category', maxLength: 120 },
    legalLevel: { label: '法规层级', column: 'legal_level', maxLength: 80 },
    issuingBody: { label: '发布机构', column: 'issuing_body', maxLength: 120 },
    jurisdiction: { label: '适用范围', column: 'jurisdiction', maxLength: 120 },
    officialSourceUrl: { label: '权威来源地址', column: 'official_source_url', maxLength: 1000 },
    metadataReviewStatus: { label: '元数据审核状态', column: 'metadata_review_status', values: ['unreviewed', 'approved', 'rejected'] },
    maintainerUserId: { label: '维护人', column: 'maintainer_user_id', type: 'id' },
    status: { label: '状态', column: 'status', values: ['active', 'archived'] }
};
const BATCH_VERSION_FIELDS = {
    effectStatus: { label: '效力状态', column: 'effect_status', values: ['unverified', 'pending', 'effective', 'expired', 'repealed'] },
    reviewStatus: { label: '版本审核状态', column: 'review_status', values: ['pending', 'approved', 'rejected'] }
};
const BATCH_METADATA_FIELDS = Object.fromEntries([
    ...Object.entries(BATCH_DOCUMENT_FIELDS),
    ...Object.entries(BATCH_VERSION_FIELDS)
].map(([key, definition]) => [key, definition.label]));

function createBatchId() {
    // 批次号只用于将同一请求的审计记录关联起来，并非认证凭据；采用时间与随机
    // 后缀，避免依赖某些嵌入式/测试运行时并不暴露的 crypto.randomUUID。
    return `reg_batch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}

function validateMetadataPatch(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch) || !Object.keys(patch).length) {
        throw Object.assign(new Error('请至少选择一个要修改的字段'), { status: 400 });
    }
    const normalized = {};
    for (const [key, value] of Object.entries(patch)) {
        if (!Object.hasOwn(BATCH_METADATA_FIELDS, key)) {
            throw Object.assign(new Error('批量修改字段不受支持，请刷新页面后重试'), { status: 400 });
        }
        if (typeof value !== 'string') {
            throw Object.assign(new Error(`${BATCH_METADATA_FIELDS[key]}格式不正确，请修改后重试`), { status: 400 });
        }
        const definition = BATCH_DOCUMENT_FIELDS[key] || BATCH_VERSION_FIELDS[key];
        const trimmed = value.trim();
        if (definition.type === 'id') {
            if (trimmed && !/^\d+$/.test(trimmed)) {
                throw Object.assign(new Error('维护人必须是有效的用户，请重新选择'), { status: 400 });
            }
            normalized[key] = trimmed;
            continue;
        }
        if (definition.values && !definition.values.includes(trimmed)) {
            throw Object.assign(new Error(`${BATCH_METADATA_FIELDS[key]}取值不合法，请重新选择`), { status: 400 });
        }
        if (definition.maxLength && trimmed.length > definition.maxLength) {
            throw Object.assign(new Error(`${BATCH_METADATA_FIELDS[key]}必须为不超过 ${definition.maxLength} 字的文本，请修改后重试`), { status: 400 });
        }
        normalized[key] = key === 'issuingBody'
            ? normalizeRegulationIssuingBodies(trimmed)
            : trimmed.replace(/\s+/g, ' ');
    }
    return normalized;
}

function splitMetadataPatch(patch) {
    const documentPatch = {};
    const versionPatch = {};
    for (const [key, value] of Object.entries(patch || {})) {
        if (Object.hasOwn(BATCH_DOCUMENT_FIELDS, key)) documentPatch[key] = value;
        if (Object.hasOwn(BATCH_VERSION_FIELDS, key)) versionPatch[key] = value;
    }
    return { documentPatch, versionPatch };
}

function getBatchFieldValue(document, version, key) {
    if (Object.hasOwn(BATCH_DOCUMENT_FIELDS, key)) return document?.[BATCH_DOCUMENT_FIELDS[key].column] ?? '';
    if (Object.hasOwn(BATCH_VERSION_FIELDS, key)) return version?.[BATCH_VERSION_FIELDS[key].column] ?? '';
    return '';
}

function buildBatchDocumentAssignments(documentPatch, userId, now) {
    const assignments = [];
    const params = [];
    for (const [key, definition] of Object.entries(BATCH_DOCUMENT_FIELDS)) {
        if (!Object.hasOwn(documentPatch, key) || key === 'metadataReviewStatus' || key === 'maintainerUserId') continue;
        assignments.push(`${definition.column} = ?`);
        params.push(documentPatch[key]);
    }
    if (Object.hasOwn(documentPatch, 'maintainerUserId')) {
        assignments.push('maintainer_user_id = ?');
        params.push(documentPatch.maintainerUserId ? Number(documentPatch.maintainerUserId) : null);
    }
    if (Object.hasOwn(documentPatch, 'metadataReviewStatus')) {
        assignments.push('metadata_review_status = ?');
        params.push(documentPatch.metadataReviewStatus);
        assignments.push("metadata_reviewed_by_user = CASE WHEN ? = 'approved' THEN ? ELSE metadata_reviewed_by_user END");
        params.push(documentPatch.metadataReviewStatus, userId || 0);
        assignments.push("metadata_reviewed_at = CASE WHEN ? = 'approved' THEN ? ELSE metadata_reviewed_at END");
        params.push(documentPatch.metadataReviewStatus, now);
    }
    assignments.push('updated_by_user = ?', 'updated_at = ?');
    params.push(userId || 0, now);
    return { assignments, params };
}

function buildBatchVersionAssignments(versionPatch, userId, now) {
    const assignments = [];
    const params = [];
    for (const [key, definition] of Object.entries(BATCH_VERSION_FIELDS)) {
        if (!Object.hasOwn(versionPatch, key) || key === 'reviewStatus') continue;
        assignments.push(`${definition.column} = ?`);
        params.push(versionPatch[key]);
    }
    if (Object.hasOwn(versionPatch, 'reviewStatus')) {
        assignments.push('review_status = ?');
        params.push(versionPatch.reviewStatus);
        assignments.push("reviewed_by_user = CASE WHEN ? = 'approved' THEN ? ELSE reviewed_by_user END");
        params.push(versionPatch.reviewStatus, userId || 0);
        assignments.push("reviewed_at = CASE WHEN ? = 'approved' THEN ? ELSE reviewed_at END");
        params.push(versionPatch.reviewStatus, now);
    }
    assignments.push('updated_at = ?');
    params.push(now);
    return { assignments, params };
}

function batchVersionFromRow(row) {
    if (!row?.batch_version_id) return null;
    return {
        id: row.batch_version_id,
        document_id: row.id,
        version_label: row.batch_version_label,
        effect_status: row.batch_effect_status,
        review_status: row.batch_review_status
    };
}

function buildBatchAuditRows(rows, documentsById, versionsByDocumentId, metadata, versionPatch) {
    return rows.map(row => {
        const beforeVersion = batchVersionFromRow(row);
        const documentId = Number(row.id);
        const afterDocument = documentsById.get(documentId) || row;
        const afterVersion = versionsByDocumentId.get(documentId) || beforeVersion;
        const before = Object.fromEntries(Object.keys(metadata).map(key => [key, getBatchFieldValue(row, beforeVersion, key)]));
        const after = Object.fromEntries(Object.keys(metadata).map(key => [key, getBatchFieldValue(afterDocument, afterVersion, key)]));
        if (Object.keys(versionPatch).length) {
            before.__currentVersionId = row.current_version_id;
            after.__currentVersionId = row.current_version_id;
        }
        return { document_id: documentId, before_json: before, after_json: after };
    });
}

async function updateRegulationDocuments({ documentIds, userId, patch }) {
    const startedAt = Date.now();
    const uniqueIds = validateDocumentIds(documentIds);
    const metadata = validateMetadataPatch(patch);
    const { documentPatch, versionPatch } = splitMetadataPatch(metadata);
    const batchId = createBatchId();
    const now = getBeijingTimestamp();
    const result = await transaction(async trx => {
        const idPlaceholders = uniqueIds.map(() => '?').join(', ');
        const rows = await runBatchQuery(trx, `
            SELECT d.*,
                   v.id AS batch_version_id,
                   v.version_label AS batch_version_label,
                   v.effect_status AS batch_effect_status,
                   v.review_status AS batch_review_status
            FROM regulation_documents d
            LEFT JOIN regulation_versions v ON v.id = d.current_version_id
            WHERE d.id IN (${idPlaceholders}) AND d.deleted_at IS NULL
            ORDER BY d.id ASC
            FOR UPDATE OF d
        `, uniqueIds);
        const documentsById = new Map(rows.map(row => [Number(row.id), row]));
        const failed = uniqueIds
            .filter(documentId => !documentsById.has(documentId))
            .map(documentId => ({ documentId, message: '法规文档不存在或已删除，请刷新列表' }));
        const eligibleRows = rows.filter(row => {
            if (!Object.keys(versionPatch).length || row.batch_version_id) return true;
            failed.push({ documentId: Number(row.id), message: '法规缺少当前版本，无法批量更新版本治理信息' });
            return false;
        });
        if (!eligibleRows.length) return { updated: [], failed, notificationCandidates: [] };

        if (Object.hasOwn(documentPatch, 'maintainerUserId') && documentPatch.maintainerUserId) {
            const assignee = await runBatchQueryOne(trx, 'SELECT id FROM users WHERE id = ? AND deleted_at IS NULL AND status = \'active\'', [Number(documentPatch.maintainerUserId)]);
            if (!assignee) throw Object.assign(new Error('维护人不存在或已停用，请重新选择'), { status: 400 });
        }

        const eligibleIds = eligibleRows.map(row => Number(row.id));
        let updatedDocuments = eligibleRows;
        if (Object.keys(documentPatch).length) {
            const update = buildBatchDocumentAssignments(documentPatch, userId, now);
            updatedDocuments = await runBatchQuery(trx, `
                UPDATE regulation_documents
                SET ${update.assignments.join(', ')}
                WHERE id IN (${eligibleIds.map(() => '?').join(', ')}) AND deleted_at IS NULL
                RETURNING *
            `, [...update.params, ...eligibleIds]);
        }
        const updatedDocumentsById = new Map(updatedDocuments.map(document => [Number(document.id), document]));

        let updatedVersions = [];
        if (Object.keys(versionPatch).length) {
            const versionIds = eligibleRows.map(row => Number(row.batch_version_id));
            const update = buildBatchVersionAssignments(versionPatch, userId, now);
            updatedVersions = await runBatchQuery(trx, `
                UPDATE regulation_versions
                SET ${update.assignments.join(', ')}
                WHERE id IN (${versionIds.map(() => '?').join(', ')})
                RETURNING id, document_id, version_label, effect_status, review_status
            `, [...update.params, ...versionIds]);
        }
        const updatedVersionsByDocumentId = new Map(updatedVersions.map(version => [Number(version.document_id), version]));
        const auditRows = buildBatchAuditRows(eligibleRows, updatedDocumentsById, updatedVersionsByDocumentId, metadata, versionPatch);
        await runBatchExecute(trx, `
            INSERT INTO regulation_document_change_logs (
                batch_id, document_id, actor_user_id, action, before_json, after_json, created_at
            )
            SELECT ?, item.document_id, ?, 'batch_update', item.before_json, item.after_json, ?
            FROM jsonb_to_recordset(?::jsonb) AS item(document_id BIGINT, before_json JSONB, after_json JSONB)
        `, [batchId, userId, now, JSON.stringify(auditRows)]);
        const notificationCandidates = updatedVersions.map(version => ({
            document: updatedDocumentsById.get(Number(version.document_id)) || documentsById.get(Number(version.document_id)),
            version
        }));
        return {
            updated: eligibleIds.map(documentId => updatedDocumentsById.get(documentId)).filter(Boolean),
            failed,
            notificationCandidates
        };
    });

    if (result.notificationCandidates.length) {
        try {
            await notifyRegulationSubscribersBulk({ candidates: result.notificationCandidates });
        } catch (error) {
            // 元数据已在事务中提交；通知失败不能把前台批量操作伪装成失败，保留结构化日志供运维补偿。
            logger.warn({ err: error.message, batchId, count: result.notificationCandidates.length }, '法规批量更新后的订阅通知发送失败');
        }
    }
    return {
        total: uniqueIds.length,
        updated: result.updated,
        failed: result.failed,
        fields: Object.keys(metadata).map(key => BATCH_METADATA_FIELDS[key]),
        batchId: result.updated.length ? batchId : null,
        durationMs: Date.now() - startedAt
    };
}

async function reindexRegulationDocuments({ documentIds }) {
    const uniqueIds = validateDocumentIds(documentIds);
    const result = await queueRegulationDocumentsReindex({ documentIds: uniqueIds });
    const queued = new Set((result.documentIds || []).map(Number));
    return {
        total: uniqueIds.length,
        queuedVersions: Number(result.queuedVersions || 0),
        clearedArticles: Number(result.clearedArticles || 0),
        queuedDocumentIds: [...queued],
        failed: uniqueIds.filter(id => !queued.has(id)).map(documentId => ({ documentId, message: '法规不存在、已归档或缺少当前版本，未加入索引队列' }))
    };
}

async function rebuildRegulationDocumentLocations({ documentIds }) {
    const uniqueIds = validateDocumentIds(documentIds);
    const rows = await query(`
        SELECT id, current_version_id
        FROM regulation_documents
        WHERE deleted_at IS NULL AND status <> 'archived' AND id IN (${uniqueIds.map(() => '?').join(', ')})
    `, uniqueIds);
    const documentsById = new Map(rows.map(row => [Number(row.id), row]));
    const rebuilt = [];
    const failed = [];
    const candidates = [];
    for (const documentId of uniqueIds) {
        const document = documentsById.get(documentId);
        if (!document?.current_version_id) {
            failed.push({ documentId, message: '法规不存在、已归档或缺少当前版本，无法重建定位' });
            continue;
        }
        candidates.push({ documentId, versionId: document.current_version_id });
    }
    let cursor = 0;
    const worker = async () => {
        while (cursor < candidates.length) {
            const current = candidates[cursor++];
            try {
                const result = await rebuildRegulationArticleLocations(current);
                if (!result) {
                    failed.push({ documentId: current.documentId, message: '法规版本不存在或无法重建定位' });
                    continue;
                }
                rebuilt.push({ documentId: current.documentId, rebuilt: Number(result.rebuilt || 0) });
            } catch (error) {
                const message = Number(error?.statusCode) === 409
                    ? (error.message || '当前版本不具备重建定位条件')
                    : '重建来源定位失败，请稍后重试';
                failed.push({ documentId: current.documentId, message });
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(3, candidates.length) }, worker));
    return {
        total: uniqueIds.length,
        rebuilt,
        rebuiltArticles: rebuilt.reduce((sum, item) => sum + item.rebuilt, 0),
        failed
    };
}

function parseAuditJson(value) {
    if (value && typeof value === 'object') return value;
    try { return JSON.parse(value || '{}'); } catch (_error) { return {}; }
}

async function listRegulationDocumentChangeLogs({ batchId, limit = 100 } = {}) {
    const id = String(batchId || '').trim();
    if (!id) return [];
    const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 100, 1), 300);
    const rows = await query(`
        SELECT l.*, d.title AS document_title
        FROM regulation_document_change_logs l
        JOIN regulation_documents d ON d.id = l.document_id
        WHERE l.batch_id = ?
        ORDER BY l.id ASC
        LIMIT ?
    `, [id, safeLimit]);
    return rows.map(row => ({ ...row, before: parseAuditJson(row.before_json), after: parseAuditJson(row.after_json) }));
}

async function revertRegulationDocumentBatch({ batchId, userId }) {
    const id = String(batchId || '').trim();
    if (!id) return { reverted: [], failed: [] };
    const logs = await listRegulationDocumentChangeLogs({ batchId: id });
    const reverted = [];
    const failed = [];
    const now = getBeijingTimestamp();
    for (const log of logs) {
        if (log.reverted_at) {
            failed.push({ documentId: Number(log.document_id), message: '该记录已被撤销' });
            continue;
        }
        const documentId = Number(log.document_id);
        const current = await getRegulationDocumentById(documentId, { includeArchived: true });
        const after = parseAuditJson(log.after_json);
        const before = parseAuditJson(log.before_json);
        const versionFields = Object.keys(after).filter(key => Object.hasOwn(BATCH_VERSION_FIELDS, key));
        const currentVersion = versionFields.length && current?.current_version_id
            ? await getRegulationVersionById(current.current_version_id)
            : null;
        const changedAfterBatch = !current || current.deleted_at
            || (after.__currentVersionId && Number(current.current_version_id) !== Number(after.__currentVersionId))
            || Object.entries(after).some(([key, value]) => {
                if (key === '__currentVersionId') return false;
                return String(getBatchFieldValue(current, currentVersion, key) || '') !== String(value || '');
            });
        if (changedAfterBatch) {
            failed.push({ documentId, message: '该文档在本次批量修改后已发生变化，未自动覆盖' });
            continue;
        }
        const { documentPatch, versionPatch } = splitMetadataPatch(before);
        const document = Object.keys(documentPatch).length
            ? await updateRegulationDocument({ documentId, userId, patch: documentPatch })
            : current;
        if (!document) {
            failed.push({ documentId, message: '法规文档不存在或已删除，无法撤销' });
            continue;
        }
        if (Object.keys(versionPatch).length) {
            const version = await updateRegulationVersionGovernance({
                documentId,
                versionId: current.current_version_id,
                userId,
                patch: versionPatch
            });
            if (!version) {
                failed.push({ documentId, message: '法规当前版本不存在，无法撤销版本治理信息' });
                continue;
            }
        }
        const changed = await execute(`
            UPDATE regulation_document_change_logs
            SET reverted_at = ?, reverted_by_user = ?
            WHERE id = ? AND reverted_at IS NULL
        `, [now, userId, log.id]);
        if (Number(changed || 0) !== 1) {
            failed.push({ documentId, message: '撤销记录已发生变化，请刷新后重试' });
            continue;
        }
        reverted.push(document);
    }
    return { reverted, failed };
}

module.exports = {
    deleteRegulationDocuments,
    listRegulationDocumentChangeLogs,
    rebuildRegulationDocumentLocations,
    reindexRegulationDocuments,
    revertRegulationDocumentBatch,
    updateRegulationDocuments
};
