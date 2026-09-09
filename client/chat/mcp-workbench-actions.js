/* 工具库工作区稳定事件委托 */

(function installMcpWorkbenchActions() {
    function workbenchApi() {
        return window.Pivot?.moduleApi?.('mcp.workbench', {}) || {};
    }

    function bindMcpWorkbenchActions() {
        const root = document.getElementById('mcp-workbench-modal');
        if (!root || root.dataset.boundMcpWorkbenchActions === '1') return;
        root.dataset.boundMcpWorkbenchActions = '1';
        root.addEventListener('click', async event => {
            const button = event.target.closest('button, [role="button"]');
            if (!button || !root.contains(button) || button.disabled || button.getAttribute('aria-disabled') === 'true') return;

            const localAuthType = button.dataset.mcpOpenLocalAuth;
            if (localAuthType !== undefined) {
                event.preventDefault();
                const localAuth = window.Pivot?.moduleApi?.('mcp.localAuth', {}) || {};
                const open = localAuth.openMcpLocalAuthorizationCenter || window.Pivot.legacy.openMcpLocalAuthorizationCenter;
                if (typeof open === 'function') return await open(localAuthType || 'local_database');
                return showToast('本机授权中心尚未加载完成，请刷新工具库后重试。', 'error');
            }

            if (button.id === 'mcp-refresh-btn') {
                event.preventDefault();
                return await workbenchApi().refreshMcpWorkbench?.(button);
            }
            if (button.id === 'mcp-health-check-btn') {
                event.preventDefault();
                const check = workbenchApi().runMcpBatchHealthCheck || window.Pivot.legacy.runMcpBatchHealthCheck;
                if (typeof check === 'function') return await check(button);
                return showToast('连通性自检尚未加载完成，请刷新工具库后重试。', 'error');
            }
            if (button.hasAttribute('data-mcp-retry-governance')) {
                event.preventDefault();
                return await workbenchApi().loadMcpGovernance?.();
            }
            if (button.hasAttribute('data-mcp-open-data-analysis')) {
                event.preventDefault();
                return await workbenchApi().openMcpDataAnalysisImport?.({
                    datasetId: button.dataset.mcpOpenDataAnalysisDataset || '',
                    tab: button.dataset.mcpOpenDataAnalysisTab || button.dataset.mcpOpenDataAnalysis || 'overview'
                });
            }
            if (button.dataset.mcpCreate !== undefined) {
                event.preventDefault();
                return window.Pivot.legacy.openMcpCreateModal?.(button.dataset.mcpCreate);
            }
            if (button.dataset.mcpSystemConfig !== undefined) {
                event.preventDefault();
                return window.Pivot.legacy.openMcpSystemConfig?.(button.dataset.mcpSystemConfig);
            }
            if (button.dataset.mcpSystemEnable !== undefined) {
                event.preventDefault();
                return await window.Pivot.legacy.ensureMcpSystemService?.(button.dataset.mcpSystemEnable, button);
            }
            if (button.dataset.mcpEdit !== undefined) {
                event.preventDefault();
                return window.Pivot.legacy.openMcpEditModal?.(button.dataset.mcpEdit);
            }
            if (button.dataset.mcpTools !== undefined) {
                event.preventDefault();
                return await window.Pivot.legacy.openMcpToolsModal?.(button.dataset.mcpTools);
            }
            if (button.dataset.mcpShare !== undefined) {
                event.preventDefault();
                return workbenchApi().openMcpShareModal?.(button.dataset.mcpShare);
            }
            if (button.dataset.mcpToggle !== undefined) {
                event.preventDefault();
                return await window.Pivot.legacy.toggleMcpServerStatus?.(button.dataset.mcpToggle, button.dataset.nextStatus, button);
            }
            if (button.dataset.mcpDelete !== undefined) {
                event.preventDefault();
                return window.Pivot.legacy.deleteMcpServer?.(button.dataset.mcpDelete, button);
            }
            if (button.hasAttribute('data-mcp-open-tool-policy')) {
                event.preventDefault();
                await window.Pivot.moduleApi('workspaces.navigation').openAdminPanel?.({ restore: false });
                return await window.Pivot.legacy.switchTab?.('tool-policy');
            }
        });
    }

    window.Pivot?.exposeModule?.('mcp.actions', { bindMcpWorkbenchActions });
}());
