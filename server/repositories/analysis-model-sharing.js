'use strict';

const crypto = require('node:crypto');
const { transaction, query, queryOne } = require('../db/client');
const models = require('./analysis-production-models');
const authorization = require('./analysis-authorization');
const { allRequired } = require('../services/data-analysis/bi/manifests');
const { canonicalHash } = require('../services/data-analysis/bi/canonical');
const { BI_POLICY } = require('../services/data-analysis/bi/policy');
const { biError } = require('../services/data-analysis/bi/errors');

const warningRulesHash = report => canonicalHash((report.warnings || []).map(item => ({ code: item.code, relationId: item.relationId || null, metricId: item.metricId || null })).sort((a, b) => canonicalHash(a).localeCompare(canonicalHash(b))));

async function get(id, client = { queryOne }) { return client.queryOne('SELECT * FROM analysis_model_reviews WHERE id=?', [id]); }
async function inbox(userId) { return query('SELECT id,model_id,status,created_at,reviewed_at FROM analysis_model_reviews WHERE reviewer_id=? OR owner_id=? ORDER BY created_at DESC LIMIT 100', [userId, userId]); }

async function requireEvidence(trx, { model, semanticHash, warningHash = null, reviewId = model.sharing_review_id, scope, businessOwner = model.business_owner, maintenanceContact = model.maintenance_contact }) {
    const review = reviewId && await get(reviewId, trx);
    const proposed = scope || { scope: model.scope, allowedUnits: model.allowed_units, allowedUserIds: model.allowed_user_ids };
    if (!review || review.model_id !== model.id || Number(review.owner_id) !== Number(model.user_id) || review.status !== 'approved' || review.semantic_hash !== semanticHash || review.rules_hash !== canonicalHash(BI_POLICY) || review.scope_hash !== canonicalHash(proposed) || review.business_owner !== businessOwner || review.maintenance_contact !== maintenanceContact || (warningHash && review.warning_rules_hash !== warningHash)) throw biError('ANALYSIS_MODEL_REVIEW_REQUIRED', '共享范围、口径或警告规则缺少另一位业务人员的有效复核，请在检查页重新发起复核。', 409);
    const checked = await trx.queryOne('SELECT definition_json,comparison_json FROM analysis_data_model_checks WHERE id=?', [review.check_id]);
    const required = require('../services/data-analysis/bi/migration').comparisonRequired(checked.definition_json, checked.comparison_json?.migrationComparison, allRequired(checked.definition_json));
    await authorization.authorize(trx, { userId: review.reviewer_id, definition: checked.definition_json, required });
    return review;
}

async function create({ userId, modelId, expectedVersion, reviewerId, checkId, proposal, businessOwner, maintenanceContact, requestKey, authorize }) {
    const requestHash = canonicalHash({ expectedVersion, reviewerId, checkId, proposal, businessOwner, maintenanceContact });
    return transaction(async trx => {
        await authorization.lockPrincipals(trx, [userId, reviewerId]);
        const current = await authorize(trx);
        const duplicate = await trx.queryOne('SELECT * FROM analysis_model_reviews WHERE model_id=? AND owner_id=? AND request_key=?', [modelId, userId, requestKey]);
        if (duplicate) { if (duplicate.request_hash !== requestHash) throw biError('ANALYSIS_MODEL_REQUEST_CONFLICT', '该幂等标识已用于其他复核请求。', 409); return duplicate; }
        await models.lock(trx, { userId, modelId, expectedVersion });
        const checked = await trx.queryOne("SELECT * FROM analysis_data_model_checks WHERE id=? AND model_id=? AND user_id=? AND status='passed' AND complete", [checkId, modelId, userId]);
        if (!checked || checked.semantic_hash !== current.model.semantic_hash || checked.rules_hash !== canonicalHash(BI_POLICY) || !checked.report_json.fullScan) throw biError('ANALYSIS_MODEL_CHECK_REQUIRED', '请先完成当前草稿检查，再发起共享口径复核。', 409);
        if (Number(reviewerId) === Number(userId)) throw biError('ANALYSIS_MODEL_REVIEWER_INVALID', '共享口径需要由另一位具备来源权限的业务人员复核。');
        const required = require('../services/data-analysis/bi/migration').comparisonRequired(checked.definition_json, checked.comparison_json?.migrationComparison, allRequired(checked.definition_json));
        await authorization.authorize(trx, { userId: reviewerId, definition: checked.definition_json, required });
        const review = await trx.queryOne(`INSERT INTO analysis_model_reviews(id,model_id,check_id,owner_id,reviewer_id,semantic_hash,rules_hash,warning_rules_hash,scope_hash,proposal_json,business_owner,maintenance_contact,request_key,request_hash)
            VALUES (?,?,?,?,?,?,?,?,?,?::jsonb,?,?,?,?) RETURNING *`, [`review_${crypto.randomUUID()}`, modelId, checkId, userId, reviewerId, checked.semantic_hash, checked.rules_hash, warningRulesHash(checked.report_json), canonicalHash(proposal), JSON.stringify(proposal), businessOwner, maintenanceContact, requestKey, requestHash]);
        await models.audit(trx, { userId, modelId, action: 'model_review_requested', details: { reviewId: review.id, reviewerId, semanticHash: checked.semantic_hash } });
        return review;
    });
}

async function decide({ userId, id, approved, comment, authorize }) {
    return transaction(async trx => {
        await authorize(trx);
        const review = await trx.queryOne('SELECT * FROM analysis_model_reviews WHERE id=? AND reviewer_id=? FOR UPDATE', [id, userId]);
        if (!review) throw biError('ANALYSIS_MODEL_REVIEW_NOT_FOUND', '业务复核不存在或无权处理。', 404);
        if (review.status !== 'requested') {
            if ((review.status === 'approved') === approved && review.comment === comment) return review;
            throw biError('ANALYSIS_MODEL_REVIEW_COMPLETED', '业务复核已完成，不能改写证据。', 409);
        }
        const result = await trx.queryOne('UPDATE analysis_model_reviews SET status=?,comment=?,reviewed_at=NOW() WHERE id=? RETURNING *', [approved ? 'approved' : 'rejected', comment, id]);
        await models.audit(trx, { userId, modelId: review.model_id, action: 'model_reviewed', outcome: result.status, details: { reviewId: id, semanticHash: review.semantic_hash } });
        return result;
    });
}

async function share({ userId, modelId, expectedVersion, reviewId, proposal, authorize }) {
    return transaction(async trx => {
        await lockEvidencePrincipals(trx, { userId, modelId, reviewId });
        await authorize(trx);
        const model = await models.lock(trx, { userId, modelId, expectedVersion });
        if (proposal.scope === 'shared') {
            const version = await models.version(modelId, model.published_version, trx);
            if (!version) throw biError('ANALYSIS_MODEL_PUBLISH_REQUIRED', '共享前请先发布完整模型。', 409);
            await requireEvidence(trx, { model, semanticHash: version.semantic_hash, reviewId, scope: proposal });
        }
        await trx.execute('UPDATE analysis_data_models SET scope=?,allowed_units=?,allowed_user_ids=?,sharing_review_id=?,version=version+1,updated_at=NOW() WHERE id=?', [proposal.scope, proposal.allowedUnits, proposal.allowedUserIds, proposal.scope === 'shared' ? reviewId : null, modelId]);
        await models.audit(trx, { userId, modelId, action: 'model_sharing_changed', details: { scope: proposal.scope, scopeHash: canonicalHash(proposal), reviewId: proposal.scope === 'shared' ? reviewId : null } });
    });
}

async function lockEvidencePrincipals(trx, { userId, modelId, reviewId = null }) {
    const initial = await models.get(modelId, trx);
    const selected = reviewId || initial?.sharing_review_id;
    const review = selected && await get(selected, trx);
    await authorization.lockPrincipals(trx, [userId, ...(review ? [review.reviewer_id] : [])]);
    return { initialReviewId: initial?.sharing_review_id || null };
}

module.exports = { get, inbox, create, decide, share, requireEvidence, warningRulesHash, lockEvidencePrincipals };
