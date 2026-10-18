// Agent 运行追踪展示，保留与运行详情共享的折叠状态。
/* eslint-disable no-undef */
function agentTraceTypeLabel(type = '') {
    return ({
        model: '模型调用', tool: '工具执行', plan: '任务规划', dag: '工作流', dag_node: '节点执行',
        agent: '智能体', handoff: '交接上下文', routing: '条件路由', control: '控制流程', note: '运行记录',
        llm: '大模型分析', observation: '观察结果', prompt: '提示词', action: '执行动作',
        error: '执行异常', execute: '任务执行', eval: '质量评测', review: '内容校对'
    })[String(type || '').toLowerCase()] || '执行步骤';
}
function agentTraceNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
}
function agentTraceDuration(value) {
    const ms = Math.max(agentTraceNumber(value), 0);
    if (ms >= 60000) return `${(ms / 60000).toFixed(ms >= 600000 ? 0 : 1)} 分钟`;
    if (ms >= 1000) return `${(ms / 1000).toFixed(ms >= 10000 ? 0 : 1)} 秒`;
    return `${Math.round(ms)} 毫秒`;
}
function agentTraceDisplayName(span = {}) {
    const name = String(span.name || '').trim();
    if (!name) return '运行步骤';
    if (/^(?:mcp\.\d+\.)?[a-z][\w-]*(?:\.[\w-]+)+$/i.test(name)) return agentToolTitle(name);
    const mapped = {
        plan: '任务规划', llm: '大模型分析', model: '模型调用', agent: '智能体运行',
        delegate: '委派智能体', handoff: '智能体交接', tool: '工具调用', action: '执行动作',
        observation: '观察结果', flow_rule: '流程规则', control: '任务控制',
        execute: '执行操作', eval: '评测分析', router: '路由分发'
    }[name.toLowerCase()];
    return mapped || agentToolTitle(name) || name;
}
function agentTraceTimestamp(value) {
    const text = String(value || '').trim();
    if (!text) return 0;
    const normalized = /[zZ]|[+-]\d\d:\d\d$/.test(text) ? text : `${text.replace(' ', 'T')}+08:00`;
    const parsed = Date.parse(normalized);
    return Number.isFinite(parsed) ? parsed : 0;
}
function agentTraceReadableDetail(span = {}, runId = '') {
    const items = [];
    if (span.details) items.push(['运行信息', span.details]);
    if (span.input) items.push(['输入摘要', span.input]);
    if (span.output) items.push(['输出摘要', span.output]);
    if (!items.length && !span.error_message) return '';
    const spanKey = String(span.span_id || span.id || span.name || '').trim();
    const effectiveRunId = runId || (typeof activeAgentRunId !== 'undefined' ? activeAgentRunId : '');
    const discKey = spanKey ? `trace-span-${spanKey}` : '';
    const isOpen = (discKey && effectiveRunId && typeof isAgentRunDisclosureOpen === 'function')
        ? isAgentRunDisclosureOpen(effectiveRunId, discKey, false)
        : false;
    const openAttr = isOpen ? ' open' : '';
    const keyAttr = discKey ? ` data-disclosure-key="${agentEscapeAttr(discKey)}"` : '';
    return `<details class="agent-trace-detail"${keyAttr}${openAttr}><summary>查看上下文</summary><div class="agent-trace-detail-body">${span.error_message ? `<div class="error-detail">${agentEscape(span.error_message)}</div>` : ''}${items.map(([label, value]) => `<section><h5>${agentEscape(label)}</h5>${typeof agentResultReadableMarkup === 'function' ? agentResultReadableMarkup(value, { maxRows: 4, maxItems: 5 }) : `<p>${agentEscape(agentShortText(JSON.stringify(value), 600))}</p>`}</section>`).join('')}</div></details>`;
}
function renderAgentTrace(traceData = {}, runStatus = '', runId = '') {
    const spans = Array.isArray(traceData?.spans) ? traceData.spans : [];
    if (!spans.length) return '';
    const summary = traceData.summary || {};
    const starts = spans.map(span => agentTraceTimestamp(span.started_at)).filter(Boolean);
    const traceStart = agentTraceTimestamp(traceData.trace?.started_at) || (starts.length ? Math.min(...starts) : Date.now());
    const spanEnd = Math.max(traceStart, ...spans.map(span => agentTraceTimestamp(span.completed_at) || (agentTraceTimestamp(span.started_at) + agentTraceNumber(span.duration_ms))));
    const longestSpanMs = Math.max(0, ...spans.map(span => agentTraceNumber(span.duration_ms)));
    const totalMs = Math.max(agentTraceNumber(summary.totalDurationMs), spanEnd - traceStart, longestSpanMs, 1);
    const effectiveRunId = runId || (typeof activeAgentRunId !== 'undefined' ? activeAgentRunId : '');
    const isPanelRecordedOpen = (effectiveRunId && typeof isAgentRunDisclosureOpen === 'function')
        ? isAgentRunDisclosureOpen(effectiveRunId, 'trace-panel', null)
        : null;
    const isExpanded = isPanelRecordedOpen !== null
        ? Boolean(isPanelRecordedOpen)
        : ['error', 'approval_required'].includes(String(runStatus || ''));
    const expanded = isExpanded ? ' open' : '';
    return `
        <details class="agent-trace-panel" data-disclosure-key="trace-panel"${expanded}>
            <summary class="agent-trace-head">
                <span><strong>运行追踪</strong><em>${spans.length} 个环节</em></span>
                <span>
                    <em>总耗时 ${agentEscape(agentTraceDuration(totalMs))}</em>
                    ${Number(summary.errorCount || 0) ? `<em class="is-error">${Number(summary.errorCount)} 个异常</em>` : '<em class="is-success">链路正常</em>'}
                </span>
            </summary>
            <div class="agent-trace-list">
                ${spans.map((span, spanIdx) => {
        const start = agentTraceTimestamp(span.started_at) || traceStart;
        const duration = Math.max(agentTraceNumber(span.duration_ms), 12);
        const left = Math.max(0, Math.min(((start - traceStart) / totalMs) * 100, 96));
        const width = Math.max(2, Math.min((duration / totalMs) * 100, 100 - left));
        const status = span.status === 'error' ? 'error' : (span.status === 'running' ? 'running' : 'completed');
        const spanKey = String(span.span_id || span.id || span.name || spanIdx).trim();
        return `
                        <article class="agent-trace-item ${status}" data-trace-span-id="${agentEscapeAttr(spanKey)}">
                            <div class="agent-trace-item-meta">
                                <span class="agent-trace-type">${agentEscape(agentTraceTypeLabel(span.span_type))}</span>
                                <strong>${agentEscape(agentTraceDisplayName(span))}</strong>
                                <em>${agentEscape(agentTraceDuration(span.duration_ms))}</em>
                            </div>
                            <div class="agent-trace-track" aria-label="${agentEscape(agentTraceDisplayName(span))}，耗时 ${agentEscape(agentTraceDuration(span.duration_ms))}">
                                <svg viewBox="0 0 100 1" preserveAspectRatio="none" aria-hidden="true"><rect x="${left.toFixed(2)}" y="0" width="${width.toFixed(2)}" height="1"></rect></svg>
                            </div>
                            ${agentTraceReadableDetail(span, effectiveRunId)}
                        </article>
                    `;
    }).join('')}
            </div>
        </details>
    `;
}
