/* 管理员运营统计路由 Admin Stats Routes */
const express = require('express');
const path = require('path');
const os = require('os');
const fs = require('fs');
const net = require('net');
const { db } = require('../db');
const { asyncHandler } = require('../http');
const { getHttpMetricsSnapshot } = require('../metrics');
const { aiSemaphore } = require('../services/concurrency');
const { getGpuMonitorStatus } = require('../services/gpu-monitor');
const { getModelEndpointRuntimeStatus } = require('../services/model-runtime');

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
    if (process.env.PIVOT_TRUST_DOCKER_INTERNAL_HOSTS === 'false') return false;
    if (process.env.KUBERNETES_SERVICE_HOST) return true;
    try {
        return fs.existsSync('/.dockerenv');
    } catch (e) {
        return false;
    }
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
    addHostAlias(names, process.env.PIVOT_LOCAL_MODEL_HOSTS || process.env.MODEL_LOCAL_HOSTS || '');
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
        SELECT id, user_id, model_id, role, token_count, created_at, 'message' AS usage_source
        FROM messages
        UNION ALL
        SELECT id, user_id, model_id, COALESCE(source, 'api') AS role, token_count, created_at, 'api' AS usage_source
        FROM model_usage_events
    `;
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
        const httpMetrics = getHttpMetricsSnapshot();
        const memory = process.memoryUsage();
        const cpu = process.cpuUsage();
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
        
        // 标记运行时的模型端点是否为本地
        if (Array.isArray(modelEndpoints.runtime)) {
            modelEndpoints.runtime.forEach(item => {
                const host = normalizeHostAlias(item.host || item.key || '');
                item.isLocal = isLocalModelHost(host, localNames);
            });
        }

        res.json({
            updatedAt: new Date().toISOString(),
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
                }
            },
            system: {
                loadAverage: os.loadavg(),
                memory: {
                    total: os.totalmem(),
                    free: os.freemem(),
                    used: os.totalmem() - os.freemem()
                },
                cpuCount: os.cpus().length,
                platform: os.platform()
            },
            concurrency,
            gpu,
            modelEndpoints
        });
    }));

    router.get('/usage', authMiddleware, asyncHandler(async (req, res) => {
        const isAdmin = req.user.role === 'admin';
        const query = `
            SELECT u.username, u.nickname, m.name as model_name,
                   COUNT(usage.id) as msg_count,
                   SUM(usage.token_count) as total_tokens,
                   MAX(usage.created_at) as last_active
            FROM (${tokenUsageSubquery()}) usage
            JOIN users u ON usage.user_id = u.id
            LEFT JOIN models m ON usage.model_id = m.id
            ${isAdmin ? '' : 'WHERE usage.user_id = ?'}
            GROUP BY u.id, usage.model_id
            ORDER BY last_active DESC
        `;
        const stats = isAdmin ? db.prepare(query).all() : db.prepare(query).all(req.user.id);
        res.json(stats);
    }));

    router.get('/trend', authMiddleware, asyncHandler(async (req, res) => {
        const isAdmin = req.user.role === 'admin';
        const query = `
            SELECT date(created_at) as day, SUM(token_count) as tokens
            FROM (${tokenUsageSubquery()}) usage
            WHERE created_at >= date('now', '+8 hours', '-30 days')
            ${isAdmin ? '' : 'AND user_id = ?'}
            GROUP BY day
            ORDER BY day
        `;
        const trend = isAdmin ? db.prepare(query).all() : db.prepare(query).all(req.user.id);
        res.json(trend);
    }));

    router.get('/report', authMiddleware, adminMiddleware, asyncHandler(async (req, res) => {
        const { unit, username, days = 30 } = req.query;
        let conditions = ["usage.created_at >= date('now', '+8 hours', '-' || ? || ' days')"];
        let params = [parseInt(days, 10) || 30];

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
        const isAdmin = req.user.role === 'admin';
        if (isAdmin) {
            const uploadDir = path.resolve(__dirname, '../../uploads');
            const dataDir = path.resolve(__dirname, '../../data');
            const summary = {
                users: db.prepare('SELECT COUNT(*) AS count FROM users').get().count,
                activeUsers: db.prepare("SELECT COUNT(*) AS count FROM users WHERE status != 'disabled'").get().count,
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
                sessions: db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?').get(req.user.id).count,
                messages: db.prepare('SELECT COUNT(*) AS count FROM messages WHERE user_id = ?').get(req.user.id).count,
                attachments: db.prepare('SELECT COUNT(*) AS count FROM attachments WHERE user_id = ?').get(req.user.id).count,
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
        const isAdmin = req.user.role === 'admin';
        const page = parseInt(req.query.page, 10) || 1;
        const limit = parseInt(req.query.limit, 10) || 20;
        const offset = (page - 1) * limit;

        const query = `
            SELECT usage.id, usage.created_at, u.username, u.nickname, md.name as model_name,
                   usage.role, usage.token_count, usage.usage_source
            FROM (${tokenUsageSubquery()}) usage
            JOIN users u ON usage.user_id = u.id
            LEFT JOIN models md ON usage.model_id = md.id
            ${isAdmin ? '' : 'WHERE usage.user_id = ?'}
            ORDER BY usage.created_at DESC
            LIMIT ? OFFSET ?
        `;
        const details = isAdmin ? db.prepare(query).all(limit, offset) : db.prepare(query).all(req.user.id, limit, offset);

        const countQuery = `SELECT COUNT(*) as count FROM (${tokenUsageSubquery()}) usage ${isAdmin ? '' : 'WHERE user_id = ?'}`;
        const total = isAdmin ? db.prepare(countQuery).get().count : db.prepare(countQuery).get(req.user.id).count;
        res.json({ data: details, total });
    }));

    router.get('/details/export', authMiddleware, asyncHandler(async (req, res) => {
        const isAdmin = req.user.role === 'admin';
        const query = `
            SELECT usage.created_at, u.username, u.nickname, md.name as model_name, usage.role, usage.token_count, usage.usage_source
            FROM (${tokenUsageSubquery()}) usage
            JOIN users u ON usage.user_id = u.id
            LEFT JOIN models md ON usage.model_id = md.id
            ${isAdmin ? '' : 'WHERE usage.user_id = ?'}
            ORDER BY usage.created_at DESC LIMIT 10000
        `;
        const details = isAdmin ? db.prepare(query).all() : db.prepare(query).all(req.user.id);
        let csv = '\uFEFF时间,用户名,显示名,模型,角色,消耗Token\n';
        details.forEach(d => {
            const roleLabel = d.usage_source === 'api' ? d.role : (d.role === 'user' ? '提问' : '回答');
            csv += [d.created_at, d.username, d.nickname || '', d.model_name || '未知', roleLabel, d.token_count].map(escapeCsvCell).join(',') + '\n';
        });
        logAction(req, '导出用量明细', `导出 ${details.length} 条明细`);
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename=usage_details.csv');
        res.send(csv);
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
