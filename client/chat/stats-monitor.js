let opsSummaryLoadController = null;
let opsSummaryLoadPromise = null;

const loadOpsSummary = function(options = {}) {
    if (opsSummaryLoadPromise && !options.force && !options.refresh) return opsSummaryLoadPromise;
    opsSummaryLoadController?.abort();
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const signalOptions = controller ? { signal: controller.signal, timeoutMs: 30000 } : {};
    const loadPromise = (async () => {
    try {
        const [summaryRes, trendRes] = await Promise.all([
            apiFetch(`${API_BASE}/stats/ops-summary`, { headers: authHeaders(), ...signalOptions }),
            apiFetch(`${API_BASE}/stats/trend`, { headers: authHeaders(), ...signalOptions })
        ]);
        if (!summaryRes?.ok) {
            throw new Error(`加载数据概览失败（HTTP ${summaryRes?.status || 500}）`);
        }
        const summary = await summaryRes.json().catch(() => ({}));
        const trend = trendRes?.ok ? (await trendRes.json().catch(() => [])) : [];
        const endpointCard = document.getElementById('ops-endpoint-list')?.closest('.stat-card');
        if (endpointCard) endpointCard.classList.toggle('hidden', !!summary.isPersonal);
        if (!summary.isPersonal) renderMonitorEndpointLists(summary.modelEndpoints || {});
        const formatSize = (bytes) => {
            const v = Number(bytes) || 0;
            if (v > 1024**3) return `${(v / 1024**3).toFixed(1)} GB`;
            if (v > 1024**2) return `${(v / 1024**2).toFixed(1)} MB`;
            return `${(v / 1024).toFixed(1)} KB`;
        };
        const cards = summary.isPersonal
            ? [['会话', summary.sessions ?? 0], ['消息', summary.messages ?? 0], ['附件', summary.attachments ?? 0], ['模型', summary.models ?? 0], ['Token', formatTokenCount(summary.tokens ?? 0)]]
            : [['用户', `${summary.activeUsers ?? 0}/${summary.users ?? 0}`], ['会话', summary.sessions ?? 0], ['消息', summary.messages ?? 0], ['附件', summary.attachments ?? 0], ['模型', summary.models ?? 0], ['Token', formatTokenCount(summary.tokens ?? 0)], ['占用', formatSize(summary.uploadsSize)], ['审计', summary.auditToday ?? 0]];
        const gridEl = document.getElementById('ops-summary-grid');
        if (gridEl) {
            gridEl.style.gridTemplateColumns = 'repeat(auto-fit, minmax(132px, 1fr))';
            PivotSafeHtml.setHtml(gridEl, cards.map(([l, v], index) => `<div class="ops-card ${index < 2 ? 'primary' : ''}"><span>${escapeHtml(l)}</span><strong>${escapeHtml(v)}</strong></div>`).join(''));
        }
        renderTrendChart('usage-trend-chart', Array.isArray(trend) ? trend : []);
        window.Pivot.legacy.scheduleSettingsWorkspaceScale?.();
    } catch (e) {
        if (e?.name === 'AbortError') return false;
        showToast(e.message || '加载概览失败', 'error');
        if (options.propagateErrors) throw e;
    }
    })();
    opsSummaryLoadController = controller;
    const settledPromise = loadPromise.finally(() => {
        if (opsSummaryLoadPromise === settledPromise) {
            opsSummaryLoadPromise = null;
            opsSummaryLoadController = null;
        }
    });
    opsSummaryLoadPromise = settledPromise;
    return opsSummaryLoadPromise;
};

let monitorTimer = null;
let monitorSummaryLoadController = null;
let monitorSummaryLoadPromise = null;

function renderRagEmbeddingLatencyTrend(container, embedding = {}) {
    if (!container) return;
    const points = Array.isArray(embedding.trend) ? embedding.trend : [];
    if (!points.length) {
        PivotSafeHtml.setHtml(container, '<div class="monitor-rag-latency-empty">暂无 Embedding 调用样本；首次检索或索引后自动显示趋势。</div>');
        return;
    }
    const width = 280;
    const height = 58;
    const max = Math.max(...points.map(item => Number(item.averageDurationMs || 0)), 1);
    const polyline = points.map((item, index) => {
        const x = points.length === 1 ? width / 2 : (index / (points.length - 1)) * width;
        const y = height - (Math.min(Math.max(Number(item.averageDurationMs || 0), 0), max) / max) * (height - 8) - 4;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    const summary = embedding.summary || {};
    const last = points.at(-1) || {};
    PivotSafeHtml.setHtml(container, `
        <div class="monitor-rag-latency-head"><span>Embedding 延迟趋势（${escapeHtml(String(embedding.minutes || 0))} 分钟）</span><strong>${formatMetricNumber(summary.averageDurationMs, 1)} ms</strong></div>
        <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Embedding 平均延迟趋势" preserveAspectRatio="none"><polyline points="${polyline}" fill="none" stroke="currentColor" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>
        <div class="monitor-rag-latency-meta"><span>最近 ${formatMetricNumber(last.averageDurationMs, 1)} ms</span><span>失败率 ${(Number(summary.errorRate || 0) * 100).toFixed(1)}%</span></div>
    `);
}

function cancelOpsSummaryLoad() {
    opsSummaryLoadController?.abort();
    opsSummaryLoadController = null;
    opsSummaryLoadPromise = null;
}

const loadMonitorSummary = async function(options = {}) {
    if (!isAdminUser()) return;
    if (monitorSummaryLoadPromise && !options.force && !options.refresh) return monitorSummaryLoadPromise;
    monitorSummaryLoadController?.abort();
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const signalOptions = controller ? { signal: controller.signal, timeoutMs: 30000 } : {};
    const loadPromise = (async () => {
    try {
        const forceRefresh = options?.force === true || options?.refresh === true;
        const suffix = forceRefresh ? '?refresh=1' : '';
        const res = await apiFetch(`${API_BASE}/stats/monitor-summary${suffix}`, signalOptions);
        if (!res.ok) throw new Error(`系统监控加载失败（HTTP ${res.status}）`);
        const data = await res.json();
        const system = data.system || {};
        const processInfo = data.process || {};
        const tokens = data.tokens || {};
        const httpInfo = data.http || {};
        const memoryUsed = system.memory?.used || 0;
        const memoryTotal = system.memory?.total || 1;
        const memoryUsedRate = memoryTotal > 0 ? memoryUsed / memoryTotal : 0;
        const disk = system.disk || {};
        const diskUsedRate = Number(disk.usedRatio ?? (disk.total > 0 ? disk.used / disk.total : 0)) || 0;
        const errorRate = (httpInfo.errorRate || 0) * 100;
        const concurrency = data.concurrency || {};
        const gpu = data.gpu || {};
        const endpoints = data.modelEndpoints || {};
        const health = data.health || {};
        const maintenance = data.maintenance || {};
        const concurrencyEffectiveMax = Number(concurrency.effectiveMax ?? concurrency.max ?? 0) || 0;
        const concurrencyConfiguredMax = Number(concurrency.configuredMax ?? gpu.configuredMaxConcurrent ?? concurrencyEffectiveMax) || concurrencyEffectiveMax;
        const concurrencyIsThrottled = Boolean(gpu.throttled) || concurrencyConfiguredMax > concurrencyEffectiveMax;
        const concurrencyHintParts = [`排队 ${formatMetricNumber(concurrency.queued)}/${formatMetricNumber(concurrency.maxQueue)}`];
        if (concurrencyIsThrottled) {
            if (concurrencyConfiguredMax > concurrencyEffectiveMax) concurrencyHintParts.push(`配置 ${formatMetricNumber(concurrencyConfiguredMax)}`);
            concurrencyHintParts.push('GPU 临时保护');
        }
        const gpuProtectionStatus = gpu.overloaded ? '保护中' : (gpu.throttled ? '降档中' : '正常');
        const loadAvgStr = Array.isArray(system.loadAverage) ? system.loadAverage.map(v => Number(v || 0).toFixed(2)).join(' / ') : '0.00 / 0.00 / 0.00';
        const cards = [
            ['AI 并发', `${formatMetricNumber(concurrency.active)}/${formatMetricNumber(concurrencyEffectiveMax)}`, concurrencyHintParts.join(' · ')],
            ['今日 Token', formatTokenCount(tokens.today), '累计 ' + formatTokenCount(tokens.total)],
            ['今日消息', formatMetricNumber(tokens.todayMessages), `15min 活跃用户: ${data.activeUsers || 0}`],
            ['请求总数', formatMetricNumber(httpInfo.requests), `错误率 ${errorRate.toFixed(2)}%`],
            ['平均延迟', `${formatMetricNumber(httpInfo.avgLatencyMs, 1)} ms`, `P95 ${formatMetricNumber(httpInfo.p95LatencyMs, 1)} ms`],
            ['进程内存', formatBytes(processInfo.memory?.rss), `堆 ${formatBytes(processInfo.memory?.heapUsed)}`],
            ['系统负载', loadAvgStr, `${system.cpuCount || 1} 核 CPU`],
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

        PivotSafeHtml.setHtml(document.getElementById('monitor-summary-grid'), cards.map(([label, value, hint]) => `
            <div class="monitor-card">
                <div class="monitor-card-head">
                    <span>${escapeHtml(label)}</span>
                    <span class="monitor-card-icon">${cardIcons[label] || ''}</span>
                </div>
                <strong title="${escapeHtml(value)}">${escapeHtml(value)}</strong>
                <small title="${escapeHtml(hint)}">${escapeHtml(hint)}</small>
            </div>
        `).join(''));

        const memBarWidth = Math.min(100, Math.round(memoryUsedRate * 100));
        const memBarColor = memBarWidth > 90 ? '#ef4444' : (memBarWidth > 75 ? '#f59e0b' : '#10b981');
        const diskBarWidth = Math.min(100, Math.round(diskUsedRate * 100));
        const diskBarColor = diskBarWidth > 90 ? '#ef4444' : (diskBarWidth > 75 ? '#f59e0b' : '#10b981');

        const heapUsed = processInfo.memory?.heapUsed || 0;
        const heapTotal = processInfo.memory?.heapTotal || 1;
        const heapBarWidth = Math.min(100, Math.round((heapUsed / heapTotal) * 100));
        const heapBarColor = heapBarWidth > 90 ? '#ef4444' : (heapBarWidth > 75 ? '#f59e0b' : '#10b981');

        const osType = String(system.type || '').replace(/^Windows_NT$/i, 'Windows');
        const osDisplay = `${osType} ${system.release || ''}`.trim() || '-';

        // 系统资源指标 (紧凑双栏合并展示，单列项带独立卡片框)
        PivotSafeHtml.setHtml(document.getElementById('monitor-resource-list'), [
            `<div class="monitor-row monitor-split-row">
                <div><span>运行主机</span><strong title="${escapeHtml(system.hostname || '-')}">${escapeHtml(system.hostname || '-')}</strong></div>
                <div><span>运行架构</span><strong title="${escapeHtml(system.platform || '-')}${system.arch ? ` (${escapeHtml(system.arch)})` : ''}">${escapeHtml(system.platform || '-')}${system.arch ? ` (${escapeHtml(system.arch)})` : ''}</strong></div>
            </div>`,
            `<div class="monitor-row monitor-split-row">
                <div><span>操作系统</span><strong title="${escapeHtml(`${system.type || ''} ${system.release || ''}`.trim() || '-')}">${escapeHtml(osDisplay)}</strong></div>
                <div><span>Node环境</span><strong title="${escapeHtml(`${processInfo.version || ''} (${processInfo.arch || ''})`.trim() || '-')}">${escapeHtml(`${processInfo.version || ''} (${processInfo.arch || ''})`.trim() || '-')}</strong></div>
            </div>`,
            `<div class="monitor-row monitor-split-row">
                <div><span>CPU 规格</span><strong>${formatMetricNumber(system.cpuCount || 1)} 逻辑核心</strong></div>
                <div><span>系统负载</span><strong title="${escapeHtml(loadAvgStr)}">${escapeHtml(loadAvgStr)}</strong></div>
            </div>`,
            `<div class="monitor-row monitor-split-row monitor-single-row">
                <div>
                    <span>CPU 型号</span>
                    <strong title="${escapeHtml(system.cpuModel || '-')}">${escapeHtml(system.cpuModel || '-')}</strong>
                </div>
            </div>`,
            `<div class="monitor-row monitor-split-row">
                <div><span>系统时长</span><strong>${formatDuration(system.uptime || 0)}</strong></div>
                <div><span>进程时长</span><strong>${formatDuration(processInfo.uptimeSeconds || 0)}</strong></div>
            </div>`,
            `<div class="monitor-row monitor-split-row">
                <div>
                    <span>物理内存</span>
                    <div class="monitor-meter-cell" title="${formatBytes(memoryUsed)} / ${formatBytes(memoryTotal)} (${memBarWidth}%)">
                        <strong>${formatBytes(memoryUsed)} / ${formatBytes(memoryTotal)} (${memBarWidth}%)</strong>
                        <div class="monitor-meter-track">
                            <div class="monitor-meter-fill" style="width: ${memBarWidth}%; background: ${memBarColor};"></div>
                        </div>
                    </div>
                </div>
                <div>
                    <span title="Node.js V8 引擎对象堆内存：已用堆 / 分配堆总额 (反映应用对象及闭包占用，用于排查内存泄漏)">Node 堆</span>
                    <div class="monitor-meter-cell" title="V8 对象堆：${formatBytes(heapUsed)} / ${formatBytes(heapTotal)} (${heapBarWidth}%)">
                        <strong>${formatBytes(heapUsed)} / ${formatBytes(heapTotal)} (${heapBarWidth}%)</strong>
                        <div class="monitor-meter-track">
                            <div class="monitor-meter-fill" style="width: ${heapBarWidth}%; background: ${heapBarColor};"></div>
                        </div>
                    </div>
                </div>
            </div>`,
            `<div class="monitor-row monitor-split-row">
                <div>
                    <span>硬盘空间</span>
                    <div class="monitor-meter-cell" title="${escapeHtml(disk.path || '')} ${formatBytes(disk.used || 0)} / ${formatBytes(disk.total || 0)} (${diskBarWidth}%)">
                        <strong>${formatBytes(disk.used || 0)} / ${formatBytes(disk.total || 0)} (${diskBarWidth}%)</strong>
                        <div class="monitor-meter-track">
                            <div class="monitor-meter-fill" style="width: ${diskBarWidth}%; background: ${diskBarColor};"></div>
                        </div>
                    </div>
                </div>
                <div>
                    <span>剩余容量</span>
                    <strong title="${escapeHtml(disk.path || '')}">${formatBytes(disk.free || 0)}</strong>
                </div>
            </div>`,
            `<div class="monitor-row monitor-split-row monitor-single-row">
                <div>
                    <span>进程 CPU 耗时</span>
                    <strong title="用户态 ${Number(processInfo.cpuSeconds?.user || 0).toFixed(2)}s · 系统态 ${Number(processInfo.cpuSeconds?.system || 0).toFixed(2)}s">${Number(processInfo.cpuSeconds?.user || 0).toFixed(1)}s 用户 / ${Number(processInfo.cpuSeconds?.system || 0).toFixed(1)}s 系统</strong>
                </div>
            </div>`
        ].join(''));

        const healthEl = document.getElementById('monitor-health-maintenance-list');
        if (healthEl) {
            const HEALTH_NAME_MAP = {
                'database': '数据库连接',
                'dataDir': '数据目录',
                'uploadsDir': '附件目录',
                'memory': '系统内存',
                'disk': '磁盘空间',
                'writeQueue': '数据库写入队列',
                'deployment': '部署就绪状态',
                'api': '接口可用性',
                'cache': '缓存服务'
            };
            const allHealthChecks = Array.isArray(health.checks) ? health.checks : [];
            // 普通健康卡片不滚动，最多呈现八个最重要的检查项；其余仍会由接口详情和
            // 服务端日志完整保留，避免偶发检查项激增把整个监控画布挤出视口。
            const healthChecks = allHealthChecks.slice(0, 8);
            const pairedHealthRows = [];
            for (let i = 0; i < healthChecks.length; i += 2) {
                const item1 = healthChecks[i];
                const item2 = healthChecks[i + 1];
                const cls1 = item1.status === 'ok' ? '' : ' is-warning';
                const name1 = HEALTH_NAME_MAP[item1.name] || item1.name;
                const cell1 = `<div class="${cls1}">
                    <span title="${escapeHtml(item1.message || '')}">${escapeHtml(name1)}</span>
                    <strong>${escapeHtml(formatHealthStatus(item1.status))}</strong>
                </div>`;
                let cell2 = '';
                if (item2) {
                    const cls2 = item2.status === 'ok' ? '' : ' is-warning';
                    const name2 = HEALTH_NAME_MAP[item2.name] || item2.name;
                    cell2 = `<div class="${cls2}">
                        <span title="${escapeHtml(item2.message || '')}">${escapeHtml(name2)}</span>
                        <strong>${escapeHtml(formatHealthStatus(item2.status))}</strong>
                    </div>`;
                }
                pairedHealthRows.push(`<div class="monitor-row monitor-split-row">${cell1}${cell2}</div>`);
            }

            const formatMaintenanceItem = (timeVal, extra) => {
                if (!timeVal) return { label: '尚未成功', title: '尚未成功执行' };
                const fullStr = formatDateToCN(timeVal);
                // 维护任务不是实时指标；即使执行发生在今天，也要保留日期，避免用户把
                // 昨天或更早的一次成功记录误当成刚刚完成。界面使用紧凑的月日 + 分钟，
                // 完整秒级时间仍通过 title 提供。
                const match = fullStr.match(/^(\d{4}-)(\d{2}-\d{2})\s+(\d{2}:\d{2})/);
                const displayTime = match ? `${match[2]} ${match[3]}` : fullStr;
                const label = extra ? `${displayTime} · ${extra}` : displayTime;
                const title = extra ? `${fullStr} (${extra})` : fullStr;
                return { label, title };
            };

            const mAudit = formatMaintenanceItem(maintenance.auditCleanup?.lastSuccessAt, `${formatMetricNumber(maintenance.auditCleanup?.lastChanges || 0)} 条`);
            const mApiLog = formatMaintenanceItem(maintenance.apiCallLogCleanup?.lastSuccessAt, `${formatMetricNumber(maintenance.apiCallLogCleanup?.lastChanges || 0)} 条`);
            const mToken = formatMaintenanceItem(maintenance.refreshTokenCleanup?.lastSuccessAt, `${formatMetricNumber(maintenance.refreshTokenCleanup?.lastChanges || 0)} 条`);
            const mBackup = formatMaintenanceItem(maintenance.backup?.lastSuccessAt, formatBytes(maintenance.backup?.lastSizeBytes || 0));
            const mOptimize = formatMaintenanceItem(maintenance.optimize?.lastSuccessAt, '');

            const maintenanceTasks = [
                ['审计清理', mAudit.label, mAudit.title],
                ['API 日志清理', mApiLog.label, mApiLog.title],
                ['令牌清理', mToken.label, mToken.title],
                ['数据库备份', mBackup.label, mBackup.title],
                ['PostgreSQL 统计', mOptimize.label, mOptimize.title]
            ];
            const pairedMaintenanceRows = [];
            for (let i = 0; i < maintenanceTasks.length; i += 2) {
                const t1 = maintenanceTasks[i];
                const t2 = maintenanceTasks[i + 1];
                const cell1 = `<div>
                    <span>${escapeHtml(t1[0])}</span>
                    <strong title="${escapeHtml(t1[2])}">${escapeHtml(t1[1])}</strong>
                </div>`;
                let cell2 = '';
                if (t2) {
                    cell2 = `<div>
                        <span>${escapeHtml(t2[0])}</span>
                        <strong title="${escapeHtml(t2[2])}">${escapeHtml(t2[1])}</strong>
                    </div>`;
                }
                pairedMaintenanceRows.push(`<div class="monitor-row monitor-split-row">${cell1}${cell2}</div>`);
            }
            const hiddenHealthHint = allHealthChecks.length > healthChecks.length
                ? `<div class="monitor-empty compact">另有 ${formatMetricNumber(allHealthChecks.length - healthChecks.length)} 项健康检查，请在接口详情中查看。</div>`
                : '';
            PivotSafeHtml.setHtml(healthEl, [...pairedHealthRows, ...pairedMaintenanceRows, hiddenHealthHint].join(''));
        }

        const concurrencyActive = Number(concurrency.active || 0);
        const concurrencyQueued = Number(concurrency.queued || 0);
        const concurrencyMaxQueue = Number(concurrency.maxQueue || 20);
        const queueTimeoutSec = Math.round(Number(concurrency.queueTimeoutMs || 300000) / 1000);
        const gpuActiveStatus = gpu.status === 'error' ? '过载熔断' : (concurrencyActive >= concurrencyEffectiveMax && concurrencyEffectiveMax > 0 ? '峰值排队' : gpuProtectionStatus);

        const aiMeterWidth = concurrencyEffectiveMax > 0 ? Math.min(100, Math.round((concurrencyActive / concurrencyEffectiveMax) * 100)) : 0;
        const aiMeterColor = aiMeterWidth > 85 ? '#ef4444' : (aiMeterWidth > 65 ? '#f59e0b' : '#10b981');

        const queueMeterWidth = concurrencyMaxQueue > 0 ? Math.min(100, Math.round((concurrencyQueued / concurrencyMaxQueue) * 100)) : 0;
        const queueMeterColor = queueMeterWidth > 80 ? '#ef4444' : (queueMeterWidth > 50 ? '#f59e0b' : '#10b981');

        const gpuRejectThreshold = ((gpu.thresholds?.reject || 0.98) * 100).toFixed(0);
        const gpuSafeThreshold = ((gpu.thresholds?.safe || 0.85) * 100).toFixed(0);
        const gpuCriticalThreshold = ((gpu.thresholds?.critical || 0.95) * 100).toFixed(0);
        const gpuIntervalSec = Math.round(Number(gpu.intervalMs || 15000) / 1000);

        const totalEndpoints = Number(endpoints.total || 0);
        const localEndpoints = Number(endpoints.localCount || 0);
        const remoteEndpoints = Number(endpoints.remoteCount || 0);

        const allGpus = gpu.available && Array.isArray(gpu.gpus) ? gpu.gpus : [];
        const visibleGpus = allGpus.slice(0, 2);
        const gpuRows = visibleGpus.length
            ? `<div class="monitor-gpu-cards-wrap">${visibleGpus.map((item, idx) => {
                const usedRate = Number(item.ratio || 0) * 100;
                const gpuName = item.name || 'GPU';
                const gpuDetails = [];
                const utilization = Number(item.utilization);
                if (Number.isFinite(utilization)) {
                    const utilizationRate = utilization > 1 ? utilization : utilization * 100;
                    gpuDetails.push(`利用率 ${utilizationRate.toFixed(0)}%`);
                }
                if (Number.isFinite(Number(item.temperature))) gpuDetails.push(`${Number(item.temperature).toFixed(0)}°C`);
                const gpuBarColor = usedRate > 90 ? '#ef4444' : (usedRate > 75 ? '#f59e0b' : '#10b981');
                return `<div class="monitor-row monitor-gpu-row">
                    <span class="monitor-gpu-name" title="#${idx} ${escapeHtml(gpuName)}">#${idx} ${escapeHtml(gpuName)}</span>
                    <div class="monitor-meter-cell">
                        <strong>${formatBytes(item.usedBytes)} / ${formatBytes(item.totalBytes)} (${usedRate.toFixed(0)}%)</strong>
                        <div class="monitor-meter-track">
                            <div class="monitor-meter-fill" style="width: ${Math.min(100, Math.round(usedRate))}%; background: ${gpuBarColor};"></div>
                        </div>
                        ${gpuDetails.length ? `<small title="${escapeHtml(gpuDetails.join(' · '))}"><strong>${escapeHtml(gpuDetails.join(' · '))}</strong></small>` : ''}
                    </div>
                </div>`;
            }).join('')}${allGpus.length > visibleGpus.length
                ? `<div class="monitor-empty compact">另有 ${formatMetricNumber(allGpus.length - visibleGpus.length)} 张 GPU，详情请查看接口监控。</div>`
                : ''}</div>`
            : `<div class="monitor-hardware-banner">
                <div class="monitor-hardware-banner-head">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
                    <strong>当前算力形态：CPU / 混合集群调度</strong>
                </div>
                <p>未检测到本地显卡资源。系统已启用自适应动态削峰保护，多模型请求由分布式端点承载。</p>
            </div>`;

        PivotSafeHtml.setHtml(document.getElementById('monitor-gpu-list'), [
            `<div class="monitor-row monitor-split-row is-three">
                <div>
                    <span>保护状态</span>
                    <strong title="当前并发负载状态">${escapeHtml(gpuActiveStatus)}</strong>
                </div>
                <div>
                    <span>动态上限</span>
                    <strong title="生效上限 / 配置上限">${escapeHtml(`${formatMetricNumber(concurrencyEffectiveMax)}/${formatMetricNumber(concurrencyConfiguredMax)}`)}</strong>
                </div>
                <div>
                    <span>熔断阈值</span>
                    <strong title="负载熔断百分比">${escapeHtml(`${gpuRejectThreshold}%`)}</strong>
                </div>
            </div>`,
            `<div class="monitor-row monitor-split-row">
                <div>
                    <span>AI 并发</span>
                    <div class="monitor-meter-cell" title="${formatMetricNumber(concurrencyActive)} / ${formatMetricNumber(concurrencyEffectiveMax)} (${aiMeterWidth}%)">
                        <strong>${formatMetricNumber(concurrencyActive)} / ${formatMetricNumber(concurrencyEffectiveMax)} (${aiMeterWidth}%)</strong>
                        <div class="monitor-meter-track">
                            <div class="monitor-meter-fill" style="width: ${aiMeterWidth}%; background: ${aiMeterColor};"></div>
                        </div>
                    </div>
                </div>
                <div>
                    <span>排队缓冲</span>
                    <div class="monitor-meter-cell" title="超过 ${queueTimeoutSec} 秒自动解挂 · ${formatMetricNumber(concurrencyQueued)} / ${formatMetricNumber(concurrencyMaxQueue)} (${queueMeterWidth}%)">
                        <strong>${formatMetricNumber(concurrencyQueued)} / ${formatMetricNumber(concurrencyMaxQueue)} (${queueMeterWidth}%)</strong>
                        <div class="monitor-meter-track">
                            <div class="monitor-meter-fill" style="width: ${queueMeterWidth}%; background: ${queueMeterColor};"></div>
                        </div>
                    </div>
                </div>
            </div>`,
            `<div class="monitor-row monitor-split-row">
                <div>
                    <span>显存水位</span>
                    <strong title="安全水位 ${escapeHtml(gpuSafeThreshold)}% · 警戒阈值 ${escapeHtml(gpuCriticalThreshold)}%">${escapeHtml(gpuSafeThreshold)}% / ${escapeHtml(gpuCriticalThreshold)}%</strong>
                </div>
                <div>
                    <span>探针周期</span>
                    <strong title="${escapeHtml(String(gpuIntervalSec))} 秒 / 轮询">${escapeHtml(String(gpuIntervalSec))}s / 轮询</strong>
                </div>
            </div>`,
            `<div class="monitor-row monitor-split-row">
                <div>
                    <span>活跃端点</span>
                    <strong title="总计 ${formatMetricNumber(totalEndpoints)} 个端点（本地 ${formatMetricNumber(localEndpoints)} · 远端 ${formatMetricNumber(remoteEndpoints)}）">${formatMetricNumber(totalEndpoints)} 个 (${formatMetricNumber(localEndpoints)}本 / ${formatMetricNumber(remoteEndpoints)}远)</strong>
                </div>
                <div>
                    <span>超时保护</span>
                    <strong title="排队超时自动释放：${formatMetricNumber(queueTimeoutSec)} 秒">${formatMetricNumber(queueTimeoutSec)}s 释放</strong>
                </div>
            </div>`,
            gpuRows
        ].join(''));

        const models = Array.isArray(tokens.byModel) ? tokens.byModel : [];
        const visibleModels = models.slice(0, 6);
        PivotSafeHtml.setHtml(document.getElementById('monitor-model-list'), visibleModels.length
            ? [visibleModels.map(item => {
                const modelName = item.model_name || '未知模型';
                return `<div class="monitor-row monitor-model-token-row">
                    <span class="monitor-model-token-name" title="${escapeHtml(modelName)}">${escapeHtml(modelName)}</span>
                    <strong class="monitor-model-token-value" title="${Number(item.tokens || 0).toLocaleString()} Tokens">${formatTokenCount(item.tokens)}</strong>
                </div>`;
            }).join(''), models.length > visibleModels.length
                ? `<div class="monitor-empty compact">另有 ${formatMetricNumber(models.length - visibleModels.length)} 个模型，已按 Token 消耗排序。</div>`
                : ''].join('')
            : '<div class="monitor-empty">今日暂无各模型 Token 消耗记录</div>');

        // 4. 数据与知识库渲染
        const ragStorageEl = document.getElementById('monitor-rag-storage-list');
        if (ragStorageEl) {
            const ragData = data.rag || {};
            const ragOperations = data.ragOperations || {};
            const embedding = ragOperations.embedding || {};
            const embeddingSummary = embedding.summary || {};
            const diagnostics = ragOperations.diagnostics || {};
            const storageData = data.storage || {};
            const avgRetrieval = Number(ragData.avgRetrievalMs || 0).toFixed(1);
            PivotSafeHtml.setHtml(ragStorageEl, [
                `<div class="monitor-row monitor-split-row">
                    <div><span>检索总数</span><strong>${formatMetricNumber(ragData.retrievals)} 次</strong></div>
                    <div><span>平均耗时</span><strong>${avgRetrieval} ms</strong></div>
                </div>`,
                `<div class="monitor-row monitor-split-row">
                    <div><span>命中率</span><strong>${(Number(ragData.hitRate || 0) * 100).toFixed(1)}%</strong></div>
                    <div><span>缓存命中</span><strong>${(Number(ragData.cacheHitRate || 0) * 100).toFixed(1)}%</strong></div>
                </div>`,
                `<div class="monitor-row monitor-split-row">
                    <div><span>Embedding</span><strong>${formatMetricNumber(embeddingSummary.averageDurationMs, 1)} ms</strong></div>
                    <div><span>失败率</span><strong>${(Number(embeddingSummary.errorRate || 0) * 100).toFixed(1)}%</strong></div>
                </div>`,
                `<div class="monitor-row monitor-split-row">
                    <div><span>索引分片</span><strong>${formatMetricNumber(ragData.chunksIndexed)}</strong></div>
                    <div><span>检索诊断</span><strong title="24h: ${formatMetricNumber(diagnostics.queryCount)} 次 / ${formatMetricNumber(diagnostics.averageElapsedMs, 1)} ms">${formatMetricNumber(diagnostics.queryCount)} 次 / ${formatMetricNumber(diagnostics.averageElapsedMs, 1)} ms</strong></div>
                </div>`,
                `<div class="monitor-row monitor-split-row">
                    <div><span>数据库</span><strong>${formatBytes(storageData.db)}</strong></div>
                    <div><span>附件存储</span><strong>${formatBytes(storageData.uploads)}</strong></div>
                </div>`
            ].join(''));
            renderRagEmbeddingLatencyTrend(document.getElementById('monitor-rag-latency-trend'), embedding);
        }

        const observability = data.observability || {};
        const observabilityEl = document.getElementById('monitor-observability-list');
        const webhookInput = document.getElementById('observability-webhook-url');
        const webhookBadge = document.getElementById('observability-webhook-status-badge');
        const hasWebhook = Boolean(observability.settings?.webhookUrl && observability.settings.webhookUrl.trim());
        if (webhookInput && observability.settings) {
            webhookInput.value = observability.settings.webhookUrl || '';
        }
        if (webhookBadge) {
            webhookBadge.textContent = hasWebhook ? '已启用推送' : '未配置推送';
            webhookBadge.title = hasWebhook ? `已配置推送: ${observability.settings.webhookUrl}` : '未配置 Webhook 告警';
            webhookBadge.className = `observability-status-badge ${hasWebhook ? 'is-active' : 'is-empty'}`;
        }
        if (observabilityEl) {
            const events = observability.events || [];
            PivotSafeHtml.setHtml(observabilityEl, events.length ? events.map(item => {
                const typeLabel = observabilityTypeLabels[item.type] || item.type || '-';
                const severityLabel = observabilitySeverityLabels[item.severity] || item.severity || '-';
                const title = item.message || item.source || '异常事件';
                const source = item.source || item.details?.modelName || item.details?.route || item.details?.query || '';
                const timeFormatted = item.created_at ? formatDateToCN(item.created_at) : '-';
                const severityClass = item.severity === 'critical' ? ' is-critical' : item.severity === 'info' ? ' is-info' : ' is-warning';
                return `
                <div class="monitor-observability-row${severityClass}">
                    <div class="monitor-observability-item-left" title="${escapeHtml([title, source, typeLabel, severityLabel, timeFormatted].filter(Boolean).join(' · '))}">
                        <strong class="monitor-observability-item-title">${escapeHtml(title)}</strong>
                        <span class="monitor-observability-badges">
                            <span class="badge-type">${escapeHtml(typeLabel)}</span>
                            <span class="badge-severity">${escapeHtml(severityLabel)}</span>
                        </span>
                        ${source && source !== title ? `<span class="monitor-observability-item-source" title="${escapeHtml(source)}">${escapeHtml(source)}</span>` : ''}
                    </div>
                    <div class="monitor-observability-item-right">
                        <span class="monitor-observability-item-duration" title="耗时: ${formatMetricNumber(item.duration_ms, 1)} ms">
                            <strong>${escapeHtml(formatObservabilityDuration(item.duration_ms))}</strong>
                            <small>耗时</small>
                        </span>
                        <span class="monitor-observability-item-time" title="发生时间: ${escapeHtml(timeFormatted)}">
                            ${escapeHtml(timeFormatted)}
                        </span>
                    </div>
                </div>
            `;
            }).join('') : '<div class="monitor-empty">暂无慢查询或异常告警</div>');
        }

        renderMonitorEndpointLists(endpoints);

        const routes = data.http.routes || [];
        const routesHtml = routes.length
            ? routes.map((route, idx) => {
                const name = describeMonitorRoute(route.route);
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
        if (modalBody) PivotSafeHtml.setHtml(modalBody, routesHtml);

        document.getElementById('monitor-updated-at').innerText = `最近刷新：${formatDateToCN(data.updatedAt)}`;
        scheduleMonitorRefresh();
        window.Pivot.legacy.scheduleSettingsWorkspaceScale?.();
    } catch (e) {
        if (e?.name === 'AbortError') return false;
        showToast(e.message || '系统监控加载失败', 'error');
        if (options.propagateErrors) throw e;
    }
    })();
    monitorSummaryLoadController = controller;
    const settledPromise = loadPromise.finally(() => {
        if (monitorSummaryLoadPromise === settledPromise) {
            monitorSummaryLoadPromise = null;
            monitorSummaryLoadController = null;
        }
    });
    monitorSummaryLoadPromise = settledPromise;
    return monitorSummaryLoadPromise;
};
function clearMonitorRefreshTimer() {
    if (monitorTimer) {
        clearTimeout(monitorTimer);
        monitorTimer = null;
    }
}

function cancelMonitorSummaryLoad() {
    const controller = monitorSummaryLoadController;
    controller?.abort();
    monitorSummaryLoadController = null;
    monitorSummaryLoadPromise = null;
}

const refreshMonitorSummary = function(options = {}) {
    return loadMonitorSummary({ ...options, force: true });
};

function scheduleMonitorRefresh() {
    clearMonitorRefreshTimer();
    const isSettingsActive = document.body?.dataset?.activeWorkspace === 'settings';
    const monitorTab = document.getElementById('tab-content-monitor');
    const visible = isSettingsActive && monitorTab && !monitorTab.classList.contains('hidden');
    const enabled = document.getElementById('monitor-auto-refresh')?.checked;
    if (visible && enabled) {
        monitorTimer = setTimeout(() => {
            const stillActive = document.body?.dataset?.activeWorkspace === 'settings';
            const stillVisible = stillActive && !document.getElementById('tab-content-monitor')?.classList.contains('hidden');
            if (stillVisible) {
                loadMonitorSummary();
            }
        }, 10000);
    }
}

const saveObservabilityWebhook = async function() {
    const input = document.getElementById('observability-webhook-url');
    const res = await apiFetch(`${API_BASE}/stats/observability/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ webhookUrl: input?.value || '', enabled: true })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return showToast(data.error || '告警设置保存失败', 'error');
    showToast('告警设置已保存', 'success');
    const drawer = document.getElementById('observability-webhook-panel');
    if (drawer && input?.value?.trim()) {
        drawer.classList.add('hidden');
    }
    loadMonitorSummary();
};

const toggleObservabilityWebhookDrawer = function() {
    const drawer = document.getElementById('observability-webhook-panel');
    if (!drawer) return;
    const isHidden = drawer.classList.contains('hidden');
    if (isHidden) {
        drawer.classList.remove('hidden');
        document.getElementById('observability-webhook-url')?.focus();
    } else {
        drawer.classList.add('hidden');
    }
};

window.Pivot?.exposeModule?.('settings.monitor', {
    loadOpsSummary,
    loadMonitorSummary,
    refreshMonitorSummary,
    saveObservabilityWebhook,
    toggleObservabilityWebhookDrawer,
    clearMonitorRefreshTimer,
    cancelMonitorSummaryLoad,
    cancelOpsSummaryLoad
}, [
    'loadOpsSummary',
    'loadMonitorSummary',
    'refreshMonitorSummary',
    'saveObservabilityWebhook',
    'toggleObservabilityWebhookDrawer',
    'clearMonitorRefreshTimer',
    'cancelMonitorSummaryLoad',
    'cancelOpsSummaryLoad'
]);
