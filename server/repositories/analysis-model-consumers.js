'use strict';

const { query, queryOne, transaction } = require('../db/client');
const { audit } = require('./analysis-production-models');
const { biError } = require('../services/data-analysis/bi/errors');

async function dependencies(modelId) {
    const views = await query("SELECT * FROM analysis_saved_views WHERE model_id=? AND source_type='model' AND deleted_at IS NULL ORDER BY name,id", [modelId]);
    const items = await query(`SELECT i.*,d.name AS dashboard_name,d.scope,d.allowed_units,d.allowed_user_ids,d.deleted_at,d.user_id AS dashboard_user_id
        FROM analysis_dashboard_items i JOIN analysis_dashboards d ON d.id=i.dashboard_id WHERE i.model_id=? AND i.source_type='model' AND d.deleted_at IS NULL ORDER BY d.name,i.id`, [modelId]);
    return { views, items };
}

async function view(id) { return queryOne('SELECT * FROM analysis_saved_views WHERE id=? AND deleted_at IS NULL', [id]); }
async function saveView({ id, userId, modelId, publishedVersion, name, description, viewType, config, binding, sourceRunId, share, expectedVersion, migration = false, authorize }) {
    return transaction(async trx => {
        await authorize(trx);
        const existing = await trx.queryOne('SELECT * FROM analysis_saved_views WHERE id=? AND deleted_at IS NULL FOR UPDATE', [id]);
        const retained = await require('./analysis-integrity').retainFixedResults(trx, { kind: 'view', id, jobId: sourceRunId });
        if (!retained) throw biError('ANALYSIS_MODEL_RESULT_UNAVAILABLE', '原分析结果已过期，请重新计算后保存视图。', 409);
        if (existing?.last_run_id && existing.last_run_id !== sourceRunId) {
            await require('./analysis-objects').release('export', `view:${id}`, trx);
            await require('./analysis-integrity').retainFixedResults(trx, { kind: 'view', id, jobId: sourceRunId });
        }
        if (existing) {
            if (Number(existing.user_id) !== Number(userId) || (migration ? existing.source_type !== 'dataset' : existing.source_type !== 'model' || existing.model_id !== modelId)) throw biError('ANALYSIS_MODEL_VIEW_NOT_FOUND', '分析视图不存在或无权修改。', 404);
            if (!Number.isSafeInteger(expectedVersion) || Number(existing.version) !== expectedVersion) throw biError('ANALYSIS_MODEL_VIEW_CONFLICT', '分析视图已变化，请重新加载；当前设置仍保留。', 409);
            await trx.execute(`UPDATE analysis_saved_views SET dataset_id=NULL,source_type='model',model_id=?,name=?,description=?,view_type=?,config_json=?::jsonb,published_version=?,binding_strategy=?,historical_manifest_id=?,last_run_id=?,scope=?,allowed_units=?,allowed_user_ids=?,version=version+1,updated_at=NOW() WHERE id=?`,
                [modelId, name, description, viewType, JSON.stringify(config), publishedVersion, binding.strategy, binding.manifestId || null, sourceRunId, share.scope, share.allowedUnits, share.allowedUserIds, id]);
        } else {
            if (expectedVersion !== undefined) throw biError('ANALYSIS_MODEL_VIEW_NOT_FOUND', '分析视图不存在或已删除。', 404);
            await trx.execute(`INSERT INTO analysis_saved_views(id,dataset_id,user_id,name,description,view_type,config_json,source_type,model_id,published_version,binding_strategy,historical_manifest_id,last_run_id,scope,allowed_units,allowed_user_ids)
                VALUES (?,NULL,?,?,?,?,?::jsonb,'model',?,?,?,?,?,?,?,?)`, [id, userId, name, description, viewType, JSON.stringify(config), modelId, publishedVersion, binding.strategy, binding.manifestId || null, sourceRunId, share.scope, share.allowedUnits, share.allowedUserIds]);
        }
        await audit(trx, { userId, modelId, version: publishedVersion, runId: sourceRunId, action: migration ? 'exploration_view_migrated' : existing && Number(existing.published_version) !== publishedVersion ? 'model_view_upgraded' : 'model_view_saved', details: { viewId: id, previousVersion: existing?.published_version || null, ...(migration ? { previousDatasetId: existing.dataset_id, previousConfigHash: require('../services/data-analysis/bi/canonical').canonicalHash(existing.config_json) } : {}) } });
        return trx.queryOne('SELECT * FROM analysis_saved_views WHERE id=?', [id]);
    });
}

async function removeView({ userId, id, modelId, authorize }) {
    return transaction(async trx => {
        await authorize(trx);
        await trx.execute('UPDATE analysis_saved_views SET deleted_at=NOW(),updated_at=NOW(),version=version+1 WHERE id=? AND user_id=?', [id, userId]);
        await require('./analysis-objects').release('export', `view:${id}`, trx);
        await audit(trx, { userId, modelId, action: 'model_view_deleted', details: { viewId: id } });
    });
}

async function dashboard(id) { return queryOne('SELECT * FROM analysis_dashboards WHERE id=? AND deleted_at IS NULL', [id]); }
async function item(id, dashboardId) { return queryOne('SELECT * FROM analysis_dashboard_items WHERE id=? AND dashboard_id=?', [id, dashboardId]); }

async function saveItem({ id, dashboardId, userId, view: source, title, position, expectedVersion, authorize }) {
    return transaction(async trx => {
        await authorize(trx);
        const dashboard = await trx.queryOne('SELECT * FROM analysis_dashboards WHERE id=? AND user_id=? AND deleted_at IS NULL FOR UPDATE', [dashboardId, userId]);
        if (!dashboard) throw biError('ANALYSIS_MODEL_DASHBOARD_NOT_FOUND', '仪表盘不存在或无权修改。', 404);
        const existing = await trx.queryOne('SELECT * FROM analysis_dashboard_items WHERE id=? AND dashboard_id=? FOR UPDATE', [id, dashboardId]);
        if (existing && (!Number.isSafeInteger(expectedVersion) || Number(existing.version) !== expectedVersion)) throw biError('ANALYSIS_MODEL_VIEW_CONFLICT', '仪表盘组件已变化，请重新加载。', 409);
        if (!existing && expectedVersion !== undefined) throw biError('ANALYSIS_MODEL_VIEW_NOT_FOUND', '仪表盘组件不存在。', 404);
        if (existing) await require('./analysis-objects').release('export', `dashboard-item:${id}`, trx);
        const count = await trx.queryOne('SELECT COUNT(*) AS total FROM analysis_dashboard_items WHERE dashboard_id=?', [dashboardId]);
        if (!existing && Number(count.total) >= 60) throw biError('ANALYSIS_MODEL_DASHBOARD_LIMIT', '单个仪表盘最多包含六十个组件。', 409);
        if (existing) await trx.execute(`UPDATE analysis_dashboard_items SET dataset_id=NULL,source_type='model',model_id=?,published_version=?,binding_strategy=?,historical_manifest_id=?,saved_view_id=?,title=?,item_type=?,position_json=?::jsonb,config_json=?::jsonb,last_run_id=NULL,last_successful_run_id=NULL,version=version+1,updated_at=NOW() WHERE id=?`,
            [source.modelId, source.publishedVersion, source.binding.strategy, source.binding.manifestId || null, source.id, title, source.viewType === 'query' ? 'table' : source.viewType, JSON.stringify(position), JSON.stringify(source.config), id]);
        else await trx.execute(`INSERT INTO analysis_dashboard_items(id,dashboard_id,dataset_id,user_id,source_type,model_id,published_version,binding_strategy,historical_manifest_id,saved_view_id,title,item_type,position_json,config_json)
            VALUES (?,?,NULL,?,'model',?,?,?,?,?,?,?,?::jsonb,?::jsonb)`, [id, dashboardId, userId, source.modelId, source.publishedVersion, source.binding.strategy, source.binding.manifestId || null, source.id, title, source.viewType === 'query' ? 'table' : source.viewType, JSON.stringify(position), JSON.stringify(source.config)]);
        await trx.execute('UPDATE analysis_dashboards SET version=version+1,updated_at=NOW() WHERE id=?', [dashboardId]);
        await audit(trx, { userId, modelId: source.modelId, version: source.publishedVersion, action: 'model_dashboard_item_saved', details: { dashboardId, itemId: id, viewId: source.id } });
        return trx.queryOne('SELECT * FROM analysis_dashboard_items WHERE id=?', [id]);
    });
}

async function recordItemRun({ itemId, userId, expectedVersion, jobId }) {
    return transaction(async trx => {
        const job = await trx.queryOne('SELECT * FROM analysis_query_jobs WHERE id=? AND user_id=? FOR SHARE', [jobId, userId]);
        if (!job || job.result_metadata_json?.resultExpired) throw biError('ANALYSIS_MODEL_RESULT_UNAVAILABLE', '分析结果已过期，请重新计算。', 409);
        const changed = await trx.execute("UPDATE analysis_dashboard_items SET last_run_id=?,last_successful_run_id=CASE WHEN ? THEN ? ELSE last_successful_run_id END,updated_at=NOW() WHERE id=? AND user_id=? AND version=?", [jobId, job.status === 'succeeded', jobId, itemId, userId, expectedVersion]);
        if (changed && job.status === 'succeeded') {
            await require('./analysis-objects').release('export', `dashboard-item:${itemId}`, trx);
            await require('./analysis-integrity').retainFixedResults(trx, { kind: 'dashboard-item', id: itemId, jobId });
        }
        return Boolean(changed);
    });
}
async function successfulRun(trx, job) {
    const items = await trx.query("UPDATE analysis_dashboard_items SET last_successful_run_id=? WHERE last_run_id=? AND user_id=? AND source_type='model' RETURNING id", [job.id, job.id, job.user_id]);
    for (const item of items) {
        await require('./analysis-objects').release('export', `dashboard-item:${item.id}`, trx);
        await require('./analysis-integrity').retainFixedResults(trx, { kind: 'dashboard-item', id: item.id, jobId: job.id });
    }
}

async function settleRefreshRuns(trx, job) {
    const runs = await trx.query(`SELECT * FROM analysis_refresh_runs WHERE user_id=? AND status='running' AND EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(result_json->'items','[]'::jsonb)) item WHERE item->>'runId'=?) FOR UPDATE SKIP LOCKED`, [job.user_id, job.id]);
    for (const run of runs) {
        const snapshot = run.result_json;
        const items = [];
        let pending = false;
        for (const item of snapshot.items || []) {
            if (item.sourceType !== 'model') { items.push(item); continue; }
            const current = await trx.queryOne('SELECT status,last_error FROM analysis_query_jobs WHERE id=? AND user_id=?', [item.runId, job.user_id]);
            if (current && ['queued', 'running', 'retry_wait', 'cancelling'].includes(current.status)) pending = true;
            items.push({ ...item, status: current?.status || 'failed', ...(current?.status === 'failed' ? { error: current.last_error } : {}) });
        }
        if (pending) continue;
        const failed = items.filter(item => item.status !== 'succeeded').length;
        const status = failed ? failed === items.length ? 'failed' : 'partial_success' : 'succeeded';
        const completed = { ...snapshot, items, status };
        await trx.execute('UPDATE analysis_refresh_runs SET status=?,result_json=?::jsonb,completed_at=NOW(),updated_at=NOW() WHERE id=?', [status, JSON.stringify(completed), run.id]);
        await trx.execute("UPDATE analysis_dashboards SET last_snapshot_json=?::jsonb,updated_at=NOW() WHERE id=? AND last_snapshot_json->>'runId'=?", [JSON.stringify(completed), run.dashboard_id, run.id]);
        await audit(trx, { userId: job.user_id, modelId: job.model_id, runId: job.id, action: 'model_dashboard_refresh_completed', outcome: status, details: { refreshId: run.id, dashboardId: run.dashboard_id } });
    }
}

module.exports = { dependencies, view, saveView, removeView, dashboard, item, saveItem, recordItemRun, successfulRun, settleRefreshRuns };
