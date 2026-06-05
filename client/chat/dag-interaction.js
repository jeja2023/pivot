/* Agent DAG 交互时序与选择器辅助函数（拆自 agents-dag-editor.js） */



const raf = window.requestAnimationFrame ? window.requestAnimationFrame.bind(window) : (cb => setTimeout(cb, 16));

const caf = window.cancelAnimationFrame ? window.cancelAnimationFrame.bind(window) : clearTimeout;

const cssEscape = window.CSS && typeof window.CSS.escape === 'function'
        ? window.CSS.escape.bind(window.CSS)
        : (value) => String(value ?? '').replace(/[^a-zA-Z0-9_\u00A0-\uFFFF-]/g, ch => `\\${ch}`);

function createDagInteractionController(ctx) {
        let connecting = null;
        let dragging = null;
        let panning = null;
        const pointFromEvent = (event) => {
            const rect = ctx.root.getBoundingClientRect();
            const vb = ctx.root.viewBox.baseVal || { x: 0, y: 0, width: rect.width, height: rect.height };
            const scaleX = vb.width / rect.width;
            const scaleY = vb.height / rect.height;
            return {
                x: (event.clientX - rect.left) * scaleX + vb.x,
                y: (event.clientY - rect.top) * scaleY + vb.y
            };
        };

        const onPointerDown = (event) => {
            const target = event.target;
            if (target.dataset.pivotDagPort === 'out') {
                event.preventDefault();
                const node = ctx.spec.nodes.find(n => n.id === target.dataset.pivotDagId);
                if (!node) return;
                const ghost = makeSvgEl('path', { class: 'pivot-dag-edge pivot-dag-edge-ghost' });
                ctx.edgesLayer.appendChild(ghost);
                connecting = { fromId: node.id, ghost };
                ctx.root.setPointerCapture?.(event.pointerId);
                return;
            }
            const nodeGroup = target.closest('[data-pivot-dag-id]');
            if (!nodeGroup) {
                ctx.selectedId = null;
                ctx.render();
                // 空白处按下：开始平移
                panning = {
                    startClientX: event.clientX,
                    startClientY: event.clientY,
                    originX: ctx.viewState.x,
                    originY: ctx.viewState.y
                };
                ctx.root.classList.add('is-panning');
                ctx.root.setPointerCapture?.(event.pointerId);
                return;
            }
            const id = nodeGroup.dataset.pivotDagId;
            const node = ctx.spec.nodes.find(n => n.id === id);
            if (!node) return;
            ctx.selectedId = id;
            ctx.render();
            const pointer = pointFromEvent(event);
            dragging = { id, offsetX: pointer.x - node._x, offsetY: pointer.y - node._y };
            ctx.root.setPointerCapture?.(event.pointerId);
        };

        const onPointerMove = (event) => {
            if (connecting) {
                const node = ctx.spec.nodes.find(n => n.id === connecting.fromId);
                if (!node) return;
                const pointer = pointFromEvent(event);
                const startX = node._x + NODE_WIDTH;
                const startY = node._y + NODE_HEIGHT / 2;
                connecting.ghost.setAttribute('d', `M ${startX},${startY} C ${startX + 60},${startY} ${pointer.x - 60},${pointer.y} ${pointer.x},${pointer.y}`);
                return;
            }
            if (dragging) {
                const node = ctx.spec.nodes.find(n => n.id === dragging.id);
                if (!node) return;
                const pointer = pointFromEvent(event);
                node._x = Math.max(0, pointer.x - dragging.offsetX);
                node._y = Math.max(0, pointer.y - dragging.offsetY);
                ctx.renderEdges();
                const group = ctx.nodesLayer.querySelector(`[data-pivot-dag-id="${cssEscape(dragging.id)}"]`);
                if (group) group.setAttribute('transform', `translate(${node._x}, ${node._y})`);
                ctx.updateViewBox();
                return;
            }
            if (panning) {
                // 把屏幕像素位移转回内容坐标位移：屏幕 px / (canvas px) * viewBox 宽 = 内容单位
                const rect = ctx.root.getBoundingClientRect();
                const { width, height } = ctx.contentBounds();
                const dxContent = (event.clientX - panning.startClientX) * (width / ctx.viewState.scale) / rect.width;
                const dyContent = (event.clientY - panning.startClientY) * (height / ctx.viewState.scale) / rect.height;
                ctx.viewState.x = panning.originX - dxContent;
                ctx.viewState.y = panning.originY - dyContent;
                ctx.updateViewBox();
            }
        };

        const onPointerUp = (event) => {
            if (connecting) {
                const target = document.elementFromPoint(event.clientX, event.clientY);
                const inPort = target?.closest?.('[data-pivot-dag-port="in"]');
                const targetId = inPort?.dataset?.pivotDagId;
                if (targetId && targetId !== connecting.fromId) {
                    const targetNode = ctx.spec.nodes.find(n => n.id === targetId);
                    if (targetNode && !targetNode.dependsOn.includes(connecting.fromId)) {
                        if (!ctx.isForwardDependency(connecting.fromId, targetId)) {
                            window.showToast?.('只能从左侧上游节点连接到右侧下游节点', 'error');
                            connecting.ghost.remove();
                            connecting = null;
                            ctx.render();
                            return;
                        }
                        if (ctx.wouldCreateCycle(connecting.fromId, targetId)) {
                            window.showToast?.('不能添加循环依赖', 'error');
                            connecting.ghost.remove();
                            connecting = null;
                            ctx.render();
                            return;
                        }
                        targetNode.dependsOn.push(connecting.fromId);
                        clampDependsOn(ctx.spec.nodes);
                        ctx.flushOut();
                    }
                }
                connecting.ghost.remove();
                connecting = null;
                ctx.render();
                return;
            }
            if (dragging) {
                dragging = null;
                ctx.flushOut();
            }
            if (panning) {
                panning = null;
                ctx.root.classList.remove('is-panning');
            }
        };

        // 滚轮缩放：以光标位置为锚点
        const onWheel = (event) => {
            event.preventDefault();
            const factor = event.deltaY > 0 ? 0.9 : 1.1;
            const nextScale = Math.min(SCALE_MAX, Math.max(SCALE_MIN, ctx.viewState.scale * factor));
            if (nextScale === ctx.viewState.scale) return;
            const anchor = pointFromEvent(event); // 缩放前光标所在内容坐标
            ctx.viewState.scale = nextScale;
            // 缩放后保持光标对应同一内容点：anchor 在新视口中仍位于相同屏幕位置
            const rect = ctx.root.getBoundingClientRect();
            const { width, height } = ctx.contentBounds();
            const newVbWidth = width / ctx.viewState.scale;
            const newVbHeight = height / ctx.viewState.scale;
            const offsetX = (event.clientX - rect.left) / rect.width;
            const offsetY = (event.clientY - rect.top) / rect.height;
            ctx.viewState.x = anchor.x - offsetX * newVbWidth;
            ctx.viewState.y = anchor.y - offsetY * newVbHeight;
            ctx.updateViewBox();
        };

        const onDoubleClick = (event) => {
            const nodeGroup = event.target.closest('[data-pivot-dag-id]');
            if (!nodeGroup) return;
            ctx.selectedId = nodeGroup.dataset.pivotDagId;
            ctx.render();
            // 把焦点放到 ctx.inspector 第一个输入，便于直接改名
            ctx.inspector?.querySelector('input[data-pivot-dag-field="title"]')?.focus();
        };

        // 键盘快捷键：Delete/Escape
        const onKeyDown = (event) => {
            // 仅在画布或节点有焦点时响应，避免与文本输入冲突
            const activeTag = (document.activeElement?.tagName || '').toLowerCase();
            const editingInput = activeTag === 'input' || activeTag === 'textarea' || activeTag === 'select';
            if (editingInput) return;
            if (event.key === 'Delete' || event.key === 'Backspace') {
                if (ctx.selectedId) {
                    event.preventDefault();
                    ctx.deleteNode(ctx.selectedId);
                }
            } else if (event.key === 'Escape') {
                if (ctx.selectedId) {
                    event.preventDefault();
                    ctx.selectedId = null;
                    ctx.render();
                    if (typeof ctx.onNodeSelectionChange === 'function') ctx.onNodeSelectionChange(null);
                }
            }
        };
        const closeToolbarDropdowns = (event) => {
            if (!ctx.toolbar || event.target?.closest?.('.pivot-dag-toolbar-dropdown')) return;
            ctx.toolbar.querySelectorAll('.pivot-dag-toolbar-dropdown[open]').forEach(item => {
                item.open = false;
            });
        };

        return {
            onPointerDown,
            onPointerMove,
            onPointerUp,
            onWheel,
            onDoubleClick,
            onKeyDown,
            closeToolbarDropdowns
        };
    }
