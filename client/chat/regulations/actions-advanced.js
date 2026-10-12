(function () {
    const ns = window.Pivot.legacy.PivotRegulationsInternal;
    if (!ns) throw new Error('法规库核心模块未加载');
    if (ns.actionsAdvancedReady) return;

    const { API, state, esc, cleanDisplayTitle, cleanArticleTitle, toast, fetchJson, regulationConfirm, fmtDate, fmtSize } = ns;
    const setBusy = (...args) => ns.setBusy?.(...args);
    const collectForm = (...args) => ns.collectForm?.(...args);
    const focusFirstField = (...args) => ns.focusFirstField?.(...args);
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

                    async function showAccessLogs(documentId) {
                        const panel = document.getElementById('regulations-access-log-panel');
                        const body = document.getElementById('regulations-access-log-body');
                        if (!panel || !body || !documentId) return;
                        panel.classList.remove('hidden');
                        PivotSafeHtml.setHtml(body, '<div class="regulations-loading">正在加载访问记录…</div>');
                        try {
                            const data = await fetchJson(`${API}/access-logs?documentId=${encodeURIComponent(documentId)}&limit=100`);
                            const rows = Array.isArray(data.data) ? data.data : [];
                            PivotSafeHtml.setHtml(body, rows.length ? `
                                <div class="table-container workspace-table-wrap">
                                    <table class="data-table compact-table">
                                        <thead><tr><th>时间</th><th>用户</th><th>操作</th><th>详情</th></tr></thead>
                                        <tbody>${rows.map(row => `<tr><td>${esc(fmtDate(row.created_at))}</td><td>${esc(row.user_name || '-')}</td><td>${esc(row.action || '-')}</td><td>${esc(row.detail || '-')}</td></tr>`).join('')}</tbody>
                                    </table>
                                </div>` : '<div class="regulations-empty compact">暂无访问记录</div>');
                        } catch (error) {
                            PivotSafeHtml.setHtml(body, `<div class="regulations-empty compact">${esc(error.message || '加载访问记录失败')}</div>`);
                        }
                    }

                    async function showRegulationAiLogs(documentId) {
                        const panel = document.getElementById('regulations-ai-log-panel');
                        const body = document.getElementById('regulations-ai-log-body');
                        if (!panel || !body || !documentId) return;
                        panel.classList.remove('hidden');
                        PivotSafeHtml.setHtml(body, '<div class="regulations-loading">正在读取问答审计记录…</div>');
                        try {
                            const data = await fetchJson(`${API}/ai-logs?documentId=${encodeURIComponent(documentId)}&limit=30`);
                            const rows = Array.isArray(data.data) ? data.data : [];
                            const sourceLabels = item => {
                                const sources = Array.isArray(item.sources_json) ? item.sources_json : [];
                                return sources.map(source => source.label || '').filter(Boolean).join('；') || '未命中可用依据';
                            };
                            PivotSafeHtml.setHtml(body, rows.length ? `
                                <div class="regulations-ai-audit-list">
                                    ${rows.map(row => `<article class="regulations-ai-audit-item">
                                        <div class="regulations-annotation-meta"><strong>${esc(row.question || '未命名问题')}</strong><span>${esc(fmtDate(row.created_at))}</span></div>
                                        <div class="regulations-ai-audit-model">模型：${esc(row.model_name || '-')} · 依据：${esc(sourceLabels(row))}</div>
                                        <details><summary>查看回答与依据快照</summary><div class="regulations-ai-audit-answer">${esc(row.answer || '模型未返回正文')}</div><div class="regulations-ai-audit-context">${esc(row.context_snapshot || '未保存上下文快照')}</div></details>
                                    </article>`).join('')}
                                </div>` : '<div class="regulations-empty compact">该法规暂无你的问答记录。</div>');
                        } catch (error) {
                            PivotSafeHtml.setHtml(body, `<div class="regulations-empty compact">${esc(error.message || '加载问答记录失败')}</div>`);
                        }
                    }

                    async function showArticleLocations(articleId) {
                        const panel = document.getElementById('regulations-location-panel');
                        const body = document.getElementById('regulations-location-body');
                        if (!panel || !body || !articleId) return;
                        panel.classList.remove('hidden');
                        PivotSafeHtml.setHtml(body, '<div class="regulations-loading">正在读取条文来源定位…</div>');
                        try {
                            const data = await fetchJson(`${API}/articles/${encodeURIComponent(articleId)}/locations`);
                            const locations = Array.isArray(data.locations) ? data.locations : [];
                            const source = data.source || {};
                            const firstPage = Number(locations[0]?.page_number || 1);
                            const sourceAction = source.downloadUrl ? `
                                <div class="regulations-admin-actions regulations-source-actions">
                                    ${source.previewUrl ? `<a class="btn-secondary" href="${esc(source.previewUrl)}#page=${firstPage}" target="_blank" rel="noopener">打开来源 PDF（第 ${firstPage} 页）</a>` : ''}
                                    <a class="btn-secondary" href="${esc(source.downloadUrl)}" target="_blank" rel="noopener">下载同版本原文件${source.fileName ? `：${esc(source.fileName)}` : ''}</a>
                                </div>` : '';
                            PivotSafeHtml.setHtml(body, locations.length ? `
                                <div class="table-container workspace-table-wrap">
                                    <table class="data-table compact-table">
                                        <thead><tr><th>页码</th><th>字符范围</th><th>定位置信度</th></tr></thead>
                                        <tbody>${locations.map(location => `<tr><td>第 ${Number(location.page_number || 1)} 页</td><td>${Number(location.char_start || 0)} - ${Number(location.char_end || 0)}</td><td>${Math.round(Number(location.confidence || 0) * 100)}%</td></tr>`).join('')}</tbody>
                                    </table>
                                </div>${sourceAction}` : `<div class="regulations-empty compact">该条文尚未生成可用来源定位。重新导入或完成页级文字识别后可补全。</div>${sourceAction}`);
                        } catch (error) {
                            PivotSafeHtml.setHtml(body, `<div class="regulations-empty compact">${esc(error.message || '加载条文来源定位失败')}</div>`);
                        }
                    }

                    function renderQualityMetric(label, value, hint = '') {
                        return `<div class="regulations-quality-metric"><strong>${esc(value)}</strong><span>${esc(label)}</span>${hint ? `<small>${esc(hint)}</small>` : ''}</div>`;
                    }

                    async function showQualitySummary() {
                        const panel = document.getElementById('regulations-quality-panel');
                        const body = document.getElementById('regulations-quality-body');
                        if (!panel || !body) return;
                        panel.classList.remove('hidden');
                        PivotSafeHtml.setHtml(body, '<div class="regulations-loading">正在汇总法规质量信息…</div>');
                        try {
                            const data = await fetchJson(`${API}/quality-summary`);
                            const summary = data.summary || {};
                            const documents = summary.documents || {};
                            const versions = summary.versions || {};
                            const links = summary.links || {};
                            const locations = summary.locations || {};
                            const obligations = summary.obligations || {};
                            PivotSafeHtml.setHtml(body, `
                                <div class="regulations-quality-grid">
                                    ${renderQualityMetric('法规文档', documents.total)}
                                    ${renderQualityMetric('元数据待审核', documents.metadataNeedsReview, '含缺少层级、来源或审核信息')}
                                    ${renderQualityMetric('缺少维护人', documents.missingMaintainer)}
                                    ${renderQualityMetric('版本待治理', versions.governanceNeedsReview, '效力或审核状态未确认')}
                                    ${renderQualityMetric('索引未完成', versions.indexingIncomplete)}
                                    ${renderQualityMetric('未解析引用', links.unresolved)}
                                    ${renderQualityMetric('引用待审核', links.needsReview)}
                                    ${renderQualityMetric('条文缺少定位', locations.articlesWithoutLocation)}
                                    ${renderQualityMetric('义务待审核', obligations.needsReview)}
                                </div>
                                <div class="regulations-quality-note">“现行有效”仅表示已由管理员填写并审核的版本状态；请继续以权威来源和组织正式意见为准。</div>
                            `);
                        } catch (error) {
                            PivotSafeHtml.setHtml(body, `<div class="regulations-empty compact">${esc(error.message || '加载质量概览失败')}</div>`);
                        }
                    }

                    async function toggleRegulationSubscription(documentId) {
                        if (!documentId) return;
                        try {
                            const subscriptions = await fetchJson(`${API}/subscriptions?documentId=${encodeURIComponent(documentId)}`);
                            const active = Array.isArray(subscriptions.subscriptions) && subscriptions.subscriptions.length > 0;
                            if (active) {
                                await fetchJson(`${API}/documents/${encodeURIComponent(documentId)}/subscriptions`, { method: 'DELETE' });
                                toast('已取消关注法规更新', 'success');
                            } else {
                                await fetchJson(`${API}/documents/${encodeURIComponent(documentId)}/subscriptions`, {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ approvedOnly: true })
                                });
                                toast('已关注审核通过的法规更新', 'success');
                            }
                            const button = document.querySelector(`[data-regulation-subscribe="${String(documentId).replace(/"/g, '\\"')}"]`);
                            if (button) button.textContent = active ? '关注更新' : '取消关注';
                        } catch (error) {
                            toast(error.message || '关注法规更新失败', 'error');
                        }
                    }

                    async function toggleRegulationBookmark(documentId) {
                        if (!documentId) return;
                        try {
                            const data = await fetchJson(`${API}/bookmarks?documentId=${encodeURIComponent(documentId)}`);
                            const existing = Array.isArray(data.bookmarks) ? data.bookmarks[0] : null;
                            if (existing?.id) {
                                await fetchJson(`${API}/bookmarks/${encodeURIComponent(existing.id)}`, { method: 'DELETE' });
                                toast('已取消收藏法规', 'success');
                            } else {
                                await fetchJson(`${API}/documents/${encodeURIComponent(documentId)}/bookmarks`, {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({})
                                });
                                toast('已收藏法规，可在“我的收藏”中设置专题', 'success');
                            }
                            const button = document.querySelector(`[data-regulation-bookmark="${String(documentId).replace(/"/g, '\\"')}"]`);
                            if (button) button.textContent = existing?.id ? '收藏法规' : '取消收藏';
                        } catch (error) {
                            toast(error.message || '更新法规收藏失败', 'error');
                        }
                    }

                    function renderRegulationBookmarks(bookmarks) {
                        if (!bookmarks.length) return '<div class="regulations-empty compact">暂无收藏。打开法规原文后，点击“收藏法规”即可加入这里。</div>';
                        return `<div class="regulations-bookmark-list">${bookmarks.map(item => `
                            <article class="regulations-bookmark-item">
                                <div><strong>${esc(item.document_title || '未命名法规')}</strong><span>${esc([item.category, item.issuing_body, item.current_version_label].filter(Boolean).join(' · ') || '未设置分类')}</span></div>
                                <label>专题<input class="form-input" data-regulation-bookmark-topic="${esc(item.id)}" value="${esc(item.topic || '')}" maxlength="80" placeholder="如 人事、采购、财务"></label>
                                <div class="regulations-admin-actions">
                                    <button type="button" class="btn-secondary" data-regulation-bookmark-open="${esc(item.document_id)}">打开法规</button>
                                    <button type="button" class="btn-secondary" data-regulation-bookmark-save="${esc(item.id)}" data-regulation-bookmark-document="${esc(item.document_id)}">保存专题</button>
                                    <button type="button" class="btn-secondary" data-regulation-bookmark-delete="${esc(item.id)}">取消收藏</button>
                                </div>
                            </article>`).join('')}</div>`;
                    }

                    async function showRegulationBookmarks() {
                        const panel = document.getElementById('regulations-bookmarks-panel');
                        const body = document.getElementById('regulations-bookmarks-body');
                        if (!panel || !body) return;
                        panel.classList.remove('hidden');
                        PivotSafeHtml.setHtml(body, '<div class="regulations-loading">正在读取收藏法规…</div>');
                        try {
                            const data = await fetchJson(`${API}/bookmarks`);
                            PivotSafeHtml.setHtml(body, renderRegulationBookmarks(Array.isArray(data.bookmarks) ? data.bookmarks : []));
                        } catch (error) {
                            PivotSafeHtml.setHtml(body, `<div class="regulations-empty compact">${esc(error.message || '加载收藏法规失败')}</div>`);
                        }
                    }

                    async function saveRegulationBookmarkTopic(bookmarkId, documentId) {
                        const field = document.querySelector(`[data-regulation-bookmark-topic="${String(bookmarkId).replace(/"/g, '\\"')}"]`);
                        if (!bookmarkId || !documentId || !field) return;
                        try {
                            await fetchJson(`${API}/documents/${encodeURIComponent(documentId)}/bookmarks`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ topic: field.value.trim() })
                            });
                            toast('收藏专题已保存', 'success');
                            await showRegulationBookmarks();
                        } catch (error) {
                            toast(error.message || '保存收藏专题失败', 'error');
                        }
                    }

                    async function deleteRegulationBookmark(bookmarkId) {
                        if (!bookmarkId) return;
                        try {
                            await fetchJson(`${API}/bookmarks/${encodeURIComponent(bookmarkId)}`, { method: 'DELETE' });
                            toast('已取消收藏法规', 'success');
                            await showRegulationBookmarks();
                        } catch (error) {
                            toast(error.message || '取消收藏失败', 'error');
                        }
                    }

                    async function showRegulationRecycleBin() {
                        if (!ns.canDeleteDocuments?.()) return;
                        const panel = document.getElementById('regulations-recycle-bin-panel');
                        const body = document.getElementById('regulations-recycle-bin-body');
                        if (!panel || !body) return;
                        panel.classList.remove('hidden');
                        PivotSafeHtml.setHtml(body, '<div class="regulations-loading">正在读取法规回收站…</div>');
                        try {
                            const data = await fetchJson(`${API}/recycle-bin?limit=100`);
                            const rows = Array.isArray(data.data) ? data.data : [];
                            PivotSafeHtml.setHtml(body, rows.length ? `
                                <div class="table-container workspace-table-wrap"><table class="data-table compact-table">
                                    <thead><tr><th>法规</th><th>分类</th><th>删除时间</th><th>操作</th></tr></thead>
                                    <tbody>${rows.map(item => `<tr><td>${esc(item.title || '-')}</td><td>${esc(item.category || '-')}</td><td>${esc(fmtDate(item.deleted_at))}</td><td><button type="button" class="btn-secondary" data-regulation-restore="${esc(item.id)}">恢复</button></td></tr>`).join('')}</tbody>
                                </table></div>` : '<div class="regulations-empty compact">回收站为空。</div>');
                        } catch (error) {
                            PivotSafeHtml.setHtml(body, `<div class="regulations-empty compact">${esc(error.message || '加载法规回收站失败')}</div>`);
                        }
                    }

                    async function requestRegulationReindex(documentId, versionId) {
                        if (!documentId || !versionId || !ns.canManage?.()) return;
                        setBusy(true, '正在重新排队向量索引…');
                        try {
                            await fetchJson(`${API}/documents/${encodeURIComponent(documentId)}/versions/${encodeURIComponent(versionId)}/reindex`, { method: 'POST' });
                            toast('向量索引已重新排队；失败时会按退避策略有限重试', 'success');
                            await ns.loadDetail?.(documentId, versionId);
                        } catch (error) {
                            toast(error.message || '重新建立向量索引失败', 'error');
                        } finally {
                            setBusy(false);
                        }
                    }

                    async function restoreRegulationFromRecycleBin(documentId) {
                        if (!documentId || !ns.canDeleteDocuments?.()) return;
                        if (!(await regulationConfirm('恢复法规', '恢复后该法规会重新出现在法规目录和检索结果中。确认恢复？'))) return;
                        setBusy(true, '正在恢复法规…');
                        try {
                            await fetchJson(`${API}/recycle-bin/${encodeURIComponent(documentId)}/restore`, { method: 'POST' });
                            toast('法规已恢复', 'success');
                            await showRegulationRecycleBin();
                            await ns.loadDocuments?.({ keepActive: true, page: state.page });
                            await ns.loadFacets?.();
                        } catch (error) {
                            toast(error.message || '恢复法规失败', 'error');
                        } finally {
                            setBusy(false);
                        }
                    }

                    function renderObligationForm(documentId, versionId, articleId, assignees = []) {
                        const assigneeOptions = (Array.isArray(assignees) ? assignees : []).map(item => {
                            const label = [item.nickname || item.username || `用户 ${item.id}`, item.unit].filter(Boolean).join(' · ');
                            return `<option value="${esc(item.id)}">${esc(label)}</option>`;
                        }).join('');
                        return `
                            <form class="regulations-obligation-form" data-obligation-document="${esc(documentId)}" data-obligation-version="${esc(versionId)}" data-obligation-article="${esc(articleId)}">
                                <div class="regulations-admin-group">
                                    <div class="regulations-admin-grid">
                                        <label>适用主体<input name="subject" class="form-input" maxlength="240" placeholder="如 用人单位"></label>
                                        <label>触发条件<input name="triggerCondition" class="form-input" maxlength="1000" placeholder="如 发生法定备案事项"></label>
                                        <label>要求动作<input name="requiredAction" class="form-input" maxlength="1000" placeholder="必填，如 完成备案" required></label>
                                        <label>期限规则<input name="dueRule" class="form-input" maxlength="500" placeholder="如 三十日内"></label>
                                        <label>责任人<select name="ownerUserId" class="form-input"><option value="">审核后待分派</option>${assigneeOptions}</select></label>
                                    </div>
                                    <label>留存凭证<input name="evidenceRequirement" class="form-input" maxlength="1000" placeholder="如 备案回执"></label>
                                </div>
                                <div class="regulations-admin-actions"><button class="btn-primary" type="submit">保存为待审核义务</button></div>
                            </form>`;
                    }

                    async function showRegulationObligations(documentId, articleId = '') {
                        const panel = document.getElementById('regulations-obligation-panel');
                        const body = document.getElementById('regulations-obligation-body');
                        if (!panel || !body || !documentId) return;
                        panel.classList.remove('hidden');
                        PivotSafeHtml.setHtml(body, '<div class="regulations-loading">正在加载合规义务…</div>');
                        try {
                            const query = articleId ? `?articleId=${encodeURIComponent(articleId)}` : '';
                            const data = await fetchJson(`${API}/documents/${encodeURIComponent(documentId)}/obligations${query}`);
                            const obligations = Array.isArray(data.obligations) ? data.obligations : [];
                            const assignees = Array.isArray(data.assignees) ? data.assignees : [];
                            const versionId = state.detail?.currentVersion?.id || '';
                            const canCreate = Boolean(articleId && versionId && ns.canManage?.());
                            const reviewLabel = item => item.review_status === 'approved' ? '已审核' : (item.review_status === 'rejected' ? '已驳回' : '待审核');
                            const reviewAction = item => ns.canManage?.() && item.review_status !== 'approved'
                                ? `<button type="button" class="btn-secondary regulations-obligation-review" data-regulation-obligation-review="${esc(item.id)}" data-regulation-obligation-document="${esc(documentId)}">审核并转为待办</button>`
                                : '';
                            const obligationRows = obligations.length
                                ? obligations.map(item => {
                                    const ownerLabel = item.owner_nickname || item.owner_username || '-';
                                    return `<tr><td>${esc(item.article_label || '-')}</td><td>${esc(item.subject || '-')}</td><td>${esc(item.required_action || '-')}</td><td>${esc(item.due_rule || '-')}</td><td>${esc(ownerLabel)}</td><td><span>${esc(reviewLabel(item))}</span>${reviewAction(item)}</td></tr>`;
                                }).join('')
                                : '<tr><td colspan="6" class="text-center">暂无义务事项</td></tr>';
                            PivotSafeHtml.setHtml(body, `
                                ${canCreate ? renderObligationForm(documentId, versionId, articleId, assignees) : ''}
                                <div class="table-container workspace-table-wrap">
                                    <table class="data-table compact-table">
                                        <thead><tr><th>条文</th><th>主体</th><th>要求动作</th><th>期限</th><th>责任人</th><th>审核/待办</th></tr></thead>
                                        <tbody>${obligationRows || '暂无义务事项'}</tbody>
                                    </table>
                                </div>
                            `);
                        } catch (error) {
                            PivotSafeHtml.setHtml(body, `<div class="regulations-empty compact">${esc(error.message || '加载合规义务失败')}</div>`);
                        }
                    }

                    async function submitRegulationObligation(form) {
                        const documentId = form.dataset.obligationDocument;
                        const versionId = form.dataset.obligationVersion;
                        const articleId = form.dataset.obligationArticle;
                        const payload = collectForm(form);
                        setBusy(true, '正在保存合规义务…');
                        try {
                            await fetchJson(`${API}/documents/${encodeURIComponent(documentId)}/versions/${encodeURIComponent(versionId)}/articles/${encodeURIComponent(articleId)}/obligations`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify(payload)
                            });
                            toast('义务事项已保存，等待人工审核', 'success');
                            await showRegulationObligations(documentId, articleId);
                        } catch (error) {
                            toast(error.message || '保存合规义务失败', 'error');
                        } finally {
                            setBusy(false);
                        }
                    }

                    async function reviewRegulationObligation(documentId, obligationId) {
                        if (!documentId || !obligationId) return;
                        setBusy(true, '正在确认合规义务…');
                        try {
                            await fetchJson(`${API}/documents/${encodeURIComponent(documentId)}/obligations/${encodeURIComponent(obligationId)}/review`, {
                                method: 'PUT',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ reviewStatus: 'approved', status: 'active' })
                            });
                            toast('义务已审核通过，可作为后续任务分派依据', 'success');
                            await showRegulationObligations(documentId);
                        } catch (error) {
                            toast(error.message || '审核合规义务失败', 'error');
                        } finally {
                            setBusy(false);
                        }
                    }

                    function renderAnnotations(body, annotations, articleId) {
                        const currentUserId = (typeof currentUser !== 'undefined' ? currentUser : window.Pivot.legacy.currentUser)?.id;
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
                    async function exportRegulationReport(turnIndex, format = 'md') {
                        const turn = state.aiTurns[turnIndex];
                        if (!turn) return;
                        const safeFormat = ['docx', 'pdf'].includes(String(format).toLowerCase()) ? String(format).toLowerCase() : 'md';
                        const formatLabel = ({ md: 'Markdown', docx: 'Word', pdf: 'PDF' })[safeFormat];
                        setBusy(true, `正在生成 ${formatLabel} 报告...`);
                        try {
                            const resp = await fetchJson(`${API}/report`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ question: turn.question, answer: turn.answer, sources: turn.sources || [], format: safeFormat })
                            });
                            let blob;
                            let fileName;
                            if (safeFormat === 'md') {
                                blob = new Blob([resp.markdown || ''], { type: 'text/markdown;charset=utf-8' });
                                fileName = `法规查询报告_${Date.now()}.md`;
                            } else {
                                const raw = window.atob(String(resp.contentBase64 || ''));
                                const bytes = new Uint8Array(raw.length);
                                for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
                                blob = new Blob([bytes], { type: resp.mimeType || 'application/octet-stream' });
                                fileName = resp.fileName || `法规查询报告_${Date.now()}.${safeFormat}`;
                            }
                            const url = URL.createObjectURL(blob);
                            const a = document.createElement('a');
                            a.href = url;
                            a.download = fileName;
                            document.body.appendChild(a);
                            a.click();
                            document.body.removeChild(a);
                            URL.revokeObjectURL(url);
                            toast(`${formatLabel} 报告已导出`, 'success');
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
                        state.importPreview = {
                            file,
                            metadata,
                            title: preview.title || file.name,
                            articles: articles.map(article => ({
                                articleLabel: article.articleLabel || '',
                                articleTitle: article.articleTitle || '',
                                headingPath: article.headingPath || '',
                                content: article.content || ''
                            }))
                        };
                        renderPreviewPanel();
                        panel.classList.remove('hidden');
                    }

                    function renderPreviewPanel() {
                        const panel = document.getElementById('regulations-preview-panel');
                        const body = document.getElementById('regulations-preview-body');
                        const preview = state.importPreview;
                        if (!panel || !body || !preview) return;
                        const articles = preview.articles || [];
                        const articleCount = articles.length;
                        PivotSafeHtml.setHtml(body, `
                            <div class="regulations-preview-summary">
                                <strong>${esc(preview.title || preview.file?.name || '法规文档')}</strong>
                                <span>${articleCount} 条</span>
                            </div>
                            <div class="regulations-preview-articles" id="regulations-preview-list">
                                ${articles.map((a, i) => `
                                    <div class="regulations-preview-article" data-preview-index="${i}">
                                        <div class="regulations-preview-article-head">
                                            <input type="checkbox" class="regulations-preview-checkbox" data-preview-check="${i}" />
                                            <input class="form-input regulations-preview-label-input" data-preview-label="${i}" maxlength="80" value="${esc(a.articleLabel || `条目 ${i + 1}`)}" aria-label="第 ${i + 1} 条标签">
                                            <input class="form-input regulations-preview-title-input" data-preview-title="${i}" maxlength="120" value="${esc(a.articleTitle || '')}" placeholder="条文标题（可选）" aria-label="第 ${i + 1} 条标题">
                                        </div>
                                        <textarea class="form-input regulations-preview-content-input" data-preview-content="${i}" rows="4" aria-label="第 ${i + 1} 条正文">${esc(a.content || '')}</textarea>
                                    </div>
                                `).join('')}
                            </div>
                            <div class="regulations-admin-actions">
                                <button type="button" class="btn-secondary" data-preview-merge>合并选中条文</button>
                                <button type="button" class="btn-primary" data-preview-confirm>确认入库</button>
                            </div>
                        `);
                    }

                    function readPreviewEdits() {
                        if (!state.importPreview) return false;
                        const articles = state.importPreview.articles || [];
                        for (let index = 0; index < articles.length; index += 1) {
                            const label = document.querySelector(`[data-preview-label="${index}"]`);
                            const title = document.querySelector(`[data-preview-title="${index}"]`);
                            const content = document.querySelector(`[data-preview-content="${index}"]`);
                            if (label) articles[index].articleLabel = label.value.trim();
                            if (title) articles[index].articleTitle = title.value.trim();
                            if (content) articles[index].content = content.value.trim();
                        }
                        return articles.every(article => article.articleLabel && article.content);
                    }

                    function mergePreviewArticles() {
                        if (!state.importPreview || !readPreviewEdits()) {
                            toast('请补全每条的标签和正文后再合并', 'warning');
                            return;
                        }
                        const indexes = Array.from(document.querySelectorAll('.regulations-preview-checkbox:checked'))
                            .map(input => Number(input.dataset.previewCheck))
                            .filter(Number.isInteger)
                            .sort((a, b) => a - b);
                        if (indexes.length < 2 || indexes.some((value, index) => index > 0 && value !== indexes[index - 1] + 1)) {
                            toast('请至少选中两个相邻条文以合并', 'warning');
                            return;
                        }
                        const articles = state.importPreview.articles;
                        const first = articles[indexes[0]];
                        const merged = indexes.map(index => articles[index]);
                        first.content = merged.map(article => article.content).filter(Boolean).join('\n\n');
                        first.articleTitle = first.articleTitle || merged.map(article => article.articleTitle).find(Boolean) || '';
                        articles.splice(indexes[0] + 1, indexes.length - 1);
                        renderPreviewPanel();
                        toast(`已合并 ${indexes.length} 个相邻条文`, 'success');
                    }

                    async function confirmPreviewImport() {
                        const preview = state.importPreview;
                        if (!preview?.file || !readPreviewEdits()) {
                            toast('请补全每条的标签和正文后再确认入库', 'warning');
                            return;
                        }
                        const formData = new FormData();
                        formData.append('file', preview.file);
                        Object.entries(preview.metadata || {}).forEach(([key, value]) => {
                            if (key !== 'file') formData.append(key, value || '');
                        });
                        formData.append('reviewedArticles', JSON.stringify(preview.articles));
                        setBusy(true, '正在提交校正后的法规导入任务…');
                        try {
                            const data = await fetchJson(`${API}/documents/import-jobs`, { method: 'POST', body: formData });
                            state.importJobs = Array.isArray(data.jobs) ? data.jobs : [];
                            ns.renderImportJobs?.(Array.isArray(data.failed) ? data.failed : []);
                            ns.scheduleImportJobsRefresh?.();
                            document.getElementById('regulations-preview-panel')?.classList.add('hidden');
                            document.getElementById('regulations-upload-form')?.reset();
                            syncImportHint(document.getElementById('regulations-upload-form'));
                            toast(`已提交 ${state.importJobs.length} 个校正导入任务`, 'success');
                        } catch (error) {
                            toast(error.message || '提交校正导入任务失败', 'error');
                        } finally {
                            setBusy(false);
                        }
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
                                            <span class="regulations-timeline-meta">${Number(v.article_count || 0)} 条${v.effect_status ? ` · ${esc({ unverified: '待核验', pending: '待生效', effective: '现行有效', expired: '失效', repealed: '废止' }[v.effect_status] || v.effect_status)}` : ''}${v.effective_from ? ` · ${esc(v.effective_from)}` : ''}${v.is_current ? ' · 当前版本' : ''}</span>
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
            showAccessLogs,
            showRegulationAiLogs,
            showArticleLocations,
            showQualitySummary,
            toggleRegulationSubscription,
            toggleRegulationBookmark,
            showRegulationBookmarks,
            saveRegulationBookmarkTopic,
            deleteRegulationBookmark,
            showRegulationRecycleBin,
            restoreRegulationFromRecycleBin,
            requestRegulationReindex,
            showRegulationObligations,
            reviewRegulationObligation,
            submitRegulationObligation,
            renderAnnotations,
            submitAnnotation,
            deleteAnnotation,
            exportRegulationReport,
            previewRegulationImport,
            showPreviewPanel,
            renderPreviewPanel,
            mergePreviewArticles,
            confirmPreviewImport,
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
})();
