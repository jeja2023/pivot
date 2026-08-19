/* eslint-disable no-undef -- Split regulations modules resolve names through PivotRegulationsInternal. */
(function () {
    const ns = window.PivotRegulationsInternal;
    if (!ns) throw new Error('法规库核心模块未加载');
    if (ns.renderShellReady) return;
    with (ns) {
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
                        return `
                            <div class="regulations-panel">
                                <main class="workspace-panel regulations-main">
                                    <div class="workspace-toolbar regulations-toolbar">
                                        <button id="regulations-open-search-btn" class="btn-primary regulations-search-entry-btn" type="button">检索</button>
                                        <button id="regulations-ai-open-btn" class="btn-secondary regulations-ai-entry-btn" type="button">AI问答</button>
                                        <button id="regulations-refresh-btn" class="btn-secondary" type="button">刷新</button>
                                        ${canImport ? '<button id="regulations-open-upload-btn" class="btn-secondary" type="button">导入文档</button>' : ''}
                                    </div>
                                    ${canImport ? renderAdminPanel() : ''}
                                    ${renderRegulationDialogs()}
                                    <div id="regulations-summary" class="regulations-summary"></div>
                                    <div class="table-container workspace-table-wrap regulations-doc-table-wrap">
                                        <table class="data-table regulations-doc-table">
                                            <thead>
                                                <tr>
                                                    <th style="width: 54px;" class="text-center">序号</th>
                                                    <th style="width: 250px;">文档名称</th>
                                                    <th style="width: 118px;">分类</th>
                                                    <th style="width: 140px;">发布机构</th>
                                                    <th style="width: 130px;">适用范围</th>
                                                    <th style="width: 96px;" class="text-center">状态</th>
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
                            <section id="regulations-search-panel" class="regulations-admin-panel hidden" role="dialog" aria-modal="true" aria-labelledby="regulations-search-title">
                                <div class="workspace-modal regulations-admin-dialog regulations-search-dialog">
                                    <div class="workspace-modal-header">
                                        <div>
                                            <h3 id="regulations-search-title">检索法规</h3>
                                        </div>
                                        <button class="btn-secondary workspace-modal-close" type="button" data-regulations-close-search>关闭</button>
                                    </div>
                                    <div class="workspace-modal-body regulations-search-modal-body">
                                        <div class="regulations-search-form">
                                            <label class="regulations-search-field regulations-search-field-wide"><span>检索内容</span><input id="regulations-query" class="form-input regulations-query-input" type="search" placeholder="搜索法规名称、发布机构或条文" value="${esc(state.query)}"></label>
                                            <label class="regulations-search-field"><span>检索模式</span><select id="regulations-search-mode" class="form-input regulations-mode-select" aria-label="检索模式">
                                                <option value="hybrid" ${state.searchMode !== 'keyword' ? 'selected' : ''}>混合检索</option>
                                                <option value="keyword" ${state.searchMode === 'keyword' ? 'selected' : ''}>关键词</option>
                                            </select></label>
                                            <label class="regulations-search-field"><span>分类</span><input id="regulations-category-filter" class="form-input regulations-filter-input" placeholder="分类" value="${esc(state.filters.category)}"></label>
                                            <label class="regulations-search-field"><span>适用范围</span><input id="regulations-jurisdiction-filter" class="form-input regulations-filter-input" placeholder="适用范围" value="${esc(state.filters.jurisdiction)}"></label>
                                            ${renderSearchArchivedControl()}
                                        </div>
                                        <div class="regulations-search-modal-actions">
                                            <button id="regulations-search-btn" class="btn-primary" type="button">检索</button>
                                            <button id="regulations-save-search-btn" class="btn-secondary" type="button">保存检索</button>
                                        </div>
                                        <div id="regulations-saved-searches" class="regulations-saved-searches hidden"></div>
                                        <div id="regulations-modal-search-results" class="regulations-search-results regulations-search-modal-results hidden" data-regulations-search-results></div>
                                    </div>
                                </div>
                            </section>
                            <section id="regulations-detail-panel" class="regulations-admin-panel hidden" role="dialog" aria-modal="true" aria-labelledby="regulations-detail-title">
                                <div class="workspace-modal regulations-admin-dialog regulations-detail-dialog">
                                    <div class="workspace-modal-header">
                                        <div>
                                            <h3 id="regulations-detail-title">法规原文</h3>
                                        </div>
                                        <div class="regulations-detail-head-actions">
                                            <span id="regulations-detail-admin-actions"></span>
                                            <button class="btn-secondary workspace-modal-close" type="button" data-regulations-close-detail>关闭</button>
                                        </div>
                                    </div>
                                    <div id="regulations-detail-forms"></div>
                                    <div id="regulations-detail-body" class="workspace-modal-body regulations-dialog-body"></div>
                                </div>
                            </section>
                            <section id="regulations-ai-panel" class="regulations-admin-panel hidden" role="dialog" aria-modal="true" aria-labelledby="regulations-ai-title">
                                <div class="workspace-modal regulations-admin-dialog regulations-ai-dialog">
                                    <div class="workspace-modal-header">
                                        <div>
                                            <h3 id="regulations-ai-title">AI问答</h3>
                                            <p>基于法规库检索命中的条文回答，并标注依据。</p>
                                        </div>
                                        <button class="btn-secondary workspace-modal-close" type="button" data-regulations-close-ai>关闭</button>
                                    </div>
                                    <div class="workspace-modal-body regulations-ai-modal-body">
                                        <textarea id="regulations-ai-question" class="form-input regulations-ai-question-input" placeholder="输入问题，例如：该制度对审批流程有哪些要求？"></textarea>
                                        <div class="regulations-ai-actions">
                                            <button id="regulations-ai-btn" class="btn-primary" type="button">生成回答</button>
                                            <button id="regulations-ai-clear-btn" class="btn-secondary" type="button">清空</button>
                                        </div>
                                        <div id="regulations-ai-answer" class="regulations-ai-answer"></div>
                                        <div id="regulations-ai-search-results" class="regulations-search-results regulations-ai-search-results hidden" data-regulations-search-results></div>
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
                        `;
                    }
                    function renderAdminPanel() {
                        return `
                            <section id="regulations-admin-panel" class="regulations-admin-panel hidden" role="dialog" aria-modal="true" aria-labelledby="regulations-import-title">
                                <div class="workspace-modal regulations-admin-dialog">
                                    <div class="workspace-modal-header">
                                        <div>
                                            <h3 id="regulations-import-title">导入文档</h3>
                                            <p>可一次选择多个文件；系统会优先从正文或文件名识别法规名称 and 发布日期。批量导入时可只填写分类、适用范围等公共字段。</p>
                                        </div>
                                        <button class="btn-secondary workspace-modal-close" type="button" data-regulations-close-upload>关闭</button>
                                    </div>
                                    <form id="regulations-upload-form" class="workspace-modal-body regulations-admin-form model-form">
                                        <div class="regulations-admin-group">
                                            <div class="regulations-admin-group-head"><strong>快速预设</strong><span>点击模板自动填充常用字段</span></div>
                                            <div class="regulations-preset-row">
                                                <button type="button" class="regulations-preset-btn" data-preset="law">法律（人大）</button>
                                                <button type="button" class="regulations-preset-btn" data-preset="lawSc">法律（人大常委会）</button>
                                                <button type="button" class="regulations-preset-btn" data-preset="regulation">行政法规</button>
                                                <button type="button" class="regulations-preset-btn" data-preset="interpretation">司法解释（最高法）</button>
                                                <button type="button" class="regulations-preset-btn" data-preset="procuratorate">司法解释（最高检）</button>
                                                <button type="button" class="regulations-preset-btn" data-preset="rule">部门规章</button>
                                            </div>
                                        </div>
                                        <div class="regulations-admin-group">
                                            <div class="regulations-admin-group-head"><strong>基础信息</strong><span>名称和日期可留空，系统会自动识别</span></div>
                                            <div class="regulations-admin-grid">
                                                <label>标题<input id="regulations-upload-title" name="title" class="form-input" maxlength="120" placeholder="单个文件可填写；批量建议留空自动识别"></label>
                                                <label>分类<input name="category" class="form-input" maxlength="120" placeholder="如 法律、行政法规、司法解释" list="regulations-category-list"></label>
                                                <label>发布机构<input name="issuingBody" class="form-input" maxlength="120" placeholder="如 全国人大常委会、国务院"></label>
                                                <label>适用范围<input name="jurisdiction" class="form-input" maxlength="120" placeholder="如 全国、某省、某市" list="regulations-jurisdiction-list"></label>
                                                <label>版本标识<input name="versionLabel" class="form-input" maxlength="80" placeholder="如 2024年修正；留空按文件名日期识别"></label>
                                            </div>
                                        </div>
                                        <div class="regulations-admin-group">
                                            <div class="regulations-admin-group-head"><strong>摘要与文件</strong><span>批量导入最多 300 个文件</span></div>
                                            <label>摘要<textarea name="summary" class="form-input" rows="3" placeholder="可选；留空时从文档正文生成摘要"></textarea></label>
                                            <label class="regulations-file-field">
                                                <span>文档文件</span>
                                                <span class="regulations-file-control">
                                                    <input id="regulations-upload-file" class="regulations-file-input" name="file" type="file" multiple accept="${FILE_ACCEPT}" required>
                                                    <span class="regulations-file-button">选择文档</span>
                                                    <span id="regulations-file-summary" class="regulations-file-summary">未选择文件</span>
                                                </span>
                                                <small class="regulations-file-hint">支持 ${SUPPORTED_FORMATS}；可批量选择，最多 300 个文件。标题、版本可留空，由系统自动识别。</small>
                                            </label>
                                        </div>
                                        <div class="regulations-admin-actions regulations-import-actions">
                                            <button type="button" class="btn-secondary" data-regulation-preview>预览条文</button>
                                            <button id="regulations-upload-submit" class="btn-primary" type="submit">上传入库</button>
                                        </div>
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
    }
})();
