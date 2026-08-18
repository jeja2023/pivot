/* 工作流触发器：承载入站 Webhook、文件落地和数据变更三类触发方式。
   触发器只创建运行任务，具体执行仍交给既有的自动化队列。 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { query, queryOne, execute } = require('../db/client');
const { logger } = require('../logger');
const { getBeijingTimestamp } = require('../time');
const { resolveAgentWorkflowVersion, normalizeDagInputsPayload } = require('./agent-workflows');
const { resolveAgentWorkflowDependencyBindings } = require('./agent-workflow-dependencies');
const { getBuiltinConfigForServer, isPathInside } = require('./builtin-mcp-common');

const TRIGGER_TYPES = new Set(['webhook', 'file', 'database']);
const TRIGGER_STATUSES = new Set(['active', 'paused']);
const MAX_TRIGGERS_PER_USER = 50;
// 入站请求体上限，避免异常大 payload 进入运行参数
const MAX_WEBHOOK_PAYLOAD_BYTES = 256 * 1024;
// 单轮轮询最多为一个触发器创建的任务数，防止历史文件一次性灌满队列
const MAX_BATCH_PER_POLL = 20;
const MAX_FILE_SCAN = 500;
const POLL_LEASE_MS = Math.max(Number.parseInt(process.env.AGENT_TRIGGER_POLL_LEASE_MS || '120000', 10) || 120000, 30000);

let createAgentRunCallback = null;
let createAgentNotificationCallback = () => null;

function configureAgentTriggers({ createAgentRun, createAgentNotification } = {}) {
    if (typeof createAgentRun === 'function') createAgentRunCallback = createAgentRun;
    if (typeof createAgentNotification === 'function') createAgentNotificationCallback = createAgentNotification;
}

function invalid(message, status = 400) {
    const err = new Error(message);
    err.status = status;
    return err;
}

function hashTriggerToken(token) {
    return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function generateTriggerToken() {
    return `wht_${crypto.randomBytes(24).toString('hex')}`;
}

function parseJson(value, fallback = {}) {
    try {
        const parsed = JSON.parse(value || '');
        return parsed && typeof parsed === 'object' ? parsed : fallback;
    } catch (_err) {
        return fallback;
    }
}

// 归一化各类触发器的配置，未知字段一律丢弃
function normalizeTriggerConfig(triggerType, raw = {}) {
    const config = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    if (triggerType === 'webhook') {
        return {
            // 把入站 payload 映射到工作流输入：键为工作流输入名，值为 payload 中的取值路径
            inputMapping: normalizeMapping(config.inputMapping ?? config.input_mapping),
            // 固定输入，用于给同一个工作流的不同触发器区分来源
            staticInputs: normalizeDagInputsPayload(config.staticInputs ?? config.static_inputs ?? {}),
            // 幂等字段路径：取到值后作为去重键，重复推送只会创建一个任务
            dedupePath: String(config.dedupePath ?? config.dedupe_path ?? '').trim().slice(0, 120),
            goalTemplate: String(config.goalTemplate ?? config.goal_template ?? '').trim().slice(0, 2000)
        };
    }
    if (triggerType === 'file') {
        return {
            directory: String(config.directory || '').trim().slice(0, 400),
            // 只匹配指定扩展名，留空表示不限
            extensions: normalizeExtensions(config.extensions),
            inputName: normalizeInputName(config.inputName ?? config.input_name, 'filePath'),
            goalTemplate: String(config.goalTemplate ?? config.goal_template ?? '').trim().slice(0, 2000)
        };
    }
    return {
        connectionId: String(config.connectionId ?? config.connection_id ?? '').trim().slice(0, 80),
        // 只读 SQL，必须包含 {{watermark}} 占位符，运行时替换为上次水位线
        query: String(config.query || '').trim().slice(0, 4000),
        watermarkField: normalizeInputName(config.watermarkField ?? config.watermark_field, 'updated_at'),
        initialWatermark: String(config.initialWatermark ?? config.initial_watermark ?? '').trim().slice(0, 120),
        inputName: normalizeInputName(config.inputName ?? config.input_name, 'rows'),
        goalTemplate: String(config.goalTemplate ?? config.goal_template ?? '').trim().slice(0, 2000)
    };
}

function normalizeInputName(value, fallback) {
    const name = String(value || '').trim().slice(0, 80);
    return /^[A-Za-z0-9_-]+$/.test(name) ? name : fallback;
}

function normalizeExtensions(value) {
    const list = Array.isArray(value)
        ? value
        : String(value || '').split(',');
    return list
        .map(item => String(item || '').trim().replace(/^\./, '').toLowerCase())
        .filter(item => /^[a-z0-9]{1,12}$/.test(item))
        .slice(0, 20);
}

function normalizeMapping(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out = {};
    Object.entries(raw).slice(0, 30).forEach(([key, val]) => {
        const cleanKey = String(key || '').trim().slice(0, 80);
        const cleanVal = String(val || '').trim().slice(0, 120);
        if (/^[A-Za-z0-9_.-]+$/.test(cleanKey) && cleanVal) {
            out[cleanKey] = cleanVal;
        }
    });
    return out;
}

// 嵌套路径取值，支持 a.b.c 或 a[0].b
function readByPath(target, pathText) {
    if (!target || typeof target !== 'object' || !pathText) return undefined;
    const segments = String(pathText)
        .replace(/\[(\w+)\]/g, '.$1')
        .split('.')
        .map(s => s.trim())
        .filter(Boolean);
    let cur = target;
    for (const segment of segments) {
        if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
        cur = cur[segment];
    }
    return cur;
}

function normalizeTriggerPayload(body = {}) {
    const name = String(body.name || '').trim().slice(0, 80);
    if (!name || name.length < 2) throw invalid('请填写触发器名称（至少 2 个字符）。');
    const triggerType = String(body.triggerType || body.trigger_type || '').trim().toLowerCase();
    if (!TRIGGER_TYPES.has(triggerType)) throw invalid('触发器类型无效。');
    const workflowId = Number.parseInt(body.workflowId ?? body.workflow_id, 10);
    if (!workflowId || Number.isNaN(workflowId)) throw invalid('请选择要触发的工作流。');
    const status = TRIGGER_STATUSES.has(body.status) ? body.status : 'active';
    const config = normalizeTriggerConfig(triggerType, body.config || body.configJson || body.config_json);
    if (triggerType === 'file' && !config.directory) throw invalid('文件触发器必须填写监听目录。');
    if (triggerType === 'database') {
        if (!config.connectionId) throw invalid('数据变更触发器必须选择数据库连接。');
        if (!config.query) throw invalid('数据变更触发器必须填写增量查询 SQL。');
        if (!config.query.includes('{{watermark}}')) {
            throw invalid('增量查询 SQL 中必须包含 {{watermark}} 占位符。');
        }
    }
    return { name, triggerType, workflowId, status, config };
}

function formatTrigger(row) {
    if (!row) return null;
    return {
        id: row.id,
        userId: row.user_id,
        workflowId: row.workflow_id,
        workflowName: row.workflow_name || undefined,
        name: row.name,
        triggerType: row.trigger_type,
        tokenHint: row.token_hint || '',
        status: row.status,
        config: parseJson(row.config_json, {}),
        watermark: row.watermark || '',
        lastTriggeredAt: row.last_triggered_at || null,
        lastRunId: row.last_run_id || null,
        triggerCount: Number(row.trigger_count || 0),
        lastError: row.last_error || null,
        createdAt: row.created_at,
        updatedAt: row.updated_at
    };
}

async function listWorkflowTriggers(user) {
    const rows = await query(`
        SELECT t.*, w.name AS workflow_name
        FROM agent_workflow_triggers t
        LEFT JOIN agent_workflows w ON w.id = t.workflow_id
        WHERE t.user_id = ? AND t.deleted_at IS NULL
        ORDER BY t.created_at DESC
    `, [user.id]);
    return rows.map(formatTrigger);
}

async function assertTriggerWorkflowAccess(workflowId, user) {
    const resolved = await resolveAgentWorkflowVersion(workflowId, user, 'published');
    if (!resolved) throw invalid('工作流不存在、无权访问或尚未发布。', 404);
    return await resolveAgentWorkflowDependencyBindings(resolved, user);
}

async function createWorkflowTrigger(user, body = {}) {
    const data = normalizeTriggerPayload(body);
    const countRow = await queryOne('SELECT COUNT(*) AS count FROM agent_workflow_triggers WHERE user_id = ? AND deleted_at IS NULL', [user.id]);
    const count = Number(countRow?.count || 0);
    if (count >= MAX_TRIGGERS_PER_USER) throw invalid(`每个账号最多创建 ${MAX_TRIGGERS_PER_USER} 个触发器。`, 409);
    await assertTriggerWorkflowAccess(data.workflowId, user);
    // 创建阶段就校验目录授权，避免保存成功但每轮轮询都失败
    if (data.triggerType === 'file') await assertDirectoryWithinReportRoots(data.config.directory, user.id);

    const now = getBeijingTimestamp();
    const token = data.triggerType === 'webhook' ? generateTriggerToken() : null;
    const inserted = await queryOne(`
        INSERT INTO agent_workflow_triggers (
            user_id, workflow_id, name, trigger_type, token_hash, token_hint,
            status, config_json, watermark, trigger_count, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
        RETURNING id
    `, [
        user.id, data.workflowId, data.name, data.triggerType,
        token ? hashTriggerToken(token) : null,
        token ? token.slice(-6) : '',
        data.status, JSON.stringify(data.config),
        data.triggerType === 'database' ? String(data.config.initialWatermark || '') : '',
        now, now
    ]);
    const row = await queryOne('SELECT * FROM agent_workflow_triggers WHERE id = ?', [inserted?.id]);
    // 明文 token 只在创建和轮换时返回一次，之后只保留摘要
    return { trigger: formatTrigger(row), token };
}

async function updateWorkflowTrigger(triggerId, user, body = {}) {
    const current = await queryOne('SELECT * FROM agent_workflow_triggers WHERE id = ? AND user_id = ? AND deleted_at IS NULL', [triggerId, user.id]);
    if (!current) return null;
    const data = normalizeTriggerPayload({ ...body, triggerType: current.trigger_type });
    await assertTriggerWorkflowAccess(data.workflowId, user);
    const now = getBeijingTimestamp();
    await execute(`
        UPDATE agent_workflow_triggers
        SET workflow_id = ?, name = ?, status = ?, config_json = ?, last_error = NULL, updated_at = ?
        WHERE id = ?
    `, [data.workflowId, data.name, data.status, JSON.stringify(data.config), now, current.id]);
    const updated = await queryOne('SELECT * FROM agent_workflow_triggers WHERE id = ?', [current.id]);
    return formatTrigger(updated);
}

async function rotateWorkflowTriggerToken(triggerId, user) {
    const current = await queryOne('SELECT * FROM agent_workflow_triggers WHERE id = ? AND user_id = ? AND deleted_at IS NULL', [triggerId, user.id]);
    if (!current) return null;
    if (current.trigger_type !== 'webhook') throw invalid('只有入站 Webhook 触发器才有访问令牌。');
    const token = generateTriggerToken();
    const now = getBeijingTimestamp();
    await execute('UPDATE agent_workflow_triggers SET token_hash = ?, token_hint = ?, updated_at = ? WHERE id = ?', [
        hashTriggerToken(token), token.slice(-6), now, current.id
    ]);
    const updated = await queryOne('SELECT * FROM agent_workflow_triggers WHERE id = ?', [current.id]);
    return { trigger: formatTrigger(updated), token };
}

async function deleteWorkflowTrigger(triggerId, user) {
    const current = await queryOne('SELECT * FROM agent_workflow_triggers WHERE id = ? AND user_id = ? AND deleted_at IS NULL', [triggerId, user.id]);
    if (!current) return null;
    const now = getBeijingTimestamp();
    await execute('UPDATE agent_workflow_triggers SET deleted_at = ?, token_hash = NULL, updated_at = ? WHERE id = ?', [
        now, now, current.id
    ]);
    return formatTrigger(current);
}

function ensureCreateAgentRun() {
    if (typeof createAgentRunCallback !== 'function') {
        throw new Error('触发器运行入口未初始化。');
    }
    return createAgentRunCallback;
}

// 读取触发器所属账号，账号停用或删除后触发一律拒绝
async function getTriggerUser(userId) {
    return await queryOne(`
        SELECT id, COALESCE(NULLIF(deleted_username, ''), username) AS username, nickname, unit, role
        FROM users
        WHERE id = ? AND deleted_at IS NULL AND COALESCE(status, 'active') != 'disabled'
    `, [userId]);
}

// 触发器共用的任务创建逻辑，统一带上来源标记和幂等键
async function createTriggerRun(trigger, user, { inputs, goal, dedupeKey }) {
    const createRun = ensureCreateAgentRun();
    // 先确认工作流仍可访问且处于已发布状态，运行时会按同一版本再解析一次
    await assertTriggerWorkflowAccess(trigger.workflow_id, user);
    const run = await createRun({
        user,
        goal: goal || `由触发器「${trigger.name}」启动`,
        title: trigger.name,
        runMode: 'dag',
        workflowId: trigger.workflow_id,
        workflowVersion: 'published',
        dagInputs: normalizeDagInputsPayload(inputs || {}),
        dedupeKey,
        metadata: {
            source: 'trigger',
            triggerId: trigger.id,
            triggerName: trigger.name,
            triggerType: trigger.trigger_type
        }
    });
    const now = getBeijingTimestamp();
    await execute(`
        UPDATE agent_workflow_triggers
        SET last_triggered_at = ?, last_run_id = ?, trigger_count = trigger_count + 1,
            last_error = NULL, updated_at = ?
        WHERE id = ?
    `, [now, run.id, now, trigger.id]);
    // 与计划任务保持一致：触发入队后写一条用户通知，便于在通知中心追溯来源
    try {
        createAgentNotificationCallback(user.id, run.id, 'trigger', '触发器已启动工作流', trigger.name);
    } catch (notificationError) {
        logger.warn({ err: notificationError.message, triggerId: trigger.id }, '触发器通知写入失败');
    }
    return run;
}

async function recordTriggerError(triggerId, message) {
    const now = getBeijingTimestamp();
    await execute('UPDATE agent_workflow_triggers SET last_error = ?, updated_at = ? WHERE id = ?', [
        String(message || '触发失败').slice(0, 1000), now, triggerId
    ]);
}

/**
 * 处理一次入站 Webhook 推送。
 * token 通过 sha256 比对，未命中、已暂停或账号失效都返回 null 由路由层统一转 404，
 * 避免通过响应差异探测有效 token。
 */
async function dispatchWebhookTrigger(token, payload = {}, meta = {}) {
    const tokenHash = hashTriggerToken(token);
    const trigger = await queryOne(`
        SELECT * FROM agent_workflow_triggers
        WHERE token_hash = ? AND trigger_type = 'webhook' AND deleted_at IS NULL
    `, [tokenHash]);
    if (!trigger || trigger.status !== 'active') return null;

    const user = await getTriggerUser(trigger.user_id);
    if (!user) return null;

    const config = parseJson(trigger.config_json, {});
    const inputs = { ...(config.staticInputs || {}) };
    Object.entries(config.inputMapping || {}).forEach(([inputName, pathText]) => {
        const value = readByPath(payload, pathText);
        if (value !== undefined) inputs[inputName] = value;
    });
    // 未配置映射时把整个 payload 作为 payload 输入，便于工作流内自行取值
    if (!Object.keys(config.inputMapping || {}).length) inputs.payload = payload;

    const dedupeValue = config.dedupePath ? readByPath(payload, config.dedupePath) : null;
    const dedupeKey = dedupeValue === undefined || dedupeValue === null || dedupeValue === ''
        ? null
        : `trigger:${trigger.id}:${String(dedupeValue).slice(0, 160)}`;

    try {
        const run = await createTriggerRun(trigger, user, {
            inputs,
            goal: config.goalTemplate || `由入站 Webhook「${trigger.name}」启动`,
            dedupeKey
        });
        logger.info({ triggerId: trigger.id, runId: run.id, sourceIp: meta.sourceIp || '' }, '入站 Webhook 已触发工作流');
        return { runId: run.id, triggerName: trigger.name };
    } catch (err) {
        await recordTriggerError(trigger.id, err.message);
        logger.error({ err: err.message, triggerId: trigger.id }, '入站 Webhook 触发工作流失败');
        throw err;
    }
}

/**
 * 校验监听目录是否落在该账号已配置的报表目录范围内。
 * 复用工具库既有的目录授权边界，触发器不新开一条可读路径。
 */
async function assertDirectoryWithinReportRoots(directory, userId) {
    const target = path.resolve(directory);
    // 报表目录配置存放在 mcp_builtin_configs，服务归属限定为本人或全局服务。
    // service_type 存在多个历史别名，统一交给 getBuiltinConfigForServer 归一化后再判断
    const servers = await query(`
        SELECT c.mcp_server_id
        FROM mcp_builtin_configs c
        JOIN mcp_servers s ON s.id = c.mcp_server_id
        WHERE c.status != 'deleted' AND s.status = 'active'
          AND (s.user_id = ? OR s.user_id IS NULL)
    `, [userId]);
    const roots = servers
        .map(item => getBuiltinConfigForServer(item.mcp_server_id))
        .filter(config => config?.service_type === 'reports')
        .flatMap(config => config.config?.roots || [])
        .map(root => path.resolve(root));
    if (!roots.length) {
        throw invalid('请先在工具库配置服务器可访问报表目录，再创建文件触发器。', 403);
    }
    if (!roots.some(root => isPathInside(root, target))) {
        throw invalid('监听目录必须位于已配置的报表目录范围内。', 403);
    }
    return target;
}

// 扫描监听目录，为每个新增文件创建一次运行；已处理文件通过幂等键跳过
async function pollFileTrigger(trigger) {
    const config = parseJson(trigger.config_json, {});
    const rawDirectory = String(config.directory || '').trim();
    if (!rawDirectory) return [];
    const user = await getTriggerUser(trigger.user_id);
    if (!user) return [];

    let directory = '';
    try {
        directory = await assertDirectoryWithinReportRoots(rawDirectory, trigger.user_id);
    } catch (err) {
        await recordTriggerError(trigger.id, err.message);
        return [];
    }
    if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
        await recordTriggerError(trigger.id, '监听目录不存在或不是目录。');
        return [];
    }

    const extensions = Array.isArray(config.extensions) ? config.extensions : [];
    const entries = fs.readdirSync(directory, { withFileTypes: true })
        .filter(entry => entry.isFile())
        .slice(0, MAX_FILE_SCAN)
        .filter(entry => {
            if (!extensions.length) return true;
            return extensions.includes(path.extname(entry.name).replace(/^\./, '').toLowerCase());
        });

    const created = [];
    for (const entry of entries) {
        if (created.length >= MAX_BATCH_PER_POLL) break;
        const filePath = path.join(directory, entry.name);
        let stat = null;
        try {
            stat = fs.statSync(filePath);
        } catch (_err) {
            continue;
        }
        // 文件名 + 修改时间 + 大小构成幂等键，同一份文件不会重复触发
        const fingerprint = `${entry.name}:${stat.mtimeMs}:${stat.size}`;
        const dedupeKey = `trigger:${trigger.id}:${crypto.createHash('sha256').update(fingerprint).digest('hex').slice(0, 32)}`;
        const existing = await queryOne('SELECT id FROM agent_runs WHERE user_id = ? AND dedupe_key = ? AND deleted_at IS NULL', [user.id, dedupeKey]);
        if (existing) continue;
        try {
            const run = await createTriggerRun(trigger, user, {
                inputs: {
                    [config.inputName || 'filePath']: filePath,
                    fileName: entry.name,
                    fileSize: stat.size,
                    modifiedAt: getBeijingTimestamp(stat.mtime)
                },
                goal: config.goalTemplate || `处理新到文件：${entry.name}`,
                dedupeKey
            });
            created.push(run);
        } catch (err) {
            await recordTriggerError(trigger.id, err.message);
            logger.error({ err: err.message, triggerId: trigger.id, fileName: entry.name }, '文件落地触发工作流失败');
            continue;
        }
    }
    return created;
}

/**
 * 轮询数据变更触发器：按水位线增量读取，命中新数据则创建一次运行并推进水位线。
 * 查询通过既有数据库工具执行，继续受只读校验和脱敏策略约束。
 */
async function pollDatabaseTrigger(trigger, executeTool) {
    const config = parseJson(trigger.config_json, {});
    const user = await getTriggerUser(trigger.user_id);
    if (!user || typeof executeTool !== 'function') return [];

    const watermark = String(trigger.watermark || config.initialWatermark || '');
    const sql = String(config.query || '').replace(/\{\{watermark\}\}/g, watermark.replace(/'/g, "''"));
    let result = null;
    try {
        result = await executeTool('db.run_readonly_query', { connectionId: config.connectionId, sql }, user);
    } catch (err) {
        await recordTriggerError(trigger.id, err.message);
        logger.error({ err: err.message, triggerId: trigger.id }, '数据变更触发查询失败');
        return [];
    }

    // Built-in/MCP database tools expose rows under structuredContent. Accept
    // both shapes so a valid query cannot be mistaken for an empty result.
    const structured = result?.structuredContent && typeof result.structuredContent === 'object'
        ? result.structuredContent
        : null;
    const rows = Array.isArray(structured?.rows)
        ? structured.rows
        : Array.isArray(result?.rows)
            ? result.rows
            : Array.isArray(result) ? result : [];
    if (!rows.length) return [];

    const watermarkField = config.watermarkField || 'updated_at';
    const watermarkValues = rows
        .map(row => row?.[watermarkField])
        .filter(value => value !== undefined && value !== null && String(value).trim() !== '');
    const numericValues = watermarkValues.map(value => Number(value)).filter(Number.isFinite);
    const nextWatermark = (numericValues.length === watermarkValues.length && numericValues.length)
        ? String(Math.max(...numericValues))
        : watermarkValues.map(value => String(value)).sort((a, b) => a.localeCompare(b)).pop() || watermark;

    const dedupeKey = `trigger:${trigger.id}:${crypto.createHash('sha256').update(`${nextWatermark}:${rows.length}`).digest('hex').slice(0, 32)}`;
    try {
        const run = await createTriggerRun(trigger, user, {
            inputs: { [config.inputName || 'rows']: rows, rowCount: rows.length, watermark: nextWatermark },
            goal: config.goalTemplate || `处理 ${rows.length} 条数据变更`,
            dedupeKey
        });
        // 水位线推进放在任务创建之后，任务创建失败时下轮会重新读取同一批数据
        await execute(`
            UPDATE agent_workflow_triggers
            SET watermark = ?, updated_at = ?
            WHERE id = ? AND (? IS NULL OR claim_token = ?)
        `, [nextWatermark, getBeijingTimestamp(), trigger.id, trigger.claim_token || null, trigger.claim_token || null]);
        return [run];
    } catch (err) {
        await recordTriggerError(trigger.id, err.message);
        logger.error({ err: err.message, triggerId: trigger.id }, '数据变更触发工作流失败');
        return [];
    }
}

// 轮询入口，由自动化调度 tick 统一驱动
async function runDuePollingTriggers({ executeTool } = {}) {
    const triggers = await query(`
        SELECT * FROM agent_workflow_triggers
        WHERE status = 'active' AND deleted_at IS NULL AND trigger_type IN ('file', 'database')
        ORDER BY COALESCE(last_triggered_at, created_at) ASC
        LIMIT 50
    `);
    const created = [];
    for (const trigger of triggers) {
        const claimToken = crypto.randomUUID();
        const now = getBeijingTimestamp();
        const claimExpiresAt = getBeijingTimestamp(new Date(Date.now() + POLL_LEASE_MS));
        const changes = await execute(`
            UPDATE agent_workflow_triggers
            SET claim_token = ?, claim_expires_at = ?, updated_at = ?
            WHERE id = ? AND status = 'active' AND deleted_at IS NULL
              AND (claim_token IS NULL OR claim_expires_at IS NULL OR claim_expires_at <= ?)
        `, [claimToken, claimExpiresAt, now, trigger.id, now]);
        if (!changes) continue;
        trigger.claim_token = claimToken;
        try {
            if (trigger.trigger_type === 'file') {
                created.push(...(await pollFileTrigger(trigger)));
            } else {
                created.push(...(await pollDatabaseTrigger(trigger, executeTool)));
            }
            await execute(`
                UPDATE agent_workflow_triggers
                SET claim_token = NULL, claim_expires_at = NULL, updated_at = ?
                WHERE id = ? AND claim_token = ?
            `, [getBeijingTimestamp(), trigger.id, claimToken]);
        } catch (err) {
            await recordTriggerError(trigger.id, err.message);
            await execute(`
                UPDATE agent_workflow_triggers
                SET claim_token = NULL, claim_expires_at = NULL, updated_at = ?
                WHERE id = ? AND claim_token = ?
            `, [getBeijingTimestamp(), trigger.id, claimToken]);
            logger.error({ err: err.message, triggerId: trigger.id }, '触发器轮询失败');
        }
    }
    return created;
}

module.exports = {
    MAX_TRIGGERS_PER_USER,
    MAX_WEBHOOK_PAYLOAD_BYTES,
    configureAgentTriggers,
    createWorkflowTrigger,
    deleteWorkflowTrigger,
    dispatchWebhookTrigger,
    hashTriggerToken,
    listWorkflowTriggers,
    pollDatabaseTrigger,
    pollFileTrigger,
    rotateWorkflowTriggerToken,
    runDuePollingTriggers,
    updateWorkflowTrigger
};
