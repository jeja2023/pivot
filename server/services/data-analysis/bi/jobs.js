'use strict';

const { readTypedEnv } = require('../../../config/env-registry');
const { transaction } = require('../../../db/client');
const repository = require('../../../repositories/analysis-model-jobs');
const modelRepository = require('../../../repositories/analysis-production-models');
const publicationRepository = require('../../../repositories/analysis-model-publications');
const authorization = require('../../../repositories/analysis-authorization');
const objectRepository = require('../../../repositories/analysis-objects');
const { modelForUser, requiredFields } = require('./access');
const { allRequired } = require('./manifests');
const { normalizeModelDefinition } = require('./definition');
const { normalizeModelQuery, requestKey } = require('./query-contract');
const { canonicalHash } = require('./canonical');
const { BI_POLICY } = require('./policy');
const { biError } = require('./errors');
const { jsonParse } = require('../shared');
const { ensureReady } = require('./readiness');
const { protect } = require('./delivery');

async function requireModelExecutionReady() {
    if (!readTypedEnv('DATA_ANALYSIS_MODEL_ENABLED')) throw biError('ANALYSIS_MODEL_RUNTIME_UNREADY', '数据建模执行服务尚未完成就绪检查，请联系维护者配置隔离执行器。草稿仍可保存。', 503);
    await ensureReady();
}
function authorize(user, modelId, definition, { all = false, query = null, write = false, comparison = null } = {}) {
    const required = all ? allRequired(definition) : requiredFields(definition, query).fields;
    require('./migration').comparisonRequired(definition, comparison, required);
    return trx => authorization.authorize(trx, { userId: user.id, modelId, definition, required, write });
}
function checkRecord(row) { return { id: row.id, modelId: row.model_id, status: row.status, complete: row.complete, semanticHash: row.semantic_hash, manifestId: row.manifest_id, report: jsonParse(row.report_json, {}), createdAt: row.created_at, completedAt: row.completed_at, draftRevision: Number(row.draft_revision) }; }
function jobRecord(row) { return { id: row.id, modelId: row.model_id, executionKind: row.execution_kind, publishedVersion: row.published_version === null ? null : Number(row.published_version), manifestId: row.manifest_id, status: row.status, progress: Number(row.progress), attempts: Number(row.attempts), lastError: row.last_error,
    createdAt: row.created_at, startedAt: row.started_at, completedAt: row.completed_at, executionMetrics: row.execution_metrics_json || {}, resultExpired: Boolean(row.result_metadata_json?.resultExpired), result: row.result_metadata_json?.resultExpired ? null : row.status === 'succeeded' && !row.check_id ? jsonParse(row.result_metadata_json, {}) : row.status === 'succeeded' && row.execution_kind === 'model_trial' ? jsonParse(row.result_metadata_json, {}) : null }; }

async function createModelCheck({ user, modelId, body }) {
    await requireModelExecutionReady();
    const model = await modelForUser(user, modelId, { write: true });
    const { definition, semanticHash } = normalizeModelDefinition(jsonParse(model.definition_json, {}));
    const key = requestKey(body.requestKey);
    if (!Number.isSafeInteger(body.expectedVersion) || body.expectedVersion !== Number(model.version)) throw biError('ANALYSIS_MODEL_VERSION_CONFLICT', '草稿修订已变化，请重新加载后检查。', 409);
    const rulesHash = canonicalHash(BI_POLICY);
    const comparison = await require('./migration').comparisonRequest(model, definition, body.migrationComparison);
    const job = await repository.admit({ userId: user.id, modelId, kind: 'model_check', expectedVersion: body.expectedVersion, definition, semanticHash, rulesHash,
        query: comparison ? { migrationComparison: comparison } : {}, requestKey: key, requestHash: canonicalHash({ expectedVersion: body.expectedVersion, semanticHash, rulesHash, comparison }), authorize: authorize(user, modelId, definition, { all: true, write: true, comparison }) });
    return { check: checkRecord(await repository.check(user.id, modelId, job.check_id)), job: jobRecord(job) };
}

async function getModelCheck(user, modelId, checkId) {
    await modelForUser(user, modelId, { write: true });
    const checked = await repository.check(user.id, modelId, checkId);
    if (!checked) throw biError('ANALYSIS_MODEL_CHECK_NOT_FOUND', '模型检查不存在或无权访问。', 404);
    await transaction(authorize(user, modelId, checked.definition_json, { all: true, write: true, comparison: checked.comparison_json?.migrationComparison }));
    const required = require('./migration').comparisonRequired(checked.definition_json, checked.comparison_json?.migrationComparison, allRequired(checked.definition_json));
    return protect(checkRecord(checked), { userId: user.id, modelId, definition: checked.definition_json, required,
        beforeSend: (_trx, current) => { if (Number(current.model.user_id) !== Number(user.id)) throw biError('ANALYSIS_MODEL_CHECK_NOT_FOUND', '模型检查不存在或无权访问。', 404); } });
}

async function publishModel({ user, modelId, body }) {
    const model = await modelForUser(user, modelId, { write: true });
    const { definition } = normalizeModelDefinition(jsonParse(model.definition_json, {}));
    if (!Array.isArray(body.warningAcceptance || []) || (body.warningAcceptance || []).some(item => typeof item.reason !== 'string' || !item.reason.trim() || item.reason.length > 1000)) throw biError('ANALYSIS_MODEL_WARNINGS_UNACCEPTED', '警告确认须包含有效的接受原因。');
    const checked = await repository.check(user.id, modelId, body.checkId);
    const version = await publicationRepository.publish({ userId: user.id, modelId, expectedVersion: body.expectedVersion, checkId: body.checkId, requestKey: requestKey(body.requestKey), reviewId: body.reviewId || null, warningAcceptance: body.warningAcceptance || [], authorize: authorize(user, modelId, definition, { all: true, write: true, comparison: checked?.comparison_json?.migrationComparison }) });
    return { modelId, version: Number(version.version), semanticHash: version.semantic_hash, publishedAt: version.created_at };
}

async function createModelRefresh({ user, modelId, body }) {
    await requireModelExecutionReady();
    await modelForUser(user, modelId, { write: true });
    if (!Number.isSafeInteger(body.publishedVersion) || !Number.isSafeInteger(body.bindingRevision)) throw biError('ANALYSIS_MODEL_INPUT_INVALID', '刷新需要指定发布版本和当前数据绑定修订。');
    const version = await modelRepository.version(modelId, body.publishedVersion);
    if (!version) throw biError('ANALYSIS_MODEL_VERSION_NOT_FOUND', '模型发布版本不存在。', 404);
    const { definition, semanticHash } = normalizeModelDefinition(version.definition_json);
    const rulesHash = canonicalHash(BI_POLICY);
    const job = await repository.admit({ userId: user.id, modelId, kind: 'model_refresh', publishedVersion: body.publishedVersion, bindingRevision: body.bindingRevision,
        definition, semanticHash, rulesHash, requestKey: requestKey(body.requestKey), requestHash: canonicalHash({ publishedVersion: body.publishedVersion, bindingRevision: body.bindingRevision, semanticHash, rulesHash }),
        authorize: authorize(user, modelId, definition, { all: true, write: true }) });
    return { job: jobRecord(job), check: checkRecord(await repository.check(user.id, modelId, job.check_id)) };
}

async function createModelQuery({ user, modelId, body, trial = false }) {
    await requireModelExecutionReady();
    const model = await modelForUser(user, modelId, { write: trial });
    const normalized = normalizeModelQuery(body, { trial });
    let definition, semanticHash, manifestId, resolveInput = null, checkId = null;
    if (trial) {
        const checked = await repository.check(user.id, modelId, normalized.checkId);
        if (!checked || checked.status !== 'passed' || !checked.complete || checked.semantic_hash !== model.semantic_hash || Number(checked.draft_revision) !== normalized.expectedVersion) throw biError('ANALYSIS_MODEL_CHECK_REQUIRED', '草稿试算需要对应当前修订的完整检查。', 409);
        definition = checked.definition_json; semanticHash = checked.semantic_hash; manifestId = checked.manifest_id; checkId = checked.id;
    } else {
        const published = await modelRepository.version(modelId, normalized.publishedVersion);
        if (!published) throw biError('ANALYSIS_MODEL_VERSION_NOT_FOUND', '模型发布版本不存在或已不再保留。', 404);
        const validated = normalizeModelDefinition(published.definition_json);
        definition = validated.definition; semanticHash = validated.semanticHash;
        resolveInput = (trx, current) => publicationRepository.resolveQueryManifest(trx, { modelId, publishedVersion: normalized.publishedVersion, semanticHash, definition, sources: current.sources, binding: normalized.binding, maxStaleness: definition.maxStaleness });
    }
    const currentSources = await transaction(authorize(user, modelId, definition, { query: normalized.query }));
    const { compileModelQuery } = require('./query');
    compileModelQuery(definition, normalized.query, Object.fromEntries(Object.entries(currentSources.sources).map(([id, source], index) => [id, { tableName: `bi_input_${index}`, columns: source.columns }])));
    const job = await repository.admit({ userId: user.id, modelId, kind: trial ? 'model_trial' : 'model_query', expectedVersion: trial ? normalized.expectedVersion : null, publishedVersion: trial ? null : normalized.publishedVersion,
        manifestId, resolveInput, checkId, query: normalized.query, requestKey: normalized.requestKey, requestHash: canonicalHash({ request: normalized.requestHash, semanticHash }), authorize: authorize(user, modelId, definition, { query: normalized.query, write: trial }) });
    return getModelJob(user, job.id);
}

async function getModelJob(user, jobId) {
    const row = await repository.get(user.id, jobId);
    if (!row) throw biError('ANALYSIS_MODEL_JOB_NOT_FOUND', '分析任务不存在或无权访问。', 404);
    if (require('./flow-pipeline').isNodeJob(row)) return require('./flow-pipeline').getNodeJob(user, row);
    await modelForUser(user, row.model_id);
    let definition;
    if (row.check_id) definition = (await repository.check(user.id, row.model_id, row.check_id)).definition_json;
    else definition = (await modelRepository.version(row.model_id, row.published_version)).definition_json;
    const options = { all: ['model_check', 'model_refresh'].includes(row.execution_kind), query: ['model_query', 'model_trial', 'model_export'].includes(row.execution_kind) ? row.query_ast_json : null, comparison: row.query_ast_json?.migrationComparison };
    await transaction(authorize(user, row.model_id, definition, options));
    if (row.manifest_id) {
        const manifests = require('../../../repositories/analysis-manifests');
        const manifest = await manifests.get(row.manifest_id), members = manifest && await manifests.members(row.manifest_id);
        if (!manifest || canonicalHash(manifest.manifest_json) !== manifest.manifest_hash || members.length !== definition.nodes.length || members.some(member => member.object_state !== 'ready')) throw biError('ANALYSIS_MODEL_SOURCE_UNAVAILABLE', '来源完整性异常，已暂停此运行的读取；请联系维护者恢复或重新检查来源。', 409);
    }
    if (row.result_object_id && !row.result_metadata_json?.resultExpired) {
        const object = await objectRepository.get(row.result_object_id);
        if (object?.state !== 'ready') throw biError('ANALYSIS_MODEL_RESULT_UNAVAILABLE', '运行结果文件已不可用，请重新计算。', 409);
    }
    const required = options.all ? allRequired(definition) : requiredFields(definition, options.query).fields;
    require('./migration').comparisonRequired(definition, options.comparison, required);
    return protect(jobRecord(row), { userId: user.id, modelId: row.model_id, definition, required,
        beforeSend: trx => require('../../../repositories/analysis-authorized-delivery').job(trx, row, definition.nodes.length) });
}

async function cancelModelJob(user, jobId, options) { await getModelJob(user, jobId); await repository.cancel(user.id, jobId, options); return getModelJob(user, jobId); }

async function submitModelQuery(options) {
    const job = await createModelQuery(options);
    if (options.body.execution === 'async' || !['queued', 'running', 'retry_wait'].includes(job.status)) return job;
    const until = Date.now() + 2000;
    void require('./runner').processModelJobs().catch(() => {});
    while (Date.now() < until) {
        await new Promise(resolve => setTimeout(resolve, Math.min(100, until - Date.now())));
        const current = await getModelJob(options.user, job.id);
        if (!['queued', 'running', 'retry_wait'].includes(current.status)) return current;
    }
    return getModelJob(options.user, job.id);
}

module.exports = { createModelCheck, getModelCheck, publishModel, createModelRefresh, createModelQuery, submitModelQuery, getModelJob, cancelModelJob, authorize, jobRecord };
