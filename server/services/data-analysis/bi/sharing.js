'use strict';

const repository = require('../../../repositories/analysis-model-sharing');
const models = require('../../../repositories/analysis-production-models');
const checks = require('../../../repositories/analysis-model-jobs');
const authorization = require('../../../repositories/analysis-authorization');
const manifests = require('../../../repositories/analysis-manifests');
const { transaction } = require('../../../db/client');
const { normalizeShareSettings } = require('../../unit-visibility');
const { filterExistingShareUserIds } = require('../../share-targets');
const { resolveAnalysisUser } = require('../shared');
const { modelForUser } = require('./access');
const { authorize } = require('./jobs');
const { allRequired } = require('./manifests');
const { requestKey } = require('./query-contract');
const { biError } = require('./errors');
const { protect } = require('./delivery');

function record(row) { return { id: row.id, modelId: row.model_id, checkId: row.check_id, reviewerId: Number(row.reviewer_id), ownerId: Number(row.owner_id), semanticHash: row.semantic_hash, rulesHash: row.rules_hash, proposal: row.proposal_json, businessOwner: row.business_owner, maintenanceContact: row.maintenance_contact, status: row.status, comment: row.comment, createdAt: row.created_at, reviewedAt: row.reviewed_at }; }
async function actor(user) {
    const current = await resolveAnalysisUser(Number(user?.id));
    if (!current || current.status !== 'active' || current.deleted_at) throw biError('ANALYSIS_MODEL_REVIEW_NOT_FOUND', '当前身份不可用，请重新登录。', 404);
    return current;
}
async function proposal(body, user) {
    const share = normalizeShareSettings(body, await actor(user));
    return { ...share, allowedUserIds: await filterExistingShareUserIds(share.allowedUserIds, { excludeUserId: user.id }) };
}

async function requestModelReview({ user, modelId, body }) {
    const model = await modelForUser(user, modelId, { write: true });
    if (!Number.isSafeInteger(body.reviewerId) || body.reviewerId < 1) throw biError('ANALYSIS_MODEL_REVIEWER_INVALID', '请选择另一位具备来源权限的业务复核者。');
    if (!model.business_owner || !model.maintenance_contact) throw biError('ANALYSIS_MODEL_CONTACT_REQUIRED', '请先填写业务负责人和维护联系人。', 409);
    const share = await proposal({ ...body, scope: 'shared' }, user);
    const checked = await checks.check(user.id, modelId, body.checkId);
    return record(await repository.create({ userId: user.id, modelId, expectedVersion: body.expectedVersion, reviewerId: body.reviewerId, checkId: body.checkId, proposal: share,
        businessOwner: model.business_owner, maintenanceContact: model.maintenance_contact, requestKey: requestKey(body.requestKey), authorize: authorize(user, modelId, model.definition_json, { all: true, write: true, comparison: checked?.comparison_json?.migrationComparison }) }));
}

async function getModelReview(user, id) {
    const current = await actor(user), row = await repository.get(id);
    if (!row || ![Number(row.owner_id), Number(row.reviewer_id)].includes(Number(current.id))) throw biError('ANALYSIS_MODEL_REVIEW_NOT_FOUND', '复核请求不存在或无权访问。', 404);
    const model = await models.get(row.model_id);
    if (!model || model.deleted_at) throw biError('ANALYSIS_MODEL_REVIEW_NOT_FOUND', '复核请求已不可用。', 404);
    const checked = await checks.check(row.owner_id, row.model_id, row.check_id);
    const required = require('./migration').comparisonRequired(checked.definition_json, checked.comparison_json?.migrationComparison, allRequired(checked.definition_json));
    const sources = await transaction(trx => authorization.authorize(trx, { userId: current.id, definition: checked.definition_json, required }));
    const manifest = await manifests.get(checked.manifest_id);
    const visibleManifest = { ...manifest.manifest_json, members: manifest.manifest_json.members.map(member => ({ ...member, columns: member.columns.filter(column => sources.sources[member.nodeId]?.columns.some(item => item.key === column.key)) })) };
    for (const member of visibleManifest.members) for (const column of member.columns) required.get(member.nodeId)?.add(column.key);
    return protect({ ...record(row), name: model.name, definition: checked.definition_json, report: checked.report_json, manifest: visibleManifest,
        sources: Object.entries(sources.sources).map(([nodeId, source]) => ({ nodeId, name: source.dataset.name })) }, { userId: current.id, definition: checked.definition_json, required });
}

async function reviewInbox(user) { const current = await actor(user); return repository.inbox(current.id); }

async function decideModelReview({ user, reviewId, body }) {
    const row = await getModelReview(user, reviewId);
    if (row.reviewerId !== Number(user.id)) throw biError('ANALYSIS_MODEL_REVIEW_NOT_FOUND', '只有指定业务复核者可以处理此请求。', 404);
    if (typeof body.approved !== 'boolean' || typeof body.comment !== 'string' || !body.comment.trim() || body.comment.length > 2000) throw biError('ANALYSIS_MODEL_REVIEW_INVALID', '请填写复核结论及原因，最多两千字。');
    const required = ['grain', 'metrics', 'coverage', 'freshness', 'warnings', 'scope'];
    if (body.approved && (!Array.isArray(body.confirmations) || required.some(key => !body.confirmations.includes(key)))) throw biError('ANALYSIS_MODEL_REVIEW_INVALID', '请逐项核对粒度、指标、完整性、新鲜度、警告和共享范围。');
    const checked = await checks.check(row.ownerId, row.modelId, row.checkId);
    const fields = require('./migration').comparisonRequired(row.definition, checked.comparison_json?.migrationComparison, allRequired(row.definition));
    return record(await repository.decide({ userId: user.id, id: reviewId, approved: body.approved, comment: body.comment.trim(), authorize: trx => authorization.authorize(trx, { userId: user.id, definition: row.definition, required: fields }) }));
}

async function changeModelSharing({ user, modelId, body }) {
    const model = await modelForUser(user, modelId, { write: true });
    const share = await proposal(body, user);
    await repository.share({ userId: user.id, modelId, expectedVersion: body.expectedVersion, proposal: share, reviewId: body.reviewId || null,
        authorize: authorize(user, modelId, share.scope === 'personal' ? { nodes: [], relations: [], metrics: [], dimensions: [] } : model.definition_json, { all: true, write: true }) });
    return (await require('./models').getProductionModel(user, modelId)).model;
}

module.exports = { requestModelReview, getModelReview, reviewInbox, decideModelReview, changeModelSharing };
