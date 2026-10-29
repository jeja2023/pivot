/* 系统监控的概览与质量指标；资源详情沿用现有监控组件。 */
(function installMonitorDashboard() {
    const api = window.Pivot;
    const unknown = '暂无数据';
    const number = value => value == null || !Number.isFinite(Number(value)) ? unknown : formatMetricNumber(value);
    const ms = value => value == null || !Number.isFinite(Number(value)) ? unknown : `${formatMetricNumber(value, 1)} ms`;
    const rows = items => items.map(([label, value, warning = false]) => `<div class="monitor-row${warning ? ' is-warning' : ''}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(String(value))}</strong></div>`).join('');
    const set = (id, html) => {
        const element = document.getElementById(id);
        if (element) PivotSafeHtml.setHtml(element, html);
    };
    function render(data) {
        const http = data.http || {};
        const health = data.health || {};
        const concurrency = data.concurrency || {};
        const open = Array.isArray(data.observability?.openByType) ? data.observability.openByType : null;
        const alerts = open?.reduce((sum, item) => sum + Number(item.count || 0), 0);
        const statuses = { ok: '正常', degraded: '需关注', error: '异常' };
        const cards = [
            ['服务健康', statuses[health.status] || unknown, '查看下方全部检查项', health.status === 'error' ? 'critical' : health.status && health.status !== 'ok'],
            ['未恢复告警', number(alerts), '全局 · 当前未恢复事件', alerts > 0],
            ['HTTP 请求', number(http.requests), '本实例 · 启动以来'],
            ['HTTP 5xx 错误率', http.requests > 0 ? `${(Number(http.errorRate || 0) * 100).toFixed(2)}%` : unknown, '本实例 · 启动以来', Number(http.errorRate) > 0.05],
            ['HTTP P95', http.requests > 0 ? (http.p95LatencyMs == null ? unknown : http.p95LatencyMs > 0 ? ms(http.p95LatencyMs) : '> 10 s') : unknown, '本实例 · 启动以来 · 直方图估算'],
            ['AI 并发', concurrency.active == null ? unknown : `${number(concurrency.active)} / ${number(concurrency.effectiveMax ?? concurrency.max)}`, `本实例 · 排队 ${number(concurrency.queued)}`]
        ];
        set('monitor-summary-grid', cards.map(([label, value, hint, warning]) => `<div class="monitor-card${warning === 'critical' ? ' is-critical' : warning ? ' is-warning' : ''}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(hint)}</small></div>`).join(''));
        const runtime = data.runtime || {};
        const queue = runtime.taskQueue || {};
        set('monitor-task-queue', queue.available ? rows([
            ['运行中', number(queue.running)], ['排队任务', number(queue.queued), queue.queued > 0],
            ['最早排队时长', queue.oldestQueuedSeconds == null ? '无排队任务' : queue.oldestQueuedSeconds < 60 ? `${formatMetricNumber(queue.oldestQueuedSeconds, 0)} 秒` : formatDuration(queue.oldestQueuedSeconds)],
            ['待人工确认', number(queue.awaitingApproval)], ['失败或部分完成（24h）', number(queue.failures24h), queue.failures24h > 0]
        ]) : '<p class="monitor-empty">任务队列暂不可用，请稍后刷新。</p>');
        const pool = runtime.pgPool || {};
        const loop = runtime.eventLoop || {};
        const writes = runtime.writeQueue || {};
        const loopAvailable = loop.supported && loop.sampled;
        set('monitor-runtime-pressure', rows([
            ['在途 HTTP 请求', number(runtime.requests?.current)],
            ['平均响应（启动以来）', http.requests > 0 ? ms(http.avgLatencyMs) : unknown],
            ['事件循环 P99', loopAvailable ? ms(loop.p99Ms) : unknown, loopAvailable && loop.p99Ms >= runtime.thresholds?.loopDelayWarnMs],
            ['事件循环采样窗口', loopAvailable ? `${formatMetricNumber(loop.windowMs / 1000, 0)} 秒` : unknown],
            ['数据库连接（忙 / 上限）', pool.available ? `${number(pool.busy)} / ${number(pool.max)}` : unknown, pool.saturated],
            ['等待数据库连接', pool.available ? number(pool.waiting) : unknown, pool.waiting > 0],
            ['待写入记录', number(writes.pending)], ['写入异常队列', number(writes.failedQueues), writes.failedQueues > 0],
            ['丢弃写入（启动以来）', number(writes.dropped), writes.dropped > 0]
        ]));
        set('monitor-usage-summary', rows([
            ['今日消息', number(data.tokens?.todayMessages)], ['今日 Token', formatTokenCount(data.tokens?.today)],
            ['累计 Token', formatTokenCount(data.tokens?.total)], ['活跃用户（15 分钟）', number(data.activeUsers)]
        ]));
        renderRouting(data);
    }
    function renderRouting(data) {
        const routingData = data.chatRouting || {};
        const routing = (Array.isArray(routingData.rows) ? routingData.rows : []).reduce((sum, row) => ({
            requests: sum.requests + Number(row.request_count || 0), errors: sum.errors + Number(row.error_count || 0),
            duration: sum.duration + Number(row.total_route_duration_ms || 0),
            knowledge: sum.knowledge + Number(row.total_rag_candidates || 0), tools: sum.tools + Number(row.total_tool_candidates || 0)
        }), { requests: 0, errors: 0, duration: 0, knowledge: 0, tools: 0 });
        const decisions = (Array.isArray(data.decisionRouting?.providers) ? data.decisionRouting.providers : []).reduce((sum, row) => ({
            calls: sum.calls + Number(row.calls || 0), errors: sum.errors + Number(row.errors || 0),
            p95: Math.max(sum.p95, Number(row.p95_duration_ms || 0))
        }), { calls: 0, errors: 0, p95: 0 });
        const available = !routingData.unavailable;
        set('monitor-routing-quality', rows([
            ['智能路由请求', available ? number(routing.requests) : unknown],
            ['路由错误', available ? number(routing.errors) : unknown, routing.errors > 0],
            ['路由平均耗时', available && routing.requests ? ms(routing.duration / routing.requests) : unknown],
            ['平均候选（知识 / 工具）', available && routing.requests ? `${formatMetricNumber(routing.knowledge / routing.requests, 1)} / ${formatMetricNumber(routing.tools / routing.requests, 1)}` : unknown],
            ['决策服务调用 / 错误', data.decisionRouting?.unavailable ? unknown : `${number(decisions.calls)} / ${number(decisions.errors)}`],
            ['决策服务最高 P95', !data.decisionRouting?.unavailable && decisions.calls ? ms(decisions.p95) : unknown]
        ]));
    }
    let executionController = null;
    let decisionController = null;
    function cancelQualityLoad() {
        executionController?.abort(); executionController = null;
        decisionController?.abort(); decisionController = null;
    }
    function failureReasonLabel(code) {
        const labels = {
            delivery_not_verified: '任务交付未通过核验',
            unspecified: '未记录具体原因'
        };
        return Object.hasOwn(labels, code) ? labels[code] : '其他未识别原因';
    }
    async function loadDecisionFailures() {
        decisionController?.abort();
        const controller = new AbortController();
        decisionController = controller;
        const element = document.getElementById('monitor-decision-failures');
        if (!element) { decisionController = null; return; }
        set('monitor-decision-failures', '<tr><td colspan="3" class="text-center">正在加载失败原因…</td></tr>');
        try {
            const response = await apiFetch(`${API_BASE}/stats/observability/decision-maintenance?lookbackDays=30`, { signal: controller.signal, timeoutMs: 30000 });
            if (!response.ok) throw new Error('失败原因暂时不可用');
            const body = await response.json();
            if (controller.signal.aborted) return;
            if (body.unavailable || !Array.isArray(body.errorBreakdown)) throw new Error('失败原因暂时不可用');
            const counts = new Map();
            for (const item of body.errorBreakdown) {
                if (item.scenario !== 'chat.execution' || item.eventType !== 'execution' || item.status !== 'failure') continue;
                const code = String(item.reasonCode || 'unspecified');
                counts.set(code, (counts.get(code) || 0) + (Number(item.count) || 0));
            }
            const sorted = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
            const emptyMessage = body.errorBreakdown.length >= 500
                ? '返回的结果中没有对话任务执行失败；由于结果达到上限，可能存在未显示的记录。'
                : '最近 30 天没有记录对话任务执行失败。';
            const content = sorted.length
                ? sorted.map(([code, count], index) => `<tr><td class="text-center">${index + 1}</td><td title="${escapeHtml(code)}">${escapeHtml(failureReasonLabel(code))}</td><td class="text-center">${escapeHtml(number(count))} 条</td></tr>`).join('')
                : `<tr><td colspan="3" class="text-center">${escapeHtml(emptyMessage)}</td></tr>`;
            set('monitor-decision-failures', content);
        } catch (error) {
            if (!controller.signal.aborted) set('monitor-decision-failures', '<tr><td colspan="3" class="text-center">失败原因暂时不可用，请点击“刷新指标”重试。</td></tr>');
        } finally {
            if (decisionController === controller) decisionController = null;
            api.legacy.scheduleSettingsWorkspaceScale?.();
        }
    }
    async function loadQuality() {
        cancelQualityLoad();
        const controller = new AbortController();
        executionController = controller;
        const element = document.getElementById('monitor-chat-execution');
        if (!element) return;
        element.textContent = '正在加载对话执行统计…';
        try {
            const response = await apiFetch(`${API_BASE}/chat/execution-metrics?scope=organization`, { signal: controller.signal, timeoutMs: 30000 });
            if (!response.ok) throw new Error('执行统计暂时不可用');
            const body = await response.json();
            if (controller.signal.aborted) return;
            const metrics = Array.isArray(body.metrics) ? body.metrics : [];
            const sum = key => metrics.reduce((total, item) => total + Number(item[key] || 0), 0);
            const tasks = metrics.filter(row => ['agent_run', 'continue_run'].includes(row.action)).reduce((total, row) => total + Number(row.count || 0), 0);
            set('monitor-chat-execution', rows([
                ['请求数', number(sum('count'))], ['任务与续接', number(tasks)], ['交付核验通过', number(sum('verified'))],
                ['执行失败或部分完成', number(sum('failures'))], ['用户纠正', number(sum('corrections'))],
                ['个人经验复用', number(sum('experience_reuse'))], ['已复核路由', number(sum('reviewed_routes'))],
                ['已核实误路由', number(sum('verified_route_mismatches'))]
            ]) + '<p class="monitor-empty">核验通过表示交付检查结果；用户纠正独立统计。没有核验样本时不计算成功率。</p>');
        } catch (error) {
            if (error.name !== 'AbortError') element.textContent = '对话执行统计暂不可用，请稍后刷新。';
        } finally {
            if (executionController === controller) executionController = null;
            api.legacy.scheduleSettingsWorkspaceScale?.();
        }
    }
    api.exposeModule('settings.monitorDashboard', { render, loadQuality, loadDecisionFailures, cancelQualityLoad });
}());
