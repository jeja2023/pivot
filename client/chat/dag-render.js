/* Agent DAG SVG 渲染辅助函数（拆自 agents-dag-editor.js） */



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
                    const path = makeSvgEl('path', {
                        class: 'pivot-dag-edge',
                        d: createEdgePath(from, node),
                        'marker-end': 'url(#pivot-dag-arrow)'
                    });
                    ctx.edgesLayer.appendChild(path);
                });
            });
        };

        const renderNodes = () => {
            ctx.nodesLayer.replaceChildren();
            const tools = ctx.currentTools();
            ctx.spec.nodes.forEach(node => {
                const group = makeSvgEl('g', {
                    class: `pivot-dag-node ${ctx.selectedId === node.id ? 'is-selected' : ''} ${node.tool ? '' : 'has-warning'}`,
                    transform: `translate(${node._x}, ${node._y})`,
                    'data-pivot-dag-id': node.id
                });
                group.appendChild(makeSvgEl('rect', {
                    class: 'pivot-dag-node-body',
                    width: NODE_WIDTH,
                    height: NODE_HEIGHT,
                    rx: 8,
                    ry: 8
                }));
                const title = makeSvgEl('text', { class: 'pivot-dag-node-title', x: 10, y: 18 });
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
