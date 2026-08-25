const { query, execute } = require('../db/client');
const { getBeijingTimestamp } = require('../time');
const { getPrimaryTenantId } = require('./enterprise-access');

const DEFAULT_WINDOW_DAYS = 30;
const MIN_SAMPLE_COUNT = 3;

function parseJson(value, fallback = []) {
    if (value && typeof value === 'object') return value;
    try { return JSON.parse(String(value || '')); } catch (_) { return fallback; }
}

function clamp(value) {
    return Math.max(0, Math.min(1, Number(value) || 0));
}

function calculateToolScore({ successRate = 0, timeoutRate = 0, helpfulRate = 0, schemaValidRate = 0 } = {}) {
    return clamp(0.40 * clamp(successRate) + 0.25 * (1 - clamp(timeoutRate)) + 0.20 * clamp(helpfulRate) + 0.15 * clamp(schemaValidRate));
}

function normalizeReliabilitySignal(signal = {}) {
    const sampleCount = Math.max(0, Number.parseInt(signal.sampleCount ?? signal.sample_count, 10) || 0);
    const successRate = clamp(signal.successRate ?? signal.success_rate);
    const timeoutRate = clamp(signal.timeoutRate ?? signal.timeout_rate);
    const helpfulRate = clamp(signal.helpfulRate ?? signal.helpful_rate);
    const schemaValidRate = clamp(signal.schemaValidRate ?? signal.schema_valid_rate);
    return {
        toolName: String(signal.toolName || signal.tool_name || '').slice(0, 160),
        toolVersion: String(signal.toolVersion || signal.tool_version || '').slice(0, 64),
        taskType: String(signal.taskType || signal.task_type || '').slice(0, 160),
        sampleCount,
        successCount: Math.max(0, Number.parseInt(signal.successCount ?? signal.success_count, 10) || 0),
        timeoutCount: Math.max(0, Number.parseInt(signal.timeoutCount ?? signal.timeout_count, 10) || 0),
        helpfulCount: Math.max(0, Number.parseInt(signal.helpfulCount ?? signal.helpful_count, 10) || 0),
        schemaValidCount: Math.max(0, Number.parseInt(signal.schemaValidCount ?? signal.schema_valid_count, 10) || 0),
        successRate,
        timeoutRate,
        helpfulRate,
        schemaValidRate,
        score: calculateToolScore({ successRate, timeoutRate, helpfulRate, schemaValidRate }),
        confidence: sampleCount >= MIN_SAMPLE_COUNT ? Math.min(1, sampleCount / 30) : 0,
        minSampleCount: MIN_SAMPLE_COUNT,
        explain: { window: signal.window || null, sampleCount, minSampleCount: MIN_SAMPLE_COUNT }
    };
}

async function queryToolSignals(user, options = {}) {
    const days = Math.max(1, Math.min(Number.parseInt(options.days, 10) || DEFAULT_WINDOW_DAYS, 365));
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const tenantId = options.tenantId || user.tenant_id || await getPrimaryTenantId(user.id);
    const aggregateTenant = options.scope === 'tenant' && tenantId;
    const calls = await query(`
        SELECT c.tool_name, c.tool_version, c.task_type, c.status, c.error_category, c.duration_ms, r.goal, r.metadata, r.user_id
        FROM agent_tool_calls c JOIN agent_runs r ON r.id = c.run_id
        WHERE ${aggregateTenant ? 'r.tenant_id = ?' : 'r.user_id = ? AND (c.tenant_id IS NULL OR c.tenant_id = ?)'} AND c.created_at >= ? AND r.deleted_at IS NULL
    `, aggregateTenant ? [tenantId, cutoff] : [user.id, tenantId, cutoff]);
    const feedback = aggregateTenant
        ? await query('SELECT tool_failures, rating, metadata FROM agent_feedback WHERE tenant_id = ? AND created_at >= ?', [tenantId, cutoff])
        : await query('SELECT tool_failures, rating, metadata FROM agent_feedback WHERE (user_id = ? OR tenant_id = ?) AND created_at >= ?', [user.id, tenantId, cutoff]);
    const byTool = new Map();
    const ensure = (tool, toolVersion = '', taskType = '') => {
        const key = `${tool}|${toolVersion}|${taskType}`;
        if (!byTool.has(key)) byTool.set(key, { toolName: tool, toolVersion, taskType, sampleCount: 0, successCount: 0, timeoutCount: 0, helpfulCount: 0, schemaValidCount: 0 });
        return byTool.get(key);
    };
    calls.forEach(call => {
        const metadata = parseJson(call.metadata, {});
        const signal = ensure(String(call.tool_name || 'unknown'), call.tool_version || '', call.task_type || metadata.taskType || metadata.task_type || '');
        signal.sampleCount += 1;
        if (['completed', 'success', 'succeeded'].includes(String(call.status))) signal.successCount += 1;
        if (['timeout', 'timed_out'].includes(String(call.error_category)) || Number(call.duration_ms || 0) >= 120000) signal.timeoutCount += 1;
        if (!['invalid', 'schema', 'validation'].includes(String(call.error_category))) signal.schemaValidCount += 1;
    });
    feedback.forEach(row => {
        const rating = Number(row.rating || 0);
        const helpful = rating >= 4 ? 1 : 0;
        parseJson(row.tool_failures, []).forEach(failure => {
            const signal = ensure(String(failure?.tool || '').trim(), failure?.toolVersion || failure?.tool_version || '', failure?.taskType || failure?.task_type || '');
            if (!signal.toolName) return;
            signal.sampleCount += Math.max(1, Number.parseInt(failure?.count, 10) || 1);
            signal.timeoutCount += /timeout/i.test(String(failure?.error || '')) ? 1 : 0;
        });
        if (helpful) byTool.forEach(signal => { signal.helpfulCount += 1; });
    });
    const windowEnd = getBeijingTimestamp();
    const windowStart = getBeijingTimestamp(new Date(Date.now() - days * 24 * 60 * 60 * 1000));
    return [...byTool.values()].map(raw => {
        const sample = Math.max(raw.sampleCount, 1);
        return normalizeReliabilitySignal({
            ...raw,
            successRate: raw.successCount / sample,
            timeoutRate: raw.timeoutCount / sample,
            helpfulRate: raw.helpfulCount / sample,
            schemaValidRate: raw.schemaValidCount / sample,
            window: { start: windowStart, end: windowEnd, days }
        });
    }).sort((a, b) => b.score - a.score || b.sampleCount - a.sampleCount);
}

async function listToolReliability(user, options = {}) {
    const signals = await queryToolSignals(user, options);
    const tenantId = options.tenantId || user.tenant_id || await getPrimaryTenantId(user.id);
    if (options.persist !== false && signals.length) {
        const now = getBeijingTimestamp();
        const days = Math.max(1, Math.min(Number.parseInt(options.days, 10) || DEFAULT_WINDOW_DAYS, 365));
        const start = getBeijingTimestamp(new Date(Date.now() - days * 24 * 60 * 60 * 1000));
        await Promise.all(signals.map(signal => execute(`INSERT INTO agent_tool_reliability (user_id, tenant_id, tool_name, tool_version, task_type, window_start, window_end, sample_count, success_count, timeout_count, helpful_count, schema_valid_count, success_rate, timeout_rate, helpful_rate, schema_valid_rate, score, confidence, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [user.id, options.scope === 'tenant' ? tenantId : null, signal.toolName, signal.toolVersion || '', signal.taskType || '', start, now, signal.sampleCount, signal.successCount, signal.timeoutCount, signal.helpfulCount, signal.schemaValidCount, signal.successRate, signal.timeoutRate, signal.helpfulRate, signal.schemaValidRate, signal.score, signal.confidence, JSON.stringify(signal.explain), now, now])));
    }
    return { days: Number.parseInt(options.days, 10) || DEFAULT_WINDOW_DAYS, scope: options.scope === 'tenant' && tenantId ? 'tenant' : 'user', minSampleCount: MIN_SAMPLE_COUNT, signals };
}

function selectToolOrder(tools = [], signals = []) {
    const scoreMap = new Map((signals || []).filter(signal => signal.sampleCount >= MIN_SAMPLE_COUNT).map(signal => [signal.toolName, signal.score]));
    return (Array.isArray(tools) ? tools : []).slice().sort((a, b) => {
        const as = scoreMap.get(a?.name || a?.toolName);
        const bs = scoreMap.get(b?.name || b?.toolName);
        if (as === undefined && bs === undefined) return 0;
        if (as === undefined) return 1;
        if (bs === undefined) return -1;
        return bs - as;
    });
}

module.exports = {
    DEFAULT_WINDOW_DAYS,
    MIN_SAMPLE_COUNT,
    calculateToolScore,
    listToolReliability,
    normalizeReliabilitySignal,
    queryToolSignals,
    selectToolOrder
};
