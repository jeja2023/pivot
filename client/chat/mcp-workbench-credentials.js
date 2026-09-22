function openCredentialsDrawer(opts = {}) {
    const api = window.Pivot?.moduleApi?.('agent.automationResources');
    if (typeof api?.open === 'function') {
        api.open({ tab: 'credentials', ...opts });
    } else {
        showToast('受控凭据管理尚未就绪，请刷新页面后重试', 'error');
    }
}

function bindCredentialsHubActions() {
    const hubCard = document.getElementById('mcp-card-security-credentials');
    if (!hubCard || hubCard.dataset.bound === '1') return;
    hubCard.dataset.bound = '1';

    document.getElementById('mcp-hub-create-credential')?.addEventListener('click', (e) => {
        e.stopPropagation();
        openCredentialsDrawer({ action: 'create' });
    });

    document.getElementById('mcp-hub-open-credentials-drawer')?.addEventListener('click', (e) => {
        e.stopPropagation();
        openCredentialsDrawer();
    });

    hubCard.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        openCredentialsDrawer();
    });
}

async function loadMcpCredentials() {
    let credentials = [];
    try {
        const credRes = await apiFetch(`${API_BASE}/agents/credentials`);
        const credData = await credRes.json().catch(() => ({}));
        if (credRes.ok && Array.isArray(credData.data)) credentials = credData.data;
    } catch (_err) {
        // 忽略网络或服务异常
    }

    const metricEl = document.getElementById('mcp-metric-credentials');
    if (metricEl) {
        metricEl.textContent = `${credentials.length} 个可用凭据`;
    }

    bindCredentialsHubActions();

    const box = document.getElementById('mcp-security-credentials');
    if (box && !box.classList.contains('hidden')) {
        renderMcpCredentialsSection(credentials);
    }
    return credentials;
}

function renderMcpCredentialsSection(credentials = []) {
    const box = document.getElementById('mcp-security-credentials');
    if (!box) return;

    const hasCreds = credentials.length > 0;
    const credentialCards = credentials.map(credential => {
        const isOwner = credential.is_owner === true;
        const hasPrev = isOwner && credential.has_previous_value;
        const scopeText = credential.scope === 'shared' ? '已共享' : '仅自己';
        const useCount = Number(credential.use_count || 0);
        const version = Number(credential.version || 1);
        const dateText = credential.last_used_at ? credential.last_used_at.slice(0, 10) : '';
        const metaText = `版本 v${version} · 已调用 ${useCount} 次${dateText ? ` · 最近使用 ${dateText}` : ''}`;
        const credName = mcpEscape(credential.name || '未命名凭据');
        return `
            <div class="mcp-product-card mcp-credential-instance-card" data-mcp-credential-id="${mcpEscape(credential.id)}">
                <div class="mcp-product-card-head">
                    <div class="mcp-credential-title-row">
                        <span class="mcp-credential-icon">
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                        </span>
                        <strong title="${credName}">${credName}</strong>
                    </div>
                    <span class="mcp-scope-badge ${credential.scope === 'shared' ? 'is-shared' : ''}">${mcpEscape(scopeText)}</span>
                </div>
                <div class="mcp-card-slug">
                    <code>${mcpEscape(credential.slug || '-')}</code>
                </div>
                <p class="mcp-card-desc">${credential.description ? mcpEscape(credential.description) : '可在工作流 HTTP 节点、Agent 工具和渠道中安全免密引用。'}</p>
                <div class="mcp-card-meta">${mcpEscape(metaText)}</div>
                <div class="mcp-product-card-actions">
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

    const html = `
        <section class="mcp-product-section mcp-credentials-section" aria-labelledby="mcp-credentials-title">
            <div class="mcp-product-section-head">
                <div class="mcp-section-title-wrap">
                    <div class="mcp-section-title-row">
                        <span class="mcp-section-icon mcp-icon-credentials">
                            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                        </span>
                        <strong id="mcp-credentials-title">受控安全凭据</strong>
                        <span class="mcp-count-pill">${credentials.length} 个可用凭据</span>
                    </div>
                    <span>集中管理供工作流、Agent 工具、通知渠道及自动化调用的鉴权密钥；支持作用域隔离、版本轮换与调用追溯。</span>
                </div>
                <div class="mcp-section-head-actions">
                    <button class="btn-primary btn-xs" type="button" data-mcp-credential-create>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                        <span>新建安全凭据</span>
                    </button>
                    <button class="btn-secondary btn-xs" type="button" data-mcp-credential-open-drawer>
                        <span>管理凭据抽屉</span>
                    </button>
                </div>
            </div>
            ${hasCreds ? `
                <div class="mcp-credentials-grid">
                    ${credentialCards}
                </div>
            ` : `
                <div class="mcp-empty-state-card">
                    <div class="mcp-empty-state-icon">
                        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                            <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                            <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
                        </svg>
                    </div>
                    <div class="mcp-empty-state-title">尚未创建受控安全凭据</div>
                    <div class="mcp-empty-state-desc">点击“新建安全凭据”录入 API Key、Bearer Token 或鉴权密标，即可在工作流 HTTP 节点和 Agent 工具中免密引用。</div>
                    <div class="mcp-empty-state-actions">
                        <button class="btn-primary btn-xs" type="button" data-mcp-credential-create>
                            <span>新建首个安全凭据</span>
                        </button>
                    </div>
                </div>
            `}
        </section>
    `;

    PivotSafeHtml.setHtml(box, html);

    const openCreds = (opts = {}) => {
        const api = window.Pivot?.moduleApi?.('agent.automationResources');
        if (typeof api?.open === 'function') {
            api.open({ tab: 'credentials', ...opts });
        } else {
            showToast('受控凭据管理尚未就绪，请刷新页面后重试', 'error');
        }
    };

    box.querySelectorAll('[data-mcp-credential-create]').forEach(btn => {
        btn.addEventListener('click', () => openCreds({ action: 'create' }));
    });
    box.querySelectorAll('[data-mcp-credential-open-drawer]').forEach(btn => {
        btn.addEventListener('click', () => openCreds());
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
    openDrawer: openCredentialsDrawer,
    render: renderMcpCredentialsSection
});
