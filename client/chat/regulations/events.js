(function () {
    const ns = window.Pivot.legacy.PivotRegulationsInternal;
    if (!ns) throw new Error('法规库核心模块未加载');
    if (ns.eventsReady) return;

    const { state, PRESETS, canDeleteDocuments, toast } = ns;

    const uploadDocument = (...args) => ns.uploadDocument?.(...args);
    const saveMetadata = (...args) => ns.saveMetadata?.(...args);
    const uploadVersion = (...args) => ns.uploadVersion?.(...args);
    const runCompare = (...args) => ns.runCompare?.(...args);
    const submitAnnotation = (...args) => ns.submitAnnotation?.(...args);
    const closeDialogs = (...args) => ns.closeDialogs?.(...args);
    const runSearch = (...args) => ns.runSearch?.(...args);
    const syncFileInputState = (...args) => ns.syncFileInputState?.(...args);
    const syncImportHint = (...args) => ns.syncImportHint?.(...args);
    const loadDetail = (...args) => ns.loadDetail?.(...args);
    const openSearchDialog = (...args) => ns.openSearchDialog?.(...args);
    const saveCurrentSearch = (...args) => ns.saveCurrentSearch?.(...args);
    const applySavedSearch = (...args) => ns.applySavedSearch?.(...args);
    const deleteSavedSearch = (...args) => ns.deleteSavedSearch?.(...args);
    const loadDocuments = (...args) => ns.loadDocuments?.(...args);
    const openAiDialog = (...args) => ns.openAiDialog?.(...args);
    const closeSearchDialog = (...args) => ns.closeSearchDialog?.(...args);
    const focusFirstField = (...args) => ns.focusFirstField?.(...args);
    const closeInlineForms = (...args) => ns.closeInlineForms?.(...args);
    const archiveDocument = (...args) => ns.archiveDocument?.(...args);
    const deleteSelectedDocuments = (...args) => ns.deleteSelectedDocuments?.(...args);
    const focusArticle = (...args) => ns.focusArticle?.(...args);
    const showSimilarArticles = (...args) => ns.showSimilarArticles?.(...args);
    const stripMarkdownFormatting = (...args) => ns.stripMarkdownFormatting?.(...args);
    const showCitationGraph = (...args) => ns.showCitationGraph?.(...args);
    const showVersionTimeline = (...args) => ns.showVersionTimeline?.(...args);
    const previewRegulationImport = (...args) => ns.previewRegulationImport?.(...args);
    const mergePreviewArticles = (...args) => ns.mergePreviewArticles?.(...args);
    const confirmPreviewImport = (...args) => ns.confirmPreviewImport?.(...args);
    const exportRegulationReport = (...args) => ns.exportRegulationReport?.(...args);
    const showAnnotations = (...args) => ns.showAnnotations?.(...args);
    const showAccessLogs = (...args) => ns.showAccessLogs?.(...args);
    const showRegulationAiLogs = (...args) => ns.showRegulationAiLogs?.(...args);
    const showArticleLocations = (...args) => ns.showArticleLocations?.(...args);
    const showQualitySummary = (...args) => ns.showQualitySummary?.(...args);
    const openGovernanceWorklist = (...args) => ns.openGovernanceWorklist?.(...args);
    const openDocumentGovernance = (...args) => ns.openDocumentGovernance?.(...args);
    const openVersionGovernance = (...args) => ns.openVersionGovernance?.(...args);
    const requestRegulationLocationRebuild = (...args) => ns.requestRegulationLocationRebuild?.(...args);
    const showCitationGovernance = (...args) => ns.showCitationGovernance?.(...args);
    const rebuildCitationLinks = (...args) => ns.rebuildCitationLinks?.(...args);
    const reviewCitationLinks = (...args) => ns.reviewCitationLinks?.(...args);
    const approveHighConfidenceCitationLinks = (...args) => ns.approveHighConfidenceCitationLinks?.(...args);
    const toggleRegulationSubscription = (...args) => ns.toggleRegulationSubscription?.(...args);
    const toggleRegulationBookmark = (...args) => ns.toggleRegulationBookmark?.(...args);
    const showRegulationBookmarks = (...args) => ns.showRegulationBookmarks?.(...args);
    const handleBookmarkTopicFilter = (...args) => ns.handleBookmarkTopicFilter?.(...args);
    const handleBookmarkSearch = (...args) => ns.handleBookmarkSearch?.(...args);
    const saveRegulationBookmarkTopic = (...args) => ns.saveRegulationBookmarkTopic?.(...args);
    const deleteRegulationBookmark = (...args) => ns.deleteRegulationBookmark?.(...args);
    const showRegulationRecycleBin = (...args) => ns.showRegulationRecycleBin?.(...args);
    const restoreRegulationFromRecycleBin = (...args) => ns.restoreRegulationFromRecycleBin?.(...args);
    const requestRegulationReindex = (...args) => ns.requestRegulationReindex?.(...args);
    const showRegulationObligations = (...args) => ns.showRegulationObligations?.(...args);
    const reviewRegulationObligation = (...args) => ns.reviewRegulationObligation?.(...args);
    const submitRegulationObligation = (...args) => ns.submitRegulationObligation?.(...args);
    const deleteAnnotation = (...args) => ns.deleteAnnotation?.(...args);
    const showCompareDialog = (...args) => ns.showCompareDialog?.(...args);
    const runChangeImpact = (...args) => ns.runChangeImpact?.(...args);
    const askAi = (...args) => ns.askAi?.(...args);
    const stopRegulationAi = (...args) => ns.stopRegulationAi?.(...args);
    const clearAiTurns = (...args) => ns.clearAiTurns?.(...args);
    const ensureView = (...args) => ns.ensureView?.(...args);
    const renderShell = (...args) => ns.renderShell?.(...args);
    const loadFacets = (...args) => ns.loadFacets?.(...args);
    const loadSavedSearches = (...args) => ns.loadSavedSearches?.(...args);
    const loadImportJobs = (...args) => ns.loadImportJobs?.(...args);
    const retryRegulationImportJob = (...args) => ns.retryRegulationImportJob?.(...args);
    const cancelRegulationImportJob = (...args) => ns.cancelRegulationImportJob?.(...args);
    const revertRegulationBatch = (...args) => ns.revertRegulationBatch?.(...args);
    const openCategoryFolder = (...args) => ns.openCategoryFolder?.(...args);
    const returnToCategoryFolders = (...args) => ns.returnToCategoryFolders?.(...args);
    const loadCategoryFolders = (...args) => ns.loadCategoryFolders?.(...args);
        async function ensureModuleReadiness() {
            if (ns.renderReadyPromise) await ns.renderReadyPromise;
            if (ns.actionsReadyPromise) await ns.actionsReadyPromise;
        }

        function bindEvents(root) {
                if (root.dataset.regulationsBound === '1') return;
                root.dataset.regulationsBound = '1';
                root.addEventListener('submit', event => {
                    if (event.target?.classList?.contains('regulations-obligation-form')) {
                        event.preventDefault();
                        submitRegulationObligation(event.target);
                        return;
                    }
                    if (event.target?.id === 'regulations-batch-edit-form') {
                        event.preventDefault();
                        ns.saveBatchMetadata?.(event.target).catch(e => toast(e.message || '批量修改失败，请稍后重试', 'error'));
                        return;
                    }
                    if (event.target?.id === 'regulations-upload-form') {
                        event.preventDefault();
                        uploadDocument(event.target);
                        return;
                    }
                    if (event.target?.id === 'regulations-edit-form') {
                        event.preventDefault();
                        saveMetadata(event.target);
                        return;
                    }
                    if (event.target?.id === 'regulations-version-form') {
                        event.preventDefault();
                        uploadVersion(event.target);
                        return;
                    }
                    if (event.target?.id === 'regulations-create-folder-form') {
                        event.preventDefault();
                        const name = event.target.querySelector('#regulations-new-folder-name')?.value
                            || event.target.querySelector('[name="name"]')?.value;
                        const description = event.target.querySelector('#regulations-new-folder-desc')?.value
                            || event.target.querySelector('[name="description"]')?.value;
                        ns.createCategoryFolder?.({ name, description });
                        return;
                    }
                    if (event.target?.id === 'regulations-compare-form') {
                        event.preventDefault();
                        runCompare(event.target);
                    }
                    if (event.target?.classList?.contains('regulations-annotation-form')) {
                        event.preventDefault();
                        submitAnnotation(event.target);
                    }
                });
                root.addEventListener('keydown', event => {
                    if (event.key === 'Escape') {
                        const detailPanel = document.getElementById('regulations-detail-panel');
                        if (detailPanel && !detailPanel.classList.contains('hidden')) {
                            detailPanel.classList.add('hidden');
                            detailPanel.classList.remove('regulations-detail-from-ai', 'regulations-detail-from-search');
                            if (state.openedFromAi) {
                                state.openedFromAi = false;
                                const aiPanel = document.getElementById('regulations-ai-panel');
                                aiPanel?.classList.remove('hidden');
                                document.getElementById('regulations-ai-question')?.focus();
                                return;
                            }
                            if (state.openedFromSearch) {
                                state.openedFromSearch = false;
                                const searchPanel = document.getElementById('regulations-search-panel');
                                searchPanel?.classList.remove('hidden');
                                return;
                            }
                            return;
                        }
                        closeDialogs();
                        return;
                    }
                    if (event.key === 'Enter' && ['regulations-query', 'regulations-category-filter', 'regulations-issuing-body-filter', 'regulations-jurisdiction-filter'].includes(event.target?.id)) {
                        event.preventDefault();
                        runSearch().catch(e => toast(e.message || '搜索失败', 'error'));
                        return;
                    }
                    if (event.key === 'Enter' && event.target?.id === 'regulations-effective-date') {
                        event.preventDefault();
                        root.querySelector('[data-regulation-effective-date]')?.click();
                        return;
                    }
                    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && event.target?.id === 'regulations-ai-question') {
                        event.preventDefault();
                        document.getElementById('regulations-ai-btn')?.click();
                        return;
                    }
                });
                root.addEventListener('change', event => {
                    if (event.target?.id === 'regulations-effective-date') {
                        const date = event.target.value.trim();
                        const docId = root.querySelector('[data-regulation-effective-date]')?.dataset?.regulationEffectiveDate;
                        if (docId) {
                            if (date) {
                                loadDetail(docId, '', date).catch(e => toast(e.message || '未找到该日期适用的法规版本', 'error'));
                            } else if (state.effectiveAt) {
                                loadDetail(docId, '', '').then(() => toast('已恢复展示当前最新版本', 'info')).catch(e => toast(e.message || '恢复失败', 'error'));
                            }
                        }
                        return;
                    }
                    if (event.target?.id === 'regulations-ai-scope') {
                        state.aiScope = event.target.value === 'document' && state.detail?.document?.id ? 'document' : 'library';
                        ns.syncAiScopeControl?.();
                        return;
                    }
                    if (event.target?.matches('[data-regulation-batch-field]')) {
                        ns.syncBatchEditFields?.();
                        return;
                    }
                    if (event.target?.matches('[data-regulation-citation-select]')) {
                        ns.toggleCitationSelection?.(event.target.dataset.regulationCitationSelect, event.target.checked);
                        return;
                    }
                    if (event.target?.matches('[data-regulation-citation-select-all]')) {
                        ns.selectAllCitationGovernance?.(event.target.checked);
                        return;
                    }
                    if (event.target?.id === 'regulations-select-all') {
                        ns.selectAllDocuments?.(event.target.checked);
                    } else if (event.target?.matches('[data-regulation-select]')) {
                        ns.selectDocument?.(event.target.dataset.regulationSelect, event.target.checked);
                    }
                });
                root.addEventListener('input', event => {
                    if (event.target?.classList?.contains('regulations-file-input')) {
                        syncFileInputState(event.target);
                    }
                    if (event.target?.id === 'regulations-upload-file') {
                        syncImportHint(event.target.closest('#regulations-upload-form'));
                    }
                    if (event.target?.matches('[data-regulation-bookmark-search]')) {
                        handleBookmarkSearch(event.target.value);
                    }
                });
                root.addEventListener('keydown', event => {
                    if (event.key === 'Enter' && event.target?.matches('[data-regulation-bookmark-topic]')) {
                        event.preventDefault();
                        const bookmarkId = event.target.dataset.regulationBookmarkTopic;
                        const card = event.target.closest('.regulations-bookmark-card');
                        const saveBtn = card?.querySelector('[data-regulation-bookmark-save]');
                        if (saveBtn) {
                            saveRegulationBookmarkTopic(bookmarkId, saveBtn.dataset.regulationBookmarkDocument, event.target.value.trim());
                        }
                    }
                });
                root.addEventListener('click', event => {
                    if (event.target.closest('#regulations-batch-mode-btn')) {
                        ns.toggleBatchMode?.();
                        return;
                    }
                    if (event.target.closest('#regulations-batch-edit-btn')) {
                        ns.openBatchEditDialog?.();
                        return;
                    }
                    if (event.target.closest('[data-regulations-close-batch-edit]') || event.target.id === 'regulations-batch-edit-panel') {
                        ns.closeBatchEditDialog?.();
                        return;
                    }
                    if (event.target.closest('#regulations-batch-delete-btn')) {
                        deleteSelectedDocuments().catch(e => toast(e.message || '批量删除失败，请稍后重试', 'error'));
                        return;
                    }
                    const revertBatch = event.target.closest('[data-regulation-batch-revert]');
                    if (revertBatch) {
                        revertRegulationBatch(revertBatch.dataset.regulationBatchRevert);
                        return;
                    }
                    if (event.target.closest('#regulations-clear-selection-btn')) {
                        ns.clearDocumentSelection?.();
                        return;
                    }
                    if (event.target.closest('#regulations-select-folder-btn')) {
                        ns.selectAllFolderDocuments?.();
                        return;
                    }
                    if (event.target.closest('#regulations-governance-batch-action-btn')) {
                        ns.runGovernanceBatchAction?.().catch(error => toast(error.message || '批量处理失败，请稍后重试', 'error'));
                        return;
                    }
                    if (event.target.closest('#regulations-reindex-scope-btn')) {
                        ns.reindexCurrentScope?.();
                        return;
                    }
                    if (event.target.closest('[data-regulations-close-batch-result]') || event.target.id === 'regulations-batch-result-panel') {
                        document.getElementById('regulations-batch-result-panel')?.classList.add('hidden');
                        return;
                    }
                    const docOpener = event.target.closest('[data-regulation-open-doc]');
                    if (docOpener) {
                        state.openedFromAi = false;
                        state.openedFromSearch = false;
                        loadDetail(docOpener.dataset.regulationOpenDoc).catch(e => toast(e.message || '加载法规详情失败', 'error'));
                        return;
                    }
                    if (event.target.closest('[data-regulation-governance-worklist]')) {
                        openGovernanceWorklist(event.target.closest('[data-regulation-governance-worklist]').dataset.regulationGovernanceWorklist);
                        return;
                    }
                    const governance = event.target.closest('[data-regulation-governance-document]');
                    if (governance) {
                        openVersionGovernance(governance.dataset.regulationGovernanceDocument, governance.dataset.regulationGovernanceVersion);
                        return;
                    }
                    const documentGovernance = event.target.closest('[data-regulation-document-governance]');
                    if (documentGovernance) {
                        openDocumentGovernance(documentGovernance.dataset.regulationDocumentGovernance, documentGovernance.dataset.regulationGovernanceVersion, documentGovernance.dataset.regulationGovernanceScope);
                        return;
                    }
                    const citationGovernance = event.target.closest('[data-regulation-citation-governance]');
                    if (citationGovernance) {
                        showCitationGovernance(citationGovernance.dataset.regulationCitationGovernance);
                        return;
                    }
                    if (event.target.closest('#regulations-open-search-btn')) {
                        openSearchDialog();
                        return;
                    }
                    if (event.target.closest('#regulations-search-btn')) {
                        runSearch().catch(e => toast(e.message || '搜索失败', 'error'));
                        return;
                    }
                    if (event.target.closest('#regulations-save-search-btn')) {
                        saveCurrentSearch();
                        return;
                    }
                    const savedSearch = event.target.closest('[data-regulation-saved-search]');
                    if (savedSearch) {
                        applySavedSearch(savedSearch.dataset.regulationSavedSearch).catch(e => toast(e.message || '应用保存检索失败', 'error'));
                        return;
                    }
                    const deleteSaved = event.target.closest('[data-regulation-delete-saved-search]');
                    if (deleteSaved) {
                        deleteSavedSearch(deleteSaved.dataset.regulationDeleteSavedSearch);
                        return;
                    }
                    if (event.target.closest('#regulations-refresh-btn')) {
                        (state.libraryView === 'folders' ? loadCategoryFolders() : loadDocuments({ keepActive: true, page: state.page })).catch(e => toast(e.message || '刷新失败', 'error'));
                        return;
                    }
                    if (event.target.closest('#regulations-folders-btn')) {
                        returnToCategoryFolders().catch(e => toast(e.message || '加载分类目录失败', 'error'));
                        return;
                    }
                    if (event.target.closest('[data-regulation-create-folder]')) {
                        ns.openCreateFolderDialog?.();
                        return;
                    }
                    if (event.target.closest('[data-regulations-close-create-folder]')) {
                        ns.closeCreateFolderDialog?.();
                        return;
                    }
                    const presetCatBtn = event.target.closest('[data-regulation-preset-cat]');
                    if (presetCatBtn) {
                        const input = document.getElementById('regulations-new-folder-name');
                        if (input) {
                            input.value = presetCatBtn.dataset.regulationPresetCat || '';
                            input.focus();
                        }
                        return;
                    }
                    const deleteFolderBtn = event.target.closest('[data-regulation-folder-delete]');
                    if (deleteFolderBtn) {
                        ns.deleteCategoryFolder?.(deleteFolderBtn.dataset.regulationFolderDelete);
                        return;
                    }
                    const importFolderBtn = event.target.closest('[data-regulation-import-folder]');
                    if (importFolderBtn) {
                        const category = importFolderBtn.dataset.regulationImportFolder;
                        const panel = document.getElementById('regulations-admin-panel');
                        panel?.classList.remove('hidden');
                        if (panel) focusFirstField(panel);
                        const form = document.getElementById('regulations-upload-form');
                        if (form && category) {
                            const catInput = form.querySelector('[name="category"]');
                            if (catInput) catInput.value = category;
                        }
                        syncImportHint(form);
                        loadImportJobs().catch(e => toast(e.message || '加载导入任务失败', 'error'));
                        return;
                    }
                    const folder = event.target.closest('[data-regulation-folder-title]');
                    if (folder) {
                        openCategoryFolder({
                            title: folder.dataset.regulationFolderTitle,
                            category: folder.dataset.regulationFolderCategory,
                            isUncategorized: folder.dataset.regulationFolderUncategorized === 'true',
                            isCustom: folder.dataset.regulationFolderCustom === 'true',
                            documentCount: folder.dataset.regulationFolderDocuments,
                            articleCount: folder.dataset.regulationFolderArticles,
                            effectiveCount: folder.dataset.regulationFolderEffective,
                            needsReviewCount: folder.dataset.regulationFolderReview,
                            latestUpdatedAt: folder.dataset.regulationFolderUpdated
                        }).catch(e => toast(e.message || '加载分类法规失败', 'error'));
                        return;
                    }
                    if (event.target.closest('[data-regulation-folder-back]')) {
                        returnToCategoryFolders().catch(e => toast(e.message || '加载分类目录失败', 'error'));
                        return;
                    }
                    if (event.target.closest('#regulations-ai-open-btn')) {
                        openAiDialog();
                        return;
                    }
                    if (event.target.closest('#regulations-bookmarks-btn')) {
                        showRegulationBookmarks();
                        return;
                    }
                    if (event.target.closest('#regulations-recycle-bin-btn')) {
                        showRegulationRecycleBin();
                        return;
                    }
                    if (event.target.id === 'regulations-search-panel') {
                        closeSearchDialog();
                        return;
                    }
                    if (event.target.id === 'regulations-detail-panel') {
                        const detailPanel = document.getElementById('regulations-detail-panel');
                        detailPanel?.classList.add('hidden');
                        detailPanel?.classList.remove('regulations-detail-from-ai', 'regulations-detail-from-search');
                        if (state.openedFromAi) {
                            state.openedFromAi = false;
                            const aiPanel = document.getElementById('regulations-ai-panel');
                            aiPanel?.classList.remove('hidden');
                            document.getElementById('regulations-ai-question')?.focus();
                            return;
                        }
                        if (state.openedFromSearch) {
                            state.openedFromSearch = false;
                            const searchPanel = document.getElementById('regulations-search-panel');
                            searchPanel?.classList.remove('hidden');
                            return;
                        }
                        return;
                    }
                    if (['regulations-admin-panel', 'regulations-ai-panel', 'regulations-similar-panel', 'regulations-graph-panel', 'regulations-timeline-panel', 'regulations-preview-panel', 'regulations-annotation-panel', 'regulations-access-log-panel', 'regulations-ai-log-panel', 'regulations-bookmarks-panel', 'regulations-recycle-bin-panel', 'regulations-quality-panel', 'regulations-citation-governance-panel', 'regulations-obligation-panel', 'regulations-location-panel', 'regulations-create-folder-panel'].includes(event.target.id)) {
                        closeDialogs();
                        return;
                    }
                    if (event.target.closest('#regulations-open-upload-btn')) {
                        const panel = document.getElementById('regulations-admin-panel');
                        panel?.classList.toggle('hidden');
                        if (panel && !panel.classList.contains('hidden')) focusFirstField(panel);
                        syncImportHint(document.getElementById('regulations-upload-form'));
                        if (panel && !panel.classList.contains('hidden')) loadImportJobs().catch(e => toast(e.message || '加载导入任务失败', 'error'));
                        return;
                    }
                    const retryImportJob = event.target.closest('[data-regulation-import-retry]');
                    if (retryImportJob) {
                        retryRegulationImportJob(retryImportJob.dataset.regulationImportRetry);
                        return;
                    }
                    const cancelImportJob = event.target.closest('[data-regulation-import-cancel]');
                    if (cancelImportJob) {
                        cancelRegulationImportJob(cancelImportJob.dataset.regulationImportCancel);
                        return;
                    }
                    if (event.target.closest('#regulations-quality-btn')) {
                        showQualitySummary();
                        return;
                    }
                    const presetBtn = event.target.closest('[data-preset]');
                    if (presetBtn) {
                        const preset = PRESETS[presetBtn.dataset.preset];
                        if (preset) {
                            const form = document.getElementById('regulations-upload-form');
                            if (form) {
                                const categoryInput = form.querySelector('[name="category"]');
                                const legalLevelInput = form.querySelector('[name="legalLevel"]');
                                const issuingBodyInput = form.querySelector('[name="issuingBody"]');
                                const jurisdictionInput = form.querySelector('[name="jurisdiction"]');
                                if (categoryInput) categoryInput.value = preset.category || '';
                                if (legalLevelInput) legalLevelInput.value = preset.legalLevel || '';
                                if (issuingBodyInput) issuingBodyInput.value = preset.issuingBody || '';
                                if (jurisdictionInput) jurisdictionInput.value = preset.jurisdiction || '';
                                toast('已应用预设模板', 'success');
                            }
                        }
                        return;
                    }
                    if (event.target.closest('[data-regulations-close-search]')) {
                        closeSearchDialog();
                        return;
                    }
                    if (event.target.closest('[data-regulations-close-upload]')) {
                        closeDialogs();
                        return;
                    }
                    if (event.target.closest('[data-regulations-close-detail]')) {
                        const detailPanel = document.getElementById('regulations-detail-panel');
                        detailPanel?.classList.add('hidden');
                        detailPanel?.classList.remove('regulations-detail-from-ai', 'regulations-detail-from-search');
                        if (state.openedFromAi) {
                            state.openedFromAi = false;
                            const aiPanel = document.getElementById('regulations-ai-panel');
                            aiPanel?.classList.remove('hidden');
                            document.getElementById('regulations-ai-question')?.focus();
                            return;
                        }
                        if (state.openedFromSearch) {
                            state.openedFromSearch = false;
                            const searchPanel = document.getElementById('regulations-search-panel');
                            searchPanel?.classList.remove('hidden');
                            return;
                        }
                        return;
                    }
                    if (event.target.closest('[data-regulations-close-ai]')) {
                        ns.stopRegulationAi?.({ silent: true });
                        state.openedFromAi = false;
                        document.getElementById('regulations-ai-panel')?.classList.add('hidden');
                        return;
                    }
                    const version = event.target.closest('[data-regulation-version-id]');
                    if (version) {
                        loadDetail(state.activeId, version.dataset.regulationVersionId).catch(e => toast(e.message || '加载版本失败', 'error'));
                        return;
                    }
                    const edit = event.target.closest('[data-regulation-edit]');
                    if (edit) {
                        openDocumentGovernance(state.activeId, state.detail?.currentVersion?.id || '', 'metadata');
                        return;
                    }
                    const addVersion = event.target.closest('[data-regulation-add-version]');
                    if (addVersion) {
                        const documentId = addVersion.dataset.regulationAddVersion;
                        Promise.resolve().then(async () => {
                            if (documentId && String(documentId) !== String(state.activeId)) await loadDetail(documentId);
                            const form = document.getElementById('regulations-version-form');
                            form?.classList.remove('hidden');
                            document.getElementById('regulations-edit-form')?.classList.add('hidden');
                            focusFirstField(form);
                        }).catch(error => toast(error.message || '打开追加版本表单失败', 'error'));
                        return;
                    }
                    const cancelInline = event.target.closest('[data-regulation-cancel-inline]');
                    if (cancelInline) {
                        closeInlineForms();
                        return;
                    }
                    const del = event.target.closest('[data-regulation-delete]');
                    if (del) {
                        if (!canDeleteDocuments()) {
                            toast('仅 admin 权限层级可删除法规文档', 'error');
                            return;
                        }
                        archiveDocument(del.dataset.regulationDelete);
                        return;
                    }
                    const match = event.target.closest('[data-regulation-match-doc]');
                    if (match) {
                        const isFromAi = !!match.closest('#regulations-ai-panel') || (state.openedFromAi && !match.closest('#regulations-search-panel'));
                        const isFromSearch = !isFromAi && (!!match.closest('#regulations-search-panel') || state.openedFromSearch);
                        state.openedFromAi = isFromAi;
                        state.openedFromSearch = isFromSearch;
                        if (!isFromSearch) {
                            closeSearchDialog();
                        }
                        if (!isFromAi) {
                            document.getElementById('regulations-ai-panel')?.classList.add('hidden');
                        }
                        document.getElementById('regulations-similar-panel')?.classList.add('hidden');
                        loadDetail(match.dataset.regulationMatchDoc, match.dataset.regulationMatchVersion || '').then(() => {
                            focusArticle(match.dataset.regulationMatchArticle);
                        }).catch(e => toast(e.message || '打开命中条文失败', 'error'));
                        return;
                    }
                    const effectiveDateClear = event.target.closest('[data-regulation-effective-date-clear]');
                    if (effectiveDateClear) {
                        const docId = effectiveDateClear.dataset.regulationEffectiveDateClear;
                        loadDetail(docId, '', '').then(() => toast('已恢复展示当前最新版本', 'info')).catch(e => toast(e.message || '恢复失败', 'error'));
                        return;
                    }
                    const effectiveDate = event.target.closest('[data-regulation-effective-date]');
                    if (effectiveDate) {
                        const date = document.getElementById('regulations-effective-date')?.value || '';
                        if (!date) {
                            toast('请选择要查看的适用日期', 'warning');
                            return;
                        }
                        loadDetail(effectiveDate.dataset.regulationEffectiveDate, '', date).catch(e => toast(e.message || '未找到该日期适用的法规版本', 'error'));
                        return;
                    }

                    const articleCopy = event.target.closest('[data-article-copy]');
                    if (articleCopy) {
                        const article = state.detail?.articles?.find(a => String(a.id) === String(articleCopy.dataset.articleCopy));
                        if (article?.content) {
                            navigator.clipboard.writeText(article.content).then(() => toast('已复制条文原文', 'success')).catch(() => toast('复制失败', 'error'));
                        }
                        return;
                    }
                    const articleAsk = event.target.closest('[data-article-ask]');
                    if (articleAsk) {
                        const article = state.detail?.articles?.find(a => String(a.id) === String(articleAsk.dataset.articleAsk));
                        state.aiScope = 'document';
                        openAiDialog('document');
                        const question = document.getElementById('regulations-ai-question');
                        if (article && question) {
                            question.value = `${article.article_label || '条文'}：\n${(article.content || '').slice(0, 500)}`;
                            question.focus();
                            question.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                        }
                        return;
                    }
                    const articleLink = event.target.closest('[data-article-link]');
                    if (articleLink) {
                        const anchor = articleLink.dataset.articleLink;
                        const url = `${location.origin}${location.pathname}#reg=${anchor}`;
                        navigator.clipboard.writeText(url).then(() => toast('已复制定位链接', 'success')).catch(() => toast('复制失败', 'error'));
                        return;
                    }
                    const similarBtn = event.target.closest('[data-regulation-similar]');
                    if (similarBtn) {
                        showSimilarArticles(similarBtn.dataset.regulationSimilar);
                        return;
                    }
                    if (event.target.closest('[data-regulations-close-result]')) {
                        document.getElementById('regulations-import-result-panel')?.classList.add('hidden');
                        return;
                    }
                    if (event.target.closest('[data-regulations-close-compare]')) {
                        document.getElementById('regulations-compare-panel')?.classList.add('hidden');
                        state.diffView = null;
                        return;
                    }
                    if (event.target.closest('[data-regulations-close-graph]')) {
                        document.getElementById('regulations-graph-panel')?.classList.add('hidden');
                        return;
                    }
                    if (event.target.closest('[data-regulations-close-timeline]')) {
                        document.getElementById('regulations-timeline-panel')?.classList.add('hidden');
                        return;
                    }
                    if (event.target.closest('[data-regulations-close-preview]')) {
                        document.getElementById('regulations-preview-panel')?.classList.add('hidden');
                        return;
                    }
                    if (event.target.closest('[data-regulations-close-similar]')) {
                        document.getElementById('regulations-similar-panel')?.classList.add('hidden');
                        return;
                    }
                    const graphNode = event.target.closest('[data-graph-article]');
                    if (graphNode) {
                        document.getElementById('regulations-graph-panel')?.classList.add('hidden');
                        loadDetail(graphNode.dataset.graphDoc || state.activeId).then(() => {
                            focusArticle(graphNode.dataset.graphArticle);
                        }).catch(e => toast(e.message || '打开引用节点失败', 'error'));
                        return;
                    }
                    const graphBtn = event.target.closest('[data-regulation-graph]');
                    if (graphBtn) {
                        showCitationGraph(graphBtn.dataset.regulationGraph);
                        return;
                    }
                    const timelineBtn = event.target.closest('[data-regulation-timeline]');
                    if (timelineBtn) {
                        showVersionTimeline(timelineBtn.dataset.regulationTimeline);
                        return;
                    }
                    const timelineNode = event.target.closest('[data-timeline-version]');
                    if (timelineNode) {
                        const docId = timelineNode.dataset.timelineDoc;
                        const versionId = timelineNode.dataset.timelineVersion;
                        document.getElementById('regulations-timeline-panel')?.classList.add('hidden');
                        loadDetail(docId, versionId).catch(e => toast(e.message || '切换版本失败', 'error'));
                        return;
                    }
                    if (event.target.closest('[data-regulation-preview]')) {
                        previewRegulationImport();
                        return;
                    }
                    const exportReportBtn = event.target.closest('[data-regulation-export-report]');
                    if (exportReportBtn) {
                        exportRegulationReport(Number(exportReportBtn.dataset.regulationExportReport), exportReportBtn.dataset.regulationExportFormat || 'md');
                        return;
                    }
                    const annotateBtn = event.target.closest('[data-regulation-annotate]');
                    if (annotateBtn) {
                        showAnnotations(annotateBtn.dataset.regulationAnnotate);
                        return;
                    }
                    const accessLog = event.target.closest('[data-regulation-access-log]');
                    if (accessLog) {
                        showAccessLogs(accessLog.dataset.regulationAccessLog);
                        return;
                    }
                    const aiLogs = event.target.closest('[data-regulation-ai-logs]');
                    if (aiLogs) {
                        showRegulationAiLogs(aiLogs.dataset.regulationAiLogs);
                        return;
                    }
                    const subscribe = event.target.closest('[data-regulation-subscribe]');
                    if (subscribe) {
                        toggleRegulationSubscription(subscribe.dataset.regulationSubscribe);
                        return;
                    }
                    const bookmark = event.target.closest('[data-regulation-bookmark]');
                    if (bookmark) {
                        toggleRegulationBookmark(bookmark.dataset.regulationBookmark);
                        return;
                    }
                    const topicFilter = event.target.closest('[data-regulation-bookmark-topic-filter]');
                    if (topicFilter) {
                        handleBookmarkTopicFilter(topicFilter.dataset.regulationBookmarkTopicFilter);
                        return;
                    }
                    const quickTopic = event.target.closest('[data-regulation-quick-topic]');
                    if (quickTopic) {
                        const topic = quickTopic.dataset.regulationQuickTopic;
                        const targetId = quickTopic.dataset.targetId;
                        const targetDoc = quickTopic.dataset.targetDoc;
                        saveRegulationBookmarkTopic(targetId, targetDoc, topic);
                        return;
                    }
                    const bookmarkSave = event.target.closest('[data-regulation-bookmark-save]');
                    if (bookmarkSave) {
                        saveRegulationBookmarkTopic(bookmarkSave.dataset.regulationBookmarkSave, bookmarkSave.dataset.regulationBookmarkDocument);
                        return;
                    }
                    const bookmarkDelete = event.target.closest('[data-regulation-bookmark-delete]');
                    if (bookmarkDelete) {
                        deleteRegulationBookmark(bookmarkDelete.dataset.regulationBookmarkDelete);
                        return;
                    }
                    const bookmarkOpen = event.target.closest('[data-regulation-bookmark-open]');
                    if (bookmarkOpen) {
                        document.getElementById('regulations-bookmarks-panel')?.classList.add('hidden');
                        loadDetail(bookmarkOpen.dataset.regulationBookmarkOpen).catch(error => toast(error.message || '加载法规详情失败', 'error'));
                        return;
                    }
                    const restore = event.target.closest('[data-regulation-restore]');
                    if (restore) {
                        restoreRegulationFromRecycleBin(restore.dataset.regulationRestore);
                        return;
                    }
                    const reindex = event.target.closest('[data-regulation-reindex-document]');
                    if (reindex) {
                        requestRegulationReindex(reindex.dataset.regulationReindexDocument, reindex.dataset.regulationReindexVersion);
                        return;
                    }
                    const rebuildLocations = event.target.closest('[data-regulation-rebuild-locations-document]');
                    if (rebuildLocations) {
                        requestRegulationLocationRebuild(rebuildLocations.dataset.regulationRebuildLocationsDocument, rebuildLocations.dataset.regulationRebuildLocationsVersion);
                        return;
                    }
                    if (event.target.closest('[data-regulation-citation-rebuild]')) {
                        rebuildCitationLinks();
                        return;
                    }
                    if (event.target.closest('[data-regulation-citation-approve-high]')) {
                        approveHighConfidenceCitationLinks();
                        return;
                    }
                    const selectedCitationReview = event.target.closest('[data-regulation-citation-review-selected]');
                    if (selectedCitationReview) {
                        ns.reviewSelectedCitationLinks?.(selectedCitationReview.dataset.regulationCitationReviewSelected);
                        return;
                    }
                    const citationReview = event.target.closest('[data-regulation-citation-review]');
                    if (citationReview) {
                        reviewCitationLinks(citationReview.dataset.regulationCitationId, citationReview.dataset.regulationCitationReview);
                        return;
                    }
                    const obligations = event.target.closest('[data-regulation-obligations]');
                    if (obligations) {
                        showRegulationObligations(obligations.dataset.regulationObligations);
                        return;
                    }
                    const obligation = event.target.closest('[data-regulation-obligation]');
                    if (obligation) {
                        showRegulationObligations(state.activeId, obligation.dataset.regulationObligation);
                        return;
                    }
                    const obligationReview = event.target.closest('[data-regulation-obligation-review]');
                    if (obligationReview) {
                        // 延迟到当前点击事件结束后再切换全局忙碌状态，避免按钮在浏览器
                        // 正处理本次点击时被重绘，导致重复触发或焦点丢失。
                        Promise.resolve().then(() => reviewRegulationObligation(
                            obligationReview.dataset.regulationObligationDocument,
                            obligationReview.dataset.regulationObligationReview
                        ));
                        return;
                    }
                    const location = event.target.closest('[data-regulation-location]');
                    if (location) {
                        showArticleLocations(location.dataset.regulationLocation);
                        return;
                    }
                    const annotationDelete = event.target.closest('[data-annotation-delete]');
                    if (annotationDelete) {
                        deleteAnnotation(annotationDelete.dataset.annotationDelete, annotationDelete.dataset.annotationArticle);
                        return;
                    }
                    if (event.target.closest('[data-regulations-close-annotation]')) {
                        document.getElementById('regulations-annotation-panel')?.classList.add('hidden');
                        return;
                    }
                    if (event.target.closest('[data-regulations-close-access-log]')) {
                        document.getElementById('regulations-access-log-panel')?.classList.add('hidden');
                        return;
                    }
                    if (event.target.closest('[data-regulations-close-ai-log]')) {
                        document.getElementById('regulations-ai-log-panel')?.classList.add('hidden');
                        return;
                    }
                    if (event.target.closest('[data-regulations-close-bookmarks]')) {
                        document.getElementById('regulations-bookmarks-panel')?.classList.add('hidden');
                        return;
                    }
                    if (event.target.closest('[data-regulations-close-recycle-bin]')) {
                        document.getElementById('regulations-recycle-bin-panel')?.classList.add('hidden');
                        return;
                    }
                    if (event.target.closest('[data-regulations-close-quality]')) {
                        document.getElementById('regulations-quality-panel')?.classList.add('hidden');
                        return;
                    }
                    if (event.target.closest('[data-regulations-close-citation-governance]')) {
                        document.getElementById('regulations-citation-governance-panel')?.classList.add('hidden');
                        return;
                    }
                    if (event.target.closest('[data-regulations-close-obligation]')) {
                        document.getElementById('regulations-obligation-panel')?.classList.add('hidden');
                        return;
                    }
                    if (event.target.closest('[data-regulations-close-location]')) {
                        document.getElementById('regulations-location-panel')?.classList.add('hidden');
                        return;
                    }
                    if (event.target.closest('[data-preview-confirm]')) {
                        confirmPreviewImport();
                        return;
                    }
                    if (event.target.closest('[data-preview-merge]')) {
                        mergePreviewArticles();
                        return;
                    }
                    const compare = event.target.closest('[data-regulation-compare]');
                    if (compare) {
                        showCompareDialog(compare.dataset.regulationCompare);
                        return;
                    }
                    if (event.target.closest('[data-regulation-impact]')) {
                        const form = document.getElementById('regulations-compare-form');
                        if (form) runChangeImpact(form);
                        return;
                    }
                    if (event.target.closest('#regulations-ai-btn')) {
                        const question = document.getElementById('regulations-ai-question');
                        askAi(question?.value?.trim());
                        return;
                    }
                    if (event.target.closest('#regulations-ai-stop-btn')) {
                        stopRegulationAi();
                        return;
                    }
                    if (event.target.closest('#regulations-ai-clear-btn')) {
                        clearAiTurns();
                        const question = document.getElementById('regulations-ai-question');
                        if (question) question.value = '';
                        return;
                    }
                    const sampleChip = event.target.closest('[data-regulations-ai-sample]');
                    if (sampleChip) {
                        const question = document.getElementById('regulations-ai-question');
                        if (question) {
                            question.value = sampleChip.dataset.regulationsAiSample || '';
                            question.focus();
                        }
                        return;
                    }
                    const copyAiBtn = event.target.closest('[data-regulations-ai-copy]');
                    if (copyAiBtn) {
                        const idx = parseInt(copyAiBtn.dataset.regulationsAiCopy, 10);
                        const turn = state.aiTurns[idx];
                        if (turn?.answer) {
                            const textToCopy = typeof stripMarkdownFormatting === 'function'
                                ? stripMarkdownFormatting(turn.answer)
                                : turn.answer;
                            navigator.clipboard.writeText(textToCopy).then(() => {
                                toast('已复制回答内容', 'success');
                            }).catch(() => {
                                toast('复制失败', 'error');
                            });
                        }
                        return;
                    }
                });
            }

            async function parseDeepLink() {
                const hash = location.hash || '';
                const m = hash.match(/^#reg=(\d+)(?:\.(\d+))?\.(\d+)$/);
                if (m) {
                    const [, docId, versionId, articleId] = m;
                    await loadDetail(docId, versionId || '');
                    focusArticle(articleId);
                }
            }

            async function showRegulationsApp() {
                await ensureModuleReadiness();
                window.Pivot.legacy.PivotDataAnalysis?.resetAiWorkspace?.();
                window.Pivot.legacy.setAppsSessionValue?.('pivot_apps_active_app', 'regulations');
                document.getElementById('apps-home-view')?.classList.add('hidden');
                document.getElementById('official-writing-view')?.classList.add('hidden');
                document.getElementById('data-analysis-view')?.classList.add('hidden');
                const view = ensureView();
                view.classList.remove('hidden');
                document.getElementById('apps-back-btn')?.classList.remove('hidden');
                if (typeof setAppsTitle === 'function') {
                    setAppsTitle('法规查询', '检索法规条文、查看版本并围绕命中条文问答。');
                }
                renderShell();
                await window.Pivot.legacy.PivotAppModels?.refresh?.('regulations', 'regulations-ai-model');
                bindEvents(view);
                try {
                    await Promise.all([loadCategoryFolders(), loadFacets(), loadSavedSearches()]);
                    await parseDeepLink();
                } catch (e) {
                    toast(e.message || '加载法规查询失败', 'error');
                }
            }

            async function loadDocumentsFromRegistry(options) {
                await ensureModuleReadiness();
                return ns.loadDocuments(options);
            }

            async function runSearchFromRegistry() {
                await ensureModuleReadiness();
                return ns.runSearch();
            }

            Object.assign(ns, {
                ensureModuleReadiness,
                bindEvents,
                parseDeepLink,
                showRegulationsApp,
                eventsReady: true
            });
            window.Pivot.legacy.PivotRegulations = {
                ready: true,
                ensureReady: () => ensureModuleReadiness().then(() => window.Pivot.legacy.PivotRegulations),
                showRegulationsApp,
                loadDocuments: loadDocumentsFromRegistry,
                runSearch: runSearchFromRegistry
            };
            window.Pivot.legacy.showRegulationsApp = showRegulationsApp;
})();
