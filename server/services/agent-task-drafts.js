'use strict';

/**
 * 聊天任务草案控制面。
 *
 * 草案有别于 Agent 运行（Run）。创建或修订草案仅持久化有界的确定性计划；
 * 既不直接调用模型，也不发现或调用工具。只有在经过独立审计的审批后，
 * 才会请求现有的 Agent 运行时创建任务运行。
 */
const crypto = require('crypto');
const { query, queryOne, transaction } = require('../db/client');
const { canonicalJson } = require('./canonical-json');
const { buildChatAgentMetadata, normalizeChatHistory } = require('./chat-agent-bridge');
const { resolveAccessibleAnswerModelAsync } = require('./models');

const ACTIONABLE_STATUSES = new Set(['needs_clarification', 'ready_for_review', 'approved']);
const RISKY_INTENT = /(删除|清空|覆盖|发布|部署|上线|发送|通知|付款|支付|转账|购买|下单|授权|分享|导出|上传|写入|修改生产|delete|remove|deploy|publish|send|payment|transfer|purchase|authorize|share|export|upload)/i;
const HIGH_RISK_INTENT = /(付款|支付|转账|购买|下单|删除全部|清空|生产环境|payment|transfer|purchase|delete\s+all|production)/i;

function draftError(message, code = 'AGENT_TASK_DRAFT_INVALID', status = 400) {
    const error = new Error(message);
    error.code = code;
    error.status = status;
    error.statusCode = status;
    return error;
}

function text(value, max = 12000) {
    return String(value ?? '').replace(/\u0000/g, '').trim().slice(0, max);
}

function nonEmpty(value, field, { min = 1, max = 12000 } = {}) {
    const normalized = text(value, max);
    if (normalized.length < min) throw draftError(`${field}为必填项，且至少需要 ${min} 个字符。`, 'AGENT_TASK_DRAFT_REQUIRED');
    return normalized;
}

function positiveInteger(value, field) {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1) throw draftError(`${field}必须是正整数。`, 'AGENT_TASK_DRAFT_REVISION_INVALID');
    return parsed;
}

function jsonObject(value, fallback = {}) {
    if (!value) return fallback;
    if (typeof value === 'object') return value;
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
    } catch (_) {
        return fallback;
    }
}

function hash(value) {
    return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function deriveTitle(goal) {
    const singleLine = text(goal, 160).replace(/\s+/g, ' ');
    return singleLine.length > 72 ? `${singleLine.slice(0, 72).trimEnd()}…` : singleLine;
}

function normalizeTitle(value, goal) {
    const supplied = text(value, 160).replace(/\s+/g, ' ');
    return supplied || deriveTitle(goal) || '未命名任务';
}

function classifyRisk(goal) {
    const hasRiskyIntent = RISKY_INTENT.test(goal);
    const level = HIGH_RISK_INTENT.test(goal) ? 'high' : (hasRiskyIntent ? 'medium' : 'low');
    const reasons = [];
    if (level === 'high') reasons.push('目标包含资金、全量删除或生产环境等高影响表述。');
    else if (level === 'medium') reasons.push('目标可能涉及对外发送、发布、写入或权限变更。');
    else reasons.push('未识别到高影响副作用；执行期仍按实时策略逐项拦截。');
    return { level, reasons, hasRiskyIntent };
}

/**
 * 初始规划器采用确定性设计。在任何模型或工具接触或执行任务之前，
 * 为用户提供真实、可审阅的执行契约。后续规划模型可丰富此对象，
 * 但必须保留下方服务端策略快照。
 */
function buildTaskDraftPlan({ goal, title, modelId }) {
    const risk = classifyRisk(goal);
    const clarificationItems = [];
    if (goal.length < 16) clarificationItems.push('请补充期望交付物、范围或完成标准。');
    if (/^(帮我|处理一下|做一下|看看|分析一下)[。！!？?]*$/i.test(goal)) clarificationItems.push('请说明要处理的对象、范围和可接受的结果形式。');

    const requiresApproval = risk.level !== 'low';
    return {
        schemaVersion: 1,
        planner: { type: 'deterministic_safe_baseline', version: 1 },
        title,
        goal,
        delivery: {
            channel: 'chat',
            description: '在当前会话交付可追溯的结果、依据与未完成项。',
            acceptance: ['明确说明完成状态', '区分事实、推断与工具结果', '出现高影响动作时先停在审批点']
        },
        steps: [
            { id: 'scope', title: '确认目标、边界与完成标准', mode: 'read_only', approval: false },
            { id: 'plan', title: '在受控运行时细化执行计划与所需能力', mode: 'read_only', approval: false },
            { id: 'execute', title: '按策略执行可验证的工作单元', mode: 'controlled', approval: requiresApproval },
            { id: 'verify', title: '核验结果、记录证据并交付摘要', mode: 'read_only', approval: false }
        ],
        resources: {
            discovery: '仅在批准后的 Agent Run 中按实时权限发现；本次规划未调用任何工具。',
            externalTools: '初始受控运行仅允许内置能力；外部工具需在后续策略升级与审批后启用。'
        },
        risk: {
            level: risk.level,
            reasons: risk.reasons,
            approvalBoundary: risk.hasRiskyIntent
                ? '涉及外部或不可逆动作时，必须由运行时策略再次要求人工批准。'
                : '即使当前目标为低风险，任何后续发现的高影响动作仍必须经过运行时审批。'
        },
        budget: {
            modelId: String(modelId || ''),
            maxSteps: 20,
            maxTokenBudget: 60000,
            timeoutMs: 600000,
            retryLimit: 1,
            toolPolicy: 'builtin_only',
            approvalPolicy: 'safe_mcp_auto'
        },
        clarification: {
            required: clarificationItems.length > 0,
            items: clarificationItems
        }
    };
}

function buildPolicySnapshot(plan) {
    return {
        schemaVersion: 1,
        mode: 'chat_task_draft',
        toolPolicy: plan.budget.toolPolicy,
        approvalPolicy: plan.budget.approvalPolicy,
        maxSteps: plan.budget.maxSteps,
        maxTokenBudget: plan.budget.maxTokenBudget,
        timeoutMs: plan.budget.timeoutMs,
        retryLimit: plan.budget.retryLimit,
        externalToolsEnabled: false,
        requiresRunTimeReauthorization: true
    };
}

function serializeDraft(row) {
    if (!row) return null;
    const plan = jsonObject(row.plan_json);
    const policySnapshot = jsonObject(row.policy_snapshot);
    return {
        id: String(row.id),
        sessionId: String(row.session_id || ''),
        title: String(row.title || ''),
        goal: String(row.goal || ''),
        status: String(row.status || ''),
        revision: Number(row.revision || 0),
        plan,
        planDigest: String(row.plan_digest || ''),
        policySnapshot,
        policyDigest: String(row.policy_digest || ''),
        runId: row.run_id ? String(row.run_id) : null,
        expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
        approvedAt: row.approved_at ? new Date(row.approved_at).toISOString() : null,
        createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
        updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null
    };
}

function assertDraftOwner(row, user) {
    if (!row || Number(row.user_id) !== Number(user?.id)) throw draftError('任务草案不存在或无权访问。', 'AGENT_TASK_DRAFT_NOT_FOUND', 404);
}

function isExpired(row) {
    const timestamp = Date.parse(String(row?.expires_at || ''));
    return Number.isFinite(timestamp) && timestamp <= Date.now();
}

async function writeEvent(trx, { draftId, revision, userId, eventType, eventData = {} }) {
    await trx.execute(`
        INSERT INTO agent_task_draft_events (id, draft_id, revision, actor_user_id, event_type, event_data)
        VALUES (?, ?, ?, ?, ?, ?::jsonb)
    `, [crypto.randomUUID(), draftId, revision, userId || null, eventType, JSON.stringify(eventData)]);
}

async function resolveModel(user, modelId, resolveModel = resolveAccessibleAnswerModelAsync) {
    const model = await resolveModel(modelId, user);
    if (!model?.id) throw draftError('请选择当前账号可用的模型后再创建任务草案。', 'AGENT_TASK_DRAFT_MODEL_UNAVAILABLE', 400);
    return model;
}

async function assertSessionAccess(user, sessionId, db) {
    const normalized = text(sessionId, 128);
    if (!normalized) throw draftError('任务草案必须归属到一个会话。', 'AGENT_TASK_DRAFT_SESSION_REQUIRED');
    const session = await db.queryOne('SELECT id FROM sessions WHERE id = ? AND user_id = ?', [normalized, user.id]);
    if (!session) throw draftError('会话不存在或无权访问。', 'AGENT_TASK_DRAFT_SESSION_NOT_FOUND', 404);
    return normalized;
}

function makeDb(overrides = {}) {
    return { query, queryOne, transaction, resolveModel: resolveAccessibleAnswerModelAsync, ...overrides };
}

async function createTaskDraft(user, input = {}, overrides = {}) {
    if (!user?.id) throw draftError('登录状态无效。', 'AUTH_MISSING', 401);
    const db = makeDb(overrides);
    const goal = nonEmpty(input.goal, '任务目标', { min: 2, max: 12000 });
    const title = normalizeTitle(input.title, goal);
    const sessionId = await assertSessionAccess(user, input.sessionId, db);
    const model = await resolveModel(user, input.modelId, db.resolveModel);
    const plan = buildTaskDraftPlan({ goal, title, modelId: model.id });
    const policySnapshot = buildPolicySnapshot(plan);
    const draft = await db.transaction(async trx => {
        const id = crypto.randomUUID();
        const revision = 1;
        const status = plan.clarification.required ? 'needs_clarification' : 'ready_for_review';
        const planDigest = hash(plan);
        const policyDigest = hash(policySnapshot);
        const row = await trx.queryOne(`
            INSERT INTO agent_task_drafts (
                id, user_id, session_id, title, goal, status, revision, plan_json, policy_snapshot,
                plan_digest, policy_digest, expires_at, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb, ?, ?, NOW() + INTERVAL '24 hours', NOW(), NOW())
            RETURNING *
        `, [id, user.id, sessionId, title, goal, status, revision, JSON.stringify(plan), JSON.stringify(policySnapshot), planDigest, policyDigest]);
        await writeEvent(trx, { draftId: id, revision, userId: user.id, eventType: 'created', eventData: { status, planDigest, policyDigest } });
        return row;
    });
    return serializeDraft(draft);
}

async function getTaskDraftForUser(user, draftId, overrides = {}) {
    const db = makeDb(overrides);
    const row = await db.queryOne('SELECT * FROM agent_task_drafts WHERE id = ? AND user_id = ?', [text(draftId, 80), user?.id]);
    assertDraftOwner(row, user);
    if (isExpired(row) && ACTIONABLE_STATUSES.has(row.status)) {
        await db.transaction(async trx => {
            await trx.execute("UPDATE agent_task_drafts SET status = 'expired', updated_at = NOW() WHERE id = ? AND user_id = ? AND status IN ('needs_clarification', 'ready_for_review', 'approved')", [row.id, user.id]);
            await writeEvent(trx, { draftId: row.id, revision: row.revision, userId: user.id, eventType: 'expired', eventData: {} });
        });
        row.status = 'expired';
    }
    return serializeDraft(row);
}

async function listTaskDraftsForUser(user, options = {}, overrides = {}) {
    const db = makeDb(overrides);
    const sessionId = text(options.sessionId, 128);
    const rows = await db.query(`
        SELECT *
        FROM agent_task_drafts
        WHERE user_id = ?
          AND (? = '' OR session_id = ?)
          AND status IN ('needs_clarification', 'ready_for_review', 'approved', 'starting')
          AND expires_at > NOW()
        ORDER BY updated_at DESC
        LIMIT 25
    `, [user?.id, sessionId, sessionId]);
    return rows.map(serializeDraft);
}

async function reviseTaskDraft(user, draftId, input = {}, overrides = {}) {
    const db = makeDb(overrides);
    const requestedRevision = positiveInteger(input.revision, 'revision');
    const draft = await db.transaction(async trx => {
        const current = await trx.queryOne('SELECT * FROM agent_task_drafts WHERE id = ? AND user_id = ? FOR UPDATE', [text(draftId, 80), user?.id]);
        assertDraftOwner(current, user);
        if (!ACTIONABLE_STATUSES.has(current.status) || current.status === 'approved') throw draftError('当前任务草案不能再编辑，请创建新草案。', 'AGENT_TASK_DRAFT_NOT_EDITABLE', 409);
        if (isExpired(current)) throw draftError('任务草案已过期，请重新创建。', 'AGENT_TASK_DRAFT_EXPIRED', 409);
        if (Number(current.revision) !== requestedRevision) throw draftError('任务草案已更新，请刷新后再编辑。', 'AGENT_TASK_DRAFT_STALE', 409);
        const goal = nonEmpty(input.goal ?? current.goal, '任务目标', { min: 2, max: 12000 });
        const title = normalizeTitle(input.title ?? current.title, goal);
        const previousPlan = jsonObject(current.plan_json);
        const modelId = previousPlan?.budget?.modelId;
        const plan = buildTaskDraftPlan({ goal, title, modelId });
        const policySnapshot = buildPolicySnapshot(plan);
        const revision = Number(current.revision) + 1;
        const status = plan.clarification.required ? 'needs_clarification' : 'ready_for_review';
        const planDigest = hash(plan);
        const policyDigest = hash(policySnapshot);
        const row = await trx.queryOne(`
            UPDATE agent_task_drafts
            SET title = ?, goal = ?, status = ?, revision = ?, plan_json = ?::jsonb, policy_snapshot = ?::jsonb,
                plan_digest = ?, policy_digest = ?, approved_at = NULL, updated_at = NOW()
            WHERE id = ? AND user_id = ?
            RETURNING *
        `, [title, goal, status, revision, JSON.stringify(plan), JSON.stringify(policySnapshot), planDigest, policyDigest, current.id, user.id]);
        await writeEvent(trx, { draftId: current.id, revision, userId: user.id, eventType: 'revised', eventData: { status, planDigest, policyDigest } });
        return row;
    });
    return serializeDraft(draft);
}

function assertExpectedDraft(current, input) {
    const revision = positiveInteger(input.revision, 'revision');
    if (Number(current.revision) !== revision || text(input.planDigest, 80) !== String(current.plan_digest || '')) {
        throw draftError('任务计划已变化，请重新审阅后再确认。', 'AGENT_TASK_DRAFT_STALE', 409);
    }
}

async function approveTaskDraft(user, draftId, input = {}, overrides = {}) {
    const db = makeDb(overrides);
    const draft = await db.transaction(async trx => {
        const current = await trx.queryOne('SELECT * FROM agent_task_drafts WHERE id = ? AND user_id = ? FOR UPDATE', [text(draftId, 80), user?.id]);
        assertDraftOwner(current, user);
        if (isExpired(current)) throw draftError('任务草案已过期，请重新创建。', 'AGENT_TASK_DRAFT_EXPIRED', 409);
        if (current.status === 'needs_clarification') throw draftError('请先补充任务信息并重新生成计划。', 'AGENT_TASK_DRAFT_CLARIFICATION_REQUIRED', 409);
        if (current.status !== 'ready_for_review') throw draftError('当前任务草案不能确认。', 'AGENT_TASK_DRAFT_NOT_APPROVABLE', 409);
        assertExpectedDraft(current, input);
        const row = await trx.queryOne(`
            UPDATE agent_task_drafts
            SET status = 'approved', approved_at = NOW(), updated_at = NOW()
            WHERE id = ? AND user_id = ?
            RETURNING *
        `, [current.id, user.id]);
        await writeEvent(trx, { draftId: current.id, revision: current.revision, userId: user.id, eventType: 'approved', eventData: { planDigest: current.plan_digest, policyDigest: current.policy_digest } });
        return row;
    });
    return serializeDraft(draft);
}

async function readChatHistory(user, sessionId, db) {
    const rows = await db.query(`
        SELECT role, content
        FROM messages
        WHERE session_id = ? AND user_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT 24
    `, [sessionId, user.id]);
    return normalizeChatHistory([...rows].reverse());
}

async function startTaskDraft(user, draftId, input = {}, { createAgentRun, ...overrides } = {}) {
    if (typeof createAgentRun !== 'function') throw draftError('Agent 运行时尚未就绪。', 'AGENT_TASK_DRAFT_RUNTIME_UNAVAILABLE', 503);
    const db = makeDb(overrides);
    const starting = await db.transaction(async trx => {
        const current = await trx.queryOne('SELECT * FROM agent_task_drafts WHERE id = ? AND user_id = ? FOR UPDATE', [text(draftId, 80), user?.id]);
        assertDraftOwner(current, user);
        if (isExpired(current)) throw draftError('任务草案已过期，请重新创建。', 'AGENT_TASK_DRAFT_EXPIRED', 409);
        if (current.status === 'run_created') return current;
        if (current.status !== 'approved') throw draftError('请先审阅并确认计划，再启动执行。', 'AGENT_TASK_DRAFT_APPROVAL_REQUIRED', 409);
        assertExpectedDraft(current, input);
        const row = await trx.queryOne(`
            UPDATE agent_task_drafts
            SET status = 'starting', updated_at = NOW()
            WHERE id = ? AND user_id = ? AND status = 'approved'
            RETURNING *
        `, [current.id, user.id]);
        if (!row) throw draftError('任务草案正在由其他请求启动。', 'AGENT_TASK_DRAFT_STARTING', 409);
        await writeEvent(trx, { draftId: current.id, revision: current.revision, userId: user.id, eventType: 'starting', eventData: { planDigest: current.plan_digest } });
        return row;
    });
    if (starting.status === 'run_created') return serializeDraft(starting);

    const plan = jsonObject(starting.plan_json);
    const policy = jsonObject(starting.policy_snapshot);
    let createdRunId = '';
    try {
        const history = await readChatHistory(user, starting.session_id, db);
        const run = await createAgentRun({
            user,
            chatAgent: true,
            sessionId: starting.session_id,
            title: starting.title,
            goal: starting.goal,
            modelId: plan?.budget?.modelId || '',
            maxSteps: Number(policy.maxSteps || 20),
            maxTokenBudget: Number(policy.maxTokenBudget || 60000),
            timeoutMs: Number(policy.timeoutMs || 600000),
            retryLimit: Number(policy.retryLimit || 1),
            toolPolicy: policy.toolPolicy || 'builtin_only',
            approvalPolicy: policy.approvalPolicy || 'safe_mcp_auto',
            contextConfig: { mode: 'recent' },
            metadata: {
                taskDraft: {
                    id: String(starting.id),
                    revision: Number(starting.revision),
                    planDigest: String(starting.plan_digest),
                    policyDigest: String(starting.policy_digest),
                    source: 'chat_task_draft'
                },
                ...buildChatAgentMetadata({
                    sessionId: starting.session_id,
                    visibleContent: starting.goal,
                    currentContent: starting.goal,
                    history,
                    source: 'chat_task_draft',
                    mcpEnabled: false,
                    ragEnabled: false
                })
            }
        });
        createdRunId = String(run.id || '');
        const completed = await db.transaction(async trx => {
            const row = await trx.queryOne(`
                UPDATE agent_task_drafts
                SET status = 'run_created', run_id = ?, updated_at = NOW()
                WHERE id = ? AND user_id = ? AND status = 'starting'
                RETURNING *
            `, [run.id, starting.id, user.id]);
            if (!row) throw draftError('任务运行已创建，但草案状态未能更新，请联系管理员核验。', 'AGENT_TASK_DRAFT_FINALIZE_FAILED', 500);
            await writeEvent(trx, { draftId: starting.id, revision: starting.revision, userId: user.id, eventType: 'run_created', eventData: { runId: run.id } });
            return row;
        });
        return { ...serializeDraft(completed), run: { id: String(run.id), status: String(run.status || 'queued'), title: String(run.title || starting.title) } };
    } catch (error) {
        // 一旦 Agent Runtime 接受了 Run，后续持久化失败绝不能将草案回退至 approved：
        // 否则重试可能创建第二个具有副作用的 Run。此时应保留在 starting 状态供运维对账。
        // 在 Run 实际创建前，重试是安全的，用户可重新启动已批准的修订版本。
        if (!createdRunId) {
            await db.transaction(async trx => {
                const row = await trx.queryOne(`
                    UPDATE agent_task_drafts
                    SET status = 'approved', updated_at = NOW()
                    WHERE id = ? AND user_id = ? AND status = 'starting'
                    RETURNING *
                `, [starting.id, user.id]);
                if (row) await writeEvent(trx, { draftId: starting.id, revision: starting.revision, userId: user.id, eventType: 'start_failed', eventData: { code: text(error.code, 80), message: text(error.message, 240) } });
            }).catch(() => {});
        }
        throw error;
    }
}

async function cancelTaskDraft(user, draftId, input = {}, overrides = {}) {
    const db = makeDb(overrides);
    const draft = await db.transaction(async trx => {
        const current = await trx.queryOne('SELECT * FROM agent_task_drafts WHERE id = ? AND user_id = ? FOR UPDATE', [text(draftId, 80), user?.id]);
        assertDraftOwner(current, user);
        if (!ACTIONABLE_STATUSES.has(current.status)) throw draftError('当前任务草案不能取消。', 'AGENT_TASK_DRAFT_NOT_CANCELLABLE', 409);
        if (input.revision !== undefined) assertExpectedDraft(current, { revision: input.revision, planDigest: input.planDigest || current.plan_digest });
        const row = await trx.queryOne(`
            UPDATE agent_task_drafts SET status = 'cancelled', updated_at = NOW()
            WHERE id = ? AND user_id = ?
            RETURNING *
        `, [current.id, user.id]);
        await writeEvent(trx, { draftId: current.id, revision: current.revision, userId: user.id, eventType: 'cancelled', eventData: {} });
        return row;
    });
    return serializeDraft(draft);
}

module.exports = {
    buildTaskDraftPlan,
    createTaskDraft,
    getTaskDraftForUser,
    listTaskDraftsForUser,
    reviseTaskDraft,
    approveTaskDraft,
    startTaskDraft,
    cancelTaskDraft,
    serializeDraft
};
