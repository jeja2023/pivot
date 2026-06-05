/* eslint-disable no-undef, no-unused-vars */
// Agent 工作流运行与发布运行辅助函数。
function agentWorkflowRunSourceLabel(source) {
    if (source === 'published') return '发布版运行';
    if (source === 'current') return '当前版本运行';
    return '预览运行';
}

function setAgentWorkflowRunConsoleStatus(message, type = '') {
    void message;
    void type;
}

function getAgentWorkflowRunSettings(raw = getAgentWorkflowText()) {
    let spec;
    try {
        spec = parseAgentWorkflowText(raw);
    } catch (e) {
        return { valid: false, error: e };
    }
    const nodes = Array.isArray(spec?.nodes) ? spec.nodes : [];
    const llmNode = nodes.find(node => String(node?.tool || '').trim() === 'agent.llm') || null;
    const input = llmNode?.input && typeof llmNode.input === 'object' ? llmNode.input : {};
    const maxSteps = Number.parseInt(input.maxSteps ?? input.max_steps ?? 20, 10);
    return {
        valid: true,
        llmNode,
        modelId: String(input.model || input.modelId || input.model_id || '').trim(),
        maxSteps: Number.isFinite(maxSteps) && maxSteps > 0 ? maxSteps : 20,
        toolPolicy: 'all',
        approvalPolicy: 'safe_mcp_auto',
        modelRouter: 'fixed',
        maxTokenBudget: 0,
        retryLimit: 1,
        toolAllowlist: [],
        contextConfig: { mode: 'auto', notes: '' }
    };
}

function validateAgentWorkflowRunSettings(settings, options = {}) {
    const requireModel = options.requireModel !== false;
    if (!settings?.valid) return '工作流 JSON 格式不正确，无法读取 LLM 节点配置';
    if (!settings.llmNode) return '工作流必须包含 1 个大模型节点';
    if (requireModel && !settings.modelId) return `${settings.llmNode.title || settings.llmNode.id || '大模型节点'} 需要填写节点模型`;
    return '';
}

function buildAgentWorkflowWorkbenchRunPayload(source = 'draft', workflowOverride = null) {
    const workflow = workflowOverride || selectedAgentWorkflow();
    const sourceMode = ['draft', 'current', 'published'].includes(source) ? source : 'draft';
    const summaryForSettings = sourceMode === 'draft'
        ? summarizeAgentDagSpec()
        : summarizeAgentDagSpec(workflow?.dag_spec || { nodes: [] });
    const runSettings = getAgentWorkflowRunSettings(sourceMode === 'draft' ? getAgentWorkflowText() : (workflow?.dag_spec || { nodes: [] }));
    const goal = inferAgentWorkflowRunGoal();
    const payload = {
        goal,
        title: `${agentWorkflowRunSourceLabel(sourceMode)}：${currentAgentWorkflowName()}`,
        modelId: runSettings.modelId,
        maxSteps: runSettings.maxSteps,
        runMode: 'dag',
        toolPolicy: runSettings.toolPolicy,
        approvalPolicy: runSettings.approvalPolicy,
        modelRouter: runSettings.modelRouter,
        maxTokenBudget: runSettings.maxTokenBudget,
        retryLimit: runSettings.retryLimit,
        toolAllowlist: runSettings.toolAllowlist,
        contextConfig: runSettings.contextConfig,
        sessionId: window.currentSessionId || null
    };
    if (!payload.goal) {
        showToast('请先填写任务目标或工作流名称', 'error');
        payload._invalid = true;
        return payload;
    }
    if (sourceMode === 'draft') {
        const summary = summaryForSettings;
        if (!summary.valid) {
            showToast('工作流 JSON 格式不正确，无法预览运行', 'error');
            payload._invalid = true;
            return payload;
        }
        if (summary.executableNodeCount <= 0) {
            showToast('预览运行至少需要 1 个已选择工具的节点', 'error');
            payload._invalid = true;
            return payload;
        }
        const settingsError = validateAgentWorkflowRunSettings(runSettings);
        if (settingsError) {
            showToast(settingsError, 'error');
            payload._invalid = true;
            return payload;
        }
        payload.dagSpec = summary.spec;
        payload.workflowVersion = 'draft';
        payload.metadata = {
            ...(payload.metadata || {}),
            workflowRunSource: 'preview',
            workflowVersionMode: 'draft',
            workflowName: currentAgentWorkflowName()
        };
    } else {
        if (!workflow) {
            showToast('请选择要运行的工作流', 'error');
            payload._invalid = true;
            return payload;
        }
        if (sourceMode === 'published' && !workflow.published_version) {
            showToast('当前工作流还没有发布版本，请先发布后再运行发布版', 'error');
            payload._invalid = true;
            return payload;
        }
        const settingsError = validateAgentWorkflowRunSettings(runSettings, { requireModel: sourceMode !== 'published' });
        if (settingsError) {
            showToast(settingsError, 'error');
            payload._invalid = true;
            return payload;
        }
        payload.workflowId = workflow.id;
        payload.workflowVersion = sourceMode === 'published' ? 'published' : 'current';
        payload.metadata = {
            ...(payload.metadata || {}),
            workflowRunSource: sourceMode === 'published' ? 'published' : 'current',
            workflowVersionMode: sourceMode,
            workflowName: workflow.name || currentAgentWorkflowName()
        };
    }
    const visualInputs = collectAgentDagInputs();
    if (Object.keys(visualInputs).length) payload.dagInputs = visualInputs;
    return payload;
}

async function runAgentWorkflowFromWorkbench(source = 'draft', options = {}) {
    const sourceMode = ['draft', 'current', 'published'].includes(source) ? source : 'draft';
    const payload = buildAgentWorkflowWorkbenchRunPayload(sourceMode, options.workflow || null);
    if (payload._invalid) return null;
    try {
        setAgentWorkflowRunConsoleStatus(`正在预检：${agentWorkflowRunSourceLabel(sourceMode)}...`, 'running');
        const preflight = await preflightAgentPayload(payload);
        if (preflight.status === 'blocked') {
            setAgentWorkflowRunConsoleStatus('预检未通过，请先处理阻断项。', 'error');
            showToast('工作流预检未通过，请先处理阻断项', 'error');
            return null;
        }
        setAgentWorkflowRunConsoleStatus(`正在创建任务：${agentWorkflowRunSourceLabel(sourceMode)}...`, 'running');
        const res = await apiFetch(`${API_BASE}/agents/runs`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '工作流运行失败');
        if (sourceMode === 'draft') {
            setAgentWorkflowRunConsoleStatus('预览运行已入队，可在预览详情查看节点轨迹。', 'ready');
            showToast('预览运行已入队', 'success');
            await window.openAgentRun(data.run.id, { workflowPreview: true });
            startAgentWorkflowPreviewPolling(data.run.id);
        } else {
            setAgentWorkflowRunConsoleStatus(`${agentWorkflowRunSourceLabel(sourceMode)}已入队，可在任务详情查看节点轨迹。`, 'ready');
            showToast(`${agentWorkflowRunSourceLabel(sourceMode)}已入队`, 'success');
            await Promise.all([loadAgentRuns(1), loadAgentSchedules(), loadAgentNotifications()]);
            await window.openAgentRun(data.run.id);
        }
        return data.run;
    } catch (e) {
        setAgentWorkflowRunConsoleStatus(e.message || '工作流运行失败', 'error');
        showToast(e.message || '工作流运行失败', 'error');
        return null;
    }
}

async function publishAndRunAgentWorkflow() {
    const workflow = await publishSelectedAgentWorkflow('current');
    if (!workflow) return null;
    return runAgentWorkflowFromWorkbench('published', { workflow });
}

window.runAgentWorkflowPreview = () => runAgentWorkflowFromWorkbench('draft');

window.runAgentWorkflowPublished = () => runAgentWorkflowFromWorkbench('published');

window.publishSelectedAgentWorkflow = publishSelectedAgentWorkflow;

window.publishAndRunAgentWorkflow = publishAndRunAgentWorkflow;

window.openAgentWorkflowVersions = openAgentWorkflowVersions;
