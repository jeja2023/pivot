/* 知识库 (RAG) 前端逻辑 Knowledge Base (RAG) Frontend Logic */

const formatRagDateToCN = (dateStr) => {
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

const escapeRagHtml = (str) => {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
};

window.loadKnowledgeDocs = async () => {
    try {
        const res = await fetch(`${API_BASE}/rag/docs`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const docs = await res.json();
        
        document.getElementById('rag-docs-body').innerHTML = docs.map((d, i) => `
            <tr>
                <td title="${escapeRagHtml(d.name)}">${escapeRagHtml(d.name)}</td>
                <td class="text-center">
                    <span class="status-badge ${d.status}">${d.status === 'ready' ? '就绪' : d.status === 'processing' ? '处理中' : '失败'}</span>
                </td>
                <td>${escapeRagHtml(formatRagDateToCN(d.created_at))}</td>
                <td class="text-center">
                    <button class="btn-danger" style="padding: 2px 8px; font-size: 0.75rem;" onclick="deleteKnowledgeDoc(${d.id})">删除</button>
                </td>
            </tr>
        `).join('');
    } catch (e) {
        console.error('加载知识库失败', e);
    }
};

window.uploadKnowledgeDoc = async () => {
    const fileInput = document.getElementById('rag-upload-input');
    if (!fileInput.files.length) return;
    
    const file = fileInput.files[0];
    const formData = new FormData();
    formData.append('file', file);

    showToast('正在上传并向量化文档，请稍候...', 'info');
    fileInput.value = ''; // 重置 input

    try {
        const res = await fetch(`${API_BASE}/rag/upload`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` },
            body: formData
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        
        showToast('文档上传成功并已加入知识库');
        window.loadKnowledgeDocs();
    } catch (e) {
        showToast(e.message || '文档上传失败', 'error');
    }
};

window.deleteKnowledgeDoc = async (id) => {
    if (!confirm('确定要从知识库中移除该文档吗？大模型将不再参考此文档。')) return;
    
    try {
        const res = await fetch(`${API_BASE}/rag/docs/${id}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (res.ok) {
            showToast('文档已移除');
            window.loadKnowledgeDocs();
        }
    } catch (e) {
        showToast('删除失败', 'error');
    }
};

// 注入额外样式
const style = document.createElement('style');
style.textContent = `
    .status-badge { padding: 4px 8px; border-radius: 4px; font-size: 0.8rem; font-weight: 600; }
    .status-badge.ready { background: rgba(16, 185, 129, 0.1); color: #10b981; }
    .status-badge.processing { background: rgba(245, 158, 11, 0.1); color: #f59e0b; }
    .status-badge.error { background: rgba(239, 68, 68, 0.1); color: #ef4444; }
`;
document.head.appendChild(style);
