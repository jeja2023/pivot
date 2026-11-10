'use strict';

const { query } = require('../db/client');
const { canAccessSharedResource } = require('../services/unit-visibility');
const { biError } = require('../services/data-analysis/bi/errors');

const HEADERS = 'm.id,m.user_id,m.name,m.description,m.scope,m.allowed_units,m.allowed_user_ids,m.version,m.model_kind,m.published_version,m.archived_at,m.business_owner,m.maintenance_contact,m.created_at,m.updated_at,m.deleted_at';

function visibleToActor(alias) {
    return `(${alias}.user_id IS NULL OR ${alias}.user_id=actor.id OR (LOWER(TRIM(COALESCE(${alias}.scope,'personal')))='shared' AND (
        (TRIM(COALESCE(${alias}.allowed_units,''))='' AND TRIM(COALESCE(${alias}.allowed_user_ids,''))='')
        OR (actor.unit<>'' AND actor.unit=ANY(ARRAY(SELECT btrim(token) FROM unnest(string_to_array(COALESCE(${alias}.allowed_units,''),',')) token)))
        OR actor.id::text=ANY(ARRAY(SELECT btrim(token) FROM unnest(string_to_array(COALESCE(${alias}.allowed_user_ids,''),',')) token)))))`;
}

const visibleModels = `WITH actor AS (SELECT ?::bigint AS id,?::text AS unit), visible AS (
    SELECT ${HEADERS},m.updated_at::text AS catalog_revision_at,u.username AS owner_name,
        jsonb_build_object('nodes',COALESCE(d.definition->'nodes','[]'),'relations',COALESCE(d.definition->'relations','[]')) AS graph_json,
        b.manifest_id,b.revision AS binding_revision,b.check_id,b.data_state,b.last_refresh_error,s.manifest_json->'members' AS members_json
    FROM analysis_data_models m CROSS JOIN actor
    LEFT JOIN users u ON u.id=m.user_id
    LEFT JOIN analysis_data_model_versions v ON v.model_id=m.id AND v.version=m.published_version
    CROSS JOIN LATERAL (SELECT CASE WHEN m.user_id=actor.id THEN m.definition_json ELSE v.definition_json END AS definition) d
    LEFT JOIN analysis_model_data_bindings b ON b.model_id=m.id AND b.published_version=m.published_version
    LEFT JOIN analysis_source_manifests s ON s.id=b.manifest_id
    WHERE m.deleted_at IS NULL AND ${visibleToActor('m')}
    AND (m.model_kind='exploration' OR m.published_version IS NOT NULL OR m.user_id=actor.id))`;

async function list(user, limit, client = { query }) {
    const size = Math.min(200, Math.max(1, Number.parseInt(limit, 10) || 100));
    return client.query(`${visibleModels} SELECT * FROM visible ORDER BY updated_at DESC,id DESC LIMIT ?`, [user.id, String(user.unit || '').trim(), size]);
}

async function page(user, options, client = { query }) {
    const statement = `${visibleModels}, states AS (
        SELECT v.*,CASE WHEN model_kind='exploration' THEN 'exploration' WHEN archived_at IS NOT NULL THEN 'archived' WHEN published_version IS NOT NULL THEN 'published' ELSE 'draft' END AS computed_lifecycle,
        CASE WHEN model_kind<>'production' THEN NULL WHEN EXISTS(
            SELECT 1 FROM jsonb_array_elements(v.graph_json->'nodes') AS nodes(node)
            LEFT JOIN analysis_datasets src ON src.id=node->>'datasetId'
            WHERE src.id IS NULL OR src.deleted_at IS NOT NULL OR src.status<>'ready' OR NOT ${visibleToActor('src')}
            OR EXISTS(SELECT 1 FROM (
                SELECT jsonb_array_elements_text(COALESCE(node->'grainKeys','[]')) AS key
                UNION SELECT pair->>'leftFieldKey' FROM jsonb_array_elements(v.graph_json->'relations') rel CROSS JOIN LATERAL jsonb_array_elements(rel->'keyPairs') pair WHERE rel->>'leftNodeId'=node->>'id'
                UNION SELECT pair->>'rightFieldKey' FROM jsonb_array_elements(v.graph_json->'relations') rel CROSS JOIN LATERAL jsonb_array_elements(rel->'keyPairs') pair WHERE rel->>'rightNodeId'=node->>'id'
            ) required WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(src.columns_json::jsonb) col WHERE col->>'key'=required.key)
                OR (src.user_id IS DISTINCT FROM actor.id AND EXISTS(SELECT 1 FROM analysis_field_governance f WHERE f.dataset_id=src.id AND f.field_key=required.key AND f.status='active' AND f.sensitivity IN ('restricted','confidential')))))
            OR v.data_state='source_unavailable' THEN 'source_unavailable'
        WHEN v.data_state='refresh_failed' THEN 'refresh_failed'
        WHEN v.data_state='pending' OR EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(v.members_json,'[]')) member
            WHERE member->>'sourceRevision' IS DISTINCT FROM (SELECT src.source_version::text FROM jsonb_array_elements(v.graph_json->'nodes') node JOIN analysis_datasets src ON src.id=node->>'datasetId' WHERE node->>'id'=member->>'nodeId' LIMIT 1)) THEN 'pending'
        ELSE 'available' END AS computed_availability
        FROM visible v CROSS JOIN actor), filtered AS (
        SELECT states.* FROM states CROSS JOIN actor WHERE (?='all' OR (?='mine' AND user_id=actor.id) OR (?='shared' AND user_id IS DISTINCT FROM actor.id))
            AND (?='all' OR computed_lifecycle=?) AND (?='all' OR computed_availability=?) AND strpos(lower(name||' '||COALESCE(description,'')),lower(?))>0)
        SELECT (SELECT COUNT(*) FROM filtered) AS total,COALESCE(jsonb_agg(to_jsonb(selected) ORDER BY selected.updated_at DESC,selected.id DESC),'[]'::jsonb) AS rows
        FROM (SELECT * FROM filtered ORDER BY updated_at DESC,id DESC LIMIT ? OFFSET ?) selected`;
    const result = (await client.query(statement, [user.id, String(user.unit || '').trim(), options.ownership, options.ownership, options.ownership,
        options.lifecycle, options.lifecycle, options.availability, options.availability, options.search, options.limit, (options.page - 1) * options.limit]))[0];
    return { rows: result.rows, total: Number(result.total), page: options.page, limit: options.limit };
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
    const rows = await trx.query(`SELECT ${HEADERS},m.updated_at::text AS catalog_revision_at,r.revision AS authorization_revision FROM analysis_data_models m
        LEFT JOIN analysis_authorization_revisions r ON r.resource_kind='model' AND r.resource_id=m.id WHERE m.id=ANY(?::text[])`, [ids]);
    const current = new Map(rows.map(row => [row.id, row]));
    for (const old of snapshots) {
        const row = current.get(old.id);
        if (!row || !canAccessSharedResource(row, user) || (row.model_kind === 'production' && Number(row.user_id) !== Number(user.id) && !row.published_version)) throw biError('ANALYSIS_MODEL_NOT_FOUND', '模型目录权限已变化，请重新加载。', 404);
        if (row.model_kind === 'production' && !/^[1-9]\d*$/.test(String(row.authorization_revision))) throw biError('ANALYSIS_AUTHORIZATION_UNREADY', '模型授权状态不完整，请联系维护者核对后重试。', 503);
        if (Number(row.version) !== Number(old.version) || Number(row.user_id) !== Number(old.user_id) || Number(row.published_version) !== Number(old.published_version) || row.catalog_revision_at !== old.catalog_revision_at) throw biError('ANALYSIS_MODEL_VERSION_CONFLICT', '模型目录已变化，请重新加载。', 409);
    }
}

module.exports = { list, page, sources, confirm };
