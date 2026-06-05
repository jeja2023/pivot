/* eslint-disable no-undef, no-unused-vars */
// Agent 运行步骤渲染器 Agent run step renderers
// Split from agent-run-renderers.js.
// Agent run step previews and structured output renderers.
function agentStepStructuredSummary(value) {
    const structured = unwrapAgentStructuredPayload(value);
    if (!structured || typeof structured !== 'object') return '';
    if (isAgentPivotChartSpec(structured)) {
        const typeLabel = {
            bar: '柱状图',
            line: '折线图',
            pie: '饼图',
            scatter: '散点图',
            area: '面积图'
        }[String(structured.chartType || '').toLowerCase()] || '图表';
        const points = Math.max(
            Array.isArray(structured.labels) ? structured.labels.length : 0,
            ...(Array.isArray(structured.series) ? structured.series.map(item => Array.isArray(item?.data) ? item.data.length : 0) : [0])
        );
        return `已生成${typeLabel}${structured.title ? `：${structured.title}` : ''}${points ? `，包含 ${points} 个数据点` : ''}。`;
    }
    const rows = agentRowsFromStructuredPayload(structured);
    if (rows.length) {
        const limit = Number(structured.limit || structured.total || 0);
        return `查询完成，返回 ${rows.length} 行数据${limit && limit !== rows.length ? `（限制 ${limit} 行）` : ''}。`;
    }
    return '';
}

function agentStepRowsMarkup(structured) {
    const rows = agentRowsFromStructuredPayload(structured);
    if (!rows.length) return '';
    const objectRows = rows
        .map(row => (row && typeof row === 'object' && !Array.isArray(row)) ? row : { value: row });
    const columns = [...new Set(objectRows.flatMap(row => Object.keys(row)))].slice(0, 6);
    const previewRows = objectRows.slice(0, 5);
    const hiddenCount = Math.max(rows.length - previewRows.length, 0);
    const limit = Number(structured?.limit || 0);
    return `
        <div class="agent-step-readable">
            <div class="agent-step-readable-head">
                <strong>查询结果</strong>
                <span>返回 ${rows.length} 行${limit && limit !== rows.length ? ` · 限制 ${limit} 行` : ''}</span>
            </div>
            <div class="agent-step-table-wrap">
                <table class="agent-step-table">
                    <thead>
                        <tr>${columns.map(column => `<th>${agentEscape(column)}</th>`).join('')}</tr>
                    </thead>
                    <tbody>
                        ${previewRows.map(row => `
                            <tr>${columns.map(column => `<td>${agentEscape(agentReadableCell(row[column]))}</td>`).join('')}</tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
            ${hiddenCount ? `<div class="agent-step-readable-note">仅展示前 ${previewRows.length} 行，还有 ${hiddenCount} 行可在原始数据中查看。</div>` : ''}
        </div>
    `;
}

function agentStepChartSummaryMarkup(structured) {
    if (!isAgentPivotChartSpec(structured)) return '';
    const typeLabel = {
        bar: '柱状图',
        line: '折线图',
        pie: '饼图',
        scatter: '散点图',
        area: '面积图'
    }[String(structured.chartType || '').toLowerCase()] || '图表';
    const series = Array.isArray(structured.series) ? structured.series : [];
    const points = Math.max(
        Array.isArray(structured.labels) ? structured.labels.length : 0,
        ...series.map(item => Array.isArray(item?.data) ? item.data.length : 0),
        0
    );
    const xAxis = structured.xAxis?.label || structured.xAxis?.field || '';
    const yAxis = structured.yAxis?.label || structured.yAxis?.field || '';
    return `
        <div class="agent-step-readable agent-step-chart-summary">
            <div class="agent-step-readable-head">
                <strong>图表已生成</strong>
                <span>${agentEscape(typeLabel)}</span>
            </div>
            <div class="agent-step-kpis">
                ${structured.title ? `<span><em>标题</em><strong>${agentEscape(structured.title)}</strong></span>` : ''}
                ${xAxis ? `<span><em>X 轴</em><strong>${agentEscape(xAxis)}</strong></span>` : ''}
                ${yAxis ? `<span><em>Y 轴</em><strong>${agentEscape(yAxis)}</strong></span>` : ''}
                <span><em>数据点</em><strong>${Number(points || 0)}</strong></span>
                ${series.length ? `<span><em>系列</em><strong>${series.map(item => agentEscape(item?.name || '数据')).join('、')}</strong></span>` : ''}
            </div>
        </div>
    `;
}

function agentLlmOutputText(value) {
    const payload = agentParsePayload(value);
    if (!payload) return '';
    if (typeof payload === 'string') return payload.trim();
    if (typeof payload !== 'object') return String(payload || '').trim();
    const contentText = Array.isArray(payload.content)
        ? payload.content.map(item => {
            if (typeof item === 'string') return item;
            if (!item || typeof item !== 'object') return '';
            return String(item.text || item.content || item.markdown || '').trim();
        }).filter(Boolean).join('\n').trim()
        : '';
    return [
        typeof payload.content === 'string' ? payload.content : '',
        payload.text,
        payload.markdown,
        payload.answer,
        payload.message,
        payload.summary,
        contentText
    ].map(item => String(item || '').trim()).find(Boolean) || '';
}

function agentStepLlmReadableMarkup(step) {
    if (String(step?.tool_name || '').trim() !== 'agent.llm') return '';
    const text = stripAgentWorkflowReportHeading(agentLlmOutputText(step.output));
    if (!text) return '';
    return `<div class="agent-step-readable agent-step-llm-output">${renderMarkdown(normalizeAgentMarkdown(text))}</div>`;
}

function agentStepReadableMarkup(step) {
    const llmReadable = agentStepLlmReadableMarkup(step);
    if (llmReadable) return llmReadable;
    const structured = unwrapAgentStructuredPayload(step.output || step.input || {});
    if (!structured || typeof structured !== 'object') return '';
    return agentStepChartSummaryMarkup(structured) || agentStepRowsMarkup(structured);
}

function agentStepPreview(step) {
    if (String(step?.tool_name || '').trim() === 'agent.llm') {
        const llmText = stripAgentWorkflowReportHeading(agentLlmOutputText(step.output));
        if (llmText) return agentShortText(llmText, 500);
    }
    const payload = agentParsePayload(step.output || step.input || {});
    if (typeof payload === 'string') return agentShortText(payload, 500);
    if (Array.isArray(payload)) return `返回 ${payload.length} 条结果。`;
    if (!payload || typeof payload !== 'object') return agentShortText(payload || '');
    const structuredSummary = agentStepStructuredSummary(payload);
    if (structuredSummary) return structuredSummary;
    if (payload.answer) return payload.answer;
    if (payload.error) return payload.error;
    if (payload.thought || payload.action) {
        const lines = [];
        if (payload.thought) lines.push(`判断：${agentShortText(payload.thought, 220)}`);
        if (payload.action === 'tool') lines.push(`动作：调用 ${agentToolTitle(payload.tool)}`);
        if (payload.action === 'final') lines.push('动作：生成最终结果');
        if (payload.input) lines.push(`参数：${agentSummarizeInput(payload.input)}`);
        return lines.join('\n') || '已完成一次规划。';
    }
    if (Array.isArray(payload.matches)) {
        const scores = payload.matches
            .map(item => Number(item.score))
            .filter(score => Number.isFinite(score));
        const best = scores.length ? `，最高相关度 ${Math.max(...scores).toFixed(3)}` : '';
        const named = payload.matches.find(item => item.name || item.source || item.document_name);
        const source = named ? `，来源：${agentShortText(named.name || named.source || named.document_name, 80)}` : '';
        return `返回 ${payload.matches.length} 条匹配结果${best}${source}。`;
    }
    if (Array.isArray(payload.documents)) return `返回 ${payload.documents.length} 个知识库文档。`;
    if (Array.isArray(payload.sessions)) return `返回 ${payload.sessions.length} 条会话记录。`;
    if (Array.isArray(payload.models)) return `返回 ${payload.models.length} 个可用模型。`;
    if (payload.query) return `查询：${payload.query}`;
    if (payload.status) return `状态：${payload.status}`;
    return agentShortText(JSON.stringify(payload), 500);
}

function normalizeAgentMarkdown(text) {
    return String(text || '')
        .replace(/\*\*([^*\n]+?)：\s+\*\*/g, '**$1：**')
        .replace(/\*\*([^*\n]+?):\s+\*\*/g, '**$1:**');
}

function stripAgentWorkflowReportHeading(text) {
    const value = String(text || '').replace(/^\uFEFF/, '');
    const trimmed = value.trim();
    if (!trimmed) return '';
    const lines = value.split(/\r?\n/);
    let start = 0;
    while (start < lines.length && !String(lines[start] || '').trim()) start += 1;
    if (start >= lines.length) return '';
    const firstLine = String(lines[start] || '').trim();
    const normalized = firstLine.replace(/^#{1,6}\s*/, '').replace(/^\*\*(.*)\*\*$/, '$1').trim();
    if (!/^(?:工作流分析报告|工作流报告|分析报告)\s*[：:]/.test(normalized)) {
        return trimmed;
    }
    const remainder = lines.slice(start + 1);
    while (remainder.length && !String(remainder[0] || '').trim()) remainder.shift();
    return remainder.join('\n').trim();
}

function agentStepRawDetail(step, preview) {
    const payload = step.output || step.input;
    if (payload === undefined || payload === null) return '';
    const raw = typeof payload === 'string' ? payload.trim() : JSON.stringify(payload, null, 2);
    if (!raw || raw === preview) return '';
    return raw.length > 5000 ? `${raw.slice(0, 5000)}\n...` : raw;
}

function agentStepMarkup(step) {
    const preview = normalizeAgentMarkdown(agentStepPreview(step));
    const readable = agentStepReadableMarkup(step);
    const raw = agentStepRawDetail(step, preview);
    return `
        <div class="agent-step ${agentEscape(step.status)}">
            <div class="agent-step-head">
                <strong>${step.step_index}. ${agentEscape(agentStepTitle(step))}</strong>
                <span>${agentEscape(agentToolTitle(step.tool_name || step.type))} · ${Number(step.duration_ms || 0)} 毫秒</span>
            </div>
            <div class="agent-step-body">${readable || renderMarkdown(agentEscape(preview))}</div>
            ${raw ? `<details class="agent-step-raw"><summary>查看原始数据</summary><pre>${agentEscape(raw)}</pre></details>` : ''}
        </div>
    `;
}

function unwrapAgentStructuredPayload(value) {
    const payload = agentParsePayload(value);
    if (!payload || typeof payload !== 'object') return null;
    if (payload.structuredContent && typeof payload.structuredContent === 'object') return payload.structuredContent;
    if (Array.isArray(payload.content)) {
        const text = payload.content
            .map(item => item?.text || item?.content || '')
            .filter(Boolean)
            .join('\n')
            .trim();
        const nested = agentParsePayload(text);
        if (nested && typeof nested === 'object') {
            return nested.structuredContent && typeof nested.structuredContent === 'object'
                ? nested.structuredContent
                : nested;
        }
    }
    return payload;
}

function isAgentPivotChartSpec(value) {
    return Boolean(value && typeof value === 'object'
        && value.type === 'pivot_chart'
        && Array.isArray(value.labels)
        && Array.isArray(value.series));
}

function renderAgentPivotChartBlock(spec) {
    return `
        <div class="pivot-echart-block" data-pivot-echart="${agentEscapeAttr(JSON.stringify(spec))}">
            <div class="pivot-echart-title">图表</div>
            <div class="pivot-echart-canvas"></div>
            <canvas height="300"></canvas>
            <pre class="pivot-echart-error-text"></pre>
        </div>
    `;
}

function renderAgentStructuredOutput(value, label = '') {
    const payload = unwrapAgentStructuredPayload(value);
    if (!payload) return '';
    let body = '';
    if (isAgentPivotChartSpec(payload)) {
        body = renderAgentPivotChartBlock(payload);
    } else if (payload && typeof payload === 'object') {
        const type = String(payload.type || '');
        const markdown = String(payload.markdown || '').trim();
        if (markdown && ['pivot_table', 'pivot_report', 'format_markdown_table'].includes(type)) {
            body = renderMarkdown(markdown);
        }
    }
    if (!body) return '';
    return `
        <div class="agent-structured-output">
            ${label ? `<div class="agent-structured-output-title">${agentEscape(label)}</div>` : ''}
            <div class="agent-structured-output-body">${body}</div>
        </div>
    `;
}
