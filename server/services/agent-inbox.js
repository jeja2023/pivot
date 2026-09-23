const { query, queryOne, execute } = require('../db/client');
const { getBeijingTimestamp } = require('../time');
const { formatAgentStatus } = require('./agent-validators');
const { patchAgentRunMetadata } = require('./agent-run-metadata-patch');

function parseJson(value, fallback = {}) {
    if (value && typeof value === 'object') return value;
    try { return JSON.parse(String(value || '')); } catch (_) { return fallback; }
}

function normalizeLimit(value, fallback = 50) {
    return Math.max(1, Math.min(Number.parseInt(value, 10) || fallback, 200));
}

async function createAgentInboxEvent(user, input = {}) {
    const eventKey = String(input.eventKey || input.event_key || `${input.eventType || 'event'}:${input.sourceId || input.runId || Date.now()}`).slice(0, 255);
    const now = getBeijingTimestamp();
    const row = await queryOne(`INSERT INTO agent_inbox_events (user_id, tenant_id, event_key, event_type, source_run_id, source_id, risk_level, title, body, payload, expires_at, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unread', ?, ?) ON CONFLICT(user_id, event_key) DO UPDATE SET body = EXCLUDED.body, payload = EXCLUDED.payload, updated_at = EXCLUDED.updated_at RETURNING *`, [user.id, user.tenant_id || input.tenantId || null, eventKey, String(input.eventType || input.event_type || 'info').slice(0, 80), input.sourceRunId || input.runId || null, input.sourceId || null, String(input.risk || input.riskLevel || 'low').slice(0, 16), String(input.title || 'Agent 通知').slice(0, 255), String(input.body || '').slice(0, 10000), JSON.stringify(input.payload && typeof input.payload === 'object' ? input.payload : {}), input.expiresAt || null, now, now]);
    return row;
}

function normalizeCircuitNotificationBody(value) {
    const text = String(value || '').trim();
    const matches = [...text.matchAll(/模型端点暂时熔断[，,]?\s*约?\s*\d+\s*秒后可重试[。.]?/g)];
    if (!matches.length) return text;
    const base = matches[0][0].replace(/[.]$/, '。');
    let detail = text.replace(/模型端点暂时熔断[，,]?\s*约?\s*\d+\s*秒后可重试[。.]?/g, ' ')
        .replace(/\s+/g, ' ')
        .replace(/^[·；;，,。s]+|[·；;，,。s]+$/g, '')
        .trim();
    return detail ? base + ' 上次错误：' + detail : base;
}

const CIRCUIT_NOTIFICATION_DEDUPE_WINDOW_MS = 15 * 60 * 1000;

function isCircuitNotification(entry) {
    return /模型端点暂时熔断/.test(String(entry?.body || ''));
}

function notificationTimestamp(entry) {
    const timestamp = new Date(String(entry?.updatedAt || entry?.createdAt || '').replace(' ', 'T')).getTime();
    return Number.isFinite(timestamp) ? timestamp : 0;
}

function notificationDeduplicationKey(entry) {
    if (entry?.sourceType !== 'notification') return '';
    const title = String(entry.title || '').replace(/\s+/g, ' ').trim();
    if (!/(?:失败|异常|熔断|错误)/.test(title)) return '';
    if (isCircuitNotification(entry)) {
        const timestamp = notificationTimestamp(entry);
        // 无可信时间戳时绝不跨运行合并，避免测试/旧数据把真实独立事故吞掉。
        if (timestamp <= 0) return entry.runId ? ['circuit-run', entry.runId, String(entry.type || ''), title].join('|') : '';
        const bucket = Math.floor(timestamp / CIRCUIT_NOTIFICATION_DEDUPE_WINDOW_MS);
        return ['circuit', bucket, String(entry.type || ''), title].join('|');
    }
    return entry.runId ? [entry.runId, String(entry.type || ''), title].join('|') : '';
}

function notificationDiagnosticScore(entry) {
    const body = String(entry?.body || '');
    let score = Math.min(body.length, 100) / 100;
    if (/(?:status code|HTTP\s*\d{3}|ECONN|ETIMEDOUT|timeout|超时|错误：)/i.test(body)) score += 5;
    if (!/模型端点暂时熔断[，,]?\s*约?\s*\d+\s*秒后可重试。?\s*模型端点暂时熔断/i.test(body)) score += 1;
    return score;
}

function dedupeInboxNotifications(items = []) {
    const selected = new Map();
    const output = [];
    items.forEach(entry => {
        const normalized = entry?.sourceType === 'notification'
            ? { ...entry, body: normalizeCircuitNotificationBody(entry.body), duplicateCount: 1, relatedRunIds: entry.runId ? [entry.runId] : [] }
            : entry;
        const key = notificationDeduplicationKey(normalized);
        if (!key) { output.push(normalized); return; }
        const existing = selected.get(key);
        if (!existing) { selected.set(key, normalized); output.push(normalized); return; }
        const aggregate = notificationDiagnosticScore(normalized) > notificationDiagnosticScore(existing) ? normalized : existing;
        const duplicateCount = Number(existing.duplicateCount || 1) + 1;
        const relatedRunIds = [...new Set([...(existing.relatedRunIds || []), ...(normalized.relatedRunIds || [])])];
        const merged = { ...aggregate, duplicateCount, relatedRunIds };
        const index = output.indexOf(existing); if (index >= 0) output[index] = merged;
        selected.set(key, merged);
    });
    return output;
}

function item(kind, id, data) {
    return {
        id: `${kind}:${id}`,
        sourceType: kind,
        sourceId: id,
        unread: data.unread !== false,
        risk: data.risk || 'low',
        expiresAt: data.expiresAt || null,
        actions: Array.isArray(data.actions) ? data.actions : [],
        ...data
    };
}

async function listAgentInbox(user, options = {}) {
    const limit = normalizeLimit(options.limit, 50);
    const items = [];
    const [notifications, approvals, runs, proposals, events] = await Promise.all([
        query(`SELECT * FROM agent_notifications WHERE user_id = ? AND (snoozed_until IS NULL OR snoozed_until <= ?) AND (muted_until IS NULL OR muted_until <= ?) ORDER BY created_at DESC, id DESC LIMIT ?`, [user.id, getBeijingTimestamp(), getBeijingTimestamp(), limit]),
        query(`SELECT * FROM agent_approval_requests WHERE user_id = ? AND status IN ('pending', 'waiting') ORDER BY created_at ASC LIMIT ?`, [user.id, limit]),
        query(`SELECT id, title, goal, status, error_message, metadata, created_at, updated_at FROM agent_runs WHERE user_id = ? AND deleted_at IS NULL AND status IN ('running', 'queued', 'waiting_approval', 'approval_required', 'failed', 'error', 'completed_with_errors') ORDER BY updated_at DESC LIMIT ?`, [user.id, limit]),
        query(`SELECT * FROM agent_evolution_proposals WHERE user_id = ? AND status IN ('draft', 'pending', 'pending_review', 'sandbox_validate', 'validation_failed', 'versioned_draft') ORDER BY updated_at DESC LIMIT ?`, [user.id, limit])
        // v0.1.163 之前，agent_notifications 会额外镜像为同内容的 inbox event。
        // 通知本身已是收件箱权威记录；保留旧镜像以便审计，但列表中必须排除，
        // 否则一次工作流完成会出现两条完全相同的“需要我处理”。
        ,query(`SELECT * FROM agent_inbox_events
                WHERE user_id = ?
                  AND event_key NOT LIKE 'notification:%'
                  AND event_type NOT LIKE 'notification.%'
                  AND (snoozed_until IS NULL OR snoozed_until <= ?)
                  AND (muted_until IS NULL OR muted_until <= ?)
                ORDER BY created_at DESC
                LIMIT ?`, [user.id, getBeijingTimestamp(), getBeijingTimestamp(), limit])
    ]);
    notifications.forEach(row => items.push(item('notification', row.id, {
        title: row.title,
        body: row.body || '',
        type: row.type || 'info',
        runId: row.run_id || null,
        unread: row.status !== 'read',
        readAt: row.read_at || null,
        createdAt: row.created_at,
        actions: row.run_id ? ['open_run', 'mark_read', 'snooze', 'mute'] : ['mark_read', 'snooze', 'mute']
    })));
    approvals.forEach(row => items.push(item('approval', row.id, {
        title: row.title || '任务需要审批',
        body: row.summary || row.instructions || '',
        runId: row.run_id,
        risk: 'high',
        expiresAt: row.expires_at || null,
        createdAt: row.created_at,
        actions: ['approve', 'reject', 'open_run']
    })));
    runs.forEach(row => {
        const metadata = parseJson(row.metadata, {});
        const isFailure = ['failed', 'error'].includes(String(row.status));
        const isRead = Boolean(metadata.inboxRead || metadata.inboxReadAt);
        const requiresApproval = ['waiting_approval', 'approval_required', 'awaiting_approval'].includes(String(row.status));
        const statusLabel = formatAgentStatus(row.status);
        items.push(item('run', row.id, {
            title: row.title || row.goal || 'Agent 任务',
            body: isFailure ? (row.error_message || '任务运行失败') : `任务状态：${statusLabel}`,
            status: row.status,
            statusText: statusLabel,
            runId: row.id,
            goalId: metadata.goalId || null,
            risk: isFailure ? 'medium' : requiresApproval ? 'high' : 'low',
            unread: requiresApproval ? true : isFailure ? !isRead : false,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            actions: ['open_run', ...(isFailure ? ['retry'] : [])]
        }));
    });
    proposals.forEach(row => items.push(item('evolution', row.id, {
        title: row.title,
        body: row.description || '能力进化提议待处理',
        proposalKind: row.kind,
        status: row.status,
        risk: row.risk_level || 'medium',
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        actions: ['review', 'validate', 'publish', 'reject']
    })));
    events.forEach(row => items.push(item('event', row.id, {
        title: row.title,
        body: row.body || '',
        eventType: row.event_type,
        runId: row.source_run_id || null,
        // sourceId 专用于待办行主键 ID，已读/静音接口使用其更新 agent_inbox_events.id（bigint 类型）；
        // 事件的业务来源标识（如 agent.browser）存放在 eventSourceId，避免污染路由参数。
        eventSourceId: row.source_id || null,
        risk: row.risk_level || 'low',
        unread: row.status !== 'read',
        expiresAt: row.expires_at || null,
        payload: parseJson(row.payload, {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        actions: ['mark_read', 'snooze', 'mute']
    })));
    const type = String(options.type || '').trim();
    const deduped = dedupeInboxNotifications(items);
    const filtered = type ? deduped.filter(entry => entry.sourceType === type) : deduped;
    filtered.sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')));
    return {
        data: filtered.slice(0, limit),
        total: filtered.length,
        unread: filtered.filter(entry => entry.unread).length,
        generatedAt: getBeijingTimestamp()
    };
}

async function markInboxItem(user, sourceType, sourceId, action = 'read', value = {}) {
    if (sourceType === 'notification') {
        const row = await queryOne('SELECT * FROM agent_notifications WHERE id = ? AND user_id = ?', [sourceId, user.id]);
        if (!row) return null;
        const now = getBeijingTimestamp();
        if (action === 'read') await execute("UPDATE agent_notifications SET status = 'read', read_at = ? WHERE id = ? AND user_id = ?", [now, sourceId, user.id]);
        else if (action === 'snooze') await execute('UPDATE agent_notifications SET snoozed_until = ? WHERE id = ? AND user_id = ?', [value.until || null, sourceId, user.id]);
        else if (action === 'mute') await execute('UPDATE agent_notifications SET muted_until = ? WHERE id = ? AND user_id = ?', [value.until || null, sourceId, user.id]);
        else throw Object.assign(new Error('收件箱操作无效。'), { status: 400, statusCode: 400 });
        return await queryOne('SELECT * FROM agent_notifications WHERE id = ?', [sourceId]);
    }
    if (sourceType === 'approval') {
        if (!['approve', 'reject'].includes(action)) return await queryOne('SELECT id, status, run_id FROM agent_approval_requests WHERE id = ? AND user_id = ?', [sourceId, user.id]);
        const { decideWorkflowApprovalRequest } = require('./agent-approval-requests');
        return decideWorkflowApprovalRequest(sourceId, user, { approve: action === 'approve', note: String(value.note || '').slice(0, 1000) });
    }
    if (sourceType === 'evolution') {
        const { decideEvolutionProposal, validateEvolutionProposal, publishEvolutionProposal } = require('./agent-evolution');
        if (['approve', 'reject'].includes(action)) return decideEvolutionProposal(user, sourceId, action, value.note || '');
        if (action === 'validate') return validateEvolutionProposal(user, sourceId, value);
        if (action === 'publish') return publishEvolutionProposal(user, sourceId);
        return queryOne('SELECT id, status FROM agent_evolution_proposals WHERE id = ? AND user_id = ?', [sourceId, user.id]);
    }
    if (sourceType === 'run') {
        const run = await queryOne('SELECT id, status FROM agent_runs WHERE id = ? AND user_id = ?', [sourceId, user.id]);
        if (!run) return null;
        if (action === 'read') {
            await patchAgentRunMetadata(sourceId, {
                inboxRead: true,
                inboxReadAt: getBeijingTimestamp()
            }, { userId: user.id });
        }
        return await queryOne('SELECT id, status FROM agent_runs WHERE id = ? AND user_id = ?', [sourceId, user.id]);
    }
    if (sourceType === 'event') {
        if (!/^\d+$/.test(String(sourceId))) throw Object.assign(new Error('收件箱事件标识无效。'), { status: 400, statusCode: 400, code: 'INVALID_INBOX_EVENT_ID' });
        if (action === 'read') await execute("UPDATE agent_inbox_events SET status = 'read', updated_at = ? WHERE id = ? AND user_id = ?", [getBeijingTimestamp(), sourceId, user.id]);
        else if (action === 'snooze' || action === 'mute') await execute(`UPDATE agent_inbox_events SET ${action === 'snooze' ? 'snoozed_until' : 'muted_until'} = ?, updated_at = ? WHERE id = ? AND user_id = ?`, [value.until || null, getBeijingTimestamp(), sourceId, user.id]);
        else throw Object.assign(new Error('收件箱事件操作无效。'), { status: 400, statusCode: 400 });
        return queryOne('SELECT * FROM agent_inbox_events WHERE id = ? AND user_id = ?', [sourceId, user.id]);
    }
    return null;
}

module.exports = { createAgentInboxEvent, listAgentInbox, markInboxItem, normalizeCircuitNotificationBody, dedupeInboxNotifications, notificationDeduplicationKey };
