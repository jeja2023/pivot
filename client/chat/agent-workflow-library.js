/* 工作流库与版本辅助函数，拆自 agents.js。 */




function agentWorkflowNodeCount(item) {
    const fromRow = Number(item?.node_count || 0);
    if (fromRow > 0) return fromRow;
    const nodes = Array.isArray(item?.dag_spec?.nodes) ? item.dag_spec.nodes : [];
    return nodes.length;
}

function agentWorkflowVersionText(item) {
    const currentVersion = Number(item?.current_version || 0);
    const publishedVersion = Number(item?.published_version || 0);
    const parts = [];
    if (currentVersion > 0) parts.push(`v${currentVersion}`);
    parts.push(`${agentWorkflowNodeCount(item)} 节点`);
    parts.push(publishedVersion > 0 ? `已发布 v${publishedVersion}` : '未发布');
    return parts.join(' · ');
}

function agentWorkflowUpdatedText(item) {
    const value = item?.updated_at || item?.version_created_at || item?.created_at || '';
    if (!value) return '';
    return typeof formatDateToCN === 'function' ? formatDateToCN(value) : String(value);
}

function agentWorkflowPickerOptionMarkup(item, selectedId) {
    const id = String(item?.id || '');
    const selected = id && String(selectedId || '') === id;
    const updatedText = agentWorkflowUpdatedText(item);
    const searchable = [
        item?.name,
        item?.description,
        agentWorkflowVersionText(item),
        updatedText
    ].filter(Boolean).join(' ');
    return `
        <button type="button" role="option" class="agent-workflow-picker-option ${selected ? 'is-selected' : ''}" data-agent-workflow-picker-id="${agentEscapeAttr(id)}" data-search-text="${agentEscapeAttr(searchable)}" aria-selected="${selected ? 'true' : 'false'}">
            <span class="agent-workflow-picker-option-main">
                <strong>${agentEscape(item?.name || '未命名工作流')}</strong>
                ${item?.description ? `<small>${agentEscape(agentShortText(item.description, 82))}</small>` : ''}
            </span>
            <span class="agent-workflow-picker-option-side">
                <em>${agentEscape(agentWorkflowVersionText(item))}</em>
                ${updatedText ? `<small>${agentEscape(updatedText)}</small>` : ''}
            </span>
        </button>
    `;
}

function setAgentWorkflowPickerOpen(isOpen, options = {}) {
    const picker = document.getElementById('agent-workflow-picker');
    const trigger = document.getElementById('agent-workflow-picker-trigger');
    const menu = document.getElementById('agent-workflow-picker-menu');
    const search = document.getElementById('agent-workflow-picker-search');
    if (!picker || !trigger || !menu) return;
    picker.classList.toggle('is-open', Boolean(isOpen));
    menu.classList.toggle('hidden', !isOpen);
    trigger.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    if (isOpen && options.focusSearch !== false) {
        requestAnimationFrame(() => {
            search?.focus();
            search?.select();
        });
    }
}

function selectAgentWorkflowFromPicker(workflowId) {
    const select = document.getElementById('agent-workflow-select');
    if (!select) return;
    select.value = String(workflowId || '');
    select.dispatchEvent(new Event('change', { bubbles: true }));
    setAgentWorkflowPickerOpen(false);
}

function renderAgentWorkflowPicker() {
    const picker = document.getElementById('agent-workflow-picker');
    const trigger = document.getElementById('agent-workflow-picker-trigger');
    const title = document.getElementById('agent-workflow-picker-title');
    const meta = document.getElementById('agent-workflow-picker-meta');
    const list = document.getElementById('agent-workflow-picker-list');
    const search = document.getElementById('agent-workflow-picker-search');
    if (!picker || !trigger || !title || !meta || !list) return;
    const selected = selectedAgentWorkflow();
    const query = String(agentWorkflowPickerQuery || '').trim().toLowerCase();
    const filtered = query
        ? agentWorkflowsCache.filter(item => {
            const text = [
                item?.name,
                item?.description,
                agentWorkflowVersionText(item),
                agentWorkflowUpdatedText(item)
            ].filter(Boolean).join(' ').toLowerCase();
            return text.includes(query);
        })
        : agentWorkflowsCache;
    picker.classList.toggle('is-empty', !agentWorkflowsCache.length);
    title.textContent = selected?.name || '选择已保存工作流';
    trigger.title = selected?.name
        ? `${selected.name} · ${agentWorkflowVersionText(selected)}`
        : '选择已保存工作流';
    meta.textContent = selected
        ? agentWorkflowVersionText(selected)
        : (agentWorkflowsCache.length ? `${agentWorkflowsCache.length} 个可用 · 支持搜索筛选` : '暂无已保存工作流');
    if (search && search.value !== agentWorkflowPickerQuery) search.value = agentWorkflowPickerQuery;
    if (!agentWorkflowsCache.length) {
        PivotSafeHtml.setHtml(list, '<div class="agent-workflow-picker-empty">保存当前画布后，会在这里选择、搜索和加载工作流。</div>');
        return;
    }
    if (!filtered.length) {
        PivotSafeHtml.setHtml(list, `<div class="agent-workflow-picker-empty">没有匹配“${agentEscape(agentWorkflowPickerQuery)}”的工作流</div>`);
        return;
    }
    PivotSafeHtml.setHtml(list, filtered.map(item => agentWorkflowPickerOptionMarkup(item, activeAgentWorkflowId)).join(''));
    list.querySelectorAll('[data-agent-workflow-picker-id]').forEach(option => {
        option.addEventListener('click', () => selectAgentWorkflowFromPicker(option.dataset.agentWorkflowPickerId));
    });
}

function renderAgentWorkflowLibrary() {
    const select = document.getElementById('agent-workflow-select');
    const currentLabel = document.getElementById('agent-workflow-current-label');
    const current = activeAgentWorkflowId || '';
    const editorOptions = [
        '<option value="">选择已保存工作流</option>',
        ...agentWorkflowsCache.map(item => {
            const version = item.current_version ? ` v${item.current_version}` : '';
            return `<option value="${agentEscape(item.id)}">${agentEscape(item.name)}${agentEscape(version)}</option>`;
        })
    ].join('');
    const nextValue = agentWorkflowsCache.some(item => String(item.id) === String(current)) ? String(current) : '';
    if (select) {
        PivotSafeHtml.setHtml(select, editorOptions);
        select.value = nextValue;
    }
    activeAgentWorkflowId = nextValue;
    const selected = agentWorkflowsCache.find(item => String(item.id) === String(nextValue));
    if (selected) {
        agentWorkflowDraftName = selected.name || agentWorkflowDraftName;
        agentWorkflowDraftDescription = selected.description || agentWorkflowDraftDescription;
    }
    if (currentLabel) {
        const canvasLabel = selected
            ? (currentWorkflowMatchesSelected(selected) ? '已同步' : '未保存更改')
            : (agentWorkflowDraftName ? '草稿未保存' : '新建草稿');
        currentLabel.textContent = canvasLabel;
        currentLabel.title = selected?.name || agentWorkflowDraftName || canvasLabel;
    }
    renderAgentWorkflowPicker();
    renderAgentWorkflowLifecycle();
    updateAgentWorkflowRunUi();
}

async function loadAgentWorkflows() {
    const select = document.getElementById('agent-workflow-select');
    if (!select) return;
    try {
        const res = await apiFetch(`${API_BASE}/agents/workflows`);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '已保存工作流加载失败');
        agentWorkflowsCache = data.data || [];
        renderAgentWorkflowLibrary();
    } catch (e) {
        showToast(e.message || '已保存工作流加载失败', 'error');
    }
}

function clearAgentWorkflowLocalSnapshots() {
    try {
        localStorage.removeItem(AGENT_WORKFLOW_DRAFT_KEY);
        localStorage.removeItem(AGENT_WORKFLOW_SAVED_KEY);
    } catch (e) {
        // 忽略存储清理失败
    }
}

function currentAgentWorkflowDescription() {
    return String(agentWorkflowDraftDescription || '').trim().slice(0, 300);
}

function newAgentWorkflow(options = {}) {
    const {
        showToast: shouldShowToast = true,
        clearSnapshots = true,
        remount = true,
        name = '',
        description = ''
    } = options;
    activeAgentWorkflowId = '';
    const select = document.getElementById('agent-workflow-select');
    if (select) select.value = '';
    agentWorkflowDraftName = String(name || '').trim().slice(0, 100);
    agentWorkflowDraftDescription = String(description || '').trim().slice(0, 300);
    if (clearSnapshots) clearAgentWorkflowLocalSnapshots();
    closeAgentDagNodeDrawer();
    writeAgentWorkflowText({ nodes: [] });
    renderAgentWorkflowLibrary();
    if (remount) {
        mountAgentDagEditor();
        window.refreshAgentDagEditor?.();
    }
    updateAgentWorkflowRunUi();
    if (shouldShowToast) showToast(agentWorkflowDraftName ? `已新建工作流草稿：${agentWorkflowDraftName}` : '已新建工作流草稿', 'success');
}

function currentAgentWorkflowName() {
    const selected = selectedAgentWorkflow();
    return String(selected?.name || agentWorkflowDraftName || '未命名工作流').trim().slice(0, 100) || '未命名工作流';
}

window.setAgentWorkflowDraftName = function(name, options = {}) {
    const nextName = String(name || '').trim().slice(0, 100);
    if (!nextName) return;
    if (options.ifEmpty && (selectedAgentWorkflow()?.name || agentWorkflowDraftName)) return;
    agentWorkflowDraftName = nextName;
    renderAgentWorkflowLibrary();
};

async function ensureAgentWorkflowNameForSave() {
    const existing = String(selectedAgentWorkflow()?.name || agentWorkflowDraftName || '').trim().slice(0, 100);
    if (existing) return existing;
    const suggested = '未命名工作流';
    const value = await window.showInputPrompt?.({
        title: '保存工作流',
        message: '给当前工作流起一个名称，保存后会进入已保存工作流。',
        value: suggested,
        placeholder: '例如：日报汇总、客户回访分析',
        requiredMessage: '请填写工作流名称'
    });
    if (value === null || value === undefined) return '';
    const name = String(value || '').trim().slice(0, 100);
    if (!name) {
        showToast('请填写工作流名称后再保存', 'error');
        return '';
    }
    agentWorkflowDraftName = name;
    renderAgentWorkflowLibrary();
    return name;
}

function inferAgentWorkflowRunGoal() {
    const selected = selectedAgentWorkflow();
    const workflowName = String(selected?.name || agentWorkflowDraftName || '').trim();
    if (workflowName) return `执行工作流：${workflowName}`.slice(0, 2000);
    const summary = summarizeAgentDagSpec();
    if (summary.valid && summary.executableNodeCount > 0) return `执行当前工作流（${summary.executableNodeCount} 个节点）`;
    return '';
}

async function saveAgentWorkflowToLibrary(options = {}) {
    const showSuccess = options.showToast !== false;
    let parsed;
    try {
        parsed = parseAgentWorkflowText();
    } catch (e) {
        showToast('工作流 JSON 格式不正确', 'error');
        return null;
    }
    // 保存前主动校验，发现错误时弹出确认门禁
    const validation = dagEditorInstance?.validate?.();
    if (validation && validation.errors.length) {
        const blockingLlmError = validation.errors.find(item => /大模型节点|节点模型/.test(String(item || '')));
        if (blockingLlmError) {
            showToast(blockingLlmError, 'error');
            return null;
        }
        const msg = [
            `工作流存在 ${validation.errors.length} 个问题：`,
            ...validation.errors.map((e, i) => `${i + 1}. ${e}`),
            '',
            '确定仍要保存吗？'
        ].join('\n');
        const confirmed = await (window.showConfirm?.('工作流校验未通过', msg) || Promise.resolve(window.confirm(msg)));
        if (!confirmed) return null;
    }
    const workflowName = await ensureAgentWorkflowNameForSave();
    if (!workflowName) return null;
    const workflowId = activeAgentWorkflowId || document.getElementById('agent-workflow-select')?.value || '';
    const method = workflowId ? 'PUT' : 'POST';
    const url = workflowId
        ? `${API_BASE}/agents/workflows/${encodeURIComponent(workflowId)}`
        : `${API_BASE}/agents/workflows`;
    const res = await apiFetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            name: workflowName,
            description: currentAgentWorkflowDescription(),
            dagSpec: parsed,
            note: method === 'POST' ? '创建工作流' : '保存新版本'
        })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        showToast(data.error || '保存已保存工作流失败', 'error');
        return null;
    }
    activeAgentWorkflowId = String(data.workflow.id);
    agentWorkflowDraftName = data.workflow.name || workflowName;
    agentWorkflowDraftDescription = data.workflow.description || currentAgentWorkflowDescription();
    await loadAgentWorkflows();
    if (showSuccess) showToast(`工作流已保存：v${data.workflow.current_version || 1}`, 'success');
    return data.workflow;
}

function loadSelectedAgentWorkflow() {
    const select = document.getElementById('agent-workflow-select');
    const workflow = agentWorkflowsCache.find(item => String(item.id) === String(select?.value || activeAgentWorkflowId));
    if (!workflow) return showToast('请选择要加载的工作流', 'warning');
    activeAgentWorkflowId = String(workflow.id);
    agentWorkflowDraftName = workflow.name || '';
    agentWorkflowDraftDescription = workflow.description || '';
    writeAgentWorkflowText(workflow.dag_spec || { nodes: [] });
    updateAgentWorkflowRunUi();
    renderAgentWorkflowLibrary();
    mountAgentDagEditor();
    window.refreshAgentDagEditor?.();
    showToast(`已加载工作流：${workflow.name}`, 'success');
}

function deleteSelectedAgentWorkflow() {
    const select = document.getElementById('agent-workflow-select');
    const workflow = agentWorkflowsCache.find(item => String(item.id) === String(select?.value || activeAgentWorkflowId));
    if (!workflow) return showToast('请选择要删除的工作流', 'warning');
    showConfirm('删除工作流', `确定删除「${workflow.name}」吗？已产生的任务记录不会受影响。`, async () => {
        const res = await apiFetch(`${API_BASE}/agents/workflows/${encodeURIComponent(workflow.id)}`, { method: 'DELETE' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) return showToast(data.error || '删除工作流失败', 'error');
        // 保存删除信息以便撤销
        const deletedInfo = { id: workflow.id, name: workflow.name };
        const wasActive = String(activeAgentWorkflowId) === String(workflow.id);
        if (wasActive) activeAgentWorkflowId = '';
        if (wasActive) agentWorkflowDraftName = '';
        agentWorkflowDraftDescription = '';
        await loadAgentWorkflows();
        // 显示含恢复操作的提示
        showToast(`工作流「${deletedInfo.name}」已删除，30 天内可恢复`, 'success');
        const lifecycle = document.getElementById('agent-workflow-lifecycle');
        if (lifecycle) {
            PivotSafeHtml.setHtml(lifecycle, `<button type="button" class="btn-secondary agent-workflow-undo-delete" title="恢复已删除的工作流">撤销删除：${agentEscape(deletedInfo.name)}</button>`);
            lifecycle.querySelector('.agent-workflow-undo-delete')?.addEventListener('click', async () => {
                const restoreRes = await apiFetch(`${API_BASE}/agents/workflows/${encodeURIComponent(deletedInfo.id)}/restore`, { method: 'PATCH' });
                const restoreData = await restoreRes.json().catch(() => ({}));
                if (!restoreRes.ok) return showToast(restoreData.error || '恢复失败', 'error');
                if (wasActive) activeAgentWorkflowId = String(restoreData.workflow.id);
                if (wasActive) agentWorkflowDraftName = restoreData.workflow.name || deletedInfo.name;
                await loadAgentWorkflows();
                showToast(`工作流「${restoreData.workflow.name || deletedInfo.name}」已恢复`, 'success');
            });
        }
    });
}

async function publishSelectedAgentWorkflow(version = 'current') {
    let workflow = selectedAgentWorkflow();
    if (String(version || 'current') === 'current') {
        workflow = await saveAgentWorkflowToLibrary({ showToast: false });
        if (!workflow) return;
    }
    if (!workflow) return showToast('请选择要发布的工作流', 'warning');
    const res = await apiFetch(`${API_BASE}/agents/workflows/${encodeURIComponent(workflow.id)}/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return showToast(data.error || '发布工作流失败', 'error');
    activeAgentWorkflowId = String(data.workflow.id);
    agentWorkflowDraftName = data.workflow.name || agentWorkflowDraftName;
    agentWorkflowDraftDescription = data.workflow.description || agentWorkflowDraftDescription;
    await loadAgentWorkflows();
    showToast(`工作流已发布：v${data.workflow.published_version || data.workflow.current_version || ''}`, 'success');
    return data.workflow;
}


function persistAgentWorkflow(key, label) {
    const raw = getAgentWorkflowText();
    let parsed;
    try {
        parsed = parseAgentWorkflowText(raw);
    } catch (e) {
        showToast('工作流 JSON 格式不正确', 'error');
        return false;
    }
    try {
        localStorage.setItem(key, JSON.stringify({
            savedAt: new Date().toISOString(),
            spec: parsed
        }));
    } catch (e) {
        showToast(`${label}失败，浏览器存储不可用`, 'error');
        return false;
    }
    return true;
}

window.saveAgentWorkflowDraft = function() {
    if (persistAgentWorkflow(AGENT_WORKFLOW_DRAFT_KEY, '保存草稿')) {
        showToast('工作流草稿已保存', 'success');
    }
};

window.saveAgentWorkflow = async function() {
    if (!persistAgentWorkflow(AGENT_WORKFLOW_SAVED_KEY, '保存工作流')) return;
    updateAgentWorkflowRunUi();
    try {
        localStorage.removeItem(AGENT_WORKFLOW_DRAFT_KEY);
    } catch (e) {
        // 忽略存储清理失败
    }
    await saveAgentWorkflowToLibrary();
};
