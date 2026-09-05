const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { query, queryOne, execute } = require('../db/client');
const { getBeijingTimestamp } = require('../time');
const { getPrimaryTenantId } = require('./enterprise-access');
const { computeNextScheduleRun } = require('./agent-schedules');
const {
    normalizeApprovalPolicy,
    normalizePositiveInt,
    normalizeToolAllowlist,
    normalizeToolPolicy,
    normalizeOptionalMaxSteps
} = require('./agent-validators');

const GOAL_STATUSES = Object.freeze(['active', 'paused', 'suspended', 'completed', 'failed', 'deleted']);
const GOAL_TRIGGER_TYPES = Object.freeze(['manual', 'timer', 'webhook', 'file', 'database']);
const MAX_GOALS_PER_USER = 100;
const MAX_FAILURES = 10;
const GOAL_CLAIM_LEASE_MS = Math.max(
    Number.parseInt(process.env.AGENT_GOAL_CLAIM_LEASE_MS || String(5 * 60 * 1000), 10) || 5 * 60 * 1000,
    30 * 1000
);
const GOAL_CLAIM_RENEW_INTERVAL_MS = Math.min(
    Math.max(Math.floor(GOAL_CLAIM_LEASE_MS / 3), 10 * 1000),
    60 * 1000
);

let createAgentRunCallback = null;
let createAgentNotificationCallback = () => null;
let goalDataRunner = null;

function configureAgentGoals({ createAgentRun, createAgentNotification, executeReadOnlyQuery } = {}) {
    if (typeof createAgentRun === 'function') createAgentRunCallback = createAgentRun;
    if (typeof createAgentNotification === 'function') createAgentNotificationCallback = createAgentNotification;
    if (typeof executeReadOnlyQuery === 'function') goalDataRunner = executeReadOnlyQuery;
}

function invalid(message, status = 400) {
    const error = new Error(message);
    error.status = status;
    error.statusCode = status;
    error.code = 'AGENT_GOAL_INVALID';
    return error;
}

function parseJson(value, fallback = {}) {
    if (value && typeof value === 'object') return value;
    try { return JSON.parse(String(value || '')); } catch (_) { return fallback; }
}

function normalizeTriggerSpec(raw = {}) {
    const input = raw && typeof raw === 'object' ? raw : {};
    const type = String(input.type || input.triggerType || input.trigger_type || 'manual').trim().toLowerCase();
    if (!GOAL_TRIGGER_TYPES.includes(type)) throw invalid('持续目标事件源无效。');
    if (type === 'timer') {
        const frequency = String(input.frequency || 'daily').trim().toLowerCase();
        if (!['daily', 'weekly', 'weekdays', 'interval', 'cron'].includes(frequency)) throw invalid('持续目标定时周期无效。');
        const intervalMinutes = normalizePositiveInt(input.intervalMinutes ?? input.interval_minutes, 60, 5, 24 * 60);
        const cronExpression = String(input.cronExpression || input.cron_expression || '').trim().slice(0, 120);
        if (frequency === 'cron' && !cronExpression) throw invalid('Cron 定时目标必须填写 cronExpression。');
        return {
            type,
            frequency,
            timeOfDay: /^\d{1,2}:\d{2}$/.test(String(input.timeOfDay || input.time_of_day || '09:00')) ? String(input.timeOfDay || input.time_of_day) : '09:00',
            dayOfWeek: normalizePositiveInt(input.dayOfWeek ?? input.day_of_week, 1, 0, 6),
            intervalMinutes,
            cronExpression
        };
    }
    if (type === 'webhook') {
        const token = String(input.token || '').trim();
        const tokenHash = String(input.tokenHash || input.token_hash || '').trim() || (token ? hashGoalToken(token) : '');
        if (!tokenHash) throw invalid('Webhook 持续目标需要访问令牌。');
        return {
            type,
            tokenHash,
            tokenHint: String(input.tokenHint || input.token_hint || token.slice(-6)).slice(-16),
            replayWindowSeconds: normalizePositiveInt(input.replayWindowSeconds ?? input.replay_window_seconds, 300, 30, 3600),
            requireSignature: input.requireSignature === true || input.require_signature === true,
            dedupePath: String(input.dedupePath || input.dedupe_path || '').trim().slice(0, 120),
            inputMapping: normalizeMapping(input.inputMapping || input.input_mapping),
            sourceAllowlist: normalizeStringList(input.sourceAllowlist || input.source_allowlist, 20, 120)
        };
    }
    if (type === 'file') {
        const directory = String(input.directory || '').trim();
        if (!directory) throw invalid('文件目标必须指定监听目录。');
        return { type, directory: directory.slice(0, 1000), inputName: String(input.inputName || input.input_name || 'filePath').slice(0, 80), extensions: normalizeStringList(input.extensions, 20, 16), stableSeconds: normalizePositiveInt(input.stableSeconds ?? input.stable_seconds, 5, 1, 3600), watermark: String(input.watermark || '').slice(0, 255) };
    }
    if (type === 'database') {
        const queryText = String(input.query || '').trim();
        if (!queryText || !/\{\{watermark\}\}/.test(queryText)) throw invalid('数据库目标必须包含 {{watermark}} 水位线查询。');
        if (/\b(insert|update|delete|drop|alter|create|truncate)\b/i.test(queryText)) throw invalid('数据库目标只允许只读查询。');
        return { type, connectionId: String(input.connectionId || input.connection_id || '').slice(0, 160), query: queryText.slice(0, 12000), watermarkField: String(input.watermarkField || input.watermark_field || 'updated_at').slice(0, 120), watermark: String(input.watermark || '').slice(0, 255), inputName: String(input.inputName || input.input_name || 'rows').slice(0, 80) };
    }
    return { type };
}

function normalizeStringList(value, maxItems, maxLength) {
    const values = Array.isArray(value) ? value : [];
    return [...new Set(values.map(item => String(item || '').trim().slice(0, maxLength)).filter(Boolean))].slice(0, maxItems);
}

function normalizeMapping(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).slice(0, 40).map(([key, path]) => [
        String(key).slice(0, 80), String(path || '').trim().slice(0, 160)
    ]).filter(([, path]) => path));
}

function hashGoalToken(token) {
    return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function generateGoalToken() {
    return `agt_${crypto.randomBytes(30).toString('base64url')}`;
}

function normalizeGoalInput(body = {}, current = null) {
    const source = current ? { ...current, ...body } : body;
    const title = String(source.title || source.name || '').trim().slice(0, 160);
    const goal = String(source.goal || '').trim().slice(0, 12000);
    if (!title || goal.length < 4) throw invalid('请填写持续目标标题和明确目标。');
    const triggerSpec = normalizeTriggerSpec(source.triggerSpec || source.trigger_spec || {});
    const authorizationSpec = normalizeAuthorization(source.authorizationSpec || source.authorization_spec || {}, source);
    const budgetSpec = normalizeBudget(source.budgetSpec || source.budget_spec || {}, source);
    return {
        title,
        goal,
        priority: Math.max(-100, Math.min(100, Number.parseInt(source.priority, 10) || 0)),
        status: source.status === 'paused' ? 'paused' : 'active',
        triggerSpec,
        authorizationSpec,
        budgetSpec,
        cooldownSeconds: normalizePositiveInt(source.cooldownSeconds ?? source.cooldown_seconds, 300, 0, 7 * 24 * 3600),
        maxFailures: normalizePositiveInt(source.maxFailures ?? source.max_failures, 5, 1, MAX_FAILURES)
    };
}

function normalizeAuthorization(raw = {}, source = {}) {
    const input = raw && typeof raw === 'object' ? raw : {};
    return {
        toolPolicy: normalizeToolPolicy(input.toolPolicy || input.tool_policy || source.toolPolicy || source.tool_policy),
        toolAllowlist: normalizeToolAllowlist(input.toolAllowlist || input.tool_allowlist || source.toolAllowlist || source.tool_allowlist),
        approvalPolicy: normalizeApprovalPolicy(input.approvalPolicy || input.approval_policy || source.approvalPolicy || source.approval_policy),
        networkPolicy: input.networkPolicy && typeof input.networkPolicy === 'object' ? input.networkPolicy : {},
        expiresAt: input.expiresAt || input.expires_at || null
    };
}

function normalizeBudget(raw = {}, source = {}) {
    const input = raw && typeof raw === 'object' ? raw : {};
    return {
        maxTokenBudget: normalizePositiveInt(input.maxTokenBudget ?? input.max_token_budget ?? source.maxTokenBudget ?? source.max_token_budget, 0, 0, 10000000),
        maxRunsPerWindow: normalizePositiveInt(input.maxRunsPerWindow ?? input.max_runs_per_window, 0, 0, 10000),
        windowSeconds: normalizePositiveInt(input.windowSeconds ?? input.window_seconds, 86400, 60, 31 * 86400),
        maxSteps: normalizeOptionalMaxSteps(input.maxSteps ?? input.max_steps ?? source.maxSteps ?? source.max_steps)
    };
}

function parseRow(row) {
    if (!row) return null;
    return {
        id: row.id,
        userId: Number(row.user_id),
        tenantId: row.tenant_id ? Number(row.tenant_id) : null,
        title: row.title,
        goal: row.goal,
        priority: Number(row.priority || 0),
        status: row.status,
        triggerSpec: parseJson(row.trigger_spec, {}),
        authorizationSpec: parseJson(row.authorization_spec, {}),
        budgetSpec: parseJson(row.budget_spec, {}),
        cooldownSeconds: Number(row.cooldown_seconds || 0),
        maxFailures: Number(row.max_failures || 0),
        failureCount: Number(row.failure_count || 0),
        nextRunAt: row.next_run_at || null,
        lastRunId: row.last_run_id || null,
        lastTriggerKey: row.last_trigger_key || null,
        lastError: row.last_error || '',
        version: Number(row.version || 1),
        pausedAt: row.paused_at || null,
        endedAt: row.ended_at || null,
        createdAt: row.created_at || null,
        updatedAt: row.updated_at || null
    };
}

function computeNextGoalRun(triggerSpec, from = getBeijingTimestamp()) {
    if (['file', 'database'].includes(triggerSpec?.type)) return getBeijingTimestamp(new Date(Date.now() + 60000));
    if (triggerSpec?.type !== 'timer') return null;
    if (triggerSpec.frequency === 'weekdays') {
        let cursor = new Date(String(from).replace(' ', 'T'));
        if (Number.isNaN(cursor.getTime())) cursor = new Date();
        for (let i = 0; i < 8; i += 1) {
            const candidate = computeNextScheduleRun('daily', triggerSpec.timeOfDay, 1, cursor, '', 0);
            if (!candidate) return null;
            const day = new Date(candidate.replace(' ', 'T')).getDay();
            if (day >= 1 && day <= 5) return candidate;
            cursor = new Date(new Date(candidate.replace(' ', 'T')).getTime() + 60 * 1000);
        }
        return null;
    }
    const frequency = triggerSpec.frequency === 'weekdays' ? 'weekly' : triggerSpec.frequency;
    return computeNextScheduleRun(
        frequency,
        triggerSpec.timeOfDay,
        triggerSpec.frequency === 'weekdays' ? 1 : triggerSpec.dayOfWeek,
        from,
        triggerSpec.cronExpression,
        triggerSpec.intervalMinutes
    );
}

async function getAgentGoal(id, user) {
    const row = await queryOne('SELECT * FROM agent_goals WHERE id = ? AND user_id = ?', [String(id || ''), user.id]);
    return parseRow(row);
}

async function listAgentGoals(user, options = {}) {
    const tenantId = options.tenantId || user.tenant_id || await getPrimaryTenantId(user.id);
    const params = [user.id, tenantId];
    const where = ['user_id = ?', '(tenant_id IS NULL OR tenant_id = ?)'];
    const status = String(options.status || '').trim();
    if (GOAL_STATUSES.includes(status)) {
        where.push('status = ?');
        params.push(status);
    } else if (options.includeDeleted !== true && status !== 'all' && status !== 'deleted') {
        where.push("status != 'deleted'");
    }
    const rows = await query(`SELECT * FROM agent_goals WHERE ${where.join(' AND ')} ORDER BY status, priority DESC, updated_at DESC LIMIT ?`, [...params, Math.max(1, Math.min(Number.parseInt(options.limit, 10) || 100, 200))]);
    return rows.map(parseRow);
}

async function createAgentGoal(user, body = {}, options = {}) {
    const count = await queryOne('SELECT COUNT(*) AS count FROM agent_goals WHERE user_id = ? AND status != \'deleted\'', [user.id]);
    if (Number(count?.count || 0) >= MAX_GOALS_PER_USER) throw invalid(`每个账号最多创建 ${MAX_GOALS_PER_USER} 个持续目标。`, 409);
    const bodyTrigger = body.triggerSpec || body.trigger_spec || {};
    const token = bodyTrigger.type === 'webhook' && !bodyTrigger.token && !bodyTrigger.tokenHash && !bodyTrigger.token_hash ? generateGoalToken() : null;
    const data = normalizeGoalInput(token ? { ...body, triggerSpec: { ...bodyTrigger, token } } : body);
    const tenantId = options.tenantId || user.tenant_id || await getPrimaryTenantId(user.id);
    const now = getBeijingTimestamp();
    const id = `goal_${crypto.randomUUID()}`;
    const nextRunAt = data.status === 'active' ? computeNextGoalRun(data.triggerSpec, now) : null;
    await execute(`
        INSERT INTO agent_goals (id, user_id, tenant_id, title, goal, priority, status, trigger_spec, authorization_spec, budget_spec, cooldown_seconds, max_failures, next_run_at, version, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::timestamptz, 1, ?::timestamptz, ?::timestamptz)
    `, [id, user.id, tenantId, data.title, data.goal, data.priority, data.status, JSON.stringify(data.triggerSpec), JSON.stringify(data.authorizationSpec), JSON.stringify(data.budgetSpec), data.cooldownSeconds, data.maxFailures, nextRunAt, now, now]);
    return { goal: parseRow(await queryOne('SELECT * FROM agent_goals WHERE id = ?', [id])), token };
}

async function updateAgentGoal(id, user, body = {}) {
    const current = await queryOne('SELECT * FROM agent_goals WHERE id = ? AND user_id = ? AND status != \'deleted\'', [String(id || ''), user.id]);
    if (!current) return null;
    const data = normalizeGoalInput({
        ...parseRow(current),
        ...body,
        triggerSpec: body.triggerSpec || body.trigger_spec || parseJson(current.trigger_spec, {}),
        authorizationSpec: body.authorizationSpec || body.authorization_spec || parseJson(current.authorization_spec, {}),
        budgetSpec: body.budgetSpec || body.budget_spec || parseJson(current.budget_spec, {})
    });
    const now = getBeijingTimestamp();
    const nextRunAt = data.status === 'active' ? computeNextGoalRun(data.triggerSpec, now) : null;
    await execute(`UPDATE agent_goals SET title = ?, goal = ?, priority = ?, status = ?, trigger_spec = ?, authorization_spec = ?, budget_spec = ?, cooldown_seconds = ?, max_failures = ?, next_run_at = ?::timestamptz, failure_count = 0, last_error = '', version = version + 1, paused_at = CASE WHEN ? = 'paused' THEN ?::timestamptz ELSE NULL END, updated_at = ?::timestamptz WHERE id = ? AND user_id = ?`, [data.title, data.goal, data.priority, data.status, JSON.stringify(data.triggerSpec), JSON.stringify(data.authorizationSpec), JSON.stringify(data.budgetSpec), data.cooldownSeconds, data.maxFailures, nextRunAt, data.status, data.status === 'paused' ? now : null, now, current.id, user.id]);
    return parseRow(await queryOne('SELECT * FROM agent_goals WHERE id = ?', [current.id]));
}

async function setAgentGoalStatus(id, user, status) {
    if (!['active', 'paused', 'completed', 'deleted'].includes(status)) throw invalid('持续目标状态不允许切换。');
    const current = await queryOne('SELECT * FROM agent_goals WHERE id = ? AND user_id = ? AND status != \'deleted\'', [String(id || ''), user.id]);
    if (!current) return null;
    const now = getBeijingTimestamp();
    const next = status === 'active' ? computeNextGoalRun(parseJson(current.trigger_spec, {}), now) : null;
    await execute('UPDATE agent_goals SET status = ?, next_run_at = ?::timestamptz, paused_at = CASE WHEN ? = \'paused\' THEN ?::timestamptz ELSE paused_at END, ended_at = CASE WHEN ? IN (\'completed\', \'deleted\') THEN ?::timestamptz ELSE ended_at END, updated_at = ?::timestamptz, version = version + 1 WHERE id = ? AND user_id = ?', [status, next, status, now, status, now, now, current.id, user.id]);
    return parseRow(await queryOne('SELECT * FROM agent_goals WHERE id = ?', [current.id]));
}

function ensureCreateRun() {
    if (typeof createAgentRunCallback !== 'function') throw invalid('持续目标运行时尚未初始化。', 503);
    return createAgentRunCallback;
}

function readByPath(payload, pathText) {
    return String(pathText || '').split('.').filter(Boolean).reduce((value, key) => value == null ? undefined : value[key], payload);
}

function startGoalClaimRenewal(goalId, claimToken) {
    let running = false;
    const timer = setInterval(async () => {
        if (running) return;
        running = true;
        try {
            await execute(`
                UPDATE agent_goals
                SET claim_expires_at = ?, updated_at = ?::timestamptz
                WHERE id = ? AND status = 'active' AND claim_token = ?
            `, [getBeijingTimestamp(new Date(Date.now() + GOAL_CLAIM_LEASE_MS)), getBeijingTimestamp(), goalId, claimToken]);
        } catch (error) {
            // 续租失败不放宽权限；当前处理完成后仍会用 token 条件释放/提交，
            // 让其它实例可以在租约真正到期后接管。
        } finally {
            running = false;
        }
    }, GOAL_CLAIM_RENEW_INTERVAL_MS);
    timer.unref?.();
    return () => clearInterval(timer);
}

async function claimAgentGoal(goalId, claimToken = crypto.randomUUID()) {
    const token = String(claimToken || '').trim().slice(0, 128);
    if (!token) return false;
    const changes = await execute(`
        UPDATE agent_goals
        SET claim_token = ?, claim_expires_at = ?, updated_at = ?::timestamptz
        WHERE id = ? AND status = 'active' AND next_run_at IS NOT NULL AND next_run_at <= NOW()
          AND (claim_token IS NULL OR claim_expires_at IS NULL OR claim_expires_at <= NOW())
    `, [token, getBeijingTimestamp(new Date(Date.now() + GOAL_CLAIM_LEASE_MS)), getBeijingTimestamp(), goalId]);
    return changes === 1 ? token : false;
}

async function runAgentGoalNow(goal, user, options = {}) {
    const run = ensureCreateRun();
    const auth = parseJson(goal.authorization_spec ?? goal.authorizationSpec, {});
    const budget = parseJson(goal.budget_spec ?? goal.budgetSpec, {});
    if (auth.expiresAt && new Date(auth.expiresAt).getTime() <= Date.now()) throw invalid('持续目标授权已过期。', 403);
    const maxRuns = Number(budget.maxRunsPerWindow || budget.max_runs_per_window || 0);
    if (maxRuns > 0) {
        const windowSeconds = Number(budget.windowSeconds || budget.window_seconds || 86400);
        const windowStart = new Date(Date.now() - windowSeconds * 1000).toISOString();
        const count = await queryOne("SELECT COUNT(*) AS count FROM agent_runs WHERE user_id = ? AND created_at >= ? AND metadata->>'goalId' = ? AND deleted_at IS NULL", [user.id, windowStart, goal.id]);
        if (Number(count?.count || 0) >= maxRuns) throw invalid('持续目标已达到运行窗口配额。', 429);
    }
    const triggerSpec = parseJson(goal.trigger_spec ?? goal.triggerSpec, {});
    if (!options.triggerType && triggerSpec.type === 'timer' && goal.last_run_id && goal.cooldown_seconds) {
        const recent = await queryOne('SELECT created_at FROM agent_runs WHERE id = ? AND created_at >= ?', [goal.last_run_id, new Date(Date.now() - Number(goal.cooldown_seconds) * 1000).toISOString()]);
        if (recent) throw invalid('持续目标仍在冷却时间内。', 429);
    }
    const triggerKey = String(options.triggerKey || `goal:${goal.id}:${options.scheduledFor || Date.now()}`).slice(0, 256);
    const existing = await queryOne('SELECT id, status FROM agent_runs WHERE user_id = ? AND dedupe_key = ? AND deleted_at IS NULL', [user.id, triggerKey]);
    if (existing) return { id: existing.id, deduped: true, status: existing.status };
    const created = await run({
        user,
        goal: goal.goal,
        title: goal.title,
        runMode: options.runMode || 'standard',
        toolPolicy: auth.toolPolicy,
        toolAllowlist: auth.toolAllowlist,
        approvalPolicy: auth.approvalPolicy,
        networkPolicy: auth.networkPolicy,
        maxSteps: budget.maxSteps,
        maxTokenBudget: budget.maxTokenBudget,
        dedupeKey: triggerKey,
        metadata: {
            source: 'goal',
            goalId: goal.id,
            goalVersion: goal.version,
            triggerType: options.triggerType || triggerSpec.type || 'manual',
            triggerKey,
            triggerInputs: options.metadata || {}
        },
        contextConfig: options.metadata && typeof options.metadata === 'object' ? { goalTriggerInputs: options.metadata } : undefined
    });
    const now = getBeijingTimestamp();
    const claimToken = String(options.claimToken || '').trim();
    const claimClause = claimToken ? ' AND claim_token = ?' : '';
    await execute(`UPDATE agent_goals SET last_run_id = ?, last_trigger_key = ?, next_run_at = ?::timestamptz, updated_at = ?::timestamptz WHERE id = ? AND user_id = ?${claimClause}`, [created.id, triggerKey, options.nextRunAt || goal.next_run_at || null, now, goal.id, user.id, ...(claimToken ? [claimToken] : [])]);
    try { await createAgentNotificationCallback(user.id, created.id, 'goal', '持续目标已启动', goal.title); } catch (_) {}
    return created;
}

function isGoalPathAllowed(directory) {
    const roots = String(process.env.AGENT_GOAL_FILE_ROOTS || process.env.AGENT_REPORT_ROOTS || '').split(',').map(item => item.trim()).filter(Boolean).map(item => path.resolve(item));
    const target = path.resolve(directory);
    return roots.length > 0 && roots.some(root => target === root || target.startsWith(`${root}${path.sep}`));
}

async function pollFileGoal(row, user) {
    const trigger = parseJson(row.trigger_spec, {});
    if (!isGoalPathAllowed(trigger.directory) || !fs.existsSync(trigger.directory)) return [];
    const entries = fs.readdirSync(trigger.directory, { withFileTypes: true }).filter(entry => entry.isFile()).filter(entry => !trigger.extensions?.length || trigger.extensions.includes(path.extname(entry.name).replace(/^\./, '').toLowerCase())).slice(0, 100);
    const created = [];
    for (const entry of entries) {
        const filePath = path.join(trigger.directory, entry.name);
        const stat = fs.statSync(filePath);
        if (Date.now() - stat.mtimeMs < Number(trigger.stableSeconds || 5) * 1000) continue;
        const fingerprint = `${entry.name}:${stat.size}:${stat.mtimeMs}`;
        const key = `goal:${row.id}:file:${crypto.createHash('sha256').update(fingerprint).digest('hex').slice(0, 32)}`;
        const run = await runAgentGoalNow(row, user, { triggerType: 'file', claimToken: row.claim_token, triggerKey: key, metadata: { [trigger.inputName || 'filePath']: filePath, fileName: entry.name, fileSize: stat.size, modifiedAt: getBeijingTimestamp(new Date(stat.mtimeMs)) } });
        if (!run?.deduped) created.push(run);
    }
    return created;
}

async function pollDatabaseGoal(row, user) {
    if (typeof goalDataRunner !== 'function') return [];
    const trigger = parseJson(row.trigger_spec, {});
    const watermark = String(trigger.watermark || '');
    const sql = trigger.query.replace(/\{\{watermark\}\}/g, watermark.replace(/'/g, "''"));
    const result = await goalDataRunner(trigger.connectionId, sql, user);
    const rows = Array.isArray(result?.rows) ? result.rows : Array.isArray(result) ? result : Array.isArray(result?.structuredContent?.rows) ? result.structuredContent.rows : [];
    if (!rows.length) return [];
    const values = rows.map(item => item?.[trigger.watermarkField]).filter(value => value !== undefined && value !== null).map(String).sort();
    const nextWatermark = values[values.length - 1] || watermark;
    const key = `goal:${row.id}:database:${crypto.createHash('sha256').update(`${nextWatermark}:${rows.length}`).digest('hex').slice(0, 32)}`;
    const run = await runAgentGoalNow(row, user, { triggerType: 'database', claimToken: row.claim_token, triggerKey: key, metadata: { [trigger.inputName || 'rows']: rows, watermark: nextWatermark, rowCount: rows.length } });
    if (!run?.deduped) {
        trigger.watermark = nextWatermark;
        await execute('UPDATE agent_goals SET trigger_spec = ?, updated_at = ?::timestamptz WHERE id = ? AND claim_token = ?', [JSON.stringify(trigger), getBeijingTimestamp(), row.id, row.claim_token || null]);
        return [run];
    }
    return [];
}

async function runDueAgentGoals(limit = 20) {
    const due = await query(`
        SELECT g.*, u.username, u.nickname, u.unit, u.role, g.tenant_id AS tenant_id
        FROM agent_goals g JOIN users u ON u.id = g.user_id
        WHERE g.status = 'active' AND g.next_run_at IS NOT NULL AND g.next_run_at <= NOW()
          AND u.deleted_at IS NULL AND COALESCE(u.status, 'active') != 'disabled'
          AND (g.claim_token IS NULL OR g.claim_expires_at IS NULL OR g.claim_expires_at <= NOW())
        ORDER BY g.next_run_at ASC LIMIT ?
    `, [Math.max(1, Math.min(Number.parseInt(limit, 10) || 20, 100))]);
    const created = [];
    for (const row of due) {
        const claimToken = crypto.randomUUID();
        if (!(await claimAgentGoal(row.id, claimToken))) continue;

        // 只有拿到 claim_token 的实例可以推进水位线、下次执行时间和失败熔断状态。
        // Agent Run 的 dedupe key 仍保留，作为第二道幂等保护。
        const claimedRow = { ...row, claim_token: claimToken };
        const stopClaimRenewal = startGoalClaimRenewal(row.id, claimToken);
        const trigger = parseJson(row.trigger_spec, {});
        const user = { id: row.user_id, username: row.username, nickname: row.nickname, unit: row.unit, role: row.role, tenant_id: row.tenant_id };
        const scheduledFor = String(row.next_run_at || '');
        try {
            const triggerType = trigger.type || 'timer';
            if (triggerType === 'file') {
                created.push(...await pollFileGoal(claimedRow, user));
                await execute('UPDATE agent_goals SET next_run_at = ?::timestamptz, updated_at = ?::timestamptz WHERE id = ? AND claim_token = ?', [getBeijingTimestamp(new Date(Date.now() + 60000)), getBeijingTimestamp(), row.id, claimToken]);
                continue;
            }
            if (triggerType === 'database') {
                created.push(...await pollDatabaseGoal(claimedRow, user));
                await execute('UPDATE agent_goals SET next_run_at = ?::timestamptz, updated_at = ?::timestamptz WHERE id = ? AND claim_token = ?', [getBeijingTimestamp(new Date(Date.now() + 60000)), getBeijingTimestamp(), row.id, claimToken]);
                continue;
            }
            const run = await runAgentGoalNow(claimedRow, user, { triggerType: 'timer', scheduledFor, claimToken, triggerKey: `goal:${row.id}:${scheduledFor}`, nextRunAt: computeNextGoalRun(trigger, getBeijingTimestamp()) });
            await execute('UPDATE agent_goals SET next_run_at = ?::timestamptz, failure_count = 0, last_error = \'\', updated_at = ?::timestamptz WHERE id = ? AND claim_token = ?', [computeNextGoalRun(trigger, getBeijingTimestamp()), getBeijingTimestamp(), row.id, claimToken]);
            created.push(run);
        } catch (error) {
            const failureCount = Number(row.failure_count || 0) + 1;
            const paused = failureCount >= Number(row.max_failures || 5);
            await execute('UPDATE agent_goals SET failure_count = ?, status = CASE WHEN ? THEN \'paused\' ELSE status END, next_run_at = CASE WHEN ? THEN NULL ELSE next_run_at END, last_error = ?, updated_at = ?::timestamptz WHERE id = ? AND claim_token = ?', [failureCount, paused, paused, String(error.message || '目标调度失败').slice(0, 1000), getBeijingTimestamp(), row.id, claimToken]);
            try { await createAgentNotificationCallback(row.user_id, null, paused ? 'error' : 'warning', paused ? '持续目标已熔断' : '持续目标调度失败', `${row.title}: ${error.message}`); } catch (_) {}
        } finally {
            stopClaimRenewal();
            await execute('UPDATE agent_goals SET claim_token = NULL, claim_expires_at = NULL, updated_at = ?::timestamptz WHERE id = ? AND claim_token = ?', [getBeijingTimestamp(), row.id, claimToken]);
        }
    }
    return created;
}

async function dispatchAgentGoalWebhook(token, payload = {}, meta = {}) {
    const tokenHash = hashGoalToken(token);
    const row = await queryOne("SELECT * FROM agent_goals WHERE status = 'active' AND trigger_spec->>'type' = 'webhook' AND trigger_spec->>'tokenHash' = ?", [tokenHash]);
    if (!row) return null;
    const trigger = parseJson(row.trigger_spec, {});
    const now = Date.now();
    const eventTime = meta.timestamp
        ? (Number.isFinite(Number(meta.timestamp)) ? Number(meta.timestamp) : Date.parse(String(meta.timestamp)))
        : now;
    if (meta.timestamp && (!Number.isFinite(eventTime) || Math.abs(now - eventTime) > Number(trigger.replayWindowSeconds || 300) * 1000)) return null;
    if (trigger.requireSignature) {
        const provided = String(meta.signature || '').trim().replace(/^sha256=/i, '');
        const expected = crypto.createHmac('sha256', String(token)).update(`${meta.timestamp || ''}.${JSON.stringify(payload)}`).digest('hex');
        if (!provided || provided.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected))) return null;
    }
    if (trigger.sourceAllowlist?.length && meta.sourceIp && !trigger.sourceAllowlist.includes(meta.sourceIp)) return null;
    const dedupeValue = trigger.dedupePath ? readByPath(payload, trigger.dedupePath) : meta.idempotencyKey;
    const triggerKey = dedupeValue ? `goal:${row.id}:webhook:${String(dedupeValue).slice(0, 160)}` : `goal:${row.id}:webhook:${crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 32)}`;
    const user = await queryOne("SELECT id, username, nickname, unit, role FROM users WHERE id = ? AND deleted_at IS NULL AND COALESCE(status, 'active') != 'disabled'", [row.user_id]);
    if (!user) return null;
    const inputs = {};
    Object.entries(trigger.inputMapping || {}).forEach(([key, pathText]) => {
        const value = readByPath(payload, pathText);
        if (value !== undefined) inputs[key] = value;
    });
    if (!Object.keys(inputs).length) inputs.payload = payload;
    const run = await runAgentGoalNow(row, user, { triggerType: 'webhook', triggerKey, metadata: inputs });
    return { runId: run.id, goalId: row.id, goalTitle: row.title };
}

async function recordAgentGoalRunOutcome(runId, outcome) {
    const run = await queryOne("SELECT id, user_id, metadata FROM agent_runs WHERE id = ? AND metadata->>'goalId' IS NOT NULL", [String(runId || '')]);
    if (!run) return null;
    const metadata = parseJson(run.metadata, {});
    const goal = await queryOne('SELECT * FROM agent_goals WHERE id = ? AND user_id = ?', [metadata.goalId, run.user_id]);
    if (!goal) return null;
    const success = String(outcome || '') === 'success';
    const failures = success ? 0 : Number(goal.failure_count || 0) + 1;
    const paused = !success && failures >= Number(goal.max_failures || 5);
    await execute("UPDATE agent_goals SET failure_count = ?, status = CASE WHEN ? THEN 'paused' ELSE status END, next_run_at = CASE WHEN ? THEN NULL ELSE next_run_at END, last_error = CASE WHEN ? THEN '' ELSE last_error END, updated_at = ?::timestamptz WHERE id = ?", [failures, paused, paused, success, getBeijingTimestamp(), goal.id]);
    return { goalId: goal.id, failureCount: failures, paused };
}

module.exports = {
    GOAL_STATUSES,
    GOAL_TRIGGER_TYPES,
    claimAgentGoal,
    configureAgentGoals,
    createAgentGoal,
    dispatchAgentGoalWebhook,
    generateGoalToken,
    getAgentGoal,
    hashGoalToken,
    listAgentGoals,
    normalizeGoalInput,
    normalizeTriggerSpec,
    recordAgentGoalRunOutcome,
    runAgentGoalNow,
    runDueAgentGoals,
    setAgentGoalStatus,
    updateAgentGoal
};
