'use strict';

const crypto = require('node:crypto');
const repository = require('../../../repositories/analysis-operations');
const versions = require('../../../repositories/analysis-production-models');
const { transaction } = require('../../../db/client');
const authorization = require('../../../repositories/analysis-authorization');
const { canonicalHash, canonicalJson } = require('./canonical');
const { normalizeModelQuery } = require('./query-contract');
const { requiredFields } = require('./field-requirements');
const { biError } = require('./errors');
const jobs = require('./jobs');

function invalid(message) { return biError('ANALYSIS_OPERATIONS_INVALID', message); }
async function actors(config) {
    const rows = await repository.principals([config.positiveUserId, config.negativeUserId]);
    const positive = rows.find(row => Number(row.id) === Number(config.positiveUserId)), negative = rows.find(row => Number(row.id) === Number(config.negativeUserId));
    if (!positive || !negative || positive.id === negative.id || rows.some(row => row.status !== 'active' || row.deleted_at || row.role !== 'user' || !row.username.startsWith('bi_probe_') || !row.service_only)) throw invalid('合成监控需要两个独立、有效且禁用交互登录的专用普通账号。');
    return { positive, negative };
}

async function validateContract(config) {
    const principals = await actors(config), version = await versions.version(config.modelId, config.publishedVersion);
    if (!version) throw invalid('合成监控模型的发布版本不存在。');
    const definition = version.definition_json, normalized = normalizeModelQuery({ ...config.query, publishedVersion: config.publishedVersion, requestKey: 'bi_probe_validation' });
    if (normalized.query.dimensions.length || normalized.query.filters.length || normalized.query.metrics.length > 3) throw invalid('合成监控只运行专用数据的至多三个明确总计指标，不接受分组和任意筛选。');
    await transaction(async trx => {
        const current = await authorization.authorize(trx, { userId: principals.positive.id, modelId: config.modelId, definition, required: requiredFields(definition, normalized.query).fields });
        if (Number(current.model.user_id) !== Number(principals.positive.id) || current.model.scope !== 'personal' || Object.values(current.sources).some(source => Number(source.dataset.user_id) !== Number(principals.positive.id) || source.dataset.scope !== 'personal')) throw invalid('合成监控必须绑定正向专用账号拥有的个人模型和专用来源。');
        if (config.sourceIds && canonicalHash([...config.sourceIds].sort()) !== canonicalHash(definition.nodes.map(node => node.datasetId).sort())) throw invalid('合成监控来源范围发生变化，请重新核对合同。');
    });
    return { ...principals, definition, query: normalized.query };
}

async function configureUnlocked(user, input) {
    const actor = await require('./operations').requireOperator(user);
    if (typeof input.enabled !== 'boolean' || Buffer.byteLength(canonicalJson(input)) > 16384 || Object.keys(input).some(key => !['enabled', 'positiveUserId', 'negativeUserId', 'modelId', 'publishedVersion', 'query', 'expectedValues'].includes(key))) throw invalid('合成监控配置无效，请使用完整且受控的专用验收合同。');
    if (!input.enabled) {
        const state = await repository.state();
        if (state.pending_run_id && state.probe_config_json.positiveUserId) await jobs.cancelModelJob({ id: state.probe_config_json.positiveUserId }, state.pending_run_id).catch(() => {});
        await repository.saveProbe({ enabled: false }, actor.id); return { enabled: false };
    }
    const { positive, negative, definition, query } = await validateContract(input);
    const expected = input.expectedValues;
    if (!expected || typeof expected !== 'object' || Array.isArray(expected) || Object.keys(expected).length !== query.metrics.length || query.metrics.some(id => !(id in expected) || expected[id] !== null && (typeof expected[id] !== 'string' || expected[id].length > 200))) throw invalid('请逐项填写监控指标的独立预期值，高精度数值须使用字符串。');
    const config = { enabled: true, positiveUserId: Number(positive.id), negativeUserId: Number(negative.id), modelId: input.modelId, publishedVersion: input.publishedVersion, query,
        sourceIds: definition.nodes.map(node => node.datasetId), expectedHash: canonicalHash(expected) };
    const previous = await repository.state();
    if (previous.pending_run_id && previous.probe_config_json.positiveUserId) await jobs.cancelModelJob({ id: previous.probe_config_json.positiveUserId }, previous.pending_run_id).catch(() => {});
    const result = await repository.saveProbe(config, actor.id);
    return { enabled: true, revision: Number(result.probe_revision), expectedHash: config.expectedHash };
}

async function configure(user, input) { return repository.lockedProbe(() => configureUnlocked(user, input), { required: true }); }

async function negativeDenied(config, negative) {
    try {
        const job = await jobs.createModelQuery({ user: negative, modelId: config.modelId, body: { ...config.query, publishedVersion: config.publishedVersion, requestKey: `probe-deny-${crypto.randomUUID()}` } });
        await jobs.cancelModelJob(negative, job.id, { cause: 'system' });
        return false;
    } catch (error) {
        if ([403, 404].includes(error.status)) return true;
        throw error;
    }
}

async function incident(revision, code, message) {
    await repository.fence(message);
    await repository.updateProbe(revision, { outcome: code, error: message, finished: true });
    await require('../../observability').recordObservabilityEvent({ type: 'system', source: `data-analysis.bi.${code}`, severity: 'critical', message });
    return { outcome: code, accessFenced: true };
}

async function tick() {
    return repository.lockedProbe(async () => {
        const state = await repository.state(), config = state.probe_config_json;
        if (!config.enabled) return { disabled: true };
        try {
            const { negative } = await actors(config);
            if (!await negativeDenied(config, negative)) return incident(state.probe_revision, 'security_failed', '数据建模反向合成监控意外获得分析权限，已暂停业务路径，请立即核查授权。');
            const { positive } = await validateContract(config);
            if (state.pending_run_id) {
                const job = await jobs.getModelJob(positive, state.pending_run_id);
                if (['queued', 'running', 'retry_wait', 'cancelling'].includes(job.status)) {
                    if (Date.now() - new Date(state.probe_started_at).getTime() > 90000) {
                        await jobs.cancelModelJob(positive, job.id, { cause: 'system' });
                        await repository.updateProbe(state.probe_revision, { outcome: 'failed', error: '合成监控任务超过九十秒。', finished: true });
                        return { outcome: 'failed' };
                    }
                    return { outcome: 'running', jobId: job.id };
                }
                if (job.status !== 'succeeded') { await repository.updateProbe(state.probe_revision, { outcome: 'failed', error: '合成监控任务未完成执行合同。', finished: true }); return { outcome: 'failed' }; }
                const values = Object.fromEntries(config.query.metrics.map(id => [id, job.result?.total?.values?.[id]?.value ?? null]));
                if (canonicalHash(values) !== config.expectedHash) return incident(state.probe_revision, 'statistics_failed', '数据建模正向合成监控与独立预期值不一致，已暂停业务路径，请核对统计口径和执行器。');
                await repository.updateProbe(state.probe_revision, { outcome: 'succeeded', finished: true });
                // 成功读取后立即登记下一轮，避免一分钟调度变成两分钟才提交一次探针。
            } else if (state.probe_started_at && Date.now() - new Date(state.probe_started_at).getTime() < 55000) return { outcome: state.probe_outcome };
            const job = await jobs.createModelQuery({ user: positive, modelId: config.modelId, body: { ...config.query, publishedVersion: config.publishedVersion, requestKey: `probe-${state.probe_revision}-${Math.floor(Date.now() / 60000)}` } });
            await repository.updateProbe(state.probe_revision, { jobId: job.id, outcome: state.pending_run_id ? 'succeeded' : 'running', started: true });
            return { outcome: 'running', jobId: job.id };
        } catch (error) {
            await repository.updateProbe(state.probe_revision, { outcome: 'failed', error: error.code === 'ANALYSIS_OPERATIONS_INVALID' ? error.message : '合成监控执行或授权检查失败，请核对专用账号和模型状态。', finished: true });
            return { outcome: 'failed', code: error.code };
        }
    });
}

async function bootstrapUnlocked(user) {
    const actor = await require('./operations').requireOperator(user), existing = await repository.state();
    if (existing.probe_config_json.enabled) { await validateContract(existing.probe_config_json); return { configured: true, modelId: existing.probe_config_json.modelId }; }
    const [positive, negative] = await repository.createProbePrincipals();
    const fact = await require('../datasets').createDatasetFromRows({ user: positive, name: 'BI 专用合成监控数据', rows: [{ 编号: '01', 金额: '100.25' }, { 编号: '02', 金额: '99.75' }, { 编号: '03', 金额: '50.00' }] });
    let model = await require('../semantic-models').saveDataModel({ user: positive, body: { modelKind: 'production', name: 'BI 专用合成监控模型', factDatasetId: fact.id, businessOwner: '系统运行监测', maintenanceContact: actor.username } });
    model = await require('./models').saveProductionDraft({ user: positive, modelId: model.id, body: { expectedVersion: model.version, definition: { ...model.definition, grainDescription: '每条验收金额记录', nodes: [{ ...model.definition.nodes[0], grainKeys: ['c_1'] }], metrics: [{ id: 'amount', type: 'sum', field: { nodeId: 'fact', fieldKey: 'c_2' }, currency: 'CNY' }, { id: 'rows', type: 'count' }] } } });
    const created = await jobs.createModelCheck({ user: positive, modelId: model.id, body: { expectedVersion: model.version, requestKey: crypto.randomUUID() } });
    await require('./runner').processModelJobs();
    const checked = await jobs.getModelCheck(positive, model.id, created.check.id);
    if (checked.status !== 'passed') throw invalid('专用合成监控模型检查未完成，请检查隔离执行器后重试配置。');
    await jobs.publishModel({ user: positive, modelId: model.id, body: { expectedVersion: model.version, checkId: checked.id, requestKey: crypto.randomUUID() } });
    await configureUnlocked(actor, { enabled: true, positiveUserId: positive.id, negativeUserId: negative.id, modelId: model.id, publishedVersion: 1, query: { dimensions: [], metrics: ['amount', 'rows'] }, expectedValues: { amount: '250.00', rows: '3' } });
    return { configured: true, modelId: model.id, positiveUserId: positive.id, negativeUserId: negative.id, credentialsIssued: false };
}

async function bootstrap(user) { return repository.lockedProbe(() => bootstrapUnlocked(user), { required: true }); }

module.exports = { configure, tick, bootstrap };
