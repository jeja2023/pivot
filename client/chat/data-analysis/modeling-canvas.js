/* global MouseEvent */
(function () {
    'use strict';
    const app = window.Pivot.legacy.PivotDataAnalysis, m = app.modeling, { state } = m, { esc } = app;
    const byId = id => document.getElementById(id);
    const namespace = 'http://www.w3.org/2000/svg';
    const CARD_WIDTH = 224, CARD_HEIGHT = 76, PORT_Y = 38;
    let gesture = null, draggedItem = null, connection = null, zoom = 1, suppressClickUntil = 0;

    const canEdit = () => state.selected?.isOwner && state.selected.lifecycle !== 'archived' && Boolean(state.draft);
    function editable() { if (!canEdit()) throw new Error('当前模型只读，请由所有者编辑未归档草稿。'); }
    const safe = run => { try { return run(); } catch (error) { app.toast(error.message || '画布操作未完成，请重试。', 'error'); } };

    const flowNodes = () => state.flowGraph?.nodes || [];
    const flowEdges = () => state.flowGraph?.edges || [];
    const isFlowNode = node => Boolean(node && node.kind);
    const findAnyNode = nodeId => state.draft?.nodes?.find(item => item.id === nodeId) || flowNodes().find(item => item.id === nodeId) || null;

    const position = (node, index = (state.draft?.nodes || []).indexOf(node)) => {
        if (isFlowNode(node)) {
            return {
                x: Math.max(20, Math.min(6000, node.layout?.x ?? 345)),
                y: Math.max(20, Math.min(6000, node.layout?.y ?? 140))
            };
        }
        const safeIdx = Math.max(0, index);
        return {
            x: Math.max(20, Math.min(6000, (state.canvasLayout[node.id]?.x ?? node.layout?.x) ?? 35 + safeIdx % 3 * 310)),
            y: Math.max(20, Math.min(6000, (state.canvasLayout[node.id]?.y ?? node.layout?.y) ?? 35 + Math.floor(safeIdx / 3) * 150))
        };
    };

    const getNodeCanvasPosition = nodeId => {
        const target = findAnyNode(nodeId);
        return target ? position(target) : { x: 35, y: 35 };
    };

    const allNodes = () => [...(state.draft?.nodes || []), ...flowNodes()];

    const bounds = () => {
        const list = allNodes();
        if (!list.length) return { width: 860, height: 480 };
        return {
            width: Math.max(860, ...list.map((node, idx) => position(node, idx).x + CARD_WIDTH + 96)),
            height: Math.max(480, ...list.map((node, idx) => position(node, idx).y + CARD_HEIGHT + 84))
        };
    };

    function assertDataset(datasetId) {
        editable();
        if (!app.state.datasets.some(dataset => dataset.id === datasetId)) throw new Error('该数据集已不可用，请刷新来源后重试。');
        if (state.draft.nodes.some(node => node.datasetId === datasetId)) throw new Error('该数据集已在模型表中；如需复用同一表做分支处理，请拖入「数据输入」算子。');
        if (state.draft.nodes.length >= 9) throw new Error('当前模型最多包含一个事实表和八张维度表。');
    }

    function assertRelation(leftNodeId, rightNodeId, editingId = '') {
        editable();
        const left = state.draft.nodes.find(node => node.id === leftNodeId), right = state.draft.nodes.find(node => node.id === rightNodeId);
        if (!left || !right || left === right) throw new Error('请从一张父表连接到另一张维度表，不能连接自身。');
        if (right.role !== 'dimension') throw new Error('关联应从父表指向维度表，事实表不能作为关联终点。');
        const relations = state.draft.relations.filter(relation => relation.id !== editingId);
        if (relations.some(relation => relation.rightNodeId === rightNodeId)) throw new Error('该维度已有父关系，请先编辑或删除原关系，不能建立重复路径。');
        if (relations.length >= 8) throw new Error('当前模型最多包含八条有效关联。');
        const visited = new Set(), pending = [rightNodeId];
        while (pending.length) {
            const id = pending.pop();
            if (id === leftNodeId) throw new Error('该连接会形成环路，请调整父表和关联方向。');
            if (visited.has(id)) continue;
            visited.add(id);
            pending.push(...relations.filter(relation => relation.leftNodeId === id).map(relation => relation.rightNodeId));
        }
    }

    function point(svg, clientX, clientY) {
        const value = svg.createSVGPoint();
        value.x = clientX;
        value.y = clientY;
        return value.matrixTransform(svg.getScreenCTM().inverse());
    }

    const portPoint = (node, direction, custom) => {
        const p = custom || position(node);
        return { x: p.x + (direction === 'out' ? CARD_WIDTH : 0), y: p.y + PORT_Y };
    };

    function line(left, right) {
        const bend = Math.max(54, Math.abs(right.x - left.x) / 2);
        return `M${left.x} ${left.y} C${left.x + bend} ${left.y},${right.x - bend} ${right.y},${right.x} ${right.y}`;
    }

    function pairPoints(fromId, toId, moving) {
        const left = findAnyNode(fromId), right = findAnyNode(toId);
        if (!left || !right) return null;
        return [
            portPoint(left, 'out', moving?.id === left.id ? moving.position : null),
            portPoint(right, 'in', moving?.id === right.id ? moving.position : null)
        ];
    }

    function edgeLabelCenter(points) {
        return { x: Math.round((points[0].x + points[1].x) / 2), y: Math.round((points[0].y + points[1].y) / 2 - 12) };
    }

    function updateEdges(svg, moving) {
        for (const relation of state.draft.relations) {
            const edge = Array.from(svg.querySelectorAll('[data-modeling-graph-relation]')).find(el => el.dataset.modelingGraphRelation === relation.id);
            const points = pairPoints(relation.leftNodeId, relation.rightNodeId, moving);
            if (!edge || !points) continue;
            edge.querySelectorAll('path').forEach(path => path.setAttribute('d', line(...points)));
            const center = edgeLabelCenter(points);
            const pill = edge.querySelector('.modeling-edge-pill');
            if (pill) { pill.setAttribute('x', center.x - 54); pill.setAttribute('y', center.y - 13); }
            const label = edge.querySelector('text');
            if (label) { label.setAttribute('x', center.x); label.setAttribute('y', center.y + 1); }
        }
        for (const fEdge of flowEdges()) {
            const edge = Array.from(svg.querySelectorAll('[data-modeling-flow-edge]')).find(el => el.dataset.modelingFlowEdge === fEdge.id);
            const points = pairPoints(fEdge.fromNodeId, fEdge.toNodeId, moving);
            if (!edge || !points) continue;
            edge.querySelectorAll('path').forEach(path => path.setAttribute('d', line(...points)));
            const center = edgeLabelCenter(points);
            const pill = edge.querySelector('.modeling-edge-pill');
            if (pill) { pill.setAttribute('x', center.x - 36); pill.setAttribute('y', center.y - 13); }
            const label = edge.querySelector('text');
            if (label) { label.setAttribute('x', center.x); label.setAttribute('y', center.y + 1); }
        }
    }

    function nodeHasInputPort(node) {
        if (isFlowNode(node)) {
            const spec = m.OPERATOR_MAP?.get(node.kind);
            return spec ? Boolean(spec.acceptsInput) : node.kind !== 'source';
        }
        return node.role === 'dimension';
    }

    function renderNodeCard(node, index, editing) {
        const p = position(node, index);
        const isFlow = isFlowNode(node);
        const spec = isFlow ? m.OPERATOR_MAP?.get(node.kind) : null;
        const badgeText = isFlow ? (spec?.badge || '算子') : (node.role === 'fact' ? '事实表' : '维度表');
        const badgeWidth = Math.max(42, badgeText.length * 12 + 12);
        const maxTitleChars = badgeWidth > 48 ? 11 : 13;
        const displayTitle = String(node.name || '').length > maxTitleChars
            ? `${String(node.name).slice(0, maxTitleChars)}…`
            : String(node.name || '');

        let subText = '';
        if (isFlow) {
            subText = m.operatorSummary ? m.operatorSummary(node) : (spec?.label || '算子节点');
        } else {
            const colCount = m.columns(node.id).length;
            const keyInfo = node.grainKeys?.length ? `已设 ${node.grainKeys.length} 个主键` : (node.role === 'fact' ? '待设粒度键' : '待设主键');
            subText = `${colCount} 列 · ${keyInfo}`;
        }

        const isActiveOut = connection && connection.nodeId === node.id;
        const inPort = nodeHasInputPort(node)
            ? `<circle class="modeling-canvas-port" cx="0" cy="${PORT_Y}" r="6" tabindex="${editing ? 0 : -1}" role="button" aria-label="${esc(`连接到${node.name}`)}" aria-disabled="${!editing}" data-canvas-port="in" data-canvas-node="${esc(node.id)}" data-canvas-field=""/>`
            : '';
        const outPort = `<circle class="modeling-canvas-port${isActiveOut ? ' is-active-port' : ''}" cx="${CARD_WIDTH}" cy="${PORT_Y}" r="6" tabindex="${editing ? 0 : -1}" role="button" aria-label="${esc(`从${node.name}发起连线`)}" aria-disabled="${!editing}" data-canvas-port="out" data-canvas-node="${esc(node.id)}" data-canvas-field=""/>`;

        const cls = [
            'modeling-graph-node',
            isFlow ? `is-operator is-op-${node.kind}` : (node.role === 'fact' ? 'is-fact' : 'is-dimension'),
            node.id === state.selectedNodeId ? 'is-selected' : '',
            state.previewOpen && state.previewNodeId === node.id ? 'is-previewing' : ''
        ].filter(Boolean).join(' ');

        return `<g class="${cls}" transform="translate(${p.x},${p.y})" tabindex="0" role="button" aria-label="${esc(`${node.name}，${badgeText}，点击打开配置抽屉，方向键移动`)}" data-modeling-graph-node="${esc(node.id)}">
            <rect class="modeling-node-card" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" rx="10"/>
            <rect class="modeling-node-accent" x="1" y="1" width="5" height="${CARD_HEIGHT - 2}" rx="3"/>
            <rect class="modeling-node-badge-bg" x="14" y="13" width="${badgeWidth}" height="20" rx="5"/>
            <text class="modeling-node-badge-text" x="${14 + Math.round(badgeWidth / 2)}" y="27" text-anchor="middle">${esc(badgeText)}</text>
            <title>${esc(`${badgeText}：${node.name}（${subText}）`)}</title>
            <text class="modeling-canvas-heading" x="${22 + badgeWidth}" y="27">${esc(displayTitle)}</text>
            <text class="modeling-canvas-subtext" x="14" y="56">${esc(subText.slice(0, 24))}</text>
            ${inPort}${outPort}
        </g>`;
    }

    function graph() {
        const size = bounds(), editing = canEdit();
        const relationLinks = state.draft.relations.map(relation => {
            const points = pairPoints(relation.leftNodeId, relation.rightNodeId);
            if (!points) return '';
            const label = `${relation.joinType === 'inner' ? '内关联' : '左关联'} · ${relation.cardinality === 'one_to_one' ? '一对一' : '多对一'}`;
            const keys = relation.keyPairs.map(pair => `${m.fieldName(relation.leftNodeId, pair.leftFieldKey)} = ${m.fieldName(relation.rightNodeId, pair.rightFieldKey)}`).join('，');
            const center = edgeLabelCenter(points);
            return `<g class="modeling-canvas-edge" data-modeling-graph-relation="${esc(relation.id)}" tabindex="0" role="button" aria-label="${esc(`${m.nodeName(relation.leftNodeId)}到${m.nodeName(relation.rightNodeId)}，${label}，${keys}`)}"><title>${esc(`${label}：${keys}（点击编辑关联，按 Delete 删除）`)}</title><path class="modeling-canvas-edge-hit" d="${line(...points)}"/><path class="modeling-canvas-edge-line" d="${line(...points)}" marker-end="url(#modeling-arrow)"/><rect class="modeling-edge-pill" x="${center.x - 54}" y="${center.y - 13}" width="108" height="20" rx="10"/><text x="${center.x}" y="${center.y + 1}" text-anchor="middle">${esc(label)}</text></g>`;
        }).join('');

        const operatorLinks = flowEdges().map(fEdge => {
            const points = pairPoints(fEdge.fromNodeId, fEdge.toNodeId);
            if (!points) return '';
            const fromTitle = m.getAnyNodeName ? m.getAnyNodeName(fEdge.fromNodeId) : fEdge.fromNodeId;
            const toTitle = m.getAnyNodeName ? m.getAnyNodeName(fEdge.toNodeId) : fEdge.toNodeId;
            const center = edgeLabelCenter(points);
            return `<g class="modeling-canvas-edge is-flow-edge" data-modeling-flow-edge="${esc(fEdge.id)}" tabindex="0" role="button" aria-label="${esc(`数据流：${fromTitle}到${toTitle}`)}"><title>${esc(`算子流转：${fromTitle} → ${toTitle}（点击查看下游算子，按 Delete 断开）`)}</title><path class="modeling-canvas-edge-hit" d="${line(...points)}"/><path class="modeling-canvas-edge-line" d="${line(...points)}" marker-end="url(#modeling-arrow)"/><rect class="modeling-edge-pill" x="${center.x - 36}" y="${center.y - 13}" width="72" height="20" rx="10"/><text x="${center.x}" y="${center.y + 1}" text-anchor="middle">数据流转</text></g>`;
        }).join('');

        const defCards = state.draft.nodes.map((node, index) => renderNodeCard(node, index, editing)).join('');
        const opCards = flowNodes().map((node, index) => renderNodeCard(node, state.draft.nodes.length + index, editing)).join('');

        return `<svg id="modeling-graph" class="modeling-graph" width="${Math.round(size.width * zoom)}" height="${Math.round(size.height * zoom)}" viewBox="0 0 ${size.width} ${size.height}" preserveAspectRatio="xMinYMin meet" role="group" aria-label="可视化数据建模画布；点击节点打开右侧配置抽屉，拖动端点建立连线"><defs><marker id="modeling-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0 0 L8 4 L0 8 Z"/></marker></defs>${relationLinks}${operatorLinks}${defCards}${opCards}</svg>`;
    }

    function palette() {
        const editing = canEdit();
        const used = new Set(state.draft.nodes.map(node => node.datasetId));
        const keyword = String(state.datasetSearch || '').trim().toLocaleLowerCase();
        const filteredDatasets = (app.state.datasets || []).filter(ds => !keyword || String(ds.name || '').toLocaleLowerCase().includes(keyword));

        const opButtons = (m.OPERATOR_SPECS || []).map(spec => {
            return `<button class="btn-secondary modeling-op-item" type="button" draggable="${editing}" data-canvas-operator="${esc(spec.kind)}"${editing ? '' : ' disabled'} title="${esc(`${spec.label}：${spec.desc}（可拖入画布或点击直接添加）`)}">
                <span class="modeling-op-badge">${esc(spec.badge)}</span>
                <span class="modeling-op-label">${esc(spec.label)}</span>
            </button>`;
        }).join('');

        const dsButtons = filteredDatasets.map(dataset => {
            const inModel = used.has(dataset.id);
            const colCount = Array.isArray(dataset.columns) && dataset.columns.length ? `${dataset.columns.length} 列` : '';
            return `<button class="btn-secondary modeling-source-item${inModel ? ' is-used' : ''}" type="button" draggable="${editing && !inModel}" data-canvas-action="add-dataset" data-canvas-dataset="${esc(dataset.id)}"${!editing || inModel ? ' disabled' : ''} title="${esc(inModel ? `${dataset.name}（已在模型表中）` : `拖拽到画布或点击添加「${dataset.name}」为维度表`)}">
                <span class="modeling-source-name">${esc(dataset.name)}</span>
                <span class="modeling-source-tag">${esc(inModel ? '已加入' : colCount || '+ 维度')}</span>
            </button>`;
        }).join('');

        return `<div class="modeling-rail-section">
                <div class="modeling-rail-head">
                    <h5>内置算子与 SQL</h5>
                    <span class="modeling-rail-count">拖拽或点击</span>
                </div>
                <div class="modeling-op-grid">${opButtons}</div>
            </div>
            <div class="modeling-rail-section modeling-palette-datasets">
                <div class="modeling-rail-head">
                    <h5>可用数据集</h5>
                    <span class="modeling-rail-count">${(app.state.datasets || []).length} 个</span>
                </div>
                ${(app.state.datasets || []).length > 4 ? `<input id="modeling-dataset-search" class="form-input modeling-compact-search" type="search" value="${esc(state.datasetSearch || '')}" placeholder="搜索数据集名称…" aria-label="搜索数据集名称">` : ''}
                <div class="modeling-canvas-sources">${dsButtons || '<div class="modeling-empty-inline"><p>暂无匹配的数据集</p><button class="btn-secondary" type="button" data-modeling-action="goto-analysis">去上传数据集</button></div>'}</div>
            </div>`;
    }

    function toolbar() {
        const editing = canEdit();
        const fact = state.draft?.nodes?.find(node => node.role === 'fact');
        const grainReady = Boolean(state.draft?.grainDescription && fact?.grainKeys?.length);
        const targetTableId = state.draft?.nodes?.some(n => n.id === state.selectedNodeId) ? state.selectedNodeId : (fact?.id || '');
        return `<div class="modeling-canvas-toolbar">
            <div class="modeling-canvas-actions">
                <button class="btn-secondary" type="button" data-modeling-action="toggle-palette" title="展开或收起左侧算子与数据集面板">${state.paletteCollapsed ? '展开组件栏' : '收起组件栏'}</button>
                <button class="btn-secondary${!grainReady && fact ? ' modeling-grain-pill' : ''}" type="button" data-modeling-action="node" data-modeling-id="${esc(targetTableId)}"${editing ? '' : ' disabled'}>${grainReady ? '表与粒度' : '待设主表粒度'}</button>
                <button class="btn-secondary" type="button" data-modeling-action="add-node"${editing ? '' : ' disabled'}>+ 维度表</button>
                <button class="btn-secondary" type="button" data-modeling-action="relation"${editing ? '' : ' disabled'}>+ 表关联</button>
            </div>
            <span id="modeling-canvas-hint" class="modeling-canvas-hint" role="status" aria-live="polite">点击节点在右侧抽屉配置属性与函数；拖动节点右侧圆点到目标左侧圆点建立关联或算子流转。</span>
            <div class="modeling-canvas-zoom-group">
                <button class="btn-secondary${state.previewOpen ? ' is-selected' : ''}" type="button" data-modeling-action="toggle-preview" title="打开或关闭底部节点实时数据运行预览">数据预览</button>
                ${state.nodeJobs?.length ? '<button class="btn-secondary" type="button" data-modeling-action="show-node-jobs">节点任务</button>' : ''}
                <button class="btn-secondary" type="button" data-canvas-action="zoom-out" aria-label="缩小关系图" title="缩小画布">缩小</button>
                <span id="modeling-canvas-zoom" class="modeling-zoom-label">${Math.round(zoom * 100)}%</span>
                <button class="btn-secondary" type="button" data-canvas-action="zoom-in" aria-label="放大关系图" title="放大画布">放大</button>
                <button class="btn-secondary" type="button" data-canvas-action="fit" title="缩放至适合当前视口">适合视口</button>
                <button class="btn-secondary" type="button" data-canvas-action="arrange"${editing ? '' : ' disabled'} title="自动排列画布所有节点位置">自动整理</button>
            </div>
        </div>`;
    }

    function hint(text) {
        const element = byId('modeling-canvas-hint');
        if (element) element.textContent = text;
    }

    function connectNodes(from, target) {
        editable();
        connection = null;
        const fromNode = findAnyNode(from.nodeId);
        const targetNode = findAnyNode(target.nodeId);
        if (!fromNode || !targetNode) throw new Error('连线端点对应的节点不存在。');
        if (isFlowNode(targetNode)) {
            m.connectFlowEdge(from.nodeId, target.nodeId);
            hint(`已连接「${fromNode.name}」→「${targetNode.name}」，可在右侧抽屉配置算子或点击运行预览。`);
            return;
        }
        if (isFlowNode(fromNode)) {
            throw new Error('算子节点请连接到下游算子，或点击「保存输出为数据集」后再添加为模型维度表。');
        }
        assertRelation(from.nodeId, target.nodeId);
        m.editRelation('', { leftNodeId: from.nodeId, rightNodeId: target.nodeId, leftFieldKey: from.fieldKey, rightFieldKey: target.fieldKey });
    }

    const portData = element => ({ nodeId: element.dataset.canvasNode, fieldKey: element.dataset.canvasField || '' });

    function saveMovedPosition(node, nextPos) {
        if (isFlowNode(node)) {
            node.layout = { x: nextPos.x, y: nextPos.y };
        } else {
            state.canvasLayout[node.id] = { x: nextPos.x, y: nextPos.y };
        }
    }

    function cancelGesture({ preserveDrag = false } = {}) {
        if (gesture?.kind === 'move') {
            const p = gesture.original;
            gesture.element.setAttribute('transform', `translate(${p.x},${p.y})`);
            updateEdges(gesture.svg);
        }
        gesture?.preview?.remove();
        gesture = null;
        connection = null;
        if (!preserveDrag) draggedItem = null;
        byId('modeling-graph')?.querySelectorAll?.('.is-connection-target,.is-active-port').forEach(element => {
            element.classList.remove('is-connection-target', 'is-active-port');
        });
        document.querySelector?.('.modeling-graph-container')?.classList.remove('is-drag-over', 'is-panning');
    }

    function bind(root) {
        root.addEventListener('dragstart', event => {
            const dsBtn = event.target.closest('[data-canvas-dataset]');
            if (dsBtn && !dsBtn.disabled) {
                safe(() => {
                    assertDataset(dsBtn.dataset.canvasDataset);
                    draggedItem = { type: 'dataset', id: dsBtn.dataset.canvasDataset, current: m.capture('canvas-drag') };
                    event.dataTransfer.setData('application/x-pivot-analysis-dataset', draggedItem.id);
                    event.dataTransfer.effectAllowed = 'copy';
                });
                return;
            }
            const opBtn = event.target.closest('[data-canvas-operator]');
            if (opBtn && !opBtn.disabled) {
                safe(() => {
                    editable();
                    draggedItem = { type: 'operator', kind: opBtn.dataset.canvasOperator, current: m.capture('canvas-drag') };
                    event.dataTransfer.setData('application/x-pivot-modeling-operator', draggedItem.kind);
                    event.dataTransfer.effectAllowed = 'copy';
                });
            }
        });

        root.addEventListener('dragover', event => {
            const container = event.target.closest('.modeling-graph-container');
            if (draggedItem?.current() && container) {
                event.preventDefault();
                event.dataTransfer.dropEffect = 'copy';
                container.classList.add('is-drag-over');
            }
        });

        root.addEventListener('dragleave', event => {
            const container = event.target.closest('.modeling-graph-container');
            if (container && !container.contains(event.relatedTarget)) container.classList.remove('is-drag-over');
        });

        root.addEventListener('drop', event => {
            if (!event.target.closest('.modeling-graph-container') || !draggedItem) return;
            event.preventDefault();
            const dragged = draggedItem, svg = byId('modeling-graph'), p = point(svg, event.clientX, event.clientY);
            const dropLayout = { x: Math.round(Math.max(20, Math.min(6000, p.x - 40))), y: Math.round(Math.max(20, Math.min(6000, p.y - 24))) };
            cancelGesture();
            if (!dragged.current()) return;
            safe(() => {
                if (dragged.type === 'dataset' && event.dataTransfer.getData('application/x-pivot-analysis-dataset') === dragged.id) {
                    assertDataset(dragged.id);
                    m.editNode('', { datasetId: dragged.id, layout: dropLayout });
                } else if (dragged.type === 'operator' && event.dataTransfer.getData('application/x-pivot-modeling-operator') === dragged.kind) {
                    editable();
                    m.addFlowOperator(dragged.kind, { layout: dropLayout, fromDrag: true });
                }
            });
        });

        root.addEventListener('dragend', () => cancelGesture());

        root.addEventListener('dblclick', event => {
            const element = event.target.closest?.('[data-modeling-graph-node]');
            if (!element || event.target.closest?.('[data-canvas-port]') || !canEdit()) return;
            event.preventDefault();
            const nodeId = element.dataset.modelingGraphNode;
            safe(() => {
                editable();
                if (m.getFlowNode?.(nodeId)) {
                    state.selectedNodeId = nodeId;
                    state.drawerMode = 'node';
                    state.drawerOpen = true;
                    m.render();
                } else {
                    m.editNode(nodeId);
                }
            });
        });

        root.addEventListener('pointerdown', event => {
            if (event.button !== 0) return;
            const svg = byId('modeling-graph');
            if (!svg || !event.target.closest?.('.modeling-graph-container')) return;
            const element = event.target.closest?.('[data-modeling-graph-node]');
            if (!element) {
                if (event.target.closest?.('[data-modeling-graph-relation],[data-modeling-flow-edge]')) return;
                const container = svg.parentElement;
                if (!container) return;
                if (gesture) cancelGesture();
                gesture = { kind: 'pan', svg, container, startX: event.clientX, startY: event.clientY, scrollLeft: container.scrollLeft, scrollTop: container.scrollTop, pointerId: event.pointerId, moved: false };
                container.classList.add('is-panning');
                svg.setPointerCapture?.(event.pointerId);
                return;
            }
            if (!canEdit()) return;
            const p = point(svg, event.clientX, event.clientY), port = event.target.closest('[data-canvas-port]');
            if (port?.dataset.canvasPort === 'in') return;
            if (gesture) cancelGesture();
            event.preventDefault();
            element.focus({ preventScroll: true });
            const node = findAnyNode(element.dataset.modelingGraphNode);
            if (!node) return;
            gesture = {
                kind: port ? 'connect' : 'move',
                svg,
                element,
                node,
                original: position(node),
                start: p,
                clientX: event.clientX,
                clientY: event.clientY,
                pointerId: event.pointerId,
                current: m.capture('canvas-pointer'),
                moved: false,
                from: port && portData(port)
            };
            if (port) {
                gesture.preview = document.createElementNS(namespace, 'path');
                gesture.preview.classList.add('modeling-canvas-preview');
                svg.appendChild(gesture.preview);
            }
            svg.setPointerCapture(event.pointerId);
        });

        root.addEventListener('pointermove', event => {
            if (!gesture || gesture.pointerId !== event.pointerId) return;
            if (gesture.kind === 'pan') {
                const dx = event.clientX - gesture.startX, dy = event.clientY - gesture.startY;
                gesture.moved ||= Math.abs(dx) + Math.abs(dy) > 4;
                gesture.container.scrollLeft = gesture.scrollLeft - dx;
                gesture.container.scrollTop = gesture.scrollTop - dy;
                return;
            }
            if (!gesture.current() || !canEdit()) { cancelGesture(); return; }
            const p = point(gesture.svg, event.clientX, event.clientY);
            gesture.moved ||= Math.abs(event.clientX - gesture.clientX) + Math.abs(event.clientY - gesture.clientY) > 4;
            if (gesture.kind === 'connect') {
                gesture.preview.setAttribute('d', line(portPoint(gesture.node, 'out'), p));
                gesture.svg.querySelectorAll('.is-connection-target').forEach(el => el.classList.remove('is-connection-target'));
                document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-modeling-graph-node]')?.classList.add('is-connection-target');
            } else {
                gesture.next = {
                    x: Math.round(Math.max(20, Math.min(6000, gesture.original.x + p.x - gesture.start.x))),
                    y: Math.round(Math.max(20, Math.min(6000, gesture.original.y + p.y - gesture.start.y)))
                };
                gesture.element.setAttribute('transform', `translate(${gesture.next.x},${gesture.next.y})`);
                updateEdges(gesture.svg, { id: gesture.node.id, position: gesture.next });
            }
        });

        root.addEventListener('pointerup', event => {
            if (!gesture || gesture.pointerId !== event.pointerId) return;
            if (gesture.kind === 'pan') {
                gesture.container.classList.remove('is-panning');
                if (gesture.svg.hasPointerCapture?.(event.pointerId)) gesture.svg.releasePointerCapture(event.pointerId);
                const wasMoved = gesture.moved;
                if (wasMoved) suppressClickUntil = Date.now() + 180;
                gesture = null;
                if (!wasMoved && state.drawerOpen && event.target.closest?.('.modeling-graph-container') && !event.target.closest?.('[data-modeling-graph-node],[data-modeling-graph-relation],[data-modeling-flow-edge],[data-canvas-port]')) {
                    state.drawerOpen = false;
                    m.render();
                }
                return;
            }
            const current = gesture, target = document.elementFromPoint(event.clientX, event.clientY);
            gesture = null;
            current.preview?.remove();
            current.svg.querySelectorAll('.is-connection-target').forEach(el => el.classList.remove('is-connection-target'));
            if (current.svg.hasPointerCapture(event.pointerId)) current.svg.releasePointerCapture(event.pointerId);
            if (!current.current() || !canEdit()) return;
            if (!current.moved) {
                if (current.kind === 'connect') {
                    connection = current.from;
                    hint('已选中输出圆点：请点击目标节点左侧输入圆点完成连线，或按 Esc 取消。');
                } else if (current.kind === 'move' && current.node) {
                    suppressClickUntil = Date.now() + 180;
                    state.selectedNodeId = current.node.id;
                    state.selectedRelationId = null;
                    state.selectedFlowEdgeId = null;
                    state.fieldSearch = '';
                    state.drawerMode = 'node';
                    state.drawerOpen = true;
                    m.render();
                    if (state.previewOpen) void m.runNodePreview?.(state.selectedNodeId).catch(() => {});
                }
                return;
            }
            suppressClickUntil = Date.now() + 250;
            if (!target?.closest('.modeling-graph-container')) {
                current.element.setAttribute('transform', `translate(${current.original.x},${current.original.y})`);
                updateEdges(current.svg);
                hint('拖拽已取消，原布局与连线保持不变。');
                return;
            }
            if (current.kind === 'move') {
                saveMovedPosition(current.node, current.next);
                state.selectedNodeId = current.node.id;
                m.changed();
                m.render();
            } else {
                safe(() => {
                    const port = target.closest('[data-canvas-port="in"]'), nodeEl = target.closest('[data-modeling-graph-node]');
                    if (!nodeEl) { hint('未落到目标节点上，连线未变更。'); return; }
                    connectNodes(current.from, port ? portData(port) : { nodeId: nodeEl.dataset.modelingGraphNode, fieldKey: '' });
                });
            }
        });

        root.addEventListener('pointercancel', () => cancelGesture({ preserveDrag: Boolean(draggedItem) }));
        root.addEventListener('lostpointercapture', () => { if (gesture) cancelGesture(); });

        root.addEventListener('click', event => {
            const canvas = event.target.closest('[data-canvas-action],[data-canvas-port],[data-modeling-graph-relation],[data-modeling-flow-edge]');
            if (!canvas) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            if (Date.now() < suppressClickUntil) return;
            safe(() => {
                if (canvas.dataset.modelingGraphRelation) {
                    editable();
                    m.editRelation(canvas.dataset.modelingGraphRelation);
                    return;
                }
                if (canvas.dataset.modelingFlowEdge) {
                    const fEdge = flowEdges().find(item => item.id === canvas.dataset.modelingFlowEdge);
                    if (fEdge) {
                        state.selectedNodeId = fEdge.toNodeId;
                        state.drawerMode = 'node';
                        state.drawerOpen = true;
                        m.render();
                    }
                    return;
                }
                if (canvas.dataset.canvasPort) {
                    editable();
                    if (canvas.dataset.canvasPort === 'out') {
                        connection = portData(canvas);
                        byId('modeling-graph')?.querySelectorAll?.('.is-active-port').forEach(el => el.classList.remove('is-active-port'));
                        canvas.classList.add('is-active-port');
                        hint('已选中输出端点：请点击目标节点左侧输入圆点完成连接，或按 Esc 取消。');
                    } else if (connection) {
                        connectNodes(connection, portData(canvas));
                    } else {
                        hint('请先点击上游节点右侧的输出圆点，再点击目标节点左侧输入圆点。');
                    }
                    return;
                }
                const action = canvas.dataset.canvasAction;
                if (action === 'add-dataset') {
                    assertDataset(canvas.dataset.canvasDataset);
                    m.editNode('', { datasetId: canvas.dataset.canvasDataset });
                } else if (action === 'arrange') {
                    editable();
                    state.draft.nodes.forEach((node, index) => {
                        state.canvasLayout[node.id] = { x: 35 + index % 3 * 310, y: 35 + Math.floor(index / 3) * 150 };
                    });
                    flowNodes().forEach((node, index) => {
                        const offset = state.draft.nodes.length + index;
                        node.layout = { x: 35 + offset % 3 * 310, y: 35 + Math.floor(offset / 3) * 150 };
                    });
                    m.changed();
                    m.render();
                    hint('已按网格自动整理全部画布节点位置。');
                } else {
                    const svg = byId('modeling-graph'), size = bounds();
                    zoom = action === 'fit'
                        ? Math.max(0.25, Math.min(1.5, ((svg.parentElement?.clientWidth || size.width) - 24) / size.width))
                        : Math.max(0.25, Math.min(2, zoom + (action === 'zoom-in' ? 0.25 : -0.25)));
                    svg.setAttribute('width', Math.round(size.width * zoom));
                    svg.setAttribute('height', Math.round(size.height * zoom));
                    byId('modeling-canvas-zoom').textContent = `${Math.round(zoom * 100)}%`;
                }
            });
        }, true);

        root.addEventListener('keydown', event => {
            if (event.key === 'Escape') { cancelGesture(); hint('拖拽与待连接端点已取消。'); return; }
            const port = event.target.closest('[data-canvas-port]');
            const relation = event.target.closest('[data-modeling-graph-relation]');
            const fEdge = event.target.closest('[data-modeling-flow-edge]');
            const element = event.target.closest('[data-modeling-graph-node]');
            if (port || relation || fEdge) {
                if (['Enter', ' '].includes(event.key)) {
                    event.preventDefault();
                    event.stopImmediatePropagation();
                    event.target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
                }
                if (relation && ['Delete', 'Backspace'].includes(event.key) && canEdit()) {
                    event.preventDefault();
                    void m.action('remove-relation', relation.dataset.modelingGraphRelation).catch(error => app.toast(error.message, 'error'));
                }
                if (fEdge && ['Delete', 'Backspace'].includes(event.key) && canEdit()) {
                    event.preventDefault();
                    m.removeFlowEdge?.(fEdge.dataset.modelingFlowEdge);
                }
                return;
            }
            if (!element) return;
            const nodeId = element.dataset.modelingGraphNode;
            if (['Enter', ' '].includes(event.key)) {
                event.preventDefault();
                safe(() => {
                    editable();
                    if (m.getFlowNode?.(nodeId)) {
                        state.selectedNodeId = nodeId;
                        state.drawerMode = 'node';
                        state.drawerOpen = true;
                        m.render();
                    } else {
                        m.editNode(nodeId);
                    }
                });
            } else if (['Delete', 'Backspace'].includes(event.key) && canEdit() && m.getFlowNode?.(nodeId)) {
                event.preventDefault();
                m.removeFlowNode?.(nodeId);
            } else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key) && canEdit()) {
                event.preventDefault();
                const node = findAnyNode(nodeId);
                if (!node) return;
                const p = position(node);
                saveMovedPosition(node, {
                    x: Math.max(20, Math.min(6000, p.x + (event.key === 'ArrowRight' ? 10 : event.key === 'ArrowLeft' ? -10 : 0))),
                    y: Math.max(20, Math.min(6000, p.y + (event.key === 'ArrowDown' ? 10 : event.key === 'ArrowUp' ? -10 : 0)))
                });
                m.changed();
                m.render();
                Array.from(byId('modeling-graph').querySelectorAll('[data-modeling-graph-node]')).find(item => item.dataset.modelingGraphNode === node.id)?.focus();
            }
        }, true);

        window.addEventListener('blur', () => cancelGesture());
        window.addEventListener('keydown', event => {
            if (event.key === 'Escape' && (gesture || connection || draggedItem)) {
                event.preventDefault();
                event.stopImmediatePropagation();
                cancelGesture();
                hint('拖拽与待连接端点已取消，原布局和关联保持不变。');
            }
        }, true);
    }

    Object.assign(m, {
        canvasGraph: graph,
        canvasPalette: palette,
        canvasToolbar: toolbar,
        bindCanvas: bind,
        clearCanvas: () => { cancelGesture(); zoom = 1; },
        assertCanvasDataset: assertDataset,
        assertCanvasRelation: assertRelation,
        getNodeCanvasPosition
    });
})();
