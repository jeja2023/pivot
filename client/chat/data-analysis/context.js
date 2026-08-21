
(function () {
    if (window.PivotDataAnalysis?.state) return;
    const API = '/api/apps/data-analysis';
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
        semanticJobs: [],
        semanticJob: null,
        semanticPollTimer: null,
        overviewPage: 1,
        overviewPageSize: 10,
        aiBusy: false,
        aiWorkspaceEpoch: 0,
        queryMode: 'visual',
        visualQuery: {
            logicalOperator: 'AND',
            filters: [
                { field: '', operator: 'eq', value: '' }
            ],
            sortField: '',
            sortOrder: 'ASC',
            limit: 100
        }
    };

    const html = window.PivotSafeHtml || {
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

    window.PivotDataAnalysis = {
        ...(window.PivotDataAnalysis || {}),
        API,
        state,
        html,
        esc,
        fmtNumber,
        activeDataset
    };
})();
