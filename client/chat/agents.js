// Split from agents.js.
/* eslint-disable no-undef */
let agentRunsCache = [];

let agentRefreshTimer = null;

let activeAgentRunId = '';

let agentToolsCache = [];

let agentTemplatesCache = [];

let agentSchedulesCache = [];

let agentArtifactsCache = [];

let capabilityPackagesCache = [];

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

const agentEscapeAttr = (value) => window.PivotSafeHtml?.escapeAttr
    ? window.PivotSafeHtml.escapeAttr(value)
    : agentEscape(value).replace(/"/g, '&quot;');

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
    return goal || '自由任务';
}

function agentPreviewDisplayTitle(value) {
    let text = String(value || '').trim();
    while (/^预览运行\s*[:：]\s*/.test(text)) {
        text = text.replace(/^预览运行\s*[:：]\s*/, '').trim();
    }
    return text || '预览运行';
}

window.loadAgentWorkbench = async function() {
    try {
        await loadAgentModels();
        await Promise.all([
            loadCapabilityPackages(),
            loadAgentModelRouters(),
            loadAgentTools(),
            loadAgentRuns(),
            loadAgentRuntimeStatus(),
            loadAgentMetrics(),
            loadAgentTemplates(),
            loadAgentSchedules(),
            loadAgentNotifications(),
            loadAgentArtifacts()
        ]);
    } catch (e) {
        showToast(e.message, 'error');
    }
};

window.openAgentWorkbench = async function() {
    window.showMainWorkspace?.('agent');
    const panel = document.getElementById('agent-workbench-modal');
    if (!panel) return;
    panel.querySelectorAll('.admin-root-only').forEach(el => {
        el.classList.toggle('hidden', !isSuperAdminUser());
    });
    await window.loadAgentWorkbench();
    window.bindAgentFilters?.();
    window.bindAgentEnterpriseControls?.();
    window.bindAgentConfigModal?.();
};

window.closeAgentWorkbench = function() {
    closeAgentConfigModal();
    closeAgentRunDetailModal();
    window.showMainWorkspace?.('chat');
    updateAgentAutoRefresh();
};

window.bindAgentGoalTemplates = function() {
    document.querySelectorAll('[data-agent-goal-template]').forEach(btn => {
        if (btn.dataset.boundAgentTemplate === '1') return;
        btn.dataset.boundAgentTemplate = '1';
        btn.addEventListener('click', () => {
            const input = document.getElementById('agent-goal-input');
            if (!input) return;
            input.value = btn.dataset.agentGoalTemplate || '';
            if (btn.dataset.agentRunMode) {
                const mode = document.getElementById('agent-run-mode');
                if (mode) mode.value = btn.dataset.agentRunMode;
            }
            if (btn.dataset.agentMcp) {
                const allowMcp = document.getElementById('agent-allow-mcp');
                if (allowMcp) allowMcp.checked = btn.dataset.agentMcp === 'true';
            }
            input.focus();
        });
    });
};

window.bindAgentFilters = function() {
    ['agent-filter-status', 'agent-filter-run-type', 'agent-filter-query'].forEach(id => {
        const el = document.getElementById(id);
        if (!el || el.dataset.boundAgentFilter === '1') return;
        el.dataset.boundAgentFilter = '1';
        const reloadFirstPage = () => loadAgentRuns(1).catch(err => showToast(err.message || '任务列表刷新失败', 'error'));
        // 文本输入防抖，避免逐键触发请求风暴与响应乱序覆盖；下拉 change 保持即时
        const debouncedReload = window.Pivot && typeof window.Pivot.debounce === 'function'
            ? window.Pivot.debounce(reloadFirstPage, 280)
            : reloadFirstPage;
        el.addEventListener('input', debouncedReload);
        el.addEventListener('change', reloadFirstPage);
    });
};

window.bindAgentEnterpriseControls = function() {
    document.querySelectorAll('[data-agent-save-template]').forEach(saveTemplateBtn => {
        if (saveTemplateBtn.dataset.boundAgentTemplateSave === '1') return;
        saveTemplateBtn.dataset.boundAgentTemplateSave = '1';
        saveTemplateBtn.addEventListener('click', saveCurrentAgentTemplate);
    });
    const frequency = document.getElementById('agent-schedule-frequency');
    const weekday = document.getElementById('agent-schedule-weekday');
    if (frequency && frequency.dataset.boundAgentSchedule !== '1') {
        frequency.dataset.boundAgentSchedule = '1';
        const update = () => weekday?.classList.toggle('is-disabled', frequency.value !== 'weekly');
        frequency.addEventListener('change', update);
        update();
    }
};

const agentConfigSectionTitles = {
    templates: '模板与计划',
    results: '能力与结果'
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
}

function openAgentConfigSection(sectionKey) {
    const section = document.querySelector(`[data-agent-config-section="${CSS.escape(sectionKey)}"]`);
    const modal = document.getElementById('agent-config-modal');
    const body = document.getElementById('agent-config-modal-body');
    const title = document.getElementById('agent-config-modal-title');
    if (!section || !modal || !body) return;
    closeAgentConfigModal();
    activeAgentConfigSection = sectionKey;
    modal.dataset.agentConfigSection = sectionKey;
    if (title) title.textContent = agentConfigSectionTitles[sectionKey] || '智能体配置';
    section.open = true;
    body.appendChild(section);
    modal.classList.remove('hidden');
    if (sectionKey === 'advanced') {
        mountAgentDagEditor();
        setTimeout(() => window.refreshAgentDagEditor?.(), 50);
    }
}

window.closeAgentConfigModal = closeAgentConfigModal;

window.openAgentConfigSection = openAgentConfigSection;

window.bindAgentConfigModal = function() {
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
        modal.addEventListener('click', event => {
            if (event.target === modal) closeAgentConfigModal();
        });
    }
    const runDetailClose = document.getElementById('agent-run-detail-close');
    if (runDetailClose && runDetailClose.dataset.boundAgentRunDetailClose !== '1') {
        runDetailClose.dataset.boundAgentRunDetailClose = '1';
        runDetailClose.addEventListener('click', closeAgentRunDetailModal);
    }
    const runDetailModal = document.getElementById('agent-run-detail-modal');
    if (runDetailModal && runDetailModal.dataset.boundAgentRunDetailOverlay !== '1') {
        runDetailModal.dataset.boundAgentRunDetailOverlay = '1';
        runDetailModal.addEventListener('click', event => {
            if (event.target === runDetailModal) closeAgentRunDetailModal();
        });
    }
    document.querySelectorAll('#agent-open-dag-btn').forEach(btn => {
        if (btn.dataset.boundAgentDagOpen === '1') return;
        btn.dataset.boundAgentDagOpen = '1';
        btn.addEventListener('click', () => window.openAgentDagWorkbench?.());
    });
};
