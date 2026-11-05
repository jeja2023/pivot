(function () {
    const app = window.Pivot.legacy.PivotDataAnalysis;
    if (!app) throw new Error('数据分析上下文模块未加载');
    const { API, state, esc } = app;
    const fetchJson = (...args) => app.fetchJson(...args), toast = (...args) => app.toast(...args);
    const setBusy = (...args) => app.setBusy(...args), loadDatasets = (...args) => app.loadDatasets(...args);

    function openEditDatasetModal(datasetId) {
        const dataset = state.datasets.find(item => item.id === datasetId);
        if (!dataset) return;
        const modal = document.getElementById('data-analysis-edit-dataset-modal');
        const idInput = document.getElementById('data-analysis-edit-dataset-id');
        const nameInput = document.getElementById('data-analysis-edit-dataset-name');
        const origInput = document.getElementById('data-analysis-edit-dataset-original-name');
        const metaEl = document.getElementById('data-analysis-edit-dataset-meta');
        if (!modal || !idInput || !nameInput || !origInput) return;
        idInput.value = dataset.id || '';
        nameInput.value = dataset.name || '';
        origInput.value = dataset.originalName || '';
        if (metaEl) {
            const fileTypeLabel = dataset.fileType === 'cleaned' ? '清洗后数据' : (dataset.fileType || '表格');
            const rowCount = Number(dataset.rowCount || 0).toLocaleString();
            const colCount = Number(dataset.columnCount || 0).toLocaleString();
            if (window.Pivot.legacy.PivotSafeHtml?.setHtml) {
                window.Pivot.legacy.PivotSafeHtml.setHtml(metaEl, `<div><strong>数据规模：</strong>${rowCount} 行 / ${colCount} 列</div><div><strong>文件类型：</strong>${esc(fileTypeLabel)}</div><div><strong>创建时间：</strong>${esc(dataset.createdAt || '-')}</div>`);
            } else {
                metaEl.textContent = `规模: ${rowCount} 行 / ${colCount} 列 | 类型: ${fileTypeLabel} | 创建: ${dataset.createdAt || '-'}`;
            }
        }
        modal.classList.remove('hidden');
        nameInput.focus();
    }

    function closeEditDatasetModal() {
        document.getElementById('data-analysis-edit-dataset-modal')?.classList.add('hidden');
    }

    async function submitEditDataset() {
        const datasetId = document.getElementById('data-analysis-edit-dataset-id')?.value?.trim();
        const nameInput = document.getElementById('data-analysis-edit-dataset-name');
        const name = nameInput?.value?.trim();
        const originalName = document.getElementById('data-analysis-edit-dataset-original-name')?.value?.trim() ?? '';
        if (!datasetId) return;
        if (!name) {
            toast('请输入数据集名称', 'warning');
            nameInput?.focus();
            return;
        }
        const saveBtn = document.getElementById('data-analysis-edit-dataset-save');
        if (saveBtn) saveBtn.disabled = true;
        setBusy(true, '正在保存修改...');
        try {
            await fetchJson(`${API}/datasets/${encodeURIComponent(datasetId)}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, originalName })
            });
            toast('数据集信息已更新', 'success');
            closeEditDatasetModal();
            await loadDatasets({ keepActive: true });
        } catch (e) {
            toast(e && e.message ? e.message : '保存失败', 'error');
        } finally {
            if (saveBtn) saveBtn.disabled = false;
            setBusy(false);
        }
    }

    app.datasetEditor = { open: openEditDatasetModal, close: closeEditDatasetModal, submit: submitEditDataset };
})();
