/* 工具库产品目录、连接账户与运行治理视图。 */

(function installMcpProductWorkbench() {
    const escape = value => escapeHtml(value === undefined || value === null ? '' : String(value));
    const modalApi = () => window.Pivot?.moduleApi?.('mcp.modal', {}) || {};
    let describedTool = null;

    function empty(message) {
        return `<div class="mcp-product-empty">${escape(message)}</div>`;
    }

    function riskLabel(value) {
        const risk = String(value || 'low');
        return risk === 'critical' ? '严重风险' : risk === 'high' ? '高风险' : risk === 'medium' ? '中风险' : '低风险';
    }

    function renderCatalog(items = []) {
        if (!items.length) return empty('暂无匹配的已授权工具。可修改关键词，或在下方添加工具服务。');
        return items.slice(0, 100).map(item => {
            const ref = item.toolRef || {};
            const toolName = item.name || ref.toolName || '';
            const capabilities = Array.isArray(item.capabilities) ? item.capabilities.slice(0, 3) : [];
            return `
                <article class="mcp-product-card">
                    <div class="mcp-product-card-head">
                        <strong>${escape(item.title || toolName)}</strong>
                        <em class="risk-${escape(item.riskLevel || 'low')}">${escape(riskLabel(item.riskLevel))}</em>
                    </div>
                    <p>${escape(item.description || '暂无工具说明。')}</p>
                    <div class="mcp-product-badges">
                        ${item.source ? `<span>${escape(item.source === 'mcp' ? '工具服务' : item.source === 'builtin' ? '系统工具' : 'API 操作')}</span>` : ''}
                        ${item.serverName ? `<span>${escape(item.serverName)}</span>` : ''}
                        ${item.requiresConnection ? '<span>需连接</span>' : ''}
                        ${item.requiresApproval || item.approvalRequired ? '<span>需审批</span>' : ''}
                        ${capabilities.map(capability => `<span>${escape(capability)}</span>`).join('')}
                    </div>
                    <div class="mcp-product-card-actions">
                        <button class="btn-secondary" type="button" data-mcp-product-describe="${escape(toolName)}" data-mcp-product-release="${escape(ref.releaseId || '')}" data-mcp-product-digest="${escape(ref.definitionDigest || '')}">查看契约</button>
                    </div>
                </article>
            `;
        }).join('');
    }

    async function loadCatalog(queryText = '') {
        const box = document.getElementById('mcp-product-catalog');
        if (!box) return;
        const query = String(queryText || '').trim();
        const response = query
            ? await apiFetch(`${API_BASE}/tools/search`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query, limit: 12 }) })
            : await apiFetch(`${API_BASE}/tools/catalog?limit=100`);
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || (query ? '工具搜索失败' : '工具目录加载失败'));
        PivotSafeHtml.setHtml(box, renderCatalog(data.data || []));
    }

    function renderConnectionAccounts(items = []) {
        if (!items.length) return empty('尚无已登记连接账户。配置或刷新工具服务后，会在此处显示连接状态。');
        return items.map(item => {
            const scopes = Array.isArray(item.scopes) ? item.scopes.slice(0, 4) : [];
            const state = String(item.auth_state || 'unconnected');
            const stateLabel = { active: '已连接', unconnected: '未连接', authorizing: '授权中', expiring: '即将过期', refresh_failed: '刷新失败', disabled: '已停用', revoked: '已撤销' }[state] || state;
            return `
                <article class="mcp-product-card mcp-connection-card">
                    <div class="mcp-product-card-head"><strong>${escape(item.display_name || item.connector_name || '连接账户')}</strong><em class="connection-${escape(state)}">${escape(stateLabel)}</em></div>
                    <p>${escape(item.connector_name || item.connector_slug || '工具连接')} · ${escape(item.ownership_scope === 'service' ? '服务账号' : item.ownership_scope === 'unit' ? '单位共享' : '个人连接')}</p>
                    <div class="mcp-product-badges">
                        ${scopes.length ? scopes.map(scope => `<span>${escape(scope)}</span>`).join('') : '<span>未授予额外范围</span>'}
                        ${item.expires_at ? `<span>到期：${escape(String(item.expires_at))}</span>` : ''}
                    </div>
                    ${item.last_error ? `<small class="mcp-product-error">${escape(item.last_error)}</small>` : ''}
                    <div class="mcp-product-card-actions">
                        <button class="btn-secondary" type="button" data-mcp-connection-action="${escape(item.auth_type === 'oauth2' ? 'authorize' : 'refresh')}" data-mcp-connection-id="${escape(item.id)}">${escape(item.auth_type === 'oauth2' ? (state === 'active' ? '重新授权' : '完成授权') : '刷新状态')}</button>
                        <button class="btn-secondary" type="button" data-mcp-connection-action="test" data-mcp-connection-id="${escape(item.id)}">测试连接</button>
                        ${state !== 'revoked' ? `<button class="btn-secondary" type="button" data-mcp-connection-action="revoke" data-mcp-connection-id="${escape(item.id)}">撤销</button>` : ''}
                    </div>
                </article>
            `;
        }).join('');
    }

    async function loadConnectionAccounts() {
        const box = document.getElementById('mcp-connection-accounts');
        if (!box) return;
        const response = await apiFetch(`${API_BASE}/connection-accounts?includeInactive=true`);
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || '连接账户加载失败');
        PivotSafeHtml.setHtml(box, renderConnectionAccounts(data.data || []));
    }

    function renderOperationSummary(summary = {}) {
        const total = Number(summary.total || 0);
        const rate = Number(summary.successRate || 0) * 100;
        return `<span><b>${escape(total)}</b> 调用</span><span><b>${escape(rate.toFixed(1))}%</b> 成功率</span><span><b>${escape(Math.round(Number(summary.p50_ms || 0)))}</b>ms P50</span><span><b>${escape(Math.round(Number(summary.p95_ms || 0)))}</b>ms P95</span><span><b>${escape(Number(summary.approval_count || 0))}</b> 等待审批</span>`;
    }

    function renderOperations(items = []) {
        if (!items.length) return empty('暂无新的工具运行记录。');
        return items.map(item => `
            <article class="mcp-operation-row">
                <div><strong>${escape(item.tool_name || '工具')}</strong><span>${escape(item.source || 'unknown')} · ${escape(item.policy_decision || 'allow')}</span></div>
                <div><em class="status-${escape(item.status || 'unknown')}">${escape(item.status || 'unknown')}</em><span>${escape(Number(item.total_ms || 0))}ms</span></div>
                ${item.error_code || item.error_class ? `<small>${escape(item.error_code || item.error_class)}</small>` : ''}
            </article>
        `).join('');
    }

    async function loadOperations() {
        const summaryBox = document.getElementById('mcp-tool-operations-summary');
        const listBox = document.getElementById('mcp-tool-operations');
        if (!summaryBox && !listBox) return;
        const [summaryResponse, operationsResponse] = await Promise.all([apiFetch(`${API_BASE}/tools/operations/summary`), apiFetch(`${API_BASE}/tools/operations?limit=80`)]);
        const summary = await summaryResponse.json().catch(() => ({}));
        const operations = await operationsResponse.json().catch(() => ({}));
        if (!summaryResponse.ok || !operationsResponse.ok) throw new Error(summary.error || operations.error || '工具运行记录加载失败');
        if (summaryBox) PivotSafeHtml.setHtml(summaryBox, renderOperationSummary(summary.data || {}));
        if (listBox) PivotSafeHtml.setHtml(listBox, renderOperations(operations.data || []));
    }

    async function describeTool(button) {
        const name = button?.dataset?.mcpProductDescribe;
        if (!name) return;
        const response = await apiFetch(`${API_BASE}/tools/describe`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ toolRef: { toolName: name, releaseId: Number(button.dataset.mcpProductRelease) || null, definitionDigest: button.dataset.mcpProductDigest || '' } })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || '工具契约读取失败');
        const detail = data.data || {};
        describedTool = detail.toolRef && detail.name ? detail : null;
        const message = `${detail.title || detail.name}\n\n${detail.description || ''}\n\n输入契约：\n${JSON.stringify(detail.inputSchema || {}, null, 2)}\n\n输出契约：\n${JSON.stringify(detail.outputSchema || {}, null, 2)}`;
        const modal = document.getElementById('mcp-product-detail-modal');
        const title = document.getElementById('mcp-product-detail-title');
        const subtitle = document.getElementById('mcp-product-detail-subtitle');
        const content = document.getElementById('mcp-product-detail-content');
        if (!modal || !content) return showToast(`${detail.title || detail.name}：已加载完整工具契约`, 'success');
        if (title) title.textContent = detail.title || detail.name || '工具契约';
        if (subtitle) subtitle.textContent = `${detail.name || ''} · 风险：${riskLabel(detail.riskLevel)}${detail.requiresApproval ? ' · 调用前需审批' : ''}`;
        content.textContent = message;
        const input = document.getElementById('mcp-product-execute-input');
        const execute = document.getElementById('mcp-product-execute-btn');
        if (input) input.value = '{}';
        if (execute) execute.disabled = !describedTool;
        modalApi().setMcpModalVisibility?.(modal, true, { focusSelector: '[data-mcp-product-detail-close]' });
    }

    async function executeDescribedTool(button) {
        if (!describedTool?.toolRef || !describedTool?.name) throw new Error('请先从搜索结果中查看工具契约。');
        const rawInput = String(document.getElementById('mcp-product-execute-input')?.value || '{}').trim() || '{}';
        let input;
        try { input = JSON.parse(rawInput); } catch (_) { throw new Error('执行输入必须是合法 JSON 对象。'); }
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('执行输入必须是 JSON 对象。');
        button.disabled = true;
        try {
            const response = await apiFetch(`${API_BASE}/tools/invoke`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ toolRef: describedTool.toolRef, input })
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(data.error || '工具执行失败');
            showToast('工具已执行；可在“运行与治理”查看策略与调用记录。', 'success');
            await loadOperations();
            return data.result;
        } finally { button.disabled = false; }
    }

    async function changeConnectionAccount(button) {
        const id = button?.dataset?.mcpConnectionId;
        const action = button?.dataset?.mcpConnectionAction;
        if (!id || !action) return;
        button.disabled = true;
        try {
            if (action === 'authorize') {
                const response = await apiFetch(`${API_BASE}/connection-accounts/${encodeURIComponent(id)}/authorize`, { method: 'POST' });
                const data = await response.json().catch(() => ({}));
                const authorizationUrl = String(data?.data?.authorizationUrl || '');
                if (!response.ok || !authorizationUrl) throw new Error(data.error || '无法发起 OAuth 授权');
                // Keep the signed-in browser session for the callback, then let
                // the provider complete the Authorization Code + PKCE exchange.
                window.location.assign(authorizationUrl);
                return;
            }
            const response = await apiFetch(`${API_BASE}/connection-accounts/${encodeURIComponent(id)}/${encodeURIComponent(action)}`, { method: 'POST' });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(data.error || '连接账户操作失败');
            if (action === 'test') {
                const count = data?.data?.toolCount;
                showToast(count === null || count === undefined ? '连接授权有效' : `连接成功，可访问 ${count} 个工具`, 'success');
            } else {
                showToast(action === 'revoke' ? '连接授权已撤销' : '连接状态已刷新', 'success');
            }
            await loadConnectionAccounts();
        } finally {
            button.disabled = false;
        }
    }

    window.Pivot?.exposeModule?.('mcp.product', { changeConnectionAccount, describeTool, executeDescribedTool, loadCatalog, loadConnectionAccounts, loadOperations });
}());
