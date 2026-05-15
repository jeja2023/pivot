/* Agent and MCP workbench */
let agentRunsCache = [];
let mcpServersCache = [];
let agentRefreshTimer = null;
let activeAgentRunId = '';

const agentEscape = (value) => escapeHtml(value === undefined || value === null ? '' : String(value));

function agentStatusLabel(status) {
    const map = {
        queued: '排队中',
        running: '运行中',
        completed: '已完成',
        error: '失败',
        cancelled: '已停止'
    };
    return map[status] || status || '-';
}

function isAgentRunActive(status) {
    return status === 'queued' || status === 'running';
}

function agentRunMeta(run) {
    const parts = [];
    if (run.model_name) parts.push(`模型 ${run.model_name}`);
    if (Number(run.tool_count || 0) > 0) parts.push(`工具 ${run.tool_count}`);
    if (Number(run.error_count || 0) > 0) parts.push(`错误 ${run.error_count}`);
    if (Number(run.step_count || 0) > 0) parts.push(`步骤 ${run.step_count}`);
    return parts.join(' · ');
}

const formatAgentAuditDate = (dateStr) => {
    if (!dateStr) return '-';
    if (typeof formatDateToCN === 'function') return formatDateToCN(dateStr);
    return String(dateStr);
};

function agentShortText(value, max = 260) {
    const text = String(value === undefined || value === null ? '' : value)
        .replace(/\s+/g, ' ')
        .trim();
    if (text.length <= max) return text;
    return `${text.slice(0, max)}...`;
}

function agentParsePayload(payload) {
    if (typeof payload !== 'string') return payload;
    const text = payload.trim();
    if (!text) return '';
    if (!text.startsWith('{') && !text.startsWith('[')) return text;
    try {
        return JSON.parse(text);
    } catch (e) {
        return text;
    }
}

function agentSummarizeInput(input) {
    const payload = agentParsePayload(input);
    if (!payload || typeof payload !== 'object') return agentShortText(payload || '');
    const parts = [];
    if (payload.query) parts.push(`查询：${payload.query}`);
    if (payload.limit) parts.push(`数量：${payload.limit}`);
    if (payload.topK) parts.push(`Top K：${payload.topK}`);
    if (payload.candidateLimit) parts.push(`候选：${payload.candidateLimit}`);
    return parts.join(' · ') || agentShortText(JSON.stringify(payload));
}

function agentStepPreview(step) {
    const payload = agentParsePayload(step.output || step.input || {});
    if (typeof payload === 'string') return agentShortText(payload, 500);
    if (Array.isArray(payload)) return `返回 ${payload.length} 条结果。`;
    if (!payload || typeof payload !== 'object') return agentShortText(payload || '');
    if (payload.answer) return payload.answer;
    if (payload.error) return payload.error;
    if (payload.thought || payload.action) {
        const lines = [];
        if (payload.thought) lines.push(`判断：${agentShortText(payload.thought, 220)}`);
        if (payload.action === 'tool') lines.push(`动作：调用 ${agentToolTitle(payload.tool)}`);
        if (payload.action === 'final') lines.push('动作：生成最终结果');
        if (payload.input) lines.push(`参数：${agentSummarizeInput(payload.input)}`);
        return lines.join('\n') || '已完成一次规划。';
    }
    if (Array.isArray(payload.matches)) {
        const scores = payload.matches
            .map(item => Number(item.score))
            .filter(score => Number.isFinite(score));
        const best = scores.length ? `，最高相关度 ${Math.max(...scores).toFixed(3)}` : '';
        const named = payload.matches.find(item => item.name || item.source || item.document_name);
        const source = named ? `，来源：${agentShortText(named.name || named.source || named.document_name, 80)}` : '';
        return `返回 ${payload.matches.length} 条匹配结果${best}${source}。`;
    }
    if (Array.isArray(payload.documents)) return `返回 ${payload.documents.length} 个知识库文档。`;
    if (Array.isArray(payload.sessions)) return `返回 ${payload.sessions.length} 条会话记录。`;
    if (Array.isArray(payload.models)) return `返回 ${payload.models.length} 个可用模型。`;
    if (payload.query) return `查询：${payload.query}`;
    if (payload.status) return `状态：${payload.status}`;
    return agentShortText(JSON.stringify(payload), 500);
}

function normalizeAgentMarkdown(text) {
    return String(text || '')
        .replace(/\*\*([^*\n]+?)：\s+\*\*/g, '**$1：**')
        .replace(/\*\*([^*\n]+?):\s+\*\*/g, '**$1:**');
}

function agentStepRawDetail(step, preview) {
    const payload = step.output || step.input;
    if (payload === undefined || payload === null) return '';
    const raw = typeof payload === 'string' ? payload.trim() : JSON.stringify(payload, null, 2);
    if (!raw || raw === preview) return '';
    return raw.length > 5000 ? `${raw.slice(0, 5000)}\n...` : raw;
}

function agentStepMarkup(step) {
    const preview = normalizeAgentMarkdown(agentStepPreview(step));
    const raw = agentStepRawDetail(step, preview);
    return `
        <div class="agent-step ${agentEscape(step.status)}">
            <div class="agent-step-head">
                <strong>${step.step_index}. ${agentEscape(agentStepTitle(step))}</strong>
                <span>${agentEscape(agentToolTitle(step.tool_name || step.type))} · ${Number(step.duration_ms || 0)} 毫秒</span>
            </div>
            <div class="agent-step-body">${renderMarkdown(agentEscape(preview))}</div>
            ${raw ? `<details class="agent-step-raw"><summary>查看原始数据</summary><pre>${agentEscape(raw)}</pre></details>` : ''}
        </div>
    `;
}

function agentModelCapabilityMarkup(model) {
    const textIcon = '<span class="cap-icon text" title="文本模型"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h10"/></svg></span>';
    if (!model) return textIcon;
    const hasVision = Number(model.supports_vision || 0) === 1 || model.capabilities?.includes?.('vision');
    const hasReasoning = Number(model.supports_reasoning || 0) === 1 || model.capabilities?.includes?.('reasoning');
    const icons = [textIcon];
    if (hasVision) icons.push('<span class="cap-icon vision" title="支持视觉输入"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg></span>');
    if (hasReasoning) icons.push('<span class="cap-icon reasoning" title="支持推理/思考"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M9 18h6"/><path d="M10 22h4"/><path d="M15 14c.2-1 .7-1.7 1.5-2.5A5 5 0 1 0 7.5 11.5C8.3 12.3 8.8 13 9 14"/></svg></span>');
    return icons.join('');
}

function updateAgentModelCaps() {
    const select = document.getElementById('agent-model-select');
    const caps = document.getElementById('agent-selected-model-caps');
    const name = document.getElementById('agent-selected-model-name');
    if (!select || !caps || !name) return;
    const model = (window._cachedModels || []).find(item => String(item.id) === String(select.value));
    name.textContent = model ? `${model.name}${model.user_id ? ' (个人)' : ''}` : '请选择模型';
    caps.innerHTML = agentModelCapabilityMarkup(model);
}

function setAgentModelListOpen(open) {
    const trigger = document.getElementById('agent-model-trigger');
    const list = document.getElementById('agent-model-list');
    if (!trigger || !list) return;
    trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
    list.classList.toggle('hidden', !open);
}

function selectAgentModel(id, close = true) {
    const select = document.getElementById('agent-model-select');
    if (!select) return;
    select.value = id;
    updateAgentModelCaps();
    document.querySelectorAll('[data-agent-model-id]').forEach(item => {
        const active = String(item.dataset.agentModelId) === String(id);
        item.classList.toggle('active', active);
        item.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    if (close) setAgentModelListOpen(false);
}

const agentToolDisplayMap = {
    'rag.search': { title: '知识库检索', description: '检索当前用户的知识库，返回按相关度排序的片段和来源文档。' },
    'sessions.search': { title: '会话检索', description: '按关键词检索当前用户的历史会话内容。' },
    'sessions.recent': { title: '最近会话', description: '列出当前用户最近的未删除会话。' },
    'knowledge.list': { title: '知识库文档', description: '列出当前用户的知识库文档及索引状态。' },
    'models.list': { title: '可用模型', description: '列出当前用户可以使用的模型。' },
    'system.health': { title: '系统健康', description: '查看数据库、存储、内存和磁盘健康状态。' },
    'system.modelRuntime': { title: '模型运行状态', description: '查看模型端点队列、熔断器和监控状态。' }
};

function agentToolTitle(tool) {
    const name = typeof tool === 'string' ? tool : tool?.name;
    if (String(name || '').startsWith('mcp.')) return '外部 MCP 工具';
    return tool?.title || agentToolDisplayMap[name]?.title || name || '工具';
}

function agentToolDescription(tool) {
    if (String(tool?.name || '').startsWith('mcp.')) return '来自外部 MCP 服务，可由自动化任务按需调用。';
    return agentToolDisplayMap[tool?.name]?.description || tool?.description || '';
}

function isAdminOnlyAgentTool(tool) {
    return Boolean(tool?.admin) || String(tool?.name || '').startsWith('system.');
}

function agentStepTitle(step) {
    const raw = step?.title || step?.type || '';
    if (raw === 'Planning') return '规划下一步';
    if (raw.startsWith('Tool failed: ')) return `工具调用失败：${agentToolTitle(raw.replace('Tool failed: ', ''))}`;
    if (raw.startsWith('Tool: ')) return `调用工具：${agentToolTitle(raw.replace('Tool: ', ''))}`;
    if (raw.startsWith('调用工具：')) return `调用工具：${agentToolTitle(raw.replace('调用工具：', ''))}`;
    if (raw.startsWith('工具调用失败：')) return `工具调用失败：${agentToolTitle(raw.replace('工具调用失败：', ''))}`;
    return raw || '执行步骤';
}

async function loadAgentModels() {
    const select = document.getElementById('agent-model-select');
    if (!select) return;
    const models = window._cachedModels || [];
    if (models.length === 0 && window.refreshModelSelector) await window.refreshModelSelector();
    const nextModels = window._cachedModels || [];
    select.innerHTML = nextModels
        .map(model => `<option value="${model.id}">${agentEscape(model.name)}${model.user_id ? ' (个人)' : ''}</option>`)
        .join('');
    const list = document.getElementById('agent-model-list');
    if (list) {
        list.innerHTML = nextModels.map(model => {
            const meta = [];
            meta.push(model.user_id ? '个人模型' : '全局模型');
            if (model.model_name && model.model_name !== model.name) meta.push(model.model_name);
            const title = typeof describeSelectorModel === 'function' ? describeSelectorModel(model, false) : model.name;
            return `
                <button type="button" role="option" class="agent-model-option" data-agent-model-id="${agentEscape(model.id)}" title="${agentEscape(title)}">
                    <span>
                        <strong>${agentEscape(model.name)}${model.user_id ? ' (个人)' : ''}</strong>
                        <small>${agentEscape(meta.join(' · '))}</small>
                    </span>
                    <span class="agent-model-caps">${agentModelCapabilityMarkup(model)}</span>
                </button>
            `;
        }).join('');
        list.querySelectorAll('[data-agent-model-id]').forEach(item => {
            item.addEventListener('click', () => selectAgentModel(item.dataset.agentModelId));
        });
    }
    const trigger = document.getElementById('agent-model-trigger');
    if (trigger && trigger.dataset.agentModelBound !== '1') {
        trigger.dataset.agentModelBound = '1';
        trigger.addEventListener('click', (event) => {
            event.stopPropagation();
            setAgentModelListOpen(document.getElementById('agent-model-list')?.classList.contains('hidden'));
        });
        document.addEventListener('click', (event) => {
            if (!event.target.closest('#agent-model-picker')) setAgentModelListOpen(false);
        });
    }
    if (select.dataset.agentCapsBound !== '1') {
        select.dataset.agentCapsBound = '1';
        select.addEventListener('change', () => selectAgentModel(select.value, false));
    }
    if (nextModels.length && !select.value) select.value = nextModels[0].id;
    selectAgentModel(select.value || nextModels[0]?.id || '', false);
}

async function loadAgentTools() {
    const list = document.getElementById('agent-tool-list');
    if (!list) return;
    const res = await apiFetch(`${API_BASE}/agents/tools`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '工具列表加载失败');
    const visibleTools = (data.tools || []).filter(tool => currentUser?.role === 'admin' || !isAdminOnlyAgentTool(tool));
    list.innerHTML = `
        ${visibleTools.map(tool => `
            <div class="agent-tool-chip ${isAdminOnlyAgentTool(tool) ? 'admin-tool' : ''}">
                <strong>
                    ${agentEscape(agentToolTitle(tool))}
                    ${isAdminOnlyAgentTool(tool) ? '<em>管理员</em>' : ''}
                </strong>
                <span>${agentEscape(agentToolDescription(tool))}</span>
            </div>
        `).join('') || '<div class="empty-state">暂无可用能力</div>'}
    `;
}

async function loadAgentRuns() {
    const list = document.getElementById('agent-runs-list');
    if (!list) return;
    const res = await apiFetch(`${API_BASE}/agents/runs?limit=30`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '任务列表加载失败');
    agentRunsCache = data.data || [];
    updateAgentAutoRefresh();
    if (agentRunsCache.length === 0) {
        list.innerHTML = '';
        activeAgentRunId = '';
        document.getElementById('agent-run-detail').innerHTML = `
            <div class="agent-empty-state agent-empty-hero">
                <strong>还没有自动化任务</strong>
                <span>在左侧输入目标并点击运行后，这里会显示任务记录、执行步骤和最终结果。</span>
            </div>
        `;
        return;
    }
    const hasSelectedRun = activeAgentRunId && agentRunsCache.some(run => run.id === activeAgentRunId);
    const selectedRunId = hasSelectedRun ? activeAgentRunId : agentRunsCache[0].id;
    list.innerHTML = agentRunsCache.map(run => `
        <button class="agent-run-item ${run.id === selectedRunId ? 'active' : ''}" data-agent-run-id="${agentEscape(run.id)}" ${run.id === selectedRunId ? 'aria-current="true"' : ''} title="${agentEscape(run.title || run.goal)}">
            <span class="agent-run-status ${agentEscape(run.status)}">${agentStatusLabel(run.status)}</span>
            <strong>${agentEscape(run.title || run.goal)}</strong>
            <small>${agentEscape(formatDateToCN(run.created_at))}</small>
            ${agentRunMeta(run) ? `<em>${agentEscape(agentRunMeta(run))}</em>` : ''}
        </button>
    `).join('');
    list.querySelectorAll('[data-agent-run-id]').forEach(btn => {
        btn.addEventListener('click', () => window.openAgentRun(btn.dataset.agentRunId));
    });
    if (!hasSelectedRun || !document.getElementById('agent-run-detail')?.innerHTML.trim()) {
        await window.openAgentRun(selectedRunId);
    }
}

window.openAgentRun = async function(runId) {
    activeAgentRunId = runId;
    const detail = document.getElementById('agent-run-detail');
    if (!detail) return;
    document.querySelectorAll('[data-agent-run-id]').forEach(btn => {
        const active = btn.dataset.agentRunId === runId;
        btn.classList.toggle('active', active);
        if (active) btn.setAttribute('aria-current', 'true');
        else btn.removeAttribute('aria-current');
    });
    detail.innerHTML = '<div class="empty-state agent-empty-state">正在加载任务详情...</div>';
    const res = await apiFetch(`${API_BASE}/agents/runs/${encodeURIComponent(runId)}`);
    const data = await res.json();
    if (!res.ok) {
        detail.innerHTML = `<div class="empty-state agent-empty-state">${agentEscape(data.error || '加载失败')}</div>`;
        return;
    }
    const run = data.run;
    const steps = data.steps || [];
    const progress = data.progress || {};
    const canCancel = isAgentRunActive(run.status);
    const canRerun = !isAgentRunActive(run.status);
    const canDelete = !isAgentRunActive(run.status);
    detail.innerHTML = `
        <div class="agent-progress-summary">
            <div class="agent-progress-bar"><span style="width: ${Math.max(0, Math.min(Number(progress.percent || 0), 100))}%"></span></div>
            <div class="agent-progress-meta">
                <span>步骤 ${Number(progress.stepCount || 0)} / ${Number(progress.maxSteps || run.max_steps || 0)}</span>
                <span>工具 ${Number(progress.toolCount || 0)}</span>
                <span>错误 ${Number(progress.errorCount || 0)}</span>
                <span>耗时 ${Number(progress.totalDurationMs || 0)} 毫秒</span>
                ${canCancel ? `<button class="btn-danger-outline" data-agent-cancel="${agentEscape(run.id)}">停止</button>` : ''}
                ${canRerun ? `<button class="btn-secondary" data-agent-rerun="${agentEscape(run.id)}">重新运行</button>` : ''}
                ${canDelete ? `<button class="btn-danger-outline" data-agent-delete="${agentEscape(run.id)}">移除记录</button>` : ''}
            </div>
        </div>
        ${run.final_answer ? `<div class="agent-final">${renderMarkdown(normalizeAgentMarkdown(run.final_answer))}</div>` : ''}
        ${run.error_message ? `<div class="error-detail">${agentEscape(run.error_message)}</div>` : ''}
        <div class="agent-step-list">
            ${steps.map(step => agentStepMarkup(step)).join('') || '<div class="empty-state agent-empty-state">任务还没有执行步骤。</div>'}
        </div>
    `;
    detail.querySelector('[data-agent-cancel]')?.addEventListener('click', () => window.cancelAgentRun(run.id));
    detail.querySelector('[data-agent-rerun]')?.addEventListener('click', () => window.rerunAgentRun(run.id));
    detail.querySelector('[data-agent-delete]')?.addEventListener('click', () => window.deleteAgentRun(run.id));
};

function ensureAgentAuditModal() {
    let modal = document.getElementById('agent-audit-modal');
    if (modal) return modal;
    modal = document.createElement('div');
    modal.id = 'agent-audit-modal';
    modal.className = 'modal-overlay hidden rag-detail-modal-overlay';
    modal.innerHTML = `
        <div class="modal rag-detail-modal agent-audit-modal">
            <div class="rag-detail-header">
                <div>
                    <h3>自动化删除审计</h3>
                    <p class="model-modal-desc">仅 admin 超级管理员可查看，普通用户移除的任务记录会保留在这里。</p>
                </div>
                <button type="button" id="agent-audit-close-btn" class="btn-danger-outline">关闭</button>
            </div>
            <div class="table-container rag-audit-table-wrap agent-audit-table-wrap">
                <table class="data-table compact-table">
                    <thead>
                        <tr>
                            <th style="width: 52px;" class="text-center">序号</th>
                            <th>任务</th>
                            <th style="width: 120px;">用户</th>
                            <th style="width: 90px;">状态</th>
                            <th style="width: 150px;">模型</th>
                            <th style="width: 115px;">统计</th>
                            <th style="width: 155px;">删除时间</th>
                            <th style="width: 120px;">删除人</th>
                        </tr>
                    </thead>
                    <tbody id="agent-audit-body"></tbody>
                </table>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    modal.addEventListener('click', (event) => {
        if (event.target === modal || event.target.closest('#agent-audit-close-btn')) {
            modal.classList.add('hidden');
        }
    });
    return modal;
}

function renderAgentAuditRows(items = []) {
    if (!items.length) {
        return '<tr><td colspan="8" class="text-center muted-text">暂无已移除的自动化任务记录</td></tr>';
    }
    return items.map((item, index) => {
        const userName = item.nickname || item.username || `用户 ${item.user_id || '-'}`;
        const deletedBy = item.deleted_by_nickname || item.deleted_by_username || `用户 ${item.deleted_by_user || '-'}`;
        const stats = `步骤 ${Number(item.step_count || 0)} / 工具 ${Number(item.tool_count || 0)} / 错误 ${Number(item.error_count || 0)}`;
        return `
            <tr>
                <td class="text-center">${index + 1}</td>
                <td title="${agentEscape(item.goal || item.title)}">
                    <strong>${agentEscape(item.title || item.goal || '-')}</strong>
                    <small>${agentEscape(agentShortText(item.goal || '', 90))}</small>
                </td>
                <td>${agentEscape(userName)}</td>
                <td>${agentEscape(agentStatusLabel(item.status))}</td>
                <td title="${agentEscape(item.model_name || '')}">${agentEscape(item.model_name || '-')}</td>
                <td>${agentEscape(stats)}</td>
                <td>${agentEscape(formatAgentAuditDate(item.deleted_at))}</td>
                <td>${agentEscape(deletedBy)}</td>
            </tr>
        `;
    }).join('');
}

function updateAgentAutoRefresh() {
    const modalOpen = !document.getElementById('agent-workbench-modal')?.classList.contains('hidden');
    const hasActiveRun = agentRunsCache.some(run => isAgentRunActive(run.status));
    if (agentRefreshTimer && (!modalOpen || !hasActiveRun)) {
        clearInterval(agentRefreshTimer);
        agentRefreshTimer = null;
    }
    if (!agentRefreshTimer && modalOpen && hasActiveRun) {
        agentRefreshTimer = setInterval(async () => {
            try {
                await loadAgentRuns();
                if (activeAgentRunId) await window.openAgentRun(activeAgentRunId);
            } catch (e) {}
        }, 3000);
    }
}

window.createAgentRun = async function() {
    const goal = document.getElementById('agent-goal-input')?.value.trim();
    const modelId = document.getElementById('agent-model-select')?.value;
    const maxSteps = document.getElementById('agent-max-steps')?.value || 5;
    if (!goal) return showToast('请输入自动化目标', 'error');
    if (!modelId) return showToast('请选择模型', 'error');
    const res = await apiFetch(`${API_BASE}/agents/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ goal, modelId, maxSteps, sessionId: window.currentSessionId || null })
    });
    const data = await res.json();
    if (!res.ok) return showToast(data.error || '创建任务失败', 'error');
    showToast('自动化任务已启动', 'success');
    document.getElementById('agent-goal-input').value = '';
    await loadAgentRuns();
    await window.openAgentRun(data.run.id);
};

window.cancelAgentRun = function(runId) {
    showConfirm('停止自动化任务', '确定停止这个正在执行的自动化任务吗？', async () => {
        const res = await apiFetch(`${API_BASE}/agents/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) return showToast(data.error || '停止失败', 'error');
        showToast('自动化任务已停止', 'success');
        await loadAgentRuns();
        const stillExists = agentRunsCache.some(run => run.id === runId);
        if (stillExists) await window.openAgentRun(runId);
    });
};

window.rerunAgentRun = async function(runId) {
    const res = await apiFetch(`${API_BASE}/agents/runs/${encodeURIComponent(runId)}/rerun`, { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return showToast(data.error || '重新运行失败', 'error');
    showToast('已创建新的自动化任务', 'success');
    await loadAgentRuns();
    await window.openAgentRun(data.run.id);
};

window.deleteAgentRun = function(runId) {
    showConfirm('移除自动化任务记录', '确定从任务列表移除这条自动化任务记录吗？记录会保留给超级管理员审计。', async () => {
        const res = await apiFetch(`${API_BASE}/agents/runs/${encodeURIComponent(runId)}`, { method: 'DELETE' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) return showToast(data.error || '移除记录失败', 'error');
        showToast('自动化任务记录已移除', 'success');
        activeAgentRunId = '';
        const detail = document.getElementById('agent-run-detail');
        if (detail) detail.innerHTML = '';
        await loadAgentRuns();
    });
};

window.showAgentRunAudit = async function() {
    if (currentUser?.username !== 'admin') {
        showToast('仅 admin 超级管理员可查看自动化删除审计', 'error');
        return;
    }
    try {
        const res = await apiFetch(`${API_BASE}/agents/runs/deleted/audit?limit=100`);
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.error) throw new Error(data.error || '删除审计加载失败');
        const modal = ensureAgentAuditModal();
        const body = modal.querySelector('#agent-audit-body');
        if (body) body.innerHTML = renderAgentAuditRows(data.data || []);
        modal.classList.remove('hidden');
    } catch (e) {
        showToast(e.message || '删除审计加载失败', 'error');
    }
};

window.loadAgentWorkbench = async function() {
    try {
        await loadAgentModels();
        await Promise.all([loadAgentTools(), loadAgentRuns()]);
    } catch (e) {
        showToast(e.message, 'error');
    }
};

window.openAgentWorkbench = async function() {
    const modal = document.getElementById('agent-workbench-modal');
    if (!modal) return;
    modal.classList.remove('hidden');
    modal.querySelectorAll('.admin-root-only').forEach(el => {
        el.classList.toggle('hidden', currentUser?.username !== 'admin');
    });
    await window.loadAgentWorkbench();
};

window.closeAgentWorkbench = function() {
    document.getElementById('agent-workbench-modal')?.classList.add('hidden');
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
            input.focus();
        });
    });
};

window.openMcpWorkbench = async function() {
    const modal = document.getElementById('mcp-workbench-modal');
    if (!modal) return;
    modal.classList.remove('hidden');
    document.querySelectorAll('#mcp-workbench-modal .admin-only').forEach(el => {
        el.classList.toggle('hidden', currentUser?.username !== 'admin');
    });
    await window.loadMcpWorkbench?.();
};

window.closeMcpWorkbench = function() {
    document.getElementById('mcp-workbench-modal')?.classList.add('hidden');
};

window.resetMcpForm = function() {
    ['mcp-id', 'mcp-name', 'mcp-url', 'mcp-key', 'mcp-desc'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
    const shared = document.getElementById('mcp-shared');
    if (shared) shared.checked = false;
};

function fillMcpForm(server) {
    document.getElementById('mcp-id').value = server.id || '';
    document.getElementById('mcp-name').value = server.name || '';
    document.getElementById('mcp-url').value = server.base_url || '';
    document.getElementById('mcp-key').value = server.has_api_key ? '********' : '';
    document.getElementById('mcp-desc').value = server.description || '';
    const shared = document.getElementById('mcp-shared');
    if (shared) shared.checked = !server.user_id;
}

async function loadMcpServers() {
    const list = document.getElementById('mcp-server-list');
    if (!list) return;
    const res = await apiFetch(`${API_BASE}/mcp/servers`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'MCP 服务加载失败');
    mcpServersCache = data.data || [];
    if (mcpServersCache.length === 0) {
        list.innerHTML = '<div class="empty-state">还没有 MCP 服务</div>';
        return;
    }
    list.innerHTML = mcpServersCache.map(server => `
        <div class="mcp-server-card">
            <div>
                <strong>${agentEscape(server.name)}</strong>
                <span>${agentEscape(server.base_url)}</span>
                ${server.last_error ? `<small class="error-text">${agentEscape(server.last_error)}</small>` : `<small>${server.last_checked_at ? `上次刷新 ${agentEscape(formatDateToCN(server.last_checked_at))}` : '尚未刷新工具'}</small>`}
            </div>
            <div class="mcp-card-actions">
                <button class="btn-secondary" data-mcp-edit="${server.id}">编辑</button>
                <button class="btn-secondary" data-mcp-refresh="${server.id}">工具</button>
                <button class="btn-danger-outline" data-mcp-delete="${server.id}">删除</button>
            </div>
        </div>
    `).join('');
    list.querySelectorAll('[data-mcp-edit]').forEach(btn => btn.addEventListener('click', () => {
        const server = mcpServersCache.find(item => String(item.id) === String(btn.dataset.mcpEdit));
        if (server) fillMcpForm(server);
    }));
    list.querySelectorAll('[data-mcp-refresh]').forEach(btn => btn.addEventListener('click', () => window.refreshMcpTools(btn.dataset.mcpRefresh)));
    list.querySelectorAll('[data-mcp-delete]').forEach(btn => btn.addEventListener('click', () => window.deleteMcpServer(btn.dataset.mcpDelete)));
}

async function loadMcpTools() {
    const box = document.getElementById('mcp-tool-cache');
    if (!box) return;
    const res = await apiFetch(`${API_BASE}/mcp/tools`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'MCP 工具加载失败');
    const tools = data.tools || [];
    box.innerHTML = `
        <div class="agent-tool-title">外部 MCP 工具 ${tools.length}</div>
        ${tools.map(tool => `
            <div class="agent-tool-chip">
                <strong>${agentEscape(tool.fullName)}</strong>
                <span>${agentEscape(tool.description || tool.serverName || '')}</span>
            </div>
        `).join('') || '<div class="empty-state">刷新 MCP 服务后会显示工具</div>'}
    `;
}

window.saveMcpServer = async function() {
    const id = document.getElementById('mcp-id')?.value;
    const payload = {
        name: document.getElementById('mcp-name')?.value.trim(),
        base_url: document.getElementById('mcp-url')?.value.trim(),
        api_key: document.getElementById('mcp-key')?.value,
        description: document.getElementById('mcp-desc')?.value.trim(),
        shared: document.getElementById('mcp-shared')?.checked || false
    };
    if (!payload.name || !payload.base_url) return showToast('请填写服务名称和 URL', 'error');
    const res = await apiFetch(`${API_BASE}/mcp/servers${id ? `/${encodeURIComponent(id)}` : ''}`, {
        method: id ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok) return showToast(data.error || '保存失败', 'error');
    showToast('MCP 服务已保存', 'success');
    window.resetMcpForm();
    await window.loadMcpWorkbench();
};

window.refreshMcpTools = async function(id) {
    const res = await apiFetch(`${API_BASE}/mcp/servers/${encodeURIComponent(id)}/refresh`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) return showToast(data.error || '刷新失败', 'error');
    showToast(`已刷新 ${data.tools.length} 个工具`, 'success');
    await window.loadMcpWorkbench();
};

window.deleteMcpServer = function(id) {
    showConfirm('删除 MCP 服务', '确定删除这个 MCP 服务吗？', async () => {
        const res = await apiFetch(`${API_BASE}/mcp/servers/${encodeURIComponent(id)}`, { method: 'DELETE' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) return showToast(data.error || '删除失败', 'error');
        showToast('MCP 服务已删除', 'success');
        await window.loadMcpWorkbench();
    });
};

window.loadMcpWorkbench = async function() {
    try {
        await Promise.all([loadMcpServers(), loadMcpTools()]);
    } catch (e) {
        showToast(e.message, 'error');
    }
};
