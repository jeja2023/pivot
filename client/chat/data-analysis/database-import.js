
(function () {
    const app = window.PivotDataAnalysis;
    if (!app) throw new Error('PivotDataAnalysis context is not loaded');
    const { API, state, esc } = app;
    const fetchJson = (...args) => app.fetchJson(...args);
    const setBusy = (...args) => app.setBusy(...args);
    const toast = (...args) => app.toast(...args);
    const loadDatasets = (...args) => app.loadDatasets(...args);

    async function importFromDatabase() {
        let connections = [];
        try {
            const data = await fetchJson('/api/mcp/servers');
            connections = (Array.isArray(data.data) ? data.data : []).filter(item => item.server_type === 'database');
        } catch (_e) { /* 空处理 */ }
        if (!connections.length) {
            toast('没有可用的服务器可访问数据库，请先在「工具箱」中配置服务器可访问数据库', 'warning');
            return;
        }

        // 渲染连接下拉选项
        const connSelect = document.getElementById('data-analysis-db-conn');
        if (connSelect) {
            PivotSafeHtml.setHtml(connSelect, connections.map(item => `<option value="${esc(item.id)}">${esc(item.name)}</option>`).join(''));
        }

        // 重置/清除表单输入内容
        const sqlText = document.getElementById('data-analysis-db-sql');
        if (sqlText) sqlText.value = 'SELECT * FROM ';
        const tableNameInput = document.getElementById('data-analysis-db-table');
        if (tableNameInput) tableNameInput.value = '';
        const datasetNameInput = document.getElementById('data-analysis-db-name');
        if (datasetNameInput) datasetNameInput.value = '';

        // 显示自定义导入弹窗
        document.getElementById('data-analysis-db-import-modal')?.classList.remove('hidden');
    }

    // 提交数据库导入请求
    async function submitDatabaseImport() {
        const connSelect = document.getElementById('data-analysis-db-conn');
        const sqlText = document.getElementById('data-analysis-db-sql');
        const tableNameInput = document.getElementById('data-analysis-db-table');
        const datasetNameInput = document.getElementById('data-analysis-db-name');

        const mcpServerId = connSelect?.value;
        const sql = sqlText?.value || '';
        const table = tableNameInput?.value || '';
        const name = datasetNameInput?.value || '';

        if (!mcpServerId) {
            toast('请选择服务器可访问数据库', 'warning');
            return;
        }
        if (!sql.trim() && !table.trim()) {
            toast('请输入只读 SQL 查询或数据表名', 'warning');
            return;
        }

        // 默认命名规则：优先使用自定义名称 -> 表名 -> 连接原名
        const selectedConnText = connSelect.options[connSelect.selectedIndex]?.text || '';
        const finalName = name.trim() || table.trim() || selectedConnText;

        // 关闭导入弹窗并进入忙碌状态
        document.getElementById('data-analysis-db-import-modal')?.classList.add('hidden');
        setBusy(true, '正在从服务器可访问数据库导入...');
        try {
            const data = await fetchJson(`${API}/import-database`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    mcpServerId,
                    sql: sql.trim(),
                    table: table.trim(),
                    name: finalName.trim()
                })
            });
            state.activeId = data.dataset?.id || '';
            toast('服务器数据库数据已导入');
            await loadDatasets({ keepActive: true });
        } catch (e) {
            toast(e && e.message ? e.message : '服务器数据库导入失败', 'error');
        } finally {
            setBusy(false);
        }
    }

    Object.assign(app, {
        importFromDatabase,
        submitDatabaseImport
    });
})();
