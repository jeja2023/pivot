// RAG 文档列表与操作 RAG document list and actions
// RAG 文档功能从 rag.js 拆分而来。
/* eslint-disable no-undef */
function renderRagDocsPagination(total, page, limit) {
    window.renderWorkspacePagination?.('pagination-ragDocs', {
        total,
        page,
        limit,
        onPageChange: targetPage => window.loadKnowledgeDocs(targetPage)
    });
}

function getRagDocDisplayName(name = '') {
    return String(name || '')
        .replace(/\.[^.]+$/, '')
        .trim()
        .slice(0, 24);
}

function updateRagDebugSamples(docs = []) {
    const buttons = Array.from(document.querySelectorAll('[data-rag-debug-sample]'));
    if (!buttons.length) return;
    const readyDoc = docs.find(doc => doc.status === 'ready') || docs[0] || null;
    const docName = getRagDocDisplayName(readyDoc?.name);
    const samples = docName ? [
        { label: `总结《${docName}》`, query: `请总结《${docName}》的主要内容。` },
        { label: '查流程规则', query: `《${docName}》里有哪些流程、规则或注意事项？` },
        { label: '找命中分块', query: `哪些分块可以回答用户关于《${docName}》的常见问题？` }
    ] : [
        { label: '总结文档', query: '请总结已上传文档的主要内容。' },
        { label: '查流程规则', query: '文档里有哪些流程、规则或注意事项？' },
        { label: '找命中分块', query: '哪些分块可以回答用户常见问题？' }
    ];
    buttons.forEach((button, index) => {
        const sample = samples[index] || samples[0];
        button.textContent = sample.label;
        button.dataset.ragDebugSample = sample.query;
    });
}

window.loadKnowledgeDocs = async (page = ragDocsPage) => {
    try {
        ragDocsPage = Math.max(Number(page) || 1, 1);
        const [res, summaryRes, qualityRes, graphSummaryRes] = await Promise.all([
            apiFetch(`${API_BASE}/rag/docs?page=${ragDocsPage}&limit=${RAG_DOCS_PAGE_SIZE}`, { headers: authHeaders() }),
            apiFetch(`${API_BASE}/rag/summary`, { headers: authHeaders() }),
            apiFetch(`${API_BASE}/rag/quality-report`, { headers: authHeaders() }),
            apiFetch(`${API_BASE}/rag/graph/summary`, { headers: authHeaders() })
        ]);
        const payload = await res.json();
        const docs = Array.isArray(payload) ? payload : (payload.data || []);
        const total = Array.isArray(payload) ? docs.length : Number(payload.total || docs.length);
        const pageSize = Array.isArray(payload) ? RAG_DOCS_PAGE_SIZE : Number(payload.limit || RAG_DOCS_PAGE_SIZE);
        const pageNo = Array.isArray(payload) ? ragDocsPage : Number(payload.page || ragDocsPage);
        const summary = await summaryRes.json().catch(() => null);
        const quality = await qualityRes.json().catch(() => null);
        const graphSummary = await graphSummaryRes.json().catch(() => null);
        renderRagSummary(summary, quality, graphSummary);
        renderRagQualityReport(quality);
        updateRagDebugSamples(docs);
        
        const body = document.getElementById('rag-docs-body');
        body.innerHTML = docs.map((d, index) => `
            <tr>
                <td class="text-center"><input type="checkbox" class="rag-doc-check" value="${d.id}"></td>
                <td class="text-center">${(pageNo - 1) * pageSize + index + 1}</td>
                <td title="${escapeRagHtml(d.name)}">${escapeRagHtml(d.name)}</td>
                <td class="text-center">
                    <span class="status-badge ${escapeRagHtml(d.status)}" title="${escapeRagHtml(d.error_message || '')}">${getRagStatusLabel(d.status)}</span>
                </td>
                <td class="text-center">
                    <input type="checkbox" class="rag-enable-toggle" data-rag-id="${d.id}" ${Number(d.is_enabled ?? 1) === 1 ? 'checked' : ''}>
                </td>
                <td class="text-center">${Number(d.chunk_count || 0)}</td>
                <td class="text-center">${Number(d.progress || (d.status === 'ready' ? 100 : 0))}%</td>
                <td>${escapeRagHtml(formatRagDateToCN(d.created_at))}</td>
                <td>${escapeRagHtml(formatRagDateToCN(d.updated_at || d.processed_at))}</td>
                <td class="text-center">
                    <div class="rag-actions">${renderRagActions(d)}</div>
                </td>
            </tr>
        `).join('') || '<tr><td colspan="10" class="text-center">暂无知识库文档</td></tr>';
        renderRagDocsPagination(total, pageNo, pageSize);
        scheduleRagStatusRefresh(docs);
    } catch (e) {
        console.error('加载知识库失败', e);
    }
};

window.openKnowledgeWorkbench = async function() {
    window.showMainWorkspace?.('knowledge');
    const panel = document.getElementById('knowledge-workbench-modal');
    if (!panel) return;
    try {
        await window.ensureAdminSettingsScript?.();
    } catch (e) {
        console.error('加载知识库配置脚本失败', e);
        showToast('知识库配置脚本加载失败，请刷新页面后重试', 'error');
    }
    ensureKnowledgeUploadModal();
    panel.querySelectorAll('.admin-only').forEach(el => {
        el.classList.toggle('hidden', !isAdminUser());
    });
    panel.querySelectorAll('.admin-root-only').forEach(el => {
        el.classList.toggle('hidden', !isSuperAdminUser());
    });
    window.bindEmbeddingModalEvents?.();
    window.bindRagDebugModalEvents?.();
    await window.loadSettings?.();
    await window.loadKnowledgeDocs?.();
    const restoreGraphDocId = getKnowledgeGraphRestoreDocId();
    if (restoreGraphDocId !== null) {
        await window.openKnowledgeGraph?.(restoreGraphDocId || null);
    }
};

window.closeKnowledgeWorkbench = function() {
    closeKnowledgeGraphModal();
    window.showMainWorkspace?.('chat');
};

function ensureKnowledgeUploadModal() {
    let modal = document.getElementById('knowledge-upload-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'knowledge-upload-modal';
        modal.className = 'modal-overlay hidden rag-detail-modal-overlay knowledge-upload-modal-overlay';
        modal.innerHTML = `
            <div class="modal rag-detail-modal knowledge-upload-modal">
                <div class="rag-detail-header">
                    <div>
                        <h3>上传文档</h3>
                        <p class="model-modal-desc">拖拽文件到下方区域，或点击区域选择文件。上传后系统会自动索引文档内容。</p>
                    </div>
                    <button type="button" id="knowledge-upload-close-btn" class="btn-danger-outline">关闭</button>
                </div>
                <button id="knowledge-upload-zone" class="knowledge-upload-zone" type="button">
                    <strong>拖拽文件到这里，或点击选择文件</strong>
                    <span>支持 PDF、Word、Excel、CSV、Markdown、网页文本。</span>
                </button>
            </div>
        `;
        document.body.appendChild(modal);
        modal.addEventListener('click', (event) => {
            if (event.target === modal || event.target.closest('#knowledge-upload-close-btn')) {
                window.closeKnowledgeUploadModal?.();
            }
        });
    }
    bindKnowledgeUploadZone(modal);
    return modal;
}

window.openKnowledgeUploadModal = function() {
    ensureKnowledgeUploadModal().classList.remove('hidden');
};

window.closeKnowledgeUploadModal = function() {
    const modal = document.getElementById('knowledge-upload-modal');
    modal?.classList.add('hidden');
};

function bindKnowledgeUploadZone(root = document) {
    const uploadZone = root.querySelector?.('#knowledge-upload-zone') || document.getElementById('knowledge-upload-zone');
    if (!uploadZone || uploadZone.dataset.boundKnowledgeDrop === '1') return;
    uploadZone.dataset.boundKnowledgeDrop = '1';
    uploadZone.addEventListener('click', () => document.getElementById('rag-upload-input')?.click());
    ['dragenter', 'dragover'].forEach(eventName => {
        uploadZone.addEventListener(eventName, event => {
            event.preventDefault();
            uploadZone.classList.add('is-dragging');
        });
    });
    ['dragleave', 'drop'].forEach(eventName => {
        uploadZone.addEventListener(eventName, event => {
            event.preventDefault();
            uploadZone.classList.remove('is-dragging');
        });
    });
    uploadZone.addEventListener('drop', event => {
        const file = event.dataTransfer?.files?.[0];
        if (!file) return;
        window.uploadKnowledgeDoc(file);
    });
}

const getSelectedRagDocIds = () => Array.from(document.querySelectorAll('.rag-doc-check:checked'))
    .map(input => Number(input.value))
    .filter(Boolean);

window.batchReindexKnowledgeDocs = async () => {
    const docIds = getSelectedRagDocIds();
    if (docIds.length === 0) return showToast('请选择文档', 'error');
    try {
        const res = await apiFetch(`${API_BASE}/rag/docs/batch-reindex`, {
            method: 'POST',
            headers: { ...authHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ docIds })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.error) throw new Error(data.error || '批量重建失败');
        showToast(`已加入 ${data.scheduled || 0} 个重建任务`);
        window.loadKnowledgeDocs();
    } catch (e) {
        showToast(e.message || '批量重建失败', 'error');
    }
};

window.batchDeleteKnowledgeDocs = async () => {
    const docIds = getSelectedRagDocIds();
    if (docIds.length === 0) return showToast('请选择文档', 'error');
    const confirmed = await ragConfirm('批量删除知识库文档', `确定删除选中的 ${docIds.length} 个知识库文档吗？大模型将不再参考这些文档。`);
    if (!confirmed) return;
    try {
        const res = await apiFetch(`${API_BASE}/rag/docs/batch-delete`, {
            method: 'POST',
            headers: { ...authHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ docIds })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.error) throw new Error(data.error || '批量删除失败');
        showToast(`已删除 ${data.deleted || 0} 个文档`);
        window.loadKnowledgeDocs();
    } catch (e) {
        showToast(e.message || '批量删除失败', 'error');
    }
};

window.toggleKnowledgeDocEnabled = async (id, enabled) => {
    try {
        const res = await apiFetch(`${API_BASE}/rag/docs/${id}/enabled`, {
            method: 'PUT',
            headers: { ...authHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.error) throw new Error(data.error || '启停失败');
        showToast(enabled ? '文档已启用' : '文档已停用');
        window.loadKnowledgeDocs();
    } catch (e) {
        showToast(e.message || '启停失败', 'error');
    }
};

window.showKnowledgeDocDetail = async (id) => {
    try {
        const res = await apiFetch(`${API_BASE}/rag/docs/${id}?limit=50`, { headers: authHeaders() });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.error) throw new Error(data.error || '详情加载失败');
        showRagDetailModal(data);
    } catch (e) {
        showToast(e.message || '详情加载失败', 'error');
    }
};

window.sendRagFeedback = async (button) => {
    try {
        const res = await apiFetch(`${API_BASE}/rag/feedback`, {
            method: 'POST',
            headers: { ...authHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({
                query: button.dataset.query,
                chunkId: button.dataset.chunkId,
                docName: button.dataset.docName,
                score: button.dataset.score,
                helpful: button.dataset.helpful === 'true'
            })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.error) throw new Error(data.error || '反馈失败');
        showToast('反馈已记录');
    } catch (e) {
        showToast(e.message || '反馈失败', 'error');
    }
};

window.debugRagQuery = async () => {
    const input = document.getElementById('rag-debug-query');
    const button = document.getElementById('rag-debug-btn');
    const results = document.getElementById('rag-debug-results');
    if (button?.disabled) return;
    const query = input?.value?.trim();
    if (!query) {
        showToast('请输入要测试的问题', 'error');
        return;
    }

    const originalText = button?.textContent || '开始测试';
    try {
        if (button) {
            button.disabled = true;
            button.textContent = '测试中...';
            button.setAttribute('aria-busy', 'true');
        }
        if (results) {
            results.innerHTML = `
                <div class="rag-debug-loading">
                    <span class="rag-debug-spinner"></span>
                    <strong>正在测试召回效果</strong>
                    <small>正在检索知识库分块，请稍候</small>
                </div>
            `;
        }
        const res = await apiFetch(`${API_BASE}/rag/debug-query`, {
            method: 'POST',
            headers: {
                ...authHeaders(),
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                query,
                scoreThreshold: document.getElementById('rag-debug-score-threshold')?.value,
                topK: document.getElementById('rag-debug-top-k')?.value,
                candidateLimit: document.getElementById('rag-debug-candidate-limit')?.value
            })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.error) throw new Error(data.error || '检索测试失败');
        renderRagDebugResults(data);
    } catch (e) {
        showToast(e.message || '检索测试失败', 'error');
        if (results) {
            results.innerHTML = `<div class="rag-debug-empty">检索测试失败，请调整问题或稍后重试</div>`;
        }
    } finally {
        if (button) {
            button.disabled = false;
            button.textContent = originalText;
            button.removeAttribute('aria-busy');
        }
    }
};

window.retryFailedKnowledgeDocs = async () => {
    try {
        const res = await apiFetch(`${API_BASE}/rag/docs/retry-failed`, {
            method: 'POST',
            headers: authHeaders()
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.error) throw new Error(data.error || '批量重试失败');
        showToast(`已加入 ${data.scheduled || 0} 个重新索引任务`);
        window.loadKnowledgeDocs();
    } catch (e) {
        showToast(e.message || '批量重试失败', 'error');
    }
};

window.uploadKnowledgeDoc = async (selectedFile = null) => {
    const fileInput = document.getElementById('rag-upload-input');
    const file = selectedFile || fileInput?.files?.[0];
    if (!file) return;
    
    const formData = new FormData();
    formData.append('file', file);

    showToast('正在上传并向量化文档，请稍候...', 'info');
    if (fileInput) fileInput.value = ''; // 重置 input

    try {
        const res = await apiFetch(`${API_BASE}/rag/upload`, {
            method: 'POST',
            headers: authHeaders(),
            body: formData
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        
        showToast(data.message || '文档已加入后台索引队列');
        window.closeKnowledgeUploadModal?.();
        window.loadKnowledgeDocs();
    } catch (e) {
        showToast(e.message || '文档上传失败', 'error');
    }
};

window.reindexKnowledgeDoc = async (id) => {
    try {
        const res = await apiFetch(`${API_BASE}/rag/docs/${id}/reindex`, {
            method: 'POST',
            headers: authHeaders()
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.error) throw new Error(data.error || '重新索引失败');
        showToast(data.message || '已加入重新索引队列');
        window.loadKnowledgeDocs();
    } catch (e) {
        showToast(e.message || '重新索引失败', 'error');
    }
};

window.deleteKnowledgeDoc = async (id) => {
    const confirmed = await ragConfirm('删除知识库文档', '确定要从知识库中移除该文档吗？大模型将不再参考此文档。');
    if (!confirmed) return;
    
    try {
        const res = await apiFetch(`${API_BASE}/rag/docs/${id}`, {
            method: 'DELETE',
            headers: authHeaders()
        });
        if (res.ok) {
            showToast('文档已移除');
            window.loadKnowledgeDocs();
        }
    } catch (e) {
        showToast('删除失败', 'error');
    }
};
