async function loadSettings() {
    try {
        const res = await apiFetch(`${API_BASE}/settings`);
        if (!res.ok) throw new Error('系统设置加载失败');
        const data = await res.json();
        const scoreInput = document.getElementById('setting-rag-score-threshold');
        const topKInput = document.getElementById('setting-rag-top-k');
        const candidateInput = document.getElementById('setting-rag-candidate-limit');
        const chunkSizeInput = document.getElementById('setting-rag-chunk-size');
        const chunkOverlapInput = document.getElementById('setting-rag-chunk-overlap');
        const memoryThresholdInput = document.getElementById('setting-memory-threshold');
        if (scoreInput) scoreInput.value = data.ragConfig?.scoreThreshold ?? 0.4;
        if (topKInput) topKInput.value = data.ragConfig?.topK ?? 3;
        if (candidateInput) candidateInput.value = data.ragConfig?.candidateLimit ?? 300;
        if (chunkSizeInput) chunkSizeInput.value = data.ragConfig?.chunkSize ?? 500;
        if (chunkOverlapInput) chunkOverlapInput.value = data.ragConfig?.chunkOverlap ?? 100;
        if (memoryThresholdInput) memoryThresholdInput.value = formatTokenInputValue(data.memoryConfig?.thresholdTokens || 12000);
        updateApiAccessState(data.apiAccessEnabled === true);
        updateEmbeddingSettingsForm(data.embeddingConfig);
    } catch (e) {
        showToast(e.message || '系统设置加载失败', 'error');
    }
}

function updateApiAccessState(enabled) {
    const isEnabled = enabled === true;
    window.apiAccessEnabled = isEnabled;
    const toggle = document.getElementById('api-access-toggle');
    const badge = document.getElementById('api-access-status-badge');
    const hint = document.getElementById('api-access-disabled-hint');
    const createBtn = document.getElementById('create-key-btn');
    const guide = document.getElementById('api-access-guide');
    if (toggle) toggle.checked = isEnabled;
    if (badge) {
        badge.textContent = isEnabled ? '已开启' : '已关闭';
        badge.classList.toggle('is-off', !isEnabled);
    }
    if (hint) hint.classList.toggle('hidden', isEnabled);
    if (createBtn) {
        createBtn.disabled = !isEnabled;
        createBtn.title = isEnabled ? '' : 'API 接入已关闭，暂不能新建密钥';
    }
    if (guide) guide.classList.toggle('is-disabled', !isEnabled);
}

window.updateApiAccessState = updateApiAccessState;

window.updateApiAccessSetting = async function() {
    if (!isSuperAdminUser()) return;
    const toggle = document.getElementById('api-access-toggle');
    if (!toggle) return;
    const enabled = toggle.checked === true;
    toggle.disabled = true;
    try {
        const res = await apiFetch(`${API_BASE}/admin/settings`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ api_access_enabled: enabled })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'API 接入设置保存失败');
        updateApiAccessState(data.apiAccessEnabled === true);
        window.loadApiKeys?.();
        showToast(data.apiAccessEnabled ? 'API 接入已开启' : 'API 接入已关闭');
    } catch (e) {
        updateApiAccessState(!enabled);
        showToast(e.message || 'API 接入设置保存失败', 'error');
    } finally {
        toggle.disabled = false;
    }
};

function getEmbeddingModelValue() {
    const embeddingModelInput = document.getElementById('setting-rag-embedding-model');
    const embeddingModelSelect = document.getElementById('setting-rag-embedding-model-select');
    return (embeddingModelInput?.value.trim() || embeddingModelSelect?.value.trim() || '');
}

window.saveMemorySettings = async () => {
    const input = document.getElementById('setting-memory-threshold');
    const saveBtn = document.getElementById('memory-threshold-save-btn');
    if (!input) return;
    const threshold = parseTokenAmount(input.value);
    if (!threshold || threshold < 256) {
        showToast('上下文阈值不能低于 256 Token', 'error');
        return;
    }
    if (saveBtn) saveBtn.disabled = true;
    const originalText = saveBtn?.innerText || '';
    if (saveBtn) saveBtn.innerText = '保存中...';
    try {
        const res = await apiFetch(`${API_BASE}/admin/settings/memory`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ memory_threshold: threshold })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '上下文阈值保存失败');
        input.value = formatTokenInputValue(data.memoryConfig?.thresholdTokens || threshold);
        window.refreshCurrentContextUsage?.();
        showToast('上下文压缩阈值已保存');
    } catch (e) {
        showToast(e.message || '上下文阈值保存失败', 'error');
    } finally {
        if (saveBtn) saveBtn.innerText = originalText || '保存';
        if (saveBtn) saveBtn.disabled = false;
    }
};

document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-memory-threshold-save]');
    if (!button || button.disabled) return;
    event.preventDefault();
    window.saveMemorySettings?.();
});

window.fetchEmbeddingModels = async () => {
    const embeddingUrlInput = document.getElementById('setting-rag-embedding-url');
    const embeddingKeyInput = document.getElementById('setting-rag-embedding-key');
    const embeddingModelInput = document.getElementById('setting-rag-embedding-model');
    const selectContainer = document.getElementById('setting-rag-embedding-model-select-container');
    const selectEl = document.getElementById('setting-rag-embedding-model-select');
    const fetchBtn = document.getElementById('rag-embedding-fetch-models-btn');

    const apiUrl = embeddingUrlInput?.value.trim() || '';
    const apiKey = embeddingKeyInput?.value.trim() || '';
    if (!apiUrl) return showToast('请先填写 Embedding Base URL', 'error');
    if (!selectContainer || !selectEl) return;

    if (fetchBtn) fetchBtn.disabled = true;
    showToast('正在获取向量模型列表...', 'info');

    try {
        const res = await apiFetch(`${API_BASE}/settings/embedding-models`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ apiUrl, apiKey })
        });
        
        const contentType = res.headers.get('content-type');
        if (!contentType || !contentType.includes('application/json')) {
            const text = await res.text();
            throw new Error(`服务器返回了非 JSON 内容（可能是 404/500 页面）：${text.slice(0, 100)}...`);
        }

        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error || '获取向量模型列表失败');
        if (!data.models || data.models.length === 0) throw new Error('未获取到可用模型');

        const currentModel = embeddingModelInput?.value.trim() || '';
        selectEl.innerHTML = '<option value="">-- 请选择获取到的向量模型 --</option>' +
            data.models.map(model => `<option value="${escapeHtml(model)}">${escapeHtml(model)}</option>`).join('');
        if (currentModel && data.models.includes(currentModel)) {
            selectEl.value = currentModel;
        }
        selectContainer.classList.remove('hidden');
        if (data.models.length === 1 && embeddingModelInput) {
            selectEl.value = data.models[0];
            embeddingModelInput.value = data.models[0];
        }
        showToast(`成功获取 ${data.models.length} 个向量模型`, 'success');
    } catch (e) {
        showToast(e.message || '获取向量模型列表失败', 'error');
        console.error('Fetch error:', e);
    } finally {
        if (fetchBtn) fetchBtn.disabled = false;
    }
};

function updateEmbeddingSettingsForm(embeddingConfig = {}) {
    const embeddingModeInput = document.getElementById('setting-rag-embedding-mode');
    const embeddingUrlInput = document.getElementById('setting-rag-embedding-url');
    const embeddingModelInput = document.getElementById('setting-rag-embedding-model');
    const embeddingKeyInput = document.getElementById('setting-rag-embedding-key');
    const embeddingStatusEl = document.getElementById('setting-rag-embedding-status');
    const embeddingModelSelect = document.getElementById('setting-rag-embedding-model-select');
    const embeddingModelSelectContainer = document.getElementById('setting-rag-embedding-model-select-container');
    if (embeddingModeInput) embeddingModeInput.value = 'http';
    if (embeddingUrlInput) embeddingUrlInput.value = embeddingConfig?.apiUrl || '';
    if (embeddingModelInput) embeddingModelInput.value = embeddingConfig?.model || 'nomic-embed-text';
    if (embeddingKeyInput) {
        embeddingKeyInput.value = '';
        embeddingKeyInput.placeholder = embeddingConfig?.hasApiKey ? '•••••••• (已配置，输入新密钥可覆盖)' : '输入 API Key (留空则保留原配置)';
    }
    if (embeddingModelSelect) embeddingModelSelect.innerHTML = '';
    if (embeddingModelSelectContainer) embeddingModelSelectContainer.classList.add('hidden');
    if (embeddingStatusEl) {
        const keyStatus = embeddingConfig?.hasApiKey ? '已配置 API Key' : '未配置 API Key';
        const source = embeddingConfig?.isPersonal ? '个人配置'
            : embeddingConfig?.source?.url === 'settings' ? '系统默认'
            : '环境变量/默认值';
        embeddingStatusEl.innerText = `HTTP 服务 · ${keyStatus} · 来源：${source}`;
    }
}

window.saveSettings = async () => {
    const scoreInput = document.getElementById('setting-rag-score-threshold');
    const topKInput = document.getElementById('setting-rag-top-k');
    const candidateInput = document.getElementById('setting-rag-candidate-limit');
    const chunkSizeInput = document.getElementById('setting-rag-chunk-size');
    const chunkOverlapInput = document.getElementById('setting-rag-chunk-overlap');
    try {
        const payload = {};
        if (scoreInput) payload.rag_score_threshold = scoreInput.value;
        if (topKInput) payload.rag_top_k = topKInput.value;
        if (candidateInput) payload.rag_candidate_limit = candidateInput.value;
        if (chunkSizeInput) payload.rag_chunk_size = chunkSizeInput.value;
        if (chunkOverlapInput) payload.rag_chunk_overlap = chunkOverlapInput.value;
        const endpoint = isSuperAdminUser() ? `${API_BASE}/admin/settings` : `${API_BASE}/settings/embedding`;
        const res = await apiFetch(endpoint, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '系统设置保存失败');
        if (scoreInput) scoreInput.value = data.ragConfig?.scoreThreshold ?? scoreInput.value;
        if (topKInput) topKInput.value = data.ragConfig?.topK ?? topKInput.value;
        if (candidateInput) candidateInput.value = data.ragConfig?.candidateLimit ?? candidateInput.value;
        if (chunkSizeInput) chunkSizeInput.value = data.ragConfig?.chunkSize ?? chunkSizeInput.value;
        if (chunkOverlapInput) chunkOverlapInput.value = data.ragConfig?.chunkOverlap ?? chunkOverlapInput.value;
        updateEmbeddingSettingsForm(data.embeddingConfig);
        showToast(isSuperAdminUser() ? '系统设置已保存' : '个人设置已保存');
    } catch (e) {
        showToast(e.message || '系统设置保存失败', 'error');
    }
};

window.saveEmbeddingSettings = async () => {
    const embeddingModeInput = document.getElementById('setting-rag-embedding-mode');
    const embeddingUrlInput = document.getElementById('setting-rag-embedding-url');
    const embeddingModelInput = document.getElementById('setting-rag-embedding-model');
    const embeddingKeyInput = document.getElementById('setting-rag-embedding-key');
    const saveBtn = document.getElementById('rag-embedding-save-btn');
    const modal = document.getElementById('rag-embedding-modal');
    if (!embeddingUrlInput || !embeddingModelInput) return;
    if (saveBtn) saveBtn.disabled = true;
    try {
        const scoreInput = document.getElementById('setting-rag-score-threshold');
        const topKInput = document.getElementById('setting-rag-top-k');
        const candidateInput = document.getElementById('setting-rag-candidate-limit');
        const chunkSizeInput = document.getElementById('setting-rag-chunk-size');
        const chunkOverlapInput = document.getElementById('setting-rag-chunk-overlap');

        const payload = {
            rag_embedding_mode: 'http',
            rag_embedding_api_url: embeddingUrlInput.value.trim(),
            rag_embedding_model: getEmbeddingModelValue()
        };
        
        if (scoreInput) payload.rag_score_threshold = scoreInput.value;
        if (topKInput) payload.rag_top_k = topKInput.value;
        if (candidateInput) payload.rag_candidate_limit = candidateInput.value;
        if (chunkSizeInput) payload.rag_chunk_size = chunkSizeInput.value;
        if (chunkOverlapInput) payload.rag_chunk_overlap = chunkOverlapInput.value;

        if (embeddingModeInput) embeddingModeInput.value = 'http';
        if (embeddingKeyInput && embeddingKeyInput.value.trim()) {
            payload.rag_embedding_api_key = embeddingKeyInput.value.trim();
        }
        const endpoint = isSuperAdminUser() ? `${API_BASE}/admin/settings` : `${API_BASE}/settings/embedding`;
        const res = await apiFetch(endpoint, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '检索配置保存失败');
        updateEmbeddingSettingsForm(data.embeddingConfig);
        showToast(isSuperAdminUser() ? '系统检索配置已保存' : '个人检索配置已保存');
        if (modal) modal.classList.add('hidden');
    } catch (e) {
        showToast(e.message || '检索配置保存失败', 'error');
    } finally {
        if (saveBtn) saveBtn.disabled = false;
    }
};
window.testEmbeddingConnection = async () => {
    const embeddingUrlInput = document.getElementById('setting-rag-embedding-url');
    const embeddingModelInput = document.getElementById('setting-rag-embedding-model');
    const embeddingKeyInput = document.getElementById('setting-rag-embedding-key');
    const testBtn = document.getElementById('rag-embedding-test-btn');
    
    if (!embeddingUrlInput || !embeddingModelInput) return;
    
    const payload = {
        mode: 'http',
        apiUrl: embeddingUrlInput.value.trim(),
        model: getEmbeddingModelValue(),
        apiKey: embeddingKeyInput?.value.trim() || ''
    };

    if (testBtn) testBtn.disabled = true;
    showToast('正在测试向量连接，请稍候...', 'info');
    
    try {
        const res = await apiFetch(`${API_BASE}/rag/settings/test-embedding`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const contentType = res.headers.get('content-type');
        if (!contentType || !contentType.includes('application/json')) {
            const text = await res.text();
            throw new Error(`连接测试请求失败（返回了 HTML）：${text.slice(0, 100)}...`);
        }

        const data = await res.json();
        if (data.success) {
            showToast(`连接测试成功！向量维度：${data.dimension}，耗时：${data.durationMs}ms`, 'success');
        } else {
            throw new Error(data.error || '连接测试失败');
        }
    } catch (e) {
        showToast(e.message, 'error');
        console.error('Test connection error:', e);
    } finally {
        if (testBtn) testBtn.disabled = false;
    }
};

window.bindEmbeddingModalEvents = function() {
    const openBtn = document.getElementById('rag-embedding-modal-open-btn');
    const cancelBtn = document.getElementById('rag-embedding-modal-cancel');
    const testBtn = document.getElementById('rag-embedding-test-btn');
    const fetchModelsBtn = document.getElementById('rag-embedding-fetch-models-btn');
    const embeddingModelSelect = document.getElementById('setting-rag-embedding-model-select');
    const embeddingModelInput = document.getElementById('setting-rag-embedding-model');
    const modal = document.getElementById('rag-embedding-modal');
    const modeSelect = document.getElementById('setting-rag-embedding-mode');
    if (!openBtn || !modal) return;

    if (openBtn.dataset.boundEmbeddingOpen !== '1') {
        openBtn.dataset.boundEmbeddingOpen = '1';
        openBtn.addEventListener('click', () => {
            modal.classList.remove('hidden');
        });
    }
    if (cancelBtn && cancelBtn.dataset.boundEmbeddingCancel !== '1') {
        cancelBtn.dataset.boundEmbeddingCancel = '1';
        cancelBtn.addEventListener('click', () => modal.classList.add('hidden'));
    }
    
    if (testBtn) {
        testBtn.onclick = () => window.testEmbeddingConnection();
    }
    if (fetchModelsBtn) {
        fetchModelsBtn.onclick = () => window.fetchEmbeddingModels();
    }
    const saveBtn = document.getElementById('rag-embedding-save-btn');
    if (saveBtn) {
        saveBtn.onclick = () => window.saveEmbeddingSettings();
    }
    if (embeddingModelSelect) {
        embeddingModelSelect.onchange = (e) => {
            if (embeddingModelInput && e.target.value) {
                embeddingModelInput.value = e.target.value;
            }
        };
    }
    if (modeSelect) {
    }
    const keyToggle = document.getElementById('rag-embedding-key-toggle');
    const keyInput = document.getElementById('setting-rag-embedding-key');
    if (keyToggle && keyInput) {
        keyToggle.onclick = () => {
            const isPassword = keyInput.type === 'password';
            keyInput.type = isPassword ? 'text' : 'password';
            keyToggle.style.color = isPassword ? 'var(--primary)' : 'var(--text-muted)';
        };
    }
};

window.bindRagDebugModalEvents = function() {
    const openBtn = document.getElementById('rag-debug-modal-open-btn');
    const closeBtn = document.getElementById('rag-debug-modal-close');
    const modal = document.getElementById('rag-debug-modal');
    if (!openBtn || !modal) return;

    openBtn.onclick = () => {
        modal.classList.remove('hidden');
        // 如果是空的，自动填充默认参数
        if (window.loadKnowledgeDocs) window.loadKnowledgeDocs();
    };
    
    if (closeBtn) {
        closeBtn.onclick = () => modal.classList.add('hidden');
    }
    
    modal.onclick = (e) => {
        if (e.target === modal) modal.classList.add('hidden');
    };
};

function renderPagination(tab, total, currentPage) {
    const totalPages = Math.ceil(total / pageState.limit);
    const container = document.getElementById(`pagination-${tab}`);
    if (!container) return;
    container.replaceChildren();
    if (totalPages <= 1) return;

    const createButton = (label, targetPage, disabled) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'btn-secondary';
        button.disabled = disabled;
        button.dataset.paginationTab = tab;
        button.dataset.paginationPage = String(targetPage);
        button.textContent = label;
        return button;
    };

    const summary = document.createElement('span');
    summary.style.margin = '0 15px';
    summary.style.fontWeight = '500';
    summary.textContent = `第 ${currentPage} / ${totalPages} 页 (共 ${total} 条)`;

    container.append(
        createButton('首页', 1, currentPage === 1),
        createButton('上一页', currentPage - 1, currentPage === 1),
        summary,
        createButton('下一页', currentPage + 1, currentPage === totalPages),
        createButton('末页', totalPages, currentPage === totalPages)
    );
}

document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-pagination-tab][data-pagination-page]');
    if (!button || button.disabled) return;
    const page = parseInt(button.dataset.paginationPage, 10);
    if (!Number.isFinite(page) || page < 1) return;
    loadTabData(button.dataset.paginationTab, page);
});
