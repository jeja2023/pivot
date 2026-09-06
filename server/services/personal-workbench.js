const { query, queryOne } = require('../db/client');
const { getBeijingTimestamp } = require('../time');
const { listAgentInbox } = require('./agent-inbox');
const { listAgentGoals } = require('./agent-goals');
const { listAgentArtifacts } = require('./agent-artifacts');
const { listRuns } = require('./agent-runs');
const { getUserSettingValueAsync, setUserSettingAsync } = require('./user-settings');

const SHORTCUT_SETTING_KEY = 'personal_workbench.shortcuts';
const DEFAULT_SHORTCUTS = ['official-writing', 'data-analysis', 'regulations', 'ocr', 'pdf-tools'];
const ALLOWED_SHORTCUTS = new Set([...DEFAULT_SHORTCUTS, 'chat', 'knowledge', 'workflows']);

function normalizeShortcuts(value) {
    const input = Array.isArray(value) ? value : (() => {
        try { return JSON.parse(String(value || '[]')); } catch (_) { return []; }
    })();
    const shortcuts = [...new Set(input.map(item => String(item || '').trim()).filter(item => ALLOWED_SHORTCUTS.has(item)))];
    return shortcuts.length ? shortcuts.slice(0, DEFAULT_SHORTCUTS.length) : [...DEFAULT_SHORTCUTS];
}

async function safe(action, fallback) {
    try { return await action(); } catch (_) { return fallback; }
}

function toRecentWork(kind, record) {
    if (kind === 'session') {
        return {
            id: record.id,
            kind,
            title: record.title || '未命名对话',
            meta: `${Number(record.msg_count || 0)} 条消息${Number(record.is_pinned || 0) ? ' · 已置顶' : ''}`,
            updatedAt: record.updated_at || record.created_at || null
        };
    }
    if (kind === 'artifact') {
        return {
            id: record.id,
            kind,
            title: record.title || '未命名成果',
            meta: `${record.type || '成果'}${record.run_title ? ` · ${record.run_title}` : ''}`,
            updatedAt: record.updated_at || record.created_at || null
        };
    }
    return {
        id: record.id,
        kind,
        title: record.title || record.goal || 'Agent 任务',
        meta: `任务状态：${record.status || '未知'}`,
        updatedAt: record.updated_at || record.created_at || null
    };
}

async function getPersonalWorkbench(user) {
    const [inbox, goals, artifacts, sessions, runs, completedArtifactCount, shortcutSetting] = await Promise.all([
        safe(() => listAgentInbox(user, { limit: 4 }), { data: [], unread: 0, total: 0 }),
        safe(() => listAgentGoals(user, { status: 'active', limit: 3 }), []),
        safe(() => listAgentArtifacts(user, 4), []),
        safe(() => query(`
            SELECT s.id, s.title, s.is_pinned, s.created_at, s.updated_at,
                   (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id AND m.deleted_at IS NULL) AS msg_count
            FROM sessions s
            WHERE s.user_id = ? AND s.deleted_at IS NULL AND COALESCE(s.is_archived, 0) = 0
            ORDER BY COALESCE(s.is_pinned, 0) DESC, COALESCE(s.updated_at, s.created_at) DESC, s.id DESC
            LIMIT 4
        `, [user.id]), []),
        safe(() => query(`
            SELECT id, title, goal, status, created_at, updated_at
            FROM agent_runs
            WHERE user_id = ? AND deleted_at IS NULL
            ORDER BY COALESCE(updated_at, created_at) DESC, id DESC
            LIMIT 4
        `, [user.id]), []),
        safe(async () => {
            const [artifactRow, runResult] = await Promise.all([
                queryOne('SELECT COUNT(*) AS count FROM agent_artifacts WHERE user_id = ?', [user.id]),
                listRuns(user, { status: 'completed', limit: 1 })
            ]);
            const a = Number(artifactRow?.count || 0);
            const r = Number(runResult?.total || 0);
            return Math.max(a, r);
        }, 0),
        safe(() => getUserSettingValueAsync(user.id, SHORTCUT_SETTING_KEY), '')
    ]);
    const actionableInbox = (inbox.data || []).filter(item => (
        item.unread || ['approval', 'run', 'evolution'].includes(String(item.sourceType || ''))
    ));
    const recentWork = [
        ...sessions.map(record => toRecentWork('session', record)),
        ...artifacts.map(record => toRecentWork('artifact', record)),
        ...runs.map(record => toRecentWork('run', record))
    ]
        .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
        .slice(0, 3);
    return {
        generatedAt: getBeijingTimestamp(),
        stats: {
            attention: actionableInbox.length,
            automations: goals.length,
            artifactsThisWeek: completedArtifactCount,
            completedArtifacts: completedArtifactCount
        },
        inbox: actionableInbox.slice(0, 3),
        goals: goals.slice(0, 3),
        recentWork,
        shortcuts: normalizeShortcuts(shortcutSetting)
    };
}

async function updatePersonalWorkbenchShortcuts(user, shortcuts) {
    const normalized = normalizeShortcuts(shortcuts);
    await setUserSettingAsync(user.id, SHORTCUT_SETTING_KEY, JSON.stringify(normalized));
    return normalized;
}

module.exports = { getPersonalWorkbench, normalizeShortcuts, updatePersonalWorkbenchShortcuts };
