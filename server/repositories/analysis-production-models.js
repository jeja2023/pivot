'use strict';

const crypto = require('node:crypto');
const { query, queryOne, transaction } = require('../db/client');
const { biError } = require('../services/data-analysis/bi/errors');

function expected(value) {
    if (!Number.isSafeInteger(value) || value < 1) throw biError('ANALYSIS_MODEL_VERSION_REQUIRED', '请携带有效草稿修订号，刷新模型后重试。');
    return value;
}

async function get(modelId, client = { queryOne }) { return client.queryOne('SELECT m.*, u.username AS owner_name FROM analysis_data_models m LEFT JOIN users u ON u.id = m.user_id WHERE m.id = ? AND m.deleted_at IS NULL', [modelId]); }

async function audit(trx, { userId, modelId, action, version = null, runId = null, outcome = 'succeeded', errorCode = '', details = {} }) {
    await trx.execute(`INSERT INTO analysis_audit_events(id,user_id,model_id,published_version,run_id,action,outcome,error_code,details_json)
        VALUES (?,?,?,?,?,?,?,?,?::jsonb)`, [crypto.randomUUID(), userId, modelId, version, runId, action, outcome, errorCode, JSON.stringify(details)]);
}

async function lock(trx, { userId, modelId, expectedVersion, allowArchived = false }) {
    expected(expectedVersion);
    await require('./analysis-authorization').authorize(trx, { userId, modelId, definition: { nodes: [] }, required: new Map(), write: true });
    const row = await trx.queryOne('SELECT * FROM analysis_data_models WHERE id = ? AND user_id = ? AND model_kind = ? AND deleted_at IS NULL FOR UPDATE', [modelId, userId, 'production']);
    if (!row) throw biError('ANALYSIS_MODEL_NOT_FOUND', '数据模型不存在或无权编辑。', 404);
    if (Number(row.version) !== expectedVersion) throw biError('ANALYSIS_MODEL_VERSION_CONFLICT', '草稿已被其他窗口修改，请重新加载；当前输入仍保留。', 409);
    if (row.archived_at && !allowArchived) throw biError('ANALYSIS_MODEL_ARCHIVED', '模型已归档，请先恢复后编辑。', 409);
    return row;
}

async function projectDraft(trx, row, definition, canvasLayout = {}, flowGraph = null) {
    await trx.execute('DELETE FROM analysis_data_model_relations WHERE model_id = ?', [row.id]);
    await trx.execute('DELETE FROM analysis_model_dimensions WHERE model_id = ?', [row.id]);
    await trx.execute('DELETE FROM analysis_metric_definitions WHERE model_id = ?', [row.id]);
    await trx.execute('DELETE FROM analysis_data_model_nodes WHERE model_id = ?', [row.id]);
    for (const node of definition.nodes) await trx.execute(`INSERT INTO analysis_data_model_nodes(id,model_id,dataset_id,role,name,grain_keys_json,config_json) VALUES (?,?,?,?,?,?::jsonb,?::jsonb)`, [node.id, row.id, node.datasetId, node.role, node.name, JSON.stringify(node.grainKeys), JSON.stringify({ ...node, ...(Object.hasOwn(canvasLayout, node.id) ? { canvasLayout: canvasLayout[node.id] } : {}), ...(node.role === 'fact' && flowGraph ? { flowGraph } : {}) })]);
    const nodes = new Map(definition.nodes.map(node => [node.id, node]));
    for (const relation of definition.relations) {
        const left = nodes.get(relation.leftNodeId), right = nodes.get(relation.rightNodeId), pair = relation.keyPairs[0];
        if (!left || !right || !pair) continue;
        await trx.execute(`INSERT INTO analysis_data_model_relations(id,model_id,user_id,left_dataset_id,left_field_key,right_dataset_id,right_field_key,join_type,cardinality,left_node_id,right_node_id,key_pairs_json,relation_revision)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?::jsonb,?)`, [`${row.id}:${relation.id}`, row.id, row.user_id, left.datasetId, pair.leftFieldKey, right.datasetId, pair.rightFieldKey, relation.joinType, relation.cardinality, left.id, right.id, JSON.stringify(relation.keyPairs), Number(row.version)]);
    }
    for (const dimension of definition.dimensions) await trx.execute(`INSERT INTO analysis_model_dimensions(id,model_id,node_id,field_key,name,config_json) VALUES (?,?,?,?,?,?::jsonb)`, [dimension.id, row.id, dimension.nodeId, dimension.fieldKey, dimension.name, JSON.stringify(dimension)]);
    const fact = definition.nodes.find(node => node.role === 'fact');
    if (fact) for (const metric of definition.metrics) await trx.execute(`INSERT INTO analysis_metric_definitions(id,dataset_id,user_id,name,description,metric_config_json,unit,model_id,model_member_id,metric_type,valid_from,valid_to)
        VALUES (?,?,?,?,?,?::jsonb,?,?,?,?,?,?)`, [`${row.id}:${metric.id}`, fact.datasetId, row.user_id, metric.name, metric.description, JSON.stringify(metric), metric.unit, row.id, metric.id, metric.type, metric.validFrom || null, metric.validTo || null]);
}

async function create({ id, userId, name, description, definition, semanticHash, businessOwner = '', maintenanceContact = '', authorize }) {
    return transaction(trx => createInTransaction(trx, { id, userId, name, description, definition, semanticHash, businessOwner, maintenanceContact, authorize }));
}
async function createInTransaction(trx, { id, userId, name, description, definition, semanticHash, businessOwner = '', maintenanceContact = '', authorize }) {
    await require('./analysis-release-controls').assertAllowed(trx, 'create');
    await authorize(trx);
    await trx.execute(`INSERT INTO analysis_data_models(id,user_id,name,description,model_kind,definition_json,semantic_hash,business_owner,maintenance_contact) VALUES (?,?,?,?,'production',?::jsonb,?,?,?)`, [id, userId, name, description, JSON.stringify(definition), semanticHash, businessOwner, maintenanceContact]);
    const row = await get(id, trx);
    await projectDraft(trx, row, definition);
    await audit(trx, { userId, modelId: id, action: 'model_created', details: { revision: 1, semanticHash } });
    return row;
}

async function nodeConfigs(modelId, client = { query }) {
    return client.query('SELECT id,config_json FROM analysis_data_model_nodes WHERE model_id=?', [modelId]);
}

async function canvasLayouts(modelId, client = { query }) {
    const rows = await nodeConfigs(modelId, client);
    return Object.fromEntries(rows.filter(row => row.config_json?.canvasLayout).map(row => [row.id, row.config_json.canvasLayout]));
}

async function flowGraph(modelId, client = { query }) {
    const rows = await nodeConfigs(modelId, client);
    const factRow = rows.find(row => row.config_json?.flowGraph);
    return factRow?.config_json?.flowGraph || { nodes: [], edges: [] };
}

async function saveDraft({ userId, modelId, expectedVersion, definition, semanticHash, canvasLayout, flowGraph: nextFlowGraph, authorize }) {
    return transaction(async trx => {
        const row = await lock(trx, { userId, modelId, expectedVersion });
        await authorize(trx);
        // 布局与算子流使用已有节点展示配置，旧快照的语义哈希和定义字节不因画布编辑而改写。
        const layout = canvasLayout === undefined ? await canvasLayouts(modelId, trx) : canvasLayout;
        const resolvedFlow = nextFlowGraph === undefined ? await flowGraph(modelId, trx) : nextFlowGraph;
        await projectDraft(trx, row, definition, layout, resolvedFlow);
        await trx.execute('UPDATE analysis_data_models SET definition_json = ?::jsonb, semantic_hash = ?, version = version + 1, updated_at = NOW() WHERE id = ?', [JSON.stringify(definition), semanticHash, modelId]);
        await audit(trx, { userId, modelId, action: 'draft_saved', details: { revision: expectedVersion + 1, semanticHash } });
        return get(modelId, trx);
    });
}

async function update({ userId, modelId, expectedVersion, name, description, businessOwner, maintenanceContact }) {
    return transaction(async trx => {
        await lock(trx, { userId, modelId, expectedVersion });
        await trx.execute('UPDATE analysis_data_models SET name = ?, description = ?,business_owner=COALESCE(?,business_owner),maintenance_contact=COALESCE(?,maintenance_contact),version = version + 1, updated_at = NOW() WHERE id = ?', [name, description, businessOwner ?? null, maintenanceContact ?? null, modelId]);
        await audit(trx, { userId, modelId, action: 'model_updated', details: { revision: expectedVersion + 1 } });
        return get(modelId, trx);
    });
}

async function archive({ userId, modelId, expectedVersion, archived, deleted = false }) {
    return transaction(async trx => {
        await lock(trx, { userId, modelId, expectedVersion, allowArchived: true });
        await trx.execute('UPDATE analysis_data_models SET deleted_at = CASE WHEN ? THEN NOW() ELSE deleted_at END, archived_at = CASE WHEN ? THEN NOW() ELSE NULL END, version = version + 1, updated_at = NOW() WHERE id = ?', [deleted, archived, modelId]);
        await audit(trx, { userId, modelId, action: deleted ? 'model_deleted' : archived ? 'model_archived' : 'model_unarchived' });
        return get(modelId, trx);
    });
}

async function versions(modelId) { return query('SELECT * FROM analysis_data_model_versions WHERE model_id = ? ORDER BY version DESC', [modelId]); }
async function version(modelId, number, client = { queryOne }) { return client.queryOne('SELECT * FROM analysis_data_model_versions WHERE model_id = ? AND version = ?', [modelId, number]); }
async function versionOptions(modelId) { return query('SELECT version,created_at FROM analysis_data_model_versions WHERE model_id=? ORDER BY version DESC LIMIT 100', [modelId]); }

module.exports = { get, create, createInTransaction, saveDraft, update, archive, versions, version, versionOptions, lock, audit, canvasLayouts, flowGraph };
