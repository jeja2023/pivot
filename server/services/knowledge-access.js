const { isAdmin } = require('../permissions');

function normalizeKnowledgeUser(userOrId) {
    if (userOrId && typeof userOrId === 'object') {
        const id = Number(userOrId.id);
        return {
            id: Number.isSafeInteger(id) && id > 0 ? id : null,
            unit: String(userOrId.unit || '').trim(),
            isAdmin: isAdmin(userOrId)
        };
    }
    const id = Number(userOrId);
    return {
        id: Number.isSafeInteger(id) && id > 0 ? id : null,
        unit: '',
        isAdmin: false
    };
}

function buildAllowedUnitSql(alias, user) {
    const normalized = normalizeKnowledgeUser(user);
    return {
        sql: `(
            ${alias}.scope = 'shared'
            AND (
                ${normalized.isAdmin ? '1 = 1' : `TRIM(COALESCE(${alias}.allowed_units, '')) = ''`}
                OR instr(',' || replace(COALESCE(${alias}.allowed_units, ''), ' ', '') || ',', ',' || ? || ',') > 0
            )
        )`,
        params: normalized.isAdmin ? [normalized.unit] : [normalized.unit]
    };
}

function buildCollectionAccessFilter(user, alias = 'c') {
    const normalized = normalizeKnowledgeUser(user);
    const shared = buildAllowedUnitSql(alias, normalized);
    return {
        sql: `(${alias}.user_id = ? OR ${shared.sql})`,
        params: [normalized.id, ...shared.params]
    };
}

function buildDocumentAccessFilter(user, docAlias = 'd', collectionAlias = 'c') {
    const normalized = normalizeKnowledgeUser(user);
    const shared = buildAllowedUnitSql(collectionAlias, normalized);
    return {
        sql: `(${docAlias}.user_id = ? OR (${docAlias}.collection_id IS NOT NULL AND ${shared.sql}))`,
        params: [normalized.id, ...shared.params]
    };
}

function canReadKnowledgeResource(resource, user) {
    const normalized = normalizeKnowledgeUser(user);
    if (!resource || resource.deleted_at) return false;
    if (Number(resource.user_id) === normalized.id) return true;
    if (String(resource.scope || 'personal').toLowerCase() !== 'shared') return false;
    if (normalized.isAdmin) return true;
    const allowed = String(resource.allowed_units || '').split(',').map(item => item.trim()).filter(Boolean);
    return !allowed.length || (normalized.unit && allowed.includes(normalized.unit));
}

module.exports = {
    buildCollectionAccessFilter,
    buildDocumentAccessFilter,
    canReadKnowledgeResource,
    normalizeKnowledgeUser
};
