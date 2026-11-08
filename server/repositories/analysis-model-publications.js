'use strict';

const { transaction, queryOne, query } = require('../db/client');
const models = require('./analysis-production-models');
const { biError } = require('../services/data-analysis/bi/errors');
const { canonicalHash } = require('../services/data-analysis/bi/canonical');
const { BI_POLICY } = require('../services/data-analysis/bi/policy');

async function publish({ userId, modelId, expectedVersion, checkId, requestKey, warningAcceptance = [], reviewId = null, authorize }) {
    const requestHash = canonicalHash({ expectedVersion, checkId, warningAcceptance, reviewId });
    return transaction(async trx => {
        await require('./analysis-release-controls').assertAllowed(trx, 'publish');
        const sharing = require('./analysis-model-sharing');
        const { initialReviewId } = await sharing.lockEvidencePrincipals(trx, { userId, modelId, reviewId });
        const current = await authorize(trx);
        const row = await trx.queryOne("SELECT * FROM analysis_data_models WHERE id=? AND user_id=? AND model_kind='production' AND deleted_at IS NULL FOR UPDATE", [modelId, userId]);
        if (!row) throw biError('ANALYSIS_MODEL_NOT_FOUND', '模型不存在或无权发布。', 404);
        const duplicate = await trx.queryOne('SELECT * FROM analysis_data_model_versions WHERE model_id=? AND request_key=?', [modelId, requestKey]);
        if (duplicate) {
            if (duplicate.request_hash !== requestHash) throw biError('ANALYSIS_MODEL_REQUEST_CONFLICT', '同一幂等标识已经用于其他发布内容。', 409);
            return duplicate;
        }
        if (!Number.isSafeInteger(expectedVersion) || Number(row.version) !== expectedVersion) throw biError('ANALYSIS_MODEL_VERSION_CONFLICT', '草稿已变化，请重新保存并检查。', 409);
        if (row.archived_at) throw biError('ANALYSIS_MODEL_ARCHIVED', '模型已归档，请恢复后再发布。', 409);
        const checked = await trx.queryOne("SELECT * FROM analysis_data_model_checks WHERE id=? AND model_id=? AND user_id=? AND status='passed' AND complete AND manifest_id IS NOT NULL", [checkId, modelId, userId]);
        if (!checked || checked.semantic_hash !== row.semantic_hash || Number(checked.draft_revision) !== expectedVersion) throw biError('ANALYSIS_MODEL_CHECK_REQUIRED', '当前草稿缺少对应的完整检查，请重新检查后发布。', 409);
        const report = checked.report_json;
        const origin = !row.published_version && await require('./analysis-model-origins').get(modelId, trx);
        if (origin && (!report.migrationComparison?.complete || report.migrationComparison.snapshotHash !== origin.snapshot_hash)) throw biError('ANALYSIS_MODEL_MIGRATION_CHECK_REQUIRED', '首次发布必须完成同一固定来源的旧探索对照，请选择维度与基础指标后重新检查。', 409);
        if (!report.fullScan || report.semanticHash !== row.semantic_hash || checked.rules_hash !== canonicalHash(BI_POLICY) || report.blockers?.length) throw biError('ANALYSIS_MODEL_CHECK_REQUIRED', '检查报告不完整、规则版本不兼容或存在阻断项，请重新检查。', 409);
        const warningKey = issue => canonicalHash({ code: issue.code, relationId: issue.relationId || null, metricId: issue.metricId || null });
        const acknowledgements = new Map(warningAcceptance.map(item => [warningKey(item), item]));
        if (acknowledgements.size !== warningAcceptance.length || acknowledgements.size !== (report.warnings || []).length || (report.warnings || []).some(issue => !acknowledgements.get(warningKey(issue))?.reason?.trim())) throw biError('ANALYSIS_MODEL_WARNINGS_UNACCEPTED', '请逐项确认本次数据版本的警告，并填写接受原因。', 409);
        const ready = await trx.queryOne(`SELECT COUNT(*) AS total,COUNT(*) FILTER(WHERE o.state='ready') AS ready FROM analysis_source_manifest_members m JOIN analysis_data_objects o ON o.id=m.object_id WHERE m.manifest_id=?`, [checked.manifest_id]);
        if (Number(ready.total) !== checked.definition_json.nodes.length || Number(ready.ready) !== Number(ready.total)) throw biError('ANALYSIS_OBJECT_NOT_READY', '检查绑定的数据对象已不可用，请重新检查。', 409);
        if (!row.business_owner || !row.maintenance_contact) throw biError('ANALYSIS_MODEL_CONTACT_REQUIRED', '请先在模型信息中填写业务负责人和维护联系人，再发布。', 409);
        if (!reviewId && (row.sharing_review_id || null) !== initialReviewId) throw biError('ANALYSIS_MODEL_VERSION_CONFLICT', '共享复核记录已变化，请重新加载后发布。', 409);
        const review = row.scope === 'shared' ? await sharing.requireEvidence(trx, { model: row, semanticHash: row.semantic_hash, warningHash: sharing.warningRulesHash(report), reviewId: reviewId || row.sharing_review_id }) : null;
        const next = await trx.queryOne('SELECT COALESCE(MAX(version),0)+1 AS next FROM analysis_data_model_versions WHERE model_id=?', [modelId]);
        const version = await trx.queryOne(`INSERT INTO analysis_data_model_versions(model_id,version,definition_json,semantic_hash,policy_json,published_by,request_key,request_hash,warning_acceptance_json,review_json)
            VALUES (?,?,?::jsonb,?,?::jsonb,?,?,?,?::jsonb,?::jsonb) RETURNING *`, [modelId, next.next, JSON.stringify(checked.definition_json), row.semantic_hash, JSON.stringify(BI_POLICY), userId, requestKey, requestHash,
            JSON.stringify(warningAcceptance.map(item => ({ ...item, acceptedBy: userId, checkId, manifestId: checked.manifest_id }))), JSON.stringify({ businessOwner: row.business_owner, maintenanceContact: row.maintenance_contact,
                evidence: review && { id: review.id, reviewerId: Number(review.reviewer_id), semanticHash: review.semantic_hash, rulesHash: review.rules_hash, warningRulesHash: review.warning_rules_hash, scopeHash: review.scope_hash, reviewedAt: review.reviewed_at } })]);
        await trx.execute('INSERT INTO analysis_model_data_bindings(model_id,published_version,manifest_id,check_id) VALUES (?,?,?,?)', [modelId, version.version, checked.manifest_id, checkId]);
        await trx.execute('UPDATE analysis_data_models SET published_version=?,sharing_review_id=COALESCE(?,sharing_review_id),updated_at=NOW() WHERE id=?', [version.version, review?.id || null, modelId]);
        await models.audit(trx, { userId, modelId, version: version.version, action: 'model_published', details: { semanticHash: row.semantic_hash, checkId, manifestId: checked.manifest_id, authorizationHash: current.authorizationHash } });
        return version;
    });
}

async function binding(modelId, version) { return queryOne('SELECT * FROM analysis_model_data_bindings WHERE model_id=? AND published_version=?', [modelId, version]); }
async function history(modelId) { return query('SELECT model_id,version,semantic_hash,published_by,created_at,definition_json,review_json FROM analysis_data_model_versions WHERE model_id=? ORDER BY version DESC', [modelId]); }

async function resolveQueryManifest(trx, { modelId, publishedVersion, semanticHash, definition, sources, binding: strategy, maxStaleness }) {
    const binding = await trx.queryOne('SELECT * FROM analysis_model_data_bindings WHERE model_id=? AND published_version=? FOR SHARE', [modelId, publishedVersion]);
    if (strategy.strategy !== 'historical' && binding?.data_state === 'source_unavailable') throw biError('ANALYSIS_MODEL_SOURCE_UNAVAILABLE', '来源完整性异常，已停止新分析；请联系维护者恢复或重新检查来源。', 409);
    const selected = strategy.strategy === 'historical' ? strategy.manifestId : binding?.manifest_id;
    const checked = selected && await trx.queryOne("SELECT id FROM analysis_data_model_checks WHERE model_id=? AND semantic_hash=? AND manifest_id=? AND status='passed' AND complete AND rules_hash=?", [modelId, semanticHash, selected, canonicalHash(BI_POLICY)]);
    if (!checked) throw biError('ANALYSIS_MODEL_CHECK_REQUIRED', '当前数据清单缺少完整检查，请先检查新数据。', 409);
    const manifest = await trx.queryOne('SELECT *,EXTRACT(EPOCH FROM NOW()) AS database_now FROM analysis_source_manifests WHERE id=?', [selected]);
    if (strategy.strategy !== 'historical') for (const member of manifest?.manifest_json?.members || []) if (require('../services/data-analysis/bi/source-contract').contractHash(definition, member.nodeId, sources[member.nodeId]) !== member.semanticSourceHash) throw biError('ANALYSIS_MODEL_SOURCE_SEMANTICS_CHANGED', '来源计算口径发生变化，请由维护者确认差异并重新发布。原有历史结果仍须按当前权限查看。', 409);
    const oldest = Math.min(...(manifest?.manifest_json?.members || []).map(member => Date.parse(member.watermark.updatedAt)));
    if (!Number.isFinite(oldest) || Number(manifest.database_now) * 1000 - oldest > maxStaleness * 1000) throw biError('ANALYSIS_MODEL_DATA_STALE', '数据已超过模型允许的陈旧时间，请检查刷新后再计算；可明确选择查看已有历史结果。', 409);
    return selected;
}

async function refreshFailed(trx, job, code) {
    await trx.execute("UPDATE analysis_model_data_bindings SET data_state='refresh_failed',last_refresh_error=?,updated_at=NOW() WHERE model_id=? AND published_version=? AND revision=?", [code, job.model_id, job.published_version, job.binding_revision]);
}

async function activateRefresh(trx, job, report) {
    const binding = await trx.queryOne('SELECT * FROM analysis_model_data_bindings WHERE model_id=? AND published_version=? FOR UPDATE', [job.model_id, job.published_version]);
    if (!binding || Number(binding.revision) !== Number(job.binding_revision)) throw biError('ANALYSIS_MODEL_BINDING_CONFLICT', '刷新依据的数据绑定已变化，候选清单未启用。', 409);
    if (!report?.passed || !report.complete || !report.fullScan) { await refreshFailed(trx, job, 'ANALYSIS_MODEL_CHECK_FAILED'); return; }
    const version = await models.version(job.model_id, job.published_version, trx);
    const warningKey = issue => canonicalHash({ code: issue.code, relationId: issue.relationId || null, metricId: issue.metricId || null });
    const accepted = new Set(version.warning_acceptance_json.map(warningKey));
    if ((report.warnings || []).some(issue => !accepted.has(warningKey(issue)))) throw biError('ANALYSIS_MODEL_WARNING_RULE_CHANGED', '候选清单出现未接受的质量警告，请核对影响并重新发布规则后刷新。', 409);
    const previous = (await trx.queryOne('SELECT manifest_json FROM analysis_source_manifests WHERE id=?', [binding.manifest_id])).manifest_json;
    const candidate = (await trx.queryOne('SELECT manifest_json FROM analysis_source_manifests WHERE id=?', [job.manifest_id])).manifest_json;
    for (const before of previous.members) {
        const after = candidate.members.find(item => item.nodeId === before.nodeId);
        if (!after || !before.semanticSourceHash || after.semanticSourceHash !== before.semanticSourceHash) throw biError('ANALYSIS_MODEL_SOURCE_SEMANTICS_CHANGED', '字段逻辑类型、单位、币种或关联键含义已变化，请维护草稿并重新发布口径。', 409);
        if (!Number.isFinite(Date.parse(after.watermark.updatedAt)) || Date.parse(after.watermark.updatedAt) < Date.parse(before.watermark.updatedAt)) throw biError('ANALYSIS_MODEL_WATERMARK_REGRESSION', '候选数据截止时间早于已启用数据，刷新未切换。', 409);
    }
    await trx.execute("UPDATE analysis_model_data_bindings SET manifest_id=?,check_id=?,revision=revision+1,data_state='available',last_refresh_error='',updated_at=NOW() WHERE model_id=? AND published_version=? AND revision=?", [job.manifest_id, job.check_id, job.model_id, job.published_version, job.binding_revision]);
    await models.audit(trx, { userId: job.user_id, modelId: job.model_id, version: job.published_version, runId: job.id, action: 'model_data_refreshed', details: { previousManifestId: binding.manifest_id, manifestId: job.manifest_id, revision: Number(binding.revision) + 1 } });
}

async function rollback({ userId, modelId, expectedVersion, version, authorize }) {
    return transaction(async trx => {
        await require('./analysis-release-controls').assertAllowed(trx, 'publish');
        const sharing = require('./analysis-model-sharing');
        const { initialReviewId } = await sharing.lockEvidencePrincipals(trx, { userId, modelId });
        const model = await models.lock(trx, { userId, modelId, expectedVersion });
        if ((model.sharing_review_id || null) !== initialReviewId) throw biError('ANALYSIS_MODEL_VERSION_CONFLICT', '共享复核记录已变化，请重新加载后回滚。', 409);
        await authorize(trx);
        const selected = await models.version(modelId, version, trx);
        if (!selected) throw biError('ANALYSIS_MODEL_VERSION_NOT_FOUND', '回滚目标版本不存在。', 404);
        if (model.scope === 'shared') await sharing.requireEvidence(trx, { model, semanticHash: selected.semantic_hash });
        await trx.execute('UPDATE analysis_data_models SET published_version=?,version=version+1,updated_at=NOW() WHERE id=?', [version, modelId]);
        await models.audit(trx, { userId, modelId, version, action: 'model_version_selected' });
        return selected;
    });
}

module.exports = { publish, binding, history, resolveQueryManifest, activateRefresh, refreshFailed, rollback };
