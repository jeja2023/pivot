const { isAdmin } = require('../permissions');
const { exactCsvTokenSql } = require('./unit-visibility');

function normalizeKnowledgeUser(userOrId) {
    if (userOrId && typeof userOrId === 'object') {
        const id = Number(userOrId.id);
        return {
            id: Number.isSafeInteger(id) && id > 0 ? id : null,
            unit: String(userOrId.unit || '').trim(),
            role: String(userOrId.role || 'user').trim() || 'user',
            isAdmin: isAdmin(userOrId)
        };
    }
    const id = Number(userOrId);
    return {
        id: Number.isSafeInteger(id) && id > 0 ? id : null,
        unit: '',
        role: 'user',
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
                OR ${exactCsvTokenSql(`${alias}.allowed_units`)}
                OR ${exactCsvTokenSql(`${alias}.allowed_user_ids`)}
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
    const productPermission = normalized.isAdmin
        ? '1 = 1'
        : `(
            ${docAlias}.product_document_id IS NOT NULL
            AND EXISTS (
                SELECT 1
                FROM knowledge_permissions permission_grant
                WHERE permission_grant.resource_type = 'document'
                  AND permission_grant.resource_id = ${docAlias}.product_document_id
                  AND permission_grant.permission IN ('viewer', 'commenter', 'editor', 'manager', 'owner')
                  AND (permission_grant.expires_at IS NULL OR permission_grant.expires_at > now() AT TIME ZONE 'Asia/Shanghai')
                  AND (
                    (permission_grant.principal_type = 'user' AND permission_grant.principal_id = ?)
                    OR (permission_grant.principal_type = 'unit' AND permission_grant.principal_id = ?)
                    OR (permission_grant.principal_type = 'role' AND permission_grant.principal_id = ?)
                  )
            )
        )`;
    const productSteward = normalized.isAdmin
        ? '1 = 1'
        : `(
            ${docAlias}.product_document_id IS NOT NULL
            AND EXISTS (
                SELECT 1
                FROM knowledge_documents stewardship_document
                WHERE stewardship_document.id = ${docAlias}.product_document_id
                  AND stewardship_document.deleted_at IS NULL
                  AND (stewardship_document.content_owner_user_id = ? OR stewardship_document.verifier_user_id = ?)
            )
        )`;
    return {
        sql: `(${docAlias}.user_id = ? OR (${docAlias}.collection_id IS NOT NULL AND ${shared.sql}) OR ${productPermission} OR ${productSteward})`,
        params: normalized.isAdmin
            ? [normalized.id, ...shared.params]
            : [normalized.id, ...shared.params, normalized.id, normalized.unit, normalized.role, normalized.id, normalized.id]
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
