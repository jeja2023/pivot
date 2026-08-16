// --- 全局组件: Toast ---
function showToast(message, type = 'success') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerText = message;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
}

const escapeSelectorText = (str) => {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
};

function renderWorkspacePagination(containerOrId, options = {}) {
    const container = typeof containerOrId === 'string' ? document.getElementById(containerOrId) : containerOrId;
    if (!container) return;
    const total = Math.max(Number(options.total || 0), 0);
    const limit = Math.max(Number(options.limit || 10), 1);
    const page = Math.max(Number(options.page || 1), 1);
    const totalPages = Math.max(Math.ceil(total / limit), 1);
    const onPageChange = typeof options.onPageChange === 'function' ? options.onPageChange : null;
    container.replaceChildren();
    if (totalPages <= 1) return;

    const createButton = (label, targetPage, disabled) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'btn-secondary';
        button.disabled = disabled;
        button.textContent = label;
        button.addEventListener('click', () => {
            if (!button.disabled && onPageChange) onPageChange(targetPage);
        });
        return button;
    };

    const summary = document.createElement('span');
    summary.textContent = `第 ${page} / ${totalPages} 页（共 ${total} 条，每页 ${limit} 条）`;
    container.append(
        createButton('首页', 1, page <= 1),
        createButton('上一页', page - 1, page <= 1),
        summary,
        createButton('下一页', page + 1, page >= totalPages),
        createButton('末页', totalPages, page >= totalPages)
    );
};

const describeSelectorModel = (model, simple = false) => {
    if (simple) {
        let suffix = '';
        if (Number(model.supports_vision || 0) === 1) suffix += ' 👁️';
        if (Number(model.supports_reasoning || 0) === 1) suffix += ' 🧠';
        return model.name + (model.user_id ? ' (个人)' : '') + suffix;
    }
    const parts = [model.name];
    if (model.user_id) parts.push('个人');
    if (Number(model.supports_vision || 0) === 1) parts.push('视觉输入');
    if (Number(model.supports_reasoning || 0) === 1) parts.push('思考模型');
    if (model.model_name && model.model_name !== model.name) parts.push(model.model_name);
    const limit = Number(model.daily_token_limit || 0);
    if (limit > 0) parts.push(`每日额度: ${limit.toLocaleString()}`);
    if (!model.user_id && model.allowed_units) parts.push(`可见范围: ${model.allowed_units}`);
    return parts.join(' | ');
};

function updateContextUsage(meta = null) {
    const pill = document.getElementById('context-usage-pill');
    const ring = document.getElementById('context-usage-ring');
    if (!pill || !ring) return;

    pill.classList.remove('is-warn', 'is-critical');

    if (!meta) {
        ring.style.setProperty('--progress', '0');
        pill.dataset.tooltip = '上下文用量: -';
        pill.removeAttribute('title');
        pill.setAttribute('aria-label', '当前会话上下文用量，点击手动压缩');
        return;
    }

    const percent = Math.min(100, Math.max(0, Number(meta.percent || 0)));
    const archived = Number(meta.archivedCount || 0);
    const summaryCount = Number(meta.summaryCount || 0);
    const active = Number(meta.activeTokens || 0).toLocaleString();
    const limit = Number(meta.threshold || 0).toLocaleString();

    ring.style.setProperty('--progress', percent);
    const tooltipParts = [`上下文用量: ${percent}% (已用 ${active}, 阈值 ${limit})`];
    
    if (archived > 0 || summaryCount > 0) {
        tooltipParts.push(`归档: ${archived}, 摘要: ${summaryCount}`);
    }
    tooltipParts.push('点击手动压缩');
    const tooltipText = tooltipParts.join(' | ');
    pill.dataset.tooltip = tooltipText;
    pill.removeAttribute('title');
    pill.setAttribute('aria-label', tooltipText);

    if (meta.status === 'critical') pill.classList.add('is-critical');
    else if (meta.status === 'warn') pill.classList.add('is-warn');
};

async function compactCurrentSessionContext() {
    const pill = document.getElementById('context-usage-pill');
    if (!currentSessionId) return showToast('请先选择一个会话', 'warning');
    if (pill?.classList.contains('is-busy')) return;
    const modelId = document.getElementById('model-selector')?.value || null;
    try {
        pill?.classList.add('is-busy');
        if (pill) {
            pill.disabled = true;
            pill.dataset.tooltip = '正在压缩上下文...';
        }
        const res = await apiFetch(`${API_BASE}/sessions/${encodeURIComponent(currentSessionId)}/compact`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ modelId })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '上下文压缩失败');
        updateContextUsage(data.contextMeta || null);
        showToast(data.message || (data.compressed ? '上下文已压缩' : '当前没有可压缩内容'), data.compressed ? 'success' : (data.inProgress ? 'warning' : 'info'));
        if (data.compressed && currentSessionId) await window.selectSession?.(currentSessionId);
    } catch (e) {
        showToast(e.message || '上下文压缩失败', 'error');
        await window.refreshCurrentContextUsage?.();
    } finally {
        pill?.classList.remove('is-busy');
        if (pill) pill.disabled = false;
    }
};

function isSelectableModelForCurrentUser(model) {
    if (!model?.user_id) return true;
    return String(model.user_id) === String(currentUser?.id);
}


function applyUploadRuntimeLimits(limits = {}) {
    const maxAttachments = limits?.maxAttachmentsPerMessage;
    if (maxAttachments !== undefined && typeof window.setMaxPendingAttachments === 'function') {
        window.setMaxPendingAttachments(maxAttachments);
    } else if (maxAttachments !== undefined) {
        window.MAX_PENDING_ATTACHMENTS = maxAttachments;
    }
};

async function loadSelectableModels() {
    const [modelRes, settingsRes] = await Promise.all([
        apiFetch(`${API_BASE}/models?page=1&limit=100`, { headers: authHeaders() }),
        apiFetch(`${API_BASE}/settings`, { headers: authHeaders() })
    ]);
    if (!modelRes.ok) throw new Error('Model list failed to load');

    const { data = [] } = await modelRes.json();
    window._cachedModels = data;
    const settings = settingsRes.ok ? await settingsRes.json() : {};
    applyUploadRuntimeLimits(settings.uploadLimits);
    const defaultModelId = settings.personalDefaultModelId || settings.defaultModelId;

    const models = data.filter(isSelectableModelForCurrentUser);

    return { models, defaultModelId, settings };
};

async function refreshModelSelector() {
    const hiddenInput = document.getElementById('model-selector');
    const triggerBtn = document.getElementById('model-selector-btn');
    const dropdownList = document.getElementById('model-dropdown-list');
    if (!hiddenInput || !triggerBtn || !dropdownList) return;

    try {
        const { models, defaultModelId } = await loadSelectableModels();

        if (models.length === 0) {
            PivotSafeHtml.setHtml(triggerBtn, '<span id="selected-model-name">暂无可用模型</span>');
            triggerBtn.disabled = true;
            return;
        }

        PivotSafeHtml.setHtml(dropdownList, models.map(model => {
            const hasVision = Number(model.supports_vision || 0) === 1;
            const hasReasoning = Number(model.supports_reasoning || 0) === 1;
            const meta = describeSelectorModel(model, false).split(' | ').slice(1).join(' | ');

            const textIcon = `
                <div class="cap-icon text" title="文本模型">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h10"/></svg>
                </div>`;
            
            const visionIcon = hasVision ? `
                <div class="cap-icon vision" title="支持视觉输入">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>
                </div>` : '';
            const reasoningIcon = hasReasoning ? `
                <div class="cap-icon reasoning" title="支持推理/思考">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M9 18h6"/><path d="M10 22h4"/><path d="M15 14c.2-1 .7-1.7 1.5-2.5A5 5 0 1 0 7.5 11.5C8.3 12.3 8.8 13 9 14"/></svg>
                </div>` : '';
            
            return `
                <div class="model-item" data-id="${model.id}">
                    <div class="model-item-header">
                        <span class="model-item-name">${escapeSelectorText(model.name)}${model.user_id ? ' (个人)' : ''}</span>
                        <div class="model-item-caps">
                            ${textIcon}${visionIcon}${reasoningIcon}
                        </div>
                    </div>
                    <div class="model-item-meta">${escapeSelectorText(meta)}</div>
                </div>
            `;
        }).join(''));
        dropdownList.querySelectorAll('.model-item').forEach(item => {
            item.addEventListener('click', () => selectDropdownModel(item.dataset.id));
        });

        let initialId = hiddenInput.value;
        if (!initialId || !models.some(m => String(m.id) === String(initialId))) {
            initialId = (defaultModelId && models.some(m => String(m.id) === String(defaultModelId))) ? defaultModelId : models[0].id;
        }
        selectDropdownModel(initialId, false);
        
    } catch (e) {
        console.error('刷新模型列表失败:', e);
        PivotSafeHtml.setHtml(triggerBtn, '<span id="selected-model-name">列表加载失败</span>');
    }
};

function setModelDropdownOpen(open) {
    const container = document.getElementById('model-selector-container');
    const trigger = document.getElementById('model-selector-btn');
    const dropdown = document.getElementById('model-dropdown-list');
    if (!container || !trigger || !dropdown) return;
    container.classList.toggle('is-open', open);
    dropdown.classList.toggle('hidden', !open);
    trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) {
        const active = dropdown.querySelector('.model-item.active') || dropdown.querySelector('.model-item');
        active?.classList.add('is-keyboard-active');
        active?.scrollIntoView({ block: 'nearest' });
    } else {
        dropdown.querySelectorAll('.model-item.is-keyboard-active').forEach(item => item.classList.remove('is-keyboard-active'));
    }
}

function moveModelDropdownActive(delta) {
    const dropdown = document.getElementById('model-dropdown-list');
    const items = Array.from(dropdown?.querySelectorAll('.model-item') || []);
    if (items.length === 0) return;
    let index = items.findIndex(item => item.classList.contains('is-keyboard-active'));
    if (index < 0) index = items.findIndex(item => item.classList.contains('active'));
    const nextIndex = (Math.max(index, 0) + delta + items.length) % items.length;
    items.forEach(item => item.classList.remove('is-keyboard-active'));
    items[nextIndex].classList.add('is-keyboard-active');
    items[nextIndex].scrollIntoView({ block: 'nearest' });
}

function selectDropdownModel(id, shouldClose = true) {
    const hiddenInput = document.getElementById('model-selector');
    const models = window._cachedModels || [];
    const model = models.find(m => String(m.id) === String(id));
    if (!model) return;

    hiddenInput.value = id;
    document.getElementById('selected-model-name').innerText = model.name + (model.user_id ? ' (个人)' : '');
    
    const hasVision = Number(model.supports_vision || 0) === 1;

    document.querySelectorAll('.model-item').forEach(el => {
        el.classList.toggle('active', String(el.dataset.id) === String(id));
        el.classList.toggle('is-keyboard-active', String(el.dataset.id) === String(id));
    });

    // 更新上传按钮状态
    const uploadBtn = document.getElementById('upload-btn');
    if (uploadBtn) {
        if (hasVision) {
            uploadBtn.style.opacity = '1';
            uploadBtn.style.cursor = 'pointer';
            uploadBtn.title = '上传附件 (图片、文档)';
        } else {
            uploadBtn.style.opacity = '0.4';
            uploadBtn.style.cursor = 'not-allowed';
            uploadBtn.title = '当前模型不支持附件 (请切换至视觉模型)';
        }
    }

    if (window.pendingAttachments && window.pendingAttachments.length > 0 && !hasVision) {
        showToast('警告：当前模型不支持已添加的附件，发送将受限', 'warning');
    }

    if (shouldClose) {
        setModelDropdownOpen(false);
    }
    hiddenInput.dispatchEvent(new Event('change'));
};

// --- 初始化 ---
document.addEventListener('DOMContentLoaded', () => {
    renderCopyright();
    if (window.showAuth) window.showAuth();
    
    const container = document.getElementById('model-selector-container');
    const trigger = document.getElementById('model-selector-btn');
    const dropdown = document.getElementById('model-dropdown-list');
    
    if (trigger && dropdown) {
        trigger.setAttribute('aria-haspopup', 'listbox');
        trigger.setAttribute('aria-expanded', 'false');
        trigger.addEventListener('click', (e) => {
            e.stopPropagation();
            setModelDropdownOpen(!container.classList.contains('is-open'));
        });
        trigger.addEventListener('keydown', (e) => {
            const isOpen = container.classList.contains('is-open');
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                setModelDropdownOpen(true);
                moveModelDropdownActive(e.key === 'ArrowDown' ? 1 : -1);
                return;
            }
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                if (!isOpen) {
                    setModelDropdownOpen(true);
                    return;
                }
                const active = dropdown.querySelector('.model-item.is-keyboard-active') || dropdown.querySelector('.model-item.active');
                if (active) selectDropdownModel(active.dataset.id);
                return;
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                setModelDropdownOpen(false);
            }
        });
        
        document.addEventListener('click', (e) => {
            if (!container.contains(e.target)) {
                setModelDropdownOpen(false);
            }
        });
    }
});

function renderCopyright() {
    document.querySelectorAll('.copyright-text').forEach(el => {
        el.innerText = APP_COPYRIGHT;
    });
}

// --- 全局图片预览 (支持聊天记录中点击放大) ---
function closeImageViewer() {
    document.getElementById('image-viewer-modal').classList.add('hidden');
    document.getElementById('viewer-img').src = '';
}

window.Pivot.exposeModule('chat.ui', {
    applyUploadRuntimeLimits,
    closeImageViewer,
    compactCurrentSessionContext,
    describeSelectorModel,
    isSelectableModelForCurrentUser,
    loadSelectableModels,
    refreshModelSelector,
    renderWorkspacePagination,
    selectDropdownModel,
    updateContextUsage
}, {
    applyUploadRuntimeLimits: 'applyUploadRuntimeLimits',
    closeImageViewer: 'closeImageViewer',
    compactCurrentSessionContext: 'compactCurrentSessionContext',
    isSelectableModelForCurrentUser: 'isSelectableModelForCurrentUser',
    loadSelectableModels: 'loadSelectableModels',
    refreshModelSelector: 'refreshModelSelector',
    renderWorkspacePagination: 'renderWorkspacePagination',
    selectDropdownModel: 'selectDropdownModel',
    updateContextUsage: 'updateContextUsage'
});

// 使用事件委托，监听聊天区域内所有的图片点击
document.addEventListener('DOMContentLoaded', () => {
    const msgContainer = document.getElementById('message-container');
    if (msgContainer) {
        msgContainer.addEventListener('click', (e) => {
            if (e.target.tagName === 'IMG') {
                const viewer = document.getElementById('image-viewer-modal');
                const viewerImg = document.getElementById('viewer-img');
                viewerImg.src = e.target.src; // 获取被点击图片的真实地址
                viewer.classList.remove('hidden');
            }
        });
    }
});
