'use strict';

const jobs = require('./analysis-model-jobs');
const { canAccessSharedResource } = require('../services/unit-visibility');
const { biError } = require('../services/data-analysis/bi/errors');

async function job(trx, previous, nodeCount) {
    const latest = await jobs.get(previous.user_id, previous.id, trx);
    // 排队与运行状态允许在一次轮询内向前推进；只有实际携带的完成结果必须保持同一对象与清单。
    if (!latest || previous.status === 'succeeded' && (latest.status !== 'succeeded' || latest.result_object_id !== previous.result_object_id || latest.manifest_id !== previous.manifest_id)
        || Boolean(latest.result_metadata_json?.resultExpired) !== Boolean(previous.result_metadata_json?.resultExpired)) throw biError('ANALYSIS_MODEL_RESULT_UNAVAILABLE', '任务结果已变化，请重新读取运行结果。', 409);
    if (previous.manifest_id) {
        const state = await trx.queryOne("SELECT COUNT(*) AS total,COUNT(*) FILTER(WHERE o.state='ready') AS ready FROM analysis_source_manifest_members m JOIN analysis_data_objects o ON o.id=m.object_id WHERE m.manifest_id=?", [previous.manifest_id]);
        if (Number(state.total) !== nodeCount || Number(state.ready) !== Number(state.total)) throw biError('ANALYSIS_MODEL_SOURCE_UNAVAILABLE', '来源完整性异常，请联系维护者。', 409);
    }
    if (previous.result_object_id && !previous.result_metadata_json?.resultExpired) {
        const result = await trx.queryOne("SELECT id FROM analysis_data_objects WHERE id=? AND state='ready'", [previous.result_object_id]);
        if (!result) throw biError('ANALYSIS_MODEL_RESULT_UNAVAILABLE', '运行结果已不可用，请重新计算。', 409);
    }
}

async function view(trx, user, previous) {
    const row = await trx.queryOne('SELECT * FROM analysis_saved_views WHERE id=? AND deleted_at IS NULL FOR SHARE', [previous.id]);
    await require('../services/data-analysis/bi/security-journal').assertResources(trx, [{ kind: 'asset', id: `analysis_saved_views:${previous.id}` }]);
    if (!row || !canAccessSharedResource(row, user) || Number(row.version) !== Number(previous.version) || row.model_id !== previous.model_id) throw biError('ANALYSIS_MODEL_VIEW_NOT_FOUND', '分析视图已变化或无权访问，请重新加载。', 404);
}

async function item(trx, user, previous) {
    const dashboard = await trx.queryOne('SELECT * FROM analysis_dashboards WHERE id=? AND deleted_at IS NULL FOR SHARE', [previous.dashboard_id]);
    const row = await trx.queryOne('SELECT * FROM analysis_dashboard_items WHERE id=? FOR SHARE', [previous.id]);
    await require('../services/data-analysis/bi/security-journal').assertResources(trx, [{ kind: 'asset', id: `analysis_dashboards:${previous.dashboard_id}` }]);
    if (!dashboard || !canAccessSharedResource(dashboard, user) || !row || row.dashboard_id !== dashboard.id || Number(row.version) !== Number(previous.version) || row.model_id !== previous.model_id) throw biError('ANALYSIS_MODEL_DASHBOARD_NOT_FOUND', '仪表盘组件已变化或无权访问，请重新加载。', 404);
}

module.exports = { job, view, item };
