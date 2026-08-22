/* eslint-disable no-undef -- Split regulations modules resolve names through PivotRegulationsInternal. */
(function () {
    const ns = window.PivotRegulationsInternal;
    if (!ns) throw new Error('法规库核心模块未加载');
    if (ns.eventsReady) return;
    with (ns) {
        async function ensureModuleReadiness() {
            if (ns.renderReadyPromise) await ns.renderReadyPromise;
            if (ns.actionsReadyPromise) await ns.actionsReadyPromise;
        }

        function bindEvents(root) {
                if (root.dataset.regulationsBound === '1') return;
                root.dataset.regulationsBound = '1';
                root.addEventListener('submit', event => {
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
                        closeDialogs();
                        return;
                    }
                    if (event.key === 'Enter' && ['regulations-query', 'regulations-category-filter', 'regulations-jurisdiction-filter'].includes(event.target?.id)) {
                        event.preventDefault();
                        runSearch().catch(e => toast(e.message || '搜索失败', 'error'));
                        return;
                    }
                });
                root.addEventListener('input', event => {
                    if (event.target?.classList?.contains('regulations-file-input')) {
                        syncFileInputState(event.target);
                    }
                    if (event.target?.id === 'regulations-upload-file') {
                        syncImportHint(event.target.closest('#regulations-upload-form'));
                    }
                });
                root.addEventListener('click', event => {
                    const docOpener = event.target.closest('[data-regulation-open-doc]');
                    if (docOpener) {
                        loadDetail(docOpener.dataset.regulationOpenDoc).catch(e => toast(e.message || '加载法规详情失败', 'error'));
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
                        loadDocuments({ keepActive: true, page: state.page }).catch(e => toast(e.message || '刷新失败', 'error'));
                        return;
                    }
                    if (event.target.closest('#regulations-ai-open-btn')) {
                        openAiDialog();
                        return;
                    }
                    if (event.target.id === 'regulations-search-panel') {
                        closeSearchDialog();
                        return;
                    }
                    if (['regulations-admin-panel', 'regulations-detail-panel', 'regulations-ai-panel', 'regulations-similar-panel', 'regulations-graph-panel', 'regulations-timeline-panel', 'regulations-preview-panel', 'regulations-annotation-panel'].includes(event.target.id)) {
                        closeDialogs();
                        return;
                    }
                    if (event.target.closest('#regulations-open-upload-btn')) {
                        const panel = document.getElementById('regulations-admin-panel');
                        panel?.classList.toggle('hidden');
                        if (panel && !panel.classList.contains('hidden')) focusFirstField(panel);
                        syncImportHint(document.getElementById('regulations-upload-form'));
                        return;
                    }
                    const presetBtn = event.target.closest('[data-preset]');
                    if (presetBtn) {
                        const preset = PRESETS[presetBtn.dataset.preset];
                        if (preset) {
                            const form = document.getElementById('regulations-upload-form');
                            if (form) {
                                const categoryInput = form.querySelector('[name="category"]');
                                const issuingBodyInput = form.querySelector('[name="issuingBody"]');
                                const jurisdictionInput = form.querySelector('[name="jurisdiction"]');
                                if (categoryInput) categoryInput.value = preset.category || '';
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
                        document.getElementById('regulations-detail-panel')?.classList.add('hidden');
                        return;
                    }
                    if (event.target.closest('[data-regulations-close-ai]')) {
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
                        const form = document.getElementById('regulations-edit-form');
                        form?.classList.remove('hidden');
                        document.getElementById('regulations-version-form')?.classList.add('hidden');
                        focusFirstField(form);
                        return;
                    }
                    const addVersion = event.target.closest('[data-regulation-add-version]');
                    if (addVersion) {
                        const form = document.getElementById('regulations-version-form');
                        form?.classList.remove('hidden');
                        document.getElementById('regulations-edit-form')?.classList.add('hidden');
                        focusFirstField(form);
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
                        document.getElementById('regulations-ai-panel')?.classList.add('hidden');
                        document.getElementById('regulations-similar-panel')?.classList.add('hidden');
                        loadDetail(match.dataset.regulationMatchDoc).then(() => {
                            focusArticle(match.dataset.regulationMatchArticle);
                        }).catch(e => toast(e.message || '打开命中条文失败', 'error'));
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
                        openAiDialog();
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
                        exportRegulationReport(Number(exportReportBtn.dataset.regulationExportReport));
                        return;
                    }
                    const annotateBtn = event.target.closest('[data-regulation-annotate]');
                    if (annotateBtn) {
                        showAnnotations(annotateBtn.dataset.regulationAnnotate);
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
                    if (event.target.closest('[data-preview-confirm]')) {
                        toast('预览确认入库功能待后续完善：目前请关闭预览直接提交表单入库', 'info');
                        return;
                    }
                    if (event.target.closest('[data-preview-merge]')) {
                        const list = document.getElementById('regulations-preview-list');
                        const checked = Array.from(list?.querySelectorAll('.regulations-preview-checkbox:checked') || []);
                        if (checked.length < 2) {
                            toast('请至少选中两个相邻条文以合并', 'warning');
                            return;
                        }
                        toast('条文合并功能待后续完善', 'info');
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
                    if (event.target.closest('#regulations-ai-clear-btn')) {
                        clearAiTurns();
                        const question = document.getElementById('regulations-ai-question');
                        if (question) question.value = '';
                    }
                });
            }

            async function parseDeepLink() {
                const hash = location.hash || '';
                const m = hash.match(/^#reg=(\d+)\.(\d+)$/);
                if (m) {
                    const [, docId, articleId] = m;
                    await loadDetail(docId);
                    focusArticle(articleId);
                }
            }

            async function showRegulationsApp() {
                await ensureModuleReadiness();
                window.PivotDataAnalysis?.resetAiWorkspace?.();
                window.setAppsSessionValue?.('pivot_apps_active_app', 'regulations');
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
                bindEvents(view);
                try {
                    await Promise.all([loadDocuments({ keepActive: true, page: state.page }), loadFacets(), loadSavedSearches()]);
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
            window.PivotRegulations = {
                ready: true,
                ensureReady: () => ensureModuleReadiness().then(() => window.PivotRegulations),
                showRegulationsApp,
                loadDocuments: loadDocumentsFromRegistry,
                runSearch: runSearchFromRegistry
            };
            window.showRegulationsApp = showRegulationsApp;
    }
})();
