/* eslint-disable no-undef -- Split regulations modules resolve names through PivotRegulationsInternal. */
(function () {
    const ns = window.PivotRegulationsInternal;
    if (!ns) throw new Error('Pivot regulations core is not loaded');
    if (ns.renderResultsReady) return;
    with (ns) {
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
                        if (state.aiBusy) {
                            PivotSafeHtml.setHtml(target, '<div class="regulations-loading">正在生成回答…</div>');
                            return;
                        }
                        if (!state.aiTurns.length) {
                            PivotSafeHtml.setHtml(target, '<div class="regulations-empty compact">AI 回答会显示在这里</div>');
                            return;
                        }
                        PivotSafeHtml.setHtml(target, state.aiTurns.map((turn, turnIndex) => {
                            const sources = Array.isArray(turn.sources) ? turn.sources : [];
                            const direct = sources.filter(s => !s.viaLink);
                            const related = sources.filter(s => s.viaLink);
                            const renderSourceBtn = source => `
                                <button class="regulations-ai-source${source.viaLink ? ' viaLink' : ''}" type="button" data-regulation-match-doc="${esc(source.documentId)}" data-regulation-match-article="${esc(source.articleId)}">
                                    <span class="regulations-ai-source-label">${esc(source.label || '相关条文')}${source.relation ? `<em class="regulations-ai-source-rel">${esc(source.relation)}</em>` : ''}</span>
                                    ${source.excerpt ? `<span class="regulations-ai-source-excerpt">${esc(source.excerpt)}</span>` : ''}
                                </button>
                            `;
                            const groupsHtml = sources.length ? `
                                <div class="regulations-ai-sources">
                                    ${direct.length ? `
                                        <div class="regulations-ai-sources-head">直接命中条文 · ${direct.length}</div>
                                        ${direct.map(renderSourceBtn).join('')}
                                    ` : ''}
                                    ${related.length ? `
                                        <div class="regulations-ai-sources-head">关联条文 · ${related.length}</div>
                                        ${related.map(renderSourceBtn).join('')}
                                    ` : ''}
                                </div>
                            ` : '';
                            return `
                                <div class="regulations-ai-turn">
                                    <div class="regulations-ai-question">${esc(turn.question)}</div>
                                    <div class="regulations-ai-card">
                                        <div class="regulations-article-body">${renderRichText(turn.answer)}</div>
                                        ${groupsHtml}
                                        <div class="regulations-ai-turn-actions">
                                            <button class="regulations-ai-export-btn" type="button" data-regulation-export-report="${turnIndex}">导出报告</button>
                                        </div>
                                    </div>
                                </div>
                            `;
                        }).join(''));
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
    }
})();
