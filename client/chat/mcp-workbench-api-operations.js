/* MCP 工作台的 OpenAPI 操作导入、展示与停用控制。 */
(function () {
function renderApiOperationCard(operation = {}) {
    const method = String(operation.method || 'GET').toUpperCase();
    const sideEffect = Boolean(operation.side_effect || operation.sideEffect || operation.approval_required);
    const methodClass = `method-${method.toLowerCase()}`;
    const titleText = mcpEscape(operation.title || operation.name || '未命名 API 操作');
    return `
        <div class="mcp-product-card mcp-api-op-card">
            <div class="mcp-product-card-head">
                <div class="mcp-api-op-title-row">
                    <span class="mcp-method-badge ${methodClass}">${mcpEscape(method)}</span>
                    <strong title="${titleText}">${titleText}</strong>
                </div>
                ${sideEffect ? '<em class="risk-medium">需审批</em>' : '<em class="risk-low">免审批</em>'}
            </div>
            <p class="mcp-card-desc">${mcpEscape(operation.description || '由 OpenAPI 文档导入的受控 HTTP 操作。')}</p>
            <div class="mcp-card-meta mcp-endpoint-path">
                <code>${mcpEscape(`${operation.baseUrl || ''}${operation.pathTemplate || ''}`)}</code>
            </div>
            <div class="mcp-product-card-actions">
                <button class="btn-danger-outline btn-xs" type="button" data-mcp-delete-api-operation="${mcpEscape(operation.apiOperationId || '')}">停用</button>
            </div>
        </div>
    `;
}

function renderPanel(operations = []) {
    const hasOps = operations.length > 0;
    return `
        <section class="mcp-product-section mcp-api-operations-section" aria-labelledby="mcp-api-operations-title">
            <div class="mcp-product-section-head">
                <div class="mcp-section-title-wrap">
                    <div class="mcp-section-title-row">
                        <span class="mcp-section-icon mcp-icon-api">
                            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
                        </span>
                        <strong id="mcp-api-operations-title">API 操作 (OpenAPI 3)</strong>
                        <span class="mcp-count-pill">${operations.length} 个操作</span>
                    </div>
                    <span>从 OpenAPI 3 JSON 规范导入受控 HTTP 端点；调用免密鉴权仅引用已有受控安全凭据。</span>
                </div>
                <div class="mcp-section-head-actions">
                    <button class="btn-secondary btn-xs" type="button" data-mcp-open-api-import>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/></svg>
                        <span>导入 OpenAPI</span>
                    </button>
                </div>
            </div>
            ${hasOps ? `
                <div class="mcp-api-operations-grid">
                    ${operations.map(renderApiOperationCard).join('')}
                </div>
            ` : `
                <div class="mcp-empty-state-card">
                    <div class="mcp-empty-state-icon">
                        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                            <polyline points="16 18 22 12 16 6"/>
                            <polyline points="8 6 2 12 8 18"/>
                        </svg>
                    </div>
                    <div class="mcp-empty-state-title">尚未导入任何 API 操作</div>
                    <div class="mcp-empty-state-desc">支持导入企业内部或第三方 OpenAPI 3.0+ JSON 规范文档，解析端点后在工具库中审核，再安全加入工作流。</div>
                    <div class="mcp-empty-state-actions">
                        <button class="btn-secondary btn-xs" type="button" data-mcp-open-api-import>
                            <span>导入首个 OpenAPI 规范</span>
                        </button>
                    </div>
                </div>
            `}
        </section>
    `;
}

function modal() { return document.getElementById('mcp-api-import-modal'); }

function setResult(message = '', type = '') {
    const box = document.getElementById('mcp-api-import-result');
    if (!box) return;
    box.textContent = message;
    box.className = `mcp-diagnostics-panel${type ? ` is-${type}` : ''}`;
}

function closeModal() {
    const target = modal();
    if (!target) return;
    target.classList.add('hidden');
    target.setAttribute('aria-hidden', 'true');
}

function openModal() {
    const target = modal();
    if (!target) return showToast('API 导入界面尚未加载完成。', 'error');
    target.classList.remove('hidden');
    target.setAttribute('aria-hidden', 'false');
    setResult('导入只创建受控操作定义，不会在此步骤访问外部 API。');
    document.getElementById('mcp-api-import-document')?.focus();
}

async function submitImport(reload = () => window.Pivot.legacy.loadMcpWorkbench?.()) {
    const documentText = document.getElementById('mcp-api-import-document')?.value || '';
    const baseUrl = document.getElementById('mcp-api-import-base-url')?.value || '';
    const credentialSlug = document.getElementById('mcp-api-import-credential-slug')?.value || '';
    const credentialHeader = document.getElementById('mcp-api-import-credential-header')?.value || 'Authorization';
    const credentialPrefix = document.getElementById('mcp-api-import-credential-prefix')?.value || 'Bearer ';
    const submit = document.getElementById('mcp-api-import-submit-btn');
    if (!documentText.trim()) return setResult('请粘贴 OpenAPI 3 JSON 文档。', 'error');
    submit?.setAttribute('disabled', 'disabled');
    setResult('正在校验并导入 API 操作…');
    try {
        const response = await apiFetch(`${API_BASE}/agents/api-operations/import-openapi`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ document: documentText, baseUrl, credentialSlug, credentialHeader, credentialPrefix })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || 'API 操作导入失败。');
        setResult(`已导入 ${Number(data.count || 0)} 个 API 操作。`, 'success');
        await reload();
        showToast(`已导入 ${Number(data.count || 0)} 个 API 操作`, 'success');
    } catch (error) {
        setResult(error.message || 'API 操作导入失败。', 'error');
    } finally {
        submit?.removeAttribute('disabled');
    }
}

async function disableOperation(id, reload = () => window.Pivot.legacy.loadMcpWorkbench?.()) {
    const operationId = String(id || '').trim();
    if (!operationId) return;
    window.Pivot.legacy.showConfirm('停用 API 操作', '停用后，工作流无法再选择该 API 操作；已保存工作流会在运行前提示工具不可用。', async () => {
        const response = await apiFetch(`${API_BASE}/agents/api-operations/${encodeURIComponent(operationId)}`, { method: 'DELETE' });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) return showToast(data.error || '停用 API 操作失败。', 'error');
        await reload();
        showToast('API 操作已停用。', 'success');
    });
}

function bindModal(reload) {
    const target = modal();
    if (!target || target.dataset.bound === '1') return;
    target.dataset.bound = '1';
    target.querySelector('#mcp-api-import-close-btn')?.addEventListener('click', closeModal);
    target.querySelector('#mcp-api-import-cancel-btn')?.addEventListener('click', closeModal);
    target.querySelector('#mcp-api-import-submit-btn')?.addEventListener('click', () => submitImport(reload));
    target.addEventListener('click', event => { if (event.target === target) closeModal(); });
}

function operationsModal() {
    return document.getElementById('mcp-api-operations-modal');
}

function openOperationsModal() {
    const target = operationsModal();
    if (!target) return;
    const modalApi = window.Pivot?.moduleApi?.('mcp.modal');
    if (typeof modalApi?.setMcpModalVisibility === 'function') {
        modalApi.setMcpModalVisibility(target, true);
    } else {
        target.classList.remove('hidden');
        target.setAttribute('aria-hidden', 'false');
    }
}

function closeOperationsModal() {
    const target = operationsModal();
    if (!target) return;
    const modalApi = window.Pivot?.moduleApi?.('mcp.modal');
    if (typeof modalApi?.setMcpModalVisibility === 'function') {
        modalApi.setMcpModalVisibility(target, false);
    } else {
        target.classList.add('hidden');
        target.setAttribute('aria-hidden', 'true');
    }
}

function bindOperationsModal(_reload) {
    const target = operationsModal();
    if (!target || target.dataset.bound === '1') return;
    target.dataset.bound = '1';

    target.querySelector('#mcp-operations-modal-close-btn')?.addEventListener('click', closeOperationsModal);
    target.addEventListener('click', event => {
        if (event.target === target) closeOperationsModal();
    });

    document.getElementById('mcp-hub-import-openapi')?.addEventListener('click', (e) => {
        e.stopPropagation();
        openModal();
    });

    document.getElementById('mcp-hub-open-operations-modal')?.addEventListener('click', (e) => {
        e.stopPropagation();
        openOperationsModal();
    });

    document.getElementById('mcp-card-api-operations')?.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        openOperationsModal();
    });
}

function bindPanel(container, reload) {
    container?.querySelectorAll('[data-mcp-open-api-import]').forEach(button => button.addEventListener('click', openModal));
    container?.querySelectorAll('[data-mcp-delete-api-operation]').forEach(button => button.addEventListener('click', () => disableOperation(button.dataset.mcpDeleteApiOperation, reload)));
    bindModal(reload);
    bindOperationsModal(reload);
}

async function loadAndRender(container, reload) {
    const response = await apiFetch(`${API_BASE}/agents/api-operations`);
    const data = await response.json().catch(() => ({}));
    const operations = response.ok ? (data.data || []) : [];

    const metricEl = document.getElementById('mcp-metric-operations');
    if (metricEl) {
        metricEl.textContent = `${operations.length} 个导入端点`;
    }

    bindOperationsModal(reload);

    if (container) {
        PivotSafeHtml.setHtml(container, renderPanel(operations));
        bindPanel(container, reload);
    }
    return operations;
}

window.Pivot.registerModule('mcp.apiOperations', { bindPanel, closeOperationsModal, loadAndRender, openModal, openOperationsModal, renderPanel });
})();

