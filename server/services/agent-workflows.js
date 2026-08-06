const { db } = require('../db');
const { sql } = require('../db/statements');
const { getBeijingTimestamp } = require('../time');
const { isAdmin } = require('../permissions');
const {
    parseJsonObject,
    normalizeDagSpec,
    inspectDagTopology
} = require('./agent-validators');
const { formatToolList } = require('./agent-tool-catalog');
const { inspectDagContracts } = require('./agent-dag-contracts');
const workflowRepository = require('../repositories/workflows');
const {
    canAccessSharedResource,
    normalizeShareScope,
    normalizeShareSettings,
    parseAllowedUnits
} = require('./unit-visibility');

/**
 * 工作流访问判定：所有者可读写，共享工作流按部门范围只读可运行。
 * write 为 true 时只承认所有者，保证编辑、发布、回滚和删除始终留在创建人手里。
 */
function assertWorkflowAccess(workflow, user, write = false) {
    if (!canAccessSharedResource(workflow, user, write)) return false;
    // 共享工作流只在发布后对接收方可见，避免草稿通过列表或运行入口泄露。
    if (!write && Number(workflow?.user_id) !== Number(user?.id)
        && normalizeShareScope(workflow?.scope) === 'shared'
        && !workflow?.published_version_id) return false;
    return true;
}

// 读取工作流原始行，不做归属过滤，由调用方用 assertWorkflowAccess 判定
function findWorkflowRow(workflowId, { includeDeleted = false } = {}) {
    return workflowRepository.getWorkflowById(workflowId, { includeDeleted });
}

// 取出仅所有者可操作的工作流，权限不足统一返回 null 交给路由层转 404
function findOwnedWorkflowRow(workflowId, user) {
    const row = findWorkflowRow(workflowId);
    return row && assertWorkflowAccess(row, user, true) ? row : null;
}

function normalizeDagRunInputs(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).slice(0, 50).map(([key, item]) => [String(key).trim().slice(0, 80), item]));
}

function llmNodeInputText(node) {
    const input = node?.input && typeof node.input === 'object' ? node.input : {};
    return [
        input.prompt,
        input.systemPrompt,
        input.system_prompt,
        input.input,
        input.text
    ].map(value => String(value || '')).join('\n');
}

function llmNodeReferencesWorkflowInput(node) {
    return /\{\{\s*(?:goal|run\.goal|inputs?\.|run\.inputs?\.)/i.test(llmNodeInputText(node));
}

function validateLlmNodePlacement(dagSpec) {
    const nodes = Array.isArray(dagSpec?.nodes) ? dagSpec.nodes : [];
    return nodes
        .filter(node => String(node?.tool || '').trim() === 'agent.llm')
        .filter(node => !(Array.isArray(node.dependsOn) && node.dependsOn.length > 0))
        .filter(node => !llmNodeReferencesWorkflowInput(node))
        .map(node => `${node.title || node.id} 缺少上游输入，请连接数据/检索节点，或在提示词中引用 {{goal}} / {{inputs.*}}。`);
}

function assertWorkflowLlmNodesConfigured(dagSpec) {
    const nodes = Array.isArray(dagSpec?.nodes) ? dagSpec.nodes : [];
    const modelNodes = nodes.filter(node => ['agent.llm', 'agent.content_review'].includes(String(node?.tool || '').trim()));
    const unconfiguredNode = modelNodes.find(node => !String(
        node?.input?.model || node?.input?.modelId || node?.input?.model_id || ''
    ).trim());
    if (unconfiguredNode) {
        const err = new Error(`${unconfiguredNode.title || unconfiguredNode.id || '大模型节点'} 需要填写节点模型。`);
        err.status = 400;
        throw err;
    }
    const placementIssues = validateLlmNodePlacement(dagSpec);
    if (placementIssues.length) {
        const err = new Error(placementIssues[0]);
        err.status = 400;
        throw err;
    }
}

function normalizeWorkflowPayload(body = {}, fallback = {}, user = {}) {
    const name = String(body.name || fallback.name || '未命名工作流').trim().slice(0, 100) || '未命名工作流';
    const dagSpec = normalizeDagSpec(body.dagSpec || body.dag_spec || fallback.dagSpec || fallback.dag_spec || {});
    if (!dagSpec.nodes.length) {
        const err = new Error('保存工作流需要至少一个有效节点。');
        err.status = 400;
        throw err;
    }
    const topology = inspectDagTopology(dagSpec);
    if (topology.blockers.length) {
        const err = new Error(`工作流结构无效：${topology.blockers[0]}`);
        err.status = 400;
        err.details = { topology };
        throw err;
    }
    assertWorkflowLlmNodesConfigured(dagSpec);
    // 未显式传共享设置时沿用原值，保证旧客户端保存不会意外改变可见性
    const share = normalizeShareSettings(body, user, fallback);
    return {
        name,
        description: String(body.description || fallback.description || '').trim().slice(0, 300),
        note: String(body.note || '').trim().slice(0, 300),
        scope: share.scope,
        allowedUnits: share.allowedUnits,
        dagSpec
    };
}

function normalizeDagInputsPayload(value) {
    if (!value) return {};
    if (typeof value === 'string') {
        const parsed = parseJsonObject(value);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? normalizeDagRunInputs(parsed) : {};
    }
    return normalizeDagRunInputs(value);
}

function formatAgentWorkflow(row, user = null) {
    if (!row) return null;
    const dagSpec = parseJsonObject(row.current_dag_spec || row.dag_spec || '') || { nodes: [] };
    const scope = normalizeShareScope(row.scope);
    const isOwner = user ? Number(row.user_id) === Number(user.id) : true;
    const publishedDagSpec = parseJsonObject(row.published_dag_spec || '') || { nodes: [] };
    const visibleDagSpec = isOwner ? dagSpec : publishedDagSpec;
    const visibleVersion = isOwner
        ? Number(row.current_version || row.version || 0)
        : Number(row.published_version || 0);
    return {
        id: row.id,
        user_id: row.user_id,
        name: row.name,
        description: row.description || '',
        scope,
        allowed_units: parseAllowedUnits(row.allowed_units),
        is_owner: isOwner,
        // 共享给本人的工作流只能查看和运行，编辑入口由前端按此标志隐藏
        can_edit: isOwner,
        owner_name: row.owner_name || '',
        current_version_id: isOwner ? (row.current_version_id || null) : (row.published_version_id || null),
        current_version: visibleVersion,
        current_note: isOwner ? (row.current_note || '') : (row.published_note || ''),
        published_version_id: row.published_version_id || null,
        published_version: Number(row.published_version || 0),
        published_at: row.published_at || '',
        is_published: Boolean(row.published_version_id),
        dag_spec: visibleDagSpec,
        node_count: Array.isArray(visibleDagSpec.nodes) ? visibleDagSpec.nodes.length : 0,
        created_at: row.created_at,
        updated_at: row.updated_at,
        version_created_at: isOwner ? (row.version_created_at || '') : (row.published_version_created_at || '')
    };
}

function getAgentWorkflowForUser(workflowId, user) {
    const row = workflowRepository.getWorkflowForUser(workflowId);
    if (!assertWorkflowAccess(row, user, false)) return null;
    return formatAgentWorkflow(row, user);
}

function listAgentWorkflows(user) {
    return workflowRepository.listWorkflowsForUser(user.id)
        .filter(row => assertWorkflowAccess(row, user, false))
        .slice(0, 100)
        .map(row => formatAgentWorkflow(row, user));
}

function listAgentWorkflowShareOptions(user) {
    const currentUnit = String(user?.unit || '').trim();
    const admin = isAdmin(user);
    const units = admin
        ? sql(`
            SELECT DISTINCT TRIM(unit) AS unit
            FROM users
            WHERE deleted_at IS NULL AND COALESCE(status, 'active') = 'active' AND TRIM(COALESCE(unit, '')) <> ''
            ORDER BY TRIM(unit) COLLATE NOCASE ASC
        `).all().map(row => String(row.unit || '').trim()).filter(Boolean)
        : (currentUnit ? [currentUnit] : []);
    return {
        currentUnit,
        units: [...new Set(units)],
        canShareAll: admin,
        canShareAcrossUnits: admin
    };
}

function resolveAgentWorkflowVersion(workflowId, user, version = 'current') {
    const normalizedWorkflowId = Number.parseInt(workflowId, 10);
    if (!normalizedWorkflowId) return null;
    const workflow = workflowRepository.getWorkflowVersionContext(normalizedWorkflowId);
    if (!assertWorkflowAccess(workflow, user, false)) return null;
    const isOwner = Number(workflow.user_id) === Number(user.id);
    let requested = String(version || 'current').trim().toLowerCase();
    // 共享使用者只能运行发布版：默认的 current 自动落到 published，
    // 显式指定历史版本则拒绝，草稿和版本历史仍归创建人掌握
    if (!isOwner) {
        if (requested === 'current' || !requested) {
            requested = 'published';
        } else if (requested !== 'published') {
            const err = new Error('共享工作流只能运行已发布版本。');
            err.status = 403;
            throw err;
        }
    }
    let versionRow = null;
    let mode = requested || 'current';
    if (requested === 'published') {
        if (!workflow.published_version_id) {
            const err = new Error('工作流尚未发布，不能以发布版运行。');
            err.status = 400;
            throw err;
        }
        versionRow = workflowRepository.getWorkflowVersionById(workflow.id, workflow.published_version_id);
    } else if (requested === 'current') {
        versionRow = workflowRepository.getWorkflowVersionById(workflow.id, workflow.current_version_id);
    } else {
        const numericVersion = Number.parseInt(requested, 10);
        if (!numericVersion) return null;
        mode = 'version';
        versionRow = workflowRepository.getWorkflowVersionByNumber(workflow.id, numericVersion);
    }
    if (!versionRow) return null;
    const dagSpec = normalizeDagSpec(parseJsonObject(versionRow.dag_spec) || {});
    if (!dagSpec.nodes.length) {
        const err = new Error('目标工作流版本没有有效节点。');
        err.status = 400;
        throw err;
    }
    return {
        workflow: {
            id: workflow.id,
            name: workflow.name,
            current_version: Number(workflow.current_version || 0),
            published_version: Number(workflow.published_version || 0),
            published_at: workflow.published_at || ''
        },
        version: Number(versionRow.version || 0),
        version_id: versionRow.id,
        mode,
        dagSpec
    };
}

function createAgentWorkflow(user, body = {}) {
    const data = normalizeWorkflowPayload(body, {}, user);
    const now = getBeijingTimestamp();
    const create = db.transaction(() => {
        const workflowInfo = db.prepare(`
            INSERT INTO agent_workflows (user_id, name, description, scope, allowed_units, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(user.id, data.name, data.description, data.scope, data.allowedUnits, now, now);
        const workflowId = workflowInfo.lastInsertRowid;
        const versionInfo = db.prepare(`
            INSERT INTO agent_workflow_versions (workflow_id, version, dag_spec, note, created_by, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(workflowId, 1, JSON.stringify(data.dagSpec), data.note, user.id, now);
        db.prepare('UPDATE agent_workflows SET current_version_id = ? WHERE id = ?')
            .run(versionInfo.lastInsertRowid, workflowId);
        return workflowId;
    });
    return getAgentWorkflowForUser(create(), user);
}

function updateAgentWorkflow(workflowId, user, body = {}) {
    const current = findOwnedWorkflowRow(workflowId, user);
    if (!current) return null;
    const data = normalizeWorkflowPayload(body, current, user);
    const currentVersion = workflowRepository.getWorkflowVersionById(current.id, current.current_version_id);
    const shareUnchanged = normalizeShareScope(current.scope) === data.scope
        && String(current.allowed_units || '') === data.allowedUnits;
    const unchanged = currentVersion
        && shareUnchanged
        && String(current.name || '') === data.name
        && String(current.description || '') === data.description
        && JSON.stringify(normalizeDagSpec(parseJsonObject(currentVersion.dag_spec) || {})) === JSON.stringify(data.dagSpec);
    if (unchanged) return getAgentWorkflowForUser(current.id, user);
    const now = getBeijingTimestamp();
    const update = db.transaction(() => {
        const nextVersion = Number(db.prepare('SELECT COALESCE(MAX(version), 0) + 1 AS next FROM agent_workflow_versions WHERE workflow_id = ?').get(current.id)?.next || 1);
        const versionInfo = db.prepare(`
            INSERT INTO agent_workflow_versions (workflow_id, version, dag_spec, note, created_by, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(current.id, nextVersion, JSON.stringify(data.dagSpec), data.note, user.id, now);
        db.prepare(`
            UPDATE agent_workflows
            SET name = ?, description = ?, scope = ?, allowed_units = ?, current_version_id = ?, updated_at = ?
            WHERE id = ?
        `).run(data.name, data.description, data.scope, data.allowedUnits, versionInfo.lastInsertRowid, now, current.id);
        return current.id;
    });
    return getAgentWorkflowForUser(update(), user);
}

function updateAgentWorkflowSharing(workflowId, user, body = {}) {
    const current = findOwnedWorkflowRow(workflowId, user);
    if (!current) return null;
    const share = normalizeShareSettings(body, user, current);
    const unchanged = normalizeShareScope(current.scope) === share.scope
        && String(current.allowed_units || '') === share.allowedUnits;
    if (unchanged) return getAgentWorkflowForUser(current.id, user);
    const now = getBeijingTimestamp();
    const update = db.transaction(() => sql(`
        UPDATE agent_workflows
        SET scope = ?, allowed_units = ?, updated_at = ?
        WHERE id = ? AND user_id = ? AND deleted_at IS NULL
    `).run(share.scope, share.allowedUnits, now, current.id, user.id));
    if (update().changes === 0) return null;
    return getAgentWorkflowForUser(current.id, user);
}

function publishAgentWorkflowVersion(workflowId, user, version = 'current') {
    // 发布属于写操作，先确认所有者身份再解析版本
    if (!findOwnedWorkflowRow(workflowId, user)) return null;
    const resolved = resolveAgentWorkflowVersion(workflowId, user, version || 'current');
    if (!resolved) return null;
    const topology = inspectDagTopology(resolved.dagSpec);
    if (topology.blockers.length) {
        const err = new Error(`发布前检查未通过：${topology.blockers[0]}`);
        err.status = 400;
        err.details = { topology };
        throw err;
    }
    const contractReport = inspectDagContracts(resolved.dagSpec, formatToolList(user, { toolPolicy: 'all' }));
    if (contractReport.blockers.length) {
        const err = new Error(`发布前检查未通过：${contractReport.blockers[0]}`);
        err.status = 400;
        err.details = { contracts: contractReport };
        throw err;
    }
    const now = getBeijingTimestamp();
    db.prepare(`
        UPDATE agent_workflows
        SET published_version_id = ?, published_at = ?, updated_at = ?
        WHERE id = ? AND user_id = ? AND deleted_at IS NULL
    `).run(resolved.version_id, now, now, resolved.workflow.id, user.id);
    return getAgentWorkflowForUser(resolved.workflow.id, user);
}

function listAgentWorkflowVersions(workflowId, user) {
    const workflow = workflowRepository.getOwnedWorkflow(workflowId, user.id);
    if (!workflow) return null;
    return workflowRepository.listWorkflowVersions(workflow.id).map(row => ({
        ...row,
        dag_spec: parseJsonObject(row.dag_spec) || { nodes: [] }
    }));
}

function restoreAgentWorkflowVersion(workflowId, user, version) {
    const workflow = workflowRepository.getOwnedWorkflow(workflowId, user.id);
    if (!workflow) return null;
    const source = workflowRepository.getWorkflowVersionByNumber(workflow.id, version);
    if (!source) return null;
    const dagSpec = normalizeDagSpec(parseJsonObject(source.dag_spec) || {});
    if (!dagSpec.nodes.length) {
        const err = new Error('目标版本没有有效节点，无法回滚。');
        err.status = 400;
        throw err;
    }
    const now = getBeijingTimestamp();
    const restore = db.transaction(() => {
        const nextVersion = Number(db.prepare('SELECT COALESCE(MAX(version), 0) + 1 AS next FROM agent_workflow_versions WHERE workflow_id = ?').get(workflow.id)?.next || 1);
        const versionInfo = db.prepare(`
            INSERT INTO agent_workflow_versions (workflow_id, version, dag_spec, note, created_by, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(workflow.id, nextVersion, JSON.stringify(dagSpec), `从 v${source.version} 回滚`, user.id, now);
        db.prepare('UPDATE agent_workflows SET current_version_id = ?, updated_at = ? WHERE id = ?')
            .run(versionInfo.lastInsertRowid, now, workflow.id);
        return workflow.id;
    });
    return getAgentWorkflowForUser(restore(), user);
}

function normalizeWorkflowNodesForDiff(spec = {}) {
    const dag = normalizeDagSpec(spec || {});
    return new Map(dag.nodes.map(node => [node.id, node]));
}

function sameJsonValue(left, right) {
    return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function diffAgentWorkflowVersions(workflowId, user, fromVersion, toVersion = 'current') {
    const workflow = workflowRepository.getWorkflowDiffContext(workflowId, user.id);
    if (!workflow) return null;
    const normalizeVersion = value => {
        if (String(value || '').trim() === 'current') return Number(workflow.current_version || 0);
        return Number.parseInt(value, 10);
    };
    const from = normalizeVersion(fromVersion);
    const to = normalizeVersion(toVersion);
    if (!from || !to) return null;
    const rows = workflowRepository.listWorkflowVersionsForDiff(workflow.id, from, to);
    const fromRow = rows.find(row => Number(row.version) === from);
    const toRow = rows.find(row => Number(row.version) === to);
    if (!fromRow || !toRow) return null;
    const fromNodes = normalizeWorkflowNodesForDiff(parseJsonObject(fromRow.dag_spec) || {});
    const toNodes = normalizeWorkflowNodesForDiff(parseJsonObject(toRow.dag_spec) || {});
    const added = [];
    const removed = [];
    const changed = [];
    toNodes.forEach((node, id) => {
        const before = fromNodes.get(id);
        if (!before) {
            added.push({ id, title: node.title, tool: node.tool });
            return;
        }
        const changes = [];
        if (before.title !== node.title) changes.push('标题');
        if (before.tool !== node.tool) changes.push('工具');
        if (!sameJsonValue(before.input, node.input)) changes.push('输入');
        if (!sameJsonValue(before.dependsOn, node.dependsOn)) changes.push('依赖');
        if (before.condition !== node.condition) changes.push('条件');
        if (changes.length) {
            changed.push({
                id,
                before: { title: before.title, tool: before.tool, dependsOn: before.dependsOn, condition: before.condition, input: before.input },
                after: { title: node.title, tool: node.tool, dependsOn: node.dependsOn, condition: node.condition, input: node.input },
                changes
            });
        }
    });
    fromNodes.forEach((node, id) => {
        if (!toNodes.has(id)) removed.push({ id, title: node.title, tool: node.tool });
    });
    return {
        workflow: { id: workflow.id, name: workflow.name },
        from: { version: fromRow.version, note: fromRow.note || '', created_at: fromRow.created_at },
        to: { version: toRow.version, note: toRow.note || '', created_at: toRow.created_at },
        summary: {
            added: added.length,
            removed: removed.length,
            changed: changed.length
        },
        added,
        removed,
        changed
    };
}

function deleteAgentWorkflow(workflowId, user) {
    const workflow = workflowRepository.getOwnedWorkflow(workflowId, user.id);
    if (!workflow) return null;
    const now = getBeijingTimestamp();
    db.prepare('UPDATE agent_workflows SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now, now, workflow.id);
    db.prepare(`
        UPDATE agent_schedules
        SET status = 'paused', next_run_at = NULL, dispatch_retry_at = NULL,
            claim_token = NULL, claim_expires_at = NULL,
            last_error = '引用的工作流已删除', updated_at = ?
        WHERE user_id = ? AND deleted_at IS NULL
          AND json_valid(run_config)
          AND CAST(json_extract(run_config, '$.workflowId') AS INTEGER) = ?
    `).run(now, user.id, workflow.id);
    return workflow;
}

// 恢复已删除工作流（软撤销）
function restoreAgentWorkflow(workflowId, user) {
    const workflow = workflowRepository.getRecentlyDeletedOwnedWorkflow(workflowId, user.id);
    if (!workflow) return null;
    const now = getBeijingTimestamp();
    db.prepare('UPDATE agent_workflows SET deleted_at = NULL, updated_at = ? WHERE id = ?').run(now, workflow.id);
    return getAgentWorkflowForUser(workflow.id, user);
}

module.exports = {
    assertWorkflowAccess,
    assertWorkflowLlmNodesConfigured,
    createAgentWorkflow,
    deleteAgentWorkflow,
    diffAgentWorkflowVersions,
    formatAgentWorkflow,
    getAgentWorkflowForUser,
    listAgentWorkflowVersions,
    listAgentWorkflows,
    listAgentWorkflowShareOptions,
    normalizeDagInputsPayload,
    normalizeDagRunInputs,
    publishAgentWorkflowVersion,
    resolveAgentWorkflowVersion,
    restoreAgentWorkflow,
    restoreAgentWorkflowVersion,
    updateAgentWorkflow,
    updateAgentWorkflowSharing
};
