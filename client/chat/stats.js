/* 统计与日志模块 Stats & Logs */

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
                <td title="${escapeHtml(d.nickname || d.username)}">${escapeHtml(d.nickname || d.username)}</td>
                <td title="${escapeHtml(d.model_name || '未知')}">${escapeHtml(d.model_name || '未知')}</td>
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
        document.getElementById('stats-list-body').innerHTML = data.map((s, idx) => `
            <tr>
                <td class="text-center">${idx + 1}</td>
                <td title="${escapeHtml(s.username)}">${escapeHtml(s.username)}</td>
                <td title="${escapeHtml(s.nickname || s.username)}">${escapeHtml(s.nickname || s.username)}</td>
                <td title="${escapeHtml(s.model_name || '未知模型')}">${escapeHtml(s.model_name || '未知模型')}</td>
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

let monitorTimer = null;
const formatMetricNumber = (value, digits = 0) => Number(value || 0).toLocaleString(undefined, {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits
});
const formatBytes = (bytes) => {
    const value = Number(bytes) || 0;
    if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GB`;
    if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MB`;
    if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${value} B`;
};
const formatDuration = (seconds) => {
    const value = Number(seconds) || 0;
    const days = Math.floor(value / 86400);
    const hours = Math.floor((value % 86400) / 3600);
    const minutes = Math.floor((value % 3600) / 60);
    if (days > 0) return `${days}天 ${hours}小时`;
    if (hours > 0) return `${hours}小时 ${minutes}分钟`;
    return `${minutes}分钟`;
};

const formatMsDuration = (milliseconds) => {
    const value = Math.max(0, Number(milliseconds) || 0);
    if (value >= 60000) return `${Math.ceil(value / 60000)} 分钟`;
    if (value >= 1000) return `${Math.ceil(value / 1000)} 秒`;
    return `${Math.ceil(value)} ms`;
};

const describeEndpointMonitor = (monitor = {}) => {
    if (!monitor.configured) return '未配置健康探针';
    const latency = monitor.latencyMs !== null && monitor.latencyMs !== undefined
        ? ` · ${formatMetricNumber(monitor.latencyMs)} ms`
        : '';
    if (monitor.status === 'unreachable') return `探针不可达${latency}`;
    if (monitor.status === 'degraded') return `探针异常${latency}`;
    return `${monitor.status || 'ok'}${latency}`;
};

const ROUTE_NAME_MAP = {
    '/api/auth/login': '用户登录',
    '/api/auth/register': '用户注册',
    '/api/auth/me': '获取当前用户',
    '/api/auth/logout': '退出登录',
    '/api/auth/keys': '密钥管理',
    '/api/chat/completions': 'AI对话补全',
    '/api/models': '获取模型列表',
    '/api/stats/usage': '用量统计查询',
    '/api/stats/details': '用量明细查询',
    '/api/stats/trend': '用量趋势数据',
    '/api/stats/report': '报表数据分析',
    '/api/stats/monitor-summary': '获取监控数据',
    '/api/admin/logs': '审计日志查询',
    '/api/settings/rag': 'RAG功能配置',
    '/api/settings/password': '修改用户密码',
    '/api/upload': '附件上传',
    '/api/models/test': '模型连接测试',
    '/api/attachments': '获取附件列表',
    '/api/auth/config': '获取认证配置',
    '/api/stats/ops-summary': '获取运营概览',
    '/': '静态资源访问'
};

window.loadMonitorSummary = async function() {
    if (currentUser?.role !== 'admin') return;
    try {
        const res = await apiFetch(`${API_BASE}/stats/monitor-summary`);
        if (!res.ok) throw new Error('系统监控加载失败');
        const data = await res.json();
        const memoryUsedRate = data.system.memory.total > 0 ? data.system.memory.used / data.system.memory.total : 0;
        const errorRate = (data.http.errorRate || 0) * 100;
        const concurrency = data.concurrency || {};
        const gpu = data.gpu || {};
        const endpoints = data.modelEndpoints || {};
        const gpuMaxRate = Number(gpu.maxRatio || 0) * 100;
        const gpuScopeHint = endpoints.hasRemoteModels
            ? `检测到 ${formatMetricNumber(endpoints.remoteCount)} 个远端模型，本机 GPU 不代表远端负载`
            : '仅当模型部署在当前服务器时代表模型负载';
        const cards = [
            ['AI 并发', `${formatMetricNumber(concurrency.active)}/${formatMetricNumber(concurrency.max)}`, `排队 ${formatMetricNumber(concurrency.queued)}/${formatMetricNumber(concurrency.maxQueue)}`],
            ['GPU 显存', gpu.available ? `${gpuMaxRate.toFixed(1)}%` : '未检测到', gpu.overloaded ? '保护中，拒绝新请求' : gpuScopeHint],
            ['今日 Token', formatMetricNumber(data.tokens.today), '累计 ' + formatMetricNumber(data.tokens.total)],
            ['今日消息', formatMetricNumber(data.tokens.todayMessages), '用户与模型消息总量'],
            ['请求总数', formatMetricNumber(data.http.requests), `错误率 ${errorRate.toFixed(2)}%`],
            ['平均延迟', `${formatMetricNumber(data.http.avgLatencyMs, 1)} ms`, `P95 ${formatMetricNumber(data.http.p95LatencyMs, 1)} ms`],
            ['进程内存', formatBytes(data.process.memory.rss), `堆 ${formatBytes(data.process.memory.heapUsed)}`],
            ['系统负载', data.system.loadAverage.map(v => Number(v).toFixed(2)).join(' / '), `${data.system.cpuCount} 核 CPU`]
        ];
        document.getElementById('monitor-summary-grid').innerHTML = cards.map(([label, value, hint]) => `
            <div class="monitor-card${label === 'GPU 显存' && gpu.overloaded ? ' is-warning' : ''}">
                <span>${escapeHtml(label)}</span>
                <strong title="${escapeHtml(value)}">${escapeHtml(value)}</strong>
                <small title="${escapeHtml(hint)}">${escapeHtml(hint)}</small>
            </div>
        `).join('');

        document.getElementById('monitor-resource-list').innerHTML = [
            ['运行时长', formatDuration(data.process.uptimeSeconds)],
            ['系统内存', `${formatBytes(data.system.memory.used)} / ${formatBytes(data.system.memory.total)} (${(memoryUsedRate * 100).toFixed(1)}%)`],
            ['进程 CPU', `${data.process.cpuSeconds.user.toFixed(2)}s 用户 / ${data.process.cpuSeconds.system.toFixed(2)}s 系统`],
            ['运行平台', data.system.platform]
        ].map(([k, v]) => `<div class="monitor-row"><span>${escapeHtml(k)}</span><strong>${escapeHtml(v)}</strong></div>`).join('');

        const gpuRows = gpu.available && Array.isArray(gpu.gpus) && gpu.gpus.length
            ? gpu.gpus.map(item => {
                const usedRate = Number(item.ratio || 0) * 100;
                const utilRate = Number(item.utilization || 0) * 100;
                return `<div class="monitor-row">
                    <span>${escapeHtml(`#${item.index} ${item.name || 'GPU'}`)}</span>
                    <strong>${escapeHtml(`${formatBytes(item.usedBytes)} / ${formatBytes(item.totalBytes)} (${usedRate.toFixed(1)}%，负载 ${utilRate.toFixed(0)}%)`)}</strong>
                </div>`;
            }).join('')
            : `<div class="monitor-empty">${escapeHtml(gpu.error ? `未获取到 GPU 指标：${gpu.error}` : '未检测到 NVIDIA GPU 指标')}</div>`;
        const endpointNotice = endpoints.hasRemoteModels
            ? `<div class="monitor-empty is-warning">检测到远端模型：${escapeHtml((endpoints.remoteModels || []).map(item => `${item.name}@${item.host}`).join('，') || '未列出')}。本机 GPU 指标仅代表 Pivot 所在服务器；并发保护只限制本系统发出的请求数。</div>`
            : '<div class="monitor-empty">本机 GPU 监控仅当模型服务部署在当前服务器时才代表模型负载。</div>';
        document.getElementById('monitor-gpu-list').innerHTML = [
            endpointNotice,
            `<div class="monitor-row"><span>保护状态</span><strong>${escapeHtml(gpu.overloaded ? '保护中' : '正常')}</strong></div>`,
            `<div class="monitor-row"><span>拒绝阈值</span><strong>${escapeHtml(`${((gpu.thresholds?.reject || 0) * 100).toFixed(0)}%`)}</strong></div>`,
            gpuRows
        ].join('');

        const models = data.tokens.byModel || [];
        document.getElementById('monitor-model-list').innerHTML = models.length
            ? models.map(item => `<div class="monitor-row"><span>${escapeHtml(item.model_name)}</span><strong>${formatMetricNumber(item.tokens)}</strong></div>`).join('')
            : '<div class="monitor-empty">今日暂无 Token 消耗</div>';

        const runtimeEndpoints = Array.isArray(endpoints.runtime) ? endpoints.runtime : [];
        const endpointListEl = document.getElementById('monitor-endpoint-list');
        if (endpointListEl) {
            endpointListEl.innerHTML = runtimeEndpoints.length
                ? runtimeEndpoints.map(item => {
                    const concurrencyStatus = item.concurrency || {};
                    const circuit = Number(item.circuitOpenMs || 0) > 0 ? ` · 熔断 ${formatMsDuration(item.circuitOpenMs)}` : '';
                    const failures = Number(item.consecutiveFailures || 0) > 0 ? ` · 失败 ${formatMetricNumber(item.consecutiveFailures)}` : '';
                    const modelNames = (item.models || []).map(model => model.name).filter(Boolean).slice(0, 3).join('、') || item.name || item.host;
                    const detail = `${describeEndpointMonitor(item.monitor)} · 并发 ${formatMetricNumber(concurrencyStatus.active)}/${formatMetricNumber(concurrencyStatus.max)} · 排队 ${formatMetricNumber(concurrencyStatus.queued)}${failures}${circuit}`;
                    const warningClass = item.monitor?.status === 'unreachable' || Number(item.circuitOpenMs || 0) > 0 ? ' is-warning' : '';
                    return `<div class="monitor-endpoint${warningClass}">
                        <div class="monitor-row">
                            <span title="${escapeHtml(item.host || item.key)}">${escapeHtml(modelNames)}</span>
                            <strong>${escapeHtml(item.host || item.key)}</strong>
                        </div>
                        <div class="monitor-empty">${escapeHtml(detail)}</div>
                    </div>`;
                }).join('')
                : '<div class="monitor-empty">暂无模型端点运行数据</div>';
        }

        const routes = data.http.routes || [];
        document.getElementById('monitor-routes-body').innerHTML = routes.length
            ? routes.map((route, idx) => {
                const name = ROUTE_NAME_MAP[route.route] || '未知接口';
                return `
                <tr>
                    <td class="text-center">${idx + 1}</td>
                    <td title="${escapeHtml(name)}">${escapeHtml(name)}</td>
                    <td>${escapeHtml(route.method)}</td>
                    <td title="${escapeHtml(route.route)}">${escapeHtml(route.route)}</td>
                    <td class="text-center">${escapeHtml(route.status)}</td>
                    <td>${formatMetricNumber(route.requests)}</td>
                    <td>${formatMetricNumber(route.avgLatencyMs, 1)} ms</td>
                </tr>
            `}).join('')
            : '<tr><td colspan="8" class="text-center">暂无请求数据</td></tr>';

        document.getElementById('monitor-updated-at').innerText = `最近刷新：${formatDateToCN(data.updatedAt)}`;
        scheduleMonitorRefresh();
    } catch (e) {
        showToast(e.message || '系统监控加载失败', 'error');
    }
};

function scheduleMonitorRefresh() {
    clearTimeout(monitorTimer);
    const visible = !document.getElementById('tab-content-monitor')?.classList.contains('hidden');
    const enabled = document.getElementById('monitor-auto-refresh')?.checked;
    if (visible && enabled) {
        monitorTimer = setTimeout(() => window.loadMonitorSummary(), 10000);
    }
}

window.exportDetails = () => downloadFileByFetch(`${API_BASE}/stats/details/export`, 'usage_details.csv');

window.exportStats = () => {
    const rows = Array.from(document.querySelectorAll('#stats-list-body tr'));
    let csv = '\uFEFF用户,显示名,模型,消息数,总Token,最后活动\n';
    rows.forEach(row => { 
        const tds = Array.from(row.querySelectorAll('td')).slice(1); // 跳过序号列
        csv += tds.map(td => escapeCsvValue(td.innerText)).join(',') + '\n'; 
    });
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'usage_stats.csv'; a.click();
};

window.loadLogs = async function(page = 1) {
    try {
        const res = await fetch(`${API_BASE}/admin/logs?page=${page}&limit=${pageState.limit}`, { headers: authHeaders() });
        const { data, total } = await res.json();
        document.getElementById('log-list-body').innerHTML = data.map((l, i) => `
            <tr>
                <td class="text-center">${(page - 1) * pageState.limit + i + 1}</td>
                <td>${escapeHtml(formatDateToCN(l.timestamp))}</td>
                <td title="${escapeHtml(l.username || '系统')}">${escapeHtml(l.username || '系统')}</td>
                <td>${escapeHtml(l.ip_address || '-')}</td>
                <td><strong>${escapeHtml(l.action)}</strong></td>
                <td>${escapeHtml(l.details)}</td>
            </tr>
        `).join('');
        renderPagination('logs', total, page);
    } catch (e) { showToast('加载日志失败', 'error'); }
}

window.exportLogs = () => downloadFileByFetch(`${API_BASE}/admin/logs/export`, 'audit_logs.csv');

window.loadReport = async function() {
    const unit = document.getElementById('report-unit').value || '';
    const username = document.getElementById('report-username').value || '';
    const days = document.getElementById('report-days').value || 30;

    try {
        const res = await fetch(`${API_BASE}/stats/report?unit=${encodeURIComponent(unit)}&username=${encodeURIComponent(username)}&days=${days}`, { headers: authHeaders() });
        const data = await res.json();
        
        // 动态填充部门下拉框
        const unitSelect = document.getElementById('report-unit');
        if (unitSelect.options.length <= 1 && data.units) {
            data.units.forEach(u => {
                const opt = document.createElement('option');
                opt.value = u; opt.innerText = u;
                unitSelect.appendChild(opt);
            });
            unitSelect.value = unit;
        }

        renderTrendChart('report-trend-chart', data.trend);
        renderBarChart('report-user-chart', data.byUser, 'nickname', 'username');
        renderBarChart('report-unit-chart', data.byUnit, 'unit', 'unit');
    } catch (e) {
        showToast('加载报表失败', 'error');
    }
}

function renderBarChart(canvasId, data, labelField, fallbackField) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(rect.width || 400, 320);
    const height = Number(canvas.getAttribute('height')) || 250;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = width * ratio; canvas.height = height * ratio;
    canvas.style.width = `${width}px`; canvas.style.height = `${height}px`;
    ctx.scale(ratio, ratio);
    ctx.clearRect(0, 0, width, height);

    const values = data.map(d => Number(d.tokens) || 0);
    const labels = data.map(d => String(d[labelField] || d[fallbackField] || '未知'));
    const max = Math.max(...values, 1);
    const padX = 120; const padY = 20; const chartW = width - padX - 60; const chartH = height - padY * 2;

    if (values.length === 0) {
        ctx.fillStyle = '#6b7280'; ctx.font = '13px sans-serif';
        ctx.fillText('暂无数据', padX, height / 2); return;
    }

    const spacing = chartH / Math.max(values.length, 5);
    const barHeight = spacing * 0.6;

    ctx.font = '12px sans-serif';
    ctx.textBaseline = 'middle';

    values.forEach((v, i) => {
        const y = padY + spacing * i + spacing / 2;
        
        // 标签绘制
        ctx.fillStyle = '#4b5563';
        let labelText = labels[i];
        if (labelText.length > 12) labelText = labelText.slice(0, 11) + '...';
        ctx.textAlign = 'right';
        ctx.fillText(labelText, padX - 10, y);

        // 条块绘制
        const barWidth = (v / max) * chartW;
        ctx.fillStyle = '#10a37f';
        ctx.beginPath();
        // 绘制圆角矩形
        const r = 4;
        const bx = padX, by = y - barHeight / 2, bw = barWidth, bh = barHeight;
        ctx.moveTo(bx + r, by);
        ctx.lineTo(bx + bw - r, by);
        ctx.quadraticCurveTo(bx + bw, by, bx + bw, by + r);
        ctx.lineTo(bx + bw, by + bh - r);
        ctx.quadraticCurveTo(bx + bw, by + bh, bx + bw - r, by + bh);
        ctx.lineTo(bx + r, by + bh);
        ctx.quadraticCurveTo(bx, by + bh, bx, by + bh - r);
        ctx.lineTo(bx, by + r);
        ctx.quadraticCurveTo(bx, by, bx + r, by);
        ctx.fill();

        // 数值绘制
        ctx.textAlign = 'left';
        ctx.fillStyle = '#6b7280';
        ctx.fillText(v.toLocaleString(), padX + barWidth + 8, y);
    });
}
