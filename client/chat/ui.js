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

const describeSelectorModel = (model, simple = false) => {
    if (simple) return model.name + (model.user_id ? ' (个人)' : '');
    const parts = [model.name];
    if (model.user_id) parts.push('个人');
    if (Number(model.supports_vision || 0) === 1) parts.push('视觉输入');
    if (model.model_name && model.model_name !== model.name) parts.push(model.model_name);
    const limit = Number(model.daily_token_limit || 0);
    if (limit > 0) parts.push(`每日额度: ${limit.toLocaleString()}`);
    if (!model.user_id && model.allowed_units) parts.push(`可见范围: ${model.allowed_units}`);
    return parts.join(' | ');
};

window.updateContextUsage = (meta = null) => {
    const pill = document.getElementById('context-usage-pill');
    if (!pill) return;
    pill.classList.remove('is-warn', 'is-critical');

    if (!meta) {
        pill.innerText = '上下文 -';
        pill.title = '当前会话上下文用量';
        return;
    }

    const percent = Number(meta.percent || 0);
    const archived = Number(meta.archivedCount || 0);
    const summaryCount = Number(meta.summaryCount || 0);
    pill.innerText = `上下文 ${percent}%`;
    pill.title = `活动 Token: ${Number(meta.activeTokens || 0).toLocaleString()} / ${Number(meta.threshold || 0).toLocaleString()}，已软归档 ${archived} 条，摘要 ${summaryCount} 条`;

    if (meta.status === 'critical') pill.classList.add('is-critical');
    else if (meta.status === 'warn') pill.classList.add('is-warn');
};

window.refreshModelSelector = async function() {
    const selector = document.getElementById('model-selector');
    if (!selector) return;
    const selected = selector.value;

    try {
        const [modelRes, settingsRes] = await Promise.all([
            fetch(`${API_BASE}/models?page=1&limit=100`, { headers: authHeaders() }),
            fetch(`${API_BASE}/settings`, { headers: authHeaders() })
        ]);
        if (!modelRes.ok) throw new Error('Model list failed to load');

        const { data = [] } = await modelRes.json();
        const settings = settingsRes.ok ? await settingsRes.json() : {};
        const defaultModelId = settings.personalDefaultModelId || settings.defaultModelId;
        
        // 只有当 currentUser 存在时才进行过滤
        const models = (window.currentUser && window.currentUser.role === 'admin')
            ? data.filter(model => !model.user_id || model.owner_role === 'admin')
            : data;

        if (models.length === 0) {
            selector.innerHTML = '<option value="">暂无可用模型</option>';
            selector.disabled = true;
            return;
        }

        selector.innerHTML = models.map(model => {
            const isSelected = (selected && String(model.id) === String(selected)) || 
                             (!selected && defaultModelId && String(model.id) === String(defaultModelId));
            const capabilitySuffix = Number(model.supports_vision || 0) === 1 ? ' · 视觉' : '';
            return `<option value="${model.id}" ${isSelected ? 'selected' : ''} title="${escapeSelectorText(describeSelectorModel(model, false))}">${escapeSelectorText(describeSelectorModel(model, true) + capabilitySuffix)}</option>`;
        }).join('');
        selector.disabled = false;

        // 如果之前没有选中值，或者选中的值已不在列表中，尝试恢复默认或第一个
        if (!selector.value && models.length > 0) {
            if (defaultModelId && models.some(m => String(m.id) === String(defaultModelId))) {
                selector.value = defaultModelId;
            } else {
                selector.value = models[0].id;
            }
        }
    } catch (e) {
        console.error('刷新模型列表失败:', e);
        selector.innerHTML = '<option value="">模型列表加载失败</option>';
        selector.disabled = true;
    }
};

// --- 初始化 ---
document.addEventListener('DOMContentLoaded', () => {
    renderCopyright();
    if (window.showAuth) window.showAuth();
});

function renderCopyright() {
    document.querySelectorAll('.copyright-text').forEach(el => {
        el.innerText = APP_COPYRIGHT;
    });
}

// --- 全局图片预览 (支持聊天记录中点击放大) ---
window.closeImageViewer = () => {
    document.getElementById('image-viewer-modal').classList.add('hidden');
    document.getElementById('viewer-img').src = '';
};

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
