/* 统计与日志模块 Stats & Logs */

function formatStatsPriceCurrency(value) {
    const raw = String(value || '').trim();
    if (!raw) return '人民币';
    return /[一-龥]/.test(raw) ? raw : '人民币';
}

function formatEstimatedCost(value, currency = '人民币') {
    const currencyLabel = formatStatsPriceCurrency(currency);
    const amount = Number(value || 0);
    if (amount <= 0) return `${currencyLabel} 0`;
    return `${currencyLabel} ${amount.toLocaleString(undefined, { maximumFractionDigits: 6 })}`;
}

const USAGE_ROLE_LABELS = {
    user: '提问',
    assistant: '回答',
    system: '系统',
    tool: '工具',
    deleted_session: '已删会话',
    rag_embedding: '知识库向量',
    agent_planner: '智能体规划',
    agent_summary: '智能体总结',
    openai_api_key: 'OpenAI 兼容接口',
    openai_cookie: '网页登录接口',
    embedding_api_key: '向量接口',
    embedding_cookie: '网页登录向量',
    api: 'API 调用',
    unknown: '未知'
};

function formatUsageRoleLabel(role) {
    const key = String(role || 'unknown').trim() || 'unknown';
    if (USAGE_ROLE_LABELS[key]) return USAGE_ROLE_LABELS[key];
    if (key.startsWith('agent_')) return '智能体调用';
    if (key.includes('embedding')) return '向量调用';
    if (key.includes('api_key')) return 'API Key 调用';
    if (key.includes('cookie')) return '网页登录调用';
    return '其它调用';
}

window.Pivot.legacy.loadDetails = async function(page = 1) {
    const titleEl = document.getElementById('details-title') || document.getElementById('usage-title');
    if (titleEl) titleEl.innerText = '用量明细';
    try {
        const res = await apiFetch(`${API_BASE}/stats/details?page=${page}&limit=${pageState.limit}`, { headers: authHeaders() });
        const { data, total } = await res.json();
        PivotSafeHtml.setHtml(document.getElementById('details-list-body'), data.map((d, i) => {
            const roleLabel = formatUsageRoleLabel(d.role);
            const username = d.username || '-';
            const displayName = d.nickname || d.username || '-';
            return `
                <tr>
                    <td class="text-center">${(page - 1) * pageState.limit + i + 1}</td>
                    <td title="${escapeHtml(formatDateToCN(d.created_at))}">${escapeHtml(formatDateToCN(d.created_at))}</td>
                    <td title="${escapeHtml(username)}">${escapeHtml(username)}</td>
                    <td title="${escapeHtml(displayName)}">${escapeHtml(displayName)}</td>
                    <td title="${escapeHtml(d.model_name || '未知')}">${escapeHtml(d.model_name || '未知')}</td>
                    <td class="text-center" title="${escapeHtml(roleLabel)}">${escapeHtml(roleLabel)}</td>
                    <td class="text-center" title="${Number(d.input_tokens || 0).toLocaleString()}">${formatTokenCount(d.input_tokens)}</td>
                    <td class="text-center" title="${Number(d.output_tokens || 0).toLocaleString()}">${formatTokenCount(d.output_tokens)}</td>
                    <td class="text-center" title="${Number(d.token_count || 0).toLocaleString()}">${formatTokenCount(d.token_count)}</td>
                </tr>
            `;
        }).join(''));
        renderPagination('details', total, page);
    } catch (e) { showToast('加载明细失败', 'error'); }
};

window.Pivot.legacy.loadStats = async function(page = pageState.stats || 1) {
    const requestedPage = Math.max(parseInt(page, 10) || 1, 1);
    pageState.stats = requestedPage;
    const titleEl = document.getElementById('stats-title') || document.getElementById('usage-title');
    if (titleEl) titleEl.innerText = '用量统计';
    try {
        const params = new URLSearchParams({
            page: String(requestedPage),
            limit: String(pageState.limit || 15)
        });
        const res = await apiFetch(`${API_BASE}/stats/usage?${params.toString()}`, { headers: authHeaders() });
        const payload = await res.json();
        const data = Array.isArray(payload) ? payload : (payload.data || []);
        const total = Array.isArray(payload) ? data.length : Number(payload.total || data.length || 0);
        const tbody = document.getElementById('stats-list-body');
        if (!tbody) return;
        PivotSafeHtml.setHtml(tbody, data.length ? data.map((s, idx) => `
            <tr>
                <td class="text-center">${(requestedPage - 1) * pageState.limit + idx + 1}</td>
                <td title="${escapeHtml(s.username)}">${escapeHtml(s.username)}</td>
                <td title="${escapeHtml(s.nickname || s.username)}">${escapeHtml(s.nickname || s.username)}</td>
                <td title="${escapeHtml(s.model_name || '未知模型')}">${escapeHtml(s.model_name || '未知模型')}</td>
                <td class="text-center">${s.msg_count}</td>
                <td class="text-center" title="${Number(s.input_tokens || 0).toLocaleString()}">${formatTokenCount(s.input_tokens)}</td>
                <td class="text-center" title="${Number(s.output_tokens || 0).toLocaleString()}">${formatTokenCount(s.output_tokens)}</td>
                <td class="text-center" title="${Number(s.total_tokens || 0).toLocaleString()}">${formatTokenCount(s.total_tokens)} / <small>${escapeHtml(formatEstimatedCost(s.estimated_cost, s.price_currency || '人民币'))}</small></td>
                <td>${s.last_active || '-'}</td>
            </tr>
        `).join('') : '<tr><td colspan="9" class="text-center">暂无统计数据</td></tr>');
        renderPagination('stats', total, requestedPage);
    } catch (e) {
        renderPagination('stats', 0, 1);
        showToast('加载统计失败', 'error');
    }
};

const trendChartRetryFrames = {};
const trendChartRetryCounts = {};

function renderTrendChart(canvasId, data) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const parentWidth = canvas.parentElement?.clientWidth || 0;
    // 容器尚未完成布局时（所在标签页处于 hidden、缩放容器宽度变量未就绪等），
    // parentElement.clientWidth 会读到 0。此处等待容器获得真实未缩放宽度后再绘制。
    if (parentWidth < 1) {
        if (trendChartRetryFrames[canvasId]) window.cancelAnimationFrame(trendChartRetryFrames[canvasId]);
        trendChartRetryCounts[canvasId] = (trendChartRetryCounts[canvasId] || 0) + 1;
        if (trendChartRetryCounts[canvasId] <= 60) {
            trendChartRetryFrames[canvasId] = window.requestAnimationFrame(() => {
                trendChartRetryFrames[canvasId] = 0;
                renderTrendChart(canvasId, data);
            });
        } else {
            trendChartRetryCounts[canvasId] = 0;
        }
        return;
    }
    trendChartRetryCounts[canvasId] = 0;

    const ctx = canvas.getContext('2d');
    const width = Math.max(parentWidth, 320);
    const height = Number(canvas.getAttribute('height')) || 150;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = width * ratio;
    canvas.height = height * ratio;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.scale(ratio, ratio);
    ctx.clearRect(0, 0, width, height);

    const chartData = Array.isArray(data) ? data : [];
    const values = chartData.map(d => Number(d?.tokens) || 0);
    const labels = chartData.map(d => String(d?.day || '').slice(5));
    const max = Math.max(...values, 1);
    const padLeft = 30;
    const padRight = 18;
    const padTop = height < 180 ? 16 : 28;
    const padBottom = height < 180 ? 24 : 42;
    const chartW = width - padLeft - padRight;
    const chartH = height - padTop - padBottom;

    ctx.strokeStyle = '#e5e7eb';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 3; i++) {
        const y = padTop + chartH * (i / 3);
        ctx.beginPath();
        ctx.moveTo(padLeft, y);
        ctx.lineTo(width - padRight, y);
        ctx.stroke();
    }

    if (values.length === 0) {
        ctx.fillStyle = '#6b7280';
        ctx.font = '13px sans-serif';
        ctx.fillText('暂无趋势数据', padLeft, height / 2);
        return;
    }

    const points = values.map((v, i) => ({
        x: padLeft + (values.length === 1 ? chartW : chartW * i / (values.length - 1)),
        y: padTop + chartH - (v / max) * chartH,
        label: labels[i],
        value: v
    }));

    ctx.beginPath();
    points.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
    ctx.strokeStyle = '#10a37f';
    ctx.lineWidth = 2;
    ctx.stroke();
    
    ctx.fillStyle = 'rgba(16, 163, 127, 0.12)';
    ctx.lineTo(points[points.length - 1].x, height - padBottom);
    ctx.lineTo(points[0].x, height - padBottom);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = '#10a37f';
    points.forEach(p => {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
        ctx.fill();
    });
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    points.forEach(p => {
        const text = formatTokenCount(p.value);
        const y = Math.max(14, p.y - 7);
        const textWidth = ctx.measureText(text).width;
        ctx.fillStyle = 'rgba(255, 255, 255, 0.88)';
        ctx.fillRect(p.x - textWidth / 2 - 4, y - 12, textWidth + 8, 14);
        ctx.fillStyle = '#047857';
        ctx.fillText(text, p.x, y);
    });
    const labelCount = Math.min(values.length, Math.max(4, Math.floor(width / 140)));
    const labelIndexes = new Set([0, values.length - 1]);
    if (labelCount > 2) {
        for (let i = 1; i < labelCount - 1; i += 1) {
            labelIndexes.add(Math.round((values.length - 1) * (i / (labelCount - 1))));
        }
    }
    ctx.fillStyle = '#6b7280';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    labelIndexes.forEach(index => {
        const p = points[index];
        if (!p) return;
        ctx.fillText(p.label || '', p.x, height - padBottom + 8);
    });
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(formatTokenCount(max), padLeft, 14);
}

window.Pivot.legacy.exportDetails = () => downloadFileByFetch(`${API_BASE}/stats/details/export`, 'usage_details.csv');
window.Pivot.legacy.exportModelCosts = () => downloadFileByFetch(`${API_BASE}/stats/model-costs/export`, 'model_costs.csv');
window.Pivot.legacy.exportCompliancePackage = () => {
    const start = document.getElementById('log-filter-start')?.value || '';
    const end = document.getElementById('log-filter-end')?.value || '';
    const params = new URLSearchParams({ start, end });
    downloadFileByFetch(`${API_BASE}/admin/compliance/export?${params.toString()}`, 'pivot_compliance_audit.zip');
};

window.Pivot.legacy.openMonitorRoutesModal = () => {
    const modal = document.getElementById('monitor-routes-modal');
    modal?.classList.remove('hidden');
    modal?.setAttribute('aria-hidden', 'false');
};

window.Pivot.legacy.closeMonitorRoutesModal = () => {
    const modal = document.getElementById('monitor-routes-modal');
    modal?.classList.add('hidden');
    modal?.setAttribute('aria-hidden', 'true');
};

window.Pivot.legacy.exportStats = () => downloadFileByFetch(`${API_BASE}/stats/usage/export`, 'usage_stats.csv');

window.Pivot.legacy.loadLogs = async function(page = 1) {
    try {
        const username = document.getElementById('log-filter-user')?.value || '';
        const action = document.getElementById('log-filter-action')?.value || '';
        const details = document.getElementById('log-filter-details')?.value || '';
        const ip = document.getElementById('log-filter-ip')?.value || '';
        const start = document.getElementById('log-filter-start')?.value || '';
        const end = document.getElementById('log-filter-end')?.value || '';
        
        pageState.logs = page;
        const limit = pageState.limit || 15;
        const params = new URLSearchParams({
            page,
            limit,
            username,
            action,
            details,
            ip,
            start,
            end
        });

        const res = await apiFetch(`${API_BASE}/admin/logs?${params.toString()}`, { headers: authHeaders() });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const { data, total } = await res.json();
        const tbody = document.getElementById('log-list-body');
        if (!tbody) return;

        if (!Array.isArray(data) || data.length === 0) {
            renderTableMessage(tbody, 7, '暂无审计日志记录');
            renderPagination('logs', 0, page);
            return;
        }

        PivotSafeHtml.setHtml(tbody, data.map((l, i) => {
            const username = l.username || '系统';
            const displayName = l.nickname || (l.username ? '-' : '系统');
            return `
                <tr>
                    <td class="text-center">${(page - 1) * limit + i + 1}</td>
                    <td>${escapeHtml(formatDateToCN(l.timestamp))}</td>
                    <td title="${escapeHtml(username)}">${escapeHtml(username)}</td>
                    <td title="${escapeHtml(displayName)}">${escapeHtml(displayName)}</td>
                    <td>${escapeHtml(l.ip_address || '-')}</td>
                    <td title="${escapeHtml(l.action)}"><strong>${escapeHtml(l.action)}</strong></td>
                    <td title="${escapeHtml(l.details || '')}">${escapeHtml(l.details || '')}</td>
                </tr>
            `;
        }).join(''));
        renderPagination('logs', total || data.length, page);
    } catch (e) { showToast('加载日志失败', 'error'); }
};

window.Pivot.legacy.resetLogFilters = () => {
    ['user', 'action', 'details', 'ip', 'start', 'end'].forEach(f => {
        const el = document.getElementById(`log-filter-${f}`);
        if (el) el.value = '';
    });
    window.Pivot.legacy.loadLogs(1);
};

window.Pivot.legacy.exportLogs = () => {
    const username = document.getElementById('log-filter-user')?.value || '';
    const action = document.getElementById('log-filter-action')?.value || '';
    const details = document.getElementById('log-filter-details')?.value || '';
    const ip = document.getElementById('log-filter-ip')?.value || '';
    const start = document.getElementById('log-filter-start')?.value || '';
    const end = document.getElementById('log-filter-end')?.value || '';
    
    const params = new URLSearchParams({ username, action, details, ip, start, end });
    downloadFileByFetch(`${API_BASE}/admin/logs/export?${params.toString()}`, 'audit_logs.csv');
};

window.Pivot.legacy.loadReport = async function() {
    window.Pivot.legacy.bindReportDateFilters?.();
    window.Pivot.legacy.syncReportDateFilters?.();
    const unit = document.getElementById('report-unit')?.value || '';
    const username = document.getElementById('report-username')?.value || '';
    const period = document.getElementById('report-days')?.value || '30';
    const start = document.getElementById('report-start')?.value || '';
    const end = document.getElementById('report-end')?.value || '';
    const params = new URLSearchParams({ unit, username });
    if (period === 'custom') {
        if (!start || !end) return showToast('请选择自定义开始和结束日期', 'error');
        if (start > end) return showToast('开始日期不能晚于结束日期', 'error');
        params.set('start', start);
        params.set('end', end);
    } else {
        params.set('days', period);
    }

    try {
        const res = await apiFetch(`${API_BASE}/stats/report?${params.toString()}`, { headers: authHeaders() });
        const data = await res.json();
        
        // 动态填充部门下拉框
        const unitSelect = document.getElementById('report-unit');
        if (unitSelect && unitSelect.options.length <= 1 && data.units) {
            data.units.forEach(u => {
                const opt = document.createElement('option');
                opt.value = u;
                opt.innerText = u;
                unitSelect.appendChild(opt);
            });
            unitSelect.value = unit;
        }

        renderTrendChart('report-trend-chart', data.trend);
        renderBarChart('report-user-chart', data.byUser, 'nickname', 'username');
        renderBarChart('report-unit-chart', data.byUnit, 'unit', 'unit');
        window.Pivot.legacy.scheduleSettingsWorkspaceScale?.();
        setTimeout(() => window.Pivot.legacy.scheduleSettingsWorkspaceScale?.(), 0);
    } catch (e) {
        showToast('加载报表失败', 'error');
    }
};

function exportReport() {
    window.Pivot.legacy.bindReportDateFilters?.();
    window.Pivot.legacy.syncReportDateFilters?.();
    const unit = document.getElementById('report-unit')?.value || '';
    const username = document.getElementById('report-username')?.value || '';
    const period = document.getElementById('report-days')?.value || '30';
    const start = document.getElementById('report-start')?.value || '';
    const end = document.getElementById('report-end')?.value || '';
    const params = new URLSearchParams({ unit, username });
    if (period === 'custom') {
        if (!start || !end) return showToast('请选择自定义开始和结束日期', 'error');
        if (start > end) return showToast('开始日期不能晚于结束日期', 'error');
        params.set('start', start);
        params.set('end', end);
    } else {
        params.set('days', period);
    }
    downloadFileByFetch(`${API_BASE}/stats/report/export?${params.toString()}`, 'audit_report.csv');
}

window.Pivot?.exposeModule?.('chat.stats', {
    exportReport
}, ['exportReport']);

window.Pivot.legacy.syncReportDateFilters = function() {
    const period = document.getElementById('report-days')?.value || '30';
    document.getElementById('report-custom-range')?.classList.toggle('hidden', period !== 'custom');
};

window.Pivot.legacy.bindReportDateFilters = function() {
    const periodSelect = document.getElementById('report-days');
    if (periodSelect && periodSelect.dataset.boundReportRange !== '1') {
        periodSelect.dataset.boundReportRange = '1';
        periodSelect.addEventListener('change', () => window.Pivot.legacy.syncReportDateFilters());
    }
    const resetBtn = document.getElementById('report-reset-btn');
    if (resetBtn && resetBtn.dataset.boundReportReset !== '1') {
        resetBtn.dataset.boundReportReset = '1';
        resetBtn.addEventListener('click', window.Pivot.legacy.resetReportFilters);
    }
    window.Pivot.legacy.syncReportDateFilters();
};

window.Pivot.legacy.resetReportFilters = function() {
    const unit = document.getElementById('report-unit');
    const username = document.getElementById('report-username');
    const period = document.getElementById('report-days');
    const start = document.getElementById('report-start');
    const end = document.getElementById('report-end');
    if (unit) unit.value = '';
    if (username) username.value = '';
    if (period) period.value = '30';
    if (start) start.value = '';
    if (end) end.value = '';
    window.Pivot.legacy.syncReportDateFilters?.();
    window.Pivot.legacy.loadReport?.();
};

function renderBarChart(canvasId, data, labelField, fallbackField) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const rect = canvas.getBoundingClientRect();
    const parentWidth = canvas.parentElement?.clientWidth || 0;
    const width = Math.max(rect.width || parentWidth || 400, 320);
    const height = Number(canvas.getAttribute('height')) || 140;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = width * ratio;
    canvas.height = height * ratio;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.scale(ratio, ratio);
    ctx.clearRect(0, 0, width, height);

    const chartData = Array.isArray(data) ? data : [];
    const values = chartData.map(d => Number(d?.tokens) || 0);
    const labels = chartData.map(d => String(d?.[labelField] || d?.[fallbackField] || '未知'));
    const max = Math.max(...values, 1);
    ctx.font = '12px sans-serif';
    const longestLabelWidth = labels.reduce((longest, label) => Math.max(longest, ctx.measureText(label).width), 0);
    const labelColumnWidth = Math.min(
        Math.max(Math.ceil(longestLabelWidth + 20), 140),
        Math.max(180, Math.floor(width * 0.45))
    );
    const padX = labelColumnWidth;
    const padY = height < 180 ? 10 : 20;
    const chartW = width - padX - 60;
    const chartH = height - padY * 2;

    if (values.length === 0) {
        ctx.fillStyle = '#6b7280';
        ctx.font = '13px sans-serif';
        ctx.fillText('暂无数据', padX, height / 2);
        return;
    }

    const spacing = chartH / Math.max(values.length, 5);
    const barHeight = spacing * 0.6;

    ctx.textBaseline = 'middle';

    values.forEach((v, i) => {
        const y = padY + spacing * i + spacing / 2;
        
        // 标签绘制
        ctx.fillStyle = '#4b5563';
        const labelText = labels[i];
        ctx.textAlign = 'right';
        ctx.fillText(labelText, padX - 10, y, padX - 16);

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
        ctx.fillText(formatTokenCount(v), padX + barWidth + 8, y);
    });
}
