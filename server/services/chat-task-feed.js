'use strict';

const repository = require('../repositories/chat-task-feed');
const { sanitizeUserVisibleText } = require('../llm');
const { resolveTenantContext } = require('./agent-tenant-context');
const { logger } = require('../logger');
const { EVENT_TYPES, STATUS_LABELS, parseObject, safeTaskText, approvalSummary, presentTaskEvent, presentLegacyStep } = require('./chat-task-presentation');

const TERMINAL = new Set(['completed', 'completed_with_errors', 'partial', 'error', 'failed', 'cancelled', 'deleted']);
const WAITING = new Set(['needs_input', 'approval_required', 'waiting_approval', 'awaiting_approval', 'awaiting_commit']);

function cursorNumber(value, name, fallback) {
    if (value === undefined || value === null || value === '') return fallback;
    const result = Number(value);
    if (!Number.isSafeInteger(result) || result < 0) throw Object.assign(new Error(`${name}必须是非负整数。`), { status: 400, code: 'CHAT_TASK_CURSOR_INVALID' });
    return result;
}

function normalizeFeedOptions(options = {}) {
    const after = cursorNumber(options.after, '事件游标', undefined);
    const before = cursorNumber(options.before, '历史事件游标', undefined);
    const beforeStep = cursorNumber(options.beforeStep, '历史步骤游标', 0);
    const limit = cursorNumber(options.limit, '每页记录数', 40);
    if (after !== undefined && before !== undefined) throw Object.assign(new Error('增量游标与历史游标不能同时使用。'), { status: 400, code: 'CHAT_TASK_CURSOR_INVALID' });
    if (limit < 1 || limit > 100) throw Object.assign(new Error('每页记录数须在 1 到 100 之间。'), { status: 400, code: 'CHAT_TASK_LIMIT_INVALID' });
    if (after !== undefined && beforeStep) throw Object.assign(new Error('增量读取不能同时翻阅历史步骤。'), { status: 400, code: 'CHAT_TASK_CURSOR_INVALID' });
    return { after, before, beforeStep, limit };
}

function presentVerification(row) {
    const report = row.verification_status ? parseObject(row.verification_report) : parseObject(row.legacy_verification);
    if (!row.verification_status && !report.outcomeStatus) return { status: 'unknown', label: '暂无独立核验记录', missing: [] };
    const status = String(row.verification_status || report.outcomeStatus);
    const missing = Array.isArray(report.semanticVerification?.missing) ? report.semanticVerification.missing : [];
    return { status, label: status === 'verified' ? '结果已通过核验' : status === 'partial' ? '结果部分通过核验' : '结果尚未通过完整核验',
        checkedAt: report.verifiedAt || null, missing: missing.slice(0, 8).map(value => safeTaskText(value, 200)) };
}

function presentArtifact(row) {
    const expired = row.expires_at && Date.parse(row.expires_at) <= Date.now();
    const ready = Boolean(row.rendition_id) && row.rendition_status === 'ready' && !expired;
    return { id: String(row.id), title: safeTaskText(row.title || '任务结果', 160), type: String(row.type || ''),
        version: Number(row.version || 1), updatedAt: row.updated_at,
        rendition: row.rendition_id ? { id: String(row.rendition_id), format: String(row.format),
            byteSize: Math.max(0, Number(row.byte_size || 0)), status: expired ? 'expired' : String(row.rendition_status), ready } : null,
        delivery: row.delivery_state ? { state: String(row.delivery_state), updatedAt: row.delivery_updated_at } : null };
}

async function getChatTaskFeed(runId, user, options = {}, dependencies = {}) {
    if (typeof runId !== 'string' || !runId.trim() || runId.length > 160) throw Object.assign(new Error('任务标识无效。'), { status: 400, code: 'CHAT_TASK_ID_INVALID' });
    const normalized = normalizeFeedOptions(options);
    const store = dependencies.repository || repository;
    const row = await store.getTaskSnapshot(runId, user?.id);
    if (!row) return null;
    const highWater = Math.max(0, Number(row.event_seq || 0));
    if (normalized.after > highWater) throw Object.assign(new Error('任务记录已变化，请重新加载执行过程。'), { status: 409, code: 'CHAT_TASK_CURSOR_AHEAD' });
    const tenant = await (dependencies.resolveTenantContext || resolveTenantContext)(user);
    let artifactReadFailed = false;
    const [eventRows, legacyRows, artifactRows] = await Promise.all([
        store.listTaskEvents(runId, user.id, { ...normalized, highWater, types: EVENT_TYPES }),
        (row.has_events || row.has_tool_events || Number(row.event_seq || 0) > 0) ? [] : store.listLegacySteps(runId, normalized),
        tenant.resolvable ? store.listTaskArtifacts(runId, user.id, tenant.tenantId).catch(error => {
            artifactReadFailed = true;
            logger.warn({ runId, code: error.code || 'ARTIFACT_READ_FAILED' }, '对话任务文件列表暂不可用，保留执行进度与控制能力');
            return [];
        }) : []
    ]);
    const forward = normalized.after !== undefined;
    const hasExtra = eventRows.length > normalized.limit;
    const selected = eventRows.slice(0, normalized.limit);
    if (!forward) selected.reverse();
    // 隐藏的模型增量也占事件序号；页面读尽时推进至快照水位，不能停在最后一条公开事件。
    const nextAfter = forward && hasExtra ? Number(selected[selected.length - 1].event_seq) : highWater;
    const legacy = legacyRows.slice(0, normalized.limit).reverse();
    const status = String(row.status || 'queued');
    return {
        version: 1,
        run: {
            id: String(row.id), session_id: row.session_id || null, conversationTaskId: row.conversation_task_id || String(row.id),
            title: safeTaskText(row.title || '对话任务', 160), status, statusText: STATUS_LABELS[status] || '正在确认任务状态',
            final_answer: sanitizeUserVisibleText(row.final_answer || ''), error_message: safeTaskText(row.error_message, 500),
            created_at: row.created_at, updated_at: row.updated_at, started_at: row.started_at, completed_at: row.completed_at,
            last_heartbeat_at: row.last_heartbeat_at, model_name: safeTaskText(row.model_name, 80),
            input_tokens: Math.max(0, Number(row.input_tokens || 0)), output_tokens: Math.max(0, Number(row.output_tokens || 0)),
            total_tokens: Math.max(0, Number(row.total_tokens || 0)), messageId: Number(row.message_id || 0) || null,
            terminal: TERMINAL.has(status), waiting: WAITING.has(status)
        },
        approval: status === 'approval_required' ? approvalSummary(row.pending_approval) : null,
        verification: presentVerification(row), artifacts: artifactRows.map(presentArtifact),
        warnings: artifactReadFailed ? [{ code: 'ARTIFACTS_UNAVAILABLE', message: '结果文件暂时无法读取，执行记录和任务控制仍可使用。' }] : [],
        events: selected.map(presentTaskEvent).filter(Boolean), legacySteps: legacy.map(presentLegacyStep),
        cursor: { eventSeq: highWater }, nextAfter, hasMore: forward && hasExtra,
        older: { before: selected[0] ? Number(selected[0].event_seq) : normalized.before || 0,
            beforeStep: legacy[0] ? Number(legacy[0].id) : normalized.beforeStep,
            hasMore: !forward && (hasExtra || legacyRows.length > normalized.limit) },
        pollAfterMs: TERMINAL.has(status) || WAITING.has(status) ? null : 4000
    };
}

module.exports = { getChatTaskFeed, normalizeFeedOptions };
