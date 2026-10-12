(function () {
    const ns = window.Pivot.legacy.PivotRegulationsInternal;
    if (!ns) throw new Error('法规库核心模块未加载');
    if (ns.actionsBatchEditReady) return;

    const { API, state, canManage, toast, fetchJson } = ns;
    let editDocuments = [];

    function syncBatchEditFields() {
        const form = document.getElementById('regulations-batch-edit-form');
        if (!form) return;
        const locked = state.busy || state.batchDeletePending;
        const toggles = Array.from(form.querySelectorAll('[data-regulation-batch-field]'));
        for (const toggle of toggles) {
            toggle.disabled = locked;
            const input = form.elements.namedItem(toggle.dataset.regulationBatchField);
            if (input) input.disabled = locked || !toggle.checked;
        }
        const submit = document.getElementById('regulations-batch-save-btn');
        if (submit) submit.disabled = locked || !toggles.some(toggle => toggle.checked);
        form.querySelectorAll('[data-regulations-close-batch-edit]').forEach(button => { button.disabled = locked; });
    }

    function openBatchEditDialog() {
        if (!canManage() || !state.batchMode || state.busy || state.batchDeletePending) return;
        editDocuments = ns.getSelectedDocuments();
        if (!editDocuments.length) {
            toast('请先勾选要修改的法规文档', 'warning');
            return;
        }
        const form = document.getElementById('regulations-batch-edit-form');
        form?.reset();
        syncBatchEditFields();
        const count = document.getElementById('regulations-batch-edit-count');
        if (count) count.textContent = `将修改选中的 ${editDocuments.length} 个文档`;
        document.getElementById('regulations-batch-edit-panel')?.classList.remove('hidden');
        ns.focusFirstField?.(form);
    }

    function closeBatchEditDialog() {
        if (state.busy) return;
        document.getElementById('regulations-batch-edit-panel')?.classList.add('hidden');
    }

    function applyUpdatedDocuments(updated) {
        const documentsById = new Map(updated.map(doc => [String(doc.id), doc]));
        state.documents = state.documents.map(doc => ({ ...doc, ...documentsById.get(String(doc.id)) }));
        const active = documentsById.get(String(state.activeId));
        if (active && state.detail?.document) {
            state.detail.document = { ...state.detail.document, ...active };
        }
        state.matches = state.matches.map(match => {
            const doc = documentsById.get(String(match.document_id));
            return doc ? { ...match, category: doc.category, issuing_body: doc.issuing_body, jurisdiction: doc.jurisdiction, status: doc.status } : match;
        });
        ns.renderDocuments?.();
        ns.renderDetail?.();
        ns.renderSearchResults?.();
    }

    async function saveBatchMetadata(form) {
        if (!canManage()) {
            toast('仅管理员可批量修改法规文档', 'error');
            return;
        }
        if (!state.batchMode || state.busy || state.batchDeletePending || !editDocuments.length) return;
        const patch = {};
        for (const toggle of form.querySelectorAll('[data-regulation-batch-field]:checked')) {
            const key = toggle.dataset.regulationBatchField;
            patch[key] = form.elements.namedItem(key)?.value.trim() || '';
        }
        if (!Object.keys(patch).length) {
            toast('请至少勾选一个要修改的字段', 'warning');
            return;
        }
        const selected = [...editDocuments];
        const titles = new Map(selected.map(doc => [String(doc.id), doc.title]));
        ns.setBusy(true, '正在批量修改法规信息…');
        try {
            let result;
            try {
                result = await fetchJson(`${API}/documents/batch-update`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ids: selected.map(doc => doc.id), patch })
                });
            } catch (error) {
                toast(error.message || '批量修改失败，请稍后重试', 'error');
                return;
            }
            const updated = Array.isArray(result.updated) ? result.updated : [];
            const failed = Array.isArray(result.failed) ? result.failed : [];
            for (const doc of updated) {
                state.selectedDocumentIds.delete(String(doc.id));
                state.selectedDocumentTitles.delete(String(doc.id));
            }
            applyUpdatedDocuments(updated);
            document.getElementById('regulations-batch-edit-panel')?.classList.add('hidden');
            toast(`已修改 ${updated.length} 个文档${failed.length ? `，${failed.length} 个失败` : ''}`, failed.length ? 'warning' : 'success');
            if (result.batchId) ns.showBatchUpdateResult?.(result, titles);
            else if (failed.length) ns.showBatchFailures(failed, titles, '修改');
            try {
                await ns.loadDocuments({ keepActive: true, page: state.page });
                await ns.loadFacets?.();
            } catch (_error) {
                toast('修改结果已保存，但列表刷新失败，请点击刷新重试', 'warning');
            }
        } finally {
            ns.setBusy(false);
        }
    }

    Object.assign(ns, { syncBatchEditFields, openBatchEditDialog, closeBatchEditDialog, saveBatchMetadata, actionsBatchEditReady: true });
})();
