const { execute, query } = require('../../db/client');
const { getBeijingTimestamp } = require('../../time');
const { getRegulationDocumentById, getRegulationVersionById } = require('./catalog');
const {
    deleteRegulationDocument,
    queueRegulationDocumentsReindex,
    rebuildRegulationArticleLocations,
    updateRegulationDocument,
    updateRegulationVersionGovernance
} = require('./mutations');

const MAX_BATCH_DOCUMENTS = 2000;

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
        normalized[key] = trimmed.replace(/\s+/g, ' ');
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

async function updateRegulationDocuments({ documentIds, userId, patch }) {
    const uniqueIds = validateDocumentIds(documentIds);
    const metadata = validateMetadataPatch(patch);
    const { documentPatch, versionPatch } = splitMetadataPatch(metadata);
    const batchId = createBatchId();
    const updated = [];
    const failed = [];
    for (const documentId of uniqueIds) {
        try {
            const beforeDocument = await getRegulationDocumentById(documentId, { includeArchived: true });
            if (!beforeDocument || beforeDocument.deleted_at) {
                failed.push({ documentId, message: '法规文档不存在或已删除，请刷新列表' });
                continue;
            }
            const beforeVersion = Object.keys(versionPatch).length && beforeDocument.current_version_id
                ? await getRegulationVersionById(beforeDocument.current_version_id)
                : null;
            if (Object.keys(versionPatch).length && !beforeVersion) {
                failed.push({ documentId, message: '法规缺少当前版本，无法批量更新版本治理信息' });
                continue;
            }
            const document = Object.keys(documentPatch).length
                ? await updateRegulationDocument({ documentId, userId, patch: documentPatch })
                : beforeDocument;
            const version = Object.keys(versionPatch).length
                ? await updateRegulationVersionGovernance({
                    documentId,
                    versionId: beforeDocument.current_version_id,
                    userId,
                    patch: versionPatch
                })
                : beforeVersion;
            if (document && !document.deleted_at && (!Object.keys(versionPatch).length || version)) {
                const before = Object.fromEntries(Object.keys(metadata).map(key => [key, getBatchFieldValue(beforeDocument, beforeVersion, key)]));
                const after = Object.fromEntries(Object.keys(metadata).map(key => [key, getBatchFieldValue(document, version, key)]));
                if (Object.keys(versionPatch).length) {
                    before.__currentVersionId = beforeDocument.current_version_id;
                    after.__currentVersionId = beforeDocument.current_version_id;
                }
                await execute(`
                    INSERT INTO regulation_document_change_logs (
                        batch_id, document_id, actor_user_id, action, before_json, after_json, created_at
                    ) VALUES (?, ?, ?, 'batch_update', ?::jsonb, ?::jsonb, ?)
                `, [batchId, documentId, userId, JSON.stringify(before), JSON.stringify(after), getBeijingTimestamp()]);
                updated.push(document);
            } else failed.push({ documentId, message: Object.keys(versionPatch).length ? '法规当前版本不存在，无法更新版本治理信息' : '法规文档不存在或已删除，请刷新列表' });
        } catch (_error) {
            failed.push({ documentId, message: '修改失败，请稍后重试' });
        }
    }
    return {
        total: uniqueIds.length,
        updated,
        failed,
        fields: Object.keys(metadata).map(key => BATCH_METADATA_FIELDS[key]),
        batchId: updated.length ? batchId : null
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
