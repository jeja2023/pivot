/* eslint-disable no-undef, no-unused-vars */
// Agent 运行加载器 Agent run loaders
// Split from agent-runs-list.js.
// Agent run model/tool loaders and run list rendering.
async function loadAgentModels() {
    const loaded = typeof window.loadSelectableModels === 'function'
        ? await window.loadSelectableModels()
        : { models: [], defaultModelId: '' };
    const defaultModelId = loaded.defaultModelId || '';
    const canSelectModel = typeof window.isSelectableModelForCurrentUser === 'function'
        ? window.isSelectableModelForCurrentUser
        : (model => !model?.user_id || String(model.user_id) === String(currentUser?.id));
    const nextModels = (loaded.models || []).filter(model => model.type !== 'embedding' && canSelectModel(model));
    window._cachedAgentModels = nextModels;
    const optionHtml = nextModels
        .map(model => `<option value="${model.id}">${agentEscape(model.name)}${model.user_id ? ' (个人)' : ''}</option>`)
        .join('');
    const mainSelectedId = document.getElementById('model-selector')?.value || '';
    const initialId = (mainSelectedId && nextModels.some(model => String(model.id) === String(mainSelectedId)))
        ? mainSelectedId
        : (defaultModelId && nextModels.some(model => String(model.id) === String(defaultModelId)))
            ? defaultModelId
            : (nextModels[0]?.id || '');

    const select = document.getElementById('agent-model-select');
    if (select) {
        const previousId = select.value;
        select.innerHTML = optionHtml;
        select.value = nextModels.some(model => String(model.id) === String(previousId)) ? previousId : initialId;
    }
    const list = document.getElementById('agent-model-list');
    if (list) {
        list.innerHTML = nextModels.length ? nextModels.map(model => {
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
        }).join('') : '<div class="agent-model-option is-empty">暂无可用于智能体的模型</div>';
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
    if (select && select.dataset.agentCapsBound !== '1') {
        select.dataset.agentCapsBound = '1';
        select.addEventListener('change', () => selectAgentModel(select.value, false));
    }
    if (select) selectAgentModel(select.value || initialId, false);
}

async function _loadAgentModelsLegacy() {
    const select = document.getElementById('agent-model-select');
    if (!select) return;
    const res = await apiFetch(`${API_BASE}/models/available`);
    if (!res.ok) throw new Error('智能体模型列表加载失败');
    const canSelectModel = typeof window.isSelectableModelForCurrentUser === 'function'
        ? window.isSelectableModelForCurrentUser
        : (model => !model?.user_id || String(model.user_id) === String(currentUser?.id));
    const nextModels = (await res.json()).filter(model => model.type !== 'embedding' && canSelectModel(model));
    window._cachedAgentModels = nextModels;
    select.innerHTML = nextModels
        .map(model => `<option value="${model.id}">${agentEscape(model.name)}${model.user_id ? ' (个人)' : ''}</option>`)
        .join('');
    const list = document.getElementById('agent-model-list');
    if (list) {
        list.innerHTML = nextModels.length ? nextModels.map(model => {
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
        }).join('') : '<div class="agent-model-option is-empty">暂无可用于智能体的模型</div>';
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

async function loadAgentModelRouters() {
    const select = document.getElementById('agent-model-router');
    if (!select) return;
    const current = select.value || 'fixed';
    try {
        const res = await apiFetch(`${API_BASE}/agents/model-routers`);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '模型路由加载失败');
        const strategies = Array.isArray(data.strategies) ? data.strategies : [];
        if (!strategies.length) return;
        select.innerHTML = strategies.map(strategy => `
            <option value="${agentEscape(strategy.code)}" title="${agentEscape(strategy.description || '')}">
                ${agentEscape(strategy.label || strategy.code)}
            </option>
        `).join('');
        select.value = strategies.some(strategy => String(strategy.code) === String(current)) ? current : 'fixed';
    } catch (e) {
        // 保留 HTML 中的默认策略，避免路由接口异常影响智能体工作台打开。
    }
}

async function loadAgentTools() {
    const list = document.getElementById('agent-tool-list');
    const res = await apiFetch(`${API_BASE}/agents/tools`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '工具列表加载失败');
    const seenToolKeys = new Set();
    const visibleTools = (data.tools || [])
        .filter(tool => isSuperAdminUser() || !isAdminOnlyAgentTool(tool))
        .filter(tool => {
            const key = String(tool?.name || `${tool?.source || ''}:${tool?.title || ''}:${tool?.description || ''}`);
            if (!key || seenToolKeys.has(key)) return false;
            seenToolKeys.add(key);
            return true;
        });
    agentToolsCache = visibleTools;
    if (dagEditorInstance) {
        window.refreshAgentDagEditor?.();
    } else {
        mountAgentDagEditor();
    }
    if (!list) return;
    list.innerHTML = `
        ${visibleTools.map(tool => {
            const title = agentToolTitle(tool);
            const description = agentToolDescription(tool);
            const tags = [
                isAdminOnlyAgentTool(tool) ? '管理员' : '',
                tool.source === 'mcp' ? '能力库' : '系统',
                tool.requiresApproval ? '需审批' : ''
            ].filter(Boolean);
            const tooltip = [
                title,
                description,
                tags.length ? `标签：${tags.join(' / ')}` : ''
            ].filter(Boolean).join('\n');
            return `
            <label class="agent-tool-chip agent-tool-select ${isAdminOnlyAgentTool(tool) ? 'admin-tool' : ''}" title="${agentEscape(tooltip)}">
                <input type="checkbox" data-agent-tool-allow="${agentEscape(tool.name)}" checked>
                <strong>
                    ${agentEscape(title)}
                    ${tags.map(tag => `<em>${agentEscape(tag)}</em>`).join('')}
                </strong>
                <span>${agentEscape(description)}</span>
            </label>
        `;
        }).join('') || '<div class="empty-state">暂无可用能力</div>'}
    `;
}

async function loadCapabilityPackages() {
    const list = document.getElementById('agent-capability-list');
    if (!list) return;
    const res = await apiFetch(`${API_BASE}/capabilities/packages`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '能力市场加载失败');
    capabilityPackagesCache = data.data || [];
    const visible = capabilityPackagesCache.slice(0, 12);
    list.innerHTML = visible.length ? visible.map(item => `
        <label class="agent-capability-item ${item.enabled ? 'enabled' : 'disabled'}">
            <input type="checkbox" data-capability-key="${agentEscape(item.package_key)}" ${item.enabled ? 'checked' : ''}>
            <span>
                <strong>${agentEscape(agentCleanCapabilityName(item.name))}</strong>
                <small>${agentEscape(agentCapabilityTypeLabel(item.type))}</small>
            </span>
        </label>
    `).join('') : '<div class="empty-state compact">暂无能力包</div>';
    list.querySelectorAll('[data-capability-key]').forEach(input => {
        input.addEventListener('change', async () => {
            const res = await apiFetch(`${API_BASE}/capabilities/packages/${encodeURIComponent(input.dataset.capabilityKey)}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled: input.checked })
            });
            const result = await res.json().catch(() => ({}));
            if (!res.ok) {
                input.checked = !input.checked;
                return showToast(result.error || '能力包状态更新失败', 'error');
            }
            showToast(input.checked ? '能力包已启用' : '能力包已停用', 'success');
            await loadAgentTools();
        });
    });
}

async function loadAgentRuntimeStatus() {
    const target = document.getElementById('agent-runtime-status');
    if (!target) return;
    const res = await apiFetch(`${API_BASE}/agents/runtime`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        target.innerHTML = '';
        return;
    }
    target.innerHTML = `
        <span>并发 ${Number(data.active || 0)} / ${Number(data.maxConcurrent || 0)}</span>
        <span>队列 ${Number(data.databaseQueued || data.queued || 0)}</span>
        <span>我的排队 ${Number(data.userQueued || 0)}</span>
    `;
}

async function loadAgentMetrics() {
    const target = document.getElementById('agent-metrics');
    if (!target) return;
    const res = await apiFetch(`${API_BASE}/agents/metrics?days=7`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        target.innerHTML = '';
        return;
    }
    target.innerHTML = `
        <span>7日任务 ${Number(data.total || 0)}</span>
        <span>成功率 ${Number(data.successRate || 0)}%</span>
        <span>失败 ${Number(data.error || 0)}</span>
        <span>Token ${agentEscape(formatAgentCompactCount(data.totalTokens || 0))}</span>
    `;
}

function renderAgentPreflight(data) {
    const target = document.getElementById('agent-preflight-panel');
    if (!target || !data) return;
    const statusText = data.status === 'blocked' ? '阻断' : data.status === 'warning' ? '有风险' : '可运行';
    const messages = [...(data.blockers || []), ...(data.warnings || []), ...(data.recommendations || [])].slice(0, 5);
    const summary = data.summary || {};
    target.className = `workspace-governance-panel agent-preflight-panel ${agentEscape(data.status || 'ready')}`;
    target.innerHTML = `
        <div class="governance-head">
            <strong>任务预检：${agentEscape(statusText)}</strong>
            <span>工具 ${Number(summary.toolCount || 0)} · 能力库 ${Number(summary.mcpToolCount || 0)} · 知识分块 ${Number(summary.knowledgeChunks || 0)}</span>
        </div>
        <div class="governance-list">
            ${messages.map(item => `<span>${agentEscape(item)}</span>`).join('') || '<span>预检通过。</span>'}
        </div>
    `;
}

async function preflightAgentPayload(payload) {
    const target = document.getElementById('agent-preflight-panel');
    if (target) {
        target.className = 'workspace-governance-panel agent-preflight-panel';
        target.innerHTML = '<div class="governance-head"><strong>任务预检中...</strong></div>';
    }
    const res = await apiFetch(`${API_BASE}/agents/preflight`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '任务预检失败');
    renderAgentPreflight(data);
    return data;
}

function renderAgentRunsPagination(page = agentRunsPage, total = agentRunsTotal, limit = AGENT_RUNS_PAGE_SIZE) {
    window.renderWorkspacePagination?.('pagination-agentRuns', {
        total,
        page,
        limit,
        onPageChange: targetPage => loadAgentRuns(targetPage).catch(err => showToast(err.message || '任务列表刷新失败', 'error'))
    });
}

async function loadAgentRuns(page = agentRunsPage) {
    const list = document.getElementById('agent-runs-list');
    if (!list) return;
    const status = document.getElementById('agent-filter-status')?.value || '';
    const query = document.getElementById('agent-filter-query')?.value.trim() || '';
    agentRunsPage = Math.max(Number(page) || 1, 1);
    const params = new URLSearchParams({
        page: String(agentRunsPage),
        limit: String(AGENT_RUNS_PAGE_SIZE)
    });
    if (status) params.set('status', status);
    if (query) params.set('query', query);
    const res = await apiFetch(`${API_BASE}/agents/runs?${params.toString()}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '任务列表加载失败');
    agentRunsCache = data.data || [];
    agentRunsTotal = Number(data.total || agentRunsCache.length || 0);
    agentRunsPage = Number(data.page || agentRunsPage);
    const pageSize = Number(data.limit || AGENT_RUNS_PAGE_SIZE);
    if (agentRunsCache.length === 0 && agentRunsTotal > 0 && agentRunsPage > 1) {
        const lastPage = Math.max(Math.ceil(agentRunsTotal / pageSize), 1);
        return loadAgentRuns(Math.min(agentRunsPage - 1, lastPage));
    }
    updateAgentAutoRefresh();
    renderAgentRunsPagination(agentRunsPage, agentRunsTotal, pageSize);
    const displayRuns = agentRunsCache;
    if (agentRunsTotal === 0 && !status && !query) {
        list.innerHTML = '';
        activeAgentRunId = '';
        closeAgentRunDetailModal();
        list.innerHTML = `
            <div class="agent-empty-state agent-empty-hero">
                <strong>还没有智能体任务</strong>
                <span>在左侧输入目标并点击运行后，这里会显示任务记录。点击详情可查看执行步骤和最终结果。</span>
            </div>
        `;
        return;
    }
    if (displayRuns.length === 0) {
        list.innerHTML = '<div class="empty-state agent-empty-state">没有匹配的任务记录。</div>';
        return;
    }
    const hasSelectedRun = activeAgentRunId && displayRuns.some(run => run.id === activeAgentRunId);
    if (!hasSelectedRun && !isAgentRunDetailModalOpen()) activeAgentRunId = '';
    list.innerHTML = `
        <div class="agent-runs-table-wrap">
            <table class="data-table agent-runs-table">
                <thead>
                    <tr>
                        <th class="text-center">序号</th>
                        <th>任务</th>
                        <th>模型</th>
                        <th>模式</th>
                        <th>步骤</th>
                        <th>工具</th>
                        <th>错误</th>
                        <th>输入Token</th>
                        <th>输出Token</th>
                        <th>总Token</th>
                        <th>创建时间</th>
                        <th>状态</th>
                        <th>操作</th>
                    </tr>
                </thead>
                <tbody>
                    ${displayRuns.map((run, index) => {
        const title = agentDisplayTitle(run);
        const mode = agentRunModeLabel(run.run_mode);
        const tokenTotal = Number(run.total_tokens || 0);
        const inputTokens = Number(run.input_tokens || 0);
        const outputTokens = Number(run.output_tokens || 0);
        const stepCount = Number(run.step_count || 0);
        const toolCount = Number(run.tool_count || 0);
        const errorCount = Number(run.error_count || 0);
        const canDelete = !isAgentRunActive(run.status);
        const taskTooltip = buildAgentRunTaskTooltip(run, title, mode, { stepCount, toolCount, errorCount });
        return `
            <tr class="${run.id === activeAgentRunId ? 'active' : ''}" data-agent-run-id="${agentEscape(run.id)}">
                <td class="text-center">${(agentRunsPage - 1) * pageSize + index + 1}</td>
                <td class="agent-runs-title-cell">
                    <strong tabindex="0" aria-label="${agentEscapeAttr(taskTooltip)}" data-agent-run-title-full="${agentEscapeAttr(taskTooltip)}">${agentEscape(title)}</strong>
                </td>
                <td>
                    <strong class="agent-runs-compact">${agentEscape(run.model_name || '-')}</strong>
                </td>
                <td>${agentEscape(mode)}</td>
                <td>${stepCount || '-'}</td>
                <td>${toolCount}</td>
                <td>${errorCount}</td>
                <td>${inputTokens ? agentEscape(formatAgentCompactCount(inputTokens)) : '-'}</td>
                <td>${outputTokens ? agentEscape(formatAgentCompactCount(outputTokens)) : '-'}</td>
                <td>${tokenTotal ? agentEscape(formatAgentCompactCount(tokenTotal)) : '-'}</td>
                <td>${agentEscape(formatDateToCN(run.created_at))}</td>
                <td>
                    <span class="agent-run-status ${agentEscape(run.status)}">${agentStatusLabel(run.status)}</span>
                </td>
                <td>
                    <div class="agent-run-table-actions">
                        <button class="btn-secondary agent-run-detail-btn" type="button" data-agent-run-detail="${agentEscape(run.id)}">详情</button>
                        ${canDelete ? `<button class="btn-danger-outline agent-run-delete-btn" type="button" data-agent-run-delete="${agentEscape(run.id)}">删除</button>` : ''}
                    </div>
                </td>
            </tr>
    `;
    }).join('')}
                </tbody>
            </table>
        </div>
    `;
    list.querySelectorAll('[data-agent-run-detail]').forEach(btn => {
        btn.addEventListener('click', () => window.openAgentRun(btn.dataset.agentRunDetail));
    });
    list.querySelectorAll('[data-agent-run-delete]').forEach(btn => {
        btn.addEventListener('click', () => window.deleteAgentRun(btn.dataset.agentRunDelete));
    });
    bindAgentRunTitleTooltip(list);
}
