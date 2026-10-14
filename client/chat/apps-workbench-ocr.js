(function () {
    if (window.Pivot.legacy.PivotOcr?.ready) return;

    const API = '/api/apps/ocr';
    const state = {
        jobs: [],
        detail: null,
        activeJobId: '',
        activePageId: '',
        status: '',
        page: 1,
        limit: 12,
        total: 0,
        queue: null,
        engines: {},
        settings: null,
        capabilities: null,
        drafts: {},
        reviewCandidates: [],
        reviewPanelInfo: null,
        isReviewerPanelOpen: false,
        selectedReviewerIds: new Set(),
        regionSelection: null,
        regionCandidate: null,
        regionDrag: null,
        ocrWatchUnsubscribe: null,
        detailRequestId: 0,
        timer: null
    };

    const html = window.Pivot.legacy.PivotSafeHtml || {
        escapeHtml(value) {
            return String(value ?? '')
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#039;');
        },
        setHtml(element, value) {
            if (!element) return;
            element.replaceChildren(document.createTextNode(String(value || '')));
        }
    };

    function esc(value) {
        return html.escapeHtml(value);
    }

    function toast(message, type) {
        if (typeof showToast === 'function') showToast(message, type);
    }

    async function requestJson(url, options = {}) {
        const res = await apiFetch(url, options);
        const data = await res.clone().json().catch(() => ({}));
        if (!res.ok) {
            throw new Error(data?.error?.message || data?.error || data?.message || `请求失败（${res.status}）`);
        }
        return data;
    }

    function formatBytes(value) {
        const size = Number(value || 0);
        if (!Number.isFinite(size) || size <= 0) return '-';
        if (size < 1024) return `${size} B`;
        if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
        return `${(size / 1024 / 1024).toFixed(1)} MB`;
    }

    function formatTime(value) {
        if (!value) return '-';
        const date = new Date(String(value).replace(' ', 'T'));
        if (Number.isNaN(date.getTime())) return String(value);
        return date.toLocaleString('zh-CN', { hour12: false });
    }

    function statusLabel(status) {
        const map = {
            queued: '排队中',
            pending: '排队中',
            processing: '处理中',
            succeeded: '已完成',
            failed: '失败',
            cancelled: '已取消',
            needs_review: '待复核'
        };
        return map[status] || status || '-';
    }

    function statusTone(status) {
        if (status === 'succeeded') return 'is-success';
        if (status === 'failed') return 'is-danger';
        if (status === 'needs_review') return 'is-warning';
        if (status === 'processing' || status === 'queued' || status === 'pending') return 'is-info';
        return '';
    }

    function activePage() {
        const pages = state.detail?.pages || [];
        return pages.find(page => String(page.id) === String(state.activePageId)) || pages[0] || null;
    }

    function blocksForPage(pageId) {
        return (state.detail?.blocks || []).filter(block => String(block.pageId) === String(pageId));
    }

    function reviewForPage(pageId) {
        return (state.detail?.reviews || []).find(item => String(item.pageId) === String(pageId)) || null;
    }

    const reviewViews = window.Pivot.legacy.PivotOcrReviewViews?.create({
        state,
        esc,
        activePage,
        blocksForPage,
        statusTone,
        api: API
    });
    if (!reviewViews) throw new Error('文字识别复核视图模块未加载，请刷新页面后重试。');
    const ocrActions = window.Pivot.legacy.PivotOcrActions?.create({
        api: API,
        state,
        requestJson,
        toast,
        renderDetail,
        loadDetail,
        loadJobs,
        closeDetailPanel,
        submitUpload
    });
    if (!ocrActions) throw new Error('文字识别动作模块未加载，请刷新页面后重试。');

    function ensureView() {
        let view = document.getElementById('ocr-view');
        if (!view) {
            view = document.createElement('div');
            view.id = 'ocr-view';
            view.className = 'ocr-view hidden';
            const host = document.querySelector('.apps-workspace-body') || document.body;
            host.appendChild(view);
        }
        if (view.dataset.ready === '1') return view;
        html.setHtml(view, `
            <div class="ocr-layout doc-tool-layout">
                <aside class="workspace-panel doc-tool-sidebar ocr-sidebar">
                    <form id="ocr-upload-form" class="doc-tool-form">
                        <label class="doc-tool-field doc-tool-field-wide">
                            <span>文件</span>
                            <input id="ocr-file-input" class="form-input" type="file" accept=".pdf,.ofd,.png,.jpg,.jpeg,.gif,.webp,.bmp" multiple required>
                        </label>
                        <div class="doc-tool-field-row">
                            <label class="doc-tool-field ocr-engine-admin-only hidden">
                                <span>识别引擎</span>
                                <select id="ocr-engine-select" class="form-input">
                                    <option value="http">外部 OCR 服务</option>
                                </select>
                            </label>
                            <label class="doc-tool-field">
                                <span>语言</span>
                                <select id="ocr-language-select" class="form-input">
                                    <option value="ch">中文</option>
                                    <option value="en">英文</option>
                                    <option value="mixed">中英混合</option>
                                </select>
                            </label>
                        </div>
                        <div class="doc-tool-field-row">
                            <label class="doc-tool-field">
                                <span title="PDF 或多页文档渲染为图像时的清晰度（每英寸点数），默认 220">图像分辨率（DPI）</span>
                                <input id="ocr-dpi-input" class="form-input" type="number" min="72" max="600" value="220" title="渲染清晰度（DPI），默认 220，推荐范围 150-300">
                            </label>
                            <label class="doc-tool-field">
                                <span>本次页数上限</span>
                                <input id="ocr-pages-input" class="form-input" type="number" min="1" max="100" value="10">
                            </label>
                        </div>
                        <label class="doc-tool-field doc-tool-field-wide">
                            <span>处理页范围</span>
                            <input id="ocr-pages-range-input" class="form-input" type="text" inputmode="text" placeholder="留空处理全部；例如 1-3,5">
                            <small id="ocr-capability-hint" class="doc-tool-hint">超出本次页数上限时，请填写需要识别的页范围。</small>
                        </label>
                        <label class="doc-tool-field doc-tool-field-wide">
                            <span>PDF 密码</span>
                            <input id="ocr-password-input" class="form-input" type="password" autocomplete="off">
                        </label>
                        <div class="doc-tool-actions">
                            <button id="ocr-submit-btn" class="btn-primary" type="submit" title="创建文字识别任务">创建任务</button>
                            ${window.pivotDesktop?.executeLocalMcpTool ? '<button id="ocr-desktop-screenshot-btn" class="btn-secondary" type="button" title="截取已授权窗口">截取已授权窗口</button>' : ''}
                            ${window.pivotDesktop?.requestLocalAuthorization ? '<button id="ocr-authorize-watch-btn" class="btn-secondary" type="button" title="授权监控目录">授权监控目录</button><button id="ocr-revoke-watch-btn" class="btn-secondary" type="button" title="停止目录监听">停止目录监听</button>' : ''}
                        </div>
                    </form>

                    <div id="ocr-service-alert" class="ocr-service-alert hidden" role="alert">
                        <div class="ocr-service-alert-body">
                            <span class="ocr-service-alert-icon" aria-hidden="true">
                                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>
                            </span>
                            <div class="ocr-service-alert-content">
                                <strong>外部 OCR 服务未连接</strong>
                                <p id="ocr-service-alert-desc">外部识别服务连接失败，请确认服务已启动并在系统设置中配置。</p>
                            </div>
                        </div>
                        <button id="ocr-open-settings-btn" class="btn-secondary ocr-service-alert-btn ocr-engine-admin-only hidden" type="button">前往系统设置配置</button>
                    </div>
                </aside>

                <main class="workspace-panel doc-tool-main ocr-main">
                    <div class="workspace-toolbar doc-tool-toolbar ocr-tools-toolbar">
                        <div class="doc-tool-toolbar-title">
                            <div class="ocr-toolbar-heading">
                                <h4>文字识别任务</h4>
                                <span id="ocr-list-summary" class="ocr-list-summary-tag">0 个任务</span>
                            </div>
                        </div>
                        <div class="ocr-toolbar-actions">
                            <div class="ocr-filter-pill-control">
                                <label class="ocr-filter-pill-prefix" for="ocr-status-filter">
                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                                        <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"></polygon>
                                    </svg>
                                    <span>状态</span>
                                </label>
                                <div class="ocr-filter-pill-body">
                                    <select id="ocr-status-filter" class="form-input ocr-filter-pill-select" aria-label="按状态筛选">
                                        <option value="">全部</option>
                                        <option value="queued">排队中</option>
                                        <option value="processing">处理中</option>
                                        <option value="needs_review">待复核</option>
                                        <option value="succeeded">已完成</option>
                                        <option value="failed">失败</option>
                                        <option value="cancelled">已取消</option>
                                    </select>
                                    <span class="ocr-filter-pill-arrow" aria-hidden="true">
                                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                                            <polyline points="6 9 12 15 18 9"></polyline>
                                        </svg>
                                    </span>
                                </div>
                            </div>
                            <button id="ocr-refresh-btn" class="btn-secondary ocr-toolbar-refresh-btn" type="button" title="刷新任务列表">
                                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                                    <polyline points="1 4 1 10 7 10"></polyline>
                                    <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path>
                                </svg>
                                <span>刷新</span>
                            </button>
                        </div>
                    </div>
                    <div class="table-container workspace-table-wrap doc-tool-table-wrap">
                        <table class="data-table compact-table doc-tool-table ocr-job-table">
                            <thead>
                                <tr>
                                    <th style="width: 54px;" class="text-center">序号</th>
                                    <th style="width: 310px;">文件</th>
                                    <th class="ocr-engine-admin-only hidden" style="width: 110px;">识别引擎</th>
                                    <th style="width: 86px;" class="text-center">状态</th>
                                    <th style="width: 76px;" class="text-center">进度</th>
                                    <th style="width: 140px;">更新时间</th>
                                    <th style="width: 196px;" class="text-center">操作</th>
                                </tr>
                            </thead>
                            <tbody id="ocr-job-table-body"></tbody>
                        </table>
                    </div>
                    <div id="ocr-job-pagination" class="pagination workspace-pagination"></div>
                </main>
            </div>
            <section id="ocr-detail-panel" class="doc-tool-detail-panel hidden" role="dialog" aria-modal="true" aria-labelledby="ocr-detail-title">
                <div class="workspace-modal doc-tool-dialog ocr-detail-dialog">
                    <div class="workspace-modal-header">
                        <div>
                            <h3 id="ocr-detail-title">识别结果</h3>
                            <p id="ocr-detail-subtitle">查看页面预览、复核文本并导出结果。</p>
                        </div>
                        <button class="btn-secondary workspace-modal-close" type="button" data-ocr-close-detail>关闭</button>
                    </div>
                    <div id="ocr-detail" class="workspace-modal-body doc-tool-modal-body ocr-detail"></div>
                </div>
            </section>
        `);
        view.dataset.ready = '1';
        bindEvents(view);
        return view;
    }

    function canViewOcrEngineConfig() {
        return typeof isSuperAdminUser === 'function' && isSuperAdminUser();
    }

    function canManageOcrSettings() {
        return canViewOcrEngineConfig();
    }

    function renderEngineConfigVisibility() {
        const canView = canViewOcrEngineConfig();
        document.querySelectorAll('#ocr-view .ocr-engine-admin-only').forEach(el => {
            el.classList.toggle('hidden', !canView);
        });
    }

    function renderSettings() {
        // OCR 服务配置已统一收拢至「系统设置 → 模型配置」
    }

    function renderEngines() {
        renderEngineConfigVisibility();
        const alertBox = document.getElementById('ocr-service-alert');
        if (!alertBox) return;
        const entries = Object.entries(state.engines || {});
        if (!entries.length) {
            alertBox.classList.add('hidden');
            return;
        }
        const httpEngine = entries.find(([name]) => name === 'http')?.[1] || state.engines?.http || null;
        if (!httpEngine || httpEngine.available) {
            alertBox.classList.add('hidden');
        } else {
            alertBox.classList.remove('hidden');
            const descEl = document.getElementById('ocr-service-alert-desc');
            if (descEl) {
                descEl.textContent = httpEngine.error || '外部 OCR 服务连接失败，请确认服务已启动并在系统设置中检查配置。';
            }
        }
    }

    function renderOcrRowActions(item) {
        const canCancel = item.allowedActions?.cancel === true || item.status === 'queued' || item.status === 'processing' || item.status === 'pending';
        return [
            '<button class="btn-secondary doc-tool-row-action" type="button" data-ocr-job-open="' + esc(item.id) + '">查看</button>',
            canCancel ? '<button class="btn-secondary doc-tool-row-action" type="button" data-ocr-job-cancel="' + esc(item.id) + '">取消</button>' : '',
            '<button class="btn-danger-outline doc-tool-row-action" type="button" data-ocr-job-delete="' + esc(item.id) + '">删除</button>'
        ].filter(Boolean).join('');
    }

    function isDetailPanelOpen() {
        return !document.getElementById('ocr-detail-panel')?.classList.contains('hidden');
    }

    function openDetailPanel() {
        document.getElementById('ocr-detail-panel')?.classList.remove('hidden');
    }

    function closeDetailPanel() {
        document.getElementById('ocr-detail-panel')?.classList.add('hidden');
    }

    function setDetailHeader(detail) {
        const title = document.getElementById('ocr-detail-title');
        const subtitle = document.getElementById('ocr-detail-subtitle');
        if (!title || !subtitle) return;
        if (!detail?.job) {
            title.textContent = '识别结果';
            subtitle.textContent = '查看页面预览、复核文本并导出结果。';
            return;
        }
        title.textContent = detail.file?.originalName || `任务 ${detail.job.id}`;
        subtitle.textContent = `${statusLabel(detail.job.status)} · ${Number(detail.job.progress || 0)}% · ${formatTime(detail.job.updatedAt || detail.job.createdAt)}`;
    }

    function renderJobs() {
        const tbody = document.getElementById('ocr-job-table-body');
        const summary = document.getElementById('ocr-list-summary');
        if (summary) summary.textContent = `${state.total || 0} 个任务`;
        if (!tbody) return;
        const offset = (state.page - 1) * state.limit;
        const showEngineConfig = canViewOcrEngineConfig();
        html.setHtml(tbody, state.jobs.map((item, index) => {
            const engine = item.config?.engine || item.config?.ocrEngine || '-';
            const language = item.config?.language || item.config?.lang || '';
            const engineCell = showEngineConfig
                ? `<td title="${esc([engine, language].filter(Boolean).join(' / '))}">${esc(engine)}${language ? '<span class="doc-tool-file-meta">' + esc(language) + '</span>' : ''}</td>`
                : '';
            return `
                <tr class="doc-tool-row ${String(item.id) === String(state.activeJobId) ? 'is-active' : ''}" data-ocr-job-id="${esc(item.id)}">
                    <td class="text-center">${offset + index + 1}</td>
                    <td title="${esc(item.file?.originalName || '')}">
                        <strong class="doc-tool-file-title">${esc(item.file?.originalName || `任务 ${item.id}`)}</strong>
                        <span class="doc-tool-file-meta">${esc(item.file?.fileExt || '')} · ${formatBytes(item.file?.fileSize)}</span>
                    </td>
                    ${engineCell}
                    <td class="text-center"><span class="doc-tool-badge ${statusTone(item.status)}">${statusLabel(item.status)}</span></td>
                    <td class="text-center">${Number(item.progress || 0)}%</td>
                    <td title="${esc(formatTime(item.updatedAt || item.createdAt))}">${esc(formatTime(item.updatedAt || item.createdAt))}</td>
                    <td class="text-center"><div class="doc-tool-row-actions">${renderOcrRowActions(item)}</div></td>
                </tr>
            `;
        }).join('') || `<tr><td colspan="${showEngineConfig ? 7 : 6}" class="doc-tool-empty-cell">暂无任务</td></tr>`);
        renderJobPagination();
    }

    function renderJobPagination() {
        const pager = document.getElementById('ocr-job-pagination');
        if (!pager) return;
        if (typeof window.Pivot.legacy.renderWorkspacePagination !== 'function') {
            pager.replaceChildren();
            return;
        }
        window.Pivot.legacy.renderWorkspacePagination(pager, {
            total: state.total,
            page: state.page,
            limit: state.limit,
            onPageChange: targetPage => {
                const nextPage = Math.max(Number(targetPage) || 1, 1);
                if (nextPage === state.page) return;
                state.page = nextPage;
                loadJobs({ keepActive: false }).catch(e => toast(e.message || '翻页失败', 'error'));
            }
        });
    }

    function renderOutputs(outputs = []) {
        if (!outputs.length) return '<div class="doc-tool-empty-small">暂无输出</div>';
        const currentRevision = Number(state.detail?.job?.contentRevision || 1);
        return outputs.map(output => `
            <button class="btn-secondary doc-tool-output-btn" type="button" data-ocr-output-download="${esc(output.id)}" data-output-name="${esc(output.fileName || '')}">
                ${esc(output.outputType || 'output')} · ${formatBytes(output.fileSize)}${Number(output.quality?.contentRevision || 0) && Number(output.quality.contentRevision) !== currentRevision ? ' · 旧版本' : ''}
            </button>
        `).join('');
    }

    function draftForPage(pageId) {
        return state.drafts[String(pageId)] || null;
    }

    function renderDetail() {
        const box = document.getElementById('ocr-detail');
        if (!box) return;
        const detail = state.detail;
        if (!detail?.job) {
            setDetailHeader(null);
            html.setHtml(box, '<div class="doc-tool-empty-detail">选择任务查看页面、文本和输出</div>');
            return;
        }
        const job = detail.job;
        setDetailHeader(detail);
        const page = activePage();
        const review = page ? reviewForPage(page.id) : null;
        const draft = page ? draftForPage(page.id) : null;
        const text = draft?.text ?? review?.revisedText ?? page?.text ?? '';
        const coverage = reviewViews.coverageSummary(job);
        const canCancel = job.allowedActions?.cancel === true || ['queued', 'processing', 'pending'].includes(job.status);
        const canRetry = job.allowedActions?.retry === true || ['failed', 'partial_success', 'cancelled'].includes(job.status);
        const canDelete = job.allowedActions?.delete !== false && !['queued', 'processing'].includes(job.status);
        const hasOutputs = (detail.outputs || []).length > 0 || (detail.pages || []).some(p => (p.text || '').trim()) || ['succeeded', 'partial_success', 'needs_review'].includes(job.status);
        html.setHtml(box, `
            <section class="ocr-detail-head">
                <div>
                    <strong>${esc(detail.file?.originalName || `任务 ${job.id}`)}</strong>
                    <span class="doc-tool-badge ${statusTone(job.status)}">${statusLabel(job.status)}</span>
                    <span>${Number(job.progress || 0)}%</span>
                    ${coverage ? `<span class="ocr-coverage-summary">${esc(coverage)}</span>` : ''}
                    ${job.errorMessage ? `<em>${esc(job.errorMessage)}</em>` : ''}
                </div>
                <div class="ocr-detail-actions">
                    ${hasOutputs ? `
                        <details class="ocr-action-menu ocr-export-menu">
                            <summary class="btn-secondary ocr-action-menu-summary" title="导出多种格式识别结果">
                                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                                    <polyline points="7 10 12 15 17 10"></polyline>
                                    <line x1="12" y1="15" x2="12" y2="3"></line>
                                </svg>
                                <span>导出</span>
                                <svg class="ocr-menu-caret" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><polyline points="6 9 12 15 18 9"></polyline></svg>
                            </summary>
                            <div class="ocr-action-menu-panel">
                                <div class="ocr-menu-group-label">常用文本</div>
                                <button class="btn-secondary ocr-menu-item" type="button" data-ocr-export="text"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line></svg><span>TXT 纯文本</span></button>
                                <button class="btn-secondary ocr-menu-item" type="button" data-ocr-export="markdown"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"></path><path d="M7 15V9l3 3 3-3v6"></path><path d="M17 12l2 2 2-2"></path></svg><span>Markdown 文档</span></button>
                                <button class="btn-secondary ocr-menu-item" type="button" data-ocr-export="json"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="16 18 22 12 16 6"></polyline><polyline points="8 6 2 12 8 18"></polyline></svg><span>JSON 结构数据</span></button>
                                <button class="btn-secondary ocr-menu-item" type="button" data-ocr-export="html"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg><span>HTML 网页</span></button>
                                <div class="ocr-menu-divider"></div>
                                <div class="ocr-menu-group-label">排版与文档</div>
                                <button class="btn-secondary ocr-menu-item" type="button" data-ocr-export="docx"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="9" y1="15" x2="15" y2="15"></line></svg><span>DOCX Word 文档</span></button>
                                <button class="btn-secondary ocr-menu-item" type="button" data-ocr-export="xlsx"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="3" y1="9" x2="21" y2="9"></line><line x1="3" y1="15" x2="21" y2="15"></line><line x1="9" y1="3" x2="9" y2="21"></line><line x1="15" y1="3" x2="15" y2="21"></line></svg><span>Excel 电子表格</span></button>
                                <button class="btn-secondary ocr-menu-item" type="button" data-ocr-export="searchable_pdf"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><circle cx="11" cy="14" r="2"></circle><line x1="13" y1="16" x2="15.5" y2="18.5"></line></svg><span>可检索双层 PDF</span></button>
                            </div>
                        </details>
                        <details class="ocr-action-menu ocr-share-menu">
                            <summary class="btn-secondary ocr-action-menu-summary" title="将结果流转到知识库、法规库或协同应用">
                                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="17 1 21 5 17 9"></polyline><path d="M3 11V9a4 4 0 0 1 4-4h14"></path><polyline points="7 23 3 19 7 15"></polyline><path d="M21 13v2a4 4 0 0 1-4 4H3"></path></svg>
                                <span>流转联动</span>
                                <svg class="ocr-menu-caret" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><polyline points="6 9 12 15 18 9"></polyline></svg>
                            </summary>
                            <div class="ocr-action-menu-panel">
                                <div class="ocr-menu-group-label">存入资料库</div>
                                <button class="btn-secondary ocr-menu-item" type="button" data-ocr-share="knowledge"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path></svg><span>入知识库</span></button>
                                <button class="btn-secondary ocr-menu-item" type="button" data-ocr-share="regulations"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"></path><path d="M2 12h20"></path></svg><span>入法规库</span></button>
                                <button class="btn-secondary ocr-menu-item" type="button" data-ocr-share="official-writing"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg><span>入公文材料</span></button>
                                <div class="ocr-menu-divider"></div>
                                <div class="ocr-menu-group-label">应用联动</div>
                                <button class="btn-secondary ocr-menu-item" type="button" data-ocr-share="chat"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg><span>放入当前聊天</span></button>
                                <button class="btn-secondary ocr-menu-item" type="button" data-ocr-extract-fields="${esc(job.id)}"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="3" y1="9" x2="21" y2="9"></line><line x1="9" y1="21" x2="9" y2="9"></line></svg><span>提取公文字段</span></button>
                            </div>
                        </details>
                    ` : ''}
                    ${job.isOwner ? `<button class="btn-secondary ${state.isReviewerPanelOpen ? 'is-active' : ''}" type="button" data-ocr-open-reviewers="${esc(job.id)}">分派复核</button>` : ''}
                    ${!job.isOwner && job.status === 'needs_review' ? `<button class="btn-secondary" type="button" data-ocr-complete-review="${esc(job.id)}">完成我的复核</button>` : ''}
                    ${state.regionSelection?.pageId === String(page?.id || '') ? `<button class="btn-secondary" type="button" data-ocr-recognize-region="${esc(page.id)}">识别选区</button>` : ''}
                    ${canRetry ? `<button class="btn-secondary" type="button" data-ocr-job-retry="${esc(job.id)}">重试</button>` : ''}
                    ${canCancel ? `<button class="btn-secondary" type="button" data-ocr-job-cancel="${esc(job.id)}">取消</button>` : ''}
                    ${canDelete ? `<button class="btn-danger-outline" type="button" data-ocr-job-delete="${esc(job.id)}">删除</button>` : ''}
                </div>
            </section>
            <section class="ocr-output-strip">${renderOutputs(detail.outputs || [])}</section>
            <section id="ocr-field-result" class="ocr-field-result hidden" aria-live="polite"></section>
            ${state.regionCandidate ? `<section class="ocr-region-result"><strong>区域识别候选</strong><p>${esc(state.regionCandidate.text || '未识别到文字')}</p><span>${state.regionCandidate.confidence === null || state.regionCandidate.confidence === undefined ? '置信度未知' : `置信度 ${Math.round(state.regionCandidate.confidence * 100)}%`} · 请人工确认后复制到正文。</span></section>` : ''}
            ${reviewViews.renderReviewerPanel(job)}
            <section class="ocr-review-grid">
                <aside class="ocr-page-list">${reviewViews.renderPageList(detail.pages || [])}</aside>
                <div class="ocr-preview-pane">
                    ${reviewViews.renderPagePreview(page)}
                </div>
                <div class="ocr-text-pane">
                    <div class="ocr-text-head">
                        <strong>${page ? `第 ${page.pageNumber} 页文本` : '页面文本'}</strong>
                        <span>${page?.textLength || 0} 字</span>
                    </div>
                    ${(page?.result?.issues || []).length ? `<div class="ocr-issue-summary">待核问题：${esc((page.result.issues || []).map(issue => issue.message || issue.type).slice(0, 3).join('；'))}</div>` : ''}
                    <textarea id="ocr-review-text" class="form-input ocr-review-textarea" spellcheck="false" data-ocr-review-page="${page ? esc(page.id) : ''}">${esc(text)}</textarea>
                    <div class="ocr-review-actions">
                        <label class="ocr-confirm-low">
                            <input id="ocr-low-confidence-confirm" type="checkbox" ${(draft?.lowConfidenceConfirmed ?? review?.lowConfidenceConfirmed) ? 'checked' : ''}>
                            <span>低置信度已确认</span>
                        </label>
                        <button class="btn-primary" type="button" data-ocr-page-save="${page ? esc(page.id) : ''}" ${page ? '' : 'disabled'}>保存复核</button>
                        <button class="btn-secondary" type="button" data-ocr-submit-feedback="${page ? esc(page.id) : ''}" ${page ? '' : 'disabled'}>授权提交纠错反馈</button>
                    </div>
                    <div class="ocr-block-list">${page ? reviewViews.renderBlocks(page.id) : ''}</div>
                </div>
            </section>
        `);
    }

    function render() {
        renderEngines();
        renderJobs();
        renderDetail();
        renderSettings();
    }

    async function loadSettings() {
        if (!canManageOcrSettings()) {
            state.settings = null;
            renderSettings();
            return null;
        }
        try {
            const data = await requestJson(`${API}/settings`);
            state.settings = data.settings || {};
            renderSettings();
            return state.settings;
        } catch (e) {
            toast(e.message || 'OCR 服务配置加载失败', 'warning');
            return null;
        }
    }

    async function loadEngines() {
        if (!canViewOcrEngineConfig()) {
            state.engines = {};
            renderEngines();
            return null;
        }
        try {
            const data = await requestJson(`${API}/engines`);
            state.engines = data.engines || {};
            renderEngines();
        } catch (e) {
            toast(e.message || '引擎状态加载失败', 'warning');
        }
    }

    async function loadCapabilities() {
        try {
            const data = await requestJson(`${API}/capabilities`);
            state.capabilities = data.capabilities || null;
            const limit = Number(state.capabilities?.limits?.maxOcrPages || 0);
            const input = document.getElementById('ocr-pages-input');
            if (input && limit) {
                input.max = String(limit);
                if (Number(input.value || 0) > limit) input.value = String(limit);
            }
            const hint = document.getElementById('ocr-capability-hint');
            if (hint && limit) hint.textContent = `一次最多识别 ${limit} 页。范围可填写 1-3,5；系统不会静默省略页面。`;
            return state.capabilities;
        } catch (error) {
            state.capabilities = null;
            return null;
        }
    }

    async function loadJobs({ keepActive = true } = {}) {
        const params = new URLSearchParams({ page: String(state.page), limit: String(state.limit) });
        if (state.status) params.set('status', state.status);
        const data = await requestJson(`${API}/jobs?${params.toString()}`);
        state.jobs = Array.isArray(data.data) ? data.data : [];
        state.total = Number(data.total || 0);
        state.queue = data.queue || null;
        if (!keepActive || !state.jobs.some(item => String(item.id) === String(state.activeJobId))) {
            state.activeJobId = '';
            state.activePageId = '';
            state.detail = null;
            state.drafts = {};
        }
        renderJobs();
        if (state.activeJobId && isDetailPanelOpen()) await loadDetail(state.activeJobId, { silent: true, openPanel: false });
        else renderDetail();
    }

    async function loadDetail(jobId, { silent = false, openPanel = true } = {}) {
        if (!jobId) return null;
        const requestId = ++state.detailRequestId;
        const data = await requestJson(`${API}/jobs/${encodeURIComponent(jobId)}`);
        if (requestId !== state.detailRequestId) return null;
        if (String(state.activeJobId || '') && String(state.activeJobId) !== String(data.job?.id || jobId)) {
            state.drafts = {};
            state.isReviewerPanelOpen = false;
            state.reviewCandidates = [];
            state.reviewPanelInfo = null;
        }
        state.detail = data;
        state.activeJobId = String(data.job?.id || jobId);
        if (!data.pages?.some(page => String(page.id) === String(state.activePageId))) {
            state.activePageId = data.pages?.[0]?.id ? String(data.pages[0].id) : '';
        }
        render();
        if (openPanel) openDetailPanel();
        if (!silent) toast('任务详情已更新');
        return data;
    }

    async function submitUpload(form, suppliedFiles = null) {
        const files = suppliedFiles ? Array.from(suppliedFiles) : Array.from(document.getElementById('ocr-file-input')?.files || []);
        if (!files.length) {
            toast('请选择文件', 'warning');
            return;
        }
        const data = new FormData(form);
        data.delete('files');
        files.forEach(file => data.append('files', file));
        if (canViewOcrEngineConfig()) data.set('engine', document.getElementById('ocr-engine-select')?.value || 'http');
        else data.delete('engine');
        data.set('language', document.getElementById('ocr-language-select')?.value || 'ch');
        data.set('dpi', document.getElementById('ocr-dpi-input')?.value || '220');
        data.set('maxRenderPages', document.getElementById('ocr-pages-input')?.value || '10');
        data.set('maxOcrPages', document.getElementById('ocr-pages-input')?.value || '10');
        data.set('pages', document.getElementById('ocr-pages-range-input')?.value || '');
        data.set('password', document.getElementById('ocr-password-input')?.value || '');
        const btn = document.getElementById('ocr-submit-btn');
        const text = btn?.textContent || '';
        if (btn) {
            btn.disabled = true;
            btn.textContent = '创建中';
        }
        try {
            const preflight = await requestJson(`${API}/preflight`, { method: 'POST', body: data });
            const rejected = Number(preflight.preflight?.rejected || 0);
            if (rejected) {
                const message = (preflight.preflight?.files || []).flatMap(item => item.warnings || []).join('；') || '部分文件未通过预检。';
                throw new Error(message);
            }
            const warnings = (preflight.preflight?.files || []).flatMap(item => item.warnings || []);
            if (warnings.length && typeof window.confirm === 'function' && !window.confirm(`${warnings.join('\n')}\n\n是否继续创建任务？`)) return;
            const created = await requestJson(`${API}/jobs`, { method: 'POST', body: data });
            state.activeJobId = String(created.job?.id || '');
            state.activePageId = '';
            form.reset();
            document.getElementById('ocr-dpi-input').value = '220';
            document.getElementById('ocr-pages-input').value = '10';
            toast(created.batch ? `已创建 ${created.batch.acceptedFiles} 个文字识别任务` : '文字识别任务已创建', 'success');
            await loadJobs({ keepActive: true });
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.textContent = text;
            }
        }
    }

    function currentJobText() {
        const pages = Array.isArray(state.detail?.pages) ? state.detail.pages : [];
        return pages.map((page, index) => {
            const text = String(page.text || '').trim();
            if (!text) return '';
            return ['[\u7b2c ' + Number(page.pageNumber || index + 1) + ' \u9875]', text].join('\n');
        }).filter(Boolean).join('\n\n').trim();
    }

    function appendToChatInput(text) {
        const input = document.getElementById('user-input') || document.querySelector('textarea[name="message"], textarea.chat-input');
        if (!input) return false;
        const prefix = input.value && !input.value.endsWith('\n') ? '\n\n' : '';
        input.value = String(input.value || '') + prefix + text;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.focus();
        return true;
    }

    async function copyText(text) {
        try {
            if (navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(text);
                return true;
            }
        } catch (_error) {}
        return false;
    }

    function appendToOfficialWritingMaterial(text) {
        const textarea = typeof getOfficialWritingTextarea === 'function'
            ? getOfficialWritingTextarea('source')
            : document.getElementById('official-writing-source');
        if (textarea) {
            const prefix = textarea.value && !textarea.value.endsWith('\n') ? '\n\n' : '';
            textarea.value = String(textarea.value || '') + prefix + text;
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
            return true;
        }
        return false;
    }

    async function shareResult(target) {
        if (!state.activeJobId) return;
        const text = currentJobText();
        if (!text) {
            toast('\u6682\u65e0\u53ef\u5206\u53d1\u7684 OCR \u6587\u672c', 'warning');
            return;
        }
        if (target === 'chat') {
            const context = await requestJson(`${API}/jobs/${encodeURIComponent(state.activeJobId)}/context`);
            const contextText = String(context.context?.text || text);
            if (appendToChatInput(contextText)) toast('\u5df2\u653e\u5165\u804a\u5929\u8f93\u5165\u6846\uff0c\u5df2\u4fdd\u7559\u4efb\u52a1\u548c\u9875\u7801\u6765\u6e90', 'success');
            else {
                const copied = await copyText(contextText);
                toast(copied ? '\u672a\u627e\u5230\u804a\u5929\u8f93\u5165\u6846\uff0c\u5df2\u590d\u5236\u5e26\u6765\u6e90\u7684\u6587\u672c' : '\u672a\u627e\u5230\u804a\u5929\u8f93\u5165\u6846\uff0c\u8bf7\u624b\u52a8\u590d\u5236\u6587\u672c', 'warning');
            }
            return;
        }
        if (target === 'official-writing') {
            const direct = appendToOfficialWritingMaterial(text);
            const copied = direct ? false : await copyText(text);
            if (direct) toast('\u5df2\u5199\u5165\u516c\u6587\u6750\u6599', 'success');
            else if (copied) toast('\u672a\u6253\u5f00\u516c\u6587\u6750\u6599\uff0c\u5df2\u590d\u5236\u6587\u672c', 'warning');
            else toast('\u672a\u6253\u5f00\u516c\u6587\u6750\u6599\uff0c\u4e5f\u65e0\u6cd5\u81ea\u52a8\u590d\u5236\uff0c\u8bf7\u624b\u52a8\u590d\u5236\u6587\u672c', 'warning');
            return;
        }
        const data = await requestJson(API + '/jobs/' + encodeURIComponent(state.activeJobId) + '/share', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ target })
        });
        const share = data.share || {};
        if (share.target === 'knowledge') toast('\u5df2\u5206\u53d1\u5230\u77e5\u8bc6\u5e93', 'success');
        else if (share.target === 'regulations') toast('\u5df2\u5206\u53d1\u5230\u6cd5\u89c4\u5e93', 'success');
        else toast('\u5206\u53d1\u5df2\u5b8c\u6210', 'success');
    }

    async function saveReview(pageId) {
        if (!pageId) return;
        const revisedText = document.getElementById('ocr-review-text')?.value || '';
        const lowConfidenceConfirmed = document.getElementById('ocr-low-confidence-confirm')?.checked === true;
        await requestJson(`${API}/pages/${encodeURIComponent(pageId)}/review`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ revisedText, lowConfidenceConfirmed, reviewStatus: 'reviewed', expectedRevision: state.detail?.job?.contentRevision })
        });
        delete state.drafts[String(pageId)];
        toast('复核已保存', 'success');
        await loadDetail(state.activeJobId, { silent: true });
    }


    function bindEvents(view) {
        if (view.dataset.bound === '1') return;
        view.dataset.bound = '1';
        view.addEventListener('submit', event => {
            if (event.target?.id !== 'ocr-upload-form') return;
            event.preventDefault();
            submitUpload(event.target).catch(e => toast(e.message || '创建任务失败', 'error'));
        });
        view.addEventListener('change', event => {
            if (event.target?.id === 'ocr-status-filter') {
                state.status = event.target.value;
                state.page = 1;
                loadJobs({ keepActive: false }).catch(e => toast(e.message || '任务加载失败', 'error'));
            }
            if (event.target?.id === 'ocr-engine-select') {
                renderEngines();
            }
            if (event.target?.id === 'ocr-service-url-input') {
                document.getElementById('ocr-settings-form')?.setAttribute('data-dirty', '1');
            }
        });
        view.addEventListener('input', event => {
            if (event.target?.id !== 'ocr-review-text') return;
            const pageId = event.target.dataset.ocrReviewPage || state.activePageId;
            if (!pageId) return;
            const previous = draftForPage(pageId) || {};
            state.drafts[String(pageId)] = { ...previous, text: event.target.value, lowConfidenceConfirmed: document.getElementById('ocr-low-confidence-confirm')?.checked === true };
        });
        ocrActions.bindRegionPointerEvents(view);
        view.addEventListener('paste', event => {
            const files = Array.from(event.clipboardData?.files || []).filter(file => String(file.type || '').startsWith('image/'));
            if (!files.length) return;
            const form = document.getElementById('ocr-upload-form');
            if (!form) return;
            event.preventDefault();
            submitUpload(form, files).catch(error => toast(error.message || '粘贴图片识别失败', 'error'));
        });
        view.addEventListener('click', event => {
            // 点击下拉菜单项时自动收起菜单
            const menuItem = event.target.closest('.ocr-action-menu-panel button');
            if (menuItem) {
                const parentMenu = menuItem.closest('.ocr-action-menu');
                if (parentMenu) parentMenu.open = false;
            }
            if (!event.target.closest('.ocr-action-menu')) {
                view.querySelectorAll('.ocr-action-menu[open]').forEach(menu => { menu.open = false; });
            } else {
                const activeMenu = event.target.closest('.ocr-action-menu');
                view.querySelectorAll('.ocr-action-menu[open]').forEach(menu => {
                    if (menu !== activeMenu) menu.open = false;
                });
            }

            const open = event.target.closest('[data-ocr-job-open]');
            if (open) {
                loadDetail(open.dataset.ocrJobOpen).catch(e => toast(e.message || '任务详情加载失败', 'error'));
                return;
            }
            if (event.target.closest('[data-ocr-close-detail]')) {
                const hasDraft = Object.keys(state.drafts).length > 0;
                if (hasDraft && typeof window.confirm === 'function' && !window.confirm('当前有未保存的复核修改，仍要关闭吗？')) return;
                closeDetailPanel();
                return;
            }
            const page = event.target.closest('[data-ocr-page-id]');
            if (page) {
                const currentInput = document.getElementById('ocr-review-text');
                if (state.activePageId && currentInput) {
                    const previous = draftForPage(state.activePageId) || {};
                    state.drafts[String(state.activePageId)] = { ...previous, text: currentInput.value, lowConfidenceConfirmed: document.getElementById('ocr-low-confidence-confirm')?.checked === true };
                }
                state.activePageId = page.dataset.ocrPageId;
                renderDetail();
                return;
            }
            if (event.target.closest('#ocr-refresh-btn')) {
                loadJobs({ keepActive: true }).catch(e => toast(e.message || '刷新失败', 'error'));
                if (canViewOcrEngineConfig()) loadEngines();
                if (canManageOcrSettings()) loadSettings();
                return;
            }
            if (event.target.closest('#ocr-desktop-screenshot-btn')) {
                ocrActions.captureDesktopScreenshot().catch(error => toast(error.message || '本机截图识别失败', 'error'));
                return;
            }
            if (event.target.closest('#ocr-authorize-watch-btn')) {
                ocrActions.authorizeWatchDirectory().catch(error => toast(error.message || '授权监控目录失败', 'error'));
                return;
            }
            if (event.target.closest('#ocr-revoke-watch-btn')) {
                ocrActions.revokeWatchDirectory().catch(error => toast(error.message || '停止目录监听失败', 'error'));
                return;
            }
            if (event.target.closest('#ocr-open-settings-btn')) {
                window.Pivot?.moduleApi?.('workspaces.navigation')?.openAdminPanel?.({ restore: false, tab: 'models' });
                return;
            }
            const shareBtn = event.target.closest('[data-ocr-share]');
            if (shareBtn) {
                shareResult(shareBtn.dataset.ocrShare).catch(e => toast(e.message || '\u5206\u53d1\u5931\u8d25', 'error'));
                return;
            }
            const overlayBlock = event.target.closest('[data-ocr-block-id]');
            if (overlayBlock) {
                const id = overlayBlock.dataset.ocrBlockId;
                document.querySelectorAll('#ocr-detail [data-ocr-block-id]').forEach(el => el.classList.toggle('is-selected', String(el.dataset.ocrBlockId) === String(id)));
                return;
            }
            const exportBtn = event.target.closest('[data-ocr-export]');
            if (exportBtn) return ocrActions.exportOutput(exportBtn.dataset.ocrExport).catch(e => toast(e.message || '导出失败', 'error'));
            const fields = event.target.closest('[data-ocr-extract-fields]');
            if (fields) return ocrActions.extractFields(fields.dataset.ocrExtractFields).catch(error => toast(error.message || '字段提取失败', 'error'));
            const region = event.target.closest('[data-ocr-recognize-region]');
            if (region) return ocrActions.recognizeSelectedRegion(region.dataset.ocrRecognizeRegion).catch(error => toast(error.message || '区域识别失败', 'error'));
            const reviewers = event.target.closest('[data-ocr-open-reviewers]');
            if (reviewers) return ocrActions.openReviewers(reviewers.dataset.ocrOpenReviewers).catch(error => toast(error.message || '加载复核人失败', 'error'));
            const completeReview = event.target.closest('[data-ocr-complete-review]');
            if (completeReview) {
                return requestJson(`${API}/jobs/${encodeURIComponent(completeReview.dataset.ocrCompleteReview)}/review-complete`, { method: 'POST' })
                    .then(data => { toast(data.review?.doubleConfirmed ? '双人复核已完成' : '已完成个人复核，等待第二位复核人确认', 'success'); return loadDetail(state.activeJobId, { silent: true }); })
                    .catch(error => toast(error.message || '完成复核失败', 'error'));
            }
            const reviewer = event.target.closest('[data-ocr-reviewer-id]');
            if (reviewer) {
                const id = String(reviewer.dataset.ocrReviewerId);
                if (reviewer.checked) state.selectedReviewerIds.add(id);
                else state.selectedReviewerIds.delete(id);
                return;
            }
            const saveReviewersButton = event.target.closest('[data-ocr-save-reviewers]');
            if (saveReviewersButton) return ocrActions.saveReviewers(saveReviewersButton.dataset.ocrSaveReviewers).catch(error => toast(error.message || '分派复核人失败', 'error'));
            if (event.target.closest('[data-ocr-close-reviewers]')) {
                state.isReviewerPanelOpen = false;
                state.reviewCandidates = [];
                state.reviewPanelInfo = null;
                state.selectedReviewerIds = new Set();
                return renderDetail();
            }
            const output = event.target.closest('[data-ocr-output-download]');
            if (output) return ocrActions.downloadOutput(output.dataset.ocrOutputDownload, output.dataset.outputName).catch(e => toast(e.message || '下载失败', 'error'));
            const save = event.target.closest('[data-ocr-page-save]');
            if (save) return saveReview(save.dataset.ocrPageSave).catch(e => toast(e.message || '保存复核失败', 'error'));
            const feedback = event.target.closest('[data-ocr-submit-feedback]');
            if (feedback) return ocrActions.submitFeedback(feedback.dataset.ocrSubmitFeedback).catch(error => toast(error.message || '提交纠错反馈失败', 'error'));
            const remove = event.target.closest('[data-ocr-job-delete]');
            if (remove) return ocrActions.deleteJob(remove.dataset.ocrJobDelete).catch(e => toast(e.message || '删除失败', 'error'));
            const retry = event.target.closest('[data-ocr-job-retry]');
            if (retry) return ocrActions.retryJob(retry.dataset.ocrJobRetry).catch(e => toast(e.message || '重试失败', 'error'));
            const cancel = event.target.closest('[data-ocr-job-cancel]');
            if (cancel) return ocrActions.cancelJob(cancel.dataset.ocrJobCancel).catch(e => toast(e.message || '取消失败', 'error'));
        });
    }

    function startPolling() {
        if (state.timer) return;
        state.timer = window.setInterval(() => {
            if (window.Pivot.legacy.getAppsSessionValue?.('pivot_apps_active_app') !== 'ocr') return;
            const active = state.jobs.some(job => job.status === 'queued' || job.status === 'pending' || job.status === 'processing');
            if (active) loadJobs({ keepActive: true }).catch(() => {});
        }, 4000);
    }

    async function showOcrApp() {
        const view = ensureView();
        window.Pivot.legacy.PivotDataAnalysis?.resetAiWorkspace?.();
        window.Pivot.legacy.setAppsSessionValue?.('pivot_apps_active_app', 'ocr');
        document.getElementById('apps-home-view')?.classList.add('hidden');
        document.getElementById('official-writing-view')?.classList.add('hidden');
        document.getElementById('data-analysis-view')?.classList.add('hidden');
        document.getElementById('regulations-view')?.classList.add('hidden');
        document.getElementById('pdf-tools-view')?.classList.add('hidden');
        view.classList.remove('hidden');
        document.getElementById('apps-back-btn')?.classList.remove('hidden');
        if (typeof setAppsTitle === 'function') setAppsTitle('文字识别', '上传图片或 PDF，复核识别结果并导出文本、Markdown、JSON 或可检索 PDF。');
        render();
        ocrActions.bindWatchEvents();
        startPolling();
        const loaders = [loadJobs({ keepActive: true }), loadCapabilities()];
        if (canViewOcrEngineConfig()) loaders.push(loadEngines());
        if (canManageOcrSettings()) loaders.push(loadSettings());
        await Promise.all(loaders);
    }

    window.Pivot.legacy.PivotOcr = {
        ready: true,
        state,
        showOcrApp,
        loadJobs,
        loadDetail
    };
    window.Pivot.legacy.showOcrApp = showOcrApp;
})();
