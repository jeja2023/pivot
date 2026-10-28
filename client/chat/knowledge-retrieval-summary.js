/* 知识库检索模型汇总与全库重建动作：从 rag-documents.js 拆出，通过 Pivot.modules 暴露。 */
/* eslint-disable no-undef */

(function() {
    let summaryLoadSequence = 0;

    async function loadKnowledgeRetrievalModelSummary() {
        const requestId = ++summaryLoadSequence;
        const label = document.querySelector('#knowledge-retrieval-model-summary span');
        if (label) label.textContent = '检索模型服务：正在加载…';
        try {
            const response = await apiFetch(`${API_BASE}/settings`, { headers: authHeaders(), timeoutMs: 30000 });
            const data = await response.json().catch(() => ({}));
            if (!response.ok || data.error) throw new Error(data.error || `HTTP ${response.status}`);
            if (requestId === summaryLoadSequence) {
                window.Pivot.legacy.applyUploadRuntimeLimits?.(data.uploadLimits);
                renderKnowledgeRetrievalModelSummary(data.retrievalModelConfig || data.embeddingConfig, data.rerankConfig);
            }
        } catch (error) {
            if (requestId !== summaryLoadSequence) return;
            console.error('加载检索模型服务失败', error);
            if (label) {
                label.textContent = '检索模型服务：加载失败，请重新打开知识库重试';
                label.title = '';
            }
        }
    }

    function renderKnowledgeRetrievalModelSummary(embeddingConfig = {}, rerankConfig = {}) {
        const target = document.getElementById('knowledge-retrieval-model-summary');
        if (!target) return;
        const label = target.querySelector('span');
        const model = String(embeddingConfig?.model || '').trim() || '未配置';
        const rerank = rerankConfig?.enabled === true
            ? `重排序：${String(rerankConfig.model || '已启用').trim() || '已启用'}`
            : '重排序：本地排序';
        if (label) {
            label.textContent = `检索模型：${model} · ${rerank}`;
            const canView = isSuperAdminUser() || (Boolean(embeddingConfig?.isPersonal) && embeddingConfig?.source?.url === 'user');
            const displayUrl = canView ? (embeddingConfig?.apiUrl || '') : (embeddingConfig?.apiUrl ? '********' : '');
            label.title = displayUrl ? `Embedding：${displayUrl}；${rerank}` : rerank;
        }
        document.getElementById('knowledge-retrieval-model-settings-btn')?.classList.toggle('hidden', !isSuperAdminUser());
    }

    async function openRetrievalModelServices() {
        if (!isSuperAdminUser()) {
            showToast('检索模型服务由 admin 权限层级统一维护', 'info');
            return;
        }
        await window.Pivot.moduleApi('workspaces.navigation').openAdminPanel?.({ restore: false, tab: 'models' });
        window.setTimeout(() => document.querySelector('[data-retrieval-model-config-open="embedding"]')?.focus(), 0);
    }

    async function reindexAllKnowledgeDocs() {
        const user = window.Pivot.legacy.currentUser || {};
        if (String(user.permissionTier || user.role || '').toLowerCase() !== 'admin') return showToast('仅 admin 权限层级可重建全部知识库向量', 'error');
        const confirmed = await ragConfirm('重建全部知识库向量', '将把全部有原文件的知识库文档重新加入后台索引队列。原文、权限与关键词检索不受影响；确认继续？');
        if (!confirmed) return;
        const lockKey = 'system-reindex';
        if (ragActionLocks.has(lockKey)) return;
        ragActionLocks.add(lockKey);
        try {
            const res = await apiFetch(`${API_BASE}/rag/admin/docs/reindex-all`, {
                method: 'POST',
                headers: { ...authHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify({ limit: 2000 })
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || data.error) throw new Error(data.error || '全库重建失败');
            showToast(`已将 ${data.scheduled || 0}/${data.scanned || 0} 个知识库文档加入重建队列${data.truncated ? '；范围超过 2,000 个，请等待本轮完成后再次执行' : ''}`);
            window.Pivot.legacy.loadKnowledgeDocs?.();
        } catch (error) {
            showToast(error.message || '全库重建失败', 'error');
        } finally {
            ragActionLocks.delete(lockKey);
        }
    }

    document.addEventListener('click', event => {
        const btn = event.target?.closest?.('#knowledge-retrieval-model-settings-btn');
        if (!btn) return;
        event.preventDefault();
        void openRetrievalModelServices();
    });

    window.Pivot?.exposeModule?.('knowledge.retrievalSummary', {
        loadKnowledgeRetrievalModelSummary,
        renderKnowledgeRetrievalModelSummary,
        openRetrievalModelServices,
        reindexAllKnowledgeDocs
    });
})();
