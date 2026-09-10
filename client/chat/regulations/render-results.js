(function () {
    const ns = window.Pivot.legacy.PivotRegulationsInternal;
    if (!ns) throw new Error('法规库核心模块未加载');
    if (ns.renderResultsReady) return;

    const { state, esc, highlightText, renderRichText } = ns;
            function getSearchModeLabel(mode = state.searchMode) {
                        return mode === 'keyword' ? '关键词' : '混合检索';
                    }

                    function renderMatchScore(match) {
                        const hybrid = Number(match?.hybridScore);
                        if (Number.isFinite(hybrid) && hybrid > 0) {
                            return `<em class="regulations-match-score">混合 ${Math.round(hybrid * 100)}%</em>`;
                        }
                        const vector = Number(match?.vectorScore);
                        if (Number.isFinite(vector) && vector > 0) {
                            return `<em class="regulations-match-score">语义 ${Math.round(vector * 100)}%</em>`;
                        }
                        if (state.searchMode === 'keyword') {
                            return '<em class="regulations-match-score muted">关键词</em>';
                        }
                        return '<em class="regulations-match-score muted">BM25 降级</em>';
                    }

                    function summarizeSavedSearch(search) {
                        const parts = [search.query, search.category, search.jurisdiction]
                            .map(item => String(item || '').trim())
                            .filter(Boolean);
                        return parts.length ? parts.join(' / ') : '全部法规';
                    }

                    function renderSavedSearches() {
                        const target = document.getElementById('regulations-saved-searches');
                        if (!target) return;
                        const searches = Array.isArray(state.savedSearches) ? state.savedSearches : [];
                        if (!searches.length) {
                            target.classList.add('hidden');
                            PivotSafeHtml.setHtml(target, '');
                            return;
                        }
                        target.classList.remove('hidden');
                        PivotSafeHtml.setHtml(target, `
                            <div class="regulations-saved-searches-head">
                                <strong>保存检索</strong>
                                <span>${searches.length} 项</span>
                            </div>
                            <div class="regulations-saved-search-list">
                                ${searches.map(search => `
                                    <div class="regulations-saved-search-item">
                                        <button class="regulations-saved-search-chip" type="button" data-regulation-saved-search="${esc(search.id)}">
                                            <strong>${esc(search.name || '未命名检索')}</strong>
                                            <span>${esc(summarizeSavedSearch(search))}</span>
                                        </button>
                                        <button class="regulations-saved-search-delete" type="button" data-regulation-delete-saved-search="${esc(search.id)}" aria-label="删除保存检索">删除</button>
                                    </div>
                                `).join('')}
                            </div>
                        `);
                    }

                    function renderSearchResults() {
                        const targets = Array.from(document.querySelectorAll('[data-regulations-search-results]'));
                        if (!targets.length) return;
                        const hasQuery = !!String(state.query || '').trim();
                        const hasMatches = Array.isArray(state.matches) && state.matches.length > 0;
                        const emptyText = hasQuery ? '暂无条文命中，已按文档列表展示相关法规' : '搜索后显示相关条文';
                        const modeText = state.query ? ` · ${getSearchModeLabel()}` : '';
                        const resultsHtml = `
                            <div class="regulations-section-head compact"><strong>条文命中</strong><span>${state.matches.length} 条${modeText}</span></div>
                            ${state.matches.map(match => `
                                <button class="regulations-match" type="button" data-regulation-match-doc="${esc(match.document_id)}" data-regulation-match-article="${esc(match.article_id)}">
                                    <strong>${esc(match.document_title || '未命名法规')}</strong>
                                    <span>${esc([match.article_label, match.article_title].filter(Boolean).join(' '))}${renderMatchScore(match)}</span>
                                    <p>${highlightText(match.excerpt || match.content || '', state.query)}</p>
                                </button>
                            `).join('') || `<div class="regulations-empty compact">${esc(emptyText)}</div>`}
                        `;
                        targets.forEach(target => {
                            target.classList.toggle('hidden', !hasQuery && !hasMatches);
                            PivotSafeHtml.setHtml(target, (!hasQuery && !hasMatches) ? '' : resultsHtml);
                        });
                    }
                    function renderAiAnswer() {
                        const target = document.getElementById('regulations-ai-answer');
                        if (!target) return;

                        if (!state.aiTurns.length && !state.aiBusy) {
                            PivotSafeHtml.setHtml(target, `
                                <div class="regulations-ai-empty">
                                    <div class="regulations-ai-empty-icon" aria-hidden="true">
                                        <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                                            <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
                                            <circle cx="12" cy="12" r="3"></circle>
                                        </svg>
                                    </div>
                                    <h4 class="regulations-ai-empty-title">法规知识智能问答</h4>
                                    <p class="regulations-ai-empty-desc">基于当前法规库全文检索匹配的法条回答，智能提炼结论并附带权威条款出处与依据。</p>
                                    <div class="regulations-ai-samples">
                                        <div class="regulations-ai-samples-label">
                                            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                                                <path d="M9 18h6"></path>
                                                <path d="M10 22h4"></path>
                                                <path d="M12 2a7 7 0 0 0-7 7c0 2.38 1.19 4.47 3 5.74V17a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1v-2.26c1.81-1.27 3-3.36 3-5.74a7 7 0 0 0-7-7z"></path>
                                            </svg>
                                            <span>推荐快捷提问：</span>
                                        </div>
                                        <div class="regulations-ai-chips">
                                            <button type="button" class="btn-secondary regulations-ai-chip" data-regulations-ai-sample="该制度对审批流程有哪些具体要求？">
                                                <span class="regulations-ai-chip-bullet" aria-hidden="true">
                                                    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                                        <path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z"></path>
                                                    </svg>
                                                </span>
                                                <span>该制度对审批流程有哪些具体要求？</span>
                                            </button>
                                            <button type="button" class="btn-secondary regulations-ai-chip" data-regulations-ai-sample="发生违规行为有哪些处罚措施与追责标准？">
                                                <span class="regulations-ai-chip-bullet" aria-hidden="true">
                                                    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                                        <path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z"></path>
                                                    </svg>
                                                </span>
                                                <span>发生违规行为有哪些处罚措施与追责标准？</span>
                                            </button>
                                            <button type="button" class="btn-secondary regulations-ai-chip" data-regulations-ai-sample="本法规的适用范围与生效执行时间？">
                                                <span class="regulations-ai-chip-bullet" aria-hidden="true">
                                                    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                                        <path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z"></path>
                                                    </svg>
                                                </span>
                                                <span>本法规的适用范围与生效执行时间？</span>
                                            </button>
                                            <button type="button" class="btn-secondary regulations-ai-chip" data-regulations-ai-sample="涉及哪些跨部门协作与定期报送节点？">
                                                <span class="regulations-ai-chip-bullet" aria-hidden="true">
                                                    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                                        <path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z"></path>
                                                    </svg>
                                                </span>
                                                <span>涉及哪些跨部门协作与定期报送节点？</span>
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            `);
                            return;
                        }

                        const turnsHtml = state.aiTurns.map((turn, turnIndex) => {
                            const sources = Array.isArray(turn.sources) ? turn.sources : [];
                            const direct = sources.filter(s => !s.viaLink);
                            const related = sources.filter(s => s.viaLink);
                            const renderSourceBtn = source => `
                                <button class="btn-secondary regulations-ai-source${source.viaLink ? ' viaLink' : ''}" type="button" data-regulation-match-doc="${esc(source.documentId)}" data-regulation-match-article="${esc(source.articleId)}">
                                    <span class="regulations-ai-source-label">
                                        <span class="regulations-ai-source-name">${esc(source.label || '相关条文')}</span>
                                        ${source.relation ? `<em class="regulations-ai-source-rel">${esc(source.relation)}</em>` : ''}
                                    </span>
                                    ${source.excerpt ? `<span class="regulations-ai-source-excerpt">${esc(source.excerpt)}</span>` : ''}
                                </button>
                            `;
                            const groupsHtml = sources.length ? `
                                <div class="regulations-ai-sources">
                                    ${direct.length ? `
                                        <div class="regulations-ai-sources-head">
                                            <span class="regulations-ai-sources-title">直接命中条文</span>
                                            <span class="regulations-ai-sources-count">${direct.length}</span>
                                        </div>
                                        <div class="regulations-ai-sources-list">${direct.map(renderSourceBtn).join('')}</div>
                                    ` : ''}
                                    ${related.length ? `
                                        <div class="regulations-ai-sources-head">
                                            <span class="regulations-ai-sources-title">关联条文</span>
                                            <span class="regulations-ai-sources-count">${related.length}</span>
                                        </div>
                                        <div class="regulations-ai-sources-list">${related.map(renderSourceBtn).join('')}</div>
                                    ` : ''}
                                </div>
                            ` : '';
                            return `
                                <div class="regulations-ai-turn">
                                    <div class="regulations-ai-question">
                                        <div class="regulations-ai-question-bubble">${esc(turn.question)}</div>
                                    </div>
                                    <div class="regulations-ai-card">
                                        <div class="regulations-ai-card-header">
                                            <span class="regulations-ai-card-avatar" aria-hidden="true">AI</span>
                                            <strong class="regulations-ai-card-title">法规问答答复</strong>
                                            <span class="regulations-ai-card-tag">基于条文检索</span>
                                        </div>
                                        <div class="regulations-article-body regulations-ai-card-body">${renderRichText(turn.answer)}</div>
                                        ${groupsHtml}
                                        <div class="regulations-ai-turn-actions">
                                            <button class="btn-secondary regulations-ai-copy-btn" type="button" data-regulations-ai-copy="${turnIndex}" title="复制此条回答">
                                                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                                                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                                                </svg>
                                                <span>复制回答</span>
                                            </button>
                                            <button class="regulations-ai-export-btn" type="button" data-regulation-export-report="${turnIndex}">
                                                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                                                    <polyline points="7 10 12 15 17 10"></polyline>
                                                    <line x1="12" y1="15" x2="12" y2="3"></line>
                                                </svg>
                                                <span>导出报告</span>
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            `;
                        }).join('');

                        const loadingHtml = state.aiBusy ? `
                            <div class="regulations-ai-turn regulations-ai-turn-loading">
                                <div class="regulations-ai-card regulations-ai-loading-card">
                                    <div class="regulations-ai-card-header">
                                        <span class="regulations-ai-card-avatar" aria-hidden="true">AI</span>
                                        <strong class="regulations-ai-card-title">法规问答答复</strong>
                                        <span class="regulations-ai-card-tag">分析生成中…</span>
                                    </div>
                                    <div class="regulations-ai-loading-indicator">
                                        <div class="regulations-ai-pulse-wave" aria-hidden="true">
                                            <span class="regulations-ai-pulse-dot"></span>
                                            <span class="regulations-ai-pulse-dot"></span>
                                            <span class="regulations-ai-pulse-dot"></span>
                                        </div>
                                        <span class="regulations-ai-loading-text">正在检索法规条文并分析生成回答…</span>
                                    </div>
                                </div>
                            </div>
                        ` : '';

                        PivotSafeHtml.setHtml(target, turnsHtml + loadingHtml);
                        window.requestAnimationFrame(() => {
                            target.scrollTop = target.scrollHeight;
                        });
                    }

        Object.assign(ns, {
            getSearchModeLabel,
            renderMatchScore,
            summarizeSavedSearch,
            renderSavedSearches,
            renderSearchResults,
            renderAiAnswer,
            renderResultsReady: true
        });
})();
