(function () {
    const ns = window.Pivot.legacy.PivotRegulationsInternal;
    if (!ns) throw new Error('法规库核心模块未加载');
    if (ns.actionsBookmarksReady) return;

    const { API, state, esc, toast, fetchJson, fmtDate } = ns;

    async function toggleRegulationSubscription(documentId) {
        if (!documentId) return;
        try {
            const subscriptions = await fetchJson(`${API}/subscriptions?documentId=${encodeURIComponent(documentId)}`);
            const active = Array.isArray(subscriptions.subscriptions) && subscriptions.subscriptions.length > 0;
            if (active) {
                await fetchJson(`${API}/documents/${encodeURIComponent(documentId)}/subscriptions`, { method: 'DELETE' });
                toast('已取消关注法规更新', 'success');
            } else {
                await fetchJson(`${API}/documents/${encodeURIComponent(documentId)}/subscriptions`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ approvedOnly: true })
                });
                toast('已关注审核通过的法规更新', 'success');
            }
            const button = document.querySelector(`[data-regulation-subscribe="${String(documentId).replace(/"/g, '\\"')}"]`);
            if (button) button.textContent = active ? '关注更新' : '取消关注';
        } catch (error) {
            toast(error.message || '关注法规更新失败', 'error');
        }
    }

    async function toggleRegulationBookmark(documentId) {
        if (!documentId) return;
        try {
            const data = await fetchJson(`${API}/bookmarks?documentId=${encodeURIComponent(documentId)}`);
            const existing = Array.isArray(data.bookmarks) ? data.bookmarks[0] : null;
            if (existing?.id) {
                await fetchJson(`${API}/bookmarks/${encodeURIComponent(existing.id)}`, { method: 'DELETE' });
                toast('已取消收藏法规', 'success');
            } else {
                await fetchJson(`${API}/documents/${encodeURIComponent(documentId)}/bookmarks`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({})
                });
                toast('已收藏法规，可在“我的收藏”中设置专题', 'success');
            }
            const button = document.querySelector(`[data-regulation-bookmark="${String(documentId).replace(/"/g, '\\"')}"]`);
            if (button) button.textContent = existing?.id ? '收藏法规' : '取消收藏';
        } catch (error) {
            toast(error.message || '更新法规收藏失败', 'error');
        }
    }

    function renderRegulationBookmarksView() {
        const body = document.getElementById('regulations-bookmarks-body');
        if (!body) return;
        const bookmarks = Array.isArray(state.regulationBookmarks) ? state.regulationBookmarks : [];
        PivotSafeHtml.setHtml(body, renderRegulationBookmarks(bookmarks));
    }

    function renderRegulationBookmarks(bookmarks) {
        if (!bookmarks.length) {
            return `
                <div class="regulations-bookmarks-empty">
                    <div class="regulations-bookmarks-empty-icon" aria-hidden="true">
                        <svg viewBox="0 0 24 24" width="42" height="42" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path>
                        </svg>
                    </div>
                    <h4>暂无法规收藏</h4>
                    <p>在查看任意法规正文详情时，点击顶部的「收藏法规」按钮即可收录到此处。收藏内容仅对当前账号可见，并支持按专题归类整理。</p>
                </div>
            `;
        }

        const topicCounts = new Map();
        let untaggedCount = 0;
        bookmarks.forEach(item => {
            const t = (item.topic || '').trim();
            if (t) {
                topicCounts.set(t, (topicCounts.get(t) || 0) + 1);
            } else {
                untaggedCount++;
            }
        });

        const activeTopic = state.bookmarkActiveTopic || '';
        const searchQuery = (state.bookmarkSearchQuery || '').trim().toLowerCase();

        const filtered = bookmarks.filter(item => {
            const itemTopic = (item.topic || '').trim();
            if (activeTopic === '__untagged__') {
                if (itemTopic) return false;
            } else if (activeTopic) {
                if (itemTopic !== activeTopic) return false;
            }
            if (searchQuery) {
                const title = (item.document_title || '').toLowerCase();
                const category = (item.category || '').toLowerCase();
                const body = (item.issuing_body || '').toLowerCase();
                const topic = itemTopic.toLowerCase();
                if (!title.includes(searchQuery) && !category.includes(searchQuery) && !body.includes(searchQuery) && !topic.includes(searchQuery)) {
                    return false;
                }
            }
            return true;
        });

        const topicsArray = Array.from(topicCounts.entries());

        return `
            <div class="regulations-bookmarks-toolbar">
                <div class="regulations-bookmarks-topics-wrap">
                    <span class="regulations-bookmarks-topics-label">
                        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>
                        </svg>
                        <span>专题：</span>
                    </span>
                    <div class="regulations-bookmarks-topic-chips">
                        <button type="button" class="btn-secondary regulations-bookmarks-topic-chip ${!activeTopic ? 'active' : ''}" data-regulation-bookmark-topic-filter="">
                            全部 (${bookmarks.length})
                        </button>
                        ${topicsArray.map(([t, count]) => `
                            <button type="button" class="btn-secondary regulations-bookmarks-topic-chip ${activeTopic === t ? 'active' : ''}" data-regulation-bookmark-topic-filter="${esc(t)}">
                                ${esc(t)} (${count})
                            </button>
                        `).join('')}
                        ${untaggedCount > 0 ? `
                            <button type="button" class="btn-secondary regulations-bookmarks-topic-chip ${activeTopic === '__untagged__' ? 'active' : ''}" data-regulation-bookmark-topic-filter="__untagged__">
                                未设专题 (${untaggedCount})
                            </button>
                        ` : ''}
                    </div>
                </div>
                <div class="regulations-bookmarks-search-box">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="regulations-bookmarks-search-icon" aria-hidden="true">
                        <circle cx="11" cy="11" r="8"></circle>
                        <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
                    </svg>
                    <input type="text" class="form-input regulations-bookmarks-search-input" placeholder="筛选法规名称或专题..." value="${esc(state.bookmarkSearchQuery || '')}" data-regulation-bookmark-search>
                </div>
            </div>
            <div class="regulations-bookmarks-meta-bar">
                <div class="regulations-bookmarks-count-info">
                    <span>已收藏 <strong>${bookmarks.length}</strong> 部法规</span>
                    ${(activeTopic || searchQuery) ? `<span class="regulations-bookmarks-count-sub">（当前匹配 <strong>${filtered.length}</strong> 部）</span>` : ''}
                </div>
                <span class="regulations-bookmarks-tip">点击法规名称或「打开法规」即可直达正文</span>
            </div>
            ${filtered.length === 0 ? `
                <div class="regulations-bookmarks-empty compact">
                    <p>未找到符合条件的收藏法规${activeTopic ? `（专题：${activeTopic === '__untagged__' ? '未设专题' : activeTopic}）` : ''}${searchQuery ? `（关键词：${searchQuery}）` : ''}。</p>
                    <button type="button" class="btn-secondary regulations-bookmarks-clear-filter-btn" data-regulation-bookmark-topic-filter="">清除筛选条件</button>
                </div>
            ` : `
                <div class="regulations-bookmark-list">
                    ${filtered.map(item => `
                        <article class="regulations-bookmark-card" data-bookmark-id="${esc(item.id)}">
                            <div class="regulations-bookmark-card-main">
                                <div class="regulations-bookmark-card-header">
                                    <div class="regulations-bookmark-title-group">
                                        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="regulations-bookmark-doc-icon" aria-hidden="true">
                                            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                                            <polyline points="14 2 14 8 20 8"></polyline>
                                            <line x1="16" y1="13" x2="8" y2="13"></line>
                                            <line x1="16" y1="17" x2="8" y2="17"></line>
                                        </svg>
                                        <button type="button" class="btn-secondary regulations-bookmark-title-btn" data-regulation-bookmark-open="${esc(item.document_id)}" title="点击查看法规正文详情">
                                            ${esc(item.document_title || '未命名法规')}
                                        </button>
                                        ${item.category ? `<span class="regulations-bookmark-badge category">${esc(item.category)}</span>` : ''}
                                        ${item.jurisdiction ? `<span class="regulations-bookmark-badge jurisdiction">${esc(item.jurisdiction)}</span>` : ''}
                                    </div>
                                    <button type="button" class="btn-secondary regulations-bookmark-open-btn" data-regulation-bookmark-open="${esc(item.document_id)}" title="查看该法规正文详情">
                                        <span>打开法规</span>
                                        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                                            <polyline points="9 18 15 12 9 6"></polyline>
                                        </svg>
                                    </button>
                                </div>
                                <div class="regulations-bookmark-meta-row">
                                    ${item.issuing_body ? `
                                        <span class="regulations-bookmark-meta-item">
                                            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                                                <path d="M3 21h18"></path>
                                                <path d="M5 21V7l8-4v18"></path>
                                                <path d="M19 21V11l-6-3"></path>
                                            </svg>
                                            <span>${esc(item.issuing_body)}</span>
                                        </span>
                                    ` : ''}
                                    ${item.current_version_label ? `
                                        <span class="regulations-bookmark-meta-item">
                                            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                                                <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
                                                <line x1="16" y1="2" x2="16" y2="6"></line>
                                                <line x1="8" y1="2" x2="8" y2="6"></line>
                                                <line x1="3" y1="10" x2="21" y2="10"></line>
                                            </svg>
                                            <span>${esc(item.current_version_label)}</span>
                                        </span>
                                    ` : ''}
                                    ${item.created_at ? `
                                        <span class="regulations-bookmark-meta-item text-muted">
                                            <span>收藏于 ${esc(fmtDate(item.created_at))}</span>
                                        </span>
                                    ` : ''}
                                </div>
                            </div>
                            <div class="regulations-bookmark-card-footer">
                                <div class="regulations-bookmark-topic-box">
                                    <div class="regulations-bookmark-topic-label">
                                        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                                            <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"></path>
                                            <circle cx="7" cy="7" r="1"></circle>
                                        </svg>
                                        <span>所属专题：</span>
                                    </div>
                                    <div class="regulations-bookmark-topic-input-wrap">
                                        <input class="form-input regulations-bookmark-topic-input" data-regulation-bookmark-topic="${esc(item.id)}" value="${esc(item.topic || '')}" maxlength="80" placeholder="如 人事、采购、财务、合规">
                                        <button type="button" class="btn-secondary regulations-bookmark-save-btn" data-regulation-bookmark-save="${esc(item.id)}" data-regulation-bookmark-document="${esc(item.document_id)}" title="保存此法规的专题标签">
                                            保存专题
                                        </button>
                                    </div>
                                    <div class="regulations-bookmark-quick-tags">
                                        <span class="regulations-bookmark-quick-label">常用：</span>
                                        <button type="button" class="btn-secondary regulations-bookmark-quick-tag" data-regulation-quick-topic="合规" data-target-id="${esc(item.id)}" data-target-doc="${esc(item.document_id)}">合规</button>
                                        <button type="button" class="btn-secondary regulations-bookmark-quick-tag" data-regulation-quick-topic="采购" data-target-id="${esc(item.id)}" data-target-doc="${esc(item.document_id)}">采购</button>
                                        <button type="button" class="btn-secondary regulations-bookmark-quick-tag" data-regulation-quick-topic="财务" data-target-id="${esc(item.id)}" data-target-doc="${esc(item.document_id)}">财务</button>
                                        <button type="button" class="btn-secondary regulations-bookmark-quick-tag" data-regulation-quick-topic="人事" data-target-id="${esc(item.id)}" data-target-doc="${esc(item.document_id)}">人事</button>
                                    </div>
                                </div>
                                <div class="regulations-bookmark-delete-wrap">
                                    <button type="button" class="btn-secondary regulations-bookmark-delete-btn" data-regulation-bookmark-delete="${esc(item.id)}" title="从我的法规收藏中取消收藏此法规">
                                        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                                            <polyline points="3 6 5 6 21 6"></polyline>
                                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                                        </svg>
                                        <span>取消收藏</span>
                                    </button>
                                </div>
                            </div>
                        </article>
                    `).join('')}
                </div>
            `}
        `;
    }

    async function showRegulationBookmarks() {
        const panel = document.getElementById('regulations-bookmarks-panel');
        const body = document.getElementById('regulations-bookmarks-body');
        if (!panel || !body) return;
        panel.classList.remove('hidden');
        PivotSafeHtml.setHtml(body, '<div class="regulations-loading">正在读取收藏法规…</div>');
        try {
            const data = await fetchJson(`${API}/bookmarks`);
            state.regulationBookmarks = Array.isArray(data.bookmarks) ? data.bookmarks : [];
            state.bookmarkActiveTopic = '';
            state.bookmarkSearchQuery = '';
            renderRegulationBookmarksView();
        } catch (error) {
            PivotSafeHtml.setHtml(body, `<div class="regulations-empty compact">${esc(error.message || '加载收藏法规失败')}</div>`);
        }
    }

    function handleBookmarkTopicFilter(topic) {
        state.bookmarkActiveTopic = topic || '';
        renderRegulationBookmarksView();
    }

    function handleBookmarkSearch(query) {
        state.bookmarkSearchQuery = query || '';
        renderRegulationBookmarksView();
    }

    async function saveRegulationBookmarkTopic(bookmarkId, documentId, customTopic = null) {
        let topicVal = customTopic;
        if (topicVal === null) {
            const field = document.querySelector(`[data-regulation-bookmark-topic="${String(bookmarkId).replace(/"/g, '\\"')}"]`);
            if (!field) return;
            topicVal = field.value.trim();
        }
        if (!bookmarkId || !documentId) return;
        try {
            await fetchJson(`${API}/documents/${encodeURIComponent(documentId)}/bookmarks`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ topic: topicVal })
            });
            toast('收藏专题已保存', 'success');
            if (Array.isArray(state.regulationBookmarks)) {
                const item = state.regulationBookmarks.find(b => String(b.id) === String(bookmarkId));
                if (item) item.topic = topicVal;
            }
            renderRegulationBookmarksView();
        } catch (error) {
            toast(error.message || '保存收藏专题失败', 'error');
        }
    }

    async function deleteRegulationBookmark(bookmarkId) {
        if (!bookmarkId) return;
        try {
            await fetchJson(`${API}/bookmarks/${encodeURIComponent(bookmarkId)}`, { method: 'DELETE' });
            toast('已取消收藏法规', 'success');
            if (Array.isArray(state.regulationBookmarks)) {
                state.regulationBookmarks = state.regulationBookmarks.filter(b => String(b.id) !== String(bookmarkId));
            }
            renderRegulationBookmarksView();
        } catch (error) {
            toast(error.message || '取消收藏失败', 'error');
        }
    }

    Object.assign(ns, {
        toggleRegulationSubscription,
        toggleRegulationBookmark,
        renderRegulationBookmarks,
        renderRegulationBookmarksView,
        handleBookmarkTopicFilter,
        handleBookmarkSearch,
        showRegulationBookmarks,
        saveRegulationBookmarkTopic,
        deleteRegulationBookmark,
        actionsBookmarksReady: true
    });
})();
