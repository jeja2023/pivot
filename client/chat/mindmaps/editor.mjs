import MindMap from '/common/vendor/simple-mind-map/0.14.0-fix.3/editor.mjs';
const schema = window.Pivot.moduleApi('mindmaps.document');

if (!MindMap.__pivotPatched) {
    MindMap.__pivotPatched = true;
    const origHandleData = MindMap.prototype.handleData;
    MindMap.prototype.handleData = function (data) {
        const keepExpand = data?.data && data.data.expand === false;
        const res = origHandleData.call(this, data);
        if (keepExpand && res?.data) {
            res.data.expand = false;
        }
        return res;
    };
}

export function mount(container, document, { change, select, failure }) {
    let current = schema.normalize(document); let suppressed = false; let selected = null; let destroyed = false; let composing = false; let presenting = false; let presentationSnapshot; let historyActions; let readonly = false;
    let history = [JSON.stringify(current)]; let historyIndex = 0;
    function remember(value) {
        const snapshot = JSON.stringify(value); if (history[historyIndex] === snapshot) return;
        history = history.slice(0, historyIndex + 1); history.push(snapshot); if (history.length > 50) history.shift(); historyIndex = history.length - 1;
    }
    const palette = () => schema.palette(current);
    const config = () => ({ backgroundColor: palette().background, lineColor: palette().line, textAlign: 'center', root: { fillColor: palette().root, color: schema.foreground(palette().root), textAlign: 'center', ...palette().styles?.root }, second: { fillColor: palette().background, color: schema.foreground(palette().background), textAlign: 'center', ...palette().styles?.second }, node: { fillColor: palette().background, color: schema.foreground(palette().background), textAlign: 'center', ...palette().styles?.node } });
    const native = schema.toEngine(current);
    const map = new MindMap({ el: container, data: native.root, layout: native.layout, themeConfig: config(), addHistoryTime: 100, enableFreeDrag: false, enableAutoEnterTextEditWhenKeydown: false, customHyperlinkJump: link => { if (/^https?:\/\//i.test(link)) window.open(link, '_blank', 'noopener,noreferrer'); }, beforeShortcutRun: key => { if (['Control+z', 'Control+y'].includes(key)) { command(key.endsWith('+z') ? 'BACK' : 'FORWARD'); return true; } return false; }, customCheckEnableShortcut: event => !event.isComposing && event.keyCode !== 229 && map.keyCommand.defaultEnableCheck(event), errorHandler: () => { if (!destroyed) failure(new Error('画布操作失败，请保存草稿后重新打开。')); } });

    function ensureNodePatched(node) {
        const proto = Object.getPrototypeOf(node);
        if (!proto || proto.__pivotPatched) return;
        proto.__pivotPatched = true;

        const origRenderExpandBtn = proto.renderExpandBtn;
        proto.renderExpandBtn = function () {
            if (this.getChildrenLength() <= 0) return;
            if (this.isRoot) {
                const wasRoot = this.isRoot;
                this.isRoot = false;
                try {
                    origRenderExpandBtn.call(this);
                } finally {
                    this.isRoot = wasRoot;
                }
            } else {
                origRenderExpandBtn.call(this);
            }
        };

        const origUpdateExpandBtnPos = proto.updateExpandBtnPos;
        proto.updateExpandBtnPos = function () {
            if (!this._expandBtn) return;
            if (this.isRoot) {
                const wasRoot = this.isRoot;
                this.isRoot = false;
                try {
                    this.renderer.layout.renderExpandBtn(this, this._expandBtn);
                } catch (_) {
                    // Layout-specific translation fallback for root
                } finally {
                    this.isRoot = wasRoot;
                }
                const transform = this._expandBtn.transform();
                if (!transform.translateX && !transform.translateY) {
                    const h = this.mindMap.themeConfig.nodeUseLineStyle ? this.height / 2 : 0;
                    this._expandBtn.translate(this.width, this.height / 2 + h);
                }
            } else {
                origUpdateExpandBtnPos.call(this);
            }
        };
    }

    function hookLayout() {
        if (!map.renderer?.layout || map.renderer.layout.__pivotHooked) return;
        map.renderer.layout.__pivotHooked = true;
        const origCreateNode = map.renderer.layout.createNode;
        map.renderer.layout.createNode = function (...args) {
            const node = origCreateNode.apply(this, args);
            if (node) ensureNodePatched(node);
            return node;
        };
    }

    hookLayout();
    map.renderer.unexpandAllNode = function (center = true, targetUid = '') {
        if (!this.renderTree) return;
        const isRootTarget = !targetUid || targetUid === this.renderTree.data?.uid;
        const walk = (node, matched) => {
            if (!matched && node.data?.uid === targetUid) matched = true;
            if (matched && node.children?.length > 0 && node.data) {
                node.data.expand = false;
            }
            if (node.children?.length) {
                node.children.forEach(child => walk(child, matched));
            }
        };
        walk(this.renderTree, isRootTarget);
        this.mindMap.render(() => {
            if (center) this.setRootNodeCenter();
        });
    };
    map.renderer.expandAllNode = function (targetUid = '') {
        if (!this.renderTree) return;
        const isRootTarget = !targetUid || targetUid === this.renderTree.data?.uid;
        const walk = (node, matched) => {
            if (!matched && node.data?.uid === targetUid) matched = true;
            if (matched && node.data) {
                node.data.expand = true;
            }
            if (node.children?.length) {
                node.children.forEach(child => walk(child, matched));
            }
        };
        walk(this.renderTree, isRootTarget);
        this.mindMap.render(() => {
            if (isRootTarget) this.mindMap.view.fit();
        });
    };
    map.renderer.toggleActiveExpand = function () {
        this.activeNodeList.forEach(t => {
            if (t.nodeData?.children?.length > 0) {
                this.toggleNodeExpand(t);
            }
        });
    };
    if (map.command?.commands) {
        map.command.commands['UNEXPAND_ALL'] = [(...args) => map.renderer.unexpandAllNode(...args)];
        map.command.commands['EXPAND_ALL'] = [(...args) => map.renderer.expandAllNode(...args)];
    }
    if (map.keyCommand?.shortcutMap) {
        map.keyCommand.shortcutMap['/'] = [() => map.renderer.toggleActiveExpand()];
    }

    let resizeTimer;
    let lastWidth = container.clientWidth; let lastHeight = container.clientHeight;
    const observer = new ResizeObserver(() => {
        if (container.clientWidth === lastWidth && container.clientHeight === lastHeight) return;
        lastWidth = container.clientWidth; lastHeight = container.clientHeight;
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => { if (!destroyed && container.clientWidth && container.clientHeight) { map.resize(); map.render(() => { if (!destroyed && container.isConnected && container.clientWidth && container.clientHeight) map.view.fit(); }); } }, 100);
    });
    observer.observe(container);
    const compositionStart = () => { composing = true; };
    const compositionEnd = () => { composing = false; commit(); };
    window.addEventListener('compositionstart', compositionStart);
    window.addEventListener('compositionend', compositionEnd);
    function commit() {
        if (suppressed || destroyed || presenting) return;
        try {
            const next = schema.fromEngine(map.getData(true), current);
            const editing = map.renderer.textEdit;
            if (editing.isShowTextEdit() && editing.currentNode) {
                const text = editing.getEditText(); const id = editing.currentNode.getData('uid');
                if (!text.trim() || text.length > schema.LIMITS.text) return;
                (function updateText(node) { if (node.id === id) node.text = text; node.children.forEach(updateText); })(next.tree);
            }
            current = schema.normalize(next);
            remember(current);
            change(current);
        } catch (error) {
            failure(error); suppressed = true;
            map.setFullData(schema.toEngine(current));
            setTimeout(() => { suppressed = false; }, 0);
        }
    }
    map.on('data_change', commit);
    map.on('node_text_edit_change', commit);
    map.on('node_tree_render_end', commit);
    map.on('hide_text_edit', () => { composing = false; });
    function selectNode(node) {
        const previous = selected?.getData('uid'); selected = node?.isGeneralization ? null : node;
        if (previous === selected?.getData('uid') && selected) return;
        if (!selected) { select(null); return; }
        const style = { ...current.presentation.nodes[selected.getData('uid')] };
        for (const key of schema.STYLE_FIELDS.filter(key => !['note', 'expanded', 'hyperlink'].includes(key))) {
            const inherited = selected.style.merge(key);
            if (style[key] === undefined && inherited !== undefined) style[key] = inherited;
        }
        select({ id: selected.getData('uid'), text: selected.getData('text'), style });
    }
    map.on('node_active', (_node, list) => selectNode(list?.[0] || null));
    function replace(document) {
        suppressed = true; current = schema.normalize(document);
        map.setFullData(schema.toEngine(current)); map.setThemeConfig(config());
        map.render(() => { suppressed = false; });
    }
    function command(name) {
        if (readonly) throw schema.error('当前导图只有查看权限，请另存副本后编辑。');
        if (historyActions && (name === 'BACK' || name === 'FORWARD')) { historyActions[name === 'BACK' ? 'undo' : 'redo'](); return; }
        if (name === 'BACK' || name === 'FORWARD') {
            const nextIndex = historyIndex + (name === 'BACK' ? -1 : 1); if (nextIndex < 0 || nextIndex >= history.length) return;
            historyIndex = nextIndex; replace(JSON.parse(history[historyIndex])); change(current); return;
        }
        if (['INSERT_CHILD_NODE', 'INSERT_NODE'].includes(name) && schema.count(current) >= schema.LIMITS.nodes) throw schema.error('节点数量已达上限，请先删除不需要的分支。');
        if (name === 'REMOVE_NODE' && selected?.isRoot) throw schema.error('中心主题不能删除。');
        if (name === 'UNEXPAND_ALL' || name === 'EXPAND_ALL') {
            map.renderer.textEdit.hideEditTextBox();
            fold(name === 'EXPAND_ALL');
            return;
        }
        if (!selected) map.renderer.root.active(); map.execCommand(name);
    }
    function activateNodeWithoutCentering(id) {
        if (!id) return;
        const activate = () => {
            const targetNode = map.renderer?.findNodeByUid?.(id);
            if (targetNode) {
                if (map.opt?.readonly) {
                    map.renderer?.clearActiveNodeList?.();
                    map.renderer?.addNodeToActiveList?.(targetNode, true);
                    map.renderer?.emitNodeActiveEvent?.(targetNode);
                } else {
                    targetNode.active?.();
                }
                selectNode(targetNode);
            }
        };
        const existing = map.renderer?.findNodeByUid?.(id);
        if (existing) {
            activate();
        } else if (typeof map.renderer?.expandToNodeUid === 'function') {
            map.renderer.expandToNodeUid(id, activate);
        } else {
            activate();
        }
    }
    return {
        document: () => { map.renderer.textEdit.hideEditTextBox(); composing = false; commit(); return current; },
        composing: () => Boolean(composing && map.renderer.textEdit.isShowTextEdit()),
        editing: () => map.renderer.textEdit.isShowTextEdit() || presenting || Boolean(globalThis.document.activeElement?.matches('input,textarea,select') && container.closest('.mindmap-workbench')?.querySelector('.mindmap-properties')?.contains(globalThis.document.activeElement)),
        readOnly(value) { readonly = value; map.setMode(value || presenting ? 'readonly' : 'edit'); },
        historyActions(actions) { historyActions = actions; },
        receive(document) { replace(document); },
        selection: () => selected?.getData('uid') || null,
        replace,
        update(document) {
            if (readonly) throw schema.error('当前导图只有查看权限，请另存副本后编辑。');
            const next = schema.normalize(document); remember(next); replace(next); change(next);
        },
        present(active) {
            if (active && !presenting) { map.renderer.textEdit.hideEditTextBox(); presentationSnapshot = schema.normalize(current); presenting = true; map.setMode('readonly'); }
            else if (!active && presenting) {
                suppressed = true; current = presentationSnapshot; map.updateData(schema.toEngine(current).root);
                map.render(() => { if (destroyed) return; presenting = false; suppressed = false; map.setMode(readonly ? 'readonly' : 'edit'); if (container.isConnected && container.clientWidth && container.clientHeight) map.view.fit(); });
            }
        },
        minimap() { return map.miniMap.calculationMiniMap(220, 140).svgHTML; },
        pan(dx, dy) { map.view.translateXY(dx, dy); },
        command,
        focus(id, center = true) {
            if (!id) return;
            const shouldCenter = typeof center === 'object' ? center.center !== false : Boolean(center);
            if (shouldCenter) {
                map.execCommand('GO_TARGET_NODE', id, node => selectNode(node));
            } else {
                activateNodeWithoutCentering(id);
            }
        },
        selectNodeById(id) {
            activateNodeWithoutCentering(id);
        },
        fit() { map.view.fit(); },
        zoomIn() {
            if (typeof map.view?.enlarge === 'function') map.view.enlarge();
            else if (typeof map.view?.setScale === 'function') map.view.setScale((map.view.scale || 1) + 0.15);
            return Math.round((map.view?.scale || 1) * 100);
        },
        zoomOut() {
            if (typeof map.view?.narrow === 'function') map.view.narrow();
            else if (typeof map.view?.setScale === 'function') map.view.setScale(Math.max(0.2, (map.view.scale || 1) - 0.15));
            return Math.round((map.view?.scale || 1) * 100);
        },
        zoomReset() {
            if (typeof map.view?.reset === 'function') map.view.reset();
            else map.view.fit();
            return Math.round((map.view?.scale || 1) * 100);
        },
        getScale() {
            return Math.round((map.view?.scale || 1) * 100);
        },
        layout(layout) {
            current = { ...current, presentation: { ...current.presentation, layout } };
            map.setLayout(layout);
            hookLayout();
            commit();
        },
        theme(themeId) { current = { ...current, presentation: { ...current.presentation, themeId } }; map.setThemeConfig(config()); commit(); },
        apply({ text, ...style }) {
            if (readonly) throw schema.error('当前导图只有查看权限。');
            if (!selected) throw schema.error('请先选择一个节点。');
            const next = schema.normalize(current); const id = selected.getData('uid');
            (function visit(node) { if (node.id === id) node.text = text; node.children.forEach(visit); })(next.tree);
            next.presentation.nodes[id] = { ...next.presentation.nodes[id], ...style }; schema.normalize(next);
            map.execCommand('SET_NODE_TEXT', selected, text, false); map.execCommand('SET_NODE_DATA', selected, { ...style, richText: false }); map.render(); commit();
        },
        fold(expand, nodeId = '') {
            if (readonly) throw schema.error('当前导图只有查看权限。');
            map.renderer.textEdit.hideEditTextBox();
            if (expand) {
                map.renderer.expandAllNode(nodeId);
            } else {
                map.renderer.unexpandAllNode(true, nodeId);
            }
            commit();
        },
        destroy() { destroyed = true; observer.disconnect(); clearTimeout(resizeTimer); window.removeEventListener('compositionstart', compositionStart); window.removeEventListener('compositionend', compositionEnd); map.destroy(); selected = null; }
    };
}
