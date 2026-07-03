// 管理员工具策略页
const toolPolicyEscape = (value) => escapeHtml(value === undefined || value === null ? '' : String(value));
const TOOL_POLICY_PAGE_SIZE = 18;
let toolPolicyPackagesCache = [];
let toolPolicyToolsCache = [];
let toolPolicySelectedPackageKey = '';
let toolPolicySelectedToolKey = '';

function toolPolicyTypeLabel(type) {
    if (type === 'builtin_tool') return '系统工具';
    if (type === 'database_connection') return '数据库连接';
    if (type === 'mcp_server') return '工具服务';
    return '工具包';
}

function toolPolicyRiskLabel(level) {
    if (level === 'low') return '低风险';
    if (level === 'high') return '高风险';
    return '中风险';
}

function toolPolicyCanEditPackage(item) {
    if (!item) return false;
    return isSuperAdminUser();
}

function toolPolicyIsGlobalPackage(item) {
    return item && !item.user_id && (item.scope === 'global' || item.scope === 'admin');
}

function toolPolicySelectedPackage() {
    return toolPolicyPackagesCache.find(item => item.package_key === toolPolicySelectedPackageKey) || null;
}

function toolPolicyToolName(tool) {
    return tool?.name || tool?.fullName || '';
}

function toolPolicyEntryKey(item, tool) {
    return `${item?.package_key || ''}::${toolPolicyToolName(tool)}`;
}

function toolPolicyEntryByKey(key) {
    return toolPolicyToolsCache.find(entry => entry.key === key) || null;
}

function toolPolicySelectedToolEntry() {
    return toolPolicyEntryByKey(toolPolicySelectedToolKey);
}

function toolPolicyGovernance(tool) {
    return tool?.governance || {};
}

function toolPolicyToolPayload(tool, patch = {}) {
    const governance = toolPolicyGovernance(tool);
    return {
        enabled: governance.enabled !== false,
        riskLevel: governance.riskLevel || 'medium',
        approvalRequired: Boolean(governance.approvalRequired),
        usage: governance.usage || '',
        ...patch
    };
}

function renderToolPolicyMessage(message, options = {}) {
    const body = document.getElementById('tool-policy-tool-body');
    const pagination = document.getElementById('pagination-tool-policy');
    if (!body) return;
    if (pagination) pagination.replaceChildren();
    body.className = 'tool-policy-tool-grid has-message';
    PivotSafeHtml.setHtml(body, `
        <div class="tool-policy-empty${options.error ? ' is-error' : ''}">
            ${toolPolicyEscape(message)}
        </div>
    `);
}

function updateToolPolicyCount() {
    const count = document.getElementById('tool-policy-tool-count');
    if (count) count.textContent = `${toolPolicyToolsCache.length} 个工具`;
}

function toolPolicyCurrentPage() {
    const page = typeof pageState === 'undefined' ? 1 : Number.parseInt(pageState['tool-policy'], 10);
    return Number.isFinite(page) && page > 0 ? page : 1;
}

function setToolPolicyPage(page) {
    if (typeof pageState !== 'undefined') {
        pageState['tool-policy'] = page;
    }
}

function toolPolicyPageEntries() {
    const totalPages = Math.max(Math.ceil(toolPolicyToolsCache.length / TOOL_POLICY_PAGE_SIZE), 1);
    const page = Math.min(toolPolicyCurrentPage(), totalPages);
    setToolPolicyPage(page);
    const start = (page - 1) * TOOL_POLICY_PAGE_SIZE;
    return {
        entries: toolPolicyToolsCache.slice(start, start + TOOL_POLICY_PAGE_SIZE),
        page
    };
}

function renderToolPolicyPagination(page) {
    const container = document.getElementById('pagination-tool-policy');
    if (!container) return;
    container.replaceChildren();
    const total = toolPolicyToolsCache.length;
    const totalPages = Math.ceil(total / TOOL_POLICY_PAGE_SIZE);
    if (totalPages <= 1) return;

    const createButton = (label, targetPage, disabled) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'btn-secondary';
        button.disabled = disabled;
        button.dataset.paginationTab = 'tool-policy';
        button.dataset.paginationPage = String(targetPage);
        button.textContent = label;
        return button;
    };

    const summary = document.createElement('span');
    summary.style.margin = '0 15px';
    summary.style.fontWeight = '500';
    summary.textContent = `第 ${page} / ${totalPages} 页 (共 ${total} 条)`;

    container.append(
        createButton('首页', 1, page === 1),
        createButton('上一页', page - 1, page === 1),
        summary,
        createButton('下一页', page + 1, page === totalPages),
        createButton('末页', totalPages, page === totalPages)
    );
}

function renderToolPolicyGovernancePanel(entry = null) {
    const panel = document.getElementById('tool-policy-governance-panel');
    const shell = document.getElementById('tool-policy-tool-shell');
    if (!panel) return;
    const open = Boolean(entry?.tool && entry?.item);
    if (shell) shell.classList.toggle('has-governance-open', open);
    if (!open) {
        panel.hidden = true;
        PivotSafeHtml.setHtml(panel, '');
        return;
    }
    const { item, tool, key } = entry;
    const editable = toolPolicyCanEditPackage(item);
    const governance = toolPolicyGovernance(tool);
    const riskLevel = governance.riskLevel || 'medium';
    const approvalRequired = Boolean(governance.approvalRequired);
    const name = toolPolicyToolName(tool);
    const title = tool.title || name;
    panel.hidden = false;
    PivotSafeHtml.setHtml(panel, `
        <div class="tool-policy-governance-head">
            <div>
                <strong>${toolPolicyEscape(title)}</strong>
                <small title="${toolPolicyEscape(name)}">${toolPolicyEscape(toolPolicyTypeLabel(item.type))} · ${toolPolicyEscape(item.name || item.package_key)}</small>
            </div>
        </div>
        <div class="tool-policy-governance-body">
            <label class="tool-policy-form-field">
                <span>风险等级</span>
                <select class="form-input" data-tool-policy-risk="${toolPolicyEscape(key)}" ${editable ? '' : 'disabled'}>
                    <option value="low" ${riskLevel === 'low' ? 'selected' : ''}>低风险</option>
                    <option value="medium" ${riskLevel === 'medium' ? 'selected' : ''}>中风险</option>
                    <option value="high" ${riskLevel === 'high' ? 'selected' : ''}>高风险</option>
                </select>
            </label>
            <label class="tool-policy-switch-row${editable ? '' : ' is-readonly'}">
                <span>
                    <strong>审批要求</strong>
                    <small>${approvalRequired ? '调用前需要审批' : '无需额外审批'}</small>
                </span>
                <span class="tool-policy-switch-control">
                    <input type="checkbox" data-tool-policy-approval="${toolPolicyEscape(key)}" ${approvalRequired ? 'checked' : ''} ${editable ? '' : 'disabled'}>
                    <span class="tool-policy-switch-track"></span>
                </span>
            </label>
            <label class="tool-policy-form-field">
                <span>适用说明</span>
                <textarea class="form-input" rows="4" data-tool-policy-usage="${toolPolicyEscape(key)}" placeholder="${toolPolicyEscape(toolPolicyRiskLabel(riskLevel))}" ${editable ? '' : 'disabled'}>${toolPolicyEscape(governance.usage || '')}</textarea>
            </label>
            <div class="tool-policy-governance-actions">
                <button type="button" class="btn-secondary" data-tool-policy-close>取消</button>
                <button type="button" class="btn-primary tool-policy-save-governance" data-tool-policy-save="${toolPolicyEscape(key)}" ${editable ? '' : 'disabled'}>保存</button>
            </div>
        </div>
    `);
    panel.querySelector('[data-tool-policy-close]')?.addEventListener('click', () => window.closeToolPolicyGovernancePanel());
    panel.querySelector('[data-tool-policy-save]')?.addEventListener('click', event => window.saveToolPolicyTool(event.currentTarget));
}

function renderToolPolicyTools() {
    const body = document.getElementById('tool-policy-tool-body');
    if (!body) return;
    updateToolPolicyCount();
    const { entries, page } = toolPolicyPageEntries();
    renderToolPolicyPagination(page);
    if (!toolPolicyToolsCache.length) {
        toolPolicySelectedToolKey = '';
        renderToolPolicyMessage(toolPolicyPackagesCache.length ? '暂无可治理工具，请先在工具箱刷新工具列表。' : '暂无全局工具包');
        renderToolPolicyGovernancePanel(null);
        return;
    }
    if (toolPolicySelectedToolKey && !toolPolicySelectedToolEntry()) {
        toolPolicySelectedToolKey = '';
    }
    body.className = 'tool-policy-tool-grid';
    PivotSafeHtml.setHtml(body, entries.map(entry => {
        const { item, tool, key } = entry;
        const editable = toolPolicyCanEditPackage(item);
        const governance = toolPolicyGovernance(tool);
        const enabled = governance.enabled !== false;
        const packageEnabled = item.enabled !== false;
        const riskLevel = governance.riskLevel || 'medium';
        const approvalRequired = Boolean(governance.approvalRequired);
        const name = toolPolicyToolName(tool);
        const title = tool.title || name;
        const active = key === toolPolicySelectedToolKey;
        return `
            <article class="tool-policy-tool-card${active ? ' active' : ''}${enabled && packageEnabled ? ' is-enabled' : ' is-disabled'}${tool.stale ? ' is-stale' : ''}">
                <header class="tool-policy-tool-card-head">
                    <div class="tool-policy-tool-title">
                        <strong title="${toolPolicyEscape(title)}">${toolPolicyEscape(title)}</strong>
                        <em title="${toolPolicyEscape(item.name || item.package_key)}">${toolPolicyEscape(toolPolicyTypeLabel(item.type))}</em>
                    </div>
                    <button class="tool-policy-status-toggle${enabled && packageEnabled ? ' is-on' : ''}" type="button" data-tool-policy-toggle="${toolPolicyEscape(key)}" data-next-enabled="${enabled && packageEnabled ? 'false' : 'true'}" aria-label="${enabled && packageEnabled ? '停用工具' : '启用工具'}" title="${enabled && packageEnabled ? '停用工具' : '启用工具'}" ${editable ? '' : 'disabled'}>
                        <span></span>
                    </button>
                </header>
                <p>${toolPolicyEscape(tool.description || (tool.stale ? '当前缓存中未找到该工具' : name))}</p>
                <div class="tool-policy-card-meta" title="${toolPolicyEscape(name)}">${toolPolicyEscape(name)}</div>
                <footer>
                    <span class="tool-policy-chip risk-${toolPolicyEscape(riskLevel)}">${toolPolicyEscape(toolPolicyRiskLabel(riskLevel))}</span>
                    <span class="tool-policy-chip${approvalRequired ? ' approval-on' : ''}">${approvalRequired ? '需审批' : '免审批'}</span>
                    ${packageEnabled ? '' : '<span class="tool-policy-chip package-off">包停用</span>'}
                    ${editable ? `<button type="button" class="btn-secondary" data-tool-policy-edit="${toolPolicyEscape(key)}">编辑</button>` : ''}
                </footer>
            </article>
        `;
    }).join(''));
    body.querySelectorAll('[data-tool-policy-edit]').forEach(button => {
        button.addEventListener('click', () => window.openToolPolicyGovernancePanel(button.dataset.toolPolicyEdit));
    });
    body.querySelectorAll('[data-tool-policy-toggle]').forEach(button => {
        button.addEventListener('click', () => window.toggleToolPolicyToolStatus(button));
    });
    renderToolPolicyGovernancePanel(toolPolicySelectedToolEntry());
}

function toolPolicyField(key, attr) {
    const escaped = window.CSS?.escape ? CSS.escape(key) : String(key || '').replace(/["\\]/g, '\\$&');
    return document.querySelector(`[${attr}="${escaped}"]`);
}

async function saveToolPolicyPackageEnabled(packageKey, enabled) {
    const res = await apiFetch(`${API_BASE}/capabilities/packages/${encodeURIComponent(packageKey)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '工具包状态保存失败');
    return data.item || null;
}

async function saveToolPolicyGovernance(entry, payload) {
    if (payload.enabled && entry.item.enabled === false) {
        await saveToolPolicyPackageEnabled(entry.item.package_key, true);
    }
    const toolName = toolPolicyToolName(entry.tool);
    const res = await apiFetch(`${API_BASE}/capabilities/packages/${encodeURIComponent(entry.item.package_key)}/tools/${encodeURIComponent(toolName)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '工具策略保存失败');
    return data.item || null;
}

async function loadToolPolicyToolsForPackage(item) {
    const res = await apiFetch(`${API_BASE}/capabilities/packages/${encodeURIComponent(item.package_key)}/tools`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '工具列表加载失败');
    const packageItem = data.item || item;
    return (data.tools || []).map(tool => ({
        key: toolPolicyEntryKey(packageItem, tool),
        item: packageItem,
        tool
    }));
}

window.loadToolPolicy = async function(options = {}) {
    if (!isAdminUser()) return;
    if (!options.forceReload && toolPolicyToolsCache.length) {
        if (!options.preserveSelection) {
            toolPolicySelectedToolKey = '';
            toolPolicySelectedPackageKey = '';
        }
        renderToolPolicyTools();
        return;
    }
    renderToolPolicyMessage('正在加载工具策略...');
    const res = await apiFetch(`${API_BASE}/capabilities/packages`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        renderToolPolicyMessage(data.error || '工具策略加载失败', { error: true });
        return showToast(data.error || '工具策略加载失败', 'error');
    }
    const previousToolKey = options.preserveSelection ? toolPolicySelectedToolKey : '';
    toolPolicyPackagesCache = (data.data || []).filter(toolPolicyIsGlobalPackage);
    const results = await Promise.all(toolPolicyPackagesCache.map(async item => {
        try {
            return { entries: await loadToolPolicyToolsForPackage(item), error: '' };
        } catch (e) {
            return { entries: [], error: e.message || '工具列表加载失败' };
        }
    }));
    toolPolicyToolsCache = results.flatMap(result => result.entries);
    const failures = results.filter(result => result.error).length;
    if (failures) showToast(`${failures} 个工具包加载失败`, 'error');
    toolPolicySelectedToolKey = toolPolicyToolsCache.some(entry => entry.key === previousToolKey) ? previousToolKey : '';
    const selected = toolPolicySelectedToolEntry();
    toolPolicySelectedPackageKey = selected?.item?.package_key || '';
    renderToolPolicyTools();
};

window.openToolPolicyGovernancePanel = function(entryKey) {
    const entry = toolPolicyEntryByKey(entryKey);
    toolPolicySelectedToolKey = entry?.key || '';
    toolPolicySelectedPackageKey = entry?.item?.package_key || '';
    renderToolPolicyTools();
};

window.closeToolPolicyGovernancePanel = function() {
    toolPolicySelectedToolKey = '';
    toolPolicySelectedPackageKey = '';
    renderToolPolicyTools();
};

window.saveToolPolicyPackageStatus = async function(input) {
    const packageKey = input?.getAttribute?.('data-tool-policy-package-enabled') || input?.dataset?.toolPolicyPackageEnabled || '';
    if (!packageKey) return;
    const item = toolPolicyPackagesCache.find(row => row.package_key === packageKey);
    const nextEnabled = input.dataset.nextEnabled === 'true';
    input.disabled = true;
    try {
            await saveToolPolicyPackageEnabled(packageKey, nextEnabled);
            showToast(nextEnabled ? '工具包已启用' : '工具包已停用', 'success');
            await window.loadToolPolicy({ forceReload: true, preserveSelection: true });
    } catch (e) {
        showToast(e.message || '工具包状态保存失败', 'error');
    } finally {
        input.disabled = !toolPolicyCanEditPackage(item);
    }
};

window.toggleToolPolicyToolStatus = async function(button) {
    const entryKey = button?.dataset?.toolPolicyToggle || '';
    const entry = toolPolicyEntryByKey(entryKey);
    if (!entry) return;
    const nextEnabled = button.dataset.nextEnabled === 'true';
    button.disabled = true;
    try {
            await saveToolPolicyGovernance(entry, toolPolicyToolPayload(entry.tool, { enabled: nextEnabled }));
            showToast(nextEnabled ? '工具已启用' : '工具已停用', 'success');
            await window.loadToolPolicy({ forceReload: true, preserveSelection: true });
    } catch (e) {
        showToast(e.message || '工具状态保存失败', 'error');
    } finally {
        button.disabled = false;
    }
};

window.saveToolPolicyTool = async function(button) {
    const entryKey = button?.dataset?.toolPolicySave || '';
    const entry = toolPolicyEntryByKey(entryKey);
    if (!entry) return;
    const riskInput = toolPolicyField(entryKey, 'data-tool-policy-risk');
    const approvalInput = toolPolicyField(entryKey, 'data-tool-policy-approval');
    const usageInput = toolPolicyField(entryKey, 'data-tool-policy-usage');
    const payload = {
        enabled: toolPolicyGovernance(entry.tool).enabled !== false,
        riskLevel: riskInput?.value || 'medium',
        approvalRequired: approvalInput?.checked || false,
        usage: usageInput?.value || ''
    };
    const oldText = button.textContent;
    button.disabled = true;
    button.textContent = '保存中...';
    try {
        await saveToolPolicyGovernance(entry, payload);
        showToast('工具策略已保存', 'success');
        await window.loadToolPolicy({ forceReload: true, preserveSelection: true });
    } catch (e) {
        showToast(e.message || '工具策略保存失败', 'error');
    } finally {
        button.disabled = false;
        button.textContent = oldText || '保存';
    }
};

document.addEventListener('click', event => {
    const refresh = event.target.closest('#tool-policy-refresh-btn');
    if (!refresh) return;
    event.preventDefault();
    window.loadToolPolicy?.({ forceReload: true });
});
