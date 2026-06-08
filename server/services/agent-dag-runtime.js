const { db } = require('../db');
const { getBeijingTimestamp } = require('../time');
const { assertWorkflowHasConfiguredLlm, normalizeDagRunInputs } = require('./agent-workflows');
const { normalizeDagNodePolicy, resolveDagNodeInput } = require('./agent-dag-utils');
const { listSteps } = require('./agent-runs');
const { clampText, executeToolByName, findAgentToolByName } = require('./agent-tool-runtime');
const { normalizeDagSpec, parseJsonObject } = require('./agent-validators');

function parseMaybeJsonPayload(value) {
    if (!value) return value;
    if (typeof value === 'object') return value;
    if (typeof value !== 'string') return value;
    const text = value.trim();
    if (!text) return '';
    const parsed = parseJsonObject(text);
    return parsed || text;
}

function firstReadableString(...values) {
    return values
        .map(value => String(value || '').trim())
        .find(Boolean) || '';
}

function extractTextFromContentArray(content) {
    if (!Array.isArray(content)) return '';
    return content
        .map(item => {
            if (typeof item === 'string') return item;
            if (!item || typeof item !== 'object') return '';
            return firstReadableString(item.text, item.content, item.markdown);
        })
        .filter(Boolean)
        .join('\n')
        .trim();
}

function summarizeStructuredDagOutput(payload) {
    if (!payload || typeof payload !== 'object') return '';
    const structured = payload.structuredContent && typeof payload.structuredContent === 'object'
        ? payload.structuredContent
        : payload;
    if (!structured || typeof structured !== 'object') return '';
    const type = String(structured.type || '').trim();
    const markdown = String(structured.markdown || '').trim();
    if (markdown && ['pivot_table', 'pivot_report', 'format_markdown_table'].includes(type)) return markdown;
    if (type === 'pivot_chart') {
        const title = String(structured.title || '').trim();
        const points = Math.max(
            Array.isArray(structured.labels) ? structured.labels.length : 0,
            ...(Array.isArray(structured.series)
                ? structured.series.map(item => Array.isArray(item?.data) ? item.data.length : 0)
                : [0])
        );
        return `已生成图表${title ? `：${title}` : ''}${points ? `，包含 ${points} 个数据点` : ''}。`;
    }
    const rows = Array.isArray(structured.rows)
        ? structured.rows
        : Array.isArray(structured.data)
            ? structured.data
            : Array.isArray(structured.items)
                ? structured.items
                : [];
    if (rows.length) return `查询完成，返回 ${rows.length} 行数据。`;
    return '';
}

function extractReadableDagOutput(output) {
    const payload = parseMaybeJsonPayload(output);
    if (!payload) return '';
    if (typeof payload === 'string') return payload.trim();
    if (typeof payload !== 'object') return String(payload || '').trim();
    const contentText = extractTextFromContentArray(payload.content);
    return firstReadableString(
        typeof payload.content === 'string' ? payload.content : '',
        payload.text,
        payload.markdown,
        payload.answer,
        payload.message,
        payload.summary,
        summarizeStructuredDagOutput(payload),
        contentText
    );
}

function buildDagFallbackFinalAnswer(dagSpec, states) {
    const nodes = Array.isArray(dagSpec?.nodes) ? dagSpec.nodes : [];
    const completedNodes = nodes.filter(node => states.get(node.id)?.status === 'completed');
    const reversedCompleted = completedNodes.slice().reverse();
    const llmNode = reversedCompleted.find(node => String(node.tool || '').trim() === 'agent.llm');
    const llmText = llmNode ? extractReadableDagOutput(states.get(llmNode.id)?.output) : '';
    if (llmText) return llmText;
    for (const node of reversedCompleted) {
        const text = extractReadableDagOutput(states.get(node.id)?.output);
        if (text) return text;
    }
    if (completedNodes.length) return `工作流执行完成，共 ${completedNodes.length} 个节点完成。`;
    return '';
}

function upsertDagNode(runId, node, patch = {}) {
    const existing = db.prepare('SELECT id FROM agent_dag_nodes WHERE run_id = ? AND node_key = ?').get(runId, node.id);
    const now = getBeijingTimestamp();
    const row = {
        title: patch.title ?? node.title,
        toolName: patch.toolName ?? node.tool,
        input: patch.input ?? node.input ?? {},
        dependsOn: patch.dependsOn ?? node.dependsOn ?? [],
        condition: patch.condition ?? node.condition ?? 'success',
        status: patch.status ?? 'pending',
        output: patch.output ?? null,
        errorMessage: patch.errorMessage ?? '',
        attemptCount: patch.attemptCount ?? 0,
        durationMs: patch.durationMs ?? null,
        startedAt: patch.startedAt ?? null,
        completedAt: patch.completedAt ?? null
    };
    if (existing) {
        db.prepare(`
            UPDATE agent_dag_nodes
            SET title = ?, tool_name = ?, input = ?, depends_on = ?, condition = ?, status = ?,
                output = ?, error_message = ?, attempt_count = ?, duration_ms = ?, started_at = ?, completed_at = ?
            WHERE id = ?
        `).run(
            row.title,
            row.toolName,
            JSON.stringify(row.input),
            JSON.stringify(row.dependsOn),
            row.condition,
            row.status,
            row.output === null ? null : JSON.stringify(row.output),
            row.errorMessage,
            row.attemptCount,
            row.durationMs,
            row.startedAt,
            row.completedAt,
            existing.id
        );
        return existing.id;
    }
    const info = db.prepare(`
        INSERT INTO agent_dag_nodes (
            run_id, node_key, title, tool_name, input, depends_on, condition, status,
            output, error_message, attempt_count, duration_ms, started_at, completed_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        runId,
        node.id,
        row.title,
        row.toolName,
        JSON.stringify(row.input),
        JSON.stringify(row.dependsOn),
        row.condition,
        row.status,
        row.output === null ? null : JSON.stringify(row.output),
        row.errorMessage,
        row.attemptCount,
        row.durationMs,
        row.startedAt,
        row.completedAt,
        now
    );
    return info.lastInsertRowid;
}

async function executeDagNodeWithPolicy({ run, user, modelCfg, node, resolvedInput, toolList, deadline, policy }, deps) {
    const startedAt = Date.now();
    const startedAtText = getBeijingTimestamp();
    let lastError = null;
    const attempts = Math.max(1, Number(policy.retryLimit || 0) + 1);
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        deps.assertRunNotCancelled(run.id);
        try {
            const output = await deps.withTimeout(
                executeToolByName(node.tool, resolvedInput, user, toolList, { run, modelCfg }),
                Math.min(policy.timeoutMs, Math.max(deadline - Date.now(), 1000)),
                `执行 DAG 节点：${node.title || node.id}`
            );
            return {
                ok: true,
                output,
                attempt,
                startedAt,
                startedAtText,
                durationMs: Date.now() - startedAt
            };
        } catch (e) {
            lastError = e;
            deps.insertStep(run.id, listSteps(run.id).length + 1, {
                type: 'dag',
                title: `DAG 节点重试：${node.title || node.id}（${attempt}/${attempts}）`,
                toolName: node.tool,
                input: resolvedInput,
                output: { error: e.message, attempt, attempts, retrying: attempt < attempts },
                errorMessage: e.message,
                status: attempt < attempts ? 'success' : 'error',
                durationMs: Date.now() - startedAt
            });
            if (attempt >= attempts) break;
        }
    }
    return {
        ok: false,
        error: lastError || new Error('DAG 节点执行失败，但没有返回错误信息。'),
        attempt: attempts,
        startedAt,
        startedAtText,
        durationMs: Date.now() - startedAt
    };
}

async function runAgentDag({ run, user, modelCfg, toolList, deadline, assertRunWithinBudget }, deps) {
    const metadata = deps.getRunMetadata(run);
    const dagSpec = normalizeDagSpec(metadata.dagSpec || metadata.dag || {});
    const dagInputs = normalizeDagRunInputs(metadata.dagInputs || metadata.inputs || {});
    const reusedDagNodes = metadata.reusedDagNodes && typeof metadata.reusedDagNodes === 'object' ? metadata.reusedDagNodes : {};
    if (!dagSpec.nodes.length) {
        throw new Error('DAG 模式至少需要一个有效节点。');
    }
    assertWorkflowHasConfiguredLlm(dagSpec);

    dagSpec.nodes.forEach(node => upsertDagNode(run.id, node, { status: 'pending' }));
    const nodeMap = new Map(dagSpec.nodes.map(node => [node.id, node]));
    const states = new Map(dagSpec.nodes.map(node => [node.id, { status: 'pending' }]));
    Object.entries(reusedDagNodes).forEach(([nodeId, state]) => {
        states.set(nodeId, {
            status: state?.status || 'completed',
            input: state?.input || {},
            output: state?.output,
            compactOutput: clampText(state?.output, 12000),
            reused: true
        });
    });
    const observations = [];
    let stepIndex = listSteps(run.id).length + 1;

    while ([...states.values()].some(state => state.status === 'pending')) {
        assertRunWithinBudget();
        deps.assertRunNotCancelled(run.id);
        const readyNodes = dagSpec.nodes.filter(node => {
            const state = states.get(node.id);
            if (state?.status !== 'pending') return false;
            return node.dependsOn.every(dep => ['completed', 'error', 'skipped'].includes(states.get(dep)?.status));
        });
        if (!readyNodes.length) {
            throw new Error('DAG 执行已停滞：当前没有可运行的节点。');
        }

        const runnable = [];
        const stopErrors = [];
        readyNodes.forEach(node => {
            const depStates = node.dependsOn.map(dep => states.get(dep)?.status);
            if (node.condition !== 'always' && depStates.some(status => status !== 'completed')) {
                states.set(node.id, { status: 'skipped' });
                upsertDagNode(run.id, node, {
                    status: 'skipped',
                    output: { status: 'skipped', reason: 'dependency_not_completed' },
                    completedAt: getBeijingTimestamp()
                });
                deps.insertStep(run.id, stepIndex, {
                    type: 'dag',
                    title: `跳过 DAG 节点：${node.title || node.id}`,
                    toolName: node.tool,
                    input: node.input,
                    output: { status: 'skipped', dependsOn: node.dependsOn }
                });
                stepIndex += 1;
            } else {
                runnable.push(node);
            }
        });

        await Promise.all(runnable.slice(0, deps.dagNodeConcurrency).map(async node => {
            const selectedTool = findAgentToolByName(node.tool, toolList);
            const resolvedInput = resolveDagNodeInput(node, {
                goal: run.goal,
                inputs: dagInputs,
                states,
                nodeMap
            });
            if (deps.maybePauseForApproval(run, selectedTool, resolvedInput)) {
                const err = new Error('DAG 节点需要工具审批。');
                err.code = 'AGENT_APPROVAL_REQUIRED';
                throw err;
            }
            const policy = normalizeDagNodePolicy(node, run, deps.agentToolTimeoutMs);
            const startedAtText = getBeijingTimestamp();
            states.set(node.id, { status: 'running', input: resolvedInput });
            upsertDagNode(run.id, node, { status: 'running', input: resolvedInput, startedAt: startedAtText });
            try {
                const result = await executeDagNodeWithPolicy({ run, user, modelCfg, node, resolvedInput, toolList, deadline, policy }, deps);
                deps.assertRunNotCancelled(run.id);
                if (!result.ok) {
                    result.error.dagAttempt = result.attempt;
                    result.error.dagDurationMs = result.durationMs;
                    throw result.error;
                }
                const { output } = result;
                const compactOutput = clampText(output, 12000);
                states.set(node.id, { status: 'completed', input: resolvedInput, output, compactOutput, attemptCount: result.attempt });
                upsertDagNode(run.id, node, {
                    status: 'completed',
                    input: resolvedInput,
                    output: compactOutput,
                    attemptCount: result.attempt,
                    durationMs: result.durationMs,
                    completedAt: getBeijingTimestamp()
                });
                observations.push({ node: node.id, title: node.title, tool: node.tool, input: resolvedInput, output: compactOutput, attempts: result.attempt });
                deps.insertStep(run.id, stepIndex, {
                    type: 'dag',
                    title: `完成 DAG 节点：${node.title || node.id}`,
                    toolName: node.tool,
                    input: resolvedInput,
                    output: compactOutput,
                    durationMs: result.durationMs
                });
            } catch (e) {
                const attemptCount = Number(e.dagAttempt || Math.max(1, Number(policy.retryLimit || 0) + 1));
                const durationMs = Number(e.dagDurationMs || 0);
                const status = policy.onError === 'continue' ? 'completed' : 'error';
                states.set(node.id, {
                    status,
                    input: resolvedInput,
                    error: e.message,
                    output: policy.onError === 'continue' ? { error: e.message, continued: true } : undefined,
                    attemptCount,
                    onError: policy.onError
                });
                upsertDagNode(run.id, node, {
                    status,
                    input: resolvedInput,
                    output: { error: e.message, onError: policy.onError },
                    errorMessage: e.message,
                    attemptCount,
                    durationMs,
                    completedAt: getBeijingTimestamp()
                });
                observations.push({ node: node.id, title: node.title, tool: node.tool, input: resolvedInput, error: e.message, onError: policy.onError, attempts: attemptCount });
                deps.insertStep(run.id, stepIndex, {
                    type: 'dag',
                    title: policy.onError === 'continue' ? `DAG 节点失败后继续：${node.title || node.id}` : `DAG 节点执行失败：${node.title || node.id}`,
                    toolName: node.tool,
                    input: resolvedInput,
                    output: { error: e.message, onError: policy.onError },
                    errorMessage: e.message,
                    status: policy.onError === 'continue' ? 'success' : 'error',
                    durationMs
                });
                if (policy.onError === 'stop') stopErrors.push(e);
            } finally {
                stepIndex += 1;
                deps.updateRun(run.id, { last_heartbeat_at: getBeijingTimestamp(), updated_at: getBeijingTimestamp() });
            }
        }));
        if (stopErrors.length) throw stopErrors[0];
    }

    const failedNodes = dagSpec.nodes.filter(node => states.get(node.id)?.status === 'error');
    const skippedNodes = dagSpec.nodes.filter(node => states.get(node.id)?.status === 'skipped');
    if (failedNodes.length || skippedNodes.length) {
        deps.insertStep(run.id, stepIndex, {
            type: 'control',
            title: failedNodes.length ? 'DAG 完成，但存在失败节点' : 'DAG 完成，但存在跳过节点',
            output: {
                failedNodes: failedNodes.map(node => ({
                    id: node.id,
                    title: node.title,
                    error: states.get(node.id)?.error || ''
                })),
                skippedNodes: skippedNodes.map(node => ({ id: node.id, title: node.title }))
            },
            status: failedNodes.length ? 'error' : 'success'
        });
    }

    const fallbackAnswer = buildDagFallbackFinalAnswer(dagSpec, states);
    let answer = '';
    try {
        const synthesizedAnswer = await deps.withTimeout(
            deps.synthesizeFinalAnswer(modelCfg, run.goal, observations, user, run.id),
            Math.min(180000, Math.max(deadline - Date.now(), 1000)),
            'DAG 最终总结'
        );
        answer = deps.isMissingFinalAnswer(synthesizedAnswer) && fallbackAnswer
            ? fallbackAnswer
            : synthesizedAnswer;
    } catch (summaryErr) {
        if (!fallbackAnswer) throw summaryErr;
        answer = fallbackAnswer;
        deps.insertStep(run.id, stepIndex + 1, {
            type: 'control',
            title: 'DAG 最终总结兜底',
            output: { warning: summaryErr.message, fallback: 'dag_node_output' }
        });
    }
    deps.updateRun(run.id, {
        status: 'completed',
        final_answer: answer,
        error_message: failedNodes.length ? `DAG 失败节点数：${failedNodes.length}` : '',
        completed_at: getBeijingTimestamp(),
        last_heartbeat_at: getBeijingTimestamp(),
        updated_at: getBeijingTimestamp()
    });
    deps.createAgentNotification(
        user.id,
        run.id,
        failedNodes.length ? 'warning' : 'completed',
        failedNodes.length ? 'DAG 运行已完成，但存在错误' : 'DAG 运行已完成',
        deps.getAgentRunTitle(run)
    );
}

module.exports = {
    buildDagFallbackFinalAnswer,
    executeDagNodeWithPolicy,
    extractReadableDagOutput,
    runAgentDag,
    upsertDagNode
};
