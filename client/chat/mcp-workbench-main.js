// 聊天工具箱工作台数据加载与操作 Chat MCP workbench data loading and actions
function renderMcpCatalogCard(service, { count = 0, metaText = '' } = {}) {
    const badge = count ? `${count} 个` : service.badge;
    const cardMeta = metaText || (count ? '可继续添加连接' : '配置后可查看工具');
    return `
        <div class="mcp-system-card mcp-connector-card">
            <div class="mcp-system-card-head">
                <strong>${mcpEscape(service.title)}</strong>
                <em>${mcpEscape(badge || '入口')}</em>
            </div>
            <p>${mcpEscape(service.description)}</p>
            ${renderMcpCardTags(mcpMetadataForType(service.type))}
            <div class="mcp-card-meta">${mcpEscape(cardMeta)}</div>
            <div class="mcp-system-actions">
                <button class="btn-secondary" type="button" data-mcp-create="${mcpEscape(service.type)}">${mcpEscape(service.actionLabel || '配置')}</button>
            </div>
        </div>
    `;
}

function renderMcpInstanceCard(server) {
    const database = server.database_connection || {};
    const typeLabel = server.server_type === 'database'
        ? (mcpDbToolLabels[database.database_type] || '数据库')
        : (mcpBuiltinToolLabels[server.server_type] || '外部服务');
    const metadataType = server.server_type === 'database' ? 'database' : (server.server_type || 'external');
    const ownerLabel = mcpOwnerLabel(server);
    const showOwner = mcpShouldShowOwner(server);
    const serverTools = mcpToolsForServer(server.id, mcpFallbackToolsForServer(server));
    const isPaused = server.status === 'paused';
    const toolCount = serverTools.length;
    return `
        <div class="mcp-system-card mcp-connector-card mcp-instance-card${isPaused ? ' is-paused' : ''}">
            <div class="mcp-system-card-head mcp-instance-head">
                <div class="mcp-instance-title">
                    <strong>${mcpEscape(mcpCleanServiceName(server.name))}</strong>
                    <span>
                        <em>${mcpEscape(typeLabel)}</em>
                        ${showOwner && ownerLabel ? `<em class="mcp-owner-badge" title="${mcpEscape(ownerLabel)}">所属：${mcpEscape(ownerLabel)}</em>` : ''}
                    </span>
                </div>
                <button class="mcp-status-toggle${isPaused ? '' : ' is-on'}" type="button" data-mcp-toggle="${mcpEscape(server.id)}" data-next-status="${isPaused ? 'active' : 'paused'}" aria-label="${isPaused ? '启用服务' : '停用服务'}" title="${isPaused ? '启用服务' : '停用服务'}">
                    <span></span>
                </button>
            </div>
            ${renderMcpCardTags(mcpMetadataForType(metadataType, server))}
            <div class="mcp-card-meta${server.last_error ? ' error-text' : ''}">
                ${mcpEscape(server.last_error || mcpToolPreviewText(server.id, mcpFallbackToolsForServer(server), toolCount ? `已接入 ${toolCount} 个工具` : '刷新后显示该服务工具'))}
            </div>
            <div class="mcp-system-actions mcp-instance-actions">
                <button class="btn-secondary" data-mcp-edit="${mcpEscape(server.id)}">编辑</button>
                <button class="btn-secondary" data-mcp-tools="${mcpEscape(server.id)}">工具</button>
                <button class="btn-danger-outline" data-mcp-delete="${mcpEscape(server.id)}">删除</button>
            </div>
        </div>
    `;
}

function mcpFormatCount(value) {
    if (window.Pivot?.formatNumber) return window.Pivot.formatNumber(value);
    const num = Number(value) || 0;
    return String(num);
}

async function loadMcpDatasetSummary() {
    try {
        const res = await apiFetch(`${API_BASE}/apps/data-analysis/datasets/summary`);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) return { count: 0, rowCount: 0, available: false };
        const summary = data.summary || {};
        return {
            count: Number(summary.count) || 0,
            rowCount: Number(summary.rowCount) || 0,
            available: true
        };
    } catch (_err) {
        return { count: 0, rowCount: 0, available: false };
    }
}
function mcpServerOwnerId(server = {}) {
    const owner = server.owner || {};
    if (owner.scope === 'global' || owner.id === null || server.user_id === null) return null;
    return owner.id || server.user_id || null;
}

function mcpServerBelongsToCurrentUser(server = {}) {
    const user = typeof currentUser !== 'undefined' ? currentUser : null;
    const ownerId = mcpServerOwnerId(server);
    return Boolean(ownerId && user?.id && String(ownerId) === String(user.id));
}

function mcpShouldShowAsWorkbenchServer(server = {}) {
    if (mcpServerOwnerId(server) === null) return true;
    if (mcpServerBelongsToCurrentUser(server)) return true;
    return false;
}

function mcpIsOtherUserServer(server = {}) {
    if (!(typeof isAdminUser === 'function' && isAdminUser())) return false;
    if (mcpServerOwnerId(server) === null) return false;
    return !mcpServerBelongsToCurrentUser(server);
}

function mcpServerTypeLabel(server = {}) {
    const database = server.database_connection || {};
    if (server.server_type === 'database') return mcpDbToolLabels[database.database_type] || '数据库';
    return mcpBuiltinToolLabels[server.server_type] || '外部服务';
}

function renderMcpOtherUserToolsPanel(servers = []) {
    if (!servers.length) return '';
    const owners = new Set();
    const typeCounts = new Map();
    servers.forEach(server => {
        const ownerLabel = mcpOwnerLabel(server) || '未知用户';
        owners.add(ownerLabel);
        const typeLabel = mcpServerTypeLabel(server);
        typeCounts.set(typeLabel, (typeCounts.get(typeLabel) || 0) + 1);
    });
    const typeText = Array.from(typeCounts.entries())
        .map(([label, count]) => `${label} ${count}`)
        .join(' / ');
    const previewRows = servers.slice(0, 8).map(server => {
        const ownerLabel = mcpOwnerLabel(server) || '未知用户';
        return `
            <div class="mcp-other-tool-row">
                <strong>${mcpEscape(mcpCleanServiceName(server.name))}</strong>
                <span>${mcpEscape(mcpServerTypeLabel(server))}</span>
                <em>${mcpEscape(ownerLabel)}</em>
            </div>
        `;
    }).join('');
    return `
        <details class="mcp-other-tools-panel">
            <summary>
                <span>
                    <strong>其它用户个人工具</strong>
                    <small>admin 可见但不默认铺开，避免用户个人工具过多时挤占当前工作入口。</small>
                </span>
                <em>${mcpEscape(`${servers.length} 个 / ${owners.size} 人`)}</em>
            </summary>
            <div class="mcp-other-tools-body">
                <p>${mcpEscape(typeText || '暂无类型统计')}</p>
                <div class="mcp-other-tools-list">${previewRows}</div>
                ${servers.length > 8 ? `<small>另有 ${mcpEscape(servers.length - 8)} 个个人工具未展开显示，可到工具策略或对应用户配置中治理。</small>` : ''}
                <button class="btn-secondary" type="button" data-mcp-open-tool-policy>查看工具策略</button>
            </div>
        </details>
    `;
}

function renderMcpDataManagementPanel(summary = {}) {
    const count = Number(summary.count) || 0;
    const rowCount = Number(summary.rowCount) || 0;
    const countText = summary.available === false ? '摘要不可用' : `${mcpFormatCount(count)} 个数据集`;
    const rowText = rowCount > 0 ? `，约 ${mcpFormatCount(rowCount)} 行` : '';
    const summaryText = summary.available === false
        ? '打开数据分析的数据总览，上传 Excel、CSV、SQLite 或一次性报表，并查看导入状态。'
        : count > 0
            ? `当前已有 ${mcpFormatCount(count)} 个数据集${rowText}；上传、列表、搜索、删除和导出都在数据总览完成。`
            : '还没有导入数据集，可上传 Excel、CSV、SQLite 或临时报表开始分析。';
    return `
        <div class="mcp-data-management-panel">
            <div class="mcp-data-management-head">
                <strong>数据管理</strong>
                <span>${mcpEscape(countText)}</span>
            </div>
            <button class="mcp-data-management-action is-primary" type="button" data-mcp-open-data-analysis data-mcp-open-data-analysis-tab="overview" aria-label="打开数据分析数据总览">
                <span>
                    <strong>打开数据总览</strong>
                    <small>${mcpEscape(summaryText)}</small>
                </span>
                <em>进入管理</em>
            </button>
        </div>
    `;
}
async function openMcpDataAnalysisImport(options = {}) {
    try {
        const payload = typeof options === 'string'
            ? { datasetId: options, tab: 'overview' }
            : { tab: 'overview', ...(options || {}) };
        const workspaces = window.Pivot?.moduleApi?.('workspaces.apps', {}) || {};
        if (typeof workspaces.openAppsWorkbench === 'function') await workspaces.openAppsWorkbench();
        let dataAnalysis = window.Pivot?.moduleApi?.('apps.dataAnalysis', {}) || {};
        if (typeof dataAnalysis.showDataAnalysisApp !== 'function') {
            await window.Pivot?.loadScriptOnce?.('/chat/apps-workbench-data-analysis.js');
            dataAnalysis = window.Pivot?.moduleApi?.('apps.dataAnalysis', {}) || {};
        }
        if (typeof dataAnalysis.showDataAnalysisApp === 'function') {
            await dataAnalysis.showDataAnalysisApp(payload);
            return;
        }
        showToast('数据分析应用入口未就绪，请从应用中心打开数据分析。', 'error');
    } catch (e) {
        showToast(e.message || '数据分析应用打开失败', 'error');
    }
}

async function loadMcpServers() {
    const list = document.getElementById('mcp-server-list');
    if (!list) return;
    const res = await apiFetch(`${API_BASE}/mcp/servers`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '工具服务加载失败');
    mcpServersCache = data.data || [];
    const datasetSummary = await loadMcpDatasetSummary();
    const localAuthorizationStatus = await (window.getMcpLocalAuthorizationStatus?.({ silent: true }) || Promise.resolve(null));
    const systemTypes = new Set(mcpSystemServices.map(item => item.type));
    const personalBuiltinTypes = new Set(mcpPersonalBuiltinServices.map(item => item.type));
    const userManagedServers = mcpServersCache.filter(server => !systemTypes.has(server.server_type));
    const workbenchServers = userManagedServers.filter(mcpShouldShowAsWorkbenchServer);
    const otherUserServers = userManagedServers.filter(mcpIsOtherUserServer);
    const personalByType = new Map(workbenchServers
        .filter(server => mcpPersonalBuiltinServices.some(item => item.type === server.server_type))
        .map(server => [server.server_type, server]));
    const databaseServers = workbenchServers.filter(server => server.server_type === 'database');
    const externalServers = workbenchServers.filter(server => !personalBuiltinTypes.has(server.server_type) && server.server_type !== 'database');
    renderMcpSystemServices();

    const databaseEntry = mcpServiceCatalog.map(service => renderMcpCatalogCard(service, {
        count: databaseServers.length,
        metaText: databaseServers.length ? '可继续添加服务器可访问数据库' : '配置后可查看数据库工具'
    })).join('');
    const reportsService = mcpPersonalBuiltinServices.find(item => item.type === 'reports');
    const imService = mcpPersonalBuiltinServices.find(item => item.type === 'im');
    const localActionCards = (window.decorateMcpLocalActionCards || (cards => cards))(
        mcpSourceActionCards.filter(card => card.action === 'local-auth'),
        localAuthorizationStatus
    );
    const dataSourceActionPanels = [
        renderMcpDataManagementPanel(datasetSummary),
        renderMcpSourceActionPanel(localActionCards, {
            title: '我的电脑',
            description: window.mcpLocalAuthorizationDescription?.(localAuthorizationStatus) || '需桌面端或本地助手授权。'
        })
    ].join('');
    const dataSourceActions = dataSourceActionPanels ? `<div class="mcp-source-action-zone">${dataSourceActionPanels}</div>` : '';
    const dataSourceCards = [
        databaseEntry,
        reportsService ? renderMcpServiceCard({
            service: reportsService,
            server: personalByType.get('reports'),
            connector: true,
            enabledEmptyText: '已配置，刷新后可查看工具',
            configMetaText: '配置后可诊断服务器目录'
        }) : '',
        ...databaseServers.map(renderMcpInstanceCard)
    ].join('');
    const notificationCards = imService ? renderMcpServiceCard({
        service: imService,
        server: personalByType.get('im'),
        connector: true,
        enabledEmptyText: '已配置，刷新后可查看工具',
        configMetaText: '配置后可测试发送'
    }) : '';
    const extensionCards = [
        renderMcpCatalogCard(mcpExternalServiceCatalog, {
            count: externalServers.length,
            metaText: externalServers.length ? '可继续添加外部工具服务' : '添加后可进行健康检查和工具 Schema 校验'
        }),
        ...externalServers.map(renderMcpInstanceCard)
    ].join('');

    const otherUserToolsPanel = renderMcpOtherUserToolsPanel(otherUserServers);
    const governanceCards = [notificationCards, extensionCards, otherUserToolsPanel].filter(Boolean).join('');
    PivotSafeHtml.setHtml(list, `
        ${renderMcpSection('数据来源', '先判断数据由服务器、上传文件还是我的电脑提供，再交给下游工具处理。', dataSourceCards, { beforeGridHtml: dataSourceActions })}
        ${renderMcpSection('通知与扩展', '把结果发到授权目标，或接入技术同事提供的外部工具服务。', governanceCards, { emptyText: '配置消息通知或外部工具服务后可在任务和工作流中复用。' })}
    `);
    list.querySelectorAll('[data-mcp-open-data-analysis]').forEach(btn => {
        btn.addEventListener('click', () => openMcpDataAnalysisImport({
            datasetId: btn.dataset.mcpOpenDataAnalysisDataset || '',
            tab: btn.dataset.mcpOpenDataAnalysisTab || btn.dataset.mcpOpenDataAnalysis || 'overview'
        }));
    });
    list.querySelectorAll('[data-mcp-open-local-auth]').forEach(btn => {
        btn.addEventListener('click', () => window.openMcpLocalAuthorizationCenter?.(btn.dataset.mcpOpenLocalAuth || 'local_database'));
    });
    list.querySelectorAll('[data-mcp-create]').forEach(btn => {
        btn.addEventListener('click', () => window.openMcpCreateModal(btn.dataset.mcpCreate));
    });
    list.querySelectorAll('[data-mcp-system-config]').forEach(btn => {
        btn.addEventListener('click', () => window.openMcpSystemConfig(btn.dataset.mcpSystemConfig));
    });
    list.querySelectorAll('[data-mcp-edit]').forEach(btn => btn.addEventListener('click', () => {
        window.openMcpEditModal(btn.dataset.mcpEdit);
    }));
    list.querySelectorAll('[data-mcp-tools]').forEach(btn => btn.addEventListener('click', () => window.openMcpToolsModal(btn.dataset.mcpTools)));
    list.querySelectorAll('[data-mcp-toggle]').forEach(btn => btn.addEventListener('click', () => window.toggleMcpServerStatus(btn.dataset.mcpToggle, btn.dataset.nextStatus)));
    list.querySelectorAll('[data-mcp-delete]').forEach(btn => btn.addEventListener('click', () => window.deleteMcpServer(btn.dataset.mcpDelete)));
    list.querySelectorAll('[data-mcp-open-tool-policy]').forEach(btn => {
        btn.addEventListener('click', async () => {
            await window.openAdminPanel?.({ restore: false });
            await window.switchTab?.('tool-policy');
        });
    });
}
function mcpToolRiskLabel(level) {
    if (level === 'low') return '低风险';
    if (level === 'high') return '高风险';
    return '中风险';
}

function renderMcpSystemServices() {
    const box = document.getElementById('mcp-system-services');
    if (!box) return;
    const byType = new Map(mcpServersCache
        .filter(server => mcpSystemServices.some(item => item.type === server.server_type) && mcpShouldShowAsWorkbenchServer(server))
        .map(server => [server.server_type, server]));
    const systemCards = mcpSystemServices
        .map(service => renderMcpServiceCard({ service, server: byType.get(service.type) }))
        .join('');
    PivotSafeHtml.setHtml(box, `
        ${renderMcpSection('处理与交付', '文档、数据、格式转换、图表和报告只处理上传文件、数据集或上游结果。', systemCards)}
    `);
    box.querySelectorAll('[data-mcp-system-enable]').forEach(btn => {
        btn.addEventListener('click', () => window.ensureMcpSystemService(btn.dataset.mcpSystemEnable, btn));
    });
    box.querySelectorAll('[data-mcp-system-config]').forEach(btn => {
        btn.addEventListener('click', () => window.openMcpSystemConfig(btn.dataset.mcpSystemConfig));
    });
    box.querySelectorAll('[data-mcp-tools]').forEach(btn => {
        btn.addEventListener('click', () => window.openMcpToolsModal(btn.dataset.mcpTools));
    });
    box.querySelectorAll('[data-mcp-toggle]').forEach(btn => {
        btn.addEventListener('click', () => window.toggleMcpServerStatus(btn.dataset.mcpToggle, btn.dataset.nextStatus));
    });
}
window.openMcpSystemConfig = function(type) {
    const service = mcpBuiltinServices.find(item => item.type === type);
    if (!service?.requiresConfig) return showToast('该系统工具不需要额外配置', 'error');
    const existing = mcpServersCache.find(server => server.server_type === type);
    if (existing) return window.openMcpEditModal(existing.id);

    const modal = document.getElementById('mcp-edit-modal');
    if (!modal) return;
    bindMcpFormControls('edit');
    setMcpEditTitle(`配置${service.title}`);
    [
        'mcp-edit-id', 'mcp-edit-url', 'mcp-edit-key', 'mcp-edit-desc',
        'mcp-edit-im-endpoint-url', 'mcp-edit-im-auth-header', 'mcp-edit-im-token',
        'mcp-edit-im-allowed-targets', 'mcp-edit-im-default-target',
        'mcp-edit-im-max-message-length'
    ].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
    setMcpSourceType(type, 'edit');
    mcpFormEl('name', 'edit').value = service.defaultName || service.title;
    mcpFormEl('desc', 'edit').value = service.defaultDescription || service.description || '';
    mcpFormEl('im-auth-header', 'edit').value = 'Authorization';
    const imAllowAtAll = mcpFormEl('im-allow-at-all', 'edit');
    if (imAllowAtAll) imAllowAtAll.checked = false;
    const shared = mcpFormEl('shared', 'edit');
    if (shared) shared.checked = false;
    document.querySelectorAll('#mcp-edit-modal .admin-only').forEach(el => {
        el.classList.toggle('hidden', !isAdminUser());
    });
    document.querySelectorAll('#mcp-edit-modal .super-admin-only').forEach(el => {
        el.classList.toggle('hidden', !isSuperAdminUser());
    });
    modal.classList.remove('hidden');
};

window.openMcpToolsModal = async function(serverId) {
    const server = mcpServersCache.find(item => String(item.id) === String(serverId));
    if (!server) return showToast('未找到工具服务', 'error');
    const modal = document.getElementById('mcp-tools-modal');
    const title = document.getElementById('mcp-tools-title');
    const list = document.getElementById('mcp-tools-list');
    if (!modal || !title || !list) return;
    const fallbackTools = mcpFallbackToolsForServer(server);
    let tools = mcpToolsForServer(server.id, fallbackTools);
    try {
        const res = await apiFetch(`${API_BASE}/mcp/servers/${encodeURIComponent(server.id)}/tools`);
        const data = await res.json().catch(() => ({}));
        if (res.ok && Array.isArray(data.tools) && data.tools.length) tools = data.tools;
    } catch (e) {
        // 弹窗治理可使用本地缓存兜底；刷新按钮仍可重新拉取工具。
    }
    title.textContent = `${mcpCleanServiceName(server.name || '工具服务')} 的可用工具`;
    const refreshButton = document.getElementById('mcp-tools-refresh-btn');
    if (refreshButton) {
        refreshButton.dataset.mcpServerId = server.id;
        refreshButton.disabled = server.status === 'paused';
        refreshButton.textContent = server.status === 'paused' ? '已停用' : '刷新工具';
    }
    PivotSafeHtml.setHtml(list, tools.length ? `
        <div class="mcp-tools-grid">
            ${tools.map(tool => {
                const governance = tool.governance || {};
                const enabled = governance.enabled !== false;
                const riskLevel = governance.riskLevel || 'medium';
                const approvalRequired = Boolean(governance.approvalRequired);
                const toolFullName = tool.name || tool.fullName || '';
                const ownerLabel = mcpOwnerLabel(tool) || mcpOwnerLabel(server);
                const showOwner = mcpShouldShowOwner(tool) || mcpShouldShowOwner(server);
                return `
                <div class="mcp-tool-card${enabled ? '' : ' is-disabled'}">
                    <div class="mcp-tool-card-head">
                        <strong>${mcpEscape(mcpToolTitle(tool))}</strong>
                        <span class="mcp-tool-state${enabled ? '' : ' is-muted'}">${enabled ? '已启用' : '已停用'}</span>
                    </div>
                    <p>${mcpEscape(mcpToolDescription(tool) || '暂无说明')}</p>
                    <div class="mcp-tool-meta">
                        ${toolFullName ? `<span>${mcpEscape(toolFullName)}</span>` : ''}
                        ${showOwner && ownerLabel ? `<span class="mcp-tool-owner" title="${mcpEscape(ownerLabel)}">所属：${mcpEscape(ownerLabel)}</span>` : ''}
                        <span>${mcpEscape(mcpToolRiskLabel(riskLevel))}</span>
                        ${approvalRequired ? '<span>需审批</span>' : ''}
                    </div>
                </div>
            `;
            }).join('')}
        </div>
    ` : '<div class="mcp-empty-panel compact"><strong>暂无可用工具</strong><span>请先刷新该服务，或确认它已启用并完成连接。</span></div>');
    modal.classList.remove('hidden');
};

window.ensureMcpSystemService = async function(type, button) {
    const service = mcpBuiltinServices.find(item => item.type === type);
    if (!service) return showToast('不支持的系统工具', 'error');
    const originalText = button?.textContent || '启用';
    if (button) {
        button.disabled = true;
        button.textContent = '处理中...';
    }
    try {
        const res = await apiFetch(`${API_BASE}/mcp/system-services/${encodeURIComponent(type)}/ensure`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) return showToast(data.error || '系统工具启用失败', 'error');
        showToast(`${service.title} 已可用，刷新到 ${Number(data.tools?.length || 0)} 个工具`, 'success');
        await window.loadMcpWorkbench();
    } finally {
        if (button) {
            button.disabled = false;
            button.textContent = originalText;
        }
    }
};

async function loadMcpTools() {
    const box = document.getElementById('mcp-tool-cache');
    const res = await apiFetch(`${API_BASE}/mcp/tools`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '工具加载失败');
    mcpToolsCache = data.tools || [];
    if (box) PivotSafeHtml.setHtml(box, '');
}

async function loadMcpGovernance() {
    const panel = document.getElementById('mcp-governance-panel');
    if (!panel) return;
    const [govRes, logsRes] = await Promise.all([
        apiFetch(`${API_BASE}/mcp/governance`),
        apiFetch(`${API_BASE}/mcp/call-logs?limit=60`)
    ]);
    const gov = await govRes.json().catch(() => ({}));
    const logs = await logsRes.json().catch(() => ({}));
    if (!govRes.ok || !logsRes.ok) {
        PivotSafeHtml.setHtml(panel, '');
        return;
    }
    panel.className = 'workspace-governance-panel mcp-governance-panel';
    const s = gov.summary || {};
    const health = gov.health || {};
    mcpCallLogsCache = logs.data || [];
    const active = Number(s.active || 0);
    const errors = Number(s.error || 0);
    const unchecked = Number(s.unchecked || 0);
    const databaseServers = Number(s.databaseServers || 0);
    const notes = (Array.isArray(health.recommendations) ? health.recommendations : [])
        .filter(Boolean)
        .slice(0, 3);
    PivotSafeHtml.setHtml(panel, `
        <div class="mcp-governance-title">
            <div>
                <strong>工具治理</strong>
                <span>健康 ${Number(s.healthScore ?? health.score ?? 0)} · 7 日 ${Number(s.calls7d || 0)} 调用 · ${Number(s.callErrors7d || 0)} 错误 · 平均 ${Number(s.avgDurationMs || 0)}ms</span>
            </div>
            <button id="mcp-refresh-btn" class="btn-secondary" type="button">刷新</button>
        </div>
        <div class="governance-metrics">
            <span><b>${active}</b>可用服务</span>
            <span><b>${errors}</b>需要处理</span>
            <span><b>${unchecked}</b>待刷新</span>
            <span><b>${databaseServers}</b>数据连接</span>
            <span><b>${Number(s.callErrorRate ?? health.callErrorRate ?? 0)}%</b>调用错误率</span>
        </div>
        ${notes.length ? `<div class="governance-list mcp-safety-notes">${notes.map(item => `<span>${mcpEscape(item)}</span>`).join('')}</div>` : ''}
    `);
    panel.querySelector('#mcp-refresh-btn')?.addEventListener('click', () => window.loadMcpWorkbench?.());
}

function collectMcpDatabasePayload(mode = 'create') {
    return {
        id: mcpFormEl('id', mode)?.value || undefined,
        name: mcpFormEl('name', mode)?.value.trim(),
        description: mcpFormEl('desc', mode)?.value.trim(),
        shared: mcpFormEl('shared', mode)?.checked || false,
        database_type: mcpFormEl('db-type', mode)?.value || 'postgres',
        host: mcpFormEl('db-host', mode)?.value.trim(),
        port: mcpFormEl('db-port', mode)?.value,
        database_name: mcpFormEl('db-name', mode)?.value.trim(),
        username: mcpFormEl('db-user', mode)?.value.trim(),
        password: mcpFormEl('db-password', mode)?.value,
        schema: mcpFormEl('db-schema', mode)?.value.trim(),
        max_rows: mcpFormEl('db-max-rows', mode)?.value,
        ssl: mcpFormEl('db-ssl', mode)?.checked || false,
        table_allowlist: mcpFormEl('db-table-allowlist', mode)?.value || '',
        field_allowlist: mcpFormEl('db-field-allowlist', mode)?.value || '',
        sensitive_fields: mcpFormEl('db-sensitive-fields', mode)?.value || '',
        row_policy_hint: mcpFormEl('db-row-policy-hint', mode)?.value.trim(),
        query_timeout_ms: mcpFormEl('db-query-timeout-ms', mode)?.value,
        sql_cost_estimate: mcpFormEl('db-sql-cost-estimate', mode)?.checked !== false
    };
}

function validateMcpDatabasePayload(payload, { requireName = true } = {}) {
    if (requireName && !payload.name) return '请填写连接名称';
    if (!payload.database_name) return '请填写数据库名；SQLite 请填写文件路径';
    if (payload.database_type !== 'sqlite' && !payload.host) return '请填写数据库主机地址';
    return '';
}

function collectMcpBuiltinPayload(type, mode = 'create') {
    const base = {
        id: mcpFormEl('id', mode)?.value || undefined,
        name: mcpFormEl('name', mode)?.value.trim(),
        description: mcpFormEl('desc', mode)?.value.trim(),
        shared: mcpFormEl('shared', mode)?.checked || false,
        service_type: type
    };
    if (type === 'reports') {
        return {
            ...base,
            roots: mcpFormEl('reports-roots', mode)?.value || '',
            extensions: mcpFormEl('reports-extensions', mode)?.value || '',
            maxFileMb: mcpFormEl('reports-max-file-mb', mode)?.value,
            maxRows: mcpFormEl('reports-max-rows', mode)?.value
        };
    }
    if (type !== 'im') return base;
    return {
        ...base,
        endpointUrl: mcpFormEl('im-endpoint-url', mode)?.value.trim(),
        authHeader: mcpFormEl('im-auth-header', mode)?.value.trim(),
        secret: mcpFormEl('im-token', mode)?.value,
        allowedTargets: mcpFormEl('im-allowed-targets', mode)?.value || '',
        defaultTarget: mcpFormEl('im-default-target', mode)?.value.trim(),
        maxMessageLength: mcpFormEl('im-max-message-length', mode)?.value,
        allowAtAll: mcpFormEl('im-allow-at-all', mode)?.checked || false
    };
}

function validateMcpBuiltinPayload(type, payload) {
    if (!payload.name) return '请填写服务名称';
    if (type === 'reports' && !String(payload.roots || '').trim()) return '请至少填写一个报表/数据文件目录';
    if (type === 'im' && !payload.endpointUrl) return '请填写局域网聊天工具接收地址';
    return '';
}

function formatMcpDatabaseError(data, fallback = '服务器可访问数据库连接失败') {
    const parts = [data?.error || fallback];
    if (data?.hint) parts.push(data.hint);
    if (data?.diagnostics?.host) {
        parts.push(`目标：${data.diagnostics.host}${data.diagnostics.port ? `:${data.diagnostics.port}` : ''}`);
    }
    return parts.filter(Boolean).join('\n');
}

window.testMcpDatabaseConnection = async function(mode = 'create') {
    if ((mcpFormEl('source-type', mode)?.value || 'external') !== 'database') {
        return showToast('请先选择服务器可访问数据库', 'error');
    }
    const payload = collectMcpDatabasePayload(mode);
    const error = validateMcpDatabasePayload(payload, { requireName: false });
    if (error) return showToast(error, 'error');

    const button = mcpFormEl('test-db-btn', mode);
    const originalText = button?.textContent || '测试连接';
    if (button) {
        button.disabled = true;
        button.textContent = '测试中...';
    }
    try {
        const res = await apiFetch(`${API_BASE}/mcp/database-connections/test`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (!res.ok) return showToast(formatMcpDatabaseError(data, '服务器可访问数据库测试失败'), 'error');
        return showToast('服务器可访问数据库测试通过', 'success');
    } finally {
        if (button) {
            button.disabled = false;
            button.textContent = originalText;
        }
    }
};

function collectMcpExternalPayload(mode = 'create') {
    return {
        name: mcpFormEl('name', mode)?.value.trim(),
        base_url: mcpFormEl('url', mode)?.value.trim(),
        api_key: mcpFormEl('key', mode)?.value,
        description: mcpFormEl('desc', mode)?.value.trim(),
        shared: mcpFormEl('shared', mode)?.checked || false,
        health_check_url: mcpFormEl('health-check-url', mode)?.value.trim(),
        timeout_ms: mcpFormEl('timeout-ms', mode)?.value,
        auth_mode: mcpFormEl('auth-mode', mode)?.value || 'auto',
        validate_tool_schema: mcpFormEl('validate-tool-schema', mode)?.checked || false,
        example_prompts: mcpFormEl('example-prompts', mode)?.value || ''
    };
}

function renderMcpDiagnostics(data = {}) {
    if (data.type === 'reports') {
        const files = Array.isArray(data.previewFiles) ? data.previewFiles.slice(0, 5) : [];
        return [
            `报表目录可读文件：${data.readableFiles || files.length || 0}`,
            ...files.map(file => `- ${file.path || file.name || file.file || JSON.stringify(file).slice(0, 80)}`),
            data.diagnostics?.hint || ''
        ].filter(Boolean).join('\n');
    }
    if (data.type === 'im') {
        const deliveries = Array.isArray(data.recentDeliveries) ? data.recentDeliveries.slice(0, 3) : [];
        return [
            data.testResult ? `测试发送：${data.testResult.ok ? '成功' : '已返回结果'}` : 'IM 配置可读取',
            `可发送目标：${(data.targets?.allowedTargets || []).length || 0}`,
            ...deliveries.map(item => `- ${item.created_at || ''} ${item.tool_name || ''} ${item.status || ''}${item.error_message ? `：${item.error_message}` : ''}`),
            data.retryHint || ''
        ].filter(Boolean).join('\n');
    }
    if (data.type === 'database') {
        return [
            '服务器可访问数据库测试通过',
            `表白名单：${(data.governance?.tableAllowlist || []).length || 0}`,
            `敏感字段：${(data.governance?.sensitiveFields || []).length || 0}`,
            `查询超时：${data.governance?.queryTimeoutMs || 20000}ms`
        ].join('\n');
    }
    if (data.type === 'external') {
        return `健康检查：HTTP ${data.statusCode || '-'}，耗时 ${data.durationMs || 0}ms`;
    }
    return data.message || JSON.stringify(data, null, 2).slice(0, 1000);
}

window.diagnoseMcpServer = async function(mode = 'edit', options = {}) {
    const id = mcpFormEl('id', mode)?.value;
    const panel = mcpFormEl('diagnostics', mode);
    if (!id) {
        if (panel) panel.textContent = '请先保存工具服务，再进行配置诊断。';
        return showToast('请先保存工具服务，再进行配置诊断', 'error');
    }
    const sourceType = mcpFormEl('source-type', mode)?.value || 'external';
    const payload = options.action === 'test'
        ? {
            action: 'test',
            target: mcpFormEl('im-test-target', mode)?.value.trim() || mcpFormEl('im-default-target', mode)?.value.trim(),
            message: mcpFormEl('im-test-message', mode)?.value.trim()
        }
        : { sourceType };
    const button = options.action === 'test' ? mcpFormEl('test-im-btn', mode) : mcpFormEl('diagnose-btn', mode);
    const originalText = button?.textContent || '配置诊断';
    if (button) {
        button.disabled = true;
        button.textContent = options.action === 'test' ? '发送中...' : '诊断中...';
    }
    if (panel) panel.textContent = '正在诊断...';
    try {
        const res = await apiFetch(`${API_BASE}/mcp/servers/${encodeURIComponent(id)}/diagnose`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.success === false) {
            const message = data.error || data.message || '配置诊断失败';
            if (panel) panel.textContent = message;
            return showToast(message, 'error');
        }
        if (panel) panel.textContent = renderMcpDiagnostics(data);
        showToast(options.action === 'test' ? '测试发送完成' : '配置诊断完成', 'success');
    } finally {
        if (button) {
            button.disabled = false;
            button.textContent = originalText;
        }
    }
};

window.saveMcpServer = async function(mode = 'create') {
    const id = mcpFormEl('id', mode)?.value;
    const sourceType = mcpFormEl('source-type', mode)?.value || 'external';
    let payload = collectMcpExternalPayload(mode);
    let endpoint = `${API_BASE}/mcp/servers${id ? `/${encodeURIComponent(id)}` : ''}`;
    if (sourceType === 'database') {
        payload = collectMcpDatabasePayload(mode);
        endpoint = `${API_BASE}/mcp/database-connections${id ? `/${encodeURIComponent(id)}` : ''}`;
        const error = validateMcpDatabasePayload(payload);
        if (error) return showToast(error, 'error');
    } else if (['reports', 'visualization', 'report', 'documents', 'data', 'format', 'im'].includes(sourceType)) {
        payload = collectMcpBuiltinPayload(sourceType, mode);
        endpoint = `${API_BASE}/mcp/builtin-services${id ? `/${encodeURIComponent(id)}` : ''}`;
        const error = validateMcpBuiltinPayload(sourceType, payload);
        if (error) return showToast(error, 'error');
    } else if (!payload.name || !payload.base_url) {
        return showToast('请填写服务名称和 URL', 'error');
    }
    const res = await apiFetch(endpoint, {
        method: id ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok) return showToast(formatMcpDatabaseError(data, '保存失败'), 'error');
    showToast('工具服务已保存', 'success');
    if (mode === 'edit') {
        window.closeMcpEditModal();
    } else {
        window.resetMcpForm();
    }
    await window.loadMcpWorkbench();
};

window.refreshMcpTools = async function(id, options = {}) {
    const res = await apiFetch(`${API_BASE}/mcp/servers/${encodeURIComponent(id)}/refresh`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) return showToast(data.error || '刷新失败', 'error');
    showToast(`已刷新 ${data.tools.length} 个工具`, 'success');
    await window.loadMcpWorkbench();
    if (options.keepToolsModalOpen) window.openMcpToolsModal(id);
};

window.toggleMcpServerStatus = async function(id, nextStatus = 'paused') {
    const server = mcpServersCache.find(item => String(item.id) === String(id));
    if (!server) return showToast('未找到工具服务', 'error');
    const res = await apiFetch(`${API_BASE}/mcp/servers/${encodeURIComponent(id)}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: nextStatus === 'paused' ? 'paused' : 'active' })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return showToast(formatMcpDatabaseError(data, '状态更新失败'), 'error');
    showToast(nextStatus === 'paused' ? '工具服务已停用' : '工具服务已启用', 'success');
    await window.loadMcpWorkbench();
};

window.deleteMcpServer = function(id) {
    showConfirm('删除工具服务', '确定删除这个工具服务吗？', async () => {
        const res = await apiFetch(`${API_BASE}/mcp/servers/${encodeURIComponent(id)}`, { method: 'DELETE' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) return showToast(data.error || '删除失败', 'error');
        showToast('工具服务已删除', 'success');
        await window.loadMcpWorkbench();
    });
};

window.loadMcpWorkbench = async function() {
    try {
        await loadMcpGovernance();
        await loadMcpTools();
        await loadMcpServers();
    } catch (e) {
        showToast(e.message, 'error');
    }
};



