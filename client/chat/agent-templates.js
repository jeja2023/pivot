// Agent 模板管理
// 拆自 agents.js。
/* eslint-disable no-undef */
function applyAgentTemplate(template) {
    if (!template) return;
    const goalInput = document.getElementById('agent-goal-input');
    if (goalInput) goalInput.value = template.goal_template || '';
    const titleInput = document.getElementById('agent-title-input');
    if (titleInput) titleInput.value = template.name || '';
    const runMode = document.getElementById('agent-run-mode');
    const templateRunMode = ['standard', 'deep', 'audit'].includes(template.run_mode) ? template.run_mode : 'standard';
    if (runMode) runMode.value = templateRunMode;
    const allowMcp = document.getElementById('agent-allow-mcp');
    if (allowMcp) allowMcp.checked = template.tool_policy !== 'builtin_only';
    const approval = document.getElementById('agent-approval-policy');
    if (approval) approval.value = template.approval_policy || 'safe_mcp_auto';
    const router = document.getElementById('agent-model-router');
    if (router) router.value = template.model_router || 'fixed';
    const steps = document.getElementById('agent-max-steps');
    const templateMaxSteps = Number(template.max_steps || 0);
    if (steps) steps.value = templateMaxSteps > 0 ? String(templateMaxSteps) : '';
    window.syncAgentRunModeStepLimit?.();
    const budget = document.getElementById('agent-token-budget');
    if (budget) budget.value = template.max_token_budget || '';
    const retry = document.getElementById('agent-retry-limit');
    if (retry) retry.value = template.retry_limit || 1;
    const context = agentParsePayload(template.context_config || '{}') || {};
    const contextMode = document.getElementById('agent-context-mode');
    if (contextMode) contextMode.value = context.mode || 'auto';
    const contextNotes = document.getElementById('agent-context-notes');
    if (contextNotes) contextNotes.value = context.notes || '';
    const allowlist = agentParsePayload(template.tool_allowlist || '[]');
    const selectedTools = Array.isArray(allowlist) ? allowlist.map(item => String(item || '').trim()).filter(Boolean) : [];
    document.querySelectorAll('[data-agent-tool-allow]').forEach(input => {
        input.checked = selectedTools.length === 0 ? true : selectedTools.includes(input.dataset.agentToolAllow);
    });
    showToast('模板已应用', 'success');
}

async function loadAgentTemplates() {
    const list = document.getElementById('agent-template-list');
    if (!list) return;
    const res = await apiFetch(`${API_BASE}/agents/templates`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '模板库加载失败');
    agentTemplatesCache = data.data || [];
    PivotSafeHtml.setHtml(list, agentTemplatesCache.length ? agentTemplatesCache.slice(0, 8).map(template => `
        <div class="agent-template-item" title="${agentEscape(template.description || template.goal_template)}">
            <button type="button" class="agent-template-apply" data-agent-template-id="${agentEscape(template.id)}">
                <strong>${agentEscape(template.name)}</strong>
                <span>${agentEscape(template.scope === 'shared' ? '共享' : '个人')}</span>
            </button>
            ${template.scope === 'personal' ? `<button type="button" class="agent-mini-danger" data-agent-template-delete="${agentEscape(template.id)}">删除</button>` : ''}
        </div>
    `).join('') : '<div class="empty-state agent-empty-state compact">暂无模板</div>');
    list.querySelectorAll('[data-agent-template-id]').forEach(btn => {
        btn.addEventListener('click', () => applyAgentTemplate(agentTemplatesCache.find(item => String(item.id) === String(btn.dataset.agentTemplateId))));
    });
    list.querySelectorAll('[data-agent-template-delete]').forEach(btn => {
        btn.addEventListener('click', () => deleteAgentTemplate(btn.dataset.agentTemplateDelete));
    });
}

async function saveCurrentAgentTemplate() {
    const payload = getAgentRunPayload();
    if (!payload.goal) return showToast('请先填写自主任务目标', 'error');
    if (payload._invalid) return;
    try {
        const suggestedName = payload.goal.slice(0, 24);
        const promptFn = window['showInputPrompt'];
        const value = typeof promptFn === 'function'
            ? await promptFn({
                title: '保存为模板',
                message: '填写模板名称，当前任务目标和执行设置会一并保存。',
                value: suggestedName,
                placeholder: '例如：项目风险总结',
                requiredMessage: '请填写模板名称'
            })
            : window.prompt('模板名称', suggestedName);
        if (value === null || value === undefined) return;
        const name = String(value || '').trim().slice(0, 80);
        if (!name) return showToast('请填写模板名称', 'error');
        const res = await apiFetch(`${API_BASE}/agents/templates`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name,
                goalTemplate: payload.goal,
                description: '从自主任务创建器保存，用于复用目标、参数和上下文设置。',
                ...payload
            })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '保存模板失败');
        showToast('自主任务模板已保存', 'success');
        await loadAgentTemplates();
    } catch (error) {
        showToast(error.message || '保存模板失败', 'error');
    }
}

function deleteAgentTemplate(templateId) {
    showConfirm('删除自主任务模板', '确定删除这个自主任务模板吗？已创建的任务记录不会受影响。', async () => {
        const res = await apiFetch(`${API_BASE}/agents/templates/${encodeURIComponent(templateId)}`, { method: 'DELETE' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) return showToast(data.error || '删除模板失败', 'error');
        showToast('模板已删除', 'success');
        await loadAgentTemplates();
    });
}
