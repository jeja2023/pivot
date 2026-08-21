/* 工作流库与版本辅助函数，拆自 agents.js。 */
/* global showAutomationWorkflowEditor, renderAutomationAssetCenter, agentWorkflowReadOnly */




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
    if (currentVersion > 0) parts.push(`版本 ${currentVersion}`);
    parts.push(`${agentWorkflowNodeCount(item)} 节点`);
    parts.push(publishedVersion > 0 ? `已发布版本 ${publishedVersion}` : '未发布');
    return parts.join(' · ');
}

function agentWorkflowPickerTriggerMetaText(item) {
    const currentVersion = Number(item?.current_version || 0);
    const publishedVersion = Number(item?.published_version || 0);
    const parts = [];
    if (currentVersion > 0) parts.push(`版本 ${currentVersion}`);
    parts.push(publishedVersion > 0 ? `已发布版本 ${publishedVersion}` : '未发布');
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

async function confirmAgentWorkflowDiscard(message) {
    const workflow = selectedAgentWorkflow();
    const draftSummary = summarizeAgentDagSpec();
    const hasUnsavedWork = workflow
        ? !currentWorkflowMatchesSelected(workflow)
        : (!draftSummary.valid || draftSummary.nodeCount > 0);
    if (!hasUnsavedWork) return true;
    if (typeof showConfirm === 'function') {
        return showConfirm('放弃未保存修改', message);
    }
    return typeof confirm !== 'function' || confirm(message);
}

async function selectAgentWorkflowFromPicker(workflowId) {
    const select = document.getElementById('agent-workflow-select');
    if (!select) return;
    const targetId = String(workflowId || '');
    setAgentWorkflowPickerOpen(false, { focusSearch: false });
    if (targetId === String(activeAgentWorkflowId || '')) return;
    const confirmed = await confirmAgentWorkflowDiscard('切换工作流会丢失当前画布中尚未保存的修改，确定继续吗？');
    if (!confirmed) return;
    select.value = targetId;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    setAgentWorkflowPickerOpen(false);
    // 选中即立即加载到画布，无需再点"加载"按钮
    if (workflowId) {
        const workflow = agentWorkflowsCache.find(item => String(item.id) === String(workflowId));
        if (workflow) {
            showAutomationWorkflowEditor(workflow.id, { readOnly: !workflow.can_edit });
            showToast(`已加载：${workflow.name}`, 'success');
        }
    }
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
    const currentTitle = String(agentWorkflowDraftName || '').trim() || selected?.name || '新建工作流';
    picker.classList.toggle('is-empty', !agentWorkflowsCache.length);
    title.textContent = currentTitle;
    trigger.title = selected
        ? `${currentTitle} · ${agentWorkflowPickerTriggerMetaText(selected)}`
        : `${currentTitle} · 点击切换已保存工作流`;
    meta.textContent = selected
        ? agentWorkflowPickerTriggerMetaText(selected)
        : (agentWorkflowsCache.length ? `点击切换 · ${agentWorkflowsCache.length} 个已保存工作流` : '尚未保存 · 暂无已保存工作流');
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
    const current = activeAgentWorkflowId || '';
    const editorOptions = [
        '<option value="">选择已保存工作流</option>',
        ...agentWorkflowsCache.map(item => {
            const version = item.current_version ? ` 版本 ${item.current_version}` : '';
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
        agentWorkflowDraftName = agentWorkflowDraftName || selected.name || '';
        agentWorkflowDraftDescription = agentWorkflowDraftDescription || selected.description || '';
    }
    // 管理操作按工作流状态开放，避免用户进入后才看到前置条件提示。
    const deleteBtn = document.getElementById('agent-workflow-delete-btn');
    const versionsBtn = document.getElementById('agent-workflow-versions-btn');
    const scheduleBtn = document.getElementById('agent-workflow-schedule-btn');
    const shareBtn = document.getElementById('agent-workflow-share-btn');
    if (deleteBtn) deleteBtn.disabled = !selected?.can_edit;
    if (versionsBtn) versionsBtn.disabled = !selected?.can_edit;
    if (scheduleBtn) {
        scheduleBtn.disabled = !selected?.can_edit || !selected?.published_version;
        scheduleBtn.title = !selected?.can_edit
            ? '共享工作流不能由接收方管理计划任务'
            : (selected?.published_version ? '' : '发布工作流后可创建计划任务');
    }
    if (shareBtn) shareBtn.disabled = !selected?.can_edit;
    renderAgentWorkflowPicker();
    renderAgentWorkflowLifecycle();
    updateAgentWorkflowRunUi();
}

async function loadAgentWorkflows() {
    const select = document.getElementById('agent-workflow-select');
    if (!select) return;
    try {
        const res = await apiFetch(`${API_BASE}/agents/workflows`, { cache: 'no-store' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '已保存工作流加载失败');
        agentWorkflowsCache = data.data || [];
        renderAgentWorkflowLibrary();
        window.Pivot.moduleApi('agent.automation').renderAssetCenter?.();
    } catch (e) {
        showToast(e.message || '已保存工作流加载失败', 'error');
    }
}

let agentWorkflowMetadataState = { workflowId: '' };

function setAgentWorkflowMetadataError(message = '') {
    const target = document.getElementById('agent-workflow-metadata-error');
    if (!target) return;
    target.textContent = message;
}

function bindAgentWorkflowMetadataModal() {
    const modal = document.getElementById('agent-workflow-metadata-modal');
    if (!modal || modal.dataset.boundAgentWorkflowMetadataModal === '1') return;
    modal.dataset.boundAgentWorkflowMetadataModal = '1';
    const close = () => modal.classList.add('hidden');
    document.getElementById('agent-workflow-metadata-close-btn')?.addEventListener('click', close);
    document.getElementById('agent-workflow-metadata-cancel-btn')?.addEventListener('click', close);
    document.getElementById('agent-workflow-metadata-save-btn')?.addEventListener('click', saveAgentWorkflowMetadata);
    modal.addEventListener('input', () => setAgentWorkflowMetadataError(''));
}

function openAgentWorkflowMetadata(workflowId) {
    bindAgentWorkflowMetadataModal();
    const workflow = agentWorkflowsCache.find(item => String(item.id) === String(workflowId));
    const modal = document.getElementById('agent-workflow-metadata-modal');
    const name = document.getElementById('agent-workflow-metadata-name');
    const description = document.getElementById('agent-workflow-metadata-description');
    if (!workflow || !workflow.can_edit || !modal || !name || !description) {
        showToast('只有工作流所有者可以编辑基本信息', 'warning');
        return;
    }
    agentWorkflowMetadataState = { workflowId: String(workflow.id) };
    name.value = workflow.name || '';
    description.value = workflow.description || '';
    setAgentWorkflowMetadataError('');
    modal.classList.remove('hidden');
    requestAnimationFrame(() => {
        name.focus();
        name.select();
    });
}

async function saveAgentWorkflowMetadata() {
    const modal = document.getElementById('agent-workflow-metadata-modal');
    const save = document.getElementById('agent-workflow-metadata-save-btn');
    const nameInput = document.getElementById('agent-workflow-metadata-name');
    const descriptionInput = document.getElementById('agent-workflow-metadata-description');
    const workflow = agentWorkflowsCache.find(item => String(item.id) === String(agentWorkflowMetadataState.workflowId));
    if (!modal || !save || !nameInput || !descriptionInput || !workflow) return;
    const name = String(nameInput.value || '').trim().slice(0, 100);
    const description = String(descriptionInput.value || '').trim().slice(0, 300);
    if (!name) {
        setAgentWorkflowMetadataError('请填写工作流名称');
        nameInput.focus();
        return;
    }
    save.disabled = true;
    try {
        const res = await apiFetch(`${API_BASE}/agents/workflows/${encodeURIComponent(workflow.id)}/metadata`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, description })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '工作流信息保存失败');
        const index = agentWorkflowsCache.findIndex(item => String(item.id) === String(workflow.id));
        if (index >= 0 && data.workflow) agentWorkflowsCache[index] = data.workflow;
        if (String(activeAgentWorkflowId || '') === String(workflow.id)) {
            agentWorkflowDraftName = data.workflow?.name || name;
            agentWorkflowDraftDescription = data.workflow?.description || description;
        }
        modal.classList.add('hidden');
        renderAgentWorkflowLibrary();
        renderAutomationAssetCenter();
        showToast('工作流信息已保存', 'success');
    } catch (error) {
        setAgentWorkflowMetadataError(error.message || '工作流信息保存失败');
    } finally {
        save.disabled = false;
    }
}

let agentWorkflowShareState = { workflowId: '', options: null };

function setAgentWorkflowShareError(message = '') {
    const error = document.getElementById('agent-workflow-share-error');
    if (!error) return;
    error.textContent = message;
    error.hidden = !message;
}

function setAgentWorkflowShareUnitsEnabled(enabled) {
    const all = document.getElementById('agent-workflow-share-all');
    const allChecked = all?.checked === true && all?.disabled !== true;
    document.querySelectorAll('#agent-workflow-share-units-list input[data-agent-share-unit], #agent-workflow-share-units-list input[data-agent-share-user]').forEach(input => {
        input.disabled = !enabled || allChecked;
    });
    document.querySelectorAll('[data-agent-share-select], [data-agent-share-clear]').forEach(button => {
        button.disabled = !enabled || allChecked;
    });
}

function renderAgentWorkflowShareUnits(workflow, options) {
    const section = document.getElementById('agent-workflow-share-units-section');
    const list = document.getElementById('agent-workflow-share-units-list');
    const allLabel = document.getElementById('agent-workflow-share-all-label');
    const all = document.getElementById('agent-workflow-share-all');
    const hint = document.getElementById('agent-workflow-share-units-hint');
    if (!section || !list || !allLabel || !all || !hint) return;
    const selectedScope = document.querySelector('input[name="agent-workflow-share-scope"]:checked')?.value;
    const isShared = (selectedScope || workflow?.scope) === 'shared';
    const availableUnits = Array.isArray(options?.units) ? options.units.filter(Boolean) : [];
    const allowedUnits = Array.isArray(workflow?.allowed_units) ? workflow.allowed_units.filter(Boolean) : [];
    const availableUsers = Array.isArray(options?.users) ? options.users.filter(item => Number(item?.id) > 0) : [];
    const allowedUserIds = new Set((Array.isArray(workflow?.allowed_user_ids)
        ? workflow.allowed_user_ids
        : String(workflow?.allowed_user_ids || '').split(',')).map(Number).filter(Number.isSafeInteger));
    const selectableUnits = new Set([...availableUnits, ...allowedUnits]);
    const unassignedUnit = '未设置单位';
    const usersByUnit = new Map();
    availableUsers.forEach(target => {
        const unit = String(target.unit || '').trim() || unassignedUnit;
        if (!usersByUnit.has(unit)) usersByUnit.set(unit, []);
        usersByUnit.get(unit).push(target);
    });
    const units = [...new Set([...availableUnits, ...allowedUnits, ...usersByUnit.keys()])]
        .sort((left, right) => {
            if (left === unassignedUnit) return 1;
            if (right === unassignedUnit) return -1;
            return left.localeCompare(right, 'zh-CN');
        });
    const canShareAll = options?.canShareAll === true;
    const existingShared = String(workflow?.scope || '') === 'shared';
    const isAll = isShared && existingShared && canShareAll && allowedUnits.length === 0 && allowedUserIds.size === 0;
    section.classList.toggle('hidden', !isShared);
    allLabel.classList.toggle('hidden', !canShareAll);
    all.checked = isAll;
    all.disabled = !canShareAll;
    hint.textContent = canShareAll
        ? '勾选单位可共享给该单位全体成员，也可展开到单位下精确选择用户。'
        : (options?.currentUnit ? `可共享给本单位 ${options.currentUnit}，其他单位只能精确选择用户。` : '当前账号未设置所属单位，只能精确选择用户。');
    if (!units.length) {
        PivotSafeHtml.setHtml(list, '<div class="agent-workflow-share-empty">暂无可共享的单位或用户。</div>');
    } else {
        PivotSafeHtml.setHtml(list, units.map(unit => {
            const unitUsers = usersByUnit.get(unit) || [];
            const selectable = unit !== unassignedUnit && selectableUnits.has(unit);
            const checked = selectable && isShared && !isAll && allowedUnits.includes(unit);
            const meta = [
                unit === options.currentUnit ? '本单位' : '',
                unitUsers.length ? `${unitUsers.length} 名用户` : '暂无用户',
                selectable ? '' : '仅可选择个人'
            ].filter(Boolean).join(' · ');
            return `
                <section class="agent-workflow-share-tree-unit" role="treeitem" aria-expanded="true">
                    <div class="agent-workflow-share-tree-unit-head">
                        ${selectable ? `<label class="agent-workflow-share-tree-unit-label"><input type="checkbox" data-agent-share-unit="${agentEscapeAttr(unit)}" ${checked ? 'checked' : ''}><span><strong>${agentEscape(unit)}</strong><small>${agentEscape(meta)}</small></span></label>` : `<span class="agent-workflow-share-tree-unit-label"><span><strong>${agentEscape(unit)}</strong><small>${agentEscape(meta)}</small></span></span>`}
                    </div>
                    <div class="agent-workflow-share-tree-users" role="group">
                        ${unitUsers.length ? unitUsers.map(target => {
        const id = Number(target.id);
        const displayName = target.nickname || target.username || `用户 ${id}`;
        const detail = target.nickname && target.username ? target.username : `用户 ${id}`;
        const userChecked = isShared && !isAll && (checked || allowedUserIds.has(id));
        return `<label class="agent-workflow-share-tree-user" role="treeitem"><input type="checkbox" data-agent-share-user="${id}" data-agent-share-user-unit="${agentEscapeAttr(unit === unassignedUnit ? '' : unit)}" ${userChecked ? 'checked' : ''}><span><strong>${agentEscape(displayName)}</strong><small>${agentEscape(detail)}</small></span></label>`;
    }).join('') : '<span class="agent-workflow-share-tree-empty">该单位暂无其他可共享用户</span>'}
                    </div>
                </section>`;
        }).join(''));
    }
    list.querySelectorAll('input[data-agent-share-unit]').forEach(input => {
        input.addEventListener('change', () => {
            const unit = input.dataset.agentShareUnit;
            list.querySelectorAll('input[data-agent-share-user]').forEach(userInput => {
                if (userInput.dataset.agentShareUserUnit === unit && !userInput.disabled) userInput.checked = input.checked;
            });
            setAgentWorkflowShareError('');
        });
    });
    setAgentWorkflowShareUnitsEnabled(isShared);
}

function bindAgentWorkflowShareModal() {
    const modal = document.getElementById('agent-workflow-share-modal');
    if (!modal || modal.dataset.boundAgentWorkflowShareModal === '1') return;
    modal.dataset.boundAgentWorkflowShareModal = '1';
    const close = () => modal.classList.add('hidden');
    document.getElementById('agent-workflow-share-close-btn')?.addEventListener('click', close);
    document.getElementById('agent-workflow-share-cancel-btn')?.addEventListener('click', close);
    modal.querySelectorAll('input[name="agent-workflow-share-scope"]').forEach(input => {
        input.addEventListener('change', () => {
            const workflow = agentWorkflowsCache.find(item => String(item.id) === String(agentWorkflowShareState.workflowId));
            renderAgentWorkflowShareUnits(workflow, agentWorkflowShareState.options || {});
            setAgentWorkflowShareError('');
        });
    });
    document.getElementById('agent-workflow-share-all')?.addEventListener('change', () => {
        const scope = modal.querySelector('input[name="agent-workflow-share-scope"]:checked')?.value;
        setAgentWorkflowShareUnitsEnabled(scope === 'shared');
    });
    modal.querySelectorAll('[data-agent-share-select], [data-agent-share-clear]').forEach(button => {
        button.addEventListener('click', () => {
            const group = button.dataset.agentShareSelect || button.dataset.agentShareClear;
            const checked = Boolean(button.dataset.agentShareSelect);
            const selector = group === 'tree'
                ? '#agent-workflow-share-units-list input[data-agent-share-unit], #agent-workflow-share-units-list input[data-agent-share-user]'
                : '#agent-workflow-share-units-list input[data-agent-share-unit]';
            modal.querySelectorAll(selector).forEach(input => {
                if (!input.disabled) input.checked = checked;
            });
            setAgentWorkflowShareError('');
        });
    });
    document.getElementById('agent-workflow-share-save-btn')?.addEventListener('click', saveAgentWorkflowSharing);
}

async function loadAgentWorkflowShareOptions() {
    const res = await apiFetch(`${API_BASE}/agents/workflows/share-options`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '共享范围加载失败');
    return data;
}

async function openAgentWorkflowShare(workflowId) {
    bindAgentWorkflowShareModal();
    const workflow = agentWorkflowsCache.find(item => String(item.id) === String(workflowId));
    const modal = document.getElementById('agent-workflow-share-modal');
    const summary = document.getElementById('agent-workflow-share-summary');
    const save = document.getElementById('agent-workflow-share-save-btn');
    if (!workflow || !workflow.can_edit || !modal || !summary || !save) {
        showToast('只有工作流所有者可以修改共享设置', 'warning');
        return;
    }
    agentWorkflowShareState = { workflowId: String(workflow.id), options: null };
    setAgentWorkflowShareError('');
    const publishHint = workflow.published_version
        ? '共享后，接收方只能查看并运行已发布版本。'
        : '当前尚未发布，保存共享设置后接收方仍不可见；发布后才会生效。';
    PivotSafeHtml.setHtml(summary, `<strong>${agentEscape(workflow.name || '未命名工作流')}</strong><span>${publishHint}</span>`);
    const scope = modal.querySelector(`input[name="agent-workflow-share-scope"][value="${workflow.scope === 'shared' ? 'shared' : 'personal'}"]`);
    if (scope) scope.checked = true;
    save.disabled = true;
    modal.classList.remove('hidden');
    try {
        const options = await loadAgentWorkflowShareOptions();
        agentWorkflowShareState.options = options;
        renderAgentWorkflowShareUnits(workflow, options);
    } catch (error) {
        setAgentWorkflowShareError(error.message || '共享范围加载失败');
    } finally {
        save.disabled = false;
    }
}

async function saveAgentWorkflowSharing() {
    const modal = document.getElementById('agent-workflow-share-modal');
    const save = document.getElementById('agent-workflow-share-save-btn');
    const workflow = agentWorkflowsCache.find(item => String(item.id) === String(agentWorkflowShareState.workflowId));
    if (!modal || !save || !workflow) return;
    const scope = modal.querySelector('input[name="agent-workflow-share-scope"]:checked')?.value || 'personal';
    const all = document.getElementById('agent-workflow-share-all');
    const allChecked = all?.checked === true && all?.disabled !== true;
    const allowedUnits = scope === 'shared' && !allChecked
        ? [...modal.querySelectorAll('#agent-workflow-share-units-list input[data-agent-share-unit]:checked')]
            .map(input => input.dataset.agentShareUnit)
            .filter(Boolean)
        : [];
    const allowedUserIds = scope === 'shared' && !allChecked
        ? [...modal.querySelectorAll('#agent-workflow-share-units-list input[data-agent-share-user]:checked')]
            .filter(input => !allowedUnits.includes(input.dataset.agentShareUserUnit || ''))
            .map(input => Number(input.dataset.agentShareUser))
            .filter(Number.isSafeInteger)
        : [];
    if (scope === 'shared' && !allChecked && !allowedUnits.length && !allowedUserIds.length) {
        setAgentWorkflowShareError('共享时至少选择一个单位或一个个人，也可以由管理员共享给全体成员。');
        return;
    }
    setAgentWorkflowShareError('');
    save.disabled = true;
    try {
        const res = await apiFetch(`${API_BASE}/agents/workflows/${encodeURIComponent(workflow.id)}/sharing`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ scope, allowedUnits, allowedUserIds })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '共享设置保存失败');
        const index = agentWorkflowsCache.findIndex(item => String(item.id) === String(workflow.id));
        if (index >= 0 && data.workflow) agentWorkflowsCache[index] = data.workflow;
        modal.classList.add('hidden');
        renderAgentWorkflowLibrary();
        renderAutomationAssetCenter();
        showToast(scope === 'shared' ? '工作流共享设置已保存' : '已取消工作流共享', 'success');
    } catch (error) {
        setAgentWorkflowShareError(error.message || '共享设置保存失败');
    } finally {
        save.disabled = false;
    }
}

let agentWorkflowDependencyState = { workflowId: '', configuration: null };

function setAgentWorkflowDependencyError(message = '') {
    const error = document.getElementById('agent-workflow-dependency-error');
    if (!error) return;
    error.textContent = message;
    error.hidden = !message;
}

function dependencyCandidateLabel(kind, item) {
    if (kind === 'models') {
        const detail = [item.model_name, item.provider].filter(Boolean).join(' · ');
        return `${item.name || item.model_name || item.id}${detail ? `（${detail}）` : ''}`;
    }
    if (kind === 'tools') {
        const detail = [item.server_name, item.source === 'mcp' ? '工具库' : '内置'].filter(Boolean).join(' · ');
        return `${item.title || item.name}${detail ? `（${detail}）` : ''}`;
    }
    if (item.managed) return `${item.name}（仅在平台内执行，不下发）`;
    const owner = item.is_owner ? '我的凭据' : (item.owner_name ? `由 ${item.owner_name} 受控共享` : '受控共享');
    return `${item.name || item.slug} · ${item.slug}（${owner}）`;
}

function dependencyCandidateValue(kind, item) {
    if (kind === 'tools') return String(item.binding_value || item.name || '');
    return String(item.id || '');
}

function dependencyGroupMarkup(kind, title, items, candidates, bindings) {
    if (!items.length) return '';
    return `
        <section class="agent-workflow-dependency-group">
            <div class="agent-workflow-dependency-group-head"><strong>${agentEscape(title)}</strong><span>${items.length} 项</span></div>
            ${items.map(item => {
        const selected = String(bindings?.[kind]?.[item.source] || '');
        const nodeNames = (item.nodes || []).map(node => node.title).filter(Boolean).join('、');
        return `
                <label class="agent-workflow-dependency-row">
                    <span class="agent-workflow-dependency-source">
                        <strong>${agentEscape(item.source)}</strong>
                        <small>${agentEscape(nodeNames || '工作流依赖')}</small>
                    </span>
                    <select class="form-input" data-agent-dependency-kind="${agentEscapeAttr(kind)}" data-agent-dependency-source="${agentEscapeAttr(item.source)}">
                        <option value="">请选择当前账号可用的等价资源</option>
                        ${candidates.map(candidate => {
            const value = dependencyCandidateValue(kind, candidate);
            return `<option value="${agentEscapeAttr(value)}" ${value === selected ? 'selected' : ''}>${agentEscape(dependencyCandidateLabel(kind, candidate))}</option>`;
        }).join('')}
                    </select>
                </label>`;
    }).join('')}
        </section>`;
}

function renderAgentWorkflowDependencies(configuration) {
    const summary = document.getElementById('agent-workflow-dependency-summary');
    const list = document.getElementById('agent-workflow-dependency-list');
    const save = document.getElementById('agent-workflow-dependency-save-btn');
    if (!summary || !list || !save) return;
    const manifest = configuration?.manifest || { models: [], tools: [], credentials: [], summary: {} };
    const candidates = configuration?.candidates || { models: [], tools: [], credentials: [] };
    const bindings = configuration?.bindings || { models: {}, tools: {}, credentials: {} };
    const total = Number(manifest.summary?.totalCount || 0);
    const statusText = configuration?.stale
        ? '发布版本已更新，需要重新确认'
        : (configuration?.status === 'ready' ? '依赖映射已就绪' : '完成以下映射后才能运行');
    PivotSafeHtml.setHtml(summary, `
        <strong>${agentEscape(configuration?.workflow?.name || '共享工作流')} · 发布版本 ${Number(configuration?.workflow?.version || 0)}</strong>
        <span>${agentEscape(statusText)}。凭据仅保存授权引用，密钥内容不会下发到当前账号。</span>
    `);
    if (!total) {
        PivotSafeHtml.setHtml(list, '<div class="agent-workflow-dependency-empty">该工作流没有需要接收者映射的模型、外部工具或凭据。</div>');
        save.textContent = '完成';
        return;
    }
    save.textContent = '确认依赖映射';
    PivotSafeHtml.setHtml(list, [
        dependencyGroupMarkup('models', '模型映射', manifest.models || [], candidates.models || [], bindings),
        dependencyGroupMarkup('tools', '工具映射', manifest.tools || [], candidates.tools || [], bindings),
        dependencyGroupMarkup('credentials', '凭据授权', manifest.credentials || [], candidates.credentials || [], bindings)
    ].join(''));
}

function bindAgentWorkflowDependencyModal() {
    const modal = document.getElementById('agent-workflow-dependency-modal');
    if (!modal || modal.dataset.boundAgentWorkflowDependencyModal === '1') return;
    modal.dataset.boundAgentWorkflowDependencyModal = '1';
    const close = () => modal.classList.add('hidden');
    document.getElementById('agent-workflow-dependency-close-btn')?.addEventListener('click', close);
    document.getElementById('agent-workflow-dependency-cancel-btn')?.addEventListener('click', close);
    modal.addEventListener('change', event => {
        if (event.target?.matches?.('[data-agent-dependency-kind]')) setAgentWorkflowDependencyError('');
    });
    document.getElementById('agent-workflow-dependency-save-btn')?.addEventListener('click', saveAgentWorkflowDependencies);
}

async function openAgentWorkflowDependencies(workflowId = '') {
    bindAgentWorkflowDependencyModal();
    const id = String(workflowId || activeAgentWorkflowId || selectedAgentWorkflow()?.id || '');
    const workflow = agentWorkflowsCache.find(item => String(item.id) === id);
    const modal = document.getElementById('agent-workflow-dependency-modal');
    const list = document.getElementById('agent-workflow-dependency-list');
    const save = document.getElementById('agent-workflow-dependency-save-btn');
    if (!id || !workflow || workflow.can_edit || !modal || !list || !save) {
        showToast('请选择共享给你的已发布工作流', 'warning');
        return null;
    }
    agentWorkflowDependencyState = { workflowId: id, configuration: null };
    setAgentWorkflowDependencyError('');
    PivotSafeHtml.setHtml(list, '<div class="agent-workflow-dependency-empty">正在加载可用依赖...</div>');
    save.disabled = true;
    modal.classList.remove('hidden');
    try {
        const res = await apiFetch(`${API_BASE}/agents/workflows/${encodeURIComponent(id)}/dependencies`);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '依赖配置加载失败');
        agentWorkflowDependencyState.configuration = data;
        renderAgentWorkflowDependencies(data);
        save.disabled = false;
        return data;
    } catch (error) {
        setAgentWorkflowDependencyError(error.message || '依赖配置加载失败');
        return null;
    }
}

async function saveAgentWorkflowDependencies() {
    const modal = document.getElementById('agent-workflow-dependency-modal');
    const save = document.getElementById('agent-workflow-dependency-save-btn');
    const id = agentWorkflowDependencyState.workflowId;
    const configuration = agentWorkflowDependencyState.configuration;
    if (!modal || !save || !id || !configuration) return;
    const bindings = { models: {}, tools: {}, credentials: {} };
    modal.querySelectorAll('[data-agent-dependency-kind][data-agent-dependency-source]').forEach(select => {
        const kind = select.dataset.agentDependencyKind;
        const source = select.dataset.agentDependencySource;
        if (bindings[kind] && source) bindings[kind][source] = select.value;
    });
    const missing = [...modal.querySelectorAll('[data-agent-dependency-kind]')].find(select => !select.value);
    if (missing) {
        setAgentWorkflowDependencyError('请为每一项依赖选择当前账号可用的等价资源。');
        missing.focus();
        return;
    }
    setAgentWorkflowDependencyError('');
    save.disabled = true;
    try {
        const res = await apiFetch(`${API_BASE}/agents/workflows/${encodeURIComponent(id)}/dependencies`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ bindings })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '依赖映射保存失败');
        agentWorkflowDependencyState.configuration = data;
        renderAgentWorkflowDependencies(data);
        modal.classList.add('hidden');
        showToast('工作流依赖映射已确认', 'success');
        return data;
    } catch (error) {
        setAgentWorkflowDependencyError(error.message || '依赖映射保存失败');
        return null;
    } finally {
        save.disabled = false;
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
    return String(agentWorkflowDraftName || selected?.name || '未命名工作流').trim().slice(0, 100) || '未命名工作流';
}

window.setAgentWorkflowDraftName = function(name, options = {}) {
    const nextName = String(name || '').trim().slice(0, 100);
    if (!nextName) return;
    if (options.ifEmpty && (selectedAgentWorkflow()?.name || agentWorkflowDraftName)) return;
    agentWorkflowDraftName = nextName;
    renderAgentWorkflowLibrary();
};

async function ensureAgentWorkflowNameForSave() {
    const existing = String(agentWorkflowDraftName || selectedAgentWorkflow()?.name || '').trim().slice(0, 100);
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
    const workflowName = String(agentWorkflowDraftName || selected?.name || '').trim();
    if (workflowName) return `执行工作流：${workflowName}`.slice(0, 2000);
    const summary = summarizeAgentDagSpec();
    if (summary.valid && summary.executableNodeCount > 0) return `执行当前工作流（${summary.executableNodeCount} 个节点）`;
    return '';
}

async function saveAgentWorkflowToLibrary(options = {}) {
    if (agentWorkflowReadOnly) {
        showToast('共享工作流为只读，只能运行已发布版本', 'warning');
        return null;
    }
    const showSuccess = options.showToast !== false;
    let parsed;
    try {
        parsed = parseAgentWorkflowText(dagEditorInstance?.getValue?.() || getAgentWorkflowText());
    } catch (e) {
        showToast('工作流配置格式不正确', 'error');
        return null;
    }
    // 结构错误会导致发布或运行结果不可预测，因此保存时直接阻断。
    const validation = dagEditorInstance?.validate?.();
    if (validation && validation.errors.length) {
        showToast(`无法保存：${validation.errors[0]}（共 ${validation.errors.length} 项）`, 'error');
        return null;
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
    if (showSuccess) showToast(`工作流已保存：版本 ${data.workflow.current_version || 1}`, 'success');
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
    if (!workflow.can_edit) return showToast('共享工作流不能由接收方删除', 'warning');
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
    if (workflow && !workflow.can_edit) {
        showToast('共享工作流不能由接收方发布', 'warning');
        return null;
    }
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
    showToast(`工作流已发布：版本 ${data.workflow.published_version || data.workflow.current_version || ''}`, 'success');
    return data.workflow;
}


function persistAgentWorkflow(key, label) {
    const raw = getAgentWorkflowText();
    let parsed;
    try {
        parsed = parseAgentWorkflowText(raw);
    } catch (e) {
        showToast('工作流配置格式不正确', 'error');
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
    const saved = await saveAgentWorkflowToLibrary();
    if (!saved) return;
    persistAgentWorkflow(AGENT_WORKFLOW_SAVED_KEY, '保存工作流');
    try {
        localStorage.removeItem(AGENT_WORKFLOW_DRAFT_KEY);
    } catch (e) {
        // 忽略存储清理失败
    }
    updateAgentWorkflowRunUi();
};
