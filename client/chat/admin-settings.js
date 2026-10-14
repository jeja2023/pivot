let settingsLoadSequence = 0, settingsLoadController = null;

function setSettingsInitialValues(selector = '') {
    document.querySelectorAll(selector).forEach(input => {
        input.dataset.settingsInitial = input.type === 'checkbox'
            ? String(input.checked === true)
            : String(input.value ?? '');
    });
}

function settingsHasUnsavedChanges() {
    return [...document.querySelectorAll('[data-settings-initial]')].some(input => (
        (input.type === 'checkbox' ? String(input.checked === true) : String(input.value ?? '')) !== input.dataset.settingsInitial
    ));
}

function clearSettingsDirty() {
    document.querySelectorAll('[data-settings-initial]').forEach(input => {
        input.dataset.settingsInitial = input.type === 'checkbox'
            ? String(input.checked === true)
            : String(input.value ?? '');
    });
}

function setSettingsLoadState(state = '', message = '', { retry = false } = {}) {
    const el = document.getElementById('settings-load-state');
    if (!el) return;
    el.dataset.state = state;
    el.replaceChildren();
    el.hidden = !message;
    if (!message) return;
    const text = document.createElement('span');
    text.textContent = message;
    el.appendChild(text);
    if (retry) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'btn-secondary settings-state-retry';
        button.textContent = '重试';
        button.addEventListener('click', () => loadSettings());
        el.appendChild(button);
    }
}

function setSettingsTabState(state = '', message = '', { retry = false, tab = '', page = 1 } = {}) {
    const el = document.getElementById('settings-tab-state');
    if (!el) return;
    el.dataset.state = state;
    el.replaceChildren();
    el.hidden = !message;
    if (!message) return;
    const text = document.createElement('span');
    text.textContent = message;
    el.appendChild(text);
    if (retry) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'btn-secondary settings-state-retry';
        button.textContent = '重试';
        button.addEventListener('click', () => window.Pivot.legacy.loadTabData?.(tab, page));
        el.appendChild(button);
    }
}

async function loadSettings() {
    const requestId = ++settingsLoadSequence;
    settingsLoadController?.abort();
    const controller = typeof AbortController === 'function' ? new AbortController() : null; settingsLoadController = controller;
    setSettingsLoadState('loading', '正在加载设置…');
    try {
        const res = await apiFetch(`${API_BASE}/settings`, controller ? { signal: controller.signal, timeoutMs: 30000 } : {});
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `系统设置加载失败（HTTP ${res.status}）`);
        if (requestId !== settingsLoadSequence) return false;
        const scoreInput = document.getElementById('setting-rag-score-threshold');
        const topKInput = document.getElementById('setting-rag-top-k');
        const candidateInput = document.getElementById('setting-rag-candidate-limit');
        const chunkSizeInput = document.getElementById('setting-rag-chunk-size');
        const chunkOverlapInput = document.getElementById('setting-rag-chunk-overlap');
        if (scoreInput) scoreInput.value = data.ragConfig?.scoreThreshold ?? 0.4;
        if (topKInput) topKInput.value = data.ragConfig?.topK ?? 3;
        if (candidateInput) candidateInput.value = data.ragConfig?.candidateLimit ?? 300;
        if (chunkSizeInput) chunkSizeInput.value = data.ragConfig?.chunkSize ?? 500;
        if (chunkOverlapInput) chunkOverlapInput.value = data.ragConfig?.chunkOverlap ?? 100;
        updateRagChunkOverlapLimit();
        setSettingsInitialValues('#setting-rag-score-threshold, #setting-rag-top-k, #setting-rag-candidate-limit, #setting-rag-chunk-size, #setting-rag-chunk-overlap');
        window.Pivot.legacy.applyUploadRuntimeLimits?.(data.uploadLimits);
        updateRuntimeSettingsForm(data.runtimeConfig);
        updateApiAccessState(data.apiAccessEnabled === true);
        updateEmbeddingSettingsForm(data.retrievalModelConfig || data.embeddingConfig, data.rerankConfig);
        (window.Pivot.getModule?.('models.retrieval')?.renderRetrievalModelServices || window.Pivot.legacy.renderRetrievalModelServices)?.(data);
        (window.Pivot.getModule?.('knowledge.retrievalSummary')?.renderKnowledgeRetrievalModelSummary || window.Pivot.legacy.renderKnowledgeRetrievalModelSummary)?.(data.retrievalModelConfig || data.embeddingConfig, data.rerankConfig);
        setSettingsLoadState('', '');
        return true;
    } catch (error) {
        if (requestId !== settingsLoadSequence || error?.name === 'AbortError') return false;
        const message = error.message || '系统设置加载失败';
        setSettingsLoadState('error', message, { retry: true });
        showToast(message, 'error');
        return false;
    } finally {
        if (settingsLoadController === controller) settingsLoadController = null;
    }
}

const cancelSettingsLoad = () => { settingsLoadController?.abort(); settingsLoadController = null; };

window.Pivot?.exposeModule?.('settings.core', {
    clearSettingsDirty,
    cancelSettingsLoad,
    loadSettings,
    setSettingsLoadState,
    setSettingsTabState,
    settingsHasUnsavedChanges
}, [
    { globalName: 'clearSettingsDirty', exportName: 'clearSettingsDirty' },
    { globalName: 'cancelSettingsLoad', exportName: 'cancelSettingsLoad' },
    { globalName: 'loadSettings', exportName: 'loadSettings' },
    { globalName: 'setSettingsLoadState', exportName: 'setSettingsLoadState' },
    { globalName: 'setSettingsTabState', exportName: 'setSettingsTabState' },
    { globalName: 'settingsHasUnsavedChanges', exportName: 'settingsHasUnsavedChanges' }
]);

function updateRagChunkOverlapLimit() {
    const chunkSizeInput = document.getElementById('setting-rag-chunk-size');
    const overlapInput = document.getElementById('setting-rag-chunk-overlap');
    if (!chunkSizeInput || !overlapInput) return;
    const chunkSize = Number.parseInt(chunkSizeInput.value, 10);
    if (!Number.isFinite(chunkSize)) return;
    const maxOverlap = Math.max(0, Math.floor(chunkSize / 2));
    overlapInput.max = String(maxOverlap);
    if (Number(overlapInput.value) > maxOverlap) overlapInput.value = String(maxOverlap);
    const helpEl = document.getElementById('rag-chunk-overlap-help');
    if (helpEl) {
        const overlap = Number.parseInt(overlapInput.value, 10) || 0;
        const ratio = chunkSize > 0 ? Math.round((overlap / chunkSize) * 100) : 0;
        const isHigh = ratio > 50;
        PivotSafeHtml.setHtml(helpEl, `重叠字符数最多为分块长度的一半（≤ ${maxOverlap} 字符，当前 <span class="retrieval-ratio-badge ${isHigh ? 'is-warning' : ''}">${ratio}% 重叠率</span>），保持段落衔接并减少边界语义丢失。`);
    }
}

function validateRagSettings() {
    const score = Number(document.getElementById('setting-rag-score-threshold')?.value);
    const topK = Number.parseInt(document.getElementById('setting-rag-top-k')?.value, 10);
    const candidate = Number.parseInt(document.getElementById('setting-rag-candidate-limit')?.value, 10);
    const chunkSize = Number.parseInt(document.getElementById('setting-rag-chunk-size')?.value, 10);
    const overlap = Number.parseInt(document.getElementById('setting-rag-chunk-overlap')?.value, 10);
    if (!Number.isFinite(score) || score < 0 || score > 1) throw new Error('相似度阈值需在 0 到 1 之间');
    if (!Number.isInteger(topK) || topK < 1 || topK > 10) throw new Error('Top K 需在 1 到 10 之间');
    if (!Number.isInteger(candidate) || candidate < Math.max(topK, 20) || candidate > 1000) throw new Error(`候选数量至少为 ${Math.max(topK, 20)}`);
    if (!Number.isInteger(chunkSize) || chunkSize < 200 || chunkSize > 2000) throw new Error('分块长度需在 200 到 2000 之间');
    if (!Number.isInteger(overlap) || overlap < 0 || overlap > Math.floor(chunkSize / 2)) throw new Error('重叠字符数不能超过分块长度的一半');
}

function runtimeItemsByKey(runtimeConfig = {}) {
    const map = {};
    (runtimeConfig.items || []).forEach(item => {
        if (item?.key) map[item.key] = item;
    });
    return map;
}

function getRuntimeItemHint(item) {
    const hintMap = {
        max_concurrent_ai_requests: '同时处理的聊天请求数，过大可能影响响应稳定性。', max_ai_queue_size: '请求排队上限，队列满后会拒绝新的请求。', ai_queue_timeout_ms: '请求在队列里等待多久后自动超时。', model_endpoint_default_concurrency: '单个模型端点默认并发量。', model_endpoint_queue_size: '单个模型端点的排队长度。', model_endpoint_queue_timeout_ms: '模型端点排队等待超时时间。', model_context_window_tokens: '没有单独配置上下文时使用的全局默认窗口。', context_reserved_output_tokens: '为输出预留的 token 数，避免把回答空间压得太小。', memory_threshold: '会话活跃 token 超过此值时触发自动压缩提炼。', sampling_temperature: '温度越高越发散，越低越稳定。', sampling_top_p: '采样概率上限，常和温度配合调节。', sampling_presence_penalty: '减少反复提同一内容的倾向。', sampling_frequency_penalty: '减少高频重复词的倾向。', upload_attachment_max_bytes: '聊天附件的总上传上限。', knowledge_upload_max_bytes: '知识库文件的总上传上限。', image_upload_max_bytes: '单张图片在上传阶段的大小上限。', image_context_max_bytes: '图片进入模型上下文前允许携带的大小上限。', max_attachments_per_message: '用户输入框中一条消息最多保留的待发送附件数量。', max_images_per_message: '一条消息允许注入的图片数量上限。', attachment_context_max_chars: '附件抽取文本写入上下文时的字符上限。', knowledge_extract_max_chars: '知识库文件抽取文本时的字符上限。', rag_top_k_max: '每次检索最多返回多少条结果。', rag_candidate_limit_max: '候选片段池的最大数量。', rag_chunk_size_max: '检索切片的最大字符数。', rag_context_budget_percent: 'RAG 在上下文中可占用的大致比例。', rag_index_max_concurrent: '同时执行多少个知识库索引任务。', agent_max_concurrent_runs: '同一时间允许多少个智能体任务运行。', agent_dag_node_concurrency: '工作流 DAG 节点的并发执行数。',
        chat_auto_agent_enabled: '关闭后用户不能选择聊天 Agent 执行模式；普通回答、手工 Agent 和工作流仍可使用。',
        memory_compression_max_concurrent: '后台同时压缩多少个记忆任务。'
    };
    return hintMap[item?.key] || '';
}

const RUNTIME_HUMAN_INT_KEYS = new Set(['model_context_window_tokens', 'context_reserved_output_tokens', 'memory_threshold', 'upload_attachment_max_bytes', 'knowledge_upload_max_bytes', 'image_upload_max_bytes', 'image_context_max_bytes', 'attachment_context_max_chars', 'knowledge_extract_max_chars', 'rag_candidate_limit_max', 'rag_chunk_size_max']);
function isRuntimeHumanIntKey(key) { return RUNTIME_HUMAN_INT_KEYS.has(key); }

function updateRuntimeStatusMirrors(text = '') {
    document.querySelectorAll('[data-runtime-status]').forEach(el => {
        el.innerText = text;
    });
}

function updateRuntimeEditState() {
    const canEdit = isSuperAdminUser();
    document.querySelectorAll('[data-runtime-key]').forEach(input => {
        input.disabled = !canEdit;
    });
    [
        document.getElementById('runtime-settings-page-save')
    ].filter(Boolean).forEach(btn => {
        btn.classList.toggle('hidden', !canEdit);
        btn.disabled = !canEdit;
        btn.title = canEdit ? '' : '只有 admin 权限层级可以修改全局参数';
    });
}

function getRuntimeSettingsFormRoot(source = null) {
    const sourceEl = source?.currentTarget || source?.target || source || document.activeElement;
    return sourceEl?.closest?.('#tab-content-global-params')
        || document.getElementById('tab-content-global-params')
        || document;
}

function collectRuntimeSettingsPayload(source = null) {
    const root = getRuntimeSettingsFormRoot(source);
    const payload = {};
    Array.from(root.querySelectorAll('[data-runtime-key]')).forEach(input => {
        const key = input.dataset.runtimeKey;
        if (!key || Object.prototype.hasOwnProperty.call(payload, key)) return;
        if (input.type === 'checkbox') {
            payload[key] = input.checked === true ? 1 : 0;
            return;
        }
        const rawValue = String(input.value || '').trim();
        payload[key] = isRuntimeHumanIntKey(key) ? parseTokenAmount(rawValue) : Number(rawValue);
    });
    return payload;
}

function updateRuntimeSettingsForm(runtimeConfig = {}) {
    window.Pivot.legacy.currentRuntimeConfig = runtimeConfig || {};
    if (runtimeConfig?.values) {
        window.Pivot.legacy.applyUploadRuntimeLimits?.({
            maxAttachmentsPerMessage: runtimeConfig.values.maxAttachmentsPerMessage,
            maxImagesPerMessage: runtimeConfig.values.maxImagesPerMessage
        });
    }
    const byKey = runtimeItemsByKey(runtimeConfig);
    document.querySelectorAll('[data-runtime-key]').forEach(input => {
        const key = input.dataset.runtimeKey;
        if (!input.id && key) input.id = `runtime-setting-${key}`;
        const formItem = input.closest('.form-item');
        const label = formItem?.querySelector('label');
        const hintEl = formItem?.querySelector('.runtime-key-note');
        if (label && input.id) label.htmlFor = input.id;
        if (hintEl && input.id) {
            if (!hintEl.id) hintEl.id = `${input.id}-hint`;
            input.setAttribute('aria-describedby', hintEl.id);
        }
        const item = byKey[key];
        if (!item) return;
        input.min = item.min ?? input.min;
        input.max = item.max ?? input.max;
        if (input.type === 'checkbox') {
            input.checked = Number(item.value) === 1;
            input.dataset.settingsInitial = String(input.checked === true);
        } else {
            input.value = isRuntimeHumanIntKey(key) ? formatTokenInputValue(item.value) : String(item.value ?? '');
            input.dataset.settingsInitial = String(input.value ?? '');
        }
        const hint = getRuntimeItemHint(item);
        const sourceHint = item.source === 'settings' ? `当前值已由系统设置保存，环境变量 ${Array.isArray(item.env) ? item.env.join(' / ') : item.env} 仅用于首次初始化` : `当前值来自环境变量 ${Array.isArray(item.env) ? item.env.join(' / ') : item.env} 或默认值`;
        if (hintEl) hintEl.textContent = [hint, sourceHint].filter(Boolean).join('；');
        input.title = hint ? `${item.label}。${hint} 范围 ${item.min} - ${item.max}` : `${item.label}，范围 ${item.min} - ${item.max}`;
    }); const updated = (runtimeConfig.items || []).map(item => item.updatedAt).filter(Boolean).sort().pop();
    updateRuntimeEditState();
    const readOnlyHint = !isSuperAdminUser() && runtimeConfig?.items?.length ? '仅 admin 权限层级可修改' : '';
    const updatedText = updated ? `最近保存：${updated}` : '';
    updateRuntimeStatusMirrors([updatedText, readOnlyHint].filter(Boolean).join(' · '));
}


window.Pivot.legacy.saveRuntimeSettings = async function(source = null) {
    if (!isSuperAdminUser()) {
        const message = '只有 admin 权限层级可以修改全局参数';
        updateRuntimeStatusMirrors(message);
        showToast(message, 'error');
        return;
    }
    const saveButtons = [
        document.getElementById('runtime-settings-page-save')
    ].filter(Boolean);
    const oldTexts = new Map(saveButtons.map(btn => [btn, btn.innerText]));
    const payload = collectRuntimeSettingsPayload(source);
    saveButtons.forEach(btn => {
        btn.disabled = true;
        btn.innerText = '正在保存...';
    });
    updateRuntimeStatusMirrors('');
    try {
        const res = await apiFetch(`${API_BASE}/admin/settings/runtime`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '运行时配置保存失败');
        updateRuntimeSettingsForm(data.runtimeConfig);
        showToast('并发与上下文配置已保存');
        if (window.Pivot.legacy.refreshMonitorSummary) window.Pivot.legacy.refreshMonitorSummary({ force: true });
        else window.Pivot.legacy.loadMonitorSummary?.({ force: true });
    } catch (e) {
        const message = e.message || '运行时配置保存失败';
        updateRuntimeStatusMirrors(message);
        showToast(message, 'error');
    } finally {
        saveButtons.forEach(btn => {
            btn.innerText = oldTexts.get(btn) || '保存配置';
            btn.disabled = false;
        });
    }
};

function updateApiAccessState(enabled) {
    const isEnabled = enabled === true;
    window.Pivot.legacy.apiAccessEnabled = isEnabled;
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

window.Pivot.legacy.updateApiAccessState = updateApiAccessState;

window.Pivot.legacy.updateApiAccessSetting = async function() {
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
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'API 接入设置保存失败');
        updateApiAccessState(data.apiAccessEnabled === true);
        window.Pivot.legacy.loadApiKeys?.();
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
function callSettingsMemoryAction(name, ...args) {
    const legacyAction = window.Pivot.legacy?.[name];
    if (typeof legacyAction === 'function') return legacyAction(...args);
    const memoryModule = window.Pivot.getModule?.('settings.memory');
    if (memoryModule && typeof memoryModule[name] === 'function') {
        return memoryModule[name](...args);
    }
    throw new Error(`记忆功能未就绪：${name}`);
}

async function reloadSettingsMemories(page = 1) {
    try {
        await callSettingsMemoryAction('loadMemories', page);
    } catch (error) {
        showToast(error.message || '长期记忆刷新失败', 'error');
    }
}

window.Pivot.moduleApi('settings.events').registerAdminSettingsEvents(() => {
    document.getElementById('runtime-settings-page-save')?.addEventListener('click', event => window.Pivot.legacy.saveRuntimeSettings?.(event));
    document.getElementById('runtime-settings-page-refresh')?.addEventListener('click', () => window.Pivot.legacy.loadSettings?.());
    document.getElementById('memory-merge-suggestions-btn')?.addEventListener('click', async () => {
        try { await callSettingsMemoryAction('openMemoryMergeSuggestionsModal'); } catch (error) { showToast(error.message || '合并建议加载失败', 'error'); }
    });
    document.getElementById('memory-jobs-panel')?.addEventListener('click', async (event) => {
        const retryButton = event.target?.closest?.('#memory-jobs-retry-btn');
        if (!retryButton) return;
        retryButton.disabled = true;
        try {
            const result = await callSettingsMemoryAction('retryMemoryJobs');
            const queued = Number(result.queued || 0);
            showToast(queued ? `已将 ${queued} 个失败任务重新入队` : '没有可重试的失败任务', queued ? 'success' : 'info');
            await callSettingsMemoryAction('loadMemories');
        } catch (e) {
            showToast(e.message || '任务维护失败', 'error');
        } finally {
            retryButton.disabled = false;
        }
    });
    document.getElementById('memory-list-body')?.addEventListener('click', async (event) => {
        const button = event.target?.closest?.('[data-memory-action]');
        if (!button) return;
        const memoryId = button.dataset.memoryId;
        const action = button.dataset.memoryAction;
        if (action === 'edit') {
            const selectedMemory = callSettingsMemoryAction('getCurrentMemory', memoryId);
            if (!selectedMemory) throw new Error('记忆数据已刷新，请重新加载后再编辑');
            callSettingsMemoryAction('openMemoryEditModal', selectedMemory);
        } else if (action === 'usage') {
            event.preventDefault();
            event.stopImmediatePropagation();
            button.disabled = true;
            try {
                await callSettingsMemoryAction('openMemoryUsageModal', memoryId);
            } catch (e) {
                showToast(e.message || '长期记忆操作失败', 'error');
            } finally {
                button.disabled = false;
            }
        }
    }, true);
    ['memory-edit-modal', 'memory-source-modal', 'memory-merge-modal'].forEach(id => {
        document.getElementById(id)?.addEventListener('click', (event) => {
            if (event.target?.id === id && id === 'memory-merge-modal') {
                try { callSettingsMemoryAction('closeMemoryMergeModal'); } catch (_) {}
            }
        });
    });
    document.getElementById('memory-merge-close')?.addEventListener('click', () => {
        try { callSettingsMemoryAction('closeMemoryMergeModal'); } catch (_) {}
    });
    window.Pivot.getModule?.('settings.memoryUi')?.bindAdminMemorySettingsEvents?.();
});

async function fetchEmbeddingModels() {
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

        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) throw new Error(data.error || '获取向量模型列表失败');
        if (!data.models || data.models.length === 0) throw new Error('未获取到可用模型');

        const currentModel = embeddingModelInput?.value.trim() || '';
        PivotSafeHtml.setHtml(selectEl, '<option value="">-- 请选择获取到的向量模型 --</option>' +
            data.models.map(model => `<option value="${escapeHtml(model)}">${escapeHtml(model)}</option>`).join(''));
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
        console.error('获取向量模型列表失败:', e);
    } finally {
        if (fetchBtn) fetchBtn.disabled = false;
    }
};

function updateEmbeddingSettingsForm(embeddingConfig = {}, rerankConfig = {}) {
    const embeddingModeInput = document.getElementById('setting-rag-embedding-mode');
    const embeddingUrlInput = document.getElementById('setting-rag-embedding-url');
    const embeddingModelInput = document.getElementById('setting-rag-embedding-model');
    const embeddingKeyInput = document.getElementById('setting-rag-embedding-key');
    const embeddingStatusEl = document.getElementById('setting-rag-embedding-status');
    const embeddingModelSelect = document.getElementById('setting-rag-embedding-model-select');
    const embeddingModelSelectContainer = document.getElementById('setting-rag-embedding-model-select-container');
    const rerankEnabled = document.getElementById('setting-rag-rerank-enabled');
    const rerankUrl = document.getElementById('setting-rag-rerank-url');
    const rerankModel = document.getElementById('setting-rag-rerank-model');
    const rerankProtocol = document.getElementById('setting-rag-rerank-protocol');
    const rerankCandidates = document.getElementById('setting-rag-rerank-candidate-limit');
    const rerankTimeout = document.getElementById('setting-rag-rerank-timeout-ms');
    const rerankKey = document.getElementById('setting-rag-rerank-key');
    const rerankStatus = document.getElementById('setting-rag-rerank-status');
    if (embeddingModeInput) embeddingModeInput.value = 'http';
    if (embeddingUrlInput) embeddingUrlInput.value = embeddingConfig?.apiUrl || '';
    if (embeddingModelInput) embeddingModelInput.value = embeddingConfig?.model || 'nomic-embed-text';
    if (embeddingKeyInput) {
        embeddingKeyInput.value = '';
        embeddingKeyInput.placeholder = embeddingConfig?.hasApiKey ? '•••••••• (已配置，输入新密钥可覆盖)' : '输入 API Key (留空则保留原配置)';
    }
    if (embeddingModelSelect) PivotSafeHtml.setHtml(embeddingModelSelect, '');
    if (embeddingModelSelectContainer) embeddingModelSelectContainer.classList.add('hidden');
    if (embeddingStatusEl) {
        const keyStatus = embeddingConfig?.hasApiKey ? '已配置 API Key' : '未配置 API Key';
        const source = embeddingConfig?.isPersonal ? '个人配置'
            : embeddingConfig?.source?.url === 'settings' ? '系统默认'
            : '环境变量/默认值';
        embeddingStatusEl.innerText = isSuperAdminUser()
            ? `HTTP 服务 · ${keyStatus} · 来源：${source} · 法规与知识库共享此系统模型`
            : `HTTP 服务 · ${keyStatus} · 来源：${source} · 法规与知识库使用管理员配置的共享模型`;
    }
    const canEditRerank = isSuperAdminUser();
    if (rerankEnabled) { rerankEnabled.checked = rerankConfig?.enabled === true; rerankEnabled.disabled = !canEditRerank; }
    if (rerankUrl) { rerankUrl.value = rerankConfig?.apiUrl || ''; rerankUrl.disabled = !canEditRerank; }
    if (rerankModel) { rerankModel.value = rerankConfig?.model || 'BAAI/bge-reranker-v2-m3'; rerankModel.disabled = !canEditRerank; }
    if (rerankProtocol) { rerankProtocol.value = rerankConfig?.protocol === 'llama_cpp' ? 'llama_cpp' : 'tei'; rerankProtocol.disabled = !canEditRerank; }
    if (rerankCandidates) { rerankCandidates.value = rerankConfig?.candidateLimit ?? 30; rerankCandidates.disabled = !canEditRerank; }
    if (rerankTimeout) { rerankTimeout.value = rerankConfig?.timeoutMs ?? 1800; rerankTimeout.disabled = !canEditRerank; }
    if (rerankKey) {
        rerankKey.value = '';
        rerankKey.disabled = !canEditRerank;
        rerankKey.placeholder = rerankConfig?.hasApiKey ? '••••••••（已配置，输入新密钥可覆盖）' : '留空则保留原配置';
    }
    if (rerankStatus) rerankStatus.innerText = rerankConfig?.configured
        ? `外部重排序 · ${rerankConfig.enabled ? '已启用' : '已配置但未启用'} · ${rerankConfig.protocol === 'llama_cpp' ? 'llama.cpp' : 'TEI'} 协议 · 前 ${rerankConfig.candidateLimit || 30} 个候选 · ${rerankConfig.timeoutMs || 1800}ms 超时`
        : '外部重排序未配置；将继续使用本地确定性排序。';
    setSettingsInitialValues('#setting-rag-embedding-url, #setting-rag-embedding-model, #setting-rag-rerank-url, #setting-rag-rerank-protocol, #setting-rag-rerank-model, #setting-rag-rerank-candidate-limit, #setting-rag-rerank-timeout-ms');
}

window.Pivot.legacy.updateEmbeddingSettingsForm = updateEmbeddingSettingsForm;

function setRetrievalModelModalVisibility(modal, open, options = {}) {
    if (!modal) return;
    if (typeof window.Pivot.legacy.setKnowledgeModalVisibility === 'function') {
        window.Pivot.legacy.setKnowledgeModalVisibility(modal, open, options);
        return;
    }
    modal.classList.toggle('hidden', !open);
    modal.setAttribute('aria-hidden', open ? 'false' : 'true');
    if (open) window.setTimeout(() => modal.querySelector(options.focusSelector || 'button, input, select, textarea')?.focus(), 0);
}

const RETRIEVAL_CONFIG_SECTIONS = {
    embedding: {
        modalId: 'rag-embedding-modal',
        saveLabel: '保存向量服务',
        focusSelector: '#setting-rag-embedding-url'
    },
    rerank: {
        modalId: 'rag-rerank-modal',
        saveLabel: '保存重排序服务',
        focusSelector: '#setting-rag-rerank-url'
    },
    policy: {
        modalId: 'rag-retrieval-policy-modal',
        saveLabel: '保存检索策略',
        focusSelector: '#setting-rag-score-threshold'
    },
    ocr: {
        modalId: 'ocr-service-modal',
        saveLabel: '保存 OCR 服务',
        focusSelector: '#setting-ocr-service-url'
    }
};

function getRetrievalConfigSection(section) {
    const value = String(section || '').trim();
    return Object.hasOwn(RETRIEVAL_CONFIG_SECTIONS, value) ? value : 'embedding';
}

function openRetrievalModelConfigSection(section) {
    if (!isSuperAdminUser()) {
        showToast('基础模型与算法服务由系统管理员统一维护', 'info');
        return false;
    }
    const safeSection = getRetrievalConfigSection(section);
    const config = RETRIEVAL_CONFIG_SECTIONS[safeSection];
    const modal = document.getElementById(config.modalId);
    if (!modal) {
        showToast('模型配置面板尚未就绪，请刷新页面后重试', 'error');
        return false;
    }
    if (safeSection === 'policy') {
        updateRagChunkOverlapLimit();
    }
    if (safeSection === 'ocr') {
        const input = document.getElementById('setting-ocr-service-url');
        if (input) input.value = window.Pivot?.ocrConfig?.serviceUrl || 'http://ocr-service:9100';
        const statusEl = document.getElementById('setting-ocr-test-status');
        if (statusEl) {
            statusEl.textContent = '';
            statusEl.className = 'model-modal-desc retrieval-config-status';
        }
    }
    setRetrievalModelModalVisibility(modal, true, { focusSelector: config.focusSelector });
    return true;
}

window.Pivot.legacy.openRetrievalModelConfigSection = openRetrievalModelConfigSection;

window.Pivot.legacy.saveSettings = async () => {
    const scoreInput = document.getElementById('setting-rag-score-threshold');
    const topKInput = document.getElementById('setting-rag-top-k');
    const candidateInput = document.getElementById('setting-rag-candidate-limit');
    const chunkSizeInput = document.getElementById('setting-rag-chunk-size');
    const chunkOverlapInput = document.getElementById('setting-rag-chunk-overlap');
    try {
        updateRagChunkOverlapLimit();
        validateRagSettings();
        const payload = {};
        if (scoreInput) payload.rag_score_threshold = scoreInput.value;
        if (topKInput) payload.rag_top_k = topKInput.value;
        if (candidateInput) payload.rag_candidate_limit = candidateInput.value;
        if (chunkSizeInput) payload.rag_chunk_size = chunkSizeInput.value;
        if (chunkOverlapInput) payload.rag_chunk_overlap = chunkOverlapInput.value;
        const endpoint = isSuperAdminUser() ? `${API_BASE}/admin/settings` : `${API_BASE}/settings/embedding`;
        const res = await apiFetch(endpoint, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '系统设置保存失败');
        if (scoreInput) scoreInput.value = data.ragConfig?.scoreThreshold ?? scoreInput.value;
        if (topKInput) topKInput.value = data.ragConfig?.topK ?? topKInput.value;
        if (candidateInput) candidateInput.value = data.ragConfig?.candidateLimit ?? candidateInput.value;
        if (chunkSizeInput) chunkSizeInput.value = data.ragConfig?.chunkSize ?? chunkSizeInput.value;
        if (chunkOverlapInput) chunkOverlapInput.value = data.ragConfig?.chunkOverlap ?? chunkOverlapInput.value;
        updateEmbeddingSettingsForm(data.retrievalModelConfig || data.embeddingConfig, data.rerankConfig);
        (window.Pivot.getModule?.('models.retrieval')?.renderRetrievalModelServices || window.Pivot.legacy.renderRetrievalModelServices)?.(data);
        (window.Pivot.getModule?.('knowledge.retrievalSummary')?.renderKnowledgeRetrievalModelSummary || window.Pivot.legacy.renderKnowledgeRetrievalModelSummary)?.(data.retrievalModelConfig || data.embeddingConfig, data.rerankConfig);
        setSettingsInitialValues('#setting-rag-score-threshold, #setting-rag-top-k, #setting-rag-candidate-limit, #setting-rag-chunk-size, #setting-rag-chunk-overlap');
        showToast(isSuperAdminUser() ? '系统设置已保存' : '个人设置已保存');
    } catch (e) {
        showToast(e.message || '系统设置保存失败', 'error');
    }
};

async function saveEmbeddingSettings(requestedSection = 'embedding') {
    const section = getRetrievalConfigSection(requestedSection);
    const config = RETRIEVAL_CONFIG_SECTIONS[section];
    const modal = document.getElementById(config.modalId);
    const saveBtn = modal?.querySelector(`[data-retrieval-config-save="${section}"]`);
    if (!modal) return;
    if (saveBtn) saveBtn.disabled = true;
    try {
        const scoreInput = document.getElementById('setting-rag-score-threshold');
        const topKInput = document.getElementById('setting-rag-top-k');
        const candidateInput = document.getElementById('setting-rag-candidate-limit');
        const chunkSizeInput = document.getElementById('setting-rag-chunk-size');
        const chunkOverlapInput = document.getElementById('setting-rag-chunk-overlap');

        if (section === 'policy') {
            updateRagChunkOverlapLimit();
            validateRagSettings();
        }

        if (section === 'ocr') {
            const serviceUrlInput = document.getElementById('setting-ocr-service-url');
            const serviceUrl = serviceUrlInput?.value.trim() || '';
            const res = await apiFetch(`${API_BASE}/settings/ocr`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ serviceUrl }) });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || 'OCR 服务保存失败');
            window.Pivot.ocrConfig = data.settings || { serviceUrl, engine: 'http' };
            if (data.engines) window.Pivot.ocrEngineStatus = data.engines;
            const currentSettings = await apiFetch(`${API_BASE}/settings`, { headers: authHeaders() }).then(r => r.json()).catch(() => ({}));
            (window.Pivot.getModule?.('models.retrieval')?.renderRetrievalModelServices || window.Pivot.legacy.renderRetrievalModelServices)?.({
                ...currentSettings,
                ocrConfig: window.Pivot.ocrConfig,
                ocrEngineStatus: window.Pivot.ocrEngineStatus
            });
            showToast('OCR 识别服务配置已保存', 'success');
            setRetrievalModelModalVisibility(modal, false);
            return;
        }

        const payload = {};
        if (section === 'embedding') {
            const embeddingModeInput = document.getElementById('setting-rag-embedding-mode');
            const embeddingUrlInput = document.getElementById('setting-rag-embedding-url');
            const embeddingModelInput = document.getElementById('setting-rag-embedding-model');
            const embeddingKeyInput = document.getElementById('setting-rag-embedding-key');
            if (!embeddingUrlInput || !embeddingModelInput) throw new Error('向量服务配置面板尚未就绪');
            payload.rag_embedding_mode = 'http';
            payload.rag_embedding_api_url = embeddingUrlInput.value.trim();
            payload.rag_embedding_model = getEmbeddingModelValue();
            if (embeddingModeInput) embeddingModeInput.value = 'http';
            if (embeddingKeyInput?.value.trim()) payload.rag_embedding_api_key = embeddingKeyInput.value.trim();
        }

        if (section === 'rerank') {
            const rerankEnabled = document.getElementById('setting-rag-rerank-enabled');
            const rerankUrl = document.getElementById('setting-rag-rerank-url');
            const rerankModel = document.getElementById('setting-rag-rerank-model');
            const rerankProtocol = document.getElementById('setting-rag-rerank-protocol');
            const rerankCandidates = document.getElementById('setting-rag-rerank-candidate-limit');
            const rerankTimeout = document.getElementById('setting-rag-rerank-timeout-ms');
            const rerankKey = document.getElementById('setting-rag-rerank-key');
            payload.rag_rerank_enabled = rerankEnabled?.checked === true;
            payload.rag_rerank_api_url = rerankUrl?.value.trim() || '';
            payload.rag_rerank_model = rerankModel?.value.trim() || 'BAAI/bge-reranker-v2-m3';
            payload.rag_rerank_protocol = rerankProtocol?.value === 'llama_cpp' ? 'llama_cpp' : 'tei';
            payload.rag_rerank_candidate_limit = rerankCandidates?.value || '30';
            payload.rag_rerank_timeout_ms = rerankTimeout?.value || '1800';
            if (rerankKey?.value.trim()) payload.rag_rerank_api_key = rerankKey.value.trim();
        }

        if (section === 'policy') {
            if (scoreInput) payload.rag_score_threshold = scoreInput.value;
            if (topKInput) payload.rag_top_k = topKInput.value;
            if (candidateInput) payload.rag_candidate_limit = candidateInput.value;
            if (chunkSizeInput) payload.rag_chunk_size = chunkSizeInput.value;
            if (chunkOverlapInput) payload.rag_chunk_overlap = chunkOverlapInput.value;
        }
        const endpoint = `${API_BASE}/admin/settings`;
        const res = await apiFetch(endpoint, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '检索配置保存失败');
        updateEmbeddingSettingsForm(data.retrievalModelConfig || data.embeddingConfig, data.rerankConfig);
        (window.Pivot.getModule?.('models.retrieval')?.renderRetrievalModelServices || window.Pivot.legacy.renderRetrievalModelServices)?.(data);
        (window.Pivot.getModule?.('knowledge.retrievalSummary')?.renderKnowledgeRetrievalModelSummary || window.Pivot.legacy.renderKnowledgeRetrievalModelSummary)?.(data.retrievalModelConfig || data.embeddingConfig, data.rerankConfig);
        if (section === 'policy') {
            setSettingsInitialValues('#setting-rag-score-threshold, #setting-rag-top-k, #setting-rag-candidate-limit, #setting-rag-chunk-size, #setting-rag-chunk-overlap');
        }
        showToast(`${config.saveLabel}成功`, 'success');
        setRetrievalModelModalVisibility(modal, false);
    } catch (e) {
        showToast(e.message || '检索配置保存失败', 'error');
    } finally {
        if (saveBtn) saveBtn.disabled = false;
    }
};
function updateRetrievalCardStatus(serviceKey, isReady, statusText = '') {
    const card = document.querySelector(`[data-retrieval-model-test="${serviceKey}"]`)?.closest('.retrieval-model-service-card');
    if (!card) return;
    card.classList.toggle('is-ready', isReady);
    card.classList.toggle('is-warning', !isReady);
    const statusSmall = card.querySelector('small');
    if (statusSmall && statusText) {
        statusSmall.textContent = statusText;
        statusSmall.title = statusText;
    }
}

async function runRetrievalTest(options, defaultBtnId, runner) {
    const { fromCard = false, button = null } = options;
    const testBtn = button || document.getElementById(defaultBtnId);
    const origText = testBtn?.textContent;
    if (testBtn) {
        testBtn.disabled = true;
        if (fromCard) testBtn.textContent = '测试中…';
    }
    try {
        await runner();
    } finally {
        if (testBtn) {
            testBtn.disabled = false;
            if (origText) testBtn.textContent = origText;
        }
    }
}

async function testEmbeddingConnection(options = {}) {
    const { fromCard = false } = options;
    let apiUrl = '', model = '', apiKey = '';
    if (!fromCard) {
        const urlInput = document.getElementById('setting-rag-embedding-url');
        const modelInput = document.getElementById('setting-rag-embedding-model');
        if (!urlInput || !modelInput) return;
        const rawUrl = urlInput.value.trim();
        const rawKey = document.getElementById('setting-rag-embedding-key')?.value.trim() || '';
        apiUrl = rawUrl === '********' ? '' : rawUrl;
        apiKey = rawKey === '********' ? '' : rawKey;
        model = getEmbeddingModelValue();
    }
    await runRetrievalTest(options, 'rag-embedding-test-btn', async () => {
        showToast('正在测试向量连接，请稍候...', 'info');
        try {
            const res = await apiFetch(`${API_BASE}/rag/settings/test-embedding`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mode: 'http', apiUrl, model, apiKey })
            });
            const contentType = res.headers.get('content-type');
            if (!contentType || !contentType.includes('application/json')) {
                const text = await res.text();
                throw new Error(`连接测试请求失败（返回了 HTML）：${text.slice(0, 100)}...`);
            }
            const data = await res.json();
            if (!data.success) throw new Error(data.error || '连接测试失败');
            showToast(`连接测试成功！向量维度：${data.dimension}，耗时：${data.durationMs}ms`, 'success');
            updateRetrievalCardStatus('embedding', true);
        } catch (e) {
            showToast(e.message, 'error');
            updateRetrievalCardStatus('embedding', false);
        }
    });
}

async function testRerankConnection(options = {}) {
    const { fromCard = false } = options;
    const rawUrl = document.getElementById('setting-rag-rerank-url')?.value.trim() || '';
    const rawKey = document.getElementById('setting-rag-rerank-key')?.value.trim() || '';
    let apiUrl = fromCard ? '' : (rawUrl === '********' ? '' : rawUrl);
    let apiKey = fromCard ? '' : (rawKey === '********' ? '' : rawKey);
    const model = document.getElementById('setting-rag-rerank-model')?.value.trim() || '';
    const protocol = document.getElementById('setting-rag-rerank-protocol')?.value === 'llama_cpp' ? 'llama_cpp' : 'tei';
    const candidateLimit = document.getElementById('setting-rag-rerank-candidate-limit')?.value || '30';
    const timeoutMs = document.getElementById('setting-rag-rerank-timeout-ms')?.value || '1800';
    if (!fromCard && !rawUrl) return showToast('请先填写重排序服务地址', 'error');

    await runRetrievalTest(options, 'rag-rerank-test-btn', async () => {
        showToast('正在测试重排序服务，请稍候…', 'info');
        try {
            const res = await apiFetch(`${API_BASE}/rag/settings/test-rerank`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ apiUrl, apiKey, model, protocol, candidateLimit, timeoutMs })
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || data.success !== true) throw new Error(data.error || '重排序服务测试失败');
            const durationText = data.durationMs ? `，耗时：${data.durationMs}ms` : '';
            showToast(`重排序服务连接成功，已验证 ${data.ranked || 0} 个测试候选${durationText}`, 'success');
            updateRetrievalCardStatus('rerank', true);
        } catch (error) {
            showToast(error.message || '重排序服务测试失败', 'error');
            updateRetrievalCardStatus('rerank', false);
        }
    });
}

async function testOcrConnection(options = {}) {
    const { fromCard = false } = options;
    const rawUrl = document.getElementById('setting-ocr-service-url')?.value.trim() || '';
    let serviceUrl = fromCard ? '' : (rawUrl === '********' ? '' : rawUrl);
    const statusEl = document.getElementById('setting-ocr-test-status');
    if (!fromCard && !rawUrl) return showToast('请先填写 OCR 服务地址', 'error');

    await runRetrievalTest(options, 'ocr-service-test-btn', async () => {
        if (statusEl) {
            statusEl.className = 'model-modal-desc retrieval-config-status is-loading';
            statusEl.textContent = '正在检测外部 OCR 服务连接，请稍候…';
        }
        showToast('正在检测 OCR 服务连接…', 'info');
        try {
            const res = await apiFetch(`${API_BASE}/settings/ocr-test`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ serviceUrl })
            });
            const data = await res.json().catch(() => ({}));
            if (data.engines) window.Pivot.ocrEngineStatus = data.engines;
            if (!res.ok || data.success !== true) throw new Error(data.message || data.error || 'OCR 服务连接失败');
            if (statusEl) {
                statusEl.className = 'model-modal-desc retrieval-config-status is-success';
                statusEl.textContent = '连接成功：外部 OCR 服务状态正常，已支持 HTTP 识别接口。';
            }
            showToast('OCR 服务连接成功', 'success');
            updateRetrievalCardStatus('ocr', true, '服务可用 · 连通测试成功');
        } catch (error) {
            if (statusEl) {
                statusEl.className = 'model-modal-desc retrieval-config-status is-error';
                statusEl.textContent = `连接失败：${error.message}`;
            }
            showToast(error.message || 'OCR 服务连接失败', 'error');
            updateRetrievalCardStatus('ocr', false, `不可用：${error.message}`);
        }
    });
}

window.Pivot.legacy.bindEmbeddingModalEvents = function() {
    const serviceCards = document.getElementById('retrieval-model-services-body');
    const testBtn = document.getElementById('rag-embedding-test-btn');
    const rerankTestBtn = document.getElementById('rag-rerank-test-btn');
    const ocrTestBtn = document.getElementById('ocr-service-test-btn');
    const fetchModelsBtn = document.getElementById('rag-embedding-fetch-models-btn');
    const embeddingModelSelect = document.getElementById('setting-rag-embedding-model-select');
    const embeddingModelInput = document.getElementById('setting-rag-embedding-model');
    const modals = Object.entries(RETRIEVAL_CONFIG_SECTIONS).map(([section, config]) => ({
        section,
        modal: document.getElementById(config.modalId)
    })).filter(item => item.modal);
    if (!modals.length) return;

    // 服务卡片会在加载、保存和分页后重新渲染。委托给稳定的父容器，避免新按钮
    // 因渲染时序而失去点击事件。
    if (serviceCards && serviceCards.dataset.boundRetrievalModelActions !== '1') {
        serviceCards.dataset.boundRetrievalModelActions = '1';
        serviceCards.dataset.boundEmbeddingOpen = '1';
        serviceCards.addEventListener('click', event => {
            const testButton = event.target?.closest?.('[data-retrieval-model-test]');
            if (testButton && serviceCards.contains(testButton)) {
                event.preventDefault();
                const serviceKey = testButton.dataset.retrievalModelTest;
                if (serviceKey === 'embedding') {
                    testEmbeddingConnection({ fromCard: true, button: testButton });
                } else if (serviceKey === 'rerank') {
                    testRerankConnection({ fromCard: true, button: testButton });
                } else if (serviceKey === 'ocr') {
                    testOcrConnection({ fromCard: true, button: testButton });
                }
                return;
            }
            const openButton = event.target?.closest?.('[data-retrieval-model-config-open]');
            if (!openButton || !serviceCards.contains(openButton)) return;
            event.preventDefault();
            openRetrievalModelConfigSection(openButton.dataset.retrievalModelConfigOpen);
        });
    }
    document.querySelectorAll('[data-retrieval-modal-cancel]').forEach(button => {
        if (button.dataset.boundRetrievalModalCancel === '1') return;
        button.dataset.boundRetrievalModalCancel = '1';
        button.addEventListener('click', () => {
            const section = getRetrievalConfigSection(button.dataset.retrievalModalCancel);
            setRetrievalModelModalVisibility(document.getElementById(RETRIEVAL_CONFIG_SECTIONS[section].modalId), false);
        });
    });
    document.querySelectorAll('[data-retrieval-config-save]').forEach(button => {
        if (button.dataset.boundRetrievalConfigSave === '1') return;
        button.dataset.boundRetrievalConfigSave = '1';
        button.addEventListener('click', () => saveEmbeddingSettings(button.dataset.retrievalConfigSave));
    });
    modals.forEach(({ modal }) => {
        if (modal.dataset.boundRetrievalModalOverlay === '1') return;
        modal.dataset.boundRetrievalModalOverlay = '1';
        modal.addEventListener('click', event => { if (event.target === modal) setRetrievalModelModalVisibility(modal, false); });
    });
    if (testBtn) testBtn.onclick = () => testEmbeddingConnection();
    if (rerankTestBtn) rerankTestBtn.onclick = () => testRerankConnection();
    if (ocrTestBtn) ocrTestBtn.onclick = () => testOcrConnection();
    if (fetchModelsBtn) fetchModelsBtn.onclick = () => fetchEmbeddingModels();
    if (embeddingModelSelect) embeddingModelSelect.onchange = (e) => { if (embeddingModelInput && e.target.value) embeddingModelInput.value = e.target.value; };
    const bindPasswordToggle = (toggleId, inputId) => {
        const toggle = document.getElementById(toggleId), input = document.getElementById(inputId);
        if (toggle && input) toggle.onclick = () => { const isPassword = input.type === 'password'; input.type = isPassword ? 'text' : 'password'; toggle.style.color = isPassword ? 'var(--primary)' : 'var(--text-muted)'; };
    };
    bindPasswordToggle('rag-embedding-key-toggle', 'setting-rag-embedding-key');
    bindPasswordToggle('rag-rerank-key-toggle', 'setting-rag-rerank-key');
    const bindPresetChips = (selector, inputSelector, dataKey) => {
        document.querySelectorAll(selector).forEach(chip => {
            if (chip.dataset.boundPreset === '1') return;
            chip.dataset.boundPreset = '1';
            chip.addEventListener('click', () => {
                const targetInput = document.querySelector(inputSelector);
                if (targetInput) { targetInput.value = chip.dataset[dataKey]; targetInput.focus(); }
            });
        });
    };
    bindPresetChips('[data-embedding-preset-model]', '#setting-rag-embedding-model', 'embeddingPresetModel');
    bindPresetChips('[data-rerank-preset-model]', '#setting-rag-rerank-model', 'rerankPresetModel');
};

document.addEventListener('input', event => {
    if (event.target?.id === 'setting-rag-chunk-size' || event.target?.id === 'setting-rag-chunk-overlap') updateRagChunkOverlapLimit();
});

window.Pivot.legacy.bindRagDebugModalEvents = function() {
    const openBtn = document.getElementById('rag-debug-modal-open-btn');
    const closeBtn = document.getElementById('rag-debug-modal-close');
    const modal = document.getElementById('rag-debug-modal');
    if (!openBtn || !modal) return;

    openBtn.onclick = () => {
        window.Pivot.legacy.setKnowledgeModalVisibility?.(modal, true, { focusSelector: '#rag-debug-query' });
        // 如果是空的，自动填充默认参数
        if (window.Pivot.legacy.loadKnowledgeDocs) window.Pivot.legacy.loadKnowledgeDocs();
        window.Pivot.legacy.loadRagDebugHistory?.();
    };
    
    if (closeBtn) {
        closeBtn.onclick = () => window.Pivot.legacy.setKnowledgeModalVisibility?.(modal, false);
    }
    
    modal.onclick = (e) => {
        if (e.target === modal) window.Pivot.legacy.setKnowledgeModalVisibility?.(modal, false);
    };
};

function renderPagination(tab, total, currentPage) {
    const container = document.getElementById(`pagination-${tab}`);
    if (!container) return;
    const tabLimit = tab === 'logs'
        ? Number(pageState.logsLimit || 20)
        : (tab === 'memories' ? Number(pageState.memoriesLimit || 20) : Number(pageState.limit || 15));
    const renderWorkspacePagination = window.Pivot?.moduleApi?.('chat.ui', {})?.renderWorkspacePagination;
    renderWorkspacePagination?.(container, {
        total,
        limit: tabLimit,
        page: currentPage,
        onPageChange: targetPage => window.Pivot.legacy.loadTabData?.(tab, targetPage)
    });
}
