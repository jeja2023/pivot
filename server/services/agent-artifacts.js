const { query, queryOne, execute, transaction } = require('../db/client');
const { getBeijingTimestamp } = require('../time');
const { publishUserEvent } = require('./realtime-events');
const { normalizePositiveInt } = require('./agent-validators');

let getRunDetailForUserCallback = null;
let getAgentRunTitleCallback = null;
let createAgentNotificationCallback = () => null;

function configureAgentArtifacts({ getRunDetailForUser, getAgentRunTitle, createAgentNotification } = {}) {
    if (typeof getRunDetailForUser === 'function') getRunDetailForUserCallback = getRunDetailForUser;
    if (typeof getAgentRunTitle === 'function') getAgentRunTitleCallback = getAgentRunTitle;
    if (typeof createAgentNotification === 'function') createAgentNotificationCallback = createAgentNotification;
}

function ensureGetRunDetailForUser() {
    if (typeof getRunDetailForUserCallback !== 'function') throw new Error('智能体产物运行时尚未配置。');
    return getRunDetailForUserCallback;
}

function ensureGetAgentRunTitle() {
    if (typeof getAgentRunTitleCallback !== 'function') throw new Error('智能体产物运行时尚未配置。');
    return getAgentRunTitleCallback;
}

async function listAgentNotifications(user, limit = 20) {
    return await query(`
        SELECT *
        FROM agent_notifications
        WHERE user_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?
    `, [user.id, normalizePositiveInt(limit, 20, 1, 100)]);
}

async function markAgentNotificationRead(notificationId, user) {
    const notification = await queryOne('SELECT * FROM agent_notifications WHERE id = ? AND user_id = ?', [notificationId, user.id]);
    if (!notification) return null;
    await execute("UPDATE agent_notifications SET status = 'read', read_at = ? WHERE id = ?", [getBeijingTimestamp(), notificationId]);
    const updated = await queryOne('SELECT * FROM agent_notifications WHERE id = ?', [notificationId]);
    publishUserEvent(user.id, 'agent.notification', { notification: updated, reason: 'read' });
    return updated;
}

async function listAgentArtifacts(user, limit = 30) {
    return await query(`
        SELECT a.*, r.title AS run_title, r.status AS run_status,
               v.version AS current_version,
               (SELECT COUNT(*) FROM agent_artifact_versions av WHERE av.artifact_id = a.id) AS version_count
        FROM agent_artifacts a
        LEFT JOIN agent_runs r ON r.id = a.run_id
        LEFT JOIN agent_artifact_versions v ON v.id = a.current_version_id
        WHERE a.user_id = ?
        ORDER BY COALESCE(a.updated_at, a.created_at) DESC, a.id DESC
        LIMIT ?
    `, [user.id, normalizePositiveInt(limit, 30, 1, 100)]);
}

async function getAgentArtifactForUser(artifactId, user) {
    return await queryOne(`
        SELECT a.*, r.title AS run_title, r.status AS run_status,
               v.version AS current_version,
               (SELECT COUNT(*) FROM agent_artifact_versions av WHERE av.artifact_id = a.id) AS version_count
        FROM agent_artifacts a
        LEFT JOIN agent_runs r ON r.id = a.run_id
        LEFT JOIN agent_artifact_versions v ON v.id = a.current_version_id
        WHERE a.id = ? AND a.user_id = ?
    `, [artifactId, user.id]);
}

async function listAgentArtifactVersions(artifactId, user) {
    const artifact = await getAgentArtifactForUser(artifactId, user);
    if (!artifact) return null;
    const versions = await query(`
        SELECT id, artifact_id, version, content, note, created_by, created_at
        FROM agent_artifact_versions
        WHERE artifact_id = ?
        ORDER BY version DESC
    `, [artifact.id]);
    return { artifact, versions };
}

async function nextArtifactVersion(artifactId) {
    const row = await queryOne('SELECT COALESCE(MAX(version), 0) + 1 AS version FROM agent_artifact_versions WHERE artifact_id = ?', [artifactId]);
    return Number(row?.version || 1);
}

async function createOrUpdateRunArtifact({ runId, user, type = 'summary', title, content, note = '' } = {}) {
    const safeRunId = String(runId || '').trim();
    const safeType = String(type || 'summary').trim().slice(0, 40) || 'summary';
    const safeTitle = String(title || '智能体结果').trim().slice(0, 120) || '智能体结果';
    const safeContent = String(content || '').trim();
    const safeNote = String(note || '').trim().slice(0, 500);
    if (!safeRunId || !user?.id || !safeContent) {
        throw new Error('创建运行产物需要有效的任务、用户和内容。');
    }
    const run = await queryOne('SELECT id FROM agent_runs WHERE id = ? AND user_id = ? AND deleted_at IS NULL', [safeRunId, user.id]);
    if (!run) throw new Error('任务不存在或无权创建产物。');
    const existing = await queryOne(`
        SELECT id FROM agent_artifacts
        WHERE run_id = ? AND user_id = ? AND type = ?
        ORDER BY id DESC
        LIMIT 1
    `, [safeRunId, user.id, safeType]);
    if (existing) {
        return await createAgentArtifactVersion(existing.id, user, {
            content: safeContent,
            note: safeNote || '运行结果更新'
        });
    }
    const now = getBeijingTimestamp();
    let artifactId = 0;
    await transaction(async trx => {
        const row = await trx.queryOne(`
            INSERT INTO agent_artifacts (run_id, user_id, type, title, content, note, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            RETURNING id
        `, [safeRunId, user.id, safeType, safeTitle, safeContent, safeNote, now, now]);
        artifactId = row?.id;
        const versionRow = await trx.queryOne(`
            INSERT INTO agent_artifact_versions (artifact_id, version, content, note, created_by, created_at)
            VALUES (?, 1, ?, ?, ?, ?)
            RETURNING id
        `, [artifactId, safeContent, safeNote || '初始版本', user.id, now]);
        await trx.execute('UPDATE agent_artifacts SET current_version_id = ? WHERE id = ?', [versionRow?.id, artifactId]);
    });
    return await getAgentArtifactForUser(artifactId, user);
}

async function createAgentArtifactVersion(artifactId, user, body = {}) {
    const artifact = await getAgentArtifactForUser(artifactId, user);
    if (!artifact) return null;
    const content = String(body.content ?? artifact.content ?? '').trim();
    if (!content) {
        const err = new Error('版本内容不能为空。');
        err.status = 400;
        throw err;
    }
    const note = String(body.note || '').trim().slice(0, 500);
    const now = getBeijingTimestamp();
    const version = await nextArtifactVersion(artifact.id);
    let versionId = 0;
    await transaction(async trx => {
        const versionRow = await trx.queryOne(`
            INSERT INTO agent_artifact_versions (artifact_id, version, content, note, created_by, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            RETURNING id
        `, [artifact.id, version, content, note, user.id, now]);
        versionId = versionRow?.id;
        await trx.execute(`
            UPDATE agent_artifacts
            SET content = ?, note = ?, current_version_id = ?, updated_at = ?
            WHERE id = ? AND user_id = ?
        `, [content, note, versionId, now, artifact.id, user.id]);
    });
    return await getAgentArtifactForUser(artifact.id, user);
}

function buildLineDiff(fromContent, toContent) {
    const fromLines = String(fromContent || '').split(/\r?\n/);
    const toLines = String(toContent || '').split(/\r?\n/);
    const max = Math.max(fromLines.length, toLines.length);
    const rows = [];
    for (let i = 0; i < max; i += 1) {
        const before = fromLines[i] ?? '';
        const after = toLines[i] ?? '';
        if (before === after) rows.push({ type: 'same', line: i + 1, text: before });
        else {
            if (before) rows.push({ type: 'remove', line: i + 1, text: before });
            if (after) rows.push({ type: 'add', line: i + 1, text: after });
        }
        if (rows.length >= 400) {
            rows.push({ type: 'truncated', line: i + 1, text: 'Diff 已截断，仅展示前 400 行变化。' });
            break;
        }
    }
    return rows;
}

async function diffAgentArtifactVersions(artifactId, user, fromVersion, toVersion) {
    const artifact = await getAgentArtifactForUser(artifactId, user);
    if (!artifact) return null;
    const from = await queryOne('SELECT * FROM agent_artifact_versions WHERE artifact_id = ? AND version = ?', [artifact.id, Number(fromVersion)]);
    const to = await queryOne('SELECT * FROM agent_artifact_versions WHERE artifact_id = ? AND version = ?', [artifact.id, Number(toVersion)]);
    if (!from || !to) {
        const err = new Error('对比版本不存在。');
        err.status = 404;
        throw err;
    }
    return { artifact, from, to, diff: buildLineDiff(from.content, to.content) };
}

async function rollbackAgentArtifactVersion(artifactId, user, version, note = '') {
    const artifact = await getAgentArtifactForUser(artifactId, user);
    if (!artifact) return null;
    const target = await queryOne('SELECT * FROM agent_artifact_versions WHERE artifact_id = ? AND version = ?', [artifact.id, Number(version)]);
    if (!target) {
        const err = new Error('回滚版本不存在。');
        err.status = 404;
        throw err;
    }
    return await createAgentArtifactVersion(artifact.id, user, {
        content: target.content,
        note: String(note || `回滚到 v${target.version}`).slice(0, 500)
    });
}

async function saveAgentRunArtifact(runId, user, body = {}) {
    const getRunDetailForUser = ensureGetRunDetailForUser();
    const getAgentRunTitle = ensureGetAgentRunTitle();
    const detail = await getRunDetailForUser(runId, user);
    if (!detail) return null;
    const content = String(body.content || detail.run.final_answer || detail.run.error_message || '').trim();
    if (!content) {
        const err = new Error('当前任务没有可沉淀的结果。');
        err.status = 400;
        throw err;
    }
    const title = String(body.title || getAgentRunTitle(detail.run) || '智能体结果').trim().slice(0, 120);
    const note = String(body.note || '初始沉淀').trim().slice(0, 500);
    const now = getBeijingTimestamp();
    let artifactId = 0;
    await transaction(async trx => {
        const row = await trx.queryOne(`
            INSERT INTO agent_artifacts (run_id, user_id, type, title, content, note, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            RETURNING id
        `, [runId, user.id, String(body.type || 'summary').slice(0, 40), title, content, note, now, now]);
        artifactId = row?.id;
        const versionRow = await trx.queryOne(`
            INSERT INTO agent_artifact_versions (artifact_id, version, content, note, created_by, created_at)
            VALUES (?, 1, ?, ?, ?, ?)
            RETURNING id
        `, [artifactId, content, note, user.id, now]);
        await trx.execute('UPDATE agent_artifacts SET current_version_id = ? WHERE id = ?', [versionRow?.id, artifactId]);
    });
    await createAgentNotificationCallback(user.id, runId, 'artifact', '智能体结果已沉淀', title);
    return await getAgentArtifactForUser(artifactId, user);
}

async function exportAgentRun(runId, user, format = 'json') {
    const getRunDetailForUser = ensureGetRunDetailForUser();
    const getAgentRunTitle = ensureGetAgentRunTitle();
    const detail = await getRunDetailForUser(runId, user);
    if (!detail) return null;
    const payload = {
        exportedAt: getBeijingTimestamp(),
        run: detail.run,
        progress: detail.progress,
        steps: detail.steps,
        dagNodes: detail.dagNodes || []
    };
    await execute('UPDATE agent_runs SET export_count = COALESCE(export_count, 0) + 1, updated_at = ? WHERE id = ?', [getBeijingTimestamp(), runId]);
    if (format === 'markdown') {
        const lines = [
            `# ${getAgentRunTitle(detail.run) || '智能体任务报告'}`,
            '',
            `- 状态：${detail.run.status}`,
            `- 模型：${detail.run.model_name || detail.run.model_id || '-'}`,
            `- 运行模式：${detail.run.run_mode || 'standard'}`,
            `- 工具范围：${detail.run.tool_policy || 'all'}`,
            `- 模型用量：${Number(detail.run.total_tokens || 0)}`,
            '',
            '## 目标',
            detail.run.goal || '',
            '',
            '## 最终结果',
            detail.run.final_answer || detail.run.error_message || '暂无最终结果',
            '',
            '## 执行步骤',
            ...detail.steps.map(step => [
                `### ${step.step_index}. ${step.title || step.type}`,
                `- 类型：${step.type}`,
                `- 工具：${step.tool_name || '-'}`,
                `- 状态：${step.status}`,
                step.error_message ? `- 错误：${step.error_message}` : '',
                '',
                '```json',
                JSON.stringify({ input: step.input, output: step.output }, null, 2),
                '```',
                ''
            ].join('\n')),
            ...(detail.dagNodes?.length ? [
                '',
                '## 工作流节点',
                ...detail.dagNodes.map(node => [
                    `### ${node.title || node.node_key}`,
                    `- 工具：${node.tool_name || '-'}`,
                    `- 状态：${node.status || '-'}`,
                    node.error_message ? `- 错误：${node.error_message}` : '',
                    '',
                    '```json',
                    JSON.stringify({ input: node.input, output: node.output }, null, 2),
                    '```',
                    ''
                ].join('\n'))
            ] : [])
        ];
        return { contentType: 'text/markdown; charset=utf-8', filename: `${runId}.md`, body: lines.join('\n') };
    }
    return { contentType: 'application/json; charset=utf-8', filename: `${runId}.json`, body: JSON.stringify(payload, null, 2) };
}

module.exports = {
    configureAgentArtifacts,
    createOrUpdateRunArtifact,
    diffAgentArtifactVersions,
    exportAgentRun,
    getAgentArtifactForUser,
    listAgentArtifactVersions,
    listAgentArtifacts,
    listAgentNotifications,
    markAgentNotificationRead,
    rollbackAgentArtifactVersion,
    saveAgentRunArtifact
};
