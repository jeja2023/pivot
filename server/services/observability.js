const crypto = require('crypto');
const { query, queryOne, execute } = require('../db/client');
const { logger } = require('../logger');
const { getBeijingTimestamp } = require('../time');
const { assertSafeOutboundUrl } = require('../security');
const { safeJsonPost } = require('./safe-http-client');
const { getAppSettingValue, setAppSetting } = require('./app-settings');

const EVENT_TYPES = new Set(['sql', 'model', 'rag', 'agent', 'chat', 'upload', 'system']);
const EVENT_STATUSES = new Set(['open', 'ack', 'resolved']);
const SEVERITIES = new Set(['info', 'warning', 'critical']);
const SLOW_SQL_MS = Math.max(Number.parseInt(process.env.PIVOT_SLOW_SQL_MS || '500', 10) || 500, 1);
const SLOW_MODEL_MS = Math.max(Number.parseInt(process.env.PIVOT_SLOW_MODEL_MS || '30000', 10) || 30000, 1);
const SLOW_RAG_MS = Math.max(Number.parseInt(process.env.PIVOT_SLOW_RAG_MS || '3000', 10) || 3000, 1);
const WEBHOOK_TIMEOUT_MS = Math.max(Number.parseInt(process.env.PIVOT_ALERT_WEBHOOK_TIMEOUT_MS || '5000', 10) || 5000, 1000);

let recordingSql = false;

function safeJson(value) {
    try {
        return JSON.stringify(value === undefined ? null : value);
    } catch (e) {
        return JSON.stringify({ error: 'details_not_serializable' });
    }
}

function getSetting(key) {
    try {
        return getAppSettingValue(key) || '';
    } catch (e) {
        return '';
    }
}


function createObservabilityTrace(input = {}) {
    const traceId = input.traceId || crypto.randomUUID();
    const startedAt = Date.now();
    const thresholdMs = Math.max(0, Number(input.thresholdMs || input.threshold_ms || 0));
    const spans = [];
    let finished = false;

    const trace = {
        traceId,
        get finished() { return finished; },
        addSpan(name, details = {}, durationMs = 0) {
            if (spans.length >= 80) return null;
            const span = {
                name: String(name || 'span').slice(0, 120),
                atMs: Date.now() - startedAt,
                durationMs: Math.max(0, Math.round(Number(durationMs || 0))),
                details
            };
            spans.push(span);
            return span;
        },
        finish(result = {}) {
            if (finished) return null;
            finished = true;
            const durationMs = Date.now() - startedAt;
            const severity = result.severity || (result.error ? 'warning' : 'info');
            const shouldRecord = result.record === true
                || severity !== 'info'
                || (thresholdMs > 0 && durationMs >= thresholdMs)
                || input.recordSuccess === true;
            if (!shouldRecord) return null;
            return recordObservabilityEvent({
                type: input.type || 'system',
                source: input.source || '',
                severity,
                durationMs,
                thresholdMs,
                message: result.message || input.message || 'Operation trace',
                details: {
                    ...(input.details || {}),
                    ...(result.details || {}),
                    traceId,
                    status: result.status || 'finished',
                    spans
                }
            });
        }
    };
    return trace;
}

async function withObservabilitySpan(trace, name, operation, details = {}) {
    const startedAt = Date.now();
    try {
        const result = await operation();
        trace?.addSpan?.(name, details, Date.now() - startedAt);
        return result;
    } catch (error) {
        trace?.addSpan?.(name, { ...details, error: error.message || String(error) }, Date.now() - startedAt);
        throw error;
    }
}
function normalizeSeverity(severity, durationMs, thresholdMs) {
    if (SEVERITIES.has(severity)) return severity;
    if (Number(durationMs || 0) >= Number(thresholdMs || 1) * 4) return 'critical';
    return 'warning';
}

async function sendWebhookAlert(event) {
    const url = getSetting('observability_webhook_url') || process.env.PIVOT_ALERT_WEBHOOK_URL || '';
    if (!url) return;
    try {
        const guardUser = { username: 'admin', role: 'admin' };
        await safeJsonPost(url, {
            source: 'pivot',
            type: event.type,
            severity: event.severity,
            title: event.message,
            durationMs: event.duration_ms,
            thresholdMs: event.threshold_ms,
            details: event.details ? (typeof event.details === 'object' ? event.details : JSON.parse(event.details)) : null,
            createdAt: event.created_at
        }, {
            user: guardUser,
            timeout: WEBHOOK_TIMEOUT_MS,
            headers: { 'Content-Type': 'application/json', 'User-Agent': 'Pivot-Alert/1.0' }
        });
        await execute('UPDATE observability_events SET alerted_at = ? WHERE id = ?', [
            getBeijingTimestamp(), event.id
        ]);
    } catch (e) {
        logger.warn({ err: e.message, eventId: event.id }, '可观测性 Webhook 告警发送失败');
    }
}

async function recordObservabilityEvent(input = {}) {
    const type = EVENT_TYPES.has(input.type) ? input.type : 'system';
    const durationMs = Math.max(0, Math.round(Number(input.durationMs || input.duration_ms || 0)));
    const thresholdMs = Math.max(0, Math.round(Number(input.thresholdMs || input.threshold_ms || 0)));
    const severity = normalizeSeverity(input.severity, durationMs, thresholdMs);
    const now = getBeijingTimestamp();
    try {
        const event = await queryOne(`
            INSERT INTO observability_events (
                type, source, severity, duration_ms, threshold_ms, message, details, status, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)
            RETURNING *
        `, [
            type,
            String(input.source || '').slice(0, 160),
            severity,
            durationMs,
            thresholdMs,
            String(input.message || '').slice(0, 500),
            safeJson(input.details || {}),
            now
        ]);
        if (event && (severity === 'warning' || severity === 'critical')) {
            sendWebhookAlert(event);
        }
        return event;
    } catch (e) {
        logger.warn({ err: e.message, type, source: input.source }, '可观测性事件写入失败');
        return null;
    }
}

function recordSlowSql(sql, durationMs, params = []) {
    if (recordingSql || durationMs < SLOW_SQL_MS) return null;
    recordingSql = true;
    try {
        return recordObservabilityEvent({
            type: 'sql',
            source: 'sqlite',
            durationMs,
            thresholdMs: SLOW_SQL_MS,
            message: '慢 SQL 执行',
            details: {
                sql: String(sql || '').replace(/\s+/g, ' ').trim().slice(0, 2000),
                paramCount: Array.isArray(params) ? params.length : 0
            }
        });
    } finally {
        recordingSql = false;
    }
}

function recordSlowModelResponse(modelCfg, durationMs, details = {}) {
    if (durationMs < SLOW_MODEL_MS) return null;
    return recordObservabilityEvent({
        type: 'model',
        source: modelCfg?.name || modelCfg?.model_name || modelCfg?.url || 'model',
        durationMs,
        thresholdMs: SLOW_MODEL_MS,
        message: '模型端点慢响应',
        details: {
            modelId: modelCfg?.id || null,
            modelName: modelCfg?.model_name || modelCfg?.name || '',
            url: modelCfg?.url || '',
            ...details
        }
    });
}

function recordSlowRagRetrieval(query, durationMs, details = {}) {
    const payload = query && typeof query === 'object'
        ? query
        : { query, durationMs, ...details };
    const actualDuration = Number(payload.durationMs || payload.duration_ms || 0);
    if (actualDuration < SLOW_RAG_MS) return null;
    return recordObservabilityEvent({
        type: 'rag',
        source: 'rag.retrieve',
        durationMs: actualDuration,
        thresholdMs: SLOW_RAG_MS,
        message: 'RAG 慢检索',
        details: {
            query: String(payload.query || '').slice(0, 500),
            ...payload
        }
    });
}

async function listObservabilityEvents(options = {}) {
    const limit = Math.min(Math.max(Number.parseInt(options.limit, 10) || 50, 1), 200);
    const type = EVENT_TYPES.has(options.type) ? options.type : '';
    const status = EVENT_STATUSES.has(options.status) ? options.status : '';
    let sql = 'SELECT * FROM observability_events WHERE 1=1';
    const params = [];
    if (type) {
        sql += ' AND type = ?';
        params.push(type);
    }
    if (status) {
        sql += ' AND status = ?';
        params.push(status);
    }
    sql += ' ORDER BY created_at DESC, id DESC LIMIT ?';
    params.push(limit);
    const rows = await query(sql, params);
    return (rows || []).map(row => ({
        ...row,
        details: (() => {
            try { return typeof row.details === 'object' ? row.details : JSON.parse(row.details || '{}'); } catch (e) { return {}; }
        })()
    }));
}

async function updateObservabilityEventStatus(id, status = 'ack') {
    const nextStatus = EVENT_STATUSES.has(status) ? status : 'ack';
    const now = getBeijingTimestamp();
    return await queryOne(`
        UPDATE observability_events
        SET status = ?, acknowledged_at = CASE WHEN ? = 'ack' THEN COALESCE(acknowledged_at, ?) ELSE acknowledged_at END
        WHERE id = ?
        RETURNING *
    `, [nextStatus, nextStatus, now, id]);
}

function getObservabilitySettings() {
    return {
        slowSqlMs: SLOW_SQL_MS,
        slowModelMs: SLOW_MODEL_MS,
        slowRagMs: SLOW_RAG_MS,
        webhookUrl: getSetting('observability_webhook_url') || '',
        webhookConfigured: Boolean(getSetting('observability_webhook_url') || process.env.PIVOT_ALERT_WEBHOOK_URL)
    };
}

async function saveObservabilitySettings(body = {}, user = null) {
    const value = String(body.webhookUrl || body.webhook_url || '').trim();
    if (value) await assertSafeOutboundUrl(value, user || { username: 'admin', role: 'admin' });
    setAppSetting('observability_webhook_url', value, { updatedBy: user?.id || null });
    return getObservabilitySettings();
}

module.exports = {
    createObservabilityTrace,
    getObservabilitySettings,
    listObservabilityEvents,
    recordObservabilityEvent,
    recordSlowModelResponse,
    recordSlowRagRetrieval,
    recordSlowSql,
    saveObservabilitySettings,
    updateObservabilityEventStatus,
    withObservabilitySpan
};
