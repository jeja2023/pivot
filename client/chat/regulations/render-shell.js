(function () {
    const ns = window.Pivot.legacy.PivotRegulationsInternal;
    if (!ns) throw new Error('法规库核心模块未加载');
    if (ns.renderShellReady) return;

    const {
        FILE_ACCEPT,
        SUPPORTED_FORMATS,
        state,
        esc,
        canManage,
        canImportDocuments,
        canDeleteDocuments
    } = ns;

    const bindEvents = (...args) => ns.bindEvents?.(...args);
    const renderDocuments = (...args) => ns.renderDocuments?.(...args);
    const renderDetail = (...args) => ns.renderDetail?.(...args);
    const renderSearchResults = (...args) => ns.renderSearchResults?.(...args);
    const renderSavedSearches = (...args) => ns.renderSavedSearches?.(...args);
    const renderAiAnswer = (...args) => ns.renderAiAnswer?.(...args);
    const syncImportHint = (...args) => ns.syncImportHint?.(...args);
            function ensureView() {
                        let view = document.getElementById('regulations-view');
                        if (view) return view;
                        view = document.createElement('div');
                        view.id = 'regulations-view';
                        view.className = 'regulations-view hidden';
                        const host = document.querySelector('.apps-workspace-body') || document.getElementById('apps-home-view')?.parentElement || document.body;
                        host.appendChild(view);
                        return view;
                    }

                    function renderShell() {
                        const view = ensureView();
                        PivotSafeHtml.setHtml(view, buildViewHtml());
                        bindEvents(view);
                        renderDocuments();
                        renderDetail();
                        renderSearchResults();
                        renderSavedSearches();
                        renderAiAnswer();
                        syncImportHint(document.getElementById('regulations-upload-form'));
                    }

                    function buildViewHtml() {
                        const canImport = canImportDocuments();
                        const canBatch = canManage();
                        return `
                            <div class="regulations-panel">
                                <main class="workspace-panel regulations-main">
                                    <div class="workspace-toolbar regulations-toolbar">
                                        <button id="regulations-open-search-btn" class="btn-primary regulations-search-entry-btn" type="button">检索</button>
                                        <button id="regulations-ai-open-btn" class="btn-secondary regulations-ai-entry-btn" type="button">AI问答</button>
                                        <button id="regulations-bookmarks-btn" class="btn-secondary" type="button">我的收藏</button>
                                        <button id="regulations-refresh-btn" class="btn-secondary" type="button">刷新</button>
                                        ${canImport ? '<button id="regulations-open-upload-btn" class="btn-secondary" type="button">导入文档</button>' : ''}
                                        ${canBatch ? '<button id="regulations-quality-btn" class="btn-secondary" type="button">质量概览</button>' : ''}
                                        ${canDeleteDocuments() ? '<button id="regulations-recycle-bin-btn" class="btn-secondary" type="button">回收站</button>' : ''}
                                    </div>
                                    ${canImport ? renderAdminPanel() : ''}
                                    ${renderRegulationDialogs()}
                                    <div id="regulations-summary" class="regulations-summary"></div>
                                    <section id="regulations-folder-directory" class="regulations-folder-directory"></section>
                                    <section id="regulations-folder-index" class="regulations-folder-index hidden"></section>
                                    ${ns.renderBatchToolbar()}
                                    <div id="regulations-doc-table-wrap" class="table-container workspace-table-wrap regulations-doc-table-wrap">
                                        <table class="data-table regulations-doc-table">
                                            <thead>
                                                <tr>
                                                    ${canBatch ? '<th id="regulations-select-column" class="text-center regulations-select-column hidden"><input id="regulations-select-all" type="checkbox" aria-label="全选本页法规文档" title="全选本页（跨页选择会保留）"></th>' : ''}
                                                    <th style="width: 54px;" class="text-center">序号</th>
                                                    <th style="width: 250px;">文档名称</th>
                                                    <th style="width: 118px;">分类</th>
                                                    <th style="width: 140px;">发布机构</th>
                                                    <th style="width: 130px;">适用范围</th>
                                                    <th class="text-center regulations-status-column">管理/效力</th>
                                                    <th style="width: 70px;" class="text-center">条文</th>
                                                    <th style="width: 118px;">版本</th>
                                                    <th style="width: 138px;">更新时间</th>
                                                    <th style="width: 156px;" class="text-center">操作</th>
                                                </tr>
                                            </thead>
                                            <tbody id="regulations-doc-list"></tbody>
                                        </table>
                                    </div>
                                    <div id="regulations-pagination" class="pagination workspace-pagination regulations-pagination"></div>
                                </main>
                            </div>
                        `;
                    }

                    function renderSearchArchivedControl() {
                        if (!canManage()) return '';
                        return `<label class="regulations-checkline regulations-search-archived"><input id="regulations-include-archived" type="checkbox" ${state.filters.includeArchived ? 'checked' : ''}><span>显示已归档</span></label>`;
                    }

                    function renderRegulationDialogs() {
                        return `
                            ${ns.renderBatchDialogs()}
                            <section id="regulations-search-panel" class="regulations-admin-panel hidden" role="dialog" aria-modal="true" aria-labelledby="regulations-search-title">
                                <div class="workspace-modal regulations-admin-dialog regulations-search-dialog">
                                    <div class="workspace-modal-header">
                                        <div>
                                            <h3 id="regulations-search-title">检索法规</h3>
                                            <p>按名称、发布机构、适用范围组合检索条文，支持混合语义检索与关键词检索</p>
                                        </div>
                                        <button class="btn-secondary workspace-modal-close" type="button" data-regulations-close-search>关闭</button>
                                    </div>
                                    <div class="workspace-modal-body regulations-search-modal-body">
                                        <div class="regulations-search-sidebar">
                                            <div class="regulations-admin-group regulations-search-group">
                                                <div class="regulations-admin-group-head">
                                                    <strong>检索条件</strong>
                                                    <span>支持多字段联合检索</span>
                                                </div>
                                                <div class="regulations-search-form">
                                                    <label class="regulations-search-field regulations-search-field-wide"><span>检索内容</span><input id="regulations-query" class="form-input regulations-query-input" type="search" placeholder="搜索法规名称、发布机构或条文" value="${esc(state.query)}"></label>
                                                    <label class="regulations-search-field"><span>检索模式</span><select id="regulations-search-mode" class="form-input regulations-mode-select" aria-label="检索模式">
                                                        <option value="hybrid" ${state.searchMode !== 'keyword' ? 'selected' : ''}>混合检索</option>
                                                        <option value="keyword" ${state.searchMode === 'keyword' ? 'selected' : ''}>关键词</option>
                                                    </select></label>
                                                    <label class="regulations-search-field"><span>分类</span><input id="regulations-category-filter" class="form-input regulations-filter-input" placeholder="分类" value="${esc(state.filters.category)}"></label>
                                                    <label class="regulations-search-field"><span>发布机构</span><input id="regulations-issuing-body-filter" class="form-input regulations-filter-input" placeholder="发布机构" value="${esc(state.filters.issuingBody)}" list="regulations-issuing-body-list"></label>
                                                    <label class="regulations-search-field"><span>适用范围</span><input id="regulations-jurisdiction-filter" class="form-input regulations-filter-input" placeholder="适用范围" value="${esc(state.filters.jurisdiction)}"></label>
                                                    <label class="regulations-search-field"><span>管理状态</span><select id="regulations-status-filter" class="form-input regulations-mode-select"><option value="" ${!state.filters.status ? 'selected' : ''}>全部</option><option value="active" ${state.filters.status === 'active' ? 'selected' : ''}>启用</option><option value="archived" ${state.filters.status === 'archived' ? 'selected' : ''}>归档</option></select></label>
                                                    ${renderSearchArchivedControl()}
                                                </div>
                                            </div>
                                            <div class="regulations-search-modal-actions">
                                                <button id="regulations-save-search-btn" class="btn-secondary" type="button" title="将当前筛选条件保存为常用预设，方便后续一键复用">保存为预设</button>
                                                <button id="regulations-search-btn" class="btn-primary" type="button">检索</button>
                                            </div>
                                            <div id="regulations-saved-searches" class="regulations-saved-searches hidden"></div>
                                        </div>
                                        <div class="regulations-search-content">
                                            <div id="regulations-modal-search-results" class="regulations-search-results regulations-search-modal-results" data-regulations-search-results></div>
                                        </div>
                                    </div>
                                </div>
                            </section>
                            <section id="regulations-detail-panel" class="regulations-admin-panel hidden" role="dialog" aria-modal="true" aria-labelledby="regulations-detail-title">
                                <div class="workspace-modal regulations-admin-dialog regulations-detail-dialog">
                                    <div class="workspace-modal-header regulations-detail-modal-header">
                                        <div class="regulations-detail-title-group">
                                            <h3 id="regulations-detail-title">法规原文</h3>
                                            <span id="regulations-detail-doc-badge" class="regulations-detail-doc-badge"></span>
                                        </div>
                                        <button class="btn-secondary workspace-modal-close" type="button" data-regulations-close-detail>关闭</button>
                                    </div>
                                    <div id="regulations-detail-toolbar" class="regulations-detail-toolbar">
                                        <div id="regulations-detail-admin-actions" class="regulations-detail-actions-wrap"></div>
                                    </div>
                                    <div id="regulations-detail-content" class="regulations-detail-content">
                                        <div id="regulations-detail-forms"></div>
                                        <div id="regulations-detail-body" class="workspace-modal-body regulations-dialog-body"></div>
                                    </div>
                                </div>
                            </section>
                            <section id="regulations-ai-panel" class="regulations-admin-panel hidden" role="dialog" aria-modal="true" aria-labelledby="regulations-ai-title">
                                <div class="workspace-modal regulations-admin-dialog regulations-ai-dialog">
                                    <div class="workspace-modal-header regulations-ai-modal-header">
                                        <div class="regulations-ai-header-main">
                                            <span class="regulations-ai-header-icon" aria-hidden="true">
                                                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                                    <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
                                                </svg>
                                            </span>
                                            <div class="regulations-ai-header-text">
                                                <div class="regulations-ai-title-row">
                                                    <h3 id="regulations-ai-title">法规 AI 智能问答</h3>
                                                    <span class="regulations-ai-header-badge">条文依据检索</span>
                                                </div>
                                                <p title="基于法规库检索匹配的条文回答，并标注具体条款出处与依据。">基于法规库检索匹配的条文回答，并标注具体条款出处与依据。</p>
                                            </div>
                                        </div>
                                        <div class="regulations-ai-header-aside">
                                            <label class="regulations-ai-model-field" for="regulations-ai-model">
                                                <span>模型</span>
                                                <select id="regulations-ai-model" class="form-input regulations-ai-model-select" data-pivot-app-model="regulations" aria-label="选择法规 AI 问答模型" disabled>
                                                    <option value="">加载模型中…</option>
                                                </select>
                                            </label>
                                            <label class="regulations-ai-model-field" for="regulations-ai-scope">
                                                <span>范围</span>
                                                <select id="regulations-ai-scope" class="form-input regulations-ai-model-select" aria-label="选择法规问答范围">
                                                    <option value="library" ${state.aiScope !== 'document' ? 'selected' : ''}>法规库</option>
                                                    <option value="document" ${state.aiScope === 'document' ? 'selected' : ''}>当前法规（请先打开法规）</option>
                                                </select>
                                            </label>
                                            <button class="btn-secondary workspace-modal-close" type="button" data-regulations-close-ai>关闭</button>
                                        </div>
                                    </div>
                                    <div class="workspace-modal-body regulations-ai-modal-body">
                                        <div id="regulations-ai-answer" class="regulations-ai-answer" role="log" aria-live="polite"></div>
                                        <div id="regulations-ai-search-results" class="regulations-search-results regulations-ai-search-results hidden" data-regulations-search-results></div>
                                        <div class="regulations-ai-composer">
                                            <div class="regulations-ai-input-card">
                                                <textarea id="regulations-ai-question" class="form-input regulations-ai-question-input" rows="2" placeholder="输入您关注的问题，例如：该制度对审批流程有哪些要求？"></textarea>
                                                <div class="regulations-ai-composer-footer">
                                                    <div class="regulations-ai-composer-tip">
                                                        <span>快捷键 <code>Ctrl+回车</code> 发送</span>
                                                    </div>
                                                    <div class="regulations-ai-actions">
                                                        <button id="regulations-ai-clear-btn" class="btn-secondary regulations-ai-clear-btn" type="button" title="清空历史问答与输入">
                                                            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                                                <polyline points="3 6 5 6 21 6"></polyline>
                                                                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                                                            </svg>
                                                            <span>清空</span>
                                                        </button>
                                                        <button id="regulations-ai-stop-btn" class="btn-secondary regulations-ai-stop-btn hidden" type="button">停止生成</button>
                                                        <button id="regulations-ai-btn" class="btn-primary regulations-ai-submit-btn" type="button">
                                                            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                                                <line x1="22" y1="2" x2="11" y2="13"></line>
                                                                <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
                                                            </svg>
                                                            <span>生成回答</span>
                                                        </button>
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </section>
                            <section id="regulations-similar-panel" class="regulations-admin-panel hidden" role="dialog" aria-modal="true" aria-labelledby="regulations-similar-title">
                                <div class="workspace-modal regulations-admin-dialog regulations-similar-dialog">
                                    <div class="workspace-modal-header">
                                        <div>
                                            <h3 id="regulations-similar-title">相似条文</h3>
                                            <p>优先按向量相似度推荐；不可用时按同分类或同发布机构降级。</p>
                                        </div>
                                        <button class="btn-secondary workspace-modal-close" type="button" data-regulations-close-similar>关闭</button>
                                    </div>
                                    <div id="regulations-similar-body" class="workspace-modal-body regulations-similar-body"></div>
                                </div>
                            </section>
                            <section id="regulations-graph-panel" class="regulations-admin-panel hidden" role="dialog" aria-modal="true">
                                <div class="workspace-modal regulations-admin-dialog regulations-graph-dialog">
                                    <div class="workspace-modal-header">
                                        <div><h3>条文引用网络</h3><p>节点为条文，连线为引用关系；点击节点跳转到对应条文。</p></div>
                                        <button class="btn-secondary workspace-modal-close" type="button" data-regulations-close-graph>关闭</button>
                                    </div>
                                    <div id="regulations-graph-body" class="workspace-modal-body regulations-graph-body"></div>
                                </div>
                            </section>
                            <section id="regulations-timeline-panel" class="regulations-admin-panel hidden" role="dialog" aria-modal="true">
                                <div class="workspace-modal regulations-admin-dialog">
                                    <div class="workspace-modal-header">
                                        <div><h3>修订时间线</h3><p>按施行日期展示该法规的版本演进，点击切换查看对应版本。</p></div>
                                        <button class="btn-secondary workspace-modal-close" type="button" data-regulations-close-timeline>关闭</button>
                                    </div>
                                    <div id="regulations-timeline-body" class="workspace-modal-body regulations-timeline-body"></div>
                                </div>
                            </section>
                            <section id="regulations-annotation-panel" class="regulations-admin-panel hidden" role="dialog" aria-modal="true">
                                <div class="workspace-modal regulations-admin-dialog">
                                    <div class="workspace-modal-header">
                                        <div><h3>条文批注</h3><p>团队共享内部理解与适用案例；只能编辑/删除自己的批注。</p></div>
                                        <button class="btn-secondary workspace-modal-close" type="button" data-regulations-close-annotation>关闭</button>
                                    </div>
                                    <div id="regulations-annotation-body" class="workspace-modal-body regulations-annotation-body"></div>
                                </div>
                            </section>
                            <section id="regulations-access-log-panel" class="regulations-admin-panel hidden" role="dialog" aria-modal="true" aria-labelledby="regulations-access-log-title">
                                <div class="workspace-modal regulations-admin-dialog">
                                    <div class="workspace-modal-header">
                                        <div><h3 id="regulations-access-log-title">法规访问记录</h3><p>显示当前法规的查看、下载、检索和问答审计信息。</p></div>
                                        <button class="btn-secondary workspace-modal-close" type="button" data-regulations-close-access-log>关闭</button>
                                    </div>
                                    <div id="regulations-access-log-body" class="workspace-modal-body"></div>
                                </div>
                            </section>
                            <section id="regulations-ai-log-panel" class="regulations-admin-panel hidden" role="dialog" aria-modal="true" aria-labelledby="regulations-ai-log-title">
                                <div class="workspace-modal regulations-admin-dialog">
                                    <div class="workspace-modal-header">
                                        <div><h3 id="regulations-ai-log-title">我的法规问答记录</h3><p>保留回答生成时使用的模型、法规版本和依据快照，用于后续复核。</p></div>
                                        <button class="btn-secondary workspace-modal-close" type="button" data-regulations-close-ai-log>关闭</button>
                                    </div>
                                    <div id="regulations-ai-log-body" class="workspace-modal-body"></div>
                                </div>
                            </section>
                            <section id="regulations-bookmarks-panel" class="regulations-admin-panel hidden" role="dialog" aria-modal="true" aria-labelledby="regulations-bookmarks-title">
                                <div class="workspace-modal regulations-admin-dialog regulations-bookmarks-dialog">
                                    <div class="workspace-modal-header">
                                        <div class="regulations-bookmarks-header-group">
                                            <div class="regulations-bookmarks-header-icon" aria-hidden="true">
                                                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                                    <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path>
                                                </svg>
                                            </div>
                                            <div>
                                                <h3 id="regulations-bookmarks-title">我的法规收藏</h3>
                                                <p>按专题分类整理常用法规，仅对当前账号可见，不会改变法规库全局元数据。</p>
                                            </div>
                                        </div>
                                        <button class="btn-secondary workspace-modal-close" type="button" data-regulations-close-bookmarks title="关闭收藏弹窗">关闭</button>
                                    </div>
                                    <div id="regulations-bookmarks-body" class="workspace-modal-body"></div>
                                </div>
                            </section>
                            <section id="regulations-recycle-bin-panel" class="regulations-admin-panel hidden" role="dialog" aria-modal="true" aria-labelledby="regulations-recycle-bin-title">
                                <div class="workspace-modal regulations-admin-dialog regulations-recycle-bin-dialog">
                                    <div class="workspace-modal-header">
                                        <div><h3 id="regulations-recycle-bin-title">法规回收站</h3><p>仅显示软删除法规；恢复后会重新进入法规目录和检索范围。</p></div>
                                        <button class="btn-secondary workspace-modal-close" type="button" data-regulations-close-recycle-bin>关闭</button>
                                    </div>
                                    <div id="regulations-recycle-bin-body" class="workspace-modal-body"></div>
                                </div>
                            </section>
                            <section id="regulations-quality-panel" class="regulations-admin-panel hidden" role="dialog" aria-modal="true" aria-labelledby="regulations-quality-title">
                                <div class="workspace-modal regulations-admin-dialog">
                                    <div class="workspace-modal-header">
                                        <div><h3 id="regulations-quality-title">法规质量概览</h3><p>集中查看待核验效力、来源、索引、定位与引用治理项。</p></div>
                                        <button class="btn-secondary workspace-modal-close" type="button" data-regulations-close-quality>关闭</button>
                                    </div>
                                    <div id="regulations-quality-body" class="workspace-modal-body"></div>
                                </div>
                            </section>
                            <section id="regulations-citation-governance-panel" class="regulations-admin-panel hidden" role="dialog" aria-modal="true" aria-labelledby="regulations-citation-governance-title">
                                <div class="workspace-modal regulations-admin-dialog regulations-citation-governance-dialog">
                                    <div class="workspace-modal-header regulations-citation-modal-header">
                                        <div class="regulations-citation-header-info">
                                            <div class="regulations-citation-title-row">
                                                <h3 id="regulations-citation-governance-title">引用治理队列</h3>
                                                <span id="regulations-citation-type-badge" class="regulations-citation-type-tag">待审核</span>
                                            </div>
                                            <p id="regulations-citation-governance-subtitle">集中处理当前法规版本的未解析与待审核引用。</p>
                                        </div>
                                        <button class="btn-secondary workspace-modal-close" type="button" data-regulations-close-citation-governance>关闭</button>
                                    </div>
                                    <div id="regulations-citation-governance-body" class="workspace-modal-body"></div>
                                </div>
                            </section>
                            <section id="regulations-obligation-panel" class="regulations-admin-panel hidden" role="dialog" aria-modal="true" aria-labelledby="regulations-obligation-title">
                                <div class="workspace-modal regulations-admin-dialog">
                                    <div class="workspace-modal-header">
                                        <div><h3 id="regulations-obligation-title">合规义务清单</h3><p>义务事项需经人工审核后再用于后续任务分派。</p></div>
                                        <button class="btn-secondary workspace-modal-close" type="button" data-regulations-close-obligation>关闭</button>
                                    </div>
                                    <div id="regulations-obligation-body" class="workspace-modal-body"></div>
                                </div>
                            </section>
                            <section id="regulations-location-panel" class="regulations-admin-panel hidden" role="dialog" aria-modal="true" aria-labelledby="regulations-location-title">
                                <div class="workspace-modal regulations-admin-dialog">
                                    <div class="workspace-modal-header">
                                        <div><h3 id="regulations-location-title">条文来源定位</h3><p>显示条文在来源文本中的页码与字符范围；低置信度定位需要人工复核。</p></div>
                                        <button class="btn-secondary workspace-modal-close" type="button" data-regulations-close-location>关闭</button>
                                    </div>
                                    <div id="regulations-location-body" class="workspace-modal-body"></div>
                                </div>
                            </section>
                        `;
                    }
                    function renderAdminPanel() {
                        return `
                            <section id="regulations-admin-panel" class="regulations-admin-panel hidden" role="dialog" aria-modal="true" aria-labelledby="regulations-import-title">
                                <div class="workspace-modal regulations-admin-dialog regulations-import-dialog">
                                    <div class="workspace-modal-header">
                                        <div>
                                            <h3 id="regulations-import-title">导入文档</h3>
                                            <p>可一次选择多个文件；提交后进入可恢复的导入队列。批量导入时可只填写分类、适用范围等公共字段。</p>
                                        </div>
                                        <button class="btn-secondary workspace-modal-close" type="button" data-regulations-close-upload>关闭</button>
                                    </div>
                                    <form id="regulations-upload-form" class="workspace-modal-body regulations-admin-form model-form regulations-import-form">
                                        <div class="regulations-admin-group">
                                            <div class="regulations-admin-group-head"><strong>快速预设</strong><span>法律解释与司法解释分开；多个发布机构统一用顿号保存</span></div>
                                            <div class="regulations-preset-row">
                                                <button type="button" class="regulations-preset-btn" data-preset="law">法律（人大）</button>
                                                <button type="button" class="regulations-preset-btn" data-preset="lawSc">法律（人大常委会）</button>
                                                <button type="button" class="btn-secondary regulations-preset-btn" data-preset="legalInterpretation">法律解释（人大常委会）</button>
                                                <button type="button" class="regulations-preset-btn" data-preset="regulation">行政法规</button>
                                                <button type="button" class="regulations-preset-btn" data-preset="interpretation">司法解释（最高法）</button>
                                                <button type="button" class="regulations-preset-btn" data-preset="procuratorate">司法解释（最高检）</button>
                                                <button type="button" class="btn-secondary regulations-preset-btn" data-preset="jointInterpretation">司法解释（两高联合）</button>
                                                <button type="button" class="regulations-preset-btn" data-preset="rule">部门规章</button>
                                            </div>
                                        </div>
                                        <div class="regulations-admin-group">
                                            <div class="regulations-admin-group-head"><strong>基础信息</strong><span>名称和日期可留空，系统会自动识别</span></div>
                                            <div class="regulations-admin-grid regulations-import-grid">
                                                <label>标题<input id="regulations-upload-title" name="title" class="form-input" maxlength="120" placeholder="单个文件可填写；批量建议留空自动识别"></label>
                                                <label>法规层级<input name="legalLevel" class="form-input" maxlength="80" placeholder="如 法律、行政法规、部门规章" list="regulations-legal-level-list"></label>
                                                <label>分类<input name="category" class="form-input" maxlength="120" placeholder="如 法律、行政法规、司法解释" list="regulations-category-list"></label>
                                                <label>发布机构（可多个）<input name="issuingBody" class="form-input" maxlength="120" placeholder="如 最高人民法院、最高人民检察院；用顿号或逗号分隔"></label>
                                                <label>适用范围<input name="jurisdiction" class="form-input" maxlength="120" placeholder="如 全国、某省、某市" list="regulations-jurisdiction-list"></label>
                                                <label>主题标签<input name="subjectTags" class="form-input" maxlength="300" placeholder="用顿号或逗号分隔"></label>
                                                <label>版本标识<input name="versionLabel" class="form-input" maxlength="80" placeholder="如 2024年修正；留空按文件名日期识别"></label>
                                                <label>效力状态<select name="effectStatus" class="form-input"><option value="unverified" selected>待核验</option><option value="pending">待生效</option><option value="effective">现行有效</option><option value="expired">失效</option><option value="repealed">废止</option></select></label>
                                                <label>生效日期<input name="effectiveFrom" class="form-input" type="date"></label>
                                            </div>
                                        </div>
                                        <div class="regulations-admin-group">
                                            <div class="regulations-admin-group-head"><strong>摘要与文件</strong><span>批量导入最多 300 个文件</span></div>
                                            <label>摘要<textarea name="summary" class="form-input" rows="2" placeholder="可选；留空时从文档正文生成摘要"></textarea></label>
                                            <div class="regulations-import-row-2col">
                                                <label>官方来源地址<input name="officialSourceUrl" class="form-input" maxlength="1000" placeholder="可选；用于法规来源追溯"></label>
                                                <label>版本来源地址<input name="sourceUrl" class="form-input" maxlength="1000" placeholder="可选；用于本次版本来源追溯"></label>
                                            </div>
                                            <div class="regulations-import-row-2col">
                                                <label class="regulations-file-field">
                                                    <span>文档文件</span>
                                                    <span class="regulations-file-control">
                                                        <input id="regulations-upload-file" class="regulations-file-input" name="file" type="file" multiple accept="${FILE_ACCEPT}" required>
                                                        <span class="regulations-file-button">选择文档</span>
                                                        <span id="regulations-file-summary" class="regulations-file-summary">未选择文件</span>
                                                    </span>
                                                    <small class="regulations-file-hint">支持 ${SUPPORTED_FORMATS}；可批量选择，最多 300 个文件。标题、版本可留空，由系统自动识别。</small>
                                                </label>
                                                <label><span>完全重复文件</span><select name="duplicateAction" class="form-input" aria-label="完全重复文件处理方式"><option value="continue">仍作为新法规导入，并标记重复</option><option value="skip">跳过已存在的完全相同文件</option></select><small class="regulations-file-hint">依据文件指纹判断；同名但内容不同的文件仍会进入导入队列，便于作为新版本人工核验。</small></label>
                                            </div>
                                        </div>
                                        <div class="regulations-admin-actions regulations-import-actions">
                                            <button type="button" class="btn-secondary" data-regulation-preview>预览条文</button>
                                            <button id="regulations-upload-submit" class="btn-primary" type="submit">上传入库</button>
                                        </div>
                                        <div id="regulations-import-jobs" class="regulations-import-jobs hidden" aria-live="polite"></div>
                                    </form>
                                </div>
                            </section>
                            <section id="regulations-import-result-panel" class="regulations-admin-panel hidden" role="dialog" aria-modal="true">
                                <div class="workspace-modal regulations-admin-dialog">
                                    <div class="workspace-modal-header">
                                        <div><h3>导入结果</h3></div>
                                        <button class="btn-secondary workspace-modal-close" type="button" data-regulations-close-result>关闭</button>
                                    </div>
                                    <div id="regulations-import-result-body" class="workspace-modal-body"></div>
                                </div>
                            </section>
                            <datalist id="regulations-category-list"></datalist>
                            <datalist id="regulations-legal-level-list"></datalist>
                            <datalist id="regulations-issuing-body-list"></datalist>
                            <datalist id="regulations-jurisdiction-list"></datalist>
                            <section id="regulations-compare-panel" class="regulations-admin-panel hidden" role="dialog" aria-modal="true">
                                <div class="workspace-modal regulations-admin-dialog">
                                    <div class="workspace-modal-header">
                                        <div><h3>版本对比</h3></div>
                                        <button class="btn-secondary workspace-modal-close" type="button" data-regulations-close-compare>关闭</button>
                                    </div>
                                    <div id="regulations-compare-body" class="workspace-modal-body"></div>
                                </div>
                            </section>


                            <section id="regulations-preview-panel" class="regulations-admin-panel hidden" role="dialog" aria-modal="true">
                                <div class="workspace-modal regulations-admin-dialog regulations-graph-dialog">
                                    <div class="workspace-modal-header">
                                        <div><h3>导入预览</h3><p>确认条文切分结果，可合并相邻条文后再入库。</p></div>
                                        <button class="btn-secondary workspace-modal-close" type="button" data-regulations-close-preview>关闭</button>
                                    </div>
                                    <div id="regulations-preview-body" class="workspace-modal-body regulations-preview-body"></div>
                                </div>
                            </section>
                            <section id="regulations-create-folder-panel" class="regulations-admin-panel hidden" role="dialog" aria-modal="true">
                                <div class="workspace-modal regulations-admin-dialog regulations-create-folder-dialog">
                                    <div class="workspace-modal-header">
                                        <div><h3>新建法规分类目录</h3><p>创建新的分类目录，便于集中归类、批量治理和检索法规文档。</p></div>
                                        <button class="btn-secondary workspace-modal-close" type="button" data-regulations-close-create-folder>关闭</button>
                                    </div>
                                    <form id="regulations-create-folder-form" class="workspace-modal-body regulations-create-folder-form">
                                        <div class="regulations-form-grid">
                                            <label>
                                                <span>分类目录名称 <em class="text-danger">*</em></span>
                                                <input id="regulations-new-folder-name" name="name" class="form-input" required maxlength="50" placeholder="如：地方性法规、部门规章、司法解释、团体标准">
                                            </label>
                                            <div class="regulations-preset-tags">
                                                <span>快捷推荐：</span>
                                                <button type="button" class="btn-secondary" data-regulation-preset-cat="行政法规">行政法规</button>
                                                <button type="button" class="btn-secondary" data-regulation-preset-cat="地方性法规">地方性法规</button>
                                                <button type="button" class="btn-secondary" data-regulation-preset-cat="部门规章">部门规章</button>
                                                <button type="button" class="btn-secondary" data-regulation-preset-cat="司法解释">司法解释</button>
                                                <button type="button" class="btn-secondary" data-regulation-preset-cat="团体标准">团体标准</button>
                                                <button type="button" class="btn-secondary" data-regulation-preset-cat="行业标准">行业标准</button>
                                                <button type="button" class="btn-secondary" data-regulation-preset-cat="企业制度">企业制度</button>
                                            </div>
                                            <label>
                                                <span>分类说明（选填）</span>
                                                <textarea id="regulations-new-folder-desc" name="description" class="form-input" maxlength="200" rows="3" placeholder="可选填写该分类目录的归类范围或治理说明"></textarea>
                                            </label>
                                        </div>
                                        <div class="regulations-admin-actions">
                                            <button type="button" class="btn-secondary" data-regulations-close-create-folder>取消</button>
                                            <button type="submit" class="btn-primary" id="regulations-create-folder-submit">确认创建</button>
                                        </div>
                                    </form>
                                </div>
                            </section>
                        `;
                    }

        Object.assign(ns, {
            ensureView,
            renderShell,
            buildViewHtml,
            renderSearchArchivedControl,
            renderRegulationDialogs,
            renderAdminPanel,
            renderShellReady: true
        });
})();
