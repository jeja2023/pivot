/**
 * server/services/admin-stats-service.js
 * 管理员用量与统计服务层：负责端点汇总、Token 用量子查询、多维筛选构建及时间计算。
 */
const { query, queryOne } = require('../db/client');
const { getResolvedLocalHostnames, isLocalModelHostAsync } = require('./host-classifier');
const { getModelEndpointRuntimeStatus } = require('./model-runtime');
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

let modelEndpointsCache = { data: null, expires: 0, key: '' };

function clearModelEndpointsCache() {
    modelEndpointsCache = { data: null, expires: 0, key: '' };
}

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
    summary.runtime = getModelEndpointRuntimeStatus(rows);
    summary.gpuScope = summary.hasRemoteModels
        ? (summary.hasLocalModels ? 'mixed' : 'local_only_not_model_host')
        : 'local';
    modelEndpointsCache = { data: summary, expires: now + 30000, key: cacheKey };
    return summary;
}

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

function dateGroupExpr(col = 'created_at') {
    return `(${col} AT TIME ZONE 'Asia/Shanghai')::date::text`;
}

async function getMonitorKnowledgeChunkCount() {
    const enabledDocCond = "COALESCE(d.is_enabled::text, '1') NOT IN ('0', 'false', 'f')";
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

function buildUsageFilterConditions(req, { canViewAll, userAlias = 'u', modelAlias = 'm', usageAlias = 'usage' } = {}) {
    const conditions = [];
    const params = [];

    if (!canViewAll) {
        conditions.push(`${usageAlias}.user_id = ?`);
        params.push(req.user.id);
    }

    const userKeyword = String(req.query.user || '').trim();
    if (userKeyword) {
        conditions.push(`(COALESCE(${userAlias}.username, '') ILIKE ? OR COALESCE(${userAlias}.nickname, '') ILIKE ? OR COALESCE(${userAlias}.deleted_username, '') ILIKE ?)`);
        params.push(`%${userKeyword}%`, `%${userKeyword}%`, `%${userKeyword}%`);
    }

    const modelKeyword = String(req.query.model || '').trim();
    if (modelKeyword) {
        conditions.push(`COALESCE(${modelAlias}.name, '') ILIKE ?`);
        params.push(`%${modelKeyword}%`);
    }

    const startDate = String(req.query.startDate || '').trim();
    if (startDate) {
        conditions.push(`${usageAlias}.created_at >= (? :: date :: timestamp AT TIME ZONE 'Asia/Shanghai')`);
        params.push(startDate);
    }

    const endDate = String(req.query.endDate || '').trim();
    if (endDate) {
        conditions.push(`${usageAlias}.created_at < ((? :: date + interval '1 day') :: timestamp AT TIME ZONE 'Asia/Shanghai')`);
        params.push(endDate);
    }

    const role = String(req.query.role || '').trim();
    if (role) {
        conditions.push(`${usageAlias}.role = ?`);
        params.push(role);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    return { whereClause, params };
}

module.exports = {
    formatUsageRoleLabel,
    summarizeModelEndpoints,
    clearModelEndpointsCache,
    getBeijingDayBounds,
    getBeijingDaysAgoStart,
    getBeijingDateExclusiveEnd,
    getBeijingMinutesAgoTimestamp,
    tokenUsageSubquery,
    balancedInputSql,
    balancedOutputSql,
    usageCostSql,
    buildDateRangeConditions,
    dateGroupExpr,
    getMonitorKnowledgeChunkCount,
    buildUsageFilterConditions
};
