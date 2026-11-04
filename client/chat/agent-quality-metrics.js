(function () {
    function render(q, escape, escapeAttr) {
        const rate = value => value === null || value === undefined ? '—' : `${Math.round(Number(value) * 100)}%`;
        const cache = q.promptCache || {};
        const tiles = [['验收通过率', rate(q.verification?.verifiedRate), `${Number(q.verification?.total || 0)} 个已验收任务`],
            ['执行终态率', rate(q.runs?.executionCompletionRate), '近 30 天任务运行'],
            ['审批中位数', q.approvals?.medianSeconds == null ? '—' : `${Math.round(Number(q.approvals.medianSeconds) / 60)} 分钟`, '人工介入耗时'],
            ['工具错误率', rate(q.tools?.errorRate), '外部调用异常率'],
            ['Prompt 缓存已观测', rate(cache.observationRate), cache.observedCalls ? `${Number(cache.cacheReadTokens || 0)} 读 / ${Number(cache.cacheCreationTokens || 0)} 写 Token` : '提供方尚未返回缓存字段'],
            ['渠道死信', Number(q.deliveries?.deadLetter || 0), '未送达消息队列']];
        const groups = q.toolChain?.groups || [];
        let summary = `<div class="agent-quality-metrics-grid">${tiles.map(([title, value, hint]) => `<div class="agent-metric-tile"><span>${escape(title)}</span><strong>${escape(value)}</strong><small title="${escapeAttr(hint)}">${escape(hint)}</small></div>`).join('')}</div>`;
        const labels = { render: '文件登记', preview_responded: '预览响应完成', preview_failed: '预览响应失败', preview_config_responded: '预览配置响应', download_responded: '下载响应完成', download_failed: '下载响应失败', delivered: '已确认交付', digest_mismatch: '摘要不一致' };
        const stages = (q.toolChain?.deliveryStages || []).filter(row => labels[row.stage]).map(row => `${labels[row.stage]} ${Number(row.samples)}`).join(' · ');
        if (stages) summary += `<p>${escape(stages)}</p>`;
        const stops = { AGENT_TOTAL_ROUND_LIMIT: '累计轮次用尽', max_steps: '累计轮次用尽', max_tokens_total: '累计模型用量用尽', max_tool_calls: '累计工具调用用尽',
            AGENT_NO_PROGRESS: '没有新结果', AGENT_SEGMENT_LIMIT: '单段结束未续跑', AGENT_TIMEOUT: '执行超时', AGENT_FINALIZATION_REQUIRED: '进入预留收尾', AGENT_BUDGET_PERSIST_FAILED: '用量记录失败' };
        const budgetStops = (q.roundBudgetStops || []).map(row => `${stops[row.code] || '其他预算边界'} ${Number(row.samples)} 项（后续完成 ${Number(row.later_completed)} 项）`).join(' · ');
        if (budgetStops) summary += `<p>任务预算停止记录：${escape(budgetStops)}</p>`;
        if (!groups.length) return summary + '<p>暂无工具链路样本。</p>';
        return summary + `<div class="table-container"><table class="data-table compact-table"><caption>我的工具调用质量 · 按入口、模型和契约版本分组</caption><thead><tr><th>工具 / 入口</th><th>样本</th><th>调用成功率</th><th>业务失败 / 超时 / 拒绝</th><th>耗时中位数 / 95分位</th></tr></thead><tbody>${groups.slice(0, 30).map(row => `<tr><td title="${escapeAttr(`模型 ${row.modelId || '-'} · 契约 ${row.definitionDigest || '无记录'}`)}">${escape(row.tool)} / ${escape(row.entrypoint)}</td><td>${Number(row.sampleCount)}</td><td>${rate(row.invocationSuccessRate)}（${Number(row.succeeded)}/${Number(row.denominator)}）</td><td>${Number(row.businessFailures)} / ${Number(row.timeouts)} / ${Number(row.denied)}</td><td>${Number(row.p50Ms)} / ${Number(row.p95Ms)} 毫秒</td></tr>`).join('')}</tbody></table></div><p>调用成功与依据、内容核验、预览及下载分别确认；无样本时不推断成功。</p>`;
    }
    window.Pivot?.exposeModule?.('agent.qualityMetrics', { render });
})();
