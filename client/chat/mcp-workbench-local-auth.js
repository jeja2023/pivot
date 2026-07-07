// 工具箱本机授权中心。当前只负责授权状态与本机资源选择，不执行查询或扫描。
const MCP_LOCAL_AUTH_TYPES = [
    {
        type: 'local_database',
        title: '连接本机数据库',
        description: '先授权本机 SQLite 文件；后续可扩展本机 MySQL、PostgreSQL 和 ODBC。',
        grantLabel: '选择 SQLite 文件',
        revokeTitle: '撤销本机数据库授权',
        revokeMessage: '确定撤销当前设备上的本机数据库授权吗？已保存的本机路径会从桌面客户端本机配置中移除。'
    },
    {
        type: 'local_report_dir',
        title: '授权本机报表目录',
        description: '选择一个本机目录，只读扫描授权范围内的报表文件。',
        grantLabel: '选择目录',
        revokeTitle: '撤销本机目录授权',
        revokeMessage: '确定撤销当前设备上的本机报表目录授权吗？已保存的本机目录会从桌面客户端本机配置中移除。'
    }
];

let mcpLocalAuthorizationStatusCache = null;
let mcpLocalAuthorizationActiveType = 'local_database';

function mcpLocalAuthConfig(type) {
    return MCP_LOCAL_AUTH_TYPES.find(item => item.type === type) || MCP_LOCAL_AUTH_TYPES[0];
}

function mcpLocalAuthBridge() {
    const desktop = window.pivotDesktop;
    if (desktop
        && typeof desktop.getLocalAuthorizationStatus === 'function'
        && typeof desktop.requestLocalAuthorization === 'function'
        && typeof desktop.revokeLocalAuthorization === 'function') {
        return desktop;
    }
    return null;
}

function mcpLocalAuthFallbackStatus(message = '') {
    return {
        available: false,
        provider: 'web',
        mode: 'web',
        deviceName: '网页端',
        supportedTypes: MCP_LOCAL_AUTH_TYPES.map(item => item.type),
        grants: {
            local_database: { type: 'local_database', authorized: false },
            local_report_dir: { type: 'local_report_dir', authorized: false }
        },
        message: message || '当前网页未检测到桌面客户端或本地助手，本机资源不会被服务器直接读取。'
    };
}

function mcpLocalAuthNormalizeStatus(status) {
    const fallback = mcpLocalAuthFallbackStatus();
    const grants = status && typeof status.grants === 'object' && status.grants ? status.grants : {};
    return {
        ...fallback,
        ...(status || {}),
        grants: {
            local_database: grants.local_database || fallback.grants.local_database,
            local_report_dir: grants.local_report_dir || fallback.grants.local_report_dir
        }
    };
}

async function getMcpLocalAuthorizationStatus(options = {}) {
    if (!options.refresh && mcpLocalAuthorizationStatusCache) return mcpLocalAuthorizationStatusCache;
    const bridge = mcpLocalAuthBridge();
    if (!bridge) {
        mcpLocalAuthorizationStatusCache = mcpLocalAuthFallbackStatus();
        return mcpLocalAuthorizationStatusCache;
    }
    try {
        const status = await bridge.getLocalAuthorizationStatus();
        mcpLocalAuthorizationStatusCache = mcpLocalAuthNormalizeStatus(status);
        return mcpLocalAuthorizationStatusCache;
    } catch (e) {
        mcpLocalAuthorizationStatusCache = mcpLocalAuthFallbackStatus(e.message || '本机授权状态读取失败。');
        if (!options.silent) showToast(mcpLocalAuthorizationStatusCache.message, 'error');
        return mcpLocalAuthorizationStatusCache;
    }
}

function mcpLocalGrant(status, type) {
    return status?.grants?.[type] || { type, authorized: false };
}

function mcpLocalAuthBadge(status, type) {
    const grant = mcpLocalGrant(status, type);
    if (!status?.available) return '需客户端';
    return grant.authorized ? '已授权' : '待授权';
}

function mcpLocalAuthCardStatusText(status, type) {
    const grant = mcpLocalGrant(status, type);
    if (!status?.available) return '使用桌面客户端或安装本地助手后授权';
    if (grant.authorized) return `${grant.label || '已授权资源'} · ${status.deviceName || grant.deviceName || '当前设备'}`;
    if (type === 'local_database') return '打开授权中心选择本机 SQLite 文件';
    return '打开授权中心选择本机报表目录';
}

function mcpLocalAuthorizationDescription(status) {
    if (!status?.available) return '当前网页未检测到本机助手。';
    const grantedCount = MCP_LOCAL_AUTH_TYPES.filter(item => mcpLocalGrant(status, item.type).authorized).length;
    return grantedCount ? `${status.deviceName || '当前设备'} 已授权 ${grantedCount} 项。` : `${status.deviceName || '当前设备'} 可授权本机资源。`;
}

function decorateMcpLocalActionCards(cards = [], status = null) {
    return cards.map(card => {
        if (!MCP_LOCAL_AUTH_TYPES.some(item => item.type === card.type)) return card;
        const grant = mcpLocalGrant(status, card.type);
        return {
            ...card,
            disabled: false,
            action: 'local-auth',
            badge: mcpLocalAuthBadge(status, card.type),
            actionLabel: grant.authorized ? '管理授权' : '授权',
            statusText: mcpLocalAuthCardStatusText(status, card.type)
        };
    });
}

function mcpLocalAuthFormatTime(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleString('zh-CN', { hour12: false });
}

function renderMcpLocalAuthGrant(type, status) {
    const config = mcpLocalAuthConfig(type);
    const grant = mcpLocalGrant(status, type);
    const available = Boolean(status?.available);
    const authorized = Boolean(grant.authorized);
    const stateClass = !available ? 'is-unavailable' : (authorized ? 'is-authorized' : 'is-pending');
    const stateText = !available ? '需要客户端' : (authorized ? '已授权' : '未授权');
    const pathText = authorized
        ? `${grant.label || '已授权资源'}${grant.pathHint ? ` · ${grant.pathHint}` : ''}`
        : '尚未选择本机资源。';
    const timeText = authorized ? mcpLocalAuthFormatTime(grant.updatedAt || grant.grantedAt) : '';
    return `
        <article class="mcp-local-auth-item ${stateClass}" data-mcp-local-auth-item="${mcpEscape(type)}">
            <header>
                <div>
                    <strong>${mcpEscape(config.title)}</strong>
                    <p>${mcpEscape(config.description)}</p>
                </div>
                <em>${mcpEscape(stateText)}</em>
            </header>
            <div class="mcp-local-auth-tags">
                <span><b>执行</b>我的电脑</span>
                <span><b>归属</b>个人</span>
                <span><b>风险</b>中风险</span>
                <span><b>自动化</b>仅当前设备在线</span>
            </div>
            <div class="mcp-local-auth-resource">
                <strong>${mcpEscape(pathText)}</strong>
                <span>${timeText ? `授权时间：${mcpEscape(timeText)}` : '本机路径只保存在桌面客户端或本地助手，不上传到服务器。'}</span>
            </div>
            <footer>
                <button class="btn-primary" type="button" data-mcp-local-grant="${mcpEscape(type)}" ${available ? '' : 'disabled'}>${mcpEscape(authorized ? '重新授权' : config.grantLabel)}</button>
                <button class="btn-secondary" type="button" data-mcp-local-revoke="${mcpEscape(type)}" ${available && authorized ? '' : 'disabled'}>撤销</button>
            </footer>
        </article>
    `;
}

function renderMcpLocalAuthorizationCenter(status) {
    const body = document.getElementById('mcp-local-auth-body');
    if (!body) return;
    const providerText = status.available ? '桌面客户端' : '网页端';
    const activeConfig = mcpLocalAuthConfig(mcpLocalAuthorizationActiveType);
    PivotSafeHtml.setHtml(body, `
        <div class="mcp-local-auth-summary ${status.available ? 'is-ready' : 'is-waiting'}">
            <div>
                <strong>${mcpEscape(providerText)} · ${mcpEscape(status.deviceName || '当前设备')}</strong>
                <span>${mcpEscape(status.message || '本机授权状态已读取。')}</span>
            </div>
            <em>${mcpEscape(status.available ? '本机桥已就绪' : '等待本地助手')}</em>
        </div>
        <div class="mcp-local-auth-tabs" role="tablist" aria-label="本机授权类型">
            ${MCP_LOCAL_AUTH_TYPES.map(item => `
                <button class="btn-secondary${item.type === activeConfig.type ? ' active' : ''}" type="button" data-mcp-local-auth-tab="${mcpEscape(item.type)}">${mcpEscape(item.title)}</button>
            `).join('')}
        </div>
        <div class="mcp-local-auth-list">
            ${renderMcpLocalAuthGrant(activeConfig.type, status)}
        </div>
        <div class="mcp-local-auth-note">
            <strong>安全边界</strong>
            <span>本步骤只建立当前设备的授权记录；工具箱仍不会让服务器主动访问你的 localhost、本机数据库或本机文件夹，后续查询会通过桌面端或本地助手只读执行。</span>
        </div>
    `);
    bindMcpLocalAuthorizationCenter(status);
}

function bindMcpLocalAuthorizationCenter(status) {
    const body = document.getElementById('mcp-local-auth-body');
    if (!body) return;
    body.querySelectorAll('[data-mcp-local-auth-tab]').forEach(button => {
        button.addEventListener('click', () => {
            mcpLocalAuthorizationActiveType = button.dataset.mcpLocalAuthTab || 'local_database';
            renderMcpLocalAuthorizationCenter(status);
        });
    });
    body.querySelectorAll('[data-mcp-local-grant]').forEach(button => {
        button.addEventListener('click', () => requestMcpLocalAuthorization(button.dataset.mcpLocalGrant));
    });
    body.querySelectorAll('[data-mcp-local-revoke]').forEach(button => {
        button.addEventListener('click', () => confirmRevokeMcpLocalAuthorization(button.dataset.mcpLocalRevoke));
    });
}

async function refreshMcpLocalAuthorizationCenter(options = {}) {
    const status = await getMcpLocalAuthorizationStatus({ refresh: true, silent: options.silent !== false });
    renderMcpLocalAuthorizationCenter(status);
    await window.loadMcpWorkbench?.();
}

async function requestMcpLocalAuthorization(type) {
    const bridge = mcpLocalAuthBridge();
    if (!bridge) return showToast('请使用桌面客户端打开，或安装本地助手后再授权本机资源。', 'warning');
    try {
        const result = await bridge.requestLocalAuthorization(type);
        if (result?.canceled) return showToast('已取消本机授权选择。', 'warning');
        mcpLocalAuthorizationStatusCache = mcpLocalAuthNormalizeStatus(result?.status);
        renderMcpLocalAuthorizationCenter(mcpLocalAuthorizationStatusCache);
        await window.loadMcpWorkbench?.();
        showToast('本机授权已更新。', 'success');
    } catch (e) {
        showToast(e.message || '本机授权失败。', 'error');
    }
}

function confirmRevokeMcpLocalAuthorization(type) {
    const config = mcpLocalAuthConfig(type);
    const revoke = async () => {
        const bridge = mcpLocalAuthBridge();
        if (!bridge) return showToast('当前没有可用的本机授权桥。', 'warning');
        try {
            const status = await bridge.revokeLocalAuthorization(type);
            mcpLocalAuthorizationStatusCache = mcpLocalAuthNormalizeStatus(status);
            renderMcpLocalAuthorizationCenter(mcpLocalAuthorizationStatusCache);
            await window.loadMcpWorkbench?.();
            showToast('本机授权已撤销。', 'success');
        } catch (e) {
            showToast(e.message || '撤销本机授权失败。', 'error');
        }
    };
    const message = `${config.revokeTitle}\n\n${config.revokeMessage}`;
    if (globalThis.confirm(message)) revoke();
}

async function openMcpLocalAuthorizationCenter(initialType = 'local_database') {
    const modal = document.getElementById('mcp-local-auth-modal');
    if (!modal) return showToast('本机授权中心未就绪。', 'error');
    mcpLocalAuthorizationActiveType = mcpLocalAuthConfig(initialType).type;
    modal.classList.remove('hidden');
    const closeButton = document.getElementById('mcp-local-auth-close-btn');
    closeButton?.addEventListener('click', closeMcpLocalAuthorizationCenter, { once: true });
    const body = document.getElementById('mcp-local-auth-body');
    if (body) PivotSafeHtml.setHtml(body, '<div class="mcp-empty-panel compact"><strong>正在读取本机授权状态</strong><span>请稍候。</span></div>');
    const status = await getMcpLocalAuthorizationStatus({ refresh: true });
    renderMcpLocalAuthorizationCenter(status);
}

function closeMcpLocalAuthorizationCenter() {
    document.getElementById('mcp-local-auth-modal')?.classList.add('hidden');
}

window.Pivot?.exposeModule?.('mcp.localAuth', {
    getMcpLocalAuthorizationStatus,
    decorateMcpLocalActionCards,
    mcpLocalAuthorizationDescription,
    openMcpLocalAuthorizationCenter,
    closeMcpLocalAuthorizationCenter,
    refreshMcpLocalAuthorizationCenter
}, [
    ['getMcpLocalAuthorizationStatus', 'getMcpLocalAuthorizationStatus'],
    ['decorateMcpLocalActionCards', 'decorateMcpLocalActionCards'],
    ['mcpLocalAuthorizationDescription', 'mcpLocalAuthorizationDescription'],
    ['openMcpLocalAuthorizationCenter', 'openMcpLocalAuthorizationCenter'],
    ['closeMcpLocalAuthorizationCenter', 'closeMcpLocalAuthorizationCenter'],
    ['refreshMcpLocalAuthorizationCenter', 'refreshMcpLocalAuthorizationCenter']
]);
