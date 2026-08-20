const {
    ACTIVE_STATUSES,
    normalizeMaxSteps
} = require('./agent-validators');
const { isSuperAdmin } = require('../permissions');
const { getAgentTraceForUser } = require('./agent-traces');
const { summarizeAgentCheckpoints } = require('./agent-checkpoints');
const runRepository = require('../repositories/agent-runs');

async function getRunForUser(runId, user, options = {}) {
    return await runRepository.getRunForUser(runId, user?.id, {
        includeDeleted: Boolean(options.includeDeleted)
    });
}

async function listRuns(user, options = {}) {
    return await runRepository.listRuns(user?.id, options);
}

async function listDeletedRunsForAdmin(user, limit = 100) {
    if (!isSuperAdmin(user)) {
        const err = new Error('仅 admin 权限层级可查看智能体任务删除审计。');
        err.status = 403;
        throw err;
    }
    return await runRepository.listDeletedRunsForAdmin(limit);
}

async function listSteps(runId) {
    return await runRepository.listSteps(runId);
}

function safeWorkflowNodeId(value, fallback = 'node') {
    const normalized = String(value || fallback)
        .trim()
        .toLowerCase()
        .replace(/[^\w-]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 48);
    return normalized || fallback;
}

function uniqueWorkflowNodeId(used, value, fallback) {
    const base = safeWorkflowNodeId(value, fallback);
    let candidate = base;
    let index = 2;
    while (used.has(candidate)) {
        candidate = `${base}_${index}`;
        index += 1;
    }
    used.add(candidate);
    return candidate;
}

function normalizeWorkflowDraftInput(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
    try {
        return JSON.parse(JSON.stringify(input));
    } catch (e) {
        return {};
    }
}

function buildWorkflowDraftLlmPrompt(run, toolNodes) {
    const referencedOutputs = toolNodes
        .map(node => {
            const reference = isDatabaseRecordQueryTool(node.tool)
                ? `{{nodes.${node.id}.output.structuredContent}}`
                : `{{nodes.${node.id}.output}}`;
            return `- ${node.title}：${reference}`;
        })
        .join('\n');
    const upstreamText = referencedOutputs || '- 没有可复用工具节点，请直接围绕原始任务目标形成结果。';
    const originalGoal = String(run?.goal || '').trim().slice(0, 12000);
    return [
        '请基于自由任务目标和上游节点输出，整理为可交付的中文结果。',
        '',
        '原始任务目标：' + (originalGoal || '未提供'),
        '',
        '上游节点输出：',
        upstreamText,
        '',
        '输出要求：',
        '1. 先给结论，再列依据和下一步建议。',
        '2. 明确说明哪些内容来自工具结果，哪些是你的分析。',
        '3. 如果上游结果不足，请指出需要补充的资料或能力。'
    ].join('\n');
}

function isContentReviewGoal(goal) {
    return /(校对|纠错|错别字|病句|文字检查|内容审核|新闻审核|标题审核)/i.test(String(goal || ''));
}

function isDatabaseRecordQueryTool(name) {
    return /(?:^|\.)db\.(?:run_readonly_query|sample_collection|aggregate)$/i.test(String(name || ''));
}

function contentReviewOutputSchema() {
    return {
        type: 'object',
        required: ['type', 'status', 'reviewComplete', 'stats', 'records', 'text'],
        properties: {
            type: { type: 'string' },
            status: { type: 'string', enum: ['completed', 'incomplete'] },
            reviewComplete: { type: 'boolean' },
            stats: {
                type: 'object',
                properties: {
                    sourceRowCount: { type: 'integer' }, processedRecords: { type: 'integer' }, skippedRecords: { type: 'integer' },
                    completedRecords: { type: 'integer' }, passedRecords: { type: 'integer' }, issueRecords: { type: 'integer' },
                    incompleteRecords: { type: 'integer' }, titleIssues: { type: 'integer' }, contentIssues: { type: 'integer' },
                    originalChars: { type: 'integer' }, cleanChars: { type: 'integer' }, modelCallCount: { type: 'integer' },
                    chunkTokens: { type: 'integer' }, overlapTokens: { type: 'integer' }, upstreamPartial: { type: 'boolean' },
                    oversizedRowCount: { type: 'integer' }, inputTruncated: { type: 'boolean' }
                }
            },
            records: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        recordId: {}, title: { type: 'string' }, status: { type: 'string', enum: ['passed', 'issues_found', 'incomplete'] },
                        reviewComplete: { type: 'boolean' }, titleIssueCount: { type: 'integer' }, contentIssueCount: { type: 'integer' },
                        chunkCount: { type: 'integer' }, originalChars: { type: 'integer' }, cleanChars: { type: 'integer' },
                        removedChars: { type: 'integer' }, error: { type: 'string' }, contextAdjusted: { type: 'boolean' },
                        issues: {
                            type: 'array', items: {
                                type: 'object', properties: {
                                    field: { type: 'string' }, category: { type: 'string' }, original: { type: 'string' },
                                    suggestion: { type: 'string' }, context: { type: 'string' }, reason: { type: 'string' },
                                    confidence: { type: 'string' }, chunkIndex: { type: 'integer' }
                                }
                            }
                        }
                    }
                }
            },
            artifact: { type: ['object', 'null'], properties: { id: {}, title: { type: 'string' }, type: { type: 'string' } } },
            warnings: { type: 'array', items: { type: 'string' } },
            text: { type: 'string' },
            markdown: { type: 'string' }
        }
    };
}

function buildWorkflowDraftFromRun(run, steps = []) {
    const used = new Set();
    const toolSteps = steps
        .filter(step => step.type === 'tool' && step.tool_name && step.status !== 'error')
        .slice(0, 12);
    const toolNodes = toolSteps.map((step, index) => {
        const id = uniqueWorkflowNodeId(used, step.tool_name || step.title, `tool_${index + 1}`);
        return {
            id,
            title: String(step.title || `执行工具：${step.tool_name}`).replace(/^工具执行完成：/, '').slice(0, 120) || `工具节点 ${index + 1}`,
            tool: step.tool_name,
            input: normalizeWorkflowDraftInput(step.input),
            dependsOn: index === 0 ? [] : [Array.from(used)[index - 1]],
            condition: 'success',
            retryLimit: 1,
            timeoutMs: 0,
            onError: 'skip_dependents'
        };
    });
    const modelId = String(run.model_id || '').trim();
    const recordQueryNode = toolNodes.slice().reverse().find(node => isDatabaseRecordQueryTool(node.tool));
    const buildOutputNode = (sourceNode, valuePath = 'output.text') => ({
        id: uniqueWorkflowNodeId(used, 'workflow_output', 'workflow_output'),
        title: '输出最终结果',
        tool: 'workflow.output',
        input: {
            name: 'result',
            value: '{{nodes.' + sourceNode.id + '.' + valuePath + '}}',
            format: 'markdown',
            presentation: 'default'
        },
        dependsOn: [sourceNode.id],
        condition: 'success',
        retryLimit: 0,
        timeoutMs: 0,
        onError: 'stop'
    });

    if (recordQueryNode && isContentReviewGoal(run.goal)) {
        const reviewId = uniqueWorkflowNodeId(used, 'content_review', 'content_review');
        const reviewNode = {
            id: reviewId,
            title: '清洗并校对新闻内容',
            tool: 'agent.content_review',
            input: {
                records: '{{nodes.' + recordQueryNode.id + '.output.structuredContent}}',
                model: modelId,
                idField: 'id',
                titleField: 'title',
                contentField: 'content',
                instructions: String(run.goal || '').trim().slice(0, 6000),
                maxRecords: 50,
                chunkTokens: 3000,
                overlapTokens: 80,
                maxTokens: 1800,
                concurrency: 2,
                maxSummaryChars: 30000,
                reportTitle: '新闻内容校对报告'
            },
            outputSchema: contentReviewOutputSchema(),
            dependsOn: [recordQueryNode.id],
            condition: 'success',
            retryLimit: 1,
            timeoutMs: 0,
            onError: 'stop'
        };
        const outputNode = buildOutputNode(reviewNode);
        const nodes = [...toolNodes, reviewNode, outputNode];
        const sourceTitle = String(run.title || run.goal || '').trim();
        return {
            name: ('由自由任务生成：' + (sourceTitle || run.id)).slice(0, 100),
            description: ('从自由任务 ' + run.id + ' 生成的富文本内容校对工作流，已保留原任务审核规则。').slice(0, 300),
            dagSpec: { nodes },
            sourceRun: {
                id: run.id,
                title: run.title || '',
                goal: run.goal || '',
                run_mode: run.run_mode || '',
                status: run.status || '',
                model_id: run.model_id || null,
                model_name: run.model_name || ''
            },
            summary: {
                toolNodeCount: toolNodes.length,
                nodeCount: nodes.length,
                contentReviewOptimized: true,
                generatedAt: new Date().toISOString()
            }
        };
    }

    const llmId = uniqueWorkflowNodeId(used, 'llm_summary', 'llm_summary');
    const llmNode = {
        id: llmId,
        title: '汇总自由任务结果',
        tool: 'agent.llm',
        input: {
            prompt: buildWorkflowDraftLlmPrompt(run, toolNodes),
            model: modelId,
            maxSteps: Number(run.max_steps || 20) || 20,
            temperature: 0.2,
            maxTokens: 2400,
            responseFormat: 'markdown'
        },
        dependsOn: toolNodes.length ? [toolNodes[toolNodes.length - 1].id] : [],
        condition: 'success',
        retryLimit: 0,
        timeoutMs: 0,
        onError: 'skip_dependents'
    };
    const outputNode = buildOutputNode(llmNode);
    const sourceTitle = String(run.title || run.goal || '').trim();
    return {
        name: `由自由任务生成：${sourceTitle || run.id}`.slice(0, 100),
        description: `从自由任务 ${run.id} 生成的工作流草稿。请在编排页检查节点、参数和发布策略后再用于生产任务。`.slice(0, 300),
        dagSpec: { nodes: [...toolNodes, llmNode, outputNode] },
        sourceRun: {
            id: run.id,
            title: run.title || '',
            goal: run.goal || '',
            run_mode: run.run_mode || '',
            status: run.status || '',
            model_id: run.model_id || null,
            model_name: run.model_name || ''
        },
        summary: {
            toolNodeCount: toolNodes.length,
            nodeCount: toolNodes.length + 2,
            generatedAt: new Date().toISOString()
        }
    };
}

async function createWorkflowDraftFromRun(runId, user) {
    const run = await runRepository.getRunForUser(runId, user?.id);
    if (!run) return null;
    if (String(run.run_mode || '') === 'dag') {
        const err = new Error('工作流任务已经具备编排结构，请直接在工作流页加载或复制。');
        err.status = 400;
        throw err;
    }
    return buildWorkflowDraftFromRun(run, await listSteps(run.id));
}

function sortDagNodesByDependencies(nodes = []) {
    const entries = nodes.map((node, index) => ({
        node,
        index,
        key: String(node.node_key || node.id || `__node_${index}`),
        uniqueKey: `${String(node.node_key || node.id || '__node')}::${index}`
    }));
    const keys = new Set(entries.map(entry => entry.key));
    const dependencyKeys = (node) => (Array.isArray(node.depends_on) ? node.depends_on : [])
        .map(dep => String(dep || '').trim())
        .filter(dep => dep && keys.has(dep));
    const ordered = [];
    const placed = new Set();
    const placedKeys = new Set();
    while (ordered.length < entries.length) {
        const remaining = entries.filter(entry => !placed.has(entry.uniqueKey));
        const ready = remaining.filter(entry => dependencyKeys(entry.node).every(dep => placedKeys.has(dep)));
        const layer = ready.length ? ready : remaining;
        layer.sort((a, b) => a.index - b.index);
        layer.forEach(entry => {
            if (placed.has(entry.uniqueKey)) return;
            placed.add(entry.uniqueKey);
            placedKeys.add(entry.key);
            ordered.push(entry.node);
        });
    }
    return ordered;
}

async function listDagNodes(runId) {
    const nodes = await runRepository.listDagNodes(runId);
    return sortDagNodesByDependencies(nodes || []);
}

function getRunProgress(run, steps = []) {
    const maxSteps = normalizeMaxSteps(run?.max_steps, run?.run_mode);
    const planCount = steps.filter(step => step.type === 'plan').length;
    const toolCount = steps.filter(step => step.type === 'tool').length;
    const errorCount = steps.filter(step => step.status === 'error').length;
    const totalDurationMs = steps.reduce((sum, step) => sum + (Number(step.duration_ms) || 0), 0);
    const active = run && ACTIVE_STATUSES.has(run.status);
    const isDag = String(run?.run_mode || '') === 'dag';
    const roundCount = isDag ? 0 : (planCount || Math.min(toolCount, maxSteps));
    const progressCount = isDag ? Math.max(planCount, toolCount) : roundCount;
    return {
        maxSteps,
        planCount,
        roundCount,
        toolCount,
        errorCount,
        stepCount: steps.length,
        totalDurationMs,
        isLimitReached: !isDag && progressCount >= maxSteps,
        percent: active ? Math.min(Math.round((progressCount / maxSteps) * 100), 95) : (['completed', 'completed_with_errors'].includes(run?.status) ? 100 : 0)
    };
}

async function getRunDetailForUser(runId, user) {
    const run = await getRunForUser(runId, user);
    if (!run) return null;
    const [steps, dagNodes, trace, checkpoints] = await Promise.all([
        listSteps(run.id),
        listDagNodes(run.id),
        getAgentTraceForUser(run.id, user),
        summarizeAgentCheckpoints(run.id)
    ]);
    let effectiveDagNodes = dagNodes || [];
    if (String(run.run_mode || '').toLowerCase() === 'dag' && effectiveDagNodes.length === 0) {
        let metadata = run.metadata;
        if (typeof metadata === 'string') {
            try { metadata = JSON.parse(metadata); } catch (e) { metadata = {}; }
        }
        const nodes = Array.isArray(metadata?.dagSpec?.nodes) ? metadata.dagSpec.nodes : [];
        if (nodes.length > 0) {
            effectiveDagNodes = nodes.map(node => ({
                run_id: run.id,
                node_key: node.id,
                title: node.title || node.id,
                tool_name: node.tool,
                status: 'pending',
                input: node.input || {},
                output: null,
                depends_on: node.dependsOn || [],
                condition: node.condition || 'success',
                attempt_count: 0
            }));
        }
    }
    return {
        run,
        steps: steps || [],
        dagNodes: effectiveDagNodes,
        progress: getRunProgress(run, steps || []),
        trace,
        checkpoints
    };
}

async function updateAgentRunTitleAndGoalForUser(runId, user, payload = {}) {
    const userId = Number(user?.id);
    if (!userId) return null;
    return await runRepository.updateAgentRunTitleAndGoal(runId, userId, payload);
}

module.exports = {
    createWorkflowDraftFromRun,
    getRunDetailForUser,
    getRunForUser,
    getRunProgress,
    listDagNodes,
    listDeletedRunsForAdmin,
    listRuns,
    sortDagNodesByDependencies,
    listSteps,
    updateAgentRunTitleAndGoalForUser
};
