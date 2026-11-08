'use strict';

const { query } = require('../db/client');
const { canAccessSharedResource, exactCsvTokenSql } = require('../services/unit-visibility');
const TABLES = new Set(['analysis_saved_views', 'analysis_dashboards', 'analysis_data_models', 'analysis_metric_definitions']);

async function listVisible(table, user, { datasetId = '', limit = 100 } = {}) {
    if (!TABLES.has(table)) throw new Error('分析资产类型无效。');
    const size = Math.min(Math.max(Number.parseInt(limit, 10) || 100, 1), 200);
    const unit = String(user?.unit || '').trim();
    const params = [user.id, unit, String(user.id)];
    if (datasetId) params.push(datasetId);
    if (table === 'analysis_data_models') params.push(user.id);
    const predicate = `deleted_at IS NULL AND (user_id IS NULL OR user_id = ? OR (
        LOWER(TRIM(COALESCE(scope, 'personal'))) = 'shared' AND (
            (TRIM(COALESCE(allowed_units, '')) = '' AND TRIM(COALESCE(allowed_user_ids, '')) = '')
            OR ${exactCsvTokenSql('allowed_units')} OR ${exactCsvTokenSql('allowed_user_ids')}
        ))) ${datasetId ? 'AND dataset_id = ?' : ''} ${table === 'analysis_metric_definitions' ? 'AND model_id IS NULL' : ''}
        ${table === 'analysis_data_models' ? "AND (model_kind = 'exploration' OR published_version IS NOT NULL OR user_id = ?)" : ''}`;
    const result = []; let offset = 0;
    // SQL 先过滤权限再分页；统一判定仍保留，用于处理历史白名单格式差异。
    while (result.length < size) {
        const rows = await query(`SELECT * FROM ${table} WHERE ${predicate} ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`, [...params, size, offset]);
        result.push(...rows.filter(row => canAccessSharedResource(row, user, false)));
        if (rows.length < size) break;
        offset += rows.length;
    }
    const visible = result.slice(0, size);
    await require('../services/data-analysis/bi/security-journal').assertAccess([{ kind: 'principal', id: String(user.id) }, ...visible.map(row => ({ kind: table === 'analysis_data_models' ? 'model' : 'asset', id: table === 'analysis_data_models' ? row.id : `${table}:${row.id}` }))]);
    return visible;
}

module.exports = { listVisible };
