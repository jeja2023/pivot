const { db } = require('../db');
const { getBeijingTimestamp } = require('../time');
const { assertWorkflowLlmNodesConfigured, normalizeDagRunInputs, resolveAgentWorkflowVersion } = require('./agent-workflows');
const { resolveAgentWorkflowDependencyBindings } = require('./agent-workflow-dependencies');
const { normalizeDagNodePolicy, resolveDagNodeInput, evaluateDagWhen, dagConditionSatisfied } = require('./agent-dag-utils');
const { listDagNodes, listSteps } = require('./agent-runs');
const { clampText, executeToolByName, findAgentToolByName } = require('./agent-tool-runtime');
const { inspectDagTopology, normalizeDagSpec, parseJsonObject } = require('./agent-validators');
const {
    normalizeJsonSchema,
    outputValueForContract,
    schemaHasRules,
    validateJsonSchemaDefinition,
    validateValueAgainstSchema
} = require('./agent-dag-contracts');

const DAG_PERSISTED_OUTPUT_MAX_CHARS = Math.max(
    120000,
    Math.min(Number.parseInt(process.env.AGENT_DAG_OUTPUT_MAX_CHARS || '8000000', 10) || 8000000, 20000000)
);

function preparePersistedDagOutput(value) {
    let text = '';
    let serialized = '';
    try {
        serialized = JSON.stringify(value);
        if (serialized === undefined) serialized = 'null';
        text = typeof value === 'string' ? value : serialized;
    } catch (error) {
        const fallback = clampText(value, DAG_PERSISTED_OUTPUT_MAX_CHARS);
        return { value: fallback, serialized: JSON.stringify(fallback) };
    }
    if (text.length <= DAG_PERSISTED_OUTPUT_MAX_CHARS) return { value, serialized };
    const payload = value?.structuredContent && typeof value.structuredContent === 'object'
        ? value.structuredContent
        : value;
    const rows = Array.isArray(payload?.rows) ? payload.rows : [];
    if (!rows.length) {
        const truncated = {
            __partial: true,
            originalChars: text.length,
            text: `${text.slice(0, DAG_PERSISTED_OUTPUT_MAX_CHARS)}\n...[truncated]`,
            warning: '节点完整输出超过持久化上限，恢复运行时只能使用截断预览。'
        };
        return { value: truncated, serialized: JSON.stringify(truncated) };
    }
    const keptRows = [];
    let used = 0;
    let oversizedRowCount = 0;
    for (const row of rows) {
        const rowText = JSON.stringify(row);
        if (rowText.length > DAG_PERSISTED_OUTPUT_MAX_CHARS - 2000) {
            oversizedRowCount += 1;
            continue;
        }
        if (used + rowText.length > DAG_PERSISTED_OUTPUT_MAX_CHARS - 2000) break;
        keptRows.push(row);
        used += rowText.length;
    }
    const truncated = {
        structuredContent: {
            ...payload,
            rows: keptRows,
            __partial: true,
            originalRowCount: rows.length,
            persistedRowCount: keptRows.length,
            oversizedRowCount
        },
        text: '节点输出过大，已按完整记录保留前 ' + keptRows.length + '/' + rows.length + ' 条。',
        warning: '恢复运行时只能使用已持久化的完整记录。'
    };
    return { value: truncated, serialized: JSON.stringify(truncated) };
}

function persistedDagOutput(value) {
    return preparePersistedDagOutput(value).value;
}

function compactPreparedDagOutput(value, serialized, max = 12000) {
    const text = typeof value === 'string' ? value : String(serialized || '');
    if (!text) return '';
    return text.length > max ? `${text.slice(0, max)}\n...[truncated]` : text;
}

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
    const completedNodes = nodes.filter(node => ['completed', 'continued_error'].includes(states.get(node.id)?.status));
    const dependencyIds = new Set(nodes.flatMap(node => Array.isArray(node.dependsOn) ? node.dependsOn : []));
    const terminalOutputs = completedNodes
        .filter(node => !dependencyIds.has(node.id))
        .map(node => ({ node, text: extractReadableDagOutput(states.get(node.id)?.output) }))
        .filter(item => item.text);
    if (terminalOutputs.length === 1) return terminalOutputs[0].text;
    if (terminalOutputs.length > 1) {
        return terminalOutputs
            .map(({ node, text }) => `## ${node.title || node.id}\n\n${text}`)
            .join('\n\n');
    }
    const reversedCompleted = completedNodes.slice().reverse();
    for (const node of reversedCompleted) {
        const text = extractReadableDagOutput(states.get(node.id)?.output);
        if (text) return text;
    }
    if (completedNodes.length) return `工作流执行完成，共 ${completedNodes.length} 个节点完成。`;
    return '';
}

function upsertDagNode(runId, node, patch = {}) {
    const nodeKey = String(patch.nodeKey || node.nodeKey || node.id || '').trim();
    const existing = db.prepare('SELECT id FROM agent_dag_nodes WHERE run_id = ? AND node_key = ?').get(runId, nodeKey);
    const now = getBeijingTimestamp();
    const row = {
        title: patch.title ?? node.title,
        toolName: patch.toolName ?? node.tool,
        input: patch.input ?? node.input ?? {},
        inputSchema: patch.inputSchema ?? node.inputSchema ?? {},
        outputSchema: patch.outputSchema ?? node.outputSchema ?? {},
        dependsOn: patch.dependsOn ?? node.dependsOn ?? [],
        condition: patch.condition ?? node.condition ?? 'success',
        status: patch.status ?? 'pending',
        output: patch.output ?? null,
        outputSerialized: patch.outputSerialized,
        errorMessage: patch.errorMessage ?? '',
        contractStatus: patch.contractStatus ?? 'unchecked',
        contractIssues: patch.contractIssues ?? [],
        attemptCount: patch.attemptCount ?? 0,
        durationMs: patch.durationMs ?? null,
        startedAt: patch.startedAt ?? null,
        completedAt: patch.completedAt ?? null
    };
    if (existing) {
        db.prepare(`
            UPDATE agent_dag_nodes
            SET title = ?, tool_name = ?, input = ?, input_schema = ?, output_schema = ?, depends_on = ?, condition = ?, status = ?,
                output = ?, error_message = ?, contract_status = ?, contract_issues = ?,
                attempt_count = ?, duration_ms = ?, started_at = ?, completed_at = ?
            WHERE id = ?
        `).run(
            row.title,
            row.toolName,
            JSON.stringify(row.input),
            JSON.stringify(row.inputSchema),
            JSON.stringify(row.outputSchema),
            JSON.stringify(row.dependsOn),
            row.condition,
            row.status,
            row.output === null ? null : (row.outputSerialized ?? JSON.stringify(row.output)),
            row.errorMessage,
            row.contractStatus,
            JSON.stringify(row.contractIssues),
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
            run_id, node_key, title, tool_name, input, input_schema, output_schema, depends_on, condition, status,
            output, error_message, contract_status, contract_issues, attempt_count, duration_ms, started_at, completed_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        runId,
        nodeKey,
        row.title,
        row.toolName,
        JSON.stringify(row.input),
        JSON.stringify(row.inputSchema),
        JSON.stringify(row.outputSchema),
        JSON.stringify(row.dependsOn),
        row.condition,
        row.status,
        row.output === null ? null : (row.outputSerialized ?? JSON.stringify(row.output)),
        row.errorMessage,
        row.contractStatus,
        JSON.stringify(row.contractIssues),
        row.attemptCount,
        row.durationMs,
        row.startedAt,
        row.completedAt,
        now
    );
    return info.lastInsertRowid;
}

async function executeDagNodeWithPolicy({ run, user, modelCfg, node, resolvedInput, toolList, deadline, policy, executionContext = {} }, deps) {
    const startedAt = Date.now();
    const startedAtText = getBeijingTimestamp();
    let lastError = null;
    let attempted = 0;
    const attempts = Math.max(1, Number(policy.retryLimit || 0) + 1);
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        attempted = attempt;
        deps.assertRunNotCancelled(run.id);
        try {
            const remainingRunMs = Math.max(deadline - Date.now(), 1);
            const nodeOwnsDeadline = policy.timeoutMs < remainingRunMs;
            const output = await deps.withTimeout(
                signal => executeToolByName(node.tool, resolvedInput, user, toolList, { run, modelCfg, node, ...executionContext, signal }),
                Math.min(policy.timeoutMs, Math.max(remainingRunMs, 1000)),
                `执行 DAG 节点：${node.title || node.id}`,
                {
                    signal: executionContext.signal || deps.signal || null,
                    timeoutCode: nodeOwnsDeadline ? 'AGENT_NODE_TIMEOUT' : 'AGENT_TIMEOUT'
                }
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
            if (['AGENT_APPROVAL_REQUIRED', 'AGENT_RUN_CANCELLED', 'AGENT_TIMEOUT'].includes(e.code)) throw e;
            lastError = e;
            if (e.code === 'AGENT_NODE_TIMEOUT') break;
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
        attempt: attempted || 1,
        startedAt,
        startedAtText,
        durationMs: Date.now() - startedAt
    };
}

function buildIncompleteDagAnswer(dagSpec, states) {
    const nodes = Array.isArray(dagSpec?.nodes) ? dagSpec.nodes : [];
    const outputNodes = nodes.filter(node => String(node.tool || '') === 'workflow.output');
    const dependencyIds = new Set(nodes.flatMap(node => Array.isArray(node.dependsOn) ? node.dependsOn : []));
    const expected = outputNodes.length
        ? outputNodes
        : nodes.filter(node => ['agent.llm', 'agent.content_review'].includes(String(node.tool || '')) && !dependencyIds.has(node.id));
    if (expected.length && expected.every(node => states.get(node.id)?.status === 'completed')) return '';
    const unfinished = expected.filter(node => !['completed', 'continued_error'].includes(states.get(node.id)?.status));
    if (!unfinished.length) return '';
    const failed = nodes.filter(node => ['error', 'continued_error'].includes(states.get(node.id)?.status));
    const lines = [
        '## 工作流交付未完成',
        '',
        '查询或前置处理可能已经成功，但预期的分析/输出节点没有完成，因此不能把行数摘要视为校对结果。',
        ''
    ];
    failed.forEach(node => lines.push('- 失败节点：' + (node.title || node.id) + '；原因：' + (states.get(node.id)?.error || '未知错误')));
    unfinished.filter(node => !failed.includes(node)).forEach(node => lines.push('- 未完成节点：' + (node.title || node.id) + '；状态：' + (states.get(node.id)?.status || 'pending')));
    return lines.join('\n');
}

async function executeSubworkflowDag({ input, run, user, modelCfg, toolList, deadline, deps, stack = [] }) {
    const workflowId = Number.parseInt(input.workflowId ?? input.workflow_id, 10);
    if (!workflowId) throw new Error('子工作流节点需要选择有效的工作流。');
    if (stack.includes(workflowId)) throw new Error(`检测到子工作流循环调用：${[...stack, workflowId].join(' -> ')}`);
    if (stack.length >= 3) throw new Error('子工作流最多允许嵌套 3 层。');
    const sourceWorkflow = resolveAgentWorkflowVersion(workflowId, user, input.version || 'published');
    if (!sourceWorkflow) throw new Error(`子工作流不存在或无权访问：${workflowId}`);
    const resolved = resolveAgentWorkflowDependencyBindings(sourceWorkflow, user);
    const dagSpec = normalizeDagSpec(resolved.dagSpec);
    const topology = inspectDagTopology(dagSpec);
    if (topology.blockers.length) throw new Error(`子工作流结构无效：${topology.blockers[0]}`);
    assertWorkflowLlmNodesConfigured(dagSpec);
    const dagInputs = normalizeDagRunInputs(input.inputs || {});
    const childRun = { ...run, goal: String(input.goal || run.goal || '') };
    const nodeMap = new Map(dagSpec.nodes.map(node => [node.id, node]));
    const states = new Map(dagSpec.nodes.map(node => [node.id, { status: 'pending' }]));
    const childStack = [...stack, workflowId];
    while ([...states.values()].some(state => state.status === 'pending')) {
        deps.assertRunNotCancelled(run.id);
        const ready = dagSpec.nodes.filter(node => states.get(node.id)?.status === 'pending'
            && node.dependsOn.every(dep => ['completed', 'continued_error', 'error', 'skipped'].includes(states.get(dep)?.status)));
        if (!ready.length) throw new Error(`子工作流“${resolved.workflow.name}”执行停滞。`);
        for (const node of ready) {
            const depStates = node.dependsOn.map(dep => states.get(dep)?.status);
            if (!dagConditionSatisfied(node.condition, depStates)) {
                states.set(node.id, { status: 'skipped' });
                continue;
            }
            const when = evaluateDagWhen(node.when, { goal: childRun.goal, inputs: dagInputs, states, nodeMap });
            if (when.skipped) {
                states.set(node.id, { status: 'skipped', skipReason: when.reason });
                continue;
            }
            const selectedTool = findAgentToolByName(node.tool, toolList);
            if (!selectedTool) throw new Error(`子工作流节点工具不可用：${node.tool || '-'}`);
            const resolvedInput = resolveDagNodeInput(node, { goal: childRun.goal, inputs: dagInputs, states, nodeMap });
            const approvalKey = `${node.tool}:subworkflow:${childStack.join('.')}:${node.id}`;
            let workflowApprovalResult = null;
            let workflowDelayResult = null;
            if (node.tool === 'workflow.approval') {
                workflowApprovalResult = await deps.waitForWorkflowApproval({
                    run,
                    user,
                    node,
                    input: resolvedInput,
                    key: approvalKey
                });
            } else if (node.tool === 'workflow.delay') {
                workflowDelayResult = await deps.waitForWorkflowDelay({
                    run,
                    node,
                    input: resolvedInput,
                    key: approvalKey
                });
            }
            if (node.tool !== 'workflow.approval' && deps.maybePauseForApproval(run, selectedTool, resolvedInput, approvalKey)) {
                const error = new Error('子工作流节点需要工具审批。');
                error.code = 'AGENT_APPROVAL_REQUIRED';
                throw error;
            }
            const policy = normalizeDagNodePolicy(node, childRun, deps.agentToolTimeoutMs);
            const executionContext = {
                dagInputs,
                workflowApprovalResult,
                workflowDelayResult,
                executeSubworkflow: childInput => executeSubworkflowDag({
                    input: childInput, run, user, modelCfg, toolList, deadline, deps, stack: childStack
                })
            };
            const result = await executeDagNodeWithPolicy({
                run: childRun, user, modelCfg, node, resolvedInput, toolList, deadline, policy, executionContext
            }, deps);
            if (result.ok) {
                states.set(node.id, { status: 'completed', input: resolvedInput, output: result.output, compactOutput: clampText(result.output, 12000) });
            } else if (policy.onError === 'continue') {
                states.set(node.id, { status: 'continued_error', input: resolvedInput, error: result.error.message, output: { error: result.error.message, continued: true } });
            } else if (policy.onError === 'stop') {
                throw result.error;
            } else {
                states.set(node.id, { status: 'error', input: resolvedInput, error: result.error.message });
            }
        }
    }
    const outputs = {};
    dagSpec.nodes.filter(node => node.tool === 'workflow.output').forEach(node => {
        const value = states.get(node.id)?.output;
        if (value?.name) {
            outputs[value.name] = value.presentation === 'table'
                ? { value: value.value, format: value.format, presentation: value.presentation, table: value.table, text: value.text }
                : value.presentation === 'file'
                    ? { value: value.value, format: value.format, presentation: value.presentation, file: value.file, text: value.text }
                    : value.value;
        }
    });
    const fallback = buildDagFallbackFinalAnswer(dagSpec, states);
    const outputNames = Object.keys(outputs);
    const output = outputNames.length === 1 ? outputs[outputNames[0]] : (outputNames.length ? outputs : fallback);
    return {
        workflowId,
        workflowName: resolved.workflow.name,
        version: resolved.version,
        output,
        outputs,
        text: extractReadableDagOutput(output) || fallback
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
    const topology = inspectDagTopology(dagSpec);
    if (topology.blockers.length) throw new Error(`DAG 拒绝执行：${topology.blockers[0]}`);
    assertWorkflowLlmNodesConfigured(dagSpec);

    const persistedDagNodes = new Map(listDagNodes(run.id).map(node => [node.node_key, node]));
    dagSpec.nodes.forEach(node => {
        const existing = persistedDagNodes.get(node.id);
        if (existing && ['completed', 'continued_error', 'skipped', 'waiting_approval'].includes(existing.status)) return;
        upsertDagNode(run.id, node, { status: 'pending' });
    });
    const nodeMap = new Map(dagSpec.nodes.map(node => [node.id, node]));
    const states = new Map(dagSpec.nodes.map(node => {
        const existing = persistedDagNodes.get(node.id);
        if (existing && ['completed', 'continued_error', 'skipped'].includes(existing.status)) {
            return [node.id, {
                status: existing.status,
                input: existing.input || {},
                output: existing.output,
                compactOutput: clampText(existing.output, 12000),
                attemptCount: existing.attempt_count || 0,
                reused: false
            }];
        }
        return [node.id, { status: 'pending' }];
    }));
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
    const rootWorkflowId = Number.parseInt(metadata.workflowId || metadata.workflow_id, 10);
    const subworkflowStack = rootWorkflowId ? [rootWorkflowId] : [];

    while ([...states.values()].some(state => state.status === 'pending')) {
        assertRunWithinBudget();
        deps.assertRunNotCancelled(run.id);
        const readyNodes = dagSpec.nodes.filter(node => {
            const state = states.get(node.id);
            if (state?.status !== 'pending') return false;
            return node.dependsOn.every(dep => ['completed', 'continued_error', 'error', 'skipped'].includes(states.get(dep)?.status));
        });
        if (!readyNodes.length) {
            throw new Error('DAG 执行已停滞：当前没有可运行的节点。');
        }

        const runnable = [];
        const stopErrors = [];
        readyNodes.forEach(node => {
            const depStates = node.dependsOn.map(dep => states.get(dep)?.status);
            // 第一道门禁：依赖状态是否满足 condition（success / failure / always）。
            if (!dagConditionSatisfied(node.condition, depStates)) {
                const reason = node.condition === 'failure'
                    ? 'dependency_not_failed'
                    : 'dependency_not_completed';
                states.set(node.id, { status: 'skipped', skipReason: reason });
                upsertDagNode(run.id, node, {
                    status: 'skipped',
                    output: { status: 'skipped', reason, condition: node.condition },
                    completedAt: getBeijingTimestamp()
                });
                deps.insertStep(run.id, stepIndex, {
                    type: 'dag',
                    nodeId: node.id,
                    title: `跳过 DAG 节点：${node.title || node.id}`,
                    toolName: node.tool,
                    input: node.input,
                    output: { status: 'skipped', reason, condition: node.condition, dependsOn: node.dependsOn }
                });
                stepIndex += 1;
                return;
            }
            // 第二道门禁：when 条件规则（Dify 风格的条件分支）。
            const whenResult = evaluateDagWhen(node.when, {
                goal: run.goal,
                inputs: dagInputs,
                states,
                nodeMap
            });
            if (whenResult.skipped) {
                states.set(node.id, { status: 'skipped', skipReason: 'when_not_matched', skipDetail: whenResult.reason });
                upsertDagNode(run.id, node, {
                    status: 'skipped',
                    output: {
                        status: 'skipped',
                        reason: 'when_not_matched',
                        when: {
                            source: whenResult.source,
                            operator: whenResult.operator,
                            operatorLabel: whenResult.operatorLabel,
                            expected: whenResult.expected,
                            actual: whenResult.actual
                        }
                    },
                    errorMessage: '',
                    completedAt: getBeijingTimestamp()
                });
                deps.insertStep(run.id, stepIndex, {
                    type: 'dag',
                    nodeId: node.id,
                    title: `条件不满足，跳过节点：${node.title || node.id}`,
                    toolName: node.tool,
                    input: node.input,
                    output: { status: 'skipped', reason: whenResult.reason, when: whenResult }
                });
                stepIndex += 1;
                return;
            }
            runnable.push(node);
        });

        const batchController = new AbortController();
        const batchSignal = (deps.signal && typeof AbortSignal.any === 'function')
            ? AbortSignal.any([deps.signal, batchController.signal])
            : batchController.signal;
        const batchResults = await Promise.allSettled(runnable.slice(0, deps.dagNodeConcurrency).map(async node => {
            batchSignal.throwIfAborted();
            const nodeStepIndex = stepIndex;
            stepIndex += 1;
            const selectedTool = findAgentToolByName(node.tool, toolList);
            const resolvedInput = resolveDagNodeInput(node, {
                goal: run.goal,
                inputs: dagInputs,
                states,
                nodeMap
            });
            const explicitInputSchema = normalizeJsonSchema(node.inputSchema || node.input_schema || {});
            const inputSchema = schemaHasRules(explicitInputSchema)
                ? explicitInputSchema
                : normalizeJsonSchema(selectedTool?.input_schema || selectedTool?.inputSchema || selectedTool?.parameters || {});
            const outputSchema = normalizeJsonSchema(node.outputSchema || node.output_schema || {});
            const inputContractIssues = [];
            validateJsonSchemaDefinition(inputSchema, `${node.title || node.id} 输入契约`, inputContractIssues);
            validateValueAgainstSchema(resolvedInput, inputSchema, {}, `${node.title || node.id} 输入`, inputContractIssues);
            const outputDefinitionIssues = validateJsonSchemaDefinition(outputSchema, `${node.title || node.id} 输出契约`, []);
            const policy = normalizeDagNodePolicy(node, run, deps.agentToolTimeoutMs);
            const startedAtText = getBeijingTimestamp();
            states.set(node.id, { status: 'running', input: resolvedInput });
            upsertDagNode(run.id, node, {
                status: 'running',
                input: resolvedInput,
                inputSchema,
                outputSchema,
                contractStatus: 'validating',
                contractIssues: [],
                startedAt: startedAtText
            });
            const delegatedAgent = node.tool === 'agent.delegate';
            const handoffNode = node.tool === 'agent.handoff';
            const nodeSpanId = deps.startAgentTraceSpan?.(run.id, {
                type: delegatedAgent ? 'agent' : (handoffNode ? 'handoff' : 'dag_node'),
                name: node.title || node.id,
                input: resolvedInput,
                details: {
                    nodeId: node.id,
                    toolName: node.tool,
                    retryLimit: policy.retryLimit,
                    agentName: delegatedAgent ? resolvedInput.agentName : undefined,
                    role: delegatedAgent ? resolvedInput.role : undefined,
                    handoffTo: delegatedAgent ? 'Supervisor' : (handoffNode ? resolvedInput.toAgent : undefined)
                }
            });
            try {
                if (inputContractIssues.length || outputDefinitionIssues.length) {
                    const issues = [...inputContractIssues, ...outputDefinitionIssues];
                    const contractError = new Error(`节点契约校验失败：${issues[0]}`);
                    contractError.code = 'AGENT_DAG_CONTRACT_INVALID';
                    contractError.contractIssues = issues;
                    throw contractError;
                }
                if (!selectedTool) throw new Error(`节点工具不可用或无权访问：${node.tool || '-'}`);
                let workflowApprovalResult = null;
                let workflowDelayResult = null;
                if (node.tool === 'workflow.approval') {
                    workflowApprovalResult = await deps.waitForWorkflowApproval({
                        run,
                        user,
                        node,
                        input: resolvedInput,
                        key: `${node.tool}:${node.id}`
                    });
                } else if (node.tool === 'workflow.delay') {
                    workflowDelayResult = await deps.waitForWorkflowDelay({
                        run,
                        node,
                        input: resolvedInput,
                        key: `${node.tool}:${node.id}`
                    });
                }
                if (node.tool !== 'workflow.approval' && deps.maybePauseForApproval(run, selectedTool, resolvedInput, `${node.tool}:${node.id}`)) {
                    const approvalError = new Error('DAG 节点需要工具审批。');
                    approvalError.code = 'AGENT_APPROVAL_REQUIRED';
                    throw approvalError;
                }
                const executionContext = {
                    dagInputs,
                    signal: batchSignal,
                    workflowApprovalResult,
                    workflowDelayResult,
                    executeSubworkflow: childInput => executeSubworkflowDag({
                        input: childInput, run, user, modelCfg, toolList, deadline, deps, stack: subworkflowStack
                    })
                };
                const result = await executeDagNodeWithPolicy({ run, user, modelCfg, node, resolvedInput, toolList, deadline, policy, executionContext }, deps);
                deps.assertRunNotCancelled(run.id);
                if (!result.ok) {
                    result.error.dagAttempt = result.attempt;
                    result.error.dagDurationMs = result.durationMs;
                    throw result.error;
                }
                const { output } = result;
                const outputContractIssues = schemaHasRules(outputSchema)
                    ? validateValueAgainstSchema(outputValueForContract(output, node), outputSchema, {}, `${node.title || node.id} 输出`, [])
                    : [];
                if (outputContractIssues.length) {
                    const contractError = new Error(`节点输出不符合契约：${outputContractIssues[0]}`);
                    contractError.code = 'AGENT_DAG_OUTPUT_CONTRACT';
                    contractError.contractIssues = outputContractIssues;
                    contractError.dagAttempt = result.attempt;
                    contractError.dagDurationMs = result.durationMs;
                    throw contractError;
                }
                const preparedOutput = preparePersistedDagOutput(output);
                const compactOutput = compactPreparedDagOutput(output, preparedOutput.serialized, 12000);
                states.set(node.id, { status: 'completed', input: resolvedInput, output, compactOutput, attemptCount: result.attempt });
                upsertDagNode(run.id, node, {
                    status: 'completed',
                    input: resolvedInput,
                    output: preparedOutput.value,
                    outputSerialized: preparedOutput.serialized,
                    contractStatus: 'valid',
                    contractIssues: [],
                    attemptCount: result.attempt,
                    durationMs: result.durationMs,
                    completedAt: getBeijingTimestamp()
                });
                observations.push({ node: node.id, title: node.title, tool: node.tool, input: resolvedInput, output: compactOutput, attempts: result.attempt });
                deps.insertStep(run.id, nodeStepIndex, {
                    type: 'dag',
                    nodeId: node.id,
                    title: `完成 DAG 节点：${node.title || node.id}`,
                    toolName: node.tool,
                    input: resolvedInput,
                    output: compactOutput,
                    durationMs: result.durationMs
                });
                deps.finishAgentTraceSpan?.(nodeSpanId, {
                    output: { nodeId: node.id, result: compactOutput },
                    details: { nodeId: node.id, toolName: node.tool, contractStatus: 'valid', attempts: result.attempt },
                    durationMs: result.durationMs
                });
            } catch (e) {
                if (e.code === 'AGENT_APPROVAL_REQUIRED') {
                    if (!batchController.signal.aborted) batchController.abort(e);
                    deps.finishAgentTraceSpan?.(nodeSpanId, {
                        status: 'waiting',
                        details: { nodeId: node.id, toolName: node.tool, reason: 'approval_required' },
                        errorMessage: e.message
                    });
                    throw e;
                }
                if (['AGENT_RUN_CANCELLED', 'AGENT_TIMEOUT'].includes(e.code)) throw e;
                const attemptCount = Number(e.dagAttempt || Math.max(1, Number(policy.retryLimit || 0) + 1));
                const durationMs = Number(e.dagDurationMs || 0);
                const timedOut = e.code === 'AGENT_NODE_TIMEOUT';
                const status = policy.onError === 'continue' ? 'continued_error' : 'error';
                const failureOutput = {
                    error: e.message,
                    code: e.code || 'AGENT_DAG_NODE_ERROR',
                    timedOut,
                    onError: policy.onError,
                    ...(policy.onError === 'continue' ? { continued: true } : {})
                };
                states.set(node.id, {
                    status,
                    input: resolvedInput,
                    error: e.message,
                    output: policy.onError === 'continue' ? failureOutput : undefined,
                    attemptCount,
                    onError: policy.onError
                });
                upsertDagNode(run.id, node, {
                    status,
                    input: resolvedInput,
                    output: failureOutput,
                    errorMessage: e.message,
                    contractStatus: timedOut ? 'timeout' : (e.contractIssues?.length ? 'invalid' : 'error'),
                    contractIssues: e.contractIssues || [],
                    attemptCount,
                    durationMs,
                    completedAt: getBeijingTimestamp()
                });
                observations.push({ node: node.id, title: node.title, tool: node.tool, input: resolvedInput, error: e.message, code: e.code || '', timedOut, onError: policy.onError, attempts: attemptCount });
                deps.insertStep(run.id, nodeStepIndex, {
                    type: 'dag',
                    nodeId: node.id,
                    title: timedOut
                        ? `DAG 节点执行超时：${node.title || node.id}`
                        : (policy.onError === 'continue' ? `DAG 节点失败后继续：${node.title || node.id}` : `DAG 节点执行失败：${node.title || node.id}`),
                    toolName: node.tool,
                    input: resolvedInput,
                    output: failureOutput,
                    errorMessage: e.message,
                    status: 'error',
                    durationMs
                });
                deps.finishAgentTraceSpan?.(nodeSpanId, {
                    status: 'error',
                    output: { nodeId: node.id, code: e.code || '', timedOut, onError: policy.onError },
                    details: { nodeId: node.id, toolName: node.tool, timedOut, contractIssues: e.contractIssues || [] },
                    errorMessage: e.message,
                    durationMs
                });
                if (policy.onError === 'stop') stopErrors.push(e);
            } finally {
                deps.updateRun(run.id, { last_heartbeat_at: getBeijingTimestamp(), updated_at: getBeijingTimestamp() });
            }
        }));
        const rejected = batchResults.find(result => result.status === 'rejected');
        if (rejected) throw rejected.reason;
        if (stopErrors.length) throw stopErrors[0];
    }

    const failedNodes = dagSpec.nodes.filter(node => ['error', 'continued_error'].includes(states.get(node.id)?.status));
    const incompleteResultNodes = dagSpec.nodes.filter(node => (
        String(node.tool || '') === 'agent.content_review'
        && states.get(node.id)?.status === 'completed'
        && states.get(node.id)?.output?.reviewComplete === false
    ));
    const skippedNodes = dagSpec.nodes.filter(node => states.get(node.id)?.status === 'skipped');
    if (failedNodes.length || skippedNodes.length || incompleteResultNodes.length) {
        deps.insertStep(run.id, stepIndex, {
            type: 'control',
            title: failedNodes.length
                ? 'DAG 完成，但存在失败节点'
                : (incompleteResultNodes.length ? 'DAG 完成，但存在未完整处理节点' : 'DAG 完成，但存在跳过节点'),
            output: {
                failedNodes: failedNodes.map(node => ({
                    id: node.id,
                    title: node.title,
                    error: states.get(node.id)?.error || ''
                })),
                skippedNodes: skippedNodes.map(node => ({ id: node.id, title: node.title })),
                incompleteResultNodes: incompleteResultNodes.map(node => ({ id: node.id, title: node.title }))
            },
            status: failedNodes.length || incompleteResultNodes.length ? 'error' : 'success'
        });
    }

    const answer = buildIncompleteDagAnswer(dagSpec, states)
        || buildDagFallbackFinalAnswer(dagSpec, states)
        || `工作流执行完成，共 ${dagSpec.nodes.length} 个节点。`;
    deps.updateRun(run.id, {
        status: failedNodes.length || incompleteResultNodes.length ? 'completed_with_errors' : 'completed',
        final_answer: answer,
        error_message: failedNodes.length
            ? `DAG 失败节点数：${failedNodes.length}`
            : (incompleteResultNodes.length ? `DAG 未完整处理节点数：${incompleteResultNodes.length}` : ''),
        completed_at: getBeijingTimestamp(),
        last_heartbeat_at: getBeijingTimestamp(),
        updated_at: getBeijingTimestamp()
    });
    deps.createAgentNotification(
        user.id,
        run.id,
        failedNodes.length || incompleteResultNodes.length ? 'warning' : 'completed',
        failedNodes.length || incompleteResultNodes.length ? 'DAG 运行已完成，但存在未完成结果' : 'DAG 运行已完成',
        deps.getAgentRunTitle(run)
    );
}

module.exports = {
    buildDagFallbackFinalAnswer,
    buildIncompleteDagAnswer,
    executeDagNodeWithPolicy,
    extractReadableDagOutput,
    persistedDagOutput,
    runAgentDag,
    upsertDagNode
};
