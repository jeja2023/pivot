
(function () {
    if (window.Pivot.legacy.PivotDataAnalysis?.state) return;
    const API = '/api/apps/data-analysis';
    const ACTIVE_TAB_STORAGE_KEY = 'pivot_data_analysis_active_tab';
    const VALID_TABS = new Set(['overview', 'cleaning', 'chart', 'compare', 'query', 'pivot', 'ai', 'history']);

    function normalizeTab(tab) {
        const normalized = String(tab || '').trim();
        return VALID_TABS.has(normalized) ? normalized : 'overview';
    }

    function getStoredActiveTab() {
        try {
            return normalizeTab(window.sessionStorage?.getItem(ACTIVE_TAB_STORAGE_KEY));
        } catch (_error) {
            return 'overview';
        }
    }

    function persistActiveTab(tab) {
        const normalized = normalizeTab(tab);
        try {
            window.sessionStorage?.setItem(ACTIVE_TAB_STORAGE_KEY, normalized);
        } catch (_error) {
            // sessionStorage 不可用时保留当前运行时页签即可。
        }
        return normalized;
    }

    function createVisualQuery() {
        return {
            logicalOperator: 'AND',
            filters: [
                { field: '', operator: 'eq', value: '' }
            ],
            sortField: '',
            sortOrder: 'ASC',
            limit: 100
        };
    }

    const state = {
        datasets: [],
        activeId: '',
        compareLeftId: '',
        compareRightId: '',
        chart: null,
        summary: null,
        compare: null,
        query: null,
        pivot: null,
        artifacts: [],
        cleaningQuality: null,
        cleaningRules: [],
        cleaningPreview: null,
        cleaningRuns: [],
        cleaningDatasetId: '',
        cleaningRunName: '',
        cleaningLoadVersion: 0,
        semanticDatasetId: '',
        semanticJobs: [],
        semanticJob: null,
        semanticSelectedJobId: '',
        semanticLoadVersion: 0,
        semanticPollTimer: null,
        overviewPage: 1,
        overviewPageSize: 10,
        queryPage: 1,
        queryPageSize: 10,
        previewDatasetId: '',
        previewPage: 1,
        previewPageSize: 25,
        historyPage: 1,
        historyPageSize: 10,
        aiBusy: false,
        aiAbortController: null,
        aiWorkspaceEpoch: 0,
        queryMode: 'visual',
        visualQuery: createVisualQuery()
    };

    const html = window.Pivot.legacy.PivotSafeHtml || {
        escapeHtml(value) {
            return String(value ?? '')
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#039;');
        },
        escapeAttr(value) {
            return this.escapeHtml(value);
        }
    };

    function esc(value) {
        return html.escapeHtml(value);
    }

    function fmtNumber(value) {
        const num = Number(value);
        if (!Number.isFinite(num)) return '-';
        return num.toLocaleString('zh-CN');
    }



    function activeDataset() {
        return state.datasets.find(item => item.id === state.activeId) || null;
    }

    window.Pivot.legacy.PivotDataAnalysis = {
        ...(window.Pivot.legacy.PivotDataAnalysis || {}),
        API,
        state,
        html,
        esc,
        fmtNumber,
        activeDataset,
        normalizeTab,
        getStoredActiveTab,
        persistActiveTab,
        createVisualQuery
    };
})();
