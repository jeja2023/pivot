/* eslint-disable no-undef, no-unused-vars */
// Agent 工作流编排与运行控制 Agent workflow orchestration and run controls
// Agent 工作流功能从 agents.js 拆分而来。
// Split from agents.js.
window.openAgentDagWorkbench = async function() {
    closeAgentConfigModal();
    window.showMainWorkspace?.('agent-dag');
    const requestedWorkflowId = activeAgentWorkflowId || '';
    await Promise.all([
        loadAgentModels(),
        agentToolsCache.length ? Promise.resolve() : loadAgentTools(),
        loadAgentWorkflows()
    ]);
    const workflow = agentWorkflowsCache.find(item => String(item.id) === String(requestedWorkflowId));
    if (workflow) {
        activeAgentWorkflowId = String(workflow.id);
        agentWorkflowDraftName = workflow.name || '';
        agentWorkflowDraftDescription = workflow.description || '';
        writeAgentWorkflowText(workflow.dag_spec || { nodes: [] });
        renderAgentWorkflowLibrary();
    } else {
        newAgentWorkflow({ showToast: false, clearSnapshots: false, remount: false });
    }
    mountAgentDagEditor();
    window.refreshAgentDagEditor?.();
    window.bindAgentDagWorkbench?.();
    updateAgentWorkflowRunUi();
};

window.closeAgentDagWorkbench = function() {
    closeAgentDagJsonModal();
    closeAgentDagNodeDrawer();
    window.showMainWorkspace?.('agent');
};

window.bindAgentDagWorkbench = function() {
    const newBtn = document.getElementById('agent-workflow-new-btn');
    if (newBtn && newBtn.dataset.boundAgentWorkflowNew !== '1') {
        newBtn.dataset.boundAgentWorkflowNew = '1';
        newBtn.addEventListener('click', () => newAgentWorkflow());
    }
    const draftBtn = document.getElementById('agent-dag-save-draft-btn');
    if (draftBtn && draftBtn.dataset.boundAgentDagDraft !== '1') {
        draftBtn.dataset.boundAgentDagDraft = '1';
        draftBtn.addEventListener('click', () => window.saveAgentWorkflowDraft?.());
    }
    const saveBtn = document.getElementById('agent-dag-save-btn');
    if (saveBtn && saveBtn.dataset.boundAgentDagSave !== '1') {
        saveBtn.dataset.boundAgentDagSave = '1';
        saveBtn.addEventListener('click', () => window.saveAgentWorkflow?.());
    }
    const backBtn = document.getElementById('agent-dag-back-btn');
    if (backBtn && backBtn.dataset.boundAgentDagBack !== '1') {
        backBtn.dataset.boundAgentDagBack = '1';
        backBtn.addEventListener('click', () => window.closeAgentDagWorkbench?.());
    }
    const workflowPicker = document.getElementById('agent-workflow-picker');
    const workflowPickerTrigger = document.getElementById('agent-workflow-picker-trigger');
    const workflowPickerSearch = document.getElementById('agent-workflow-picker-search');
    const workflowPickerList = document.getElementById('agent-workflow-picker-list');
    if (workflowPickerTrigger && workflowPickerTrigger.dataset.boundAgentWorkflowPicker !== '1') {
        workflowPickerTrigger.dataset.boundAgentWorkflowPicker = '1';
        workflowPickerTrigger.addEventListener('click', () => {
            const isOpen = workflowPicker?.classList.contains('is-open');
            setAgentWorkflowPickerOpen(!isOpen);
        });
        workflowPickerTrigger.addEventListener('keydown', event => {
            if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                setAgentWorkflowPickerOpen(true);
            }
        });
    }
    if (workflowPickerSearch && workflowPickerSearch.dataset.boundAgentWorkflowSearch !== '1') {
        workflowPickerSearch.dataset.boundAgentWorkflowSearch = '1';
        workflowPickerSearch.addEventListener('input', () => {
            agentWorkflowPickerQuery = workflowPickerSearch.value || '';
            renderAgentWorkflowPicker();
        });
        workflowPickerSearch.addEventListener('keydown', event => {
            if (event.key === 'Escape') {
                event.preventDefault();
                setAgentWorkflowPickerOpen(false);
                workflowPickerTrigger?.focus();
                return;
            }
            if (event.key === 'ArrowDown') {
                event.preventDefault();
                workflowPickerList?.querySelector('.agent-workflow-picker-option')?.focus();
            }
        });
    }
    if (workflowPickerList && workflowPickerList.dataset.boundAgentWorkflowList !== '1') {
        workflowPickerList.dataset.boundAgentWorkflowList = '1';
        workflowPickerList.addEventListener('keydown', event => {
            const option = event.target.closest('.agent-workflow-picker-option');
            if (!option) return;
            if (event.key === 'Escape') {
                event.preventDefault();
                setAgentWorkflowPickerOpen(false);
                workflowPickerTrigger?.focus();
                return;
            }
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                const options = Array.from(workflowPickerList.querySelectorAll('.agent-workflow-picker-option'));
                const index = options.indexOf(option);
                const nextIndex = event.key === 'ArrowDown'
                    ? Math.min(index + 1, options.length - 1)
                    : Math.max(index - 1, 0);
                options[nextIndex]?.focus();
            }
        });
    }
    if (workflowPicker && workflowPicker.dataset.boundAgentWorkflowOutside !== '1') {
        workflowPicker.dataset.boundAgentWorkflowOutside = '1';
        document.addEventListener('click', event => {
            if (!workflowPicker.contains(event.target)) setAgentWorkflowPickerOpen(false, { focusSearch: false });
        });
    }
    const workflowSelect = document.getElementById('agent-workflow-select');
    if (workflowSelect && workflowSelect.dataset.boundAgentWorkflowSelect !== '1') {
        workflowSelect.dataset.boundAgentWorkflowSelect = '1';
        workflowSelect.addEventListener('change', () => {
            activeAgentWorkflowId = workflowSelect.value || '';
            if (!activeAgentWorkflowId) {
                newAgentWorkflow({ showToast: false, clearSnapshots: false });
                return;
            }
            const selected = agentWorkflowsCache.find(item => String(item.id) === String(activeAgentWorkflowId));
            agentWorkflowDraftName = selected?.name || '';
            agentWorkflowDraftDescription = selected?.description || '';
            renderAgentWorkflowLibrary();
            updateAgentWorkflowRunUi();
        });
    }
    const loadBtn = document.getElementById('agent-workflow-load-btn');
    if (loadBtn && loadBtn.dataset.boundAgentWorkflowLoad !== '1') {
        loadBtn.dataset.boundAgentWorkflowLoad = '1';
        loadBtn.addEventListener('click', loadSelectedAgentWorkflow);
    }
    const versionsBtn = document.getElementById('agent-workflow-versions-btn');
    if (versionsBtn && versionsBtn.dataset.boundAgentWorkflowVersions !== '1') {
        versionsBtn.dataset.boundAgentWorkflowVersions = '1';
        versionsBtn.addEventListener('click', openAgentWorkflowVersions);
    }
    const deleteBtn = document.getElementById('agent-workflow-delete-btn');
    if (deleteBtn && deleteBtn.dataset.boundAgentWorkflowDelete !== '1') {
        deleteBtn.dataset.boundAgentWorkflowDelete = '1';
        deleteBtn.addEventListener('click', deleteSelectedAgentWorkflow);
    }
    const drawerDeleteBtn = document.getElementById('agent-dag-node-drawer-delete');
    if (drawerDeleteBtn && drawerDeleteBtn.dataset.boundAgentDagDrawerDelete !== '1') {
        drawerDeleteBtn.dataset.boundAgentDagDrawerDelete = '1';
        drawerDeleteBtn.addEventListener('click', deleteSelectedAgentDagNode);
    }
    const drawerCloseBtn = document.getElementById('agent-dag-node-drawer-close');
    if (drawerCloseBtn && drawerCloseBtn.dataset.boundAgentDagDrawerClose !== '1') {
        drawerCloseBtn.dataset.boundAgentDagDrawerClose = '1';
        drawerCloseBtn.addEventListener('click', closeAgentDagNodeDrawer);
    }
    const jsonCloseBtn = document.getElementById('agent-dag-json-close-btn');
    if (jsonCloseBtn && jsonCloseBtn.dataset.boundAgentDagJsonClose !== '1') {
        jsonCloseBtn.dataset.boundAgentDagJsonClose = '1';
        jsonCloseBtn.addEventListener('click', closeAgentDagJsonModal);
    }
    const jsonApplyBtn = document.getElementById('agent-dag-json-apply-btn');
    if (jsonApplyBtn && jsonApplyBtn.dataset.boundAgentDagJsonApply !== '1') {
        jsonApplyBtn.dataset.boundAgentDagJsonApply = '1';
        jsonApplyBtn.addEventListener('click', syncAgentDagJsonToCanvas);
    }
    const jsonModal = document.getElementById('agent-dag-json-modal');
    if (jsonModal && jsonModal.dataset.boundAgentDagJsonOverlay !== '1') {
        jsonModal.dataset.boundAgentDagJsonOverlay = '1';
        jsonModal.addEventListener('click', event => {
            if (event.target === jsonModal) closeAgentDagJsonModal();
        });
    }
    // 运行时输入面板刷新按钮
    const inputsRefreshBtn = document.getElementById('agent-dag-inputs-refresh-btn');
    if (inputsRefreshBtn && inputsRefreshBtn.dataset.boundInputsRefresh !== '1') {
        inputsRefreshBtn.dataset.boundInputsRefresh = '1';
        inputsRefreshBtn.addEventListener('click', refreshAgentDagInputsPanel);
    }
};
