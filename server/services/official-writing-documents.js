const { query, queryOne, execute } = require('../db/client');

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
        serialized = JSON.stringify(value);
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
        state: parseState(row.state)
    };
}

async function listOfficialWritingDocuments(user) {
    if (!user?.id) throw documentError('未授权访问。', 401, 'AUTH_REQUIRED');
    const rows = await query(`
        SELECT client_id, title, manual_title, state, version, created_at, updated_at
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

    const row = await queryOne(`
        INSERT INTO official_writing_documents
            (user_id, client_id, title, manual_title, state, version, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 1, NOW(), NOW())
        ON CONFLICT (user_id, client_id) DO UPDATE
        SET title = EXCLUDED.title,
            manual_title = EXCLUDED.manual_title,
            state = EXCLUDED.state,
            version = official_writing_documents.version + 1,
            updated_at = NOW()
        WHERE official_writing_documents.deleted_at IS NULL
        RETURNING client_id, title, manual_title, state, version, created_at, updated_at
    `, [user.id, clientId, title, manualTitle, state]);
    if (!row) {
        throw documentError('公文不存在或已删除。', 404, 'OFFICIAL_WRITING_DOCUMENT_NOT_FOUND');
    }
    return toPublicDocument(row);
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
    deleteOfficialWritingDocument,
    listOfficialWritingDocuments,
    normalizeClientId,
    normalizeState,
    saveOfficialWritingDocument,
    toPublicDocument
};
