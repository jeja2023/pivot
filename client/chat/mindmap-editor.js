(function () {
    function mount(container, artifact) {
        const old = container.querySelector('[data-mindmap-editor]'); old?.remove();
        if (artifact.type !== 'mindmap') return;
        let tree;
        try { tree = typeof artifact.content === 'object' ? artifact.content : JSON.parse(artifact.content); } catch (_) { return; }

        let zoomLevel = 1.0;
        let currentTheme = 'indigo';
        let lastSvgString = '';
        let isAllBranchesCollapsed = false;

        const workbench = document.createElement('div');
        workbench.className = 'mindmap-studio-workbench';
        workbench.dataset.mindmapEditor = '1';

        // 1. Left Outline Sidebar
        const outlinePane = document.createElement('div');
        outlinePane.className = 'mindmap-outline-pane';

        const outlineHeader = document.createElement('div');
        outlineHeader.className = 'mindmap-outline-header';
        
        const outlineTitleWrap = document.createElement('div');
        outlineTitleWrap.className = 'mindmap-outline-title-wrap';
        const outlineTitle = document.createElement('strong');
        outlineTitle.textContent = '节点大纲编排';
        const countBadge = document.createElement('span');
        countBadge.className = 'mindmap-node-count-badge';
        outlineTitleWrap.appendChild(outlineTitle);
        outlineTitleWrap.appendChild(countBadge);
        outlineHeader.appendChild(outlineTitleWrap);

        const outlineActions = document.createElement('div');
        outlineActions.className = 'mindmap-outline-header-actions';

        const toggleCollapseAllBtn = document.createElement('button');
        toggleCollapseAllBtn.type = 'button';
        toggleCollapseAllBtn.className = 'btn-secondary btn-xs mindmap-fold-all-btn';
        toggleCollapseAllBtn.textContent = '折叠分支';
        toggleCollapseAllBtn.title = '一键折叠或展开下级分支';
        toggleCollapseAllBtn.onclick = () => {
            isAllBranchesCollapsed = !isAllBranchesCollapsed;
            toggleCollapseAllBtn.textContent = isAllBranchesCollapsed ? '展开分支' : '折叠分支';
            function setCollapsed(n, val) {
                if (n.children && n.children.length > 0) {
                    n._collapsed = val;
                    n.children.forEach(c => setCollapsed(c, val));
                }
            }
            if (tree.children) tree.children.forEach(c => setCollapsed(c, isAllBranchesCollapsed));
            redraw();
        };
        outlineActions.appendChild(toggleCollapseAllBtn);

        const addBranchTopBtn = document.createElement('button');
        addBranchTopBtn.type = 'button';
        addBranchTopBtn.className = 'btn-secondary btn-xs mindmap-add-branch-btn';
        addBranchTopBtn.textContent = '+ 添加分支';
        addBranchTopBtn.title = '在根节点下添加新的一级分支';
        addBranchTopBtn.onclick = () => {
            syncTreeFromInputs();
            tree.children = tree.children || [];
            if (tree.children.length >= 120) return showToast('脑图最多支持 120 个节点。', 'warning');
            tree.children.push({ id: `node-${Date.now()}-${Math.floor(Math.random() * 10000)}`, text: `分支${tree.children.length + 1}`, children: [] });
            redraw();
            schedulePreview();
        };
        outlineActions.appendChild(addBranchTopBtn);
        outlineHeader.appendChild(outlineActions);
        outlinePane.appendChild(outlineHeader);

        const treeScroll = document.createElement('div');
        treeScroll.className = 'mindmap-tree-scroll';
        outlinePane.appendChild(treeScroll);

        const outlineFooter = document.createElement('div');
        outlineFooter.className = 'mindmap-outline-footer';

        const noteTextarea = document.createElement('textarea');
        noteTextarea.className = 'form-input mindmap-note-textarea';
        noteTextarea.rows = 2;
        noteTextarea.placeholder = '说明本次脑图修改原因（可选）';
        outlineFooter.appendChild(noteTextarea);

        const saveBtn = document.createElement('button');
        saveBtn.type = 'button';
        saveBtn.className = 'btn-primary mindmap-save-btn';
        saveBtn.textContent = '保存脑图并生成新图形';
        saveBtn.onclick = async () => {
            syncTreeFromInputs();
            saveBtn.disabled = true;
            try {
                const note = noteTextarea.value.trim() || '脑图结构与内容编辑保存';
                const response = await apiFetch(`${API_BASE}/apps/mindmaps`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ artifactId: artifact.id, tree, note })
                });
                const data = await response.json().catch(() => ({}));
                if (!response.ok) throw new Error(data.error || '脑图保存失败。');
                showToast('脑图和图形已保存到产物。', 'success');
                await window.Pivot.moduleApi('agent.artifacts')?.openVersions?.(artifact.id);
            } catch (error) {
                showToast(error.message, 'error');
            } finally {
                saveBtn.disabled = false;
            }
        };
        outlineFooter.appendChild(saveBtn);
        outlinePane.appendChild(outlineFooter);

        // 2. Right Canvas Pane
        const canvasPane = document.createElement('div');
        canvasPane.className = 'mindmap-canvas-pane';

        const canvasToolbar = document.createElement('div');
        canvasToolbar.className = 'mindmap-canvas-toolbar';

        const canvasToolbarTitle = document.createElement('div');
        canvasToolbarTitle.className = 'mindmap-canvas-toolbar-title';

        const toggleSidebarBtn = document.createElement('button');
        toggleSidebarBtn.type = 'button';
        toggleSidebarBtn.className = 'btn-secondary btn-xs mindmap-toggle-sidebar-btn';
        toggleSidebarBtn.textContent = '折叠大纲';
        toggleSidebarBtn.title = '折叠或展开左侧大纲编排栏，获得更宽广画布';
        toggleSidebarBtn.onclick = () => {
            const isCollapsed = workbench.classList.toggle('sidebar-collapsed');
            toggleSidebarBtn.textContent = isCollapsed ? '展开大纲' : '折叠大纲';
            if (isCollapsed) {
                toggleSidebarBtn.classList.add('active');
            } else {
                toggleSidebarBtn.classList.remove('active');
            }
        };
        canvasToolbarTitle.appendChild(toggleSidebarBtn);

        const canvasTitleText = document.createElement('strong');
        canvasTitleText.textContent = '导图画布预览';
        const canvasHint = document.createElement('span');
        canvasHint.className = 'mindmap-canvas-hint';
        canvasHint.textContent = '贝塞尔曲线 · 矢量卡片排版';
        canvasToolbarTitle.appendChild(canvasTitleText);
        canvasToolbarTitle.appendChild(canvasHint);
        canvasToolbar.appendChild(canvasToolbarTitle);

        const canvasTools = document.createElement('div');
        canvasTools.className = 'mindmap-canvas-tools';

        // Color Theme Select
        const themeSelect = document.createElement('select');
        themeSelect.className = 'mindmap-theme-select';
        themeSelect.title = '导图配色方案';
        [
            { value: 'indigo', label: '商务靛蓝' },
            { value: 'forest', label: '森林墨绿' },
            { value: 'ocean', label: '深海碧蓝' },
            { value: 'sunset', label: '暖金夕阳' }
        ].forEach(opt => {
            const o = document.createElement('option');
            o.value = opt.value;
            o.textContent = opt.label;
            themeSelect.appendChild(o);
        });
        themeSelect.onchange = () => {
            currentTheme = themeSelect.value;
            void fetchPreview({ showFeedback: true });
        };
        canvasTools.appendChild(themeSelect);

        // Zoom controls
        const zoomGroup = document.createElement('div');
        zoomGroup.className = 'mindmap-zoom-group';

        const zoomOutBtn = document.createElement('button');
        zoomOutBtn.type = 'button';
        zoomOutBtn.textContent = '−';
        zoomOutBtn.title = '缩小';
        zoomOutBtn.onclick = () => {
            zoomLevel = Math.max(0.4, Number((zoomLevel - 0.15).toFixed(2)));
            applyZoom();
        };

        const zoomVal = document.createElement('span');
        zoomVal.className = 'mindmap-zoom-val';
        zoomVal.textContent = '100%';

        const zoomInBtn = document.createElement('button');
        zoomInBtn.type = 'button';
        zoomInBtn.textContent = '+';
        zoomInBtn.title = '放大';
        zoomInBtn.onclick = () => {
            zoomLevel = Math.min(2.5, Number((zoomLevel + 0.15).toFixed(2)));
            applyZoom();
        };

        const zoomFitBtn = document.createElement('button');
        zoomFitBtn.type = 'button';
        zoomFitBtn.textContent = '适应';
        zoomFitBtn.title = '适应画布视口';
        zoomFitBtn.onclick = () => {
            const svg = stage.querySelector('svg');
            if (svg && viewport.clientWidth > 100 && viewport.clientHeight > 100) {
                const svgW = svg.clientWidth || parseInt(svg.getAttribute('width'), 10) || 800;
                const svgH = svg.clientHeight || parseInt(svg.getAttribute('height'), 10) || 500;
                const padW = viewport.clientWidth - 48;
                const padH = viewport.clientHeight - 48;
                if (svgW > 0 && svgH > 0) {
                    zoomLevel = Math.max(0.45, Math.min(1.4, Number(Math.min(padW / svgW, padH / svgH).toFixed(2))));
                    applyZoom();
                    viewport.scrollLeft = 0;
                    viewport.scrollTop = 0;
                    return;
                }
            }
            zoomLevel = 1.0;
            applyZoom();
        };

        zoomGroup.appendChild(zoomOutBtn);
        zoomGroup.appendChild(zoomVal);
        zoomGroup.appendChild(zoomInBtn);
        zoomGroup.appendChild(zoomFitBtn);
        canvasTools.appendChild(zoomGroup);

        const previewBtn = document.createElement('button');
        previewBtn.type = 'button';
        previewBtn.className = 'btn-secondary btn-sm mindmap-preview-btn';
        previewBtn.textContent = '预览导图';
        previewBtn.title = '实时渲染当前修改的导图图形';
        previewBtn.onclick = async () => {
            syncTreeFromInputs();
            previewBtn.disabled = true;
            previewBtn.textContent = '渲染中...';
            try {
                await fetchPreview({ showFeedback: true });
            } finally {
                previewBtn.disabled = false;
                previewBtn.textContent = '预览导图';
            }
        };
        canvasTools.appendChild(previewBtn);

        const downloadSvgBtn = document.createElement('button');
        downloadSvgBtn.type = 'button';
        downloadSvgBtn.className = 'btn-secondary btn-sm';
        downloadSvgBtn.textContent = '下载 SVG';
        downloadSvgBtn.title = '导出独立高清 SVG 矢量图';
        downloadSvgBtn.onclick = () => {
            if (!lastSvgString) return showToast('暂无可下载的脑图矢量图形', 'warning');
            const blob = new Blob([lastSvgString], { type: 'image/svg+xml;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${tree.text || '思维导图'}.svg`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            showToast('已导出 SVG 矢量图');
        };
        canvasTools.appendChild(downloadSvgBtn);

        canvasToolbar.appendChild(canvasTools);
        canvasPane.appendChild(canvasToolbar);

        // Viewport
        const viewport = document.createElement('div');
        viewport.className = 'mindmap-canvas-viewport';

        const stage = document.createElement('div');
        stage.className = 'mindmap-svg-stage';
        viewport.appendChild(stage);
        canvasPane.appendChild(viewport);

        // Mouse Drag-to-Pan support
        let isPanning = false;
        let startX = 0, startY = 0, scrollLeft = 0, scrollTop = 0;
        viewport.addEventListener('mousedown', e => {
            if (e.target.closest('button, input, select, textarea')) return;
            isPanning = true;
            viewport.classList.add('is-panning');
            startX = e.pageX - viewport.offsetLeft;
            startY = e.pageY - viewport.offsetTop;
            scrollLeft = viewport.scrollLeft;
            scrollTop = viewport.scrollTop;
        });
        window.addEventListener('mousemove', e => {
            if (!isPanning) return;
            e.preventDefault();
            const x = e.pageX - viewport.offsetLeft;
            const y = e.pageY - viewport.offsetTop;
            viewport.scrollLeft = scrollLeft - (x - startX);
            viewport.scrollTop = scrollTop - (y - startY);
        });
        window.addEventListener('mouseup', () => {
            if (isPanning) {
                isPanning = false;
                viewport.classList.remove('is-panning');
            }
        });

        // Wheel zoom with Ctrl or trackpad pinch
        viewport.addEventListener('wheel', e => {
            if (e.ctrlKey || e.metaKey) {
                e.preventDefault();
                if (e.deltaY < 0) {
                    zoomLevel = Math.min(2.5, Number((zoomLevel + 0.1).toFixed(2)));
                } else {
                    zoomLevel = Math.max(0.4, Number((zoomLevel - 0.1).toFixed(2)));
                }
                applyZoom();
            }
        }, { passive: false });

        workbench.appendChild(outlinePane);
        workbench.appendChild(canvasPane);

        function applyZoom() {
            zoomVal.textContent = `${Math.round(zoomLevel * 100)}%`;
            stage.style.transform = `scale(${zoomLevel})`;
        }

        let previewTimer = null;
        function schedulePreview() {
            clearTimeout(previewTimer);
            previewTimer = setTimeout(() => {
                void fetchPreview();
            }, 300);
        }

        function syncTreeFromInputs() {
            const inputs = treeScroll.querySelectorAll('input.mindmap-node-input');
            inputs.forEach(inp => {
                if (inp._boundNode) inp._boundNode.text = inp.value;
            });
        }

        function createActionButton(text, handler, isDanger = false) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = isDanger ? 'btn-danger-outline btn-xs mindmap-btn-action' : 'btn-secondary btn-xs mindmap-btn-action';
            btn.textContent = text;
            btn.onclick = handler;
            return btn;
        }

        function redraw() {
            treeScroll.replaceChildren();

            let totalNodes = 0;
            function countAll(node) {
                totalNodes++;
                (node.children || []).forEach(countAll);
            }
            countAll(tree);
            countBadge.textContent = `${totalNodes} 个节点`;

            function visit(node, parent, depth) {
                const card = document.createElement('div');
                card.className = `mindmap-tree-node-card depth-${depth}`;
                card.dataset.depth = String(depth);
                card.style.marginLeft = `${depth * 14}px`;

                const headerRow = document.createElement('div');
                headerRow.className = 'mindmap-node-header-row';

                const pillWrap = document.createElement('div');
                pillWrap.className = 'mindmap-node-pill-wrap';

                if (node.children && node.children.length > 0) {
                    const foldToggle = document.createElement('button');
                    foldToggle.type = 'button';
                    foldToggle.className = `mindmap-node-fold-btn ${node._collapsed ? 'is-collapsed' : ''}`;
                    foldToggle.title = node._collapsed ? '展开子分支' : '折叠子分支';
                    foldToggle.innerHTML = node._collapsed
                        ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"></polyline></svg>'
                        : '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"></polyline></svg>';
                    foldToggle.onclick = (e) => {
                        e.stopPropagation();
                        syncTreeFromInputs();
                        node._collapsed = !node._collapsed;
                        redraw();
                    };
                    pillWrap.appendChild(foldToggle);
                }

                const pill = document.createElement('span');
                pill.className = `mindmap-depth-pill ${depth === 0 ? 'root' : depth === 1 ? 'branch' : 'leaf'}`;
                pill.textContent = depth === 0 ? '根主题' : depth === 1 ? '分支' : `子级 ${depth}`;
                pillWrap.appendChild(pill);

                if (node.children && node.children.length > 0 && node._collapsed) {
                    const badge = document.createElement('span');
                    badge.className = 'mindmap-collapsed-badge';
                    badge.textContent = `${node.children.length} 个子分支`;
                    pillWrap.appendChild(badge);
                }

                headerRow.appendChild(pillWrap);

                const actionsWrap = document.createElement('div');
                actionsWrap.className = 'mindmap-node-actions';

                actionsWrap.appendChild(createActionButton('添加子节点', () => {
                    syncTreeFromInputs();
                    const count = cur => 1 + (cur.children || []).reduce((sum, ch) => sum + count(ch), 0);
                    if (depth >= 6 || count(tree) >= 120) return showToast('脑图最多支持 120 个节点、6 层。', 'warning');
                    node.children = node.children || [];
                    node._collapsed = false; // automatically unfold parent so new child is visible
                    node.children.push({ id: `node-${Date.now()}-${Math.floor(Math.random() * 10000)}`, text: '新节点', children: [] });
                    redraw();
                    schedulePreview();
                }));

                if (parent) {
                    actionsWrap.appendChild(createActionButton('上移', () => {
                        syncTreeFromInputs();
                        const i = parent.children.indexOf(node);
                        if (i > 0) {
                            [parent.children[i - 1], parent.children[i]] = [node, parent.children[i - 1]];
                            redraw();
                            schedulePreview();
                        }
                    }));

                    actionsWrap.appendChild(createActionButton('删除分支', () => {
                        syncTreeFromInputs();
                        parent.children = parent.children.filter(ch => ch !== node);
                        redraw();
                        schedulePreview();
                    }, true));
                }

                headerRow.appendChild(actionsWrap);
                card.appendChild(headerRow);

                const input = document.createElement('input');
                input.className = 'form-input mindmap-node-input';
                input.maxLength = 120;
                input.value = node.text || '';
                input._boundNode = node;
                input.placeholder = '输入节点文本内容';
                input.addEventListener('input', () => {
                    node.text = input.value;
                    schedulePreview();
                });
                card.appendChild(input);

                treeScroll.appendChild(card);
                
                if (!node._collapsed) {
                    (node.children || []).forEach(child => visit(child, node, depth + 1));
                }
            }

            visit(tree, null, 0);
        }

        async function fetchPreview(options = {}) {
            syncTreeFromInputs();
            try {
                const response = await apiFetch(`${API_BASE}/apps/mindmaps/preview`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ tree, theme: currentTheme })
                });
                const data = await response.json().catch(() => ({}));
                if (!response.ok) throw new Error(data.error || '脑图预览失败。');
                lastSvgString = data.svg || '';
                PivotSafeHtml.setHtml(stage, data.svg, { USE_PROFILES: { html: true, svg: true, svgFilters: true } });
                stage.classList.remove('mindmap-stage-pulse');
                void stage.offsetWidth;
                stage.classList.add('mindmap-stage-pulse');
                if (options.showFeedback) {
                    showToast('导图预览已更新', 'success');
                }
            } catch (error) {
                showToast(error.message, 'error');
            }
        }

        redraw();
        void fetchPreview();
        container.prepend(workbench);
    }

    window.Pivot.exposeModule('chat.mindmapEditor', { mount });
}());
