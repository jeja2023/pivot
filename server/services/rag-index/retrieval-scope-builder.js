'use strict';

const { buildDocumentAccessFilter } = require('../knowledge-access');

// 将检索过滤、目录权限和产品文档元数据的关联集中起来；调用端只须传入
// 已标准化的 scope，从而避免每种召回途径出现不同的访问控制条件。
function createRetrievalScopeBuilder(normalizeRetrievalScope) {
    return function buildRetrievalScopeSql(scope, docAlias = 'd', user = null) {
        const normalized = normalizeRetrievalScope(scope);
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

module.exports = { createRetrievalScopeBuilder };
