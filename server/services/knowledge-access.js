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

function buildAllowedTargetSql(alias, user) {
    const normalized = normalizeKnowledgeUser(user);
    return {
        sql: `(
            ${alias}.scope = 'shared'
            AND (
                ${normalized.isAdmin ? '1 = 1' : `(
                    TRIM(COALESCE(${alias}.allowed_units, '')) = ''
                    AND TRIM(COALESCE(${alias}.allowed_user_ids, '')) = ''
                )`}
                OR instr(',' || replace(COALESCE(${alias}.allowed_units, ''), ' ', '') || ',', ',' || ? || ',') > 0
                OR instr(',' || replace(COALESCE(${alias}.allowed_user_ids, ''), ' ', '') || ',', ',' || ? || ',') > 0
            )
        )`,
        params: [normalized.unit, normalized.id]
    };
}

function buildCollectionAccessFilter(user, alias = 'c') {
    const normalized = normalizeKnowledgeUser(user);
    const shared = buildAllowedTargetSql(alias, normalized);
    return {
        sql: `(${alias}.user_id = ? OR ${shared.sql})`,
        params: [normalized.id, ...shared.params]
    };
}

function buildDocumentAccessFilter(user, docAlias = 'd', collectionAlias = 'c') {
    const normalized = normalizeKnowledgeUser(user);
    const shared = buildAllowedTargetSql(collectionAlias, normalized);
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
    const allowedUnits = String(resource.allowed_units || '').split(',').map(item => item.trim()).filter(Boolean);
    const allowedUserIds = String(resource.allowed_user_ids || '').split(',').map(Number).filter(Number.isSafeInteger);
    if (!allowedUnits.length && !allowedUserIds.length) return true;
    return (normalized.unit && allowedUnits.includes(normalized.unit)) || allowedUserIds.includes(normalized.id);
}

module.exports = {
    buildCollectionAccessFilter,
    buildDocumentAccessFilter,
    canReadKnowledgeResource,
    normalizeKnowledgeUser
};
