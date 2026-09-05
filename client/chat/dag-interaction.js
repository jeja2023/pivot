/* Agent DAG canvas interaction: selection, drag, connect, pan and keyboard actions. */

const cssEscape = window.CSS && typeof window.CSS.escape === 'function'
    ? window.CSS.escape.bind(window.CSS)
    : value => String(value ?? '').replace(/[^a-zA-Z0-9_\u00A0-\uFFFF-]/g, ch => `\\${ch}`);

function createDagInteractionController(ctx) {
    let connecting = null;
    let dragging = null;
    let panning = null;
    let boxSelecting = null;

    const pointFromEvent = event => {
        const rect = ctx.root.getBoundingClientRect();
        const vb = ctx.root.viewBox.baseVal || { x: 0, y: 0, width: rect.width, height: rect.height };
        return {
            x: (event.clientX - rect.left) * vb.width / rect.width + vb.x,
            y: (event.clientY - rect.top) * vb.height / rect.height + vb.y
        };
    };

    const setBoxRect = (start, end) => {
        const x = Math.min(start.x, end.x);
        const y = Math.min(start.y, end.y);
        boxSelecting.rect.setAttribute('x', x);
        boxSelecting.rect.setAttribute('y', y);
        boxSelecting.rect.setAttribute('width', Math.abs(end.x - start.x));
        boxSelecting.rect.setAttribute('height', Math.abs(end.y - start.y));
        boxSelecting.bounds = { x, y, right: Math.max(start.x, end.x), bottom: Math.max(start.y, end.y) };
    };

    const onPointerDown = event => {
        if (ctx.readOnly) {
            const nodeGroup = event.target.closest?.('[data-pivot-dag-id]');
            if (nodeGroup) {
                ctx.selectNode(nodeGroup.dataset.pivotDagId, event.shiftKey || event.ctrlKey || event.metaKey);
                ctx.render();
            } else {
                const rect = ctx.root.getBoundingClientRect();
                ctx.root.setPointerCapture?.(event.pointerId);
                panning = {
                    startClientX: event.clientX,
                    startClientY: event.clientY,
                    originX: ctx.viewState.x,
                    originY: ctx.viewState.y,
                    rect
                };
                ctx.root.classList.add('is-panning');
            }
            return;
        }
        const target = event.target;
        if (target.dataset.pivotDagPort === 'out') {
            event.preventDefault();
            const node = ctx.spec.nodes.find(item => item.id === target.dataset.pivotDagId);
            if (!node) return;
            const ghost = makeSvgEl('path', { class: 'pivot-dag-edge pivot-dag-edge-ghost' });
            ctx.edgesLayer.appendChild(ghost);
            connecting = { fromId: node.id, ghost };
            ctx.root.setPointerCapture?.(event.pointerId);
            return;
        }
        const edge = target.closest?.('[data-pivot-dag-edge-to]');
        if (edge) {
            event.preventDefault();
            ctx.selectedEdge = { fromId: edge.dataset.pivotDagEdgeFrom, toId: edge.dataset.pivotDagEdgeTo };
            ctx.render();
            return;
        }
        const nodeGroup = target.closest?.('[data-pivot-dag-id]');
        if (!nodeGroup) {
            if (event.shiftKey) {
                event.preventDefault();
                const start = pointFromEvent(event);
                const rect = makeSvgEl('rect', { class: 'pivot-dag-selection-box', x: start.x, y: start.y, width: 0, height: 0 });
                ctx.root.appendChild(rect);
                boxSelecting = { start, rect, bounds: null };
            } else {
                ctx.clearSelection();
                ctx.render();
                panning = { startClientX: event.clientX, startClientY: event.clientY, originX: ctx.viewState.x, originY: ctx.viewState.y };
                ctx.root.classList.add('is-panning');
            }
            ctx.root.setPointerCapture?.(event.pointerId);
            return;
        }
        const id = nodeGroup.dataset.pivotDagId;
        const node = ctx.spec.nodes.find(item => item.id === id);
        if (!node) return;
        const additive = event.shiftKey || event.ctrlKey || event.metaKey;
        if (additive || !ctx.selectedIds.has(id)) ctx.selectNode(id, additive);
        ctx.render();
        const pointer = pointFromEvent(event);
        const selected = ctx.selectedIds.has(id) ? [...ctx.selectedIds] : [id];
        dragging = {
            id,
            offsetX: pointer.x - node._x,
            offsetY: pointer.y - node._y,
            origins: new Map(selected.map(nodeId => {
                const item = ctx.spec.nodes.find(candidate => candidate.id === nodeId);
                return [nodeId, { x: item?._x || 0, y: item?._y || 0 }];
            })),
            moved: false
        };
        ctx.root.setPointerCapture?.(event.pointerId);
    };

    const onPointerMove = event => {
        if (connecting) {
            const node = ctx.spec.nodes.find(item => item.id === connecting.fromId);
            if (!node) return;
            const pointer = pointFromEvent(event);
            const startX = node._x + NODE_WIDTH;
            const startY = node._y + NODE_HEIGHT / 2;
            connecting.ghost.setAttribute('d', `M ${startX},${startY} C ${startX + 60},${startY} ${pointer.x - 60},${pointer.y} ${pointer.x},${pointer.y}`);
            return;
        }
        if (dragging) {
            const anchor = ctx.spec.nodes.find(item => item.id === dragging.id);
            if (!anchor) return;
            const pointer = pointFromEvent(event);
            const nextX = Math.max(0, pointer.x - dragging.offsetX);
            const nextY = Math.max(0, pointer.y - dragging.offsetY);
            const dx = nextX - (dragging.origins.get(dragging.id)?.x || 0);
            const dy = nextY - (dragging.origins.get(dragging.id)?.y || 0);
            if (!dragging.moved && (Math.abs(dx) > 1 || Math.abs(dy) > 1)) {
                dragging.moved = true;
                ctx.recordHistory();
            }
            dragging.origins.forEach((origin, nodeId) => {
                const node = ctx.spec.nodes.find(item => item.id === nodeId);
                if (!node) return;
                node._x = Math.max(0, origin.x + dx);
                node._y = Math.max(0, origin.y + dy);
                const group = ctx.nodesLayer.querySelector(`[data-pivot-dag-id="${cssEscape(nodeId)}"]`);
                group?.setAttribute('transform', `translate(${node._x}, ${node._y})`);
            });
            ctx.renderEdges();
            ctx.updateViewBox({ refreshCulling: true });
            return;
        }
        if (boxSelecting) {
            setBoxRect(boxSelecting.start, pointFromEvent(event));
            return;
        }
        if (panning) {
            const rect = ctx.root.getBoundingClientRect();
            const { width, height } = ctx.contentBounds();
            ctx.viewState.x = panning.originX - (event.clientX - panning.startClientX) * (width / ctx.viewState.scale) / rect.width;
            ctx.viewState.y = panning.originY - (event.clientY - panning.startClientY) * (height / ctx.viewState.scale) / rect.height;
            ctx.updateViewBox({ refreshCulling: true });
        }
    };

    const onPointerUp = event => {
        if (connecting) {
            const target = document.elementFromPoint(event.clientX, event.clientY);
            const inPort = target?.closest?.('[data-pivot-dag-port="in"]');
            const targetId = inPort?.dataset?.pivotDagId;
            if (targetId && targetId !== connecting.fromId) {
                const targetNode = ctx.spec.nodes.find(item => item.id === targetId);
                if (targetNode && !targetNode.dependsOn.includes(connecting.fromId)) {
                    if (ctx.wouldCreateCycle(connecting.fromId, targetId)) window.Pivot.legacy.showToast?.('不能添加循环依赖', 'error');
                    else {
                        ctx.recordHistory();
                        targetNode.dependsOn.push(connecting.fromId);
                        clampDependsOn(ctx.spec.nodes);
                        ctx.flushOut();
                    }
                }
            }
            connecting.ghost.remove();
            connecting = null;
            ctx.render();
            return;
        }
        if (dragging) {
            const moved = dragging.moved;
            dragging = null;
            if (moved) ctx.flushOut();
            ctx.render();
        }
        if (boxSelecting) {
            const bounds = boxSelecting.bounds;
            const ids = bounds ? ctx.spec.nodes.filter(node => (
                node._x < bounds.right && node._x + NODE_WIDTH > bounds.x
                && node._y < bounds.bottom && node._y + NODE_HEIGHT > bounds.y
            )).map(node => node.id) : [];
            boxSelecting.rect.remove();
            boxSelecting = null;
            ctx.setSelection(ids, ids[0]);
            ctx.render();
        }
        if (panning) {
            panning = null;
            ctx.root.classList.remove('is-panning');
        }
    };

    const onWheel = event => {
        event.preventDefault();
        const factor = event.deltaY > 0 ? 0.9 : 1.1;
        const nextScale = Math.min(SCALE_MAX, Math.max(SCALE_MIN, ctx.viewState.scale * factor));
        if (nextScale === ctx.viewState.scale) return;
        const anchor = pointFromEvent(event);
        ctx.viewState.scale = nextScale;
        const rect = ctx.root.getBoundingClientRect();
        const { width, height } = ctx.contentBounds();
        ctx.viewState.x = anchor.x - (event.clientX - rect.left) / rect.width * width / nextScale;
        ctx.viewState.y = anchor.y - (event.clientY - rect.top) / rect.height * height / nextScale;
        ctx.updateViewBox({ refreshCulling: true });
    };

    const onDoubleClick = event => {
        const nodeGroup = event.target.closest?.('[data-pivot-dag-id]');
        if (ctx.readOnly) {
            if (nodeGroup) {
                ctx.selectNode(nodeGroup.dataset.pivotDagId, false);
                ctx.render();
            }
            return;
        }
        if (!nodeGroup) {
            ctx.addNodeAt?.(pointFromEvent(event));
            return;
        }
        ctx.selectNode(nodeGroup.dataset.pivotDagId, false);
        ctx.render();
        ctx.inspector?.querySelector('input[data-pivot-dag-field="title"]')?.focus();
    };

    const onKeyDown = event => {
        const tag = (document.activeElement?.tagName || '').toLowerCase();
        if (['input', 'textarea', 'select'].includes(tag)) return;
        if (ctx.readOnly) {
            if (event.key === 'Escape') {
                event.preventDefault();
                ctx.clearSelection();
                ctx.render();
                ctx.onNodeSelectionChange?.(null);
            }
            return;
        }
        const modifier = event.ctrlKey || event.metaKey;
        if (modifier && event.key.toLowerCase() === 'z') { event.preventDefault(); return event.shiftKey ? ctx.redo() : ctx.undo(); }
        if (modifier && event.key.toLowerCase() === 'y') { event.preventDefault(); return ctx.redo(); }
        if (modifier && event.key.toLowerCase() === 'c') { event.preventDefault(); return ctx.copySelection(); }
        if (modifier && event.key.toLowerCase() === 'v') { event.preventDefault(); return ctx.pasteSelection(); }
        if (modifier && event.key.toLowerCase() === 'd') { event.preventDefault(); return ctx.duplicateSelection(); }
        if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); return ctx.deleteSelection(); }
        if (event.key === 'Escape') { event.preventDefault(); ctx.clearSelection(); ctx.render(); ctx.onNodeSelectionChange?.(null); }
    };

    const closeToolbarDropdowns = event => {
        if (!ctx.toolbar || event.target?.closest?.('.pivot-dag-toolbar-dropdown')) return;
        ctx.toolbar.querySelectorAll('.pivot-dag-toolbar-dropdown[open]').forEach(item => { item.open = false; });
    };

    return { onPointerDown, onPointerMove, onPointerUp, onWheel, onDoubleClick, onKeyDown, closeToolbarDropdowns };
}
