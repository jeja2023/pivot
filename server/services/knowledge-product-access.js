'use strict';

const { query } = require('../db/client');
const { isSuperAdmin } = require('../permissions');

function normalizeId(value) {
    const id = Number.parseInt(value, 10);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
}

async function getProductDocumentsForUser(documentIds = [], user) {
    const ids = [...new Set((Array.isArray(documentIds) ? documentIds : [documentIds])
        .map(normalizeId).filter(Boolean))].slice(0, 500);
    if (!ids.length || !user?.id) return new Map();
    const ownerClause = isSuperAdmin(user) ? 'TRUE' : 'kd.owner_user_id = ?';
    const params = [...ids, ...(isSuperAdmin(user) ? [] : [user.id])];
    const rows = await query(`
        SELECT kd.*, kc.scope AS collection_scope, kc.allowed_units AS collection_allowed_units,
               kc.allowed_user_ids AS collection_allowed_user_ids
        FROM knowledge_documents kd
        LEFT JOIN knowledge_collections kc ON kc.id = kd.collection_id AND kc.deleted_at IS NULL
        WHERE kd.id IN (${ids.map(() => '?').join(',')}) AND kd.deleted_at IS NULL AND ${ownerClause}
    `, params);
    return new Map(rows.map(row => [Number(row.id), row]));
}

module.exports = { getProductDocumentsForUser };
