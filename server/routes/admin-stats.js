/* 管理员运营统计路由 Admin Stats Routes */
const express = require('express');
const path = require('path');
const os = require('os');
const fs = require('fs');
const net = require('net');
const { db } = require('../db');
const { asyncHandler } = require('../http');
const { getHttpMetricsSnapshot, getRagMetricsSnapshot } = require('../metrics');
const { aiSemaphore } = require('../services/concurrency');
const { getGpuMonitorStatus } = require('../services/gpu-monitor');
const { getModelEndpointRuntimeStatus } = require('../services/model-runtime');
const { getMaintenanceStatus } = require('../services/maintenance');
const { getSystemHealthSnapshot } = require('../services/system-health');
const { getBeijingTimestamp } = require('../time');

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

function normalizeHostAlias(value) {
    let host = String(value || '').trim();
    if (!host) return '';
    if (host.includes(',')) host = host.split(',')[0].trim();
    if (!host) return '';

    try {
        host = new URL(host.includes('://') ? host : `http://${host}`).hostname;
    } catch (e) {
        host = host.replace(/\/.*$/, '');
        if (host.startsWith('[')) {
            const bracketEnd = host.indexOf(']');
            host = bracketEnd >= 0 ? host.slice(1, bracketEnd) : host.slice(1);
        } else if ((host.match(/:/g) || []).length === 1) {
            host = host.split(':')[0];
        }
    }

    host = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
    if (host.includes('%')) host = host.split('%')[0];
    return host;
}

function addHostAlias(names, value) {
    String(value || '')
        .split(',')
        .map(normalizeHostAlias)
        .filter(Boolean)
        .forEach(host => names.add(host));
}

function getRequestHostAliases(req) {
    if (!req) return [];
    return [
        req.hostname,
        req.headers?.host,
        req.headers?.['x-forwarded-host'],
        req.headers?.['x-forwarded-server']
    ].filter(Boolean);
}

function isLikelyContainerRuntime() {
    if (process.env.PIVOT_TRUST_DOCKER_INTERNAL_HOSTS === 'true') return true;
    return false;
}

function isDockerInternalServiceHost(host) {
    const normalized = normalizeHostAlias(host);
    if (!normalized || normalized.includes('.') || net.isIP(normalized)) return false;
    if (!/^[a-z0-9][a-z0-9_-]*$/i.test(normalized)) return false;
    return isLikelyContainerRuntime();
}

function isLocalModelHost(host, localNames) {
    const normalized = normalizeHostAlias(host);
    return localNames.has(normalized) || isDockerInternalServiceHost(normalized);
}

function getLocalHostnames({ requestHosts = [], publicUrl = process.env.PUBLIC_URL || '' } = {}) {
    const names = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0', 'host.docker.internal', 'loopback']);
    try {
        const hostname = os.hostname().toLowerCase();
        names.add(hostname);
        if (hostname.includes('.')) {
            names.add(hostname.split('.')[0]);
        }
        
        const interfaces = os.networkInterfaces();
        Object.values(interfaces).flat().filter(Boolean).forEach(item => {
            if (item.address) {
                names.add(String(item.address).toLowerCase());
                // Handle IPv6 with zone index if any
                if (item.address.includes('%')) {
                    names.add(item.address.split('%')[0].toLowerCase());
                }
            }
        });
    } catch (e) {
        // Keep the conservative defaults above.
    }
    addHostAlias(names, publicUrl);
    addHostAlias(names, process.env.PIVOT_LOCAL_MODEL_HOSTS || '');
    requestHosts.forEach(host => addHostAlias(names, host));
    return names;
}

function summarizeModelEndpoints({ requestHosts = [], publicUrl = '' } = {}) {
    const rows = db.prepare(`
        SELECT id, name, url, monitor_url, max_concurrent
        FROM models
        WHERE COALESCE(status, 'active') = 'active'
        ORDER BY id ASC
    `).all();
    const localNames = getLocalHostnames({ requestHosts, publicUrl });
    const summary = {
        total: rows.length,
        localCount: 0,
        remoteCount: 0,
        unknownCount: 0,
        remoteModels: [],
        localModels: []
    };

    rows.forEach(row => {
        try {
            const parsed = new URL(String(row.url || '').trim());
            const host = parsed.hostname.toLowerCase();
            const isLocal = isLocalModelHost(host, localNames);
            const item = {
                id: row.id,
                name: row.name,
                host,
                isLocal,
                monitor_url: row.monitor_url || '',
                max_concurrent: row.max_concurrent || 0
            };
            if (isLocal) {
                summary.localCount += 1;
                summary.localModels.push(item);
            } else {
                summary.remoteCount += 1;
                summary.remoteModels.push(item);
            }
        } catch (e) {
            summary.unknownCount += 1;
        }
    });

    summary.hasRemoteModels = summary.remoteCount > 0;
    summary.hasLocalModels = summary.localCount > 0;
    summary.runtime = getModelEndpointRuntimeStatus();
    summary.gpuScope = summary.hasRemoteModels
        ? (summary.hasLocalModels ? 'mixed' : 'local_only_not_model_host')
        : 'local';
    return summary;
}

function tokenUsageSubquery() {
    return `
        SELECT id, user_id, model_id, role, token_count,
               CASE WHEN role = 'user' THEN token_count ELSE 0 END AS input_tokens,
               CASE WHEN role != 'user' THEN token_count ELSE 0 END AS output_tokens,
               created_at, 'message' AS usage_source
        FROM messages
        UNION ALL
        SELECT id, user_id, model_id, COALESCE(source, 'api') AS role, token_count,
               COALESCE(input_tokens, 0) AS input_tokens,
               COALESCE(output_tokens, 0) AS output_tokens,
               created_at, 'api' AS usage_source
        FROM model_usage_events
    `;
}

function balancedInputSql(alias) {
    return `COALESCE(${alias}.input_tokens, 0)`;
}

function balancedOutputSql(alias) {
    return `MAX(COALESCE(${alias}.output_tokens, 0), COALESCE(${alias}.token_count, 0) - COALESCE(${alias}.input_tokens, 0))`;
}

function usageCostSql(usageAlias = 'usage', modelAlias = 'm') {
    return `ROUND(((${balancedInputSql(usageAlias)}) * COALESCE(${modelAlias}.input_price_per_million, 0) + (${balancedOutputSql(usageAlias)}) * COALESCE(${modelAlias}.output_price_per_million, 0)) / 1000000.0, 6)`;
}

const isSuperAdmin = (user) => user?.username === 'admin';

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
        const httpMetrics = getHttpMetricsSnapshot();
        const ragMetrics = getRagMetricsSnapshot();
        const memory = process.memoryUsage();
        const cpu = process.cpuUsage();
        
        // 统计 15 分钟内活跃用户
        const activeUsersCount = db.prepare(`
            SELECT COUNT(DISTINCT user_id) AS count 
            FROM audit_logs 
            WHERE timestamp >= datetime('now', '+8 hours', '-15 minutes')
        `).get().count || 0;

        // 获取存储统计
        const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, '../../data');
        const dbFile = path.join(dataDir, 'chat.db');
        let dbSize = 0;
        try {
            if (fs.existsSync(dbFile)) {
                dbSize += fs.statSync(dbFile).size;
                const walFile = dbFile + '-wal';
                if (fs.existsSync(walFile)) dbSize += fs.statSync(walFile).size;
            }
        } catch(e) {}
        
        const uploadsDir = path.resolve(__dirname, '../../uploads');
        let uploadsSize = 0;
        try {
            if (fs.existsSync(uploadsDir)) {
                const getDirSizeSync = (dir) => {
                    let total = 0;
                    const items = fs.readdirSync(dir, { withFileTypes: true });
                    for (const item of items) {
                        const p = path.join(dir, item.name);
                        if (item.isDirectory()) total += getDirSizeSync(p);
                        else total += fs.statSync(p).size;
                    }
                    return total;
                };
                uploadsSize = getDirSizeSync(uploadsDir);
            }
        } catch(e) {}

        const todayTokens = db.prepare(`
            SELECT COALESCE(SUM(token_count), 0) AS total
            FROM (${tokenUsageSubquery()}) usage
            WHERE date(created_at) = date('now', '+8 hours')
        `).get().total || 0;
        const totalTokens = db.prepare(`
            SELECT COALESCE(SUM(token_count), 0) AS total
            FROM (${tokenUsageSubquery()}) usage
        `).get().total || 0;
        const todayMessages = db.prepare("SELECT COUNT(*) AS count FROM messages WHERE date(created_at) = date('now', '+8 hours')").get().count || 0;
        const tokenByModel = db.prepare(`
            SELECT COALESCE(md.name, '未知模型') AS model_name, COALESCE(SUM(usage.token_count), 0) AS tokens
            FROM (${tokenUsageSubquery()}) usage
            LEFT JOIN models md ON md.id = usage.model_id
            WHERE date(usage.created_at) = date('now', '+8 hours')
            GROUP BY COALESCE(md.name, '未知模型')
            ORDER BY tokens DESC
            LIMIT 8
        `).all();

        const concurrency = aiSemaphore.getStatus();
        const gpu = getGpuMonitorStatus();
        const requestHosts = getRequestHostAliases(req);
        const modelEndpoints = summarizeModelEndpoints({ requestHosts, publicUrl });
        const localNames = getLocalHostnames({ requestHosts, publicUrl });
        const health = getSystemHealthSnapshot();
        const maintenance = getMaintenanceStatus();
        const diskHealth = (health.checks || []).find(item => item.name === 'disk') || {};
        
        // 标记运行时的模型端点是否为本地
        if (Array.isArray(modelEndpoints.runtime)) {
            modelEndpoints.runtime.forEach(item => {
                const host = normalizeHostAlias(item.host || item.key || '');
                item.isLocal = isLocalModelHost(host, localNames);
            });
        }

        res.json({
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
                    path: diskHealth.path || dataDir,
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
            health,
            maintenance,
            storage: {
                db: dbSize,
                uploads: uploadsSize,
                total: dbSize + uploadsSize
            },
            activeUsers: activeUsersCount
        });
    }));
    
    router.get('/usage', authMiddleware, asyncHandler(async (req, res) => {
        const canViewAll = isSuperAdmin(req.user);
        const query = `
            SELECT u.username, u.nickname, m.name as model_name,
                   COUNT(usage.id) as msg_count,
                   COALESCE(SUM(${balancedInputSql('usage')}), 0) as input_tokens,
                   COALESCE(SUM(${balancedOutputSql('usage')}), 0) as output_tokens,
                   COALESCE(SUM(usage.token_count), 0) as total_tokens,
                   COALESCE(SUM(${usageCostSql('usage', 'm')}), 0) as estimated_cost,
                   COALESCE(m.price_currency, 'CNY') as price_currency,
                   MAX(usage.created_at) as last_active
            FROM (${tokenUsageSubquery()}) usage
            JOIN users u ON usage.user_id = u.id
            LEFT JOIN models m ON usage.model_id = m.id
            ${canViewAll ? '' : 'WHERE usage.user_id = ?'}
            GROUP BY u.id, usage.model_id
            ORDER BY last_active DESC
        `;
        const stats = canViewAll ? db.prepare(query).all() : db.prepare(query).all(req.user.id);
        res.json(stats);
    }));

    router.get('/trend', authMiddleware, asyncHandler(async (req, res) => {
        const canViewAll = isSuperAdmin(req.user);
        const query = `
            SELECT date(created_at) as day, SUM(token_count) as tokens
            FROM (${tokenUsageSubquery()}) usage
            WHERE created_at >= date('now', '+8 hours', '-30 days')
            ${canViewAll ? '' : 'AND user_id = ?'}
            GROUP BY day
            ORDER BY day
        `;
        const trend = canViewAll ? db.prepare(query).all() : db.prepare(query).all(req.user.id);
        res.json(trend);
    }));

    router.get('/report', authMiddleware, adminMiddleware, asyncHandler(async (req, res) => {
        const { unit, username, days = 30, start, end } = req.query;
        let conditions = [];
        let params = [];
        if (start || end) {
            if (start) {
                conditions.push("date(usage.created_at) >= date(?)");
                params.push(String(start));
            }
            if (end) {
                conditions.push("date(usage.created_at) <= date(?)");
                params.push(String(end));
            }
        } else {
            const safeDays = Math.min(Math.max(parseInt(days, 10) || 30, 1), 3650);
            conditions.push("usage.created_at >= date('now', '+8 hours', '-' || ? || ' days')");
            params.push(safeDays);
        }

        if (unit) {
            conditions.push("u.unit = ?");
            params.push(unit);
        }
        if (username) {
            conditions.push("u.username LIKE ?");
            params.push(`%${username}%`);
        }

        const whereClause = 'WHERE ' + conditions.join(' AND ');

        const trend = db.prepare(`
            SELECT date(usage.created_at) as day, SUM(usage.token_count) as tokens
            FROM (${tokenUsageSubquery()}) usage JOIN users u ON usage.user_id = u.id
            ${whereClause}
            GROUP BY day ORDER BY day
        `).all(...params);

        const byUser = db.prepare(`
            SELECT u.username, u.nickname, SUM(usage.token_count) as tokens
            FROM (${tokenUsageSubquery()}) usage JOIN users u ON usage.user_id = u.id
            ${whereClause}
            GROUP BY u.id ORDER BY tokens DESC LIMIT 10
        `).all(...params);

        const byUnit = db.prepare(`
            SELECT COALESCE(u.unit, '未分配') as unit, SUM(usage.token_count) as tokens
            FROM (${tokenUsageSubquery()}) usage JOIN users u ON usage.user_id = u.id
            ${whereClause}
            GROUP BY COALESCE(u.unit, '未分配') ORDER BY tokens DESC
        `).all(...params);

        // Filter out options for select dropdowns
        const units = db.prepare("SELECT DISTINCT unit FROM users WHERE unit IS NOT NULL AND unit != ''").all().map(r => r.unit);

        res.json({ trend, byUser, byUnit, units });
    }));

    router.get('/ops-summary', authMiddleware, asyncHandler(async (req, res) => {
        const canViewAll = isSuperAdmin(req.user);
        if (canViewAll) {
            const uploadDir = path.resolve(__dirname, '../../uploads');
            const dataDir = path.resolve(__dirname, '../../data');
            const summary = {
                users: db.prepare('SELECT COUNT(*) AS count FROM users').get().count,
                activeUsers: db.prepare("SELECT COUNT(*) AS count FROM users WHERE status != 'disabled' AND deleted_at IS NULL").get().count,
                sessions: db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count,
                messages: db.prepare('SELECT COUNT(*) AS count FROM messages').get().count,
                attachments: db.prepare('SELECT COUNT(*) AS count FROM attachments').get().count,
                models: db.prepare('SELECT COUNT(*) AS count FROM models').get().count,
                tokens: db.prepare(`
                    SELECT COALESCE(SUM(token_count), 0) AS total
                    FROM (${tokenUsageSubquery()}) usage
                `).get().total,
                uploadsSize: await getCachedDirSize(uploadDir),
                dataSize: await getCachedDirSize(dataDir),
                auditToday: db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE date(timestamp) = date('now', '+8 hours')").get().count,
                isPersonal: false
            };
            res.json(summary);
        } else {
            const summary = {
                sessions: db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE user_id = ? AND deleted_at IS NULL').get(req.user.id).count,
                messages: db.prepare('SELECT COUNT(*) AS count FROM messages WHERE user_id = ? AND deleted_at IS NULL').get(req.user.id).count,
                attachments: db.prepare('SELECT COUNT(*) AS count FROM attachments WHERE user_id = ? AND deleted_at IS NULL').get(req.user.id).count,
                models: db.prepare("SELECT COUNT(*) AS count FROM models WHERE user_id IS NULL OR user_id = ?").get(req.user.id).count,
                tokens: db.prepare(`
                    SELECT COALESCE(SUM(token_count), 0) AS total
                    FROM (${tokenUsageSubquery()}) usage
                    WHERE user_id = ?
                `).get(req.user.id).total,
                isPersonal: true
            };
            res.json(summary);
        }
    }));

    router.get('/details', authMiddleware, asyncHandler(async (req, res) => {
        const canViewAll = isSuperAdmin(req.user);
        const page = parseInt(req.query.page, 10) || 1;
        const limit = parseInt(req.query.limit, 10) || 20;
        const offset = (page - 1) * limit;

        const query = `
            SELECT usage.id, usage.created_at, u.username, u.nickname, md.name as model_name,
                   usage.role, usage.token_count,
                   ${balancedInputSql('usage')} AS input_tokens,
                   ${balancedOutputSql('usage')} AS output_tokens,
                   ${usageCostSql('usage', 'md')} AS estimated_cost,
                   COALESCE(md.price_currency, 'CNY') AS price_currency,
                   usage.usage_source
            FROM (${tokenUsageSubquery()}) usage
            JOIN users u ON usage.user_id = u.id
            LEFT JOIN models md ON usage.model_id = md.id
            ${canViewAll ? '' : 'WHERE usage.user_id = ?'}
            ORDER BY usage.created_at DESC
            LIMIT ? OFFSET ?
        `;
        const details = canViewAll ? db.prepare(query).all(limit, offset) : db.prepare(query).all(req.user.id, limit, offset);

        const countQuery = `SELECT COUNT(*) as count FROM (${tokenUsageSubquery()}) usage ${canViewAll ? '' : 'WHERE user_id = ?'}`;
        const total = canViewAll ? db.prepare(countQuery).get().count : db.prepare(countQuery).get(req.user.id).count;
        res.json({ data: details, total });
    }));

    router.get('/details/export', authMiddleware, asyncHandler(async (req, res) => {
        const canViewAll = isSuperAdmin(req.user);
        const query = `
            SELECT usage.created_at, u.username, u.nickname, md.name as model_name, usage.role,
                   usage.token_count,
                   ${balancedInputSql('usage')} AS input_tokens,
                   ${balancedOutputSql('usage')} AS output_tokens,
                   ${usageCostSql('usage', 'md')} AS estimated_cost,
                   COALESCE(md.price_currency, 'CNY') AS price_currency,
                   usage.usage_source
            FROM (${tokenUsageSubquery()}) usage
            JOIN users u ON usage.user_id = u.id
            LEFT JOIN models md ON usage.model_id = md.id
            ${canViewAll ? '' : 'WHERE usage.user_id = ?'}
            ORDER BY usage.created_at DESC LIMIT 10000
        `;
        const details = canViewAll ? db.prepare(query).all() : db.prepare(query).all(req.user.id);
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
        const conditions = [];
        const params = [];
        if (start) {
            conditions.push('date(usage.created_at) >= date(?)');
            params.push(start);
        }
        if (end) {
            conditions.push('date(usage.created_at) <= date(?)');
            params.push(end);
        }
        if (!start && !end) {
            conditions.push("usage.created_at >= date('now', '+8 hours', '-' || ? || ' days')");
            params.push(days);
        }
        if (!canViewAll) {
            conditions.push('usage.user_id = ?');
            params.push(req.user.id);
        }
        const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
        const rows = db.prepare(`
            SELECT md.id AS model_id, COALESCE(md.name, 'Unknown') AS model_name,
                   COALESCE(md.model_name, '') AS upstream_model,
                   COALESCE(md.price_currency, 'CNY') AS price_currency,
                   COALESCE(md.input_price_per_million, 0) AS input_price_per_million,
                   COALESCE(md.output_price_per_million, 0) AS output_price_per_million,
                   COUNT(usage.id) AS usage_count,
                   COALESCE(SUM(${balancedInputSql('usage')}), 0) AS input_tokens,
                   COALESCE(SUM(${balancedOutputSql('usage')}), 0) AS output_tokens,
                   COALESCE(SUM(usage.token_count), 0) AS total_tokens,
                   COALESCE(SUM(${usageCostSql('usage', 'md')}), 0) AS estimated_cost,
                   MIN(usage.created_at) AS first_used_at,
                   MAX(usage.created_at) AS last_used_at
            FROM (${tokenUsageSubquery()}) usage
            LEFT JOIN models md ON md.id = usage.model_id
            ${whereClause}
            GROUP BY usage.model_id
            ORDER BY estimated_cost DESC, total_tokens DESC
        `).all(...params);
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
        const conditions = ["usage.created_at >= date('now', '+8 hours', '-' || ? || ' days')"];
        const params = [days];
        if (!canViewAll) {
            conditions.push('usage.user_id = ?');
            params.push(req.user.id);
        }
        const rows = db.prepare(`
            SELECT COALESCE(md.name, 'Unknown') AS model_name,
                   COALESCE(md.model_name, '') AS upstream_model,
                   COALESCE(md.price_currency, 'CNY') AS price_currency,
                   COALESCE(md.input_price_per_million, 0) AS input_price_per_million,
                   COALESCE(md.output_price_per_million, 0) AS output_price_per_million,
                   COALESCE(SUM(${balancedInputSql('usage')}), 0) AS input_tokens,
                   COALESCE(SUM(${balancedOutputSql('usage')}), 0) AS output_tokens,
                   COALESCE(SUM(usage.token_count), 0) AS total_tokens,
                   COALESCE(SUM(${usageCostSql('usage', 'md')}), 0) AS estimated_cost
            FROM (${tokenUsageSubquery()}) usage
            LEFT JOIN models md ON md.id = usage.model_id
            WHERE ${conditions.join(' AND ')}
            GROUP BY usage.model_id
            ORDER BY estimated_cost DESC, total_tokens DESC
        `).all(...params);
        let csv = '\uFEFFModel,Upstream Model,Currency,Input Price / 1M,Output Price / 1M,Input Tokens,Output Tokens,Total Tokens,Estimated Cost\n';
        rows.forEach(row => {
            csv += [
                row.model_name,
                row.upstream_model,
                row.price_currency,
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
        if (!isSuperAdmin(req.user)) return res.status(403).json({ error: '仅 admin 超级管理员可查看第三方 API 调用内容' });
        const page = parseInt(req.query.page, 10) || 1;
        const limit = Math.min(parseInt(req.query.limit, 10) || 15, 100);
        const offset = (page - 1) * limit;
        const keyword = String(req.query.keyword || '').trim();
        const conditions = [];
        const params = [];
        if (keyword) {
            conditions.push('(u.username LIKE ? OR u.nickname LIKE ? OR l.model_name LIKE ? OR l.request_messages LIKE ? OR l.response_text LIKE ?)');
            const like = `%${keyword}%`;
            params.push(like, like, like, like, like);
        }
        const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
        const rows = db.prepare(`
            SELECT l.id, l.created_at, l.model_name, l.status, l.error_message,
                   COALESCE(l.input_tokens, 0) AS input_tokens,
                   MAX(COALESCE(l.output_tokens, 0), COALESCE(l.total_tokens, 0) - COALESCE(l.input_tokens, 0)) AS output_tokens,
                   l.total_tokens, l.stream, l.ip_address,
                   l.request_messages, l.response_text,
                   u.username, u.nickname, k.name AS api_key_name, k.key_preview
            FROM api_call_logs l
            JOIN users u ON u.id = l.user_id
            LEFT JOIN api_keys k ON k.id = l.api_key_id
            ${where}
            ORDER BY l.created_at DESC
            LIMIT ? OFFSET ?
        `).all(...params, limit, offset);
        const total = db.prepare(`
            SELECT COUNT(*) AS count
            FROM api_call_logs l
            JOIN users u ON u.id = l.user_id
            LEFT JOIN api_keys k ON k.id = l.api_key_id
            ${where}
        `).get(...params).count;
        res.json({ data: rows, total });
    }));


    return router;
}

module.exports = {
    createAdminStatsRouter,
    getLocalHostnames,
    isDockerInternalServiceHost,
    isLocalModelHost,
    normalizeHostAlias,
    summarizeModelEndpoints
};
