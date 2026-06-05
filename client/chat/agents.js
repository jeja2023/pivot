/* Agent and MCP workbench */
let agentRunsCache = [];
let agentRefreshTimer = null;
let activeAgentRunId = '';
let agentToolsCache = [];
let agentTemplatesCache = [];
let agentSchedulesCache = [];
let agentArtifactsCache = [];
let capabilityPackagesCache = [];
let agentRealtimeSource = null;
let agentRealtimeConnected = false;
let agentRealtimeRefreshTimer = null;
let activeAgentConfigSection = '';
let agentRunsPage = 1;
let agentRunsTotal = 0;
let agentWorkflowsCache = [];
let activeAgentWorkflowId = '';
let agentWorkflowDraftName = '';
let agentWorkflowDraftDescription = '';
let agentWorkflowPickerQuery = '';
let activeAgentWorkflowPreviewRunId = '';
let agentWorkflowPreviewTimer = null;
const AGENT_RUNS_PAGE_SIZE = 10;
const AGENT_WORKFLOW_DRAFT_KEY = 'pivot.agent.workflow.draft';
const AGENT_WORKFLOW_SAVED_KEY = 'pivot.agent.workflow.saved';
let agentRunTitleTooltipEl = null;
let agentRunTitleTooltipTarget = null;

const agentEscape = (value) => escapeHtml(value === undefined || value === null ? '' : String(value));
const agentEscapeAttr = (value) => window.PivotSafeHtml?.escapeAttr
    ? window.PivotSafeHtml.escapeAttr(value)
    : agentEscape(value).replace(/"/g, '&quot;');

function agentLooksLikeCorruptTitle(value) {
    const text = String(value || '').trim();
    if (!text) return true;
    if (/^[?\uFFFD\s._-]+$/.test(text) && /[?\uFFFD]{3,}/.test(text)) return true;
    const questionCount = (text.match(/[?\uFFFD]/g) || []).length;
    return questionCount >= 3 && questionCount / Math.max(text.length, 1) > 0.55;
}

function agentDisplayTitle(item) {
    const title = String(item?.title || '').trim();
    const goal = String(item?.goal || '').trim();
    if (!agentLooksLikeCorruptTitle(title)) return title;
    return goal || '智能体任务';
}

function agentPreviewDisplayTitle(value) {
    let text = String(value || '').trim();
    while (/^预览运行\s*[:：]\s*/.test(text)) {
        text = text.replace(/^预览运行\s*[:：]\s*/, '').trim();
    }
    return text || '预览运行';
}

function ensureAgentRunTitleTooltip() {
    if (agentRunTitleTooltipEl?.isConnected) return agentRunTitleTooltipEl;
    agentRunTitleTooltipEl = document.createElement('div');
    agentRunTitleTooltipEl.className = 'agent-run-title-tooltip hidden';
    agentRunTitleTooltipEl.setAttribute('role', 'tooltip');
    document.body.appendChild(agentRunTitleTooltipEl);
    return agentRunTitleTooltipEl;
}

function positionAgentRunTitleTooltip(target) {
    if (!agentRunTitleTooltipEl || !target) return;
    const rect = target.getBoundingClientRect();
    const tooltipRect = agentRunTitleTooltipEl.getBoundingClientRect();
    const gap = 8;
    const viewportPadding = 12;
    const maxLeft = Math.max(viewportPadding, window.innerWidth - tooltipRect.width - viewportPadding);
    const left = Math.min(Math.max(rect.left, viewportPadding), maxLeft);
    let top = rect.bottom + gap;
    if (top + tooltipRect.height > window.innerHeight - viewportPadding) {
        top = Math.max(viewportPadding, rect.top - tooltipRect.height - gap);
    }
    agentRunTitleTooltipEl.style.left = `${Math.round(left)}px`;
    agentRunTitleTooltipEl.style.top = `${Math.round(top)}px`;
}

function showAgentRunTitleTooltip(target) {
    const text = target?.dataset?.agentRunTitleFull || '';
    if (!text) return;
    const tooltip = ensureAgentRunTitleTooltip();
    tooltip.textContent = text;
    tooltip.classList.remove('hidden');
    agentRunTitleTooltipTarget = target;
    positionAgentRunTitleTooltip(target);
}

function hideAgentRunTitleTooltip(target = null) {
    if (target && target !== agentRunTitleTooltipTarget) return;
    agentRunTitleTooltipEl?.classList.add('hidden');
    agentRunTitleTooltipTarget = null;
}

function agentNotificationTitle(item) {
    const title = String(item?.title || '').trim();
    if (!agentLooksLikeCorruptTitle(title)) return title;
    const body = String(item?.body || '').trim();
    if (!agentLooksLikeCorruptTitle(body)) return agentShortText(body, 72);
    return '智能体通知';
}

function agentNotificationBody(item) {
    const body = String(item?.body || item?.created_at || '').trim();
    if (!agentLooksLikeCorruptTitle(body)) return agentShortText(body, 72);
    return item?.created_at || '任务状态已更新';
}

function agentStatusLabel(status) {
    const map = {
        queued: '排队中',
        running: '运行中',
        completed: '已完成',
        error: '失败',
        cancelled: '已停止',
        approval_required: '待审批'
    };
    return map[status] || status || '-';
}

function isAgentRunActive(status) {
    return status === 'queued' || status === 'running' || status === 'approval_required';
}

function agentRunModeLabel(mode) {
    const map = { standard: '标准模式', deep: '深度模式', audit: '审查模式', dag: '工作流' };
    return map[mode] || '标准模式';
}

function agentToolPolicyLabel(policy) {
    return policy === 'builtin_only' ? '仅系统工具' : '系统 + 能力库';
}

function agentDownload(url) {
    const link = document.createElement('a');
    link.href = url;
    link.download = '';
    document.body.appendChild(link);
    link.click();
    link.remove();
}

function formatAgentTokenUsage(run) {
    const total = Number(run?.total_tokens || 0);
    if (!total) return '';
    return `Token ${total}（入 ${Number(run.input_tokens || 0)} / 出 ${Number(run.output_tokens || 0)}）`;
}

function formatAgentCompactCount(value) {
    const num = Number(value || 0);
    if (!Number.isFinite(num)) return '0';
    const units = [
        { value: 1_000_000_000, suffix: 'B' },
        { value: 1_000_000, suffix: 'M' },
        { value: 1_000, suffix: 'K' }
    ];
    const unit = units.find(item => Math.abs(num) >= item.value);
    if (!unit) return String(Math.round(num));
    const scaled = num / unit.value;
    const digits = Math.abs(scaled) >= 100 ? 0 : 1;
    return `${scaled.toFixed(digits).replace(/\.0$/, '')}${unit.suffix}`;
}

const formatAgentAuditDate = (dateStr) => {
    if (!dateStr) return '-';
    if (typeof formatDateToCN === 'function') return formatDateToCN(dateStr);
    return String(dateStr);
};

function buildAgentRunTaskTooltip(run, title, mode, counts = {}) {
    const stepCount = Number(counts.stepCount || 0);
    const toolCount = Number(counts.toolCount || 0);
    const errorCount = Number(counts.errorCount || 0);
    const goal = String(run?.goal || '').trim();
    const lines = [
        `任务：${title || '-'}`,
        `状态：${agentStatusLabel(run?.status)}`,
        `创建时间：${formatAgentAuditDate(run?.created_at)}`,
        `开始时间：${formatAgentAuditDate(run?.started_at)}`,
        `完成时间：${formatAgentAuditDate(run?.completed_at)}`,
        `模型：${run?.model_name || '-'}`,
        `模式：${mode || '-'}`,
        `步骤数：${stepCount}`,
        `工具数：${toolCount}`,
        `错误数：${errorCount}`
    ];
    if (goal) lines.push(`目标：${goal}`);
    return lines.join('\n');
}

function agentShortText(value, max = 260) {
    const text = String(value === undefined || value === null ? '' : value)
        .replace(/\s+/g, ' ')
        .trim();
    if (text.length <= max) return text;
    return `${text.slice(0, max)}...`;
}

function agentParsePayload(payload) {
    if (typeof payload !== 'string') return payload;
    const text = payload.trim();
    if (!text) return '';
    if (!text.startsWith('{') && !text.startsWith('[')) return text;
    try {
        return JSON.parse(text);
    } catch (e) {
        return text;
    }
}

function agentSummarizeInput(input) {
    const payload = agentParsePayload(input);
    if (!payload || typeof payload !== 'object') return agentShortText(payload || '');
    const parts = [];
    if (payload.query) parts.push(`查询：${payload.query}`);
    if (payload.limit) parts.push(`数量：${payload.limit}`);
    if (payload.topK) parts.push(`Top K：${payload.topK}`);
    if (payload.candidateLimit) parts.push(`候选：${payload.candidateLimit}`);
    return parts.join(' · ') || agentShortText(JSON.stringify(payload));
}

function agentReadableCell(value) {
    if (value === undefined || value === null || value === '') return '-';
    if (typeof value === 'object') return agentShortText(JSON.stringify(value), 80);
    return agentShortText(value, 80);
}

function agentRowsFromStructuredPayload(payload) {
    if (!payload || typeof payload !== 'object') return [];
    if (Array.isArray(payload.rows)) return payload.rows;
    if (Array.isArray(payload.data)) return payload.data;
    if (Array.isArray(payload.items)) return payload.items;
    if (Array.isArray(payload.result)) return payload.result;
    return [];
}

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

function agentStepReadableMarkup(step) {
    const structured = unwrapAgentStructuredPayload(step.output || step.input || {});
    if (!structured || typeof structured !== 'object') return '';
    return agentStepChartSummaryMarkup(structured) || agentStepRowsMarkup(structured);
}

function agentStepPreview(step) {
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

function renderAgentRunVisualOutputs(dagNodes = [], steps = [], finalAnswer = '', runStatus = '') {
    if (isAgentRunActive(runStatus)) return '';
    if (/```(?:pivot-echart|pivot-chart|chart|charts)\b/i.test(String(finalAnswer || ''))) return '';
    const items = [];
    const seen = new Set();
    const push = (payload, label) => {
        const structured = unwrapAgentStructuredPayload(payload);
        if (!structured) return;
        const markup = renderAgentStructuredOutput(structured, label);
        if (!markup) return;
        const key = JSON.stringify(structured).slice(0, 2000);
        if (seen.has(key)) return;
        seen.add(key);
        items.push(markup);
    };
    dagNodes.forEach(node => push(node.output, node.title || node.node_key || agentToolTitle(node.tool_name)));
    if (!items.length) {
        steps.forEach(step => push(step.output, step.title || agentToolTitle(step.tool_name || step.type)));
    }
    if (!items.length) return '';
    const visibleItems = items.slice(0, 4);
    return `
        <section class="agent-visual-results">
            <div class="agent-tool-section-head compact">
                <strong>可视化结果</strong>
                <span>${visibleItems.length} 个结果</span>
            </div>
            ${visibleItems.join('')}
        </section>
    `;
}

function agentSortDagNodesForDisplay(dagNodes = []) {
    const nodes = Array.isArray(dagNodes) ? dagNodes.slice() : [];
    const entries = nodes.map((node, index) => ({
        node,
        index,
        key: String(node?.node_key || node?.id || `__node_${index}`),
        uniqueKey: `${String(node?.node_key || node?.id || '__node')}::${index}`
    }));
    const keySet = new Set(entries.map(entry => entry.key));
    const dependencyKeys = (node) => {
        const rawDepends = node?.depends_on ?? node?.dependsOn;
        const parsedDeps = agentParsePayload(rawDepends);
        const deps = Array.isArray(rawDepends)
            ? rawDepends
            : (Array.isArray(parsedDeps) ? parsedDeps : []);
        return deps.map(dep => String(dep || '').trim()).filter(dep => dep && keySet.has(dep));
    };
    const ordered = [];
    const placed = new Set();
    const placedKeys = new Set();
    while (ordered.length < entries.length) {
        const remaining = entries.filter(entry => !placed.has(entry.uniqueKey));
        const ready = remaining.filter(entry => dependencyKeys(entry.node).every(dep => placedKeys.has(dep)));
        const layer = ready.length ? ready : remaining;
        layer.sort((a, b) => a.index - b.index);
        layer.forEach(entry => {
            if (placed.has(entry.uniqueKey)) return;
            placed.add(entry.uniqueKey);
            placedKeys.add(entry.key);
            ordered.push(entry.node);
        });
    }
    return ordered;
}

function buildAgentToolStatsMarkup(steps) {
    if (!Array.isArray(steps) || steps.length === 0) return '';
    const toolSteps = steps.filter(s => String(s.type || '').toLowerCase() === 'tool' && s.tool_name);
    if (toolSteps.length === 0) return '';
    const stats = new Map();
    toolSteps.forEach(step => {
        const name = String(step.tool_name);
        const entry = stats.get(name) || { name, count: 0, errors: 0, durationMs: 0 };
        entry.count += 1;
        entry.durationMs += Math.max(Number(step.duration_ms || 0), 0);
        if (String(step.status || '').toLowerCase() === 'error') entry.errors += 1;
        stats.set(name, entry);
    });
    const ranked = [...stats.values()].sort((a, b) => b.count - a.count || b.durationMs - a.durationMs);
    const maxCount = ranked[0].count || 1;
    const rows = ranked.map(entry => {
        const widthPct = Math.max(4, (entry.count / maxCount) * 100);
        const avg = entry.count > 0 ? Math.round(entry.durationMs / entry.count) : 0;
        return `
            <div class="agent-tool-stat-row ${entry.errors > 0 ? 'has-error' : ''}">
                <span class="agent-tool-stat-name" title="${agentEscape(entry.name)}">${agentEscape(entry.name)}</span>
                <div class="agent-tool-stat-bar"><div class="agent-tool-stat-bar-fill" style="width:${widthPct.toFixed(1)}%"></div></div>
                <span class="agent-tool-stat-count">${entry.count} 次</span>
                <span class="agent-tool-stat-extra">${entry.durationMs} ms · 均 ${avg} ms${entry.errors > 0 ? ` · <em>${entry.errors} 失败</em>` : ''}</span>
            </div>
        `;
    }).join('');
    return `
        <section class="agent-tool-stats">
            <header class="agent-tool-stats-head"><strong>工具调用统计</strong><span>${ranked.length} 种工具 · 共 ${toolSteps.length} 次调用</span></header>
            <div class="agent-tool-stats-list">${rows}</div>
        </section>
    `;
}

function agentProgressLabel(run = {}, progress = {}) {
    const stepCount = Number(progress.stepCount || 0);
    const maxSteps = Number(progress.maxSteps || run.max_steps || 0);
    if (isAgentRunActive(run.status)) {
        if (progress.isLimitReached && maxSteps > 0) return `已执行 ${stepCount} 步（已达上限 ${maxSteps} 步）`;
        return maxSteps > 0 ? `已执行 ${stepCount} 步（上限 ${maxSteps} 步）` : `已执行 ${stepCount} 步`;
    }
    return `已执行 ${stepCount} 步`;
}

function agentDagNodeReadableText(node) {
    if (String(node?.tool_name || '').trim() !== 'agent.llm') return '';
    const payload = agentParsePayload(node.output);
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
    ].map(value => String(value || '').trim()).find(Boolean) || '';
}

function agentDagNodeReadableOutputMarkup(node) {
    const text = agentDagNodeReadableText(node);
    if (!text) return '';
    const cleanText = stripAgentWorkflowReportHeading(text);
    const parsed = agentParsePayload(cleanText);
    if (parsed && typeof parsed === 'object') {
        return `<div class="agent-dag-node-readable-output"><pre>${agentEscape(JSON.stringify(parsed, null, 2))}</pre></div>`;
    }
    return `<div class="agent-dag-node-readable-output">${renderMarkdown(normalizeAgentMarkdown(cleanText))}</div>`;
}

function agentDagNodeMarkup(node) {
    const deps = Array.isArray(node.depends_on) ? node.depends_on : [];
    const input = node.input ? (typeof node.input === 'string' ? node.input : JSON.stringify(node.input, null, 2)) : '';
    const output = node.output ? (typeof node.output === 'string' ? node.output : JSON.stringify(node.output, null, 2)) : '';
    const readableOutput = agentDagNodeReadableOutputMarkup(node);
    const canRerun = String(node.status || '').toLowerCase() === 'error';
    const status = String(node.status || 'pending').toLowerCase();
    const statusLabel = {
        completed: '完成',
        running: '运行中',
        error: '错误',
        skipped: '跳过',
        pending: '待执行'
    }[status] || agentStatusLabel(status);
    const depText = deps.length ? deps.join(', ') : '无依赖';
    const toolName = agentToolTitle(node.tool_name || '-');
    return `
        <div class="agent-dag-node ${agentEscape(node.status)}">
            <div class="agent-dag-node-head">
                <div class="agent-dag-node-title">
                    <strong>${agentEscape(node.title || node.node_key)}</strong>
                    ${node.node_key ? `<span>${agentEscape(node.node_key)}</span>` : ''}
                </div>
                <div class="agent-dag-node-badges">
                    <span class="agent-dag-node-status ${agentEscape(status)}">${agentEscape(statusLabel)}</span>
                    <span class="agent-dag-node-tool">${agentEscape(toolName)}</span>
                </div>
            </div>
            <div class="agent-dag-node-meta">
                <span><em>依赖</em><strong>${agentEscape(depText)}</strong></span>
                <span><em>尝试</em><strong>${Number(node.attempt_count || 0)} 次</strong></span>
                <span><em>耗时</em><strong>${Number(node.duration_ms || 0)} ms</strong></span>
                <span><em>条件</em><strong>${agentEscape(node.condition || '-')}</strong></span>
            </div>
            ${node.error_message ? `<div class="error-detail">${agentEscape(node.error_message)}</div>` : ''}
            ${canRerun ? `<button type="button" class="btn-secondary agent-dag-node-rerun" data-agent-dag-rerun-node="${agentEscape(node.node_key)}">重跑此节点</button>` : ''}
            ${readableOutput}
            ${(input || output) ? `
                <div class="agent-dag-node-folders">
                    ${input ? `<details><summary>节点输入</summary><pre>${agentEscape(agentShortText(input, 2400))}</pre></details>` : ''}
                    ${output ? `<details><summary>节点输出</summary><pre>${agentEscape(agentShortText(output, 3000))}</pre></details>` : ''}
                </div>
            ` : ''}
        </div>
    `;
}

// DAG运行结果可视化：渲染迷你状态图
function renderAgentDagRunGraph(dagNodes) {
    if (!dagNodes.length) return '';
    const NODE_W = 112, NODE_H = 34, GAP_X = 44, GAP_Y = 24, PAD = 18;
    const MIN_VIEW_W = 880, MIN_VIEW_H = 150;
    // 状态 -> 颜色映射
    const statusColor = (status) => {
        const s = String(status || 'pending').toLowerCase();
        if (s === 'completed') return { fill: '#10b981', stroke: '#059669' };
        if (s === 'error') return { fill: '#ef4444', stroke: '#dc2626' };
        if (s === 'running') return { fill: '#3b82f6', stroke: '#2563eb' };
        if (s === 'skipped') return { fill: '#f59e0b', stroke: '#d97706' };
        return { fill: '#94a3b8', stroke: '#64748b' }; // pending
    };
    // 收集所有 depends_on 引用
    const allIds = new Set(dagNodes.map(n => n.node_key));
    const depMap = new Map();
    dagNodes.forEach(n => {
        depMap.set(n.node_key, (n.depends_on || []).filter(d => allIds.has(d)));
    });
    // 拓扑分层布局
    const layers = [];
    const placed = new Set();
    while (placed.size < dagNodes.length) {
        const layer = [];
        dagNodes.forEach(n => {
            if (placed.has(n.node_key)) return;
            if ((depMap.get(n.node_key) || []).every(d => placed.has(d))) layer.push(n);
        });
        if (!layer.length) { dagNodes.filter(n => !placed.has(n.node_key)).forEach(n => layer.push(n)); }
        layer.forEach(n => placed.add(n.node_key));
        layers.push(layer);
    }
    // 计算坐标
    const positions = new Map();
    layers.forEach((layer, li) => {
        layer.forEach((node, si) => {
            positions.set(node.node_key, {
                x: PAD + li * (NODE_W + GAP_X),
                y: PAD + si * (NODE_H + GAP_Y)
            });
        });
    });
    const totalW = PAD + layers.length * (NODE_W + GAP_X) - GAP_X + PAD;
    const lastLayerHeight = Math.max(...layers.map(l => l.length), 1) * (NODE_H + GAP_Y) - GAP_Y;
    const totalH = PAD + lastLayerHeight + PAD;
    const viewW = Math.max(totalW, MIN_VIEW_W);
    const viewH = Math.max(totalH, MIN_VIEW_H);
    // 渲染边
    const edges = [];
    dagNodes.forEach(n => {
        const to = positions.get(n.node_key);
        (depMap.get(n.node_key) || []).forEach(fromId => {
            const from = positions.get(fromId);
            if (from && to) {
                const sx = from.x + NODE_W, sy = from.y + NODE_H / 2;
                const tx = to.x, ty = to.y + NODE_H / 2;
                const cx = sx + (tx - sx) / 2;
                edges.push(`<path d="M${sx},${sy} C${cx},${sy} ${cx},${ty} ${tx},${ty}" stroke="#94a3b8" stroke-width="1.5" fill="none" marker-end="url(#dag-run-arrow)"/>`);
            }
        });
    });
    // 渲染节点
    const nodes = dagNodes.map(n => {
        const pos = positions.get(n.node_key);
        const c = statusColor(n.status);
        const label = (n.title || n.node_key || '').slice(0, 12);
        return `
            <g transform="translate(${pos.x},${pos.y})">
                <rect width="${NODE_W}" height="${NODE_H}" rx="6" ry="6" fill="${c.fill}" stroke="${c.stroke}" stroke-width="1.5" opacity="0.9"/>
                <text x="${NODE_W/2}" y="${NODE_H/2 + 3}" text-anchor="middle" fill="#fff" font-size="10" font-weight="600">${agentEscape(label)}</text>
                <text x="${NODE_W/2}" y="${NODE_H - 5}" text-anchor="middle" fill="rgba(255,255,255,0.8)" font-size="7">${agentEscape(n.status || 'pending')}</text>
            </g>
        `;
    });
    return `
        <div class="agent-dag-run-graph">
            <svg viewBox="0 0 ${viewW} ${viewH}" preserveAspectRatio="xMinYMin meet" style="width:100%;max-height:220px;border:1px solid var(--border);border-radius:8px;background:#f8fafc;">
                <defs>
                    <marker id="dag-run-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
                        <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
                    </marker>
                </defs>
                ${edges.join('')}
                ${nodes.join('')}
            </svg>
            <div class="agent-dag-run-legend">
                <span class="dag-legend-completed">■ 完成</span>
                <span class="dag-legend-running">■ 运行中</span>
                <span class="dag-legend-error">■ 错误</span>
                <span class="dag-legend-skipped">■ 跳过</span>
                <span class="dag-legend-pending">■ 待执行</span>
            </div>
        </div>
    `;
}

function agentModelCapabilityMarkup(model) {
    const textIcon = '<span class="cap-icon text" title="文本模型"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h10"/></svg></span>';
    if (!model) return textIcon;
    const hasVision = Number(model.supports_vision || 0) === 1 || model.capabilities?.includes?.('vision');
    const hasReasoning = Number(model.supports_reasoning || 0) === 1 || model.capabilities?.includes?.('reasoning');
    const icons = [textIcon];
    if (hasVision) icons.push('<span class="cap-icon vision" title="支持视觉输入"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg></span>');
    if (hasReasoning) icons.push('<span class="cap-icon reasoning" title="支持推理/思考"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M9 18h6"/><path d="M10 22h4"/><path d="M15 14c.2-1 .7-1.7 1.5-2.5A5 5 0 1 0 7.5 11.5C8.3 12.3 8.8 13 9 14"/></svg></span>');
    return icons.join('');
}

function updateAgentModelCaps() {
    const select = document.getElementById('agent-model-select');
    const caps = document.getElementById('agent-selected-model-caps');
    const name = document.getElementById('agent-selected-model-name');
    if (!select || !caps || !name) return;
    const model = (window._cachedAgentModels || []).find(item => String(item.id) === String(select.value));
    name.textContent = model ? `${model.name}${model.user_id ? ' (个人)' : ''}` : '请选择模型';
    caps.innerHTML = agentModelCapabilityMarkup(model);
}

function setAgentModelListOpen(open) {
    const trigger = document.getElementById('agent-model-trigger');
    const list = document.getElementById('agent-model-list');
    if (!trigger || !list) return;
    trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
    list.classList.toggle('hidden', !open);
}

function selectAgentModel(id, close = true) {
    const select = document.getElementById('agent-model-select');
    if (!select) return;
    select.value = id;
    updateAgentModelCaps();
    document.querySelectorAll('[data-agent-model-id]').forEach(item => {
        const active = String(item.dataset.agentModelId) === String(id);
        item.classList.toggle('active', active);
        item.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    if (close) setAgentModelListOpen(false);
}

const agentToolDisplayMap = {
    'agent.llm': { title: '大模型节点', description: '在工作流中调用指定大模型，对上游结果进行分析、改写、抽取或生成内容。' },
    'rag.search': { title: '知识库检索', description: '检索当前用户的知识库，返回按相关度排序的片段和来源文档。' },
    'sessions.search': { title: '会话检索', description: '按关键词检索当前用户的历史会话内容。' },
    'sessions.recent': { title: '最近会话', description: '列出当前用户最近的未删除会话。' },
    'knowledge.list': { title: '知识库文档', description: '列出当前用户的知识库文档及索引状态。' },
    'models.list': { title: '可用模型', description: '列出当前用户可以使用的模型。' },
    'system.health': { title: '系统健康', description: '查看数据库、存储、内存和磁盘健康状态。' },
    'system.modelRuntime': { title: '模型运行状态', description: '查看模型端点队列、熔断器和监控状态。' },
    'db.list_tables': { title: '列出数据表', description: '列出当前数据库中可查询的表和视图。' },
    'db.count_tables': { title: '统计数据表数量', description: '统计当前数据库中可查询的数据表和视图数量。' },
    'db.describe_table': { title: '查看表结构', description: '查看表字段、类型和可空性。' },
    'db.run_readonly_query': { title: '只读 SQL 查询', description: '执行 SELECT/WITH/SHOW/DESCRIBE/EXPLAIN 等只读查询。' },
    'db.group_count': { title: '分组统计', description: '按指定表字段分组并统计数量。' },
    'db.list_collections': { title: '列出集合', description: '列出 MongoDB 数据库集合。' },
    'db.count_collections': { title: '统计集合数量', description: '统计 MongoDB 数据库中的集合数量。' },
    'db.sample_collection': { title: '读取集合样本', description: '读取 MongoDB 集合的小样本，辅助理解字段结构。' },
    'db.aggregate': { title: 'Mongo 聚合查询', description: '执行只读统计分析聚合管道。' }
};

function agentToolShortName(toolOrName) {
    const name = typeof toolOrName === 'string' ? toolOrName : (toolOrName?.name || toolOrName?.fullName || '');
    const match = String(name || '').match(/^mcp\.\d+\.(.+)$/);
    return match ? match[1] : String(name || '');
}

function agentToolTitle(tool) {
    const name = typeof tool === 'string' ? tool : (tool?.name || tool?.fullName);
    const shortName = agentToolShortName(tool);
    return agentToolDisplayMap[shortName]?.title || tool?.title || shortName || name || '工具';
}

function agentToolDescription(tool) {
    const shortName = agentToolShortName(tool);
    const description = agentToolDisplayMap[shortName]?.description || tool?.description || '';
    if (String(tool?.name || '').startsWith('mcp.') && tool?.serverName) {
        return `来自「${tool.serverName}」：${description || '已保存的能力服务，可由智能体任务按需调用。'}`;
    }
    return description;
}

function agentCleanCapabilityName(name) {
    return String(name || '')
        .replace(/^内置\s*/u, '')
        .replace(/^系统内置\s*/u, '')
        .replace(/\s*MCP$/iu, '')
        .trim();
}

function agentCapabilityTypeLabel(type) {
    if (type === 'builtin_tool') return '系统工具';
    if (type === 'database_connection') return '数据库连接';
    return '能力服务';
}

function isAdminOnlyAgentTool(tool) {
    return Boolean(tool?.admin) || String(tool?.name || '').startsWith('system.');
}

function agentStepTitle(step) {
    const raw = step?.title || step?.type || '';
    if (raw === 'Planning') return '规划下一步';
    if (raw.startsWith('Tool failed: ')) return `工具调用失败：${agentToolTitle(raw.replace('Tool failed: ', ''))}`;
    if (raw.startsWith('Tool: ')) return `调用工具：${agentToolTitle(raw.replace('Tool: ', ''))}`;
    if (raw.startsWith('调用工具：')) return `调用工具：${agentToolTitle(raw.replace('调用工具：', ''))}`;
    if (raw.startsWith('工具调用失败：')) return `工具调用失败：${agentToolTitle(raw.replace('工具调用失败：', ''))}`;
    return raw || '执行步骤';
}

async function loadAgentModels() {
    const loaded = typeof window.loadSelectableModels === 'function'
        ? await window.loadSelectableModels()
        : { models: [], defaultModelId: '' };
    const defaultModelId = loaded.defaultModelId || '';
    const canSelectModel = typeof window.isSelectableModelForCurrentUser === 'function'
        ? window.isSelectableModelForCurrentUser
        : (model => !model?.user_id || String(model.user_id) === String(currentUser?.id));
    const nextModels = (loaded.models || []).filter(model => model.type !== 'embedding' && canSelectModel(model));
    window._cachedAgentModels = nextModels;
    const optionHtml = nextModels
        .map(model => `<option value="${model.id}">${agentEscape(model.name)}${model.user_id ? ' (个人)' : ''}</option>`)
        .join('');
    const mainSelectedId = document.getElementById('model-selector')?.value || '';
    const initialId = (mainSelectedId && nextModels.some(model => String(model.id) === String(mainSelectedId)))
        ? mainSelectedId
        : (defaultModelId && nextModels.some(model => String(model.id) === String(defaultModelId)))
            ? defaultModelId
            : (nextModels[0]?.id || '');

    const select = document.getElementById('agent-model-select');
    if (select) {
        const previousId = select.value;
        select.innerHTML = optionHtml;
        select.value = nextModels.some(model => String(model.id) === String(previousId)) ? previousId : initialId;
    }
    const list = document.getElementById('agent-model-list');
    if (list) {
        list.innerHTML = nextModels.length ? nextModels.map(model => {
            const meta = [];
            meta.push(model.user_id ? '个人模型' : '全局模型');
            if (model.model_name && model.model_name !== model.name) meta.push(model.model_name);
            const title = typeof describeSelectorModel === 'function' ? describeSelectorModel(model, false) : model.name;
            return `
                <button type="button" role="option" class="agent-model-option" data-agent-model-id="${agentEscape(model.id)}" title="${agentEscape(title)}">
                    <span>
                        <strong>${agentEscape(model.name)}${model.user_id ? ' (个人)' : ''}</strong>
                        <small>${agentEscape(meta.join(' · '))}</small>
                    </span>
                    <span class="agent-model-caps">${agentModelCapabilityMarkup(model)}</span>
                </button>
            `;
        }).join('') : '<div class="agent-model-option is-empty">暂无可用于智能体的模型</div>';
        list.querySelectorAll('[data-agent-model-id]').forEach(item => {
            item.addEventListener('click', () => selectAgentModel(item.dataset.agentModelId));
        });
    }
    const trigger = document.getElementById('agent-model-trigger');
    if (trigger && trigger.dataset.agentModelBound !== '1') {
        trigger.dataset.agentModelBound = '1';
        trigger.addEventListener('click', (event) => {
            event.stopPropagation();
            setAgentModelListOpen(document.getElementById('agent-model-list')?.classList.contains('hidden'));
        });
        document.addEventListener('click', (event) => {
            if (!event.target.closest('#agent-model-picker')) setAgentModelListOpen(false);
        });
    }
    if (select && select.dataset.agentCapsBound !== '1') {
        select.dataset.agentCapsBound = '1';
        select.addEventListener('change', () => selectAgentModel(select.value, false));
    }
    if (select) selectAgentModel(select.value || initialId, false);
}

async function _loadAgentModelsLegacy() {
    const select = document.getElementById('agent-model-select');
    if (!select) return;
    const res = await apiFetch(`${API_BASE}/models/available`);
    if (!res.ok) throw new Error('智能体模型列表加载失败');
    const canSelectModel = typeof window.isSelectableModelForCurrentUser === 'function'
        ? window.isSelectableModelForCurrentUser
        : (model => !model?.user_id || String(model.user_id) === String(currentUser?.id));
    const nextModels = (await res.json()).filter(model => model.type !== 'embedding' && canSelectModel(model));
    window._cachedAgentModels = nextModels;
    select.innerHTML = nextModels
        .map(model => `<option value="${model.id}">${agentEscape(model.name)}${model.user_id ? ' (个人)' : ''}</option>`)
        .join('');
    const list = document.getElementById('agent-model-list');
    if (list) {
        list.innerHTML = nextModels.length ? nextModels.map(model => {
            const meta = [];
            meta.push(model.user_id ? '个人模型' : '全局模型');
            if (model.model_name && model.model_name !== model.name) meta.push(model.model_name);
            const title = typeof describeSelectorModel === 'function' ? describeSelectorModel(model, false) : model.name;
            return `
                <button type="button" role="option" class="agent-model-option" data-agent-model-id="${agentEscape(model.id)}" title="${agentEscape(title)}">
                    <span>
                        <strong>${agentEscape(model.name)}${model.user_id ? ' (个人)' : ''}</strong>
                        <small>${agentEscape(meta.join(' · '))}</small>
                    </span>
                    <span class="agent-model-caps">${agentModelCapabilityMarkup(model)}</span>
                </button>
            `;
        }).join('') : '<div class="agent-model-option is-empty">暂无可用于智能体的模型</div>';
        list.querySelectorAll('[data-agent-model-id]').forEach(item => {
            item.addEventListener('click', () => selectAgentModel(item.dataset.agentModelId));
        });
    }
    const trigger = document.getElementById('agent-model-trigger');
    if (trigger && trigger.dataset.agentModelBound !== '1') {
        trigger.dataset.agentModelBound = '1';
        trigger.addEventListener('click', (event) => {
            event.stopPropagation();
            setAgentModelListOpen(document.getElementById('agent-model-list')?.classList.contains('hidden'));
        });
        document.addEventListener('click', (event) => {
            if (!event.target.closest('#agent-model-picker')) setAgentModelListOpen(false);
        });
    }
    if (select.dataset.agentCapsBound !== '1') {
        select.dataset.agentCapsBound = '1';
        select.addEventListener('change', () => selectAgentModel(select.value, false));
    }
    if (nextModels.length && !select.value) select.value = nextModels[0].id;
    selectAgentModel(select.value || nextModels[0]?.id || '', false);
}

async function loadAgentModelRouters() {
    const select = document.getElementById('agent-model-router');
    if (!select) return;
    const current = select.value || 'fixed';
    try {
        const res = await apiFetch(`${API_BASE}/agents/model-routers`);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '模型路由加载失败');
        const strategies = Array.isArray(data.strategies) ? data.strategies : [];
        if (!strategies.length) return;
        select.innerHTML = strategies.map(strategy => `
            <option value="${agentEscape(strategy.code)}" title="${agentEscape(strategy.description || '')}">
                ${agentEscape(strategy.label || strategy.code)}
            </option>
        `).join('');
        select.value = strategies.some(strategy => String(strategy.code) === String(current)) ? current : 'fixed';
    } catch (e) {
        // 保留 HTML 中的默认策略，避免路由接口异常影响智能体工作台打开。
    }
}

async function loadAgentTools() {
    const list = document.getElementById('agent-tool-list');
    const res = await apiFetch(`${API_BASE}/agents/tools`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '工具列表加载失败');
    const seenToolKeys = new Set();
    const visibleTools = (data.tools || [])
        .filter(tool => isSuperAdminUser() || !isAdminOnlyAgentTool(tool))
        .filter(tool => {
            const key = String(tool?.name || `${tool?.source || ''}:${tool?.title || ''}:${tool?.description || ''}`);
            if (!key || seenToolKeys.has(key)) return false;
            seenToolKeys.add(key);
            return true;
        });
    agentToolsCache = visibleTools;
    if (dagEditorInstance) {
        window.refreshAgentDagEditor?.();
    } else {
        mountAgentDagEditor();
    }
    if (!list) return;
    list.innerHTML = `
        ${visibleTools.map(tool => {
            const title = agentToolTitle(tool);
            const description = agentToolDescription(tool);
            const tags = [
                isAdminOnlyAgentTool(tool) ? '管理员' : '',
                tool.source === 'mcp' ? '能力库' : '系统',
                tool.requiresApproval ? '需审批' : ''
            ].filter(Boolean);
            const tooltip = [
                title,
                description,
                tags.length ? `标签：${tags.join(' / ')}` : ''
            ].filter(Boolean).join('\n');
            return `
            <label class="agent-tool-chip agent-tool-select ${isAdminOnlyAgentTool(tool) ? 'admin-tool' : ''}" title="${agentEscape(tooltip)}">
                <input type="checkbox" data-agent-tool-allow="${agentEscape(tool.name)}" checked>
                <strong>
                    ${agentEscape(title)}
                    ${tags.map(tag => `<em>${agentEscape(tag)}</em>`).join('')}
                </strong>
                <span>${agentEscape(description)}</span>
            </label>
        `;
        }).join('') || '<div class="empty-state">暂无可用能力</div>'}
    `;
}

async function loadCapabilityPackages() {
    const list = document.getElementById('agent-capability-list');
    if (!list) return;
    const res = await apiFetch(`${API_BASE}/capabilities/packages`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '能力市场加载失败');
    capabilityPackagesCache = data.data || [];
    const visible = capabilityPackagesCache.slice(0, 12);
    list.innerHTML = visible.length ? visible.map(item => `
        <label class="agent-capability-item ${item.enabled ? 'enabled' : 'disabled'}">
            <input type="checkbox" data-capability-key="${agentEscape(item.package_key)}" ${item.enabled ? 'checked' : ''}>
            <span>
                <strong>${agentEscape(agentCleanCapabilityName(item.name))}</strong>
                <small>${agentEscape(agentCapabilityTypeLabel(item.type))}</small>
            </span>
        </label>
    `).join('') : '<div class="empty-state compact">暂无能力包</div>';
    list.querySelectorAll('[data-capability-key]').forEach(input => {
        input.addEventListener('change', async () => {
            const res = await apiFetch(`${API_BASE}/capabilities/packages/${encodeURIComponent(input.dataset.capabilityKey)}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled: input.checked })
            });
            const result = await res.json().catch(() => ({}));
            if (!res.ok) {
                input.checked = !input.checked;
                return showToast(result.error || '能力包状态更新失败', 'error');
            }
            showToast(input.checked ? '能力包已启用' : '能力包已停用', 'success');
            await loadAgentTools();
        });
    });
}

async function loadAgentRuntimeStatus() {
    const target = document.getElementById('agent-runtime-status');
    if (!target) return;
    const res = await apiFetch(`${API_BASE}/agents/runtime`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        target.innerHTML = '';
        return;
    }
    target.innerHTML = `
        <span>并发 ${Number(data.active || 0)} / ${Number(data.maxConcurrent || 0)}</span>
        <span>队列 ${Number(data.databaseQueued || data.queued || 0)}</span>
        <span>我的排队 ${Number(data.userQueued || 0)}</span>
    `;
}

async function loadAgentMetrics() {
    const target = document.getElementById('agent-metrics');
    if (!target) return;
    const res = await apiFetch(`${API_BASE}/agents/metrics?days=7`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        target.innerHTML = '';
        return;
    }
    target.innerHTML = `
        <span>7日任务 ${Number(data.total || 0)}</span>
        <span>成功率 ${Number(data.successRate || 0)}%</span>
        <span>失败 ${Number(data.error || 0)}</span>
        <span>Token ${agentEscape(formatAgentCompactCount(data.totalTokens || 0))}</span>
    `;
}

function renderAgentPreflight(data) {
    const target = document.getElementById('agent-preflight-panel');
    if (!target || !data) return;
    const statusText = data.status === 'blocked' ? '阻断' : data.status === 'warning' ? '有风险' : '可运行';
    const messages = [...(data.blockers || []), ...(data.warnings || []), ...(data.recommendations || [])].slice(0, 5);
    const summary = data.summary || {};
    target.className = `workspace-governance-panel agent-preflight-panel ${agentEscape(data.status || 'ready')}`;
    target.innerHTML = `
        <div class="governance-head">
            <strong>任务预检：${agentEscape(statusText)}</strong>
            <span>工具 ${Number(summary.toolCount || 0)} · 能力库 ${Number(summary.mcpToolCount || 0)} · 知识分块 ${Number(summary.knowledgeChunks || 0)}</span>
        </div>
        <div class="governance-list">
            ${messages.map(item => `<span>${agentEscape(item)}</span>`).join('') || '<span>预检通过。</span>'}
        </div>
    `;
}

async function preflightAgentPayload(payload) {
    const target = document.getElementById('agent-preflight-panel');
    if (target) {
        target.className = 'workspace-governance-panel agent-preflight-panel';
        target.innerHTML = '<div class="governance-head"><strong>任务预检中...</strong></div>';
    }
    const res = await apiFetch(`${API_BASE}/agents/preflight`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '任务预检失败');
    renderAgentPreflight(data);
    return data;
}

function renderAgentRunsPagination(page = agentRunsPage, total = agentRunsTotal, limit = AGENT_RUNS_PAGE_SIZE) {
    window.renderWorkspacePagination?.('pagination-agentRuns', {
        total,
        page,
        limit,
        onPageChange: targetPage => loadAgentRuns(targetPage).catch(err => showToast(err.message || '任务列表刷新失败', 'error'))
    });
}

async function loadAgentRuns(page = agentRunsPage) {
    const list = document.getElementById('agent-runs-list');
    if (!list) return;
    const status = document.getElementById('agent-filter-status')?.value || '';
    const query = document.getElementById('agent-filter-query')?.value.trim() || '';
    agentRunsPage = Math.max(Number(page) || 1, 1);
    const params = new URLSearchParams({
        page: String(agentRunsPage),
        limit: String(AGENT_RUNS_PAGE_SIZE)
    });
    if (status) params.set('status', status);
    if (query) params.set('query', query);
    const res = await apiFetch(`${API_BASE}/agents/runs?${params.toString()}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '任务列表加载失败');
    agentRunsCache = data.data || [];
    agentRunsTotal = Number(data.total || agentRunsCache.length || 0);
    agentRunsPage = Number(data.page || agentRunsPage);
    const pageSize = Number(data.limit || AGENT_RUNS_PAGE_SIZE);
    if (agentRunsCache.length === 0 && agentRunsTotal > 0 && agentRunsPage > 1) {
        const lastPage = Math.max(Math.ceil(agentRunsTotal / pageSize), 1);
        return loadAgentRuns(Math.min(agentRunsPage - 1, lastPage));
    }
    updateAgentAutoRefresh();
    renderAgentRunsPagination(agentRunsPage, agentRunsTotal, pageSize);
    const displayRuns = agentRunsCache;
    if (agentRunsTotal === 0 && !status && !query) {
        list.innerHTML = '';
        activeAgentRunId = '';
        closeAgentRunDetailModal();
        list.innerHTML = `
            <div class="agent-empty-state agent-empty-hero">
                <strong>还没有智能体任务</strong>
                <span>在左侧输入目标并点击运行后，这里会显示任务记录。点击详情可查看执行步骤和最终结果。</span>
            </div>
        `;
        return;
    }
    if (displayRuns.length === 0) {
        list.innerHTML = '<div class="empty-state agent-empty-state">没有匹配的任务记录。</div>';
        return;
    }
    const hasSelectedRun = activeAgentRunId && displayRuns.some(run => run.id === activeAgentRunId);
    if (!hasSelectedRun && !isAgentRunDetailModalOpen()) activeAgentRunId = '';
    list.innerHTML = `
        <div class="agent-runs-table-wrap">
            <table class="data-table agent-runs-table">
                <thead>
                    <tr>
                        <th class="text-center">序号</th>
                        <th>任务</th>
                        <th>模型</th>
                        <th>模式</th>
                        <th>步骤</th>
                        <th>工具</th>
                        <th>错误</th>
                        <th>输入Token</th>
                        <th>输出Token</th>
                        <th>总Token</th>
                        <th>创建时间</th>
                        <th>状态</th>
                        <th>操作</th>
                    </tr>
                </thead>
                <tbody>
                    ${displayRuns.map((run, index) => {
        const title = agentDisplayTitle(run);
        const mode = agentRunModeLabel(run.run_mode);
        const tokenTotal = Number(run.total_tokens || 0);
        const inputTokens = Number(run.input_tokens || 0);
        const outputTokens = Number(run.output_tokens || 0);
        const stepCount = Number(run.step_count || 0);
        const toolCount = Number(run.tool_count || 0);
        const errorCount = Number(run.error_count || 0);
        const canDelete = !isAgentRunActive(run.status);
        const taskTooltip = buildAgentRunTaskTooltip(run, title, mode, { stepCount, toolCount, errorCount });
        return `
            <tr class="${run.id === activeAgentRunId ? 'active' : ''}" data-agent-run-id="${agentEscape(run.id)}">
                <td class="text-center">${(agentRunsPage - 1) * pageSize + index + 1}</td>
                <td class="agent-runs-title-cell">
                    <strong tabindex="0" aria-label="${agentEscapeAttr(taskTooltip)}" data-agent-run-title-full="${agentEscapeAttr(taskTooltip)}">${agentEscape(title)}</strong>
                </td>
                <td>
                    <strong class="agent-runs-compact">${agentEscape(run.model_name || '-')}</strong>
                </td>
                <td>${agentEscape(mode)}</td>
                <td>${stepCount || '-'}</td>
                <td>${toolCount}</td>
                <td>${errorCount}</td>
                <td>${inputTokens ? agentEscape(formatAgentCompactCount(inputTokens)) : '-'}</td>
                <td>${outputTokens ? agentEscape(formatAgentCompactCount(outputTokens)) : '-'}</td>
                <td>${tokenTotal ? agentEscape(formatAgentCompactCount(tokenTotal)) : '-'}</td>
                <td>${agentEscape(formatDateToCN(run.created_at))}</td>
                <td>
                    <span class="agent-run-status ${agentEscape(run.status)}">${agentStatusLabel(run.status)}</span>
                </td>
                <td>
                    <div class="agent-run-table-actions">
                        <button class="btn-secondary agent-run-detail-btn" type="button" data-agent-run-detail="${agentEscape(run.id)}">详情</button>
                        ${canDelete ? `<button class="btn-danger-outline agent-run-delete-btn" type="button" data-agent-run-delete="${agentEscape(run.id)}">删除</button>` : ''}
                    </div>
                </td>
            </tr>
    `;
    }).join('')}
                </tbody>
            </table>
        </div>
    `;
    list.querySelectorAll('[data-agent-run-detail]').forEach(btn => {
        btn.addEventListener('click', () => window.openAgentRun(btn.dataset.agentRunDetail));
    });
    list.querySelectorAll('[data-agent-run-delete]').forEach(btn => {
        btn.addEventListener('click', () => window.deleteAgentRun(btn.dataset.agentRunDelete));
    });
    bindAgentRunTitleTooltip(list);
}

function bindAgentRunTitleTooltip(list = document.getElementById('agent-runs-list')) {
    if (!list || list.dataset.boundAgentRunTitleTooltip === '1') return;
    list.dataset.boundAgentRunTitleTooltip = '1';
    const getTarget = event => event.target.closest?.('[data-agent-run-title-full]');
    list.addEventListener('mouseover', event => {
        const target = getTarget(event);
        if (target) showAgentRunTitleTooltip(target);
    });
    list.addEventListener('mousemove', event => {
        const target = getTarget(event);
        if (target && target === agentRunTitleTooltipTarget) positionAgentRunTitleTooltip(target);
    });
    list.addEventListener('mouseout', event => {
        const target = getTarget(event);
        if (target && !target.contains(event.relatedTarget)) hideAgentRunTitleTooltip(target);
    });
    list.addEventListener('focusin', event => {
        const target = getTarget(event);
        if (target) showAgentRunTitleTooltip(target);
    });
    list.addEventListener('focusout', event => {
        const target = getTarget(event);
        if (target) hideAgentRunTitleTooltip(target);
    });
    list.addEventListener('scroll', () => {
        if (agentRunTitleTooltipTarget?.isConnected) positionAgentRunTitleTooltip(agentRunTitleTooltipTarget);
    });
    window.addEventListener('resize', () => hideAgentRunTitleTooltip());
}

function isAgentRunDetailModalOpen() {
    return !document.getElementById('agent-run-detail-modal')?.classList.contains('hidden');
}

function agentRunMetadata(run = {}) {
    const metadata = run?.metadata || {};
    if (metadata && typeof metadata === 'object') return metadata;
    if (typeof metadata !== 'string') return {};
    try {
        const parsed = JSON.parse(metadata);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (e) {
        return {};
    }
}

function isAgentWorkflowPreviewRun(run = {}, options = {}) {
    if (options.workflowPreview) return true;
    const metadata = agentRunMetadata(run);
    return String(metadata.workflowRunSource || metadata.workflow_run_source || metadata.runSource || '').toLowerCase() === 'preview';
}

function ensureAgentRunDetailModalVisible() {
    const modal = document.getElementById('agent-run-detail-modal');
    if (modal && modal.parentElement !== document.body) document.body.appendChild(modal);
    return modal;
}

function closeAgentRunDetailModal() {
    const modal = document.getElementById('agent-run-detail-modal');
    const detail = document.getElementById('agent-run-detail');
    const closingPreview = activeAgentRunId === activeAgentWorkflowPreviewRunId;
    modal?.classList.add('hidden');
    if (detail) detail.innerHTML = '';
    document.querySelectorAll('[data-agent-run-id]').forEach(row => row.classList.remove('active'));
    if (closingPreview) {
        stopAgentWorkflowPreviewPolling();
        activeAgentWorkflowPreviewRunId = '';
    }
    activeAgentRunId = '';
}

window.closeAgentRunDetailModal = closeAgentRunDetailModal;

window.openAgentRun = async function(runId, options = {}) {
    activeAgentRunId = runId;
    const modal = ensureAgentRunDetailModalVisible();
    const detail = document.getElementById('agent-run-detail');
    if (!detail) return null;
    document.querySelectorAll('[data-agent-run-id]').forEach(row => {
        const active = row.dataset.agentRunId === runId;
        row.classList.toggle('active', active);
    });
    modal?.classList.remove('hidden');
    if (!options.silent) detail.innerHTML = '<div class="empty-state agent-empty-state">正在加载任务详情...</div>';
    const res = await apiFetch(`${API_BASE}/agents/runs/${encodeURIComponent(runId)}`);
    const data = await res.json();
    if (!res.ok) {
        detail.innerHTML = `<div class="empty-state agent-empty-state">${agentEscape(data.error || '加载失败')}</div>`;
        return null;
    }
    const run = data.run;
    const isPreview = isAgentWorkflowPreviewRun(run, options);
    const steps = data.steps || [];
    const dagNodes = agentSortDagNodesForDisplay(data.dagNodes || []);
    const progress = data.progress || {};
    const canCancel = isAgentRunActive(run.status);
    const canRerun = !isPreview && !isAgentRunActive(run.status);
    const canApprove = !isPreview && run.status === 'approval_required';
    const tokenUsage = formatAgentTokenUsage(run);
    const progressPercent = Math.max(0, Math.min(Number(progress.percent || 0), 100));
    const progressLabel = agentProgressLabel(run, progress);
    if (isPreview) {
        run.title = agentPreviewDisplayTitle(agentDisplayTitle(run));
        run.final_answer = stripAgentWorkflowReportHeading(run.final_answer);
    }
    const visualOutputs = renderAgentRunVisualOutputs(dagNodes, steps, run.final_answer, run.status);
    const title = document.getElementById('agent-run-detail-title');
    if (title) title.textContent = isPreview ? `预览运行：${agentPreviewDisplayTitle(agentDisplayTitle(run))}` : agentDisplayTitle(run);
    detail.innerHTML = `
        <div class="agent-progress-summary">
            <div class="agent-progress-bar"><span style="width: ${progressPercent}%"></span></div>
            <div class="agent-progress-meta">
                <span>${agentEscape(progressLabel)}</span>
                <span>工具 ${Number(progress.toolCount || 0)}</span>
                <span>错误 ${Number(progress.errorCount || 0)}</span>
                <span>耗时 ${Number(progress.totalDurationMs || 0)} 毫秒</span>
                <span>${agentEscape(agentRunModeLabel(run.run_mode))}</span>
                <span>${agentEscape(agentToolPolicyLabel(run.tool_policy))}</span>
                ${tokenUsage ? `<span>${agentEscape(tokenUsage)}</span>` : ''}
                ${canCancel ? `<button class="btn-danger-outline" data-agent-cancel="${agentEscape(run.id)}">停止</button>` : ''}
                ${canApprove ? `<button class="btn-primary" data-agent-approve="${agentEscape(run.id)}">批准工具</button><button class="btn-danger-outline" data-agent-reject="${agentEscape(run.id)}">拒绝</button>` : ''}
                ${canRerun ? `<button class="btn-secondary" data-agent-rerun="${agentEscape(run.id)}">重新运行</button>` : ''}
                ${canRerun ? `<button class="btn-secondary" data-agent-resume="${agentEscape(run.id)}">断点续跑</button>` : ''}
                ${!isPreview && (run.final_answer || run.error_message) ? `<button class="btn-secondary" data-agent-save-artifact="${agentEscape(run.id)}">保存结果</button>` : ''}
                ${!isPreview ? `<button class="btn-secondary" data-agent-export-md="${agentEscape(run.id)}">导出</button>` : ''}
            </div>
        </div>
        ${run.final_answer ? `<div class="agent-final">${renderMarkdown(normalizeAgentMarkdown(run.final_answer))}</div>` : ''}
        ${run.error_message ? `<div class="error-detail">${agentEscape(run.error_message)}</div>` : ''}
        ${visualOutputs}
        ${dagNodes.length ? `
            <div class="agent-dag-list">
                <div class="agent-tool-section-head compact">
                    <strong>工作流节点</strong>
                    <span>${dagNodes.length} 个节点</span>
                </div>
                ${renderAgentDagRunGraph(dagNodes)}
                ${dagNodes.map(node => agentDagNodeMarkup(node)).join('')}
            </div>
        ` : ''}
        ${buildAgentToolStatsMarkup(steps)}
        <div class="agent-step-list">
            ${steps.map(step => agentStepMarkup(step)).join('') || '<div class="empty-state agent-empty-state">任务还没有执行步骤。</div>'}
        </div>
    `;
    detail.querySelector('[data-agent-cancel]')?.addEventListener('click', () => {
        if (isPreview) return window.cancelAgentWorkflowPreviewRun(run.id);
        return window.cancelAgentRun(run.id);
    });
    detail.querySelector('[data-agent-approve]')?.addEventListener('click', () => window.approveAgentRun(run.id, true));
    detail.querySelector('[data-agent-reject]')?.addEventListener('click', () => window.approveAgentRun(run.id, false));
    detail.querySelector('[data-agent-rerun]')?.addEventListener('click', () => window.rerunAgentRun(run.id));
    detail.querySelector('[data-agent-resume]')?.addEventListener('click', () => window.resumeAgentRun(run.id));
    detail.querySelectorAll('[data-agent-dag-rerun-node]').forEach(btn => {
        btn.addEventListener('click', () => window.rerunAgentDagNode(run.id, btn.dataset.agentDagRerunNode || ''));
    });
    detail.querySelector('[data-agent-save-artifact]')?.addEventListener('click', () => window.saveAgentArtifact(run.id));
    detail.querySelector('[data-agent-export-md]')?.addEventListener('click', () => agentDownload(`${API_BASE}/agents/runs/${encodeURIComponent(run.id)}/export?format=markdown`));
    window.renderPivotCharts?.(detail);
    return run;
};

function stopAgentWorkflowPreviewPolling() {
    if (agentWorkflowPreviewTimer) {
        clearInterval(agentWorkflowPreviewTimer);
        agentWorkflowPreviewTimer = null;
    }
}

function startAgentWorkflowPreviewPolling(runId) {
    stopAgentWorkflowPreviewPolling();
    activeAgentWorkflowPreviewRunId = runId;
    agentWorkflowPreviewTimer = setInterval(async () => {
        if (activeAgentWorkflowPreviewRunId !== runId || activeAgentRunId !== runId || !isAgentRunDetailModalOpen()) {
            stopAgentWorkflowPreviewPolling();
            return;
        }
        try {
            const run = await window.openAgentRun(runId, { workflowPreview: true, silent: true });
            if (run && !isAgentRunActive(run.status)) stopAgentWorkflowPreviewPolling();
        } catch (e) {}
    }, 3000);
}

function ensureAgentAuditModal() {
    let modal = document.getElementById('agent-audit-modal');
    if (modal) return modal;
    modal = document.createElement('div');
    modal.id = 'agent-audit-modal';
    modal.className = 'modal-overlay hidden rag-detail-modal-overlay';
    modal.innerHTML = `
        <div class="modal rag-detail-modal agent-audit-modal">
            <div class="rag-detail-header">
                <div>
                    <h3>智能体删除审计</h3>
                    <p class="model-modal-desc">仅 admin 权限层级可查看，普通用户移除的任务记录会保留在这里。</p>
                </div>
                <button type="button" id="agent-audit-close-btn" class="btn-danger-outline">关闭</button>
            </div>
            <div class="table-container rag-audit-table-wrap agent-audit-table-wrap">
                <table class="data-table compact-table">
                    <thead>
                        <tr>
                            <th style="width: 52px;" class="text-center">序号</th>
                            <th>任务</th>
                            <th style="width: 120px;">用户</th>
                            <th style="width: 90px;">状态</th>
                            <th style="width: 150px;">模型</th>
                            <th style="width: 115px;">统计</th>
                            <th style="width: 155px;">删除时间</th>
                            <th style="width: 120px;">删除人</th>
                        </tr>
                    </thead>
                    <tbody id="agent-audit-body"></tbody>
                </table>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    modal.addEventListener('click', (event) => {
        if (event.target === modal || event.target.closest('#agent-audit-close-btn')) {
            modal.classList.add('hidden');
        }
    });
    return modal;
}

function renderAgentAuditRows(items = []) {
    if (!items.length) {
        return '<tr><td colspan="8" class="text-center muted-text">暂无已移除的智能体任务记录</td></tr>';
    }
    return items.map((item, index) => {
        const userName = item.nickname || item.username || `用户 ${item.user_id || '-'}`;
        const deletedBy = item.deleted_by_nickname || item.deleted_by_username || `用户 ${item.deleted_by_user || '-'}`;
        const stats = `步骤 ${Number(item.step_count || 0)} / 工具 ${Number(item.tool_count || 0)} / 错误 ${Number(item.error_count || 0)}`;
        return `
            <tr>
                <td class="text-center">${index + 1}</td>
                <td title="${agentEscape(item.goal || item.title)}">
                    <strong>${agentEscape(agentDisplayTitle(item) || '-')}</strong>
                    <small>${agentEscape(agentShortText(item.goal || '', 90))}</small>
                </td>
                <td>${agentEscape(userName)}</td>
                <td>${agentEscape(agentStatusLabel(item.status))}</td>
                <td title="${agentEscape(item.model_name || '')}">${agentEscape(item.model_name || '-')}</td>
                <td>${agentEscape(stats)}</td>
                <td>${agentEscape(formatAgentAuditDate(item.deleted_at))}</td>
                <td>${agentEscape(deletedBy)}</td>
            </tr>
        `;
    }).join('');
}

function updateAgentAutoRefresh() {
    const modalOpen = !document.getElementById('agent-workbench-modal')?.classList.contains('hidden');
    const hasActiveRun = agentRunsCache.some(run => isAgentRunActive(run.status));
    if (agentRealtimeConnected) {
        if (agentRefreshTimer) {
            clearInterval(agentRefreshTimer);
            agentRefreshTimer = null;
        }
        return;
    }
    if (agentRefreshTimer && (!modalOpen || !hasActiveRun)) {
        clearInterval(agentRefreshTimer);
        agentRefreshTimer = null;
    }
    if (!agentRefreshTimer && modalOpen && hasActiveRun) {
        agentRefreshTimer = setInterval(async () => {
            try {
                await loadAgentRuns();
                await loadAgentRuntimeStatus();
                await loadAgentMetrics();
                if (activeAgentRunId && isAgentRunDetailModalOpen()) await window.openAgentRun(activeAgentRunId);
            } catch (e) {}
        }, 3000);
    }
}

function scheduleAgentRealtimeRefresh(payload = {}) {
    clearTimeout(agentRealtimeRefreshTimer);
    agentRealtimeRefreshTimer = setTimeout(async () => {
        try {
            const modalOpen = !document.getElementById('agent-workbench-modal')?.classList.contains('hidden');
            if (!modalOpen) return;
            await Promise.all([
                loadAgentRuns(),
                loadAgentRuntimeStatus(),
                loadAgentNotifications()
            ]);
            if (payload.type === 'agent.run') await loadAgentMetrics();
            const runId = payload.run?.id || payload.notification?.run_id || '';
            if (activeAgentRunId && isAgentRunDetailModalOpen() && (!runId || runId === activeAgentRunId)) {
                await window.openAgentRun(activeAgentRunId);
            }
        } catch (e) {}
    }, 300);
}

function handleAgentRealtimeEvent(event) {
    const payload = JSON.parse(event.data || '{}');
    if (payload.type === 'agent.notification' && payload.notification?.status === 'unread') {
        showToast(agentNotificationTitle(payload.notification) || '收到新的智能体通知', 'info');
    }
    scheduleAgentRealtimeRefresh(payload);
}

window.initAgentRealtime = function() {
    if (agentRealtimeSource || !window.EventSource || !currentUser) return;
    agentRealtimeSource = new EventSource(`${API_BASE}/events`, { withCredentials: true });
    agentRealtimeSource.addEventListener('connected', () => {
        agentRealtimeConnected = true;
        updateAgentAutoRefresh();
    });
    agentRealtimeSource.addEventListener('agent.run', handleAgentRealtimeEvent);
    agentRealtimeSource.addEventListener('agent.notification', handleAgentRealtimeEvent);
    agentRealtimeSource.addEventListener('agent.streaming', handleAgentStreamingEvent);
    agentRealtimeSource.onerror = () => {
        agentRealtimeConnected = false;
        updateAgentAutoRefresh();
    };
};

// v0.0.52 流式 function calling 实时演示：把累加器快照渲染到任务详情面板
function handleAgentStreamingEvent(event) {
    let payload;
    try { payload = JSON.parse(event.data || '{}'); } catch (e) { return; }
    if (!payload || !payload.runId) return;
    // 只为当前打开的任务渲染，避免后台任务覆盖前台 UI
    if (activeAgentRunId !== payload.runId) return;
    renderAgentStreamingPanel(payload);
}

function renderAgentStreamingPanel(payload) {
    const container = document.getElementById('agent-run-detail');
    if (!container) return;
    let panel = container.querySelector('.agent-streaming-panel');
    if (!panel) {
        panel = document.createElement('section');
        panel.className = 'agent-streaming-panel';
        container.insertBefore(panel, container.firstChild || null);
    }
    const step = Number(payload.step) || 0;
    const finish = payload.finishReason ? agentEscape(payload.finishReason) : '—';
    const completed = Boolean(payload.completed);
    const content = String(payload.content || '');
    const partial = Array.isArray(payload.partialToolCalls) ? payload.partialToolCalls : [];
    const toolHtml = partial.length === 0
        ? '<div class="agent-streaming-empty">尚未发现工具调用增量</div>'
        : partial.map((call, idx) => {
            const name = agentEscape(call.name || `工具#${idx + 1}`);
            const argsLen = String(call.argumentsRaw || '').length;
            const preview = agentEscape(String(call.argumentsRaw || '').slice(0, 240));
            return `
                <div class="agent-streaming-tool">
                    <div class="agent-streaming-tool-head"><strong>${name}</strong><span>arguments ${argsLen} 字符</span></div>
                    <pre class="agent-streaming-tool-args">${preview}${argsLen > 240 ? '…' : ''}</pre>
                </div>
            `;
        }).join('');
    panel.innerHTML = `
        <header class="agent-streaming-head">
            <strong>流式生成（实验）</strong>
            <span>第 ${step} 步 · finish_reason: ${finish}${completed ? ' · 已完成' : ''}</span>
        </header>
        <div class="agent-streaming-body">
            <div class="agent-streaming-content">${agentEscape(content) || '<em>等待第一个 token…</em>'}</div>
            <div class="agent-streaming-tools">${toolHtml}</div>
        </div>
    `;
    // 任务终态时延迟收起面板：5s 后淡出，避免长期占据视野
    if (completed && payload.finishReason && payload.finishReason !== 'tool_calls') {
        setTimeout(() => panel?.classList.add('is-fading'), 5000);
    } else {
        panel.classList.remove('is-fading');
    }
}

window.closeAgentRealtime = function() {
    if (agentRealtimeRefreshTimer) clearTimeout(agentRealtimeRefreshTimer);
    agentRealtimeRefreshTimer = null;
    agentRealtimeConnected = false;
    if (agentRealtimeSource) {
        agentRealtimeSource.close();
        agentRealtimeSource = null;
    }
    updateAgentAutoRefresh();
};

function getSelectedAgentToolAllowlist() {
    const checked = [...document.querySelectorAll('[data-agent-tool-allow]:checked')].map(input => input.dataset.agentToolAllow);
    if (!checked.length) return ['__none__'];
    if (checked.length === agentToolsCache.length) return [];
    return checked;
}

function getAgentContextConfig() {
    return {
        mode: document.getElementById('agent-context-mode')?.value || 'auto',
        notes: document.getElementById('agent-context-notes')?.value || ''
    };
}

function getAgentWorkflowText() {
    return document.getElementById('agent-dag-spec')?.value.trim() || '';
}

function parseAgentWorkflowText(raw = getAgentWorkflowText()) {
    if (raw == null || raw === '') return { nodes: [] };
    if (typeof raw === 'string') {
        const text = raw.trim();
        if (!text) return { nodes: [] };
        return JSON.parse(text);
    }
    if (Array.isArray(raw)) return { nodes: raw };
    if (typeof raw === 'object') return raw;
    throw new Error('Invalid workflow JSON payload.');
}

function summarizeAgentDagSpec(raw = getAgentWorkflowText()) {
    try {
        const parsed = parseAgentWorkflowText(raw);
        const spec = Array.isArray(parsed) ? { nodes: parsed } : (parsed && typeof parsed === 'object' ? parsed : { nodes: [] });
        const nodes = Array.isArray(spec.nodes) ? spec.nodes : [];
        const executableNodes = nodes.filter(node => String(node?.tool || '').trim());
        return {
            valid: true,
            spec: { ...spec, nodes },
            nodeCount: nodes.length,
            executableNodeCount: executableNodes.length
        };
    } catch (e) {
        return {
            valid: false,
            spec: { nodes: [] },
            nodeCount: 0,
            executableNodeCount: 0,
            error: e
        };
    }
}

function updateAgentWorkflowRunUi() {
    renderAgentWorkflowLifecycle();
    refreshAgentDagInputsPanel();
}

function workflowLifecycleChip(label, value, state = '') {
    return `
        <span class="agent-workflow-lifecycle-chip ${state}">
            <strong>${agentEscape(label)}</strong>
            <em>${agentEscape(value)}</em>
        </span>
    `;
}

function renderAgentWorkflowLifecycle() {
    const target = document.getElementById('agent-workflow-lifecycle');
    if (!target) return;
    const workflow = selectedAgentWorkflow();
    const draftSummary = summarizeAgentDagSpec();
    const savedSummary = workflow ? summarizeAgentDagSpec(workflow.dag_spec || { nodes: [] }) : null;
    const draftMatchesSaved = workflow ? currentWorkflowMatchesSelected(workflow) : false;
    const currentText = workflow
        ? `v${workflow.current_version || 1}`
        : '未保存';
    const publishedText = workflow?.published_version
        ? `v${workflow.published_version}`
        : '未发布';
    const draftText = draftSummary.valid
        ? `${draftSummary.executableNodeCount || savedSummary?.executableNodeCount || 0} 节点 · ${workflow ? (draftMatchesSaved ? '已同步' : '未保存') : '草稿'}`
        : '需修正';
    const runText = workflow?.published_version
        ? '草稿/发布版'
        : '仅草稿';
    if (target) {
        target.innerHTML = [
            workflowLifecycleChip('草稿', draftText, draftMatchesSaved ? '' : 'is-draft'),
            workflowLifecycleChip('当前', currentText, workflow ? 'is-ready' : ''),
            workflowLifecycleChip('发布', publishedText, workflow?.published_version ? 'is-ready' : 'is-draft'),
            workflowLifecycleChip('运行', runText, workflow?.published_version ? 'is-ready' : '')
        ].join('');
    }
}

function writeAgentWorkflowText(value) {
    const textarea = document.getElementById('agent-dag-spec');
    if (!textarea) return;
    textarea.value = typeof value === 'string' ? value : JSON.stringify(value || { nodes: [] }, null, 2);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    updateAgentWorkflowRunUi();
}

function openAgentDagJsonModal() {
    const modal = document.getElementById('agent-dag-json-modal');
    const textarea = document.getElementById('agent-dag-spec');
    if (!modal || !textarea) return;
    modal.classList.remove('hidden');
    textarea.focus();
}

function closeAgentDagJsonModal() {
    document.getElementById('agent-dag-json-modal')?.classList.add('hidden');
}

function syncAgentDagJsonToCanvas() {
    if (dagEditorInstance?.syncFromJson?.()) {
        updateAgentWorkflowRunUi();
        showToast('JSON 已同步到画布', 'success');
        closeAgentDagJsonModal();
    }
}

function updateAgentDagNodeDrawer(node) {
    const drawer = document.getElementById('agent-dag-node-drawer');
    const title = document.getElementById('agent-dag-node-drawer-title');
    const subtitle = document.getElementById('agent-dag-node-drawer-subtitle');
    if (!drawer) return;
    const isOpen = Boolean(node);
    drawer.classList.toggle('hidden', !isOpen);
    drawer.setAttribute('aria-hidden', isOpen ? 'false' : 'true');
    if (title) title.textContent = node?.title || node?.id || '节点配置';
    if (subtitle) subtitle.textContent = node ? `${node.id}${node.tool ? ` · ${node.tool}` : ''}` : '';
}

function closeAgentDagNodeDrawer() {
    dagEditorInstance?.clearSelection?.();
    updateAgentDagNodeDrawer(null);
}

function deleteSelectedAgentDagNode() {
    dagEditorInstance?.deleteSelectedNode?.();
}

function agentWorkflowNodeCount(item) {
    const fromRow = Number(item?.node_count || 0);
    if (fromRow > 0) return fromRow;
    const nodes = Array.isArray(item?.dag_spec?.nodes) ? item.dag_spec.nodes : [];
    return nodes.length;
}

function agentWorkflowVersionText(item) {
    const currentVersion = Number(item?.current_version || 0);
    const publishedVersion = Number(item?.published_version || 0);
    const parts = [];
    if (currentVersion > 0) parts.push(`v${currentVersion}`);
    parts.push(`${agentWorkflowNodeCount(item)} 节点`);
    parts.push(publishedVersion > 0 ? `已发布 v${publishedVersion}` : '未发布');
    return parts.join(' · ');
}

function agentWorkflowUpdatedText(item) {
    const value = item?.updated_at || item?.version_created_at || item?.created_at || '';
    if (!value) return '';
    return typeof formatDateToCN === 'function' ? formatDateToCN(value) : String(value);
}

function agentWorkflowPickerOptionMarkup(item, selectedId) {
    const id = String(item?.id || '');
    const selected = id && String(selectedId || '') === id;
    const updatedText = agentWorkflowUpdatedText(item);
    const searchable = [
        item?.name,
        item?.description,
        agentWorkflowVersionText(item),
        updatedText
    ].filter(Boolean).join(' ');
    return `
        <button type="button" role="option" class="agent-workflow-picker-option ${selected ? 'is-selected' : ''}" data-agent-workflow-picker-id="${agentEscapeAttr(id)}" data-search-text="${agentEscapeAttr(searchable)}" aria-selected="${selected ? 'true' : 'false'}">
            <span class="agent-workflow-picker-option-main">
                <strong>${agentEscape(item?.name || '未命名工作流')}</strong>
                ${item?.description ? `<small>${agentEscape(agentShortText(item.description, 82))}</small>` : ''}
            </span>
            <span class="agent-workflow-picker-option-side">
                <em>${agentEscape(agentWorkflowVersionText(item))}</em>
                ${updatedText ? `<small>${agentEscape(updatedText)}</small>` : ''}
            </span>
        </button>
    `;
}

function setAgentWorkflowPickerOpen(isOpen, options = {}) {
    const picker = document.getElementById('agent-workflow-picker');
    const trigger = document.getElementById('agent-workflow-picker-trigger');
    const menu = document.getElementById('agent-workflow-picker-menu');
    const search = document.getElementById('agent-workflow-picker-search');
    if (!picker || !trigger || !menu) return;
    picker.classList.toggle('is-open', Boolean(isOpen));
    menu.classList.toggle('hidden', !isOpen);
    trigger.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    if (isOpen && options.focusSearch !== false) {
        requestAnimationFrame(() => {
            search?.focus();
            search?.select();
        });
    }
}

function selectAgentWorkflowFromPicker(workflowId) {
    const select = document.getElementById('agent-workflow-select');
    if (!select) return;
    select.value = String(workflowId || '');
    select.dispatchEvent(new Event('change', { bubbles: true }));
    setAgentWorkflowPickerOpen(false);
}

function renderAgentWorkflowPicker() {
    const picker = document.getElementById('agent-workflow-picker');
    const trigger = document.getElementById('agent-workflow-picker-trigger');
    const title = document.getElementById('agent-workflow-picker-title');
    const meta = document.getElementById('agent-workflow-picker-meta');
    const list = document.getElementById('agent-workflow-picker-list');
    const search = document.getElementById('agent-workflow-picker-search');
    if (!picker || !trigger || !title || !meta || !list) return;
    const selected = selectedAgentWorkflow();
    const query = String(agentWorkflowPickerQuery || '').trim().toLowerCase();
    const filtered = query
        ? agentWorkflowsCache.filter(item => {
            const text = [
                item?.name,
                item?.description,
                agentWorkflowVersionText(item),
                agentWorkflowUpdatedText(item)
            ].filter(Boolean).join(' ').toLowerCase();
            return text.includes(query);
        })
        : agentWorkflowsCache;
    picker.classList.toggle('is-empty', !agentWorkflowsCache.length);
    title.textContent = selected?.name || '选择已保存工作流';
    trigger.title = selected?.name
        ? `${selected.name} · ${agentWorkflowVersionText(selected)}`
        : '选择已保存工作流';
    meta.textContent = selected
        ? agentWorkflowVersionText(selected)
        : (agentWorkflowsCache.length ? `${agentWorkflowsCache.length} 个可用 · 支持搜索筛选` : '暂无已保存工作流');
    if (search && search.value !== agentWorkflowPickerQuery) search.value = agentWorkflowPickerQuery;
    if (!agentWorkflowsCache.length) {
        list.innerHTML = '<div class="agent-workflow-picker-empty">保存当前画布后，会在这里选择、搜索和加载工作流。</div>';
        return;
    }
    if (!filtered.length) {
        list.innerHTML = `<div class="agent-workflow-picker-empty">没有匹配“${agentEscape(agentWorkflowPickerQuery)}”的工作流</div>`;
        return;
    }
    list.innerHTML = filtered.map(item => agentWorkflowPickerOptionMarkup(item, activeAgentWorkflowId)).join('');
    list.querySelectorAll('[data-agent-workflow-picker-id]').forEach(option => {
        option.addEventListener('click', () => selectAgentWorkflowFromPicker(option.dataset.agentWorkflowPickerId));
    });
}

function renderAgentWorkflowLibrary() {
    const select = document.getElementById('agent-workflow-select');
    const currentLabel = document.getElementById('agent-workflow-current-label');
    const current = activeAgentWorkflowId || '';
    const editorOptions = [
        '<option value="">选择已保存工作流</option>',
        ...agentWorkflowsCache.map(item => {
            const version = item.current_version ? ` v${item.current_version}` : '';
            return `<option value="${agentEscape(item.id)}">${agentEscape(item.name)}${agentEscape(version)}</option>`;
        })
    ].join('');
    const nextValue = agentWorkflowsCache.some(item => String(item.id) === String(current)) ? String(current) : '';
    if (select) {
        select.innerHTML = editorOptions;
        select.value = nextValue;
    }
    activeAgentWorkflowId = nextValue;
    const selected = agentWorkflowsCache.find(item => String(item.id) === String(nextValue));
    if (selected) {
        agentWorkflowDraftName = selected.name || agentWorkflowDraftName;
        agentWorkflowDraftDescription = selected.description || agentWorkflowDraftDescription;
    }
    if (currentLabel) {
        const canvasLabel = selected
            ? (currentWorkflowMatchesSelected(selected) ? '已同步' : '未保存更改')
            : (agentWorkflowDraftName ? '草稿未保存' : '新建草稿');
        currentLabel.textContent = canvasLabel;
        currentLabel.title = selected?.name || agentWorkflowDraftName || canvasLabel;
    }
    renderAgentWorkflowPicker();
    renderAgentWorkflowLifecycle();
    updateAgentWorkflowRunUi();
}

async function loadAgentWorkflows() {
    const select = document.getElementById('agent-workflow-select');
    if (!select) return;
    try {
        const res = await apiFetch(`${API_BASE}/agents/workflows`);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '已保存工作流加载失败');
        agentWorkflowsCache = data.data || [];
        renderAgentWorkflowLibrary();
    } catch (e) {
        showToast(e.message || '已保存工作流加载失败', 'error');
    }
}

function clearAgentWorkflowLocalSnapshots() {
    try {
        localStorage.removeItem(AGENT_WORKFLOW_DRAFT_KEY);
        localStorage.removeItem(AGENT_WORKFLOW_SAVED_KEY);
    } catch (e) {
        // ignore storage cleanup failures
    }
}

function currentAgentWorkflowDescription() {
    return String(agentWorkflowDraftDescription || '').trim().slice(0, 300);
}

function newAgentWorkflow(options = {}) {
    const {
        showToast: shouldShowToast = true,
        clearSnapshots = true,
        remount = true,
        name = '',
        description = ''
    } = options;
    activeAgentWorkflowId = '';
    const select = document.getElementById('agent-workflow-select');
    if (select) select.value = '';
    agentWorkflowDraftName = String(name || '').trim().slice(0, 100);
    agentWorkflowDraftDescription = String(description || '').trim().slice(0, 300);
    if (clearSnapshots) clearAgentWorkflowLocalSnapshots();
    closeAgentDagNodeDrawer();
    writeAgentWorkflowText({ nodes: [] });
    renderAgentWorkflowLibrary();
    if (remount) {
        mountAgentDagEditor();
        window.refreshAgentDagEditor?.();
    }
    updateAgentWorkflowRunUi();
    if (shouldShowToast) showToast(agentWorkflowDraftName ? `已新建工作流草稿：${agentWorkflowDraftName}` : '已新建工作流草稿', 'success');
}

function currentAgentWorkflowName() {
    const selected = selectedAgentWorkflow();
    return String(selected?.name || agentWorkflowDraftName || '未命名工作流').trim().slice(0, 100) || '未命名工作流';
}

window.setAgentWorkflowDraftName = function(name, options = {}) {
    const nextName = String(name || '').trim().slice(0, 100);
    if (!nextName) return;
    if (options.ifEmpty && (selectedAgentWorkflow()?.name || agentWorkflowDraftName)) return;
    agentWorkflowDraftName = nextName;
    renderAgentWorkflowLibrary();
};

async function ensureAgentWorkflowNameForSave() {
    const existing = String(selectedAgentWorkflow()?.name || agentWorkflowDraftName || '').trim().slice(0, 100);
    if (existing) return existing;
    const suggested = '未命名工作流';
    const value = await window.showInputPrompt?.({
        title: '保存工作流',
        message: '给当前工作流起一个名称，保存后会进入已保存工作流。',
        value: suggested,
        placeholder: '例如：日报汇总、客户回访分析',
        requiredMessage: '请填写工作流名称'
    });
    if (value === null || value === undefined) return '';
    const name = String(value || '').trim().slice(0, 100);
    if (!name) {
        showToast('请填写工作流名称后再保存', 'error');
        return '';
    }
    agentWorkflowDraftName = name;
    renderAgentWorkflowLibrary();
    return name;
}

function inferAgentWorkflowRunGoal() {
    const selected = selectedAgentWorkflow();
    const workflowName = String(selected?.name || agentWorkflowDraftName || '').trim();
    if (workflowName) return `执行工作流：${workflowName}`.slice(0, 2000);
    const summary = summarizeAgentDagSpec();
    if (summary.valid && summary.executableNodeCount > 0) return `执行当前工作流（${summary.executableNodeCount} 个节点）`;
    return '';
}

async function saveAgentWorkflowToLibrary(options = {}) {
    const showSuccess = options.showToast !== false;
    let parsed;
    try {
        parsed = parseAgentWorkflowText();
    } catch (e) {
        showToast('工作流 JSON 格式不正确', 'error');
        return null;
    }
    // 保存前主动校验，发现错误时弹出确认门禁
    const validation = dagEditorInstance?.validate?.();
    if (validation && validation.errors.length) {
        const blockingLlmError = validation.errors.find(item => /大模型节点|节点模型/.test(String(item || '')));
        if (blockingLlmError) {
            showToast(blockingLlmError, 'error');
            return null;
        }
        const msg = [
            `工作流存在 ${validation.errors.length} 个问题：`,
            ...validation.errors.map((e, i) => `${i + 1}. ${e}`),
            '',
            '确定仍要保存吗？'
        ].join('\n');
        const confirmed = await (window.showConfirm?.('工作流校验未通过', msg) || Promise.resolve(window.confirm(msg)));
        if (!confirmed) return null;
    }
    const workflowName = await ensureAgentWorkflowNameForSave();
    if (!workflowName) return null;
    const workflowId = activeAgentWorkflowId || document.getElementById('agent-workflow-select')?.value || '';
    const method = workflowId ? 'PUT' : 'POST';
    const url = workflowId
        ? `${API_BASE}/agents/workflows/${encodeURIComponent(workflowId)}`
        : `${API_BASE}/agents/workflows`;
    const res = await apiFetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            name: workflowName,
            description: currentAgentWorkflowDescription(),
            dagSpec: parsed,
            note: method === 'POST' ? '创建工作流' : '保存新版本'
        })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        showToast(data.error || '保存已保存工作流失败', 'error');
        return null;
    }
    activeAgentWorkflowId = String(data.workflow.id);
    agentWorkflowDraftName = data.workflow.name || workflowName;
    agentWorkflowDraftDescription = data.workflow.description || currentAgentWorkflowDescription();
    await loadAgentWorkflows();
    if (showSuccess) showToast(`工作流已保存：v${data.workflow.current_version || 1}`, 'success');
    return data.workflow;
}

function loadSelectedAgentWorkflow() {
    const select = document.getElementById('agent-workflow-select');
    const workflow = agentWorkflowsCache.find(item => String(item.id) === String(select?.value || activeAgentWorkflowId));
    if (!workflow) return showToast('请选择要加载的工作流', 'warning');
    activeAgentWorkflowId = String(workflow.id);
    agentWorkflowDraftName = workflow.name || '';
    agentWorkflowDraftDescription = workflow.description || '';
    writeAgentWorkflowText(workflow.dag_spec || { nodes: [] });
    updateAgentWorkflowRunUi();
    renderAgentWorkflowLibrary();
    mountAgentDagEditor();
    window.refreshAgentDagEditor?.();
    showToast(`已加载工作流：${workflow.name}`, 'success');
}

function deleteSelectedAgentWorkflow() {
    const select = document.getElementById('agent-workflow-select');
    const workflow = agentWorkflowsCache.find(item => String(item.id) === String(select?.value || activeAgentWorkflowId));
    if (!workflow) return showToast('请选择要删除的工作流', 'warning');
    showConfirm('删除工作流', `确定删除「${workflow.name}」吗？已产生的任务记录不会受影响。`, async () => {
        const res = await apiFetch(`${API_BASE}/agents/workflows/${encodeURIComponent(workflow.id)}`, { method: 'DELETE' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) return showToast(data.error || '删除工作流失败', 'error');
        // 保存删除信息以便撤销
        const deletedInfo = { id: workflow.id, name: workflow.name };
        const wasActive = String(activeAgentWorkflowId) === String(workflow.id);
        if (wasActive) activeAgentWorkflowId = '';
        if (wasActive) agentWorkflowDraftName = '';
        agentWorkflowDraftDescription = '';
        await loadAgentWorkflows();
        // 显示含恢复操作的提示
        showToast(`工作流「${deletedInfo.name}」已删除，30 天内可恢复`, 'success');
        const lifecycle = document.getElementById('agent-workflow-lifecycle');
        if (lifecycle) {
            lifecycle.innerHTML = `<button type="button" class="btn-secondary agent-workflow-undo-delete" title="恢复已删除的工作流">撤销删除：${agentEscape(deletedInfo.name)}</button>`;
            lifecycle.querySelector('.agent-workflow-undo-delete')?.addEventListener('click', async () => {
                const restoreRes = await apiFetch(`${API_BASE}/agents/workflows/${encodeURIComponent(deletedInfo.id)}/restore`, { method: 'PATCH' });
                const restoreData = await restoreRes.json().catch(() => ({}));
                if (!restoreRes.ok) return showToast(restoreData.error || '恢复失败', 'error');
                if (wasActive) activeAgentWorkflowId = String(restoreData.workflow.id);
                if (wasActive) agentWorkflowDraftName = restoreData.workflow.name || deletedInfo.name;
                await loadAgentWorkflows();
                showToast(`工作流「${restoreData.workflow.name || deletedInfo.name}」已恢复`, 'success');
            });
        }
    });
}

async function publishSelectedAgentWorkflow(version = 'current') {
    let workflow = selectedAgentWorkflow();
    if (String(version || 'current') === 'current') {
        workflow = await saveAgentWorkflowToLibrary({ showToast: false });
        if (!workflow) return;
    }
    if (!workflow) return showToast('请选择要发布的工作流', 'warning');
    const res = await apiFetch(`${API_BASE}/agents/workflows/${encodeURIComponent(workflow.id)}/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return showToast(data.error || '发布工作流失败', 'error');
    activeAgentWorkflowId = String(data.workflow.id);
    agentWorkflowDraftName = data.workflow.name || agentWorkflowDraftName;
    agentWorkflowDraftDescription = data.workflow.description || agentWorkflowDraftDescription;
    await loadAgentWorkflows();
    showToast(`工作流已发布：v${data.workflow.published_version || data.workflow.current_version || ''}`, 'success');
    return data.workflow;
}

function ensureAgentWorkflowVersionsModal() {
    let modal = document.getElementById('agent-workflow-versions-modal');
    if (modal) return modal;
    modal = document.createElement('div');
    modal.id = 'agent-workflow-versions-modal';
    modal.className = 'modal-overlay hidden rag-detail-modal-overlay';
    modal.innerHTML = `
        <div class="modal rag-detail-modal agent-workflow-versions-modal">
            <div class="rag-detail-header">
                <div>
                    <h3>工作流版本</h3>
                    <p class="model-modal-desc">查看历史版本，加载到画布预览，或回滚为新的当前版本。</p>
                </div>
                <button type="button" id="agent-workflow-versions-close-btn" class="btn-secondary">关闭</button>
            </div>
            <div id="agent-workflow-versions-body" class="agent-workflow-versions-body"></div>
        </div>
    `;
    document.body.appendChild(modal);
    modal.addEventListener('click', event => {
        if (event.target === modal || event.target.closest('#agent-workflow-versions-close-btn')) {
            modal.classList.add('hidden');
        }
    });
    return modal;
}

function selectedAgentWorkflow() {
    const select = document.getElementById('agent-workflow-select');
    return agentWorkflowsCache.find(item => String(item.id) === String(select?.value || activeAgentWorkflowId));
}

function currentWorkflowMatchesSelected(workflow) {
    if (!workflow) return false;
    try {
        return JSON.stringify(parseAgentWorkflowText()) === JSON.stringify(workflow.dag_spec || { nodes: [] });
    } catch (e) {
        return false;
    }
}

function agentWorkflowVersionMarkup(item, workflow) {
    const spec = item.dag_spec || { nodes: [] };
    const nodeCount = Array.isArray(spec.nodes) ? spec.nodes.length : 0;
    const isCurrent = Number(item.version) === Number(workflow?.current_version);
    const isPublished = Number(item.version) === Number(workflow?.published_version);
    return `
        <div class="agent-workflow-version-item ${isCurrent ? 'current' : ''}">
            <div>
                <strong>v${Number(item.version || 0)}${isCurrent ? ' · 当前' : ''}${isPublished ? ' · 已发布' : ''}</strong>
                <span>${nodeCount} 节点 · ${agentEscape(item.created_at || '-')}</span>
                ${item.note ? `<small>${agentEscape(agentShortText(item.note, 120))}</small>` : ''}
            </div>
            <div class="agent-workflow-version-actions">
                <button type="button" class="btn-secondary" data-agent-workflow-version-diff="${agentEscape(item.version)}">对比当前</button>
                <button type="button" class="btn-secondary" data-agent-workflow-version-load="${agentEscape(item.version)}">加载旧版</button>
                <button type="button" class="btn-secondary" data-agent-workflow-version-publish="${agentEscape(item.version)}" ${isPublished ? 'disabled' : ''}>发布</button>
                <button type="button" class="btn-primary" data-agent-workflow-version-restore="${agentEscape(item.version)}" ${isCurrent ? 'disabled' : ''}>回滚</button>
            </div>
        </div>
    `;
}

function agentWorkflowDiffMarkup(diff) {
    if (!diff) return '<div class="empty-state agent-empty-state">暂无差异</div>';
    const summary = diff.summary || {};
    const renderSimple = (items, type) => items.map(item => `
        <div class="agent-workflow-diff-row ${type}">
            <strong>${agentEscape(item.id)} · ${agentEscape(item.title || '-')}</strong>
            <span>${agentEscape(item.tool || '-')}</span>
        </div>
    `).join('');
    const renderChanged = (items) => items.map(item => `
        <div class="agent-workflow-diff-row changed">
            <strong>${agentEscape(item.id)} · ${agentEscape(item.after?.title || item.before?.title || '-')}</strong>
            <span>变化：${agentEscape((item.changes || []).join('、'))}</span>
            <details>
                <summary>查看前后参数</summary>
                <pre>${agentEscape(JSON.stringify({ before: item.before, after: item.after }, null, 2))}</pre>
            </details>
        </div>
    `).join('');
    const hasDiff = Number(summary.added || 0) || Number(summary.removed || 0) || Number(summary.changed || 0);
    if (!hasDiff) {
        return `
            <section class="agent-workflow-diff-panel">
                <header>v${agentEscape(diff.from?.version)} 与 v${agentEscape(diff.to?.version)} 没有节点差异</header>
            </section>
        `;
    }
    return `
        <section class="agent-workflow-diff-panel">
            <header>
                <strong>v${agentEscape(diff.from?.version)} → v${agentEscape(diff.to?.version)}</strong>
                <span>新增 ${Number(summary.added || 0)} · 删除 ${Number(summary.removed || 0)} · 修改 ${Number(summary.changed || 0)}</span>
            </header>
            ${diff.added?.length ? `<h4>新增节点</h4>${renderSimple(diff.added, 'added')}` : ''}
            ${diff.removed?.length ? `<h4>删除节点</h4>${renderSimple(diff.removed, 'removed')}` : ''}
            ${diff.changed?.length ? `<h4>修改节点</h4>${renderChanged(diff.changed)}` : ''}
        </section>
    `;
}

async function showAgentWorkflowVersionDiff(workflow, version) {
    const body = document.getElementById('agent-workflow-versions-body');
    if (!body) return;
    const target = body.querySelector(`[data-agent-workflow-version-diff="${CSS.escape(String(version))}"]`);
    target?.setAttribute('disabled', 'disabled');
    const res = await apiFetch(`${API_BASE}/agents/workflows/${encodeURIComponent(workflow.id)}/diff?from=${encodeURIComponent(version)}&to=current`);
    const data = await res.json().catch(() => ({}));
    target?.removeAttribute('disabled');
    const existing = body.querySelector('.agent-workflow-diff-panel');
    existing?.remove();
    if (!res.ok) return showToast(data.error || '版本对比失败', 'error');
    body.insertAdjacentHTML('afterbegin', agentWorkflowDiffMarkup(data));
}

async function openAgentWorkflowVersions() {
    const workflow = selectedAgentWorkflow();
    if (!workflow) return showToast('请选择要查看版本的工作流', 'warning');
    const modal = ensureAgentWorkflowVersionsModal();
    const body = document.getElementById('agent-workflow-versions-body');
    modal.classList.remove('hidden');
    body.innerHTML = '<div class="empty-state agent-empty-state">正在加载版本...</div>';
    const res = await apiFetch(`${API_BASE}/agents/workflows/${encodeURIComponent(workflow.id)}/versions`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        body.innerHTML = `<div class="empty-state agent-empty-state">${agentEscape(data.error || '版本加载失败')}</div>`;
        return;
    }
    const versions = data.data || [];
    body.innerHTML = versions.length
        ? versions.map(item => agentWorkflowVersionMarkup(item, workflow)).join('')
        : '<div class="empty-state agent-empty-state">暂无版本</div>';
    body.querySelectorAll('[data-agent-workflow-version-diff]').forEach(btn => {
        btn.addEventListener('click', () => showAgentWorkflowVersionDiff(workflow, btn.dataset.agentWorkflowVersionDiff));
    });
    body.querySelectorAll('[data-agent-workflow-version-load]').forEach(btn => {
        btn.addEventListener('click', () => {
            const version = versions.find(item => String(item.version) === String(btn.dataset.agentWorkflowVersionLoad));
            if (!version) return;
            writeAgentWorkflowText(version.dag_spec || { nodes: [] });
            mountAgentDagEditor();
            window.refreshAgentDagEditor?.();
            updateAgentWorkflowRunUi();
            showToast(`已加载 v${version.version} 到画布，保存后会生成新版本`, 'success');
        });
    });
    body.querySelectorAll('[data-agent-workflow-version-publish]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const version = btn.dataset.agentWorkflowVersionPublish;
            btn.setAttribute('disabled', 'disabled');
            const published = await publishSelectedAgentWorkflow(version);
            btn.removeAttribute('disabled');
            if (published) openAgentWorkflowVersions();
        });
    });
    body.querySelectorAll('[data-agent-workflow-version-restore]').forEach(btn => {
        btn.addEventListener('click', () => {
            const version = btn.dataset.agentWorkflowVersionRestore;
            showConfirm('回滚工作流版本', `确定将工作流回滚到 v${version} 吗？系统会生成一个新的当前版本。`, async () => {
                const restoreRes = await apiFetch(`${API_BASE}/agents/workflows/${encodeURIComponent(workflow.id)}/versions/${encodeURIComponent(version)}/restore`, { method: 'POST' });
                const restoreData = await restoreRes.json().catch(() => ({}));
                if (!restoreRes.ok) return showToast(restoreData.error || '版本回滚失败', 'error');
                activeAgentWorkflowId = String(restoreData.workflow.id);
                agentWorkflowDraftName = restoreData.workflow.name || agentWorkflowDraftName;
                agentWorkflowDraftDescription = restoreData.workflow.description || agentWorkflowDraftDescription;
                writeAgentWorkflowText(restoreData.workflow.dag_spec || { nodes: [] });
                await loadAgentWorkflows();
                mountAgentDagEditor();
                window.refreshAgentDagEditor?.();
                updateAgentWorkflowRunUi();
                showToast(`已回滚为 v${restoreData.workflow.current_version}`, 'success');
                openAgentWorkflowVersions();
            });
        });
    });
}

function persistAgentWorkflow(key, label) {
    const raw = getAgentWorkflowText();
    let parsed;
    try {
        parsed = parseAgentWorkflowText(raw);
    } catch (e) {
        showToast('工作流 JSON 格式不正确', 'error');
        return false;
    }
    try {
        localStorage.setItem(key, JSON.stringify({
            savedAt: new Date().toISOString(),
            spec: parsed
        }));
    } catch (e) {
        showToast(`${label}失败，浏览器存储不可用`, 'error');
        return false;
    }
    return true;
}

window.saveAgentWorkflowDraft = function() {
    if (persistAgentWorkflow(AGENT_WORKFLOW_DRAFT_KEY, '保存草稿')) {
        showToast('工作流草稿已保存', 'success');
    }
};

window.saveAgentWorkflow = async function() {
    if (!persistAgentWorkflow(AGENT_WORKFLOW_SAVED_KEY, '保存工作流')) return;
    updateAgentWorkflowRunUi();
    try {
        localStorage.removeItem(AGENT_WORKFLOW_DRAFT_KEY);
    } catch (e) {
        // ignore storage cleanup failures
    }
    await saveAgentWorkflowToLibrary();
};

function getAgentRunPayload(goalOverride = '') {
    const allowMcp = document.getElementById('agent-allow-mcp')?.checked !== false;
    const rawRunMode = document.getElementById('agent-run-mode')?.value || 'standard';
    const runMode = ['standard', 'deep', 'audit'].includes(rawRunMode) ? rawRunMode : 'standard';
    const typedGoal = goalOverride || document.getElementById('agent-goal-input')?.value.trim();
    const payload = {
        goal: typedGoal,
        modelId: document.getElementById('agent-model-select')?.value,
        maxSteps: document.getElementById('agent-max-steps')?.value || 10,
        runMode,
        toolPolicy: allowMcp ? 'all' : 'builtin_only',
        approvalPolicy: document.getElementById('agent-approval-policy')?.value || 'safe_mcp_auto',
        modelRouter: document.getElementById('agent-model-router')?.value || 'fixed',
        maxTokenBudget: document.getElementById('agent-token-budget')?.value || 0,
        retryLimit: document.getElementById('agent-retry-limit')?.value || 1,
        toolAllowlist: getSelectedAgentToolAllowlist(),
        contextConfig: getAgentContextConfig(),
        sessionId: window.currentSessionId || null
    };
    return payload;
}

function applyAgentTemplate(template) {
    if (!template) return;
    const goalInput = document.getElementById('agent-goal-input');
    if (goalInput) goalInput.value = template.goal_template || '';
    const runMode = document.getElementById('agent-run-mode');
    const templateRunMode = ['standard', 'deep', 'audit'].includes(template.run_mode) ? template.run_mode : 'standard';
    if (runMode) runMode.value = templateRunMode;
    const allowMcp = document.getElementById('agent-allow-mcp');
    if (allowMcp) allowMcp.checked = template.tool_policy !== 'builtin_only';
    const approval = document.getElementById('agent-approval-policy');
    if (approval) approval.value = template.approval_policy || 'safe_mcp_auto';
    const router = document.getElementById('agent-model-router');
    if (router) router.value = template.model_router || 'fixed';
    const steps = document.getElementById('agent-max-steps');
    if (steps) steps.value = template.max_steps || 10;
    const budget = document.getElementById('agent-token-budget');
    if (budget) budget.value = template.max_token_budget || '';
    const retry = document.getElementById('agent-retry-limit');
    if (retry) retry.value = template.retry_limit || 1;
    const context = agentParsePayload(template.context_config || '{}') || {};
    const contextMode = document.getElementById('agent-context-mode');
    if (contextMode) contextMode.value = context.mode || 'auto';
    const contextNotes = document.getElementById('agent-context-notes');
    if (contextNotes) contextNotes.value = context.notes || '';
    const allowlist = agentParsePayload(template.tool_allowlist || '[]');
    const selectedTools = Array.isArray(allowlist) ? allowlist.map(item => String(item || '').trim()).filter(Boolean) : [];
    document.querySelectorAll('[data-agent-tool-allow]').forEach(input => {
        input.checked = selectedTools.length === 0 ? true : selectedTools.includes(input.dataset.agentToolAllow);
    });
    showToast('模板已应用', 'success');
}

async function loadAgentTemplates() {
    const list = document.getElementById('agent-template-list');
    if (!list) return;
    const res = await apiFetch(`${API_BASE}/agents/templates`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '模板库加载失败');
    agentTemplatesCache = data.data || [];
    list.innerHTML = agentTemplatesCache.length ? agentTemplatesCache.slice(0, 8).map(template => `
        <div class="agent-template-item" title="${agentEscape(template.description || template.goal_template)}">
            <button type="button" class="agent-template-apply" data-agent-template-id="${agentEscape(template.id)}">
                <strong>${agentEscape(template.name)}</strong>
                <span>${agentEscape(template.scope === 'shared' ? '共享' : '个人')}</span>
            </button>
            ${template.scope === 'personal' ? `<button type="button" class="agent-mini-danger" data-agent-template-delete="${agentEscape(template.id)}">删除</button>` : ''}
        </div>
    `).join('') : '<div class="empty-state agent-empty-state compact">暂无模板</div>';
    list.querySelectorAll('[data-agent-template-id]').forEach(btn => {
        btn.addEventListener('click', () => applyAgentTemplate(agentTemplatesCache.find(item => String(item.id) === String(btn.dataset.agentTemplateId))));
    });
    list.querySelectorAll('[data-agent-template-delete]').forEach(btn => {
        btn.addEventListener('click', () => deleteAgentTemplate(btn.dataset.agentTemplateDelete));
    });
}

async function saveCurrentAgentTemplate() {
    const payload = getAgentRunPayload();
    if (!payload.goal) return showToast('请先填写任务目标', 'error');
    if (payload._invalid) return;
    const name = window.prompt('模板名称', payload.goal.slice(0, 24));
    if (!name) return;
    const res = await apiFetch(`${API_BASE}/agents/templates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            name,
            goalTemplate: payload.goal,
            description: '从智能体工作台保存',
            ...payload
        })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return showToast(data.error || '保存模板失败', 'error');
    showToast('模板已保存', 'success');
    await loadAgentTemplates();
}

function deleteAgentTemplate(templateId) {
    showConfirm('删除智能体模板', '确定删除这个智能体模板吗？已创建的任务记录不会受影响。', async () => {
        const res = await apiFetch(`${API_BASE}/agents/templates/${encodeURIComponent(templateId)}`, { method: 'DELETE' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) return showToast(data.error || '删除模板失败', 'error');
        showToast('模板已删除', 'success');
        await loadAgentTemplates();
    });
}

async function loadAgentSchedules() {
    const list = document.getElementById('agent-schedule-list');
    if (!list) return;
    const res = await apiFetch(`${API_BASE}/agents/schedules`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '计划队列加载失败');
    agentSchedulesCache = data.data || [];
    list.innerHTML = agentSchedulesCache.length ? agentSchedulesCache.slice(0, 5).map(schedule => `
        <div class="agent-ops-item">
            <strong>${agentEscape(schedule.name)}</strong>
            <span>${agentEscape(schedule.frequency === 'daily' ? '每天' : schedule.frequency === 'weekly' ? '每周' : '手动')} · 下次 ${agentEscape(schedule.next_run_at || '-')}</span>
            <div class="agent-ops-actions">
                <button type="button" class="btn-secondary" data-agent-schedule-run="${agentEscape(schedule.id)}">运行</button>
                <button type="button" class="btn-danger-outline" data-agent-schedule-delete="${agentEscape(schedule.id)}">删除</button>
            </div>
        </div>
    `).join('') : '<div class="empty-state agent-empty-state compact">暂无计划</div>';
    list.querySelectorAll('[data-agent-schedule-run]').forEach(btn => {
        btn.addEventListener('click', () => runAgentSchedule(btn.dataset.agentScheduleRun));
    });
    list.querySelectorAll('[data-agent-schedule-delete]').forEach(btn => {
        btn.addEventListener('click', () => deleteAgentSchedule(btn.dataset.agentScheduleDelete));
    });
}

async function runAgentSchedule(scheduleId) {
    const res = await apiFetch(`${API_BASE}/agents/schedules/${encodeURIComponent(scheduleId)}/run`, { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return showToast(data.error || '计划运行失败', 'error');
    showToast('计划任务已入队', 'success');
    await loadAgentRuns(1);
    await window.openAgentRun(data.run.id);
}

function deleteAgentSchedule(scheduleId) {
    showConfirm('删除智能体计划', '确定删除这个计划吗？已产生的任务记录不会受影响。', async () => {
        const res = await apiFetch(`${API_BASE}/agents/schedules/${encodeURIComponent(scheduleId)}`, { method: 'DELETE' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) return showToast(data.error || '删除计划失败', 'error');
        showToast('计划已删除', 'success');
        await loadAgentSchedules();
    });
}

async function loadAgentNotifications() {
    const list = document.getElementById('agent-notification-list');
    if (!list) return;
    const res = await apiFetch(`${API_BASE}/agents/notifications?limit=8`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '通知加载失败');
    const items = data.data || [];
    list.innerHTML = items.length ? items.slice(0, 5).map(item => `
        <button type="button" class="agent-ops-item ${item.status === 'unread' ? 'unread' : ''}" data-agent-notification-id="${agentEscape(item.id)}" data-agent-notification-run="${agentEscape(item.run_id || '')}">
            <strong>${agentEscape(agentNotificationTitle(item))}</strong>
            <span>${agentEscape(agentNotificationBody(item))}</span>
        </button>
    `).join('') : '<div class="empty-state agent-empty-state compact">暂无通知</div>';
    list.querySelectorAll('[data-agent-notification-id]').forEach(btn => {
        btn.addEventListener('click', async () => {
            await apiFetch(`${API_BASE}/agents/notifications/${encodeURIComponent(btn.dataset.agentNotificationId)}/read`, { method: 'POST' });
            if (btn.dataset.agentNotificationRun) await window.openAgentRun(btn.dataset.agentNotificationRun);
            await loadAgentNotifications();
        });
    });
}

async function loadAgentArtifacts() {
    const list = document.getElementById('agent-artifact-list');
    if (!list) return;
    const res = await apiFetch(`${API_BASE}/agents/artifacts?limit=8`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '结果沉淀加载失败');
    agentArtifactsCache = data.data || [];
    list.innerHTML = agentArtifactsCache.length ? agentArtifactsCache.slice(0, 4).map(item => `
        <button type="button" class="agent-ops-item" data-agent-artifact-id="${agentEscape(item.id)}">
            <strong>${agentEscape(item.title)}</strong>
            <span>v${Number(item.current_version || 1)} · ${Number(item.version_count || 1)} 版 · ${agentEscape(formatDateToCN(item.updated_at || item.created_at))}</span>
        </button>
    `).join('') : '<div class="empty-state agent-empty-state compact">暂无沉淀结果</div>';
    list.querySelectorAll('[data-agent-artifact-id]').forEach(btn => {
        btn.addEventListener('click', () => window.openAgentArtifactVersions(btn.dataset.agentArtifactId));
    });
}

function ensureAgentArtifactModal() {
    let modal = document.getElementById('agent-artifact-modal');
    if (modal) return modal;
    modal = document.createElement('div');
    modal.id = 'agent-artifact-modal';
    modal.className = 'modal-overlay hidden rag-detail-modal-overlay';
    modal.innerHTML = `
        <div class="modal rag-detail-modal agent-artifact-modal">
            <div class="rag-detail-header">
                <div>
                    <h3 id="agent-artifact-title">结果版本</h3>
                    <p class="model-modal-desc" id="agent-artifact-desc"></p>
                </div>
                <button type="button" id="agent-artifact-close-btn" class="btn-danger-outline">关闭</button>
            </div>
            <div class="agent-artifact-editor">
                <label>
                    <span>版本备注</span>
                    <input id="agent-artifact-note" class="form-input" placeholder="说明本次修改、回滚或校订原因">
                </label>
                <label>
                    <span>当前内容</span>
                    <textarea id="agent-artifact-content" class="form-input agent-artifact-content"></textarea>
                </label>
                <button type="button" id="agent-artifact-save-version" class="btn-primary">保存新版本</button>
            </div>
            <div id="agent-artifact-diff" class="agent-artifact-diff"></div>
            <div id="agent-artifact-version-list" class="agent-artifact-version-list"></div>
        </div>
    `;
    document.body.appendChild(modal);
    modal.addEventListener('click', event => {
        if (event.target === modal || event.target.closest('#agent-artifact-close-btn')) {
            modal.classList.add('hidden');
        }
    });
    return modal;
}

async function loadAgentArtifactModal(artifactId) {
    const modal = ensureAgentArtifactModal();
    const res = await apiFetch(`${API_BASE}/agents/artifacts/${encodeURIComponent(artifactId)}/versions`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return showToast(data.error || '版本加载失败', 'error');
    const artifact = data.artifact || {};
    const versions = data.versions || [];
    modal.querySelector('#agent-artifact-title').textContent = artifact.title || '结果版本';
    modal.querySelector('#agent-artifact-desc').textContent = `${versions.length} 个版本 · 当前 v${artifact.current_version || 1}`;
    modal.querySelector('#agent-artifact-content').value = artifact.content || '';
    modal.querySelector('#agent-artifact-note').value = '';
    modal.querySelector('#agent-artifact-diff').innerHTML = '';
    modal.querySelector('#agent-artifact-save-version').onclick = async () => {
        const content = modal.querySelector('#agent-artifact-content').value;
        const note = modal.querySelector('#agent-artifact-note').value;
        const saveRes = await apiFetch(`${API_BASE}/agents/artifacts/${encodeURIComponent(artifactId)}/versions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content, note })
        });
        const saveData = await saveRes.json().catch(() => ({}));
        if (!saveRes.ok) return showToast(saveData.error || '保存版本失败', 'error');
        showToast('新版本已保存', 'success');
        await loadAgentArtifacts();
        await loadAgentArtifactModal(artifactId);
    };
    const list = modal.querySelector('#agent-artifact-version-list');
    list.innerHTML = versions.map(version => `
        <div class="agent-artifact-version ${version.id === artifact.current_version_id ? 'current' : ''}">
            <div>
                <strong>v${Number(version.version)}</strong>
                <span>${agentEscape(version.note || '无备注')}</span>
                <small>${agentEscape(formatDateToCN(version.created_at))}</small>
            </div>
            <div class="agent-artifact-version-actions">
                ${version.version > 1 ? `<button type="button" class="btn-secondary" data-artifact-diff="${version.version}">对比上一版</button>` : ''}
                ${version.id !== artifact.current_version_id ? `<button type="button" class="btn-secondary" data-artifact-rollback="${version.version}">回滚</button>` : ''}
            </div>
        </div>
    `).join('') || '<div class="empty-state compact">暂无版本</div>';
    list.querySelectorAll('[data-artifact-diff]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const to = Number(btn.dataset.artifactDiff);
            const diffRes = await apiFetch(`${API_BASE}/agents/artifacts/${encodeURIComponent(artifactId)}/diff?from=${to - 1}&to=${to}`);
            const diffData = await diffRes.json().catch(() => ({}));
            if (!diffRes.ok) return showToast(diffData.error || '对比失败', 'error');
            modal.querySelector('#agent-artifact-diff').innerHTML = `
                <strong>v${to - 1} → v${to}</strong>
                <pre>${agentEscape((diffData.diff || []).filter(row => row.type !== 'same').map(row => `${row.type === 'add' ? '+' : row.type === 'remove' ? '-' : ' '} ${row.text}`).join('\n') || '无差异')}</pre>
            `;
        });
    });
    list.querySelectorAll('[data-artifact-rollback]').forEach(btn => {
        btn.addEventListener('click', () => {
            showConfirm('回滚结果版本', `确定回滚到 v${btn.dataset.artifactRollback} 吗？会生成一个新的当前版本。`, async () => {
                const rollbackRes = await apiFetch(`${API_BASE}/agents/artifacts/${encodeURIComponent(artifactId)}/rollback`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ version: Number(btn.dataset.artifactRollback) })
                });
                const rollbackData = await rollbackRes.json().catch(() => ({}));
                if (!rollbackRes.ok) return showToast(rollbackData.error || '回滚失败', 'error');
                showToast('已回滚并生成新版本', 'success');
                await loadAgentArtifacts();
                await loadAgentArtifactModal(artifactId);
            });
        });
    });
    modal.classList.remove('hidden');
}

window.openAgentArtifactVersions = loadAgentArtifactModal;

function agentWorkflowRunSourceLabel(source) {
    if (source === 'published') return '发布版运行';
    if (source === 'current') return '当前版本运行';
    return '预览运行';
}

function setAgentWorkflowRunConsoleStatus(message, type = '') {
    void message;
    void type;
}

function getAgentWorkflowRunSettings(raw = getAgentWorkflowText()) {
    let spec;
    try {
        spec = parseAgentWorkflowText(raw);
    } catch (e) {
        return { valid: false, error: e };
    }
    const nodes = Array.isArray(spec?.nodes) ? spec.nodes : [];
    const llmNode = nodes.find(node => String(node?.tool || '').trim() === 'agent.llm') || null;
    const input = llmNode?.input && typeof llmNode.input === 'object' ? llmNode.input : {};
    const maxSteps = Number.parseInt(input.maxSteps ?? input.max_steps ?? 20, 10);
    return {
        valid: true,
        llmNode,
        modelId: String(input.model || input.modelId || input.model_id || '').trim(),
        maxSteps: Number.isFinite(maxSteps) && maxSteps > 0 ? maxSteps : 20,
        toolPolicy: 'all',
        approvalPolicy: 'safe_mcp_auto',
        modelRouter: 'fixed',
        maxTokenBudget: 0,
        retryLimit: 1,
        toolAllowlist: [],
        contextConfig: { mode: 'auto', notes: '' }
    };
}

function validateAgentWorkflowRunSettings(settings, options = {}) {
    const requireModel = options.requireModel !== false;
    if (!settings?.valid) return '工作流 JSON 格式不正确，无法读取 LLM 节点配置';
    if (!settings.llmNode) return '工作流必须包含 1 个大模型节点';
    if (requireModel && !settings.modelId) return `${settings.llmNode.title || settings.llmNode.id || '大模型节点'} 需要填写节点模型`;
    return '';
}

function buildAgentWorkflowWorkbenchRunPayload(source = 'draft', workflowOverride = null) {
    const workflow = workflowOverride || selectedAgentWorkflow();
    const sourceMode = ['draft', 'current', 'published'].includes(source) ? source : 'draft';
    const summaryForSettings = sourceMode === 'draft'
        ? summarizeAgentDagSpec()
        : summarizeAgentDagSpec(workflow?.dag_spec || { nodes: [] });
    const runSettings = getAgentWorkflowRunSettings(sourceMode === 'draft' ? getAgentWorkflowText() : (workflow?.dag_spec || { nodes: [] }));
    const goal = inferAgentWorkflowRunGoal();
    const payload = {
        goal,
        title: `${agentWorkflowRunSourceLabel(sourceMode)}：${currentAgentWorkflowName()}`,
        modelId: runSettings.modelId,
        maxSteps: runSettings.maxSteps,
        runMode: 'dag',
        toolPolicy: runSettings.toolPolicy,
        approvalPolicy: runSettings.approvalPolicy,
        modelRouter: runSettings.modelRouter,
        maxTokenBudget: runSettings.maxTokenBudget,
        retryLimit: runSettings.retryLimit,
        toolAllowlist: runSettings.toolAllowlist,
        contextConfig: runSettings.contextConfig,
        sessionId: window.currentSessionId || null
    };
    if (!payload.goal) {
        showToast('请先填写任务目标或工作流名称', 'error');
        payload._invalid = true;
        return payload;
    }
    if (sourceMode === 'draft') {
        const summary = summaryForSettings;
        if (!summary.valid) {
            showToast('工作流 JSON 格式不正确，无法预览运行', 'error');
            payload._invalid = true;
            return payload;
        }
        if (summary.executableNodeCount <= 0) {
            showToast('预览运行至少需要 1 个已选择工具的节点', 'error');
            payload._invalid = true;
            return payload;
        }
        const settingsError = validateAgentWorkflowRunSettings(runSettings);
        if (settingsError) {
            showToast(settingsError, 'error');
            payload._invalid = true;
            return payload;
        }
        payload.dagSpec = summary.spec;
        payload.workflowVersion = 'draft';
        payload.metadata = {
            ...(payload.metadata || {}),
            workflowRunSource: 'preview',
            workflowVersionMode: 'draft',
            workflowName: currentAgentWorkflowName()
        };
    } else {
        if (!workflow) {
            showToast('请选择要运行的工作流', 'error');
            payload._invalid = true;
            return payload;
        }
        if (sourceMode === 'published' && !workflow.published_version) {
            showToast('当前工作流还没有发布版本，请先发布后再运行发布版', 'error');
            payload._invalid = true;
            return payload;
        }
        const settingsError = validateAgentWorkflowRunSettings(runSettings, { requireModel: sourceMode !== 'published' });
        if (settingsError) {
            showToast(settingsError, 'error');
            payload._invalid = true;
            return payload;
        }
        payload.workflowId = workflow.id;
        payload.workflowVersion = sourceMode === 'published' ? 'published' : 'current';
        payload.metadata = {
            ...(payload.metadata || {}),
            workflowRunSource: sourceMode === 'published' ? 'published' : 'current',
            workflowVersionMode: sourceMode,
            workflowName: workflow.name || currentAgentWorkflowName()
        };
    }
    const visualInputs = collectAgentDagInputs();
    if (Object.keys(visualInputs).length) payload.dagInputs = visualInputs;
    return payload;
}

async function runAgentWorkflowFromWorkbench(source = 'draft', options = {}) {
    const sourceMode = ['draft', 'current', 'published'].includes(source) ? source : 'draft';
    const payload = buildAgentWorkflowWorkbenchRunPayload(sourceMode, options.workflow || null);
    if (payload._invalid) return null;
    try {
        setAgentWorkflowRunConsoleStatus(`正在预检：${agentWorkflowRunSourceLabel(sourceMode)}...`, 'running');
        const preflight = await preflightAgentPayload(payload);
        if (preflight.status === 'blocked') {
            setAgentWorkflowRunConsoleStatus('预检未通过，请先处理阻断项。', 'error');
            showToast('工作流预检未通过，请先处理阻断项', 'error');
            return null;
        }
        setAgentWorkflowRunConsoleStatus(`正在创建任务：${agentWorkflowRunSourceLabel(sourceMode)}...`, 'running');
        const res = await apiFetch(`${API_BASE}/agents/runs`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '工作流运行失败');
        if (sourceMode === 'draft') {
            setAgentWorkflowRunConsoleStatus('预览运行已入队，可在预览详情查看节点轨迹。', 'ready');
            showToast('预览运行已入队', 'success');
            await window.openAgentRun(data.run.id, { workflowPreview: true });
            startAgentWorkflowPreviewPolling(data.run.id);
        } else {
            setAgentWorkflowRunConsoleStatus(`${agentWorkflowRunSourceLabel(sourceMode)}已入队，可在任务详情查看节点轨迹。`, 'ready');
            showToast(`${agentWorkflowRunSourceLabel(sourceMode)}已入队`, 'success');
            await Promise.all([loadAgentRuns(1), loadAgentSchedules(), loadAgentNotifications()]);
            await window.openAgentRun(data.run.id);
        }
        return data.run;
    } catch (e) {
        setAgentWorkflowRunConsoleStatus(e.message || '工作流运行失败', 'error');
        showToast(e.message || '工作流运行失败', 'error');
        return null;
    }
}

async function publishAndRunAgentWorkflow() {
    const workflow = await publishSelectedAgentWorkflow('current');
    if (!workflow) return null;
    return runAgentWorkflowFromWorkbench('published', { workflow });
}

window.runAgentWorkflowPreview = () => runAgentWorkflowFromWorkbench('draft');
window.runAgentWorkflowPublished = () => runAgentWorkflowFromWorkbench('published');
window.publishSelectedAgentWorkflow = publishSelectedAgentWorkflow;
window.publishAndRunAgentWorkflow = publishAndRunAgentWorkflow;
window.openAgentWorkflowVersions = openAgentWorkflowVersions;

window.createAgentRun = async function() {
    const payload = getAgentRunPayload();
    const frequency = document.getElementById('agent-schedule-frequency')?.value || 'manual';
    if (!payload.goal) return showToast('请先填写任务目标', 'error');
    if (!payload.modelId) return showToast('请选择模型', 'error');
    if (payload._invalid) return;
    const preflight = await preflightAgentPayload(payload);
    if (preflight.status === 'blocked') return showToast('任务预检未通过，请先处理阻断项', 'error');
    if (frequency !== 'manual') {
        const schedulePayload = { ...payload };
        const scheduleRes = await apiFetch(`${API_BASE}/agents/schedules`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ...schedulePayload,
                name: payload.goal.slice(0, 40),
                frequency,
                timeOfDay: document.getElementById('agent-schedule-time')?.value || '09:00',
                dayOfWeek: document.getElementById('agent-schedule-weekday')?.value || 1
            })
        });
        const scheduleData = await scheduleRes.json().catch(() => ({}));
        if (!scheduleRes.ok) return showToast(scheduleData.error || '计划创建失败', 'error');
        showToast('计划任务已创建', 'success');
        await loadAgentSchedules();
        return;
    }
    const res = await apiFetch(`${API_BASE}/agents/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok) return showToast(data.error || '任务创建失败', 'error');
    showToast('智能体任务已入队', 'success');
    document.getElementById('agent-goal-input').value = '';
    await Promise.all([loadAgentRuns(1), loadAgentSchedules(), loadAgentNotifications()]);
    await window.openAgentRun(data.run.id);
};

window.approveAgentRun = async function(runId, approve = true) {
    const res = await apiFetch(`${API_BASE}/agents/runs/${encodeURIComponent(runId)}/approval`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approve })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return showToast(data.error || '审批处理失败', 'error');
    showToast(approve ? '已批准工具调用，任务继续排队' : '已拒绝工具调用', 'success');
    await loadAgentRuns();
    await window.openAgentRun(runId);
};

window.cancelAgentRun = function(runId) {
    showConfirm('停止智能体任务', '确定停止这个正在执行的智能体任务吗？', async () => {
        const res = await apiFetch(`${API_BASE}/agents/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) return showToast(data.error || '停止失败', 'error');
        showToast('智能体任务已停止', 'success');
        await loadAgentRuns();
        const stillExists = agentRunsCache.some(run => run.id === runId);
        if (stillExists) await window.openAgentRun(runId);
    });
};

window.cancelAgentWorkflowPreviewRun = function(runId) {
    showConfirm('停止预览运行', '确定停止这次工作流预览运行吗？', async () => {
        const res = await apiFetch(`${API_BASE}/agents/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) return showToast(data.error || '停止失败', 'error');
        showToast('预览运行已停止', 'success');
        await window.openAgentRun(runId, { workflowPreview: true });
    });
};

window.rerunAgentRun = async function(runId) {
    const res = await apiFetch(`${API_BASE}/agents/runs/${encodeURIComponent(runId)}/rerun`, { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return showToast(data.error || '重新运行失败', 'error');
    showToast('已创建新的智能体任务', 'success');
    await loadAgentRuns(1);
    await window.openAgentRun(data.run.id);
};

window.resumeAgentRun = async function(runId) {
    const res = await apiFetch(`${API_BASE}/agents/runs/${encodeURIComponent(runId)}/resume`, { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return showToast(data.error || '断点续跑失败', 'error');
    showToast('已从上次执行位置创建续跑任务', 'success');
    await loadAgentRuns(1);
    await window.openAgentRun(data.run.id);
};

window.rerunAgentDagNode = async function(runId, nodeId = '') {
    const res = await apiFetch(`${API_BASE}/agents/runs/${encodeURIComponent(runId)}/dag/rerun`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nodeId })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return showToast(data.error || '节点重跑失败', 'error');
    showToast('已创建节点重跑任务', 'success');
    await loadAgentRuns(1);
    await window.openAgentRun(data.run.id);
};

window.saveAgentArtifact = async function(runId) {
    const res = await apiFetch(`${API_BASE}/agents/runs/${encodeURIComponent(runId)}/artifacts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return showToast(data.error || '保存结果失败', 'error');
    showToast('结果已沉淀', 'success');
    await loadAgentArtifacts();
};

window.deleteAgentRun = function(runId) {
    showConfirm('移除智能体任务记录', '确定从任务列表移除这条智能体任务记录吗？记录会保留给 admin 权限层级审计。', async () => {
        const res = await apiFetch(`${API_BASE}/agents/runs/${encodeURIComponent(runId)}`, { method: 'DELETE' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) return showToast(data.error || '移除记录失败', 'error');
        showToast('智能体任务记录已移除', 'success');
        closeAgentRunDetailModal();
        await loadAgentRuns();
    });
};

window.showAgentRunAudit = async function() {
    if (!isSuperAdminUser()) {
        showToast('仅 admin 权限层级可查看智能体删除审计', 'error');
        return;
    }
    try {
        const res = await apiFetch(`${API_BASE}/agents/runs/deleted/audit?limit=100`);
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.error) throw new Error(data.error || '删除审计加载失败');
        const modal = ensureAgentAuditModal();
        const body = modal.querySelector('#agent-audit-body');
        if (body) body.innerHTML = renderAgentAuditRows(data.data || []);
        modal.classList.remove('hidden');
    } catch (e) {
        showToast(e.message || '删除审计加载失败', 'error');
    }
};

window.loadAgentWorkbench = async function() {
    try {
        await loadAgentModels();
        await Promise.all([
            loadCapabilityPackages(),
            loadAgentModelRouters(),
            loadAgentTools(),
            loadAgentRuns(),
            loadAgentRuntimeStatus(),
            loadAgentMetrics(),
            loadAgentTemplates(),
            loadAgentSchedules(),
            loadAgentNotifications(),
            loadAgentArtifacts()
        ]);
    } catch (e) {
        showToast(e.message, 'error');
    }
};

window.openAgentWorkbench = async function() {
    window.showMainWorkspace?.('agent');
    const panel = document.getElementById('agent-workbench-modal');
    if (!panel) return;
    panel.querySelectorAll('.admin-root-only').forEach(el => {
        el.classList.toggle('hidden', !isSuperAdminUser());
    });
    await window.loadAgentWorkbench();
    window.bindAgentFilters?.();
    window.bindAgentEnterpriseControls?.();
    window.bindAgentConfigModal?.();
};

window.openAgentDagWorkbench = async function() {
    closeAgentConfigModal();
    window.showMainWorkspace?.('agent-dag');
    const requestedWorkflowId = activeAgentWorkflowId || '';
    await Promise.all([
        loadAgentModels(),
        agentToolsCache.length ? Promise.resolve() : loadAgentTools(),
        loadAgentWorkflows()
    ]);
    const workflow = agentWorkflowsCache.find(item => String(item.id) === String(requestedWorkflowId));
    if (workflow) {
        activeAgentWorkflowId = String(workflow.id);
        agentWorkflowDraftName = workflow.name || '';
        agentWorkflowDraftDescription = workflow.description || '';
        writeAgentWorkflowText(workflow.dag_spec || { nodes: [] });
        renderAgentWorkflowLibrary();
    } else {
        newAgentWorkflow({ showToast: false, clearSnapshots: false, remount: false });
    }
    mountAgentDagEditor();
    window.refreshAgentDagEditor?.();
    window.bindAgentDagWorkbench?.();
    updateAgentWorkflowRunUi();
};

window.closeAgentWorkbench = function() {
    closeAgentConfigModal();
    closeAgentRunDetailModal();
    window.showMainWorkspace?.('chat');
    updateAgentAutoRefresh();
};

window.closeAgentDagWorkbench = function() {
    closeAgentDagJsonModal();
    closeAgentDagNodeDrawer();
    window.showMainWorkspace?.('agent');
};

window.bindAgentGoalTemplates = function() {
    document.querySelectorAll('[data-agent-goal-template]').forEach(btn => {
        if (btn.dataset.boundAgentTemplate === '1') return;
        btn.dataset.boundAgentTemplate = '1';
        btn.addEventListener('click', () => {
            const input = document.getElementById('agent-goal-input');
            if (!input) return;
            input.value = btn.dataset.agentGoalTemplate || '';
            if (btn.dataset.agentRunMode) {
                const mode = document.getElementById('agent-run-mode');
                if (mode) mode.value = btn.dataset.agentRunMode;
            }
            if (btn.dataset.agentMcp) {
                const allowMcp = document.getElementById('agent-allow-mcp');
                if (allowMcp) allowMcp.checked = btn.dataset.agentMcp === 'true';
            }
            input.focus();
        });
    });
};

window.bindAgentFilters = function() {
    ['agent-filter-status', 'agent-filter-query'].forEach(id => {
        const el = document.getElementById(id);
        if (!el || el.dataset.boundAgentFilter === '1') return;
        el.dataset.boundAgentFilter = '1';
        const reloadFirstPage = () => loadAgentRuns(1).catch(err => showToast(err.message || '任务列表刷新失败', 'error'));
        // 文本输入防抖，避免逐键触发请求风暴与响应乱序覆盖；下拉 change 保持即时
        const debouncedReload = window.Pivot && typeof window.Pivot.debounce === 'function'
            ? window.Pivot.debounce(reloadFirstPage, 280)
            : reloadFirstPage;
        el.addEventListener('input', debouncedReload);
        el.addEventListener('change', reloadFirstPage);
    });
};

window.bindAgentEnterpriseControls = function() {
    const saveTemplateBtn = document.getElementById('agent-save-template-btn');
    if (saveTemplateBtn && saveTemplateBtn.dataset.boundAgentTemplateSave !== '1') {
        saveTemplateBtn.dataset.boundAgentTemplateSave = '1';
        saveTemplateBtn.addEventListener('click', saveCurrentAgentTemplate);
    }
    const frequency = document.getElementById('agent-schedule-frequency');
    const weekday = document.getElementById('agent-schedule-weekday');
    if (frequency && frequency.dataset.boundAgentSchedule !== '1') {
        frequency.dataset.boundAgentSchedule = '1';
        const update = () => weekday?.classList.toggle('is-disabled', frequency.value !== 'weekly');
        frequency.addEventListener('change', update);
        update();
    }
};

const agentConfigSectionTitles = {
    templates: '模板与计划',
    results: '能力与结果'
};

function closeAgentConfigModal() {
    const modal = document.getElementById('agent-config-modal');
    const body = document.getElementById('agent-config-modal-body');
    const store = document.getElementById('agent-config-section-store');
    if (body && store) {
        Array.from(body.children).forEach(child => {
            store.appendChild(child);
            if (child.matches?.('.agent-collapse-section')) child.open = true;
        });
    }
    activeAgentConfigSection = '';
    if (modal) delete modal.dataset.agentConfigSection;
    modal?.classList.add('hidden');
}

function openAgentConfigSection(sectionKey) {
    const section = document.querySelector(`[data-agent-config-section="${CSS.escape(sectionKey)}"]`);
    const modal = document.getElementById('agent-config-modal');
    const body = document.getElementById('agent-config-modal-body');
    const title = document.getElementById('agent-config-modal-title');
    if (!section || !modal || !body) return;
    closeAgentConfigModal();
    activeAgentConfigSection = sectionKey;
    modal.dataset.agentConfigSection = sectionKey;
    if (title) title.textContent = agentConfigSectionTitles[sectionKey] || '智能体配置';
    section.open = true;
    body.appendChild(section);
    modal.classList.remove('hidden');
    if (sectionKey === 'advanced') {
        mountAgentDagEditor();
        setTimeout(() => window.refreshAgentDagEditor?.(), 50);
    }
}

window.closeAgentConfigModal = closeAgentConfigModal;
window.openAgentConfigSection = openAgentConfigSection;

window.bindAgentConfigModal = function() {
    document.querySelectorAll('[data-agent-config-open]').forEach(btn => {
        if (btn.dataset.boundAgentConfigOpen === '1') return;
        btn.dataset.boundAgentConfigOpen = '1';
        btn.addEventListener('click', () => openAgentConfigSection(btn.dataset.agentConfigOpen));
    });
    const closeBtn = document.getElementById('agent-config-modal-close');
    if (closeBtn && closeBtn.dataset.boundAgentConfigClose !== '1') {
        closeBtn.dataset.boundAgentConfigClose = '1';
        closeBtn.addEventListener('click', closeAgentConfigModal);
    }
    const modal = document.getElementById('agent-config-modal');
    if (modal && modal.dataset.boundAgentConfigOverlay !== '1') {
        modal.dataset.boundAgentConfigOverlay = '1';
        modal.addEventListener('click', event => {
            if (event.target === modal) closeAgentConfigModal();
        });
    }
    const runDetailClose = document.getElementById('agent-run-detail-close');
    if (runDetailClose && runDetailClose.dataset.boundAgentRunDetailClose !== '1') {
        runDetailClose.dataset.boundAgentRunDetailClose = '1';
        runDetailClose.addEventListener('click', closeAgentRunDetailModal);
    }
    const runDetailModal = document.getElementById('agent-run-detail-modal');
    if (runDetailModal && runDetailModal.dataset.boundAgentRunDetailOverlay !== '1') {
        runDetailModal.dataset.boundAgentRunDetailOverlay = '1';
        runDetailModal.addEventListener('click', event => {
            if (event.target === runDetailModal) closeAgentRunDetailModal();
        });
    }
    document.querySelectorAll('#agent-open-dag-btn').forEach(btn => {
        if (btn.dataset.boundAgentDagOpen === '1') return;
        btn.dataset.boundAgentDagOpen = '1';
        btn.addEventListener('click', () => window.openAgentDagWorkbench?.());
    });
};

window.bindAgentDagWorkbench = function() {
    const newBtn = document.getElementById('agent-workflow-new-btn');
    if (newBtn && newBtn.dataset.boundAgentWorkflowNew !== '1') {
        newBtn.dataset.boundAgentWorkflowNew = '1';
        newBtn.addEventListener('click', () => newAgentWorkflow());
    }
    const draftBtn = document.getElementById('agent-dag-save-draft-btn');
    if (draftBtn && draftBtn.dataset.boundAgentDagDraft !== '1') {
        draftBtn.dataset.boundAgentDagDraft = '1';
        draftBtn.addEventListener('click', () => window.saveAgentWorkflowDraft?.());
    }
    const saveBtn = document.getElementById('agent-dag-save-btn');
    if (saveBtn && saveBtn.dataset.boundAgentDagSave !== '1') {
        saveBtn.dataset.boundAgentDagSave = '1';
        saveBtn.addEventListener('click', () => window.saveAgentWorkflow?.());
    }
    const backBtn = document.getElementById('agent-dag-back-btn');
    if (backBtn && backBtn.dataset.boundAgentDagBack !== '1') {
        backBtn.dataset.boundAgentDagBack = '1';
        backBtn.addEventListener('click', () => window.closeAgentDagWorkbench?.());
    }
    const workflowPicker = document.getElementById('agent-workflow-picker');
    const workflowPickerTrigger = document.getElementById('agent-workflow-picker-trigger');
    const workflowPickerSearch = document.getElementById('agent-workflow-picker-search');
    const workflowPickerList = document.getElementById('agent-workflow-picker-list');
    if (workflowPickerTrigger && workflowPickerTrigger.dataset.boundAgentWorkflowPicker !== '1') {
        workflowPickerTrigger.dataset.boundAgentWorkflowPicker = '1';
        workflowPickerTrigger.addEventListener('click', () => {
            const isOpen = workflowPicker?.classList.contains('is-open');
            setAgentWorkflowPickerOpen(!isOpen);
        });
        workflowPickerTrigger.addEventListener('keydown', event => {
            if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                setAgentWorkflowPickerOpen(true);
            }
        });
    }
    if (workflowPickerSearch && workflowPickerSearch.dataset.boundAgentWorkflowSearch !== '1') {
        workflowPickerSearch.dataset.boundAgentWorkflowSearch = '1';
        workflowPickerSearch.addEventListener('input', () => {
            agentWorkflowPickerQuery = workflowPickerSearch.value || '';
            renderAgentWorkflowPicker();
        });
        workflowPickerSearch.addEventListener('keydown', event => {
            if (event.key === 'Escape') {
                event.preventDefault();
                setAgentWorkflowPickerOpen(false);
                workflowPickerTrigger?.focus();
                return;
            }
            if (event.key === 'ArrowDown') {
                event.preventDefault();
                workflowPickerList?.querySelector('.agent-workflow-picker-option')?.focus();
            }
        });
    }
    if (workflowPickerList && workflowPickerList.dataset.boundAgentWorkflowList !== '1') {
        workflowPickerList.dataset.boundAgentWorkflowList = '1';
        workflowPickerList.addEventListener('keydown', event => {
            const option = event.target.closest('.agent-workflow-picker-option');
            if (!option) return;
            if (event.key === 'Escape') {
                event.preventDefault();
                setAgentWorkflowPickerOpen(false);
                workflowPickerTrigger?.focus();
                return;
            }
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                const options = Array.from(workflowPickerList.querySelectorAll('.agent-workflow-picker-option'));
                const index = options.indexOf(option);
                const nextIndex = event.key === 'ArrowDown'
                    ? Math.min(index + 1, options.length - 1)
                    : Math.max(index - 1, 0);
                options[nextIndex]?.focus();
            }
        });
    }
    if (workflowPicker && workflowPicker.dataset.boundAgentWorkflowOutside !== '1') {
        workflowPicker.dataset.boundAgentWorkflowOutside = '1';
        document.addEventListener('click', event => {
            if (!workflowPicker.contains(event.target)) setAgentWorkflowPickerOpen(false, { focusSearch: false });
        });
    }
    const workflowSelect = document.getElementById('agent-workflow-select');
    if (workflowSelect && workflowSelect.dataset.boundAgentWorkflowSelect !== '1') {
        workflowSelect.dataset.boundAgentWorkflowSelect = '1';
        workflowSelect.addEventListener('change', () => {
            activeAgentWorkflowId = workflowSelect.value || '';
            if (!activeAgentWorkflowId) {
                newAgentWorkflow({ showToast: false, clearSnapshots: false });
                return;
            }
            const selected = agentWorkflowsCache.find(item => String(item.id) === String(activeAgentWorkflowId));
            agentWorkflowDraftName = selected?.name || '';
            agentWorkflowDraftDescription = selected?.description || '';
            renderAgentWorkflowLibrary();
            updateAgentWorkflowRunUi();
        });
    }
    const loadBtn = document.getElementById('agent-workflow-load-btn');
    if (loadBtn && loadBtn.dataset.boundAgentWorkflowLoad !== '1') {
        loadBtn.dataset.boundAgentWorkflowLoad = '1';
        loadBtn.addEventListener('click', loadSelectedAgentWorkflow);
    }
    const versionsBtn = document.getElementById('agent-workflow-versions-btn');
    if (versionsBtn && versionsBtn.dataset.boundAgentWorkflowVersions !== '1') {
        versionsBtn.dataset.boundAgentWorkflowVersions = '1';
        versionsBtn.addEventListener('click', openAgentWorkflowVersions);
    }
    const deleteBtn = document.getElementById('agent-workflow-delete-btn');
    if (deleteBtn && deleteBtn.dataset.boundAgentWorkflowDelete !== '1') {
        deleteBtn.dataset.boundAgentWorkflowDelete = '1';
        deleteBtn.addEventListener('click', deleteSelectedAgentWorkflow);
    }
    const drawerDeleteBtn = document.getElementById('agent-dag-node-drawer-delete');
    if (drawerDeleteBtn && drawerDeleteBtn.dataset.boundAgentDagDrawerDelete !== '1') {
        drawerDeleteBtn.dataset.boundAgentDagDrawerDelete = '1';
        drawerDeleteBtn.addEventListener('click', deleteSelectedAgentDagNode);
    }
    const drawerCloseBtn = document.getElementById('agent-dag-node-drawer-close');
    if (drawerCloseBtn && drawerCloseBtn.dataset.boundAgentDagDrawerClose !== '1') {
        drawerCloseBtn.dataset.boundAgentDagDrawerClose = '1';
        drawerCloseBtn.addEventListener('click', closeAgentDagNodeDrawer);
    }
    const jsonCloseBtn = document.getElementById('agent-dag-json-close-btn');
    if (jsonCloseBtn && jsonCloseBtn.dataset.boundAgentDagJsonClose !== '1') {
        jsonCloseBtn.dataset.boundAgentDagJsonClose = '1';
        jsonCloseBtn.addEventListener('click', closeAgentDagJsonModal);
    }
    const jsonApplyBtn = document.getElementById('agent-dag-json-apply-btn');
    if (jsonApplyBtn && jsonApplyBtn.dataset.boundAgentDagJsonApply !== '1') {
        jsonApplyBtn.dataset.boundAgentDagJsonApply = '1';
        jsonApplyBtn.addEventListener('click', syncAgentDagJsonToCanvas);
    }
    const jsonModal = document.getElementById('agent-dag-json-modal');
    if (jsonModal && jsonModal.dataset.boundAgentDagJsonOverlay !== '1') {
        jsonModal.dataset.boundAgentDagJsonOverlay = '1';
        jsonModal.addEventListener('click', event => {
            if (event.target === jsonModal) closeAgentDagJsonModal();
        });
    }
    // 运行时输入面板刷新按钮
    const inputsRefreshBtn = document.getElementById('agent-dag-inputs-refresh-btn');
    if (inputsRefreshBtn && inputsRefreshBtn.dataset.boundInputsRefresh !== '1') {
        inputsRefreshBtn.dataset.boundInputsRefresh = '1';
        inputsRefreshBtn.addEventListener('click', refreshAgentDagInputsPanel);
    }
};

// 智能体 DAG 可视化编辑器挂载（v0.0.47）
// 与 #agent-dag-spec textarea 双向同步：编辑器内部变化 -> textarea；textarea 手动改 -> 编辑器重绘
let dagEditorInstance = null;
function mountAgentDagEditor() {
    const canvas = document.getElementById('agent-dag-editor-canvas');
    const textarea = document.getElementById('agent-dag-spec');
    const toolbar = document.getElementById('agent-dag-editor-toolbar');
    const inspector = document.getElementById('agent-dag-editor-inspector');
    if (!canvas || !textarea || !window.PivotDagEditor) return;
    if (!canvas.offsetParent && activeAgentConfigSection !== 'advanced') return;
    if (dagEditorInstance) dagEditorInstance.destroy();
    dagEditorInstance = window.PivotDagEditor.mount({
        canvas,
        textarea,
        toolbar,
        inspector,
        getTools: () => agentToolsCache || [],
        onOpenJson: openAgentDagJsonModal,
        onNodeSelectionChange: updateAgentDagNodeDrawer,
        onChange: (result) => {
            if (result && result.error === 'invalid_json') {
                showToast('工作流 JSON 格式不正确', 'error');
            } else {
                updateAgentWorkflowRunUi();
                // 同步刷新运行时输入面板
                refreshAgentDagInputsPanel();
            }
        }
    });
}
window.refreshAgentDagEditor = () => dagEditorInstance?.refresh();

// 运行时输入参数面板：自动扫描工作流中引用的 {{inputs.*}} 变量并生成输入表单
function refreshAgentDagInputsPanel() {
    const workflowWorkbench = document.getElementById('agent-dag-workbench-modal');
    const workflowWorkbenchOpen = Boolean(workflowWorkbench && !workflowWorkbench.classList.contains('hidden'));
    const panel = document.getElementById('agent-dag-inputs-panel');
    const list = document.getElementById('agent-dag-inputs-list');
    if (!panel || !list) return;
    if (!workflowWorkbenchOpen) {
        panel.classList.add('hidden');
        return;
    }
    const scanRefs = (dagText) => {
        const refs = new Set();
        const regex = /\{\{\s*inputs\.([\w.-]+)\s*\}\}/g;
        let match;
        while ((match = regex.exec(dagText || '')) !== null) {
            const key = String(match[1] || '').trim();
            if (key) refs.add(key);
        }
        return refs;
    };
    let dagText = '';
    try { dagText = document.getElementById('agent-dag-spec')?.value || ''; } catch (e) { dagText = ''; }
    const refs = scanRefs(dagText);
    if (!refs.size) {
        panel.classList.add('hidden');
        return;
    }
    panel.classList.remove('hidden');
    const existing = {};
    list.querySelectorAll('.agent-dag-input-item input').forEach(input => {
        existing[input.dataset.dagInputKey || input.name] = input.value;
    });
    list.innerHTML = [...refs].map(key => `
        <label class="agent-dag-input-item">
            <span>${agentEscape(key)}</span>
            <input class="form-input" type="text" data-dag-input-key="${agentEscape(key)}" value="${agentEscape(existing[key] || '')}" placeholder="输入 ${agentEscape(key)} 的值">
        </label>
    `).join('');
}

// 从运行时输入面板收集 dagInputs
function collectAgentDagInputs() {
    const result = {};
    document.querySelectorAll('#agent-dag-inputs-list [data-dag-input-key]').forEach(input => {
        const key = String(input.dataset.dagInputKey || '').trim();
        const value = String(input.value || '').trim();
        if (key) result[key] = value;
    });
    return result;
}

window.refreshAgentDagInputs = refreshAgentDagInputsPanel;
window.collectAgentDagInputs = collectAgentDagInputs;
