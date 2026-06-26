const { db } = require('../../db');
const { isSuperAdmin } = require('../../permissions');
const SYSTEM_MCP_SERVICES = {
    reports: {
        name: '报表文件',
        description: '系统集成的报表和数据文件访问能力。',
        requiresConfig: true
    },
    visualization: {
        name: '图表生成',
        description: '系统集成的图表生成与表格展示能力。'
    },
    report: {
        name: '报告编排',
        description: '系统集成的报告章节编排能力。'
    },
    documents: {
        name: '文档解析',
        description: '系统集成的文档结构解析与文本切分能力。'
    },
    data: {
        name: '数据处理',
        description: '系统集成的表格数据清洗、筛选和聚合能力。'
    },
    format: {
        name: '格式转换',
        description: '系统集成的 Markdown、JSON 和文本格式转换能力。'
    },
    im: {
        name: 'IM 通知',
        description: '系统集成的局域网消息通知能力。',
        requiresConfig: true
    }
};

function getDatabaseTestErrorStatus(err) {
    if (err?.normalizedStatus) return err.normalizedStatus;
    const status = Number(err?.status || err?.statusCode || 0);
    if (status >= 400 && status < 500) return status;
    const message = String(err?.message || '');
    if (/普通用户|Non-admin/.test(message)) return 403;
    if (/请选择|请填写|SQLite file|Unsupported database type|driver is not installed/.test(message)) return 400;
    return 502;
}

function sanitizeDatabaseConnectionForLog(connection, body = {}) {
    return {
        database_type: connection?.database_type || body?.database_type || body?.databaseType || '',
        host: connection?.host || body?.host || '',
        port: connection?.port || body?.port || '',
        database_name: connection?.database_name || body?.database_name || body?.databaseName || '',
        username: connection?.username || body?.username || ''
    };
}

function parseServerConfig(value) {
    try {
        const parsed = typeof value === 'string' ? JSON.parse(value || '{}') : (value || {});
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (e) {
        return {};
    }
}

function splitConfigList(value) {
    if (Array.isArray(value)) return value.map(item => String(item || '').trim()).filter(Boolean);
    return String(value || '')
        .split(/[\n;]+/)
        .map(item => item.trim())
        .filter(Boolean);
}

function parseBoolean(value, fallback = false) {
    if (value === true || value === 'true' || value === 1 || value === '1') return true;
    if (value === false || value === 'false' || value === 0 || value === '0') return false;
    return fallback;
}

function pickConfigValue(payload, current, snakeKey, camelKey, fallback = '') {
    if (Object.prototype.hasOwnProperty.call(payload, snakeKey)) return payload[snakeKey];
    if (Object.prototype.hasOwnProperty.call(payload, camelKey)) return payload[camelKey];
    if (Object.prototype.hasOwnProperty.call(current, camelKey)) return current[camelKey];
    return fallback;
}

function normalizeExternalServerConfig(payload = {}) {
    const current = parseServerConfig(payload.config);
    const authMode = String(pickConfigValue(payload, current, 'auth_mode', 'authMode', 'auto')).toLowerCase();
    const allowedAuthMode = ['auto', 'bearer', 'x-api-key', 'none'].includes(authMode) ? authMode : 'auto';
    const timeoutMs = Math.max(1000, Math.min(Number(pickConfigValue(payload, current, 'timeout_ms', 'timeoutMs', 20000)) || 20000, 120000));
    return {
        ...current,
        healthCheckUrl: String(pickConfigValue(payload, current, 'health_check_url', 'healthCheckUrl', '')).trim(),
        timeoutMs,
        authMode: allowedAuthMode,
        validateToolSchema: parseBoolean(
            pickConfigValue(payload, current, 'validate_tool_schema', 'validateToolSchema', current.validateToolSchema),
            false
        ),
        examplePrompts: splitConfigList(pickConfigValue(payload, current, 'example_prompts', 'examplePrompts', current.examplePrompts))
            .slice(0, 12)
            .map(item => item.slice(0, 300))
    };
}

function clampHealthScore(value) {
    const score = Math.round(Number(value) || 0);
    return Math.max(0, Math.min(score, 100));
}

function buildCapabilityHealth(summary = {}, callSummary = {}) {
    const total = Number(summary.total || 0);
    const active = Number(summary.active || 0);
    const error = Number(summary.error || 0);
    const unchecked = Number(summary.unchecked || 0);
    const calls7d = Number(callSummary.total || 0);
    const callErrors7d = Number(callSummary.errors || 0);
    const avgDurationMs = Number(callSummary.avgDurationMs || 0);
    const activeRate = total > 0 ? active / total : 0;
    const callErrorRate = calls7d > 0 ? callErrors7d / calls7d : 0;
    let score = total > 0 ? 55 + activeRate * 30 : 0;
    score -= Math.min(error * 14, 35);
    score -= Math.min(unchecked * 5, 20);
    score -= Math.min(callErrorRate * 100, 25);
    if (avgDurationMs > 8000) score -= 10;
    else if (avgDurationMs > 3000) score -= 5;
    const healthScore = clampHealthScore(score);
    const recommendations = [];
    if (total === 0) recommendations.push('先启用一个系统工具，确认聊天、自由任务和工作流可正常调用工具。');
    if (error > 0) recommendations.push('存在异常工具服务，建议优先检查连接配置、密钥和网络可达性。');
    if (unchecked > 0) recommendations.push('存在未刷新工具列表的服务，建议刷新工具缓存后再交给模型使用。');
    if (callErrorRate >= 0.2) recommendations.push('近 7 日能力调用错误率偏高，建议查看调用日志定位失败工具。');
    if (avgDurationMs > 3000) recommendations.push('工具平均耗时较高，建议收紧返回行数或拆分长耗时任务。');
    return {
        score: healthScore,
        level: healthScore >= 85 ? 'excellent' : healthScore >= 70 ? 'good' : healthScore >= 50 ? 'attention' : 'risk',
        activeRate: Math.round(activeRate * 100),
        callErrorRate: Math.round(callErrorRate * 100),
        recommendations
    };
}

function findAccessibleBuiltinService(serviceType, user) {
    return db.prepare(`
        SELECT s.*
        FROM mcp_servers s
        JOIN mcp_builtin_configs c ON c.mcp_server_id = s.id
        WHERE s.status != 'deleted'
          AND c.status != 'deleted'
          AND c.service_type = ?
          AND (s.user_id IS NULL OR s.user_id = ? OR ? = 1)
        ORDER BY s.user_id IS NOT NULL, s.id ASC
        LIMIT 1
    `).get(serviceType, user.id, isSuperAdmin(user) ? 1 : 0) || null;
}

module.exports = {
    SYSTEM_MCP_SERVICES,
    getDatabaseTestErrorStatus,
    sanitizeDatabaseConnectionForLog,
    parseServerConfig,
    splitConfigList,
    parseBoolean,
    pickConfigValue,
    normalizeExternalServerConfig,
    clampHealthScore,
    buildCapabilityHealth,
    findAccessibleBuiltinService
};
