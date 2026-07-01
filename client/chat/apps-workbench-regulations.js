(function () {
    const API = '/api/apps/regulations';
    const FILE_ACCEPT = '.txt,.md,.pdf,.doc,.docx,.xls,.xlsx,.csv,.json,.html,.htm';
    const SUPPORTED_FORMATS = 'TXT、Markdown、PDF、Word（DOC/DOCX）、Excel（XLS/XLSX）、CSV、JSON、HTML/HTM';
    const REGULATIONS_PAGE_SIZE = 20;
    const html = window.PivotSafeHtml || {
        escapeHtml(value) {
            return String(value ?? '')
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#039;');
        }
    };

    const state = {
        documents: [], total: 0, activeId: '', detail: null, matches: [], query: '',
        searchMode: 'hybrid', savedSearches: [],
        filters: { category: '', jurisdiction: '', includeArchived: false },
        aiAnswer: '', aiSources: [], aiTurns: [], aiBusy: false,
        facets: { categories: [], jurisdictions: [] },
        page: 1, pageSize: REGULATIONS_PAGE_SIZE,
        diffView: null,
        busy: false, loaded: false
    };

    const PRESETS = {
        law: { category: '法律', issuingBody: '全国人民代表大会', jurisdiction: '全国' },
        lawSc: { category: '法律', issuingBody: '全国人大常委会', jurisdiction: '全国' },
        regulation: { category: '行政法规', issuingBody: '国务院', jurisdiction: '全国' },
        interpretation: { category: '司法解释', issuingBody: '最高人民法院', jurisdiction: '全国' },
        procuratorate: { category: '司法解释', issuingBody: '最高人民检察院', jurisdiction: '全国' },
        rule: { category: '部门规章', issuingBody: '', jurisdiction: '全国' }
    };

    function esc(value) { return html.escapeHtml(value); }

    // 将正文按 Markdown 渲染为带排版的 HTML，渲染器不可用时回退为转义纯文本
    function renderRichText(content) {
        const text = String(content || '').trim();
        if (!text) return '';
        if (typeof window.renderMarkdown === 'function') {
            try {
                const htmlText = window.renderMarkdown(text);
                if (htmlText) return htmlText;
            } catch (_) { /* 渲染失败时回退到纯文本展示 */ }
        }
        return `<p>${esc(text).replace(/\n/g, '<br>')}</p>`;
    }

    function stripMarkdownTitleLine(value) {
        return String(value || '')
            .trim()
            .replace(/^#{1,6}\s*/, '')
            .replace(/^>\s*/, '')
            .replace(/^[-*+]\s+/, '')
            .replace(/^\d+[.)、]\s+/, '')
            .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
            .replace(/[*_`~]+/g, '')
            .split(/\s+#{1,6}\s+/)[0]
            .trim();
    }

    // 去除标题里残留的 Markdown 标记符号和摘要换行，表格中只展示纯标题
    function cleanDisplayTitle(value, fallback = '未命名法规') {
        const lines = String(value || fallback || '')
            .replace(/\r/g, '\n')
            .split('\n')
            .map(stripMarkdownTitleLine)
            .filter(Boolean);
        return lines[0] || fallback;
    }

    function cleanArticleTitle(value) {
        return cleanDisplayTitle(value, '');
    }

    function escapeRegExp(value) {
        return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    // 在转义后的文本上高亮检索词，仅注入受控的 <mark> 标签，无 XSS 风险
    function highlightText(text, query) {
        const safe = esc(text || '');
        const terms = String(query || '').trim().split(/\s+/).map(esc).filter(term => term.length >= 1);
        if (!terms.length) return safe;
        const pattern = new RegExp(`(${terms.map(escapeRegExp).join('|')})`, 'gi');
        return safe.replace(pattern, '<mark class="regulations-hl">$1</mark>');
    }

    function getActiveUser() {
        return typeof currentUser !== 'undefined' ? currentUser : window.currentUser;
    }

    function canManage() {
        const user = getActiveUser();
        if (typeof isAdminUser === 'function' && isAdminUser(user)) return true;
        const tier = String(user?.permissionTier || user?.permission_tier || '').toLowerCase();
        return user?.isAdmin === true
            || user?.is_admin === true
            || tier === 'admin'
            || tier === 'manager';
    }

    function canImportDocuments() {
        const user = getActiveUser();
        return String(user?.username || '').toLowerCase() === 'admin';
    }

    function getRegulationsSelectedModelId() {
        return document.getElementById('model-selector')?.value || '';
    }

    // 删除类操作统一走项目内自定义确认弹窗（不使用浏览器默认 confirm）；showConfirm 不可用时回退
    function regulationConfirm(title, message) {
        return new Promise((resolve) => {
            if (typeof window.showConfirm === 'function') {
                window.showConfirm(title, message, () => resolve(true));
                const cancelBtn = document.getElementById('modal-confirm-cancel');
                const container = document.getElementById('confirm-container');
                const cleanup = (result) => {
                    cancelBtn?.removeEventListener('click', onCancel);
                    container?.removeEventListener('click', onOverlay);
                    resolve(result);
                };
                const onCancel = () => cleanup(false);
                const onOverlay = (event) => { if (event.target === container) cleanup(false); };
                cancelBtn?.addEventListener('click', onCancel, { once: true });
                container?.addEventListener('click', onOverlay, { once: true });
                return;
            }
            resolve(typeof window.confirm === 'function' ? window.confirm(message) : true);
        });
    }

    function canDeleteDocuments() {
        const user = getActiveUser();
        if (typeof isSuperAdminUser === 'function' && isSuperAdminUser(user)) return true;
        const tier = String(user?.permissionTier || user?.permission_tier || '').toLowerCase();
        const username = String(user?.username || '').trim().toLowerCase();
        return user?.isSuperAdmin === true
            || user?.is_super_admin === true
            || tier === 'admin'
            || (username === 'admin' && (user?.role === 'admin' || user?.isAdmin === true || user?.is_admin === true));
    }

    function toast(message, type) { if (typeof showToast === 'function') showToast(message, type); }

    async function fetchJson(url, options = {}) {
        const res = await apiFetch(url, options);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error?.message || data?.error || `请求失败（${res.status}）`);
        return data;
    }

    function fmtSize(value) {
        const size = Number(value || 0);
        if (!Number.isFinite(size) || size <= 0) return '-';
        if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
        if (size >= 1024) return `${(size / 1024).toFixed(1)} KB`;
        return `${size} B`;
    }

    function fmtDate(value) {
        if (!value) return '-';
        if (typeof formatDateToCN === 'function') return formatDateToCN(value);
        return String(value).slice(0, 16) || '-';
    }

    function renderRegulationStatusCell(doc) {
        const chips = [];
        if (doc?.status === 'archived') chips.push('<span class="regulations-status-pill archived">已归档</span>');
        if (!chips.length) chips.push('<span class="regulations-status-pill active">有效</span>');
        return `<span class="regulations-status-cell">${chips.join('')}</span>`;
    }

    function renderRegulationActions(doc) {
        const actions = [
            `<button class="btn-secondary regulations-row-action" type="button" data-regulation-open-doc="${esc(doc.id)}">查看</button>`
        ];
        if (canManage() && doc?.current_version_id) {
            actions.push(`<a class="btn-secondary regulations-row-action" href="${API}/documents/${encodeURIComponent(doc.id)}/download?versionId=${encodeURIComponent(doc.current_version_id)}">下载</a>`);
        }
        if (canDeleteDocuments()) {
            actions.push(`<button class="btn-danger-outline regulations-row-action" type="button" data-regulation-delete="${esc(doc.id)}">删除</button>`);
        }
        return `<div class="regulations-row-actions">${actions.join('')}</div>`;
    }

    function getRegulationsPageSummary() {
        const total = Number(state.total || 0);
        const pageSize = Math.max(Number(state.pageSize || REGULATIONS_PAGE_SIZE), 1);
        const totalPages = Math.max(Math.ceil(total / pageSize), 1);
        const page = Math.min(Math.max(Number(state.page || 1), 1), totalPages);
        return `第 ${page} / ${totalPages} 页`;
    }

    function renderRegulationsSummary() {
        const target = document.getElementById('regulations-summary');
        if (!target) return;
        const docs = Array.isArray(state.documents) ? state.documents : [];
        const articleCount = docs.reduce((sum, doc) => sum + Number(doc.article_count || 0), 0);
        const archivedCount = docs.filter(doc => doc.status === 'archived').length;
        const activeCount = Math.max(docs.length - archivedCount, 0);
        const categories = new Set(docs.map(doc => doc.category).filter(Boolean));
        const jurisdictions = new Set(docs.map(doc => doc.jurisdiction).filter(Boolean));
        const chips = [
            `${Number(state.total || 0)} 文档`,
            `${docs.length} 本页`,
            `${activeCount} 有效`,
            `${archivedCount} 已归档`,
            `${articleCount} 条文`,
            `${categories.size} 分类`,
            `${jurisdictions.size} 适用范围`,
            getRegulationsPageSummary()
        ];
        target.innerHTML = chips.map(text => `<span class="regulations-summary-pill">${esc(text)}</span>`).join('');
    }

    function renderDocumentsPagination() {
        if (typeof window.renderWorkspacePagination !== 'function') return;
        window.renderWorkspacePagination('regulations-pagination', {
            total: state.total,
            page: state.page,
            limit: state.pageSize,
            onPageChange: targetPage => loadDocuments({ page: targetPage, keepActive: true })
        });
    }
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
        view.innerHTML = buildViewHtml();
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

    function renderDocuments() {
        const target = document.getElementById('regulations-doc-list');
        if (!target) return;
        if (!state.documents.length) {
            target.innerHTML = '<tr><td colspan="11" class="text-center">暂无法规文档</td></tr>';
        } else {
            const startIndex = (Math.max(Number(state.page || 1), 1) - 1) * Math.max(Number(state.pageSize || REGULATIONS_PAGE_SIZE), 1);
            target.innerHTML = state.documents.map((doc, index) => {
                const title = esc(cleanDisplayTitle(doc.title || '未命名法规'));
                const rowIndex = startIndex + index + 1;
                return `
                <tr class="regulations-doc-row">
                    <td class="text-center">${rowIndex}</td>
                    <td title="${title}">
                        <strong class="regulations-doc-title">${title}</strong>
                    </td>
                    <td title="${esc(doc.category || '')}">${esc(doc.category || '-')}</td>
                    <td title="${esc(doc.issuing_body || '')}">${esc(doc.issuing_body || '-')}</td>
                    <td title="${esc(doc.jurisdiction || '')}">${esc(doc.jurisdiction || '-')}</td>
                    <td class="text-center">${renderRegulationStatusCell(doc)}</td>
                    <td class="text-center"><span class="regulations-article-count">${Number(doc.article_count || 0)}</span></td>
                    <td title="${esc(doc.current_version_label || '')}">${esc(doc.current_version_label || '-')}</td>
                    <td title="${esc(fmtDate(doc.updated_at || doc.current_version_updated_at || doc.created_at))}">${esc(fmtDate(doc.updated_at || doc.current_version_updated_at || doc.created_at))}</td>
                    <td class="text-center">${renderRegulationActions(doc)}</td>
                </tr>`;
            }).join('');
        }
        renderRegulationsSummary();
        renderDocumentsPagination();
    }
    function renderDetail() {
        const target = document.getElementById('regulations-detail-body');
        if (!target) return;
        const detail = state.detail;
        const adminActions = document.getElementById('regulations-detail-admin-actions');
        const formsHost = document.getElementById('regulations-detail-forms');
        if (!detail?.document) {
            target.innerHTML = '<div class="regulations-placeholder">请选择法规文档查看正文。</div>';
            if (adminActions) adminActions.innerHTML = '';
            if (formsHost) formsHost.innerHTML = '';
            return;
        }
        const doc = detail.document;
        const articles = Array.isArray(detail.articles) ? detail.articles : [];
        const title = cleanDisplayTitle(doc.title || '未命名法规');
        // 管理员可在详情弹窗内编辑信息、追加版本；引用网络对所有人可见（只读）
        if (adminActions) {
            const graphBtn = `<button class="btn-secondary" type="button" data-regulation-graph="${esc(doc.id)}">引用网络</button>`;
            const timelineBtn = (Array.isArray(detail.versions) && detail.versions.length >= 1)
                ? `<button class="btn-secondary" type="button" data-regulation-timeline="${esc(doc.id)}">修订时间线</button>` : '';
            adminActions.innerHTML = graphBtn + timelineBtn + (canManage() ? `
                <button class="btn-secondary" type="button" data-regulation-edit="${esc(doc.id)}">编辑信息</button>
                <button class="btn-secondary" type="button" data-regulation-add-version="${esc(doc.id)}">追加版本</button>
            ` : '');
        }
        if (formsHost) {
            formsHost.innerHTML = canManage() ? renderInlineEditor(doc) + renderVersionUploader(doc) : '';
        }
        // #5 废止/修订提醒横幅：汇总被其它法律 supersede 的条文
        const superseded = articles.filter(a => Array.isArray(a.supersededBy) && a.supersededBy.length);
        const supersedeBanner = superseded.length ? `
            <div class="regulations-supersede-banner">
                <strong>修订提醒</strong>
                <span>本法以下条文已被其它法规废止或修订：</span>
                <ul>
                    ${superseded.map(a => a.supersededBy.map(s => `
                        <li>${esc(a.article_label)} ← <button class="regulations-supersede-link" type="button" data-regulation-match-doc="${esc(s.sourceDocumentId)}">${esc(s.sourceDocumentTitle)} ${esc(s.sourceArticleLabel || '')}</button></li>
                    `).join('')).join('')}
                </ul>
            </div>
        ` : '';
        // 分条渲染：每条带 regulation-article-{id} 锚点，便于引用图/废止/AI依据精确跳转
        // 单条「全文」时退化为整篇展示
        const isWhole = articles.length === 1 && (articles[0].article_label === '全文' || !articles[0].article_label);
        let bodyHtml;
        if (isWhole) {
            bodyHtml = `<article id="regulation-article-${esc(articles[0].id)}" class="regulations-original-document">
                <div class="regulations-article-body">${renderRichText(articles[0].content || '')}</div>
            </article>`;
        } else {
            bodyHtml = articles.map(article => {
                const content = String(article.content || '').trim();
                if (!content) return '';
                const label = cleanDisplayTitle(article.article_label || '', '');
                const statusBadge = renderArticleStatusBadge(article);
                const supersededBadge = (Array.isArray(article.supersededBy) && article.supersededBy.length)
                    ? '<span class="regulations-article-badge superseded">被修订</span>' : '';
                const annotationCount = Number(article.annotationCount || 0);
                const articleId = esc(article.id);
                const articleAnchor = `${doc.id}.${article.id}`;
                const annotateBtn = `<button class="regulations-article-tool regulations-article-annotate" type="button" data-regulation-annotate="${articleId}">批注${annotationCount ? ` · ${annotationCount}` : ''}</button>`;
                const tools = [
                    statusBadge,
                    supersededBadge,
                    `<button class="regulations-article-tool" type="button" data-article-copy="${articleId}">复制</button>`,
                    `<button class="regulations-article-tool" type="button" data-article-ask="${articleId}">提问</button>`,
                    `<button class="regulations-article-tool" type="button" data-article-link="${esc(articleAnchor)}">定位</button>`,
                    `<button class="regulations-article-tool" type="button" data-regulation-similar="${articleId}">相似</button>`,
                    annotateBtn
                ].filter(Boolean).join('');
                // 正文若已以条号开头则不重复标题
                const showLabel = label && label !== '全文' && !content.startsWith(label);
                return `
                    <article id="regulation-article-${articleId}" class="regulations-article-block">
                        <div class="regulations-article-block-head">
                            ${showLabel ? `<strong>${esc(label)}</strong>` : '<span></span>'}
                            <span class="regulations-article-block-tools">
                                ${tools}
                            </span>
                        </div>
                        <div class="regulations-article-body">${renderRichText(content)}</div>
                    </article>
                `;
            }).filter(Boolean).join('');
        }
        target.innerHTML = bodyHtml
            ? `${supersedeBanner}${bodyHtml}`
            : `${supersedeBanner}<div class="regulations-empty compact">${esc(title)} 暂无可查看的法规原文</div>`;
    }

    // #8 条文状态徽章：amended（已修正）/ repealed（已废止），active 不显示
    function renderArticleStatusBadge(article) {
        const status = String(article?.status || 'active');
        if (status === 'repealed') {
            return `<span class="regulations-article-badge repealed">已废止${article.amended_date ? ` · ${esc(article.amended_date)}` : ''}</span>`;
        }
        if (status === 'amended') {
            return `<span class="regulations-article-badge amended">已修正${article.amended_date ? ` · ${esc(article.amended_date)}` : ''}</span>`;
        }
        return '';
    }

    function renderInlineEditor(doc) {
        return `
            <form id="regulations-edit-form" class="regulations-inline-form hidden" data-doc-id="${esc(doc.id)}">
                <div class="regulations-dialog-head">
                    <div>
                        <h3>编辑法规信息</h3>
                        <p>这些信息用于筛选、检索和问答引用。</p>
                    </div>
                </div>
                <div class="regulations-admin-group">
                    <div class="regulations-admin-grid">
                        <label>标题<input name="title" class="form-input" maxlength="120" value="${esc(doc.title || '')}" required></label>
                        <label>\u7248\u672c\u6807\u8bc6<input name="versionLabel" class="form-input" maxlength="80" value="${esc(doc.current_version_label || '')}" placeholder="\u5982 2024\u5e74\u4fee\u6b63\u30012020\u5e74\u4fee\u8ba2"></label>
                        <label>分类<input name="category" class="form-input" maxlength="120" value="${esc(doc.category || '')}" list="regulations-category-list"></label>
                        <label>发布机构<input name="issuingBody" class="form-input" maxlength="120" value="${esc(doc.issuing_body || '')}"></label>
                        <label>适用范围<input name="jurisdiction" class="form-input" maxlength="120" value="${esc(doc.jurisdiction || '')}" list="regulations-jurisdiction-list"></label>
                        <label>状态<select name="status" class="form-input">
                            <option value="active" ${doc.status !== 'archived' ? 'selected' : ''}>启用</option>
                            <option value="archived" ${doc.status === 'archived' ? 'selected' : ''}>归档</option>
                        </select></label>
                    </div>
                    <label>摘要<textarea name="summary" class="form-input" rows="3">${esc(doc.summary || '')}</textarea></label>
                </div>
                <div class="regulations-admin-actions">
                    <button class="btn-secondary" type="button" data-regulation-cancel-inline>取消</button>
                    <button class="btn-primary" type="submit">保存</button>
                </div>
            </form>
        `;
    }

    function renderVersionUploader(doc) {
        return `
            <form id="regulations-version-form" class="regulations-inline-form hidden" data-doc-id="${esc(doc.id)}">
                <div class="regulations-dialog-head">
                    <div>
                        <h3>追加版本</h3>
                        <p>上传新版本后会重新解析条文，并设为当前版本。</p>
                    </div>
                </div>
                <div class="regulations-admin-group">
                    <div class="regulations-admin-grid">
                        <label>版本标识<input name="versionLabel" class="form-input" maxlength="80" placeholder="如 2024年修正；留空按文件名日期识别"></label>
                        <label>标题<input name="title" class="form-input" maxlength="120" value="${esc(doc.title || '')}"></label>
                    </div>
                    <label>摘要<textarea name="summary" class="form-input" rows="3" placeholder="可选；留空时从新版本正文生成摘要"></textarea></label>
                    <label class="regulations-file-field">
                        <span>新版本文件</span>
                        <span class="regulations-file-control">
                            <input name="file" class="regulations-file-input" type="file" accept="${FILE_ACCEPT}" required>
                            <span class="regulations-file-button">选择文件</span>
                            <span class="regulations-file-summary">未选择文件</span>
                        </span>
                        <small class="regulations-file-hint">支持 ${SUPPORTED_FORMATS}。</small>
                    </label>
                </div>
                <div class="regulations-admin-actions">
                    <button class="btn-secondary" type="button" data-regulation-cancel-inline>取消</button>
                    <button class="btn-primary" type="submit">上传版本</button>
                </div>
            </form>
        `;
    }

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
            target.innerHTML = '';
            return;
        }
        target.classList.remove('hidden');
        target.innerHTML = `
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
        `;
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
            target.innerHTML = (!hasQuery && !hasMatches) ? '' : resultsHtml;
        });
    }
    function renderAiAnswer() {
        const target = document.getElementById('regulations-ai-answer');
        if (!target) return;
        if (state.aiBusy) {
            target.innerHTML = '<div class="regulations-loading">正在生成回答…</div>';
            return;
        }
        if (!state.aiTurns.length) {
            target.innerHTML = '<div class="regulations-empty compact">AI 回答会显示在这里</div>';
            return;
        }
        target.innerHTML = state.aiTurns.map((turn, turnIndex) => {
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
        }).join('');
    }


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
        if (detailEl) detailEl.innerHTML = '<div class="regulations-loading">正在加载法规详情…</div>';
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
        body.innerHTML = `
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
        `;
    }

    async function showSimilarArticles(articleId) {
        const panel = document.getElementById('regulations-similar-panel');
        const body = document.getElementById('regulations-similar-body');
        if (!panel || !body) return;
        panel.classList.remove('hidden');
        body.innerHTML = '<div class="regulations-loading">正在查找相似条文…</div>';
        try {
            const resp = await fetchJson(`${API}/articles/${encodeURIComponent(articleId)}/similar?limit=8`);
            renderSimilarArticles(body, Array.isArray(resp.similar) ? resp.similar : [], articleId);
        } catch (e) {
            body.innerHTML = `<div class="regulations-empty compact">${esc(e.message || '加载相似条文失败')}</div>`;
        }
    }
    async function uploadDocument(form) {
        const fileInput = form.querySelector('#regulations-upload-file');
        const fileCount = Number(fileInput?.files?.length || 0);
        if (!fileCount) {
            toast('请选择要导入的文档', 'warning');
            return;
        }
        const formData = new FormData(form);
        const endpoint = fileCount > 1 ? `${API}/documents/batch` : `${API}/documents`;
        setBusy(true, fileCount > 1 ? `正在导入 ${fileCount} 个文档...` : '正在导入文档...');
        try {
            const data = await fetchJson(endpoint, { method: 'POST', body: formData });
            if (fileCount > 1) {
                const created = Array.isArray(data.created) ? data.created : [];
                const failed = Array.isArray(data.failed) ? data.failed : [];
                state.activeId = created[0]?.document?.id || state.activeId || '';
                const hasIssues = failed.length > 0 || created.some(c => c.duplicateOf);
                if (hasIssues) {
                    showImportResult(created, failed);
                }
                toast(`已导入 ${created.length} 个文档${failed.length ? `，${failed.length} 个失败` : ''}`, failed.length ? 'warning' : undefined);
            } else {
                state.activeId = data.document?.id || '';
                if (data.duplicateOf) {
                    toast(`文档已导入（疑似重复：${data.duplicateOf.title || '已有同源文档'}）`, 'warning');
                } else {
                    toast('文档已导入');
                }
            }
            form.reset();
            syncImportHint(form);
            closeDialogs();
            await loadDocuments({ keepActive: true, page: 1 });
        } catch (e) {
            toast(e.message || '导入失败', 'error');
        } finally {
            setBusy(false);
        }
    }

    function showImportResult(created, failed) {
        const panel = document.getElementById('regulations-import-result-panel');
        const body = document.getElementById('regulations-import-result-body');
        if (!panel || !body) return;
        const createdHtml = created.length ? `
            <div class="regulations-import-section">
                <div class="regulations-section-head compact"><strong>已导入</strong><span>${created.length} 个</span></div>
                ${created.map(item => {
                    const dup = item.duplicateOf ? `<span class="regulations-badge warning">疑似重复：${esc(item.duplicateOf.title || '已有同源')}</span>` : '';
                    return `<div class="regulations-import-item success">${esc(item.sourceName || item.document?.title || '文档')} ${dup}</div>`;
                }).join('')}
            </div>
        ` : '';
        const failedHtml = failed.length ? `
            <div class="regulations-import-section">
                <div class="regulations-section-head compact"><strong>失败</strong><span>${failed.length} 个</span></div>
                ${failed.map(item => `
                    <div class="regulations-import-item error">
                        <strong>${esc(item.fileName || '文件')}</strong>
                        <span>${esc(item.message || '导入失败')}</span>
                    </div>
                `).join('')}
            </div>
        ` : '';
        body.innerHTML = createdHtml + failedHtml;
        panel.classList.remove('hidden');
    }

    async function saveMetadata(form) {
        const docId = form.dataset.docId;
        const payload = collectForm(form);
        setBusy(true, '正在保存法规信息...');
        try {
            await fetchJson(`${API}/documents/${encodeURIComponent(docId)}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            toast('法规信息已保存');
            closeInlineForms();
            await loadDocuments({ keepActive: true, page: state.page });
            await loadDetail(docId);
        } catch (e) {
            toast(e.message || '保存失败', 'error');
        } finally {
            setBusy(false);
        }
    }

    async function uploadVersion(form) {
        const docId = form.dataset.docId;
        const fileInput = form.querySelector('input[type="file"]');
        if (!fileInput?.files?.length) {
            toast('请选择新版本文件', 'warning');
            return;
        }
        const formData = new FormData(form);
        setBusy(true, '正在上传新版本...');
        try {
            await fetchJson(`${API}/documents/${encodeURIComponent(docId)}/versions`, { method: 'POST', body: formData });
            toast('新版本已上传');
            form.reset();
            syncFileInputState(fileInput);
            closeInlineForms();
            await loadDocuments({ keepActive: true, page: state.page });
            await loadDetail(docId);
        } catch (e) {
            toast(e.message || '上传版本失败', 'error');
        } finally {
            setBusy(false);
        }
    }

    async function archiveDocument(id) {
        if (!id) return;
        if (!(await regulationConfirm('删除法规文档', '确定删除该法规文档吗？删除后仅管理员可在归档列表中查看。'))) return;
        setBusy(true, '正在删除法规文档...');
        try {
            await fetchJson(`${API}/documents/${encodeURIComponent(id)}`, { method: 'DELETE' });
            toast('法规文档已删除');
            state.activeId = '';
            state.detail = null;
            document.getElementById('regulations-detail-panel')?.classList.add('hidden');
            await loadDocuments({ keepActive: false, page: 1 });
        } catch (e) {
            toast(e.message || '删除失败', 'error');
        } finally {
            setBusy(false);
        }
    }

    async function askAi() {
        const question = document.getElementById('regulations-ai-question')?.value.trim() || '';
        if (!question) {
            toast('请输入要咨询的问题', 'warning');
            return;
        }
        state.aiBusy = true;
        renderAiAnswer();
        setBusy(true, '正在生成回答...');
        try {
            // 多轮问答：携带最近 4 轮历史，每轮仍做全库检索
            const history = state.aiTurns.slice(-4).map(t => ({ question: t.question, answer: t.answer }));
            const model = getRegulationsSelectedModelId() || undefined;
            const data = await fetchJson(`${API}/ai`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query: question, limit: 8, history, model })
            });
            const answer = data.content || data.answer || '';
            const sources = Array.isArray(data.sources) ? data.sources : [];
            state.aiTurns.push({ question, answer, sources });
        } catch (e) {
            toast(e.message || 'AI 回答失败', 'error');
        } finally {
            state.aiBusy = false;
            setBusy(false);
            renderAiAnswer();
        }
    }

    async function loadFacets() {
        try {
            const data = await fetchJson(`${API}/facets${canManage() && state.filters.includeArchived ? '?includeArchived=true' : ''}`);
            state.facets.categories = Array.isArray(data.categories) ? data.categories : [];
            state.facets.jurisdictions = Array.isArray(data.jurisdictions) ? data.jurisdictions : [];
            const catList = document.getElementById('regulations-category-list');
            const jurList = document.getElementById('regulations-jurisdiction-list');
            if (catList) catList.innerHTML = state.facets.categories.map(c => `<option value="${esc(c)}">`).join('');
            if (jurList) jurList.innerHTML = state.facets.jurisdictions.map(j => `<option value="${esc(j)}">`).join('');
        } catch (_e) {
            // facets 失败不影响主流程
        }
    }

    function clearAiTurns() {
        state.aiTurns = [];
        renderAiAnswer();
    }

    // #4 引用网络：拉取条文引用图并用轻量 SVG 渲染（环形布局，无第三方库）
    const REG_GRAPH_REL_COLORS = {
        cite: '#10a37f',
        depend: '#2563eb',
        supersede: '#d97706',
        apply: '#7c3aed'
    };

    async function showCitationGraph(docId) {
        const panel = document.getElementById('regulations-graph-panel');
        const body = document.getElementById('regulations-graph-body');
        if (!panel || !body) return;
        panel.classList.remove('hidden');
        body.innerHTML = '<div class="regulations-loading">正在加载引用网络…</div>';
        try {
            const resp = await fetchJson(`${API}/documents/${encodeURIComponent(docId)}/citation-graph`);
            renderCitationGraph(body, resp.graph || null);
        } catch (e) {
            body.innerHTML = `<div class="regulations-empty compact">${esc(e.message || '加载引用网络失败')}</div>`;
        }
    }

    function renderCitationGraph(container, graph) {
        if (!container) return;
        const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
        const edges = Array.isArray(graph?.edges) ? graph.edges : [];
        if (!nodes.length) {
            container.innerHTML = '<div class="regulations-empty compact">该文档暂无条文节点</div>';
            return;
        }
        const internalEdges = edges.filter(e => !e.external);
        if (!internalEdges.length) {
            container.innerHTML = '<div class="regulations-empty compact">该文档条文之间暂无已解析的引用关系</div>';
            return;
        }
        // 环形布局
        const size = 520;
        const cx = size / 2;
        const cy = size / 2;
        const radius = size / 2 - 60;
        const pos = new Map();
        nodes.forEach((n, i) => {
            const angle = (2 * Math.PI * i) / nodes.length - Math.PI / 2;
            pos.set(n.id, { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) });
        });
        const edgeLines = internalEdges.map(e => {
            const s = pos.get(e.source);
            const t = pos.get(e.target);
            if (!s || !t) return '';
            const color = REG_GRAPH_REL_COLORS[e.type] || '#94a3b8';
            return `<line x1="${s.x.toFixed(1)}" y1="${s.y.toFixed(1)}" x2="${t.x.toFixed(1)}" y2="${t.y.toFixed(1)}" stroke="${color}" stroke-width="1.5" stroke-opacity="0.6" marker-end="url(#reg-arrow)"></line>`;
        }).join('');
        const nodeCircles = nodes.map(n => {
            const p = pos.get(n.id);
            if (!p) return '';
            const label = esc(cleanDisplayTitle(n.label || '', n.label || ''));
            return `
                <g class="regulations-graph-node" data-graph-doc="${esc(graph.document?.id || '')}" data-graph-article="${esc(n.id)}" tabindex="0">
                    <circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="6" fill="#10a37f"></circle>
                    <text x="${p.x.toFixed(1)}" y="${(p.y - 10).toFixed(1)}" text-anchor="middle" font-size="10" fill="#334155">${label}</text>
                </g>
            `;
        }).join('');
        const legend = Object.entries(REG_GRAPH_REL_COLORS).map(([type, color]) => {
            const used = internalEdges.some(e => (e.type || 'cite') === type);
            if (!used) return '';
            const labelMap = { cite: '引用', depend: '依据', supersede: '废止/修订', apply: '适用' };
            return `<span class="regulations-graph-legend-item"><i style="background:${color}"></i>${labelMap[type] || type}</span>`;
        }).join('');
        container.innerHTML = `
            <div class="regulations-graph-legend">${legend}</div>
            <svg class="regulations-graph-svg" viewBox="0 0 ${size} ${size}" width="100%" height="${size}">
                <defs>
                    <marker id="reg-arrow" markerWidth="8" markerHeight="8" refX="10" refY="3" orient="auto" markerUnits="strokeWidth">
                        <path d="M0,0 L6,3 L0,6 Z" fill="#94a3b8"></path>
                    </marker>
                </defs>
                ${edgeLines}
                ${nodeCircles}
            </svg>
        `;
    }

    // #7 导入预览：解析条文、展示并允许合并，最终回填到导入表单或直接入库
    // #10 条文批注：打开面板、加载、提交、删除
    async function showAnnotations(articleId) {
        const panel = document.getElementById('regulations-annotation-panel');
        const body = document.getElementById('regulations-annotation-body');
        if (!panel || !body) return;
        panel.dataset.articleId = articleId;
        panel.classList.remove('hidden');
        body.innerHTML = '<div class="regulations-loading">正在加载批注…</div>';
        try {
            const resp = await fetchJson(`${API}/articles/${encodeURIComponent(articleId)}/annotations`);
            renderAnnotations(body, Array.isArray(resp.annotations) ? resp.annotations : [], articleId);
        } catch (e) {
            body.innerHTML = `<div class="regulations-empty compact">${esc(e.message || '加载批注失败')}</div>`;
        }
    }

    function renderAnnotations(body, annotations, articleId) {
        const currentUserId = (typeof currentUser !== 'undefined' ? currentUser : window.currentUser)?.id;
        body.innerHTML = `
            <form class="regulations-annotation-form" data-annotation-article="${esc(articleId)}">
                <textarea class="form-input" name="content" rows="3" placeholder="输入内部理解、适用案例或注意事项…" required></textarea>
                <div class="regulations-admin-actions">
                    <button type="submit" class="btn-primary">提交批注</button>
                </div>
            </form>
            <div class="regulations-annotation-list">
                ${annotations.length ? annotations.map(a => `
                    <div class="regulations-annotation-item">
                        <div class="regulations-annotation-meta">
                            <strong>${esc(a.user_name || '匿名')}</strong>
                            <span>${esc(a.updated_at || a.created_at || '')}</span>
                            ${Number(a.user_id) === Number(currentUserId) ? `<button class="btn-text regulations-annotation-delete" type="button" data-annotation-delete="${esc(a.id)}" data-annotation-article="${esc(articleId)}">删除</button>` : ''}
                        </div>
                        <div class="regulations-annotation-content">${esc(a.content)}</div>
                    </div>
                `).join('') : '<div class="regulations-empty compact">暂无批注，添加第一条吧</div>'}
            </div>
        `;
    }

    async function submitAnnotation(form) {
        const articleId = form.dataset.annotationArticle;
        const content = form.querySelector('[name="content"]')?.value?.trim();
        if (!content) {
            toast('请输入批注内容', 'warning');
            return;
        }
        try {
            await fetchJson(`${API}/articles/${encodeURIComponent(articleId)}/annotations`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content })
            });
            toast('批注已提交', 'success');
            showAnnotations(articleId);
        } catch (e) {
            toast(e.message || '提交失败', 'error');
        }
    }

    async function deleteAnnotation(annotationId, articleId) {
        if (!(await regulationConfirm('删除批注', '确定删除该批注吗？'))) return;
        try {
            await fetchJson(`${API}/annotations/${encodeURIComponent(annotationId)}`, { method: 'DELETE' });
            toast('批注已删除', 'success');
            showAnnotations(articleId);
        } catch (e) {
            toast(e.message || '删除失败', 'error');
        }
    }

    // #11 导出合规报告：把某轮问答生成 Markdown 并下载
    async function exportRegulationReport(turnIndex) {
        const turn = state.aiTurns[turnIndex];
        if (!turn) return;
        setBusy(true, '正在生成报告...');
        try {
            const resp = await fetchJson(`${API}/report`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ question: turn.question, answer: turn.answer, sources: turn.sources || [] })
            });
            const blob = new Blob([resp.markdown || ''], { type: 'text/markdown;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `法规查询报告_${Date.now()}.md`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            toast('报告已导出', 'success');
        } catch (e) {
            toast(e.message || '导出失败', 'error');
        } finally {
            setBusy(false);
        }
    }

    async function previewRegulationImport() {
        const form = document.getElementById('regulations-upload-form');
        if (!form) return;
        const fileInput = form.querySelector('input[name="file"]');
        const files = fileInput?.files;
        if (!files?.length) {
            toast('请先选择文件', 'warning');
            return;
        }
        if (files.length > 1) {
            toast('预览模式仅支持单文件，批量导入请直接提交', 'warning');
            return;
        }
        const file = files[0];
        const formData = new FormData();
        formData.append('file', file);
        // 读取表单元数据传给解析端
        const metadata = collectForm(form);
        Object.keys(metadata).forEach(k => {
            if (k !== 'file') formData.append(k, metadata[k] || '');
        });
        setBusy(true, '正在解析文档...');
        try {
            const resp = await fetchJson(`${API}/documents/preview`, { method: 'POST', body: formData });
            showPreviewPanel(resp, file, metadata);
        } catch (e) {
            toast(e.message || '预览失败', 'error');
        } finally {
            setBusy(false);
        }
    }

    function showPreviewPanel(preview, file, metadata) {
        const panel = document.getElementById('regulations-preview-panel');
        const body = document.getElementById('regulations-preview-body');
        if (!panel || !body) return;
        const articles = Array.isArray(preview.articles) ? preview.articles : [];
        const articleCount = Number(preview.articleCount || 0) || articles.length;
        body.innerHTML = `
            <div class="regulations-preview-summary">
                <strong>${esc(preview.title || file.name)}</strong>
                <span>${articleCount} 条</span>
            </div>
            <div class="regulations-preview-articles" id="regulations-preview-list">
                ${articles.map((a, i) => `
                    <div class="regulations-preview-article" data-preview-index="${i}">
                        <div class="regulations-preview-article-head">
                            <input type="checkbox" class="regulations-preview-checkbox" data-preview-check="${i}" />
                            <strong>${esc(a.articleLabel || `条目 ${i + 1}`)}</strong>
                            ${a.articleTitle ? `<span class="regulations-preview-title">${esc(a.articleTitle)}</span>` : ''}
                        </div>
                        <div class="regulations-preview-content">${esc(a.content?.substring(0, 200) || '')}${a.content?.length > 200 ? '…' : ''}</div>
                    </div>
                `).join('')}
            </div>
            <div class="regulations-admin-actions">
                <button type="button" class="btn-secondary" data-preview-merge>合并选中条文</button>
                <button type="button" class="btn-primary" data-preview-confirm>确认入库</button>
            </div>
        `;
        // 缓存预览数据供确认时提交
        panel.dataset.previewFile = file.name;
        panel.dataset.previewData = JSON.stringify({ articles, metadata, file: { name: file.name, size: file.size } });
        panel.classList.remove('hidden');
    }

    // #13 修订时间线：按版本施行日期排序展示，点击切换版本
    function showVersionTimeline(docId) {
        const panel = document.getElementById('regulations-timeline-panel');
        const body = document.getElementById('regulations-timeline-body');
        if (!panel || !body) return;
        const versions = (state.detail?.versions || []).slice();
        // 按版本 id 升序（早→晚），版本标识多为施行日期
        versions.sort((a, b) => Number(a.id) - Number(b.id));
        if (!versions.length) {
            body.innerHTML = '<div class="regulations-empty compact">暂无版本</div>';
        } else {
            body.innerHTML = `
                <div class="regulations-timeline">
                    ${versions.map(v => `
                        <button class="regulations-timeline-node ${Number(v.id) === Number(state.detail?.currentVersion?.id) ? 'active' : ''}" type="button" data-timeline-version="${esc(v.id)}" data-timeline-doc="${esc(docId)}">
                            <span class="regulations-timeline-dot"></span>
                            <span class="regulations-timeline-label">${esc(v.version_label || `版本 ${v.id}`)}</span>
                            <span class="regulations-timeline-meta">${Number(v.article_count || 0)} 条${v.is_current ? ' · 当前版本' : ''}</span>
                        </button>
                    `).join('')}
                </div>
            `;
        }
        panel.classList.remove('hidden');
    }

    async function showCompareDialog(docId) {
        const versions = state.detail?.versions || [];
        if (versions.length < 2) {
            toast('至少需要两个版本才能对比', 'warning');
            return;
        }
        const panel = document.getElementById('regulations-compare-panel');
        const body = document.getElementById('regulations-compare-body');
        if (!panel || !body) return;
        body.innerHTML = `
            <form id="regulations-compare-form" data-doc-id="${esc(docId)}">
                <div class="regulations-admin-group">
                    <label>从版本
                        <select name="from" class="form-input" required>
                            ${versions.map(v => `<option value="${esc(v.id)}">${esc(v.version_label || `版本 ${v.id}`)}</option>`).join('')}
                        </select>
                    </label>
                    <label>到版本
                        <select name="to" class="form-input" required>
                            ${versions.map((v, i) => `<option value="${esc(v.id)}" ${i === 0 ? 'selected' : ''}>${esc(v.version_label || `版本 ${v.id}`)}</option>`).join('')}
                        </select>
                    </label>
                </div>
                <div class="regulations-admin-actions">
                    <button type="submit" class="btn-primary">生成对比</button>
                    <button type="button" class="btn-secondary" data-regulation-impact>影响分析</button>
                </div>
            </form>
            <div id="regulations-diff-result"></div>
        `;
        panel.classList.remove('hidden');
        focusFirstField(body);
    }

    async function runChangeImpact(form) {
        const docId = form.dataset.docId;
        const data = collectForm(form);
        const result = document.getElementById('regulations-diff-result');
        if (!result) return;
        setBusy(true, '正在分析变更影响...');
        try {
            const resp = await fetchJson(`${API}/documents/${encodeURIComponent(docId)}/change-impact?from=${encodeURIComponent(data.from)}&to=${encodeURIComponent(data.to)}`);
            renderChangeImpact(result, resp.impact || null);
        } catch (e) {
            toast(e.message || '影响分析失败', 'error');
        } finally {
            setBusy(false);
        }
    }

    function renderChangeImpact(container, impact) {
        if (!container) return;
        if (!impact) {
            container.innerHTML = '<div class="regulations-empty compact">无影响分析结果</div>';
            return;
        }
        const impacts = Array.isArray(impact.impacts) ? impact.impacts : [];
        const summary = impact.summary || {};
        if (!impacts.length) {
            container.innerHTML = `
                <div class="regulations-diff-summary">
                    <strong>变更影响分析</strong>
                    <span>变更 ${summary.changed || 0} · 删除 ${summary.removed || 0}</span>
                    <span>本次变更的条文未被库内其它条文引用，影响面较小。</span>
                </div>
            `;
            return;
        }
        container.innerHTML = `
            <div class="regulations-diff-summary">
                <strong>变更影响分析</strong>
                <span>${impacts.length} 个变更条文被引用，需关注以下受影响条文</span>
            </div>
            ${impacts.map(item => `
                <div class="regulations-diff-article changed">
                    <strong>${esc(item.label)} 被引用</strong>
                    <div class="regulations-impact-referers">
                        ${(item.internalReferers || []).map(r => `
                            <button class="regulations-impact-referer" type="button" data-regulation-match-doc="${esc(impact.document?.id || '')}" data-regulation-match-article="${esc(r.article_id)}">
                                本法 ${esc(r.article_label)}${r.article_title ? ` ${esc(r.article_title)}` : ''}
                            </button>
                        `).join('')}
                        ${(item.crossReferers || []).map(r => `
                            <button class="regulations-impact-referer cross" type="button" data-regulation-match-doc="${esc(r.document_id)}" data-regulation-match-article="${esc(r.article_id)}">
                                ${esc(r.document_title)} ${esc(r.article_label)}
                            </button>
                        `).join('')}
                    </div>
                </div>
            `).join('')}
        `;
    }

    async function runCompare(form) {
        const docId = form.dataset.docId;
        const data = collectForm(form);
        const result = document.getElementById('regulations-diff-result');
        if (!result) return;
        setBusy(true, '正在生成版本对比...');
        try {
            const diff = await fetchJson(`${API}/documents/${encodeURIComponent(docId)}/diff?from=${encodeURIComponent(data.from)}&to=${encodeURIComponent(data.to)}`);
            state.diffView = diff.diff || null;
            renderDiff(result);
        } catch (e) {
            toast(e.message || '版本对比失败', 'error');
        } finally {
            setBusy(false);
        }
    }

    function renderDiff(container) {
        if (!container || !state.diffView) return;
        const diff = state.diffView;
        const summary = diff.summary || {};
        const addedHtml = (diff.added || []).length ? `
            <div class="regulations-diff-section">
                <div class="regulations-section-head compact"><strong>新增条文</strong><span>${diff.added.length} 条</span></div>
                ${diff.added.map(a => `
                    <div class="regulations-diff-article added">
                        <strong>${esc(a.label)}</strong>
                        <span>${esc(cleanArticleTitle(a.title))}</span>
                        <pre>${esc(a.content)}</pre>
                    </div>
                `).join('')}
            </div>
        ` : '';
        const removedHtml = (diff.removed || []).length ? `
            <div class="regulations-diff-section">
                <div class="regulations-section-head compact"><strong>删除条文</strong><span>${diff.removed.length} 条</span></div>
                ${diff.removed.map(a => `
                    <div class="regulations-diff-article removed">
                        <strong>${esc(a.label)}</strong>
                        <span>${esc(cleanArticleTitle(a.title))}</span>
                        <pre>${esc(a.content)}</pre>
                    </div>
                `).join('')}
            </div>
        ` : '';
        const changedHtml = (diff.changed || []).length ? `
            <div class="regulations-diff-section">
                <div class="regulations-section-head compact"><strong>变更条文</strong><span>${diff.changed.length} 条</span></div>
                ${diff.changed.map(a => `
                    <div class="regulations-diff-article changed">
                        <strong>${esc(a.label)}</strong>
                        <span>${esc(cleanArticleTitle(a.title))}</span>
                        <div class="regulations-diff-lines">
                            ${(a.segments || []).map(seg => {
                                if (seg.type === 'add') return `<div class="diff-line added">+ ${esc(seg.text)}</div>`;
                                if (seg.type === 'del') return `<div class="diff-line removed">- ${esc(seg.text)}</div>`;
                                return `<div class="diff-line eq">${esc(seg.text)}</div>`;
                            }).join('')}
                        </div>
                    </div>
                `).join('')}
            </div>
        ` : '';
        container.innerHTML = `
            <div class="regulations-diff-summary">
                <strong>${esc(diff.document?.title || '文档')}</strong>
                <span>${esc(diff.from?.version_label || `版本 ${diff.from?.id}`)} → ${esc(diff.to?.version_label || `版本 ${diff.to?.id}`)}</span>
                <span>新增 ${summary.added || 0} · 删除 ${summary.removed || 0} · 变更 ${summary.changed || 0}</span>
            </div>
            ${addedHtml}${removedHtml}${changedHtml}
        `;
    }

    function syncImportHint(form) {
        const fileInput = form?.querySelector('#regulations-upload-file');
        const submitBtn = form?.querySelector('#regulations-upload-submit');
        if (!fileInput || !submitBtn) return;
        syncFileInputState(fileInput);
        const count = Number(fileInput.files?.length || 0);
        submitBtn.textContent = count > 1 ? `批量导入 ${count} 个文档` : '上传入库';
    }

    function getFileSelectionText(fileInput) {
        const files = Array.from(fileInput?.files || []);
        if (!files.length) return '未选择文件';
        if (files.length === 1) {
            const file = files[0];
            return `${file.name || '已选择文件'}${file.size ? ` · ${fmtSize(file.size)}` : ''}`;
        }
        const totalSize = files.reduce((sum, file) => sum + Number(file.size || 0), 0);
        return `已选择 ${files.length} 个文档${totalSize ? ` · 共 ${fmtSize(totalSize)}` : ''}`;
    }

    function syncFileInputState(fileInput) {
        const summary = fileInput?.closest('.regulations-file-field')?.querySelector('.regulations-file-summary');
        if (summary) summary.textContent = getFileSelectionText(fileInput);
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
        sessionStorage.setItem('pivot_apps_active_app', 'regulations');
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

    window.PivotRegulations = { showRegulationsApp, loadDocuments, runSearch };
    window.showRegulationsApp = showRegulationsApp;
})();














