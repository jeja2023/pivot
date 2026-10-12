const { execute, query } = require('../../db/client');
const { getBeijingTimestamp } = require('../../time');
const { getRegulationDocumentById } = require('./catalog');
const { deleteRegulationDocument, updateRegulationDocument } = require('./mutations');

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

const BATCH_METADATA_FIELDS = { category: '分类', issuingBody: '发布机构', jurisdiction: '适用范围', status: '状态' };
const BATCH_METADATA_COLUMN = { category: 'category', issuingBody: 'issuing_body', jurisdiction: 'jurisdiction', status: 'status' };

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
            throw Object.assign(new Error('批量修改仅支持分类、发布机构、适用范围和状态'), { status: 400 });
        }
        if (typeof value !== 'string' || value.length > 120) {
            throw Object.assign(new Error(`${BATCH_METADATA_FIELDS[key]}必须为不超过 120 字的文本，请修改后重试`), { status: 400 });
        }
        if (key === 'status' && !['active', 'archived'].includes(value)) {
            throw Object.assign(new Error('状态仅支持启用或归档，请重新选择'), { status: 400 });
        }
        normalized[key] = value.trim().replace(/\s+/g, ' ');
    }
    return normalized;
}

async function updateRegulationDocuments({ documentIds, userId, patch }) {
    const uniqueIds = validateDocumentIds(documentIds);
    const metadata = validateMetadataPatch(patch);
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
            const document = await updateRegulationDocument({ documentId, userId, patch: metadata });
            if (document && !document.deleted_at) {
                const before = Object.fromEntries(Object.keys(metadata).map(key => [key, beforeDocument[BATCH_METADATA_COLUMN[key]] || '']));
                const after = Object.fromEntries(Object.keys(metadata).map(key => [key, document[BATCH_METADATA_COLUMN[key]] || '']));
                await execute(`
                    INSERT INTO regulation_document_change_logs (
                        batch_id, document_id, actor_user_id, action, before_json, after_json, created_at
                    ) VALUES (?, ?, ?, 'batch_update', ?::jsonb, ?::jsonb, ?)
                `, [batchId, documentId, userId, JSON.stringify(before), JSON.stringify(after), getBeijingTimestamp()]);
                updated.push(document);
            } else failed.push({ documentId, message: '法规文档不存在或已删除，请刷新列表' });
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
        const changedAfterBatch = !current || current.deleted_at || Object.entries(after).some(([key, value]) => String(current[BATCH_METADATA_COLUMN[key]] || '') !== String(value || ''));
        if (changedAfterBatch) {
            failed.push({ documentId, message: '该文档在本次批量修改后已发生变化，未自动覆盖' });
            continue;
        }
        const document = await updateRegulationDocument({ documentId, userId, patch: before });
        if (!document) {
            failed.push({ documentId, message: '法规文档不存在或已删除，无法撤销' });
            continue;
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
    revertRegulationDocumentBatch,
    updateRegulationDocuments
};
