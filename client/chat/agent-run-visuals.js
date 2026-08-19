// Agent 运行可视化 Agent run visuals
// Split from agent-run-renderers.js.
// 智能体运行可视化产物、DAG 拓扑图与进度展示工具
/* eslint-disable no-undef */
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
                <span class="agent-tool-stat-name" title="${agentEscape(entry.name)}">${agentEscape(agentToolTitle(entry.name))}</span>
                <div class="agent-tool-stat-bar"><div class="agent-tool-stat-bar-fill" style="width:${widthPct.toFixed(1)}%"></div></div>
                <span class="agent-tool-stat-count">${entry.count} 次</span>
                <span class="agent-tool-stat-extra">${agentRunDurationLabel(entry.durationMs)} · 平均 ${agentRunDurationLabel(avg)}${entry.errors > 0 ? ` · <em>${entry.errors} 次失败</em>` : ''}</span>
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
    const roundCount = Number(progress.roundCount || 0);
    const maxSteps = Number(progress.maxSteps || run.max_steps || 0);
    if (String(run.run_mode || '') === 'dag') return `已生成 ${stepCount} 条执行记录`;
    if (isAgentRunActive(run.status)) {
        if (progress.isLimitReached && maxSteps > 0) return `已执行 ${roundCount} 轮（已达上限 ${maxSteps} 轮）`;
        return maxSteps > 0 ? `已执行 ${roundCount} 轮（上限 ${maxSteps} 轮）` : `已执行 ${roundCount} 轮`;
    }
    return `已执行 ${roundCount} 轮，共 ${stepCount} 条记录`;
}

function agentDagNodeReadableText(node) {
    const tool = String(node?.tool_name || '').trim();
    if (tool === 'agent.delegate') {
        return agentLlmOutputText(node.output) || String(node.output?.handoff?.summary || '').trim();
    }
    if (tool === 'agent.handoff') return String(node.output?.summary || '').trim();
    if (tool !== 'agent.llm') return '';
    return agentLlmOutputText(node.output);
}

function agentDagNodeReadableOutputMarkup(node) {
    const structured = unwrapAgentStructuredPayload(node.output);
    if (structured && typeof structured === 'object') {
        const structuredMarkup = agentStepChartSummaryMarkup(structured) || agentStepRowsMarkup(structured);
        if (structuredMarkup) return `<div class="agent-dag-node-readable-output">${structuredMarkup}</div>`;
        const renderedOutput = renderAgentStructuredOutput(structured);
        if (renderedOutput) return `<div class="agent-dag-node-readable-output">${renderedOutput}</div>`;
    }
    const text = agentDagNodeReadableText(node);
    const value = text ? stripAgentWorkflowReportHeading(text) : node.output;
    if (value === undefined || value === null || value === '') return '';
    const parsed = agentParsePayload(value);
    const modeClass = typeof parsed === 'string' ? ' is-markdown' : ' is-structured';
    return `<div class="agent-dag-node-readable-output${modeClass}">${agentResultReadableMarkup(parsed, { maxRows: 8, maxItems: 10 })}</div>`;
}

function agentDagNodeDisplayTitle(node = {}) {
    const title = String(node.title || '').trim();
    const key = String(node.node_key || '').trim();
    const tool = String(node.tool_name || '').trim();
    const looksTechnical = !title
        || [key, tool, agentToolShortName(tool)].includes(title)
        || /^(?:mcp\.\d+\.)?[a-z][\w-]*(?:\.[\w-]+)+$/i.test(title);
    return looksTechnical ? agentToolTitle(tool || key || title) : title;
}

function agentDagNodeMarkup(node, index = null) {
    const deps = Array.isArray(node.depends_on) ? node.depends_on : [];
    const input = node.input ? (typeof node.input === 'string' ? node.input : JSON.stringify(node.input, null, 2)) : '';
    const output = node.output ? (typeof node.output === 'string' ? node.output : JSON.stringify(node.output, null, 2)) : '';
    const readableOutput = agentDagNodeReadableOutputMarkup(node);
    const canRerun = String(node.status || '').toLowerCase() === 'error';
    const status = String(node.status || 'pending').toLowerCase();
    const statusLabel = {
        completed: '已完成',
        continued_error: '失败后继续',
        running: '运行中',
        error: '执行失败',
        skipped: '跳过',
        pending: '待执行'
    }[status] || agentStatusLabel(status);
    const contractIssues = Array.isArray(node.contract_issues) ? node.contract_issues : [];
    const depText = deps.length ? deps.join(', ') : '无依赖';
    const toolName = agentToolTitle(node.tool_name || '-');
    const delegateName = node.tool_name === 'agent.delegate'
        ? String(node.input?.agentName || node.input?.agent_name || '').trim()
        : '';
    const displayTitle = agentDagNodeDisplayTitle(node);
    const detailOpen = ['error', 'running'].includes(status) ? ' open' : '';
    const stepNumber = Number.isInteger(index) ? `<span class="agent-dag-node-index">${index + 1}</span>` : '';
    return `
        <div class="agent-dag-node ${agentEscape(status)}">
            <details class="agent-dag-node-details"${detailOpen}>
                <summary class="agent-dag-node-head">
                    <div class="agent-dag-node-title">
                        ${stepNumber}
                        <div><strong>${agentEscape(displayTitle)}</strong><span>${agentEscape(toolName)}</span></div>
                    </div>
                    <div class="agent-dag-node-badges">
                        <span class="agent-dag-node-status ${agentEscape(status)}">${agentEscape(statusLabel)}</span>
                        <em>${agentEscape(agentRunDurationLabel(node.duration_ms))}</em>
                    </div>
                </summary>
                <div class="agent-dag-node-body">
                    ${delegateName ? `<div class="agent-dag-node-agent">${agentEscape(delegateName)}</div>` : ''}
                    ${node.error_message ? `<div class="error-detail">${agentEscape(node.error_message)}</div>` : ''}
                    ${contractIssues.length ? `<div class="agent-dag-contract-issues"><strong>结果校验未通过</strong><span>${agentEscape(contractIssues.join('；'))}</span></div>` : ''}
                    ${readableOutput ? `<section class="agent-dag-node-result"><h5>本步骤结果</h5>${readableOutput}</section>` : ''}
                    <details class="agent-dag-node-technical">
                        <summary>查看技术信息</summary>
                        <div class="agent-dag-node-meta">
                            <span><em>前置步骤</em><strong>${agentEscape(depText)}</strong></span>
                            <span><em>尝试次数</em><strong>${Number(node.attempt_count || 0)} 次</strong></span>
                            <span><em>耗时</em><strong>${agentEscape(agentRunDurationLabel(node.duration_ms))}</strong></span>
                            <span><em>执行条件</em><strong>${agentEscape(node.condition || '无')}</strong></span>
                        </div>
                        ${(input || output) ? `
                            <div class="agent-dag-node-folders">
                                ${input ? `<details><summary>查看输入数据</summary><pre>${agentEscape(agentShortText(input, 2400))}</pre></details>` : ''}
                                ${output ? `<details><summary>节点输出</summary><pre>${agentEscape(agentShortText(output, 3000))}</pre></details>` : ''}
                            </div>
                        ` : ''}
                    </details>
                    ${canRerun ? `<button type="button" class="btn-secondary agent-dag-node-rerun" data-agent-dag-rerun-node="${agentEscape(node.node_key)}">只重试这一步</button>` : ''}
                </div>
            </details>
        </div>
    `;
}

function renderAgentDagRunGraph(dagNodes) {
    if (!dagNodes.length) return '';
    const NODE_W = 116, NODE_H = 36, GAP_X = 46, GAP_Y = 26, PAD = 20;
    const MIN_VIEW_W = 860, MIN_VIEW_H = 135;
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
    // 自动居中坐标计算
    const totalW = layers.length * (NODE_W + GAP_X) - GAP_X;
    const maxNodesInLayer = Math.max(...layers.map(l => l.length), 1);
    const totalH = maxNodesInLayer * (NODE_H + GAP_Y) - GAP_Y;

    const tightW = totalW + PAD * 2;
    const tightH = totalH + PAD * 2;
    const viewW = Math.max(tightW, Math.min(MIN_VIEW_W, Math.round(tightW * 1.25)));
    const viewH = Math.max(tightH, Math.min(MIN_VIEW_H, Math.round(tightH * 1.25)));

    const offsetX = Math.max(PAD, (viewW - totalW) / 2);
    const offsetY = Math.max(PAD, (viewH - totalH) / 2);

    const positions = new Map();
    layers.forEach((layer, li) => {
        layer.forEach((node, si) => {
            positions.set(node.node_key, {
                x: offsetX + li * (NODE_W + GAP_X),
                y: offsetY + si * (NODE_H + GAP_Y)
            });
        });
    });
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
        const label = agentDagNodeDisplayTitle(n).slice(0, 14);
        const statusLabel = ({ completed: '已完成', running: '运行中', error: '失败', skipped: '跳过', pending: '待执行' })[String(n.status || '').toLowerCase()] || '待执行';
        return `
            <g transform="translate(${pos.x},${pos.y})">
                <rect width="${NODE_W}" height="${NODE_H}" rx="7" ry="7" fill="${c.fill}" stroke="${c.stroke}" stroke-width="1.5" opacity="0.95"/>
                <text x="${NODE_W/2}" y="${NODE_H/2 - 2}" text-anchor="middle" fill="#ffffff" font-size="11" font-weight="700">${agentEscape(label)}</text>
                <text x="${NODE_W/2}" y="${NODE_H/2 + 10}" text-anchor="middle" fill="rgba(255,255,255,0.85)" font-size="8.5" font-weight="600">${agentEscape(statusLabel)}</text>
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
