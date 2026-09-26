'use strict';

const { query, queryOne } = require('../db/client');
const { getBeijingTimestamp } = require('../time');

const EXPERIENCE_EVENT_TYPES = new Set([
    'personal_entry_opened', 'onboarding_started', 'onboarding_step_saved', 'onboarding_skipped', 'onboarding_completed',
    'first_task_created', 'first_task_succeeded', 'first_task_failed', 'goal_draft_previewed', 'goal_created_confirmed'
]);
const SAFE_METADATA_KEYS = new Set(['stage', 'source', 'entrypoint', 'durationMs', 'runMode', 'triggerType', 'channelSelected', 'scopeSelected', 'taskKind']);

function normalizeMetadata(value = {}) {
    const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const output = {};
    for (const [key, item] of Object.entries(raw)) {
        if (!SAFE_METADATA_KEYS.has(key)) continue;
        if (typeof item === 'boolean') output[key] = item;
        else if (typeof item === 'number' && Number.isFinite(item)) output[key] = Math.max(-1_000_000_000, Math.min(item, 1_000_000_000));
        else if (typeof item === 'string') output[key] = item.replace(/\s+/g, ' ').trim().slice(0, 120);
    }
    return output;
}

async function recordAgentExperienceEvent(user, eventType, options = {}) {
    const type = String(eventType || '').trim();
    if (!EXPERIENCE_EVENT_TYPES.has(type) || !user?.id) return null;
    const result = await queryOne(`
        INSERT INTO agent_experience_events (user_id, tenant_id, event_type, session_id, run_id, metadata, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT DO NOTHING
        RETURNING id, event_type, created_at
    `, [user.id, user.tenant_id || user.tenantId || null, type, String(options.sessionId || '').slice(0, 128) || null, String(options.runId || '').slice(0, 128) || null, JSON.stringify(normalizeMetadata(options.metadata)), getBeijingTimestamp()]);
    return result || null;
}

async function recordFirstTaskCreated(user, run, metadata = {}) {
    if (!run?.id || !user?.id) return null;
    const prior = await queryOne('SELECT id FROM agent_runs WHERE user_id = ? AND id != ? AND deleted_at IS NULL LIMIT 1', [user.id, run.id]);
    if (prior) return null;
    return recordAgentExperienceEvent(user, 'first_task_created', {
        runId: run.id, sessionId: run.session_id || '',
        metadata: { runMode: run.run_mode || metadata.runMode || 'standard', entrypoint: metadata.entrypoint || metadata.source || 'agent' }
    });
}

async function recordFirstTaskTerminal(runId, status) {
    const run = await queryOne('SELECT id, user_id, tenant_id, session_id, run_mode, created_at FROM agent_runs WHERE id = ?', [String(runId || '')]);
    if (!run) return null;
    const created = await queryOne("SELECT id FROM agent_experience_events WHERE user_id = ? AND event_type = 'first_task_created' AND run_id = ?", [run.user_id, run.id]);
    if (!created) return null;
    const type = ['completed', 'completed_with_errors', 'partial'].includes(String(status)) ? 'first_task_succeeded' : 'first_task_failed';
    return recordAgentExperienceEvent({ id: run.user_id, tenant_id: run.tenant_id }, type, {
        runId: run.id, sessionId: run.session_id || '', metadata: { runMode: run.run_mode || 'standard' }
    });
}

async function getAgentExperienceSummary(user, options = {}) {
    const days = Math.max(1, Math.min(Number.parseInt(options.days, 10) || 30, 365));
    const rows = await query(`
        SELECT event_type, COUNT(*) AS count, MIN(created_at) AS first_at, MAX(created_at) AS last_at
        FROM agent_experience_events
        WHERE user_id = ? AND created_at >= NOW() - (? || ' days')::interval
        GROUP BY event_type
    `, [user.id, String(days)]);
    const byType = Object.fromEntries(rows.map(row => [row.event_type, { count: Number(row.count || 0), firstAt: row.first_at || null, lastAt: row.last_at || null }]));
    return { days, events: byType };
}

module.exports = { getAgentExperienceSummary, recordAgentExperienceEvent, recordFirstTaskCreated, recordFirstTaskTerminal };
