// --- 管理与配置逻辑 ---
const formatDateToCN = (dateStr) => {
    if (!dateStr) return '-';
    const text = String(dateStr).trim();
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)) {
        return text;
    }
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
        const res = await fetch(url, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
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

document.getElementById('admin-panel-btn').onclick = () => {
    const adminContainer = document.getElementById('admin-container');
    adminContainer.classList.remove('hidden');
    
    // 强制刷新权限显示 (应对角色变更或初始加载延迟)
    if (currentUser.role === 'admin') {
        document.querySelectorAll('.admin-only').forEach(el => el.classList.remove('hidden'));
    } else {
        document.querySelectorAll('.admin-only').forEach(el => el.classList.add('hidden'));
    }
    
    switchTab(currentUser.role === 'admin' ? 'ops' : 'prompts');
};

window.closeModal = () => document.getElementById('admin-container').classList.add('hidden');

let pageState = { models: 1, users: 1, logs: 1, details: 1, attachments: 1, limit: 10 };

window.switchTab = async (tab) => {
    // 隐藏所有面板
    document.getElementById('tab-content-users').classList.add('hidden');
    document.getElementById('tab-content-models').classList.add('hidden');
    document.getElementById('tab-content-logs').classList.add('hidden');
    document.getElementById('tab-content-stats').classList.add('hidden');
    document.getElementById('tab-content-details').classList.add('hidden');
    document.getElementById('tab-content-knowledge').classList.add('hidden');
    document.getElementById('tab-content-prompts').classList.add('hidden');
    document.getElementById('tab-content-attachments').classList.add('hidden');
    document.getElementById('tab-content-ops').classList.add('hidden');
    
    document.querySelectorAll('.admin-tab').forEach(b => b.classList.remove('active'));
    
    document.getElementById(`tab-${tab}`).classList.add('active');
    document.getElementById(`tab-content-${tab}`).classList.remove('hidden');
    
    loadTabData(tab);
};

async function loadTabData(tab, page = 1) {
    pageState[tab] = page;
    if (tab === 'models') loadModels(page);
    if (tab === 'users') loadUsers(page);
    if (tab === 'logs') loadLogs(page);
    if (tab === 'stats') loadStats();
    if (tab === 'prompts') loadPrompts();
    if (tab === 'attachments') loadAttachments(page);
    if (tab === 'ops') loadOpsSummary();
    if (tab === 'details') loadDetails(page);
    if (tab === 'knowledge' && window.loadKnowledgeDocs) window.loadKnowledgeDocs();
}

async function loadPrompts() {
    const res = await fetch(`${API_BASE}/prompts`, { headers: { 'Authorization': `Bearer ${token}` } });
    const data = await res.json();
    const grid = document.getElementById('prompt-grid');
    grid.innerHTML = data.map(p => `
        <div class="prompt-card">
            <div class="prompt-card-head">
                <h4>${escapeHtml(p.name)}</h4>
                <span>${escapeHtml(p.scope === 'global' ? '全局' : '个人')}</span>
            </div>
            <p>${escapeHtml(p.content)}</p>
            <div class="prompt-actions">
                <button class="btn-secondary" onclick="applyPrompt(JSON.parse(decodeURIComponent('${encodeActionArg(p)}')).content)">应用</button>
                ${(p.scope !== 'global' || currentUser.role === 'admin') ? `<button class="btn-secondary" onclick="prepareEditPrompt(JSON.parse(decodeURIComponent('${encodeActionArg(p)}')))">编辑</button><button class="btn-danger" onclick="deletePrompt(${p.id})">删除</button>` : ''}
            </div>
        </div>
    `).join('');
}

window.applyPrompt = async (content) => {
    if (!currentSessionId) return showToast('请先选择一个对话', 'error');
    
    showConfirm('切换 AI 角色', '确定要将该角色指令应用到当前对话吗？(之前的设定将被覆盖)', async () => {
        try {
            const res = await fetch(`${API_BASE}/sessions/${currentSessionId}/system-prompt`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                body: JSON.stringify({ systemPrompt: content })
            });
            if (res.ok) {
                showToast('AI 角色切换成功');
                closeModal();
            }
        } catch (e) { showToast('应用失败', 'error'); }
    });
};

window.openPromptModal = () => {
    resetPromptForm();
    document.getElementById('prompt-modal-title').innerText = '添加指令';
    document.getElementById('p-scope').disabled = currentUser.role !== 'admin';
    document.getElementById('prompt-modal-container').classList.remove('hidden');
};

window.closePromptModal = () => {
    document.getElementById('prompt-modal-container').classList.add('hidden');
};

window.resetPromptForm = () => {
    document.getElementById('p-id').value = '';
    document.getElementById('p-name').value = '';
    document.getElementById('p-category').value = '通用';
    document.getElementById('p-scope').value = currentUser.role === 'admin' ? 'global' : 'personal';
    document.getElementById('p-content').value = '';
};

window.prepareEditPrompt = (prompt) => {
    document.getElementById('p-id').value = prompt.id;
    document.getElementById('p-name').value = prompt.name;
    document.getElementById('p-category').value = prompt.category || '通用';
    document.getElementById('p-scope').value = prompt.scope || 'personal';
    document.getElementById('p-scope').disabled = currentUser.role !== 'admin';
    document.getElementById('p-content').value = prompt.content;
    document.getElementById('prompt-modal-title').innerText = '编辑指令';
    document.getElementById('prompt-modal-container').classList.remove('hidden');
};

window.savePrompt = async () => {
    const id = document.getElementById('p-id').value;
    const payload = {
        name: document.getElementById('p-name').value,
        category: document.getElementById('p-category').value,
        scope: document.getElementById('p-scope').value,
        content: document.getElementById('p-content').value
    };
    const res = await fetch(API_BASE + (id ? `/prompts/${id}` : '/prompts'), {
        method: id ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok) return showToast(data.error || '保存失败', 'error');
    closePromptModal();
    loadPrompts();
    showToast('指令已保存');
};

window.deletePrompt = (id) => {
    showConfirm('删除指令', '确定删除该指令模板吗？', async () => {
        try {
            const res = await fetch(`${API_BASE}/prompts/${id}`, {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (res.ok) {
                showToast('指令已删除');
                loadPrompts();
            }
        } catch (e) { showToast('删除失败', 'error'); }
    });
};

async function loadDetails(page = 1) {
    const res = await fetch(`${API_BASE}/admin/stats/details?page=${page}&limit=10`, { headers: { 'Authorization': `Bearer ${token}` } });
    const { data, total } = await res.json();
    document.getElementById('details-list-body').innerHTML = data.map((d, i) => `
        <tr>
            <td class="text-center" title="${(page-1)*10 + i + 1}">${(page-1)*10 + i + 1}</td>
            <td title="${escapeHtml(formatDateToCN(d.created_at))}">${escapeHtml(formatDateToCN(d.created_at))}</td>
            <td title="${escapeHtml(d.nickname || d.username)}">${escapeHtml(d.nickname || d.username)}</td>
            <td title="${escapeHtml(d.model_name || '未知')}">${escapeHtml(d.model_name || '未知')}</td>
            <td class="text-center" title="${d.role === 'user' ? '提问' : '回答'}">${d.role === 'user' ? '提问' : '回答'}</td>
            <td title="${d.token_count}">${d.token_count}</td>
        </tr>
    `).join('');
    renderPagination('details', total, page);
}

let trendChart = null;

async function loadStats() {
    // 1. 获取基础用量表格
    const resTable = await fetch(`${API_BASE}/admin/stats/usage`, { headers: { 'Authorization': `Bearer ${token}` } });
    const tableData = await resTable.json();
    document.getElementById('stats-list-body').innerHTML = tableData.map(s => `
        <tr>
            <td title="${escapeHtml(s.username)}">${escapeHtml(s.username)}</td>
            <td title="${escapeHtml(s.nickname || s.username)}">${escapeHtml(s.nickname || s.username)}</td>
            <td title="${escapeHtml(s.model_name || '未知模型')}">${escapeHtml(s.model_name || '未知模型')}</td>
            <td class="text-center">${s.msg_count}</td>
            <td class="text-center">${s.total_tokens.toLocaleString()}</td>
            <td style="color: var(--text-muted); font-size: 0.85rem;">${s.last_active || '-'}</td>
        </tr>
    `).join('');

}

function renderTrendChart(canvasId, data) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(rect.width || 600, 320);
    const height = Number(canvas.getAttribute('height')) || 180;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = width * ratio;
    canvas.height = height * ratio;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.scale(ratio, ratio);
    ctx.clearRect(0, 0, width, height);

    const values = data.map(d => Number(d.tokens) || 0);
    const labels = data.map(d => String(d.day || '').slice(5));
    const max = Math.max(...values, 1);
    const pad = 28;
    const chartW = width - pad * 2;
    const chartH = height - pad * 2;

    ctx.strokeStyle = '#e5e7eb';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 3; i++) {
        const y = pad + chartH * (i / 3);
        ctx.beginPath();
        ctx.moveTo(pad, y);
        ctx.lineTo(width - pad, y);
        ctx.stroke();
    }

    if (values.length === 0) {
        ctx.fillStyle = '#6b7280';
        ctx.font = '13px sans-serif';
        ctx.fillText('暂无趋势数据', pad, height / 2);
        return;
    }

    const points = values.map((value, index) => {
        const x = pad + (values.length === 1 ? chartW : chartW * index / (values.length - 1));
        const y = pad + chartH - (value / max) * chartH;
        return { x, y, value, label: labels[index] };
    });

    ctx.beginPath();
    points.forEach((point, index) => {
        if (index === 0) ctx.moveTo(point.x, point.y);
        else ctx.lineTo(point.x, point.y);
    });
    ctx.strokeStyle = '#10a37f';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.fillStyle = 'rgba(16, 163, 127, 0.12)';
    ctx.lineTo(points[points.length - 1].x, height - pad);
    ctx.lineTo(points[0].x, height - pad);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = '#10a37f';
    points.forEach(point => {
        ctx.beginPath();
        ctx.arc(point.x, point.y, 3, 0, Math.PI * 2);
        ctx.fill();
    });

    ctx.fillStyle = '#6b7280';
    ctx.font = '11px sans-serif';
    const first = points[0];
    const last = points[points.length - 1];
    ctx.fillText(first.label || '', pad, height - 8);
    ctx.fillText(last.label || '', Math.max(pad, width - pad - 34), height - 8);
    ctx.fillText(String(max), pad, 14);
}

async function loadOpsSummary() {
    const [summaryRes, trendRes] = await Promise.all([
        fetch(`${API_BASE}/admin/ops/summary`, { headers: { 'Authorization': `Bearer ${token}` } }),
        fetch(`${API_BASE}/admin/stats/trend`, { headers: { 'Authorization': `Bearer ${token}` } })
    ]);
    const summary = await summaryRes.json();
    const trend = await trendRes.json();
    const formatSize = (bytes) => {
        const value = Number(bytes) || 0;
        if (value > 1024 * 1024 * 1024) return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`;
        if (value > 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
        if (value > 1024) return `${(value / 1024).toFixed(1)} KB`;
        return `${value} B`;
    };
    const cards = [
        ['用户', `${summary.activeUsers}/${summary.users}`],
        ['会话', summary.sessions],
        ['消息', summary.messages],
        ['附件', summary.attachments],
        ['模型', summary.models],
        ['Token', Number(summary.tokens || 0).toLocaleString()],
        ['上传占用', formatSize(summary.uploadsSize)],
        ['今日审计', summary.auditToday]
    ];
    document.getElementById('ops-summary-grid').innerHTML = cards.map(([label, value]) => `
        <div class="ops-card"><span>${label}</span><strong>${value}</strong></div>
    `).join('');
    renderTrendChart('usage-trend-chart', trend);
}

window.exportDetails = () => {
    downloadFileByFetch(`${API_BASE}/admin/stats/details/export`, 'usage_details.csv');
};

window.exportStats = () => {
    const rows = Array.from(document.querySelectorAll('#stats-list-body tr'));
    let csv = '\uFEFF用户,显示名,模型,消息数,总Token\n';
    rows.forEach(row => {
        const cols = Array.from(row.querySelectorAll('td')).map(td => escapeCsvValue(td.innerText));
        csv += cols.join(',') + '\n';
    });
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'usage_stats.csv';
    a.click();
};

function renderPagination(tab, total, currentPage) {
    const totalPages = Math.ceil(total / pageState.limit);
    const container = document.getElementById(`pagination-${tab}`);
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

async function loadAttachments(page = 1) {
    pageState.attachments = page;
    const keyword = document.getElementById('attachment-search-input')?.value || '';
    const res = await fetch(`${API_BASE}/attachments?page=${page}&limit=${pageState.limit}&keyword=${encodeURIComponent(keyword)}`, {
        headers: { 'Authorization': `Bearer ${token}` }
    });
    const { data, total } = await res.json();
    document.getElementById('attachment-list-body').innerHTML = data.map(item => `
        <tr>
            <td title="${escapeHtml(item.file_name)}">${escapeHtml(item.file_name)}</td>
            <td title="${escapeHtml(item.session_title || item.session_id || '-')}">${escapeHtml(item.session_title || item.session_id || '-')}</td>
            <td title="${escapeHtml(item.file_type || '-')}">${escapeHtml(item.file_type || '-')}</td>
            <td>${formatFileSize(item.file_size)}</td>
            <td title="${escapeHtml(formatDateToCN(item.created_at))}">${escapeHtml(formatDateToCN(item.created_at))}</td>
            <td class="text-center">
                <div style="display: flex; gap: 5px; justify-content: center;">
                    <a class="btn-secondary" style="padding: 2px 8px; font-size: 0.75rem; text-decoration: none;" href="${item.url}" target="_blank">打开</a>
                    <button class="btn-danger" style="padding: 2px 8px; font-size: 0.75rem;" onclick="deleteAttachment(${item.id})">删除</button>
                </div>
            </td>
        </tr>
    `).join('');
    renderPagination('attachments', total, page);
}

function formatFileSize(size) {
    const value = Number(size) || 0;
    if (value > 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
    if (value > 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${value} B`;
}

window.deleteAttachment = (id) => {
    showConfirm('删除附件', '确定删除该附件吗？文件将从磁盘永久移除。', async () => {
        try {
            const res = await fetch(`${API_BASE}/attachments/${id}`, {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (res.ok) {
                showToast('附件已删除');
                loadAttachments(pageState.attachments);
            }
        } catch (e) { showToast('删除失败', 'error'); }
    });
};

let attachmentSearchTimer = null;
document.getElementById('attachment-search-input')?.addEventListener('input', () => {
    clearTimeout(attachmentSearchTimer);
    attachmentSearchTimer = setTimeout(() => loadAttachments(1), 300);
});

async function loadModels(page = 1) {
    const res = await fetch(`${API_BASE}/models?page=${page}&limit=${pageState.limit}`, { headers: { 'Authorization': `Bearer ${token}` } });
    if (res.status === 401) {
        localStorage.removeItem('token');
        window.location.reload();
        return;
    }
    const result = await res.json();
    const data = result.data || [];
    
    if (page === 1) {
        refreshModelSelector();
    }

    document.getElementById('model-list-body').innerHTML = data.map(m => `
        <tr id="model-row-${m.id}">
            <td title="${escapeHtml(m.name)}">${escapeHtml(m.name)}${m.user_id ? ' <small>(私有)</small>' : ' <small>(全局)</small>'}</td>
            <td title="${escapeHtml(m.url)}">${escapeHtml(m.url)}</td>
            <td>${Number(m.daily_token_limit || 0) > 0 ? Number(m.daily_token_limit).toLocaleString() : '不限'}</td>
            <td title="${escapeHtml(m.allowed_units || '')}">${escapeHtml(m.allowed_units || '全部')}</td>
            <td class="text-center">
                <span class="status-dot status-unknown" id="status-${m.id}" title="等待检测"></span>
                <small id="latency-${m.id}"></small>
            </td>
            <td class="text-center">
                <div style="display: flex; gap: 5px; justify-content: center;">
                    <button class="btn-secondary" style="padding: 2px 8px; font-size: 0.75rem; border-color: var(--primary); color: var(--primary);" onclick="testExistingModel(JSON.parse(decodeURIComponent('${encodeActionArg(m)}')))">测试</button>
                    <button class="btn-secondary" style="padding: 2px 8px; font-size: 0.75rem;" onclick="prepareEditModel(JSON.parse(decodeURIComponent('${encodeActionArg(m)}')))">编辑</button>
                    ${(m.user_id || currentUser.role === 'admin') ? `<button class="btn-danger" style="padding: 2px 8px; font-size: 0.75rem;" onclick="deleteModel(${m.id})">删除</button>` : ''}
                </div>
            </td>
        </tr>
    `).join('');
    
    // 异步检测每个模型状态
    data.forEach(m => checkSingleModelStatus(m.id));
    
    renderPagination('models', total, page);
}

const pendingTests = new Set();
async function checkSingleModelStatus(id) {
    if (pendingTests.has(id)) return;
    const dot = document.getElementById(`status-${id}`);
    const latencyEl = document.getElementById(`latency-${id}`);
    if (!dot) return;
    
    pendingTests.add(id);
    const startTime = Date.now();
    try {
        const res = await fetch('/api/models/test', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({ id, source: 'auto' })
        });
        const duration = Date.now() - startTime;
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.success !== false) {
            dot.className = 'status-dot status-online';
            dot.title = '在线';
            latencyEl.innerText = `${duration}ms`;
        } else {
            dot.className = 'status-dot status-offline';
            dot.title = data.error || '连接失败';
            latencyEl.innerText = '';
        }
    } catch (e) {
        dot.className = 'status-dot status-offline';
        dot.title = '网络错误';
    } finally {
        pendingTests.delete(id);
    }
}

window.openModelModal = () => {
    resetModelForm();
    document.getElementById('model-modal-title').innerText = '添加新模型';
    document.getElementById('model-modal-container').classList.remove('hidden');
};

window.closeModelModal = () => {
    document.getElementById('model-modal-container').classList.add('hidden');
};

window.prepareEditModel = (model) => {
    document.getElementById('m-id').value = model.id;
    document.getElementById('m-name').value = model.name;
    document.getElementById('m-url').value = model.url;
    document.getElementById('m-model').value = model.model_name;
    document.getElementById('m-key').value = model.api_key || '';
    document.getElementById('m-daily-limit').value = model.daily_token_limit || '';
    document.getElementById('m-units').value = model.allowed_units || '';
    
    document.getElementById('model-modal-title').innerText = '编辑模型配置';
    document.getElementById('model-modal-container').classList.remove('hidden');
};

window.testExistingModel = async (model) => {
    if (pendingTests.has(model.id)) return showToast('该模型正在自动检测，请稍后再试', 'info');
    await testConnection(null, null, null, model.id);
};

window.testModelConfig = async () => {
    const id = document.getElementById('m-id').value;
    const url = document.getElementById('m-url').value;
    const api_key = document.getElementById('m-key').value;
    const model_name = document.getElementById('m-model').value;
    await testConnection(url, api_key, model_name, id);
};

async function testConnection(url, api_key, model_name, id = null) {
    if (!id && !url) return showToast('请输入接口地址', 'error');
    showToast('正在测试连接...', 'info');
    try {
        const res = await fetch('/api/models/test', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({ id, url, api_key, model_name, source: 'manual' })
        });
        const data = await res.json();
        if (res.ok && data.success === false) return showToast('连接失败: ' + (data.error || '未知错误'), 'error');
        if (res.ok) showToast('连接成功');
        else showToast('连接失败: ' + (data.error || '未知错误'), 'error');
    } catch (e) {
        showToast('网络错误', 'error');
    }
}

async function refreshModelSelector() {
    const selector = document.getElementById('model-selector');
    if (!selector) return;
    const selected = selector.value;
    const describeModelOption = (m) => {
        const parts = [m.name];
        parts.push(m.user_id ? '私有' : '全局');
        if (m.model_name) parts.push(m.model_name);
        const limit = Number(m.daily_token_limit || 0);
        if (limit > 0) parts.push(`${limit.toLocaleString()} Token/日`);
        if (!m.user_id && m.allowed_units) parts.push(`限 ${m.allowed_units}`);
        return parts.join(' · ');
    };
    try {
        const res = await fetch(`${API_BASE}/models?page=1&limit=100`, { headers: { 'Authorization': `Bearer ${token}` } });
        if (!res.ok) throw new Error('模型列表加载失败');
        const { data } = await res.json();
        selector.innerHTML = data.length
            ? data.map(m => `<option value="${m.id}" title="${escapeHtml(describeModelOption(m))}">${escapeHtml(describeModelOption(m))}</option>`).join('')
            : '<option value="">暂无可用模型</option>';
        selector.disabled = data.length === 0;
        if (selected && data.some(m => String(m.id) === String(selected))) selector.value = selected;
    } catch (e) {
        selector.innerHTML = '<option value="">模型加载失败</option>';
        selector.disabled = true;
    }
}

window.resetModelForm = () => {
    document.getElementById('m-id').value = '';
    document.getElementById('m-name').value = '';
    document.getElementById('m-url').value = '';
    document.getElementById('m-model').value = '';
    document.getElementById('m-key').value = '';
    document.getElementById('m-daily-limit').value = '';
    document.getElementById('m-units').value = '';
    
    // 重置可见性
    document.getElementById('m-key').type = 'password';
};

window.toggleKeyVisibility = async () => {
    const keyInput = document.getElementById('m-key');
    const modelId = document.getElementById('m-id').value;
    
    // 如果是编辑模式且当前显示的是掩码，则请求后端获取明文
    if (keyInput.type === 'password' && keyInput.value === '********' && modelId) {
        try {
            const res = await fetch(`${API_BASE}/models/${modelId}/key`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            const data = await res.json();
            if (data.key) keyInput.value = data.key;
            if (data.error) showToast(data.error, 'error');
        } catch (e) {
            showToast('获取明文密钥失败', 'error');
        }
    }
    
    keyInput.type = keyInput.type === 'password' ? 'text' : 'password';
};

async function loadUsers(page = 1) {
    const res = await fetch(`${API_BASE}/admin/users?page=${page}&limit=${pageState.limit}`, { headers: { 'Authorization': `Bearer ${token}` } });
    const { data, total } = await res.json();
    document.getElementById('user-list-body').innerHTML = data.map(u => `
        <tr>
            <td class="text-center" title="${u.id}">${u.id}</td>
            <td title="${escapeHtml(u.username)}">${escapeHtml(u.username)}</td>
            <td title="${escapeHtml(u.nickname || '')}">${escapeHtml(u.nickname || u.username)}</td>
            <td title="${escapeHtml(u.unit || '')}">${escapeHtml(u.unit || '-')}</td>
            <td title="${escapeHtml(u.role)}">${escapeHtml(u.role)}</td>
            <td title="${escapeHtml(u.status || 'active')}">${(u.status || 'active') === 'disabled' ? '禁用' : '启用'}</td>
            <td class="text-center">
                <div style="display: flex; gap: 5px; justify-content: center;">
                    <button class="btn-secondary" style="padding: 2px 8px; font-size: 0.75rem;" onclick="prepareEditUser(JSON.parse(decodeURIComponent('${encodeActionArg(u)}')))">编辑</button>
                    <button class="btn-secondary" style="padding: 2px 8px; font-size: 0.75rem;" onclick="resetUserPassword(${u.id})">重置密码</button>
                    ${u.id !== currentUser.id ? `<button class="btn-danger" style="padding: 2px 8px; font-size: 0.75rem;" onclick="deleteUser(${u.id})">删除</button>` : ''}
                </div>
            </td>
        </tr>
    `).join('');
    renderPagination('users', total, page);
}

window.openUserModal = () => {
    resetUserForm();
    document.getElementById('user-modal-title').innerText = '添加用户';
    document.getElementById('u-password-wrap').classList.remove('hidden');
    document.getElementById('user-modal-container').classList.remove('hidden');
};

window.closeUserModal = () => {
    document.getElementById('user-modal-container').classList.add('hidden');
};

window.resetUserForm = () => {
    document.getElementById('u-id').value = '';
    document.getElementById('u-username').value = '';
    document.getElementById('u-username').disabled = false;
    document.getElementById('u-password').value = '';
    document.getElementById('u-nickname').value = '';
    document.getElementById('u-unit').value = '';
    document.getElementById('u-role').value = 'user';
    document.getElementById('u-status').value = 'active';
};

window.prepareEditUser = (user) => {
    document.getElementById('u-id').value = user.id;
    document.getElementById('u-username').value = user.username;
    document.getElementById('u-username').disabled = true;
    document.getElementById('u-nickname').value = user.nickname || '';
    document.getElementById('u-unit').value = user.unit || '';
    document.getElementById('u-role').value = user.role || 'user';
    document.getElementById('u-status').value = user.status || 'active';
    document.getElementById('u-password-wrap').classList.add('hidden');
    document.getElementById('user-modal-title').innerText = '编辑用户';
    document.getElementById('user-modal-container').classList.remove('hidden');
};

window.saveUser = async () => {
    const id = document.getElementById('u-id').value;
    const payload = {
        username: document.getElementById('u-username').value,
        password: document.getElementById('u-password').value,
        nickname: document.getElementById('u-nickname').value,
        unit: document.getElementById('u-unit').value,
        role: document.getElementById('u-role').value,
        status: document.getElementById('u-status').value
    };
    const res = await fetch(API_BASE + (id ? `/admin/users/${id}` : '/admin/users'), {
        method: id ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok) return showToast(data.error || '保存失败', 'error');
    closeUserModal();
    loadUsers(pageState.users);
    showToast('用户已保存');
};

window.resetUserPassword = async (id) => {
    const password = prompt('请输入新密码（至少 8 位，包含字母和数字）');
    if (!password) return;
    const res = await fetch(`${API_BASE}/admin/users/${id}/password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ password })
    });
    const data = await res.json();
    if (!res.ok) return showToast(data.error || '重置失败', 'error');
    showToast('密码已重置');
};

window.exportLogs = () => {
    downloadFileByFetch(`${API_BASE}/admin/logs/export`, 'audit_logs.csv');
};

window.exportUsers = () => {
    downloadFileByFetch(`${API_BASE}/admin/users/export`, 'users.csv');
};

window.importUsers = async () => {
    const file = document.getElementById('user-import-input').files[0];
    if (!file) return;
    const formData = new FormData();
    formData.append('file', file);
    try {
        const res = await fetch(`${API_BASE}/admin/users/import`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` },
            body: formData
        });
        const data = await res.json();
        if (data.success) {
            showToast(`成功导入 ${data.count} 名用户`);
            loadUsers();
        }
    } catch (e) { showToast('导入失败', 'error'); }
    document.getElementById('user-import-input').value = '';
};

async function loadLogs(page = 1) {
    const res = await fetch(`${API_BASE}/admin/logs?page=${page}&limit=${pageState.limit}`, { headers: { 'Authorization': `Bearer ${token}` } });
    const { data, total } = await res.json();
    document.getElementById('log-list-body').innerHTML = data.map((l, index) => `
        <tr>
            <td class="text-center" title="${(page - 1) * pageState.limit + index + 1}">${(page - 1) * pageState.limit + index + 1}</td>
            <td title="${escapeHtml(formatDateToCN(l.timestamp))}">${escapeHtml(formatDateToCN(l.timestamp))}</td>
            <td title="${escapeHtml(l.username || '系统')}">${escapeHtml(l.username || '系统')}</td>
            <td title="${escapeHtml(l.ip_address || '-')}">${escapeHtml(l.ip_address || '-')}</td>
            <td title="${escapeHtml(l.action)}"><strong>${escapeHtml(l.action)}</strong></td>
            <td title="${escapeHtml(l.details)}">${escapeHtml(l.details)}</td>
        </tr>
    `).join('');
    renderPagination('logs', total, page);
}

window.addModel = async () => {
    const id = document.getElementById('m-id').value;
    const name = document.getElementById('m-name').value;
    const url = document.getElementById('m-url').value;
    const model_name = document.getElementById('m-model').value;
    const api_key = document.getElementById('m-key').value;
    const daily_token_limit = Number(document.getElementById('m-daily-limit').value || 0);
    const allowed_units = document.getElementById('m-units').value;
    
    const method = id ? 'PUT' : 'POST';
    const path = id ? `/models/${id}` : '/models';

    if (!name || !url) return showToast('模型名称和接口地址不能为空', 'error');
    
    const btn = document.getElementById('m-submit-btn');
    const oldText = btn.innerText;
    btn.disabled = true;
    btn.innerText = '正在保存...';

    try {
        const res = await fetch(API_BASE + path, {
            method: method,
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({ name, url, model_name, api_key, daily_token_limit, allowed_units })
        });
        if (res.ok) {
            loadModels();
            closeModelModal();
            showToast(id ? '模型更新成功' : '模型添加成功');
        } else {
            const err = await res.json();
            showToast(err.error || '操作失败', 'error');
        }
    } catch (e) {
        showToast('网络请求失败', 'error');
    } finally {
        btn.disabled = false;
        btn.innerText = oldText;
    }
};

window.deleteModel = (id) => {
    showConfirm('删除模型', '确定要删除该模型配置吗？', async () => {
        const res = await fetch(`${API_BASE}/models/${id}`, { method: 'DELETE', headers: { 'Authorization': `Bearer ${token}` } });
        if (res.ok) { showToast('模型已删除'); loadModels(pageState.models); }
    });
};

window.deleteUser = (id) => {
    showConfirm('删除用户', '确定删除该用户吗？所有历史对话将被清空。', async () => {
        const res = await fetch(API_BASE + `/admin/users/${id}`, { method: 'DELETE', headers: { 'Authorization': `Bearer ${token}` } });
        if (res.ok) { showToast('用户已删除'); loadUsers(pageState.users); }
    });
};
