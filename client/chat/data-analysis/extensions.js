(function () {
    const app = window.Pivot.legacy.PivotDataAnalysis;
    if (!app) throw new Error('数据分析上下文模块未加载');

    function onDataAnalysisTabActivated(tab) {
        if (tab === 'governance') {
            if (app.state.governanceDatasetId) {
                app.loadGovernance?.(app.state.governanceDatasetId, { silent: true });
                app.loadScalability?.(app.state.governanceDatasetId, { silent: true });
            } else {
                app.renderGovernance?.();
                app.loadScalability?.('', { silent: true });
            }
            app.loadSemanticModels?.({ silent: true });
        }
        if (tab === 'assets') {
            if (app.state.assetsDatasetId) {
                app.loadAssets?.(app.state.assetsDatasetId, { silent: true });
            } else {
                app.renderGovernance?.();
            }
        }
        if (tab === 'dashboards') app.loadDashboards?.({ keepActive: true, silent: true });
        if (tab === 'query') app.loadAsyncQueryJobs?.({ silent: true });
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
