'use strict';

const { canAccessSharedResource } = require('../services/unit-visibility');
const { canonicalHash } = require('../services/data-analysis/bi/canonical');
const { biError } = require('../services/data-analysis/bi/errors');

async function lockPrincipals(trx, userIds) {
    await require('./analysis-release-controls').readLock(trx);
    for (const id of [...new Set(userIds.map(String))].sort((a, b) => a.localeCompare(b, 'en'))) {
        await trx.queryOne("SELECT pg_advisory_xact_lock_shared(hashtext('pivot:analysis:authorization'), hashtext(?))", [`principal:${id}`]);
    }
}

async function lockReadResources(trx, { modelIds, datasetIds }) {
    await require('./analysis-release-controls').readLock(trx);
    for (const [kind, ids] of [['model', modelIds], ['dataset', datasetIds]]) {
        const keys = [...new Set(ids)].sort().map(id => `${kind}:${id}`);
        if (keys.length) await trx.query(`SELECT pg_advisory_xact_lock_shared(hashtext('pivot:analysis:authorization'),hashtext(resource)) FROM unnest(?::text[]) WITH ORDINALITY AS resources(resource,position) ORDER BY position`, [keys]);
    }
}

// 身份、模型、来源按固定顺序加锁；编辑在读取模型行之前取得排他锁，避免共享锁升级。
// 读取栅栏一直持有到结果/快照事务提交；现有授权写路径由数据库触发器取得对应排他锁。
async function authorize(trx, { userId, modelId = null, definition, required, write = false }) {
    await require('./analysis-release-controls').readLock(trx);
    const resources = [{ kind: 'principal', id: String(userId) }, ...(modelId ? [{ kind: 'model', id: modelId }] : []), ...definition.nodes.map(node => ({ kind: 'dataset', id: node.datasetId }))]
        .sort((left, right) => ({ principal: 0, model: 1, dataset: 2 }[left.kind] - { principal: 0, model: 1, dataset: 2 }[right.kind]) || left.id.localeCompare(right.id, 'en'));
    for (const resource of resources) {
        if (resource.kind === 'model' && write) await trx.queryOne("SELECT pg_advisory_xact_lock(hashtext('pivot:analysis:authorization'),hashtext(?))", [`model:${resource.id}`]);
        else await trx.queryOne("SELECT pg_advisory_xact_lock_shared(hashtext('pivot:analysis:authorization'), hashtext(?))", [`${resource.kind}:${resource.id}`]);
    }
    const user = await trx.queryOne('SELECT id,username,nickname,unit,role,status,deleted_at FROM users WHERE id = ?', [userId]);
    if (!user || user.deleted_at || user.status !== 'active') throw biError('ANALYSIS_MODEL_NOT_FOUND', '当前账号不可用，请重新登录。', 404);
    if (modelId) {
        const gate = await trx.queryOne("SELECT access_fenced,probe_config_json FROM analysis_operation_state WHERE id='main' FOR SHARE");
        const probe = gate?.probe_config_json;
        if (!gate || gate.access_fenced && !(probe?.enabled && probe.modelId === modelId && [probe.positiveUserId, probe.negativeUserId].some(id => Number(id) === Number(userId)))) throw biError('ANALYSIS_MODEL_INCIDENT_FENCED', '数据建模正在核对统计或权限异常，已暂停业务读取与新分析；请联系维护者处理。', 503);
    }
    let model = null;
    if (modelId) {
        model = await trx.queryOne('SELECT * FROM analysis_data_models WHERE id = ? AND model_kind = ?', [modelId, 'production']);
        if (!model || !canAccessSharedResource(model, user, write)) throw biError('ANALYSIS_MODEL_NOT_FOUND', '模型不存在或无权访问。', 404);
    }
    const sources = Object.create(null);
    for (const node of definition.nodes) {
        const dataset = await trx.queryOne(`SELECT *,to_char(COALESCE(updated_at,created_at) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS bi_updated_at FROM analysis_datasets WHERE id = ?`, [node.datasetId]);
        if (!dataset || !canAccessSharedResource(dataset, user) || dataset.status !== 'ready') throw biError('ANALYSIS_MODEL_SOURCE_UNAVAILABLE', '模型来源不可用，请联系模型维护者检查来源权限。', 404);
        const governance = await trx.query('SELECT field_key, logical_type, unit, date_format, sensitivity, business_definition, status, revision, metadata_json FROM analysis_field_governance WHERE dataset_id = ? ORDER BY field_key', [dataset.id]);
        const restricted = new Set(governance.filter(field => field.status === 'active' && ['restricted', 'confidential'].includes(field.sensitivity)).map(field => field.field_key));
        const columns = (typeof dataset.columns_json === 'string' ? JSON.parse(dataset.columns_json) : dataset.columns_json).filter(column => Number(user.id) === Number(dataset.user_id) || !restricted.has(column.key));
        if ([...(required.get(node.id) || [])].some(key => !columns.some(column => column.key === key))) throw biError('ANALYSIS_MODEL_FIELD_UNAVAILABLE', '模型所需字段不可用，请联系模型维护者检查字段权限。', 403);
        const version = await trx.queryOne('SELECT * FROM analysis_dataset_versions WHERE dataset_id=? AND parquet_path=? ORDER BY version DESC LIMIT 1', [dataset.id, dataset.parquet_path]);
        sources[node.id] = { dataset, columns, governance, version };
    }
    await require('../services/data-analysis/bi/security-journal').assertResources(trx, resources);
    const vector = [];
    for (const resource of resources) {
        const row = await trx.queryOne('SELECT revision FROM analysis_authorization_revisions WHERE resource_kind = ? AND resource_id = ?', [resource.kind, resource.id]);
        if (!row || !/^[1-9]\d*$/.test(String(row.revision))) throw biError('ANALYSIS_AUTHORIZATION_UNREADY', '授权修订记录不完整，已停止数据读取；请联系维护者核对授权状态。', 503);
        vector.push({ ...resource, revision: String(row.revision) });
    }
    return { user, model, sources, vector, authorizationHash: canonicalHash(vector) };
}

module.exports = { authorize, lockPrincipals, lockReadResources };
