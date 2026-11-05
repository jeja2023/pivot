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
    const predicate = `deleted_at IS NULL AND (user_id IS NULL OR user_id = ? OR (
        LOWER(TRIM(COALESCE(scope, 'personal'))) = 'shared' AND (
            (TRIM(COALESCE(allowed_units, '')) = '' AND TRIM(COALESCE(allowed_user_ids, '')) = '')
            OR ${exactCsvTokenSql('allowed_units')} OR ${exactCsvTokenSql('allowed_user_ids')}
        ))) ${datasetId ? 'AND dataset_id = ?' : ''}`;
    const result = []; let offset = 0;
    // SQL 先过滤权限再分页；统一判定仍保留，用于处理历史白名单格式差异。
    while (result.length < size) {
        const rows = await query(`SELECT * FROM ${table} WHERE ${predicate} ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`, [...params, size, offset]);
        result.push(...rows.filter(row => canAccessSharedResource(row, user, false)));
        if (rows.length < size) break;
        offset += rows.length;
    }
    return result.slice(0, size);
}

module.exports = { listVisible };
