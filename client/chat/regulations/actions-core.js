/* eslint-disable no-undef -- Split regulations modules resolve names through PivotRegulationsInternal. */
(function () {
    const ns = window.PivotRegulationsInternal;
    if (!ns) throw new Error('Pivot regulations core is not loaded');
    if (ns.actionsCoreReady) return;
    with (ns) {
        function setBusy(busy, text = '') {
                        state.busy = !!busy;
                        document.querySelector('.regulations-panel')?.classList.toggle('is-busy', state.busy);
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
                        syncSearchControls();
                        renderSavedSearches();
                        renderSearchResults();
                        window.setTimeout(() => document.getElementById('regulations-query')?.focus(), 0);
                    }

                    function closeSearchDialog() {
                        document.getElementById('regulations-search-panel')?.classList.add('hidden');
                        renderDocuments();
                    }

                    function openDetailDialog() {
                        const panel = document.getElementById('regulations-detail-panel');
                        panel?.classList.remove('hidden');
                    }

                    function openAiDialog() {
                        const panel = document.getElementById('regulations-ai-panel');
                        panel?.classList.remove('hidden');
                        renderAiAnswer();
                        renderSearchResults();
                        window.setTimeout(() => document.getElementById('regulations-ai-question')?.focus(), 0);
                    }

                    function closeInlineForms() {
                        document.getElementById('regulations-edit-form')?.classList.add('hidden');
                        document.getElementById('regulations-version-form')?.classList.add('hidden');
                    }

                    function closeDialogs() {
                        document.getElementById('regulations-admin-panel')?.classList.add('hidden');
                        document.getElementById('regulations-search-panel')?.classList.add('hidden');
                        document.getElementById('regulations-import-result-panel')?.classList.add('hidden');
                        document.getElementById('regulations-compare-panel')?.classList.add('hidden');
                        document.getElementById('regulations-detail-panel')?.classList.add('hidden');
                        document.getElementById('regulations-ai-panel')?.classList.add('hidden');
                        document.getElementById('regulations-similar-panel')?.classList.add('hidden');
                        document.getElementById('regulations-graph-panel')?.classList.add('hidden');
                        document.getElementById('regulations-timeline-panel')?.classList.add('hidden');
                        document.getElementById('regulations-preview-panel')?.classList.add('hidden');
                        document.getElementById('regulations-annotation-panel')?.classList.add('hidden');
                        closeInlineForms();
                    }

                    function collectForm(form) {
                        const data = new FormData(form);
                        return Object.fromEntries(data.entries());
                    }

                    async function loadDocuments({ keepActive = true, page = state.page } = {}) {
                        const requestedPage = Math.max(Number(page) || 1, 1);
                        const pageSize = Math.max(Number(state.pageSize || REGULATIONS_PAGE_SIZE), 1);
                        const params = new URLSearchParams();
                        // 文档表格展示法规库目录，弹窗里的条文检索条件不应改写底层表格状态。
                        params.set('limit', String(pageSize));
                        params.set('offset', String((requestedPage - 1) * pageSize));
                        const data = await fetchJson(`${API}/documents?${params.toString()}`);
                        const incoming = Array.isArray(data.data) ? data.data : [];
                        state.total = Number(data.total || 0);
                        state.pageSize = Math.max(Number(data.limit || pageSize), 1);
                        const totalPages = Math.max(Math.ceil(state.total / state.pageSize), 1);
                        if (!incoming.length && state.total > 0 && requestedPage > totalPages) {
                            state.page = totalPages;
                            return loadDocuments({ keepActive, page: totalPages });
                        }
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
                    async function loadDetail(id, versionId = '') {
                        if (!id) return;
                        openDetailDialog();
                        const detailEl = document.getElementById('regulations-detail-body');
                        if (detailEl) PivotSafeHtml.setHtml(detailEl, '<div class="regulations-loading">正在加载法规详情…</div>');
                        const params = new URLSearchParams();
                        if (versionId) params.set('versionId', versionId);
                        const url = `${API}/documents/${encodeURIComponent(id)}${params.toString() ? `?${params.toString()}` : ''}`;
                        const data = await fetchJson(url);
                        state.activeId = data.detail?.document?.id || id;
                        state.detail = data.detail || null;
                        renderDocuments();
                        renderDetail();
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
                        state.filters.jurisdiction = document.getElementById('regulations-jurisdiction-filter')?.value.trim() || '';
                        state.filters.includeArchived = !!document.getElementById('regulations-include-archived')?.checked;
                    }

                    function syncSearchControls() {
                        const query = document.getElementById('regulations-query');
                        const mode = document.getElementById('regulations-search-mode');
                        const category = document.getElementById('regulations-category-filter');
                        const jurisdiction = document.getElementById('regulations-jurisdiction-filter');
                        const includeArchived = document.getElementById('regulations-include-archived');
                        if (query) query.value = state.query || '';
                        if (mode) mode.value = state.searchMode === 'keyword' ? 'keyword' : 'hybrid';
                        if (category) category.value = state.filters.category || '';
                        if (jurisdiction) jurisdiction.value = state.filters.jurisdiction || '';
                        if (includeArchived) includeArchived.checked = !!state.filters.includeArchived;
                    }

                    function matchPassesActiveFilters(match) {
                        const category = String(state.filters.category || '').trim().toLowerCase();
                        const jurisdiction = String(state.filters.jurisdiction || '').trim().toLowerCase();
                        if (category && !String(match.category || '').toLowerCase().includes(category)) return false;
                        if (jurisdiction && !String(match.jurisdiction || '').toLowerCase().includes(jurisdiction)) return false;
                        return true;
                    }

                    async function fetchArticleMatches() {
                        if (!state.query) return [];
                        const params = new URLSearchParams({ query: state.query, limit: '50' });
                        if (canManage() && state.filters.includeArchived) params.set('includeArchived', 'true');
                        const endpoint = state.searchMode === 'keyword' ? 'documents/search' : 'search/hybrid';
                        const data = await fetchJson(`${API}/${endpoint}?${params.toString()}`);
                        return (Array.isArray(data.matches) ? data.matches : [])
                            .filter(matchPassesActiveFilters)
                            .slice(0, 20);
                    }

                    async function runSearch() {
                        readSearchControls();
                        state.matches = state.query ? await fetchArticleMatches() : [];
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
                        const parts = [state.query, state.filters.category, state.filters.jurisdiction]
                            .map(item => String(item || '').trim())
                            .filter(Boolean);
                        return parts.length ? parts.join(' / ').slice(0, 60) : '全部法规';
                    }

                    async function saveCurrentSearch() {
                        readSearchControls();
                        if (!state.query && !state.filters.category && !state.filters.jurisdiction) {
                            toast('请先输入检索词或筛选条件', 'warning');
                            return;
                        }
                        const fallback = buildSavedSearchDefaultName();
                        const name = typeof window.prompt === 'function'
                            ? window.prompt('保存为常用检索', fallback)
                            : fallback;
                        if (!String(name || '').trim()) return;
                        setBusy(true, '正在保存检索...');
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
                            toast('检索已保存', 'success');
                            await loadSavedSearches();
                        } catch (e) {
                            toast(e.message || '保存检索失败', 'error');
                        } finally {
                            setBusy(false);
                        }
                    }

                    async function applySavedSearch(searchId) {
                        const search = state.savedSearches.find(item => String(item.id) === String(searchId));
                        if (!search) return;
                        state.query = search.query || '';
                        state.filters.category = search.category || '';
                        state.filters.jurisdiction = search.jurisdiction || '';
                        syncSearchControls();
                        await runSearch();
                    }

                    async function deleteSavedSearch(searchId) {
                        if (!searchId) return;
                        if (!(await regulationConfirm('删除保存检索', '确定删除这个保存检索吗？'))) return;
                        setBusy(true, '正在删除保存检索...');
                        try {
                            await fetchJson(`${API}/saved-searches/${encodeURIComponent(searchId)}`, { method: 'DELETE' });
                            state.savedSearches = state.savedSearches.filter(item => String(item.id) !== String(searchId));
                            renderSavedSearches();
                            toast('保存检索已删除', 'success');
                        } catch (e) {
                            toast(e.message || '删除保存检索失败', 'error');
                        } finally {
                            setBusy(false);
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
            closeInlineForms,
            closeDialogs,
            collectForm,
            loadDocuments,
            loadDetail,
            focusArticle,
            readSearchControls,
            syncSearchControls,
            matchPassesActiveFilters,
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
    }
})();
