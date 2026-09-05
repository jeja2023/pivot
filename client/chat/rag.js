// Split from rag.js.
/* eslint-disable no-undef */
const {
    RAG_ICONS,
    escapeRagHtml,
    formatRagDateToCN,
    formatRagSize
} = window.Pivot?.ragFormat || {};

const {
    escapeAttr: escapeRagAttr = (value) => String(value ?? '')
} = window.Pivot?.html || window.Pivot.legacy.PivotSafeHtml || {};

const {
    buildGraphCanvasMarkup,
    buildGraphEditorModalShellHtml,
    buildGraphEntitiesHtml,
    buildGraphEntityEditorHtml,
    buildGraphNodeTooltip,
    buildGraphModalShellHtml,
    buildGraphQueryResultHtml,
    buildGraphRelationFilterOptionsHtml,
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
    cancelGraphNodeTooltipHide: cancelGraphNodeTooltipHideUi = () => { },
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
    hideGraphNodeTooltip: hideGraphNodeTooltipUi = () => { },
    moveGraphMapPan: moveGraphMapPanUi = () => false,
    positionGraphNodeTooltip: positionGraphNodeTooltipUi = () => { },
    resetGraphMapView: resetGraphMapViewUi = () => { },
    scheduleGraphNodeTooltipHide: scheduleGraphNodeTooltipHideUi = () => { },
    showGraphNodeTooltip: showGraphNodeTooltipUi = () => { },
    startGraphMapPan: startGraphMapPanUi = () => false,
    stopGraphMapPan: stopGraphMapPanUi = () => false,
    zoomGraphMap: zoomGraphMapUi = () => { },
    zoomGraphMapByAction: zoomGraphMapByActionUi = () => { }
} = window.Pivot?.ragGraphUi || {};

const getRagStatusLabel = (status) => {
    if (status === 'ready') return '就绪';
    if (status === 'processing') return '处理中';
    if (status === 'error') return '失败';
    return status || '-';
};

const renderRagActions = (doc) => {
    const buttons = [];
    const canEdit = doc.can_edit !== false && doc.read_only !== true;
    buttons.push(`<button type="button" class="btn-secondary rag-detail-btn" data-rag-id="${doc.id}" title="查看文档详情">详情</button>`);
    buttons.push(`<button type="button" class="btn-secondary rag-doc-meta-btn" data-rag-id="${doc.id}" title="整理专题库和标签">整理</button>`);
    if (Number(doc.chunk_count || 0) > 0) {
        buttons.push(`<button type="button" class="btn-secondary rag-doc-graph-btn" data-rag-id="${doc.id}" title="查看文档知识图谱">图谱</button>`);
    }
    if (doc.status === 'error' && doc.source_path) {
        buttons.push(`<button type="button" class="btn-secondary rag-reindex-btn" data-rag-id="${doc.id}" title="重新建立文档索引">重试</button>`);
    }
    buttons.push(`<button type="button" class="btn-danger rag-delete-btn" data-rag-id="${doc.id}" title="从知识库移除文档">删除</button>`);
    return (canEdit ? buttons : buttons.filter(button => !/rag-doc-meta-btn|rag-reindex-btn|rag-delete-btn/.test(button))).join('');
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
        if (shouldAutoRefreshRagDocs()) window.Pivot.legacy.loadKnowledgeDocs();
    }, 3000);
};

const ragConfirm = (title, message) => new Promise((resolve) => {
    if (typeof window.Pivot.legacy.showConfirm === 'function') {
        window.Pivot.legacy.showConfirm(title, message, () => resolve(true));
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

document.addEventListener('click', async (event) => {
    const activeActionMenu = event.target.closest('.knowledge-action-menu');
    if (activeActionMenu) {
        if (event.target.closest('.knowledge-action-menu-panel')) {
            document.querySelectorAll('.knowledge-action-menu').forEach(menu => {
                menu.removeAttribute('open');
            });
        } else {
            document.querySelectorAll('.knowledge-action-menu').forEach(menu => {
                if (menu !== activeActionMenu) {
                    menu.removeAttribute('open');
                }
            });
        }
    } else {
        document.querySelectorAll('.knowledge-action-menu').forEach(menu => {
            menu.removeAttribute('open');
        });
    }

    const reindexBtn = event.target.closest('.rag-reindex-btn');
    if (reindexBtn) {
        window.Pivot.legacy.reindexKnowledgeDoc(reindexBtn.dataset.ragId);
        return;
    }

    const detailBtn = event.target.closest('.rag-detail-btn');
    if (detailBtn) {
        window.Pivot.legacy.showKnowledgeDocDetail(detailBtn.dataset.ragId);
        return;
    }

    const metaBtn = event.target.closest('.rag-doc-meta-btn');
    if (metaBtn) {
        window.Pivot.legacy.openKnowledgeDocMetaModal?.(metaBtn.dataset.ragId);
        return;
    }

    const docGraphBtn = event.target.closest('.rag-doc-graph-btn');
    if (docGraphBtn) {
        window.Pivot.legacy.openKnowledgeGraph(docGraphBtn.dataset.ragId);
        return;
    }

    const feedbackBtn = event.target.closest('.rag-feedback-btn');
    if (feedbackBtn) {
        window.Pivot.legacy.sendRagFeedback(feedbackBtn);
        return;
    }

    const debugChatBtn = event.target.closest('[data-rag-debug-chat]');
    if (debugChatBtn) {
        const query = debugChatBtn.dataset.ragDebugChat || document.getElementById('rag-debug-query')?.value || '';
        document.getElementById('rag-debug-modal')?.classList.add('hidden');
        window.Pivot.legacy.showMainWorkspace?.('chat');
        try {
            localStorage.setItem('pivot_chat_rag_enabled', 'true');
        } catch (e) {
            // 本地存储不可用时，仍然尝试同步当前页面按钮状态。
        }
        await window.Pivot.legacy.applyRagDebugScopeToChat?.();
        window.Pivot.legacy.syncChatToolToggles?.();
        const input = document.getElementById('user-input');
        if (input && query) {
            input.value = query;
            window.Pivot.legacy.resizeUserInput?.();
            input.focus();
        }
        showToast('已带着这个问题回到聊天，并打开知识库', 'success');
        return;
    }

    const deleteBtn = event.target.closest('.rag-delete-btn');
    if (deleteBtn) {
        window.Pivot.legacy.deleteKnowledgeDoc(deleteBtn.dataset.ragId);
        return;
    }

    if (event.target.closest('#rag-refresh-btn')) {
        window.Pivot.legacy.loadKnowledgeDocs();
        return;
    }

    if (event.target.closest('#rag-create-collection-btn')) {
        window.Pivot.legacy.createKnowledgeCollectionFromPrompt?.();
        return;
    }

    if (event.target.closest('#rag-create-tag-btn')) {
        window.Pivot.legacy.createKnowledgeTagFromPrompt?.();
        return;
    }

    if (event.target.closest('#rag-graph-open-btn')) {
        window.Pivot.legacy.openKnowledgeGraph();
        return;
    }

    if (event.target.closest('#rag-graph-search-btn')) {
        refreshGraphSearch().catch(e => showToast(e.message || '实体搜索失败', 'error'));
        return;
    }

    if (event.target.closest('#rag-graph-query-btn')) {
        window.Pivot.legacy.debugKnowledgeGraphQuery().catch(e => showToast(e.message || '图谱查询失败', 'error'));
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
        window.Pivot.legacy.selectKnowledgeGraphEntity(graphEntityBtn.dataset.entityId);
        return;
    }

    if (event.target.closest('#rag-graph-edit-entity-btn')) {
        window.Pivot.legacy.showKnowledgeGraphEntityEditor(ragGraphState.selectedEntity);
        return;
    }

    const saveEntityBtn = event.target.closest('#rag-graph-save-entity-btn');
    if (saveEntityBtn) {
        window.Pivot.legacy.saveKnowledgeGraphEntity(saveEntityBtn.dataset.entityId).catch(e => showToast(e.message || '实体保存失败', 'error'));
        return;
    }

    const mergeEntityBtn = event.target.closest('#rag-graph-merge-entity-btn');
    if (mergeEntityBtn) {
        window.Pivot.legacy.mergeKnowledgeGraphEntity(mergeEntityBtn.dataset.sourceEntityId).catch(e => showToast(e.message || '实体合并失败', 'error'));
        return;
    }

    const editRelationBtn = event.target.closest('.rag-graph-edit-relation-btn');
    if (editRelationBtn) {
        window.Pivot.legacy.editKnowledgeGraphRelation(editRelationBtn.dataset.relationId).catch(e => showToast(e.message || '关系编辑失败', 'error'));
        return;
    }

    const saveRelationBtn = event.target.closest('#rag-graph-save-relation-btn');
    if (saveRelationBtn) {
        window.Pivot.legacy.saveKnowledgeGraphRelation(saveRelationBtn.dataset.relationId).catch(e => showToast(e.message || '关系保存失败', 'error'));
        return;
    }

    const confirmRelationBtn = event.target.closest('.rag-graph-confirm-relation-btn');
    if (confirmRelationBtn) {
        window.Pivot.legacy.confirmKnowledgeGraphRelation(confirmRelationBtn.dataset.relationId).catch(e => showToast(e.message || '关系确认失败', 'error'));
        return;
    }

    if (event.target.closest('#rag-graph-cancel-editor-btn')) {
        closeKnowledgeGraphEditorModal();
        return;
    }

    const deleteRelationBtn = event.target.closest('.rag-graph-delete-relation-btn');
    if (deleteRelationBtn) {
        window.Pivot.legacy.deleteKnowledgeGraphRelation(deleteRelationBtn.dataset.relationId).catch(e => showToast(e.message || '关系删除失败', 'error'));
        return;
    }

    if (event.target.closest('#rag-graph-rebuild-doc-btn')) {
        window.Pivot.legacy.rebuildKnowledgeGraphForDoc().catch(e => showToast(e.message || '图谱重建失败', 'error'));
        return;
    }

    if (event.target.closest('#rag-audit-btn')) {
        window.Pivot.legacy.showKnowledgeDocAudit();
        return;
    }

    if (event.target.closest('#rag-batch-reindex-btn')) {
        window.Pivot.legacy.batchReindexKnowledgeDocs();
        return;
    }

    if (event.target.closest('#rag-batch-delete-btn')) {
        window.Pivot.legacy.batchDeleteKnowledgeDocs();
        return;
    }

    if (event.target.closest('#rag-retry-failed-btn')) {
        window.Pivot.legacy.retryFailedKnowledgeDocs();
        return;
    }

    const debugSampleBtn = event.target.closest('[data-rag-debug-sample]');
    if (debugSampleBtn) {
        const input = document.getElementById('rag-debug-query');
        if (input) {
            input.value = debugSampleBtn.dataset.ragDebugSample || '';
            input.focus();
        }
        return;
    }

    if (event.target.closest('#rag-debug-btn')) {
        window.Pivot.legacy.debugRagQuery();
        return;
    }

});

document.addEventListener('pointerdown', (event) => {
    startGraphMapPan(event);
});

document.addEventListener('pointermove', (event) => {
    moveGraphMapPan(event);
});

document.addEventListener('pointerup', (event) => {
    stopGraphMapPan(event);
});

document.addEventListener('pointercancel', (event) => {
    stopGraphMapPan(event);
});

document.addEventListener('wheel', (event) => {
    const map = event.target.closest?.('.rag-graph-map');
    if (!map || event.target.closest?.('.rag-graph-map-controls')) return;
    const view = getGraphMapView();
    hideGraphNodeTooltip();
    event.preventDefault();
    zoomGraphMap(view.scale + (event.deltaY > 0 ? -RAG_GRAPH_ZOOM_STEP : RAG_GRAPH_ZOOM_STEP), event.clientX, event.clientY);
}, { passive: false });

document.addEventListener('mouseover', (event) => {
    if (event.target.closest?.('#rag-graph-node-tooltip')) {
        cancelGraphNodeTooltipHideUi();
        return;
    }
    const node = event.target.closest?.('.rag-graph-map-node, .rag-graph-entity');
    if (node && !node.contains(event.relatedTarget)) {
        showGraphNodeTooltip(node, event);
        return;
    }
    const relation = event.target.closest?.('.rag-graph-relation');
    if (!relation || relation.contains(event.relatedTarget)) return;
    showGraphNodeTooltip(relation, event);
});

document.addEventListener('mousemove', (event) => {
    const node = event.target.closest?.('.rag-graph-map-node, .rag-graph-entity, .rag-graph-relation');
    if (!node) return;
    positionGraphNodeTooltip(event);
});

document.addEventListener('mouseout', (event) => {
    const node = event.target.closest?.('.rag-graph-map-node, .rag-graph-entity');
    if (node && !node.contains(event.relatedTarget)) {
        if (event.relatedTarget?.closest?.('#rag-graph-node-tooltip')) return;
        scheduleGraphNodeTooltipHideUi(300);
        return;
    }
    const relation = event.target.closest?.('.rag-graph-relation');
    if (!relation || relation.contains(event.relatedTarget)) return;
    if (event.relatedTarget?.closest?.('#rag-graph-node-tooltip')) return;
    scheduleGraphNodeTooltipHideUi(300);
});

document.addEventListener('focusin', (event) => {
    const node = event.target.closest?.('.rag-graph-map-node, .rag-graph-entity, .rag-graph-relation');
    if (!node) return;
    showGraphNodeTooltip(node, node.getBoundingClientRect());
});

document.addEventListener('focusout', (event) => {
    if (event.target.closest?.('.rag-graph-map-node, .rag-graph-entity, .rag-graph-relation')) hideGraphNodeTooltip();
});

document.addEventListener('change', async (event) => {
    if (event.target?.id === 'rag-select-all') {
        document.querySelectorAll('.rag-doc-check').forEach(input => { input.checked = event.target.checked; });
        window.Pivot.legacy.syncRagSelectAllState?.();
        return;
    }
    if (event.target?.id === 'rag-collection-filter') {
        if (typeof window.Pivot.legacy.handleRagCollectionScopeChange === 'function') {
            await window.Pivot.legacy.handleRagCollectionScopeChange('docs');
        } else {
            window.Pivot.legacy.loadKnowledgeDocs(1);
        }
        return;
    }
    if (event.target?.id === 'rag-tag-filter') {
        window.Pivot.legacy.loadKnowledgeDocs(1);
        return;
    }
    const enableToggle = event.target.closest?.('.rag-enable-toggle');
    if (enableToggle) {
        window.Pivot.legacy.toggleKnowledgeDocEnabled(enableToggle.dataset.ragId, enableToggle.checked);
        return;
    }
    if (event.target.closest?.('.rag-doc-check')) {
        window.Pivot.legacy.syncRagSelectAllState?.();
        return;
    }
    if (['rag-graph-type', 'rag-graph-quality'].includes(event.target?.id)) {
        refreshGraphSearch().catch(e => showToast(e.message || '图谱筛选失败', 'error'));
        return;
    }
    if (['rag-graph-relation-status', 'rag-graph-relation-type', 'rag-graph-min-confidence'].includes(event.target?.id)) {
        if (ragGraphState.selectedEntityId) {
            window.Pivot.legacy.selectKnowledgeGraphEntity(ragGraphState.selectedEntityId).catch(e => showToast(e.message || '关系筛选失败', 'error'));
        } else {
            loadGraphRelations().catch(e => showToast(e.message || '关系筛选失败', 'error'));
        }
    }
});

document.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && event.target?.id === 'rag-debug-query') {
        window.Pivot.legacy.debugRagQuery();
    }
    if (event.key === 'Enter' && event.target?.id === 'rag-graph-search') {
        refreshGraphSearch().catch(e => showToast(e.message || '实体搜索失败', 'error'));
    }
    if (event.key === 'Enter' && event.target?.id === 'rag-graph-query') {
        window.Pivot.legacy.debugKnowledgeGraphQuery().catch(e => showToast(e.message || '图谱查询失败', 'error'));
    }
    if (event.key === 'Enter' && event.target?.id === 'rag-graph-min-confidence') {
        if (ragGraphState.selectedEntityId) {
            window.Pivot.legacy.selectKnowledgeGraphEntity(ragGraphState.selectedEntityId).catch(e => showToast(e.message || '关系筛选失败', 'error'));
        } else {
            loadGraphRelations().catch(e => showToast(e.message || '关系筛选失败', 'error'));
        }
    }
});
