// 工作流触发器与凭据库管理。敏感值只写入服务端，浏览器不缓存或回显凭据明文。
/* eslint-disable no-undef */
let agentAutomationResourceTab = 'triggers';
let agentWorkflowTriggersCache = [];
let agentWorkflowCredentialsCache = [];
let agentAutomationResourceLoadSequence = 0;
let agentAutomationResourceEditorState = null;
let agentAutomationResourceModalOpener = null;
let agentAutomationShareOptions = null;
const agentAutomationResourceActionLocks = new Set();

function agentAutomationResourceModal() {
    return document.getElementById('agent-automation-resources-modal');
}

function setAgentAutomationResourcesModalVisible(isOpen, focusTarget = null) {
    const modal = agentAutomationResourceModal();
    if (!modal) return;
    if (isOpen) {
        agentAutomationResourceModalOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        modal.classList.remove('hidden');
        modal.setAttribute('aria-hidden', 'false');
        requestAnimationFrame(() => (focusTarget || modal.querySelector('[data-agent-automation-resource-tab].active'))?.focus());
        return;
    }
    modal.classList.add('hidden');
    modal.setAttribute('aria-hidden', 'true');
    clearAgentAutomationResourceNotice();
    resetAgentAutomationResourceEditor();
    const opener = agentAutomationResourceModalOpener;
    agentAutomationResourceModalOpener = null;
    if (opener?.isConnected) requestAnimationFrame(() => opener.focus());
}

function agentAutomationResourceTypeLabel(type) {
    return ({ webhook: 'Webhook', file: '文件落地', database: '数据变更' })[type] || '未知类型';
}

function agentAutomationResourceScopeText(resource) {
    if (!resource?.is_owner) return `来自 ${resource.owner_name || '其他成员'} 的共享凭据`;
    if (resource.scope !== 'shared') return '仅自己可用';
    const units = Array.isArray(resource.allowed_units) ? resource.allowed_units.filter(Boolean) : [];
    const users = Array.isArray(resource.allowed_user_ids) ? resource.allowed_user_ids.filter(Boolean) : [];
    if (!units.length && !users.length) return '共享给全体成员';
    const targets = [];
    if (units.length) targets.push(units.join('、'));
    if (users.length) targets.push(`${users.length} 名个人`);
    return `共享给 ${targets.join(' + ')}`;
}

function agentAutomationResourceDateText(value) {
    return value ? String(value).replace('T', ' ').replace(/\.\d+Z?$/, '') : '尚未触发';
}

async function readAgentAutomationResourceResponse(response, fallbackMessage) {
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || fallbackMessage);
    return data;
}

async function loadAgentAutomationResources(options = {}) {
    const requestId = ++agentAutomationResourceLoadSequence;
    const list = document.getElementById('agent-automation-resources-list');
    if (options.showLoading && list) {
        PivotSafeHtml.setHtml(list, '<div class="agent-automation-resources-loading">正在加载自动化资源...</div>');
    }
    const [triggersResult, credentialsResult] = await Promise.allSettled([
        apiFetch(`${API_BASE}/agents/triggers`),
        apiFetch(`${API_BASE}/agents/credentials`)
    ]);
    if (requestId !== agentAutomationResourceLoadSequence) return false;
    const errors = [];
    if (triggersResult.status === 'fulfilled') {
        try {
            const data = await readAgentAutomationResourceResponse(triggersResult.value, '触发器列表加载失败');
            agentWorkflowTriggersCache = Array.isArray(data.data) ? data.data : [];
        } catch (error) {
            errors.push(error);
        }
    } else {
        errors.push(triggersResult.reason);
    }
    if (credentialsResult.status === 'fulfilled') {
        try {
            const data = await readAgentAutomationResourceResponse(credentialsResult.value, '凭据列表加载失败');
            agentWorkflowCredentialsCache = Array.isArray(data.data) ? data.data : [];
        } catch (error) {
            errors.push(error);
        }
    } else {
        errors.push(credentialsResult.reason);
    }
    renderAgentAutomationResourceList();
    if (errors.length) throw new Error(errors[0]?.message || '自动化资源加载失败');
    return true;
}

function renderAgentAutomationResourceTabs() {
    const tablist = document.getElementById('agent-automation-resources-tabs');
    const list = document.getElementById('agent-automation-resources-list');
    if (!tablist || !list) return;
    tablist.querySelectorAll('[data-agent-automation-resource-tab]').forEach(button => {
        const active = button.dataset.agentAutomationResourceTab === agentAutomationResourceTab;
        button.classList.toggle('active', active);
        button.setAttribute('aria-selected', active ? 'true' : 'false');
        button.tabIndex = active ? 0 : -1;
    });
    list.setAttribute('aria-labelledby', agentAutomationResourceTab === 'triggers'
        ? 'agent-automation-triggers-tab'
        : 'agent-automation-credentials-tab');
    const create = document.getElementById('agent-automation-resources-new-btn');
    if (create) create.textContent = agentAutomationResourceTab === 'triggers' ? '新建触发器' : '新建凭据';
}

function renderAgentAutomationResourceList() {
    const list = document.getElementById('agent-automation-resources-list');
    if (!list || agentAutomationResourceEditorState) return;
    renderAgentAutomationResourceTabs();
    if (agentAutomationResourceTab === 'triggers') {
        if (!agentWorkflowTriggersCache.length) {
            PivotSafeHtml.setHtml(list, '<div class="agent-automation-resources-empty"><strong>暂无触发器</strong><span>新建 Webhook、文件落地或数据变更触发器，让已发布工作流在事件到达时自动运行。</span></div>');
            return;
        }
        PivotSafeHtml.setHtml(list, `<div class="agent-automation-resource-rows">${agentWorkflowTriggersCache.map(trigger => {
            const hasError = Boolean(trigger.lastError);
            const paused = trigger.status === 'paused';
            return `<article class="agent-automation-resource-row">
                <div class="agent-automation-resource-main">
                    <div><strong>${agentEscape(trigger.name || '未命名触发器')}</strong><span>${agentEscape(agentAutomationResourceTypeLabel(trigger.triggerType))} · ${agentEscape(trigger.workflowName || `工作流 #${trigger.workflowId}`)}</span></div>
                    <span class="automation-status ${paused ? 'paused' : 'published'}">${paused ? '已暂停' : '已启用'}</span>
                </div>
                <div class="agent-automation-resource-meta">
                    <span>已触发 ${Number(trigger.triggerCount || 0)} 次</span>
                    <span>最近：${agentEscape(agentAutomationResourceDateText(trigger.lastTriggeredAt))}</span>
                    ${trigger.triggerType === 'webhook' && trigger.tokenHint ? `<span>令牌尾号：${agentEscape(trigger.tokenHint)}</span>` : ''}
                </div>
                ${hasError ? `<p class="agent-automation-resource-error">最近错误：${agentEscape(trigger.lastError)}</p>` : ''}
                <div class="agent-automation-resource-actions">
                    <button type="button" class="btn-secondary" data-agent-automation-resource-action="trigger-edit" data-agent-automation-resource-id="${agentEscapeAttr(trigger.id)}">编辑</button>
                    <button type="button" class="btn-secondary" data-agent-automation-resource-action="trigger-toggle" data-agent-automation-resource-id="${agentEscapeAttr(trigger.id)}">${paused ? '启用' : '暂停'}</button>
                    ${trigger.triggerType === 'webhook' ? `<button type="button" class="btn-secondary" data-agent-automation-resource-action="trigger-rotate" data-agent-automation-resource-id="${agentEscapeAttr(trigger.id)}">轮换令牌</button>` : ''}
                    <button type="button" class="btn-danger-outline" data-agent-automation-resource-action="trigger-delete" data-agent-automation-resource-id="${agentEscapeAttr(trigger.id)}">删除</button>
                </div>
            </article>`;
        }).join('')}</div>`);
        return;
    }
    if (!agentWorkflowCredentialsCache.length) {
        PivotSafeHtml.setHtml(list, '<div class="agent-automation-resources-empty"><strong>暂无凭据</strong><span>创建后可在工作流节点中以引用名使用；凭据内容只会加密保存，不会再次显示在页面上。</span></div>');
        return;
    }
    PivotSafeHtml.setHtml(list, `<div class="agent-automation-resource-rows">${agentWorkflowCredentialsCache.map(credential => {
        const ownerActions = credential.is_owner === true;
        const canRevert = ownerActions && credential.has_previous_value;
        return `<article class="agent-automation-resource-row">
            <div class="agent-automation-resource-main">
                <div><strong>${agentEscape(credential.name || '未命名凭据')}</strong><span>引用名：<code>${agentEscape(credential.slug || '-')}</code></span></div>
                <span class="automation-status ${credential.scope === 'shared' ? 'published' : ''}">${credential.scope === 'shared' ? '已共享' : '仅自己'}</span>
            </div>
            <div class="agent-automation-resource-meta">
                <span>${agentEscape(agentAutomationResourceScopeText(credential))}</span>
                <span>版本 ${Number(credential.version || 1)} · 已使用 ${Number(credential.use_count || 0)} 次</span>
                ${credential.last_used_at ? `<span>最近使用：${agentEscape(agentAutomationResourceDateText(credential.last_used_at))}</span>` : ''}
            </div>
            ${credential.description ? `<p class="agent-automation-resource-description">${agentEscape(credential.description)}</p>` : ''}
            <div class="agent-automation-resource-actions">
                ${ownerActions ? `<button type="button" class="btn-secondary" data-agent-automation-resource-action="credential-edit" data-agent-automation-resource-id="${agentEscapeAttr(credential.id)}">编辑</button><button type="button" class="btn-secondary" data-agent-automation-resource-action="credential-rotate" data-agent-automation-resource-id="${agentEscapeAttr(credential.id)}">轮换</button>${canRevert ? `<button type="button" class="btn-secondary" data-agent-automation-resource-action="credential-revert" data-agent-automation-resource-id="${agentEscapeAttr(credential.id)}">撤销轮换</button>` : ''}<button type="button" class="btn-danger-outline" data-agent-automation-resource-action="credential-delete" data-agent-automation-resource-id="${agentEscapeAttr(credential.id)}">删除</button>` : '<span class="agent-automation-resource-readonly">共享凭据仅可使用，只有所有者可以管理。</span>'}
            </div>
        </article>`;
    }).join('')}</div>`);
}

function clearAgentAutomationResourceNotice() {
    const notice = document.getElementById('agent-automation-resources-notice');
    if (!notice) return;
    notice.replaceChildren();
    notice.classList.add('hidden');
}

function showAgentAutomationWebhookNotice(token, triggerName = '') {
    const notice = document.getElementById('agent-automation-resources-notice');
    if (!notice || !token) return;
    const heading = document.createElement('strong');
    heading.textContent = `${triggerName || 'Webhook 触发器'}已生成新的访问地址`;
    const copy = document.createElement('span');
    copy.textContent = '访问令牌只显示这一次。请立即保存；关闭此窗口后只能重新轮换令牌。';
    const controls = document.createElement('div');
    controls.className = 'agent-automation-resource-secret-controls';
    const field = document.createElement('textarea');
    field.className = 'form-input';
    field.readOnly = true;
    field.rows = 2;
    field.setAttribute('aria-label', 'Webhook 地址，仅本次显示');
    const origin = window.location?.origin && window.location.origin !== 'null' ? window.location.origin : '';
    field.value = `${origin}/hooks/workflow/${token}`;
    const copyButton = document.createElement('button');
    copyButton.type = 'button';
    copyButton.className = 'btn-secondary';
    copyButton.textContent = '复制地址';
    copyButton.addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(field.value);
            showToast('Webhook 地址已复制', 'success');
        } catch (_error) {
            field.focus();
            field.select();
            const copied = document.execCommand('copy');
            showToast(copied ? 'Webhook 地址已复制' : '复制失败，请手动复制', copied ? 'success' : 'error');
        }
    });
    controls.append(field, copyButton);
    notice.replaceChildren(heading, copy, controls);
    notice.classList.remove('hidden');
}

function agentAutomationTriggerConfig(type, config = {}) {
    if (type === 'webhook') return {
        inputMapping: config.inputMapping || config.input_mapping || {},
        staticInputs: config.staticInputs || config.static_inputs || {},
        dedupePath: config.dedupePath || config.dedupe_path || '',
        goalTemplate: config.goalTemplate || config.goal_template || ''
    };
    if (type === 'file') return {
        directory: config.directory || '',
        extensions: Array.isArray(config.extensions) ? config.extensions.join(', ') : String(config.extensions || ''),
        inputName: config.inputName || config.input_name || 'filePath',
        goalTemplate: config.goalTemplate || config.goal_template || ''
    };
    return {
        connectionId: config.connectionId || config.connection_id || '',
        query: config.query || '',
        watermarkField: config.watermarkField || config.watermark_field || 'updated_at',
        initialWatermark: config.initialWatermark || config.initial_watermark || '',
        inputName: config.inputName || config.input_name || 'rows',
        goalTemplate: config.goalTemplate || config.goal_template || ''
    };
}

function agentAutomationTriggerConfigFields(type, config) {
    if (type === 'webhook') return `
        <div class="agent-automation-resources-form-grid">
            <label><span>输入映射（JSON）</span><textarea class="form-input" name="inputMappingJson" rows="5" spellcheck="false" placeholder='{"订单号":"data.order.id"}'>${agentEscape(JSON.stringify(config.inputMapping || {}, null, 2))}</textarea><small>键为工作流输入名，值为 Webhook JSON 中的字段路径；留空会把完整请求体传入 <code>payload</code>。</small></label>
            <label><span>固定输入（JSON）</span><textarea class="form-input" name="staticInputsJson" rows="5" spellcheck="false" placeholder='{"来源":"ERP"}'>${agentEscape(JSON.stringify(config.staticInputs || {}, null, 2))}</textarea><small>每次触发都会附加的工作流输入。</small></label>
        </div>
        <label><span>去重字段路径</span><input class="form-input" name="dedupePath" type="text" maxlength="120" value="${agentEscapeAttr(config.dedupePath)}" placeholder="例如 data.eventId"></label>
        <label><span>运行目标说明</span><textarea class="form-input" name="goalTemplate" rows="3" maxlength="2000" placeholder="例如：处理来自 ERP 的订单变更">${agentEscape(config.goalTemplate)}</textarea></label>`;
    if (type === 'file') return `
        <label><span>监听目录</span><input class="form-input" name="directory" type="text" required maxlength="400" value="${agentEscapeAttr(config.directory)}" placeholder="选择已授权的报告目录"></label>
        <div class="agent-automation-resources-form-grid">
            <label><span>文件扩展名</span><input class="form-input" name="extensions" type="text" maxlength="260" value="${agentEscapeAttr(config.extensions)}" placeholder="csv, xlsx, pdf；留空表示全部"></label>
            <label><span>工作流输入名</span><input class="form-input" name="inputName" type="text" maxlength="80" value="${agentEscapeAttr(config.inputName)}" placeholder="filePath"></label>
        </div>
        <label><span>运行目标说明</span><textarea class="form-input" name="goalTemplate" rows="3" maxlength="2000" placeholder="例如：处理新落地的报告文件">${agentEscape(config.goalTemplate)}</textarea></label>`;
    return `
        <label><span>数据库连接 ID</span><input class="form-input" name="connectionId" type="text" required maxlength="80" value="${agentEscapeAttr(config.connectionId)}" placeholder="填写工具库中已授权的数据库连接 ID"></label>
        <label><span>增量查询 SQL</span><textarea class="form-input" name="query" rows="6" required maxlength="4000" spellcheck="false" placeholder="SELECT * FROM orders WHERE updated_at > '{{watermark}}'">${agentEscape(config.query)}</textarea><small>必须是只读查询，并包含 <code>{{watermark}}</code> 占位符。</small></label>
        <div class="agent-automation-resources-form-grid">
            <label><span>水位线字段</span><input class="form-input" name="watermarkField" type="text" maxlength="80" value="${agentEscapeAttr(config.watermarkField)}" placeholder="updated_at"></label>
            <label><span>初始水位线</span><input class="form-input" name="initialWatermark" type="text" maxlength="120" value="${agentEscapeAttr(config.initialWatermark)}" placeholder="首次轮询起点"></label>
            <label><span>工作流输入名</span><input class="form-input" name="inputName" type="text" maxlength="80" value="${agentEscapeAttr(config.inputName)}" placeholder="rows"></label>
        </div>
        <label><span>运行目标说明</span><textarea class="form-input" name="goalTemplate" rows="3" maxlength="2000" placeholder="例如：处理订单状态变化">${agentEscape(config.goalTemplate)}</textarea></label>`;
}

function agentAutomationCredentialShareFields(credential, options = {}) {
    const scope = credential?.scope === 'shared' ? 'shared' : 'personal';
    const allowedUnits = Array.isArray(credential?.allowed_units) ? credential.allowed_units : [];
    const allowedUserIds = new Set((Array.isArray(credential?.allowed_user_ids) ? credential.allowed_user_ids : []).map(Number));
    const availableUnits = Array.isArray(options.units) ? options.units.filter(Boolean) : [];
    const users = Array.isArray(options.users) ? options.users.filter(item => Number(item?.id) > 0) : [];
    const canShareAll = options.canShareAll === true;
    const allShared = scope === 'shared' && canShareAll && !allowedUnits.length && !allowedUserIds.size;
    const units = [...new Set([...availableUnits, ...allowedUnits])];
    const usersByUnit = new Map();
    users.forEach(user => {
        const unit = String(user.unit || '').trim() || '未设置单位';
        if (!usersByUnit.has(unit)) usersByUnit.set(unit, []);
        usersByUnit.get(unit).push(user);
    });
    const groupUnits = [...new Set([...units, ...usersByUnit.keys()])].sort((left, right) => left.localeCompare(right, 'zh-CN'));
    return `
        <fieldset class="agent-workflow-share-scope-fieldset">
            <legend>可用范围</legend>
            <label class="agent-workflow-share-choice"><input type="radio" name="credentialScope" value="personal" ${scope === 'personal' ? 'checked' : ''}><span><strong>仅自己</strong><small>只有本人可在工作流中引用此凭据。</small></span></label>
            <label class="agent-workflow-share-choice"><input type="radio" name="credentialScope" value="shared" ${scope === 'shared' ? 'checked' : ''}><span><strong>共享</strong><small>接收方只能使用，不能查看或修改凭据内容。</small></span></label>
        </fieldset>
        <section class="agent-workflow-share-units-section ${scope === 'shared' ? '' : 'hidden'}" data-agent-automation-share-section aria-label="共享对象">
            <label class="agent-workflow-share-all ${canShareAll ? '' : 'hidden'}"><input type="checkbox" data-agent-automation-share-all ${allShared ? 'checked' : ''}><span>共享给全体成员</span></label>
            <div class="agent-workflow-share-units-head"><div><strong>共享对象</strong><span>${agentEscape(canShareAll ? '可选择全体成员、单位或个人。' : (options.currentUnit ? `可共享给本单位 ${options.currentUnit}，也可精确选择个人。` : '可精确选择个人。'))}</span></div></div>
            <div class="agent-workflow-share-tree" role="tree" aria-label="单位和用户">${groupUnits.length ? groupUnits.map(unit => {
        const unitUsers = usersByUnit.get(unit) || [];
        const selectableUnit = availableUnits.includes(unit);
        const unitChecked = allowedUnits.includes(unit);
        return `<section class="agent-workflow-share-tree-unit" role="treeitem" aria-expanded="true"><div class="agent-workflow-share-tree-unit-head">${selectableUnit ? `<label class="agent-workflow-share-tree-unit-label"><input type="checkbox" data-agent-automation-share-unit="${agentEscapeAttr(unit)}" ${unitChecked ? 'checked' : ''}><span><strong>${agentEscape(unit)}</strong><small>${unitUsers.length ? `${unitUsers.length} 名用户` : '可按单位共享'}</small></span></label>` : `<span class="agent-workflow-share-tree-unit-label"><span><strong>${agentEscape(unit)}</strong><small>仅可选择个人</small></span></span>`}</div><div class="agent-workflow-share-tree-users" role="group">${unitUsers.length ? unitUsers.map(user => {
            const id = Number(user.id);
            const name = user.nickname || user.username || `用户 ${id}`;
            return `<label class="agent-workflow-share-tree-user" role="treeitem"><input type="checkbox" data-agent-automation-share-user="${id}" data-agent-automation-share-user-unit="${agentEscapeAttr(unit)}" ${allowedUserIds.has(id) || unitChecked ? 'checked' : ''}><span><strong>${agentEscape(name)}</strong><small>${agentEscape(user.username || `用户 ${id}`)}</small></span></label>`;
        }).join('') : '<span class="agent-workflow-share-tree-empty">暂无可共享用户</span>'}</div></section>`;
    }).join('') : '<div class="agent-workflow-share-empty">暂无可共享的单位或用户。</div>'}</div>
        </section>`;
}

function setAgentAutomationResourceEditorVisible(isOpen) {
    const tabs = document.getElementById('agent-automation-resources-tabs');
    const actions = document.getElementById('agent-automation-resources-actions');
    const list = document.getElementById('agent-automation-resources-list');
    const editor = document.getElementById('agent-automation-resources-editor');
    tabs?.classList.toggle('hidden', isOpen);
    actions?.classList.toggle('hidden', isOpen);
    list?.classList.toggle('hidden', isOpen);
    editor?.classList.toggle('hidden', !isOpen);
}

function resetAgentAutomationResourceEditor() {
    agentAutomationResourceEditorState = null;
    const editor = document.getElementById('agent-automation-resources-editor');
    if (editor) editor.replaceChildren();
    setAgentAutomationResourceEditorVisible(false);
    renderAgentAutomationResourceList();
}

function agentAutomationPublishedWorkflows(selectedId = '') {
    const available = agentWorkflowsCache.filter(workflow => Number(workflow.published_version || 0) > 0);
    const selected = agentWorkflowsCache.find(workflow => String(workflow.id) === String(selectedId));
    if (selected && !available.some(workflow => String(workflow.id) === String(selected.id))) available.unshift(selected);
    return available;
}

function renderAgentAutomationResourceEditor(kind, item = null, draft = {}) {
    const editor = document.getElementById('agent-automation-resources-editor');
    const subtitle = document.getElementById('agent-automation-resources-subtitle');
    if (!editor) return;
    clearAgentAutomationResourceNotice();
    const isTrigger = kind === 'trigger';
    const isRotation = kind === 'credential-rotate';
    const triggerType = draft.triggerType || item?.triggerType || 'webhook';
    agentAutomationResourceEditorState = { kind, id: item?.id ? String(item.id) : '', triggerType };
    setAgentAutomationResourceEditorVisible(true);
    if (subtitle) subtitle.textContent = isTrigger
        ? '触发器只会启动已发布工作流；运行权限和依赖配置仍由工作流自身控制。'
        : (isRotation ? '新值将立即生效，当前值保留 24 小时，期间可撤销本次轮换。' : '凭据内容只会加密写入服务端，不会返回或再次显示。');
    if (isRotation) {
        PivotSafeHtml.setHtml(editor, `
            <div class="agent-automation-resources-editor-head"><strong>轮换凭据：${agentEscape(item?.name || '')}</strong><button type="button" class="btn-secondary" data-agent-automation-resource-back>返回列表</button></div>
            <label><span>新的凭据内容</span><textarea class="form-input" name="secretValue" rows="5" required maxlength="8192" autocomplete="new-password" placeholder="粘贴新的密钥、Token 或密码"></textarea><small>保存后仅用于运行时注入，系统不会再次显示该内容。</small></label>
            <div class="agent-automation-resources-editor-error" role="alert" hidden></div>
            <div class="agent-automation-resources-editor-footer"><button type="button" class="btn-secondary" data-agent-automation-resource-back>取消</button><button type="submit" class="btn-primary">确认轮换</button></div>`);
        requestAnimationFrame(() => editor.elements.secretValue?.focus());
        return;
    }
    if (isTrigger) {
        const config = agentAutomationTriggerConfig(triggerType, draft.config || item?.config || {});
        const workflows = agentAutomationPublishedWorkflows(draft.workflowId || item?.workflowId || activeAgentWorkflowId);
        const workflowId = String(draft.workflowId || item?.workflowId || activeAgentWorkflowId || '');
        PivotSafeHtml.setHtml(editor, `
            <div class="agent-automation-resources-editor-head"><strong>${item ? '编辑触发器' : '新建触发器'}</strong><button type="button" class="btn-secondary" data-agent-automation-resource-back>返回列表</button></div>
            <div class="agent-automation-resources-form-grid">
                <label><span>触发器名称</span><input class="form-input" name="name" type="text" required minlength="2" maxlength="80" value="${agentEscapeAttr(draft.name ?? item?.name ?? '')}" placeholder="例如：ERP 订单变更"></label>
                <label><span>已发布工作流</span><select class="form-input" name="workflowId" required><option value="">请选择已发布工作流</option>${workflows.map(workflow => `<option value="${agentEscapeAttr(workflow.id)}" ${String(workflow.id) === workflowId ? 'selected' : ''}>${agentEscape(workflow.name)} · 已发布版本 ${Number(workflow.published_version || 0)}</option>`).join('')}</select></label>
                <label><span>触发方式</span><select class="form-input" name="triggerType" ${item ? 'disabled' : ''}><option value="webhook" ${triggerType === 'webhook' ? 'selected' : ''}>入站 Webhook</option><option value="file" ${triggerType === 'file' ? 'selected' : ''}>文件落地</option><option value="database" ${triggerType === 'database' ? 'selected' : ''}>数据变更</option></select></label>
                <label><span>状态</span><select class="form-input" name="status"><option value="active" ${(draft.status ?? item?.status ?? 'active') === 'active' ? 'selected' : ''}>创建后立即启用</option><option value="paused" ${(draft.status ?? item?.status) === 'paused' ? 'selected' : ''}>创建后保持暂停</option></select></label>
            </div>
            <section class="agent-automation-resources-config"><strong>${agentEscape(agentAutomationResourceTypeLabel(triggerType))} 配置</strong>${agentAutomationTriggerConfigFields(triggerType, config)}</section>
            <div class="agent-automation-resources-editor-error" role="alert" hidden></div>
            <div class="agent-automation-resources-editor-footer"><button type="button" class="btn-secondary" data-agent-automation-resource-back>取消</button><button type="submit" class="btn-primary">${item ? '保存触发器' : '创建触发器'}</button></div>`);
        editor.elements.name?.focus();
        return;
    }
    const scopeOptions = agentAutomationShareOptions || {};
    PivotSafeHtml.setHtml(editor, `
        <div class="agent-automation-resources-editor-head"><strong>${item ? '编辑凭据' : '新建凭据'}</strong><button type="button" class="btn-secondary" data-agent-automation-resource-back>返回列表</button></div>
        <div class="agent-automation-resources-form-grid">
            <label><span>凭据名称</span><input class="form-input" name="name" type="text" required maxlength="80" value="${agentEscapeAttr(draft.name ?? item?.name ?? '')}" placeholder="例如：ERP 生产环境 API"></label>
            <label><span>引用名</span><input class="form-input" name="slug" type="text" required minlength="2" maxlength="64" pattern="[A-Za-z0-9_ -]+" value="${agentEscapeAttr(draft.slug ?? item?.slug ?? '')}" placeholder="例如：ERP_API_KEY" autocapitalize="characters"></label>
        </div>
        <label><span>用途说明</span><textarea class="form-input" name="description" rows="3" maxlength="500" placeholder="说明凭据对应的系统和用途">${agentEscape(draft.description ?? item?.description ?? '')}</textarea></label>
        ${!item ? '<label><span>凭据内容</span><textarea class="form-input" name="secretValue" rows="5" required maxlength="8192" autocomplete="new-password" placeholder="粘贴密钥、Token 或密码"></textarea><small>保存后内容会加密存储，页面不会再次显示。</small></label>' : ''}
        ${agentAutomationCredentialShareFields(item, scopeOptions)}
        <div class="agent-automation-resources-editor-error" role="alert" hidden></div>
        <div class="agent-automation-resources-editor-footer"><button type="button" class="btn-secondary" data-agent-automation-resource-back>取消</button><button type="submit" class="btn-primary">${item ? '保存凭据' : '创建凭据'}</button></div>`);
    editor.elements.name?.focus();
    syncAgentAutomationResourceShareControls();
}

function setAgentAutomationResourceEditorError(message = '') {
    const error = document.querySelector('#agent-automation-resources-editor .agent-automation-resources-editor-error');
    if (!error) return;
    error.textContent = message;
    error.hidden = !message;
}

function syncAgentAutomationResourceShareControls() {
    const editor = document.getElementById('agent-automation-resources-editor');
    if (!editor) return;
    const scope = editor.querySelector('input[name="credentialScope"]:checked')?.value || 'personal';
    const section = editor.querySelector('[data-agent-automation-share-section]');
    const all = editor.querySelector('[data-agent-automation-share-all]');
    const disabled = scope !== 'shared' || all?.checked === true;
    section?.classList.toggle('hidden', scope !== 'shared');
    editor.querySelectorAll('[data-agent-automation-share-unit], [data-agent-automation-share-user]').forEach(input => {
        input.disabled = disabled;
    });
}

function parseAgentAutomationResourceObject(value, label) {
    const text = String(value || '').trim();
    if (!text) return {};
    try {
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
        return parsed;
    } catch (_error) {
        throw new Error(`${label}必须是 JSON 对象。`);
    }
}

function readAgentAutomationTriggerEditor() {
    const editor = document.getElementById('agent-automation-resources-editor');
    const state = agentAutomationResourceEditorState;
    const type = state?.triggerType || 'webhook';
    const name = String(editor?.elements.name?.value || '').trim();
    const workflowId = String(editor?.elements.workflowId?.value || '').trim();
    const status = editor?.elements.status?.value === 'paused' ? 'paused' : 'active';
    if (!name) throw new Error('请填写触发器名称。');
    if (!workflowId) throw new Error('请选择已发布工作流。');
    let config;
    if (type === 'webhook') {
        config = {
            inputMapping: parseAgentAutomationResourceObject(editor.elements.inputMappingJson?.value, '输入映射'),
            staticInputs: parseAgentAutomationResourceObject(editor.elements.staticInputsJson?.value, '固定输入'),
            dedupePath: String(editor.elements.dedupePath?.value || '').trim(),
            goalTemplate: String(editor.elements.goalTemplate?.value || '').trim()
        };
    } else if (type === 'file') {
        config = {
            directory: String(editor.elements.directory?.value || '').trim(),
            extensions: String(editor.elements.extensions?.value || '').split(',').map(value => value.trim()).filter(Boolean),
            inputName: String(editor.elements.inputName?.value || '').trim(),
            goalTemplate: String(editor.elements.goalTemplate?.value || '').trim()
        };
        if (!config.directory) throw new Error('请填写监听目录。');
    } else {
        config = {
            connectionId: String(editor.elements.connectionId?.value || '').trim(),
            query: String(editor.elements.query?.value || '').trim(),
            watermarkField: String(editor.elements.watermarkField?.value || '').trim(),
            initialWatermark: String(editor.elements.initialWatermark?.value || '').trim(),
            inputName: String(editor.elements.inputName?.value || '').trim(),
            goalTemplate: String(editor.elements.goalTemplate?.value || '').trim()
        };
        if (!config.connectionId || !config.query) throw new Error('请填写数据库连接 ID 和增量查询 SQL。');
        if (!config.query.includes('{{watermark}}')) throw new Error('增量查询 SQL 必须包含 {{watermark}} 占位符。');
    }
    return { name, workflowId, status, triggerType: type, config };
}

function readAgentAutomationCredentialShare(editor) {
    const scope = editor.querySelector('input[name="credentialScope"]:checked')?.value || 'personal';
    if (scope !== 'shared') return { scope: 'personal', allowedUnits: [], allowedUserIds: [] };
    const all = editor.querySelector('[data-agent-automation-share-all]');
    if (all?.checked) return { scope, allowedUnits: [], allowedUserIds: [] };
    const allowedUnits = [...editor.querySelectorAll('[data-agent-automation-share-unit]:checked')]
        .map(input => input.dataset.agentAutomationShareUnit)
        .filter(Boolean);
    const allowedUserIds = [...editor.querySelectorAll('[data-agent-automation-share-user]:checked')]
        .filter(input => !allowedUnits.includes(input.dataset.agentAutomationShareUserUnit || ''))
        .map(input => Number(input.dataset.agentAutomationShareUser))
        .filter(Number.isSafeInteger);
    if (!allowedUnits.length && !allowedUserIds.length) throw new Error('共享时至少选择一个单位或一个个人；管理员也可以共享给全体成员。');
    return { scope, allowedUnits, allowedUserIds };
}

function readAgentAutomationCredentialEditor() {
    const editor = document.getElementById('agent-automation-resources-editor');
    const name = String(editor?.elements.name?.value || '').trim();
    const slug = String(editor?.elements.slug?.value || '').trim();
    if (!name || !slug) throw new Error('请填写凭据名称和引用名。');
    const share = readAgentAutomationCredentialShare(editor);
    return {
        name,
        slug,
        description: String(editor.elements.description?.value || '').trim(),
        secretValue: String(editor.elements.secretValue?.value || ''),
        ...share
    };
}

async function loadAgentAutomationShareOptions() {
    if (agentAutomationShareOptions) return agentAutomationShareOptions;
    const response = await apiFetch(`${API_BASE}/agents/workflows/share-options`);
    agentAutomationShareOptions = await readAgentAutomationResourceResponse(response, '共享范围加载失败');
    return agentAutomationShareOptions;
}

async function runAgentAutomationResourceAction(key, button, task) {
    if (agentAutomationResourceActionLocks.has(key)) return null;
    agentAutomationResourceActionLocks.add(key);
    if (button) {
        button.disabled = true;
        button.setAttribute('aria-busy', 'true');
    }
    try {
        return await task();
    } finally {
        agentAutomationResourceActionLocks.delete(key);
        if (button?.isConnected) {
            button.disabled = false;
            button.removeAttribute('aria-busy');
        }
    }
}

async function confirmAgentAutomationResource(title, message) {
    if (typeof showConfirm === 'function') return await showConfirm(title, message);
    return window.confirm(message);
}

async function saveAgentAutomationResource(event) {
    event.preventDefault();
    const state = agentAutomationResourceEditorState;
    const editor = document.getElementById('agent-automation-resources-editor');
    const submit = editor?.querySelector('button[type="submit"]');
    if (!state || !editor || !submit) return;
    setAgentAutomationResourceEditorError('');
    try {
        await runAgentAutomationResourceAction(`${state.kind}:${state.id || 'new'}`, submit, async () => {
            if (state.kind === 'trigger') {
                const payload = readAgentAutomationTriggerEditor();
                const endpoint = state.id ? `${API_BASE}/agents/triggers/${encodeURIComponent(state.id)}` : `${API_BASE}/agents/triggers`;
                const response = await apiFetch(endpoint, {
                    method: state.id ? 'PUT' : 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                const data = await readAgentAutomationResourceResponse(response, state.id ? '触发器保存失败' : '触发器创建失败');
                await loadAgentAutomationResources();
                resetAgentAutomationResourceEditor();
                if (data.token) showAgentAutomationWebhookNotice(data.token, data.trigger?.name || payload.name);
                showToast(state.id ? '触发器已保存' : '触发器已创建', 'success');
                return;
            }
            if (state.kind === 'credential-rotate') {
                const secretValue = String(editor.elements.secretValue?.value || '');
                if (!secretValue.trim()) throw new Error('请填写新的凭据内容。');
                const response = await apiFetch(`${API_BASE}/agents/credentials/${encodeURIComponent(state.id)}/rotate`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ secretValue })
                });
                await readAgentAutomationResourceResponse(response, '凭据轮换失败');
                await loadAgentAutomationResources();
                resetAgentAutomationResourceEditor();
                showToast('凭据已轮换，旧值将在 24 小时后自动失效', 'success');
                return;
            }
            const payload = readAgentAutomationCredentialEditor();
            if (!state.id && !payload.secretValue.trim()) throw new Error('请填写凭据内容。');
            const endpoint = state.id ? `${API_BASE}/agents/credentials/${encodeURIComponent(state.id)}` : `${API_BASE}/agents/credentials`;
            const response = await apiFetch(endpoint, {
                method: state.id ? 'PUT' : 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            await readAgentAutomationResourceResponse(response, state.id ? '凭据保存失败' : '凭据创建失败');
            await loadAgentAutomationResources();
            resetAgentAutomationResourceEditor();
            showToast(state.id ? '凭据已保存' : '凭据已创建，内容已加密保存', 'success');
        });
    } catch (error) {
        setAgentAutomationResourceEditorError(error.message || '保存失败，请稍后重试');
    }
}

async function handleAgentAutomationResourceAction(button) {
    const action = button.dataset.agentAutomationResourceAction;
    const id = button.dataset.agentAutomationResourceId;
    const trigger = agentWorkflowTriggersCache.find(item => String(item.id) === String(id));
    const credential = agentWorkflowCredentialsCache.find(item => String(item.id) === String(id));
    if (action === 'trigger-edit' && trigger) return renderAgentAutomationResourceEditor('trigger', trigger);
    if (action === 'credential-edit' && credential) {
        try {
            await loadAgentAutomationShareOptions();
            renderAgentAutomationResourceEditor('credential', credential);
        } catch (error) {
            showToast(error.message || '共享范围加载失败', 'error');
        }
        return;
    }
    if (action === 'credential-rotate' && credential) return renderAgentAutomationResourceEditor('credential-rotate', credential);
    if (action === 'trigger-toggle' && trigger) {
        await runAgentAutomationResourceAction(`trigger-toggle:${id}`, button, async () => {
            const response = await apiFetch(`${API_BASE}/agents/triggers/${encodeURIComponent(id)}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: trigger.name,
                    workflowId: trigger.workflowId,
                    status: trigger.status === 'paused' ? 'active' : 'paused',
                    config: trigger.config || {}
                })
            });
            await readAgentAutomationResourceResponse(response, '触发器状态更新失败');
            await loadAgentAutomationResources();
            showToast(trigger.status === 'paused' ? '触发器已启用' : '触发器已暂停', 'success');
        }).catch(error => showToast(error.message || '触发器状态更新失败', 'error'));
        return;
    }
    if (action === 'trigger-rotate' && trigger) {
        const confirmed = await confirmAgentAutomationResource('轮换 Webhook 令牌', `轮换后，当前地址将立即失效。确定为「${trigger.name}」轮换令牌吗？`);
        if (!confirmed) return;
        await runAgentAutomationResourceAction(`trigger-rotate:${id}`, button, async () => {
            const response = await apiFetch(`${API_BASE}/agents/triggers/${encodeURIComponent(id)}/rotate-token`, { method: 'POST' });
            const data = await readAgentAutomationResourceResponse(response, 'Webhook 令牌轮换失败');
            await loadAgentAutomationResources();
            showAgentAutomationWebhookNotice(data.token, data.trigger?.name || trigger.name);
            showToast('Webhook 令牌已轮换', 'success');
        }).catch(error => showToast(error.message || 'Webhook 令牌轮换失败', 'error'));
        return;
    }
    if (action === 'credential-revert' && credential) {
        const confirmed = await confirmAgentAutomationResource('撤销凭据轮换', `确定撤销「${credential.name}」最近一次轮换吗？当前值会恢复为上一版本。`);
        if (!confirmed) return;
        await runAgentAutomationResourceAction(`credential-revert:${id}`, button, async () => {
            const response = await apiFetch(`${API_BASE}/agents/credentials/${encodeURIComponent(id)}/revert`, { method: 'POST' });
            await readAgentAutomationResourceResponse(response, '撤销凭据轮换失败');
            await loadAgentAutomationResources();
            showToast('已撤销最近一次凭据轮换', 'success');
        }).catch(error => showToast(error.message || '撤销凭据轮换失败', 'error'));
        return;
    }
    const isTrigger = action === 'trigger-delete';
    const resource = isTrigger ? trigger : credential;
    if (!resource || action !== 'trigger-delete' && action !== 'credential-delete') return;
    const confirmed = await confirmAgentAutomationResource(isTrigger ? '删除触发器' : '删除凭据', isTrigger
        ? `确定删除「${resource.name}」吗？Webhook 地址会立即失效，历史运行记录不会删除。`
        : `确定删除「${resource.name}」吗？密文会被清空，工作流中的同名引用将无法继续使用。`);
    if (!confirmed) return;
    const endpoint = isTrigger ? `${API_BASE}/agents/triggers/${encodeURIComponent(id)}` : `${API_BASE}/agents/credentials/${encodeURIComponent(id)}`;
    await runAgentAutomationResourceAction(`${isTrigger ? 'trigger' : 'credential'}-delete:${id}`, button, async () => {
        const response = await apiFetch(endpoint, { method: 'DELETE' });
        await readAgentAutomationResourceResponse(response, isTrigger ? '触发器删除失败' : '凭据删除失败');
        await loadAgentAutomationResources();
        showToast(isTrigger ? '触发器已删除' : '凭据已删除，密文已清空', 'success');
    }).catch(error => showToast(error.message || '删除失败', 'error'));
}

function bindAgentAutomationResources() {
    const modal = agentAutomationResourceModal();
    if (!modal || modal.dataset.boundAgentAutomationResources === '1') return;
    modal.dataset.boundAgentAutomationResources = '1';
    const close = () => setAgentAutomationResourcesModalVisible(false);
    document.getElementById('agent-automation-resources-close-btn')?.addEventListener('click', close);
    document.getElementById('agent-automation-resources-cancel-btn')?.addEventListener('click', close);
    modal.addEventListener('click', event => {
        if (event.target === modal) close();
    });
    modal.addEventListener('keydown', event => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        close();
    });
    document.getElementById('agent-automation-resources-tabs')?.addEventListener('click', event => {
        const tab = event.target.closest('[data-agent-automation-resource-tab]');
        if (!tab || agentAutomationResourceEditorState) return;
        agentAutomationResourceTab = tab.dataset.agentAutomationResourceTab === 'credentials' ? 'credentials' : 'triggers';
        clearAgentAutomationResourceNotice();
        renderAgentAutomationResourceList();
        tab.focus();
    });
    document.getElementById('agent-automation-resources-tabs')?.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const tabs = [...event.currentTarget.querySelectorAll('[data-agent-automation-resource-tab]')];
        const current = tabs.findIndex(tab => tab.dataset.agentAutomationResourceTab === agentAutomationResourceTab);
        const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
        tabs[index]?.click();
    });
    document.getElementById('agent-automation-resources-new-btn')?.addEventListener('click', async () => {
        if (agentAutomationResourceTab === 'triggers') return renderAgentAutomationResourceEditor('trigger');
        try {
            await loadAgentAutomationShareOptions();
            renderAgentAutomationResourceEditor('credential');
        } catch (error) {
            showToast(error.message || '共享范围加载失败', 'error');
        }
    });
    document.getElementById('agent-automation-resources-list')?.addEventListener('click', event => {
        const button = event.target.closest('[data-agent-automation-resource-action]');
        if (button) handleAgentAutomationResourceAction(button);
    });
    document.getElementById('agent-automation-resources-editor')?.addEventListener('submit', saveAgentAutomationResource);
    document.getElementById('agent-automation-resources-editor')?.addEventListener('click', event => {
        if (event.target.closest('[data-agent-automation-resource-back]')) resetAgentAutomationResourceEditor();
    });
    document.getElementById('agent-automation-resources-editor')?.addEventListener('input', () => setAgentAutomationResourceEditorError(''));
    document.getElementById('agent-automation-resources-editor')?.addEventListener('change', event => {
        const editor = event.currentTarget;
        if (event.target.name === 'triggerType' && agentAutomationResourceEditorState?.kind === 'trigger') {
            const draft = {
                name: String(editor.elements.name?.value || ''),
                workflowId: String(editor.elements.workflowId?.value || ''),
                status: editor.elements.status?.value || 'active',
                triggerType: event.target.value
            };
            renderAgentAutomationResourceEditor('trigger', null, draft);
            return;
        }
        if (event.target.matches('input[name="credentialScope"], [data-agent-automation-share-all]')) {
            syncAgentAutomationResourceShareControls();
            return;
        }
        if (event.target.matches('[data-agent-automation-share-unit]')) {
            const unit = event.target.dataset.agentAutomationShareUnit;
            editor.querySelectorAll('[data-agent-automation-share-user-unit]').forEach(input => {
                if (input.dataset.agentAutomationShareUserUnit !== unit) return;
                if (!input.disabled) input.checked = event.target.checked;
            });
        }
    });
}

async function openAgentAutomationResources(options = {}) {
    bindAgentAutomationResources();
    agentAutomationResourceTab = options.tab === 'credentials' ? 'credentials' : 'triggers';
    resetAgentAutomationResourceEditor();
    renderAgentAutomationResourceTabs();
    setAgentAutomationResourcesModalVisible(true);
    try {
        await Promise.all([
            agentWorkflowsCache.length ? Promise.resolve() : loadAgentWorkflows(),
            loadAgentAutomationResources({ showLoading: true })
        ]);
        renderAgentAutomationResourceList();
    } catch (error) {
        showToast(error.message || '自动化资源加载失败', 'error');
    }
}

window.Pivot.exposeModule('agent.automationResources', {
    open: openAgentAutomationResources,
    refresh: () => loadAgentAutomationResources(),
    listTriggers: () => agentWorkflowTriggersCache.map(item => ({ ...item })),
    listCredentials: () => agentWorkflowCredentialsCache.map(item => ({ ...item }))
});
