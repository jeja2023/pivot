'use strict';

const { buildDocumentAccessFilter } = require('../knowledge-access');

function normalizeScopeIdList(value, max = 50) {
    const values = Array.isArray(value) ? value : [value];
    return [...new Set(values
        .map(item => Number.parseInt(item, 10))
        .filter(item => Number.isSafeInteger(item) && item > 0))]
        .slice(0, max);
}

function normalizeScopeTagList(value, max = 20) {
    const values = Array.isArray(value) ? value : [value];
    return [...new Set(values
        .flatMap(item => String(item || '').split(/[,，;；\s\n]+/))
        .map(item => item.trim().replace(/^#+/, '').replace(/\s+/g, ' ').slice(0, 40))
        .filter(Boolean))]
        .slice(0, max);
}

function normalizeScopeEnumList(value, allowed, max = 20) {
    const values = Array.isArray(value) ? value : [value];
    return [...new Set(values
        .flatMap(item => String(item || '').split(/[,，;；\s\n]+/))
        .map(item => item.trim().toLowerCase())
        .filter(item => allowed.has(item)))]
        .slice(0, max);
}

function normalizeScopeDate(value) {
    const text = String(value || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?$/.test(text)) return '';
    const date = new Date(text.replace(' ', 'T'));
    return Number.isNaN(date.getTime()) ? '' : text;
}

function normalizeRetrievalScope(scope = {}) {
    const raw = scope && typeof scope === 'object' ? scope : {};
    const filters = raw.filters && typeof raw.filters === 'object' ? raw.filters : raw;
    const collectionIds = normalizeScopeIdList(raw.collectionIds ?? raw.collectionId);
    const tagNames = normalizeScopeTagList(raw.tagNames ?? raw.tagName ?? raw.tag);
    const verifiedStatuses = normalizeScopeEnumList(filters.verifiedStatus ?? filters.verifiedStatuses ?? (filters.verified === true ? 'verified' : ''), new Set(['verified', 'unverified', 'expired']), 3);
    const lifecycleStatuses = normalizeScopeEnumList(filters.lifecycleStatus ?? filters.lifecycleStatuses, new Set(['draft', 'review', 'published', 'expired', 'archived']), 5);
    const sourceKinds = normalizeScopeEnumList(filters.sourceKind ?? filters.sourceKinds, new Set(['upload', 'local_dir', 'lan_http', 'database', 'internal_api', 'manual']), 6);
    const ownerUnits = normalizeScopeTagList(filters.ownerUnit ?? filters.ownerUnits, 20);
    const updatedAfter = normalizeScopeDate(filters.updatedAfter);
    const parts = [];
    if (collectionIds.length) parts.push(`collections:${collectionIds.join(',')}`);
    if (tagNames.length) parts.push(`tags:${tagNames.join(',')}`);
    if (verifiedStatuses.length) parts.push(`verified:${verifiedStatuses.join(',')}`);
    if (lifecycleStatuses.length) parts.push(`lifecycle:${lifecycleStatuses.join(',')}`);
    if (sourceKinds.length) parts.push(`sources:${sourceKinds.join(',')}`);
    if (ownerUnits.length) parts.push(`owners:${ownerUnits.join(',')}`);
    if (updatedAfter) parts.push(`updated:${updatedAfter}`);
    return {
        collectionIds,
        tagNames,
        verifiedStatuses,
        lifecycleStatuses,
        sourceKinds,
        ownerUnits,
        updatedAfter,
        cacheKey: parts.length ? parts.join(';') : 'all'
    };
}

// 将检索过滤、目录权限和产品文档元数据的关联集中起来；调用端只须传入
// 已标准化的 scope，从而避免每种召回途径出现不同的访问控制条件。
function createRetrievalScopeBuilder(scopeNormalizer = normalizeRetrievalScope) {
    return function buildRetrievalScopeSql(scope, docAlias = 'd', user = null) {
        const normalized = scopeNormalizer(scope);
        const clauses = [];
        const params = [];
        if (normalized.collectionIds.length) {
            clauses.push(`${docAlias}.collection_id IN (${normalized.collectionIds.map(() => '?').join(',')})`);
            params.push(...normalized.collectionIds);
        }
        if (normalized.tagNames.length) {
            clauses.push(`EXISTS (
                SELECT 1 FROM knowledge_doc_tags tag_scope
                WHERE tag_scope.doc_id = ${docAlias}.id
                  AND tag_scope.user_id = ${docAlias}.user_id
                  AND tag_scope.tag IN (${normalized.tagNames.map(() => '?').join(',')})
            )`);
            params.push(...normalized.tagNames);
        }
        if (normalized.verifiedStatuses.length) {
            clauses.push(`kd_product.verified_status IN (${normalized.verifiedStatuses.map(() => '?').join(',')})`);
            params.push(...normalized.verifiedStatuses);
        }
        if (normalized.lifecycleStatuses.length) {
            clauses.push(`kd_product.lifecycle_status IN (${normalized.lifecycleStatuses.map(() => '?').join(',')})`);
            params.push(...normalized.lifecycleStatuses);
        }
        if (normalized.sourceKinds.length) {
            clauses.push(`ks_product.kind IN (${normalized.sourceKinds.map(() => '?').join(',')})`);
            params.push(...normalized.sourceKinds);
        }
        if (normalized.ownerUnits.length) {
            clauses.push(`owner_user.unit IN (${normalized.ownerUnits.map(() => '?').join(',')})`);
            params.push(...normalized.ownerUnits);
        }
        if (normalized.updatedAfter) {
            clauses.push(`kd_product.updated_at >= ?`);
            params.push(normalized.updatedAfter);
        }
        const access = user ? buildDocumentAccessFilter(user, docAlias, 'c_access') : null;
        return {
            sql: clauses.length ? ` AND ${clauses.join(' AND ')}` : '',
            params,
            normalized,
            accessSql: access ? ` AND ${access.sql}` : '',
            accessParams: access ? access.params : [],
            accessJoin: `
                LEFT JOIN knowledge_collections c_access ON c_access.id = ${docAlias}.collection_id AND c_access.deleted_at IS NULL
                LEFT JOIN knowledge_documents kd_product ON kd_product.id = ${docAlias}.product_document_id AND kd_product.deleted_at IS NULL
                LEFT JOIN knowledge_sources ks_product ON ks_product.id = kd_product.source_id AND ks_product.deleted_at IS NULL
                LEFT JOIN users owner_user ON owner_user.id = kd_product.owner_user_id AND owner_user.deleted_at IS NULL
            `
        };
    };
}

const buildRetrievalScopeSql = createRetrievalScopeBuilder(normalizeRetrievalScope);

module.exports = {
    buildRetrievalScopeSql,
    normalizeRetrievalScope
};
