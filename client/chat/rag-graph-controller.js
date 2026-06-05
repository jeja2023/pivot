/* eslint-disable no-undef, no-unused-vars */
// RAG 知识图谱控制器 RAG graph controller
// Split from rag.js.
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
