'use strict';

const { transaction } = require('../db/client');

function conflict(message, status = 409) {
    return Object.assign(new Error(message), { status, code: status === 409 ? 'ANALYSIS_MODEL_VERSION_CONFLICT' : 'ANALYSIS_MODEL_NOT_FOUND' });
}

async function mutateModel({ userId, modelId, expectedVersion }, mutate) {
    if (expectedVersion !== undefined && (!Number.isSafeInteger(Number(expectedVersion)) || Number(expectedVersion) < 1)) {
        throw Object.assign(new Error('数据模型版本无效，请刷新模型后重试。'), { status: 400 });
    }
    return transaction(async trx => {
        const model = await trx.queryOne('SELECT * FROM analysis_data_models WHERE id = ? AND user_id = ? AND deleted_at IS NULL FOR UPDATE', [modelId, userId]);
        if (!model) throw conflict('数据模型不存在或无权编辑。', 404);
        if (model.model_kind === 'production') throw Object.assign(new Error('正式模型请使用数据建模草稿或归档接口。'), { status: 409, code: 'ANALYSIS_MODEL_UPGRADE_REQUIRED' });
        if (expectedVersion !== undefined && Number(expectedVersion) !== Number(model.version)) throw conflict('数据模型已在其他窗口修改，请重新加载后再保存；当前输入仍保留。');
        return mutate(trx, model);
    });
}

async function saveRelation({ userId, modelId, expectedVersion, relationId, values, validate }) {
    return mutateModel({ userId, modelId, expectedVersion }, async (trx, model) => {
        const relations = await trx.query('SELECT * FROM analysis_data_model_relations WHERE model_id = ? ORDER BY created_at ASC, id ASC', [modelId]);
        const existing = relations.find(row => row.id === relationId);
        if (values.editing && !existing) throw conflict('关联不存在或已删除，请重新加载模型。', 404);
        validate(relations, existing);
        if (existing) {
            await trx.execute(`UPDATE analysis_data_model_relations SET left_dataset_id = ?, left_field_key = ?, right_dataset_id = ?, right_field_key = ?, join_type = ?, cardinality = ?, quality_json = ?::jsonb, updated_at = NOW() WHERE id = ? AND model_id = ?`,
                [values.leftDatasetId, values.leftFieldKey, values.rightDatasetId, values.rightFieldKey, values.joinType, values.cardinality, JSON.stringify(values.quality), relationId, model.id]);
        } else {
            await trx.execute(`INSERT INTO analysis_data_model_relations (id, model_id, user_id, left_dataset_id, left_field_key, right_dataset_id, right_field_key, join_type, cardinality, status, quality_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?::jsonb, NOW(), NOW())`,
                [relationId, model.id, userId, values.leftDatasetId, values.leftFieldKey, values.rightDatasetId, values.rightFieldKey, values.joinType, values.cardinality, JSON.stringify(values.quality)]);
        }
        await trx.execute('UPDATE analysis_data_models SET version = version + 1, updated_at = NOW() WHERE id = ?', [model.id]);
        return trx.queryOne('SELECT * FROM analysis_data_model_relations WHERE id = ? AND model_id = ?', [relationId, model.id]);
    });
}

async function removeRelation({ userId, modelId, relationId, expectedVersion, validate }) {
    return mutateModel({ userId, modelId, expectedVersion }, async (trx, model) => {
        const relations = await trx.query('SELECT * FROM analysis_data_model_relations WHERE model_id = ? ORDER BY created_at ASC, id ASC', [modelId]);
        if (!relations.some(row => row.id === relationId)) throw conflict('关联不存在或已删除，请重新加载模型。', 404);
        validate(relations.filter(row => row.id !== relationId));
        await trx.execute('DELETE FROM analysis_data_model_relations WHERE id = ? AND model_id = ?', [relationId, model.id]);
        await trx.execute('UPDATE analysis_data_models SET version = version + 1, updated_at = NOW() WHERE id = ?', [model.id]);
        return { deleted: true, version: Number(model.version) + 1 };
    });
}

async function removeModel({ userId, modelId, expectedVersion }) {
    return mutateModel({ userId, modelId, expectedVersion }, async (trx, model) => {
        await trx.execute('UPDATE analysis_data_models SET deleted_at = NOW(), updated_at = NOW(), version = version + 1 WHERE id = ?', [model.id]);
        return { deleted: true, version: Number(model.version) + 1 };
    });
}

async function updateModel({ userId, modelId, expectedVersion, name, description, share }) {
    return mutateModel({ userId, modelId, expectedVersion }, async (trx, model) => {
        await trx.execute('UPDATE analysis_data_models SET name = ?, description = ?, scope = ?, allowed_units = ?, allowed_user_ids = ?, version = version + 1, updated_at = NOW() WHERE id = ?',
            [name, description, share.scope, share.allowedUnits, share.allowedUserIds, model.id]);
    });
}

module.exports = { saveRelation, removeRelation, removeModel, updateModel };
