// 聊天工具库工作台数据加载与操作 Chat MCP workbench data loading and actions
let mcpWorkbenchLoadPromise = null;
const mcpActionLocks = new Set();
const mcpModalApi = () => window.Pivot?.moduleApi?.('mcp.modal', {}) || {};

function setMcpWorkbenchState(kind = '', message = '') {
    const state = document.getElementById('mcp-workbench-state');
    if (state) state.hidden = true;
    if (kind === 'error' && message) {
        showToast(message, 'error');
    }
}

async function withMcpActionLock(key, button, busyText, action) {
    if (mcpActionLocks.has(key)) return null;
    mcpActionLocks.add(key);
    const originalText = button?.textContent || '';
    if (button) {
        button.disabled = true;
        button.setAttribute('aria-busy', 'true');
        if (busyText) button.textContent = busyText;
    }
    try {
        return await action();
    } catch (error) {
        showToast(error?.message || '工具库操作失败，请稍后重试', 'error');
        return null;
    } finally {
        mcpActionLocks.delete(key);
        if (button) {
            button.disabled = false;
            button.removeAttribute('aria-busy');
            if (busyText) button.textContent = originalText;
        }
    }
}

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
    const isShared = String(server.scope || '').toLowerCase() === 'shared' && server.user_id !== null;
    const toolCount = serverTools.length;
    return `
        <div class="mcp-system-card mcp-connector-card mcp-instance-card${isPaused ? ' is-paused' : ''}">
            <div class="mcp-system-card-head mcp-instance-head">
                <div class="mcp-instance-title">
                    <strong>${mcpEscape(mcpCleanServiceName(server.name))}</strong>
                    <span>
                        <em>${mcpEscape(typeLabel)}</em>
                        ${isShared ? '<em class="mcp-owner-badge">共享 · 只读</em>' : ''}
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
    if (server.read_only === true || String(server.scope || '').toLowerCase() === 'shared') return true;
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
        ? '打开数据分析的数据总览，上传 Excel、CSV、SQLite 或一次性报表。'
        : count > 0
            ? `当前已导入 ${mcpFormatCount(count)} 个数据集${rowText}。`
            : '还没有导入数据集，可上传 Excel、CSV 开始分析。';
    return `
        <div class="mcp-data-management-panel">
            <div class="mcp-data-management-head">
                <strong>数据管理</strong>
                <span title="${mcpEscape(countText)}">${mcpEscape(countText)}</span>
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
    const dataSourcesBox = document.getElementById('mcp-data-sources');
    const notificationsBox = document.getElementById('mcp-notifications-extensions');
    const list = document.getElementById('mcp-server-list');
    if (!dataSourcesBox && !notificationsBox && !list) return;

    const res = await apiFetch(`${API_BASE}/mcp/servers`);
    const data = await res.json().catch(() => ({}));
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
    window.Pivot?.moduleApi?.('mcp.credentials')?.load?.();
    const databaseEntry = mcpServiceCatalog.map(service => renderMcpCatalogCard(service, {
        count: databaseServers.length,
        metaText: databaseServers.length ? '可继续添加服务器可访问数据库' : '配置后可查看数据库工具'
    })).join('');
    const reportsService = mcpPersonalBuiltinServices.find(item => item.type === 'reports');
    const imService = mcpPersonalBuiltinServices.find(item => item.type === 'im');

    // 将数据库与目录本地授权操作合并为统一的 UI 入口
    const localDatabaseGrant = localAuthorizationStatus?.grants?.local_database?.authorized;
    const localDirectoryGrant = localAuthorizationStatus?.grants?.local_report_dir?.authorized;
    const localBrowserGrant = localAuthorizationStatus?.grants?.local_browser?.authorized;
    const isAnyAuthorized = localDatabaseGrant || localDirectoryGrant || localBrowserGrant;
    const localFallbackTools = mcpLocalAuthorizedFallbackTools(localAuthorizationStatus);
    const localTools = mcpToolsForServer(0, localFallbackTools);
    const localToolCount = localTools.length;
    const localActionCards = [{
        action: 'local-auth',
        authType: 'local_database',
        title: '管理本机资源授权',
        description: localToolCount
            ? `已接入 ${localToolCount} 个本机只读工具，可查看 mcp.0.* 工具。`
            : '通过桌面客户端接入本机 SQLite、报表目录或受控浏览器自动化。',
        badge: isAnyAuthorized ? '已授权' : '待授权',
        actionLabel: isAnyAuthorized ? '管理授权' : '授权',
        statusText: localToolCount
            ? `mcp.0 工具 ${localToolCount} 个`
            : (isAnyAuthorized ? '已授权，等待桌面端同步工具' : 'Web 网页端不直接访问本机资源'),
        toolCount: localToolCount,
        toolsLabel: localToolCount ? `${localToolCount} 个工具` : ''
    }];

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

    if (dataSourcesBox && notificationsBox) {
        PivotSafeHtml.setHtml(dataSourcesBox, renderMcpSection('数据来源', '先判断数据由服务器、上传文件还是我的电脑提供，再交给下游工具处理。', dataSourceCards, { beforeGridHtml: dataSourceActions }));
        PivotSafeHtml.setHtml(notificationsBox, renderMcpSection('通知与扩展', '把结果发到授权目标，或接入技术同事提供的外部工具服务。', governanceCards, { emptyText: '配置消息通知或外部工具服务后可在任务和工作流中复用。' }));
    } else if (list) {
        PivotSafeHtml.setHtml(list, `
            ${renderMcpSection('数据来源', '先判断数据由服务器、上传文件还是我的电脑提供，再交给下游工具处理。', dataSourceCards, { beforeGridHtml: dataSourceActions })}
            ${renderMcpSection('通知与扩展', '把结果发到授权目标，或接入技术同事提供的外部工具服务。', governanceCards, { emptyText: '配置消息通知或外部工具服务后可在任务和工作流中复用。' })}
        `);
    }

    const containers = [dataSourcesBox, notificationsBox, list].filter(Boolean);
    containers.forEach(container => {
        container.querySelectorAll('[data-mcp-tools]').forEach(btn => {
            const server = mcpServersCache.find(item => String(item.id) === String(btn.dataset.mcpTools));
            if (!server) return;
            const owner = mcpServerBelongsToCurrentUser(server) || (server.user_id === null && isSuperAdminUser());
            const readOnly = server.read_only === true || String(server.scope || '').toLowerCase() === 'shared' && !owner;
            if (readOnly) {
                const card = btn.closest('.mcp-instance-card');
                card?.querySelectorAll('[data-mcp-edit], [data-mcp-delete], [data-mcp-toggle]').forEach(action => {
                    action.disabled = true;
                    action.hidden = true;
                });
            } else if (server.server_type === 'database' && owner && !btn.closest('.mcp-instance-actions')?.querySelector('[data-mcp-share]')) {
                const share = document.createElement('button');
                share.type = 'button';
                share.className = 'btn-secondary';
                share.dataset.mcpShare = String(server.id);
                share.textContent = '分享';
                btn.parentElement?.insertBefore(share, btn);
            }
        });
        container.querySelectorAll('[data-mcp-open-data-analysis]').forEach(btn => {
            btn.addEventListener('click', () => openMcpDataAnalysisImport({
                datasetId: btn.dataset.mcpOpenDataAnalysisDataset || '',
                tab: btn.dataset.mcpOpenDataAnalysisTab || btn.dataset.mcpOpenDataAnalysis || 'overview'
            }));
        });
        container.querySelectorAll('[data-mcp-open-local-auth]').forEach(btn => {
            btn.addEventListener('click', () => window.openMcpLocalAuthorizationCenter?.(btn.dataset.mcpOpenLocalAuth || 'local_database'));
        });
        container.querySelectorAll('[data-mcp-create]').forEach(btn => {
            btn.addEventListener('click', () => window.openMcpCreateModal(btn.dataset.mcpCreate));
        });
        container.querySelectorAll('[data-mcp-system-config]').forEach(btn => {
            btn.addEventListener('click', () => window.openMcpSystemConfig(btn.dataset.mcpSystemConfig));
        });
        container.querySelectorAll('[data-mcp-edit]').forEach(btn => btn.addEventListener('click', () => {
            window.openMcpEditModal(btn.dataset.mcpEdit);
        }));
        container.querySelectorAll('[data-mcp-tools]').forEach(btn => btn.addEventListener('click', () => window.openMcpToolsModal(btn.dataset.mcpTools)));
        container.querySelectorAll('[data-mcp-share]').forEach(btn => btn.addEventListener('click', () => openMcpShareModal(btn.dataset.mcpShare)));
        container.querySelectorAll('[data-mcp-toggle]').forEach(btn => btn.addEventListener('click', () => window.toggleMcpServerStatus(btn.dataset.mcpToggle, btn.dataset.nextStatus, btn)));
        container.querySelectorAll('[data-mcp-delete]').forEach(btn => btn.addEventListener('click', () => window.deleteMcpServer(btn.dataset.mcpDelete, btn)));
        container.querySelectorAll('[data-mcp-open-tool-policy]').forEach(btn => {
            btn.addEventListener('click', async () => {
                await window.openAdminPanel?.({ restore: false });
                await window.switchTab?.('tool-policy');
            });
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
        btn.addEventListener('click', () => window.toggleMcpServerStatus(btn.dataset.mcpToggle, btn.dataset.nextStatus, btn));
    });
}
window.openMcpSystemConfig = function (type) {
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
    mcpModalApi().setMcpModalVisibility?.(modal, true, { focusSelector: '#mcp-edit-name' });
};

window.openMcpToolsModal = async function (serverId) {
    const server = mcpIsLocalDeviceServerId(serverId)
        ? mcpLocalDeviceServer(await (window.getMcpLocalAuthorizationStatus?.({ silent: true }) || Promise.resolve(null)))
        : mcpServersCache.find(item => String(item.id) === String(serverId));
    if (!server) return showToast('未找到工具服务', 'error');
    const modal = document.getElementById('mcp-tools-modal');
    const title = document.getElementById('mcp-tools-title');
    const list = document.getElementById('mcp-tools-list');
    if (!modal || !title || !list) return;
    mcpModalApi().bindMcpModalAccessibility?.();
    const fallbackTools = mcpFallbackToolsForServer(server);
    let tools = mcpToolsForServer(server.id, fallbackTools);
    PivotSafeHtml.setHtml(list, '<div class="mcp-empty-panel compact"><strong>正在读取工具列表...</strong><span>正在同步服务能力，请稍候。</span></div>');
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
        const toolFullName = tool.fullName || tool.name || '';
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
                    <div class="mcp-tool-actions">
                        <button class="btn-secondary mcp-tool-test-btn" type="button" data-mcp-test-tool="${mcpEscape(toolFullName)}" data-mcp-tool-title="${mcpEscape(mcpToolTitle(tool))}">单步测试</button>
                    </div>
                </div>
            `;
    }).join('')}
        </div>
    ` : '<div class="mcp-empty-panel compact"><strong>暂无可用工具</strong><span>请先刷新该服务，或确认它已启用并完成连接。</span></div>');
    list.querySelectorAll('[data-mcp-test-tool]').forEach(btn => {
        btn.addEventListener('click', () => {
            const toolName = btn.dataset.mcpTestTool;
            const toolTitle = btn.dataset.mcpToolTitle;
            const toolObj = tools.find(t => (t.fullName || t.name) === toolName);
            window.openMcpToolTestModal(toolName, toolTitle, toolObj);
        });
    });
    mcpModalApi().setMcpModalVisibility?.(modal, true, { focusSelector: '#mcp-tools-refresh-btn' });
};

const MCP_TOOL_SAMPLE_INPUTS = {
    'viz.build_chart': {
        chartType: 'bar',
        title: '销售业绩统计',
        rows: [
            { month: '1月', sales: 120 },
            { month: '2月', sales: 190 },
            { month: '3月', sales: 300 }
        ],
        xAxis: 'month',
        yAxis: 'sales',
        aggregation: 'sum'
    },
    'viz.build_table': {
        title: '客户清单',
        rows: [
            { id: 1, name: '张三', department: '研发部', status: '在职' },
            { id: 2, name: '李四', department: '市场部', status: '在职' }
        ]
    },
    'data.profile_rows': {
        rows: [
            { id: 1, age: 28, city: '北京', score: 95.5 },
            { id: 2, age: 34, city: '上海', score: 88.0 },
            { id: 3, age: null, city: '广州', score: 72.5 }
        ]
    },
    'data.filter_rows': {
        rows: [
            { name: '任务A', priority: 'high', done: false },
            { name: '任务B', priority: 'low', done: true },
            { name: '任务C', priority: 'high', done: true }
        ],
        filters: { priority: 'high' },
        matchMode: 'exact'
    },
    'data.group_summary': {
        rows: [
            { category: '电子', price: 2999 },
            { category: '电子', price: 1499 },
            { category: '服装', price: 199 }
        ],
        groupBy: 'category',
        valueField: 'price',
        aggregation: 'sum'
    },
    'doc.chunk_text': {
        text: '这是第一段新闻内容。\n\n这是第二段新闻内容，包含更多详细信息。\n\n这是第三段总结。',
        maxChars: 200
    },
    'doc.extract_outline': {
        text: '# 第一章 系统概述\n\n系统由前端与后端组成。\n\n## 1.1 架构设计\n\n采用微内核架构。\n\n# 第二章 部署指南'
    },
    'doc.extract_key_values': {
        text: '姓名：张三\n职位：高级工程师\n入职日期：2024-01-15'
    },
    'format.to_markdown_table': {
        rows: [
            { 序号: 1, 模块: '认证中心', 状态: '正常' },
            { 序号: 2, 模块: '模型网关', 状态: '正常' }
        ]
    },
    'format.to_json': {
        value: 'key1=value1\nkey2=value2',
        pretty: true
    },
    'system.health': {},
    'system.modelRuntime': {},
    'models.list': {},
    'rag.search': {
        query: '系统部署要求',
        limit: 3
    },
    'db.list_tables': {},
    'db.count_tables': {},
    'db.describe_table': {
        table: 'users'
    },
    'db.run_readonly_query': {
        sql: 'SELECT 1 AS test_status, current_timestamp AS test_time;'
    },
    'db.group_count': {
        table: 'users',
        groupBy: 'role'
    },
    'reports.list_files': {
        limit: 5
    },
    'im.list_allowed_targets': {},
    'im.send_markdown': {
        target: 'test_group',
        markdown: '**测试消息**：智枢工具单步测试'
    }
};

function generateDefaultSampleInput(schema) {
    const props = schema?.properties || {};
    const sample = {};
    Object.entries(props).forEach(([key, spec]) => {
        if (spec.default !== undefined) {
            sample[key] = spec.default;
        } else if (spec.type === 'string') {
            sample[key] = spec.enum ? spec.enum[0] : 'test';
        } else if (spec.type === 'number' || spec.type === 'integer') {
            sample[key] = spec.minimum !== undefined ? spec.minimum : 1;
        } else if (spec.type === 'boolean') {
            sample[key] = true;
        } else if (spec.type === 'array') {
            sample[key] = [];
        } else if (spec.type === 'object') {
            sample[key] = {};
        }
    });
    return sample;
}

function fillMcpToolSampleInput(toolFullName, schema) {
    const inputEl = document.getElementById('mcp-tool-test-input');
    if (!inputEl) return;
    const shortName = String(toolFullName || '').replace(/^mcp\.\d+\./, '');
    let sample = MCP_TOOL_SAMPLE_INPUTS[shortName] || MCP_TOOL_SAMPLE_INPUTS[toolFullName];
    if (!sample) {
        let parsedSchema = schema;
        if (!parsedSchema) {
            const raw = document.getElementById('mcp-tool-test-name')?.dataset?.toolSchema;
            try { parsedSchema = JSON.parse(raw); } catch (_) {}
        }
        sample = generateDefaultSampleInput(parsedSchema);
    }
    inputEl.value = JSON.stringify(sample, null, 2);
}

function openMcpToolTestModal(toolFullName, toolTitle, toolObj) {
    bindMcpToolTestModalControls();
    mcpModalApi().bindMcpModalAccessibility?.();
    const modal = document.getElementById('mcp-tool-test-modal');
    if (!modal) return;
    const titleEl = document.getElementById('mcp-tool-test-title');
    const subtitleEl = document.getElementById('mcp-tool-test-subtitle');
    const nameEl = document.getElementById('mcp-tool-test-name');
    const statusEl = document.getElementById('mcp-tool-test-status');
    const resultEl = document.getElementById('mcp-tool-test-result');
    const schemaHintEl = document.getElementById('mcp-tool-test-schema-hint');

    if (titleEl) titleEl.textContent = `工具单步测试 · ${toolTitle || toolFullName}`;
    if (subtitleEl) subtitleEl.textContent = `工具标识：${toolFullName}`;
    if (nameEl) {
        nameEl.value = toolFullName;
        nameEl.dataset.toolSchema = JSON.stringify(toolObj?.input_schema || toolObj?.inputSchema || {});
    }
    if (statusEl) {
        statusEl.className = 'mcp-tool-test-status';
        statusEl.textContent = '';
    }
    if (resultEl) resultEl.textContent = '点击下方“运行测试”查看工具返回结果...';

    const schema = toolObj?.input_schema || toolObj?.inputSchema || {};
    const req = Array.isArray(schema.required) ? schema.required : [];
    const props = schema.properties || {};
    const propNames = Object.keys(props);
    if (schemaHintEl) {
        schemaHintEl.textContent = propNames.length
            ? `入参字段：${propNames.map(k => `${k}${req.includes(k) ? ' (必填)' : ''}`).join('、')}`
            : '当前工具不需要额外必填参数。';
    }

    fillMcpToolSampleInput(toolFullName, schema);
    mcpModalApi().setMcpModalVisibility?.(modal, true, { focusSelector: '#mcp-tool-test-input' });
}

async function runMcpToolTest() {
    const nameEl = document.getElementById('mcp-tool-test-name');
    const inputEl = document.getElementById('mcp-tool-test-input');
    const statusEl = document.getElementById('mcp-tool-test-status');
    const resultEl = document.getElementById('mcp-tool-test-result');
    const runBtn = document.getElementById('mcp-tool-test-run-btn');
    const toolName = nameEl?.value?.trim();
    if (!toolName) return showToast('未指定待测工具名称', 'error');

    let inputPayload = {};
    const rawInput = inputEl?.value?.trim();
    if (rawInput) {
        try {
            inputPayload = JSON.parse(rawInput);
        } catch (e) {
            if (statusEl) {
                statusEl.className = 'mcp-tool-test-status error';
                statusEl.textContent = 'JSON 格式错误';
            }
            if (resultEl) resultEl.textContent = `参数 JSON 解析失败：${e.message}`;
            return showToast('测试入参不是合法的 JSON 格式', 'error');
        }
    }

    if (runBtn) {
        runBtn.disabled = true;
        runBtn.textContent = '执行中...';
    }
    if (statusEl) {
        statusEl.className = 'mcp-tool-test-status';
        statusEl.textContent = '正在调用工具...';
    }
    if (resultEl) resultEl.textContent = '请求发送中，请稍候...';

    const startTime = Date.now();
    try {
        const res = await apiFetch(`${API_BASE}/mcp/tools/call`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: toolName, input: inputPayload })
        });
        const duration = Date.now() - startTime;
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.success === false) {
            const errMsg = data.error || '工具调用返回错误';
            if (statusEl) {
                statusEl.className = 'mcp-tool-test-status error';
                statusEl.textContent = `执行失败 (${duration}ms)`;
            }
            if (resultEl) resultEl.textContent = `错误状态：${res.status}\n错误信息：${errMsg}`;
            return;
        }
        if (statusEl) {
            statusEl.className = 'mcp-tool-test-status success';
            statusEl.textContent = `执行成功 (${duration}ms)`;
        }
        if (resultEl) {
            const formatted = typeof data.result === 'string' ? data.result : JSON.stringify(data.result, null, 2);
            resultEl.textContent = formatted;
        }
    } catch (err) {
        const duration = Date.now() - startTime;
        if (statusEl) {
            statusEl.className = 'mcp-tool-test-status error';
            statusEl.textContent = `网络错误 (${duration}ms)`;
        }
        if (resultEl) resultEl.textContent = `调用异常：${err.message}`;
    } finally {
        if (runBtn) {
            runBtn.disabled = false;
            runBtn.textContent = '运行测试';
        }
    }
}

function bindMcpToolTestModalControls() {
    const modal = document.getElementById('mcp-tool-test-modal');
    if (!modal || modal.dataset.boundMcpToolTestModal === '1') return;
    modal.dataset.boundMcpToolTestModal = '1';

    const closeModal = () => mcpModalApi().setMcpModalVisibility?.(modal, false);
    document.getElementById('mcp-tool-test-close-btn')?.addEventListener('click', closeModal);
    document.getElementById('mcp-tool-test-cancel-btn')?.addEventListener('click', closeModal);
    document.getElementById('mcp-tool-test-run-btn')?.addEventListener('click', () => runMcpToolTest());
    document.getElementById('mcp-tool-test-fill-sample-btn')?.addEventListener('click', () => {
        const name = document.getElementById('mcp-tool-test-name')?.value;
        fillMcpToolSampleInput(name);
        showToast('已填入测试样例参数', 'success');
    });
    document.getElementById('mcp-tool-test-format-btn')?.addEventListener('click', () => {
        const inputEl = document.getElementById('mcp-tool-test-input');
        if (!inputEl?.value?.trim()) return;
        try {
            inputEl.value = JSON.stringify(JSON.parse(inputEl.value), null, 2);
            showToast('JSON 已格式化', 'success');
        } catch (e) {
            showToast('JSON 格式有误，无法格式化', 'error');
        }
    });
    modal.addEventListener('click', event => {
        if (event.target === modal) closeModal();
    });
}

async function runMcpBatchHealthCheck() {
    const btn = document.getElementById('mcp-health-check-btn');
    if (mcpActionLocks.has('batch-health-check')) return;
    mcpActionLocks.add('batch-health-check');
    const originalText = btn ? btn.textContent : '连通性自检';
    if (btn) {
        btn.disabled = true;
        btn.textContent = '正在检测...';
    }
    try {
        const servers = (mcpServersCache || []).filter(s => (
            s.status !== 'paused'
            && mcpShouldShowAsWorkbenchServer(s)
            && s.read_only !== true
        ));
        if (!servers.length) {
            showToast('当前没有可诊断的工具服务', 'info');
            return;
        }
        let successCount = 0;
        let failCount = 0;
        await Promise.all(servers.map(async server => {
            try {
                const res = await apiFetch(`${API_BASE}/mcp/servers/${encodeURIComponent(server.id)}/diagnose`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({})
                });
                const data = await res.json().catch(() => ({}));
                if (res.ok && data.success !== false) {
                    successCount += 1;
                    server.last_error = null;
                } else {
                    failCount += 1;
                    server.last_error = data.error || '连通失败';
                }
            } catch (e) {
                failCount += 1;
                server.last_error = e.message || '网络连接异常';
            }
        }));
        showToast(`已完成 ${servers.length} 个服务自检：${successCount} 个正常，${failCount} 个异常`, failCount > 0 ? 'warning' : 'success');
        await window.loadMcpWorkbench();
    } finally {
        mcpActionLocks.delete('batch-health-check');
        if (btn) {
            btn.disabled = false;
            btn.textContent = originalText;
        }
    }
}

window.ensureMcpSystemService = async function (type, button) {
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
    const data = await res.json().catch(() => ({}));
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
        PivotSafeHtml.setHtml(panel, '<div class="mcp-governance-empty">治理概览暂不可用，工具列表仍可继续使用。<button type="button" class="btn-secondary" data-mcp-retry-governance>重试治理概览</button></div>');
        panel.querySelector('[data-mcp-retry-governance]')?.addEventListener('click', () => loadMcpGovernance());
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
        </div>
        <div class="governance-metrics">
            <button id="mcp-refresh-btn" class="btn-secondary" type="button">刷新</button>
            <button id="mcp-health-check-btn" class="btn-secondary" type="button">连通性自检</button>
            <span><b>${active}</b>可用服务</span>
            <span><b>${errors}</b>需要处理</span>
            <span><b>${unchecked}</b>待刷新</span>
            <span><b>${databaseServers}</b>数据连接</span>
            <span><b>${Number(s.callErrorRate ?? health.callErrorRate ?? 0)}%</b>调用错误率</span>
        </div>
        ${notes.length ? `<div class="governance-list mcp-safety-notes">${notes.map(item => `<span>${mcpEscape(item)}</span>`).join('')}</div>` : ''}
    `);
    panel.querySelector('#mcp-refresh-btn')?.addEventListener('click', () => window.loadMcpWorkbench?.());
    panel.querySelector('#mcp-health-check-btn')?.addEventListener('click', () => window.runMcpBatchHealthCheck?.());
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

window.testMcpDatabaseConnection = async function (mode = 'create') {
    if ((mcpFormEl('source-type', mode)?.value || 'external') !== 'database') {
        return showToast('请先选择服务器可访问数据库', 'error');
    }
    const payload = collectMcpDatabasePayload(mode);
    const error = validateMcpDatabasePayload(payload, { requireName: false });
    if (error) return showToast(error, 'error');

    const button = mcpFormEl('test-db-btn', mode);
    return withMcpActionLock(`database-test-${mode}`, button, '测试中...', async () => {
        const res = await apiFetch(`${API_BASE}/mcp/database-connections/test`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(formatMcpDatabaseError(data, '服务器可访问数据库测试失败'));
        showToast('服务器可访问数据库测试通过', 'success');
        return data;
    });
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
        protocol_mode: mcpFormEl('protocol-mode', mode)?.value || 'legacy',
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

window.diagnoseMcpServer = async function (mode = 'edit', options = {}) {
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
    return withMcpActionLock(`diagnose-${mode}-${id}-${options.action || 'check'}`, button, options.action === 'test' ? '发送中...' : '诊断中...', async () => {
        if (panel) panel.textContent = '正在诊断...';
        const res = await apiFetch(`${API_BASE}/mcp/servers/${encodeURIComponent(id)}/diagnose`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.success === false) {
            const message = data.error || data.message || '配置诊断失败';
            if (panel) panel.textContent = message;
            throw new Error(message);
        }
        if (panel) panel.textContent = renderMcpDiagnostics(data);
        showToast(options.action === 'test' ? '测试发送完成' : '配置诊断完成', 'success');
        return data;
    });
};

window.saveMcpServer = async function (mode = 'create') {
    const saveButton = mcpFormEl('save-btn', mode);
    if (mcpActionLocks.has(`save-${mode}`)) return;
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
        return showToast('请填写服务名称和URL', 'error');
    }
    return withMcpActionLock(`save-${mode}`, saveButton, '保存中...', async () => {
        const res = await apiFetch(endpoint, {
            method: id ? 'PUT' : 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(formatMcpDatabaseError(data, '保存失败'));
        showToast('工具服务已保存', 'success');
        if (mode === 'edit') {
            window.closeMcpEditModal();
        } else {
            window.resetMcpForm();
        }
        await window.loadMcpWorkbench();
        return data;
    });
};

window.refreshMcpTools = async function (id, options = {}) {
    const refreshButton = options.button || document.getElementById('mcp-tools-refresh-btn');
    if (mcpActionLocks.has(`refresh-${id}`)) return;
    mcpActionLocks.add(`refresh-${id}`);
    const isLocalDevice = mcpIsLocalDeviceServerId(id);
    let localFallbackCount = 0;
    const originalText = refreshButton?.textContent || '刷新工具';
    if (refreshButton) {
        refreshButton.disabled = true;
        refreshButton.textContent = '刷新中...';
    }
    try {
        if (isLocalDevice) {
            const registration = await (window.syncMcpLocalExecutionBridge ? window.syncMcpLocalExecutionBridge() : Promise.resolve(null)).catch(() => null);
            const status = registration?.status || await (window.getMcpLocalAuthorizationStatus?.({ refresh: true, silent: true }) || Promise.resolve(null));
            localFallbackCount = mcpLocalAuthorizedFallbackTools(status).length;
        }
        const res = await apiFetch(`${API_BASE}/mcp/servers/${encodeURIComponent(id)}/refresh`, { method: 'POST' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '刷新失败');
        const refreshedCount = Number(data.tools?.length || 0);
        const visibleCount = isLocalDevice ? Math.max(refreshedCount, localFallbackCount) : refreshedCount;
        showToast(isLocalDevice ? `已同步本机工具 ${visibleCount} 个` : `已刷新 ${visibleCount} 个工具`, 'success');
        await window.loadMcpWorkbench();
        if (options.keepToolsModalOpen) window.openMcpToolsModal(id);
    } catch (error) {
        showToast(error.message || '刷新失败', 'error');
    } finally {
        mcpActionLocks.delete(`refresh-${id}`);
        if (refreshButton) {
            refreshButton.disabled = false;
            refreshButton.textContent = originalText;
        }
    }
};

window.toggleMcpServerStatus = async function (id, nextStatus = 'paused', button = null) {
    const server = mcpServersCache.find(item => String(item.id) === String(id));
    if (!server) return showToast('未找到工具服务', 'error');
    return withMcpActionLock(`status-${id}`, button, '', async () => {
        const res = await apiFetch(`${API_BASE}/mcp/servers/${encodeURIComponent(id)}/status`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: nextStatus === 'paused' ? 'paused' : 'active' })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(formatMcpDatabaseError(data, '状态更新失败'));
        showToast(nextStatus === 'paused' ? '工具服务已停用' : '工具服务已启用', 'success');
        await window.loadMcpWorkbench();
        return data;
    });
};

window.deleteMcpServer = function (id, button = null) {
    showConfirm('删除工具服务', '确定删除这个工具服务吗？', async () => {
        await withMcpActionLock(`delete-${id}`, button, '删除中...', async () => {
            const res = await apiFetch(`${API_BASE}/mcp/servers/${encodeURIComponent(id)}`, { method: 'DELETE' });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || '删除失败');
            showToast('工具服务已删除', 'success');
            await window.loadMcpWorkbench();
        });
    });
};

function setMcpShareError(message = '') {
    const errorEl = document.getElementById('mcp-share-error');
    if (!errorEl) return;
    errorEl.textContent = message;
    errorEl.hidden = !message;
}

function setMcpShareTargetsEnabled() {
    const modal = document.getElementById('mcp-share-modal');
    if (!modal) return;
    const enabled = modal.querySelector('input[name="mcp-share-scope"]:checked')?.value === 'shared';
    const all = document.getElementById('mcp-share-all');
    const allChecked = all?.checked === true && all?.disabled !== true;
    modal.querySelectorAll('input[name="mcp-share-unit"], input[name="mcp-share-user"], [data-mcp-share-select], [data-mcp-share-clear]')
        .forEach(control => control.disabled = !enabled || allChecked);
}

function bindMcpShareModal() {
    const modal = document.getElementById('mcp-share-modal');
    if (!modal || modal.dataset.bound === 'true') return;
    modal.dataset.bound = 'true';
    mcpModalApi().bindMcpModalAccessibility?.();
    const close = () => mcpModalApi().setMcpModalVisibility?.(modal, false);
    document.getElementById('mcp-share-close-btn')?.addEventListener('click', close);
    document.getElementById('mcp-share-cancel-btn')?.addEventListener('click', close);
    modal.addEventListener('click', event => {
        if (event.target === modal) close();
    });

    modal.querySelectorAll('input[name="mcp-share-scope"]').forEach(input => {
        input.addEventListener('change', () => {
            const isShared = modal.querySelector('input[name="mcp-share-scope"]:checked')?.value === 'shared';
            const unitsSection = document.getElementById('mcp-share-units-section');
            if (unitsSection) unitsSection.classList.toggle('hidden', !isShared);
            setMcpShareTargetsEnabled();
            setMcpShareError('');
        });
    });

    document.getElementById('mcp-share-all')?.addEventListener('change', () => {
        setMcpShareTargetsEnabled();
        setMcpShareError('');
    });
    modal.querySelectorAll('[data-mcp-share-select], [data-mcp-share-clear]').forEach(button => {
        button.addEventListener('click', () => {
            const group = button.dataset.mcpShareSelect || button.dataset.mcpShareClear;
            const checked = Boolean(button.dataset.mcpShareSelect);
            const tree = document.getElementById('mcp-share-target-tree');
            if (group === 'tree') window.PivotShareTargetTree?.setChecked(tree, checked);
            setMcpShareError('');
        });
    });

    document.getElementById('mcp-share-save-btn')?.addEventListener('click', async () => {
        const id = document.getElementById('mcp-share-id')?.value;
        const scope = modal.querySelector('input[name="mcp-share-scope"]:checked')?.value || 'personal';
        const isShared = scope === 'shared';
        const all = document.getElementById('mcp-share-all');
        const allChecked = all?.checked === true && all?.disabled !== true;
        const allowedUnits = isShared && !allChecked
            ? [...modal.querySelectorAll('input[name="mcp-share-unit"]:checked')].map(input => input.value).filter(Boolean)
            : [];
        const allowedUserIds = isShared && !allChecked
            ? [...modal.querySelectorAll('input[name="mcp-share-user"]:checked')]
                .filter(input => !allowedUnits.includes(input.dataset.shareTreeUserUnit || ''))
                .map(input => Number(input.value))
                .filter(Number.isSafeInteger)
            : [];

        if (isShared && !allChecked && !allowedUnits.length && !allowedUserIds.length) {
            setMcpShareError('共享时至少选择一个单位或一个个人，也可以由管理员共享给全体成员。');
            return;
        }

        setMcpShareError('');
        const saveBtn = document.getElementById('mcp-share-save-btn');
        if (saveBtn) saveBtn.disabled = true;

        try {
            const res = await apiFetch(`${API_BASE}/mcp/servers/${encodeURIComponent(id)}/sharing`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ scope, allowedUnits, allowedUserIds })
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || '共享设置保存失败');
            close();
            showToast('共享设置已更新', 'success');
            await window.loadMcpWorkbench();
        } catch (err) {
            setMcpShareError(err.message || '共享设置保存失败');
        } finally {
            if (saveBtn) saveBtn.disabled = false;
        }
    });
}

async function openMcpShareModal(serverId) {
    bindMcpShareModal();
    const modal = document.getElementById('mcp-share-modal');
    if (!modal) return;
    setMcpShareError('');
    const res = await apiFetch(`${API_BASE}/mcp/servers/${encodeURIComponent(serverId)}/share-options`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return showToast(data.error || '无法读取共享设置', 'error');
    if (data.data?.supportsSharing === false) return showToast('当前服务不支持共享', 'error');

    const server = data.data?.server || {};
    const units = Array.isArray(data.data?.units) ? data.data.units.filter(Boolean) : [];
    const users = Array.isArray(data.data?.users) ? data.data.users.filter(item => Number(item?.id) > 0) : [];
    const allowed = new Set(String(server.allowed_units || '').split(',').map(item => item.trim()).filter(Boolean));
    const allowedUserIds = new Set((Array.isArray(server.allowed_user_ids)
        ? server.allowed_user_ids
        : String(server.allowed_user_ids || '').split(',')).map(Number).filter(Number.isSafeInteger));
    const isShared = String(server.scope || '') === 'shared';
    const canShareAll = data.data?.canShareAll === true;
    const isAll = isShared && canShareAll && allowed.size === 0 && allowedUserIds.size === 0;

    document.getElementById('mcp-share-id').value = String(serverId);

    const summaryEl = document.getElementById('mcp-share-summary');
    if (summaryEl) {
        PivotSafeHtml.setHtml(summaryEl, `
            <strong>${mcpEscape(server.name || '数据库只读服务')}</strong>
            <span>共享后，接收方只能执行只读 SQL 工具，连接密码和编辑权限不会被共享。</span>
        `);
    }

    const scopeRadio = modal.querySelector(`input[name="mcp-share-scope"][value="${isShared ? 'shared' : 'personal'}"]`);
    if (scopeRadio) scopeRadio.checked = true;

    const unitsSection = document.getElementById('mcp-share-units-section');
    if (unitsSection) unitsSection.classList.toggle('hidden', !isShared);

    const allCheckbox = document.getElementById('mcp-share-all');
    if (allCheckbox) {
        allCheckbox.checked = isAll;
        allCheckbox.disabled = !canShareAll;
    }
    const allLabel = document.getElementById('mcp-share-all-label');
    if (allLabel) allLabel.classList.toggle('hidden', !canShareAll);

    const currentUnit = String(data.data?.currentUnit || '').trim();
    const targetTree = document.getElementById('mcp-share-target-tree');
    if (targetTree) {
        PivotSafeHtml.setHtml(targetTree, window.PivotShareTargetTree?.render({
            units,
            users,
            allowedUnits: [...allowed],
            allowedUserIds: [...allowedUserIds],
            currentUnit,
            isShared,
            isAll,
            unitInputName: 'mcp-share-unit',
            userInputName: 'mcp-share-user',
            escapeText: mcpEscape,
            escapeAttr: mcpEscape
        }) || '<div class="agent-workflow-share-empty">暂无可共享的单位或用户。</div>');
        window.PivotShareTargetTree?.bind(targetTree, {
            unitSelector: 'input[name="mcp-share-unit"]',
            userSelector: 'input[name="mcp-share-user"]',
            onChange: () => setMcpShareError('')
        });
    }

    setMcpShareTargetsEnabled();

    mcpModalApi().setMcpModalVisibility?.(modal, true, { focusSelector: 'input[name="mcp-share-scope"]' });
};

window.Pivot?.exposeModule?.('mcp.workbench', {
    openMcpShareModal,
    openMcpToolTestModal,
    runMcpToolTest,
    runMcpBatchHealthCheck,
    fillMcpToolSampleInput
});

window.loadMcpWorkbench = async function () {
    if (mcpWorkbenchLoadPromise) return mcpWorkbenchLoadPromise;
    mcpWorkbenchLoadPromise = (async () => {
        try {
            window.Pivot?.moduleApi?.('mcp.tabs')?.bindTabs?.();
            await loadMcpGovernance();
            await (window.syncMcpLocalExecutionBridge
                ? window.syncMcpLocalExecutionBridge()
                : Promise.resolve(null)).catch(() => null);
            await loadMcpTools();
            await loadMcpServers();
        } catch (e) {
            showToast(e?.message || '工具库加载失败，请检查网络连接', 'error');
        } finally {
            mcpWorkbenchLoadPromise = null;
        }
    })();
    return mcpWorkbenchLoadPromise;
};

function renderMcpSourceActionPanel(cards = [], { title = '', description = '' } = {}) {
    const availableCards = cards.filter(Boolean);
    if (!availableCards.length) return '';
    const actions = availableCards.map(card => {
        const isAuthorized = card.badge === '已授权';
        const btnText = card.actionLabel || (isAuthorized ? '管理授权' : '授权');
        const btnClass = isAuthorized ? 'btn-secondary' : 'btn-secondary is-active';
        const toolsButton = Number(card.toolCount || 0) > 0
            ? `<button class="btn-secondary mcp-source-tool-btn" type="button" data-mcp-tools="0">${mcpEscape(card.toolsLabel || '工具')}</button>`
            : '';
        return `
            <div class="mcp-source-action" role="group">
                <button class="mcp-source-action-main" data-mcp-open-local-auth="${mcpEscape(card.authType)}" type="button">
                    <span>
                        <strong>${mcpEscape(card.title)}</strong>
                        <small>${mcpEscape(card.description)}</small>
                    </span>
                    <span class="mcp-source-btn-wrap">
                        <em class="${btnClass}">${mcpEscape(btnText)}</em>
                    </span>
                </button>
                ${toolsButton}
            </div>
        `;
    }).join('');
    return `
        <div class="mcp-source-action-panel">
            <div class="mcp-source-action-head">
                <strong>${mcpEscape(title)}</strong>
                <span title="${mcpEscape(description)}">${mcpEscape(description)}</span>
            </div>
            <div class="mcp-source-action-list">${actions}</div>
        </div>
    `;
}
