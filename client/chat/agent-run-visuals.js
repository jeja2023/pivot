/* eslint-disable no-undef, no-unused-vars */
// Agent 运行可视化 Agent run visuals
// Split from agent-run-renderers.js.
// Agent run visual outputs, DAG graph, and progress helpers.
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
    return agentLlmOutputText(node.output);
}

function agentDagNodeReadableOutputMarkup(node) {
    const text = agentDagNodeReadableText(node);
    if (!text) return '';
    const cleanText = stripAgentWorkflowReportHeading(text);
    const parsed = agentParsePayload(cleanText);
    if (parsed && typeof parsed === 'object') {
        return `<div class="agent-dag-node-readable-output is-json"><pre>${agentEscape(JSON.stringify(parsed, null, 2))}</pre></div>`;
    }
    return `<div class="agent-dag-node-readable-output is-markdown">${renderMarkdown(normalizeAgentMarkdown(cleanText))}</div>`;
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
