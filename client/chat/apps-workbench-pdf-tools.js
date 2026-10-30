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
        polling: false,
        activePresetId: '',
        pagePlan: [],
        pagePlanHistory: [],
        pagePlanFuture: []
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
        compress: { label: '优化 PDF', inputMode: 'single-or-batch', supportsCompression: true },
        protect: { label: '加密保护 PDF', inputMode: 'single', supportsProtection: true },
        compare: { label: '比较两个 PDF', inputMode: 'exact-two', supportsCompare: true },
        redact: { label: '永久脱敏（栅格化）', inputMode: 'single-or-batch', supportsRedaction: true },
        fill_form: { label: '填写 PDF 表单', inputMode: 'single-or-batch', supportsFormFill: true },
        annotate: { label: '添加轻批注', inputMode: 'single-or-batch', supportsAnnotations: true },
        pdfa_validate: { label: '验证 PDF/A', inputMode: 'single', supportsPdfa: true },
        export_docx: { label: '导出可复核 Word', inputMode: 'single-or-batch', supportsDocxExport: true },
        export_xlsx: { label: '导出可复核 Excel', inputMode: 'single-or-batch', supportsXlsxExport: true },
        page_plan: { label: '页面工作区编排', inputMode: 'single', supportsPagePlan: true }
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
        return Object.entries(operations()).map(([id, meta]) => `<option value="${esc(id)}" ${meta.available === false ? 'disabled' : ''}>${esc(meta.label || id)}${meta.available === false ? '（当前部署不可用）' : ''}</option>`).join('');
    }

    function availablePresets() {
        return (state.capabilities?.presets || []).filter(item => {
            const meta = operations()[item?.operation];
            return item?.id && meta && meta.available !== false;
        });
    }

    function renderQuickPresetButtons() {
        const presets = availablePresets();
        if (!presets.length) return '<span class="pdf-quick-preset-empty">暂无可用快速方案</span>';
        return presets.map(item => {
            const active = String(state.activePresetId) === String(item.id);
            const operationName = operationLabel(item.operation);
            return `<button type="button" class="btn-secondary pdf-quick-preset${active ? ' is-active' : ''}" data-pdf-quick-preset="${esc(item.id)}" aria-pressed="${active ? 'true' : 'false'}" title="填入${esc(operationName)}的推荐参数">${esc(item.label)}</button>`;
        }).join('');
    }

    function renderQuickPresets() {
        const target = document.getElementById('pdf-quick-presets');
        if (target) html.setHtml(target, renderQuickPresetButtons());
    }

    function clearActivePreset() {
        if (!state.activePresetId) return;
        state.activePresetId = '';
        renderQuickPresets();
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
                    <form id="pdf-tools-form" class="doc-tool-form" novalidate>
                        <label class="doc-tool-field doc-tool-field-wide"><span>处理方式</span><select id="pdf-operation-select" class="form-input" name="operation">${renderOperationOptions()}</select></label>
                        <section class="pdf-quick-presets" aria-labelledby="pdf-quick-presets-title"><div class="pdf-quick-presets-head"><div><strong id="pdf-quick-presets-title">快速方案 <span>可选</span></strong><small>一键填入常用处理方式与推荐参数，之后仍可自行调整。</small></div></div><div id="pdf-quick-presets" class="pdf-quick-presets-list" role="group" aria-label="PDF 快速方案">正在读取可用方案…</div></section>
                        <label class="doc-tool-field doc-tool-field-wide"><span>文件</span><input id="pdf-files-input" class="form-input" type="file" name="files" accept=".pdf,.png,.jpg,.jpeg,.webp,.bmp" multiple><small id="pdf-file-hint" class="pdf-tool-hint">合并与图片转 PDF 可组合多个文件；其它操作默认单文件。</small></label>
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
                        <div class="doc-tool-field-row hidden" data-pdf-option="compression"><label class="doc-tool-field"><span>优化方式</span><select id="pdf-compression-mode" class="form-input"><option value="structure">结构无损优化</option><option value="images">嵌入图片 JPEG 优化</option></select></label><label class="doc-tool-field"><span>JPEG 质量</span><input id="pdf-compression-jpeg-quality" class="form-input" type="number" min="1" max="100" value="75"></label><small class="pdf-tool-hint">图像优化只重写可安全优化的嵌入图像；不会把整页截图作为默认压缩方式。系统会展示实际前后体积。</small></div>
                        <div class="doc-tool-field-row hidden" data-pdf-option="protection"><label class="doc-tool-field"><span>打开密码</span><input id="pdf-output-password" class="form-input" type="password" autocomplete="new-password"></label><label class="doc-tool-field"><span>管理密码</span><input id="pdf-owner-password" class="form-input" type="password" autocomplete="new-password"></label><label class="doc-tool-field pdf-tool-checkbox"><input id="pdf-protect-print" type="checkbox" checked><span>允许打印</span></label><label class="doc-tool-field pdf-tool-checkbox"><input id="pdf-protect-modify" type="checkbox" checked><span>允许修改</span></label><small class="pdf-tool-hint">密码只在任务执行期保存在加密临时存储中，不出现在任务详情或日志。</small></div>
                        <div class="doc-tool-field-row hidden" data-pdf-option="compare"><label class="doc-tool-field"><span>比较分辨率</span><input id="pdf-compare-dpi" class="form-input" type="number" min="72" max="300" value="144"></label><small class="pdf-tool-hint">请选择两份 PDF。输出包含逐页视觉差异图与可复核 JSON 报告。</small></div>
                        <label class="doc-tool-field doc-tool-field-wide hidden" data-pdf-option="redaction"><span>永久脱敏区域（JSON）</span><textarea id="pdf-redact-regions" class="form-input" rows="3" placeholder='[{"page":1,"x":0.1,"y":0.1,"width":0.3,"height":0.08,"label":"身份证号"}]'></textarea><small class="pdf-tool-hint">坐标为页面左上角起的 0-1 比例。结果会生成栅格化副本，移除原文、表单、批注、附件和签名；请先核对区域。</small></label>
                        <label class="doc-tool-field doc-tool-field-wide hidden" data-pdf-option="annotations"><span>轻批注（JSON）</span><textarea id="pdf-annotations" class="form-input" rows="3" placeholder='[{"page":1,"type":"highlight","x":0.1,"y":0.1,"width":0.3,"height":0.06,"content":"请复核"}]'></textarea><small class="pdf-tool-hint">支持 highlight 和 note；坐标为页面左上角起的 0-1 比例。</small></label>
                        <label class="doc-tool-field doc-tool-field-wide hidden" data-pdf-option="form"><span>表单字段值（JSON）</span><textarea id="pdf-form-values" class="form-input" rows="3" placeholder='{"申请人":"张三","确认":true}'></textarea><small class="pdf-tool-hint">字段名必须与原 AcroForm 字段一致；保留交互表单，不自动扁平化。</small></label>
                        <div class="doc-tool-field-row hidden" data-pdf-option="pdfa"><label class="doc-tool-field"><span>验证 profile</span><select id="pdf-pdfa-profile" class="form-input"><option value="0">自动识别</option><option value="1b">PDF/A-1b</option><option value="2b">PDF/A-2b</option><option value="3b">PDF/A-3b</option><option value="4">PDF/A-4</option></select></label><small class="pdf-tool-hint">只生成 veraPDF 验证报告；没有通过验证绝不标记为 PDF/A 合规。</small></div>
                        <label class="doc-tool-field doc-tool-field-wide hidden" data-pdf-option="page-plan"><span>页面编排（JSON）</span><textarea id="pdf-page-plan" class="form-input" rows="3" placeholder='[{"sourcePage":2,"rotation":0},{"sourcePage":1,"rotation":90},{"blank":true}]'></textarea><small class="pdf-tool-hint">可用源页重排、旋转或插入空白页。执行会创建新版本，原件保持不变。</small></label>
                        <label class="doc-tool-field doc-tool-field-wide"><span>PDF 密码</span><input id="pdf-password-input" class="form-input" type="password" autocomplete="off"><small class="pdf-tool-hint">仅用于本次任务，处理结束后会被删除。加密 PDF 需要部署 qpdf；请在提交前确认已有处理授权。</small></label>
                        <div class="doc-tool-actions"><button id="pdf-submit-btn" class="btn-primary" type="submit">创建任务</button></div>
                    </form>
                </aside>
                <main class="workspace-panel doc-tool-main pdf-tools-main">
                    <div class="workspace-toolbar doc-tool-toolbar pdf-tools-toolbar">
                        <div class="doc-tool-toolbar-title">
                            <div class="pdf-toolbar-heading">
                                <h4>PDF 处理任务</h4>
                                <span id="pdf-list-summary" class="pdf-list-summary-tag">0 个任务</span>
                            </div>
                            <span id="pdf-capability-summary" class="pdf-capability-summary"></span>
                        </div>
                        <div class="pdf-toolbar-actions">
                            <div class="pdf-filter-pill-control">
                                <label class="pdf-filter-pill-prefix" for="pdf-status-filter">
                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                                        <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"></polygon>
                                    </svg>
                                    <span>状态</span>
                                </label>
                                <div class="pdf-filter-pill-body">
                                    <select id="pdf-status-filter" class="form-input pdf-filter-pill-select" aria-label="按状态筛选">
                                        <option value="">全部</option>
                                        <option value="queued">排队中</option>
                                        <option value="processing">处理中</option>
                                        <option value="succeeded">已完成</option>
                                        <option value="partial_success">部分完成</option>
                                        <option value="needs_review">待复核</option>
                                        <option value="failed">失败</option>
                                        <option value="cancelled">已取消</option>
                                    </select>
                                    <span class="pdf-filter-pill-arrow" aria-hidden="true">
                                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                                            <polyline points="6 9 12 15 18 9"></polyline>
                                        </svg>
                                    </span>
                                </div>
                            </div>
                            <button id="pdf-refresh-btn" class="btn-secondary pdf-toolbar-refresh-btn" type="button" title="刷新任务列表">
                                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                                    <polyline points="1 4 1 10 7 10"></polyline>
                                    <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path>
                                </svg>
                                <span>刷新</span>
                            </button>
                        </div>
                    </div>
                    <div class="table-container workspace-table-wrap doc-tool-table-wrap">
                        <table class="data-table compact-table doc-tool-table pdf-job-table">
                            <thead><tr><th class="text-center">序号</th><th>文件</th><th>处理方式</th><th class="text-center">状态</th><th class="text-center">进度</th><th>更新时间</th><th class="text-center">操作</th></tr></thead>
                            <tbody id="pdf-job-table-body"></tbody>
                        </table>
                    </div>
                    <div id="pdf-job-pagination" class="pagination workspace-pagination"></div>
                </main>
            </div>
            <section id="pdf-detail-panel" class="doc-tool-detail-panel hidden" role="dialog" aria-modal="true" aria-labelledby="pdf-detail-title"><div class="workspace-modal doc-tool-dialog pdf-detail-dialog"><div class="workspace-modal-header"><div><h3 id="pdf-detail-title">PDF 处理详情</h3><p id="pdf-detail-subtitle">查看任务摘要、页面和输出文件。</p></div><button class="btn-secondary workspace-modal-close" type="button" data-pdf-close-detail>关闭</button></div><div id="pdf-detail" class="workspace-modal-body doc-tool-modal-body pdf-detail"></div></div></section>
            <section id="pdf-page-preview-panel" class="doc-tool-detail-panel hidden" role="dialog" aria-modal="true" aria-labelledby="pdf-page-preview-title"><div class="workspace-modal doc-tool-dialog pdf-page-preview-dialog"><div class="workspace-modal-header"><div><h3 id="pdf-page-preview-title">PDF 页面预览</h3><p>预览来自受控页面资源，可返回任务详情继续处理。</p></div><button class="btn-secondary workspace-modal-close" type="button" data-pdf-close-preview>返回详情</button></div><div class="workspace-modal-body pdf-page-preview-body"><img id="pdf-page-preview-image" alt="PDF 页面预览"></div></div></section>
            <section id="pdf-page-plan-panel" class="doc-tool-detail-panel hidden" role="dialog" aria-modal="true" aria-labelledby="pdf-page-plan-title"><div class="workspace-modal doc-tool-dialog pdf-page-plan-dialog"><div class="workspace-modal-header"><div><h3 id="pdf-page-plan-title">页面工作区</h3><p id="pdf-page-plan-summary">拖动前请先用前移、后移、旋转或插入空白页调整草稿。</p></div><button class="btn-secondary workspace-modal-close" type="button" data-pdf-close-page-plan>关闭</button></div><div class="workspace-modal-body pdf-page-plan-body"><div class="pdf-page-plan-actions"><button class="btn-secondary" type="button" data-pdf-plan-undo>撤销</button><button class="btn-secondary" type="button" data-pdf-plan-redo>重做</button><button class="btn-secondary" type="button" data-pdf-plan-blank>末尾插入空白页</button><button class="btn-primary" type="button" data-pdf-plan-apply>创建页面编排版本</button></div><div id="pdf-page-plan-list" class="pdf-page-plan-list"></div><p class="pdf-tool-hint">最多保留 20 步草稿历史。提交会以原始输入创建新版本；不覆盖旧结果或原件。</p></div></div></section>
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
        show('compression', Boolean(meta.supportsCompression));
        show('protection', Boolean(meta.supportsProtection));
        show('compare', Boolean(meta.supportsCompare));
        show('redaction', Boolean(meta.supportsRedaction));
        show('annotations', Boolean(meta.supportsAnnotations));
        show('form', Boolean(meta.supportsFormFill));
        show('pdfa', Boolean(meta.supportsPdfa));
        show('page-plan', Boolean(meta.supportsPagePlan));
        const hint = document.getElementById('pdf-file-hint');
        if (hint) hint.textContent = meta.available === false
            ? (meta.unavailableReason || `${meta.label}在当前部署不可用。`)
            : (meta.inputMode === 'combine' ? `${meta.label}需要组合多个文件，文件顺序将决定输出顺序。` : (meta.inputMode === 'exact-two' ? `${meta.label}需要且只能选择两份 PDF。` : (meta.inputMode === 'single' ? `${meta.label}一次只能处理一个文件。` : '默认一次处理一个文件；选择批量后会分别生成每个文件的结果。')));
    }

    function applyPreset(presetId) {
        const preset = availablePresets().find(item => item.id === presetId);
        if (!preset) return;
        if (String(state.activePresetId) === String(preset.id)) {
            // 再次点击当前方案即转为“自定义”：保留已经填入的值，只取消方案标记。
            state.activePresetId = '';
            renderQuickPresets();
            return;
        }
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
        state.activePresetId = preset.id;
        renderQuickPresets();
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

    function getFileFormatBadge(filename) {
        const ext = String(filename || '').split('.').pop().toLowerCase();
        if (['doc', 'docx'].includes(ext)) return { text: 'DOCX', type: 'docx' };
        if (['xls', 'xlsx', 'csv'].includes(ext)) return { text: 'XLSX', type: 'xlsx' };
        if (ext === 'pdf') return { text: 'PDF', type: 'pdf' };
        if (['zip', 'rar', 'tar', 'gz', '7z'].includes(ext)) return { text: 'ZIP', type: 'zip' };
        if (['png', 'jpg', 'jpeg', 'webp', 'bmp'].includes(ext)) return { text: 'IMG', type: 'img' };
        return { text: ext ? ext.toUpperCase().slice(0, 4) : 'FILE', type: 'file' };
    }

    function detailActions(detail) {
        const allowed = detail?.job?.allowedActions || {};
        const jobId = detail?.job?.id;
        if (!jobId) return '';
        const outputs = detail.outputs || [];
        return [
            allowed.download && outputs.length > 1 ? `<button class="btn-primary" type="button" data-pdf-job-download="${esc(jobId)}">下载全部结果</button>` : '',
            allowed.retry ? `<button class="btn-secondary" type="button" data-pdf-job-retry="${esc(jobId)}">重试</button>` : '',
            allowed.reprocess ? `<button class="btn-secondary" type="button" data-pdf-job-reprocess="${esc(jobId)}">再次处理</button>` : '',
            allowed.cancel ? `<button class="btn-secondary" type="button" data-pdf-job-cancel="${esc(jobId)}">取消</button>` : '',
            allowed.delete ? `<button class="btn-danger-outline" type="button" data-pdf-job-delete="${esc(jobId)}">删除</button>` : ''
        ].filter(Boolean).join('');
    }

    function renderPreflight(preflight) {
        if (!preflight) return '';
        const files = (preflight.files || []).map(file => {
            const warnings = (file.warnings || []).map(w => `<span class="pdf-preflight-warning-pill">${esc(w)}</span>`).join('');
            return `
                <div class="pdf-preflight-row">
                    <div class="pdf-preflight-row-main">
                        <span class="pdf-preflight-file-icon">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>
                        </span>
                        <strong class="pdf-preflight-filename" title="${esc(file.originalName || '文件')}">${esc(file.originalName || '文件')}</strong>
                    </div>
                    <div class="pdf-preflight-row-meta">
                        <span class="pdf-preflight-page-pill">${Number(file.pageCount || 0)} 页</span>
                        ${warnings}
                    </div>
                </div>
            `;
        }).join('');
        return `
            <section class="pdf-detail-section pdf-preflight-section">
                <div class="pdf-section-head">
                    <h4 class="pdf-section-title">
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>
                        <span>文件预检</span>
                    </h4>
                    <span class="pdf-section-tag">共 ${Number(preflight.totalPages || 0)} 页 · ${preflight.mode === 'batch' ? '批量分别处理' : '单次处理'}</span>
                </div>
                ${files ? `<div class="pdf-preflight-list">${files}</div>` : '<div class="pdf-detail-empty-card">暂无可用预检信息。</div>'}
            </section>
        `;
    }

    function renderOutputs(outputs) {
        if (!outputs?.length) return '<div class="pdf-detail-empty-card">暂无可下载输出。</div>';
        return `
            <div class="pdf-output-card-list">
                ${outputs.map(output => {
                    const name = output.fileName || output.outputType || '输出文件';
                    const badge = getFileFormatBadge(name);
                    return `
                        <div class="pdf-output-card">
                            <div class="pdf-output-card-main">
                                <span class="pdf-file-format-badge is-${badge.type}">${badge.text}</span>
                                <div class="pdf-output-info">
                                    <strong class="pdf-output-name" title="${esc(name)}">${esc(name)}</strong>
                                    <div class="pdf-output-meta">
                                        <span class="pdf-output-size">${formatBytes(output.fileSize)}</span>
                                        ${output.outputType ? `<span class="pdf-output-kind">${esc(output.outputType)}</span>` : ''}
                                    </div>
                                </div>
                            </div>
                            <div class="pdf-output-card-actions">
                                <button class="btn-primary pdf-output-dl-btn" type="button" data-pdf-output-download="${esc(output.id)}" data-output-name="${esc(name)}" title="下载此文件">
                                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
                                    <span>下载文件</span>
                                </button>
                                <div class="pdf-output-dispatch-btns">
                                    <button class="btn-secondary pdf-output-dispatch-btn" type="button" data-pdf-output-dispatch="${esc(output.id)}" data-pdf-dispatch-target="knowledge" title="流转到知识库">
                                        <span>发送到知识库</span>
                                    </button>
                                    <button class="btn-secondary pdf-output-dispatch-btn" type="button" data-pdf-output-dispatch="${esc(output.id)}" data-pdf-dispatch-target="regulations" title="流转到法规导入">
                                        <span>发送到法规导入</span>
                                    </button>
                                </div>
                            </div>
                        </div>
                    `;
                }).join('')}
            </div>
        `;
    }

    function renderPages(detail) {
        const pages = detail?.pages || [];
        if (!pages.length) return '';
        return `
            <section class="pdf-detail-section pdf-pages-section">
                <div class="pdf-section-head">
                    <h4 class="pdf-section-title">
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>
                        <span>页面与 OCR 复核</span>
                    </h4>
                    <button class="btn-secondary doc-tool-row-action pdf-pages-plan-btn" type="button" data-pdf-open-page-plan>
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"></line><line x1="8" y1="12" x2="21" y2="12"></line><line x1="8" y1="18" x2="21" y2="18"></line><line x1="3" y1="6" x2="3.01" y2="6"></line><line x1="3" y1="12" x2="3.01" y2="12"></line><line x1="3" y1="18" x2="3.01" y2="18"></line></svg>
                        <span>打开页面工作区</span>
                    </button>
                </div>
                <div class="pdf-page-grid">
                    ${pages.map(page => `
                        <button class="pdf-page-card" type="button" data-pdf-page-preview="${esc(page.id)}" title="点击放大预览第 ${Number(page.pageNumber || 1)} 页">
                            <div class="pdf-page-card-thumb">
                                <img src="${API}/pages/${encodeURIComponent(page.id)}/image" alt="第 ${Number(page.pageNumber || 1)} 页预览" loading="lazy">
                                <span class="pdf-page-zoom-hint">
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line><line x1="11" y1="8" x2="11" y2="14"></line><line x1="8" y1="11" x2="14" y2="11"></line></svg>
                                </span>
                            </div>
                            <div class="pdf-page-card-footer">
                                <span class="pdf-page-num">第 ${Number(page.pageNumber || 1)} 页</span>
                                ${page.confidence === null ? '' : `<span class="pdf-page-conf">${Math.round(Number(page.confidence || 0) * 100)}%</span>`}
                            </div>
                        </button>
                    `).join('')}
                </div>
            </section>
        `;
    }

    function previewPage(pageId) {
        const image = document.getElementById('pdf-page-preview-image');
        const panel = document.getElementById('pdf-page-preview-panel');
        if (!image || !panel) return;
        image.src = `${API}/pages/${encodeURIComponent(pageId)}/image`;
        panel.classList.remove('hidden');
        image.focus?.();
    }

    function clonePagePlan(plan) { return JSON.parse(JSON.stringify(Array.isArray(plan) ? plan : [])); }
    function planSourcePages() { return (state.detail?.pages || []).map(page => ({ sourcePage: Number(page.pageNumber || 0), rotation: 0, pageId: page.id, blank: false })).filter(item => item.sourcePage > 0); }
    function rememberPagePlan() {
        state.pagePlanHistory.push(clonePagePlan(state.pagePlan));
        if (state.pagePlanHistory.length > 20) state.pagePlanHistory.shift();
        state.pagePlanFuture = [];
    }
    function updatePagePlan(mutator) {
        rememberPagePlan();
        mutator(state.pagePlan);
        renderPagePlan();
    }
    function pagePlanItemImage(item) {
        if (item.blank) return '<div class="pdf-page-plan-blank" aria-label="空白页">空白页</div>';
        return `<img src="${API}/pages/${encodeURIComponent(item.pageId || '')}/image" alt="源页 ${Number(item.sourcePage || 0)}" loading="lazy">`;
    }
    function renderPagePlan() {
        const list = document.getElementById('pdf-page-plan-list');
        const summary = document.getElementById('pdf-page-plan-summary');
        if (!list || !summary) return;
        const deleted = Math.max(planSourcePages().length - state.pagePlan.filter(item => !item.blank).length, 0);
        summary.textContent = `当前输出 ${state.pagePlan.length} 页；删除 ${deleted} 页；草稿可撤销 ${state.pagePlanHistory.length} 步。`;
        const planCardsHtml = state.pagePlan.map((item, index) => `<article class="pdf-page-plan-card" data-pdf-plan-index="${index}">${pagePlanItemImage(item)}<div class="pdf-page-plan-card-info"><strong>${item.blank ? '空白页' : `源页 ${Number(item.sourcePage || 0)}`}</strong><small>${item.blank ? '将使用相邻页面尺寸' : `旋转 ${Number(item.rotation || 0)}°`}</small></div><div class="pdf-page-plan-card-actions"><button class="btn-secondary" type="button" data-pdf-plan-move="up" data-pdf-plan-index="${index}" ${index === 0 ? 'disabled' : ''}>前移</button><button class="btn-secondary" type="button" data-pdf-plan-move="down" data-pdf-plan-index="${index}" ${index === state.pagePlan.length - 1 ? 'disabled' : ''}>后移</button>${item.blank ? '' : `<button class="btn-secondary" type="button" data-pdf-plan-rotate data-pdf-plan-index="${index}">旋转</button>`}<button class="btn-danger-outline" type="button" data-pdf-plan-delete data-pdf-plan-index="${index}">删除</button></div></article>`).join('');
        const emptyPlanHtml = '<p class="doc-tool-empty-small">草稿不能为空。请关闭后重新打开页面工作区。</p>';
        html.setHtml(list, planCardsHtml || emptyPlanHtml);
    }
    function openPagePlanEditor() {
        if (!(state.detail?.pages || []).length) { toast('当前任务没有可用页面预览；请先运行可生成页面预览的处理或重新上传。', 'warning'); return; }
        state.pagePlan = planSourcePages();
        state.pagePlanHistory = [];
        state.pagePlanFuture = [];
        renderPagePlan();
        document.getElementById('pdf-page-plan-panel')?.classList.remove('hidden');
    }
    async function applyPagePlan() {
        if (!state.activeJobId || !state.pagePlan.length) { toast('页面编排草稿不能为空。', 'warning'); return; }
        if (!await confirmAction('创建页面编排版本', '将以当前任务的原始输入创建一个新版本。原始文件和旧结果不会被修改。确定继续吗？')) return;
        await requestJson(`${API}/jobs/${encodeURIComponent(state.activeJobId)}/reprocess`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ config: { operation: 'page_plan', mode: 'single', pagePlan: state.pagePlan.map(({ sourcePage, rotation, blank }) => ({ sourcePage, rotation, blank })) } })
        });
        document.getElementById('pdf-page-plan-panel')?.classList.add('hidden');
        toast('已创建页面编排的新版本。', 'success');
        await loadJobs({ keepActive: false });
    }

    function renderBatchItems(items) {
        if (!items?.length) return '';
        return `
            <section class="pdf-detail-section pdf-batch-section">
                <div class="pdf-section-head">
                    <h4 class="pdf-section-title">
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="14" rx="2" ry="2"></rect><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"></path></svg>
                        <span>批量结果明细</span>
                    </h4>
                    <span class="pdf-section-tag">共 ${items.length} 个文件</span>
                </div>
                <div class="pdf-batch-list">
                    ${items.map(item => `
                        <div class="pdf-batch-row">
                            <div class="pdf-batch-row-main">
                                <strong class="pdf-batch-filename" title="${esc(item.originalName || '文件')}">${esc(item.originalName || '文件')}</strong>
                                <span class="doc-tool-badge ${statusTone(item.status)}">${esc(statusLabel(item.status))}</span>
                            </div>
                            ${item.errorMessage ? `<div class="pdf-batch-err-box">${esc(item.errorMessage)}</div>` : ''}
                        </div>
                    `).join('')}
                </div>
            </section>
        `;
    }

    function renderDetail() {
        const box = document.getElementById('pdf-detail');
        const title = document.getElementById('pdf-detail-title');
        const subtitle = document.getElementById('pdf-detail-subtitle');
        if (!box || !title || !subtitle) return;
        const detail = state.detail;
        if (!detail?.job) {
            title.textContent = 'PDF 处理详情';
            html.setHtml(subtitle, '选择任务查看摘要、页面和输出文件。');
            html.setHtml(box, '<div class="doc-tool-empty-detail">请选择一个 PDF 任务。</div>');
            return;
        }
        const result = detail.job.result || {};
        const fileName = detail.file?.originalName || `任务 ${detail.job.id}`;
        title.textContent = fileName;
        title.title = fileName;

        const opLabel = operationLabel(detail.job.config?.operation);
        const statLabel = statusLabel(detail.job.status);
        const progressVal = Number(detail.job.progress || 0);
        const timeLabel = formatTime(detail.job.updatedAt || detail.job.createdAt);
        html.setHtml(subtitle, `
            <span class="pdf-header-badge is-op">${esc(opLabel)}</span>
            <span class="pdf-header-badge ${statusTone(detail.job.status)}">${esc(statLabel)}</span>
            <span class="pdf-header-progress">进度 ${progressVal}%</span>
            <span class="pdf-sub-time">${esc(timeLabel)}</span>
        `);

        const metricConfigs = [
            { key: 'requestedPages', label: '请求页数', value: result.requestedPages, icon: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>' },
            { key: 'processedPages', label: '已处理页', value: result.processedPages, icon: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg>' },
            { key: 'processedFiles', label: '成功文件', value: result.processedFiles, icon: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>' },
            { key: 'failedFiles', label: '失败文件', value: result.failedFiles, icon: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>', isError: true },
            { key: 'outputs', label: '生成输出', value: (detail.outputs || []).length, icon: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="12" y1="8" x2="12" y2="16"></line><line x1="8" y1="12" x2="16" y2="12"></line></svg>' }
        ];
        const activeMetrics = metricConfigs.filter(m => m.value !== undefined && m.value !== null && m.value !== 0);

        const metricsHtml = activeMetrics.length ? `
            <div class="pdf-metric-grid">
                ${activeMetrics.map(m => `
                    <div class="pdf-metric-card ${m.isError ? 'is-danger' : ''}">
                        <div class="pdf-metric-head">
                            <span class="pdf-metric-icon">${m.icon}</span>
                            <span class="pdf-metric-label">${esc(m.label)}</span>
                        </div>
                        <div class="pdf-metric-val">${esc(m.value)}</div>
                    </div>
                `).join('')}
            </div>
        ` : '';

        const actionsHtml = detailActions(detail);

        const summaryBarHtml = `
            <section class="pdf-detail-overview-card">
                <div class="pdf-overview-status-wrap">
                    <span class="doc-tool-badge ${statusTone(detail.job.status)} pdf-status-badge">
                        <span class="pdf-status-pulse-dot"></span>
                        ${esc(statLabel)}
                    </span>
                    <span class="pdf-overview-op-badge">${esc(opLabel)}</span>
                    ${detail.job.errorMessage ? `<div class="pdf-overview-err-banner">${esc(detail.job.errorMessage)}</div>` : ''}
                </div>
                ${actionsHtml ? `<div class="pdf-detail-actions">${actionsHtml}</div>` : ''}
            </section>
        `;

        const outputsSectionHtml = `
            <section class="pdf-detail-section pdf-outputs-section">
                <div class="pdf-section-head">
                    <h4 class="pdf-section-title">
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path><polyline points="13 2 13 9 20 9"></polyline></svg>
                        <span>输出文件</span>
                    </h4>
                    <span class="pdf-section-tag">${(detail.outputs || []).length} 个产物</span>
                </div>
                ${renderOutputs(detail.outputs || [])}
            </section>
        `;

        html.setHtml(box, `
            ${summaryBarHtml}
            ${metricsHtml}
            ${renderPreflight(detail.preflight)}
            ${renderBatchItems(detail.items?.length ? detail.items : result.items)}
            ${renderPages(detail)}
            ${outputsSectionHtml}
        `);
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
        renderQuickPresets();
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

    function appendOptionalFormValue(data, id, name) {
        const element = document.getElementById(id);
        if (!element) return;
        if (element.type === 'checkbox') {
            if (element.checked) data.set(name, 'true');
            return;
        }
        const value = String(element.value || '').trim();
        if (value) data.set(name, value);
    }

    function appendJsonValue(data, id, name, fallback) {
        const element = document.getElementById(id);
        const raw = String(element?.value || '').trim();
        if (!raw) return;
        let value;
        try { value = JSON.parse(raw); } catch (_error) { throw new Error(`“${element?.previousElementSibling?.textContent || name}”必须是有效 JSON。`); }
        if (fallback === 'array' && !Array.isArray(value)) throw new Error(`“${name}”必须是 JSON 数组。`);
        if (fallback === 'object' && (!value || Array.isArray(value) || typeof value !== 'object')) throw new Error(`“${name}”必须是 JSON 对象。`);
        data.set(name, JSON.stringify(value));
    }

    async function submitJob(form) {
        const files = Array.from(document.getElementById('pdf-files-input')?.files || []);
        if (!files.length) {
            toast('请选择需要处理的文件。', 'warning');
            document.getElementById('pdf-files-input')?.focus();
            return;
        }
        const data = new FormData();
        files.forEach(file => data.append('files', file));
        const selectedOperation = currentOperation();
        const meta = operation(selectedOperation);
        data.set('operation', selectedOperation);
        if (meta.inputMode === 'single-or-batch') appendOptionalFormValue(data, 'pdf-mode-input', 'mode');
        if (meta.supportsPages) appendOptionalFormValue(data, 'pdf-pages-input', 'pages');
        if (meta.supportsOrder) appendOptionalFormValue(data, 'pdf-order-input', 'pageOrder');
        if (selectedOperation === 'rotate') appendOptionalFormValue(data, 'pdf-rotate-input', 'rotateDegrees');
        if (meta.supportsDpi) {
            appendOptionalFormValue(data, 'pdf-dpi-input', 'dpi');
            appendOptionalFormValue(data, 'pdf-max-pages-input', 'maxToolPages');
        }
        if (meta.supportsWatermark) [['pdf-watermark-text', 'watermarkText'], ['pdf-watermark-position', 'watermarkPosition'], ['pdf-watermark-opacity', 'watermarkOpacity']].forEach(([id, name]) => appendOptionalFormValue(data, id, name));
        if (meta.supportsPageNumbers) [['pdf-page-number-start', 'pageNumberStart'], ['pdf-page-number-position', 'pageNumberPosition'], ['pdf-skip-cover', 'skipCover']].forEach(([id, name]) => appendOptionalFormValue(data, id, name));
        if (meta.supportsCrop) [['pdf-crop-left', 'cropLeft'], ['pdf-crop-right', 'cropRight'], ['pdf-crop-top', 'cropTop'], ['pdf-crop-bottom', 'cropBottom']].forEach(([id, name]) => appendOptionalFormValue(data, id, name));
        if (meta.supportsBlankPage) [['pdf-blank-after', 'blankPageAfter'], ['pdf-blank-count', 'blankPageCount']].forEach(([id, name]) => appendOptionalFormValue(data, id, name));
        if (selectedOperation === 'images_to_pdf') [['pdf-page-size', 'pageSize'], ['pdf-image-fit', 'imageFit']].forEach(([id, name]) => appendOptionalFormValue(data, id, name));
        if (meta.supportsCompression) [['pdf-compression-mode', 'compressionMode'], ['pdf-compression-jpeg-quality', 'compressionJpegQuality']].forEach(([id, name]) => appendOptionalFormValue(data, id, name));
        if (meta.supportsProtection) {
            appendOptionalFormValue(data, 'pdf-output-password', 'outputPassword');
            appendOptionalFormValue(data, 'pdf-owner-password', 'ownerPassword');
            data.set('outputPermissions', JSON.stringify({ print: Boolean(document.getElementById('pdf-protect-print')?.checked), modify: Boolean(document.getElementById('pdf-protect-modify')?.checked) }));
        }
        if (meta.supportsCompare) appendOptionalFormValue(data, 'pdf-compare-dpi', 'compareDpi');
        if (meta.supportsPdfa) appendOptionalFormValue(data, 'pdf-pdfa-profile', 'pdfaProfile');
        if (meta.supportsRedaction) appendJsonValue(data, 'pdf-redact-regions', 'redactRegions', 'array');
        if (meta.supportsAnnotations) appendJsonValue(data, 'pdf-annotations', 'annotations', 'array');
        if (meta.supportsFormFill) appendJsonValue(data, 'pdf-form-values', 'formValues', 'object');
        if (meta.supportsPagePlan) appendJsonValue(data, 'pdf-page-plan', 'pagePlan', 'array');
        appendOptionalFormValue(data, 'pdf-password-input', 'password');
        const button = document.getElementById('pdf-submit-btn');
        const label = button?.textContent;
        if (button) { button.disabled = true; button.textContent = '正在创建'; }
        try {
            const created = await requestJson(`${API}/jobs`, { method: 'POST', body: data });
            state.activeJobId = String(created.job?.id || '');
            form.reset();
            state.activePresetId = '';
            renderQuickPresets();
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
        // 服务端以流式 ZIP 返回；使用浏览器原生下载通道，避免客户端先把全部归档读入 Blob。
        const link = document.createElement('a');
        link.href = `${API}/jobs/${encodeURIComponent(jobId)}/outputs/download`;
        link.download = `pdf-job-${jobId}-全部输出.zip`;
        document.body.appendChild(link);
        link.click();
        link.remove();
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
            if (event.target?.id === 'pdf-operation-select') {
                clearActivePreset();
                syncOperationOptions();
            } else if (event.target?.closest?.('#pdf-tools-form') && event.target?.id !== 'pdf-files-input') {
                clearActivePreset();
            }
            if (event.target?.id === 'pdf-status-filter') { state.status = event.target.value; state.page = 1; loadJobs({ keepActive: false }).catch(error => toast(error.message, 'error')); }
        });
        view.addEventListener('input', event => {
            if (event.target?.closest?.('#pdf-tools-form') && event.target?.id !== 'pdf-files-input') clearActivePreset();
        });
        view.addEventListener('click', event => {
            const closest = selector => event.target.closest(selector);
            const quickPreset = closest('[data-pdf-quick-preset]'); if (quickPreset) return void applyPreset(quickPreset.dataset.pdfQuickPreset);
            const open = closest('[data-pdf-job-open]'); if (open) return void loadDetail(open.dataset.pdfJobOpen).catch(error => toast(error.message, 'error'));
            if (closest('[data-pdf-close-detail]')) return void closeDetail();
            if (closest('[data-pdf-close-preview]')) return void document.getElementById('pdf-page-preview-panel')?.classList.add('hidden');
            if (closest('[data-pdf-close-page-plan]')) return void document.getElementById('pdf-page-plan-panel')?.classList.add('hidden');
            if (closest('[data-pdf-open-page-plan]')) return void openPagePlanEditor();
            if (closest('[data-pdf-plan-undo]')) { if (state.pagePlanHistory.length) { state.pagePlanFuture.push(clonePagePlan(state.pagePlan)); state.pagePlan = state.pagePlanHistory.pop(); renderPagePlan(); } return; }
            if (closest('[data-pdf-plan-redo]')) { if (state.pagePlanFuture.length) { state.pagePlanHistory.push(clonePagePlan(state.pagePlan)); state.pagePlan = state.pagePlanFuture.pop(); renderPagePlan(); } return; }
            if (closest('[data-pdf-plan-blank]')) return void updatePagePlan(plan => plan.push({ blank: true, sourcePage: 0, rotation: 0 }));
            if (closest('[data-pdf-plan-apply]')) return void applyPagePlan().catch(error => toast(error.message || '页面编排创建失败。', 'error'));
            const move = closest('[data-pdf-plan-move]'); if (move) return void updatePagePlan(plan => { const index = Number(move.dataset.pdfPlanIndex); const target = move.dataset.pdfPlanMove === 'up' ? index - 1 : index + 1; if (Number.isInteger(index) && target >= 0 && Boolean(plan[target])) [plan[index], plan[target]] = [plan[target], plan[index]]; });
            const rotatePlan = closest('[data-pdf-plan-rotate]'); if (rotatePlan) return void updatePagePlan(plan => { const item = plan[Number(rotatePlan.dataset.pdfPlanIndex)]; if (item) item.rotation = (Number(item.rotation || 0) + 90) % 360; });
            const deletePlan = closest('[data-pdf-plan-delete]'); if (deletePlan) return void updatePagePlan(plan => { const index = Number(deletePlan.dataset.pdfPlanIndex); if (plan.length > 1 && Number.isInteger(index)) plan.splice(index, 1); else toast('页面编排不能删除为零页。', 'warning'); });
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
            const view = document.getElementById('pdf-tools-view');
            if (state.polling || document.hidden || !view || view.closest('.hidden, [hidden], [aria-hidden="true"]') || window.Pivot.legacy.getAppsSessionValue?.('pivot_apps_active_app') !== 'pdf-tools') return;
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
