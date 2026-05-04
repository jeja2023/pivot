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
    const tabs = ['users', 'models', 'logs', 'stats', 'report', 'details', 'knowledge', 'prompts', 'attachments', 'ops', 'labs', 'account'];
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
}

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
