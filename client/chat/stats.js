// --- 统计与日志模块 Stats & Logs (完整功能版) ---
window.loadDetails = async function(page = 1) {
    const isAdmin = currentUser.role === 'admin';
    const titleEl = document.getElementById('details-title');
    if (titleEl) titleEl.innerText = '用量明细';
    try {
        const res = await fetch(`${API_BASE}/stats/details?page=${page}&limit=10`, { headers: authHeaders() });
        const { data, total } = await res.json();
        document.getElementById('details-list-body').innerHTML = data.map((d, i) => `
            <tr>
                <td class="text-center">${(page-1)*10 + i + 1}</td>
                <td>${escapeHtml(formatDateToCN(d.created_at))}</td>
                <td>${escapeHtml(d.nickname || d.username)}</td>
                <td>${escapeHtml(d.model_name || '未知')}</td>
                <td class="text-center">${d.role === 'user' ? '提问' : '回答'}</td>
                <td>${d.token_count}</td>
            </tr>
        `).join('');
        renderPagination('details', total, page);
    } catch (e) { showToast('加载明细失败', 'error'); }
}

window.loadStats = async function() {
    const isAdmin = currentUser.role === 'admin';
    const titleEl = document.getElementById('stats-title');
    if (titleEl) titleEl.innerText = '用量统计';
    try {
        const res = await fetch(`${API_BASE}/stats/usage`, { headers: authHeaders() });
        const data = await res.json();
        document.getElementById('stats-list-body').innerHTML = data.map(s => `
            <tr>
                <td>${escapeHtml(s.username)}</td>
                <td>${escapeHtml(s.nickname || s.username)}</td>
                <td>${escapeHtml(s.model_name || '未知模型')}</td>
                <td class="text-center">${s.msg_count}</td>
                <td class="text-center">${s.total_tokens.toLocaleString()}</td>
                <td style="color: var(--text-muted); font-size: 0.85rem;">${s.last_active || '-'}</td>
            </tr>
        `).join('');
    } catch (e) { showToast('加载统计失败', 'error'); }
}

function renderTrendChart(canvasId, data) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(rect.width || 600, 320);
    const height = Number(canvas.getAttribute('height')) || 180;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = width * ratio; canvas.height = height * ratio;
    canvas.style.width = `${width}px`; canvas.style.height = `${height}px`;
    ctx.scale(ratio, ratio);
    ctx.clearRect(0, 0, width, height);

    const values = data.map(d => Number(d.tokens) || 0);
    const labels = data.map(d => String(d.day || '').slice(5));
    const max = Math.max(...values, 1);
    const pad = 28; const chartW = width - pad * 2; const chartH = height - pad * 2;

    ctx.strokeStyle = '#e5e7eb'; ctx.lineWidth = 1;
    for (let i = 0; i <= 3; i++) {
        const y = pad + chartH * (i / 3);
        ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(width - pad, y); ctx.stroke();
    }

    if (values.length === 0) {
        ctx.fillStyle = '#6b7280'; ctx.font = '13px sans-serif';
        ctx.fillText('暂无趋势数据', pad, height / 2); return;
    }

    const points = values.map((v, i) => ({
        x: pad + (values.length === 1 ? chartW : chartW * i / (values.length - 1)),
        y: pad + chartH - (v / max) * chartH,
        label: labels[i]
    }));

    ctx.beginPath();
    points.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
    ctx.strokeStyle = '#10a37f'; ctx.lineWidth = 2; ctx.stroke();
    
    ctx.fillStyle = 'rgba(16, 163, 127, 0.12)';
    ctx.lineTo(points[points.length-1].x, height - pad); ctx.lineTo(points[0].x, height - pad);
    ctx.closePath(); ctx.fill();

    ctx.fillStyle = '#10a37f';
    points.forEach(p => { ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, Math.PI*2); ctx.fill(); });
    ctx.fillStyle = '#6b7280'; ctx.font = '11px sans-serif';
    ctx.fillText(points[0].label || '', pad, height - 8);
    ctx.fillText(points[points.length-1].label || '', width - pad - 34, height - 8);
    ctx.fillText(String(max), pad, 14);
}

window.loadOpsSummary = async function() {
    try {
        const [summaryRes, trendRes] = await Promise.all([
            fetch(`${API_BASE}/stats/ops-summary`, { headers: authHeaders() }),
            fetch(`${API_BASE}/stats/trend`, { headers: authHeaders() })
        ]);
        const summary = await summaryRes.json();
        const trend = await trendRes.json();
        const formatSize = (bytes) => {
            const v = Number(bytes) || 0;
            if (v > 1024**3) return `${(v / 1024**3).toFixed(1)} GB`;
            if (v > 1024**2) return `${(v / 1024**2).toFixed(1)} MB`;
            return `${(v / 1024).toFixed(1)} KB`;
        };
        const cards = summary.isPersonal ? [['会话', summary.sessions], ['消息', summary.messages], ['附件', summary.attachments], ['模型', summary.models], ['Token', Number(summary.tokens || 0).toLocaleString()]] : [['用户', `${summary.activeUsers}/${summary.users}`], ['会话', summary.sessions], ['消息', summary.messages], ['附件', summary.attachments], ['模型', summary.models], ['Token', Number(summary.tokens || 0).toLocaleString()], ['占用', formatSize(summary.uploadsSize)], ['审计', summary.auditToday]];
        const gridEl = document.getElementById('ops-summary-grid');
        gridEl.style.gridTemplateColumns = `repeat(${cards.length}, 1fr)`;
        gridEl.innerHTML = cards.map(([l, v]) => `<div class="ops-card"><span>${l}</span><strong>${v}</strong></div>`).join('');
        renderTrendChart('usage-trend-chart', trend);
    } catch (e) { showToast('加载概览失败', 'error'); }
}

window.exportDetails = () => downloadFileByFetch(`${API_BASE}/stats/details/export`, 'usage_details.csv');
window.exportStats = () => {
    const rows = Array.from(document.querySelectorAll('#stats-list-body tr'));
    let csv = '\uFEFF用户,显示名,模型,消息数,总Token\n';
    rows.forEach(row => { csv += Array.from(row.querySelectorAll('td')).map(td => escapeCsvValue(td.innerText)).join(',') + '\n'; });
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'usage_stats.csv'; a.click();
};

window.loadLogs = async function(page = 1) {
    const res = await fetch(`${API_BASE}/admin/logs?page=${page}&limit=${pageState.limit}`, { headers: authHeaders() });
    const { data, total } = await res.json();
    document.getElementById('log-list-body').innerHTML = data.map((l, i) => `
        <tr>
            <td class="text-center">${(page - 1) * pageState.limit + i + 1}</td>
            <td>${escapeHtml(formatDateToCN(l.timestamp))}</td>
            <td>${escapeHtml(l.username || '系统')}</td>
            <td>${escapeHtml(l.ip_address || '-')}</td>
            <td><strong>${escapeHtml(l.action)}</strong></td>
            <td>${escapeHtml(l.details)}</td>
        </tr>
    `).join('');
    renderPagination('logs', total, page);
}
window.exportLogs = () => downloadFileByFetch(`${API_BASE}/admin/logs/export`, 'audit_logs.csv');
