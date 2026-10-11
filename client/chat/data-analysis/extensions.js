(function () {
    const app = window.Pivot.legacy.PivotDataAnalysis;
    if (!app) throw new Error('数据分析上下文模块未加载');

    function onDataAnalysisTabActivated(tab) {
        if (['governance', 'assets'].includes(tab)) {
            app.loadGovernance?.(app.state.governanceDatasetId || app.state.activeId, { silent: true });
            app.loadSemanticModels?.({ silent: true });
        }
        if (tab === 'dashboards') app.loadDashboards?.({ keepActive: true, silent: true });
        if (tab === 'query') app.loadAsyncQueryJobs?.({ silent: true });
        if (tab === 'governance') app.loadScalability?.(app.state.governanceDatasetId || app.state.activeId, { silent: true });
    }

    function bindDataAnalysisExtensionEvents(root) {
        app.bindGovernanceEvents?.(root);
        app.bindSemanticModelEvents?.(root);
        app.bindAsyncQueryEvents?.(root);
        app.bindDashboardEvents?.(root);
        app.bindScalabilityEvents?.(root);
    }

    Object.assign(app, { onDataAnalysisTabActivated, bindDataAnalysisExtensionEvents });
})();
