'use strict';

const { execute } = require('../db/client');
const { canonicalHash } = require('../services/data-analysis/bi/canonical');

function parse(value) { try { return typeof value === 'string' ? JSON.parse(value) : value || {}; } catch (_) { return {}; } }

// 固定模型 ID 精确匹配；动态模型选择无法证明无关，交接时也要求暂停并由原所有者重新确认。
function usesModel(value, modelId) {
    if (!value || typeof value !== 'object') return false;
    const tool = Object.values(value).some(item => item === 'analysis.modelQuery' || item === 'analysis.modelResult');
    const hasId = item => item && typeof item === 'object' && (item.modelId === modelId || Object.values(item).some(hasId));
    if (tool && (hasId(value) || !JSON.stringify(value).includes('"modelId"') || /\{\{|\$\{/.test(JSON.stringify(value)))) return true;
    return Object.values(value).some(item => usesModel(item, modelId));
}

async function inventory(trx, ownerId, modelId, { lock = false } = {}) {
    const refresh = await trx.query(`SELECT s.* FROM analysis_refresh_schedules s WHERE s.user_id=? AND EXISTS
        (SELECT 1 FROM analysis_dashboard_items i WHERE i.dashboard_id=s.dashboard_id AND i.model_id=?) ORDER BY s.id${lock ? ' FOR UPDATE OF s' : ''}`, [ownerId, modelId]);
    const agents = await trx.query(`SELECT * FROM agent_schedules WHERE user_id=? AND deleted_at IS NULL ORDER BY id${lock ? ' FOR UPDATE' : ''}`, [ownerId]);
    const workflowIds = [...new Set(agents.map(row => Number(parse(row.run_config).workflowId)).filter(id => Number.isSafeInteger(id) && id > 0))];
    const workflows = workflowIds.length ? await trx.query(`SELECT w.id,w.user_id,v.version,v.dag_spec,w.current_version_id,w.published_version_id,v.id AS version_id FROM agent_workflows w
        JOIN agent_workflow_versions v ON v.workflow_id=w.id WHERE w.deleted_at IS NULL AND w.id=ANY(?::bigint[])`, [workflowIds]) : [];
    const resolved = row => {
        const config = parse(row.run_config);
        return workflows.filter(workflow => Number(workflow.id) === Number(config.workflowId) &&
            (config.workflowVersion && !['current', 'published'].includes(config.workflowVersion) ? Number(workflow.version) === Number(config.workflowVersion) :
                Number(workflow.version_id) === Number(config.workflowVersion === 'published' || Number(workflow.user_id) !== Number(ownerId) ? workflow.published_version_id : workflow.current_version_id)));
    };
    const related = agents.filter(row => {
        if (usesModel(parse(row.run_config), modelId)) return true;
        return resolved(row).some(workflow => usesModel(parse(workflow.dag_spec), modelId));
    });
    return [...refresh.map(row => ({ kind: 'refresh', id: row.id, name: row.name, status: row.status, hash: canonicalHash({ name: row.name, status: row.status, dashboard: row.dashboard_id, dataset: row.dataset_id, frequency: row.frequency, cron: row.cron_expression, interval: row.interval_minutes }) })),
        ...related.map(row => ({ kind: 'workflow', id: String(row.id), name: row.name, status: row.status, hash: canonicalHash({ config: parse(row.run_config), status: row.status, name: row.name, workflows: resolved(row).map(workflow => ({ id: String(workflow.id), version: String(workflow.version), dag: parse(workflow.dag_spec) })) }) }))];
}

async function pause(trx, plans, ownerId) {
    for (const plan of plans) {
        if (plan.kind === 'refresh') await trx.execute("UPDATE analysis_refresh_schedules SET status='paused',next_run_at=NULL,last_error='模型已交接，请重新确认执行主体和来源权限。',updated_at=NOW() WHERE id=? AND user_id=?", [plan.id, ownerId]);
        else await trx.execute("UPDATE agent_schedules SET status='paused',next_run_at=NULL,claim_token=NULL,claim_expires_at=NULL,last_error='模型已交接，请重新确认工作流主体、模型访问和凭据绑定。',updated_at=NOW() WHERE id=? AND user_id=?", [plan.id, ownerId]);
    }
}

async function pauseUnavailableRefresh(id) {
    await execute("UPDATE analysis_refresh_schedules SET status='paused',next_run_at=NULL,last_status='failed',last_error='执行主体已停用或删除，请重新确认计划主体。',updated_at=NOW() WHERE id=?", [id]);
}

module.exports = { inventory, pause, pauseUnavailableRefresh };
