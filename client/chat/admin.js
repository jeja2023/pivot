// --- 管理员面板核心逻辑 Admin Core ---
/* exported formatDateToCN, escapeHtml, renderTableMessage, escapeCsvValue, formatTokenAmount, formatTokenCount, formatTokenInputValue, parseTokenAmount, encodeActionArg, downloadFileByFetch, renderPagination */
const formatDateToCN = (dateStr) => {
    if (!dateStr) return '-';
    const text = String(dateStr).trim();
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)) return text;
    const date = new Date(text);
    if (Number.isNaN(date.getTime())) return text;
    return date.toLocaleString('zh-CN', { 
        timeZone: 'Asia/Shanghai', 
        hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
    }).replace(/\//g, '-');
};

const escapeHtml = (str) => {
    if (str === 0) return '0';
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
};

function renderTableMessage(tbody, colspan, message, options = {}) {
    if (!tbody) return;
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = colspan;
    td.className = options.className || 'text-center';
    td.style.padding = options.padding || '28px';
    if (options.color) td.style.color = options.color;
    td.textContent = message || '';
    tr.appendChild(td);
    tbody.replaceChildren(tr);
}

const escapeCsvValue = (value) => {
    let text = value === undefined || value === null ? '' : String(value);
    if (/^[=+\-@]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
};

function formatTokenAmount(value, options = {}) {
    const { emptyText = '不限', suffix = '' } = options;
    const n = Number(value) || 0;
    if (n <= 0) return emptyText;
    if (n >= 1000000000) return `${(n / 1000000000).toFixed(n >= 10000000000 ? 0 : 1)}B${suffix}`;
    if (n >= 1000000) return `${(n / 1000000).toFixed(n >= 10000000 ? 0 : 1)}M${suffix}`;
    if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}K${suffix}`;
    return `${n.toLocaleString()}${suffix}`;
}

const formatTokenCount = (value, emptyText = '0') => formatTokenAmount(value, { emptyText });

function formatTokenInputValue(value) {
    const n = Number(value) || 0;
    if (n <= 0) return '';
    if (n >= 1000000000) return `${(n / 1000000000).toFixed(n >= 10000000000 ? 0 : 1)}B`;
    if (n >= 1000000) return `${(n / 1000000).toFixed(n >= 10000000 ? 0 : 1)}M`;
    if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}K`;
    return String(n);
}

function parseTokenAmount(value) {
    const text = String(value || '').trim();
    if (!text) return 0;
    const match = text.replace(/,/g, '').match(/^(\d+(?:\.\d+)?)\s*([kKmMbB万亿]?)\s*(?:tokens?)?$/);
    if (!match) return Number(text.replace(/[^\d.]/g, '')) || 0;
    const num = Number(match[1]) || 0;
    const unit = match[2].toLowerCase();
    const multiplier = unit === 'k' ? 1000
        : unit === '万' ? 10000
        : unit === 'm' ? 1000000
        : unit === '亿' ? 100000000
        : unit === 'b' ? 1000000000
        : 1;
    return Math.round(num * multiplier);
}

const encodeActionArg = (value) => encodeURIComponent(JSON.stringify(value))
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29');

const downloadFileByFetch = async (url, filename) => {
    showToast('正在准备导出文件...', 'info');
    try {
        const res = await apiFetch(url);
        if (!res.ok) throw new Error('下载失败');
        const blob = await res.blob();
        const downloadUrl = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = downloadUrl;
        a.download = filename || 'export.csv';
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(downloadUrl);
        a.remove();
        showToast('导出成功');
    } catch (e) {
        showToast('导出失败: ' + e.message, 'error');
    }
};

let pageState = { models: 1, users: 1, logs: 1, details: 1, attachments: 1, apiCallLogs: 1, userRecords: 1, limit: 15 };

const SETTINGS_TABS = ['users', 'models', 'logs', 'monitor', 'stats', 'report', 'keys', 'details', 'prompts', 'attachments', 'ops', 'account'];
const ADMIN_ONLY_SETTINGS_TABS = new Set(['ops', 'users', 'logs', 'monitor', 'report']);

function getDefaultSettingsTab() {
    return currentUser?.role === 'admin' ? 'ops' : 'models';
}

function normalizeSettingsTab(tab) {
    let target = SETTINGS_TABS.includes(tab) ? tab : getDefaultSettingsTab();
    if (ADMIN_ONLY_SETTINGS_TABS.has(target) && currentUser?.role !== 'admin') target = 'models';
    return target;
}

const adminFeatureScripts = [
    '/chat/models.js',
    '/chat/users.js',
    '/chat/stats.js',
    '/chat/extra.js'
];

let adminFeatureLoadPromise = null;

const loadScriptOnce = (src) => new Promise((resolve, reject) => {
    const appVersionTag = document.documentElement?.dataset?.appVersion || window.APP_VERSION_TAG || '';
    const versionTag = appVersionTag && appVersionTag !== '__APP_VERSION__' ? `?v=${encodeURIComponent(appVersionTag)}` : '';
    const versionedSrc = `${src}${versionTag}`;
    const existing = Array.from(document.scripts).find(script => {
        const current = script.getAttribute('src') || '';
        return current === src || current === versionedSrc || current.startsWith(`${src}?`);
    });
    if (existing) {
        resolve();
        return;
    }
    const script = document.createElement('script');
    script.src = versionedSrc;
    script.async = false;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`加载脚本失败: ${src}`));
    document.head.appendChild(script);
});

window.ensureAdminFeatureScripts = async () => {
    if (adminFeatureLoadPromise) return adminFeatureLoadPromise;
    adminFeatureLoadPromise = (async () => {
        for (const src of adminFeatureScripts) {
            await loadScriptOnce(src);
        }
    })();
    try {
        await adminFeatureLoadPromise;
    } catch (e) {
        adminFeatureLoadPromise = null;
        throw e;
    }
};

window.openAdminPanel = async (options = {}) => {
    await window.ensureAdminFeatureScripts();
    const adminContainer = document.getElementById('admin-container');
    window.showMainWorkspace?.('settings');
    adminContainer?.classList.remove('hidden');
    const isAdmin = currentUser?.role === 'admin';
    const isSuperAdmin = currentUser?.username === 'admin';
    const titleEl = adminContainer?.querySelector('.settings-workspace-header h3');
    const descEl = adminContainer?.querySelector('.settings-workspace-header p');
    if (titleEl) titleEl.innerText = isAdmin ? '系统设置' : '个人设置';
    if (descEl) descEl.innerText = isAdmin
        ? '集中管理模型、用户、审计、监控、用量、API 接入与账号安全。'
        : '管理你的模型、指令、附件、用量、API 接入与账号安全。';
    
    if (isAdmin) {
        document.querySelectorAll('.admin-only').forEach(el => el.classList.remove('hidden'));
    } else {
        document.querySelectorAll('.admin-only').forEach(el => el.classList.add('hidden'));
    }
    document.querySelectorAll('.super-admin-only').forEach(el => {
        el.classList.toggle('hidden', !isSuperAdmin);
    });
    await loadSettings();
    const targetTab = options.restore ? normalizeSettingsTab(window.getStoredSettingsTab?.()) : getDefaultSettingsTab();
    await window.switchTab(targetTab);
};

window.closeModal = () => window.showMainWorkspace?.('chat');

window.switchTab = async (tab) => {
    await window.ensureAdminFeatureScripts();
    tab = normalizeSettingsTab(tab);
    const tabs = SETTINGS_TABS;
    tabs.forEach(t => document.getElementById(`tab-content-${t}`)?.classList.add('hidden'));
    document.querySelectorAll('.admin-tab').forEach(b => b.classList.remove('active'));
    document.querySelector('.settings-workspace-view .admin-content')?.classList.toggle('is-monitor-tab-active', tab === 'monitor');
    
    document.getElementById(`tab-${tab}`)?.classList.add('active');
    document.getElementById(`tab-content-${tab}`)?.classList.remove('hidden');
    window.persistSettingsTab?.(tab);
    loadTabData(tab);
};

async function loadTabData(tab, page = 1) {
    pageState[tab] = page;
    if (tab === 'models' && window.loadModels) loadModels(page);
    if (tab === 'users' && window.loadUsers) {
        loadUsers(page);
        setTimeout(() => window.ensureUserRecordButtons?.(), 0);
    }
    if (tab === 'logs' && window.loadLogs) loadLogs(page);
    if (tab === 'monitor' && window.loadMonitorSummary) loadMonitorSummary();
    if (tab === 'stats' && window.loadStats) loadStats();
    if (tab === 'report' && window.loadReport) loadReport();
    if (tab === 'prompts' && window.loadPrompts) loadPrompts();
    if (tab === 'attachments' && window.loadAttachments) loadAttachments(page);
    if (tab === 'ops' && window.loadOpsSummary) loadOpsSummary();
    if (tab === 'details' && window.loadDetails) loadDetails(page);
    if (tab === 'apiCallLogs' && window.loadApiCallLogs) loadApiCallLogs(page);
    if (tab === 'userRecords' && window.loadUserRecordMessages) loadUserRecordMessages(page);
    if (tab === 'keys' && window.loadApiKeys) {
        loadApiKeys();
        const displayEl = document.getElementById('api-base-url-display');
        if (displayEl) {
            // 优先使用后端配置的公网 URL，否则根据当前访问地址智能生成
            const origin = window.publicUrl || window.location.origin;
            displayEl.innerText = `${origin}/v1`;
        }
    }
}
window.loadTabData = loadTabData;

// 智能获取远程模型列表
window.fetchRemoteModels = async function() {
    const url = document.getElementById('m-url').value;
    const apiKey = document.getElementById('m-key').value;
    const id = document.getElementById('m-id').value;
    const selectContainer = document.getElementById('m-model-select-container');
    const selectEl = document.getElementById('m-model-select');
    
    if (!url) return showToast('请先填写接口地址', 'error');

    try {
        showToast('正在获取模型列表...', 'info');
        const res = await apiFetch(`${API_BASE}/models/fetch-remote`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url, api_key: apiKey, id })
        });
        const data = await res.json();
        
        if (!data.success) throw new Error(data.error);
        if (!data.models || data.models.length === 0) throw new Error('未获取到可用模型');

        // 填充下拉框
        selectEl.innerHTML = '<option value="">-- 请选择获取到的模型 --</option>' + 
            data.models.map(m => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join('');
        
        selectContainer.classList.remove('hidden');
        showToast(`成功获取 ${data.models.length} 个模型`);

        // 绑定选择事件
        selectEl.onchange = (e) => {
            if (e.target.value) {
                document.getElementById('m-model').value = e.target.value;
                // 尝试自动填充显示名称 (如果是空的)
                const nameInput = document.getElementById('m-name');
                if (!nameInput.value) {
                    nameInput.value = e.target.value;
                }
            }
        };
    } catch (e) {
        showToast(e.message, 'error');
    }
};

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
        updateEmbeddingSettingsForm(data.embeddingConfig);
    } catch (e) {
        showToast(e.message || '系统设置加载失败', 'error');
    }
}

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
        const endpoint = currentUser?.username === 'admin' ? `${API_BASE}/admin/settings` : `${API_BASE}/settings/embedding`;
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
        showToast(currentUser?.username === 'admin' ? '系统设置已保存' : '个人设置已保存');
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
        const endpoint = currentUser?.username === 'admin' ? `${API_BASE}/admin/settings` : `${API_BASE}/settings/embedding`;
        const res = await apiFetch(endpoint, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '检索配置保存失败');
        updateEmbeddingSettingsForm(data.embeddingConfig);
        showToast(currentUser?.username === 'admin' ? '系统检索配置已保存' : '个人检索配置已保存');
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
    
    // 移除旧监听防止重复
    const newOpenBtn = openBtn.cloneNode(true);
    openBtn.parentNode.replaceChild(newOpenBtn, openBtn);
    const newCancelBtn = cancelBtn.cloneNode(true);
    cancelBtn.parentNode.replaceChild(newCancelBtn, cancelBtn);

    newOpenBtn.onclick = () => {
        modal.classList.remove('hidden');
    };
    newCancelBtn.onclick = () => modal.classList.add('hidden');
    
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
