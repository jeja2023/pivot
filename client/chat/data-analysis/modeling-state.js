(function () {
    'use strict';
    const app = window.Pivot.legacy.PivotDataAnalysis;
    const state = {
        models: [],
        selected: null,
        draft: null,
        flowGraph: { nodes: [], edges: [] },
        dirty: false,
        saveState: 'saved',
        section: 'tables',
        drawerOpen: false,
        drawerMode: 'node',
        selectedNodeId: '',
        selectedRelationId: '',
        selectedFlowEdgeId: '',
        paletteCollapsed: Boolean(window.matchMedia?.('(max-width: 760px)')?.matches),
        paletteTab: 'datasets',
        datasetSearch: '',
        fieldSearch: '',
        fnCategory: 'all',
        previewOpen: false,
        previewLoading: false,
        previewNodeId: '',
        previewData: null,
        previewError: '',
        schemaCache: Object.create(null),
        epoch: 0,
        requests: new Map(),
        listPage: 1,
        listTotal: 0,
        listLoading: false,
        listError: '',
        dataRevision: 0,
        previewStale: false,
        nodeJob: null,
        nodeJobs: [],
        nodeTaskRevision: -1,
        nodeSubmitting: false,
        nodeHistoryOpen: false,
        nodeRequests: new Map(),
        search: '',
        ownership: 'all',
        lifecycle: 'all',
        availability: 'all',
        check: null,
        run: null,
        versions: [],
        dependencies: null,
        busy: false,
        pollTimer: null,
        canvasLayout: Object.create(null),
        queryMode: 'trial',
        analysisDefinition: null,
        analysisVersion: null,
        resultPage: null
    };
    const owner = () => String(window.Pivot.legacy.currentUser?.id || '');
    let account = owner();
    function stopPolling() { clearTimeout(state.pollTimer); state.pollTimer = null; }
    function reset() {
        stopPolling();
        app.modeling.clearCanvas?.();
        app.modeling.closeDialog?.();
        state.epoch++;
        state.selected = null;
        state.draft = null;
        state.flowGraph = { nodes: [], edges: [] };
        state.canvasLayout = Object.create(null);
        state.dirty = false;
        state.drawerOpen = false;
        state.drawerMode = 'node';
        state.selectedNodeId = '';
        state.selectedRelationId = '';
        state.selectedFlowEdgeId = '';
        state.datasetSearch = '';
        state.fieldSearch = '';
        state.fnCategory = 'all';
        state.previewOpen = false;
        state.previewLoading = false;
        state.previewNodeId = '';
        state.previewData = null;
        state.previewError = '';
        state.dataRevision++;
        state.previewStale = false;
        state.nodeJob = null;
        state.nodeJobs = [];
        state.nodeTaskRevision = -1;
        state.nodeSubmitting = false;
        state.nodeHistoryOpen = false;
        state.nodeRequests.clear();
        state.schemaCache = Object.create(null);
        state.check = null;
        state.run = null;
        state.versions = [];
        state.dependencies = null;
        state.requests.clear();
        state.analysisDefinition = null;
        state.analysisVersion = null;
        state.queryMode = 'trial';
        state.resultPage = null;
    }
    function capture(scope) {
        if (account !== owner()) { reset(); state.models = []; account = owner(); }
        const sequence = (state.requests.get(scope) || 0) + 1;
        state.requests.set(scope, sequence);
        const epoch = state.epoch, userId = owner(), modelId = state.selected?.id || '';
        return () => state.requests.get(scope) === sequence && state.epoch === epoch && owner() === userId && (state.selected?.id || '') === modelId;
    }
    function changed() {
        state.dataRevision++;
        state.previewStale = Boolean(state.previewData);
        state.previewLoading = false;
        state.schemaCache = Object.create(null);
        state.dirty = true;
        state.saveState = 'unsaved';
        state.check = null;
        state.run = null;
        app.modeling.renderSaveState?.();
        app.modeling.renderPreviewState?.();
    }
    async function canLeave() {
        if (!state.dirty) return true;
        return Boolean(await window.Pivot.legacy.showConfirm?.('模型草稿尚未保存', '离开将放弃本次未保存的修改。请选择取消返回保存，或确认放弃修改。'));
    }
    window.addEventListener('beforeunload', event => { if (state.dirty) { event.preventDefault(); event.returnValue = ''; } });
    document.addEventListener('click', event => {
        const target = event.target.closest?.('#apps-back-btn,#apps-modal-close');
        if (!target || !state.dirty || document.getElementById('data-analysis-view')?.classList.contains('hidden')) return;
        event.preventDefault(); event.stopImmediatePropagation();
        void canLeave().then(leave => { if (leave) { reset(); target.click(); } });
    }, true);
    const request = (path, options) => app.fetchJson(`${app.API}${path}`, options);
    const json = (body, method = 'POST') => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    app.modeling = {
        state,
        owner,
        capture,
        changed,
        reset,
        stopPolling,
        canLeave,
        request,
        json,
        clone: value => JSON.parse(JSON.stringify(value)),
        key: () => window.crypto.randomUUID(),
        table: (headers, rows, empty = '暂无内容') => {
            const headerHtml = headers.map((value, idx) => {
                const isIndex = idx === 0 && (value === '序号' || value === '#');
                const isAction = value === '操作';
                const cls = [isIndex ? 'text-center col-index' : '', isAction ? 'text-center col-actions' : ''].filter(Boolean).join(' ');
                return `<th${cls ? ` class="${cls}"` : ''}>${app.esc(value)}</th>`;
            }).join('');
            return `<div class="table-container"><table class="data-table compact-table"><thead><tr>${headerHtml}</tr></thead><tbody>${rows.length ? rows.join('') : `<tr><td colspan="${headers.length}">${app.esc(empty)}</td></tr>`}</tbody></table></div>`;
        }
    };
    app.hasUnsavedModelingChanges = () => state.dirty;
    app.confirmLeaveModeling = canLeave;
})();
