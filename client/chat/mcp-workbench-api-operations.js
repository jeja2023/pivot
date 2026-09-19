/* MCP 工作台的 OpenAPI 操作导入、展示与停用控制。 */
(function () {
function renderApiOperationCard(operation = {}) {
    const method = String(operation.method || 'GET').toUpperCase();
    const sideEffect = Boolean(operation.side_effect || operation.sideEffect || operation.approval_required);
    return `
        <div class="mcp-system-card mcp-connector-card">
            <div class="mcp-system-card-head">
                <strong>${mcpEscape(operation.title || operation.name || '未命名 API 操作')}</strong>
                <em>${mcpEscape(method)}${sideEffect ? ' · 需审批' : ''}</em>
            </div>
            <p>${mcpEscape(operation.description || '由 OpenAPI 文档导入的受控 HTTP 操作。')}</p>
            <div class="mcp-card-meta">${mcpEscape(`${operation.baseUrl || ''}${operation.pathTemplate || ''}`)}</div>
            <div class="mcp-system-actions">
                <button class="btn-danger-outline" type="button" data-mcp-delete-api-operation="${mcpEscape(operation.apiOperationId || '')}">停用</button>
            </div>
        </div>
    `;
}

function renderPanel(operations = []) {
    return `
        <section class="mcp-section">
            <div class="mcp-section-head">
                <div><strong>API 操作</strong><span>从受支持的 OpenAPI 3 JSON 导入；凭据只引用已有安全凭据。</span></div>
                <button class="btn-secondary" type="button" data-mcp-open-api-import>导入 OpenAPI</button>
            </div>
            <div class="mcp-system-services">
                ${operations.length ? operations.map(renderApiOperationCard).join('') : '<div class="mcp-empty-panel compact"><strong>尚未导入 API 操作</strong><span>可导入企业内部 OpenAPI 3 文档，先在工具库中审核，再加入工作流。</span></div>'}
            </div>
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

function bindPanel(container, reload) {
    container?.querySelectorAll('[data-mcp-open-api-import]').forEach(button => button.addEventListener('click', openModal));
    container?.querySelectorAll('[data-mcp-delete-api-operation]').forEach(button => button.addEventListener('click', () => disableOperation(button.dataset.mcpDeleteApiOperation, reload)));
    bindModal(reload);
}

async function loadAndRender(container, reload) {
    if (!container) return [];
    const response = await apiFetch(`${API_BASE}/agents/api-operations`);
    const data = await response.json().catch(() => ({}));
    const operations = response.ok ? (data.data || []) : [];
    PivotSafeHtml.setHtml(container, renderPanel(operations));
    bindPanel(container, reload);
    return operations;
}

window.Pivot.registerModule('mcp.apiOperations', { bindPanel, loadAndRender, openModal, renderPanel });
})();
