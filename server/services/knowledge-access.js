const { isSuperAdmin } = require('../permissions');

function normalizeKnowledgeUser(userOrId) {
    if (userOrId && typeof userOrId === 'object') {
        const id = Number(userOrId.id);
        return {
            id: Number.isSafeInteger(id) && id > 0 ? id : null,
            unit: String(userOrId.unit || '').trim(),
            role: String(userOrId.role || 'user').trim() || 'user',
            isSuperAdmin: isSuperAdmin(userOrId)
        };
    }
    const id = Number(userOrId);
    return {
        id: Number.isSafeInteger(id) && id > 0 ? id : null,
        unit: '',
        role: 'user',
        isSuperAdmin: false
    };
}

function buildCollectionAccessFilter(user, alias = 'c') {
    const normalized = normalizeKnowledgeUser(user);
    if (normalized.isSuperAdmin) return { sql: '1 = 1', params: [] };
    return {
        sql: `${alias}.user_id = ?`,
        params: [normalized.id]
    };
}

function buildDocumentAccessFilter(user, docAlias = 'd', _collectionAlias = 'c') {
    const normalized = normalizeKnowledgeUser(user);
    if (normalized.isSuperAdmin) return { sql: '1 = 1', params: [] };
    return {
        sql: `${docAlias}.user_id = ?`,
        params: [normalized.id]
    };
}

function canReadKnowledgeResource(resource, user) {
    const normalized = normalizeKnowledgeUser(user);
    if (!resource || resource.deleted_at) return false;
    return normalized.isSuperAdmin || Number(resource.user_id) === normalized.id;
}

module.exports = {
    buildCollectionAccessFilter,
    buildDocumentAccessFilter,
    canReadKnowledgeResource,
    normalizeKnowledgeUser
};
