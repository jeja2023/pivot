'use strict';

const crypto = require('node:crypto');
const repository = require('../../repositories/policy-reviews');
const sources = require('./sources');
const contract = require('./contract');
const planner = require('./model');
const executions = new Map();

async function modelFor(user, id) {
    const model = await require('../models').getRunnableModelForUserAsync(id, user);
    if (!model || model.secret_error) throw contract.invalid('所选模型不可用或没有使用权限，请重新选择。', 403, 'POLICY_REVIEW_MODEL_UNAVAILABLE');
    if (Number(model.daily_token_limit) > 0 && await require('../models').getModelDailyUsageAsync(user.id, model.id) >= Number(model.daily_token_limit)) throw contract.invalid('所选模型今日用量已达上限。', 429, 'POLICY_REVIEW_BUDGET');
    return model;
}

function summary(row) {
    const result = row.result_json, request = row.input_request;
    return { id: row.id, title: request.title, asOf: request.asOf, status: result.withdrawn ? 'withdrawn' : row.status, version: result.version,
        createdAt: row.created_at, updatedAt: row.updated_at, error: row.error_message || '',
        processed: result.findings?.length || 0, total: request.clauses.length, modelCalls: result.modelCalls || 0,
        usage: result.usage, canResume: !result.withdrawn && ['failed', 'cancelled', 'expired'].includes(row.status) && Number(result.modelCalls || 0) < (request.limits?.modelCalls || 40) };
}

async function assertReviewActive(row, user, signal) {
    signal?.throwIfAborted();
    await sources.assertRequest(row.input_request, user, { enabled: true });
    if (row.input_request.parentRunId) {
        const parent = await repository.parent(user, row.input_request.parentRunId);
        if (!parent || parent.deleted_at || !['queued', 'running', 'planning', 'executing', 'observing', 'resuming', 'verifying'].includes(parent.status)) throw contract.invalid('所属智能体任务已暂停或结束，审查已停止。', 409, 'POLICY_REVIEW_PARENT_STOPPED');
        const config = typeof parent.budget_config === 'string' ? JSON.parse(parent.budget_config || '{}') : parent.budget_config || {};
        const tokenLimit = Math.min(Number(parent.max_token_budget) > 0 ? Number(parent.max_token_budget) : Infinity, Number(config.max_tokens_total) > 0 ? Number(config.max_tokens_total) : Infinity);
        if (Number(parent.total_tokens || 0) >= tokenLimit) throw contract.invalid('所属智能体任务的累计用量已达上限，审查已停止。', 429, 'POLICY_REVIEW_BUDGET');
        const rawStart = String(parent.started_at || '');
        const start = parent.started_at instanceof Date ? parent.started_at.getTime() : rawStart ? Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(rawStart) ? rawStart : rawStart.replace(' ', 'T') + '+08:00') : 0;
        if (start && Date.now() >= start + Number(parent.timeout_ms || 600000)) throw contract.invalid('所属智能体任务已达到原执行期限，审查已停止。', 409, 'POLICY_REVIEW_PARENT_STOPPED');
    }
}

async function run(user, id, deps = {}) {
    if (executions.has(id)) return;
    const lease = crypto.randomUUID();
    if (!await repository.claim(user, id, lease)) return;
    const controller = new AbortController(), signal = controller.signal;
    executions.set(id, controller);
    const heartbeat = setInterval(() => repository.renew(user, id, lease).then(row => { if (!row) controller.abort(); }).catch(error => controller.abort(error)), 15000);
    heartbeat.unref?.();
    let result;
    try {
        const row = await repository.read(user, id);
        if (!row || row.status !== 'working') return;
        result = row.result_json;
        const totalBatches = Math.ceil(row.input_request.clauses.length / contract.BATCH_SIZE);
        for (let index = result.completedBatches || 0; index < totalBatches; index++) {
            await assertReviewActive(row, user, signal);
            if (result.modelCalls >= (row.input_request.limits?.modelCalls || 40) || result.usage.totalTokens >= (row.input_request.limits?.tokens || 2000000)) throw contract.invalid('本次审查已达到累计用量边界，已保留完成结果，请分次创建新审查。', 429, 'POLICY_REVIEW_BUDGET');
            const model = await (deps.modelFor || modelFor)(user, row.input_request.modelId);
            const batch = row.input_request.clauses.slice(index * contract.BATCH_SIZE, (index + 1) * contract.BATCH_SIZE);
            const messages = planner.messages(row.input_request, batch);
            planner.assertContext(model, messages);
            const inputTokens = require('../../llm').estimateTokens(JSON.stringify(messages));
            const outputLimit = Math.min(12000, (row.input_request.limits?.tokens || 2000000) - result.usage.totalTokens - inputTokens);
            if (outputLimit < 1000) throw contract.invalid('剩余用量不足以完整读取材料并生成审查结果，请分次提交。', 429, 'POLICY_REVIEW_BUDGET');
            result.modelCalls++;
            if (!await repository.progress(user, id, lease, result)) throw contract.invalid('审查已停止或执行权已变化。', 409, 'POLICY_REVIEW_STOPPED');
            const response = await (deps.callModel || planner.call)({ modelCfg: model, user, messages, maxTokens: outputLimit, signal,
                budget: deps.budget, runId: row.input_request.parentRunId });
            signal.throwIfAborted();
            result.usage.totalTokens += Math.max(0, Number(response.usage?.totalTokens || 0));
            result.usage.knownCalls += response.usage && !response.usageEstimated ? 1 : 0;
            if (response.budgetExceeded) throw contract.invalid('所属任务累计用量已达上限，已保留原有结果。', 429, 'POLICY_REVIEW_BUDGET');
            const findings = contract.normalizeFindings(planner.parse(response), batch, row.input_request.materials);
            await assertReviewActive(row, user, signal);
            const updates = new Map(result.findings.map(item => [item.id, item]));
            findings.forEach(item => updates.set(item.id, item));
            result.findings = row.input_request.clauses.flatMap(clause => updates.has(clause.id) ? [updates.get(clause.id)] : []); result.completedBatches = index + 1;
            if (!await repository.progress(user, id, lease, result)) throw contract.invalid('审查已停止或执行权已变化。', 409, 'POLICY_REVIEW_STOPPED');
        }
        await assertReviewActive(row, user, signal);
        await repository.progress(user, id, lease, result, 'completed');
    } catch (error) {
        if (result) await repository.progress(user, id, lease, result, 'failed', String(error.code || '').startsWith('POLICY_REVIEW_') || error.code === 'APP_DISABLED'
            ? error.message : '审查服务暂不可用，已保留完成批次，可稍后继续。').catch(() => {});
    } finally {
        clearInterval(heartbeat);
        if (executions.get(id) === controller) executions.delete(id);
    }
}

function schedule(user, id, deps = {}) { setImmediate(() => run(user, id, deps).catch(() => {})); }

async function start(user, input, context = {}, deps = {}) {
    const normalized = contract.normalizeInput(input), prepared = await sources.prepare(user, normalized);
    const parentRunId = context.run?.id || context.runId || '';
    if (parentRunId && !(await repository.parent(user, parentRunId))) throw contract.invalid('所属任务不存在或无权访问。', 403);
    const sourceDigest = contract.digest({ documents: prepared.documents, materials: prepared.materials.map(({ id, digest }) => ({ id, digest })) });
    const { requestKey, materialIds: _materialIds, ...settings } = normalized;
    const request = { ...settings, ...prepared, parentRunId, sourceDigest };
    planner.assertContext(await modelFor(user, normalized.modelId), planner.messages(request, request.clauses.slice(0, contract.BATCH_SIZE)));
    request.requestDigest = contract.digest(request);
    request.limits = { modelCalls: Math.min(40, Number(context.budget?.limits?.max_steps ?? 40) - Number(context.budget?.counts?.steps || 0)),
        tokens: Math.min(2000000, Number(context.budget?.limits?.max_tokens_total ?? 2000000) - Number(context.budget?.counts?.tokens_total || 0)) };
    if (request.limits.modelCalls < 1 || request.limits.tokens < 1000) throw contract.invalid('当前任务剩余用量不足以创建材料审查。', 429, 'POLICY_REVIEW_BUDGET');
    const id = 'policy_review_' + contract.digest([user.id, requestKey]).slice(0, 40);
    const row = await repository.create(user, id, request);
    if (row.status === 'working') (deps.schedule || schedule)(user, id, { budget: context.budget });
    return summary(row);
}

async function get(user, id, { recover = true } = {}) {
    const row = await repository.read(user, id);
    if (!row) return null;
    if (row.result_json.withdrawn) throw contract.invalid('报告已撤回，不能继续读取或下载。', 403, 'POLICY_REVIEW_SOURCE_UNAVAILABLE');
    await sources.assertRequest(row.input_request, user);
    if (row.status === 'working' && new Date(row.expires_at).getTime() <= Date.now()) {
        await repository.expire(user, id);
        return { ...summary({ ...row, status: 'expired' }), error: '审查执行期限已到，可明确选择续跑。',
            documents: row.input_request.documents, materials: row.input_request.materials.map(({ id, title }) => ({ id, title })),
            findings: contract.completeFindings(row.input_request, row.result_json), notes: row.result_json.notes || '', clauses: row.input_request.clauses };
    }
    if (recover && row.status === 'working' && Number(row.result_json._leaseUntil || 0) < Date.now() / 1000) schedule(user, id);
    return { ...summary(row), documents: row.input_request.documents, materials: row.input_request.materials.map(({ id, title }) => ({ id, title })),
        findings: contract.completeFindings(row.input_request, row.result_json), notes: row.result_json.notes || '', clauses: row.input_request.clauses,
        scope: row.input_request.scope };
}

async function page(user, input = {}) {
    const limit = 10, page = Math.max(1, Math.min(100000, Number.parseInt(input.page, 10) || 1));
    const result = await repository.page(user, { limit, offset: (page - 1) * limit });
    return { tasks: result.rows.map(summary), total: result.total, page, limit };
}

async function cancel(user, id) {
    const updated = await repository.cancel(user, id);
    if (updated) executions.get(id)?.abort();
    const row = await repository.read(user, id);
    return row ? { id, status: row.status } : null;
}

async function resume(user, id) {
    const row = await repository.read(user, id);
    if (!row) return null;
    if (row.result_json.withdrawn) throw contract.invalid('报告已撤回，请创建新审查。', 403);
    await assertReviewActive(row, user);
    if (Number(row.result_json.modelCalls || 0) >= (row.input_request.limits?.modelCalls || 40) || Number(row.result_json.usage?.totalTokens || 0) >= (row.input_request.limits?.tokens || 2000000)) throw contract.invalid('本次累计预算已用尽，请分次创建新审查。', 429, 'POLICY_REVIEW_BUDGET');
    await modelFor(user, row.input_request.modelId);
    const updated = await repository.resume(user, id);
    if (!updated) return summary(row);
    schedule(user, id);
    return { id, status: 'working' };
}

async function withdraw(user, id) {
    const row = await repository.withdraw(user, id);
    if (row) executions.get(id)?.abort();
    return row ? { id, status: 'withdrawn' } : null;
}

module.exports = { start, get, page, cancel, resume, withdraw, run, modelFor };
