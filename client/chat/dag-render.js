/* Agent DAG SVG 渲染辅助函数（拆自 agents-dag-editor.js） */

const DAG_ICON_SHAPES = {
    bot: [
        ['rect', { x: 4, y: 6, width: 16, height: 12, rx: 2 }],
        ['path', { d: 'M12 2v4M8 2h8M8 16h8' }],
        ['circle', { cx: 9, cy: 12, r: 1 }],
        ['circle', { cx: 15, cy: 12, r: 1 }]
    ],
    users: [
        ['path', { d: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8' }],
        ['path', { d: 'M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75' }]
    ],
    shuffle: [
        ['path', { d: 'M16 3h5v5M4 20l17-17M21 16v5h-5M15 15l6 6M4 4l5 5' }]
    ],
    code: [
        ['polyline', { points: '8 9 4 12 8 15' }],
        ['polyline', { points: '16 9 20 12 16 15' }],
        ['line', { x1: 14, y1: 5, x2: 10, y2: 19 }]
    ],
    globe: [
        ['circle', { cx: 12, cy: 12, r: 9 }],
        ['path', { d: 'M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18' }]
    ],
    search: [
        ['circle', { cx: 11, cy: 11, r: 7 }],
        ['line', { x1: 20, y1: 20, x2: 16.65, y2: 16.65 }]
    ],
    database: [
        ['ellipse', { cx: 12, cy: 5, rx: 8, ry: 3 }],
        ['path', { d: 'M4 5v6c0 1.66 3.58 3 8 3s8-1.34 8-3V5M4 11v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6' }]
    ],
    chart: [
        ['path', { d: 'M4 20V10M10 20V4M16 20v-7M22 20H2' }]
    ],
    table: [
        ['rect', { x: 3, y: 4, width: 18, height: 16, rx: 2 }],
        ['path', { d: 'M3 10h18M9 4v16M15 4v16' }]
    ],
    message: [
        ['path', { d: 'M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z' }]
    ],
    'book-open': [
        ['path', { d: 'M2 4h6a4 4 0 0 1 4 4v13a3 3 0 0 0-3-3H2zM22 4h-6a4 4 0 0 0-4 4v13a3 3 0 0 1 3-3h7z' }]
    ],
    'file-text': [
        ['path', { d: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8M8 17h8M8 9h2' }]
    ],
    plug: [
        ['path', { d: 'M12 22v-5M9 8V2M15 8V2M6 8h12v3a6 6 0 0 1-12 0z' }]
    ],
    puzzle: [
        ['path', { d: 'M19 13h-2a2 2 0 1 1 0-4h2V5a2 2 0 0 0-2-2h-4v2a2 2 0 1 1-4 0V3H5a2 2 0 0 0-2 2v4h2a2 2 0 1 1 0 4H3v4a2 2 0 0 0 2 2h4v-2a2 2 0 1 1 4 0v2h4a2 2 0 0 0 2-2z' }]
    ],
    'log-in': [
        ['path', { d: 'M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3' }]
    ],
    'log-out': [
        ['path', { d: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9' }]
    ],
    'git-branch': [
        ['line', { x1: 6, y1: 3, x2: 6, y2: 15 }],
        ['circle', { cx: 18, cy: 6, r: 3 }],
        ['circle', { cx: 6, cy: 18, r: 3 }],
        ['path', { d: 'M18 9a9 9 0 0 1-9 9' }]
    ],
    'user-check': [
        ['path', { d: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8M16 11l2 2 4-4' }]
    ],
    repeat: [
        ['path', { d: 'M17 1l4 4-4 4M3 11V9a4 4 0 0 1 4-4h14M7 23l-4-4 4-4M21 13v2a4 4 0 0 1-4 4H3' }]
    ],
    workflow: [
        ['rect', { x: 3, y: 3, width: 6, height: 6, rx: 1 }],
        ['rect', { x: 15, y: 15, width: 6, height: 6, rx: 1 }],
        ['path', { d: 'M9 6h4a5 5 0 0 1 5 5v4M15 18h-4a5 5 0 0 1-5-5V9' }]
    ],
    clock: [
        ['circle', { cx: 12, cy: 12, r: 9 }],
        ['path', { d: 'M12 7v5l3 2' }]
    ]
};

function createDagIcon(name, className = '') {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    if (className) svg.setAttribute('class', className);
    const shapes = DAG_ICON_SHAPES[name] || [];
    shapes.forEach(([tag, attrs]) => {
        const shape = document.createElementNS(SVG_NS, tag);
        Object.entries(attrs).forEach(([key, value]) => shape.setAttribute(key, String(value)));
        svg.appendChild(shape);
    });
    return svg;
}

// 每种 tool 的视觉元数据：图标、颜色主题、标签。
const DAG_NODE_VISUAL = {
    'agent.llm':      { svgIcon: 'bot',       theme: 'llm',      label: '大模型' },
    'agent.delegate': { svgIcon: 'users',     theme: 'delegate', label: '委派智能体' },
    'agent.handoff':  { svgIcon: 'shuffle',   theme: 'handoff',  label: '智能体交接' },
    'agent.code':     { svgIcon: 'code',      theme: 'code',     label: '代码执行' },
    'agent.http':     { svgIcon: 'globe',     theme: 'http',     label: 'HTTP 请求' },
    'agent.merge':    { iconText: '⊕',        theme: 'merge',    label: '变量聚合' },
    'workflow.input': { svgIcon: 'log-in',    theme: 'input',    label: '工作流输入' },
    'workflow.output':{ svgIcon: 'log-out',   theme: 'output',   label: '工作流输出' },
    'workflow.condition': { svgIcon: 'git-branch', theme: 'condition', label: '条件路由' },
    'workflow.approval': { svgIcon: 'user-check', theme: 'approval', label: '人工审批' },
    'workflow.foreach': { svgIcon: 'repeat', theme: 'loop', label: '循环 / 批处理' },
    'workflow.subworkflow': { svgIcon: 'workflow', theme: 'subflow', label: '子工作流' },
    'workflow.delay': { svgIcon: 'clock', theme: 'delay', label: '延时' },
    'rag.search':     { svgIcon: 'search',    theme: 'rag',      label: '知识检索' },
    'viz.build_chart':{ svgIcon: 'chart',     theme: 'viz',      label: '图表生成' },
    'viz.build_table':{ svgIcon: 'table',     theme: 'viz',      label: '表格展示' },
};

function dagNodeVisual(toolName) {
    const key = String(toolName || '').trim();
    if (DAG_NODE_VISUAL[key]) return DAG_NODE_VISUAL[key];
    // 模糊匹配：db.*、rag.*、sessions.*、knowledge.*、viz.*
    if (key.startsWith('db.'))         return { svgIcon: 'database',  theme: 'db',      label: '数据库' };
    if (key.startsWith('rag.'))        return { svgIcon: 'search',    theme: 'rag',     label: '知识检索' };
    if (key.startsWith('viz.'))        return { svgIcon: 'chart',     theme: 'viz',     label: '可视化' };
    if (key.startsWith('sessions.'))   return { svgIcon: 'message',   theme: 'session', label: '会话' };
    if (key.startsWith('knowledge.'))  return { svgIcon: 'book-open', theme: 'rag',     label: '知识库' };
    if (key.startsWith('report.'))     return { svgIcon: 'file-text', theme: 'report',  label: '报告' };
    if (key.startsWith('mcp.'))        return { svgIcon: 'plug',      theme: 'mcp',     label: 'MCP 工具' };
    return { iconText: '▸', theme: 'default', label: '' };
}

// 运行状态徽章：从外部通过 dagNodeRunStates 注入当前运行状态（画布实例外部写入）。
// key = node.id，value = { status, durationMs?, error? }
if (!window.dagNodeRunStates) window.dagNodeRunStates = new Map();

function createEdgePath(fromNode, toNode) {
        const startX = fromNode._x + NODE_WIDTH;
        const startY = fromNode._y + NODE_HEIGHT / 2;
        const endX = toNode._x;
        const endY = toNode._y + NODE_HEIGHT / 2;
        const c1x = startX + Math.max(40, (endX - startX) / 2);
        const c2x = endX - Math.max(40, (endX - startX) / 2);
        return `M ${startX},${startY} C ${c1x},${startY} ${c2x},${endY} ${endX},${endY}`;
    }

function makeSvgEl(tag, attrs = {}) {
        const el = document.createElementNS(SVG_NS, tag);
        Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, String(v)));
        return el;
    }

function createDagRenderController(ctx) {
const renderEdges = () => {
            ctx.edgesLayer.replaceChildren();
            const byId = new Map(ctx.spec.nodes.map(n => [n.id, n]));
            ctx.spec.nodes.forEach(node => {
                (node.dependsOn || []).forEach(depId => {
                    const from = byId.get(depId);
                    if (!from) return;
                    const selected = ctx.selectedEdge?.fromId === depId && ctx.selectedEdge?.toId === node.id;
                    const group = makeSvgEl('g', {
                        class: `pivot-dag-edge-group${selected ? ' is-selected' : ''}`,
                        'data-pivot-dag-edge-from': depId,
                        'data-pivot-dag-edge-to': node.id,
                        tabindex: '0',
                        role: 'button',
                        'aria-label': `依赖连线：${from.title || from.id} 到 ${node.title || node.id}`
                    });
                    const d = createEdgePath(from, node);
                    const hit = makeSvgEl('path', {
                        class: 'pivot-dag-edge-hit',
                        d,
                        'data-pivot-dag-edge-from': depId,
                        'data-pivot-dag-edge-to': node.id
                    });
                    const path = makeSvgEl('path', {
                        class: 'pivot-dag-edge',
                        d,
                        'data-pivot-dag-edge-from': depId,
                        'data-pivot-dag-edge-to': node.id,
                        'marker-end': 'url(#pivot-dag-arrow)'
                    });
                    group.append(hit, path);
                    const conditionLabel = node.when ? '条件' : node.condition === 'failure' ? '失败' : node.condition === 'always' ? '始终' : '';
                    if (conditionLabel) {
                        const label = makeSvgEl('text', {
                            class: 'pivot-dag-edge-label',
                            x: (from._x + NODE_WIDTH + node._x) / 2,
                            y: (from._y + node._y) / 2 + NODE_HEIGHT / 2 - 6
                        });
                        label.textContent = conditionLabel;
                        group.appendChild(label);
                    }
                    ctx.edgesLayer.appendChild(group);
                });
            });
        };

        const renderNodes = () => {
            ctx.nodesLayer.replaceChildren();
            const tools = ctx.currentTools();
            ctx.spec.nodes.forEach(node => {
                const llmNode = isLlmNode(node);
                const visual = dagNodeVisual(node.tool);
                const runState = window.dagNodeRunStates.get(node.id);
                const runStatus = runState?.status || '';
                const hasVisualIcon = Boolean(visual.svgIcon || visual.iconText);

                const group = makeSvgEl('g', {
                    class: [
                        'pivot-dag-node',
                        (ctx.isNodeSelected?.(node.id) || ctx.selectedId === node.id) ? 'is-selected' : '',
                        node.tool ? '' : 'has-warning',
                        llmNode ? 'is-llm' : '',
                        visual.theme !== 'default' ? `is-${visual.theme}` : '',
                        runStatus ? `run-${runStatus}` : ''
                    ].filter(Boolean).join(' '),
                    transform: `translate(${node._x}, ${node._y})`,
                    'data-pivot-dag-id': node.id,
                    tabindex: '0',
                    role: 'button',
                    'aria-label': `${node.title || node.id}，${visual.label || node.tool || '未选择工具'}`
                });

                group.appendChild(makeSvgEl('rect', {
                    class: 'pivot-dag-node-body',
                    width: NODE_WIDTH,
                    height: NODE_HEIGHT,
                    rx: 8,
                    ry: 8
                }));

                // 节点类型图标（左侧小圆）
                if (hasVisualIcon) {
                    const iconWrap = makeSvgEl('foreignObject', {
                        class: 'pivot-dag-node-icon-foreign',
                        x: 7,
                        y: 7,
                        width: 20,
                        height: 20
                    });
                    const iconEl = document.createElement('div');
                    iconEl.className = `pivot-dag-node-icon is-${visual.theme}`;
                    iconEl.setAttribute('aria-hidden', 'true');
                    if (visual.svgIcon) iconEl.appendChild(createDagIcon(visual.svgIcon));
                    else iconEl.textContent = visual.iconText;
                    iconWrap.appendChild(iconEl);
                    group.appendChild(iconWrap);
                }

                const title = makeSvgEl('text', {
                    class: 'pivot-dag-node-title',
                    x: hasVisualIcon ? 30 : 10,
                    y: 18
                });
                title.textContent = node.title || node.id;
                group.appendChild(title);

                const toolDisplay = buildNodeToolDisplay(tools, node.tool);
                const toolWrap = makeSvgEl('foreignObject', {
                    class: 'pivot-dag-node-tool-foreign',
                    x: 10,
                    y: 27,
                    width: NODE_WIDTH - 20,
                    height: 30
                });
                const toolBody = document.createElement('div');
                toolBody.className = `pivot-dag-node-tool ${node.tool ? '' : 'is-empty'}`;
                toolBody.title = toolDisplay.tooltip;
                const toolArrow = document.createElement('span');
                toolArrow.className = 'pivot-dag-node-tool-arrow';
                toolArrow.textContent = '→';
                const toolName = document.createElement('span');
                toolName.className = 'pivot-dag-node-tool-name';
                toolName.textContent = toolDisplay.title;
                toolBody.appendChild(toolArrow);
                toolBody.appendChild(toolName);
                if (toolDisplay.shortId) {
                    const toolId = document.createElement('span');
                    toolId.className = 'pivot-dag-node-tool-id';
                    toolId.textContent = toolDisplay.shortId;
                    toolBody.appendChild(toolId);
                }
                toolWrap.appendChild(toolBody);
                group.appendChild(toolWrap);

                // 运行状态徽章：右上角叠加
                if (runStatus) {
                    const badgeWrap = makeSvgEl('foreignObject', {
                        class: 'pivot-dag-run-badge-foreign',
                        x: NODE_WIDTH - 24,
                        y: -8,
                        width: 28,
                        height: 20
                    });
                    const badge = document.createElement('div');
                    badge.className = `pivot-dag-run-badge is-${runStatus}`;
                    if (runStatus === 'running') {
                        const spinner = document.createElement('span');
                        spinner.className = 'pivot-dag-run-spinner';
                        badge.appendChild(spinner);
                    } else if (runStatus === 'completed') {
                        badge.textContent = '✓';
                        if (runState.durationMs) badge.title = `${(runState.durationMs / 1000).toFixed(1)}s`;
                    } else if (runStatus === 'error' || runStatus === 'continued_error') {
                        badge.textContent = '✗';
                        if (runState.error) badge.title = runState.error;
                    } else if (runStatus === 'skipped') {
                        badge.textContent = '↷';
                        badge.title = '已跳过';
                    }
                    badgeWrap.appendChild(badge);
                    group.appendChild(badgeWrap);

                    // 运行中：节点边框闪烁动画
                    if (runStatus === 'running') {
                        const pulseRect = makeSvgEl('rect', {
                            class: 'pivot-dag-node-pulse',
                            width: NODE_WIDTH,
                            height: NODE_HEIGHT,
                            rx: 8,
                            ry: 8
                        });
                        group.insertBefore(pulseRect, group.firstChild);
                    }
                }

                // 出端口（拖出去创建依赖）
                const outPort = makeSvgEl('circle', {
                    class: 'pivot-dag-port pivot-dag-port-out',
                    cx: NODE_WIDTH,
                    cy: NODE_HEIGHT / 2,
                    r: 5,
                    'data-pivot-dag-port': 'out',
                    'data-pivot-dag-id': node.id
                });
                group.appendChild(outPort);
                // 入端口（接收依赖的连接落点）
                const inPort = makeSvgEl('circle', {
                    class: 'pivot-dag-port pivot-dag-port-in',
                    cx: 0,
                    cy: NODE_HEIGHT / 2,
                    r: 5,
                    'data-pivot-dag-port': 'in',
                    'data-pivot-dag-id': node.id
                });
                group.appendChild(inPort);
                ctx.nodesLayer.appendChild(group);
            });
        };

        return { renderEdges, renderNodes };
    }
