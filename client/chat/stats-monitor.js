let opsSummaryLoadController = null;
let opsSummaryLoadPromise = null;

window.loadOpsSummary = function(options = {}) {
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
        window.scheduleSettingsWorkspaceScale?.();
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

function cancelOpsSummaryLoad() {
    opsSummaryLoadController?.abort();
    opsSummaryLoadController = null;
    opsSummaryLoadPromise = null;
}

window.loadMonitorSummary = async function(options = {}) {
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

        // 恢复详细资源展示 (9行)
        PivotSafeHtml.setHtml(document.getElementById('monitor-resource-list'), [
            ['运行主机', `<strong>${escapeHtml(system.hostname || '-')}</strong>`],
            ['操作系统', `<strong>${escapeHtml(`${system.type || ''} ${system.release || ''}`.trim() || '-')}</strong>`],
            ['Node 版本', `<strong>${escapeHtml(`${processInfo.version || ''} (${processInfo.arch || ''})`.trim() || '-')}</strong>`],
            ['CPU 型号', `<strong>${escapeHtml(system.cpuModel || '-')}</strong>`],
            ['系统时长', `<strong>${formatDuration(system.uptime || 0)}</strong>`],
            ['进程时长', `<strong>${formatDuration(processInfo.uptimeSeconds || 0)}</strong>`],
            ['系统内存', `<div class="monitor-meter-cell">
                <strong>${formatBytes(memoryUsed)} / ${formatBytes(memoryTotal)} (${memBarWidth}%)</strong>
                <div class="monitor-meter-track">
                    <div class="monitor-meter-fill" style="width: ${memBarWidth}%; background: ${memBarColor};"></div>
                </div>
            </div>`],
            ['硬盘空间', `<div class="monitor-meter-cell" title="${escapeHtml(disk.path || '')}">
                <strong>${formatBytes(disk.used || 0)} / ${formatBytes(disk.total || 0)} (${diskBarWidth}%)</strong>
                <div class="monitor-meter-track">
                    <div class="monitor-meter-fill" style="width: ${diskBarWidth}%; background: ${diskBarColor};"></div>
                </div>
            </div>`],
            ['硬盘剩余', `<strong title="${escapeHtml(disk.path || '')}">${formatBytes(disk.free || 0)}</strong>`],
            ['进程 CPU', `<strong>${Number(processInfo.cpuSeconds?.user || 0).toFixed(1)}s U / ${Number(processInfo.cpuSeconds?.system || 0).toFixed(1)}s S</strong>`],
            ['运行平台', `<strong>${escapeHtml(system.platform || '-')}</strong>`]
        ].map(([k, v]) => `<div class="monitor-row"><span>${escapeHtml(k)}</span>${v}</div>`).join(''));

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
                ['PostgreSQL 统计', formatMaintenanceTime(maintenance.optimize?.lastSuccessAt)]
            ].map(([label, value]) => `<div class="monitor-row">
                <span>${escapeHtml(label)}</span>
                <strong title="${escapeHtml(value)}">${escapeHtml(value)}</strong>
            </div>`);
            PivotSafeHtml.setHtml(healthEl, [...healthRows, ...maintenanceRows].join(''));
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
            : '<div class="monitor-empty is-warning"><strong>硬件提示：</strong>未检测到 NVIDIA GPU (请检查驱动)。</div>';

        const gpuScopeNotice = '<div class="monitor-empty is-info"><strong>本机指标：</strong>仅显示 Pivot 部署服务器上的 NVIDIA GPU 与全局并发保护；模型端点本地/远端状态请查看“模型端点状态”。</div>';

        PivotSafeHtml.setHtml(document.getElementById('monitor-gpu-list'), [
            gpuScopeNotice,
            `<div class="monitor-row monitor-split-row is-three">
                <div>
                    <span>保护状态</span>
                    <strong>${escapeHtml(gpuProtectionStatus)}</strong>
                </div>
                <div>
                    <span>AI上限</span>
                    <strong title="当前 / 配置">${escapeHtml(`${formatMetricNumber(concurrencyEffectiveMax)}/${formatMetricNumber(concurrencyConfiguredMax)}`)}</strong>
                </div>
                <div>
                    <span>拒绝阈值</span>
                    <strong>${escapeHtml(`${((gpu.thresholds?.reject || 0) * 100).toFixed(0)}%`)}</strong>
                </div>
            </div>`,
            gpuRows
        ].join(''));

        const models = tokens.byModel || [];
        PivotSafeHtml.setHtml(document.getElementById('monitor-model-list'), models.length
            ? models.map(item => {
                const modelName = item.model_name || '未知模型';
                return `<div class="monitor-row monitor-model-token-row">
                    <span class="monitor-model-token-name" title="${escapeHtml(modelName)}">${escapeHtml(modelName)}</span>
                    <strong class="monitor-model-token-value" title="${Number(item.tokens || 0).toLocaleString()} Tokens">${formatTokenCount(item.tokens)}</strong>
                </div>`;
            }).join('')
            : '<div class="monitor-empty">今日暂无 Token 消耗</div>');

        // 4. 数据与知识库渲染
        const ragStorageEl = document.getElementById('monitor-rag-storage-list');
        if (ragStorageEl) {
            const ragData = data.rag || {};
            const storageData = data.storage || {};
            const avgRetrieval = Number(ragData.avgRetrievalMs || 0).toFixed(1);
            PivotSafeHtml.setHtml(ragStorageEl, [
                ['检索总数', `<strong>${formatMetricNumber(ragData.retrievals)} 次</strong>`],
                ['命中率', `<strong>${(Number(ragData.hitRate || 0) * 100).toFixed(1)}%</strong>`],
                ['缓存命中率', `<strong>${(Number(ragData.cacheHitRate || 0) * 100).toFixed(1)}%</strong>`],
                ['平均耗时', `<strong>${avgRetrieval} ms</strong>`],
                ['索引分片', `<strong>${formatMetricNumber(ragData.chunksIndexed)}</strong>`],
                ['数据库大小', `<strong>${formatBytes(storageData.db)}</strong>`],
                ['附件总存储', `<strong>${formatBytes(storageData.uploads)}</strong>`]
            ].map(([k, v]) => `<div class="monitor-row"><span>${escapeHtml(k)}</span>${v}</div>`).join(''));
        }

        const observability = data.observability || {};
        const observabilityEl = document.getElementById('monitor-observability-list');
        const webhookInput = document.getElementById('observability-webhook-url');
        if (webhookInput && observability.settings) {
            webhookInput.value = observability.settings.webhookUrl || '';
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
        window.scheduleSettingsWorkspaceScale?.();
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

window.Pivot?.exposeModule?.('settings.monitor', {
    clearMonitorRefreshTimer,
    cancelMonitorSummaryLoad,
    cancelOpsSummaryLoad
}, ['clearMonitorRefreshTimer', 'cancelMonitorSummaryLoad', 'cancelOpsSummaryLoad']);

window.refreshMonitorSummary = function(options = {}) {
    return window.loadMonitorSummary({ ...options, force: true });
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
                window.loadMonitorSummary();
            }
        }, 10000);
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
