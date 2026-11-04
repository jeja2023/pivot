const { query, queryOne, execute } = require('../db/client');
const model = require('../../client/common/official-writing-document');
const library = require('../repositories/official-writing-library');

const MAX_CLIENT_ID_LENGTH = 96;
const MAX_TITLE_LENGTH = 120;
const MAX_STATE_BYTES = 4 * 1024 * 1024;

function documentError(message, status = 400, code = 'OFFICIAL_WRITING_DOCUMENT_INVALID') {
    const error = new Error(message);
    error.status = status;
    error.code = code;
    return error;
}

function normalizeClientId(value) {
    const clientId = String(value || '').trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(clientId) || clientId.length > MAX_CLIENT_ID_LENGTH) {
        throw documentError('公文标识无效。');
    }
    return clientId;
}

function normalizeTitle(value) {
    const title = String(value || '').trim().replace(/\s+/g, ' ');
    return (title || '未命名公文').slice(0, MAX_TITLE_LENGTH);
}

function normalizeState(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw documentError('公文内容格式无效。');
    }
    let serialized;
    try {
        const state = model.normalize(value);
        state.artifactId = '';
        serialized = JSON.stringify(state);
    } catch (_) {
        throw documentError('公文内容无法保存。');
    }
    if (!serialized || Buffer.byteLength(serialized, 'utf8') > MAX_STATE_BYTES) {
        throw documentError('单篇公文内容过大，请精简历史版本或素材后重试。', 413, 'OFFICIAL_WRITING_DOCUMENT_TOO_LARGE');
    }
    return serialized;
}

function parseState(value) {
    try {
        const state = JSON.parse(String(value || '{}'));
        return state && typeof state === 'object' && !Array.isArray(state) ? state : {};
    } catch (_) {
        return {};
    }
}

function toPublicDocument(row) {
    if (!row) return null;
    return {
        id: String(row.client_id),
        title: String(row.title || '未命名公文'),
        manualTitle: Number(row.manual_title || 0) === 1,
        updatedAt: row.updated_at,
        createdAt: row.created_at,
        version: Number(row.version || 1),
        artifactId: row.artifact_id ? String(row.artifact_id) : '',
        summary: row.summary && typeof row.summary === 'object' ? row.summary : model.summary(parseState(row.state)),
        ...(row.state === undefined ? {} : { state: { ...model.normalize(parseState(row.state)), artifactId: row.artifact_id ? String(row.artifact_id) : '' } })
    };
}

async function listOfficialWritingDocuments(user) {
    if (!user?.id) throw documentError('未授权访问。', 401, 'AUTH_REQUIRED');
    const rows = await query(`
        SELECT client_id, title, manual_title, state, summary, artifact_id, version, created_at, updated_at
        FROM official_writing_documents
        WHERE user_id = ? AND deleted_at IS NULL
        ORDER BY updated_at DESC, id DESC
    `, [user.id]);
    return rows.map(toPublicDocument);
}

async function saveOfficialWritingDocument(user, clientIdInput, body = {}) {
    if (!user?.id) throw documentError('未授权访问。', 401, 'AUTH_REQUIRED');
    const clientId = normalizeClientId(clientIdInput);
    const title = normalizeTitle(body.title);
    const manualTitle = body.manualTitle === true ? 1 : 0;
    const state = normalizeState(body.state);
    const clientVersion = Number(body.version || 0);
    if (!Number.isSafeInteger(clientVersion) || clientVersion < 0) throw documentError('公文版本无效。');

    const row = await queryOne(`
        INSERT INTO official_writing_documents
            (user_id, client_id, title, manual_title, state, summary, version, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?::jsonb, 1, NOW(), NOW())
        ON CONFLICT (user_id, client_id) DO UPDATE
        SET title = EXCLUDED.title,
            manual_title = EXCLUDED.manual_title,
            state = EXCLUDED.state,
            summary = EXCLUDED.summary,
            version = CASE
                WHEN official_writing_documents.title = EXCLUDED.title
                 AND official_writing_documents.manual_title = EXCLUDED.manual_title
                 AND official_writing_documents.state = EXCLUDED.state
                THEN official_writing_documents.version
                ELSE official_writing_documents.version + 1
            END,
            updated_at = CASE
                WHEN official_writing_documents.title = EXCLUDED.title
                 AND official_writing_documents.manual_title = EXCLUDED.manual_title
                 AND official_writing_documents.state = EXCLUDED.state
                THEN official_writing_documents.updated_at
                ELSE NOW()
            END
        WHERE official_writing_documents.deleted_at IS NULL
          AND (? = 0 OR official_writing_documents.version = ? OR
              (official_writing_documents.title = EXCLUDED.title
               AND official_writing_documents.manual_title = EXCLUDED.manual_title
               AND official_writing_documents.state = EXCLUDED.state))
        RETURNING client_id, title, manual_title, state, summary, artifact_id, version, created_at, updated_at
    `, [user.id, clientId, title, manualTitle, state, JSON.stringify(model.summary(JSON.parse(state))), Object.hasOwn(body, 'version') ? 1 : 0, clientVersion]);
    if (!row) {
        const existing = await queryOne('SELECT version FROM official_writing_documents WHERE user_id = ? AND client_id = ? AND deleted_at IS NULL', [user.id, clientId]);
        if (existing) throw documentError('公文已在其他窗口更新。请保留本页内容并复制正文，再刷新查看最新版本。', 409, 'OFFICIAL_WRITING_DOCUMENT_CONFLICT');
        throw documentError('公文不存在或已删除。', 404, 'OFFICIAL_WRITING_DOCUMENT_NOT_FOUND');
    }
    const publicDoc = toPublicDocument(row);
    // 当客户端显式传入了当前版本号且更新后版本未自增时，判定为内容无变动
    publicDoc.isModified = clientVersion > 0 ? Number(row.version) !== clientVersion : true;
    return publicDoc;
}

async function getOfficialWritingDocument(user, input) {
    if (!user?.id) throw documentError('未授权访问。', 401, 'AUTH_REQUIRED');
    const row = await library.getDocument(user.id, normalizeClientId(input));
    if (!row) throw documentError('公文不存在或已删除。', 404, 'OFFICIAL_WRITING_DOCUMENT_NOT_FOUND');
    return toPublicDocument(row);
}

async function listOfficialWritingDocumentPage(user, input = {}) {
    if (!user?.id) throw documentError('未授权访问。', 401, 'AUTH_REQUIRED');
    const limit = Math.min(50, Math.max(1, Number.parseInt(input.limit, 10) || 10));
    const page = Math.min(1000000, Math.max(1, Number.parseInt(input.page, 10) || 1));
    const docType = String(input.docType || '');
    if (docType && !model.TYPES.includes(docType)) throw documentError('公文文种无效。');
    const result = await library.pageDocuments(user.id, { page, limit, query: String(input.query || '').trim().slice(0, 120), docType, sort: String(input.sort || 'updated') });
    return { data: result.rows.map(toPublicDocument), total: result.total, page: result.page, limit };
}

async function ensureOfficialWritingExportArtifact(user, input, body = {}) {
    if (!user?.id) throw documentError('未授权访问。', 401, 'AUTH_REQUIRED');
    const version = Number(body.version);
    if (!Number.isSafeInteger(version) || version < 1) throw documentError('请先保存公文再导出。');
    const result = await library.saveExportArtifact(user, normalizeClientId(input), version);
    if (result.missing) throw documentError('公文不存在或已删除。', 404, 'OFFICIAL_WRITING_DOCUMENT_NOT_FOUND');
    if (result.conflict) throw documentError('公文已更新，请重新预览并导出。', 409, 'OFFICIAL_WRITING_DOCUMENT_CONFLICT');
    return result;
}

async function deleteOfficialWritingDocument(user, clientIdInput) {
    if (!user?.id) throw documentError('未授权访问。', 401, 'AUTH_REQUIRED');
    const clientId = normalizeClientId(clientIdInput);
    return (await execute(`
        UPDATE official_writing_documents
        SET deleted_at = NOW(), updated_at = NOW()
        WHERE user_id = ? AND client_id = ? AND deleted_at IS NULL
    `, [user.id, clientId])) > 0;
}

module.exports = {
    MAX_STATE_BYTES,
    ensureOfficialWritingExportArtifact,
    getOfficialWritingDocument,
    listOfficialWritingDocumentPage,
    deleteOfficialWritingDocument,
    listOfficialWritingDocuments,
    normalizeClientId,
    normalizeState,
    saveOfficialWritingDocument,
    toPublicDocument
};
