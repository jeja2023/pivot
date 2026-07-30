const { db } = require('../db');
const { getBeijingTimestamp } = require('../time');
const {
    parseJsonObject,
    normalizeDagSpec
} = require('./agent-validators');
const { formatToolList } = require('./agent-tool-catalog');
const { inspectDagContracts } = require('./agent-dag-contracts');

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

function assertWorkflowHasConfiguredLlm(dagSpec) {
    const nodes = Array.isArray(dagSpec?.nodes) ? dagSpec.nodes : [];
    const llmNodes = nodes.filter(node => String(node?.tool || '').trim() === 'agent.llm');
    if (!llmNodes.length) {
        const err = new Error('工作流必须包含 1 个大模型节点。');
        err.status = 400;
        throw err;
    }
    const unconfiguredNode = llmNodes.find(node => !String(
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

function normalizeWorkflowPayload(body = {}, fallback = {}) {
    const name = String(body.name || fallback.name || '未命名工作流').trim().slice(0, 100) || '未命名工作流';
    const dagSpec = normalizeDagSpec(body.dagSpec || body.dag_spec || fallback.dagSpec || fallback.dag_spec || {});
    if (!dagSpec.nodes.length) {
        const err = new Error('保存工作流需要至少一个有效节点。');
        err.status = 400;
        throw err;
    }
    assertWorkflowHasConfiguredLlm(dagSpec);
    return {
        name,
        description: String(body.description || fallback.description || '').trim().slice(0, 300),
        note: String(body.note || '').trim().slice(0, 300),
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

function formatAgentWorkflow(row) {
    if (!row) return null;
    const dagSpec = parseJsonObject(row.current_dag_spec || row.dag_spec || '') || { nodes: [] };
    return {
        id: row.id,
        user_id: row.user_id,
        name: row.name,
        description: row.description || '',
        current_version_id: row.current_version_id || null,
        current_version: Number(row.current_version || row.version || 0),
        current_note: row.current_note || '',
        published_version_id: row.published_version_id || null,
        published_version: Number(row.published_version || 0),
        published_at: row.published_at || '',
        is_published: Boolean(row.published_version_id),
        dag_spec: dagSpec,
        node_count: Array.isArray(dagSpec.nodes) ? dagSpec.nodes.length : 0,
        created_at: row.created_at,
        updated_at: row.updated_at,
        version_created_at: row.version_created_at || ''
    };
}

function getAgentWorkflowForUser(workflowId, user) {
    const row = db.prepare(`
        SELECT
            w.*,
            v.version AS current_version,
            v.dag_spec AS current_dag_spec,
            v.note AS current_note,
            v.created_at AS version_created_at,
            pv.version AS published_version
        FROM agent_workflows w
        LEFT JOIN agent_workflow_versions v ON v.id = w.current_version_id
        LEFT JOIN agent_workflow_versions pv ON pv.id = w.published_version_id
        WHERE w.id = ? AND w.user_id = ? AND w.deleted_at IS NULL
    `).get(workflowId, user.id);
    return formatAgentWorkflow(row);
}

function listAgentWorkflows(user) {
    return db.prepare(`
        SELECT
            w.*,
            v.version AS current_version,
            v.dag_spec AS current_dag_spec,
            v.note AS current_note,
            v.created_at AS version_created_at,
            pv.version AS published_version
        FROM agent_workflows w
        LEFT JOIN agent_workflow_versions v ON v.id = w.current_version_id
        LEFT JOIN agent_workflow_versions pv ON pv.id = w.published_version_id
        WHERE w.user_id = ? AND w.deleted_at IS NULL
        ORDER BY w.updated_at DESC, w.id DESC
        LIMIT 100
    `).all(user.id).map(formatAgentWorkflow);
}

function resolveAgentWorkflowVersion(workflowId, user, version = 'current') {
    const normalizedWorkflowId = Number.parseInt(workflowId, 10);
    if (!normalizedWorkflowId) return null;
    const workflow = db.prepare(`
        SELECT
            w.*,
            cv.version AS current_version,
            pv.version AS published_version
        FROM agent_workflows w
        LEFT JOIN agent_workflow_versions cv ON cv.id = w.current_version_id
        LEFT JOIN agent_workflow_versions pv ON pv.id = w.published_version_id
        WHERE w.id = ? AND w.user_id = ? AND w.deleted_at IS NULL
    `).get(normalizedWorkflowId, user.id);
    if (!workflow) return null;
    const requested = String(version || 'current').trim().toLowerCase();
    let versionRow = null;
    let mode = requested || 'current';
    if (requested === 'published') {
        if (!workflow.published_version_id) {
            const err = new Error('工作流尚未发布，不能以发布版运行。');
            err.status = 400;
            throw err;
        }
        versionRow = db.prepare('SELECT * FROM agent_workflow_versions WHERE id = ? AND workflow_id = ?')
            .get(workflow.published_version_id, workflow.id);
    } else if (requested === 'current') {
        versionRow = db.prepare('SELECT * FROM agent_workflow_versions WHERE id = ? AND workflow_id = ?')
            .get(workflow.current_version_id, workflow.id);
    } else {
        const numericVersion = Number.parseInt(requested, 10);
        if (!numericVersion) return null;
        mode = 'version';
        versionRow = db.prepare('SELECT * FROM agent_workflow_versions WHERE workflow_id = ? AND version = ?')
            .get(workflow.id, numericVersion);
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
    const data = normalizeWorkflowPayload(body);
    const now = getBeijingTimestamp();
    const create = db.transaction(() => {
        const workflowInfo = db.prepare(`
            INSERT INTO agent_workflows (user_id, name, description, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)
        `).run(user.id, data.name, data.description, now, now);
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
    const current = db.prepare('SELECT * FROM agent_workflows WHERE id = ? AND user_id = ? AND deleted_at IS NULL').get(workflowId, user.id);
    if (!current) return null;
    const data = normalizeWorkflowPayload(body, current);
    const now = getBeijingTimestamp();
    const update = db.transaction(() => {
        const nextVersion = Number(db.prepare('SELECT COALESCE(MAX(version), 0) + 1 AS next FROM agent_workflow_versions WHERE workflow_id = ?').get(current.id)?.next || 1);
        const versionInfo = db.prepare(`
            INSERT INTO agent_workflow_versions (workflow_id, version, dag_spec, note, created_by, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(current.id, nextVersion, JSON.stringify(data.dagSpec), data.note, user.id, now);
        db.prepare(`
            UPDATE agent_workflows
            SET name = ?, description = ?, current_version_id = ?, updated_at = ?
            WHERE id = ?
        `).run(data.name, data.description, versionInfo.lastInsertRowid, now, current.id);
        return current.id;
    });
    return getAgentWorkflowForUser(update(), user);
}

function publishAgentWorkflowVersion(workflowId, user, version = 'current') {
    const resolved = resolveAgentWorkflowVersion(workflowId, user, version || 'current');
    if (!resolved) return null;
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
    const workflow = db.prepare('SELECT id FROM agent_workflows WHERE id = ? AND user_id = ? AND deleted_at IS NULL').get(workflowId, user.id);
    if (!workflow) return null;
    return db.prepare(`
        SELECT id, workflow_id, version, dag_spec, note, created_by, created_at
        FROM agent_workflow_versions
        WHERE workflow_id = ?
        ORDER BY version DESC
    `).all(workflow.id).map(row => ({
        ...row,
        dag_spec: parseJsonObject(row.dag_spec) || { nodes: [] }
    }));
}

function restoreAgentWorkflowVersion(workflowId, user, version) {
    const workflow = db.prepare('SELECT * FROM agent_workflows WHERE id = ? AND user_id = ? AND deleted_at IS NULL').get(workflowId, user.id);
    if (!workflow) return null;
    const source = db.prepare(`
        SELECT *
        FROM agent_workflow_versions
        WHERE workflow_id = ? AND version = ?
    `).get(workflow.id, Number.parseInt(version, 10));
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
    const workflow = db.prepare(`
        SELECT w.*, cv.version AS current_version
        FROM agent_workflows w
        LEFT JOIN agent_workflow_versions cv ON cv.id = w.current_version_id
        WHERE w.id = ? AND w.user_id = ? AND w.deleted_at IS NULL
    `).get(workflowId, user.id);
    if (!workflow) return null;
    const normalizeVersion = value => {
        if (String(value || '').trim() === 'current') return Number(workflow.current_version || 0);
        return Number.parseInt(value, 10);
    };
    const from = normalizeVersion(fromVersion);
    const to = normalizeVersion(toVersion);
    if (!from || !to) return null;
    const rows = db.prepare(`
        SELECT version, dag_spec, note, created_at
        FROM agent_workflow_versions
        WHERE workflow_id = ? AND version IN (?, ?)
    `).all(workflow.id, from, to);
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
    const workflow = db.prepare('SELECT * FROM agent_workflows WHERE id = ? AND user_id = ? AND deleted_at IS NULL').get(workflowId, user.id);
    if (!workflow) return null;
    const now = getBeijingTimestamp();
    db.prepare('UPDATE agent_workflows SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now, now, workflow.id);
    return workflow;
}

// 恢复已删除工作流（软撤销）
function restoreAgentWorkflow(workflowId, user) {
    const workflow = db.prepare(`
        SELECT * FROM agent_workflows
        WHERE id = ? AND user_id = ? AND deleted_at IS NOT NULL
          AND deleted_at > datetime('now', '+8 hours', '-30 days')
    `).get(workflowId, user.id);
    if (!workflow) return null;
    const now = getBeijingTimestamp();
    db.prepare('UPDATE agent_workflows SET deleted_at = NULL, updated_at = ? WHERE id = ?').run(now, workflow.id);
    return getAgentWorkflowForUser(workflow.id, user);
}

module.exports = {
    assertWorkflowHasConfiguredLlm,
    createAgentWorkflow,
    deleteAgentWorkflow,
    diffAgentWorkflowVersions,
    getAgentWorkflowForUser,
    listAgentWorkflowVersions,
    listAgentWorkflows,
    normalizeDagInputsPayload,
    normalizeDagRunInputs,
    publishAgentWorkflowVersion,
    resolveAgentWorkflowVersion,
    restoreAgentWorkflow,
    restoreAgentWorkflowVersion,
    updateAgentWorkflow
};
