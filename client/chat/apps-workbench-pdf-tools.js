(function () {
    if (window.PivotPdfTools?.ready) return;

    const API = '/api/apps/pdf-tools';
    const state = {
        jobs: [],
        detail: null,
        activeJobId: '',
        status: '',
        page: 1,
        limit: 12,
        total: 0,
        timer: null
    };

    const OPERATIONS = {
        merge: { label: '合并 PDF', pages: false, order: false, rotate: false, image: false },
        split: { label: '拆分页面', pages: true, order: false, rotate: false, image: false },
        rotate: { label: '旋转页面', pages: true, order: false, rotate: true, image: false },
        delete_pages: { label: '删除页面', pages: true, order: false, rotate: false, image: false },
        reorder: { label: '重排页面', pages: false, order: true, rotate: false, image: false },
        extract_text: { label: '提取文本', pages: false, order: false, rotate: false, image: false },
        pdf_to_images: { label: 'PDF 转图片', pages: true, order: false, rotate: false, image: true },
        images_to_pdf: { label: '图片转 PDF', pages: false, order: false, rotate: false, image: false },
        searchable_pdf: { label: '\u53ef\u641c\u7d22 PDF', pages: false, order: false, rotate: false, image: false }
    };

    const html = window.PivotSafeHtml || {
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
        if (!res.ok) throw new Error(data?.error?.message || data?.error || data?.message || `请求失败（${res.status}）`);
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
        if (status === 'processing' || status === 'pending') return 'is-info';
        return '';
    }

    function operationLabel(operation) {
        return OPERATIONS[operation]?.label || operation || '-';
    }

    function ensureView() {
        let view = document.getElementById('pdf-tools-view');
        if (!view) {
            view = document.createElement('div');
            view.id = 'pdf-tools-view';
            view.className = 'pdf-tools-view hidden';
            const host = document.querySelector('.apps-workspace-body') || document.body;
            host.appendChild(view);
        }
        if (view.dataset.ready === '1') return view;
        html.setHtml(view, `
            <div class="pdf-tools-layout doc-tool-layout">
                <aside class="workspace-panel doc-tool-sidebar pdf-tools-sidebar">
                    <form id="pdf-tools-form" class="doc-tool-form">
                        <label class="doc-tool-field doc-tool-field-wide">
                            <span>操作</span>
                            <select id="pdf-operation-select" class="form-input" name="operation">
                                ${Object.entries(OPERATIONS).map(([value, item]) => `<option value="${esc(value)}">${esc(item.label)}</option>`).join('')}
                            </select>
                        </label>
                        <label class="doc-tool-field doc-tool-field-wide">
                            <span>文件</span>
                            <input id="pdf-files-input" class="form-input" type="file" name="files" accept=".pdf,.png,.jpg,.jpeg,.webp,.bmp" multiple required>
                        </label>
                        <div class="doc-tool-field-row" data-pdf-option="pages">
                            <label class="doc-tool-field doc-tool-field-wide">
                                <span>页面范围</span>
                                <input id="pdf-pages-input" class="form-input" name="pages" type="text" placeholder="1-3,5">
                            </label>
                        </div>
                        <div class="doc-tool-field-row hidden" data-pdf-option="order">
                            <label class="doc-tool-field doc-tool-field-wide">
                                <span>页面顺序</span>
                                <input id="pdf-order-input" class="form-input" name="pageOrder" type="text" placeholder="3,1,2">
                            </label>
                        </div>
                        <div class="doc-tool-field-row hidden" data-pdf-option="rotate">
                            <label class="doc-tool-field doc-tool-field-wide">
                                <span>旋转角度</span>
                                <select id="pdf-rotate-input" class="form-input" name="rotateDegrees">
                                    <option value="90">90°</option>
                                    <option value="180">180°</option>
                                    <option value="270">270°</option>
                                </select>
                            </label>
                        </div>
                        <div class="doc-tool-field-row" data-pdf-option="render">
                            <label class="doc-tool-field">
                                <span>DPI</span>
                                <input id="pdf-dpi-input" class="form-input" name="dpi" type="number" min="72" max="600" value="220">
                            </label>
                            <label class="doc-tool-field">
                                <span>页数上限</span>
                                <input id="pdf-max-pages-input" class="form-input" name="maxToolPages" type="number" min="1" max="300" value="100">
                            </label>
                        </div>
                        <label class="doc-tool-field doc-tool-field-wide">
                            <span>PDF 密码</span>
                            <input id="pdf-password-input" class="form-input" name="password" type="password" autocomplete="off">
                        </label>
                        <div class="doc-tool-actions">
                            <button id="pdf-submit-btn" class="btn-primary" type="submit">创建任务</button>
                            <button id="pdf-refresh-btn" class="btn-secondary" type="button">刷新</button>
                        </div>
                    </form>
                    <div class="doc-tool-filter">
                        <label class="doc-tool-field doc-tool-field-wide">
                            <span>状态</span>
                            <select id="pdf-status-filter" class="form-input">
                                <option value="">全部任务</option>
                                <option value="pending">排队中</option>
                                <option value="processing">处理中</option>
                                <option value="succeeded">已完成</option>
                                <option value="failed">失败</option>
                            </select>
                        </label>
                    </div>
                </aside>

                <main class="workspace-panel doc-tool-main pdf-tools-main">
                    <div class="workspace-toolbar doc-tool-toolbar">
                        <div class="doc-tool-toolbar-title">
                            <h4>PDF 工具任务</h4>
                            <span id="pdf-list-summary">0 个任务</span>
                        </div>
                    </div>
                    <div class="table-container workspace-table-wrap doc-tool-table-wrap">
                        <table class="data-table compact-table doc-tool-table pdf-job-table">
                            <thead>
                                <tr>
                                    <th style="width: 54px;" class="text-center">序号</th>
                                    <th style="width: 330px;">文件</th>
                                    <th style="width: 118px;">处理方式</th>
                                    <th style="width: 86px;" class="text-center">状态</th>
                                    <th style="width: 76px;" class="text-center">进度</th>
                                    <th style="width: 140px;">更新时间</th>
                                    <th style="width: 196px;" class="text-center">操作</th>
                                </tr>
                            </thead>
                            <tbody id="pdf-job-table-body"></tbody>
                        </table>
                    </div>
                    <div id="pdf-job-pagination" class="pagination workspace-pagination"></div>
                </main>
            </div>
            <section id="pdf-detail-panel" class="doc-tool-detail-panel hidden" role="dialog" aria-modal="true" aria-labelledby="pdf-detail-title">
                <div class="workspace-modal doc-tool-dialog pdf-detail-dialog">
                    <div class="workspace-modal-header">
                        <div>
                            <h3 id="pdf-detail-title">PDF 处理结果</h3>
                            <p id="pdf-detail-subtitle">查看任务摘要并下载输出文件。</p>
                        </div>
                        <button class="btn-secondary workspace-modal-close" type="button" data-pdf-close-detail>关闭</button>
                    </div>
                    <div id="pdf-detail" class="workspace-modal-body doc-tool-modal-body pdf-detail"></div>
                </div>
            </section>
        `);
        view.dataset.ready = '1';
        bindEvents(view);
        syncOperationOptions();
        return view;
    }

    function resultOutputs(job) {
        return Array.isArray(job?.result?.outputs) ? job.result.outputs.filter(Boolean) : [];
    }

    function selectOutput(outputs = []) {
        const list = Array.isArray(outputs) ? outputs.filter(output => output?.id) : [];
        return list[0] || null;
    }

    function renderPdfRowActions(item) {
        const canCancel = item.status === 'pending' || item.status === 'processing';
        return [
            '<button class="btn-secondary doc-tool-row-action" type="button" data-pdf-job-open="' + esc(item.id) + '">查看</button>',
            canCancel ? '<button class="btn-secondary doc-tool-row-action" type="button" data-pdf-job-cancel="' + esc(item.id) + '">取消</button>' : '',
            '<button class="btn-danger-outline doc-tool-row-action" type="button" data-pdf-job-delete="' + esc(item.id) + '">删除</button>'
        ].filter(Boolean).join('');
    }

    function isDetailPanelOpen() {
        return !document.getElementById('pdf-detail-panel')?.classList.contains('hidden');
    }

    function openDetailPanel() {
        document.getElementById('pdf-detail-panel')?.classList.remove('hidden');
    }

    function closeDetailPanel() {
        document.getElementById('pdf-detail-panel')?.classList.add('hidden');
    }

    function setDetailHeader(detail) {
        const title = document.getElementById('pdf-detail-title');
        const subtitle = document.getElementById('pdf-detail-subtitle');
        if (!title || !subtitle) return;
        if (!detail?.job) {
            title.textContent = 'PDF 处理结果';
            subtitle.textContent = '查看任务摘要并下载输出文件。';
            return;
        }
        const operation = detail.job?.config?.operation || detail.job?.result?.operation || '';
        title.textContent = detail.file?.originalName || `任务 ${detail.job.id}`;
        subtitle.textContent = `${operationLabel(operation)} · ${statusLabel(detail.job.status)} · ${Number(detail.job.progress || 0)}%`;
    }
    function renderJobs() {
        const tbody = document.getElementById('pdf-job-table-body');
        const summary = document.getElementById('pdf-list-summary');
        if (summary) summary.textContent = `${state.total || 0} 个任务`;
        if (!tbody) return;
        const offset = (state.page - 1) * state.limit;
        html.setHtml(tbody, state.jobs.map((item, index) => {
            const operation = item.config?.operation || item.config?.pdfOperation || '';
            return `
                <tr class="doc-tool-row ${String(item.id) === String(state.activeJobId) ? 'is-active' : ''}" data-pdf-job-id="${esc(item.id)}">
                    <td class="text-center">${offset + index + 1}</td>
                    <td title="${esc(item.file?.originalName || '')}">
                        <strong class="doc-tool-file-title">${esc(item.file?.originalName || `任务 ${item.id}`)}</strong>
                        <span class="doc-tool-file-meta">${esc(item.file?.fileExt || '')} · ${formatBytes(item.file?.fileSize)}</span>
                    </td>
                    <td title="${esc(operationLabel(operation))}">${esc(operationLabel(operation))}</td>
                    <td class="text-center"><span class="doc-tool-badge ${statusTone(item.status)}">${statusLabel(item.status)}</span></td>
                    <td class="text-center">${Number(item.progress || 0)}%</td>
                    <td title="${esc(formatTime(item.updatedAt || item.createdAt))}">${esc(formatTime(item.updatedAt || item.createdAt))}</td>
                    <td class="text-center"><div class="doc-tool-row-actions">${renderPdfRowActions(item)}</div></td>
                </tr>
            `;
        }).join('') || '<tr><td colspan="7" class="doc-tool-empty-cell">暂无任务</td></tr>');
        renderJobPagination();
    }

    function renderJobPagination() {
        const pager = document.getElementById('pdf-job-pagination');
        if (!pager) return;
        if (typeof window.renderWorkspacePagination !== 'function') {
            pager.replaceChildren();
            return;
        }
        window.renderWorkspacePagination(pager, {
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
        return outputs.map(output => `
            <button class="btn-secondary doc-tool-output-btn" type="button" data-pdf-output-download="${esc(output.id)}" data-output-name="${esc(output.fileName || '')}">
                ${esc(output.fileName || output.outputType || 'output')} · ${formatBytes(output.fileSize)}
            </button>
        `).join('');
    }

    function renderResultMeta(job) {
        const result = job?.result || {};
        const rows = [];
        if (result.operation) rows.push(['操作', operationLabel(result.operation)]);
        if (result.pageCount) rows.push(['页数', result.pageCount]);
        if (result.outputCount) rows.push(['输出', result.outputCount]);
        if (result.textLength) rows.push(['文本', `${result.textLength} 字`]);
        if (!rows.length) return '';
        return `<div class="pdf-result-grid">${rows.map(([k, v]) => `<div><span>${esc(k)}</span><strong>${esc(v)}</strong></div>`).join('')}</div>`;
    }

    function renderDetail() {
        const box = document.getElementById('pdf-detail');
        if (!box) return;
        const detail = state.detail;
        if (!detail?.job) {
            setDetailHeader(null);
            html.setHtml(box, '<div class="doc-tool-empty-detail">选择任务查看输出</div>');
            return;
        }
        const job = detail.job;
        setDetailHeader(detail);
        html.setHtml(box, `
            <section class="pdf-detail-head">
                <div>
                    <strong>${esc(detail.file?.originalName || `任务 ${job.id}`)}</strong>
                    <span class="doc-tool-badge ${statusTone(job.status)}">${statusLabel(job.status)}</span>
                    <span>${Number(job.progress || 0)}%</span>
                    ${job.errorMessage ? `<em>${esc(job.errorMessage)}</em>` : ''}
                </div>
                <div class="pdf-detail-actions">
                    ${(detail.outputs || []).filter(output => output?.id).length > 1 ? `<button class="btn-secondary" type="button" data-pdf-job-download="${esc(job.id)}">全部下载</button>` : ''}
                    <button class="btn-secondary" type="button" data-pdf-job-retry="${esc(job.id)}">重试</button>
                    <button class="btn-secondary" type="button" data-pdf-job-cancel="${esc(job.id)}">取消</button>
                    <button class="btn-danger-outline" type="button" data-pdf-job-delete="${esc(job.id)}">删除</button>
                </div>
            </section>
            ${renderResultMeta(job)}
            <section class="pdf-output-list">${renderOutputs(detail.outputs || [])}</section>
        `);
    }

    function render() {
        renderJobs();
        renderDetail();
    }

    function syncOperationOptions() {
        const op = document.getElementById('pdf-operation-select')?.value || 'merge';
        const meta = OPERATIONS[op] || OPERATIONS.merge;
        document.querySelectorAll('#pdf-tools-view [data-pdf-option="pages"]').forEach(el => el.classList.toggle('hidden', !meta.pages));
        document.querySelectorAll('#pdf-tools-view [data-pdf-option="order"]').forEach(el => el.classList.toggle('hidden', !meta.order));
        document.querySelectorAll('#pdf-tools-view [data-pdf-option="rotate"]').forEach(el => el.classList.toggle('hidden', !meta.rotate));
        document.querySelectorAll('#pdf-tools-view [data-pdf-option="render"]').forEach(el => el.classList.toggle('hidden', !(op === 'pdf_to_images' || op === 'searchable_pdf')));
    }

    async function loadJobs({ keepActive = true } = {}) {
        const params = new URLSearchParams({ page: String(state.page), limit: String(state.limit) });
        if (state.status) params.set('status', state.status);
        const data = await requestJson(`${API}/jobs?${params.toString()}`);
        state.jobs = Array.isArray(data.data) ? data.data : [];
        state.total = Number(data.total || 0);
        if (!keepActive || !state.jobs.some(item => String(item.id) === String(state.activeJobId))) {
            state.activeJobId = '';
            state.detail = null;
        }
        renderJobs();
        if (state.activeJobId && isDetailPanelOpen()) await loadDetail(state.activeJobId, { silent: true, openPanel: false });
        else renderDetail();
    }

    async function loadDetail(jobId, { silent = false, openPanel = true } = {}) {
        if (!jobId) return null;
        const data = await requestJson(`${API}/jobs/${encodeURIComponent(jobId)}`);
        state.detail = data;
        state.activeJobId = String(data.job?.id || jobId);
        render();
        if (openPanel) openDetailPanel();
        if (!silent) toast('任务详情已更新');
        return data;
    }

    async function submitJob(form) {
        const files = Array.from(document.getElementById('pdf-files-input')?.files || []);
        if (!files.length) {
            toast('请选择文件', 'warning');
            return;
        }
        const data = new FormData();
        files.forEach(file => data.append('files', file));
        data.set('operation', document.getElementById('pdf-operation-select')?.value || 'merge');
        data.set('pages', document.getElementById('pdf-pages-input')?.value || '');
        data.set('pageOrder', document.getElementById('pdf-order-input')?.value || '');
        data.set('rotateDegrees', document.getElementById('pdf-rotate-input')?.value || '90');
        data.set('dpi', document.getElementById('pdf-dpi-input')?.value || '220');
        data.set('maxToolPages', document.getElementById('pdf-max-pages-input')?.value || '100');
        data.set('password', document.getElementById('pdf-password-input')?.value || '');
        const btn = document.getElementById('pdf-submit-btn');
        const text = btn?.textContent || '';
        if (btn) {
            btn.disabled = true;
            btn.textContent = '创建中';
        }
        try {
            const created = await requestJson(`${API}/jobs`, { method: 'POST', body: data });
            state.activeJobId = String(created.job?.id || '');
            form.reset();
            document.getElementById('pdf-dpi-input').value = '220';
            document.getElementById('pdf-max-pages-input').value = '100';
            syncOperationOptions();
            toast('PDF 工具任务已创建', 'success');
            await loadJobs({ keepActive: true });
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.textContent = text;
            }
        }
    }

    async function downloadOutput(outputId, filename = '') {
        const res = await apiFetch(`${API}/outputs/${encodeURIComponent(outputId)}/download`);
        if (!res.ok) {
            const data = await res.clone().json().catch(() => ({}));
            throw new Error(data?.error?.message || data?.error || `下载失败（${res.status}）`);
        }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename || `pdf-output-${outputId}`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
    }

    async function downloadJobOutputArchive(jobId, filename = '') {
        const res = await apiFetch(`${API}/jobs/${encodeURIComponent(jobId)}/outputs/download`);
        if (!res.ok) {
            const data = await res.clone().json().catch(() => ({}));
            throw new Error(data?.error?.message || data?.error || `下载失败（${res.status}）`);
        }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename || `pdf-job-${jobId}-全部输出.zip`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
    }
    async function downloadJobOutputs(jobId) {
        const row = state.jobs.find(item => String(item.id) === String(jobId));
        const rowOutputs = resultOutputs(row);
        const rowOutput = selectOutput(rowOutputs);
        if (rowOutput?.id && rowOutputs.length === 1) {
            await downloadOutput(rowOutput.id, rowOutput.fileName);
            return;
        }
        if (rowOutputs.length > 1) {
            await downloadJobOutputArchive(jobId);
            toast('已开始下载全部输出', 'success');
            return;
        }
        const detail = await loadDetail(jobId, { silent: true, openPanel: false });
        const outputs = Array.isArray(detail?.outputs) ? detail.outputs.filter(output => output?.id) : [];
        if (!outputs.length) {
            toast('该任务暂无可下载输出', 'warning');
            return;
        }
        if (outputs.length === 1) {
            await downloadOutput(outputs[0].id, outputs[0].fileName);
            return;
        }
        await downloadJobOutputArchive(jobId);
        toast('已开始下载全部输出', 'success');
    }
    async function retryJob(jobId) {
        await requestJson(`${API}/jobs/${encodeURIComponent(jobId)}/retry`, { method: 'POST' });
        toast('任务已重新排队', 'success');
        await loadJobs({ keepActive: true });
    }

    async function cancelJob(jobId) {
        await requestJson(`${API}/jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' });
        toast('任务已取消');
        await loadJobs({ keepActive: true });
    }

    async function deleteJob(jobId) {
        if (!jobId) return;
        const confirmed = typeof window.confirm !== 'function' || window.confirm('确定删除该任务及相关文件吗？删除后不可恢复。');
        if (!confirmed) return;
        await requestJson(`${API}/jobs/${encodeURIComponent(jobId)}`, { method: 'DELETE' });
        if (String(state.activeJobId) === String(jobId)) {
            state.activeJobId = '';
            state.detail = null;
            closeDetailPanel();
        }
        toast('任务已删除', 'success');
        await loadJobs({ keepActive: false });
    }

    function bindEvents(view) {
        if (view.dataset.bound === '1') return;
        view.dataset.bound = '1';
        view.addEventListener('submit', event => {
            if (event.target?.id !== 'pdf-tools-form') return;
            event.preventDefault();
            submitJob(event.target).catch(e => toast(e.message || '创建任务失败', 'error'));
        });
        view.addEventListener('change', event => {
            if (event.target?.id === 'pdf-operation-select') {
                syncOperationOptions();
                return;
            }
            if (event.target?.id === 'pdf-status-filter') {
                state.status = event.target.value;
                state.page = 1;
                loadJobs({ keepActive: false }).catch(e => toast(e.message || '任务加载失败', 'error'));
            }
        });
        view.addEventListener('click', event => {
            const open = event.target.closest('[data-pdf-job-open]');
            if (open) {
                loadDetail(open.dataset.pdfJobOpen).catch(e => toast(e.message || '任务详情加载失败', 'error'));
                return;
            }
            if (event.target.closest('[data-pdf-close-detail]')) {
                closeDetailPanel();
                return;
            }
            if (event.target.closest('#pdf-refresh-btn')) {
                loadJobs({ keepActive: true }).catch(e => toast(e.message || '刷新失败', 'error'));
                return;
            }
            const output = event.target.closest('[data-pdf-output-download]');
            if (output) {
                downloadOutput(output.dataset.pdfOutputDownload, output.dataset.outputName).catch(e => toast(e.message || '下载失败', 'error'));
                return;
            }
            const rowDownload = event.target.closest('[data-pdf-job-download]');
            if (rowDownload) {
                downloadJobOutputs(rowDownload.dataset.pdfJobDownload).catch(e => toast(e.message || '下载失败', 'error'));
                return;
            }
            const remove = event.target.closest('[data-pdf-job-delete]');
            if (remove) {
                deleteJob(remove.dataset.pdfJobDelete).catch(e => toast(e.message || '删除失败', 'error'));
                return;
            }
            const retry = event.target.closest('[data-pdf-job-retry]');
            if (retry) {
                retryJob(retry.dataset.pdfJobRetry).catch(e => toast(e.message || '重试失败', 'error'));
                return;
            }
            const cancel = event.target.closest('[data-pdf-job-cancel]');
            if (cancel) {
                cancelJob(cancel.dataset.pdfJobCancel).catch(e => toast(e.message || '取消失败', 'error'));
            }
        });
    }

    function startPolling() {
        if (state.timer) return;
        state.timer = window.setInterval(() => {
            if (window.getAppsSessionValue?.('pivot_apps_active_app') !== 'pdf-tools') return;
            const active = state.jobs.some(job => job.status === 'pending' || job.status === 'processing');
            if (active) loadJobs({ keepActive: true }).catch(() => {});
        }, 4000);
    }

    async function showPdfToolsApp() {
        const view = ensureView();
        window.PivotDataAnalysis?.resetAiWorkspace?.();
        window.setAppsSessionValue?.('pivot_apps_active_app', 'pdf-tools');
        document.getElementById('apps-home-view')?.classList.add('hidden');
        document.getElementById('official-writing-view')?.classList.add('hidden');
        document.getElementById('data-analysis-view')?.classList.add('hidden');
        document.getElementById('regulations-view')?.classList.add('hidden');
        document.getElementById('ocr-view')?.classList.add('hidden');
        view.classList.remove('hidden');
        document.getElementById('apps-back-btn')?.classList.remove('hidden');
        if (typeof setAppsTitle === 'function') setAppsTitle('PDF 工具', '合并、拆分、旋转、删除、重排 PDF 页面，并导出图片或文本。');
        render();
        startPolling();
        await loadJobs({ keepActive: true });
    }

    window.PivotPdfTools = {
        ready: true,
        state,
        showPdfToolsApp,
        loadJobs,
        loadDetail
    };
    window.showPdfToolsApp = showPdfToolsApp;
})();
