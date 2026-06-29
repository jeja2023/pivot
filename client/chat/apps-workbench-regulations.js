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

    function canManage() { return typeof isAdminUser === 'function' ? isAdminUser() : false; }
    function canImportDocuments() {
        const user = typeof currentUser !== 'undefined' ? currentUser : window.currentUser;
        return String(user?.username || '').toLowerCase() === 'admin';
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
        if (doc?.effect_status === 'expired') chips.push('<span class="regulations-status-pill expired">已废止</span>');
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
        if (canManage()) {
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
        const expiredCount = docs.filter(doc => doc.effect_status === 'expired').length;
        const archivedCount = docs.filter(doc => doc.status === 'archived').length;
        const activeCount = Math.max(docs.length - expiredCount - archivedCount, 0);
        const categories = new Set(docs.map(doc => doc.category).filter(Boolean));
        const jurisdictions = new Set(docs.map(doc => doc.jurisdiction).filter(Boolean));
        const chips = [
            `${Number(state.total || 0)} 文档`,
            `${docs.length} 本页`,
            `${activeCount} 有效`,
            `${expiredCount} 已废止`,
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
        renderAiAnswer();
        syncImportHint(document.getElementById('regulations-upload-form'));
    }

    function buildViewHtml() {
        const admin = canManage();
        const canImport = canImportDocuments();
        return `
            <div class="regulations-panel">
                <main class="workspace-panel regulations-main">
                    <div class="workspace-toolbar regulations-toolbar">
                        <button id="regulations-ai-open-btn" class="btn-primary regulations-ai-entry-btn" type="button">AI问答</button>
                        <input id="regulations-query" class="form-input regulations-query-input" type="search" placeholder="搜索法规名称、发布机构或条文" value="${esc(state.query)}">
                        <input id="regulations-category-filter" class="form-input regulations-filter-input" placeholder="分类" value="${esc(state.filters.category)}">
                        <input id="regulations-jurisdiction-filter" class="form-input regulations-filter-input" placeholder="适用范围" value="${esc(state.filters.jurisdiction)}">
                        ${admin ? `<label class="regulations-checkline"><input id="regulations-include-archived" type="checkbox" ${state.filters.includeArchived ? 'checked' : ''}><span>显示已归档</span></label>` : ''}
                        <button id="regulations-search-btn" class="btn-secondary" type="button">搜索</button>
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
                                    <th style="width: 106px;">生效日期</th>
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

    function renderRegulationDialogs() {
        return `
            <section id="regulations-detail-panel" class="regulations-admin-panel hidden" role="dialog" aria-modal="true" aria-labelledby="regulations-detail-title">
                <div class="regulations-admin-dialog regulations-detail-dialog">
                    <div class="regulations-dialog-head">
                        <div>
                            <h3 id="regulations-detail-title">法规原文</h3>
                        </div>
                        <div class="regulations-detail-head-actions">
                            <span id="regulations-detail-admin-actions"></span>
                            <button class="btn-secondary workspace-modal-close regulations-dialog-close" type="button" data-regulations-close-detail>关闭</button>
                        </div>
                    </div>
                    <div id="regulations-detail-forms"></div>
                    <div id="regulations-detail-body" class="regulations-dialog-body"></div>
                </div>
            </section>
            <section id="regulations-ai-panel" class="regulations-admin-panel hidden" role="dialog" aria-modal="true" aria-labelledby="regulations-ai-title">
                <div class="regulations-admin-dialog regulations-ai-dialog">
                    <div class="regulations-dialog-head">
                        <div>
                            <h3 id="regulations-ai-title">AI问答</h3>
                            <p>基于法规库检索命中的条文回答，并标注依据。</p>
                        </div>
                        <button class="btn-secondary workspace-modal-close regulations-dialog-close" type="button" data-regulations-close-ai>关闭</button>
                    </div>
                    <div class="regulations-ai-modal-body">
                        <textarea id="regulations-ai-question" class="form-input regulations-ai-question-input" placeholder="输入问题，例如：该制度对审批流程有哪些要求？"></textarea>
                        <div class="regulations-ai-actions">
                            <button id="regulations-ai-btn" class="btn-primary" type="button">生成回答</button>
                            <button id="regulations-ai-clear-btn" class="btn-secondary" type="button">清空</button>
                        </div>
                        <div id="regulations-ai-answer" class="regulations-ai-answer"></div>
                        <div id="regulations-search-results" class="regulations-search-results"></div>
                    </div>
                </div>
            </section>
        `;
    }
    function renderAdminPanel() {
        return `
            <section id="regulations-admin-panel" class="regulations-admin-panel hidden" role="dialog" aria-modal="true" aria-labelledby="regulations-import-title">
                <div class="regulations-admin-dialog">
                    <div class="regulations-dialog-head">
                        <div>
                            <h3 id="regulations-import-title">导入文档</h3>
                            <p>可一次选择多个文件；系统会优先从正文或文件名识别法规名称和发布日期。批量导入时可只填写分类、适用范围等公共字段。</p>
                        </div>
                        <button class="btn-secondary workspace-modal-close regulations-dialog-close" type="button" data-regulations-close-upload>关闭</button>
                    </div>
                    <form id="regulations-upload-form" class="regulations-admin-form model-form">
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
                                <label>生效日期<input name="effectiveDate" class="form-input" maxlength="40" placeholder="如 2026-06-29；批量可留空"></label>
                                <label>失效日期<input name="expireDate" class="form-input" maxlength="40" placeholder="可选；留空视为现行有效"></label>
                                <label>版本标识<input name="versionLabel" class="form-input" maxlength="80" placeholder="如 2024年修正、2020年修订；留空按施行日期"></label>
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
                                <small class="regulations-file-hint">支持 ${SUPPORTED_FORMATS}；可批量选择，最多 300 个文件。标题、生效日期可留空，由系统自动识别。</small>
                            </label>
                        </div>
                        <div class="regulations-admin-actions regulations-import-actions"><button id="regulations-upload-submit" class="btn-primary" type="submit">上传入库</button></div>
                    </form>
                </div>
            </section>
            <section id="regulations-import-result-panel" class="regulations-admin-panel hidden" role="dialog" aria-modal="true">
                <div class="regulations-admin-dialog">
                    <div class="regulations-dialog-head">
                        <div><h3>导入结果</h3></div>
                        <button class="btn-secondary workspace-modal-close regulations-dialog-close" type="button" data-regulations-close-result>关闭</button>
                    </div>
                    <div id="regulations-import-result-body"></div>
                </div>
            </section>
            <datalist id="regulations-category-list"></datalist>
            <datalist id="regulations-jurisdiction-list"></datalist>
            <section id="regulations-compare-panel" class="regulations-admin-panel hidden" role="dialog" aria-modal="true">
                <div class="regulations-admin-dialog">
                    <div class="regulations-dialog-head">
                        <div><h3>版本对比</h3></div>
                        <button class="btn-secondary workspace-modal-close regulations-dialog-close" type="button" data-regulations-close-compare>关闭</button>
                    </div>
                    <div id="regulations-compare-body"></div>
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
                    <td title="${esc(doc.effective_date || '')}">${esc(doc.effective_date || '-')}</td>
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
        // 管理员可在详情弹窗内编辑信息、追加版本
        if (adminActions) {
            adminActions.innerHTML = canManage() ? `
                <button class="btn-secondary" type="button" data-regulation-edit="${esc(doc.id)}">编辑信息</button>
                <button class="btn-secondary" type="button" data-regulation-add-version="${esc(doc.id)}">追加版本</button>
            ` : '';
        }
        if (formsHost) {
            formsHost.innerHTML = canManage() ? renderInlineEditor(doc) + renderVersionUploader(doc) : '';
        }
        const originalText = articles.map(article => {
            const content = String(article.content || '').trim();
            if (!content) return '';
            const label = cleanDisplayTitle(article.article_label || '', '');
            if (!label || label === '全文' || content.startsWith(label)) return content;
            return `${label}\n\n${content}`;
        }).filter(Boolean).join('\n\n');
        target.innerHTML = originalText ? `
            <article class="regulations-original-document">
                <div class="regulations-article-body">${renderRichText(originalText)}</div>
            </article>
        ` : `<div class="regulations-empty compact">${esc(title)} 暂无可查看的法规原文</div>`;
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
                        <label>分类<input name="category" class="form-input" maxlength="120" value="${esc(doc.category || '')}" list="regulations-category-list"></label>
                        <label>发布机构<input name="issuingBody" class="form-input" maxlength="120" value="${esc(doc.issuing_body || '')}"></label>
                        <label>适用范围<input name="jurisdiction" class="form-input" maxlength="120" value="${esc(doc.jurisdiction || '')}" list="regulations-jurisdiction-list"></label>
                        <label>生效日期<input name="effectiveDate" class="form-input" maxlength="40" value="${esc(doc.effective_date || '')}"></label>
                        <label>失效日期<input name="expireDate" class="form-input" maxlength="40" value="${esc(doc.expire_date || '')}" placeholder="可选；留空视为现行有效"></label>
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
                        <label>版本标识<input name="versionLabel" class="form-input" maxlength="80" placeholder="如 2024年修正；留空按施行日期"></label>
                        <label>施行日期<input name="effectiveDate" class="form-input" maxlength="40" placeholder="如 2024-12-01；留空自动识别"></label>
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

    function renderSearchResults() {
        const target = document.getElementById('regulations-search-results');
        if (!target) return;
        target.innerHTML = `
            <div class="regulations-section-head compact"><strong>条文命中</strong><span>${state.matches.length} 条</span></div>
            ${state.matches.map(match => `
                <button class="regulations-match" type="button" data-regulation-match-doc="${esc(match.document_id)}" data-regulation-match-article="${esc(match.article_id)}">
                    <strong>${esc(match.document_title || '未命名法规')}</strong>
                    <span>${esc([match.article_label, match.article_title].filter(Boolean).join(' '))}</span>
                    <p>${highlightText(match.excerpt || match.content || '', state.query)}</p>
                </button>
            `).join('') || '<div class="regulations-empty compact">搜索后显示相关条文</div>'}
        `;
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
        target.innerHTML = state.aiTurns.map(turn => {
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
        document.getElementById('regulations-import-result-panel')?.classList.add('hidden');
        document.getElementById('regulations-compare-panel')?.classList.add('hidden');
        document.getElementById('regulations-detail-panel')?.classList.add('hidden');
        document.getElementById('regulations-ai-panel')?.classList.add('hidden');
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
        if (state.query) params.set('query', state.query);
        if (state.filters.category) params.set('category', state.filters.category);
        if (state.filters.jurisdiction) params.set('jurisdiction', state.filters.jurisdiction);
        if (canManage() && state.filters.includeArchived) params.set('includeArchived', 'true');
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

    async function runSearch() {
        state.query = document.getElementById('regulations-query')?.value.trim() || '';
        state.filters.category = document.getElementById('regulations-category-filter')?.value.trim() || '';
        state.filters.jurisdiction = document.getElementById('regulations-jurisdiction-filter')?.value.trim() || '';
        state.filters.includeArchived = !!document.getElementById('regulations-include-archived')?.checked;
        await loadDocuments({ keepActive: false, page: 1 });
        if (state.query) {
            // 条文命中覆盖全库，便于跨法规检索并跳转，而非仅限当前文档
            const params = new URLSearchParams({ query: state.query, limit: '20' });
            if (canManage() && state.filters.includeArchived) params.set('includeArchived', 'true');
            const data = await fetchJson(`${API}/documents/search?${params.toString()}`);
            state.matches = Array.isArray(data.matches) ? data.matches : [];
        } else {
            state.matches = [];
        }
        renderSearchResults();
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
        if (typeof window.confirm === 'function' && !window.confirm('确定删除该法规文档吗？删除后仅管理员可在归档列表中查看。')) return;
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
            const data = await fetchJson(`${API}/ai`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query: question, limit: 8, history })
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
                </div>
            </form>
            <div id="regulations-diff-result"></div>
        `;
        panel.classList.remove('hidden');
        focusFirstField(body);
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
            if (event.target.closest('#regulations-search-btn')) {
                runSearch().catch(e => toast(e.message || '搜索失败', 'error'));
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
            if (['regulations-admin-panel', 'regulations-detail-panel', 'regulations-ai-panel'].includes(event.target.id)) {
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
                archiveDocument(del.dataset.regulationDelete);
                return;
            }
            const match = event.target.closest('[data-regulation-match-doc]');
            if (match) {
                document.getElementById('regulations-ai-panel')?.classList.add('hidden');
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
            if (event.target.closest('[data-regulations-close-result]')) {
                document.getElementById('regulations-import-result-panel')?.classList.add('hidden');
                return;
            }
            if (event.target.closest('[data-regulations-close-compare]')) {
                document.getElementById('regulations-compare-panel')?.classList.add('hidden');
                state.diffView = null;
                return;
            }
            const compare = event.target.closest('[data-regulation-compare]');
            if (compare) {
                showCompareDialog(compare.dataset.regulationCompare);
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
            await Promise.all([loadDocuments({ keepActive: true, page: state.page }), loadFacets()]);
            await parseDeepLink();
        } catch (e) {
            toast(e.message || '加载法规查询失败', 'error');
        }
    }

    window.PivotRegulations = { showRegulationsApp, loadDocuments, runSearch };
    window.showRegulationsApp = showRegulationsApp;
})();














