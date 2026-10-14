(function () {
    const ns = window.Pivot.legacy.PivotRegulationsInternal;
    if (!ns) throw new Error('法规库核心模块未加载');
    if (ns.actionsCoreReady) return;

    const { API, state, REGULATIONS_PAGE_SIZE, esc, cleanArticleTitle, canManage, toast, fetchJson, regulationConfirm } = ns;
    const renderSavedSearches = (...args) => ns.renderSavedSearches?.(...args);
    const renderSearchResults = (...args) => ns.renderSearchResults?.(...args);
    const renderDocuments = (...args) => ns.renderDocuments?.(...args);
    const renderAiAnswer = (...args) => ns.renderAiAnswer?.(...args);
    const renderDetail = (...args) => ns.renderDetail?.(...args);
        function setBusy(busy, text = '') {
                        state.busy = !!busy;
                        document.querySelector('.regulations-panel')?.classList.toggle('is-busy', state.busy);
                        ns.syncDocumentSelection?.();
                        if (text) toast(text);
                    }

                    function focusFirstField(container) {
                        window.setTimeout(() => {
                            container?.querySelector('input, textarea, select, button')?.focus();
                        }, 0);
                    }

                    function openSearchDialog() {
                        const panel = document.getElementById('regulations-search-panel');
                        panel?.classList.remove('hidden');
                        state.matches = [];
                        state.hasSearched = false;
                        syncSearchControls();
                        renderSavedSearches();
                        renderSearchResults();
                        window.setTimeout(() => document.getElementById('regulations-query')?.focus(), 0);
                    }

                    function closeSearchDialog() {
                        document.getElementById('regulations-search-panel')?.classList.add('hidden');
                        state.matches = [];
                        state.hasSearched = false;
                        renderSearchResults();
                        renderDocuments();
                    }

                    function openDetailDialog() {
                        const panel = document.getElementById('regulations-detail-panel');
                        panel?.classList.remove('hidden');
                    }

                    function syncAiScopeControl() {
                        const control = document.getElementById('regulations-ai-scope');
                        if (!control) return;
                        const activeDocument = state.detail?.document;
                        const currentOption = control.querySelector('option[value="document"]');
                        if (currentOption) {
                            currentOption.disabled = !activeDocument?.id;
                            currentOption.textContent = activeDocument?.title
                                ? `当前法规：${String(activeDocument.title).slice(0, 28)}`
                                : '当前法规（请先打开法规）';
                        }
                        if (!activeDocument?.id && state.aiScope === 'document') state.aiScope = 'library';
                        control.value = state.aiScope;
                    }

                    function openAiDialog(scope = '') {
                        if (scope === 'document' && state.detail?.document?.id) state.aiScope = 'document';
                        const panel = document.getElementById('regulations-ai-panel');
                        panel?.classList.remove('hidden');
                        syncAiScopeControl();
                        renderAiAnswer();
                        renderSearchResults();
                        window.setTimeout(() => document.getElementById('regulations-ai-question')?.focus(), 0);
                    }

                    function closeInlineForms() {
                        document.getElementById('regulations-edit-form')?.classList.add('hidden');
                        document.getElementById('regulations-version-form')?.classList.add('hidden');
                    }

                    function closeDialogs() {
                        // 关闭问答弹窗即取消仍在传输的流，避免后台继续占用模型连接。
                        ns.stopRegulationAi?.({ silent: true });
                        document.getElementById('regulations-admin-panel')?.classList.add('hidden');
                        closeSearchDialog();
                        document.getElementById('regulations-import-result-panel')?.classList.add('hidden');
                        document.getElementById('regulations-batch-result-panel')?.classList.add('hidden');
                        ns.closeBatchEditDialog?.();
                        document.getElementById('regulations-compare-panel')?.classList.add('hidden');
                        document.getElementById('regulations-detail-panel')?.classList.add('hidden');
                        document.getElementById('regulations-ai-panel')?.classList.add('hidden');
                        document.getElementById('regulations-similar-panel')?.classList.add('hidden');
                        document.getElementById('regulations-graph-panel')?.classList.add('hidden');
                        document.getElementById('regulations-timeline-panel')?.classList.add('hidden');
                        document.getElementById('regulations-preview-panel')?.classList.add('hidden');
                        document.getElementById('regulations-annotation-panel')?.classList.add('hidden');
                        document.getElementById('regulations-access-log-panel')?.classList.add('hidden');
                        document.getElementById('regulations-ai-log-panel')?.classList.add('hidden');
                        document.getElementById('regulations-bookmarks-panel')?.classList.add('hidden');
                        document.getElementById('regulations-recycle-bin-panel')?.classList.add('hidden');
                        document.getElementById('regulations-quality-panel')?.classList.add('hidden');
                        document.getElementById('regulations-citation-governance-panel')?.classList.add('hidden');
                        document.getElementById('regulations-obligation-panel')?.classList.add('hidden');
                        document.getElementById('regulations-location-panel')?.classList.add('hidden');
                        document.getElementById('regulations-create-folder-panel')?.classList.add('hidden');
                        if (state.importJobsTimer) {
                            window.clearTimeout(state.importJobsTimer);
                            state.importJobsTimer = null;
                        }
                        closeInlineForms();
                    }

                    function collectForm(form) {
                        const data = new FormData(form);
                        return Object.fromEntries(data.entries());
                    }

                    function appendActiveFolderParams(params) {
                        const folder = state.activeFolder;
                        if (!folder) return;
                        if (folder.isUncategorized) params.set('uncategorized', 'true');
                        else if (folder.category) params.set('category', folder.category);
                    }

                    async function loadCategoryFolders() {
                        const params = new URLSearchParams();
                        if (canManage() && state.filters.includeArchived) params.set('includeArchived', 'true');
                        const data = await fetchJson(`${API}/category-folders${params.toString() ? `?${params.toString()}` : ''}`);
                        state.categoryFolders = Array.isArray(data.folders) ? data.folders : [];
                        state.total = state.categoryFolders.reduce((total, folder) => total + Number(folder.documentCount || 0), 0);
                        state.documents = [];
                        state.page = 1;
                        state.libraryView = 'folders';
                        state.activeFolder = null;
                        state.governancePending = false;
                        state.governanceScope = '';
                        state.batchMode = false;
                        state.selectedDocumentIds.clear();
                        state.selectedDocumentTitles.clear();
                        renderDocuments();
                    }

                    async function openCategoryFolder(folder) {
                        if (!folder) return;
                        state.libraryView = 'documents';
                        state.activeFolder = {
                            title: String(folder.title || '未分类'),
                            category: String(folder.category || ''),
                            isUncategorized: Boolean(folder.isUncategorized || !folder.category),
                            isCustom: Boolean(folder.isCustom),
                            documentCount: Number(folder.documentCount || folder.document_count || 0),
                            articleCount: Number(folder.articleCount || folder.article_count || 0),
                            effectiveCount: Number(folder.effectiveCount || folder.effective_count || 0),
                            needsReviewCount: Number(folder.needsReviewCount || folder.needs_review_count || 0),
                            latestUpdatedAt: folder.latestUpdatedAt || folder.latest_updated_at || ''
                        };
                        state.governancePending = false;
                        state.governanceScope = '';
                        state.page = 1;
                        state.selectedDocumentIds.clear();
                        state.selectedDocumentTitles.clear();
                        await loadDocuments({ keepActive: false, page: 1 });
                    }

                    function openCreateFolderDialog() {
                        const panel = document.getElementById('regulations-create-folder-panel');
                        const input = document.getElementById('regulations-new-folder-name');
                        const desc = document.getElementById('regulations-new-folder-desc');
                        if (!panel) return;
                        if (input) input.value = '';
                        if (desc) desc.value = '';
                        panel.classList.remove('hidden');
                        window.setTimeout(() => input?.focus(), 0);
                    }

                    function closeCreateFolderDialog() {
                        document.getElementById('regulations-create-folder-panel')?.classList.add('hidden');
                    }

                    async function createCategoryFolder({ name, description } = {}) {
                        const trimmed = String(name || '').trim();
                        if (!trimmed) {
                            toast('请输入分类目录名称', 'warning');
                            return;
                        }
                        setBusy(true);
                        try {
                            const resp = await fetchJson(`${API}/category-folders`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ name: trimmed, description: String(description || '').trim() })
                            });
                            toast(resp.message || '分类目录创建成功', 'success');
                            closeCreateFolderDialog();
                            setBusy(false);
                            await loadCategoryFolders();
                            ns.loadFacets?.();
                        } catch (e) {
                            setBusy(false);
                            toast(e.message || '创建分类目录失败', 'error');
                        }
                    }

                    async function deleteCategoryFolder(category) {
                        const targetCategory = String(category || '').trim();
                        if (!targetCategory) return;
                        const ok = await regulationConfirm('删除分类目录', `确定要删除分类目录「${targetCategory}」吗？\n该操作仅能删除没有关联法规文档的自定义分类。`);
                        if (!ok) return;
                        setBusy(true);
                        try {
                            const resp = await fetchJson(`${API}/category-folders/${encodeURIComponent(targetCategory)}`, {
                                method: 'DELETE'
                            });
                            toast(resp.message || '分类目录已删除', 'success');
                            setBusy(false);
                            await returnToCategoryFolders();
                            ns.loadFacets?.();
                        } catch (e) {
                            setBusy(false);
                            toast(e.message || '删除分类目录失败', 'error');
                        }
                    }

                    async function returnToCategoryFolders() {
                        if (state.busy) return;
                        if (state.libraryView === 'folders') {
                            toast('当前已在分类目录首页', 'info');
                            return;
                        }
                        if (state.batchMode) {
                            state.batchMode = false;
                            state.selectedDocumentIds.clear();
                            state.selectedDocumentTitles.clear();
                        }
                        await loadCategoryFolders();
                        toast('已返回分类目录', 'info');
                    }

                    async function loadDocuments({ keepActive = true, page = state.page } = {}) {
                        if (state.libraryView === 'folders') return await loadCategoryFolders();
                        const requestedPage = Math.max(Number(page) || 1, 1);
                        const pageSize = Math.max(Number(state.pageSize || REGULATIONS_PAGE_SIZE), 1);
                        const params = new URLSearchParams();
                        // 文档表格展示法规库目录，弹窗里的条文检索条件不应改写底层表格状态。
                        params.set('limit', String(pageSize));
                        params.set('offset', String((requestedPage - 1) * pageSize));
                        appendActiveFolderParams(params);
                        if (state.governanceScope && canManage()) params.set('governanceScope', state.governanceScope);
                        else if (state.governancePending && canManage()) params.set('governancePending', 'true');
                        const data = await fetchJson(`${API}/documents?${params.toString()}`);
                        const incoming = Array.isArray(data.data) ? data.data : [];
                        state.total = Number(data.total || 0);
                        state.pageSize = Math.max(Number(data.limit || pageSize), 1);
                        const totalPages = Math.max(Math.ceil(state.total / state.pageSize), 1);
                        if (!incoming.length && state.total > 0 && requestedPage > totalPages) {
                            state.page = totalPages;
                            return loadDocuments({ keepActive, page: totalPages });
                        }
                        // 批量处理允许跨页保留选择；页首复选框仅操作当前页。已删除或
                        // 无权访问的旧选择会由服务端返回逐项失败，不在翻页时静默抹除。
                        state.documents = incoming;
                        state.page = Math.min(requestedPage, totalPages);
                        const activeInPage = state.documents.some(doc => Number(doc.id) === Number(state.activeId));
                        if (!keepActive || !activeInPage) {
                            state.activeId = '';
                            state.detail = null;
                        } else if (state.detail?.document && Number(state.detail.document.id) !== Number(state.activeId)) {
                            state.detail = null;
                        }
                        renderDocuments();
                        renderDetail();
                        state.loaded = true;
                    }
                    async function loadDetail(id, versionId = '', effectiveAt = '') {
                        if (!id) return;
                        openDetailDialog();
                        const detailEl = document.getElementById('regulations-detail-body');
                        if (detailEl) PivotSafeHtml.setHtml(detailEl, '<div class="regulations-loading">正在加载法规详情…</div>');
                        const params = new URLSearchParams();
                        if (versionId) params.set('versionId', versionId);
                        if (effectiveAt) params.set('effectiveAt', effectiveAt);
                        const url = `${API}/documents/${encodeURIComponent(id)}${params.toString() ? `?${params.toString()}` : ''}`;
                        const data = await fetchJson(url);
                        state.activeId = data.detail?.document?.id || id;
                        state.detail = data.detail || null;
                        state.effectiveAt = effectiveAt || '';
                        renderDocuments();
                        renderDetail();
                        syncAiScopeControl();
                    }

                    // 跳转到指定条文并短暂高亮，便于在长文档里定位
                    function focusArticle(articleId) {
                        const target = document.getElementById(`regulation-article-${articleId}`);
                        if (!target) return;
                        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        target.classList.add('regulations-article-flash');
                        window.setTimeout(() => target.classList.remove('regulations-article-flash'), 1800);
                    }

                    function readSearchControls() {
                        state.query = document.getElementById('regulations-query')?.value.trim() || '';
                        const mode = document.getElementById('regulations-search-mode')?.value || state.searchMode;
                        state.searchMode = mode === 'keyword' ? 'keyword' : 'hybrid';
                        state.filters.category = document.getElementById('regulations-category-filter')?.value.trim() || '';
                        state.filters.issuingBody = document.getElementById('regulations-issuing-body-filter')?.value.trim() || '';
                        state.filters.jurisdiction = document.getElementById('regulations-jurisdiction-filter')?.value.trim() || '';
                        state.filters.status = document.getElementById('regulations-status-filter')?.value || '';
                        state.filters.includeArchived = !!document.getElementById('regulations-include-archived')?.checked;
                    }

                    function syncSearchControls() {
                        const query = document.getElementById('regulations-query');
                        const mode = document.getElementById('regulations-search-mode');
                        const category = document.getElementById('regulations-category-filter');
                        const issuingBody = document.getElementById('regulations-issuing-body-filter');
                        const jurisdiction = document.getElementById('regulations-jurisdiction-filter');
                        const status = document.getElementById('regulations-status-filter');
                        const includeArchived = document.getElementById('regulations-include-archived');
                        if (query) query.value = state.query || '';
                        if (mode) mode.value = state.searchMode === 'keyword' ? 'keyword' : 'hybrid';
                        if (category) category.value = state.filters.category || '';
                        if (issuingBody) issuingBody.value = state.filters.issuingBody || '';
                        if (jurisdiction) jurisdiction.value = state.filters.jurisdiction || '';
                        if (status) status.value = state.filters.status || '';
                        if (includeArchived) includeArchived.checked = !!state.filters.includeArchived;
                    }

                    async function fetchArticleMatches() {
                        const hasFilters = !!(state.filters.category || state.filters.issuingBody || state.filters.jurisdiction || state.filters.status);
                        if (!state.query && !hasFilters) return [];
                        const params = new URLSearchParams({ query: state.query, limit: '50' });
                        if (state.filters.category) params.set('category', state.filters.category);
                        if (state.filters.issuingBody) params.set('issuingBody', state.filters.issuingBody);
                        if (state.filters.jurisdiction) params.set('jurisdiction', state.filters.jurisdiction);
                        if (state.filters.status) params.set('status', state.filters.status);
                        if (canManage() && state.filters.includeArchived) params.set('includeArchived', 'true');
                        const endpoint = state.searchMode === 'keyword' ? 'documents/search' : 'search/hybrid';
                        const data = await fetchJson(`${API}/${endpoint}?${params.toString()}`);
                        return (Array.isArray(data.matches) ? data.matches : []).slice(0, 20);
                    }

                    async function runSearch() {
                        readSearchControls();
                        state.hasSearched = true;
                        try {
                            state.matches = await fetchArticleMatches();
                        } catch (err) {
                            console.warn('[regulations] 检索执行异常:', err);
                            toast(err.message || '检索失败，请稍后重试', 'warning');
                            state.matches = [];
                        }
                        renderSearchResults();
                    }
                    async function loadSavedSearches() {
                        try {
                            const data = await fetchJson(`${API}/saved-searches`);
                            state.savedSearches = Array.isArray(data.searches) ? data.searches : [];
                            renderSavedSearches();
                        } catch (_e) {
                            state.savedSearches = [];
                            renderSavedSearches();
                        }
                    }

                    function buildSavedSearchDefaultName() {
                        const parts = [state.query, state.filters.category, state.filters.issuingBody, state.filters.jurisdiction, state.filters.status]
                            .map(item => String(item || '').trim())
                            .filter(Boolean);
                        return parts.length ? parts.join(' / ').slice(0, 60) : '未命名预设';
                    }

                    async function saveCurrentSearch() {
                        readSearchControls();
                        if (!state.query && !state.filters.category && !state.filters.issuingBody && !state.filters.jurisdiction && !state.filters.status) {
                            toast('请先输入检索词或设置筛选条件', 'warning');
                            return;
                        }
                        const existingDuplicate = (state.savedSearches || []).find(item =>
                            String(item.query || '').trim() === String(state.query || '').trim() &&
                            String(item.category || '').trim() === String(state.filters.category || '').trim() &&
                            String(item.jurisdiction || '').trim() === String(state.filters.jurisdiction || '').trim()
                        );
                        if (existingDuplicate) {
                            toast(`已存在相同条件的常用检索预设「${existingDuplicate.name || '常用预设'}」，无需重复保存`, 'info');
                            return;
                        }
                        const fallback = buildSavedSearchDefaultName();
                        const name = typeof window.prompt === 'function'
                            ? window.prompt('保存为常用检索预设（输入预设名称以便后续一键快速筛选）：', fallback)
                            : fallback;
                        if (!String(name || '').trim()) return;
                        setBusy(true, '正在保存检索预设...');
                        try {
                            await fetchJson(`${API}/saved-searches`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                    name: String(name).trim(),
                                    query: state.query,
                                    category: state.filters.category,
                                    jurisdiction: state.filters.jurisdiction
                                })
                            });
                            toast('常用检索预设已保存', 'success');
                            await loadSavedSearches();
                        } catch (e) {
                            toast(e.message || '保存检索预设失败', 'error');
                        } finally {
                            setBusy(false);
                        }
                    }

                    async function applySavedSearch(searchId) {
                        const search = state.savedSearches.find(item => String(item.id) === String(searchId));
                        if (!search) return;
                        state.query = search.query || '';
                        state.filters.category = search.category || '';
                        state.filters.issuingBody = '';
                        state.filters.jurisdiction = search.jurisdiction || '';
                        state.filters.status = '';
                        syncSearchControls();
                        await runSearch();
                    }

                    async function deleteSavedSearch(searchId) {
                        if (!searchId) return;
                        try {
                            await fetchJson(`${API}/saved-searches/${encodeURIComponent(searchId)}`, { method: 'DELETE' });
                            state.savedSearches = state.savedSearches.filter(item => String(item.id) !== String(searchId));
                            renderSavedSearches();
                            toast('常用预设已删除', 'info');
                        } catch (e) {
                            toast(e.message || '删除预设失败', 'error');
                        }
                    }

                    function renderSimilarityScore(item) {
                        const score = Number(item?.similarity);
                        if (Number.isFinite(score) && score > 0) {
                            return `<em class="regulations-match-score">相似 ${Math.round(score * 100)}%</em>`;
                        }
                        return '<em class="regulations-match-score muted">降级推荐</em>';
                    }

                    function renderSimilarArticles(body, similar, articleId) {
                        if (!body) return;
                        const sourceArticle = state.detail?.articles?.find(article => String(article.id) === String(articleId));
                        PivotSafeHtml.setHtml(body, `
                            <div class="regulations-similar-source">
                                <strong>${esc(sourceArticle?.article_label || '当前条文')}</strong>
                                <span>${esc(cleanArticleTitle(sourceArticle?.article_title || ''))}</span>
                            </div>
                            <div class="regulations-similar-list">
                                ${similar.length ? similar.map(item => `
                                    <button class="regulations-match regulations-similar-match" type="button" data-regulation-match-doc="${esc(item.document_id)}" data-regulation-match-article="${esc(item.article_id)}">
                                        <strong>${esc(item.document_title || '未命名法规')}</strong>
                                        <span>${esc([item.article_label, item.article_title].filter(Boolean).join(' '))}${renderSimilarityScore(item)}</span>
                                        <p>${esc(item.excerpt || '')}</p>
                                    </button>
                                `).join('') : '<div class="regulations-empty compact">暂无相似条文</div>'}
                            </div>
                        `);
                    }

                    async function showSimilarArticles(articleId) {
                        const panel = document.getElementById('regulations-similar-panel');
                        const body = document.getElementById('regulations-similar-body');
                        if (!panel || !body) return;
                        panel.classList.remove('hidden');
                        PivotSafeHtml.setHtml(body, '<div class="regulations-loading">正在查找相似条文…</div>');
                        try {
                            const resp = await fetchJson(`${API}/articles/${encodeURIComponent(articleId)}/similar?limit=8`);
                            renderSimilarArticles(body, Array.isArray(resp.similar) ? resp.similar : [], articleId);
                        } catch (e) {
                            PivotSafeHtml.setHtml(body, `<div class="regulations-empty compact">${esc(e.message || '加载相似条文失败')}</div>`);
                        }
                    }

        Object.assign(ns, {
            setBusy,
            focusFirstField,
            openSearchDialog,
            closeSearchDialog,
            openDetailDialog,
            openAiDialog,
            syncAiScopeControl,
            closeInlineForms,
            closeDialogs,
            collectForm,
            loadDocuments,
            loadDetail,
            focusArticle,
            readSearchControls,
                        appendActiveFolderParams,
                        loadCategoryFolders,
                        openCategoryFolder,
                        returnToCategoryFolders,
                        openCreateFolderDialog,
                        closeCreateFolderDialog,
                        createCategoryFolder,
                        deleteCategoryFolder,
            syncSearchControls,
            fetchArticleMatches,
            runSearch,
            loadSavedSearches,
            buildSavedSearchDefaultName,
            saveCurrentSearch,
            applySavedSearch,
            deleteSavedSearch,
            renderSimilarityScore,
            renderSimilarArticles,
            showSimilarArticles,
            actionsCoreReady: true
        });
})();
