/* 画布编辑器、草稿恢复与发布运行的共用适配。 */
/* eslint-disable no-undef */
(function () {
    const request = (path, options = {}) => apiFetch(`${API_BASE}${path}`, {
        ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
    });
    const editor = () => dagEditorInstance;
    const current = () => selectedAgentWorkflow() || null;
    const spec = () => { parseAgentWorkflowText(); return editor()?.getValue?.() || parseAgentWorkflowText(); };
    function capture() {
        return { specText: getAgentWorkflowText(), workflowId: current()?.id || null,
            name: currentAgentWorkflowName(), description: currentAgentWorkflowDescription(), baseVersion: Number(current()?.current_version || 0) };
    }
    function restore(value) {
        agentWorkflowDraftName = value.name || '未命名工作流';
        agentWorkflowDraftDescription = value.description || '';
        writeAgentWorkflowText(value.specText);
        try { editor()?.setValue?.(JSON.parse(value.specText), { notify: false }); } catch (_) { /* 未完成 JSON 仍作为可恢复草稿保留。 */ }
        refreshAgentDagInputsPanel();
    }
    window.Pivot.registerModule('agent.workflowBridge', {
        request, editor, current, spec, capture, restore,
        openJson: () => { if (!agentWorkflowReadOnly) openAgentDagJsonModal(); },
        upload: async file => {
            let sessionId = window.Pivot.legacy.currentSessionId;
            if (!sessionId) { const response = await request('/sessions', { method: 'POST', body: JSON.stringify({ title: '工作流资料' }) }); const session = await response.json(); if (!response.ok) throw new Error(session.error || '无法准备资料上传。'); sessionId = session.id; }
            return uploadChatFile(file, sessionId);
        },
        readOnly: () => agentWorkflowReadOnly, userId: () => currentUser?.id,
        tools: () => agentToolsCache || [], models: () => window.Pivot.legacy._cachedAgentModels || [],
        setName: name => { agentWorkflowDraftName = name.slice(0, 100); renderAgentWorkflowLibrary(); window.Pivot.moduleApi('agent.workflowDrafts')?.changed?.(); },
        inputs: () => collectAgentDagInputs(), write: value => { writeAgentWorkflowText(value); editor()?.setValue?.(value); },
        choose: workflow => { activeAgentWorkflowId = String(workflow?.id || ''); const picker = document.getElementById('agent-workflow-select'); if (picker) picker.value = activeAgentWorkflowId; },
        openEditor: (id, options) => showAutomationWorkflowEditor(id, options),
        newWorkflow: values => { newAgentWorkflow({ showToast: false, ...values }); showAutomationWorkflowEditor('', { keepDraft: true }); },
        run: (source, options) => runAgentWorkflowFromWorkbench(source, options),
        persist: options => saveAgentWorkflowToLibrary(options), publish: options => publishSelectedAgentWorkflow(options?.targetVersion || 'current', options),
        focus: id => focusAgentDagNode(id), refreshInputs: () => refreshAgentDagInputsPanel(),
        reload: () => loadAgentWorkflows(), workflows: () => agentWorkflowsCache,
        openDependencies: id => window.Pivot.moduleApi('agent.automation').openWorkflowDependencies?.(id),
        openTriggers: id => window.Pivot.moduleApi('agent.automationResources').open?.({ tab: 'triggers', workflowId: id })
    });
})();
