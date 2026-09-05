// Split from agents.js.
/* eslint-disable no-undef */
let agentRunsCache = [];

let agentRefreshTimer = null;

let activeAgentRunId = '';

let agentToolsCache = [];

let agentTemplatesCache = [];

let agentSchedulesCache = [];

let agentScheduleFilterId = '';

let agentArtifactsCache = [];

let agentRealtimeSource = null;

let agentRealtimeConnected = false;

let agentRealtimeRefreshTimer = null;

let activeAgentConfigSection = '';

let agentRunsPage = 1;

let agentRunsTotal = 0;

let agentWorkflowsCache = [];

let activeAgentWorkflowId = '';

let agentWorkflowDraftName = '';

let agentWorkflowDraftDescription = '';

let agentWorkflowPickerQuery = '';

let activeAgentWorkflowPreviewRunId = '';

let agentWorkflowPreviewTimer = null;

let pendingAgentWorkflowDraft = null;

const AGENT_RUNS_PAGE_SIZE = 15;

const AGENT_WORKFLOW_DRAFT_KEY = 'pivot.agent.workflow.draft';

const AGENT_WORKFLOW_SAVED_KEY = 'pivot.agent.workflow.saved';

let agentRunTitleTooltipEl = null;

let agentRunTitleTooltipTarget = null;

const agentEscape = (value) => escapeHtml(value === undefined || value === null ? '' : String(value));

const agentEscapeAttr = (value) => window.Pivot.legacy.PivotSafeHtml?.escapeAttr
    ? window.Pivot.legacy.PivotSafeHtml.escapeAttr(value)
    : agentEscape(value).replace(/"/g, '&quot;');

const agentEvaluationsApi = () => window.Pivot.moduleApi('agent.evaluations');

function agentLooksLikeCorruptTitle(value) {
    const text = String(value || '').trim();
    if (!text) return true;
    if (/^[?\uFFFD\s._-]+$/.test(text) && /[?\uFFFD]{3,}/.test(text)) return true;
    const questionCount = (text.match(/[?\uFFFD]/g) || []).length;
    return questionCount >= 3 && questionCount / Math.max(text.length, 1) > 0.55;
}

function agentDisplayTitle(item) {
    const title = String(item?.title || '').trim();
    const goal = String(item?.goal || '').trim();
    if (!agentLooksLikeCorruptTitle(title)) return title;
    return goal || '自主任务';
}

function agentPreviewDisplayTitle(value) {
    let text = String(value || '').trim();
    while (/^预览运行\s*[:：]\s*/.test(text)) {
        text = text.replace(/^预览运行\s*[:：]\s*/, '').trim();
    }
    return text || '预览运行';
}

window.Pivot.legacy.loadAgentWorkbench = async function() {
    try {
        await loadAgentModels();
        await Promise.all([
            loadAgentModelRouters(),
            loadAgentTools(),
            loadAgentRuns(),
            loadAgentRuntimeStatus(),
            loadAgentMetrics(),
            loadAgentTemplates(),
            loadAgentSchedules(),
            loadAgentNotifications(),
            loadAgentArtifacts(),
            window.Pivot.legacy.loadAgentHarnessSkills?.(),
            agentEvaluationsApi().loadSuites?.()
        ]);
    } catch (e) {
        showToast(e.message, 'error');
    }
};

window.Pivot.legacy.setTaskComposerOpen = function(isOpen = true) {
    const modal = document.getElementById('agent-task-editor-modal');
    const openButton = document.getElementById('task-create-open-btn');
    if (!modal) return;
    if (modal.dataset.boundTaskEditorOverlay !== '1') {
        modal.dataset.boundTaskEditorOverlay = '1';
    }
    const wasOpen = !modal.classList.contains('hidden');
    modal.classList.toggle('hidden', !isOpen);
    modal.setAttribute('aria-hidden', isOpen ? 'false' : 'true');
    openButton?.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    if (isOpen) setTimeout(() => (document.getElementById('agent-title-input') || document.getElementById('agent-goal-input'))?.focus(), 0);
    else if (wasOpen && modal.contains(document.activeElement)) openButton?.focus();
};

window.Pivot.legacy.syncAutomationPrimaryTabs = function(activeSection = 'tasks') {
    if (typeof document?.querySelectorAll !== 'function') return;
    document.querySelectorAll('[data-automation-section]').forEach(button => {
        const isActive = button.dataset.automationSection === activeSection;
        button.classList.toggle('active', isActive);
        button.setAttribute('aria-selected', isActive ? 'true' : 'false');
        button.tabIndex = isActive ? 0 : -1;
    });
};

window.Pivot.legacy.bindUnifiedAutomationTabs = function() {
    if (typeof document?.querySelectorAll !== 'function') return;
    document.querySelectorAll('[data-automation-section]').forEach(button => {
        if (button.dataset.boundAutomationSection === '1') return;
        button.dataset.boundAutomationSection = '1';
        button.addEventListener('click', async () => {
            try {
                const section = button.dataset.automationSection;
                const isWorkflowEditorOpen = document.body?.dataset.activeWorkspace === 'agent-dag'
                    && !document.getElementById('automation-editor-view')?.classList.contains('hidden');
                if (isWorkflowEditorOpen && section === 'workflows') return;
                if (isWorkflowEditorOpen && typeof confirmAgentWorkflowDiscard === 'function') {
                    const confirmed = await confirmAgentWorkflowDiscard('切换自动化功能会放弃当前画布中尚未保存的修改，确定继续吗？');
                    if (!confirmed) return;
                }
                if (section === 'tasks') return window.Pivot.legacy.openAgentWorkbench?.({ tab: 'tasks' });
                if (section === 'workbench') return window.Pivot.legacy.openAgentWorkbench?.({ tab: 'workbench' });
                return window.Pivot.legacy.openAgentDagWorkbench?.({ tab: section });
            } catch (error) {
                showToast(error.message || '自动化页面加载失败', 'error');
            }
        });
    });
};

window.Pivot.legacy.bindAgentWorkbenchShortcuts = function() {
    if (typeof document?.querySelectorAll !== 'function') return;
    document.querySelectorAll('[data-automation-jump="workbench"]').forEach(btn => {
        if (btn.dataset.boundAutomationJump === '1') return;
        btn.dataset.boundAutomationJump = '1';
        btn.addEventListener('click', () => {
            window.Pivot.legacy.openAgentWorkbench?.({ tab: 'workbench' });
        });
    });
};

window.Pivot.legacy.openAgentWorkbench = async function(options = {}) {
    window.Pivot.legacy.showMainWorkspace?.('agent');
    const tab = options.tab || 'tasks';
    try { sessionStorage.setItem('pivot.agent.active_tab', tab); } catch (_) {}
    window.Pivot.legacy.syncAutomationPrimaryTabs(tab);
    const panel = document.getElementById('agent-workbench-modal');
    if (!panel) return;

    const tasksView = document.getElementById('agent-tasks-view');
    const controlPlaneView = document.getElementById('agent-control-plane');
    const newTaskBtn = document.getElementById('task-create-open-btn');
    const newGoalTopBtn = document.getElementById('agent-goal-create-top-btn');
    const subtitle = panel.querySelector('.agent-modal-header p');

    if (tab === 'workbench') {
        if (tasksView) tasksView.classList.add('hidden');
        if (controlPlaneView) controlPlaneView.classList.remove('hidden');
        if (newTaskBtn) newTaskBtn.classList.add('hidden');
        if (newGoalTopBtn) newGoalTopBtn.classList.remove('hidden');
        if (subtitle) subtitle.textContent = '智能体工作台：技能与助手、待办、自动目标、通知设置与运行质量。';
        window.Pivot?.moduleApi?.('agent.harness')?.loadAgentControlPlane?.();
    } else {
        if (tasksView) tasksView.classList.remove('hidden');
        if (controlPlaneView) controlPlaneView.classList.add('hidden');
        if (newTaskBtn) newTaskBtn.classList.remove('hidden');
        if (newGoalTopBtn) newGoalTopBtn.classList.add('hidden');
        if (subtitle) subtitle.textContent = '集中创建、运行与审计一次性后台任务、工作流任务与计划执行。';
    }

    const queryInput = document.getElementById('agent-filter-query');
    const runTypeInput = document.getElementById('agent-filter-run-type');
    agentScheduleFilterId = Object.hasOwn(options, 'scheduleId') ? String(options.scheduleId || '') : '';
    if (queryInput && Object.hasOwn(options, 'query')) queryInput.value = String(options.query || '');
    if (runTypeInput && Object.hasOwn(options, 'runType')) runTypeInput.value = String(options.runType || '');
    panel.querySelectorAll('.admin-root-only').forEach(el => {
        el.classList.toggle('hidden', !isSuperAdminUser());
    });
    window.Pivot.legacy.setTaskComposerOpen(Boolean(options.create));
    // 智能体工作区脚本按需加载，在数据请求前优先绑定交互与选项卡切换事件
    window.Pivot.legacy.bindAgentGoalTemplates?.();
    window.Pivot.legacy.bindAgentFilters?.();
    window.Pivot.legacy.bindAgentEnterpriseControls?.();
    window.Pivot.legacy.bindAgentConfigModal?.();
    window.Pivot.legacy.bindUnifiedAutomationTabs?.();
    window.Pivot.legacy.bindAgentWorkbenchShortcuts?.();
    // 智能体脚本按需加载；登录时如果尚未进入工作区，实时脚本不会参与初始化。
    // 在脚本就绪后补建 SSE，确保新任务的状态和执行步骤无需手动刷新即可显示。
    window.Pivot.legacy.initAgentRealtime?.();
    if (tab === 'tasks') {
        await window.Pivot.legacy.loadAgentWorkbench();
    }
};

window.Pivot.legacy.closeAgentWorkbench = function() {
    closeAgentConfigModal();
    window.Pivot.legacy.closeAgentRunDetailModal();
    window.Pivot.legacy.setTaskComposerOpen(false);
    (window.Pivot.legacy.returnFromWorkspace || window.Pivot.legacy.showMainWorkspace)?.('personal');
    updateAgentAutoRefresh();
};

window.Pivot.legacy.bindAgentGoalTemplates = function() {
    document.querySelectorAll('[data-agent-goal-template]').forEach(btn => {
        if (btn.dataset.boundAgentTemplate === '1') return;
        btn.dataset.boundAgentTemplate = '1';
        btn.addEventListener('click', () => {
            const input = document.getElementById('agent-goal-input');
            const titleInput = document.getElementById('agent-title-input');
            if (!input) return;
            input.value = btn.dataset.agentGoalTemplate || '';
            if (titleInput) titleInput.value = btn.dataset.agentTitleTemplate || btn.textContent.trim() || '';
            if (btn.dataset.agentRunMode) {
                const mode = document.getElementById('agent-run-mode');
                if (mode) mode.value = btn.dataset.agentRunMode;
                window.Pivot.legacy.syncAgentRunModeStepLimit?.();
            }
            if (btn.dataset.agentMcp) {
                const allowMcp = document.getElementById('agent-allow-mcp');
                if (allowMcp) allowMcp.checked = btn.dataset.agentMcp === 'true';
            }
            input.focus();
        });
    });
};

window.Pivot.legacy.bindAgentFilters = function() {
    ['agent-filter-status', 'agent-filter-run-type', 'agent-filter-query'].forEach(id => {
        const el = document.getElementById(id);
        if (!el || el.dataset.boundAgentFilter === '1') return;
        el.dataset.boundAgentFilter = '1';
        const reloadFirstPage = () => {
            if (id === 'agent-filter-run-type' && el.value !== 'scheduled') {
                agentScheduleFilterId = '';
            }
            loadAgentRuns(1).catch(err => showToast(err.message || '任务列表刷新失败', 'error'));
        };
        // 文本输入防抖，避免逐键触发请求风暴与响应乱序覆盖；下拉 change 保持即时
        const debouncedReload = window.Pivot && typeof window.Pivot.debounce === 'function'
            ? window.Pivot.debounce(reloadFirstPage, 280)
            : reloadFirstPage;
        el.addEventListener('input', debouncedReload);
        el.addEventListener('change', reloadFirstPage);
    });
};

window.Pivot.legacy.syncAgentRunModeStepLimit = function() {
    const mode = document.getElementById('agent-run-mode')?.value || 'standard';
    const input = document.getElementById('agent-max-steps');
    const limits = { standard: 30, deep: 50, audit: 60 };
    const limit = limits[mode] || limits.standard;
    if (!input) return;
    input.max = String(limit);
    const value = Number(input.value || 0);
    if (value > limit) input.value = String(limit);
};

window.Pivot.legacy.bindAgentEnterpriseControls = function() {
    if (typeof bindAgentTemplateModal === 'function') bindAgentTemplateModal();
    document.querySelectorAll('[data-agent-save-template]').forEach(saveTemplateBtn => {
        if (saveTemplateBtn.dataset.boundAgentTemplateSave === '1') return;
        saveTemplateBtn.dataset.boundAgentTemplateSave = '1';
        saveTemplateBtn.addEventListener('click', saveCurrentAgentTemplate);
    });
    const savePlanButton = document.getElementById('agent-save-plan-btn');
    if (savePlanButton && savePlanButton.dataset.boundAgentPlanSave !== '1') {
        savePlanButton.dataset.boundAgentPlanSave = '1';
        savePlanButton.addEventListener('click', saveCurrentAgentTaskAsSchedule);
    }
    const runMode = document.getElementById('agent-run-mode');
    if (runMode && runMode.dataset.boundAgentStepLimit !== '1') {
        runMode.dataset.boundAgentStepLimit = '1';
        runMode.addEventListener('change', window.Pivot.legacy.syncAgentRunModeStepLimit);
    }
    window.Pivot.legacy.syncAgentRunModeStepLimit();
};

const agentConfigSectionTitles = {
    templates: '任务模板',
    results: '能力与结果',
    harness: '运行环境',
    evaluations: '质量评测'
};

function closeAgentConfigModal() {
    const modal = document.getElementById('agent-config-modal');
    const body = document.getElementById('agent-config-modal-body');
    const store = document.getElementById('agent-config-section-store');
    if (body && store) {
        Array.from(body.children).forEach(child => {
            store.appendChild(child);
            if (child.matches?.('.agent-collapse-section')) child.open = true;
        });
    }
    activeAgentConfigSection = '';
    if (modal) delete modal.dataset.agentConfigSection;
    modal?.classList.add('hidden');
    modal?.setAttribute('aria-hidden', 'true');
}

function openAgentConfigSection(sectionKey) {
    if (sectionKey === 'evaluations') {
        globalThis['openAgentWorkbench']?.({ tab: 'workbench' });
        window.Pivot?.moduleApi?.('agent.harness')?.switchAgentCpSubview?.('quality');
        const evaluations = agentEvaluationsApi();
        evaluations.bind?.();
        evaluations.loadSuites?.().catch(error => showToast(error.message || '评测中心加载失败', 'error'));
        return;
    }
    if (sectionKey === 'harness') {
        globalThis['openAgentWorkbench']?.({ tab: 'workbench' });
        window.Pivot?.moduleApi?.('agent.harness')?.switchAgentCpSubview?.('governance');
        window.Pivot.legacy.loadAgentHarnessManagement?.();
        return;
    }
    if (sectionKey === 'templates') {
        globalThis['openAgentWorkbench']?.({ tab: 'tasks' });
        window.Pivot.legacy.setTaskComposerOpen(true);
        return;
    }
    if (sectionKey === 'results') {
        globalThis['openAgentWorkbench']?.({ tab: 'tasks' });
        return;
    }
    const section = document.querySelector(`[data-agent-config-section="${CSS.escape(sectionKey)}"]`);
    const modal = document.getElementById('agent-config-modal');
    const body = document.getElementById('agent-config-modal-body');
    const title = document.getElementById('agent-config-modal-title');
    if (!section || !modal || !body) return;
    closeAgentConfigModal();
    activeAgentConfigSection = sectionKey;
    modal.dataset.agentConfigSection = sectionKey;
    if (title) title.textContent = agentConfigSectionTitles[sectionKey] || '任务配置';
    section.open = true;
    body.appendChild(section);
    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');
    if (sectionKey === 'advanced') {
        mountAgentDagEditor();
        setTimeout(() => window.Pivot.legacy.refreshAgentDagEditor?.(), 50);
    }
}

window.Pivot.legacy.closeAgentConfigModal = closeAgentConfigModal;

window.Pivot.legacy.openAgentConfigSection = openAgentConfigSection;

window.Pivot.legacy.bindAgentConfigModal = function() {
    if (typeof document?.querySelectorAll !== 'function') return;
    document.querySelectorAll('[data-agent-config-open]').forEach(btn => {
        if (btn.dataset.boundAgentConfigOpen === '1') return;
        btn.dataset.boundAgentConfigOpen = '1';
        btn.addEventListener('click', () => openAgentConfigSection(btn.dataset.agentConfigOpen));
    });
    const closeBtn = document.getElementById('agent-config-modal-close');
    if (closeBtn && closeBtn.dataset.boundAgentConfigClose !== '1') {
        closeBtn.dataset.boundAgentConfigClose = '1';
        closeBtn.addEventListener('click', closeAgentConfigModal);
    }
    const modal = document.getElementById('agent-config-modal');
    if (modal && modal.dataset.boundAgentConfigOverlay !== '1') {
        modal.dataset.boundAgentConfigOverlay = '1';
    }
    const runDetailClose = document.getElementById('agent-run-detail-close');
    if (runDetailClose && runDetailClose.dataset.boundAgentRunDetailClose !== '1') {
        runDetailClose.dataset.boundAgentRunDetailClose = '1';
        runDetailClose.addEventListener('click', window.Pivot.legacy.closeAgentRunDetailModal);
    }
    const runDetailModal = document.getElementById('agent-run-detail-modal');
    if (runDetailModal && runDetailModal.dataset.boundAgentRunDetailOverlay !== '1') {
        runDetailModal.dataset.boundAgentRunDetailOverlay = '1';
    }
};

window.Pivot.legacy.bindUnifiedAutomationTabs?.();
window.Pivot.legacy.bindAgentWorkbenchShortcuts?.();
