'use strict';

const { queryOne, transaction } = require('../db/client');
const models = require('./analysis-production-models');
const { biError } = require('../services/data-analysis/bi/errors');

async function get(modelId, client = { queryOne }) { return client.queryOne('SELECT * FROM analysis_model_origins WHERE model_id=?', [modelId]); }
async function inventory(trx, modelId) {
    await trx.queryOne("SELECT pg_advisory_xact_lock_shared(hashtext('pivot:analysis:authorization'),hashtext(?))", [`model:${modelId}`]);
    const model = await trx.queryOne("SELECT * FROM analysis_data_models WHERE id=? AND model_kind='exploration' AND deleted_at IS NULL", [modelId]);
    if (!model) throw biError('ANALYSIS_MODEL_NOT_FOUND', '旧探索模型不存在或无权迁移。', 404);
    const relations = await trx.query('SELECT * FROM analysis_data_model_relations WHERE model_id=? ORDER BY created_at,id', [modelId]);
    const ids = [...new Set(relations.flatMap(row => [row.left_dataset_id, row.right_dataset_id]))];
    const metrics = ids.length ? await trx.query('SELECT * FROM analysis_metric_definitions WHERE dataset_id=ANY(?::text[]) AND model_id IS NULL AND deleted_at IS NULL ORDER BY id LIMIT 1001', [ids]) : [];
    const views = ids.length ? await trx.query("SELECT id,user_id,name,dataset_id,version,config_json,source_type FROM analysis_saved_views WHERE dataset_id=ANY(?::text[]) AND deleted_at IS NULL ORDER BY id LIMIT 1001", [ids]) : [];
    const versions = ids.length ? await trx.query('SELECT id,dataset_id,version,row_count,created_at FROM analysis_dataset_versions WHERE dataset_id=ANY(?::text[]) ORDER BY dataset_id,version DESC LIMIT 1001', [ids]) : [];
    return { model, relations, metrics, views, versions };
}
async function create({ userId, sourceModelId, requestKey, requestHash, prepare }) {
    return transaction(async trx => {
        await trx.queryOne('SELECT pg_advisory_xact_lock(hashtextextended(?,0)) AS locked', [`analysis-migration:${userId}:${sourceModelId}:${requestKey}`]);
        const duplicate = await trx.queryOne('SELECT * FROM analysis_model_origins WHERE user_id=? AND source_model_id=? AND request_key=?', [userId, sourceModelId, requestKey]);
        if (duplicate) {
            if (duplicate.request_hash !== requestHash) throw biError('ANALYSIS_MODEL_REQUEST_CONFLICT', '同一幂等标识已经用于不同迁移内容。', 409);
            await require('./analysis-authorization').authorize(trx, { userId, modelId: duplicate.model_id, definition: { nodes: [] }, required: new Map(), write: true });
            return models.get(duplicate.model_id, trx);
        }
        const { snapshot, snapshotHash, ...draft } = await prepare(trx);
        const row = await models.createInTransaction(trx, draft);
        await trx.execute('INSERT INTO analysis_model_origins(model_id,source_model_id,user_id,request_key,request_hash,snapshot_hash,snapshot_json) VALUES (?,?,?,?,?,?,?::jsonb)', [row.id, sourceModelId, userId, requestKey, requestHash, snapshotHash, JSON.stringify(snapshot)]);
        await models.audit(trx, { userId, modelId: row.id, action: 'model_migrated', details: { sourceModelId, snapshotHash } });
        return row;
    });
}
module.exports = { get, inventory, create };
