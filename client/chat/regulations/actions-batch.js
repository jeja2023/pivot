(function () {
    const ns = window.Pivot.legacy.PivotRegulationsInternal;
    if (!ns) throw new Error('法规库核心模块未加载');
    if (ns.actionsBatchReady) return;

    const { API, state, esc, canManage, canDeleteDocuments, toast, fetchJson, regulationConfirm } = ns;

    function getSelectedDocuments() {
        return [...state.selectedDocumentIds].map(id => {
            const visible = state.documents.find(doc => String(doc.id) === id);
            return visible || { id: Number(id), title: state.selectedDocumentTitles.get(id) || `文档 ${id}` };
        });
    }

    function toggleBatchMode() {
        if (!canManage() || state.busy || state.batchDeletePending) return;
        state.batchMode = !state.batchMode;
        state.selectedDocumentIds.clear();
        state.selectedDocumentTitles.clear();
        ns.closeBatchEditDialog?.();
        ns.renderDocuments?.();
    }

    function syncDocumentSelection() {
        const ids = state.documents.map(doc => String(doc.id));
        const selectedCount = state.selectedDocumentIds.size;
        const selectedVisibleCount = ids.filter(id => state.selectedDocumentIds.has(id)).length;
        const enabled = canManage() && state.batchMode;
        const locked = state.busy || state.batchDeletePending || !enabled;
        const modeButton = document.getElementById('regulations-batch-mode-btn');
        if (modeButton) {
            modeButton.textContent = enabled ? '退出批量处理' : '批量处理';
            modeButton.setAttribute('aria-pressed', String(enabled));
            modeButton.disabled = state.busy || state.batchDeletePending;
        }
        document.getElementById('regulations-batch-actions')?.classList.toggle('hidden', !enabled);
        document.getElementById('regulations-select-column')?.classList.toggle('hidden', !enabled);
        const selectAll = document.getElementById('regulations-select-all');
        if (selectAll) {
            selectAll.checked = ids.length > 0 && selectedVisibleCount === ids.length;
            selectAll.indeterminate = selectedVisibleCount > 0 && selectedVisibleCount !== ids.length;
            selectAll.disabled = locked || !ids.length;
        }
        document.querySelectorAll('[data-regulation-select]').forEach(input => {
            input.checked = state.selectedDocumentIds.has(input.dataset.regulationSelect);
            input.disabled = locked;
        });
        const count = document.getElementById('regulations-selected-count');
        if (count) count.textContent = `已选 ${selectedCount} 项${selectedCount > selectedVisibleCount ? `（当前页 ${selectedVisibleCount} 项）` : ''}`;
        const deleteButton = document.getElementById('regulations-batch-delete-btn');
        if (deleteButton) deleteButton.disabled = locked || !selectedCount;
        const clearButton = document.getElementById('regulations-clear-selection-btn');
        if (clearButton) clearButton.disabled = locked || !selectedCount;
        const editButton = document.getElementById('regulations-batch-edit-btn');
        if (editButton) editButton.disabled = locked || !selectedCount;
        const folderSelectButton = document.getElementById('regulations-select-folder-btn');
        if (folderSelectButton) {
            const folderTitle = state.activeFolder?.title;
            folderSelectButton.textContent = folderTitle ? `全选“${folderTitle}”` : '全选全部法规';
            folderSelectButton.disabled = locked;
        }
        const scopeReindexButton = document.getElementById('regulations-reindex-scope-btn');
        if (scopeReindexButton) {
            const folderTitle = state.activeFolder?.title;
            scopeReindexButton.textContent = folderTitle ? `重建“${folderTitle}”向量` : '重建全库向量';
            scopeReindexButton.disabled = locked;
        }
        ns.syncBatchEditFields?.();
    }

    function selectDocument(id, checked) {
        if (!canManage() || !state.batchMode || state.busy || state.batchDeletePending) return;
        const key = String(id);
        const document = state.documents.find(doc => String(doc.id) === key);
        if (!document) return;
        if (checked) {
            state.selectedDocumentIds.add(key);
            state.selectedDocumentTitles.set(key, document.title || `文档 ${key}`);
        } else {
            state.selectedDocumentIds.delete(key);
            state.selectedDocumentTitles.delete(key);
        }
        syncDocumentSelection();
    }

    function selectAllDocuments(checked) {
        if (!canManage() || !state.batchMode || state.busy || state.batchDeletePending) return;
        state.documents.forEach(doc => {
            const key = String(doc.id);
            if (checked) {
                state.selectedDocumentIds.add(key);
                state.selectedDocumentTitles.set(key, doc.title || `文档 ${key}`);
            } else {
                state.selectedDocumentIds.delete(key);
                state.selectedDocumentTitles.delete(key);
            }
        });
        syncDocumentSelection();
    }

    function clearDocumentSelection() {
        if (!canManage() || !state.batchMode || state.busy || state.batchDeletePending) return;
        state.selectedDocumentIds.clear();
        state.selectedDocumentTitles.clear();
        syncDocumentSelection();
    }

    async function selectAllFolderDocuments() {
        if (!canManage() || !state.batchMode || state.busy || state.batchDeletePending) return;
        const params = new URLSearchParams({ limit: '2000' });
        if (state.activeFolder?.isUncategorized) params.set('uncategorized', 'true');
        else if (state.activeFolder?.category) params.set('category', state.activeFolder.category);
        try {
            const result = await fetchJson(`${API}/documents/folder-selection?${params.toString()}`);
            if (result.truncated) {
                toast('当前范围超过 2,000 份法规，请先缩小分类范围后再批量处理', 'warning');
                return;
            }
            state.selectedDocumentIds.clear();
            state.selectedDocumentTitles.clear();
            (Array.isArray(result.data) ? result.data : []).forEach(document => {
                const id = String(document.id);
                state.selectedDocumentIds.add(id);
                state.selectedDocumentTitles.set(id, document.title || `文档 ${id}`);
            });
            syncDocumentSelection();
            toast(`已选择当前范围的 ${state.selectedDocumentIds.size} 份法规`, 'success');
        } catch (error) {
            toast(error.message || '全选当前范围失败', 'error');
        }
    }

    async function reindexCurrentScope() {
        if (!canManage() || !state.batchMode || state.busy || state.batchDeletePending) return;
        const folder = state.activeFolder;
        const scopeLabel = folder?.title ? `“${folder.title}”分类` : '全库当前法规';
        const confirmation = `将清空${scopeLabel}当前版本的旧向量，并在后台使用系统统一模型重新建立索引。期间关键词检索保持可用；服务重启后任务会继续。确认重建？`;
        if (!(await regulationConfirm('批量重建向量索引', confirmation))) return;
        ns.setBusy(true, '正在将法规加入向量重建队列…');
        try {
            const body = folder?.isUncategorized
                ? { uncategorized: true }
                : (folder?.category ? { category: folder.category } : {});
            const response = await fetchJson(`${API}/documents/reindex`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            const result = response?.result || {};
            toast(`已排队 ${Number(result.queuedVersions || 0)} 个当前版本，已清空 ${Number(result.clearedArticles || 0)} 条旧向量；可继续使用关键词检索`, 'success');
            await ns.loadDocuments?.({ keepActive: true, page: state.page });
        } catch (error) {
            toast(error.message || '批量重建向量索引失败', 'error');
        } finally {
            ns.setBusy(false);
        }
    }

    function showBatchFailures(failed, titles, action = '删除') {
        const body = document.getElementById('regulations-batch-result-body');
        if (!body) return;
        const title = document.getElementById('regulations-batch-result-title');
        if (title) title.textContent = `批量${action}结果`;
        PivotSafeHtml.setHtml(body, `
            <p>以下 ${failed.length} 个文档未能${esc(action)}，请查看原因后重试。</p>
            <div class="table-container workspace-table-wrap">
                <table class="data-table compact-table">
                    <thead><tr><th>文档</th><th>失败原因</th></tr></thead>
                    <tbody>${failed.map(item => `<tr><td>${esc(titles.get(String(item.documentId)) || `文档 ${item.documentId}`)}</td><td>${esc(item.message || '删除失败，请稍后重试')}</td></tr>`).join('')}</tbody>
                </table>
            </div>`);
        document.getElementById('regulations-batch-result-panel')?.classList.remove('hidden');
    }

    function showBatchUpdateResult(result, titles) {
        if (!result?.batchId) return;
        const body = document.getElementById('regulations-batch-result-body');
        if (!body) return;
        const failed = Array.isArray(result.failed) ? result.failed : [];
        const title = document.getElementById('regulations-batch-result-title');
        if (title) title.textContent = '批量修改结果';
        PivotSafeHtml.setHtml(body, `
            <p>已保存 ${Number(result.updated?.length || 0)} 项法规信息。撤销会逐条校验此后是否又被修改，不会覆盖较新的内容。</p>
            <div class="regulations-admin-actions"><button class="btn-secondary" type="button" data-regulation-batch-revert="${esc(result.batchId)}">撤销本次修改</button></div>
            ${failed.length ? `<div class="table-container workspace-table-wrap"><table class="data-table compact-table"><thead><tr><th>文档</th><th>未修改原因</th></tr></thead><tbody>${failed.map(item => `<tr><td>${esc(titles.get(String(item.documentId)) || `文档 ${item.documentId}`)}</td><td>${esc(item.message || '修改失败，请稍后重试')}</td></tr>`).join('')}</tbody></table></div>` : ''}
        `);
        document.getElementById('regulations-batch-result-panel')?.classList.remove('hidden');
    }

    async function revertRegulationBatch(batchId) {
        if (!batchId || !canManage() || state.busy || state.batchDeletePending) return;
        if (!(await regulationConfirm('撤销批量修改', '将撤销本次批量修改中尚未被后续编辑的法规信息。确认继续？'))) return;
        ns.setBusy(true, '正在撤销批量修改…');
        try {
            const result = await fetchJson(`${API}/documents/batch-revert`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ batchId })
            });
            const reverted = Array.isArray(result.reverted) ? result.reverted : [];
            const failed = Array.isArray(result.failed) ? result.failed : [];
            const byId = new Map(reverted.map(document => [String(document.id), document]));
            state.documents = state.documents.map(document => ({ ...document, ...byId.get(String(document.id)) }));
            state.matches = state.matches.map(match => {
                const document = byId.get(String(match.document_id));
                return document ? { ...match, category: document.category, issuing_body: document.issuing_body, jurisdiction: document.jurisdiction, status: document.status } : match;
            });
            ns.renderDocuments?.();
            ns.renderSearchResults?.();
            document.getElementById('regulations-batch-result-panel')?.classList.add('hidden');
            toast(`已撤销 ${reverted.length} 项${failed.length ? `，${failed.length} 项因后续修改未撤销` : ''}`, failed.length ? 'warning' : 'success');
            await ns.loadDocuments({ keepActive: true, page: state.page });
            await ns.loadFacets?.();
        } catch (error) {
            toast(error.message || '撤销批量修改失败', 'error');
        } finally {
            ns.setBusy(false);
        }
    }

    async function deleteSelectedDocuments() {
        if (!canDeleteDocuments()) {
            toast('仅 admin 权限层级可删除法规文档', 'error');
            return;
        }
        if (!state.batchMode || state.busy || state.batchDeletePending) return;
        const selected = getSelectedDocuments();
        if (!selected.length) {
            toast('请先勾选要删除的法规文档', 'warning');
            return;
        }
        const titles = new Map(selected.map(doc => [String(doc.id), doc.title]));
        let ownsBusyState = false;
        state.batchDeletePending = true;
        syncDocumentSelection();
        try {
            if (!(await regulationConfirm('批量删除法规文档', `确定删除选中的 ${selected.length} 个法规文档吗？删除后将从法规列表和检索结果中移除。`))) return;
            if (state.busy) return;
            ns.setBusy(true, '正在批量删除法规文档…');
            ownsBusyState = true;
            let result;
            try {
                result = await fetchJson(`${API}/documents/batch-delete`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ids: selected.map(doc => doc.id) })
                });
            } catch (error) {
                toast(error.message || '批量删除失败，请稍后重试', 'error');
                return;
            }
            const deleted = new Set((result.deleted || []).map(String));
            const failed = Array.isArray(result.failed) ? result.failed : [];
            deleted.forEach(id => {
                state.selectedDocumentIds.delete(id);
                state.selectedDocumentTitles.delete(id);
            });
            state.matches = state.matches.filter(match => !deleted.has(String(match.document_id)));
            ns.renderSearchResults?.();
            if (deleted.has(String(state.activeId))) {
                state.activeId = '';
                state.detail = null;
                document.getElementById('regulations-detail-panel')?.classList.add('hidden');
            }
            toast(`已删除 ${deleted.size} 个文档${failed.length ? `，${failed.length} 个失败` : ''}`, failed.length ? 'warning' : 'success');
            if (failed.length) showBatchFailures(failed, titles);
            try {
                await ns.loadDocuments({ keepActive: true, page: state.page });
            } catch (_error) {
                state.documents = state.documents.filter(doc => !deleted.has(String(doc.id)));
                state.total = Math.max(state.total - deleted.size, 0);
                ns.renderDocuments?.();
                ns.renderDetail?.();
                toast('删除结果已保存，但列表刷新失败，请点击刷新重试', 'warning');
            }
        } finally {
            if (ownsBusyState) ns.setBusy(false);
            state.batchDeletePending = false;
            syncDocumentSelection();
        }
    }

    Object.assign(ns, {
        syncDocumentSelection,
        toggleBatchMode,
        getSelectedDocuments,
        showBatchFailures,
        showBatchUpdateResult,
        selectDocument,
        selectAllDocuments,
        selectAllFolderDocuments,
        reindexCurrentScope,
        clearDocumentSelection,
        deleteSelectedDocuments,
        revertRegulationBatch,
        actionsBatchReady: true
    });
})();
