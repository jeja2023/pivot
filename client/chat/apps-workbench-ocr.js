(function () {
    if (window.PivotOcr?.ready) return;

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
        timer: null
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
                            <input id="ocr-file-input" class="form-input" type="file" accept=".pdf,.png,.jpg,.jpeg,.webp,.bmp" required>
                        </label>
                        <div class="doc-tool-field-row">
                            <label class="doc-tool-field">
                                <span>识别引擎</span>
                                <select id="ocr-engine-select" class="form-input">
                                    <option value="paddle">PaddleOCR</option>
                                    <option value="tesseract">Tesseract</option>
                                    <option value="vision">视觉模型</option>
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
                                <span>DPI</span>
                                <input id="ocr-dpi-input" class="form-input" type="number" min="72" max="600" value="220">
                            </label>
                            <label class="doc-tool-field">
                                <span>页数上限</span>
                                <input id="ocr-pages-input" class="form-input" type="number" min="1" max="100" value="10">
                            </label>
                        </div>
                        <label class="doc-tool-field doc-tool-field-wide">
                            <span>PDF 密码</span>
                            <input id="ocr-password-input" class="form-input" type="password" autocomplete="off">
                        </label>
                        <div class="doc-tool-actions">
                            <button id="ocr-submit-btn" class="btn-primary" type="submit">创建任务</button>
                            <button id="ocr-refresh-btn" class="btn-secondary" type="button">刷新</button>
                        </div>
                    </form>

                    <div class="doc-tool-filter">
                        <label class="doc-tool-field doc-tool-field-wide">
                            <span>状态</span>
                            <select id="ocr-status-filter" class="form-input">
                                <option value="">全部任务</option>
                                <option value="pending">排队中</option>
                                <option value="processing">处理中</option>
                                <option value="needs_review">待复核</option>
                                <option value="succeeded">已完成</option>
                                <option value="failed">失败</option>
                            </select>
                        </label>
                    </div>

                    <div id="ocr-engine-status" class="doc-tool-engine-list"></div>
                </aside>

                <main class="workspace-panel doc-tool-main ocr-main">
                    <div class="doc-tool-main-head">
                        <div>
                            <h4>文字识别任务</h4>
                            <span id="ocr-list-summary">0 个任务</span>
                        </div>
                        <div class="doc-tool-head-actions">
                            <button id="ocr-prev-page" class="btn-secondary" type="button">上一页</button>
                            <button id="ocr-next-page" class="btn-secondary" type="button">下一页</button>
                        </div>
                    </div>
                    <div class="table-container workspace-table-wrap doc-tool-table-wrap">
                        <table class="data-table compact-table doc-tool-table">
                            <thead>
                                <tr>
                                    <th style="width: 58px;" class="text-center">序号</th>
                                    <th>文件</th>
                                    <th style="width: 100px;" class="text-center">状态</th>
                                    <th style="width: 96px;" class="text-center">进度</th>
                                    <th style="width: 150px;">更新时间</th>
                                </tr>
                            </thead>
                            <tbody id="ocr-job-table-body"></tbody>
                        </table>
                    </div>
                    <div id="ocr-detail" class="ocr-detail"></div>
                </main>
            </div>
        `);
        view.dataset.ready = '1';
        bindEvents(view);
        return view;
    }

    function renderEngines() {
        const box = document.getElementById('ocr-engine-status');
        if (!box) return;
        const entries = Object.entries(state.engines || {});
        html.setHtml(box, entries.map(([name, info]) => `
            <div class="doc-tool-engine ${info?.available ? 'is-success' : 'is-warning'}">
                <strong>${esc(name)}</strong>
                <span>${info?.available ? '可用' : esc(info?.error || '不可用')}</span>
            </div>
        `).join('') || '<div class="doc-tool-empty-small">引擎状态未加载</div>');
    }

    function renderJobs() {
        const tbody = document.getElementById('ocr-job-table-body');
        const summary = document.getElementById('ocr-list-summary');
        if (summary) summary.textContent = `${state.total || 0} 个任务`;
        if (!tbody) return;
        const offset = (state.page - 1) * state.limit;
        html.setHtml(tbody, state.jobs.map((item, index) => `
            <tr class="doc-tool-row ${String(item.id) === String(state.activeJobId) ? 'is-active' : ''}" data-ocr-job-id="${esc(item.id)}">
                <td class="text-center">${offset + index + 1}</td>
                <td>
                    <button class="doc-tool-link" type="button" data-ocr-job-open="${esc(item.id)}">${esc(item.file?.originalName || `任务 ${item.id}`)}</button>
                    <small>${esc(item.file?.fileExt || '')} ${formatBytes(item.file?.fileSize)}</small>
                </td>
                <td class="text-center"><span class="doc-tool-badge ${statusTone(item.status)}">${statusLabel(item.status)}</span></td>
                <td class="text-center">${Number(item.progress || 0)}%</td>
                <td>${esc(formatTime(item.updatedAt || item.createdAt))}</td>
            </tr>
        `).join('') || '<tr><td colspan="5" class="doc-tool-empty-cell">暂无任务</td></tr>');
        document.getElementById('ocr-prev-page')?.toggleAttribute('disabled', state.page <= 1);
        document.getElementById('ocr-next-page')?.toggleAttribute('disabled', state.page * state.limit >= state.total);
    }

    function renderOutputs(outputs = []) {
        if (!outputs.length) return '<div class="doc-tool-empty-small">暂无输出</div>';
        return outputs.map(output => `
            <button class="btn-secondary doc-tool-output-btn" type="button" data-ocr-output-download="${esc(output.id)}" data-output-name="${esc(output.fileName || '')}">
                ${esc(output.outputType || 'output')} · ${formatBytes(output.fileSize)}
            </button>
        `).join('');
    }

    function renderPageList(pages = []) {
        if (!pages.length) return '<div class="doc-tool-empty-small">暂无页面</div>';
        return pages.map(page => `
            <button class="ocr-page-pill ${String(activePage()?.id) === String(page.id) ? 'is-active' : ''} ${statusTone(page.ocrStatus)}" type="button" data-ocr-page-id="${esc(page.id)}">
                <span>第 ${page.pageNumber} 页</span>
                <em>${page.confidence === null || page.confidence === undefined ? '-' : Math.round(page.confidence * 100) + '%'}</em>
            </button>
        `).join('');
    }

    function confidenceThreshold() {
        const value = Number(state.detail?.job?.config?.confidenceThreshold);
        return Number.isFinite(value) && value > 0 ? value : 0.75;
    }

    function bboxToRect(bbox) {
        if (!Array.isArray(bbox) || !bbox.length) return null;
        if (Array.isArray(bbox[0])) {
            const points = bbox
                .map(point => Array.isArray(point) ? point : [])
                .filter(point => Number.isFinite(Number(point[0])) && Number.isFinite(Number(point[1])));
            if (!points.length) return null;
            const xs = points.map(point => Number(point[0]));
            const ys = points.map(point => Number(point[1]));
            const minX = Math.min(...xs);
            const maxX = Math.max(...xs);
            const minY = Math.min(...ys);
            const maxY = Math.max(...ys);
            return { x: minX, y: minY, width: Math.max(maxX - minX, 1), height: Math.max(maxY - minY, 1) };
        }
        if (bbox.length >= 4) {
            const x = Number(bbox[0]);
            const y = Number(bbox[1]);
            const third = Number(bbox[2]);
            const fourth = Number(bbox[3]);
            if (![x, y, third, fourth].every(Number.isFinite)) return null;
            const width = third > x ? third - x : third;
            const height = fourth > y ? fourth - y : fourth;
            return { x, y, width: Math.max(width, 1), height: Math.max(height, 1) };
        }
        return null;
    }

    function pct(value, total) {
        const n = Number(value || 0);
        const d = Math.max(Number(total || 0), 1);
        return Math.min(Math.max((n / d) * 100, 0), 100).toFixed(4) + '%';
    }

    function renderOverlayBlocks(page) {
        if (!page) return '';
        const width = Number(page.width || 0) || 1;
        const height = Number(page.height || 0) || 1;
        const threshold = confidenceThreshold();
        return blocksForPage(page.id).map(block => {
            const rect = bboxToRect(block.bbox || []);
            if (!rect) return '';
            const confidence = Number(block.confidence || 0);
            const lowClass = confidence > 0 && confidence < threshold ? ' is-low' : '';
            const style = [
                'left:' + pct(rect.x, width),
                'top:' + pct(rect.y, height),
                'width:' + pct(rect.width, width),
                'height:' + pct(rect.height, height)
            ].join(';');
            const title = Math.round(confidence * 100) + '% ' + String(block.text || '').slice(0, 80);
            return '<button class="ocr-overlay-box' + lowClass + '" type="button" style="' + style + '" data-ocr-block-id="' + esc(block.id || '') + '" title="' + esc(title) + '"></button>';
        }).join('');
    }

    function renderPagePreview(page) {
        if (!page?.hasImage) return '<div class="doc-tool-empty-detail">\u6682\u65e0\u9875\u9762\u9884\u89c8</div>';
        const width = Number(page.width || 0) || 1;
        const height = Number(page.height || 0) || 1;
        return [
            '<div class="ocr-preview-canvas" style="aspect-ratio:' + width + '/' + height + '">',
            '<img alt="\u9875\u9762\u9884\u89c8" src="' + API + '/pages/' + encodeURIComponent(page.id) + '/image">',
            '<div class="ocr-overlay-layer">' + renderOverlayBlocks(page) + '</div>',
            '</div>'
        ].join('');
    }

    function renderBlocks(pageId) {
        const blocks = blocksForPage(pageId).slice(0, 120);
        if (!blocks.length) return '<div class="doc-tool-empty-small">\u6682\u65e0\u6587\u672c\u5757</div>';
        const threshold = confidenceThreshold();
        return blocks.map(block => {
            const confidence = Number(block.confidence || 0);
            const lowClass = confidence > 0 && confidence < threshold ? ' is-low' : '';
            return [
                '<div class="ocr-block-row' + lowClass + '" data-ocr-block-id="' + esc(block.id || '') + '">',
                '<span>' + Math.round(confidence * 100) + '%</span>',
                '<p>' + esc(block.text || '') + '</p>',
                '</div>'
            ].join('');
        }).join('');
    }

    function renderDetail() {
        const box = document.getElementById('ocr-detail');
        if (!box) return;
        const detail = state.detail;
        if (!detail?.job) {
            html.setHtml(box, '<div class="doc-tool-empty-detail">选择任务查看页面、文本和输出</div>');
            return;
        }
        const job = detail.job;
        const page = activePage();
        const review = page ? reviewForPage(page.id) : null;
        const text = review?.revisedText ?? page?.text ?? '';
        html.setHtml(box, `
            <section class="ocr-detail-head">
                <div>
                    <strong>${esc(detail.file?.originalName || `任务 ${job.id}`)}</strong>
                    <span class="doc-tool-badge ${statusTone(job.status)}">${statusLabel(job.status)}</span>
                    <span>${Number(job.progress || 0)}%</span>
                    ${job.errorMessage ? `<em>${esc(job.errorMessage)}</em>` : ''}
                </div>
                <div class="ocr-detail-actions">
                    <button class="btn-secondary" type="button" data-ocr-job-retry="${esc(job.id)}">重试</button>
                    <button class="btn-secondary" type="button" data-ocr-job-cancel="${esc(job.id)}">取消</button>
                    <button class="btn-secondary" type="button" data-ocr-export="text">TXT</button>
                    <button class="btn-secondary" type="button" data-ocr-export="markdown">Markdown</button>
                    <button class="btn-secondary" type="button" data-ocr-export="json">JSON</button>
                    <button class="btn-secondary" type="button" data-ocr-export="html">HTML</button>
                    <button class="btn-secondary" type="button" data-ocr-export="docx">DOCX</button>
                    <button class="btn-secondary" type="button" data-ocr-export="searchable_pdf">可检索PDF</button>
                    <button class="btn-secondary" type="button" data-ocr-share="knowledge">\u5165\u77e5\u8bc6\u5e93</button>
                    <button class="btn-secondary" type="button" data-ocr-share="regulations">\u5165\u6cd5\u89c4\u5e93</button>
                    <button class="btn-secondary" type="button" data-ocr-share="official-writing">\u5165\u516c\u6587\u6750\u6599</button>
                    <button class="btn-secondary" type="button" data-ocr-share="chat">\u653e\u5165\u804a\u5929</button>
                </div>
            </section>
            <section class="ocr-output-strip">${renderOutputs(detail.outputs || [])}</section>
            <section class="ocr-review-grid">
                <aside class="ocr-page-list">${renderPageList(detail.pages || [])}</aside>
                <div class="ocr-preview-pane">
                    ${renderPagePreview(page)}
                </div>
                <div class="ocr-text-pane">
                    <div class="ocr-text-head">
                        <strong>${page ? `第 ${page.pageNumber} 页文本` : '页面文本'}</strong>
                        <span>${page?.textLength || 0} 字</span>
                    </div>
                    <textarea id="ocr-review-text" class="form-input ocr-review-textarea" spellcheck="false">${esc(text)}</textarea>
                    <div class="ocr-review-actions">
                        <label class="ocr-confirm-low">
                            <input id="ocr-low-confidence-confirm" type="checkbox" ${review?.lowConfidenceConfirmed ? 'checked' : ''}>
                            <span>低置信度已确认</span>
                        </label>
                        <button class="btn-primary" type="button" data-ocr-page-save="${page ? esc(page.id) : ''}" ${page ? '' : 'disabled'}>保存复核</button>
                    </div>
                    <div class="ocr-block-list">${page ? renderBlocks(page.id) : ''}</div>
                </div>
            </section>
        `);
    }

    function render() {
        renderEngines();
        renderJobs();
        renderDetail();
    }

    async function loadEngines() {
        try {
            const data = await requestJson(`${API}/engines`);
            state.engines = data.engines || {};
            renderEngines();
        } catch (e) {
            toast(e.message || '引擎状态加载失败', 'warning');
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
            state.activeJobId = state.jobs[0]?.id ? String(state.jobs[0].id) : '';
        }
        renderJobs();
        if (state.activeJobId) await loadDetail(state.activeJobId, { silent: true });
        else {
            state.detail = null;
            renderDetail();
        }
    }

    async function loadDetail(jobId, { silent = false } = {}) {
        if (!jobId) return;
        const data = await requestJson(`${API}/jobs/${encodeURIComponent(jobId)}`);
        state.detail = data;
        state.activeJobId = String(data.job?.id || jobId);
        if (!data.pages?.some(page => String(page.id) === String(state.activePageId))) {
            state.activePageId = data.pages?.[0]?.id ? String(data.pages[0].id) : '';
        }
        render();
        if (!silent) toast('任务详情已更新');
    }

    async function submitUpload(form) {
        const file = document.getElementById('ocr-file-input')?.files?.[0];
        if (!file) {
            toast('请选择文件', 'warning');
            return;
        }
        const data = new FormData(form);
        data.set('file', file);
        data.set('engine', document.getElementById('ocr-engine-select')?.value || 'paddle');
        data.set('language', document.getElementById('ocr-language-select')?.value || 'ch');
        data.set('dpi', document.getElementById('ocr-dpi-input')?.value || '220');
        data.set('maxRenderPages', document.getElementById('ocr-pages-input')?.value || '10');
        data.set('maxOcrPages', document.getElementById('ocr-pages-input')?.value || '10');
        data.set('password', document.getElementById('ocr-password-input')?.value || '');
        const btn = document.getElementById('ocr-submit-btn');
        const text = btn?.textContent || '';
        if (btn) {
            btn.disabled = true;
            btn.textContent = '创建中';
        }
        try {
            const created = await requestJson(`${API}/jobs`, { method: 'POST', body: data });
            state.activeJobId = String(created.job?.id || '');
            state.activePageId = '';
            form.reset();
            document.getElementById('ocr-dpi-input').value = '220';
            document.getElementById('ocr-pages-input').value = '10';
            toast('文字识别任务已创建', 'success');
            await loadJobs({ keepActive: true });
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.textContent = text;
            }
        }
    }

    async function exportOutput(format) {
        if (!state.activeJobId) return;
        const data = await requestJson(`${API}/jobs/${encodeURIComponent(state.activeJobId)}/outputs`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ format })
        });
        toast('输出已生成', 'success');
        await loadDetail(state.activeJobId, { silent: true });
        if (data.output?.id) await downloadOutput(data.output.id, data.output.fileName);
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
        link.download = filename || `ocr-output-${outputId}`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
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
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            return true;
        }
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
        localStorage.setItem('pivot_ocr_official_writing_material_v1', JSON.stringify({ text, savedAt: new Date().toISOString() }));
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
            if (appendToChatInput(text)) toast('\u5df2\u653e\u5165\u804a\u5929\u8f93\u5165\u6846', 'success');
            else {
                await copyText(text);
                toast('\u672a\u627e\u5230\u804a\u5929\u8f93\u5165\u6846\uff0c\u5df2\u590d\u5236\u6587\u672c', 'warning');
            }
            return;
        }
        if (target === 'official-writing') {
            const direct = appendToOfficialWritingMaterial(text);
            await copyText(text).catch(() => false);
            toast(direct ? '\u5df2\u5199\u5165\u516c\u6587\u6750\u6599' : '\u5df2\u4fdd\u5b58\u5230\u516c\u6587\u6750\u6599\u5f85\u53d6\u7528\u533a\u5e76\u590d\u5236', 'success');
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
            body: JSON.stringify({ revisedText, lowConfidenceConfirmed, reviewStatus: 'reviewed' })
        });
        toast('复核已保存', 'success');
        await loadDetail(state.activeJobId, { silent: true });
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
        });
        view.addEventListener('click', event => {
            const open = event.target.closest('[data-ocr-job-open]');
            if (open) {
                loadDetail(open.dataset.ocrJobOpen).catch(e => toast(e.message || '任务详情加载失败', 'error'));
                return;
            }
            const page = event.target.closest('[data-ocr-page-id]');
            if (page) {
                state.activePageId = page.dataset.ocrPageId;
                renderDetail();
                return;
            }
            if (event.target.closest('#ocr-refresh-btn')) {
                loadJobs({ keepActive: true }).catch(e => toast(e.message || '刷新失败', 'error'));
                loadEngines();
                return;
            }
            if (event.target.closest('#ocr-prev-page')) {
                if (state.page > 1) {
                    state.page -= 1;
                    loadJobs({ keepActive: false }).catch(e => toast(e.message || '翻页失败', 'error'));
                }
                return;
            }
            if (event.target.closest('#ocr-next-page')) {
                if (state.page * state.limit < state.total) {
                    state.page += 1;
                    loadJobs({ keepActive: false }).catch(e => toast(e.message || '翻页失败', 'error'));
                }
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
            if (exportBtn) {
                exportOutput(exportBtn.dataset.ocrExport).catch(e => toast(e.message || '导出失败', 'error'));
                return;
            }
            const output = event.target.closest('[data-ocr-output-download]');
            if (output) {
                downloadOutput(output.dataset.ocrOutputDownload, output.dataset.outputName).catch(e => toast(e.message || '下载失败', 'error'));
                return;
            }
            const save = event.target.closest('[data-ocr-page-save]');
            if (save) {
                saveReview(save.dataset.ocrPageSave).catch(e => toast(e.message || '保存复核失败', 'error'));
                return;
            }
            const retry = event.target.closest('[data-ocr-job-retry]');
            if (retry) {
                retryJob(retry.dataset.ocrJobRetry).catch(e => toast(e.message || '重试失败', 'error'));
                return;
            }
            const cancel = event.target.closest('[data-ocr-job-cancel]');
            if (cancel) {
                cancelJob(cancel.dataset.ocrJobCancel).catch(e => toast(e.message || '取消失败', 'error'));
            }
        });
    }

    function startPolling() {
        if (state.timer) return;
        state.timer = window.setInterval(() => {
            if (sessionStorage.getItem('pivot_apps_active_app') !== 'ocr') return;
            const active = state.jobs.some(job => job.status === 'pending' || job.status === 'processing');
            if (active) loadJobs({ keepActive: true }).catch(() => {});
        }, 4000);
    }

    async function showOcrApp() {
        const view = ensureView();
        sessionStorage.setItem('pivot_apps_active_app', 'ocr');
        document.getElementById('apps-home-view')?.classList.add('hidden');
        document.getElementById('official-writing-view')?.classList.add('hidden');
        document.getElementById('data-analysis-view')?.classList.add('hidden');
        document.getElementById('regulations-view')?.classList.add('hidden');
        document.getElementById('pdf-tools-view')?.classList.add('hidden');
        view.classList.remove('hidden');
        document.getElementById('apps-back-btn')?.classList.remove('hidden');
        if (typeof setAppsTitle === 'function') setAppsTitle('文字识别', '上传图片或 PDF，复核识别结果并导出文本、Markdown、JSON 或可检索 PDF。');
        render();
        startPolling();
        await Promise.all([loadEngines(), loadJobs({ keepActive: true })]);
    }

    window.PivotOcr = {
        ready: true,
        state,
        showOcrApp,
        loadJobs,
        loadDetail
    };
    window.showOcrApp = showOcrApp;
})();