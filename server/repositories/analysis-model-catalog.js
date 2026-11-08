'use strict';

const { query } = require('../db/client');
const { exactCsvTokenSql, canAccessSharedResource } = require('../services/unit-visibility');
const { biError } = require('../services/data-analysis/bi/errors');

const HEADERS = 'm.id,m.user_id,m.name,m.description,m.scope,m.allowed_units,m.allowed_user_ids,m.version,m.model_kind,m.published_version,m.archived_at,m.business_owner,m.maintenance_contact,m.created_at,m.updated_at,m.deleted_at';

async function list(user, limit, client = { query }) {
    const size = Math.min(200, Math.max(1, Number.parseInt(limit, 10) || 100));
    return client.query(`SELECT ${HEADERS}, u.username AS owner_name,
        jsonb_build_object('nodes',COALESCE(d.definition->'nodes','[]'),'relations',COALESCE(d.definition->'relations','[]')) AS graph_json,
        b.manifest_id,b.revision AS binding_revision,b.check_id,b.data_state,b.last_refresh_error,s.manifest_json->'members' AS members_json
        FROM analysis_data_models m
        LEFT JOIN users u ON u.id=m.user_id
        LEFT JOIN analysis_data_model_versions v ON v.model_id=m.id AND v.version=m.published_version
        CROSS JOIN LATERAL (SELECT CASE WHEN m.user_id=? THEN m.definition_json ELSE v.definition_json END AS definition) d
        LEFT JOIN analysis_model_data_bindings b ON b.model_id=m.id AND b.published_version=m.published_version
        LEFT JOIN analysis_source_manifests s ON s.id=b.manifest_id
        WHERE m.deleted_at IS NULL AND (m.user_id IS NULL OR m.user_id=? OR (LOWER(TRIM(COALESCE(m.scope,'personal')))='shared' AND (
            (TRIM(COALESCE(m.allowed_units,''))='' AND TRIM(COALESCE(m.allowed_user_ids,''))='') OR ${exactCsvTokenSql('m.allowed_units')} OR ${exactCsvTokenSql('m.allowed_user_ids')})))
        AND (m.model_kind='exploration' OR m.published_version IS NOT NULL OR m.user_id=?)
        ORDER BY m.updated_at DESC,m.id DESC LIMIT ?`, [user.id, user.id, String(user.unit || '').trim(), String(user.id), user.id, size]);
}

async function sources(ids) {
    if (!ids.length) return [];
    return query(`SELECT d.id,d.user_id,d.scope,d.allowed_units,d.allowed_user_ids,d.deleted_at,d.status,d.source_version,
        ARRAY(SELECT col->>'key' FROM jsonb_array_elements(d.columns_json::jsonb) col) AS column_keys,
        ARRAY(SELECT f.field_key FROM analysis_field_governance f WHERE f.dataset_id=d.id AND f.status='active' AND f.sensitivity IN ('restricted','confidential')) AS restricted_keys
        FROM analysis_datasets d WHERE d.id=ANY(?::text[])`, [ids]);
}

async function confirm(trx, user, snapshots) {
    const ids = snapshots.map(row => row.id);
    await require('../services/data-analysis/bi/security-journal').assertResources(trx, snapshots.map(row => ({ kind: 'model', id: row.id })));
    const rows = await trx.query(`SELECT ${HEADERS},r.revision AS authorization_revision FROM analysis_data_models m
        LEFT JOIN analysis_authorization_revisions r ON r.resource_kind='model' AND r.resource_id=m.id WHERE m.id=ANY(?::text[])`, [ids]);
    const current = new Map(rows.map(row => [row.id, row]));
    for (const old of snapshots) {
        const row = current.get(old.id);
        if (!row || !canAccessSharedResource(row, user) || (row.model_kind === 'production' && Number(row.user_id) !== Number(user.id) && !row.published_version)) throw biError('ANALYSIS_MODEL_NOT_FOUND', '模型目录权限已变化，请重新加载。', 404);
        if (row.model_kind === 'production' && !/^[1-9]\d*$/.test(String(row.authorization_revision))) throw biError('ANALYSIS_AUTHORIZATION_UNREADY', '模型授权状态不完整，请联系维护者核对后重试。', 503);
        if (Number(row.version) !== Number(old.version) || Number(row.user_id) !== Number(old.user_id) || Number(row.published_version) !== Number(old.published_version) || String(row.updated_at) !== String(old.updated_at)) throw biError('ANALYSIS_MODEL_VERSION_CONFLICT', '模型目录已变化，请重新加载。', 409);
    }
}

module.exports = { list, sources, confirm };
