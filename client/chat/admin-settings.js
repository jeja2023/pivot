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
        updateEmbeddingSettingsForm(data.embeddingConfig);
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
        max_concurrent_ai_requests: '同时处理的聊天请求数，过大可能影响响应稳定性。',
        max_ai_queue_size: '请求排队上限，队列满后会拒绝新的请求。',
        ai_queue_timeout_ms: '请求在队列里等待多久后自动超时。',
        model_endpoint_default_concurrency: '单个模型端点默认并发量。',
        model_endpoint_queue_size: '单个模型端点的排队长度。',
        model_endpoint_queue_timeout_ms: '模型端点排队等待超时时间。',
        model_context_window_tokens: '没有单独配置上下文时使用的全局默认窗口。',
        context_reserved_output_tokens: '为输出预留的 token 数，避免把回答空间压得太小。',
        memory_threshold: '会话活跃 token 超过此值时触发自动压缩提炼。',
        sampling_temperature: '温度越高越发散，越低越稳定。',
        sampling_top_p: '采样概率上限，常和温度配合调节。',
        sampling_presence_penalty: '减少反复提同一内容的倾向。',
        sampling_frequency_penalty: '减少高频重复词的倾向。',
        upload_attachment_max_bytes: '聊天附件的总上传上限。',
        knowledge_upload_max_bytes: '知识库文件的总上传上限。',
        image_upload_max_bytes: '单张图片在上传阶段的大小上限。',
        image_context_max_bytes: '图片进入模型上下文前允许携带的大小上限。',
        max_attachments_per_message: '用户输入框中一条消息最多保留的待发送附件数量。',
        max_images_per_message: '一条消息允许注入的图片数量上限。',
        attachment_context_max_chars: '附件抽取文本写入上下文时的字符上限。',
        knowledge_extract_max_chars: '知识库文件抽取文本时的字符上限。',
        rag_top_k_max: '每次检索最多返回多少条结果。',
        rag_candidate_limit_max: '候选片段池的最大数量。',
        rag_chunk_size_max: '检索切片的最大字符数。',
        rag_context_budget_percent: 'RAG 在上下文中可占用的大致比例。',
        rag_index_max_concurrent: '同时执行多少个知识库索引任务。',
        agent_max_concurrent_runs: '同一时间允许多少个智能体任务运行。',
        agent_dag_node_concurrency: '工作流 DAG 节点的并发执行数。',
        chat_auto_agent_enabled: '关闭后用户不能选择聊天 Agent 执行模式；普通回答、手工 Agent 和工作流仍可使用。',
        memory_compression_max_concurrent: '后台同时压缩多少个记忆任务。'
    };
    return hintMap[item?.key] || '';
}

function isRuntimeHumanIntKey(key) {
    return new Set([
        'model_context_window_tokens',
        'context_reserved_output_tokens',
        'memory_threshold',
        'upload_attachment_max_bytes',
        'knowledge_upload_max_bytes',
        'image_upload_max_bytes',
        'image_context_max_bytes',
        'attachment_context_max_chars',
        'knowledge_extract_max_chars',
        'rag_candidate_limit_max',
        'rag_chunk_size_max'
    ]).has(key);
}

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
window.Pivot.moduleApi('settings.events').registerAdminSettingsEvents(() => {
const memory = window.Pivot.moduleApi('settings.memory', {});
document.getElementById('runtime-settings-page-save')?.addEventListener('click', event => window.Pivot.legacy.saveRuntimeSettings?.(event));
document.getElementById('runtime-settings-page-refresh')?.addEventListener('click', () => window.Pivot.legacy.loadSettings?.());
document.getElementById('memory-refresh-btn')?.addEventListener('click', () => window.Pivot.legacy.loadMemories?.());
document.getElementById('long-term-memory-toggle')?.addEventListener('change', (event) => {
    window.Pivot.legacy.updateLongTermMemoryEnabled?.(event.target.checked === true);
});

document.getElementById('memory-merge-suggestions-btn')?.addEventListener('click', () => window.Pivot.legacy.loadMemoryMergeSuggestions?.());
document.getElementById('memory-export-btn')?.addEventListener('click', () => window.Pivot.legacy.exportMemories?.());
document.getElementById('memory-search-input')?.addEventListener('input', () => {
    clearTimeout(window.Pivot.legacy.memorySearchTimer);
    window.Pivot.legacy.memorySearchTimer = setTimeout(() => window.Pivot.legacy.loadMemories?.(1), 250);
});
document.getElementById('memory-status-filter')?.addEventListener('change', () => window.Pivot.legacy.loadMemories?.(1));
document.getElementById('memory-type-filter')?.addEventListener('change', () => window.Pivot.legacy.loadMemories?.(1));
document.getElementById('memory-archive-expired-btn')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
        const data = await memory.archiveExpiredMemories();
        showToast(`已归档 ${Number(data.archived || 0)} 条过期记忆`);
        await window.Pivot.legacy.loadMemories?.();
    } catch (e) {
        showToast(e.message || '过期记忆归档失败', 'error');
    } finally {
        button.disabled = false;
    }
});
document.getElementById('memory-select-all')?.addEventListener('change', (event) => {
    document.querySelectorAll('[data-memory-select]').forEach(input => {
        input.checked = event.target.checked === true;
    });
});
document.getElementById('memory-bulk-enable-btn')?.addEventListener('click', async (event) => {
    const ids = memory.selectedMemoryIds();
    if (!ids.length) return showToast('请先选择记忆', 'warning');
    const button = event.currentTarget;
    button.disabled = true;
    try {
        await memory.bulkUpdateMemoryStatus(ids, 'active');
        showToast('选中记忆已恢复');
        await window.Pivot.legacy.loadMemories?.();
    } catch (error) {
        showToast(error.message || '批量恢复失败', 'error');
    } finally {
        button.disabled = false;
    }
});
document.getElementById('memory-bulk-disable-btn')?.addEventListener('click', async (event) => {
    const ids = memory.selectedMemoryIds();
    if (!ids.length) return showToast('请先选择记忆', 'warning');
    const button = event.currentTarget;
    button.disabled = true;
    try {
        await memory.bulkUpdateMemoryStatus(ids, 'disabled');
        showToast('选中记忆已禁用');
        await window.Pivot.legacy.loadMemories?.();
    } catch (error) {
        showToast(error.message || '批量禁用失败', 'error');
    } finally {
        button.disabled = false;
    }
});
document.getElementById('memory-bulk-delete-btn')?.addEventListener('click', async (event) => {
    const ids = memory.selectedMemoryIds();
    if (!ids.length) return showToast('请先选择记忆', 'warning');
    const button = event.currentTarget;
    button.disabled = true;
    try {
        await memory.bulkUpdateMemoryStatus(ids, 'deleted');
        showToast('选中记忆已删除');
        await window.Pivot.legacy.loadMemories?.();
    } catch (error) {
        showToast(error.message || '批量删除失败', 'error');
    } finally {
        button.disabled = false;
    }
});
document.getElementById('memory-jobs-panel')?.addEventListener('click', async (event) => {
    const retryButton = event.target?.closest?.('#memory-jobs-retry-btn');
    const cleanupButton = event.target?.closest?.('#memory-jobs-cleanup-btn');
    if (!retryButton && !cleanupButton) return;
    const button = retryButton || cleanupButton;
    button.disabled = true;
    try {
        if (retryButton) {
            await memory.retryMemoryJobs();
            showToast('失败任务已重新入队');
        } else {
            const data = await memory.cleanupMemoryJobs();
            showToast(`已清理 ${Number(data.deleted || 0)} 个旧任务`);
        }
        await window.Pivot.legacy.loadMemories?.();
    } catch (e) {
        showToast(e.message || '任务维护失败', 'error');
    } finally {
        button.disabled = false;
    }
});
document.getElementById('memory-list-body')?.addEventListener('click', async (event) => {
    const button = event.target?.closest?.('[data-memory-action]');
    if (!button) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const memoryId = button.dataset.memoryId;
    const action = button.dataset.memoryAction;
    button.disabled = true;
    try {
        if (action === 'edit') {
            const selectedMemory = memory.getCurrentMemory(memoryId);
            if (!selectedMemory) throw new Error('记忆数据已刷新，请重新加载后再编辑');
            window.Pivot.legacy.openMemoryEditModal?.(selectedMemory);
        } else if (action === 'source') {
            await window.Pivot.legacy.openMemorySourceModal?.(memoryId);
        } else if (action === 'usage') {
            await memory.openMemoryUsageModal(memoryId);
        } else if (action === 'disable') {
            await memory.updateMemoryStatus(memoryId, 'disabled');
            showToast('长期记忆已禁用');
            await window.Pivot.legacy.loadMemories?.();
        } else if (action === 'restore') {
            await memory.updateMemoryStatus(memoryId, 'active');
            showToast('长期记忆已恢复');
            await window.Pivot.legacy.loadMemories?.();
        } else if (action === 'delete') {
            await memory.deleteMemory(memoryId);
            showToast('长期记忆已删除');
            await window.Pivot.legacy.loadMemories?.();
        }
    } catch (e) {
        showToast(e.message || '长期记忆操作失败', 'error');
    } finally {
        button.disabled = false;
    }
}, true);
document.getElementById('memory-edit-cancel')?.addEventListener('click', () => window.Pivot.legacy.closeMemoryEditModal?.());
document.getElementById('memory-edit-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const saveButton = document.getElementById('memory-edit-save');
    if (saveButton) saveButton.disabled = true;
    const memoryId = document.getElementById('memory-edit-id')?.value;
    try {
        await memory.saveMemory(memoryId, {
            type: document.getElementById('memory-edit-type')?.value,
            content: document.getElementById('memory-edit-content')?.value,
            salience: Number(document.getElementById('memory-edit-salience')?.value),
            confidence: Number(document.getElementById('memory-edit-confidence')?.value)
        });
        showToast('长期记忆已保存');
        window.Pivot.legacy.closeMemoryEditModal?.();
        await window.Pivot.legacy.loadMemories?.();
    } catch (e) {
        showToast(e.message || '记忆保存失败', 'error');
    } finally {
        if (saveButton) saveButton.disabled = false;
    }
});
document.getElementById('memory-source-close')?.addEventListener('click', () => window.Pivot.legacy.closeMemorySourceModal?.());
document.getElementById('memory-merge-panel')?.addEventListener('click', async (event) => {
    const button = event.target?.closest?.('[data-memory-merge-target]');
    if (!button) return;
    button.disabled = true;
    try {
        await memory.mergeMemoryPair(button.dataset.memoryMergeTarget, button.dataset.memoryMergeSource);
        showToast('长期记忆已合并');
        await window.Pivot.legacy.loadMemories?.();
        await window.Pivot.legacy.loadMemoryMergeSuggestions?.();
    } catch (e) {
        showToast(e.message || '记忆合并失败', 'error');
    } finally {
        button.disabled = false;
    }
});
document.getElementById('memory-edit-modal')?.addEventListener('click', (event) => {
    if (event.target?.id === 'memory-edit-modal') window.Pivot.legacy.closeMemoryEditModal?.();
});
document.getElementById('memory-source-modal')?.addEventListener('click', (event) => {
    if (event.target?.id === 'memory-source-modal') window.Pivot.legacy.closeMemorySourceModal?.();
});
});
window.Pivot.legacy.fetchEmbeddingModels = async () => {
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
    if (embeddingModelSelect) PivotSafeHtml.setHtml(embeddingModelSelect, '');
    if (embeddingModelSelectContainer) embeddingModelSelectContainer.classList.add('hidden');
    if (embeddingStatusEl) {
        const keyStatus = embeddingConfig?.hasApiKey ? '已配置 API Key' : '未配置 API Key';
        const source = embeddingConfig?.isPersonal ? '个人配置'
            : embeddingConfig?.source?.url === 'settings' ? '系统默认'
            : '环境变量/默认值';
        embeddingStatusEl.innerText = `HTTP 服务 · ${keyStatus} · 来源：${source}`;
    }
    setSettingsInitialValues('#setting-rag-embedding-url, #setting-rag-embedding-model');
}

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
        const res = await apiFetch(endpoint, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '系统设置保存失败');
        if (scoreInput) scoreInput.value = data.ragConfig?.scoreThreshold ?? scoreInput.value;
        if (topKInput) topKInput.value = data.ragConfig?.topK ?? topKInput.value;
        if (candidateInput) candidateInput.value = data.ragConfig?.candidateLimit ?? candidateInput.value;
        if (chunkSizeInput) chunkSizeInput.value = data.ragConfig?.chunkSize ?? chunkSizeInput.value;
        if (chunkOverlapInput) chunkOverlapInput.value = data.ragConfig?.chunkOverlap ?? chunkOverlapInput.value;
        updateEmbeddingSettingsForm(data.embeddingConfig);
        setSettingsInitialValues('#setting-rag-score-threshold, #setting-rag-top-k, #setting-rag-candidate-limit, #setting-rag-chunk-size, #setting-rag-chunk-overlap');
        showToast(isSuperAdminUser() ? '系统设置已保存' : '个人设置已保存');
    } catch (e) {
        showToast(e.message || '系统设置保存失败', 'error');
    }
};

window.Pivot.legacy.saveEmbeddingSettings = async () => {
    const embeddingModeInput = document.getElementById('setting-rag-embedding-mode');
    const embeddingUrlInput = document.getElementById('setting-rag-embedding-url');
    const embeddingModelInput = document.getElementById('setting-rag-embedding-model');
    const embeddingKeyInput = document.getElementById('setting-rag-embedding-key');
    const saveBtn = document.getElementById('rag-embedding-save-btn');
    const modal = document.getElementById('rag-embedding-modal');
    if (!embeddingUrlInput || !embeddingModelInput) return;
    if (saveBtn) saveBtn.disabled = true;
    try {
        updateRagChunkOverlapLimit();
        validateRagSettings();
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
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '检索配置保存失败');
        updateEmbeddingSettingsForm(data.embeddingConfig);
        setSettingsInitialValues('#setting-rag-score-threshold, #setting-rag-top-k, #setting-rag-candidate-limit, #setting-rag-chunk-size, #setting-rag-chunk-overlap');
        showToast(isSuperAdminUser() ? '系统检索配置已保存' : '个人检索配置已保存');
        if (modal) window.Pivot.legacy.setKnowledgeModalVisibility?.(modal, false);
    } catch (e) {
        showToast(e.message || '检索配置保存失败', 'error');
    } finally {
        if (saveBtn) saveBtn.disabled = false;
    }
};
window.Pivot.legacy.testEmbeddingConnection = async () => {
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
        console.error('测试连接失败:', e);
    } finally {
        if (testBtn) testBtn.disabled = false;
    }
};

window.Pivot.legacy.bindEmbeddingModalEvents = function() {
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
            window.Pivot.legacy.setKnowledgeModalVisibility?.(modal, true, { focusSelector: '#setting-rag-score-threshold' });
        });
    }
    if (cancelBtn && cancelBtn.dataset.boundEmbeddingCancel !== '1') {
        cancelBtn.dataset.boundEmbeddingCancel = '1';
        cancelBtn.addEventListener('click', () => window.Pivot.legacy.setKnowledgeModalVisibility?.(modal, false));
    }
    
    if (testBtn) {
        testBtn.onclick = () => window.Pivot.legacy.testEmbeddingConnection();
    }
    if (fetchModelsBtn) {
        fetchModelsBtn.onclick = () => window.Pivot.legacy.fetchEmbeddingModels();
    }
    const saveBtn = document.getElementById('rag-embedding-save-btn');
    if (saveBtn) {
        saveBtn.onclick = () => window.Pivot.legacy.saveEmbeddingSettings();
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

document.addEventListener('input', event => {
    if (event.target?.id === 'setting-rag-chunk-size') updateRagChunkOverlapLimit();
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
    const renderWorkspacePagination = window.Pivot?.moduleApi?.('chat.ui', {})?.renderWorkspacePagination;
    renderWorkspacePagination?.(container, {
        total,
        limit: pageState.limit,
        page: currentPage,
        onPageChange: targetPage => window.Pivot.legacy.loadTabData?.(tab, targetPage)
    });
}
