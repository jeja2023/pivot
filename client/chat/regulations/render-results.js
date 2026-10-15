(function () {
    const ns = window.Pivot.legacy.PivotRegulationsInternal;
    if (!ns) throw new Error('法规库核心模块未加载');
    if (ns.renderResultsReady) return;

    const { state, esc, highlightText, renderRichText, stripMarkdownFormatting, renderAiCardAnswer } = ns;
            function getSearchModeLabel(mode = state.searchMode) {
                        return mode === 'keyword' ? '关键词' : '混合检索';
                    }

                    function renderMatchScore(match) {
                        if (match?.retrieval === 'hybrid') {
                            return '<em class="regulations-match-score">混合排序</em>';
                        }
                        if (match?.retrieval === 'semantic') {
                            return '<em class="regulations-match-score">语义命中</em>';
                        }
                        if (state.searchMode === 'keyword' || match?.retrieval === 'keyword') {
                            return '<em class="regulations-match-score muted">关键词</em>';
                        }
                        return '<em class="regulations-match-score muted">筛选结果</em>';
                    }

                    function summarizeSavedSearch(search) {
                        const parts = [search.query, search.category, search.jurisdiction]
                            .map(item => String(item || '').trim())
                            .filter(Boolean);
                        return parts.length ? parts.join(' · ') : '全部条件';
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
                                <div class="regulations-saved-searches-title">
                                    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                                        <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path>
                                    </svg>
                                    <strong>常用检索预设</strong>
                                    <span>${searches.length} 项</span>
                                </div>
                                <span class="regulations-saved-searches-tip">点击一键应用</span>
                            </div>
                            <div class="regulations-saved-search-list">
                                ${searches.map(search => {
                                    const searchName = search.name || '常用预设';
                                    return `
                                    <div class="regulations-saved-search-item" title="点击应用此检索条件并执行检索">
                                        <button class="btn-secondary regulations-saved-search-chip" type="button" data-regulation-saved-search="${esc(search.id)}">
                                            <strong>${esc(searchName)}</strong>
                                            <span>${esc(summarizeSavedSearch(search))}</span>
                                        </button>
                                        <button class="btn-secondary regulations-saved-search-delete" type="button" data-regulation-delete-saved-search="${esc(search.id)}" title="删除此预设" aria-label="删除此预设">
                                            <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                                                <line x1="18" y1="6" x2="6" y2="18"></line>
                                                <line x1="6" y1="6" x2="18" y2="18"></line>
                                            </svg>
                                        </button>
                                    </div>
                                `;}).join('')}
                            </div>
                        `);
                    }

                    function renderSearchResults() {
                        const target = document.getElementById('regulations-modal-search-results');
                        if (!target) return;
                        const aiTarget = document.getElementById('regulations-ai-search-results');
                        if (aiTarget) aiTarget.classList.add('hidden');

                        const hasQuery = !!String(state.query || '').trim();
                        const hasFilters = !!(state.filters.category || state.filters.issuingBody || state.filters.jurisdiction || state.filters.status);
                        const hasMatches = Array.isArray(state.matches) && state.matches.length > 0;
                        const modeText = hasQuery ? ` · ${getSearchModeLabel()}` : (hasFilters ? ' · 条件筛选' : '');

                        let resultsHtml = '';
                        if (state.searchBusy) {
                            resultsHtml = `
                                <div class="regulations-loading" role="status" aria-live="polite">正在检索法规条文，请稍候…</div>
                            `;
                        } else if (!state.hasSearched) {
                            resultsHtml = `
                                <div class="regulations-search-results-head">
                                    <div class="regulations-search-results-title-group">
                                        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="regulations-search-head-icon" aria-hidden="true">
                                            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                                            <polyline points="14 2 14 8 20 8"></polyline>
                                            <line x1="16" y1="13" x2="8" y2="13"></line>
                                            <line x1="16" y1="17" x2="8" y2="17"></line>
                                        </svg>
                                        <strong>条文命中匹配</strong>
                                        <span class="regulations-search-count-badge muted">等待检索</span>
                                    </div>
                                    <span class="regulations-search-results-head-hint">在左侧设置条件后点击检索</span>
                                </div>
                                <div class="regulations-search-guide-empty">
                                    <div class="regulations-search-guide-icon" aria-hidden="true">
                                        <svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                                            <circle cx="11" cy="11" r="8"></circle>
                                            <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
                                            <line x1="11" y1="8" x2="11" y2="14"></line>
                                            <line x1="8" y1="11" x2="14" y2="11"></line>
                                        </svg>
                                    </div>
                                    <h4 class="regulations-search-guide-title">条文检索命中区</h4>
                                    <p class="regulations-search-guide-desc">在左侧输入关键词或组合筛选条件后，点击「检索」按钮，匹配的法律法规条文将在此实时展现。</p>
                                    <div class="regulations-search-guide-tips">
                                        <div class="regulations-search-guide-tip">
                                            <span class="regulations-search-guide-dot"></span>
                                            <span>支持<strong>混合语义</strong>与<strong>精准关键词</strong>两种检索模式</span>
                                        </div>
                                        <div class="regulations-search-guide-tip">
                                            <span class="regulations-search-guide-dot"></span>
                                            <span>支持按分类、发布机构、适用范围与状态多维联合过滤</span>
                                        </div>
                                        <div class="regulations-search-guide-tip">
                                            <span class="regulations-search-guide-dot"></span>
                                            <span>点击命中条文卡片可直接<strong>直达法规正文</strong>对应条款位置</span>
                                        </div>
                                    </div>
                                </div>
                            `;
                        } else if (!hasMatches) {
                            const emptyDesc = hasQuery
                                ? `未检索到与「${esc(state.query)}」相关的条文`
                                : '未检索到符合当前筛选条件的条文';
                            resultsHtml = `
                                <div class="regulations-search-results-head">
                                    <div class="regulations-search-results-title-group">
                                        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="regulations-search-head-icon" aria-hidden="true">
                                            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                                            <polyline points="14 2 14 8 20 8"></polyline>
                                            <line x1="16" y1="13" x2="8" y2="13"></line>
                                            <line x1="16" y1="17" x2="8" y2="17"></line>
                                        </svg>
                                        <strong>条文命中匹配</strong>
                                        <span class="regulations-search-count-badge">0 条${modeText}</span>
                                    </div>
                                    <span class="regulations-search-results-head-hint">建议调整检索条件</span>
                                </div>
                                <div class="regulations-search-empty-state">
                                    <div class="regulations-search-empty-icon" aria-hidden="true">
                                        <svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                                            <circle cx="11" cy="11" r="8"></circle>
                                            <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
                                            <line x1="8" y1="11" x2="14" y2="11"></line>
                                        </svg>
                                    </div>
                                    <h4>未找到匹配条文</h4>
                                    <p>${esc(emptyDesc)}，建议尝试缩减检索词、切换检索模式或减少筛选条件后重试。</p>
                                </div>
                            `;
                        } else {
                            resultsHtml = `
                                <div class="regulations-search-results-head">
                                    <div class="regulations-search-results-title-group">
                                        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="regulations-search-head-icon" aria-hidden="true">
                                            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                                            <polyline points="14 2 14 8 20 8"></polyline>
                                            <line x1="16" y1="13" x2="8" y2="13"></line>
                                            <line x1="16" y1="17" x2="8" y2="17"></line>
                                        </svg>
                                        <strong>条文命中匹配</strong>
                                        <span class="regulations-search-count-badge">${state.matches.length} 条命中${modeText}</span>
                                    </div>
                                    <span class="regulations-search-results-head-hint">点击卡片直达正文对应位置</span>
                                </div>
                                <div class="regulations-search-results-list">
                                    ${state.matches.map(match => {
                                        const excerpt = highlightText(match.excerpt || match.content || '', state.query);
                                        return `
                                            <button class="btn-secondary regulations-match" type="button" data-regulation-match-doc="${esc(match.document_id)}" data-regulation-match-version="${esc(match.version_id || '')}" data-regulation-match-article="${esc(match.article_id)}" title="点击跳转至法规正文对应条款并高亮">
                                                <div class="regulations-match-header">
                                                    <div class="regulations-match-doc-badge">
                                                        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="regulations-match-doc-icon" aria-hidden="true">
                                                            <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path>
                                                            <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path>
                                                        </svg>
                                                        <strong class="regulations-match-doc-title">${esc(match.document_title || '未命名法规')}</strong>
                                                    </div>
                                                    <div class="regulations-match-tags">
                                                        ${match.article_label ? `<span class="regulations-match-article-tag">${esc(match.article_label)}</span>` : ''}
                                                        ${renderMatchScore(match)}
                                                    </div>
                                                </div>
                                                ${match.article_title ? `
                                                    <div class="regulations-match-title-row">
                                                        <span class="regulations-match-article-title">${esc(match.article_title)}</span>
                                                    </div>
                                                ` : ''}
                                                <div class="regulations-match-body">
                                                    <p class="regulations-match-excerpt">${excerpt}</p>
                                                </div>
                                                <div class="regulations-match-footer">
                                                    <span class="regulations-match-hint">
                                                        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                                                            <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"></path>
                                                            <circle cx="12" cy="10" r="3"></circle>
                                                        </svg>
                                                        匹配条文定位
                                                    </span>
                                                    <span class="regulations-match-arrow" aria-hidden="true">
                                                        查看正文
                                                        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                                            <polyline points="9 18 15 12 9 6"></polyline>
                                                        </svg>
                                                    </span>
                                                </div>
                                            </button>
                                        `;
                                    }).join('')}
                                </div>
                            `;
                        }

                        target.classList.remove('hidden');
                        PivotSafeHtml.setHtml(target, resultsHtml);
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
                            const isStreaming = !!turn.streaming;
                            const sources = Array.isArray(turn.sources) ? turn.sources : [];
                            const grounding = turn.grounding && typeof turn.grounding === 'object' ? turn.grounding : null;
                            const direct = sources.filter(s => !s.viaLink);
                            const related = sources.filter(s => s.viaLink);
                            const verificationLabel = isStreaming
                                ? '生成并核验中…'
                                : grounding?.status === 'verified'
                                    ? '依据已核验'
                                    : grounding?.status === 'no_candidates'
                                        ? '未检到候选'
                                        : grounding?.status === 'insufficient_evidence'
                                            ? '候选不足，需补充'
                                            : '基于条文检索';
                            const renderSourceBtn = source => {
                                const excerptText = source.excerpt
                                    ? (typeof stripMarkdownFormatting === 'function' ? stripMarkdownFormatting(source.excerpt) : source.excerpt)
                                    : '';
                                return `
                                    <button class="regulations-ai-source${source.viaLink ? ' viaLink' : ''}" type="button" data-regulation-match-doc="${esc(source.documentId)}" data-regulation-match-version="${esc(source.versionId || '')}" data-regulation-match-article="${esc(source.articleId)}" title="点击查看此法条原文">
                                        <span class="regulations-ai-source-label">
                                            <span class="regulations-ai-source-name"><b class="regulations-ai-source-index">[${esc(source.index || '?')}]</b>${esc(source.label || '相关条文')}</span>
                                            ${source.relation ? `<em class="regulations-ai-source-rel">${esc(source.relation)}</em>` : ''}
                                        </span>
                                        ${excerptText ? `<span class="regulations-ai-source-excerpt">${esc(excerptText)}</span>` : ''}
                                    </button>
                                `;
                            };
                            const groupsHtml = sources.length ? `
                                <div class="regulations-ai-sources">
                                    ${direct.length ? `
                                        <div class="regulations-ai-sources-head">
                                            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                                                <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"></path>
                                                <circle cx="12" cy="10" r="3"></circle>
                                            </svg>
                                            <span class="regulations-ai-sources-title" title="由检索直接召回，尚不代表已被回答采纳">直接检索候选</span>
                                            <span class="regulations-ai-sources-count">${direct.length}</span>
                                        </div>
                                        <div class="regulations-ai-sources-list">${direct.map(renderSourceBtn).join('')}</div>
                                    ` : ''}
                                    ${related.length ? `
                                        <div class="regulations-ai-sources-head">
                                            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                                                <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path>
                                                <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path>
                                            </svg>
                                            <span class="regulations-ai-sources-title" title="由候选条文的引用关系扩展得出，尚不代表已被回答采纳">引用关联候选</span>
                                            <span class="regulations-ai-sources-count">${related.length}</span>
                                        </div>
                                        <div class="regulations-ai-sources-list">${related.map(renderSourceBtn).join('')}</div>
                                    ` : ''}
                                </div>
                            ` : '';

                            const rawAnswer = turn.answer || '';
                            let bodyHtml = '';
                            if (isStreaming) {
                                if (rawAnswer) {
                                    bodyHtml = typeof renderAiCardAnswer === 'function'
                                        ? renderAiCardAnswer(rawAnswer)
                                        : esc(rawAnswer);
                                } else {
                                    bodyHtml = `
                                        <div class="regulations-ai-streaming-placeholder">
                                            <div class="regulations-ai-pulse-wave" aria-hidden="true">
                                                <span class="regulations-ai-pulse-dot"></span>
                                                <span class="regulations-ai-pulse-dot"></span>
                                                <span class="regulations-ai-pulse-dot"></span>
                                            </div>
                                            <span class="regulations-ai-loading-text">正在检索法规条文、生成并核验引用依据…</span>
                                        </div>
                                    `;
                                }
                            } else {
                                bodyHtml = typeof renderAiCardAnswer === 'function'
                                    ? renderAiCardAnswer(rawAnswer)
                                    : renderRichText(rawAnswer);
                            }

                            return `
                                <div class="regulations-ai-turn">
                                    <div class="regulations-ai-question">
                                        <div class="regulations-ai-question-bubble">${esc(turn.question)}</div>
                                    </div>
                                    <div class="regulations-ai-card">
                                        <div class="regulations-ai-card-header">
                                            <span class="regulations-ai-card-avatar" aria-hidden="true">AI</span>
                                            <strong class="regulations-ai-card-title">法规问答答复</strong>
                                            <span class="regulations-ai-card-tag">${verificationLabel}</span>
                                        </div>
                                        <div id="regulations-ai-answer-${turnIndex}" class="regulations-article-body regulations-ai-card-body">${bodyHtml}</div>
                                        ${groupsHtml}
                                        ${isStreaming ? '' : `<div class="regulations-ai-turn-actions">
                                            <button class="btn-secondary regulations-ai-copy-btn" type="button" data-regulations-ai-copy="${turnIndex}" title="复制此条回答">
                                                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                                                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                                                </svg>
                                                <span>复制回答</span>
                                            </button>
                                            <button class="btn-secondary regulations-ai-export-btn" type="button" data-regulation-export-report="${turnIndex}" data-regulation-export-format="md">
                                                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                                                    <polyline points="7 10 12 15 17 10"></polyline>
                                                    <line x1="12" y1="15" x2="12" y2="3"></line>
                                                </svg>
                                                <span>导出 Markdown</span>
                                            </button>
                                            <button class="btn-secondary regulations-ai-export-btn" type="button" data-regulation-export-report="${turnIndex}" data-regulation-export-format="docx">导出 Word</button>
                                            <button class="btn-secondary regulations-ai-export-btn" type="button" data-regulation-export-report="${turnIndex}" data-regulation-export-format="pdf">导出 PDF</button>
                                        </div>`}
                                    </div>
                                </div>
                            `;
                        }).join('');

                        const loadingHtml = state.aiBusy && !state.aiTurns.some(turn => turn.streaming) ? `
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
                                        <span class="regulations-ai-loading-text">正在检索法规条文、生成并核验引用依据…</span>
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
