'use strict';

const crypto = require('node:crypto');
const { transaction } = require('../db/client');
const models = require('./analysis-production-models');
const authorization = require('./analysis-authorization');
const plans = require('./analysis-model-plans');
const { isSuperAdmin } = require('../permissions');
const { allRequired } = require('../services/data-analysis/bi/manifests');
const { canonicalHash } = require('../services/data-analysis/bi/canonical');
const { biError } = require('../services/data-analysis/bi/errors');

const missing = () => biError('ANALYSIS_MODEL_TRANSFER_NOT_FOUND', '交接请求不存在或无权处理。', 404);
const changed = () => biError('ANALYSIS_MODEL_TRANSFER_CHANGED', '模型修订、共享范围或相关计划已变化，请重新预览并发起交接。', 409);

async function actor(trx, userId) {
    return (await authorization.authorize(trx, { userId, definition: { nodes: [] }, required: new Map() })).user;
}

async function lockContext(trx, { userId, modelId, recipientId, exclusive = false }) {
    const initial = await models.get(modelId, trx);
    if (!initial || initial.model_kind !== 'production') throw missing();
    await authorization.lockPrincipals(trx, [userId, recipientId, initial.user_id]);
    await trx.queryOne(exclusive ? "SELECT pg_advisory_xact_lock(hashtext('pivot:analysis:authorization'),hashtext(?))" : "SELECT pg_advisory_xact_lock_shared(hashtext('pivot:analysis:authorization'),hashtext(?))", [`model:${modelId}`]);
    const current = await actor(trx, userId);
    const model = await trx.queryOne(`SELECT * FROM analysis_data_models WHERE id=? AND model_kind='production' AND deleted_at IS NULL${exclusive ? ' FOR UPDATE' : ''}`, [modelId]);
    if (!model || Number(model.user_id) !== Number(initial.user_id)) throw changed();
    return { current, model };
}

async function context(trx, input, locked = null) {
    const { userId, modelId, recipientId, exclusive = false } = input;
    const { current, model } = locked || await lockContext(trx, input);
    const owner = await trx.queryOne('SELECT id,username,nickname,status,deleted_at FROM users WHERE id=?', [model.user_id]);
    if (Number(userId) !== Number(model.user_id) && !(isSuperAdmin(current) && (!owner || owner.status !== 'active' || owner.deleted_at)) && Number(userId) !== Number(recipientId)) throw missing();
    if (Number(model.user_id) === Number(recipientId)) throw biError('ANALYSIS_MODEL_TRANSFER_INVALID', '接收人不能是当前所有者。');
    const versions = await trx.query('SELECT version,semantic_hash,definition_json FROM analysis_data_model_versions WHERE model_id=? ORDER BY version', [modelId]);
    let receiving;
    for (const definition of [model.definition_json, ...versions.map(version => version.definition_json)]) receiving = await authorization.authorize(trx, { userId: recipientId, definition, required: allRequired(definition) });
    const bindings = await trx.query('SELECT published_version,revision,manifest_id,check_id FROM analysis_model_data_bindings WHERE model_id=? ORDER BY published_version', [modelId]);
    const related = await plans.inventory(trx, model.user_id, modelId, { lock: exclusive });
    const impact = { modelName: model.name, ownerName: owner?.nickname || owner?.username || String(model.user_id), recipientName: receiving.user.nickname || receiving.user.username,
        ownerId: Number(model.user_id), recipientId: Number(recipientId), version: Number(model.version), publishedVersion: model.published_version,
        semanticHash: model.semantic_hash, definitionHash: canonicalHash(model.definition_json), scope: model.scope, allowedUnits: model.allowed_units, allowedUserIds: model.allowed_user_ids,
        reviewId: model.sharing_review_id, businessOwner: model.business_owner, maintenanceContact: model.maintenance_contact,
        versions: versions.map(row => ({ version: Number(row.version), semanticHash: row.semantic_hash })), bindings, plans: related };
    return { current, model, impact, hash: canonicalHash(impact) };
}

async function preview(input) {
    return transaction(async trx => {
        const result = await context(trx, input);
        if (Number(input.userId) === Number(input.recipientId)) throw missing();
        return { modelId: result.model.id, name: result.model.name, impact: result.impact, impactHash: result.hash };
    });
}

async function create(input) {
    return transaction(async trx => {
        const hash = canonicalHash({ recipientId: input.recipientId, impactHash: input.impactHash, expectedVersion: input.expectedVersion, reason: input.reason, businessOwner: input.businessOwner, maintenanceContact: input.maintenanceContact });
        const locked = await lockContext(trx, input);
        await trx.queryOne("SELECT pg_advisory_xact_lock(hashtext('pivot:analysis:transfer-request'),hashtext(?))", [`${input.modelId}:${input.userId}:${input.requestKey}`]);
        const duplicate = await trx.queryOne('SELECT * FROM analysis_model_transfers WHERE model_id=? AND initiator_id=? AND request_key=?', [input.modelId, input.userId, input.requestKey]);
        if (duplicate) { if (duplicate.request_hash !== hash) throw biError('ANALYSIS_MODEL_REQUEST_CONFLICT', '幂等标识已用于其他交接请求。', 409); return duplicate; }
        const result = await context(trx, input, locked);
        if (Number(input.userId) === Number(input.recipientId)) throw missing();
        if (result.hash !== input.impactHash || Number(result.model.version) !== input.expectedVersion) throw changed();
        const row = await trx.queryOne(`INSERT INTO analysis_model_transfers(id,model_id,owner_id,initiator_id,recipient_id,expected_version,impact_hash,impact_json,business_owner,maintenance_contact,reason,request_key,request_hash)
            VALUES (?,?,?,?,?,?,?,?::jsonb,?,?,?,?,?) RETURNING *`, [`transfer_${crypto.randomUUID()}`, input.modelId, result.model.user_id, input.userId, input.recipientId, input.expectedVersion, result.hash, JSON.stringify(result.impact), input.businessOwner, input.maintenanceContact, input.reason, input.requestKey, hash]);
        await models.audit(trx, { userId: input.userId, modelId: input.modelId, action: 'model_transfer_requested', details: { transferId: row.id, recipientId: input.recipientId, impactHash: result.hash, reason: input.reason } });
        return row;
    });
}

async function inbox(userId) {
    return transaction(async trx => { await actor(trx, userId); return trx.query('SELECT * FROM analysis_model_transfers WHERE recipient_id=? OR initiator_id=? ORDER BY created_at DESC LIMIT 100', [userId, userId]); });
}

async function detail(userId, id) {
    return transaction(async trx => {
        const row = await trx.queryOne('SELECT * FROM analysis_model_transfers WHERE id=? AND (recipient_id=? OR initiator_id=?)', [id, userId, userId]);
        if (!row) throw missing();
        if (row.status !== 'requested') { await actor(trx, userId); return { row, currentImpact: null, unchanged: null }; }
        try {
            const current = await context(trx, { userId, modelId: row.model_id, recipientId: Number(row.recipient_id) });
            return { row, currentImpact: current.impact, unchanged: current.hash === row.impact_hash };
        } catch (error) {
            if (!['ANALYSIS_MODEL_SOURCE_UNAVAILABLE', 'ANALYSIS_MODEL_FIELD_UNAVAILABLE', 'ANALYSIS_MODEL_TRANSFER_CHANGED', 'ANALYSIS_MODEL_TRANSFER_NOT_FOUND'].includes(error.code)) throw error;
            return { row, currentImpact: null, unchanged: false };
        }
    });
}

async function decide({ userId, id, action, comment }) {
    return transaction(async trx => {
        const initial = await trx.queryOne('SELECT * FROM analysis_model_transfers WHERE id=?', [id]);
        if (!initial || (action === 'cancelled' ? Number(initial.initiator_id) !== userId : Number(initial.recipient_id) !== userId)) throw missing();
        // 接受前先按固定顺序取得身份和模型栅栏，避免在持有请求行锁后等待所有权写锁。
        const current = action === 'accepted' && initial.status === 'requested' ? await context(trx, { userId, modelId: initial.model_id, recipientId: userId, exclusive: true }) : null;
        await actor(trx, userId);
        const row = await trx.queryOne('SELECT *,expires_at<=NOW() AS expired FROM analysis_model_transfers WHERE id=? FOR UPDATE', [id]);
        if (row.status !== 'requested') { if (row.status === action && row.decision_comment === comment) return row; throw biError('ANALYSIS_MODEL_TRANSFER_COMPLETED', '交接请求已经处理，不能改写证据。', 409); }
        if (action === 'accepted') {
            if (row.expired) throw biError('ANALYSIS_MODEL_TRANSFER_EXPIRED', '交接请求已超过七天，请重新发起。', 409);
            if (current.hash !== row.impact_hash || Number(current.model.user_id) !== Number(row.owner_id)) throw changed();
            const active = await trx.queryOne("SELECT id FROM analysis_query_jobs WHERE model_id=? AND (status IN ('queued','running','retry_wait','cancelling') OR EXISTS(SELECT 1 FROM analysis_runtime_slots s WHERE s.job_id=analysis_query_jobs.id)) LIMIT 1", [row.model_id]);
            if (active) throw biError('ANALYSIS_MODEL_TRANSFER_BUSY', '模型仍有活动任务或待回收执行槽，请先取消并确认任务停止。', 409);
            await plans.pause(trx, current.impact.plans, row.owner_id);
            await trx.execute("UPDATE analysis_data_models SET user_id=?,scope='personal',allowed_units='',allowed_user_ids='',sharing_review_id=NULL,business_owner=?,maintenance_contact=?,version=version+1,updated_at=NOW() WHERE id=?", [userId, row.business_owner, row.maintenance_contact, row.model_id]);
        }
        const result = await trx.queryOne('UPDATE analysis_model_transfers SET status=?,decision_comment=?,completed_at=NOW() WHERE id=? RETURNING *', [action, comment, id]);
        await models.audit(trx, { userId, modelId: row.model_id, action: `model_transfer_${action}`, details: { transferId: id, ownerId: Number(row.owner_id), recipientId: Number(row.recipient_id), impactHash: row.impact_hash, pausedPlans: current?.impact.plans.map(plan => ({ kind: plan.kind, id: plan.id })) || [], comment } });
        return result;
    });
}

module.exports = { preview, create, inbox, detail, decide };
