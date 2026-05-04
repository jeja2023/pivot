// --- 管理员面板核心逻辑 Admin Core ---
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
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
};

const escapeCsvValue = (value) => {
    let text = value === undefined || value === null ? '' : String(value);
    if (/^[=+\-@]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
};

const encodeActionArg = (value) => encodeURIComponent(JSON.stringify(value));

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

let pageState = { models: 1, users: 1, logs: 1, details: 1, attachments: 1, limit: 10 };

document.getElementById('admin-panel-btn').onclick = () => {
    const adminContainer = document.getElementById('admin-container');
    adminContainer.classList.remove('hidden');
    
    if (currentUser.role === 'admin') {
        document.querySelectorAll('.admin-only').forEach(el => el.classList.remove('hidden'));
    } else {
        document.querySelectorAll('.admin-only').forEach(el => el.classList.add('hidden'));
    }
    loadSettings();
    switchTab('ops');
};

window.closeModal = () => document.getElementById('admin-container').classList.add('hidden');

window.switchTab = async (tab) => {
    const tabs = ['users', 'models', 'logs', 'stats', 'report', 'keys', 'details', 'knowledge', 'prompts', 'attachments', 'ops', 'labs', 'account'];
    tabs.forEach(t => document.getElementById(`tab-content-${t}`)?.classList.add('hidden'));
    document.querySelectorAll('.admin-tab').forEach(b => b.classList.remove('active'));
    
    document.getElementById(`tab-${tab}`)?.classList.add('active');
    document.getElementById(`tab-content-${tab}`)?.classList.remove('hidden');
    loadTabData(tab);
};

async function loadTabData(tab, page = 1) {
    pageState[tab] = page;
    if (tab === 'models' && window.loadModels) loadModels(page);
    if (tab === 'users' && window.loadUsers) loadUsers(page);
    if (tab === 'logs' && window.loadLogs) loadLogs(page);
    if (tab === 'stats' && window.loadStats) loadStats();
    if (tab === 'report' && window.loadReport) loadReport();
    if (tab === 'prompts' && window.loadPrompts) loadPrompts();
    if (tab === 'attachments' && window.loadAttachments) loadAttachments(page);
    if (tab === 'ops' && window.loadOpsSummary) loadOpsSummary();
    if (tab === 'details' && window.loadDetails) loadDetails(page);
    if (tab === 'labs') loadSettings();
    if (tab === 'knowledge' && window.loadKnowledgeDocs) window.loadKnowledgeDocs();
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
            data.models.map(m => `<option value="${m}">${m}</option>`).join('');
        
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
    const ragCheckbox = document.getElementById('setting-rag-enabled');
    if (!ragCheckbox) return;
    try {
        const res = await apiFetch(`${API_BASE}/settings`);
        if (!res.ok) throw new Error('系统设置加载失败');
        const data = await res.json();
        ragCheckbox.checked = data.ragEnabled === true;
        document.getElementById('tab-knowledge')?.classList.toggle('hidden', !ragCheckbox.checked);
    } catch (e) {
        showToast(e.message || '系统设置加载失败', 'error');
    }
}

window.saveSettings = async () => {
    const ragCheckbox = document.getElementById('setting-rag-enabled');
    if (!ragCheckbox) return;
    ragCheckbox.disabled = true;
    try {
        const res = await apiFetch(`${API_BASE}/admin/settings`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rag_enabled: ragCheckbox.checked })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '系统设置保存失败');
        ragCheckbox.checked = data.ragEnabled === true;
        document.getElementById('tab-knowledge')?.classList.toggle('hidden', !data.ragEnabled);
        showToast('系统设置已保存');
    } catch (e) {
        showToast(e.message || '系统设置保存失败', 'error');
    } finally {
        ragCheckbox.disabled = false;
    }
};

function renderPagination(tab, total, currentPage) {
    const totalPages = Math.ceil(total / pageState.limit);
    const container = document.getElementById(`pagination-${tab}`);
    if (!container) return;
    if (totalPages <= 1) {
        container.innerHTML = '';
        return;
    }
    container.innerHTML = `
        <button class="btn-secondary" ${currentPage === 1 ? 'disabled' : ''} onclick="loadTabData('${tab}', 1)">首页</button>
        <button class="btn-secondary" ${currentPage === 1 ? 'disabled' : ''} onclick="loadTabData('${tab}', ${currentPage - 1})">上一页</button>
        <span style="margin: 0 15px; font-weight: 500;">第 ${currentPage} / ${totalPages} 页 (共 ${total} 条)</span>
        <button class="btn-secondary" ${currentPage === totalPages ? 'disabled' : ''} onclick="loadTabData('${tab}', ${currentPage + 1})">下一页</button>
        <button class="btn-secondary" ${currentPage === totalPages ? 'disabled' : ''} onclick="loadTabData('${tab}', ${totalPages})">末页</button>
    `;
}
