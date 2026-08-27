// 工具库连接与安全凭据管理模块 MCP workbench credentials management module

async function loadMcpCredentials() {
    const box = document.getElementById('mcp-security-credentials');
    if (!box) return [];

    let credentials = [];
    try {
        const credRes = await apiFetch(`${API_BASE}/agents/credentials`);
        const credData = await credRes.json().catch(() => ({}));
        if (credRes.ok && Array.isArray(credData.data)) credentials = credData.data;
    } catch (_err) {
        // 忽略网络或服务异常
    }

    renderMcpCredentialsSection(credentials);
    return credentials;
}

function renderMcpCredentialsSection(credentials = []) {
    const box = document.getElementById('mcp-security-credentials');
    if (!box) return;

    const credentialCards = credentials.map(credential => {
        const isOwner = credential.is_owner === true;
        const hasPrev = isOwner && credential.has_previous_value;
        const scopeText = credential.scope === 'shared' ? '已共享' : '仅自己';
        const useCount = Number(credential.use_count || 0);
        const version = Number(credential.version || 1);
        const dateText = credential.last_used_at ? credential.last_used_at.slice(0, 10) : '';
        const metaText = `版本 v${version} · 已调用 ${useCount} 次${dateText ? ` · 最近使用 ${dateText}` : ''}`;
        return `
            <div class="mcp-system-card mcp-credential-instance-card" data-mcp-credential-id="${mcpEscape(credential.id)}">
                <div class="mcp-system-card-head">
                    <strong>${mcpEscape(credential.name || '未命名凭据')}</strong>
                    <span class="mcp-badge ${credential.scope === 'shared' ? 'is-shared' : ''}">${mcpEscape(scopeText)}</span>
                </div>
                <div class="mcp-card-slug">
                    <code>${mcpEscape(credential.slug || '-')}</code>
                </div>
                <p class="mcp-card-desc">${credential.description ? mcpEscape(credential.description) : '可在工作流 HTTP 节点、Agent 工具和渠道中安全引用'}</p>
                <div class="mcp-card-meta">${mcpEscape(metaText)}</div>
                <div class="mcp-system-actions">
                    ${isOwner ? `
                        <button class="btn-secondary btn-xs" type="button" data-mcp-credential-action="rotate" data-mcp-credential-id="${mcpEscape(credential.id)}">轮换</button>
                        ${hasPrev ? `<button class="btn-secondary btn-xs" type="button" data-mcp-credential-action="revert" data-mcp-credential-id="${mcpEscape(credential.id)}">撤销轮换</button>` : ''}
                        <button class="btn-secondary btn-xs" type="button" data-mcp-credential-action="edit" data-mcp-credential-id="${mcpEscape(credential.id)}">编辑</button>
                        <button class="btn-danger-outline btn-xs" type="button" data-mcp-credential-action="delete" data-mcp-credential-id="${mcpEscape(credential.id)}">删除</button>
                    ` : '<span class="mcp-readonly-hint">共享凭据仅供调用</span>'}
                </div>
            </div>
        `;
    }).join('');

    const credentialActions = `
        <div class="mcp-source-action-zone">
            <div class="mcp-data-management-panel">
                <div class="mcp-data-management-head">
                    <strong>受控安全凭据</strong>
                    <span>${credentials.length} 个可用凭据</span>
                </div>
                <div class="mcp-credential-manage-actions">
                    <button class="btn-primary" type="button" data-mcp-credential-create>
                        <span>新建安全凭据</span>
                    </button>
                    <button class="btn-secondary" type="button" data-mcp-credential-open-drawer>
                        <span>管理凭据抽屉</span>
                    </button>
                </div>
            </div>
        </div>
    `;

    PivotSafeHtml.setHtml(box, renderMcpSection(
        '连接与安全凭据',
        '集中管理供工作流、Agent 工具、通知渠道及自动化回调调用的受控鉴权凭据与 API Key。',
        credentialCards,
        {
            beforeGridHtml: credentialActions,
            emptyText: '还没有创建受控凭据。点击“新建安全凭据”录入 API Key 或 Token，即可在工作流和工具中免密调用。'
        }
    ));

    const openCreds = (opts = {}) => {
        const api = window.Pivot?.moduleApi?.('agent.automationResources');
        if (typeof api?.open === 'function') {
            api.open({ tab: 'credentials', ...opts });
        }
    };

    box.querySelector('[data-mcp-credential-create]')?.addEventListener('click', () => {
        openCreds({ action: 'create' });
    });
    box.querySelector('[data-mcp-credential-open-drawer]')?.addEventListener('click', () => {
        openCreds();
    });
    box.querySelectorAll('[data-mcp-credential-action]').forEach(btn => {
        btn.addEventListener('click', () => {
            const action = btn.dataset.mcpCredentialAction;
            const credId = btn.dataset.mcpCredentialId;
            openCreds({ action, id: credId });
        });
    });
}

window.Pivot?.exposeModule?.('mcp.credentials', {
    load: loadMcpCredentials,
    render: renderMcpCredentialsSection
});
