(function () {
    if (window.Pivot.legacy.PivotPdfTools?.ready) return;

    const API = '/api/apps/pdf-tools';
    const state = {
        jobs: [],
        detail: null,
        activeJobId: '',
        status: '',
        page: 1,
        limit: 12,
        total: 0,
        capabilities: null,
        timer: null,
        polling: false
    };

    const FALLBACK_OPERATIONS = {
        merge: { label: '合并 PDF', inputMode: 'combine', accept: 'pdf' },
        split: { label: '拆分页面', inputMode: 'single-or-batch', supportsPages: true },
        rotate: { label: '旋转页面', inputMode: 'single-or-batch', supportsPages: true },
        delete_pages: { label: '删除页面', inputMode: 'single-or-batch', supportsPages: true },
        reorder: { label: '重排页面', inputMode: 'single-or-batch', supportsOrder: true },
        extract_text: { label: '提取文本', inputMode: 'single-or-batch' },
        pdf_to_images: { label: 'PDF 转图片', inputMode: 'single-or-batch', supportsPages: true, supportsDpi: true },
        images_to_pdf: { label: '图片转 PDF', inputMode: 'combine', accept: 'image' },
        searchable_pdf: { label: '生成可搜索 PDF', inputMode: 'single', supportsPages: true },
        watermark: { label: '添加水印', inputMode: 'single-or-batch', supportsPages: true, supportsWatermark: true },
        page_numbers: { label: '添加页码', inputMode: 'single-or-batch', supportsPages: true, supportsPageNumbers: true },
        crop: { label: '裁切页面', inputMode: 'single-or-batch', supportsPages: true, supportsCrop: true },
        insert_blank: { label: '插入空白页', inputMode: 'single-or-batch', supportsBlankPage: true },
        compress: { label: '优化 PDF', inputMode: 'single-or-batch', supportsCompression: true }
    };

    const html = window.Pivot.legacy.PivotSafeHtml || {
        escapeHtml(value) {
            return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
        },
        setHtml(element, value) {
            if (!element) return;
            element.replaceChildren(document.createTextNode(String(value || '')));
        }
    };

    function esc(value) { return html.escapeHtml(value); }
    function toast(message, type) { if (typeof showToast === 'function') showToast(message, type); }

    async function requestJson(url, options = {}) {
        const response = await apiFetch(url, options);
        const data = await response.clone().json().catch(() => ({}));
        if (!response.ok) {
            const error = new Error(data?.error?.message || data?.error || data?.message || `请求失败（${response.status}）`);
            error.code = data?.code || data?.error?.code || '';
            throw error;
        }
        return data;
    }

    function operations() {
        const remote = state.capabilities?.operations;
        if (!Array.isArray(remote) || !remote.length) return FALLBACK_OPERATIONS;
        return remote.reduce((result, item) => ({ ...result, [item.id]: item }), {});
    }

    function operation(operation) { return operations()[operation] || FALLBACK_OPERATIONS.merge; }
    function operationLabel(value) { return operation(value)?.label || value || '-'; }
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
        return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('zh-CN', { hour12: false });
    }
    function statusLabel(value) {
        return ({ queued: '排队中', processing: '处理中', succeeded: '已完成', partial_success: '部分完成', failed: '失败', cancelled: '已取消', needs_review: '待复核' })[value] || value || '-';
    }
    function statusTone(value) {
        if (value === 'succeeded') return 'is-success';
        if (value === 'partial_success' || value === 'needs_review') return 'is-warning';
        if (value === 'failed') return 'is-danger';
        if (value === 'queued' || value === 'processing') return 'is-info';
        return '';
    }
    function currentOperation() { return document.getElementById('pdf-operation-select')?.value || 'merge'; }
    function isDetailOpen() { return !document.getElementById('pdf-detail-panel')?.classList.contains('hidden'); }
    function closeDetail() { document.getElementById('pdf-detail-panel')?.classList.add('hidden'); }
    function openDetail() { document.getElementById('pdf-detail-panel')?.classList.remove('hidden'); }

    function renderOperationOptions() {
        return Object.entries(operations()).map(([id, meta]) => `<option value="${esc(id)}">${esc(meta.label || id)}</option>`).join('');
    }

    function renderPresetOptions() {
        const presets = state.capabilities?.presets || [];
        return ['<option value="">不使用预设</option>', ...presets.map(item => `<option value="${esc(item.id)}">${esc(item.label)}</option>`)].join('');
    }

    function ensureView() {
        let view = document.getElementById('pdf-tools-view');
        if (!view) {
            view = document.createElement('div');
            view.id = 'pdf-tools-view';
            view.className = 'pdf-tools-view hidden';
            (document.querySelector('.apps-workspace-body') || document.body).appendChild(view);
        }
        if (view.dataset.ready === '1') return view;
        html.setHtml(view, `
            <div class="pdf-tools-layout doc-tool-layout">
                <aside class="workspace-panel doc-tool-sidebar pdf-tools-sidebar">
                    <form id="pdf-tools-form" class="doc-tool-form">
                        <label class="doc-tool-field doc-tool-field-wide"><span>常用预设</span><select id="pdf-preset-select" class="form-input">${renderPresetOptions()}</select><small class="pdf-tool-hint">预设会填入处理方式和常用参数，仍可在提交前调整。</small></label>
                        <label class="doc-tool-field doc-tool-field-wide"><span>处理方式</span><select id="pdf-operation-select" class="form-input" name="operation">${renderOperationOptions()}</select></label>
                        <label class="doc-tool-field doc-tool-field-wide"><span>文件</span><input id="pdf-files-input" class="form-input" type="file" name="files" accept=".pdf,.png,.jpg,.jpeg,.webp,.bmp" multiple required><small id="pdf-file-hint" class="pdf-tool-hint">合并与图片转 PDF 可组合多个文件；其它操作默认单文件。</small></label>
                        <label class="doc-tool-field doc-tool-field-wide hidden" data-pdf-option="batch"><span>多文件处理方式</span><select id="pdf-mode-input" class="form-input"><option value="single">一次处理一个文件</option><option value="batch">批量分别处理每个文件</option></select></label>
                        <label class="doc-tool-field doc-tool-field-wide hidden" data-pdf-option="pages"><span>页面范围</span><input id="pdf-pages-input" class="form-input" name="pages" type="text" placeholder="例如 1-3,5"><small class="pdf-tool-hint">范围必须在文件实际页数内；留空表示全部页面。</small></label>
                        <label class="doc-tool-field doc-tool-field-wide hidden" data-pdf-option="order"><span>完整页面顺序</span><input id="pdf-order-input" class="form-input" name="pageOrder" type="text" placeholder="例如 3,1,2"><small class="pdf-tool-hint">重排必须包含每一页且不能重复。</small></label>
                        <div class="doc-tool-field-row hidden" data-pdf-option="rotate"><label class="doc-tool-field doc-tool-field-wide"><span>旋转角度</span><select id="pdf-rotate-input" class="form-input"><option value="90">顺时针 90°</option><option value="180">180°</option><option value="270">顺时针 270°</option></select></label></div>
                        <div class="doc-tool-field-row hidden" data-pdf-option="render"><label class="doc-tool-field"><span>分辨率（每英寸点数）</span><input id="pdf-dpi-input" class="form-input" type="number" min="72" max="600" value="220"></label><label class="doc-tool-field"><span>最多页数</span><input id="pdf-max-pages-input" class="form-input" type="number" min="1" max="300" value="100"></label></div>
                        <div class="doc-tool-field-row hidden" data-pdf-option="watermark"><label class="doc-tool-field doc-tool-field-wide"><span>水印文字</span><input id="pdf-watermark-text" class="form-input" type="text" maxlength="120" value="机密"></label><label class="doc-tool-field"><span>位置</span><select id="pdf-watermark-position" class="form-input"><option value="center">居中</option><option value="top-center">顶部居中</option><option value="bottom-center">底部居中</option></select></label><label class="doc-tool-field"><span>透明度</span><input id="pdf-watermark-opacity" class="form-input" type="number" min="0.05" max="0.8" step="0.05" value="0.18"></label></div>
                        <div class="doc-tool-field-row hidden" data-pdf-option="numbers"><label class="doc-tool-field"><span>起始页码</span><input id="pdf-page-number-start" class="form-input" type="number" min="1" value="1"></label><label class="doc-tool-field"><span>位置</span><select id="pdf-page-number-position" class="form-input"><option value="bottom-center">底部居中</option><option value="bottom-right">右下角</option><option value="bottom-left">左下角</option></select></label><label class="doc-tool-field pdf-tool-checkbox"><input id="pdf-skip-cover" type="checkbox"><span>跳过封面</span></label></div>
                        <div class="doc-tool-field-row hidden" data-pdf-option="crop"><label class="doc-tool-field"><span>左边距 pt</span><input id="pdf-crop-left" class="form-input" type="number" min="0" value="0"></label><label class="doc-tool-field"><span>右边距 pt</span><input id="pdf-crop-right" class="form-input" type="number" min="0" value="0"></label><label class="doc-tool-field"><span>上边距 pt</span><input id="pdf-crop-top" class="form-input" type="number" min="0" value="0"></label><label class="doc-tool-field"><span>下边距 pt</span><input id="pdf-crop-bottom" class="form-input" type="number" min="0" value="0"></label><small class="pdf-tool-hint">裁切只改变页面可见区域，不会删除隐藏内容。</small></div>
                        <div class="doc-tool-field-row hidden" data-pdf-option="blank"><label class="doc-tool-field"><span>插入位置</span><input id="pdf-blank-after" class="form-input" type="number" min="0" value="0"></label><label class="doc-tool-field"><span>空白页数量</span><input id="pdf-blank-count" class="form-input" type="number" min="1" max="20" value="1"></label><small class="pdf-tool-hint">0 表示文件开头；其它数字表示在该页之后插入。</small></div>
                        <div class="doc-tool-field-row hidden" data-pdf-option="image-pdf"><label class="doc-tool-field"><span>页面纸张</span><select id="pdf-page-size" class="form-input"><option value="original">保持图片物理尺寸</option><option value="a4">A4</option><option value="a3">A3</option><option value="letter">北美信纸尺寸</option></select></label><label class="doc-tool-field"><span>适配方式</span><select id="pdf-image-fit" class="form-input"><option value="contain">完整显示</option><option value="cover">填满纸张</option></select></label></div>
                        <label class="doc-tool-field doc-tool-field-wide"><span>PDF 密码</span><input id="pdf-password-input" class="form-input" type="password" autocomplete="off"><small class="pdf-tool-hint">仅用于本次任务，处理结束后会被删除。当前结构处理不支持加密 PDF。</small></label>
                        <div class="doc-tool-actions"><button id="pdf-submit-btn" class="btn-primary" type="submit">创建任务</button><button id="pdf-refresh-btn" class="btn-secondary" type="button">刷新</button></div>
                    </form>
                    <div class="doc-tool-filter"><label class="doc-tool-field doc-tool-field-wide"><span>状态</span><select id="pdf-status-filter" class="form-input"><option value="">全部任务</option><option value="queued">排队中</option><option value="processing">处理中</option><option value="succeeded">已完成</option><option value="partial_success">部分完成</option><option value="needs_review">待复核</option><option value="failed">失败</option><option value="cancelled">已取消</option></select></label></div>
                </aside>
                <main class="workspace-panel doc-tool-main pdf-tools-main"><div class="workspace-toolbar doc-tool-toolbar"><div class="doc-tool-toolbar-title"><h4>PDF 处理任务</h4><span id="pdf-list-summary">0 个任务</span></div><span id="pdf-capability-summary" class="pdf-capability-summary"></span></div><div class="table-container workspace-table-wrap doc-tool-table-wrap"><table class="data-table compact-table doc-tool-table pdf-job-table"><thead><tr><th class="text-center">序号</th><th>文件</th><th>处理方式</th><th class="text-center">状态</th><th class="text-center">进度</th><th>更新时间</th><th class="text-center">操作</th></tr></thead><tbody id="pdf-job-table-body"></tbody></table></div><div id="pdf-job-pagination" class="pagination workspace-pagination"></div></main>
            </div>
            <section id="pdf-detail-panel" class="doc-tool-detail-panel hidden" role="dialog" aria-modal="true" aria-labelledby="pdf-detail-title"><div class="workspace-modal doc-tool-dialog pdf-detail-dialog"><div class="workspace-modal-header"><div><h3 id="pdf-detail-title">PDF 处理详情</h3><p id="pdf-detail-subtitle">查看任务摘要、页面和输出文件。</p></div><button class="btn-secondary workspace-modal-close" type="button" data-pdf-close-detail>关闭</button></div><div id="pdf-detail" class="workspace-modal-body doc-tool-modal-body pdf-detail"></div></div></section>
            <section id="pdf-page-preview-panel" class="doc-tool-detail-panel hidden" role="dialog" aria-modal="true" aria-labelledby="pdf-page-preview-title"><div class="workspace-modal doc-tool-dialog pdf-page-preview-dialog"><div class="workspace-modal-header"><div><h3 id="pdf-page-preview-title">PDF 页面预览</h3><p>预览来自受控页面资源，可返回任务详情继续处理。</p></div><button class="btn-secondary workspace-modal-close" type="button" data-pdf-close-preview>返回详情</button></div><div class="workspace-modal-body pdf-page-preview-body"><img id="pdf-page-preview-image" alt="PDF 页面预览"></div></div></section>
        `);
        view.dataset.ready = '1';
        bindEvents(view);
        syncOperationOptions();
        return view;
    }

    function syncOperationOptions() {
        const selected = currentOperation();
        const meta = operation(selected);
        const show = (name, visible) => document.querySelectorAll(`#pdf-tools-view [data-pdf-option="${name}"]`).forEach(element => element.classList.toggle('hidden', !visible));
        show('batch', meta.inputMode === 'single-or-batch');
        show('pages', Boolean(meta.supportsPages));
        show('order', Boolean(meta.supportsOrder));
        show('rotate', selected === 'rotate');
        show('render', Boolean(meta.supportsDpi));
        show('watermark', Boolean(meta.supportsWatermark));
        show('numbers', Boolean(meta.supportsPageNumbers));
        show('crop', Boolean(meta.supportsCrop));
        show('blank', Boolean(meta.supportsBlankPage));
        show('image-pdf', selected === 'images_to_pdf');
        const hint = document.getElementById('pdf-file-hint');
        if (hint) hint.textContent = meta.inputMode === 'combine' ? `${meta.label}需要组合多个文件，文件顺序将决定输出顺序。` : (meta.inputMode === 'single' ? `${meta.label}一次只能处理一个文件。` : '默认一次处理一个文件；选择批量后会分别生成每个文件的结果。');
    }

    function applyPreset(presetId) {
        const preset = (state.capabilities?.presets || []).find(item => item.id === presetId);
        if (!preset) return;
        const operationSelect = document.getElementById('pdf-operation-select');
        if (operationSelect && operations()[preset.operation]) operationSelect.value = preset.operation;
        const fieldIds = {
            dpi: 'pdf-dpi-input', maxToolPages: 'pdf-max-pages-input', watermarkText: 'pdf-watermark-text', watermarkPosition: 'pdf-watermark-position', watermarkOpacity: 'pdf-watermark-opacity', pageNumberPosition: 'pdf-page-number-position', pageNumberStart: 'pdf-page-number-start'
        };
        Object.entries(preset.config || {}).forEach(([key, value]) => {
            if (key === 'skipCover') {
                const input = document.getElementById('pdf-skip-cover');
                if (input) input.checked = Boolean(value);
                return;
            }
            const input = document.getElementById(fieldIds[key]);
            if (input) input.value = String(value);
        });
        syncOperationOptions();
    }

    function renderRowActions(item) {
        const action = item.allowedActions || {};
        const active = ['queued', 'processing'].includes(item.status);
        return [
            `<button class="btn-secondary doc-tool-row-action" type="button" data-pdf-job-open="${esc(item.id)}">查看</button>`,
            (action.download || item.status === 'succeeded' || item.status === 'partial_success') ? `<button class="btn-secondary doc-tool-row-action" type="button" data-pdf-job-download="${esc(item.id)}">下载</button>` : '',
            (action.retry || item.status === 'failed' || item.status === 'needs_review' || item.status === 'cancelled') ? `<button class="btn-secondary doc-tool-row-action" type="button" data-pdf-job-retry="${esc(item.id)}">重试</button>` : '',
            active ? `<button class="btn-secondary doc-tool-row-action" type="button" data-pdf-job-cancel="${esc(item.id)}">取消</button>` : '',
            !active ? `<button class="btn-danger-outline doc-tool-row-action" type="button" data-pdf-job-delete="${esc(item.id)}">删除</button>` : ''
        ].filter(Boolean).join('');
    }

    function renderJobs() {
        const tbody = document.getElementById('pdf-job-table-body');
        const summary = document.getElementById('pdf-list-summary');
        const capability = document.getElementById('pdf-capability-summary');
        if (summary) summary.textContent = `${state.total || 0} 个任务`;
        if (capability) capability.textContent = state.capabilities?.engines?.cjkFont?.available === false ? '中文 PDF 字体不可用' : '结果按任务独立保留';
        if (!tbody) return;
        const offset = (state.page - 1) * state.limit;
        const rows = state.jobs.map(function (item, index) {
            const fileMeta = `${item.file?.originalName || ''} ${item.file?.fileExt || ''} ${formatBytes(item.file?.fileSize)}`.trim();
            return `
            <tr class="doc-tool-row ${String(item.id) === String(state.activeJobId) ? 'is-active' : ''}">
                <td class="text-center">${offset + index + 1}</td><td data-pdf-file-meta="${esc(fileMeta)}"><strong class="doc-tool-file-title">${esc(item.file?.originalName || `任务 ${item.id}`)}</strong></td><td>${esc(operationLabel(item.config?.operation))}</td><td class="text-center"><span class="doc-tool-badge ${statusTone(item.status)}">${statusLabel(item.status)}</span></td><td class="text-center">${Number(item.progress || 0)}%</td><td>${esc(formatTime(item.updatedAt || item.createdAt))}</td><td class="text-center"><div class="doc-tool-row-actions">${renderRowActions(item)}</div></td>
            </tr>`;
        }).join('');
        html.setHtml(tbody, rows || '<tr><td colspan="7" class="doc-tool-empty-cell">暂无任务</td></tr>');
        const pager = document.getElementById('pdf-job-pagination');
        if (pager && typeof window.Pivot.legacy.renderWorkspacePagination === 'function') window.Pivot.legacy.renderWorkspacePagination(pager, { total: state.total, page: state.page, limit: state.limit, onPageChange: next => { state.page = Math.max(Number(next) || 1, 1); loadJobs({ keepActive: false }).catch(error => toast(error.message, 'error')); } });
    }

    function detailActions(detail) {
        const allowed = detail?.job?.allowedActions || {};
        const jobId = detail?.job?.id;
        if (!jobId) return '';
        return [
            allowed.download && (detail.outputs || []).length ? `<button class="btn-secondary" type="button" data-pdf-job-download="${esc(jobId)}">下载结果</button>` : '',
            allowed.retry ? `<button class="btn-secondary" type="button" data-pdf-job-retry="${esc(jobId)}">重试</button>` : '',
            allowed.reprocess ? `<button class="btn-secondary" type="button" data-pdf-job-reprocess="${esc(jobId)}">再次处理</button>` : '',
            allowed.cancel ? `<button class="btn-secondary" type="button" data-pdf-job-cancel="${esc(jobId)}">取消</button>` : '',
            allowed.delete ? `<button class="btn-danger-outline" type="button" data-pdf-job-delete="${esc(jobId)}">删除</button>` : ''
        ].filter(Boolean).join('');
    }

    function renderPreflight(preflight) {
        if (!preflight) return '';
        const files = (preflight.files || []).map(file => `<li><strong>${esc(file.originalName || '文件')}</strong>：${Number(file.pageCount || 0)} 页${(file.warnings || []).length ? `；${esc((file.warnings || []).join('；'))}` : ''}</li>`).join('');
        return `<section class="pdf-detail-section"><h4>文件预检</h4><p>共 ${Number(preflight.totalPages || 0)} 页，处理模式：${preflight.mode === 'batch' ? '批量分别处理' : '单次处理'}。</p>${files ? `<ul class="pdf-detail-list">${files}</ul>` : '<p>暂无可用预检信息。</p>'}</section>`;
    }

    function renderOutputs(outputs) {
        if (!outputs?.length) return '<p class="doc-tool-empty-small">暂无可下载输出。</p>';
        return `<div class="pdf-output-list">${outputs.map(output => `<div class="pdf-output-item"><button class="btn-secondary doc-tool-output-btn" type="button" data-pdf-output-download="${esc(output.id)}" data-output-name="${esc(output.fileName || '')}">${esc(output.fileName || output.outputType || '输出文件')} · ${formatBytes(output.fileSize)}</button><div class="pdf-output-actions"><button class="btn-secondary doc-tool-row-action" type="button" data-pdf-output-dispatch="${esc(output.id)}" data-pdf-dispatch-target="knowledge">发送到知识库</button><button class="btn-secondary doc-tool-row-action" type="button" data-pdf-output-dispatch="${esc(output.id)}" data-pdf-dispatch-target="regulations">发送到法规导入</button></div></div>`).join('')}</div>`;
    }

    function renderPages(detail) {
        const pages = detail?.pages || [];
        if (!pages.length) return '';
        return `<section class="pdf-detail-section"><h4>页面与 OCR 复核</h4><div class="pdf-page-grid">${pages.map(page => `<button class="btn-secondary pdf-page-card" type="button" data-pdf-page-preview="${esc(page.id)}"><img src="${API}/pages/${encodeURIComponent(page.id)}/image" alt="第 ${Number(page.pageNumber || 1)} 页预览" loading="lazy"><span>第 ${Number(page.pageNumber || 1)} 页${page.confidence === null ? '' : ` · ${Math.round(Number(page.confidence || 0) * 100)}%`}</span></button>`).join('')}</div></section>`;
    }

    function previewPage(pageId) {
        const image = document.getElementById('pdf-page-preview-image');
        const panel = document.getElementById('pdf-page-preview-panel');
        if (!image || !panel) return;
        image.src = `${API}/pages/${encodeURIComponent(pageId)}/image`;
        panel.classList.remove('hidden');
        image.focus?.();
    }

    function renderBatchItems(items) {
        if (!items?.length) return '';
        return `<section class="pdf-detail-section"><h4>批量结果</h4><ul class="pdf-detail-list">${items.map(item => `<li><strong>${esc(item.originalName || '文件')}</strong>：${esc(statusLabel(item.status))}${item.errorMessage ? `；${esc(item.errorMessage)}` : ''}</li>`).join('')}</ul></section>`;
    }

    function renderDetail() {
        const box = document.getElementById('pdf-detail');
        const title = document.getElementById('pdf-detail-title');
        const subtitle = document.getElementById('pdf-detail-subtitle');
        if (!box || !title || !subtitle) return;
        const detail = state.detail;
        if (!detail?.job) {
            title.textContent = 'PDF 处理详情'; subtitle.textContent = '选择任务查看摘要、页面和输出文件。'; html.setHtml(box, '<div class="doc-tool-empty-detail">请选择一个 PDF 任务。</div>'); return;
        }
        const result = detail.job.result || {};
        title.textContent = detail.file?.originalName || `任务 ${detail.job.id}`;
        subtitle.textContent = `${operationLabel(detail.job.config?.operation)} · ${statusLabel(detail.job.status)} · ${Number(detail.job.progress || 0)}%`;
        const metrics = [['请求页', result.requestedPages], ['已处理页', result.processedPages], ['成功文件', result.processedFiles], ['失败文件', result.failedFiles], ['输出', (detail.outputs || []).length]].filter(([, value]) => value !== undefined && value !== null && value !== 0);
        html.setHtml(box, `<section class="pdf-detail-head"><div><span class="doc-tool-badge ${statusTone(detail.job.status)}">${statusLabel(detail.job.status)}</span>${detail.job.errorMessage ? `<em>${esc(detail.job.errorMessage)}</em>` : ''}</div><div class="pdf-detail-actions">${detailActions(detail)}</div></section><div class="pdf-result-grid">${metrics.map(([label, value]) => `<div><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`).join('')}</div>${renderPreflight(detail.preflight)}${renderBatchItems(detail.items?.length ? detail.items : result.items)}${renderPages(detail)}<section class="pdf-detail-section"><h4>输出文件</h4>${renderOutputs(detail.outputs || [])}</section>`);
    }

    function render() { renderJobs(); renderDetail(); }

    async function loadCapabilities() {
        state.capabilities = await requestJson(`${API}/capabilities`).catch(() => null);
        const select = document.getElementById('pdf-operation-select');
        if (select && state.capabilities?.operations) {
            const current = select.value;
            html.setHtml(select, renderOperationOptions());
            select.value = operations()[current] ? current : 'merge';
        }
        const presetSelect = document.getElementById('pdf-preset-select');
        if (presetSelect) html.setHtml(presetSelect, renderPresetOptions());
        syncOperationOptions();
    }

    async function loadJobs({ keepActive = true } = {}) {
        const query = new URLSearchParams({ page: String(state.page), limit: String(state.limit) });
        if (state.status) query.set('status', state.status);
        const data = await requestJson(`${API}/jobs?${query.toString()}`);
        state.jobs = Array.isArray(data.data) ? data.data : [];
        state.total = Number(data.total || 0);
        if (!keepActive || !state.jobs.some(item => String(item.id) === String(state.activeJobId))) { state.activeJobId = ''; state.detail = null; }
        renderJobs();
        if (state.activeJobId && isDetailOpen()) await loadDetail(state.activeJobId, { silent: true, show: false }); else renderDetail();
    }

    async function loadDetail(jobId, { silent = false, show = true } = {}) {
        const data = await requestJson(`${API}/jobs/${encodeURIComponent(jobId)}`);
        state.detail = data;
        state.activeJobId = String(data.job?.id || jobId);
        render();
        if (show) openDetail();
        if (!silent) toast('任务详情已更新', 'success');
        return data;
    }

    function appendFormValue(data, id, name) {
        const element = document.getElementById(id);
        if (!element) return;
        if (element.type === 'checkbox') data.set(name, element.checked ? 'true' : 'false'); else data.set(name, element.value || '');
    }

    async function submitJob(form) {
        const files = Array.from(document.getElementById('pdf-files-input')?.files || []);
        if (!files.length) { toast('请选择需要处理的文件。', 'warning'); return; }
        const data = new FormData();
        files.forEach(file => data.append('files', file));
        data.set('operation', currentOperation());
        data.set('mode', document.getElementById('pdf-mode-input')?.value || 'single');
        [
            ['pdf-pages-input', 'pages'], ['pdf-order-input', 'pageOrder'], ['pdf-rotate-input', 'rotateDegrees'], ['pdf-dpi-input', 'dpi'], ['pdf-max-pages-input', 'maxToolPages'], ['pdf-password-input', 'password'], ['pdf-watermark-text', 'watermarkText'], ['pdf-watermark-position', 'watermarkPosition'], ['pdf-watermark-opacity', 'watermarkOpacity'], ['pdf-page-number-start', 'pageNumberStart'], ['pdf-page-number-position', 'pageNumberPosition'], ['pdf-skip-cover', 'skipCover'], ['pdf-crop-left', 'cropLeft'], ['pdf-crop-right', 'cropRight'], ['pdf-crop-top', 'cropTop'], ['pdf-crop-bottom', 'cropBottom'], ['pdf-blank-after', 'blankPageAfter'], ['pdf-blank-count', 'blankPageCount'], ['pdf-page-size', 'pageSize'], ['pdf-image-fit', 'imageFit']
        ].forEach(([id, name]) => appendFormValue(data, id, name));
        const button = document.getElementById('pdf-submit-btn');
        const label = button?.textContent;
        if (button) { button.disabled = true; button.textContent = '正在创建'; }
        try {
            const created = await requestJson(`${API}/jobs`, { method: 'POST', body: data });
            state.activeJobId = String(created.job?.id || '');
            form.reset();
            syncOperationOptions();
            toast('PDF 任务已创建，系统将校验页数和输出完整性。', 'success');
            await loadJobs({ keepActive: true });
        } finally { if (button) { button.disabled = false; button.textContent = label || '创建任务'; } }
    }

    async function downloadOutput(outputId, filename = '') {
        const response = await apiFetch(`${API}/outputs/${encodeURIComponent(outputId)}/download`);
        if (!response.ok) { const data = await response.clone().json().catch(() => ({})); throw new Error(data?.error || `下载失败（${response.status}）`); }
        const url = URL.createObjectURL(await response.blob());
        const link = document.createElement('a'); link.href = url; link.download = filename || `pdf-output-${outputId}`; document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(url);
    }

    async function downloadJobOutputs(jobId) {
        const detail = state.detail?.job?.id === Number(jobId) ? state.detail : await loadDetail(jobId, { silent: true, show: false });
        const outputs = detail?.outputs || [];
        if (!outputs.length) { toast('该任务暂无可下载输出。', 'warning'); return; }
        if (outputs.length === 1) return downloadOutput(outputs[0].id, outputs[0].fileName);
        const response = await apiFetch(`${API}/jobs/${encodeURIComponent(jobId)}/outputs/download`);
        if (!response.ok) { const data = await response.clone().json().catch(() => ({})); throw new Error(data?.error || `下载失败（${response.status}）`); }
        const url = URL.createObjectURL(await response.blob());
        const link = document.createElement('a'); link.href = url; link.download = `pdf-job-${jobId}-全部输出.zip`; document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(url);
    }

    async function confirmAction(title, message) {
        if (typeof window.Pivot?.legacy?.showConfirm === 'function') return window.Pivot.legacy.showConfirm(title, message);
        return false;
    }

    async function retryJob(jobId) { await requestJson(`${API}/jobs/${encodeURIComponent(jobId)}/retry`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); toast('任务已重新排队。', 'success'); await loadJobs({ keepActive: true }); }
    async function reprocessJob(jobId) { if (!await confirmAction('再次处理 PDF', '将创建一个新的处理版本，当前结果会保留。确定继续吗？')) return; await requestJson(`${API}/jobs/${encodeURIComponent(jobId)}/reprocess`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); toast('已创建新的处理版本。', 'success'); await loadJobs({ keepActive: false }); }
    async function cancelJob(jobId) { if (!await confirmAction('取消 PDF 任务', '系统会停止后续步骤并清理尚未发布的结果。确定取消吗？')) return; await requestJson(`${API}/jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' }); toast('已请求取消任务。'); await loadJobs({ keepActive: true }); }
    async function deleteJob(jobId) { if (!await confirmAction('删除 PDF 任务', '将删除该任务及其不再被引用的文件，此操作不可恢复。确定删除吗？')) return; await requestJson(`${API}/jobs/${encodeURIComponent(jobId)}`, { method: 'DELETE' }); if (String(state.activeJobId) === String(jobId)) { state.activeJobId = ''; state.detail = null; closeDetail(); } toast('PDF 任务已删除。', 'success'); await loadJobs({ keepActive: false }); }
    async function dispatchOutput(outputId, target) {
        const targetLabel = target === 'regulations' ? '法规导入' : '知识库';
        const message = target === 'regulations'
            ? '将把该 PDF 作为待审核材料发送到法规导入。导入后仍需人工确认文本、来源和效力信息。确定继续吗？'
            : '将把该 PDF 发送到知识库，并按知识库规则继续索引。确定继续吗？';
        if (!await confirmAction(`发送到${targetLabel}`, message)) return;
        const dispatch = await requestJson(`${API}/jobs/${encodeURIComponent(state.activeJobId)}/dispatch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ outputId, target }) });
        toast(`已发送到${targetLabel}。`, 'success');
        return dispatch;
    }

    function bindEvents(view) {
        if (view.dataset.bound === '1') return;
        view.dataset.bound = '1';
        view.addEventListener('submit', event => { if (event.target?.id === 'pdf-tools-form') { event.preventDefault(); submitJob(event.target).catch(error => toast(error.message || '创建任务失败。', 'error')); } });
        view.addEventListener('change', event => {
            if (event.target?.id === 'pdf-operation-select') syncOperationOptions();
            if (event.target?.id === 'pdf-preset-select') applyPreset(event.target.value);
            if (event.target?.id === 'pdf-status-filter') { state.status = event.target.value; state.page = 1; loadJobs({ keepActive: false }).catch(error => toast(error.message, 'error')); }
        });
        view.addEventListener('click', event => {
            const closest = selector => event.target.closest(selector);
            const open = closest('[data-pdf-job-open]'); if (open) return void loadDetail(open.dataset.pdfJobOpen).catch(error => toast(error.message, 'error'));
            if (closest('[data-pdf-close-detail]')) return void closeDetail();
            if (closest('[data-pdf-close-preview]')) return void document.getElementById('pdf-page-preview-panel')?.classList.add('hidden');
            if (closest('#pdf-refresh-btn')) return void loadJobs({ keepActive: true }).catch(error => toast(error.message, 'error'));
            const output = closest('[data-pdf-output-download]'); if (output) return void downloadOutput(output.dataset.pdfOutputDownload, output.dataset.outputName).catch(error => toast(error.message, 'error'));
            const dispatch = closest('[data-pdf-output-dispatch]'); if (dispatch) return void dispatchOutput(dispatch.dataset.pdfOutputDispatch, dispatch.dataset.pdfDispatchTarget).catch(error => toast(error.message, 'error'));
            const download = closest('[data-pdf-job-download]'); if (download) return void downloadJobOutputs(download.dataset.pdfJobDownload).catch(error => toast(error.message, 'error'));
            const retry = closest('[data-pdf-job-retry]'); if (retry) return void retryJob(retry.dataset.pdfJobRetry).catch(error => toast(error.message, 'error'));
            const reprocess = closest('[data-pdf-job-reprocess]'); if (reprocess) return void reprocessJob(reprocess.dataset.pdfJobReprocess).catch(error => toast(error.message, 'error'));
            const cancel = closest('[data-pdf-job-cancel]'); if (cancel) return void cancelJob(cancel.dataset.pdfJobCancel).catch(error => toast(error.message, 'error'));
            const remove = closest('[data-pdf-job-delete]'); if (remove) return void deleteJob(remove.dataset.pdfJobDelete).catch(error => toast(error.message, 'error'));
            const pagePreview = closest('[data-pdf-page-preview]'); if (pagePreview) return void previewPage(pagePreview.dataset.pdfPagePreview);
        });
    }

    function startPolling() {
        if (state.timer) return;
        state.timer = window.setInterval(async () => {
            if (state.polling || document.hidden || window.Pivot.legacy.getAppsSessionValue?.('pivot_apps_active_app') !== 'pdf-tools') return;
            if (!state.jobs.some(job => ['queued', 'processing'].includes(job.status))) return;
            state.polling = true;
            try { await loadJobs({ keepActive: true }); } catch (_error) {} finally { state.polling = false; }
        }, 4000);
    }

    async function showPdfToolsApp() {
        const view = ensureView();
        window.Pivot.legacy.PivotDataAnalysis?.resetAiWorkspace?.();
        window.Pivot.legacy.setAppsSessionValue?.('pivot_apps_active_app', 'pdf-tools');
        ['apps-home-view', 'official-writing-view', 'data-analysis-view', 'regulations-view', 'ocr-view'].forEach(id => document.getElementById(id)?.classList.add('hidden'));
        view.classList.remove('hidden');
        document.getElementById('apps-back-btn')?.classList.remove('hidden');
        if (typeof setAppsTitle === 'function') setAppsTitle('PDF 工具', '在受控工作区中整理页面、数字化扫描件、生成交付文件并追溯每次处理。');
        await loadCapabilities();
        render();
        startPolling();
        await loadJobs({ keepActive: true });
    }

    window.Pivot.legacy.PivotPdfTools = { ready: true, state, showPdfToolsApp, loadJobs, loadDetail };
    window.Pivot.legacy.showPdfToolsApp = showPdfToolsApp;
})();
