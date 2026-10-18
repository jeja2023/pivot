'use strict';

const crypto = require('crypto');
const { normalizeTaskContract } = require('./agent-verification');

const TRANSACTION_STATUSES = Object.freeze(new Set([
    'draft', 'planned', 'executing', 'verifying', 'awaiting_commit', 'committed',
    'compensating', 'rolled_back', 'partial', 'needs_input', 'failed', 'cancelled'
]));
const EFFECT_STATUSES = Object.freeze(new Set(['planned', 'staged', 'executing', 'committed', 'compensation_pending', 'compensated', 'failed', 'cancelled']));
const COMMIT_MODES = Object.freeze(new Set(['preview', 'after_verify', 'manual', 'irreversible']));
const TRANSACTION_TRANSITIONS = Object.freeze({
    draft: new Set(['planned', 'cancelled']),
    planned: new Set(['executing', 'cancelled', 'needs_input']),
    executing: new Set(['verifying', 'compensating', 'partial', 'needs_input', 'failed', 'cancelled']),
    verifying: new Set(['awaiting_commit', 'compensating', 'partial', 'needs_input', 'failed']),
    awaiting_commit: new Set(['committed', 'compensating', 'needs_input', 'cancelled']),
    compensating: new Set(['rolled_back', 'partial', 'needs_input', 'failed']),
    committed: new Set(), rolled_back: new Set(), partial: new Set(), needs_input: new Set(), failed: new Set(), cancelled: new Set()
});

function transactionError(message, code = 'AGENT_TASK_TRANSACTION_INVALID', status = 400) {
    const error = new Error(message);
    error.code = code;
    error.status = status;
    error.statusCode = status;
    return error;
}

function text(value, max = 255) { return String(value ?? '').trim().slice(0, max); }

function normalizeResourceKeys(value) {
    const source = Array.isArray(value) ? value : [];
    return [...new Set(source.map(item => text(item, 255)).filter(Boolean))].slice(0, 32);
}

function normalizeCompensation(value = {}) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const mode = ['automatic', 'manual', 'none'].includes(String(source.mode || 'none')) ? String(source.mode || 'none') : 'none';
    return {
        mode,
        action: text(source.action || '', 120),
        instructions: text(source.instructions || '', 2000),
        required: source.required === true || mode !== 'none'
    };
}

function normalizeEffectPlan(value = {}) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const effectType = text(source.effectType || source.effect_type, 96);
    if (!effectType) throw transactionError('副作用计划必须声明 effectType。', 'AGENT_TASK_EFFECT_TYPE_REQUIRED');
    const commitMode = String(source.commitMode || source.commit_mode || 'after_verify');
    if (!COMMIT_MODES.has(commitMode)) throw transactionError('副作用提交模式无效。', 'AGENT_TASK_EFFECT_COMMIT_MODE_INVALID');
    const idempotencyKey = text(source.idempotencyKey || source.idempotency_key, 255);
    if (!idempotencyKey) throw transactionError('副作用计划必须声明 idempotencyKey。', 'AGENT_TASK_EFFECT_IDEMPOTENCY_REQUIRED');
    const compensation = normalizeCompensation(source.compensation);
    if (commitMode === 'irreversible' && compensation.mode === 'automatic') {
        throw transactionError('不可逆副作用不能标记为自动补偿。', 'AGENT_TASK_EFFECT_COMPENSATION_INVALID');
    }
    return { effectType, resourceKeys: normalizeResourceKeys(source.resourceKeys || source.resource_keys), idempotencyKey, commitMode, compensation };
}

function normalizeTaskTransaction(value = {}, goal = '') {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const taskContract = normalizeTaskContract(source.taskContract || source.task_contract || {}, goal);
    const status = TRANSACTION_STATUSES.has(String(source.status || 'draft')) ? String(source.status || 'draft') : 'draft';
    return {
        version: 1,
        id: text(source.id || '', 64),
        status,
        taskContract,
        workspaceSnapshot: source.workspaceSnapshot && typeof source.workspaceSnapshot === 'object' ? source.workspaceSnapshot : {},
        effects: (Array.isArray(source.effects) ? source.effects : []).slice(0, 64).map(normalizeEffectPlan),
        verification: source.verification && typeof source.verification === 'object' ? source.verification : {},
        commitEvidence: source.commitEvidence && typeof source.commitEvidence === 'object' ? source.commitEvidence : {}
    };
}

function assertTransactionTransition(from, to) {
    const current = String(from || 'draft');
    const target = String(to || '');
    if (!TRANSACTION_STATUSES.has(current) || !TRANSACTION_STATUSES.has(target) || !TRANSACTION_TRANSITIONS[current]?.has(target)) {
        throw transactionError(`任务事务状态不能从 ${current || '-'} 转换为 ${target || '-'}。`, 'AGENT_TASK_TRANSACTION_TRANSITION_INVALID', 409);
    }
    return target;
}

function assertCommitReady(transaction = {}, effects = [], verification = transaction.verification || {}) {
    const normalized = normalizeTaskTransaction(transaction, transaction?.taskContract?.goal || '');
    if (String(verification?.outcomeStatus || verification?.outcome_status || '') !== 'verified') {
        throw transactionError('任务验收未通过，不能提交副作用。', 'AGENT_TASK_TRANSACTION_VERIFICATION_REQUIRED', 409);
    }
    const list = Array.isArray(effects) ? effects : [];
    const pending = list.filter(effect => {
        const mode = String(effect?.commitMode || effect?.commit_mode || 'after_verify');
        const status = String(effect?.status || 'planned');
        return mode === 'preview' ? status !== 'staged' : status !== 'committed';
    });
    if (pending.length) throw transactionError('仍有未提交或未处理的副作用，不能结束任务事务。', 'AGENT_TASK_TRANSACTION_EFFECTS_PENDING', 409);
    if (normalized.status !== 'awaiting_commit' && normalized.status !== 'committed') {
        throw transactionError('任务事务尚未进入待提交状态。', 'AGENT_TASK_TRANSACTION_NOT_READY', 409);
    }
    return true;
}

function createTaskTransactionDraft({ runId, userId, tenantId = 0, goal = '', taskContract, workspaceSnapshot = {}, effects = [] } = {}) {
    if (!text(runId, 160)) throw transactionError('任务事务必须关联 Run。', 'AGENT_TASK_TRANSACTION_RUN_REQUIRED');
    if (!Number.isSafeInteger(Number(userId)) || Number(userId) <= 0) throw transactionError('任务事务必须关联用户。', 'AGENT_TASK_TRANSACTION_USER_REQUIRED');
    return {
        ...normalizeTaskTransaction({ status: 'draft', taskContract, workspaceSnapshot, effects }, goal),
        id: crypto.randomUUID(),
        runId: text(runId, 160),
        userId: Number(userId),
        tenantId: Number(tenantId) || 0
    };
}

module.exports = {

    assertCommitReady,
    assertTransactionTransition,
    createTaskTransactionDraft,

    normalizeEffectPlan,

    transactionError
};
