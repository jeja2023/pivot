/* 统计与日志模块 Stats & Logs */

function formatEstimatedCost(value, currency = 'CNY') {
    const amount = Number(value || 0);
    if (amount <= 0) return `${currency} 0`;
    return `${currency} ${amount.toLocaleString(undefined, { maximumFractionDigits: 6 })}`;
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

function ensureStatsExportActions() {
    const exportBtn = document.getElementById('stats-export-btn');
    if (!exportBtn || document.getElementById('model-cost-export-btn')) return;
    const wrap = document.createElement('div');
    wrap.className = 'export-action-group';
    exportBtn.parentElement?.insertBefore(wrap, exportBtn);
    wrap.appendChild(exportBtn);
    const costBtn = document.createElement('button');
    costBtn.id = 'model-cost-export-btn';
    costBtn.type = 'button';
    costBtn.className = 'btn-secondary';
    costBtn.textContent = '导出费用';
    costBtn.addEventListener('click', () => window.exportModelCosts?.());
    wrap.appendChild(costBtn);
    if (isAdminUser()) {
        const complianceBtn = document.createElement('button');
        complianceBtn.id = 'compliance-export-btn';
        complianceBtn.type = 'button';
        complianceBtn.className = 'btn-secondary';
        complianceBtn.textContent = '合规审计包';
        complianceBtn.addEventListener('click', () => window.exportCompliancePackage?.());
        wrap.appendChild(complianceBtn);
    }
}

window.loadDetails = async function(page = 1) {
    const titleEl = document.getElementById('details-title');
    if (titleEl) titleEl.innerText = '用量明细';
    try {
        const res = await apiFetch(`${API_BASE}/stats/details?page=${page}&limit=${pageState.limit}`, { headers: authHeaders() });
        const { data, total } = await res.json();
        document.getElementById('details-list-body').innerHTML = data.map((d, i) => {
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
        }).join('');
        renderPagination('details', total, page);
    } catch (e) { showToast('加载明细失败', 'error'); }
}

window.loadStats = async function() {
    ensureStatsExportActions();
    const titleEl = document.getElementById('stats-title');
    if (titleEl) titleEl.innerText = '用量统计';
    try {
        const res = await apiFetch(`${API_BASE}/stats/usage`, { headers: authHeaders() });
        const data = await res.json();
        document.getElementById('stats-list-body').innerHTML = data.map((s, idx) => `
            <tr>
                <td class="text-center">${idx + 1}</td>
                <td title="${escapeHtml(s.username)}">${escapeHtml(s.username)}</td>
                <td title="${escapeHtml(s.nickname || s.username)}">${escapeHtml(s.nickname || s.username)}</td>
                <td title="${escapeHtml(s.model_name || '未知模型')}">${escapeHtml(s.model_name || '未知模型')}</td>
                <td class="text-center">${s.msg_count}</td>
                <td class="text-center" title="${Number(s.input_tokens || 0).toLocaleString()}">${formatTokenCount(s.input_tokens)}</td>
                <td class="text-center" title="${Number(s.output_tokens || 0).toLocaleString()}">${formatTokenCount(s.output_tokens)}</td>
                <td class="text-center" title="${Number(s.total_tokens || 0).toLocaleString()}">${formatTokenCount(s.total_tokens)} / <small>${escapeHtml(formatEstimatedCost(s.estimated_cost, s.price_currency || 'CNY'))}</small></td>
                <td>${s.last_active || '-'}</td>
            </tr>
        `).join('');
    } catch (e) { showToast('加载统计失败', 'error'); }
}

function renderTrendChart(canvasId, data) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const rect = canvas.getBoundingClientRect();
    const parentWidth = canvas.parentElement?.clientWidth || 0;
    const width = Math.max(rect.width || parentWidth || 600, 320);
    const height = Number(canvas.getAttribute('height')) || 220;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = width * ratio; canvas.height = height * ratio;
    canvas.style.width = `${width}px`; canvas.style.height = `${height}px`;
    ctx.scale(ratio, ratio);
    ctx.clearRect(0, 0, width, height);

    const values = data.map(d => Number(d.tokens) || 0);
    const labels = data.map(d => String(d.day || '').slice(5));
    const max = Math.max(...values, 1);
    const padLeft = 30;
    const padRight = 18;
    const padTop = 28;
    const padBottom = 34;
    const chartW = width - padLeft - padRight;
    const chartH = height - padTop - padBottom;

    ctx.strokeStyle = '#e5e7eb'; ctx.lineWidth = 1;
    for (let i = 0; i <= 3; i++) {
        const y = padTop + chartH * (i / 3);
        ctx.beginPath(); ctx.moveTo(padLeft, y); ctx.lineTo(width - padRight, y); ctx.stroke();
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
    ctx.strokeStyle = '#10a37f'; ctx.lineWidth = 2; ctx.stroke();
    
    ctx.fillStyle = 'rgba(16, 163, 127, 0.12)';
    ctx.lineTo(points[points.length - 1].x, height - padBottom);
    ctx.lineTo(points[0].x, height - padBottom);
    ctx.closePath(); ctx.fill();

    ctx.fillStyle = '#10a37f';
    points.forEach(p => { ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, Math.PI*2); ctx.fill(); });
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

function renderMonitorEndpointLists(endpoints = {}) {
    const runtimeEndpoints = Array.isArray(endpoints.runtime) ? endpoints.runtime : [];
    const listEls = Array.from(document.querySelectorAll('.js-monitor-endpoint-list'));
    const legacyEl = document.getElementById('monitor-endpoint-list');
    if (legacyEl && !listEls.includes(legacyEl)) listEls.push(legacyEl);
    if (listEls.length === 0) return;

    const html = runtimeEndpoints.length
        ? runtimeEndpoints.map(item => {
            const concurrencyStatus = item.concurrency || {};
            const circuit = Number(item.circuitOpenMs || 0) > 0 ? ` · 熔断 ${formatMsDuration(item.circuitOpenMs)}` : '';
            const failures = Number(item.consecutiveFailures || 0) > 0 ? ` · 失败 ${formatMetricNumber(item.consecutiveFailures)}` : '';
            const modelNames = (item.models || []).map(model => model.name).filter(Boolean).slice(0, 3).join('、') || item.name || item.host;
            const detail = `${describeEndpointMonitor(item.monitor)} · 并发 ${formatMetricNumber(concurrencyStatus.active)}/${formatMetricNumber(concurrencyStatus.max)} · 排队 ${formatMetricNumber(concurrencyStatus.queued)}${failures}${circuit}`;
            const warningClass = item.monitor?.status === 'unreachable' || Number(item.circuitOpenMs || 0) > 0 ? ' is-warning' : '';
            const locBadge = item.isLocal
                ? '<span class="monitor-endpoint-badge is-local">本地</span>'
                : '<span class="monitor-endpoint-badge is-remote">远端</span>';
            return `<div class="monitor-endpoint${warningClass}">
                <div class="monitor-row">
                    <span title="${escapeHtml(item.host || item.key)}">${locBadge}${escapeHtml(modelNames)}</span>
                    <strong>${escapeHtml(item.host || item.key)}</strong>
                </div>
                <div class="monitor-empty">${escapeHtml(detail)}</div>
            </div>`;
        }).join('')
        : '<div class="monitor-empty">暂无模型端点运行数据</div>';

    listEls.forEach(el => { el.innerHTML = html; });
}

window.loadOpsSummary = async function() {
    try {
        const includeMonitor = isAdminUser();
        const [summaryRes, trendRes, monitorRes] = await Promise.all([
            apiFetch(`${API_BASE}/stats/ops-summary`, { headers: authHeaders() }),
            apiFetch(`${API_BASE}/stats/trend`, { headers: authHeaders() }),
            includeMonitor ? apiFetch(`${API_BASE}/stats/monitor-summary`) : Promise.resolve(null)
        ]);
        const summary = await summaryRes.json();
        const trend = await trendRes.json();
        if (monitorRes?.ok) {
            const monitorSummary = await monitorRes.json();
            renderMonitorEndpointLists(monitorSummary.modelEndpoints || {});
        }
        const formatSize = (bytes) => {
            const v = Number(bytes) || 0;
            if (v > 1024**3) return `${(v / 1024**3).toFixed(1)} GB`;
            if (v > 1024**2) return `${(v / 1024**2).toFixed(1)} MB`;
            return `${(v / 1024).toFixed(1)} KB`;
        };
        const cards = summary.isPersonal
            ? [['会话', summary.sessions], ['消息', summary.messages], ['附件', summary.attachments], ['模型', summary.models], ['Token', formatTokenCount(summary.tokens)]]
            : [['用户', `${summary.activeUsers}/${summary.users}`], ['会话', summary.sessions], ['消息', summary.messages], ['附件', summary.attachments], ['模型', summary.models], ['Token', formatTokenCount(summary.tokens)], ['占用', formatSize(summary.uploadsSize)], ['审计', summary.auditToday]];
        const gridEl = document.getElementById('ops-summary-grid');
        gridEl.style.gridTemplateColumns = 'repeat(auto-fit, minmax(132px, 1fr))';
        gridEl.innerHTML = cards.map(([l, v], index) => `<div class="ops-card ${index < 2 ? 'primary' : ''}"><span>${escapeHtml(l)}</span><strong>${escapeHtml(v)}</strong></div>`).join('');
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

const formatObservabilityDuration = (milliseconds) => {
    const value = Math.max(0, Number(milliseconds) || 0);
    if (value >= 60000) return `${(value / 60000).toFixed(1)} min`;
    if (value >= 1000) return `${(value / 1000).toFixed(1)} s`;
    return `${Math.ceil(value)} ms`;
};

const observabilityTypeLabels = {
    model: '模型',
    sql: 'SQL',
    rag: '知识库',
    http: '接口',
    system: '系统'
};

const observabilitySeverityLabels = {
    info: '提示',
    warning: '预警',
    critical: '严重'
};

const formatHealthStatus = (status) => {
    if (status === 'ok') return '正常';
    if (status === 'degraded') return '需关注';
    if (status === 'error') return '异常';
    return '未知';
};

const formatMaintenanceTime = (value) => value ? formatDateToCN(value) : '尚未成功';

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
    // 认证与授权
    '/api/auth/login': '用户登录验证',
    '/api/auth/register': '新用户注册',
    '/api/auth/me': '获取个人账户信息',
    '/api/auth/logout': '安全退出登录',
    '/api/auth/keys': 'API 密钥管理',
    '/api/auth/config': '获取认证配置',
    '/api/auth/refresh': '刷新身份令牌',
    
    // 对话核心
    '/api/chat': 'AI 对话请求',
    '/api/chat/completions': 'AI 对话流式补全',
    '/api/sessions': '会话列表管理',
    '/api/sessions/tags/list': '获取会话标签汇总',
    '/api/sessions/search/content': '全局消息全文搜索',
    '/api/sessions/:id': '获取/更新指定会话',
    '/api/sessions/:id/export': '导出对话记录 CSV',
    '/api/sessions/:id/pin': '置顶/取消置顶会话',
    '/api/sessions/:id/archive': '归档/恢复会话记录',
    '/api/sessions/:id/tags': '批量更新会话标签',
    '/api/sessions/:id/system-prompt': '设置会话系统提示词',
    '/api/messages': '获取历史消息流水',
    '/api/messages/:id': '物理删除单条消息',
    '/api/chat/title': '智能生成会话标题',
    '/api/chat/clear': '清空对话历史',
    
    // 用量与报表
    '/api/stats/usage': '个人用量统计',
    '/api/stats/details': '个人用量明细',
    '/api/stats/trend': '个人用量趋势',
    '/api/stats/report': '报表分析数据',
    '/api/stats/monitor-summary': '系统实时监控数据',
    '/api/stats/ops-summary': '运营后台汇总数据',
    
    // 管理员专享
    '/api/admin/users': '全站用户账号管理',
    '/api/admin/users/export': '导出全站用户 CSV',
    '/api/admin/users/import': '批量导入用户数据',
    '/api/admin/users/:id': '更新/删除指定用户',
    '/api/admin/users/:id/password': '管理员重置用户密码',
    '/api/admin/logs': '全量审计日志检索',
    '/api/admin/logs/export': '导出全量审计 CSV',
    '/api/stats/admin/usage': '全局多维度用量汇总',
    '/api/stats/admin/details': '全站消息流监控流水',
    '/api/stats/admin/trend': '全站每日流量趋势',
    
    // 模型管理
    '/api/models': '模型列表获取与增删',
    '/api/models/test': '端点连接稳定性测试',
    '/api/models/fetch-remote': '远程模型列表探测',
    '/api/models/:id': '更新/删除指定模型',
    '/api/models/:id/key': '解密查看模型密钥',
    
    // 附件与文件
    '/api/upload': '附件文件上传',
    '/api/attachments': '获取附件资源列表',
    '/api/attachments/:id': '附件资源读取/下载',
    
    // RAG 知识库
    '/api/rag/knowledge': '知识库文档管理',
    '/api/rag/query': '知识库语义检索测试',
    '/api/rag/status': 'RAG 引擎状态检测',
    
    // 提示词模板
    '/api/prompts': '提示词模板库管理',
    '/api/prompts/:id': '更新/删除提示词模板',
    
    // OpenAI 兼容网关 (v1)
    '/v1/chat/completions': 'OpenAI 接口兼容补全',
    '/v1/models': 'OpenAI 兼容模型列表',
    
    // 系统配置与健康
    '/api/health': '服务健康状态检测',
    '/api/metrics': '监控指标导出 (Prometheus)',
    '/api/settings': '系统与个人基础设置',
    '/api/admin/settings': '修改系统全局策略',
    '/api/settings/password': '用户自主修改密码',
    '/api/settings/default-model': '设置个人默认模型',
    '/api/settings/rag': 'RAG 检索增强参数配置',
    
    // 核心静态资源
    '/': '系统主入口',
    '/chat.html': '对话主界面',
    '/chat/config.js': '前端基础配置脚本',
    '/chat/ui.js': '界面交互逻辑脚本',
    '/chat/auth.js': '前端认证逻辑脚本',
    '/chat/admin.js': '管理后台逻辑脚本',
    '/stats.js': '统计分析核心脚本',
    '/chat/render.js': '消息渲染逻辑脚本',
    '/chat/engine.js': '对话引擎逻辑脚本',
    '/chat/sidebar.js': '侧边栏逻辑脚本',
    '/chat/app.js': '程序主入口脚本',
    '/chat.css': '界面主样式表',
    '/common/styles/theme.css': '全局主题样式',
    '/common/styles/layout.css': '通用布局样式',
    '/chat/chat.css': '对话模块专属样式'
};

window.loadMonitorSummary = async function() {
    if (!isAdminUser()) return;
    try {
        const res = await apiFetch(`${API_BASE}/stats/monitor-summary`);
        if (!res.ok) throw new Error('系统监控加载失败');
        const data = await res.json();
        const memoryUsedRate = data.system.memory.total > 0 ? data.system.memory.used / data.system.memory.total : 0;
        const disk = data.system.disk || {};
        const diskUsedRate = Number(disk.usedRatio ?? (disk.total > 0 ? disk.used / disk.total : 0)) || 0;
        const errorRate = (data.http.errorRate || 0) * 100;
        const concurrency = data.concurrency || {};
        const gpu = data.gpu || {};
        const endpoints = data.modelEndpoints || {};
        const health = data.health || {};
        const maintenance = data.maintenance || {};
        const cards = [
            ['AI 并发', `${formatMetricNumber(concurrency.active)}/${formatMetricNumber(concurrency.max)}`, `排队 ${formatMetricNumber(concurrency.queued)}/${formatMetricNumber(concurrency.maxQueue)}`],
            ['今日 Token', formatTokenCount(data.tokens.today), '累计 ' + formatTokenCount(data.tokens.total)],
            ['今日消息', formatMetricNumber(data.tokens.todayMessages), `15min 活跃用户: ${data.activeUsers}`],
            ['请求总数', formatMetricNumber(data.http.requests), `错误率 ${errorRate.toFixed(2)}%`],
            ['平均延迟', `${formatMetricNumber(data.http.avgLatencyMs, 1)} ms`, `P95 ${formatMetricNumber(data.http.p95LatencyMs, 1)} ms`],
            ['进程内存', formatBytes(data.process.memory.rss), `堆 ${formatBytes(data.process.memory.heapUsed)}`],
            ['系统负载', data.system.loadAverage.map(v => Number(v).toFixed(2)).join(' / '), `${data.system.cpuCount} 核 CPU`],
            ['维护任务', maintenance.running ? '运行中' : '未启动', `审计保留 ${maintenance.retentionDays || '-'} 天`]
        ];
        const cardIcons = {
            'AI 并发': '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
            '今日 Token': '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>',
            '今日消息': '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
            '请求总数': '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>',
            '平均延迟': '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
            '进程内存': '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>',
            '系统负载': '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>',
            '维护任务': '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.1-3.1a6 6 0 0 1-7.9 7.9l-6.8 6.8a2.1 2.1 0 0 1-3-3l6.8-6.8a6 6 0 0 1 7.9-7.9l-3.1 3.1z"/></svg>'
        };

        document.getElementById('monitor-summary-grid').innerHTML = cards.map(([label, value, hint]) => `
            <div class="monitor-card">
                <div class="monitor-card-head">
                    <span>${escapeHtml(label)}</span>
                    <span class="monitor-card-icon">${cardIcons[label] || ''}</span>
                </div>
                <strong title="${escapeHtml(value)}">${escapeHtml(value)}</strong>
                <small title="${escapeHtml(hint)}">${escapeHtml(hint)}</small>
            </div>
        `).join('');

        const memBarWidth = Math.min(100, Math.round(memoryUsedRate * 100));
        const memBarColor = memBarWidth > 90 ? '#ef4444' : (memBarWidth > 75 ? '#f59e0b' : '#10b981');
        const diskBarWidth = Math.min(100, Math.round(diskUsedRate * 100));
        const diskBarColor = diskBarWidth > 90 ? '#ef4444' : (diskBarWidth > 75 ? '#f59e0b' : '#10b981');

        // 恢复详细资源展示 (9行)
        document.getElementById('monitor-resource-list').innerHTML = [
            ['运行主机', `<strong>${escapeHtml(data.system.hostname)}</strong>`],
            ['操作系统', `<strong>${escapeHtml(`${data.system.type} ${data.system.release}`)}</strong>`],
            ['Node 版本', `<strong>${escapeHtml(`${data.process.version} (${data.process.arch})`)}</strong>`],
            ['CPU 型号', `<strong>${escapeHtml(data.system.cpuModel)}</strong>`],
            ['系统时长', `<strong>${formatDuration(data.system.uptime)}</strong>`],
            ['进程时长', `<strong>${formatDuration(data.process.uptimeSeconds)}</strong>`],
            ['系统内存', `<div class="monitor-meter-cell">
                <strong>${formatBytes(data.system.memory.used)} / ${formatBytes(data.system.memory.total)} (${memBarWidth}%)</strong>
                <div class="monitor-meter-track">
                    <div class="monitor-meter-fill" style="width: ${memBarWidth}%; background: ${memBarColor};"></div>
                </div>
            </div>`],
            ['硬盘空间', `<div class="monitor-meter-cell" title="${escapeHtml(disk.path || '')}">
                <strong>${formatBytes(disk.used)} / ${formatBytes(disk.total)} (${diskBarWidth}%)</strong>
                <div class="monitor-meter-track">
                    <div class="monitor-meter-fill" style="width: ${diskBarWidth}%; background: ${diskBarColor};"></div>
                </div>
            </div>`],
            ['硬盘剩余', `<strong title="${escapeHtml(disk.path || '')}">${formatBytes(disk.free)}</strong>`],
            ['进程 CPU', `<strong>${data.process.cpuSeconds.user.toFixed(1)}s U / ${data.process.cpuSeconds.system.toFixed(1)}s S</strong>`],
            ['运行平台', `<strong>${escapeHtml(data.system.platform)}</strong>`]
        ].map(([k, v]) => `<div class="monitor-row"><span>${escapeHtml(k)}</span>${v}</div>`).join('');

        const healthEl = document.getElementById('monitor-health-maintenance-list');
        if (healthEl) {
            const HEALTH_NAME_MAP = {
                'database': '数据库连接',
                'dataDir': '数据目录',
                'uploadsDir': '附件目录',
                'memory': '系统内存',
                'disk': '磁盘空间',
                'api': '接口可用性',
                'cache': '缓存服务'
            };
            const healthRows = (health.checks || []).map(item => {
                const cls = item.status === 'ok' ? '' : ' is-warning';
                const displayName = HEALTH_NAME_MAP[item.name] || item.name;
                return `<div class="monitor-row${cls}">
                    <span title="${escapeHtml(item.message || '')}">${escapeHtml(displayName)}</span>
                    <strong>${escapeHtml(formatHealthStatus(item.status))}</strong>
                </div>`;
            });
            const maintenanceRows = [
                ['审计清理', `${formatMaintenanceTime(maintenance.auditCleanup?.lastSuccessAt)} / ${formatMetricNumber(maintenance.auditCleanup?.lastChanges || 0)} 条`],
                ['API 日志清理', `${formatMaintenanceTime(maintenance.apiCallLogCleanup?.lastSuccessAt)} / ${formatMetricNumber(maintenance.apiCallLogCleanup?.lastChanges || 0)} 条`],
                ['令牌清理', `${formatMaintenanceTime(maintenance.refreshTokenCleanup?.lastSuccessAt)} / ${formatMetricNumber(maintenance.refreshTokenCleanup?.lastChanges || 0)} 条`],
                ['数据库备份', `${formatMaintenanceTime(maintenance.backup?.lastSuccessAt)} / ${formatBytes(maintenance.backup?.lastSizeBytes || 0)}`],
                ['SQLite 优化', formatMaintenanceTime(maintenance.optimize?.lastSuccessAt)]
            ].map(([label, value]) => `<div class="monitor-row">
                <span>${escapeHtml(label)}</span>
                <strong title="${escapeHtml(value)}">${escapeHtml(value)}</strong>
            </div>`);
            healthEl.innerHTML = [...healthRows, ...maintenanceRows].join('');
        }

        const gpuRows = gpu.available && Array.isArray(gpu.gpus) && gpu.gpus.length
            ? gpu.gpus.map((item, idx) => {
                const usedRate = Number(item.ratio || 0) * 100;
                const gpuName = item.name || 'GPU';
                const gpuDetails = [];
                const utilization = Number(item.utilization);
                if (Number.isFinite(utilization)) {
                    const utilizationRate = utilization > 1 ? utilization : utilization * 100;
                    gpuDetails.push(`GPU利用率 ${utilizationRate.toFixed(0)}%`);
                }
                if (Number.isFinite(Number(item.temperature))) gpuDetails.push(`${Number(item.temperature).toFixed(0)}°C`);
                return `<div class="monitor-row monitor-gpu-row">
                    <span class="monitor-gpu-name" title="${escapeHtml(gpuName)}">#${idx} ${escapeHtml(gpuName)}</span>
                    <strong class="monitor-gpu-usage">
                        ${escapeHtml(`${formatBytes(item.usedBytes)} / ${formatBytes(item.totalBytes)} · 显存 ${usedRate.toFixed(0)}%`)}
                        ${gpuDetails.length ? `<small>${escapeHtml(gpuDetails.join(' · '))}</small>` : ''}
                    </strong>
                </div>`;
            }).join('')
            : `<div class="monitor-empty is-warning"><strong>硬件提示：</strong>未检测到 NVIDIA GPU (请检查驱动)。</div>`;

        const gpuScopeNotice = '<div class="monitor-empty is-info"><strong>本机指标：</strong>仅显示 Pivot 部署服务器上的 NVIDIA GPU 与全局并发保护；模型端点本地/远端状态请查看“模型端点状态”。</div>';

        document.getElementById('monitor-gpu-list').innerHTML = [
            gpuScopeNotice,
            `<div class="monitor-row monitor-split-row">
                <div>
                    <span>保护状态</span>
                    <strong>${escapeHtml(gpu.overloaded ? '保护中' : '正常')}</strong>
                </div>
                <div>
                    <span>拒绝阈值</span>
                    <strong>${escapeHtml(`${((gpu.thresholds?.reject || 0) * 100).toFixed(0)}%`)}</strong>
                </div>
            </div>`,
            gpuRows
        ].join('');

        const models = data.tokens.byModel || [];
        document.getElementById('monitor-model-list').innerHTML = models.length
            ? models.map(item => {
                const modelName = item.model_name || '未知模型';
                return `<div class="monitor-row monitor-model-token-row">
                    <span class="monitor-model-token-name" title="${escapeHtml(modelName)}">${escapeHtml(modelName)}</span>
                    <strong class="monitor-model-token-value" title="${Number(item.tokens || 0).toLocaleString()} Tokens">${formatTokenCount(item.tokens)}</strong>
                </div>`;
            }).join('')
            : '<div class="monitor-empty">今日暂无 Token 消耗</div>';

        // 4. 数据与知识库渲染
        const ragStorageEl = document.getElementById('monitor-rag-storage-list');
        if (ragStorageEl) {
            ragStorageEl.innerHTML = [
                ['检索总数', `<strong>${formatMetricNumber(data.rag.retrievals)} 次</strong>`],
                ['命中率', `<strong>${(Number(data.rag.hitRate || 0) * 100).toFixed(1)}%</strong>`],
                ['缓存命中率', `<strong>${(Number(data.rag.cacheHitRate || 0) * 100).toFixed(1)}%</strong>`],
                ['平均耗时', `<strong>${data.rag.avgRetrievalMs.toFixed(1)} ms</strong>`],
                ['索引分片', `<strong>${formatMetricNumber(data.rag.chunksIndexed)}</strong>`],
                ['数据库大小', `<strong>${formatBytes(data.storage.db)}</strong>`],
                ['附件总存储', `<strong>${formatBytes(data.storage.uploads)}</strong>`]
            ].map(([k, v]) => `<div class="monitor-row"><span>${escapeHtml(k)}</span>${v}</div>`).join('');
        }

        const observability = data.observability || {};
        const observabilityEl = document.getElementById('monitor-observability-list');
        const webhookInput = document.getElementById('observability-webhook-url');
        if (webhookInput && observability.settings) {
            webhookInput.value = observability.settings.webhookUrl || '';
        }
        if (observabilityEl) {
            const events = observability.events || [];
            observabilityEl.innerHTML = events.length ? events.map(item => {
                const typeLabel = observabilityTypeLabels[item.type] || item.type || '-';
                const severityLabel = observabilitySeverityLabels[item.severity] || item.severity || '-';
                const title = item.message || item.source || '异常事件';
                const source = item.source || item.details?.modelName || item.details?.route || item.details?.query || '';
                const severityClass = item.severity === 'critical' ? ' is-critical' : item.severity === 'info' ? ' is-info' : ' is-warning';
                return `
                <div class="monitor-observability-row${severityClass}">
                    <div class="monitor-observability-main" title="${escapeHtml([typeLabel, severityLabel, source, item.message].filter(Boolean).join(' · '))}">
                        <div class="monitor-observability-title">
                            <strong>${escapeHtml(title)}</strong>
                            <span class="monitor-observability-badges">
                                <span>${escapeHtml(typeLabel)}</span>
                                <span>${escapeHtml(severityLabel)}</span>
                            </span>
                        </div>
                        ${source ? `<small>${escapeHtml(source)}</small>` : ''}
                    </div>
                    <div class="monitor-observability-duration" title="${formatMetricNumber(item.duration_ms, 1)} ms">
                        <strong>${escapeHtml(formatObservabilityDuration(item.duration_ms))}</strong>
                        <small>耗时</small>
                    </div>
                </div>
            `;
            }).join('') : '<div class="monitor-empty">暂无慢查询或异常告警</div>';
        }

        renderMonitorEndpointLists(endpoints);

        const routes = data.http.routes || [];
        const routesHtml = routes.length
            ? routes.map((route, idx) => {
                const purePath = (route.route || '').split('?')[0].trim().toLowerCase();
                let name = ROUTE_NAME_MAP[purePath] || ROUTE_NAME_MAP[route.route.trim().toLowerCase()];
                if (!name) {
                    if (purePath.startsWith('/common/vendor/')) name = '第三方组件库资源';
                    else if (purePath.startsWith('/uploads/')) name = '用户上传附件流';
                    else name = route.route;
                }
                return `
                <tr>
                    <td class="text-center">${idx + 1}</td>
                    <td title="${escapeHtml(name)}">${escapeHtml(name)}</td>
                    <td class="text-center">${escapeHtml(route.method)}</td>
                    <td title="${escapeHtml(route.route)}">${escapeHtml(route.route)}</td>
                    <td class="text-center">${escapeHtml(route.status)}</td>
                    <td class="text-center">${formatMetricNumber(route.requests)}</td>
                    <td class="text-center">${formatMetricNumber(route.avgLatencyMs, 1)} ms</td>
                </tr>
            `}).join('')
            : '<tr><td colspan="7" class="text-center">暂无请求数据</td></tr>';

        const modalBody = document.getElementById('monitor-routes-modal-body');
        if (modalBody) modalBody.innerHTML = routesHtml;

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

window.saveObservabilityWebhook = async function() {
    const input = document.getElementById('observability-webhook-url');
    const res = await apiFetch(`${API_BASE}/stats/observability/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ webhookUrl: input?.value || '', enabled: true })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return showToast(data.error || '告警设置保存失败', 'error');
    showToast('告警设置已保存', 'success');
    window.loadMonitorSummary();
};

window.exportDetails = () => downloadFileByFetch(`${API_BASE}/stats/details/export`, 'usage_details.csv');
window.exportModelCosts = () => downloadFileByFetch(`${API_BASE}/stats/model-costs/export`, 'model_costs.csv');
window.exportCompliancePackage = () => {
    const start = document.getElementById('log-filter-start')?.value || '';
    const end = document.getElementById('log-filter-end')?.value || '';
    const params = new URLSearchParams({ start, end });
    downloadFileByFetch(`${API_BASE}/admin/compliance/export?${params.toString()}`, 'pivot_compliance_audit.zip');
};

window.openMonitorRoutesModal = () => {
    document.getElementById('monitor-routes-modal')?.classList.remove('hidden');
};

window.closeMonitorRoutesModal = () => {
    document.getElementById('monitor-routes-modal')?.classList.add('hidden');
};

window.exportStats = () => {
    const rows = Array.from(document.querySelectorAll('#stats-list-body tr'));
    let csv = '\uFEFF用户,显示名,模型,消息数,输入Token,输出Token,总Token,最后活动\n';
    rows.forEach(row => { 
        const tds = Array.from(row.querySelectorAll('td')).slice(1); // 跳过序号列
        csv += tds.map(td => escapeCsvValue(td.innerText)).join(',') + '\n'; 
    });
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'usage_stats.csv'; a.click();
};

window.loadLogs = async function(page = 1) {
    try {
        const username = document.getElementById('log-filter-user')?.value || '';
        const action = document.getElementById('log-filter-action')?.value || '';
        const details = document.getElementById('log-filter-details')?.value || '';
        const ip = document.getElementById('log-filter-ip')?.value || '';
        const start = document.getElementById('log-filter-start')?.value || '';
        const end = document.getElementById('log-filter-end')?.value || '';
        
        const params = new URLSearchParams({
            page,
            limit: pageState.limit,
            username,
            action,
            details,
            ip,
            start,
            end
        });

        const res = await apiFetch(`${API_BASE}/admin/logs?${params.toString()}`, { headers: authHeaders() });
        const { data, total } = await res.json();
        document.getElementById('log-list-body').innerHTML = data.map((l, i) => {
            const username = l.username || '系统';
            const displayName = l.nickname || (l.username ? '-' : '系统');
            return `
                <tr>
                    <td class="text-center">${(page - 1) * pageState.limit + i + 1}</td>
                    <td>${escapeHtml(formatDateToCN(l.timestamp))}</td>
                    <td title="${escapeHtml(username)}">${escapeHtml(username)}</td>
                    <td title="${escapeHtml(displayName)}">${escapeHtml(displayName)}</td>
                    <td>${escapeHtml(l.ip_address || '-')}</td>
                    <td title="${escapeHtml(l.action)}"><strong>${escapeHtml(l.action)}</strong></td>
                    <td title="${escapeHtml(l.details || '')}">${escapeHtml(l.details || '')}</td>
                </tr>
            `;
        }).join('');
        renderPagination('logs', total, page);
    } catch (e) { showToast('加载日志失败', 'error'); }
}

window.resetLogFilters = () => {
    ['user', 'action', 'details', 'ip', 'start', 'end'].forEach(f => {
        const el = document.getElementById(`log-filter-${f}`);
        if (el) el.value = '';
    });
    window.loadLogs(1);
};

window.exportLogs = () => {
    const username = document.getElementById('log-filter-user')?.value || '';
    const action = document.getElementById('log-filter-action')?.value || '';
    const details = document.getElementById('log-filter-details')?.value || '';
    const ip = document.getElementById('log-filter-ip')?.value || '';
    const start = document.getElementById('log-filter-start')?.value || '';
    const end = document.getElementById('log-filter-end')?.value || '';
    
    const params = new URLSearchParams({ username, action, details, ip, start, end });
    downloadFileByFetch(`${API_BASE}/admin/logs/export?${params.toString()}`, 'audit_logs.csv');
};

window.loadReport = async function() {
    window.bindReportDateFilters?.();
    window.syncReportDateFilters?.();
    const unit = document.getElementById('report-unit').value || '';
    const username = document.getElementById('report-username').value || '';
    const period = document.getElementById('report-days').value || '30';
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

window.syncReportDateFilters = function() {
    const period = document.getElementById('report-days')?.value || '30';
    document.getElementById('report-custom-range')?.classList.toggle('hidden', period !== 'custom');
}

window.bindReportDateFilters = function() {
    const periodSelect = document.getElementById('report-days');
    if (periodSelect && periodSelect.dataset.boundReportRange !== '1') {
        periodSelect.dataset.boundReportRange = '1';
        periodSelect.addEventListener('change', () => window.syncReportDateFilters());
    }
    const resetBtn = document.getElementById('report-reset-btn');
    if (resetBtn && resetBtn.dataset.boundReportReset !== '1') {
        resetBtn.dataset.boundReportReset = '1';
        resetBtn.addEventListener('click', window.resetReportFilters);
    }
    window.syncReportDateFilters();
}

window.resetReportFilters = function() {
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
    window.syncReportDateFilters?.();
    window.loadReport?.();
}

function renderBarChart(canvasId, data, labelField, fallbackField) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const rect = canvas.getBoundingClientRect();
    const parentWidth = canvas.parentElement?.clientWidth || 0;
    const width = Math.max(rect.width || parentWidth || 400, 320);
    const height = Number(canvas.getAttribute('height')) || 250;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = width * ratio; canvas.height = height * ratio;
    canvas.style.width = `${width}px`; canvas.style.height = `${height}px`;
    ctx.scale(ratio, ratio);
    ctx.clearRect(0, 0, width, height);

    const values = data.map(d => Number(d.tokens) || 0);
    const labels = data.map(d => String(d[labelField] || d[fallbackField] || '未知'));
    const max = Math.max(...values, 1);
    ctx.font = '12px sans-serif';
    const longestLabelWidth = labels.reduce((longest, label) => Math.max(longest, ctx.measureText(label).width), 0);
    const labelColumnWidth = Math.min(
        Math.max(Math.ceil(longestLabelWidth + 20), 140),
        Math.max(180, Math.floor(width * 0.45))
    );
    const padX = labelColumnWidth;
    const padY = 20;
    const chartW = width - padX - 60;
    const chartH = height - padY * 2;

    if (values.length === 0) {
        ctx.fillStyle = '#6b7280'; ctx.font = '13px sans-serif';
        ctx.fillText('暂无数据', padX, height / 2); return;
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
