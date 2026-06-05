/* 知识库 (RAG) 前端逻辑 Knowledge Base (RAG) Frontend Logic */

const {
    RAG_ICONS,
    escapeRagHtml,
    formatRagDateToCN,
    formatRagSize
} = window.Pivot?.ragFormat || {};
const {
    escapeAttr: escapeRagAttr = (value) => String(value ?? '')
} = window.Pivot?.html || window.PivotSafeHtml || {};
const {
    buildGraphCanvasMarkup,
    buildGraphEditorModalShellHtml,
    buildGraphEntitiesHtml,
    buildGraphEntityEditorHtml,
    buildGraphNodeTooltip,
    buildGraphModalShellHtml,
    buildGraphRelationOptionsHtml,
    buildGraphRelationTooltip,
    buildGraphRelationEditorHtml,
    buildGraphRelationsHtml,
    buildGraphTypeFilterOptionsHtml,
    buildGraphTypeOptionsHtml,
    buildGraphSummaryHtml,
    getGraphNodeName,
    graphRelationLabel: graphRelationLabelText = (value) => String(value ?? ''),
    graphTypeLabel: graphTypeLabelText = (value) => String(value ?? '')
} = window.Pivot?.ragGraphRender || {};
const {
    clampGraphZoom = (scale, minZoom, maxZoom) => Math.min(maxZoom, Math.max(minZoom, scale))
} = window.Pivot?.ragGraphLayout || {};
const {
    ensureGraphMapView: ensureGraphMapViewState = (graphState) => {
        if (!graphState.mapView) {
            graphState.mapView = {
                x: 0,
                y: 0,
                scale: 1,
                isPanning: false,
                pointerId: null,
                startX: 0,
                startY: 0,
                originX: 0,
                originY: 0,
                moved: false,
                suppressNextNodeClick: false
            };
        }
        return graphState.mapView;
    },
    hideGraphNodeTooltip: hideGraphNodeTooltipUi = () => {},
    moveGraphMapPan: moveGraphMapPanUi = () => false,
    positionGraphNodeTooltip: positionGraphNodeTooltipUi = () => {},
    resetGraphMapView: resetGraphMapViewUi = () => {},
    showGraphNodeTooltip: showGraphNodeTooltipUi = () => {},
    startGraphMapPan: startGraphMapPanUi = () => false,
    stopGraphMapPan: stopGraphMapPanUi = () => false,
    zoomGraphMap: zoomGraphMapUi = () => {},
    zoomGraphMapByAction: zoomGraphMapByActionUi = () => {}
} = window.Pivot?.ragGraphUi || {};

const getRagStatusLabel = (status) => {
    if (status === 'ready') return '就绪';
    if (status === 'processing') return '处理中';
    if (status === 'error') return '失败';
    return status || '-';
};

const renderRagActions = (doc) => {
    const buttons = [];
    buttons.push(`<button class="btn-secondary rag-detail-btn" data-rag-id="${doc.id}">详情</button>`);
    if (Number(doc.chunk_count || 0) > 0) {
        buttons.push(`<button class="btn-secondary rag-doc-graph-btn" data-rag-id="${doc.id}">图谱</button>`);
    }
    if (doc.status === 'error' && doc.source_path) {
        buttons.push(`<button class="btn-secondary rag-reindex-btn" data-rag-id="${doc.id}">重试</button>`);
    }
    buttons.push(`<button class="btn-danger rag-delete-btn" data-rag-id="${doc.id}">删除</button>`);
    return buttons.join('');
};

let ragStatusRefreshTimer = null;
let ragDocsPage = 1;
const RAG_DOCS_PAGE_SIZE = 15;

const shouldAutoRefreshRagDocs = () => {
    const panel = document.getElementById('knowledge-workbench-modal');
    return Boolean(panel && !panel.classList.contains('hidden'));
};

const scheduleRagStatusRefresh = (docs) => {
    if (ragStatusRefreshTimer) {
        clearTimeout(ragStatusRefreshTimer);
        ragStatusRefreshTimer = null;
    }
    if (!Array.isArray(docs) || !docs.some(doc => doc.status === 'processing')) return;
    if (!shouldAutoRefreshRagDocs()) return;
    ragStatusRefreshTimer = setTimeout(() => {
        if (shouldAutoRefreshRagDocs()) window.loadKnowledgeDocs();
    }, 3000);
};

const ragConfirm = (title, message) => new Promise((resolve) => {
    if (typeof window.showConfirm === 'function') {
        window.showConfirm(title, message, () => resolve(true));
        const cancelBtn = document.getElementById('modal-confirm-cancel');
        const container = document.getElementById('confirm-container');
        const cancelHandler = () => {
            cancelBtn?.removeEventListener('click', cancelHandler);
            container?.removeEventListener('click', overlayHandler);
            resolve(false);
        };
        const overlayHandler = (event) => {
            if (event.target === container) cancelHandler();
        };
        cancelBtn?.addEventListener('click', cancelHandler, { once: true });
        container?.addEventListener('click', overlayHandler, { once: true });
        return;
    }
    resolve(false);
});

const ensureRagDetailModal = () => {
    let modal = document.getElementById('rag-detail-modal');
    if (modal) return modal;

    modal = document.createElement('div');
    modal.id = 'rag-detail-modal';
    modal.className = 'modal-overlay hidden rag-detail-modal-overlay';
    modal.innerHTML = `
        <div class="modal rag-detail-modal">
            <div class="rag-detail-header">
                <div>
                    <h3 id="rag-detail-title">知识库文档详情</h3>
                    <p id="rag-detail-subtitle" class="model-modal-desc"></p>
                </div>
                <button type="button" id="rag-detail-close-btn" class="btn-danger-outline">关闭</button>
            </div>
            <div id="rag-detail-meta" class="rag-detail-meta"></div>
            <div id="rag-detail-chunks" class="rag-detail-chunks"></div>
        </div>
    `;
    document.body.appendChild(modal);
    modal.addEventListener('click', (event) => {
        if (event.target === modal || event.target.closest('#rag-detail-close-btn')) {
            modal.classList.add('hidden');
        }
    });
    return modal;
};

const ensureRagAuditModal = () => {
    let modal = document.getElementById('rag-audit-modal');
    if (modal) return modal;

    modal = document.createElement('div');
    modal.id = 'rag-audit-modal';
    modal.className = 'modal-overlay hidden rag-detail-modal-overlay';
    modal.innerHTML = `
        <div class="modal rag-detail-modal">
            <div class="rag-detail-header">
                <div>
                    <h3>知识库删除审计</h3>
                    <p class="model-modal-desc">仅 admin 权限层级可见，保留用户删除后的文档元数据、源文件路径与索引状态。</p>
                </div>
                <button type="button" id="rag-audit-close-btn" class="btn-danger-outline">关闭</button>
            </div>
            <div class="table-container rag-audit-table-wrap">
                <table class="data-table compact-table">
                    <thead>
                        <tr>
                            <th style="width: 50px;" class="text-center">序号</th>
                            <th>文档</th>
                            <th>用户</th>
                            <th>状态</th>
                            <th>分块</th>
                            <th>源文件</th>
                            <th>删除时间</th>
                        </tr>
                    </thead>
                    <tbody id="rag-audit-body"></tbody>
                </table>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    modal.addEventListener('click', (event) => {
        if (event.target === modal || event.target.closest('#rag-audit-close-btn')) {
            modal.classList.add('hidden');
        }
    });
    return modal;
};

const renderRagAuditRows = (items = []) => {
    if (!items.length) {
        return '<tr><td colspan="7" class="text-center muted-text">暂无已删除知识库文档</td></tr>';
    }
    return items.map((item, index) => `
        <tr>
            <td class="text-center">${index + 1}</td>
            <td title="${escapeRagHtml(item.name)}">${escapeRagHtml(item.name)}</td>
            <td>${escapeRagHtml(item.nickname || item.username || `用户 ${item.user_id || '-'}`)}</td>
            <td>${escapeRagHtml(getRagStatusLabel(item.status))}</td>
            <td>${Number(item.indexed_chunks || item.chunk_count || 0)} / ${Number(item.chunk_count || 0)}</td>
            <td title="${escapeRagHtml(item.source_path || '')}">${escapeRagHtml(item.source_path || '-')}</td>
            <td>${formatRagDateToCN(item.deleted_at)}</td>
        </tr>
    `).join('');
};

const showRagDetailModal = (data) => {
    const modal = ensureRagDetailModal();
    const doc = data.doc || {};
    const chunks = Array.isArray(data.chunks) ? data.chunks : [];
    const title = document.getElementById('rag-detail-title');
    const subtitle = document.getElementById('rag-detail-subtitle');
    const meta = document.getElementById('rag-detail-meta');
    const chunkList = document.getElementById('rag-detail-chunks');

    if (title) title.textContent = doc.name || '知识库文档详情';
    if (subtitle) subtitle.textContent = `共 ${Number(data.totalChunks || 0)} 个分块，当前展示 ${chunks.length} 个`;
    if (meta) {
        const enabledText = Number(doc.is_enabled ?? 1) === 1 ? '已启用' : '已停用';
        const items = [
            { icon: RAG_ICONS.status, label: '解析状态', value: getRagStatusLabel(doc.status), class: `status-${doc.status}` },
            { icon: RAG_ICONS.enable, label: '生效状态', value: enabledText, class: enabledText === '已启用' ? 'status-ready' : 'status-error' },
            { icon: RAG_ICONS.progress, label: '索引进度', value: `${Number(doc.progress || 0)}%` },
            { icon: RAG_ICONS.chunks, label: '分块总数', value: Number(data.totalChunks || 0) },
            { icon: RAG_ICONS.time, label: '创建时间', value: formatRagDateToCN(doc.created_at) },
            { icon: RAG_ICONS.time, label: '更新时间', value: formatRagDateToCN(doc.updated_at || doc.processed_at) }
        ];
        meta.innerHTML = items.map(item => `
            <div class="rag-meta-card ${item.class || ''}">
                <div class="rag-meta-label">${item.icon}<span>${escapeRagHtml(item.label)}</span></div>
                <div class="rag-meta-value" title="${escapeRagAttr(item.value)}">${escapeRagHtml(item.value)}</div>
            </div>
        `).join('');
    }
    if (chunkList) {
        chunkList.innerHTML = chunks.length
            ? chunks.map((chunk, index) => `
                <article class="rag-detail-chunk">
                    <header>
                        <strong>#${index + 1}</strong>
                        <span>${Number(chunk.length || String(chunk.content || '').length)} 字</span>
                    </header>
                    <p>${escapeRagHtml(chunk.content || '')}</p>
                </article>
            `).join('')
            : '<div class="rag-debug-empty">暂无可预览分块</div>';
    }
    modal.classList.remove('hidden');
};

window.showKnowledgeDocAudit = async () => {
    if (!isSuperAdminUser()) {
        showToast('仅 admin 权限层级可查看知识库删除审计', 'error');
        return;
    }
    try {
        const res = await apiFetch(`${API_BASE}/rag/admin/docs/audit?limit=100`, { headers: authHeaders() });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.error) throw new Error(data.error || '删除审计加载失败');
        const modal = ensureRagAuditModal();
        const body = modal.querySelector('#rag-audit-body');
        if (body) body.innerHTML = renderRagAuditRows(data.data || []);
        modal.classList.remove('hidden');
    } catch (e) {
        showToast(e.message || '删除审计加载失败', 'error');
    }
};

const renderRagSummary = (summary) => {
    const el = document.getElementById('rag-summary');
    if (!el || !summary) return;
    const items = [
        ['文档', summary.total || 0],
        ['就绪', summary.ready || 0],
        ['处理中', summary.processing || 0],
        ['失败', summary.error || 0],
        ['分块', summary.chunks || 0],
        ['源文件', formatRagSize(summary.sourceSize || 0)],
        ['队列', `${summary.queue?.running || 0}/${summary.queue?.pending || 0}`]
    ];
    const lastError = summary.lastError?.error_message
        ? `<span class="rag-summary-error" title="${escapeRagHtml(summary.lastError.error_message)}">最近错误：${escapeRagHtml(summary.lastError.name || '文档')}</span>`
        : '';
    el.innerHTML = `
        <div class="rag-summary-items">
            ${items.map(([label, value]) => `<span><b>${escapeRagHtml(value)}</b>${escapeRagHtml(label)}</span>`).join('')}
        </div>
        ${lastError}
    `;

    const retryBtn = document.getElementById('rag-retry-failed-btn');
    if (retryBtn) retryBtn.disabled = !(summary.retryableErrors > 0);
    const scoreInput = document.getElementById('rag-debug-score-threshold');
    const topKInput = document.getElementById('rag-debug-top-k');
    const candidateInput = document.getElementById('rag-debug-candidate-limit');
    if (scoreInput && !scoreInput.value) scoreInput.value = summary.config?.scoreThreshold ?? 0.4;
    if (topKInput && !topKInput.value) topKInput.value = summary.config?.topK ?? 3;
    if (candidateInput && !candidateInput.value) candidateInput.value = summary.config?.candidateLimit ?? 300;
};

const renderRagQualityReport = (report) => {
    const el = document.getElementById('rag-quality-report');
    if (!el || !report) return;
    const overview = report.overview || {};
    const problemDocs = Array.isArray(report.problemDocs) ? report.problemDocs : [];
    const recommendations = Array.isArray(report.recommendations) ? report.recommendations : [];
    el.innerHTML = `
        <div class="governance-head">
            <strong>质量诊断</strong>
            <span>异常 ${Number(overview.error || 0)} · 停用 ${Number(overview.disabled || 0)} · 空分块 ${Number(overview.emptyReady || 0)}</span>
        </div>
        <div class="governance-list">
            ${recommendations.slice(0, 3).map(item => `<span>${escapeRagHtml(item)}</span>`).join('')}
            ${problemDocs.slice(0, 4).map(doc => `
                <span class="${doc.status === 'error' ? 'is-error' : ''}">
                    ${escapeRagHtml(doc.name || '文档')} · ${escapeRagHtml(getRagStatusLabel(doc.status))} · 分块 ${Number(doc.chunk_count || 0)}
                </span>
            `).join('')}
        </div>
    `;
};

const renderRagDebugResults = (data) => {
    const el = document.getElementById('rag-debug-results');
    if (!el) return;
    const matches = Array.isArray(data.matches) ? data.matches : [];
    el.classList.remove('hidden');

    // 关键词高亮：把字符串里出现的 keywords 包成 <mark>，并保持先转义再替换的顺序
    const keywords = (Array.isArray(data.keywords) ? data.keywords : [])
        .map(k => String(k || '').trim())
        .filter(k => k.length > 0)
        .sort((a, b) => b.length - a.length)
        .slice(0, 16);
    const highlightChunk = (text) => {
        const escaped = escapeRagHtml(text || '');
        if (keywords.length === 0) return escaped;
        try {
            const pattern = keywords
                .map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
                .filter(Boolean)
                .join('|');
            if (!pattern) return escaped;
            return escaped.replace(new RegExp(`(${pattern})`, 'gi'), '<mark class="rag-debug-hit">$1</mark>');
        } catch (e) {
            return escaped;
        }
    };

    // 按 source 聚合：方便查看哪个文件命中最多、平均分多少
    const grouped = new Map();
    matches.forEach(m => {
        const key = String(m.source || '-');
        const entry = grouped.get(key) || { source: key, count: 0, matched: 0, totalScore: 0, top: 0 };
        entry.count += 1;
        if (m.matched) entry.matched += 1;
        const score = Number(m.score || 0);
        entry.totalScore += score;
        if (score > entry.top) entry.top = score;
        grouped.set(key, entry);
    });
    const groupedList = Array.from(grouped.values()).sort((a, b) => b.top - a.top).slice(0, 8);

    const maxScore = matches.reduce((acc, m) => Math.max(acc, Number(m.score || 0)), 0) || 1;
    const elapsed = Number(data.elapsedMs || data.elapsed || 0);

    el.innerHTML = `
        <div class="rag-debug-meta">
            <span>关键词：${escapeRagHtml((data.keywords || []).join(' / ') || '-')}</span>
            <span>候选：${Number(data.candidateCount || 0)}</span>
            <span>阈值：${Number(data.threshold || 0).toFixed(2)}</span>
            ${elapsed > 0 ? `<span>检索耗时：${elapsed} ms</span>` : ''}
        </div>
        ${groupedList.length > 1 ? `
            <div class="rag-debug-grouped" role="list">
                ${groupedList.map(g => `
                    <div class="rag-debug-grouped-item" role="listitem">
                        <span class="rag-debug-grouped-source">${escapeRagHtml(g.source)}</span>
                        <span class="rag-debug-grouped-stats">命中 ${g.matched}/${g.count}<span class="rag-debug-grouped-divider">·</span>峰值 ${g.top.toFixed(3)}<span class="rag-debug-grouped-divider">·</span>均值 ${(g.totalScore / g.count).toFixed(3)}</span>
                    </div>
                `).join('')}
            </div>
        ` : ''}
        <div class="rag-debug-list">
            ${matches.map((m, index) => {
                const score = Number(m.score || 0);
                const percent = Math.max(0, Math.min(1, score / maxScore)) * 100;
                return `
                <div class="rag-debug-item ${m.matched ? 'matched' : ''}">
                    <div class="rag-debug-item-head">
                        <strong>#${index + 1} ${escapeRagHtml(m.source || '-')}</strong>
                        <span class="rag-debug-score" title="原始相似度">${score.toFixed(3)}${m.matched ? ' 命中' : ''}</span>
                    </div>
                    <div class="rag-debug-score-bar" aria-hidden="true">
                        <div class="rag-debug-score-bar-fill" style="width:${percent.toFixed(1)}%"></div>
                    </div>
                    <p>${highlightChunk(m.text || '')}</p>
                    <div class="rag-feedback-actions">
                        <button class="btn-secondary rag-feedback-btn" data-helpful="true" data-query="${escapeRagHtml(data.query || '')}" data-chunk-id="${m.chunkId || ''}" data-doc-name="${escapeRagHtml(m.source || '')}" data-score="${score}">有用</button>
                        <button class="btn-secondary rag-feedback-btn" data-helpful="false" data-query="${escapeRagHtml(data.query || '')}" data-chunk-id="${m.chunkId || ''}" data-doc-name="${escapeRagHtml(m.source || '')}" data-score="${score}">无用</button>
                    </div>
                </div>
                `;
            }).join('') || '<div class="rag-debug-empty">没有召回到可用分块</div>'}
        </div>
    `;
};

let ragGraphState = {
    selectedEntityId: null,
    selectedEntity: null,
    entities: [],
    relations: [],
    mapView: {
        x: 0,
        y: 0,
        scale: 1,
        isPanning: false,
        pointerId: null,
        startX: 0,
        startY: 0,
        originX: 0,
        originY: 0,
        moved: false,
        suppressNextNodeClick: false
    }
};
const RAG_GRAPH_ACTIVE_STORAGE_KEY = 'pivot_knowledge_graph_active';
const RAG_GRAPH_DOC_STORAGE_KEY = 'pivot_knowledge_graph_doc';
const RAG_GRAPH_MIN_ZOOM = 0.55;
const RAG_GRAPH_MAX_ZOOM = 2.2;
const RAG_GRAPH_ZOOM_STEP = 0.16;
const GRAPH_UI_OPTIONS = {
    clampZoom: clampGraphZoom,
    escapeHtml: escapeRagHtml,
    maxZoom: RAG_GRAPH_MAX_ZOOM,
    minZoom: RAG_GRAPH_MIN_ZOOM,
    zoomStep: RAG_GRAPH_ZOOM_STEP
};

const setKnowledgeGraphRestoreState = (active, docId = '') => {
    try {
        if (active) {
            sessionStorage.setItem(RAG_GRAPH_ACTIVE_STORAGE_KEY, 'true');
            if (docId) sessionStorage.setItem(RAG_GRAPH_DOC_STORAGE_KEY, String(docId));
            else sessionStorage.removeItem(RAG_GRAPH_DOC_STORAGE_KEY);
        } else {
            sessionStorage.removeItem(RAG_GRAPH_ACTIVE_STORAGE_KEY);
            sessionStorage.removeItem(RAG_GRAPH_DOC_STORAGE_KEY);
        }
    } catch (e) {
        // sessionStorage may be blocked; restoring the subpage is best effort.
    }
};

const getKnowledgeGraphRestoreDocId = () => {
    try {
        return sessionStorage.getItem(RAG_GRAPH_ACTIVE_STORAGE_KEY) === 'true'
            ? (sessionStorage.getItem(RAG_GRAPH_DOC_STORAGE_KEY) || '')
            : null;
    } catch (e) {
        return null;
    }
};

const closeKnowledgeGraphEditorModal = () => {
    document.getElementById('rag-graph-editor-modal')?.classList.add('hidden');
};

const closeKnowledgeGraphModal = () => {
    closeKnowledgeGraphEditorModal();
    hideGraphNodeTooltip();
    document.getElementById('rag-graph-modal')?.classList.add('hidden');
    setKnowledgeGraphRestoreState(false);
};

const graphTypeLabel = (type) => graphTypeLabelText(type);
const graphRelationLabel = (type) => graphRelationLabelText(type);
const graphTypeOptionsHtml = (selectedType = 'concept') => buildGraphTypeOptionsHtml(selectedType, {
    escapeAttr: escapeRagAttr,
    escapeHtml: escapeRagHtml
});
const graphRelationOptionsHtml = (selectedType = 'related_to') => buildGraphRelationOptionsHtml(selectedType, {
    escapeAttr: escapeRagAttr,
    escapeHtml: escapeRagHtml
});
const graphTypeFilterOptionsHtml = () => buildGraphTypeFilterOptionsHtml({
    emptyLabel: '全部类型',
    escapeAttr: escapeRagAttr,
    escapeHtml: escapeRagHtml
});

const getGraphMapView = () => ensureGraphMapViewState(ragGraphState);
const resetGraphMapView = () => resetGraphMapViewUi(ragGraphState, GRAPH_UI_OPTIONS);
const zoomGraphMap = (nextScale, clientX = null, clientY = null) => zoomGraphMapUi(nextScale, ragGraphState, {
    ...GRAPH_UI_OPTIONS,
    clientX,
    clientY
});
const zoomGraphMapByAction = (action) => zoomGraphMapByActionUi(action, ragGraphState, GRAPH_UI_OPTIONS);
const showGraphNodeTooltip = (node, eventOrRect) => showGraphNodeTooltipUi(node, eventOrRect, GRAPH_UI_OPTIONS);
const hideGraphNodeTooltip = () => hideGraphNodeTooltipUi();
const positionGraphNodeTooltip = (eventOrRect) => positionGraphNodeTooltipUi(eventOrRect);
const startGraphMapPan = (event) => startGraphMapPanUi(event, ragGraphState, GRAPH_UI_OPTIONS);
const moveGraphMapPan = (event) => moveGraphMapPanUi(event, ragGraphState, GRAPH_UI_OPTIONS);
const stopGraphMapPan = (event) => stopGraphMapPanUi(event, ragGraphState, GRAPH_UI_OPTIONS);

const ensureRagGraphModal = () => {
    let modal = document.getElementById('rag-graph-modal');
    if (modal) return modal;
    modal = document.createElement('div');
    modal.id = 'rag-graph-modal';
    modal.className = 'modal-overlay hidden rag-detail-modal-overlay';
    modal.innerHTML = buildGraphModalShellHtml({
        escapeAttr: escapeRagAttr,
        escapeHtml: escapeRagHtml,
        messages: {
            canvasTitle: '关系地图',
            closeLabel: '关闭',
            description: '查看实体关系、来源文档，并校准图谱节点与关系。',
            editEntityLabel: '校准实体',
            entitiesTitle: '实体节点',
            rebuildDocLabel: '重建本文档图谱',
            relationsTitle: '关系明细',
            searchLabel: '搜索',
            searchPlaceholder: '搜索实体、系统、部门、流程',
            title: '知识图谱'
        },
        typeFilterOptionsHtml: graphTypeFilterOptionsHtml()
    });
    document.body.appendChild(modal);
    modal.addEventListener('click', (event) => {
        if (event.target === modal || event.target.closest('#rag-graph-close-btn')) {
            closeKnowledgeGraphModal();
        }
    });
    return modal;
};

const ensureRagGraphEditorModal = () => {
    let modal = document.getElementById('rag-graph-editor-modal');
    if (modal) return modal;
    modal = document.createElement('div');
    modal.id = 'rag-graph-editor-modal';
    modal.className = 'modal-overlay hidden rag-graph-editor-modal-overlay';
    modal.innerHTML = buildGraphEditorModalShellHtml({
        escapeHtml: escapeRagHtml,
        messages: {
            closeLabel: '关闭',
            title: '实体校准'
        }
    });
    document.body.appendChild(modal);
    modal.addEventListener('click', (event) => {
        if (event.target === modal || event.target.closest('#rag-graph-editor-close-btn')) {
            closeKnowledgeGraphEditorModal();
        }
    });
    return modal;
};

const renderGraphSummary = (summary = {}) => {
    const el = document.getElementById('rag-graph-summary');
    if (!el) return;
    el.innerHTML = buildGraphSummaryHtml(summary, {
        escapeHtml: escapeRagHtml,
        graphTypeLabel,
        labels: {
            entities: '实体',
            relations: '关系',
            mentions: '提及'
        }
    });
};

const renderGraphEntities = (payload = {}) => {
    const list = document.getElementById('rag-graph-entities');
    const count = document.getElementById('rag-graph-entity-count');
    const entities = Array.isArray(payload.data) ? payload.data : [];
    ragGraphState.entities = entities;
    if (count) count.textContent = String(Number(payload.total || entities.length));
    if (!list) return;
    list.innerHTML = buildGraphEntitiesHtml(entities, {
        escapeAttr: escapeRagAttr,
        escapeHtml: escapeRagHtml,
        graphTypeLabel,
        selectedEntityId: ragGraphState.selectedEntityId,
        messages: {
            emptyHtml: '<div class="rag-debug-empty">暂无实体</div>',
            describeEntityMeta: (entity, getTypeLabel, escapeHtml) => (
                `<b>${escapeHtml(getTypeLabel(entity.type))}</b> · 提及 ${Number(entity.mention_count || 0)} · 关系 ${Number(entity.relation_count || 0)}`
            ),
            formatConfidence: (entity) => `可信度 ${Number(entity.confidence || 0).toFixed(2)}`
        }
    });
};

const renderGraphCanvas = (graph = {}) => {
    const el = document.getElementById('rag-graph-canvas');
    if (!el) return;
    hideGraphNodeTooltip();
    const editEntityBtn = document.getElementById('rag-graph-edit-entity-btn');
    const { hasNodes, html } = buildGraphCanvasMarkup(graph, {
        centerId: Number(graph.center?.id || ragGraphState.selectedEntityId),
        escapeAttr: escapeRagAttr,
        escapeHtml: escapeRagHtml,
        buildGraphNodeTooltip,
        getGraphNodeName,
        graphRelationLabel,
        graphTypeLabel,
        messages: {
            describeFooterCounts: (nodeCount, edgeCount) => `显示 ${nodeCount} 个节点 / ${edgeCount} 条关系`,
            describeFooterStatusCollapsed: (hiddenCount) => `已收起 ${hiddenCount} 条远端关系`,
            describeNodeMeta: ({ isCenter, relationCount }) => (isCenter ? '中心实体' : `${relationCount} 条关系`),
            emptyHtml: '<div class="rag-debug-empty">选择一个实体查看关系地图</div>',
            footerStatusExpanded: '当前实体关系已全部展示',
            mapAriaLabel: '关系地图视图控制',
            resetTitle: '复位',
            zoomInTitle: '放大',
            zoomOutTitle: '缩小'
        }
    });
    if (!hasNodes) {
        editEntityBtn?.classList.add('hidden');
        el.innerHTML = html;
        return;
    }
    editEntityBtn?.classList.toggle('hidden', !ragGraphState.selectedEntity);
    el.innerHTML = html;
    resetGraphMapView();
};

const renderGraphRelations = (payload = {}) => {
    const list = document.getElementById('rag-graph-relations');
    const count = document.getElementById('rag-graph-relation-count');
    const relations = Array.isArray(payload.data) ? payload.data : [];
    ragGraphState.relations = relations;
    if (count) count.textContent = String(Number(payload.total || relations.length));
    if (!list) return;
    list.innerHTML = buildGraphRelationsHtml(relations, {
        escapeAttr: escapeRagAttr,
        escapeHtml: escapeRagHtml,
        buildGraphRelationTooltip,
        graphRelationLabel,
        messages: {
            deleteLabel: '删除',
            describeSource: (row) => `来源：${row.doc_name || '知识图谱'}`,
            editLabel: '编辑',
            emptyHtml: '<div class="rag-debug-empty">暂无关系</div>',
            formatConfidence: (row) => `可信度 ${Number(row.confidence || 0).toFixed(2)}`
        }
    });
};

const loadGraphSummary = async () => {
    const res = await apiFetch(`${API_BASE}/rag/graph/summary`, { headers: authHeaders() });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error(data.error || '图谱概览加载失败');
    renderGraphSummary(data);
    return data;
};

const loadGraphEntities = async () => {
    const query = document.getElementById('rag-graph-search')?.value?.trim() || '';
    const type = document.getElementById('rag-graph-type')?.value || '';
    const params = new URLSearchParams({ limit: '80' });
    if (query) params.set('query', query);
    if (type) params.set('type', type);
    const res = await apiFetch(`${API_BASE}/rag/graph/entities?${params}`, { headers: authHeaders() });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error(data.error || '实体加载失败');
    renderGraphEntities(data);
    return data;
};

const loadGraphRelations = async (entityId = ragGraphState.selectedEntityId) => {
    const params = new URLSearchParams({ limit: '100' });
    if (entityId) params.set('entityId', entityId);
    const res = await apiFetch(`${API_BASE}/rag/graph/relations?${params}`, { headers: authHeaders() });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error(data.error || '关系加载失败');
    renderGraphRelations(data);
    return data;
};

window.openKnowledgeGraph = async (docId = null) => {
    const modal = ensureRagGraphModal();
    modal.dataset.docId = docId || '';
    ragGraphState.selectedEntityId = null;
    ragGraphState.selectedEntity = null;
    setKnowledgeGraphRestoreState(true, docId || '');
    document.getElementById('rag-graph-rebuild-doc-btn')?.classList.toggle('hidden', !docId);
    modal.classList.remove('hidden');
    try {
        await loadGraphSummary();
        const entities = await loadGraphEntities();
        const firstEntity = entities.data?.[0];
        if (firstEntity) await window.selectKnowledgeGraphEntity(firstEntity.id);
        else {
            ragGraphState.selectedEntityId = null;
            ragGraphState.selectedEntity = null;
            renderGraphCanvas({});
            renderGraphRelations({ data: [], total: 0 });
        }
    } catch (e) {
        showToast(e.message || '知识图谱加载失败', 'error');
    }
};

window.selectKnowledgeGraphEntity = async (entityId) => {
    ragGraphState.selectedEntityId = Number(entityId);
    renderGraphEntities({ data: ragGraphState.entities, total: ragGraphState.entities.length });
    try {
        const [graphRes] = await Promise.all([
            apiFetch(`${API_BASE}/rag/graph/entities/${entityId}?limit=120`, { headers: authHeaders() }),
            loadGraphRelations(entityId)
        ]);
        const graph = await graphRes.json().catch(() => ({}));
        if (!graphRes.ok || graph.error) throw new Error(graph.error || '实体关系加载失败');
        ragGraphState.selectedEntity = graph.center || null;
        renderGraphCanvas(graph);
    } catch (e) {
        ragGraphState.selectedEntity = null;
        document.getElementById('rag-graph-edit-entity-btn')?.classList.add('hidden');
        showToast(e.message || '实体关系加载失败', 'error');
    }
};

window.showKnowledgeGraphEntityEditor = (entity) => {
    if (!entity) return;
    const modal = ensureRagGraphEditorModal();
    const title = modal.querySelector('#rag-graph-editor-title');
    const subtitle = modal.querySelector('#rag-graph-editor-subtitle');
    const body = modal.querySelector('#rag-graph-editor-body');
    if (!body) return;
    if (title) title.textContent = '实体校准';
    if (subtitle) subtitle.textContent = `#${Number(entity.id)} · ${graphTypeLabel(entity.type)}`;
    const mergeCandidates = ragGraphState.entities
        .filter(item => Number(item.id) !== Number(entity.id))
        .slice(0, 80);
    body.innerHTML = buildGraphEntityEditorHtml(entity, {
        escapeAttr: escapeRagAttr,
        escapeHtml: escapeRagHtml,
        graphTypeLabel,
        mergeCandidates,
        typeOptionsHtml: graphTypeOptionsHtml(entity.type || 'concept'),
        messages: {
            cancelLabel: '取消',
            descriptionLabel: '描述',
            mergeLabel: '合并实体',
            mergeTargetLabel: '合并到实体 ID',
            mergeTargetPlaceholder: '选择或输入目标 ID',
            nameLabel: '实体名称',
            saveLabel: '保存实体',
            typeLabel: '实体类型'
        }
    });
    modal.classList.remove('hidden');
};

window.saveKnowledgeGraphEntity = async (entityId) => {
    const payload = {
        name: document.getElementById('rag-graph-edit-name')?.value,
        type: document.getElementById('rag-graph-edit-type')?.value,
        description: document.getElementById('rag-graph-edit-description')?.value
    };
    const res = await apiFetch(`${API_BASE}/rag/graph/entities/${entityId}`, {
        method: 'PUT',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error(data.error || '实体保存失败');
    showToast('实体已保存');
    await loadGraphEntities();
    await window.selectKnowledgeGraphEntity(entityId);
    closeKnowledgeGraphEditorModal();
};

window.mergeKnowledgeGraphEntity = async (sourceEntityId) => {
    const targetEntityId = Number(document.getElementById('rag-graph-merge-target')?.value || 0);
    if (!targetEntityId || Number(targetEntityId) === Number(sourceEntityId)) return showToast('请输入有效的目标实体 ID', 'error');
    const confirmed = await ragConfirm('合并知识图谱实体', `确定将实体 ${sourceEntityId} 合并到 ${targetEntityId} 吗？`);
    if (!confirmed) return;
    const res = await apiFetch(`${API_BASE}/rag/graph/entities/merge`, {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceEntityId, targetEntityId })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error(data.error || '实体合并失败');
    showToast('实体已合并');
    await loadGraphEntities();
    await window.selectKnowledgeGraphEntity(targetEntityId);
    closeKnowledgeGraphEditorModal();
};

window.editKnowledgeGraphRelation = async (relationId) => {
    const relation = ragGraphState.relations.find(item => Number(item.id) === Number(relationId));
    if (!relation) return;
    window.showKnowledgeGraphRelationEditor(relation);
};

window.showKnowledgeGraphRelationEditor = (relation) => {
    if (!relation) return;
    const modal = ensureRagGraphEditorModal();
    const title = modal.querySelector('#rag-graph-editor-title');
    const subtitle = modal.querySelector('#rag-graph-editor-subtitle');
    const body = modal.querySelector('#rag-graph-editor-body');
    if (!body) return;
    if (title) title.textContent = '关系校准';
    if (subtitle) subtitle.textContent = `#${Number(relation.id)} · 可信度 ${Number(relation.confidence || 0).toFixed(2)}`;
    body.innerHTML = buildGraphRelationEditorHtml(relation, {
        escapeAttr: escapeRagAttr,
        escapeHtml: escapeRagHtml,
        messages: {
            cancelLabel: '取消',
            descriptionLabel: '关系描述',
            saveLabel: '保存关系',
            sourceLabel: '起点',
            targetLabel: '终点',
            typeLabel: '关系类型'
        },
        relationOptionsHtml: graphRelationOptionsHtml(relation.relation_type || 'related_to')
    });
    modal.classList.remove('hidden');
};

window.saveKnowledgeGraphRelation = async (relationId) => {
    const relation = ragGraphState.relations.find(item => Number(item.id) === Number(relationId));
    if (!relation) return;
    const relationType = document.getElementById('rag-graph-edit-relation-type')?.value || relation.relation_type || 'related_to';
    const description = document.getElementById('rag-graph-edit-relation-description')?.value ?? relation.description;
    const res = await apiFetch(`${API_BASE}/rag/graph/relations/${relationId}`, {
        method: 'PUT',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ relationType, description, confidence: relation.confidence })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error(data.error || '关系保存失败');
    showToast('关系已保存');
    await window.selectKnowledgeGraphEntity(ragGraphState.selectedEntityId);
    closeKnowledgeGraphEditorModal();
};

window.deleteKnowledgeGraphRelation = async (relationId) => {
    const confirmed = await ragConfirm('删除知识图谱关系', '确定删除该关系吗？');
    if (!confirmed) return;
    const res = await apiFetch(`${API_BASE}/rag/graph/relations/${relationId}`, { method: 'DELETE', headers: authHeaders() });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error(data.error || '关系删除失败');
    showToast('关系已删除');
    await window.selectKnowledgeGraphEntity(ragGraphState.selectedEntityId);
};

window.rebuildKnowledgeGraphForDoc = async () => {
    const docId = document.getElementById('rag-graph-modal')?.dataset?.docId;
    if (!docId) return;
    const res = await apiFetch(`${API_BASE}/rag/graph/docs/${docId}/rebuild`, { method: 'POST', headers: authHeaders() });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error(data.error || '图谱重建失败');
    showToast(`图谱已重建：实体 ${data.entities || 0}，关系 ${data.relations || 0}`);
    await window.openKnowledgeGraph(docId);
};

function renderRagDocsPagination(total, page, limit) {
    window.renderWorkspacePagination?.('pagination-ragDocs', {
        total,
        page,
        limit,
        onPageChange: targetPage => window.loadKnowledgeDocs(targetPage)
    });
}

window.loadKnowledgeDocs = async (page = ragDocsPage) => {
    try {
        ragDocsPage = Math.max(Number(page) || 1, 1);
        const [res, summaryRes, qualityRes, graphSummaryRes] = await Promise.all([
            apiFetch(`${API_BASE}/rag/docs?page=${ragDocsPage}&limit=${RAG_DOCS_PAGE_SIZE}`, { headers: authHeaders() }),
            apiFetch(`${API_BASE}/rag/summary`, { headers: authHeaders() }),
            apiFetch(`${API_BASE}/rag/quality-report`, { headers: authHeaders() }),
            apiFetch(`${API_BASE}/rag/graph/summary`, { headers: authHeaders() })
        ]);
        const payload = await res.json();
        const docs = Array.isArray(payload) ? payload : (payload.data || []);
        const total = Array.isArray(payload) ? docs.length : Number(payload.total || docs.length);
        const pageSize = Array.isArray(payload) ? RAG_DOCS_PAGE_SIZE : Number(payload.limit || RAG_DOCS_PAGE_SIZE);
        const pageNo = Array.isArray(payload) ? ragDocsPage : Number(payload.page || ragDocsPage);
        const summary = await summaryRes.json().catch(() => null);
        const quality = await qualityRes.json().catch(() => null);
        const graphSummary = await graphSummaryRes.json().catch(() => null);
        renderRagSummary(summary);
        renderRagQualityReport(quality);
        if (graphSummary && !graphSummary.error) {
            const summaryEl = document.getElementById('rag-summary');
            const items = summaryEl?.querySelector('.rag-summary-items');
            if (items) {
                items.insertAdjacentHTML('beforeend', `
                    <span><b>${Number(graphSummary.entities || 0)}</b>实体</span>
                    <span><b>${Number(graphSummary.relations || 0)}</b>关系</span>
                `);
            }
        }
        
        const body = document.getElementById('rag-docs-body');
        body.innerHTML = docs.map((d, index) => `
            <tr>
                <td class="text-center"><input type="checkbox" class="rag-doc-check" value="${d.id}"></td>
                <td class="text-center">${(pageNo - 1) * pageSize + index + 1}</td>
                <td title="${escapeRagHtml(d.name)}">${escapeRagHtml(d.name)}</td>
                <td class="text-center">
                    <span class="status-badge ${escapeRagHtml(d.status)}" title="${escapeRagHtml(d.error_message || '')}">${getRagStatusLabel(d.status)}</span>
                </td>
                <td class="text-center">
                    <input type="checkbox" class="rag-enable-toggle" data-rag-id="${d.id}" ${Number(d.is_enabled ?? 1) === 1 ? 'checked' : ''}>
                </td>
                <td class="text-center">${Number(d.chunk_count || 0)}</td>
                <td class="text-center">${Number(d.progress || (d.status === 'ready' ? 100 : 0))}%</td>
                <td>${escapeRagHtml(formatRagDateToCN(d.created_at))}</td>
                <td>${escapeRagHtml(formatRagDateToCN(d.updated_at || d.processed_at))}</td>
                <td class="text-center">
                    <div class="rag-actions">${renderRagActions(d)}</div>
                </td>
            </tr>
        `).join('') || '<tr><td colspan="10" class="text-center">暂无知识库文档</td></tr>';
        renderRagDocsPagination(total, pageNo, pageSize);
        scheduleRagStatusRefresh(docs);
    } catch (e) {
        console.error('加载知识库失败', e);
    }
};

window.openKnowledgeWorkbench = async function() {
    window.showMainWorkspace?.('knowledge');
    const panel = document.getElementById('knowledge-workbench-modal');
    if (!panel) return;
    panel.querySelectorAll('.admin-only').forEach(el => {
        el.classList.toggle('hidden', !isAdminUser());
    });
    panel.querySelectorAll('.admin-root-only').forEach(el => {
        el.classList.toggle('hidden', !isSuperAdminUser());
    });
    window.bindEmbeddingModalEvents?.();
    window.bindRagDebugModalEvents?.();
    await window.loadSettings?.();
    await window.loadKnowledgeDocs?.();
    const restoreGraphDocId = getKnowledgeGraphRestoreDocId();
    if (restoreGraphDocId !== null) {
        await window.openKnowledgeGraph?.(restoreGraphDocId || null);
    }
};

window.closeKnowledgeWorkbench = function() {
    closeKnowledgeGraphModal();
    window.showMainWorkspace?.('chat');
};

const getSelectedRagDocIds = () => Array.from(document.querySelectorAll('.rag-doc-check:checked'))
    .map(input => Number(input.value))
    .filter(Boolean);

window.batchReindexKnowledgeDocs = async () => {
    const docIds = getSelectedRagDocIds();
    if (docIds.length === 0) return showToast('请选择文档', 'error');
    try {
        const res = await apiFetch(`${API_BASE}/rag/docs/batch-reindex`, {
            method: 'POST',
            headers: { ...authHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ docIds })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.error) throw new Error(data.error || '批量重建失败');
        showToast(`已加入 ${data.scheduled || 0} 个重建任务`);
        window.loadKnowledgeDocs();
    } catch (e) {
        showToast(e.message || '批量重建失败', 'error');
    }
};

window.batchDeleteKnowledgeDocs = async () => {
    const docIds = getSelectedRagDocIds();
    if (docIds.length === 0) return showToast('请选择文档', 'error');
    const confirmed = await ragConfirm('批量删除知识库文档', `确定删除选中的 ${docIds.length} 个知识库文档吗？大模型将不再参考这些文档。`);
    if (!confirmed) return;
    try {
        const res = await apiFetch(`${API_BASE}/rag/docs/batch-delete`, {
            method: 'POST',
            headers: { ...authHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ docIds })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.error) throw new Error(data.error || '批量删除失败');
        showToast(`已删除 ${data.deleted || 0} 个文档`);
        window.loadKnowledgeDocs();
    } catch (e) {
        showToast(e.message || '批量删除失败', 'error');
    }
};

window.toggleKnowledgeDocEnabled = async (id, enabled) => {
    try {
        const res = await apiFetch(`${API_BASE}/rag/docs/${id}/enabled`, {
            method: 'PUT',
            headers: { ...authHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.error) throw new Error(data.error || '启停失败');
        showToast(enabled ? '文档已启用' : '文档已停用');
        window.loadKnowledgeDocs();
    } catch (e) {
        showToast(e.message || '启停失败', 'error');
    }
};

window.showKnowledgeDocDetail = async (id) => {
    try {
        const res = await apiFetch(`${API_BASE}/rag/docs/${id}?limit=50`, { headers: authHeaders() });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.error) throw new Error(data.error || '详情加载失败');
        showRagDetailModal(data);
    } catch (e) {
        showToast(e.message || '详情加载失败', 'error');
    }
};

window.sendRagFeedback = async (button) => {
    try {
        const res = await apiFetch(`${API_BASE}/rag/feedback`, {
            method: 'POST',
            headers: { ...authHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({
                query: button.dataset.query,
                chunkId: button.dataset.chunkId,
                docName: button.dataset.docName,
                score: button.dataset.score,
                helpful: button.dataset.helpful === 'true'
            })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.error) throw new Error(data.error || '反馈失败');
        showToast('反馈已记录');
    } catch (e) {
        showToast(e.message || '反馈失败', 'error');
    }
};

window.debugRagQuery = async () => {
    const input = document.getElementById('rag-debug-query');
    const button = document.getElementById('rag-debug-btn');
    const results = document.getElementById('rag-debug-results');
    if (button?.disabled) return;
    const query = input?.value?.trim();
    if (!query) {
        showToast('请输入要测试的问题', 'error');
        return;
    }

    const originalText = button?.textContent || '开始测试';
    try {
        if (button) {
            button.disabled = true;
            button.textContent = '测试中...';
            button.setAttribute('aria-busy', 'true');
        }
        if (results) {
            results.innerHTML = `
                <div class="rag-debug-loading">
                    <span class="rag-debug-spinner"></span>
                    <strong>正在测试召回效果</strong>
                    <small>正在检索知识库分块，请稍候</small>
                </div>
            `;
        }
        const res = await apiFetch(`${API_BASE}/rag/debug-query`, {
            method: 'POST',
            headers: {
                ...authHeaders(),
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                query,
                scoreThreshold: document.getElementById('rag-debug-score-threshold')?.value,
                topK: document.getElementById('rag-debug-top-k')?.value,
                candidateLimit: document.getElementById('rag-debug-candidate-limit')?.value
            })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.error) throw new Error(data.error || '检索测试失败');
        renderRagDebugResults(data);
    } catch (e) {
        showToast(e.message || '检索测试失败', 'error');
        if (results) {
            results.innerHTML = `<div class="rag-debug-empty">检索测试失败，请调整问题或稍后重试</div>`;
        }
    } finally {
        if (button) {
            button.disabled = false;
            button.textContent = originalText;
            button.removeAttribute('aria-busy');
        }
    }
};

window.retryFailedKnowledgeDocs = async () => {
    try {
        const res = await apiFetch(`${API_BASE}/rag/docs/retry-failed`, {
            method: 'POST',
            headers: authHeaders()
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.error) throw new Error(data.error || '批量重试失败');
        showToast(`已加入 ${data.scheduled || 0} 个重新索引任务`);
        window.loadKnowledgeDocs();
    } catch (e) {
        showToast(e.message || '批量重试失败', 'error');
    }
};

window.uploadKnowledgeDoc = async () => {
    const fileInput = document.getElementById('rag-upload-input');
    if (!fileInput.files.length) return;
    
    const file = fileInput.files[0];
    const formData = new FormData();
    formData.append('file', file);

    showToast('正在上传并向量化文档，请稍候...', 'info');
    fileInput.value = ''; // 重置 input

    try {
        const res = await apiFetch(`${API_BASE}/rag/upload`, {
            method: 'POST',
            headers: authHeaders(),
            body: formData
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        
        showToast(data.message || '文档已加入后台索引队列');
        window.loadKnowledgeDocs();
    } catch (e) {
        showToast(e.message || '文档上传失败', 'error');
    }
};

window.reindexKnowledgeDoc = async (id) => {
    try {
        const res = await apiFetch(`${API_BASE}/rag/docs/${id}/reindex`, {
            method: 'POST',
            headers: authHeaders()
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.error) throw new Error(data.error || '重新索引失败');
        showToast(data.message || '已加入重新索引队列');
        window.loadKnowledgeDocs();
    } catch (e) {
        showToast(e.message || '重新索引失败', 'error');
    }
};

document.addEventListener('click', (event) => {
    const reindexBtn = event.target.closest('.rag-reindex-btn');
    if (reindexBtn) {
        window.reindexKnowledgeDoc(reindexBtn.dataset.ragId);
        return;
    }

    const detailBtn = event.target.closest('.rag-detail-btn');
    if (detailBtn) {
        window.showKnowledgeDocDetail(detailBtn.dataset.ragId);
        return;
    }

    const docGraphBtn = event.target.closest('.rag-doc-graph-btn');
    if (docGraphBtn) {
        window.openKnowledgeGraph(docGraphBtn.dataset.ragId);
        return;
    }

    const feedbackBtn = event.target.closest('.rag-feedback-btn');
    if (feedbackBtn) {
        window.sendRagFeedback(feedbackBtn);
        return;
    }

    const deleteBtn = event.target.closest('.rag-delete-btn');
    if (deleteBtn) {
        window.deleteKnowledgeDoc(deleteBtn.dataset.ragId);
        return;
    }

    if (event.target.closest('#rag-refresh-btn')) {
        window.loadKnowledgeDocs();
        return;
    }

    if (event.target.closest('#rag-graph-open-btn')) {
        window.openKnowledgeGraph();
        return;
    }

    if (event.target.closest('#rag-graph-search-btn')) {
        loadGraphEntities().then(payload => {
            const firstEntity = payload.data?.[0];
            if (firstEntity) window.selectKnowledgeGraphEntity(firstEntity.id);
            else {
                ragGraphState.selectedEntityId = null;
                ragGraphState.selectedEntity = null;
                renderGraphCanvas({});
                renderGraphRelations({ data: [], total: 0 });
            }
        }).catch(e => showToast(e.message || '实体搜索失败', 'error'));
        return;
    }

    const graphZoomBtn = event.target.closest('[data-graph-zoom-action]');
    if (graphZoomBtn) {
        zoomGraphMapByAction(graphZoomBtn.dataset.graphZoomAction);
        return;
    }

    const graphEntityBtn = event.target.closest('.rag-graph-entity, .rag-graph-node');
    if (graphEntityBtn) {
        const mapView = getGraphMapView();
        if (mapView.suppressNextNodeClick) {
            mapView.suppressNextNodeClick = false;
            return;
        }
        window.selectKnowledgeGraphEntity(graphEntityBtn.dataset.entityId);
        return;
    }

    if (event.target.closest('#rag-graph-edit-entity-btn')) {
        window.showKnowledgeGraphEntityEditor(ragGraphState.selectedEntity);
        return;
    }

    const saveEntityBtn = event.target.closest('#rag-graph-save-entity-btn');
    if (saveEntityBtn) {
        window.saveKnowledgeGraphEntity(saveEntityBtn.dataset.entityId).catch(e => showToast(e.message || '实体保存失败', 'error'));
        return;
    }

    const mergeEntityBtn = event.target.closest('#rag-graph-merge-entity-btn');
    if (mergeEntityBtn) {
        window.mergeKnowledgeGraphEntity(mergeEntityBtn.dataset.sourceEntityId).catch(e => showToast(e.message || '实体合并失败', 'error'));
        return;
    }

    const editRelationBtn = event.target.closest('.rag-graph-edit-relation-btn');
    if (editRelationBtn) {
        window.editKnowledgeGraphRelation(editRelationBtn.dataset.relationId).catch(e => showToast(e.message || '关系编辑失败', 'error'));
        return;
    }

    const saveRelationBtn = event.target.closest('#rag-graph-save-relation-btn');
    if (saveRelationBtn) {
        window.saveKnowledgeGraphRelation(saveRelationBtn.dataset.relationId).catch(e => showToast(e.message || '关系保存失败', 'error'));
        return;
    }

    if (event.target.closest('#rag-graph-cancel-editor-btn')) {
        closeKnowledgeGraphEditorModal();
        return;
    }

    const deleteRelationBtn = event.target.closest('.rag-graph-delete-relation-btn');
    if (deleteRelationBtn) {
        window.deleteKnowledgeGraphRelation(deleteRelationBtn.dataset.relationId).catch(e => showToast(e.message || '关系删除失败', 'error'));
        return;
    }

    if (event.target.closest('#rag-graph-rebuild-doc-btn')) {
        window.rebuildKnowledgeGraphForDoc().catch(e => showToast(e.message || '图谱重建失败', 'error'));
        return;
    }

    if (event.target.closest('#rag-audit-btn')) {
        window.showKnowledgeDocAudit();
        return;
    }

    if (event.target.closest('#rag-batch-reindex-btn')) {
        window.batchReindexKnowledgeDocs();
        return;
    }

    if (event.target.closest('#rag-batch-delete-btn')) {
        window.batchDeleteKnowledgeDocs();
        return;
    }

    if (event.target.closest('#rag-retry-failed-btn')) {
        window.retryFailedKnowledgeDocs();
        return;
    }

    if (event.target.closest('#rag-debug-btn')) {
        window.debugRagQuery();
        return;
    }

});

document.addEventListener('pointerdown', (event) => {
    startGraphMapPan(event);
});

document.addEventListener('pointermove', (event) => {
    moveGraphMapPan(event);
});

document.addEventListener('pointerup', stopGraphMapPan);
document.addEventListener('pointercancel', stopGraphMapPan);

document.addEventListener('wheel', (event) => {
    const map = event.target.closest?.('.rag-graph-map');
    if (!map || event.target.closest?.('.rag-graph-map-controls')) return;
    const view = getGraphMapView();
    hideGraphNodeTooltip();
    event.preventDefault();
    zoomGraphMap(view.scale + (event.deltaY > 0 ? -RAG_GRAPH_ZOOM_STEP : RAG_GRAPH_ZOOM_STEP), event.clientX, event.clientY);
}, { passive: false });

document.addEventListener('mouseover', (event) => {
    const node = event.target.closest?.('.rag-graph-map-node');
    if (node && !node.contains(event.relatedTarget)) {
        showGraphNodeTooltip(node, event);
        return;
    }
    const relation = event.target.closest?.('.rag-graph-relation');
    if (!relation || relation.contains(event.relatedTarget)) return;
    showGraphNodeTooltip(relation, event);
});

document.addEventListener('mousemove', (event) => {
    const node = event.target.closest?.('.rag-graph-map-node, .rag-graph-relation');
    if (!node) return;
    positionGraphNodeTooltip(event);
});

document.addEventListener('mouseout', (event) => {
    const node = event.target.closest?.('.rag-graph-map-node');
    if (node && !node.contains(event.relatedTarget)) {
        hideGraphNodeTooltip();
        return;
    }
    const relation = event.target.closest?.('.rag-graph-relation');
    if (!relation || relation.contains(event.relatedTarget)) return;
    hideGraphNodeTooltip();
});

document.addEventListener('focusin', (event) => {
    const node = event.target.closest?.('.rag-graph-map-node, .rag-graph-relation');
    if (!node) return;
    showGraphNodeTooltip(node, node.getBoundingClientRect());
});

document.addEventListener('focusout', (event) => {
    if (event.target.closest?.('.rag-graph-map-node, .rag-graph-relation')) hideGraphNodeTooltip();
});

document.addEventListener('change', (event) => {
    if (event.target?.id === 'rag-select-all') {
        document.querySelectorAll('.rag-doc-check').forEach(input => { input.checked = event.target.checked; });
        return;
    }
    const enableToggle = event.target.closest?.('.rag-enable-toggle');
    if (enableToggle) {
        window.toggleKnowledgeDocEnabled(enableToggle.dataset.ragId, enableToggle.checked);
    }
});

document.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && event.target?.id === 'rag-debug-query') {
        window.debugRagQuery();
    }
    if (event.key === 'Enter' && event.target?.id === 'rag-graph-search') {
        loadGraphEntities().then(payload => {
            const firstEntity = payload.data?.[0];
            if (firstEntity) window.selectKnowledgeGraphEntity(firstEntity.id);
        }).catch(e => showToast(e.message || '实体搜索失败', 'error'));
    }
});

window.deleteKnowledgeDoc = async (id) => {
    const confirmed = await ragConfirm('删除知识库文档', '确定要从知识库中移除该文档吗？大模型将不再参考此文档。');
    if (!confirmed) return;
    
    try {
        const res = await apiFetch(`${API_BASE}/rag/docs/${id}`, {
            method: 'DELETE',
            headers: authHeaders()
        });
        if (res.ok) {
            showToast('文档已移除');
            window.loadKnowledgeDocs();
        }
    } catch (e) {
        showToast('删除失败', 'error');
    }
};

// 注入额外样式
const style = document.createElement('style');
style.textContent = `
    .status-badge { padding: 3px 7px; border-radius: 4px; font-size: 0.72rem; font-weight: 600; }
    .status-badge.ready { background: rgba(16, 185, 129, 0.1); color: #10b981; }
    .status-badge.processing { background: rgba(245, 158, 11, 0.1); color: #f59e0b; }
    .status-badge.error { background: rgba(239, 68, 68, 0.1); color: #ef4444; }
    .rag-actions { display: inline-flex; gap: 4px; align-items: center; justify-content: center; }
    .rag-actions button { height: 22px; min-height: 22px; padding: 0 7px; font-size: 0.66rem; border-radius: 6px; }
    .rag-summary { display: flex; justify-content: space-between; align-items: center; gap: 10px; margin: 0 0 10px; color: var(--text-muted); font-size: 0.76rem; }
    .rag-summary-items { display: flex; flex-wrap: wrap; gap: 6px; }
    .rag-summary-items span { display: inline-flex; gap: 4px; align-items: baseline; padding: 3px 7px; border: 1px solid var(--border); border-radius: 6px; background: rgba(148, 163, 184, 0.05); line-height: 1.35; }
    .rag-summary-items b { color: var(--text-main); font-weight: 700; }
    .rag-summary-error { max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #ef4444; }
    #rag-retry-failed-btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .rag-debug-panel { display: flex; gap: 7px; align-items: center; margin: 0 0 10px; }
    .rag-debug-panel .form-input { margin: 0; height: 32px; flex: 1; font-size: 0.8rem; padding: 5px 9px; }
    .rag-debug-panel .rag-debug-param { flex: 0 0 80px; }
    .rag-debug-panel button { height: 32px; white-space: nowrap; font-size: 0.78rem; padding: 0 11px; }
    .rag-debug-results { margin: 0 0 14px; border: 1px solid var(--border); border-radius: 8px; background: rgba(148, 163, 184, 0.04); overflow: hidden; }
    .rag-debug-meta { display: flex; flex-wrap: wrap; gap: 7px; padding: 8px 10px; color: var(--text-muted); font-size: 0.72rem; border-bottom: 1px solid var(--border); }
    .rag-debug-list { display: grid; gap: 7px; padding: 8px; max-height: 300px; overflow: auto; }
    .rag-debug-item { border: 1px solid var(--border); border-radius: 6px; padding: 8px 9px; background: var(--bg-secondary); }
    .rag-debug-item.matched { border-color: rgba(16, 185, 129, 0.45); background: rgba(16, 185, 129, 0.06); }
    .rag-debug-item-head { display: flex; justify-content: space-between; gap: 10px; margin-bottom: 5px; font-size: 0.76rem; }
    .rag-debug-item p { margin: 0; color: var(--text-muted); font-size: 0.74rem; line-height: 1.45; }
    .rag-debug-hit { background: rgba(250, 204, 21, 0.45); color: inherit; padding: 0 1px; border-radius: 2px; }
    .rag-debug-score-bar { width: 100%; height: 4px; background: rgba(148, 163, 184, 0.18); border-radius: 999px; overflow: hidden; margin: 4px 0 6px; }
    .rag-debug-score-bar-fill { height: 100%; background: linear-gradient(90deg, rgba(16, 185, 129, 0.85), rgba(59, 130, 246, 0.85)); border-radius: inherit; transition: width 120ms ease-out; }
    .rag-debug-score { font-variant-numeric: tabular-nums; }
    .rag-debug-grouped { display: flex; flex-wrap: wrap; gap: 6px; padding: 8px 10px; border-bottom: 1px solid var(--border); background: rgba(148, 163, 184, 0.04); }
    .rag-debug-grouped-item { display: inline-flex; align-items: center; gap: 6px; padding: 3px 8px; border-radius: 999px; background: var(--bg-secondary); border: 1px solid var(--border); font-size: 0.7rem; color: var(--text-muted); }
    .rag-debug-grouped-source { color: var(--text-primary); font-weight: 600; max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .rag-debug-grouped-stats { font-variant-numeric: tabular-nums; }
    .rag-debug-grouped-divider { margin: 0 4px; color: var(--text-muted); opacity: 0.6; }
    .rag-feedback-actions { display: flex; gap: 5px; margin-top: 7px; }
    .rag-feedback-actions button { padding: 1px 7px; font-size: 0.7rem; }
    .rag-debug-empty { padding: 10px; color: var(--text-muted); text-align: center; font-size: 0.76rem; }
    .rag-detail-modal-overlay { z-index: 5400; }
    #rag-graph-modal.rag-detail-modal-overlay {
        align-items: stretch;
        justify-content: stretch;
        padding: 0;
        background: var(--surface);
        backdrop-filter: none;
    }
    #rag-graph-modal.rag-detail-modal-overlay.hidden {
        display: none;
    }
    .rag-detail-modal {
        width: min(980px, calc(100vw - 36px));
        max-height: min(760px, calc(100vh - 36px));
        padding: 22px;
        text-align: left;
        display: flex;
        flex-direction: column;
        gap: 14px;
    }
    .rag-detail-header {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 14px;
        border-bottom: 1px solid var(--border);
        padding-bottom: 12px;
    }
    .rag-detail-header h3 {
        margin: 0;
        font-size: 1.05rem;
        max-width: 680px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .rag-detail-meta {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
        gap: 8px;
        margin-bottom: 6px;
    }
    .rag-meta-card {
        display: flex;
        flex-direction: column;
        gap: 3px;
        padding: 6px 10px;
        border: 1px solid var(--border);
        border-radius: 8px;
        background: var(--bg-secondary);
        transition: all 0.2s ease;
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.02);
        min-width: 0;
    }
    .rag-meta-card:hover {
        border-color: var(--primary-color);
        box-shadow: 0 3px 8px rgba(0, 0, 0, 0.05);
        transform: translateY(-1px);
    }
    .rag-meta-label {
        display: flex;
        align-items: center;
        gap: 5px;
        color: var(--text-muted);
        font-size: 0.65rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.01em;
    }
    .rag-meta-label svg {
        opacity: 0.6;
        width: 12px !important;
        height: 12px !important;
    }
    .rag-meta-value {
        color: var(--text-main);
        font-size: 0.78rem;
        font-weight: 700;
        line-height: 1.2;
        word-break: break-all;
        white-space: nowrap;
    }
    @media (max-width: 900px) {
        .rag-meta-value { white-space: normal; }
    }
    .rag-meta-card.status-ready .rag-meta-value { color: #10b981; }
    .rag-meta-card.status-processing .rag-meta-value { color: #f59e0b; }
    .rag-meta-card.status-error .rag-meta-value { color: #ef4444; }
    .rag-detail-chunks {
        display: grid;
        gap: 10px;
        overflow: auto;
        padding-right: 4px;
    }
    .rag-detail-chunk {
        border: 1px solid var(--border);
        border-radius: 8px;
        background: var(--bg-secondary);
        padding: 8px 12px;
    }
    .rag-detail-chunk header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 4px;
        color: var(--text-muted);
        font-size: 0.75rem;
    }
    .rag-detail-chunk p {
        margin: 0;
        color: var(--text-main);
        line-height: 1.5;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        font-size: 0.82rem;
    }
    .rag-audit-table-wrap {
        max-height: 560px;
        overflow: auto;
    }
    .rag-audit-table-wrap td {
        max-width: 260px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .rag-graph-modal {
        width: 100vw;
        height: 100vh;
        max-width: none;
        max-height: none;
        padding: 0;
        text-align: left;
        display: flex;
        flex-direction: column;
        gap: 0;
        overflow: hidden;
        border-radius: 0;
        border: 0;
        box-shadow: none;
    }
    .rag-graph-modal .rag-detail-header {
        flex: 0 0 auto;
        padding: 14px 18px 12px;
        background: #fff;
        border-bottom: 1px solid var(--border);
    }
    .rag-graph-modal .rag-detail-header h3 {
        margin: 0 0 4px;
        font-size: 1.08rem;
        color: var(--text-main);
        max-width: none;
    }
    .rag-graph-modal .rag-detail-header .model-modal-desc {
        margin: 0;
        color: var(--text-muted);
        font-size: 0.78rem;
        line-height: 1.4;
    }
    #rag-graph-close-btn {
        flex: 0 0 auto;
        min-width: 72px;
        height: 34px;
        padding: 0 14px;
        font-size: 0.82rem;
        font-weight: 700;
        border-radius: 8px;
        box-shadow: none;
    }
    .rag-graph-topbar {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px 12px;
        flex: 0 0 auto;
        padding: 10px 18px 12px;
        background: #f8fafc;
    }
    .rag-graph-summary {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        align-items: center;
        color: var(--text-muted);
        font-size: 0.72rem;
        flex: 0 1 auto;
        min-width: 0;
        padding: 0;
    }
    .rag-graph-summary span {
        display: inline-flex;
        gap: 4px;
        align-items: baseline;
        min-height: 24px;
        padding: 3px 8px;
        border: 1px solid rgba(148, 163, 184, 0.16);
        border-radius: 7px;
        background: rgba(248, 250, 252, 0.8);
        line-height: 1.35;
    }
    .rag-graph-summary b { color: var(--text-main); }
    .rag-graph-toolbar {
        display: grid;
        grid-template-columns: minmax(240px, 1fr) 190px auto;
        gap: 8px;
        align-items: center;
        flex: 1 1 560px;
        min-width: min(560px, 100%);
        padding: 0;
        background: transparent;
    }
    .rag-graph-toolbar .form-input {
        margin: 0;
        height: 36px;
        min-height: 36px;
        padding: 0 12px;
        font-size: 0.82rem;
        border-radius: 8px;
        background: #fff;
    }
    .rag-graph-toolbar button {
        height: 36px;
        min-height: 36px;
        padding: 0 14px;
        font-size: 0.82rem;
        border-radius: 8px;
        white-space: nowrap;
    }
    .rag-graph-layout {
        display: grid;
        grid-template-columns: minmax(280px, 0.85fr) minmax(520px, 1.55fr) minmax(340px, 1fr);
        gap: 10px;
        flex: 1 1 auto;
        min-height: 0;
        overflow: hidden;
        padding: 0 18px 18px;
        background: #f8fafc;
    }
    .rag-graph-panel {
        border: 1px solid var(--border);
        border-radius: 8px;
        background: #fff;
        box-shadow: 0 8px 18px rgba(15, 23, 42, 0.035);
        display: flex;
        min-width: 0;
        min-height: 0;
        flex-direction: column;
    }
    .rag-graph-panel-head {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 8px;
        padding: 8px 10px;
        border-bottom: 1px solid var(--border);
        font-size: 0.86rem;
        flex: 0 0 auto;
    }
    .rag-graph-panel-head span {
        color: var(--text-muted);
        font-variant-numeric: tabular-nums;
    }
    .rag-graph-panel-actions {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 6px;
        min-width: 0;
    }
    .rag-graph-panel-actions button {
        height: 28px;
        min-height: 28px;
        padding: 0 10px;
        font-size: 0.72rem;
        border-radius: 7px;
        white-space: nowrap;
    }
    .rag-graph-panel-actions button.hidden {
        display: none;
    }
    .rag-graph-entity-list,
    .rag-graph-relation-list,
    .rag-graph-canvas {
        overflow: auto;
        padding: 8px;
        min-height: 0;
        flex: 1 1 auto;
    }
    .rag-graph-entity {
        width: 100%;
        border: 1px solid var(--border);
        background: var(--bg-secondary);
        color: var(--text-main);
        border-radius: 7px;
        padding: 8px 9px;
        margin-bottom: 7px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        text-align: left;
        cursor: pointer;
    }
    .rag-graph-entity.active,
    .rag-graph-node.center {
        border-color: rgba(59, 130, 246, 0.65);
        background: rgba(59, 130, 246, 0.08);
    }
    .rag-graph-entity strong,
    .rag-graph-node strong {
        display: block;
        font-size: 0.8rem;
        line-height: 1.35;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .rag-graph-entity small,
    .rag-graph-node small,
    .rag-graph-relation small {
        color: var(--text-muted);
        font-size: 0.7rem;
        line-height: 1.35;
    }
    .rag-graph-entity em {
        font-style: normal;
        color: var(--text-muted);
        font-size: 0.72rem;
        font-variant-numeric: tabular-nums;
    }
    .rag-graph-node-cloud {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        align-content: flex-start;
        padding-bottom: 10px;
        border-bottom: 1px solid var(--border);
    }
    .rag-graph-node {
        border: 1px solid var(--border);
        border-radius: 8px;
        background: var(--bg-secondary);
        color: var(--text-main);
        padding: 8px 10px;
        min-width: 112px;
        max-width: 200px;
        cursor: pointer;
        text-align: left;
    }
    .rag-graph-edge-list {
        display: grid;
        gap: 6px;
        padding-top: 10px;
    }
    .rag-graph-edge {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
        gap: 6px;
        align-items: center;
        color: var(--text-muted);
        font-size: 0.74rem;
    }
    .rag-graph-edge span {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .rag-graph-edge b {
        color: var(--text-main);
        font-weight: 700;
        font-size: 0.7rem;
    }
    .rag-graph-relation {
        border: 1px solid var(--border);
        border-radius: 7px;
        background: var(--bg-secondary);
        padding: 8px 9px;
        margin-bottom: 7px;
    }
    .rag-graph-relation header {
        display: flex;
        justify-content: space-between;
        gap: 8px;
        font-size: 0.78rem;
        line-height: 1.35;
    }
    .rag-graph-relation p {
        margin: 4px 0;
        color: var(--text-muted);
        font-size: 0.72rem;
        line-height: 1.4;
    }
    .rag-graph-actions,
    .rag-graph-editor-actions {
        display: flex;
        gap: 6px;
        margin-top: 7px;
    }
    .rag-graph-actions button {
        height: 24px;
        min-height: 24px;
        padding: 0 8px;
        font-size: 0.7rem;
        border-radius: 6px;
    }
    .rag-graph-editor-modal-overlay {
        z-index: 5520;
        align-items: center;
        justify-content: center;
        padding: 18px;
        background: rgba(15, 23, 42, 0.28);
        backdrop-filter: blur(6px);
    }
    .rag-graph-editor-modal-overlay.hidden {
        display: none;
    }
    .rag-graph-editor-modal {
        width: min(780px, calc(100vw - 40px));
        max-height: min(720px, calc(100vh - 40px));
        padding: 0;
        text-align: left;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        border-radius: 10px;
        border: 1px solid rgba(148, 163, 184, 0.28);
        box-shadow: 0 24px 70px rgba(15, 23, 42, 0.22);
    }
    .rag-graph-editor-modal-head {
        flex: 0 0 auto;
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 16px;
        padding: 16px 18px 14px;
        border-bottom: 1px solid var(--border);
        background: #fff;
    }
    .rag-graph-editor-modal-head h3 {
        margin: 0 0 4px;
        color: var(--text-main);
        font-size: 1rem;
        line-height: 1.25;
    }
    .rag-graph-editor-modal-head .model-modal-desc {
        margin: 0;
        color: var(--text-muted);
        font-size: 0.76rem;
        line-height: 1.4;
    }
    .rag-graph-editor-modal-body {
        flex: 1 1 auto;
        min-height: 0;
        overflow: auto;
        padding: 16px 18px 18px;
        background: #fff;
    }
    #rag-graph-editor-close-btn {
        flex: 0 0 auto;
        min-width: 64px;
        height: 32px;
        padding: 0 12px;
        font-size: 0.78rem;
        border-radius: 8px;
        box-shadow: none;
    }
    .rag-graph-editor {
        border: 1px solid var(--border);
        border-radius: 8px;
        padding: 10px 12px;
        background: #fff;
        box-shadow: 0 8px 18px rgba(15, 23, 42, 0.035);
        flex: 0 0 auto;
        margin: 0 18px 18px;
    }
    .rag-graph-editor-grid {
        display: grid;
        grid-template-columns: repeat(3, minmax(160px, 1fr));
        gap: 8px;
    }
    .rag-graph-editor-grid label {
        display: grid;
        gap: 4px;
        color: var(--text-muted);
        font-size: 0.74rem;
    }
    .rag-graph-editor-grid .form-input {
        margin: 0;
        height: 32px;
        min-height: 32px;
        padding: 0 10px;
        font-size: 0.78rem;
        border-radius: 8px;
        background: #fff;
    }
    .rag-graph-editor-actions button {
        height: 28px;
        min-height: 28px;
        padding: 0 10px;
        font-size: 0.74rem;
        border-radius: 8px;
    }
    .rag-graph-editor-wide { grid-column: 1 / -1; }
    .rag-graph-layout {
        grid-template-columns: minmax(240px, 0.72fr) minmax(500px, 1.62fr) minmax(300px, 0.94fr);
        gap: 12px;
    }
    .rag-graph-canvas-panel {
        min-width: 0;
    }
    .rag-graph-canvas {
        position: relative;
        overflow: hidden;
        padding: 0;
        background:
            linear-gradient(90deg, rgba(148, 163, 184, 0.08) 1px, transparent 1px),
            linear-gradient(180deg, rgba(148, 163, 184, 0.08) 1px, transparent 1px),
            #fbfdff;
        background-size: 32px 32px;
    }
    .rag-graph-map {
        position: relative;
        width: 100%;
        height: calc(100% - 42px);
        min-height: 360px;
        overflow: hidden;
        cursor: grab;
        user-select: none;
        touch-action: none;
    }
    .rag-graph-map.is-panning {
        cursor: grabbing;
    }
    .rag-graph-map-stage {
        position: absolute;
        inset: 0;
        z-index: 1;
        transform-origin: 0 0;
        will-change: transform;
        transition: transform 120ms ease;
    }
    .rag-graph-map.is-panning .rag-graph-map-stage {
        transition: none;
    }
    .rag-graph-map-controls {
        position: absolute;
        top: 10px;
        right: 10px;
        z-index: 8;
        display: flex;
        align-items: center;
        gap: 4px;
        padding: 4px;
        border: 1px solid rgba(148, 163, 184, 0.22);
        border-radius: 8px;
        background: rgba(255, 255, 255, 0.92);
        box-shadow: 0 8px 18px rgba(15, 23, 42, 0.08);
        backdrop-filter: blur(8px);
        cursor: default;
    }
    .rag-graph-map-controls button {
        width: 28px;
        height: 28px;
        min-height: 28px;
        padding: 0;
        border-radius: 7px;
        font-size: 0.78rem;
        font-weight: 900;
        line-height: 1;
    }
    .rag-graph-map-controls button[data-graph-zoom-action="reset"] {
        width: 38px;
        font-size: 0.68rem;
    }
    .rag-graph-map-controls button:disabled {
        opacity: 0.46;
        cursor: not-allowed;
    }
    #rag-graph-zoom-value {
        width: 42px;
        color: #475569;
        font-size: 0.68rem;
        font-weight: 900;
        text-align: center;
        font-variant-numeric: tabular-nums;
    }
    .rag-graph-svg {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        pointer-events: none;
    }
    .rag-graph-svg marker path {
        fill: #64748b;
    }
    .rag-graph-link {
        fill: none;
        stroke: #64748b;
        stroke-width: 0.55;
        opacity: 0.72;
        vector-effect: non-scaling-stroke;
    }
    .rag-graph-link.is-owner { stroke: #059669; }
    .rag-graph-link.is-belong { stroke: #2563eb; }
    .rag-graph-link.is-depend { stroke: #7c3aed; }
    .rag-graph-link.is-contain { stroke: #0f766e; }
    .rag-graph-link.is-affect { stroke: #dc2626; }
    .rag-graph-edge-label {
        position: absolute;
        z-index: 3;
        transform: translate(-50%, -50%);
        max-width: 86px;
        padding: 3px 7px;
        border-radius: 999px;
        border: 1px solid rgba(100, 116, 139, 0.24);
        background: rgba(255, 255, 255, 0.88);
        color: #334155;
        font-size: 0.66rem;
        font-weight: 800;
        line-height: 1;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        box-shadow: 0 4px 10px rgba(15, 23, 42, 0.06);
        pointer-events: none;
    }
    .rag-graph-edge-label.is-owner { color: #047857; border-color: rgba(5, 150, 105, 0.26); }
    .rag-graph-edge-label.is-belong { color: #1d4ed8; border-color: rgba(37, 99, 235, 0.24); }
    .rag-graph-edge-label.is-depend { color: #6d28d9; border-color: rgba(124, 58, 237, 0.24); }
    .rag-graph-edge-label.is-contain { color: #0f766e; border-color: rgba(15, 118, 110, 0.24); }
    .rag-graph-edge-label.is-affect { color: #b91c1c; border-color: rgba(220, 38, 38, 0.24); }
    .rag-graph-map-node {
        position: absolute;
        z-index: 4;
        width: 138px;
        min-height: 64px;
        margin: 0;
        transform: translate(-50%, -50%);
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        justify-content: center;
        gap: 3px;
        padding: 9px 11px;
        border-radius: 8px;
        border-color: rgba(148, 163, 184, 0.32);
        background: rgba(255, 255, 255, 0.94);
        box-shadow: 0 10px 26px rgba(15, 23, 42, 0.09);
    }
    .rag-graph-map-node:hover {
        border-color: rgba(16, 185, 129, 0.45);
        box-shadow: 0 14px 30px rgba(15, 23, 42, 0.12);
    }
    .rag-graph-map-node.center {
        width: 162px;
        min-height: 76px;
        border-color: rgba(16, 185, 129, 0.68);
        background: #ecfdf5;
        box-shadow: 0 18px 34px rgba(16, 185, 129, 0.16);
    }
    .rag-graph-map-node span {
        max-width: 100%;
        color: #047857;
        font-size: 0.64rem;
        font-weight: 900;
        line-height: 1;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }
    .rag-graph-map-node strong {
        width: 100%;
        color: #0f172a;
        font-size: 0.82rem;
        line-height: 1.2;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }
    .rag-graph-map-node small {
        width: 100%;
        color: #64748b;
        font-size: 0.68rem;
        line-height: 1.2;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }
    .rag-graph-node-tooltip {
        position: fixed;
        z-index: 5510;
        display: grid;
        gap: 4px;
        max-width: min(340px, calc(100vw - 24px));
        padding: 9px 11px;
        border: 1px solid rgba(148, 163, 184, 0.18);
        border-radius: 8px;
        background: rgba(15, 23, 42, 0.95);
        color: rgba(255, 255, 255, 0.88);
        box-shadow: 0 16px 36px rgba(15, 23, 42, 0.22);
        pointer-events: none;
        font-size: 0.73rem;
        line-height: 1.45;
        overflow-wrap: anywhere;
        white-space: normal;
    }
    .rag-graph-node-tooltip.hidden {
        display: none;
    }
    .rag-graph-node-tooltip strong {
        color: #fff;
        font-size: 0.78rem;
        line-height: 1.35;
    }
    .rag-graph-node-tooltip span {
        color: rgba(226, 232, 240, 0.9);
    }
    .rag-graph-map-footer {
        position: absolute;
        left: 12px;
        right: 12px;
        bottom: 10px;
        z-index: 5;
        display: flex;
        justify-content: space-between;
        gap: 10px;
        padding: 7px 10px;
        border: 1px solid rgba(148, 163, 184, 0.2);
        border-radius: 8px;
        background: rgba(255, 255, 255, 0.88);
        color: #64748b;
        font-size: 0.7rem;
        font-weight: 700;
        backdrop-filter: blur(8px);
    }
    .rag-graph-summary span {
        background: #fff;
    }
    .rag-graph-summary span small {
        color: var(--text-muted);
        font-size: 0.7rem;
        font-weight: 800;
    }
    .rag-graph-summary-main b {
        font-size: 0.86rem;
    }
    .rag-graph-entity {
        border-radius: 8px;
        box-sizing: border-box;
        min-width: 0;
        overflow: hidden;
        transition: border-color 0.16s ease, background 0.16s ease, box-shadow 0.16s ease;
    }
    .rag-graph-entity > span {
        min-width: 0;
        flex: 1 1 calc(100% - 90px);
    }
    .rag-graph-entity-list,
    .rag-graph-relation-list {
        overflow-x: hidden;
    }
    .rag-graph-entity.active {
        border-color: rgba(16, 185, 129, 0.55);
        background: #ecfdf5;
        box-shadow: inset 3px 0 0 rgba(16, 185, 129, 0.78);
    }
    .rag-graph-entity small b {
        color: #047857;
        font-weight: 900;
    }
    .rag-graph-entity em {
        flex: 0 0 82px;
        width: 82px;
        padding: 2px 7px;
        border-radius: 999px;
        background: rgba(148, 163, 184, 0.1);
        color: #475569;
        font-size: 0.66rem;
        font-weight: 800;
        text-align: center;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: clip;
    }
    .rag-graph-relation {
        box-sizing: border-box;
        min-width: 0;
        padding: 6px 8px;
        margin-bottom: 5px;
        border-radius: 7px;
        background: #fff;
        box-shadow: 0 3px 10px rgba(15, 23, 42, 0.03);
    }
    .rag-graph-relation.is-owner { border-left: 2px solid #059669; }
    .rag-graph-relation.is-belong { border-left: 2px solid #2563eb; }
    .rag-graph-relation.is-depend { border-left: 2px solid #7c3aed; }
    .rag-graph-relation.is-contain { border-left: 2px solid #0f766e; }
    .rag-graph-relation.is-affect { border-left: 2px solid #dc2626; }
    .rag-graph-relation header {
        align-items: center;
        gap: 6px;
        font-size: 0.75rem;
        line-height: 1.2;
    }
    .rag-graph-relation header strong {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
        align-items: center;
        gap: 5px;
        min-width: 0;
        flex: 1 1 auto;
    }
    .rag-graph-relation header strong span {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .rag-graph-relation header strong b {
        padding: 2px 6px;
        border-radius: 999px;
        background: rgba(16, 185, 129, 0.08);
        color: #047857;
        font-size: 0.64rem;
        line-height: 1;
        white-space: nowrap;
    }
    .rag-graph-relation-foot {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        align-items: center;
        gap: 6px;
        margin-top: 4px;
    }
    .rag-graph-relation-foot p {
        display: flex;
        align-items: center;
        gap: 8px;
        min-width: 0;
        margin: 0;
        color: var(--text-muted);
        font-size: 0.68rem;
        line-height: 1.2;
    }
    .rag-graph-relation-foot p span {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .rag-graph-relation-foot p span:first-child {
        flex: 0 0 auto;
        max-width: 108px;
    }
    .rag-graph-relation .rag-graph-actions {
        margin: 0;
        gap: 4px;
    }
    .rag-graph-relation .rag-graph-actions button {
        height: 22px;
        min-height: 22px;
        padding: 0 7px;
        font-size: 0.66rem;
        border-radius: 6px;
    }
    .rag-graph-confidence {
        flex: 0 0 auto;
        color: #64748b;
        font-size: 0.64rem;
        font-weight: 800;
        white-space: nowrap;
    }
    .rag-graph-editor {
        display: flex;
        flex-direction: column;
        gap: 8px;
    }
    .rag-graph-editor-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        color: var(--text-main);
        font-size: 0.82rem;
    }
    .rag-graph-editor-head span {
        color: var(--text-muted);
        font-size: 0.72rem;
        font-weight: 800;
    }
    .rag-graph-editor-grid textarea.form-input {
        min-height: 54px;
        height: auto;
        padding: 8px 10px;
        resize: vertical;
        line-height: 1.35;
    }
    .rag-graph-editor-grid input[readonly] {
        color: var(--text-muted);
        background: #f8fafc;
    }
    @media (max-width: 1200px) {
        .rag-graph-layout {
            grid-template-columns: minmax(240px, 0.9fr) minmax(420px, 1.3fr) minmax(280px, 1fr);
        }
    }
    @media (max-width: 720px) {
        .rag-detail-modal { width: calc(100vw - 20px); max-height: calc(100vh - 20px); padding: 16px; }
        .rag-detail-header { align-items: stretch; flex-direction: column; }
        .rag-detail-header h3 { max-width: 100%; white-space: normal; }
        .rag-graph-modal { width: 100vw; height: 100vh; padding: 14px; border-radius: 0; }
        .rag-graph-editor-modal { width: calc(100vw - 20px); max-height: calc(100vh - 20px); border-radius: 8px; }
        .rag-graph-editor-modal-head { padding: 14px; }
        .rag-graph-editor-modal-body { padding: 14px; }
        .rag-graph-topbar { align-items: stretch; padding: 10px 14px 12px; }
        .rag-graph-summary,
        .rag-graph-toolbar { width: 100%; }
        .rag-graph-toolbar,
        .rag-graph-layout,
        .rag-graph-editor-grid { grid-template-columns: 1fr; }
        .rag-graph-layout { overflow: auto; }
        .rag-graph-panel { min-height: 280px; }
    }
`;
document.head.appendChild(style);
