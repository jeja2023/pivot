/* eslint-disable no-undef -- Split regulations modules resolve names through PivotRegulationsInternal. */
(function () {
    const ns = window.PivotRegulationsInternal;
    if (!ns) throw new Error('Pivot regulations core is not loaded');
    if (ns.actionsAdvancedReady) return;
    with (ns) {
            const REG_GRAPH_REL_COLORS = {
                        cite: '#10a37f',
                        depend: '#2563eb',
                        supersede: '#d97706',
                        apply: '#7c3aed'
                    };

                    async function showCitationGraph(docId) {
                        const panel = document.getElementById('regulations-graph-panel');
                        const body = document.getElementById('regulations-graph-body');
                        if (!panel || !body) return;
                        panel.classList.remove('hidden');
                        PivotSafeHtml.setHtml(body, '<div class="regulations-loading">正在加载引用网络…</div>');
                        try {
                            const resp = await fetchJson(`${API}/documents/${encodeURIComponent(docId)}/citation-graph`);
                            renderCitationGraph(body, resp.graph || null);
                        } catch (e) {
                            PivotSafeHtml.setHtml(body, `<div class="regulations-empty compact">${esc(e.message || '加载引用网络失败')}</div>`);
                        }
                    }

                    function getCitationNodeLabel(node, fallback = '') {
                        const label = cleanDisplayTitle(node?.label || node?.title || fallback, fallback || '\u6761\u6587');
                        const title = cleanDisplayTitle(node?.title || '', '');
                        if (title && title !== label) return `${label} ${title}`;
                        return label;
                    }

                    function getCitationRelationLabel(type) {
                        const labelMap = { cite: '\u5f15\u7528', depend: '\u4f9d\u636e', supersede: '\u5e9f\u6b62/\u4fee\u8ba2', apply: '\u9002\u7528' };
                        return labelMap[type] || type || '\u5f15\u7528';
                    }

                    function truncateCitationLine(value, maxLength) {
                        const text = String(value || '').replace(/\s+/g, '').trim();
                        if (!text) return '';
                        return text.length > maxLength ? `${text.slice(0, Math.max(1, maxLength - 1))}\u2026` : text;
                    }

                    function getCitationNodeLines(node, fallback = '') {
                        const label = cleanDisplayTitle(node?.label || fallback, fallback || '\u6761\u6587');
                        const title = cleanDisplayTitle(node?.title || '', '');
                        const first = truncateCitationLine(label, 10);
                        const secondSource = title && title !== label ? title : '';
                        const second = truncateCitationLine(secondSource, 10);
                        return second ? [first, second] : [truncateCitationLine(getCitationNodeLabel(node, fallback), 11)];
                    }
                    function renderCitationGraph(container, graph) {
                        if (!container) return;
                        const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
                        const edges = Array.isArray(graph?.edges) ? graph.edges : [];
                        if (!nodes.length) {
                            PivotSafeHtml.setHtml(container, '<div class="regulations-empty compact">\u8be5\u6587\u6863\u6682\u65e0\u6761\u6587\u8282\u70b9</div>');
                            return;
                        }
                        const nodeById = new Map(nodes.map(node => [String(node.id), node]));
                        const internalEdges = edges.filter(edge => {
                            const source = String(edge?.source ?? '');
                            const target = String(edge?.target ?? '');
                            return source && target && !edge.external && nodeById.has(source) && nodeById.has(target);
                        });
                        if (!internalEdges.length) {
                            PivotSafeHtml.setHtml(container, '<div class="regulations-empty compact">\u8be5\u6587\u6863\u6761\u6587\u4e4b\u95f4\u6682\u65e0\u5df2\u89e3\u6790\u7684\u5f15\u7528\u5173\u7cfb</div>');
                            return;
                        }

                        const involvedIds = new Set();
                        const degree = new Map();
                        internalEdges.forEach(edge => {
                            const source = String(edge.source);
                            const target = String(edge.target);
                            involvedIds.add(source);
                            involvedIds.add(target);
                            degree.set(source, (degree.get(source) || 0) + 1);
                            degree.set(target, (degree.get(target) || 0) + 1);
                        });
                        const involvedNodes = nodes
                            .filter(node => involvedIds.has(String(node.id)))
                            .sort((a, b) => Number(a.sortOrder || 0) - Number(b.sortOrder || 0) || Number(a.id) - Number(b.id));
                        const graphNodeLimit = internalEdges.length > 80 ? 32 : internalEdges.length > 40 ? 40 : 56;
                        const rankedNodes = involvedNodes.slice().sort((a, b) => {
                            const diff = (degree.get(String(b.id)) || 0) - (degree.get(String(a.id)) || 0);
                            if (diff) return diff;
                            return Number(a.sortOrder || 0) - Number(b.sortOrder || 0) || Number(a.id) - Number(b.id);
                        });
                        const rankedEdges = internalEdges.slice().sort((a, b) => {
                            const scoreA = (degree.get(String(a.source)) || 0) + (degree.get(String(a.target)) || 0);
                            const scoreB = (degree.get(String(b.source)) || 0) + (degree.get(String(b.target)) || 0);
                            return scoreB - scoreA;
                        });
                        const visibleIdSeed = new Set();
                        rankedEdges.forEach(edge => {
                            if (visibleIdSeed.size >= graphNodeLimit) return;
                            const source = String(edge.source);
                            const target = String(edge.target);
                            if (visibleIdSeed.has(source) && visibleIdSeed.has(target)) return;
                            if (visibleIdSeed.size <= graphNodeLimit - 2) {
                                visibleIdSeed.add(source);
                                visibleIdSeed.add(target);
                            }
                        });
                        rankedNodes.forEach(node => {
                            if (visibleIdSeed.size < graphNodeLimit) visibleIdSeed.add(String(node.id));
                        });
                        const visibleNodes = involvedNodes.filter(node => visibleIdSeed.has(String(node.id)));
                        const visibleIds = new Set(visibleNodes.map(node => String(node.id)));
                        const visibleEdges = internalEdges.filter(edge => visibleIds.has(String(edge.source)) && visibleIds.has(String(edge.target)));

                        const cols = visibleNodes.length <= 6 ? 2 : visibleNodes.length <= 16 ? 4 : visibleNodes.length <= 28 ? 5 : 6;
                        const cellW = 162;
                        const cellH = 82;
                        const marginX = 48;
                        const marginY = 44;
                        const rows = Math.max(Math.ceil(visibleNodes.length / cols), 1);
                        const width = Math.max(820, marginX * 2 + cols * cellW);
                        const height = Math.max(360, marginY * 2 + rows * cellH);
                        const positions = new Map();
                        visibleNodes.forEach((node, index) => {
                            const row = Math.floor(index / cols);
                            const col = index % cols;
                            positions.set(String(node.id), {
                                x: marginX + col * cellW + cellW / 2,
                                y: marginY + row * cellH
                            });
                        });

                        const arrowId = `reg-arrow-${String(graph?.document?.id || 'current').replace(/[^a-zA-Z0-9_-]/g, '')}`;
                        const edgePaths = visibleEdges.map((edge, index) => {
                            const source = positions.get(String(edge.source));
                            const target = positions.get(String(edge.target));
                            if (!source || !target) return '';
                            const color = REG_GRAPH_REL_COLORS[edge.type] || '#64748b';
                            const midX = (source.x + target.x) / 2;
                            const bend = (index % 2 === 0 ? 1 : -1) * Math.min(46, Math.max(18, Math.abs(source.x - target.x) * 0.08 + Math.abs(source.y - target.y) * 0.12));
                            const d = `M ${source.x.toFixed(1)} ${source.y.toFixed(1)} C ${midX.toFixed(1)} ${(source.y + bend).toFixed(1)}, ${midX.toFixed(1)} ${(target.y - bend).toFixed(1)}, ${target.x.toFixed(1)} ${target.y.toFixed(1)}`;
                            return `<path d="${d}" fill="none" stroke="${color}" stroke-width="1.4" stroke-opacity="0.42" marker-end="url(#${arrowId})"></path>`;
                        }).join('');

                        const nodeItems = visibleNodes.map(node => {
                            const p = positions.get(String(node.id));
                            if (!p) return '';
                            const label = getCitationNodeLabel(node, `\u6761\u6587 ${node.id}`);
                            const lines = getCitationNodeLines(node, `\u6761\u6587 ${node.id}`);
                            const count = degree.get(String(node.id)) || 0;
                            const lineY = lines.length > 1 ? [p.y - 5, p.y + 10] : [p.y + 4];
                            const textLines = lines.map((line, index) => `<tspan x="${p.x.toFixed(1)}" y="${lineY[index].toFixed(1)}">${esc(line)}</tspan>`).join('');
                            return `
                                <g class="regulations-graph-node" data-graph-doc="${esc(graph.document?.id || '')}" data-graph-article="${esc(node.id)}" tabindex="0">
                                    <title>${esc(label)} \u00b7 ${count} \u6761\u5173\u7cfb</title>
                                    <rect x="${(p.x - 66).toFixed(1)}" y="${(p.y - 24).toFixed(1)}" width="132" height="48" rx="7"></rect>
                                    <text x="${p.x.toFixed(1)}" y="${lineY[0].toFixed(1)}" text-anchor="middle">${textLines}</text>
                                </g>
                            `;
                        }).join('');
                        const legend = Object.entries(REG_GRAPH_REL_COLORS).map(([type, color]) => {
                            const used = internalEdges.some(edge => (edge.type || 'cite') === type);
                            if (!used) return '';
                            return `<span class="regulations-graph-legend-item"><i style="background:${color}"></i>${getCitationRelationLabel(type)}</span>`;
                        }).join('');

                        const getNodeSort = id => Number(nodeById.get(String(id))?.sortOrder || 0);
                        const sortedEdges = internalEdges.slice().sort((a, b) => getNodeSort(a.source) - getNodeSort(b.source) || getNodeSort(a.target) - getNodeSort(b.target));
                        const edgeList = sortedEdges.map(edge => {
                            const sourceNode = nodeById.get(String(edge.source));
                            const targetNode = nodeById.get(String(edge.target));
                            const sourceLabel = getCitationNodeLabel(sourceNode, `\u6761\u6587 ${edge.source}`);
                            const targetLabel = getCitationNodeLabel(targetNode, edge.targetLabel || `\u6761\u6587 ${edge.target}`);
                            const color = REG_GRAPH_REL_COLORS[edge.type] || '#64748b';
                            return `
                                <div class="regulations-graph-edge-item">
                                    <button class="regulations-graph-edge-link" type="button" data-graph-doc="${esc(graph.document?.id || '')}" data-graph-article="${esc(edge.source)}" title="${esc(sourceLabel)}">${esc(sourceLabel)}</button>
                                    <span class="regulations-graph-edge-type" style="--edge-color:${color}">${esc(getCitationRelationLabel(edge.type || 'cite'))}</span>
                                    <button class="regulations-graph-edge-link" type="button" data-graph-doc="${esc(graph.document?.id || '')}" data-graph-article="${esc(edge.target)}" title="${esc(targetLabel)}">${esc(targetLabel)}</button>
                                </div>
                            `;
                        }).join('');
                        const hiddenNodeCount = Math.max(involvedNodes.length - visibleNodes.length, 0);
                        const hiddenEdgeCount = Math.max(internalEdges.length - visibleEdges.length, 0);

                        PivotSafeHtml.setHtml(container, `
                            <div class="regulations-graph-summary">
                                <span><strong>${internalEdges.length}</strong> \u6761\u5173\u7cfb</span>
                                <span><strong>${involvedNodes.length}</strong> \u4e2a\u76f8\u5173\u6761\u6587</span>
                                <span><strong>${nodes.length}</strong> \u4e2a\u5168\u6587\u6761\u6587</span>
                            </div>
                            <div class="regulations-graph-legend">${legend}</div>
                            <div class="regulations-graph-layout">
                                <div class="regulations-graph-canvas-wrap">
                                    <div class="regulations-graph-canvas-head"><strong>\u6838\u5fc3\u56fe</strong><span>\u6309\u6761\u6587\u5173\u8054\u5ea6\u4f18\u5148\u663e\u793a</span></div>
                                    <div class="regulations-graph-canvas-scroll">
                                    <svg class="regulations-graph-svg" viewBox="0 0 ${width} ${height}" width="100%" height="${height}">
                                        <defs>
                                            <marker id="${arrowId}" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto" markerUnits="strokeWidth">
                                                <path d="M0,0 L6,3 L0,6 Z" fill="#64748b"></path>
                                            </marker>
                                        </defs>
                                        ${edgePaths}
                                        ${nodeItems}
                                    </svg>
                                    </div>
                                    ${hiddenNodeCount || hiddenEdgeCount ? `<div class="regulations-graph-note">\u6838\u5fc3\u56fe\u4f18\u5148\u663e\u793a ${visibleNodes.length} \u4e2a\u9ad8\u5173\u8054\u6761\u6587\u3001${visibleEdges.length} \u6761\u5173\u7cfb\uff1b\u53f3\u4fa7\u5217\u8868\u4fdd\u7559\u5168\u90e8 ${internalEdges.length} \u6761\u5173\u7cfb\u3002</div>` : ''}
                                </div>
                                <div class="regulations-graph-edge-list">
                                    <div class="regulations-graph-edge-list-head">\u5173\u7cfb\u660e\u7ec6\uff08${internalEdges.length}\uff09</div>
                                    ${edgeList}
                                </div>
                            </div>
                        `);
                    }
                    // #7 导入预览：解析条文、展示并允许合并，最终回填到导入表单或直接入库
                    // #10 条文批注：打开面板、加载、提交、删除
                    async function showAnnotations(articleId) {
                        const panel = document.getElementById('regulations-annotation-panel');
                        const body = document.getElementById('regulations-annotation-body');
                        if (!panel || !body) return;
                        panel.dataset.articleId = articleId;
                        panel.classList.remove('hidden');
                        PivotSafeHtml.setHtml(body, '<div class="regulations-loading">正在加载批注…</div>');
                        try {
                            const resp = await fetchJson(`${API}/articles/${encodeURIComponent(articleId)}/annotations`);
                            renderAnnotations(body, Array.isArray(resp.annotations) ? resp.annotations : [], articleId);
                        } catch (e) {
                            PivotSafeHtml.setHtml(body, `<div class="regulations-empty compact">${esc(e.message || '加载批注失败')}</div>`);
                        }
                    }

                    function renderAnnotations(body, annotations, articleId) {
                        const currentUserId = (typeof currentUser !== 'undefined' ? currentUser : window.currentUser)?.id;
                        PivotSafeHtml.setHtml(body, `
                            <form class="regulations-annotation-form" data-annotation-article="${esc(articleId)}">
                                <textarea class="form-input" name="content" rows="3" placeholder="输入内部理解、适用案例或注意事项…" required></textarea>
                                <div class="regulations-admin-actions">
                                    <button type="submit" class="btn-primary">提交批注</button>
                                </div>
                            </form>
                            <div class="regulations-annotation-list">
                                ${annotations.length ? annotations.map(a => `
                                    <div class="regulations-annotation-item">
                                        <div class="regulations-annotation-meta">
                                            <strong>${esc(a.user_name || '匿名')}</strong>
                                            <span>${esc(a.updated_at || a.created_at || '')}</span>
                                            ${Number(a.user_id) === Number(currentUserId) ? `<button class="btn-text regulations-annotation-delete" type="button" data-annotation-delete="${esc(a.id)}" data-annotation-article="${esc(articleId)}">删除</button>` : ''}
                                        </div>
                                        <div class="regulations-annotation-content">${esc(a.content)}</div>
                                    </div>
                                `).join('') : '<div class="regulations-empty compact">暂无批注，添加第一条吧</div>'}
                            </div>
                        `);
                    }

                    async function submitAnnotation(form) {
                        const articleId = form.dataset.annotationArticle;
                        const content = form.querySelector('[name="content"]')?.value?.trim();
                        if (!content) {
                            toast('请输入批注内容', 'warning');
                            return;
                        }
                        try {
                            await fetchJson(`${API}/articles/${encodeURIComponent(articleId)}/annotations`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ content })
                            });
                            toast('批注已提交', 'success');
                            showAnnotations(articleId);
                        } catch (e) {
                            toast(e.message || '提交失败', 'error');
                        }
                    }

                    async function deleteAnnotation(annotationId, articleId) {
                        if (!(await regulationConfirm('删除批注', '确定删除该批注吗？'))) return;
                        try {
                            await fetchJson(`${API}/annotations/${encodeURIComponent(annotationId)}`, { method: 'DELETE' });
                            toast('批注已删除', 'success');
                            showAnnotations(articleId);
                        } catch (e) {
                            toast(e.message || '删除失败', 'error');
                        }
                    }

                    // #11 导出合规报告：把某轮问答生成 Markdown 并下载
                    async function exportRegulationReport(turnIndex) {
                        const turn = state.aiTurns[turnIndex];
                        if (!turn) return;
                        setBusy(true, '正在生成报告...');
                        try {
                            const resp = await fetchJson(`${API}/report`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ question: turn.question, answer: turn.answer, sources: turn.sources || [] })
                            });
                            const blob = new Blob([resp.markdown || ''], { type: 'text/markdown;charset=utf-8' });
                            const url = URL.createObjectURL(blob);
                            const a = document.createElement('a');
                            a.href = url;
                            a.download = `法规查询报告_${Date.now()}.md`;
                            document.body.appendChild(a);
                            a.click();
                            document.body.removeChild(a);
                            URL.revokeObjectURL(url);
                            toast('报告已导出', 'success');
                        } catch (e) {
                            toast(e.message || '导出失败', 'error');
                        } finally {
                            setBusy(false);
                        }
                    }

                    async function previewRegulationImport() {
                        const form = document.getElementById('regulations-upload-form');
                        if (!form) return;
                        const fileInput = form.querySelector('input[name="file"]');
                        const files = fileInput?.files;
                        if (!files?.length) {
                            toast('请先选择文件', 'warning');
                            return;
                        }
                        if (files.length > 1) {
                            toast('预览模式仅支持单文件，批量导入请直接提交', 'warning');
                            return;
                        }
                        const file = files[0];
                        const formData = new FormData();
                        formData.append('file', file);
                        // 读取表单元数据传给解析端
                        const metadata = collectForm(form);
                        Object.keys(metadata).forEach(k => {
                            if (k !== 'file') formData.append(k, metadata[k] || '');
                        });
                        setBusy(true, '正在解析文档...');
                        try {
                            const resp = await fetchJson(`${API}/documents/preview`, { method: 'POST', body: formData });
                            showPreviewPanel(resp, file, metadata);
                        } catch (e) {
                            toast(e.message || '预览失败', 'error');
                        } finally {
                            setBusy(false);
                        }
                    }

                    function showPreviewPanel(preview, file, metadata) {
                        const panel = document.getElementById('regulations-preview-panel');
                        const body = document.getElementById('regulations-preview-body');
                        if (!panel || !body) return;
                        const articles = Array.isArray(preview.articles) ? preview.articles : [];
                        const articleCount = Number(preview.articleCount || 0) || articles.length;
                        PivotSafeHtml.setHtml(body, `
                            <div class="regulations-preview-summary">
                                <strong>${esc(preview.title || file.name)}</strong>
                                <span>${articleCount} 条</span>
                            </div>
                            <div class="regulations-preview-articles" id="regulations-preview-list">
                                ${articles.map((a, i) => `
                                    <div class="regulations-preview-article" data-preview-index="${i}">
                                        <div class="regulations-preview-article-head">
                                            <input type="checkbox" class="regulations-preview-checkbox" data-preview-check="${i}" />
                                            <strong>${esc(a.articleLabel || `条目 ${i + 1}`)}</strong>
                                            ${a.articleTitle ? `<span class="regulations-preview-title">${esc(a.articleTitle)}</span>` : ''}
                                        </div>
                                        <div class="regulations-preview-content">${esc(a.content?.substring(0, 200) || '')}${a.content?.length > 200 ? '…' : ''}</div>
                                    </div>
                                `).join('')}
                            </div>
                            <div class="regulations-admin-actions">
                                <button type="button" class="btn-secondary" data-preview-merge>合并选中条文</button>
                                <button type="button" class="btn-primary" data-preview-confirm>确认入库</button>
                            </div>
                        `);
                        // 缓存预览数据供确认时提交
                        panel.dataset.previewFile = file.name;
                        panel.dataset.previewData = JSON.stringify({ articles, metadata, file: { name: file.name, size: file.size } });
                        panel.classList.remove('hidden');
                    }

                    // #13 修订时间线：按版本施行日期排序展示，点击切换版本
                    function showVersionTimeline(docId) {
                        const panel = document.getElementById('regulations-timeline-panel');
                        const body = document.getElementById('regulations-timeline-body');
                        if (!panel || !body) return;
                        const versions = (state.detail?.versions || []).slice();
                        // 按版本 id 升序（早→晚），版本标识多为施行日期
                        versions.sort((a, b) => Number(a.id) - Number(b.id));
                        if (!versions.length) {
                            PivotSafeHtml.setHtml(body, '<div class="regulations-empty compact">暂无版本</div>');
                        } else {
                            PivotSafeHtml.setHtml(body, `
                                <div class="regulations-timeline">
                                    ${versions.map(v => `
                                        <button class="regulations-timeline-node ${Number(v.id) === Number(state.detail?.currentVersion?.id) ? 'active' : ''}" type="button" data-timeline-version="${esc(v.id)}" data-timeline-doc="${esc(docId)}">
                                            <span class="regulations-timeline-dot"></span>
                                            <span class="regulations-timeline-label">${esc(v.version_label || `版本 ${v.id}`)}</span>
                                            <span class="regulations-timeline-meta">${Number(v.article_count || 0)} 条${v.is_current ? ' · 当前版本' : ''}</span>
                                        </button>
                                    `).join('')}
                                </div>
                            `);
                        }
                        panel.classList.remove('hidden');
                    }

                    async function showCompareDialog(docId) {
                        const versions = state.detail?.versions || [];
                        if (versions.length < 2) {
                            toast('至少需要两个版本才能对比', 'warning');
                            return;
                        }
                        const panel = document.getElementById('regulations-compare-panel');
                        const body = document.getElementById('regulations-compare-body');
                        if (!panel || !body) return;
                        PivotSafeHtml.setHtml(body, `
                            <form id="regulations-compare-form" data-doc-id="${esc(docId)}">
                                <div class="regulations-admin-group">
                                    <label>从版本
                                        <select name="from" class="form-input" required>
                                            ${versions.map(v => `<option value="${esc(v.id)}">${esc(v.version_label || `版本 ${v.id}`)}</option>`).join('')}
                                        </select>
                                    </label>
                                    <label>到版本
                                        <select name="to" class="form-input" required>
                                            ${versions.map((v, i) => `<option value="${esc(v.id)}" ${i === 0 ? 'selected' : ''}>${esc(v.version_label || `版本 ${v.id}`)}</option>`).join('')}
                                        </select>
                                    </label>
                                </div>
                                <div class="regulations-admin-actions">
                                    <button type="submit" class="btn-primary">生成对比</button>
                                    <button type="button" class="btn-secondary" data-regulation-impact>影响分析</button>
                                </div>
                            </form>
                            <div id="regulations-diff-result"></div>
                        `);
                        panel.classList.remove('hidden');
                        focusFirstField(body);
                    }

                    async function runChangeImpact(form) {
                        const docId = form.dataset.docId;
                        const data = collectForm(form);
                        const result = document.getElementById('regulations-diff-result');
                        if (!result) return;
                        setBusy(true, '正在分析变更影响...');
                        try {
                            const resp = await fetchJson(`${API}/documents/${encodeURIComponent(docId)}/change-impact?from=${encodeURIComponent(data.from)}&to=${encodeURIComponent(data.to)}`);
                            renderChangeImpact(result, resp.impact || null);
                        } catch (e) {
                            toast(e.message || '影响分析失败', 'error');
                        } finally {
                            setBusy(false);
                        }
                    }

                    function renderChangeImpact(container, impact) {
                        if (!container) return;
                        if (!impact) {
                            PivotSafeHtml.setHtml(container, '<div class="regulations-empty compact">无影响分析结果</div>');
                            return;
                        }
                        const impacts = Array.isArray(impact.impacts) ? impact.impacts : [];
                        const summary = impact.summary || {};
                        if (!impacts.length) {
                            PivotSafeHtml.setHtml(container, `
                                <div class="regulations-diff-summary">
                                    <strong>变更影响分析</strong>
                                    <span>变更 ${summary.changed || 0} · 删除 ${summary.removed || 0}</span>
                                    <span>本次变更的条文未被库内其它条文引用，影响面较小。</span>
                                </div>
                            `);
                            return;
                        }
                        PivotSafeHtml.setHtml(container, `
                            <div class="regulations-diff-summary">
                                <strong>变更影响分析</strong>
                                <span>${impacts.length} 个变更条文被引用，需关注以下受影响条文</span>
                            </div>
                            ${impacts.map(item => `
                                <div class="regulations-diff-article changed">
                                    <strong>${esc(item.label)} 被引用</strong>
                                    <div class="regulations-impact-referers">
                                        ${(item.internalReferers || []).map(r => `
                                            <button class="regulations-impact-referer" type="button" data-regulation-match-doc="${esc(impact.document?.id || '')}" data-regulation-match-article="${esc(r.article_id)}">
                                                本法 ${esc(r.article_label)}${r.article_title ? ` ${esc(r.article_title)}` : ''}
                                            </button>
                                        `).join('')}
                                        ${(item.crossReferers || []).map(r => `
                                            <button class="regulations-impact-referer cross" type="button" data-regulation-match-doc="${esc(r.document_id)}" data-regulation-match-article="${esc(r.article_id)}">
                                                ${esc(r.document_title)} ${esc(r.article_label)}
                                            </button>
                                        `).join('')}
                                    </div>
                                </div>
                            `).join('')}
                        `);
                    }

                    async function runCompare(form) {
                        const docId = form.dataset.docId;
                        const data = collectForm(form);
                        const result = document.getElementById('regulations-diff-result');
                        if (!result) return;
                        setBusy(true, '正在生成版本对比...');
                        try {
                            const diff = await fetchJson(`${API}/documents/${encodeURIComponent(docId)}/diff?from=${encodeURIComponent(data.from)}&to=${encodeURIComponent(data.to)}`);
                            state.diffView = diff.diff || null;
                            renderDiff(result);
                        } catch (e) {
                            toast(e.message || '版本对比失败', 'error');
                        } finally {
                            setBusy(false);
                        }
                    }

                    function renderDiff(container) {
                        if (!container || !state.diffView) return;
                        const diff = state.diffView;
                        const summary = diff.summary || {};
                        const addedHtml = (diff.added || []).length ? `
                            <div class="regulations-diff-section">
                                <div class="regulations-section-head compact"><strong>新增条文</strong><span>${diff.added.length} 条</span></div>
                                ${diff.added.map(a => `
                                    <div class="regulations-diff-article added">
                                        <strong>${esc(a.label)}</strong>
                                        <span>${esc(cleanArticleTitle(a.title))}</span>
                                        <pre>${esc(a.content)}</pre>
                                    </div>
                                `).join('')}
                            </div>
                        ` : '';
                        const removedHtml = (diff.removed || []).length ? `
                            <div class="regulations-diff-section">
                                <div class="regulations-section-head compact"><strong>删除条文</strong><span>${diff.removed.length} 条</span></div>
                                ${diff.removed.map(a => `
                                    <div class="regulations-diff-article removed">
                                        <strong>${esc(a.label)}</strong>
                                        <span>${esc(cleanArticleTitle(a.title))}</span>
                                        <pre>${esc(a.content)}</pre>
                                    </div>
                                `).join('')}
                            </div>
                        ` : '';
                        const changedHtml = (diff.changed || []).length ? `
                            <div class="regulations-diff-section">
                                <div class="regulations-section-head compact"><strong>变更条文</strong><span>${diff.changed.length} 条</span></div>
                                ${diff.changed.map(a => `
                                    <div class="regulations-diff-article changed">
                                        <strong>${esc(a.label)}</strong>
                                        <span>${esc(cleanArticleTitle(a.title))}</span>
                                        <div class="regulations-diff-lines">
                                            ${(a.segments || []).map(seg => {
                                                if (seg.type === 'add') return `<div class="diff-line added">+ ${esc(seg.text)}</div>`;
                                                if (seg.type === 'del') return `<div class="diff-line removed">- ${esc(seg.text)}</div>`;
                                                return `<div class="diff-line eq">${esc(seg.text)}</div>`;
                                            }).join('')}
                                        </div>
                                    </div>
                                `).join('')}
                            </div>
                        ` : '';
                        PivotSafeHtml.setHtml(container, `
                            <div class="regulations-diff-summary">
                                <strong>${esc(diff.document?.title || '文档')}</strong>
                                <span>${esc(diff.from?.version_label || `版本 ${diff.from?.id}`)} → ${esc(diff.to?.version_label || `版本 ${diff.to?.id}`)}</span>
                                <span>新增 ${summary.added || 0} · 删除 ${summary.removed || 0} · 变更 ${summary.changed || 0}</span>
                            </div>
                            ${addedHtml}${removedHtml}${changedHtml}
                        `);
                    }

                    function syncImportHint(form) {
                        const fileInput = form?.querySelector('#regulations-upload-file');
                        const submitBtn = form?.querySelector('#regulations-upload-submit');
                        if (!fileInput || !submitBtn) return;
                        syncFileInputState(fileInput);
                        const count = Number(fileInput.files?.length || 0);
                        submitBtn.textContent = count > 1 ? `批量导入 ${count} 个文档` : '上传入库';
                    }

                    function getFileSelectionText(fileInput) {
                        const files = Array.from(fileInput?.files || []);
                        if (!files.length) return '未选择文件';
                        if (files.length === 1) {
                            const file = files[0];
                            return `${file.name || '已选择文件'}${file.size ? ` · ${fmtSize(file.size)}` : ''}`;
                        }
                        const totalSize = files.reduce((sum, file) => sum + Number(file.size || 0), 0);
                        return `已选择 ${files.length} 个文档${totalSize ? ` · 共 ${fmtSize(totalSize)}` : ''}`;
                    }

                    function syncFileInputState(fileInput) {
                        const summary = fileInput?.closest('.regulations-file-field')?.querySelector('.regulations-file-summary');
                        if (summary) summary.textContent = getFileSelectionText(fileInput);
                    }

        Object.assign(ns, {
            showCitationGraph,
            renderCitationGraph,
            showAnnotations,
            renderAnnotations,
            submitAnnotation,
            deleteAnnotation,
            exportRegulationReport,
            previewRegulationImport,
            showPreviewPanel,
            showVersionTimeline,
            showCompareDialog,
            runChangeImpact,
            renderChangeImpact,
            runCompare,
            renderDiff,
            syncImportHint,
            getFileSelectionText,
            syncFileInputState,
            actionsAdvancedReady: true
        });
    }
})();
