const { query, queryOne, transaction } = require('../db/client');
const { getBeijingTimestamp } = require('../time');
const { redactTraceValue } = require('./agent-traces');

const DEFAULT_CHILD_LIMIT = Math.min(Math.max(Number(process.env.AGENT_CHILD_MAX_CONCURRENCY || 4) || 4, 1), 32);
const MAX_FORK_ITEMS = 100;

function parseJson(value, fallback = {}) {
    if (value && typeof value === 'object') return value;
    try { return JSON.parse(value || ''); } catch (_) { return fallback; }
}

function normalizeForkHistory(value, fallback = 'none') {
    if (value && typeof value === 'object') {
        const mode = String(value.mode || value.strategy || fallback).trim().toLowerCase();
        const turns = Math.min(Math.max(Number(value.turns || value.count || 0) || 0, 0), MAX_FORK_ITEMS);
        if (mode === 'all') return { mode: 'all', turns: MAX_FORK_ITEMS };
        if (mode === 'turns' || turns > 0) return { mode: 'turns', turns: turns || 1 };
        return { mode: 'none', turns: 0 };
    }
    const text = String(value || fallback).trim().toLowerCase();
    if (text === 'all') return { mode: 'all', turns: MAX_FORK_ITEMS };
    const match = text.match(/^(?:turns?|last)\s*:?\s*(\d+)$/);
    if (match) return { mode: 'turns', turns: Math.min(Math.max(Number(match[1]) || 1, 1), MAX_FORK_ITEMS) };
    return { mode: 'none', turns: 0 };
}

function normalizeChildLimit(value, fallback = DEFAULT_CHILD_LIMIT) {
    const parsed = Number(value);
    return Math.min(Math.max(Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback, 1), 32);
}

function normalizePositiveBudget(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function resourceConfigFromRun(run = {}) {
    const metadata = parseJson(run.metadata, {});
    const budget = parseJson(run.budget_config || run.budgetConfig, {});
    return {
        tokenBudget: normalizePositiveBudget(run.max_token_budget ?? run.maxTokenBudget),
        maxChildren: normalizeChildLimit(
            budget.max_children ?? budget.maxChildren ?? metadata.maxChildConcurrency ?? metadata.max_children,
            DEFAULT_CHILD_LIMIT
        )
    };
}

async function ensureResourceLedger(trx, run) {
    const config = resourceConfigFromRun(run);
    await trx.execute(`
        INSERT INTO agent_run_resources (
            run_id, user_id, parent_run_id, token_budget, max_children,
            fork_history_mode, fork_history_turns, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'none', 0, ?, ?)
        ON CONFLICT (run_id) DO NOTHING
    `, [run.id, run.user_id, run.parent_run_id || null, config.tokenBudget, config.maxChildren, getBeijingTimestamp(), getBeijingTimestamp()]);
    return await trx.queryOne('SELECT * FROM agent_run_resources WHERE run_id = ? FOR UPDATE', [run.id]);
}

async function reserveChildRunResources({ parentRunId, userId, requestedTokenBudget = 0, forkHistory = 'none' } = {}) {
    if (!parentRunId) return { tokenBudget: normalizePositiveBudget(requestedTokenBudget), reservation: null, forkHistory: normalizeForkHistory(forkHistory) };
    const requested = normalizePositiveBudget(requestedTokenBudget);
    const mode = normalizeForkHistory(forkHistory);
    return await transaction(async trx => {
        const parent = await trx.queryOne(`
            SELECT id, user_id, parent_run_id, max_token_budget, budget_config, metadata
            FROM agent_runs
            WHERE id = ? AND user_id = ? AND deleted_at IS NULL
            FOR UPDATE
        `, [parentRunId, userId]);
        if (!parent) {
            const error = new Error('父 Agent Run 不存在或无权创建子运行。');
            error.code = 'AGENT_PARENT_RUN_NOT_FOUND';
            error.status = 403;
            throw error;
        }
        const parentLedger = await ensureResourceLedger(trx, parent);
        const activeChildren = Number(parentLedger.active_children || 0);
        if (activeChildren >= Number(parentLedger.max_children || DEFAULT_CHILD_LIMIT)) {
            const error = new Error(`父 Agent 子运行并发已达到上限 ${parentLedger.max_children}。`);
            error.code = 'AGENT_CHILD_CONCURRENCY_EXCEEDED';
            error.category = 'resource';
            throw error;
        }
        const parentBudget = Number(parentLedger.token_budget || 0);
        const reserved = Number(parentLedger.tokens_reserved || 0);
        const consumed = Number(parentLedger.tokens_consumed || 0);
        const remaining = parentBudget > 0 ? Math.max(parentBudget - reserved - consumed, 0) : 0;
        if (parentBudget > 0 && remaining <= 0) {
            const error = new Error('父 Agent 没有可继承的剩余 Token 预算。');
            error.code = 'AGENT_CHILD_BUDGET_EXCEEDED';
            error.category = 'resource';
            throw error;
        }
        const effectiveBudget = parentBudget > 0
            ? (requested > 0 ? Math.min(requested, remaining) : remaining)
            : requested;
        if (parentBudget > 0 && requested > 0 && requested > remaining) {
            const error = new Error(`子 Agent 请求预算 ${requested} 超过父 Agent 剩余预算 ${remaining}。`);
            error.code = 'AGENT_CHILD_BUDGET_EXCEEDED';
            error.category = 'resource';
            throw error;
        }
        const now = getBeijingTimestamp();
        await trx.execute(`
            UPDATE agent_run_resources
            SET active_children = active_children + 1,
                tokens_reserved = tokens_reserved + ?, updated_at = ?
            WHERE run_id = ?
        `, [effectiveBudget, now, parentRunId]);
        return {
            tokenBudget: effectiveBudget,
            forkHistory: mode,
            reservation: {
                parentRunId: String(parentRunId),
                tokenBudget: effectiveBudget,
                forkHistory: mode
            }
        };
    });
}

async function initializeAgentRunResources({ runId, userId, parentRunId = null, tokenBudget = 0, forkHistory = 'none', maxChildren = null } = {}) {
    if (!runId || !userId) return null;
    const mode = normalizeForkHistory(forkHistory);
    const safeBudget = normalizePositiveBudget(tokenBudget);
    const result = await queryOne(`
        INSERT INTO agent_run_resources (
            run_id, user_id, parent_run_id, token_budget, max_children,
            fork_history_mode, fork_history_turns, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (run_id) DO UPDATE SET
            token_budget = EXCLUDED.token_budget,
            fork_history_mode = EXCLUDED.fork_history_mode,
            fork_history_turns = EXCLUDED.fork_history_turns,
            updated_at = EXCLUDED.updated_at
        RETURNING *
    `, [runId, userId, parentRunId || null, safeBudget, normalizeChildLimit(maxChildren), mode.mode, mode.turns, getBeijingTimestamp(), getBeijingTimestamp()]);
    return result;
}

async function releaseChildRunReservation(runId) {
    if (!runId) return false;
    return await transaction(async trx => {
        const child = await trx.queryOne(`SELECT * FROM agent_run_resources WHERE run_id = ? FOR UPDATE`, [runId]);
        if (!child || !child.parent_run_id || child.reservation_released) return false;
        const parent = await trx.queryOne(`SELECT * FROM agent_run_resources WHERE run_id = ? FOR UPDATE`, [child.parent_run_id]);
        const now = getBeijingTimestamp();
        if (parent) {
            await trx.execute(`
                UPDATE agent_run_resources
                SET active_children = GREATEST(active_children - 1, 0),
                    tokens_reserved = GREATEST(tokens_reserved - ?, 0),
                    tokens_consumed = tokens_consumed + ?, updated_at = ?
                WHERE run_id = ?
            `, [Number(child.token_budget || 0), Number(child.tokens_consumed || 0), now, child.parent_run_id]);
        }
        await trx.execute(`UPDATE agent_run_resources SET reservation_released = TRUE, updated_at = ? WHERE run_id = ?`, [now, runId]);
        return true;
    });
}

async function cancelChildRunReservation({ parentRunId, userId, tokenBudget = 0 } = {}) {
    if (!parentRunId || !userId) return false;
    return await transaction(async trx => {
        const parent = await trx.queryOne(`
            SELECT run_id FROM agent_run_resources
            WHERE run_id = ? AND user_id = ?
            FOR UPDATE
        `, [parentRunId, userId]);
        if (!parent) return false;
        const now = getBeijingTimestamp();
        const changed = await trx.execute(`
            UPDATE agent_run_resources
            SET active_children = GREATEST(active_children - 1, 0),
                tokens_reserved = GREATEST(tokens_reserved - ?, 0), updated_at = ?
            WHERE run_id = ?
        `, [normalizePositiveBudget(tokenBudget), now, parentRunId]);
        return changed > 0;
    });
}

async function recordAgentRunResourceUsage(runId, totalTokens = 0) {
    const amount = Math.max(Number(totalTokens) || 0, 0);
    if (!runId || amount <= 0) return null;
    return await queryOne(`
        UPDATE agent_run_resources
        SET tokens_consumed = tokens_consumed + ?, updated_at = ?
        WHERE run_id = ?
        RETURNING run_id, token_budget, tokens_reserved, tokens_consumed, active_children, max_children
    `, [amount, getBeijingTimestamp(), runId]);
}

async function getAgentRunResources(runId, userId) {
    return await queryOne(`SELECT * FROM agent_run_resources WHERE run_id = ? AND user_id = ?`, [runId, userId]);
}

async function buildForkHistory(runId, userId, strategy = 'none') {
    const mode = normalizeForkHistory(strategy);
    if (mode.mode === 'none') return { mode: 'none', turns: 0, items: [] };
    const rows = await query(`
        SELECT step_index, type, title, tool_name, input, output, status, error_message, created_at
        FROM agent_steps
        WHERE run_id = ?
        ORDER BY step_index DESC
        LIMIT ?
    `, [runId, mode.turns]);
    const items = rows.reverse().map(row => ({
        stepIndex: Number(row.step_index || 0),
        type: row.type || '',
        title: row.title || '',
        toolName: row.tool_name || '',
        input: redactTraceValue(parseJson(row.input, {})),
        output: redactTraceValue(parseJson(row.output, {})),
        status: row.status || '',
        errorMessage: String(row.error_message || '').slice(0, 500),
        createdAt: row.created_at || ''
    }));
    return { mode: mode.mode, turns: mode.turns, sourceRunId: String(runId), items };
}

module.exports = {
    DEFAULT_CHILD_LIMIT,
    buildForkHistory,
    cancelChildRunReservation,
    getAgentRunResources,
    initializeAgentRunResources,
    normalizeChildLimit,
    normalizeForkHistory,
    recordAgentRunResourceUsage,
    releaseChildRunReservation,
    reserveChildRunResources
};
