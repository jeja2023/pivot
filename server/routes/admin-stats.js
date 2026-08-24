/* 管理员运营统计路由 */
const express = require('express');
const path = require('path');
const os = require('os');
const { query, queryOne } = require('../db/client');
const { asyncHandler, normalizeLimit, normalizePage } = require('../http');
const { getHttpMetricsSnapshot, getRagMetricsSnapshot } = require('../metrics');
const { aiSemaphore } = require('../services/concurrency');
const { getGpuMonitorStatus } = require('../services/gpu-monitor');
const { getModelEndpointRuntimeStatus } = require('../services/model-runtime');
const { getMaintenanceStatus } = require('../services/maintenance');
const { getDeploymentProfile } = require('../services/deployment-profile');
const {
    getObservabilitySettings,
    listObservabilityEvents,
    saveObservabilitySettings,
    updateObservabilityEventStatus
} = require('../services/observability');
const { getSystemHealthSnapshot } = require('../services/system-health');
const { normalizePriceCurrency } = require('../services/model-costs');
const { getBeijingTimestamp } = require('../time');
const { isSuperAdmin } = require('../permissions');
const {
    getLocalHostnames,
    getRequestHostAliases,
    getResolvedLocalHostnames,
    isDockerInternalServiceHost,
    isLocalModelHost,
    isLocalModelHostAsync,
    normalizeHostAlias
} = require('../services/host-classifier');

const USAGE_ROLE_LABELS = {
    user: '提问',
    assistant: '回答',
    system: '系统',
    tool: '工具',
    deleted_session: '已删会话',
    rag_embedding: '知识库向量',
    agent_planner: '智能体规划',
    agent_summary: '智能体总结',
    openai_api_key: 'OpenAI 兼容接口',
    openai_cookie: '网页登录接口',
    embedding_api_key: '向量接口',
    embedding_cookie: '网页登录向量',
    api: 'API 调用',
    unknown: '未知'
};

function formatUsageRoleLabel(role) {
    const key = String(role || 'unknown').trim() || 'unknown';
    if (USAGE_ROLE_LABELS[key]) return USAGE_ROLE_LABELS[key];
    if (key.startsWith('agent_')) return '智能体调用';
    if (key.includes('embedding')) return '向量调用';
    if (key.includes('api_key')) return 'API Key 调用';
    if (key.includes('cookie')) return '网页登录调用';
    return '其它调用';
}

let modelEndpointsCache = { data: null, expires: 0, key: '' };

async function summarizeModelEndpoints({ requestHosts = [], publicUrl = '' } = {}) {
    const cacheKey = `${publicUrl}|${Array.isArray(requestHosts) ? requestHosts.slice().sort().join(',') : ''}`;
    const now = Date.now();
    if (modelEndpointsCache.data && modelEndpointsCache.expires > now && modelEndpointsCache.key === cacheKey) {
        return modelEndpointsCache.data;
    }
    const rows = await query(`
        SELECT id, name, url, monitor_url, max_concurrent
        FROM models
        WHERE COALESCE(status, 'active') = 'active'
        ORDER BY id ASC
    `);
    const localNames = await getResolvedLocalHostnames({ requestHosts, publicUrl });
    const summary = {
        total: rows.length,
        localCount: 0,
        remoteCount: 0,
        unknownCount: 0,
        remoteModels: [],
        localModels: []
    };

    // 并行解析各模型主机是否为本地，避免串行 await 累加 DNS 解析延迟；再按原顺序聚合以保持稳定输出
    const resolved = await Promise.all(rows.map(async (row) => {
        try {
            const parsed = new URL(String(row.url || '').trim());
            const host = parsed.hostname.toLowerCase();
            const isLocal = await isLocalModelHostAsync(host, localNames);
            return {
                id: row.id,
                name: row.name,
                host,
                isLocal,
                monitor_url: row.monitor_url || '',
                max_concurrent: row.max_concurrent || 0
            };
        } catch (e) {
            return null;
        }
    }));

    for (const item of resolved) {
        if (!item) {
            summary.unknownCount += 1;
            continue;
        }
        if (item.isLocal) {
            summary.localCount += 1;
            summary.localModels.push(item);
        } else {
            summary.remoteCount += 1;
            summary.remoteModels.push(item);
        }
    }

    summary.hasRemoteModels = summary.remoteCount > 0;
    summary.hasLocalModels = summary.localCount > 0;
    summary.runtime = getModelEndpointRuntimeStatus();
    summary.gpuScope = summary.hasRemoteModels
        ? (summary.hasLocalModels ? 'mixed' : 'local_only_not_model_host')
        : 'local';
    modelEndpointsCache = { data: summary, expires: now + 30000, key: cacheKey };
    return summary;
}

// ─────────────────────────────────────────────────────────────────────────────
// 日期工具（北京时间，SQLite 格式字符串比较 or PG AT TIME ZONE）
// ─────────────────────────────────────────────────────────────────────────────

function getBeijingDayBounds(date = new Date()) {
    const day = getBeijingTimestamp(date).slice(0, 10);
    const next = new Date(`${day}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    return { start: `${day} 00:00:00`, nextStart: `${next.toISOString().slice(0, 10)} 00:00:00` };
}

function shiftDayString(day, deltaDays) {
    const d = new Date(`${day}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + deltaDays);
    return d.toISOString().slice(0, 10);
}

function getBeijingDaysAgoStart(days, date = new Date()) {
    const today = getBeijingTimestamp(date).slice(0, 10);
    return `${shiftDayString(today, -Math.abs(days))} 00:00:00`;
}

function getBeijingDateExclusiveEnd(day) {
    return `${shiftDayString(day, 1)} 00:00:00`;
}

function getBeijingMinutesAgoTimestamp(minutes, date = new Date()) {
    return getBeijingTimestamp(new Date(date.getTime() - minutes * 60 * 1000));
}

function tokenUsageSubquery(innerWhere = '') {
    const whereClause = innerWhere ? `WHERE ${innerWhere}` : '';
    return `
        SELECT id, user_id, model_id, role, token_count,
               CASE WHEN role = 'user' THEN token_count ELSE 0 END AS input_tokens,
               CASE WHEN role != 'user' THEN token_count ELSE 0 END AS output_tokens,
               created_at, 'message' AS usage_source
        FROM messages ${whereClause}
        UNION ALL
        SELECT id, user_id, model_id, COALESCE(source, 'api') AS role, token_count,
               COALESCE(input_tokens, 0) AS input_tokens, COALESCE(output_tokens, 0) AS output_tokens,
               created_at, 'api' AS usage_source
        FROM model_usage_events ${whereClause}
    `;
}

const balancedInputSql = alias => `COALESCE(${alias}.input_tokens, 0)`;
const balancedOutputSql = alias => `GREATEST(COALESCE(${alias}.output_tokens, 0), COALESCE(${alias}.token_count, 0) - COALESCE(${alias}.input_tokens, 0))`;
function usageCostSql(usageAlias = 'usage', modelAlias = 'm') {
    const expr = `((${balancedInputSql(usageAlias)}) * COALESCE(${modelAlias}.input_price_per_million, 0) + (${balancedOutputSql(usageAlias)}) * COALESCE(${modelAlias}.output_price_per_million, 0)) / 1000000.0`;
    return `ROUND((${expr})::numeric, 6)`;
}

function buildDateRangeConditions(startTs, endTs) {
    const conditions = [], params = [];
    if (startTs) { conditions.push("created_at >= (? :: timestamp AT TIME ZONE 'Asia/Shanghai')"); params.push(startTs); }
    if (endTs) { conditions.push("created_at < (? :: timestamp AT TIME ZONE 'Asia/Shanghai')"); params.push(endTs); }
    return { conditions, params };
}

/**
 * 将 created_at（timestamptz）转换为北京时区的日期字符串，用于 GROUP BY day。
 */
function dateGroupExpr(col = 'created_at') {
    return `(${col} AT TIME ZONE 'Asia/Shanghai')::date::text`;
}

async function getMonitorKnowledgeChunkCount() {
    // is_enabled 在 SQLite 和 PostgreSQL 中均为 BIGINT 0/1 整型，统一使用整数比较
    const enabledDocCond = "COALESCE(d.is_enabled, 1) != 0";
    const row = await queryOne(`
        SELECT COUNT(c.id) AS count
        FROM knowledge_chunks c
        JOIN knowledge_docs d ON d.id = c.doc_id
        WHERE d.status = 'ready'
          AND d.deleted_at IS NULL
          AND ${enabledDocCond}
    `);
    return Number(row?.count || 0);
}

const MONITOR_SUMMARY_CACHE_TTL_MS = 8000;
let monitorSummaryCache = { data: null, expires: 0 };
const OPS_SUMMARY_CACHE_TTL_MS = 8000;
const opsSummaryCache = new Map();
const TREND_CACHE_TTL_MS = 15000;
const trendCache = new Map();

function invalidateMonitorSummaryCache() {
    monitorSummaryCache = { data: null, expires: 0 };
    opsSummaryCache.clear();
    trendCache.clear();
    modelEndpointsCache = { data: null, expires: 0, key: '' };
}

function createAdminStatsRouter({
    authMiddleware,
    adminMiddleware,
    logAction,
    escapeCsvCell,
    getCachedDirSize,
    publicUrl = ''
}) {
    const router = express.Router();

    router.get('/monitor-summary', authMiddleware, adminMiddleware, asyncHandler(async (req, res) => {
        const cacheNow = Date.now();
        const forceRefresh = req.query?.refresh === '1' || req.query?.force === '1' || req.query?.cache === 'none';
        if (!forceRefresh && monitorSummaryCache.data && monitorSummaryCache.expires > cacheNow) {
            return res.json(monitorSummaryCache.data);
        }
        const httpMetrics = getHttpMetricsSnapshot();
        const ragMetrics = {
            ...getRagMetricsSnapshot(),
            chunksIndexed: await getMonitorKnowledgeChunkCount()
        };
        const observabilityEvents = await listObservabilityEvents({ limit: 12 });

        const observabilityOpen = await query(`
            SELECT type, COUNT(*) AS count
            FROM observability_events
            WHERE status IN ('open', 'alerted')
            GROUP BY type
        `);

        const memory = process.memoryUsage();
        const cpu = process.cpuUsage();

        // 统计 15 分钟内活跃用户
        const activeUsersSince = getBeijingMinutesAgoTimestamp(15);
        const activeUsersRow = await queryOne(
            "SELECT COUNT(DISTINCT user_id) AS count FROM audit_logs WHERE timestamp >= (? :: timestamp AT TIME ZONE 'Asia/Shanghai')",
            [activeUsersSince]
        );
        const activeUsersCount = Number(activeUsersRow?.count || 0);

        // 获取存储统计
        let dbSize = 0;
        try {
            const dbSizeRow = await queryOne('SELECT pg_database_size(current_database()) AS db_size');
            if (dbSizeRow && dbSizeRow.db_size) {
                dbSize = Number(dbSizeRow.db_size) || 0;
            }
        } catch (_) {}

        const uploadsDir = process.env.PIVOT_UPLOAD_DIR || process.env.UPLOAD_DIR
            ? path.resolve(process.env.PIVOT_UPLOAD_DIR || process.env.UPLOAD_DIR)
            : path.resolve(__dirname, '../../uploads');
        let uploadsSize = 0;
        try {
            uploadsSize = await getCachedDirSize(uploadsDir);
        } catch(e) {}

        // 北京当日 token 统计（使用快速双表聚合，避免大子查询物化）
        const dayBounds = getBeijingDayBounds();
        const todayTokensRow = await queryOne(
            "SELECT ((SELECT COALESCE(SUM(token_count), 0) FROM messages WHERE created_at >= (? :: timestamp AT TIME ZONE 'Asia/Shanghai') AND created_at < (? :: timestamp AT TIME ZONE 'Asia/Shanghai')) + (SELECT COALESCE(SUM(token_count), 0) FROM model_usage_events WHERE created_at >= (? :: timestamp AT TIME ZONE 'Asia/Shanghai') AND created_at < (? :: timestamp AT TIME ZONE 'Asia/Shanghai'))) AS total",
            [dayBounds.start, dayBounds.nextStart, dayBounds.start, dayBounds.nextStart]
        );
        const todayTokens = Number(todayTokensRow?.total || 0);

        const totalTokensRow = await queryOne(
            'SELECT ((SELECT COALESCE(SUM(token_count), 0) FROM messages) + (SELECT COALESCE(SUM(token_count), 0) FROM model_usage_events)) AS total'
        );
        const totalTokens = Number(totalTokensRow?.total || 0);

        const todayMessagesRow = await queryOne(
            "SELECT COUNT(*) AS count FROM messages WHERE created_at >= (? :: timestamp AT TIME ZONE 'Asia/Shanghai') AND created_at < (? :: timestamp AT TIME ZONE 'Asia/Shanghai')",
            [dayBounds.start, dayBounds.nextStart]
        );
        const todayMessages = Number(todayMessagesRow?.count || 0);

        const { conditions: dayConditions, params: dayParams } = buildDateRangeConditions(dayBounds.start, dayBounds.nextStart);
        const dayWhere = dayConditions.join(' AND ');
        const tokenByModel = await query(
            `SELECT COALESCE(md.name, '未知模型') AS model_name, COALESCE(SUM(usage.token_count), 0) AS tokens
             FROM (${tokenUsageSubquery(dayWhere)}) usage
             LEFT JOIN models md ON md.id = usage.model_id
             GROUP BY COALESCE(md.name, '未知模型')
             ORDER BY tokens DESC
             LIMIT 8`,
            dayParams.length ? [...dayParams, ...dayParams] : []
        );

        const concurrency = aiSemaphore.getStatus();
        const gpu = getGpuMonitorStatus();
        const requestHosts = getRequestHostAliases(req);
        const modelEndpoints = await summarizeModelEndpoints({ requestHosts, publicUrl });
        const localNames = await getResolvedLocalHostnames({ requestHosts, publicUrl });
        const health = getSystemHealthSnapshot();
        const maintenance = getMaintenanceStatus();
        const diskHealth = (health.checks || []).find(item => item.name === 'disk') || {};

        // 标记运行时的模型端点是否为本地
        if (Array.isArray(modelEndpoints.runtime)) {
            await Promise.all(modelEndpoints.runtime.map(async item => {
                const host = normalizeHostAlias(item.host || item.key || '');
                item.isLocal = await isLocalModelHostAsync(host, localNames);
            }));
        }

        const payload = {
            updatedAt: getBeijingTimestamp(),
            tokens: {
                today: todayTokens,
                total: totalTokens,
                todayMessages,
                byModel: tokenByModel
            },
            http: httpMetrics,
            process: {
                uptimeSeconds: Math.floor(process.uptime()),
                memory,
                cpuSeconds: {
                    user: cpu.user / 1e6,
                    system: cpu.system / 1e6
                },
                version: process.version,
                arch: process.arch
            },
            system: {
                loadAverage: os.loadavg(),
                memory: {
                    total: os.totalmem(),
                    free: os.freemem(),
                    used: os.totalmem() - os.freemem()
                },
                disk: {
                    path: diskHealth.path || uploadsDir,
                    total: diskHealth.total || 0,
                    free: diskHealth.free || 0,
                    used: Math.max(0, Number(diskHealth.total || 0) - Number(diskHealth.free || 0)),
                    usedRatio: diskHealth.usedRatio || 0,
                    status: diskHealth.status || 'unknown'
                },
                cpuCount: os.cpus().length,
                cpuModel: os.cpus()[0]?.model || '未知',
                platform: os.platform(),
                type: os.type(),
                release: os.release(),
                arch: os.arch(),
                hostname: os.hostname(),
                uptime: os.uptime()
            },
            concurrency,
            gpu,
            modelEndpoints,
            rag: ragMetrics,
            observability: {
                events: observabilityEvents,
                openByType: observabilityOpen,
                settings: getObservabilitySettings()
            },
            health,
            maintenance,
            deployment: getDeploymentProfile(),
            storage: {
                db: dbSize,
                uploads: uploadsSize,
                total: dbSize + uploadsSize
            },
            activeUsers: activeUsersCount
        };
        monitorSummaryCache = { data: payload, expires: Date.now() + MONITOR_SUMMARY_CACHE_TTL_MS };
        res.json(payload);
    }));

    router.get('/observability/events', authMiddleware, adminMiddleware, asyncHandler(async (req, res) => {
        res.json({ data: await listObservabilityEvents({
            type: req.query.type,
            status: req.query.status,
            limit: req.query.limit
        }) });
    }));

    router.put('/observability/events/:id/status', authMiddleware, adminMiddleware, asyncHandler(async (req, res) => {
        const event = await updateObservabilityEventStatus(req.params.id, req.body?.status);
        if (!event) return res.status(404).json({ error: '观测事件不存在。' });
        logAction(req, '更新观测事件状态', `事件ID: ${event.id}，状态: ${event.status}`);
        res.json({ success: true, event });
    }));

    router.get('/observability/settings', authMiddleware, adminMiddleware, asyncHandler(async (_req, res) => {
        res.json(getObservabilitySettings());
    }));

    router.put('/observability/settings', authMiddleware, adminMiddleware, asyncHandler(async (req, res) => {
        const settings = await saveObservabilitySettings({
            webhookUrl: req.body?.webhookUrl,
            enabled: req.body?.enabled
        }, req.user);
        logAction(req, '更新慢查询与告警设置', settings.webhookConfigured ? '已配置 webhook' : '未配置 webhook');
        res.json({ success: true, settings });
    }));

    router.get('/usage', authMiddleware, asyncHandler(async (req, res) => {
        const canViewAll = isSuperAdmin(req.user);
        const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 15, 1), 100);
        const offset = (page - 1) * limit;

        const whereParams = [];
        const whereClause = canViewAll ? '' : (() => { whereParams.push(req.user.id); return 'WHERE usage.user_id = ?'; })();

        const groupedQuery = `
            SELECT COALESCE(NULLIF(u.deleted_username, ''), u.username) AS username, u.nickname, m.name as model_name,
                   COUNT(usage.id) as msg_count,
                   COALESCE(SUM(${balancedInputSql('usage')}), 0) as input_tokens,
                   COALESCE(SUM(${balancedOutputSql('usage')}), 0) as output_tokens,
                   COALESCE(SUM(usage.token_count), 0) as total_tokens,
                   COALESCE(SUM(${usageCostSql('usage', 'm')}), 0) as estimated_cost,
                   COALESCE(m.price_currency, '人民币') as price_currency,
                   MAX(usage.created_at) as last_active
            FROM (${tokenUsageSubquery()}) usage
            JOIN users u ON usage.user_id = u.id
            LEFT JOIN models m ON usage.model_id = m.id
            ${whereClause}
            GROUP BY u.id, usage.model_id, u.username, u.deleted_username, u.nickname, m.name, m.price_currency
        `;

        const stats = await query(
            `${groupedQuery} ORDER BY last_active DESC LIMIT ? OFFSET ?`,
            [...whereParams, limit, offset]
        );
        const totalRow = await queryOne(
            `SELECT COUNT(*) AS count FROM (${groupedQuery}) grouped`,
            whereParams
        );
        const total = Number(totalRow?.count || 0);
        res.json({ data: stats, total, page, limit });
    }));

    router.get('/usage/export', authMiddleware, asyncHandler(async (req, res) => {
        const canViewAll = isSuperAdmin(req.user);
        const whereParams = [];
        const whereClause = canViewAll ? '' : (() => { whereParams.push(req.user.id); return 'WHERE usage.user_id = ?'; })();

        const rows = await query(`
            SELECT COALESCE(NULLIF(u.deleted_username, ''), u.username) AS username, u.nickname, m.name as model_name,
                   COUNT(usage.id) as msg_count,
                   COALESCE(SUM(${balancedInputSql('usage')}), 0) as input_tokens,
                   COALESCE(SUM(${balancedOutputSql('usage')}), 0) as output_tokens,
                   COALESCE(SUM(usage.token_count), 0) as total_tokens,
                   COALESCE(SUM(${usageCostSql('usage', 'm')}), 0) as estimated_cost,
                   COALESCE(m.price_currency, '人民币') as price_currency,
                   MAX(usage.created_at) as last_active
            FROM (${tokenUsageSubquery()}) usage
            JOIN users u ON usage.user_id = u.id
            LEFT JOIN models m ON usage.model_id = m.id
            ${whereClause}
            GROUP BY u.id, usage.model_id, u.username, u.deleted_username, u.nickname, m.name, m.price_currency
            ORDER BY last_active DESC
        `, whereParams);

        let csv = '\uFEFF用户,显示名,模型,消息数,输入Token,输出Token,总Token,估算费用,最后活动\n';
        rows.forEach(row => {
            csv += [
                row.username,
                row.nickname || row.username || '',
                row.model_name || '未知模型',
                row.msg_count || 0,
                row.input_tokens || 0,
                row.output_tokens || 0,
                row.total_tokens || 0,
                `${row.price_currency || '人民币'} ${row.estimated_cost || 0}`,
                row.last_active || ''
            ].map(escapeCsvCell).join(',') + '\n';
        });
        logAction(req, '导出用量统计', `导出 ${rows.length} 条汇总`);
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename=usage_stats.csv');
        res.send(csv);
    }));

    router.get('/trend', authMiddleware, asyncHandler(async (req, res) => {
        const canViewAll = isSuperAdmin(req.user);
        const cacheKey = canViewAll ? 'all' : `user:${req.user.id}`;
        const cacheNow = Date.now();
        const forceRefresh = req.query?.refresh === '1' || req.query?.force === '1';
        if (!forceRefresh) {
            const cached = trendCache.get(cacheKey);
            if (cached && cached.expires > cacheNow) return res.json(cached.data);
        }

        const innerConditions = [];
        const innerParams = [];
        const { conditions: dateConditions, params: dateParams } = buildDateRangeConditions(getBeijingDaysAgoStart(30), null);
        innerConditions.push(...dateConditions);
        innerParams.push(...dateParams);

        if (!canViewAll) {
            innerConditions.push('user_id = ?');
            innerParams.push(req.user.id);
        }

        const innerWhere = innerConditions.join(' AND ');
        const dayExpr = dateGroupExpr('usage.created_at');
        const trend = await query(
            `SELECT ${dayExpr} as day, SUM(token_count) as tokens
             FROM (${tokenUsageSubquery(innerWhere)}) usage
             GROUP BY ${dayExpr}
             ORDER BY day`,
            [...innerParams, ...innerParams]
        );
        trendCache.set(cacheKey, { data: trend, expires: Date.now() + TREND_CACHE_TTL_MS });
        res.json(trend);
    }));

    router.get('/report', authMiddleware, adminMiddleware, asyncHandler(async (req, res) => {
        const { unit, username, days = 30, start, end } = req.query;
        const innerConditions = [];
        const innerParams = [];
        const outerConditions = [];
        const outerParams = [];

        if (start || end) {
            const { conditions, params } = buildDateRangeConditions(
                start ? `${String(start)} 00:00:00` : null,
                end ? getBeijingDateExclusiveEnd(String(end)) : null
            );
            innerConditions.push(...conditions);
            innerParams.push(...params);
        } else {
            const safeDays = Math.min(Math.max(parseInt(days, 10) || 30, 1), 3650);
            const { conditions, params } = buildDateRangeConditions(getBeijingDaysAgoStart(safeDays), null);
            innerConditions.push(...conditions);
            innerParams.push(...params);
        }

        if (unit) {
            outerConditions.push('u.unit = ?');
            outerParams.push(unit);
        }
        if (username) {
            outerConditions.push("COALESCE(NULLIF(u.deleted_username, ''), u.username) ILIKE ?");
            outerParams.push(`%${username}%`);
        }

        const innerWhere = innerConditions.join(' AND ');
        const outerWhere = outerConditions.length ? `WHERE ${outerConditions.join(' AND ')}` : '';
        // UNION ALL 内部条件 innerParams 需传两份
        const unionParams = [...innerParams, ...innerParams];
        const dayExpr = dateGroupExpr('usage.created_at');

        const trend = await query(
            `SELECT ${dayExpr} as day, SUM(usage.token_count) as tokens
             FROM (${tokenUsageSubquery(innerWhere)}) usage JOIN users u ON usage.user_id = u.id
             ${outerWhere}
             GROUP BY ${dayExpr} ORDER BY day`,
            [...unionParams, ...outerParams]
        );

        const byUser = await query(
            `SELECT COALESCE(NULLIF(u.deleted_username, ''), u.username) AS username, u.nickname, SUM(usage.token_count) as tokens
             FROM (${tokenUsageSubquery(innerWhere)}) usage JOIN users u ON usage.user_id = u.id
             ${outerWhere}
             GROUP BY u.id, u.username, u.deleted_username, u.nickname ORDER BY tokens DESC LIMIT 10`,
            [...unionParams, ...outerParams]
        );

        const byUnit = await query(
            `SELECT COALESCE(u.unit, '未分配') as unit, SUM(usage.token_count) as tokens
             FROM (${tokenUsageSubquery(innerWhere)}) usage JOIN users u ON usage.user_id = u.id
             ${outerWhere}
             GROUP BY COALESCE(u.unit, '未分配') ORDER BY tokens DESC LIMIT 10`,
            [...unionParams, ...outerParams]
        );

        const units = (await query("SELECT DISTINCT unit FROM users WHERE unit IS NOT NULL AND unit != ''")).map(r => r.unit);

        res.json({ trend, byUser, byUnit, units });
    }));

    router.get('/report/export', authMiddleware, adminMiddleware, asyncHandler(async (req, res) => {
        const { unit, username, days = 30, start, end } = req.query;
        const innerConditions = [];
        const innerParams = [];
        const outerConditions = [];
        const outerParams = [];

        let rangeDesc = '';
        if (start || end) {
            rangeDesc = `${start || '最早'} 至 ${end || '最新'}`;
            const { conditions, params } = buildDateRangeConditions(
                start ? `${String(start)} 00:00:00` : null,
                end ? getBeijingDateExclusiveEnd(String(end)) : null
            );
            innerConditions.push(...conditions);
            innerParams.push(...params);
        } else {
            const safeDays = Math.min(Math.max(parseInt(days, 10) || 30, 1), 3650);
            rangeDesc = `近 ${safeDays} 天`;
            const { conditions, params } = buildDateRangeConditions(getBeijingDaysAgoStart(safeDays), null);
            innerConditions.push(...conditions);
            innerParams.push(...params);
        }

        if (unit) {
            outerConditions.push('u.unit = ?');
            outerParams.push(unit);
        }
        if (username) {
            outerConditions.push("COALESCE(NULLIF(u.deleted_username, ''), u.username) ILIKE ?");
            outerParams.push(`%${username}%`);
        }

        const innerWhere = innerConditions.join(' AND ');
        const outerWhere = outerConditions.length ? `WHERE ${outerConditions.join(' AND ')}` : '';
        const unionParams = [...innerParams, ...innerParams];
        const dayExpr = dateGroupExpr('usage.created_at');

        const trend = await query(
            `SELECT ${dayExpr} as day, SUM(usage.token_count) as tokens
             FROM (${tokenUsageSubquery(innerWhere)}) usage JOIN users u ON usage.user_id = u.id
             ${outerWhere}
             GROUP BY ${dayExpr} ORDER BY day`,
            [...unionParams, ...outerParams]
        );

        const byUser = await query(
            `SELECT COALESCE(NULLIF(u.deleted_username, ''), u.username) AS username, u.nickname, COALESCE(u.unit, '未分配') as unit, SUM(usage.token_count) as tokens
             FROM (${tokenUsageSubquery(innerWhere)}) usage JOIN users u ON usage.user_id = u.id
             ${outerWhere}
             GROUP BY u.id, u.username, u.deleted_username, u.nickname, u.unit ORDER BY tokens DESC`,
            [...unionParams, ...outerParams]
        );

        const byUnit = await query(
            `SELECT COALESCE(u.unit, '未分配') as unit, SUM(usage.token_count) as tokens
             FROM (${tokenUsageSubquery(innerWhere)}) usage JOIN users u ON usage.user_id = u.id
             ${outerWhere}
             GROUP BY COALESCE(u.unit, '未分配') ORDER BY tokens DESC`,
            [...unionParams, ...outerParams]
        );

        let csv = '\uFEFF';
        csv += '# 审计报表导出汇总\n';
        csv += `导出时间,${getBeijingTimestamp()}\n`;
        csv += `统计范围,${rangeDesc}\n`;
        csv += `部门筛选,${unit || '全部部门'}\n`;
        csv += `用户筛选,${username || '全部用户'}\n\n`;

        csv += '# 一、Token 每日使用趋势\n';
        csv += '日期,Token消耗量\n';
        trend.forEach(row => {
            csv += `${escapeCsvCell(row.day)},${row.tokens || 0}\n`;
        });
        if (trend.length === 0) csv += '暂无数据,0\n';
        csv += '\n';

        csv += '# 二、用户消耗排行\n';
        csv += '排名,用户名,显示名,部门,Token消耗量\n';
        byUser.forEach((row, idx) => {
            csv += [
                idx + 1,
                row.username,
                row.nickname || row.username || '',
                row.unit || '未分配',
                row.tokens || 0
            ].map(escapeCsvCell).join(',') + '\n';
        });
        if (byUser.length === 0) csv += '暂无数据,,,,0\n';
        csv += '\n';

        csv += '# 三、部门消耗对比\n';
        csv += '部门,Token消耗量\n';
        byUnit.forEach(row => {
            csv += [
                row.unit || '未分配',
                row.tokens || 0
            ].map(escapeCsvCell).join(',') + '\n';
        });
        if (byUnit.length === 0) csv += '暂无数据,0\n';

        logAction(req, '导出审计报表', `导出范围: ${rangeDesc}, 部门: ${unit || '全部'}, 用户: ${username || '全部'}`);
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename=audit_report.csv');
        res.send(csv);
    }));

    router.get('/ops-summary', authMiddleware, asyncHandler(async (req, res) => {
        const canViewAll = isSuperAdmin(req.user);
        const cacheKey = canViewAll ? 'all' : `user:${req.user.id}`;
        const cacheNow = Date.now();
        const forceRefresh = req.query?.refresh === '1' || req.query?.force === '1';
        if (!forceRefresh) {
            const cached = opsSummaryCache.get(cacheKey);
            if (cached && cached.expires > cacheNow) return res.json(cached.data);
        }

        if (canViewAll) {
            const uploadDir = process.env.PIVOT_UPLOAD_DIR || process.env.UPLOAD_DIR
                ? path.resolve(process.env.PIVOT_UPLOAD_DIR || process.env.UPLOAD_DIR)
                : path.resolve(__dirname, '../../uploads');
            const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.resolve(__dirname, '../../data');

            const dayBounds = getBeijingDayBounds();
            const auditCountRow = await queryOne(
                "SELECT COUNT(*) AS count FROM audit_logs WHERE timestamp >= (? :: timestamp AT TIME ZONE 'Asia/Shanghai') AND timestamp < (? :: timestamp AT TIME ZONE 'Asia/Shanghai')",
                [dayBounds.start, dayBounds.nextStart]
            );

            const [counts, uploadsSize, dataSize] = await Promise.all([
                (async () => {
                    const [users, activeUsers, sessions, messages, attachments, models, tokens] = await Promise.all([
                        queryOne('SELECT COUNT(*) AS count FROM users'),
                        queryOne("SELECT COUNT(*) AS count FROM users WHERE status != 'disabled' AND deleted_at IS NULL"),
                        queryOne('SELECT COUNT(*) AS count FROM sessions'),
                        queryOne('SELECT COUNT(*) AS count FROM messages'),
                        queryOne('SELECT COUNT(*) AS count FROM attachments'),
                        queryOne('SELECT COUNT(*) AS count FROM models'),
                        queryOne('SELECT ((SELECT COALESCE(SUM(token_count), 0) FROM messages) + (SELECT COALESCE(SUM(token_count), 0) FROM model_usage_events)) AS total')
                    ]);
                    return {
                        users: Number(users?.count || 0),
                        activeUsers: Number(activeUsers?.count || 0),
                        sessions: Number(sessions?.count || 0),
                        messages: Number(messages?.count || 0),
                        attachments: Number(attachments?.count || 0),
                        models: Number(models?.count || 0),
                        tokens: Number(tokens?.total || 0),
                        auditToday: Number(auditCountRow?.count || 0)
                    };
                })(),
                getCachedDirSize(uploadDir),
                getCachedDirSize(dataDir)
            ]);

            const payload = {
                users: counts.users,
                activeUsers: counts.activeUsers,
                sessions: counts.sessions,
                messages: counts.messages,
                attachments: counts.attachments,
                models: counts.models,
                tokens: counts.tokens,
                uploadsSize,
                dataSize,
                auditToday: counts.auditToday,
                isPersonal: false
            };
            opsSummaryCache.set(cacheKey, { data: payload, expires: Date.now() + OPS_SUMMARY_CACHE_TTL_MS });
            res.json(payload);
        } else {
            const uid = req.user.id;
            const [sessions, messages, attachments, models, tokens] = await Promise.all([
                queryOne('SELECT COUNT(*) AS count FROM sessions WHERE user_id = ? AND deleted_at IS NULL', [uid]),
                queryOne('SELECT COUNT(*) AS count FROM messages WHERE user_id = ? AND deleted_at IS NULL', [uid]),
                queryOne('SELECT COUNT(*) AS count FROM attachments WHERE user_id = ? AND deleted_at IS NULL', [uid]),
                queryOne('SELECT COUNT(*) AS count FROM models WHERE user_id IS NULL OR user_id = ?', [uid]),
                queryOne('SELECT ((SELECT COALESCE(SUM(token_count), 0) FROM messages WHERE user_id = ? AND deleted_at IS NULL) + (SELECT COALESCE(SUM(token_count), 0) FROM model_usage_events WHERE user_id = ?)) AS total', [uid, uid])
            ]);
            const payload = {
                sessions: Number(sessions?.count || 0),
                messages: Number(messages?.count || 0),
                attachments: Number(attachments?.count || 0),
                models: Number(models?.count || 0),
                tokens: Number(tokens?.total || 0),
                isPersonal: true
            };
            opsSummaryCache.set(cacheKey, { data: payload, expires: Date.now() + OPS_SUMMARY_CACHE_TTL_MS });
            res.json(payload);
        }
    }));

    router.get('/details', authMiddleware, asyncHandler(async (req, res) => {
        const canViewAll = isSuperAdmin(req.user);
        const page = normalizePage(req.query.page);
        const limit = normalizeLimit(req.query.limit, 20, 100);
        const offset = (page - 1) * limit;

        const innerParams = [];
        const innerWhere = canViewAll ? '' : (() => { innerParams.push(req.user.id); return 'user_id = ?'; })();

        const detailsSql = `
            SELECT usage.id, usage.created_at, COALESCE(NULLIF(u.deleted_username, ''), u.username) AS username, u.nickname, md.name as model_name,
                   usage.role, usage.token_count,
                   ${balancedInputSql('usage')} AS input_tokens,
                   ${balancedOutputSql('usage')} AS output_tokens,
                   ${usageCostSql('usage', 'md')} AS estimated_cost,
                   COALESCE(md.price_currency, '人民币') AS price_currency,
                   usage.usage_source
            FROM (${tokenUsageSubquery(innerWhere)}) usage
            JOIN users u ON usage.user_id = u.id
            LEFT JOIN models md ON usage.model_id = md.id
            ORDER BY usage.created_at DESC
            LIMIT ? OFFSET ?
        `;
        // UNION ALL 内部 innerParams 传两份
        const unionParams = [...innerParams, ...innerParams];
        const details = await query(detailsSql, [...unionParams, limit, offset]);

        const countRow = await queryOne(
            `SELECT COUNT(*) as count FROM (${tokenUsageSubquery(innerWhere)}) usage`,
            unionParams
        );
        const total = Number(countRow?.count || 0);
        res.json({ data: details, total });
    }));

    router.get('/details/export', authMiddleware, asyncHandler(async (req, res) => {
        const canViewAll = isSuperAdmin(req.user);
        const innerParams = [];
        const innerWhere = canViewAll ? '' : (() => { innerParams.push(req.user.id); return 'user_id = ?'; })();
        const unionParams = [...innerParams, ...innerParams];

        const details = await query(`
            SELECT usage.created_at, COALESCE(NULLIF(u.deleted_username, ''), u.username) AS username, u.nickname, md.name as model_name, usage.role,
                   usage.token_count,
                   ${balancedInputSql('usage')} AS input_tokens,
                   ${balancedOutputSql('usage')} AS output_tokens,
                   ${usageCostSql('usage', 'md')} AS estimated_cost,
                   COALESCE(md.price_currency, '人民币') AS price_currency,
                   usage.usage_source
            FROM (${tokenUsageSubquery(innerWhere)}) usage
            JOIN users u ON usage.user_id = u.id
            LEFT JOIN models md ON usage.model_id = md.id
            ORDER BY usage.created_at DESC LIMIT 10000
        `, unionParams);

        let csv = '\uFEFF时间,用户名,显示名,模型,角色,输入Token,输出Token,总Token\n';
        details.forEach(d => {
            const roleLabel = formatUsageRoleLabel(d.role);
            csv += [d.created_at, d.username, d.nickname || '', d.model_name || '未知', roleLabel, d.input_tokens || 0, d.output_tokens || 0, d.token_count].map(escapeCsvCell).join(',') + '\n';
        });
        logAction(req, '导出用量明细', `导出 ${details.length} 条明细`);
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename=usage_details.csv');
        res.send(csv);
    }));

    router.get('/model-costs', authMiddleware, asyncHandler(async (req, res) => {
        const canViewAll = isSuperAdmin(req.user);
        const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 3650);
        const start = String(req.query.start || '').trim();
        const end = String(req.query.end || '').trim();

        const innerConditions = [];
        const innerParams = [];

        if (start || end) {
            const { conditions, params } = buildDateRangeConditions(
                start ? `${start} 00:00:00` : null,
                end ? getBeijingDateExclusiveEnd(end) : null
            );
            innerConditions.push(...conditions);
            innerParams.push(...params);
        } else {
            const { conditions, params } = buildDateRangeConditions(getBeijingDaysAgoStart(days), null);
            innerConditions.push(...conditions);
            innerParams.push(...params);
        }

        if (!canViewAll) {
            innerConditions.push('user_id = ?');
            innerParams.push(req.user.id);
        }

        const innerWhere = innerConditions.join(' AND ');
        const unionParams = [...innerParams, ...innerParams];

        const rows = await query(`
            SELECT md.id AS model_id, COALESCE(md.name, 'Unknown') AS model_name,
                   COALESCE(md.model_name, '') AS upstream_model,
                   COALESCE(md.price_currency, '人民币') AS price_currency,
                   COALESCE(md.input_price_per_million, 0) AS input_price_per_million,
                   COALESCE(md.output_price_per_million, 0) AS output_price_per_million,
                   COUNT(usage.id) AS usage_count,
                   COALESCE(SUM(${balancedInputSql('usage')}), 0) AS input_tokens,
                   COALESCE(SUM(${balancedOutputSql('usage')}), 0) AS output_tokens,
                   COALESCE(SUM(usage.token_count), 0) AS total_tokens,
                   COALESCE(SUM(${usageCostSql('usage', 'md')}), 0) AS estimated_cost,
                   MIN(usage.created_at) AS first_used_at,
                   MAX(usage.created_at) AS last_used_at
            FROM (${tokenUsageSubquery(innerWhere)}) usage
            LEFT JOIN models md ON md.id = usage.model_id
            GROUP BY usage.model_id, md.id, md.name, md.model_name, md.price_currency, md.input_price_per_million, md.output_price_per_million
            ORDER BY estimated_cost DESC, total_tokens DESC
        `, unionParams);

        const totals = rows.reduce((acc, row) => {
            acc.input_tokens += Number(row.input_tokens || 0);
            acc.output_tokens += Number(row.output_tokens || 0);
            acc.total_tokens += Number(row.total_tokens || 0);
            acc.estimated_cost += Number(row.estimated_cost || 0);
            return acc;
        }, { input_tokens: 0, output_tokens: 0, total_tokens: 0, estimated_cost: 0 });
        totals.estimated_cost = Math.round(totals.estimated_cost * 1e6) / 1e6;
        res.json({ data: rows, totals, days, start, end });
    }));

    router.get('/model-costs/export', authMiddleware, asyncHandler(async (req, res) => {
        const canViewAll = isSuperAdmin(req.user);
        const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 3650);

        const innerConditions = [];
        const innerParams = [];
        const { conditions, params } = buildDateRangeConditions(getBeijingDaysAgoStart(days), null);
        innerConditions.push(...conditions);
        innerParams.push(...params);

        if (!canViewAll) {
            innerConditions.push('user_id = ?');
            innerParams.push(req.user.id);
        }

        const innerWhere = innerConditions.join(' AND ');
        const unionParams = [...innerParams, ...innerParams];

        const rows = await query(`
            SELECT COALESCE(md.name, 'Unknown') AS model_name,
                   COALESCE(md.model_name, '') AS upstream_model,
                   COALESCE(md.price_currency, '人民币') AS price_currency,
                   COALESCE(md.input_price_per_million, 0) AS input_price_per_million,
                   COALESCE(md.output_price_per_million, 0) AS output_price_per_million,
                   COALESCE(SUM(${balancedInputSql('usage')}), 0) AS input_tokens,
                   COALESCE(SUM(${balancedOutputSql('usage')}), 0) AS output_tokens,
                   COALESCE(SUM(usage.token_count), 0) AS total_tokens,
                   COALESCE(SUM(${usageCostSql('usage', 'md')}), 0) AS estimated_cost
            FROM (${tokenUsageSubquery(innerWhere)}) usage
            LEFT JOIN models md ON md.id = usage.model_id
            GROUP BY usage.model_id, md.name, md.model_name, md.price_currency, md.input_price_per_million, md.output_price_per_million
            ORDER BY estimated_cost DESC, total_tokens DESC
        `, unionParams);

        let csv = '\uFEFFModel,Upstream Model,计价币种,Input Price / 1M,Output Price / 1M,Input Tokens,Output Tokens,Total Tokens,Estimated Cost\n';
        rows.forEach(row => {
            csv += [
                row.model_name,
                row.upstream_model,
                normalizePriceCurrency(row.price_currency),
                row.input_price_per_million,
                row.output_price_per_million,
                row.input_tokens,
                row.output_tokens,
                row.total_tokens,
                row.estimated_cost
            ].map(escapeCsvCell).join(',') + '\n';
        });
        logAction(req, '导出模型费用统计', `导出 ${rows.length} 个模型费用统计`);
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename=model_costs.csv');
        res.send(csv);
    }));

    router.get('/api-call-logs', authMiddleware, asyncHandler(async (req, res) => {
        if (!isSuperAdmin(req.user)) return res.status(403).json({ error: '仅 admin 权限层级可查看第三方 API 调用内容' });
        const page = normalizePage(req.query.page);
        const limit = normalizeLimit(req.query.limit, 15, 100);
        const offset = (page - 1) * limit;
        const keyword = String(req.query.keyword || '').trim();
        const conditions = [];
        const params = [];

        if (keyword) {
            conditions.push("(COALESCE(NULLIF(u.deleted_username, ''), u.username) ILIKE ? OR u.nickname ILIKE ? OR l.model_name ILIKE ? OR l.request_messages ILIKE ? OR l.response_text ILIKE ?)");
            const like = `%${keyword}%`;
            params.push(like, like, like, like, like);
        }

        const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
        const rows = await query(`
            SELECT l.id, l.created_at, l.model_name, l.status, l.error_message,
                   COALESCE(l.input_tokens, 0) AS input_tokens,
                   GREATEST(COALESCE(l.output_tokens, 0), COALESCE(l.total_tokens, 0) - COALESCE(l.input_tokens, 0)) AS output_tokens,
                   l.total_tokens, l.stream, l.ip_address,
                   l.request_messages, l.response_text,
                   COALESCE(NULLIF(u.deleted_username, ''), u.username) AS username, u.nickname, k.name AS api_key_name, k.key_preview
            FROM api_call_logs l
            JOIN users u ON u.id = l.user_id
            LEFT JOIN api_keys k ON k.id = l.api_key_id
            ${where}
            ORDER BY l.created_at DESC
            LIMIT ? OFFSET ?
        `, [...params, limit, offset]);

        const totalRow = await queryOne(`
            SELECT COUNT(*) AS count
            FROM api_call_logs l
            JOIN users u ON u.id = l.user_id
            LEFT JOIN api_keys k ON k.id = l.api_key_id
            ${where}
        `, params);
        const total = Number(totalRow?.count || 0);
        res.json({ data: rows, total });
    }));

    return router;
}

module.exports = {
    createAdminStatsRouter,
    invalidateMonitorSummaryCache,
    getMonitorKnowledgeChunkCount,
    getLocalHostnames,
    getResolvedLocalHostnames,
    isDockerInternalServiceHost,
    isLocalModelHost,
    isLocalModelHostAsync,
    normalizeHostAlias,
    summarizeModelEndpoints
};
