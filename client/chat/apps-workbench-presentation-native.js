(function () {
    'use strict';
    const API = '/api/apps/presentations/native';
    let revisionModelId = '';
    let bound = false, helpers, presentationState, documentValue = null, slideIndex = 0, selected = '', readPatch = null, job = null, epoch = 0, cachedDocuments = [];
    const byId = id => document.getElementById(id);
    const actor = () => String(window.Pivot.legacy?.currentUser?.id || '');
    function current(sequence) {
        const modal = byId('presentation-native-modal');
        return sequence === epoch && modal?.dataset.owner === actor() && !modal.classList.contains('hidden');
    }
    function node(tag, className = '', text = '') { const item = document.createElement(tag); item.className = className; item.textContent = text; return item; }
    function button(text, action, primary = false) {
        const item = node('button', primary ? 'btn-primary' : 'btn-secondary', text);
        item.type = 'button';
        item.addEventListener('click', async () => {
            const sequence = epoch;
            try { await action(); } catch (error) { if (current(sequence)) showError(error); }
        });
        return item;
    }
    function field(label, type, value = '', options = {}) {
        const wrapper = node('label', 'presentation-native-field'), input = node(type === 'select' ? 'select' : type === 'textarea' ? 'textarea' : 'input', 'form-input');
        wrapper.append(node('span', '', label), input); input.setAttribute('aria-label', label);
        if (type === 'select') for (const [key, title] of Object.entries(options)) input.appendChild(new Option(title, key));
        else if (type === 'textarea') { input.rows = 2; input.maxLength = 12000; }
        else input.type = type;
        if (type === 'checkbox') input.checked = Boolean(value); else input.value = String(value ?? '');
        return { wrapper, input };
    }
    const post = body => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    function showError(error) { byId('presentation-native-status')?.replaceChildren(node('p', '', error.message || '原稿操作失败，请刷新后重试。')); }
    function svgIcon(paths, size = 18) {
        const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        el.setAttribute('width', String(size)); el.setAttribute('height', String(size));
        el.setAttribute('viewBox', '0 0 24 24'); el.setAttribute('fill', 'none');
        el.setAttribute('stroke', 'currentColor'); el.setAttribute('stroke-width', '2');
        el.setAttribute('stroke-linecap', 'round'); el.setAttribute('stroke-linejoin', 'round');
        for (const [tag, attrs] of paths) {
            const child = document.createElementNS('http://www.w3.org/2000/svg', tag);
            for (const [k, v] of Object.entries(attrs)) child.setAttribute(k, v);
            el.appendChild(child);
        }
        return el;
    }
    function dirty() { return Boolean(readPatch?.()); }
    function formatDocTime(val) {
        if (!val) return '';
        const d = new Date(val);
        if (Number.isNaN(d.getTime())) return String(val).slice(0, 16);
        const pad = n => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }
    function updateDocPreview() {
        const selector = byId('presentation-native-documents');
        const preview = byId('presentation-native-doc-preview');
        const openBtn = byId('presentation-native-open-btn');
        if (!selector || !preview) return;
        const selectedId = selector.value;
        const doc = cachedDocuments.find(item => String(item.id) === String(selectedId));
        preview.replaceChildren();

        if (!doc) {
            if (openBtn) {
                openBtn.disabled = true;
                openBtn.classList.remove('btn-primary');
                openBtn.classList.add('btn-secondary');
                openBtn.title = cachedDocuments.length ? '请在上方下拉框选择一份原稿' : '暂无历史原稿可打开';
            }
            const hint = node('p', 'presentation-native-hint-text', cachedDocuments.length
                ? '从上方下拉框选择历史原稿继续微调，或直接载入当前工作台文稿。'
                : '暂无历史导入原稿。请在左侧选择本地 PPTX 导入，或载入当前工作台文稿。');
            preview.appendChild(hint);
            return;
        }

        if (openBtn) {
            openBtn.disabled = false;
            openBtn.classList.remove('btn-secondary');
            openBtn.classList.add('btn-primary');
            openBtn.title = `打开《${doc.title}》开始编辑`;
        }

        const card = node('div', 'presentation-native-doc-card');
        const rowTop = node('div', 'presentation-native-doc-card-top');
        const titleWrap = node('div', 'presentation-native-doc-title-wrap');
        const icon = svgIcon([['path', { d: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z' }], ['polyline', { points: '14 2 14 8 20 8' }]], 15);
        const titleText = node('strong', 'presentation-native-doc-title', doc.title);
        titleText.title = doc.title;
        const verBadge = node('span', 'presentation-native-version-pill', `v${doc.current_version}`);
        titleWrap.append(icon, titleText, verBadge);

        const clearBtn = node('button', 'presentation-native-link-btn', '清空选择');
        clearBtn.type = 'button';
        clearBtn.addEventListener('click', () => {
            selector.value = '';
            updateDocPreview();
        });
        rowTop.append(titleWrap, clearBtn);

        const rowBottom = node('div', 'presentation-native-doc-card-bottom');
        const timeText = node('span', 'presentation-native-doc-time', `更新时间：${formatDocTime(doc.updated_at || doc.created_at) || '近期'}`);
        const deleteBtn = node('button', 'presentation-native-danger-link-btn', '归档移除');
        deleteBtn.type = 'button';
        deleteBtn.title = '从已有原稿列表中归档移除此文稿';
        deleteBtn.addEventListener('click', async () => {
            const title = doc.title || '此原稿';
            if (!await window.Pivot.legacy.showConfirm?.('确认归档原稿', `确定从已有原稿列表中归档移除《${title}》吗？`)) return;
            const sequence = epoch;
            try {
                await helpers.requestJson(API + '/documents/' + encodeURIComponent(doc.id), { method: 'DELETE' });
                if (current(sequence)) await library(sequence);
            } catch (e) {
                showError(e);
            }
        });
        rowBottom.append(timeText, deleteBtn);
        card.append(rowTop, rowBottom);
        preview.appendChild(card);
    }
    async function discardAllowed() { return !dirty() || Boolean(await window.Pivot.legacy.showConfirm?.('尚未保存对象修改', '切换后当前对象未保存的修改将丢弃。是否继续？')); }
    function ensureView() {
        if (byId('presentation-native-modal')) return;
        const overlay = node('div', 'modal-overlay hidden'); overlay.id = 'presentation-native-modal';
        const modal = node('section', 'workspace-modal presentation-native-dialog');
        modal.id = 'presentation-native-dialog';
        modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true'); modal.setAttribute('aria-label', '原稿编辑与离线视频');

        // 弹窗头部
        const head = node('div', 'presentation-create-dialog-head');
        const titleRow = node('div', 'presentation-create-dialog-title-row');
        const titleGroup = node('div', 'presentation-create-dialog-title-group');
        titleGroup.append(
            node('h3', '', '原稿编辑与离线视频'),
            node('p', '', '逐页解析 PPTX 母版元素、图层坐标编辑与离线视频合成；亦用于沿用原稿设计。')
        );
        const closeBtn = node('button', 'btn-secondary workspace-modal-close', '关闭');
        closeBtn.type = 'button'; closeBtn.setAttribute('aria-label', '关闭');
        closeBtn.addEventListener('click', async () => {
            const sequence = epoch;
            if (await discardAllowed() && current(sequence)) {
                overlay.classList.add('hidden');
                modal.classList.remove('has-document');
                epoch++;
                documentValue = null; job = null; selected = ''; readPatch = null; slideIndex = 0;
                byId('presentation-native-upload').value = '';
                byId('presentation-native-preview').removeAttribute('src');
                byId('presentation-native-status').replaceChildren();
                byId('presentation-native-narration').replaceChildren();
                const docSel = byId('presentation-native-documents');
                if (docSel) docSel.value = '';
                updateDocPreview();
            }
        });
        titleRow.append(titleGroup, closeBtn);
        head.appendChild(titleRow);

        const body = node('div', 'workspace-modal-body presentation-native-body-wrap');

        // 提示横幅
        const banner = node('div', 'presentation-native-banner');
        banner.id = 'presentation-native-banner';
        body.appendChild(banner);

        // 入口双卡片网格
        const entryGrid = node('div', 'presentation-native-entry-grid');
        entryGrid.id = 'presentation-native-entry-grid';

        // Card 1: 导入本地 PPTX 原稿
        const cardUpload = node('div', 'presentation-native-card');
        const cardUploadHead = node('div', 'presentation-native-card-head');
        cardUploadHead.append(
            svgIcon([['path', { d: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4' }], ['polyline', { points: '17 8 12 3 7 8' }], ['line', { x1: '12', y1: '3', x2: '12', y2: '15' }]], 20),
            node('h4', '', '导入本地 PPTX 原稿')
        );
        const cardUploadDesc = node('p', 'presentation-native-card-desc', '解析每一页母版矢量形状、图层层级与文字对象；支持继续编辑或沿用设计。');
        const file = field('选择 PPTX 原稿', 'file'); file.input.id = 'presentation-native-upload'; file.input.accept = '.pptx';
        const upload = button('导入并编辑', importFile, true); upload.id = 'presentation-native-import';
        upload.className = 'btn-primary presentation-native-submit-btn';
        cardUpload.append(cardUploadHead, cardUploadDesc, file.wrapper, upload);

        // Card 2: 打开已有原稿或工作台
        const cardExisting = node('div', 'presentation-native-card');
        const cardExistingHead = node('div', 'presentation-native-card-head');
        cardExistingHead.append(
            svgIcon([['path', { d: 'M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z' }]], 20),
            node('h4', '', '打开已有原稿或工作台')
        );
        const cardExistingDesc = node('p', 'presentation-native-card-desc', '选择历史导入的原稿版本继续编辑，或直接载入当前工作台文稿微调。');

        const docsWrapper = node('div', 'presentation-native-field-group');
        const docsHead = node('div', 'presentation-native-field-head');
        const docsLabel = node('label', 'presentation-native-field-label', '已有原稿');
        docsLabel.htmlFor = 'presentation-native-documents';
        const docsHeadRight = node('div', 'presentation-native-head-tools');
        const docsCountBadge = node('span', 'presentation-native-count-badge', '0 份');
        docsCountBadge.id = 'presentation-native-docs-count';
        const docsRefreshBtn = node('button', 'presentation-native-refresh-btn', '刷新');
        docsRefreshBtn.type = 'button';
        docsRefreshBtn.id = 'presentation-native-docs-refresh';
        docsRefreshBtn.title = '重新加载历史原稿列表';
        docsRefreshBtn.addEventListener('click', async () => {
            const sequence = epoch;
            try {
                docsRefreshBtn.disabled = true;
                await library(sequence);
            } catch (err) {
                showError(err);
            } finally {
                docsRefreshBtn.disabled = false;
            }
        });
        docsHeadRight.append(docsCountBadge, docsRefreshBtn);
        docsHead.append(docsLabel, docsHeadRight);

        const docsSelect = node('select', 'presentation-native-select');
        docsSelect.id = 'presentation-native-documents';
        docsSelect.addEventListener('change', () => {
            updateDocPreview();
        });
        docsSelect.addEventListener('dblclick', async () => {
            const id = docsSelect.value;
            if (id && await discardAllowed() && current(epoch)) await loadDocument(id);
        });
        docsSelect.addEventListener('keydown', async (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                const id = docsSelect.value;
                if (id && await discardAllowed() && current(epoch)) await loadDocument(id);
            }
        });

        const previewBox = node('div', 'presentation-native-doc-preview');
        previewBox.id = 'presentation-native-doc-preview';

        docsWrapper.append(docsHead, docsSelect, previewBox);

        const existingActions = node('div', 'presentation-native-existing-actions');
        const openBtn = button('打开原稿', async () => {
            const sequence = epoch, id = docsSelect.value;
            if (id && await discardAllowed() && current(sequence)) await loadDocument(id);
        });
        openBtn.id = 'presentation-native-open-btn';
        openBtn.disabled = true;

        const currentBtn = button('打开当前工作台文稿', async () => {
            if (!presentationState.active?.id) throw new Error('请先在工作台打开一份文稿。');
            await begin({ kind: 'import', presentationId: presentationState.active.id, title: presentationState.active.title });
        });
        currentBtn.id = 'presentation-native-current-btn';
        currentBtn.className = 'btn-secondary presentation-native-current-btn';
        existingActions.append(openBtn, currentBtn);
        cardExisting.append(cardExistingHead, cardExistingDesc, docsWrapper, existingActions);

        entryGrid.append(cardUpload, cardExisting);
        body.appendChild(entryGrid);

        const status = node('div', 'presentation-evidence-card'); status.id = 'presentation-native-status'; status.setAttribute('aria-live', 'polite');
        body.appendChild(status);

        // 原稿编辑器主体
        const editor = node('div', 'presentation-native-editor hidden'); editor.id = 'presentation-native-editor';
        const top = node('div', 'presentation-native-toolbar'), slides = field('页面', 'select'), versions = field('版本', 'select');
        slides.input.id = 'presentation-native-slide'; versions.input.id = 'presentation-native-version';
        slides.input.addEventListener('change', async () => {
            const sequence = epoch, next = Number(slides.input.value);
            if (await discardAllowed() && current(sequence)) { slideIndex = next; selected = ''; renderSlide(); }
        });
        versions.input.addEventListener('change', async () => {
            const sequence = epoch, id = documentValue?.id, version = Number(versions.input.value);
            if (id && await discardAllowed() && current(sequence)) await loadDocument(id, version);
        });
        const download = button('下载此版本PPTX', () => downloadPackage());
        const restore = button('恢复所选历史版本', async () => {
            if (documentValue.version === documentValue.currentVersion) throw new Error('当前已是最新版本。');
            await begin({ kind: 'restore', documentId: documentValue.id, baseVersion: documentValue.currentVersion, sourceVersion: documentValue.version, title: documentValue.title });
        });
        const video = button('离线导出MP4', () => byId('presentation-native-video').classList.toggle('hidden'));
        const revisePage = button('AI 修改本页文字', revisePageText); revisePage.id = 'presentation-native-revise-page';
        top.append(slides.wrapper, versions.wrapper, download, revisePage, restore, video);
        const layout = node('div', 'presentation-native-layout'), stage = node('div', 'presentation-native-stage'), picture = node('img'); picture.id = 'presentation-native-preview'; picture.alt = '原稿页面的离线静态预览'; stage.appendChild(picture);
        const overlaySvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); overlaySvg.id = 'presentation-native-selection'; overlaySvg.classList.add('presentation-native-selection'); stage.appendChild(overlaySvg);
        const aside = node('aside', 'presentation-native-properties'), objects = field('页面对象', 'select'); objects.input.id = 'presentation-native-object';
        objects.input.addEventListener('change', () => chooseObject(objects.input.value).catch(showError));
        const properties = node('div'); properties.id = 'presentation-native-properties';
        const save = button('保存对象修改', saveObject, true); save.id = 'presentation-native-save';
        aside.append(objects.wrapper, properties, save); layout.append(stage, aside);
        const note = node('p', 'presentation-empty-note'); note.id = 'presentation-native-notice';
        editor.append(top, note, layout, createVideo());
        body.appendChild(editor);

        modal.append(head, body);
        overlay.appendChild(modal);
        document.body.appendChild(overlay);
    }
    function createVideo() {
        const panel = node('section', 'presentation-native-video hidden'); panel.id = 'presentation-native-video'; panel.appendChild(node('h4', '', '页面视频'));
        panel.appendChild(node('p', 'presentation-empty-note', '使用离线静态页面、所选转场和旁白生成MP4。原生对象动画、嵌入视频播放与交互链接不包含在此模式中；原稿PPTX保留这些内容。'));
        const grid = node('div', 'presentation-native-fields');
        for (const [id, label, type, value, options] of [
            ['duration', '每页基础停留秒数', 'number', 5], ['resolution', '清晰度', 'select', '720p', { '720p': '720p', '1080p': '1080p' }],
            ['fps', '帧率', 'select', 24, { 24: '24帧', 30: '30帧' }], ['transition', '页面转场', 'select', 'fade', { fade: '淡入淡出', none: '直接切页' }]
        ]) { const control = field(label, type, value, options); control.input.id = 'presentation-native-video-' + id; grid.appendChild(control.wrapper); }
        const narration = node('div'); narration.id = 'presentation-native-narration';
        const accepted = field('我确认使用页面视频模式，并已核对字体和静态预览', 'checkbox', false); accepted.input.id = 'presentation-native-video-accept';
        panel.append(grid, node('p', 'presentation-empty-note', '可为每页上传WAV、MP3或OGG旁白。停留时间会延长至旁白结束后；单页最多60秒、整稿最多10分钟。'), narration, accepted.wrapper, button('开始离线视频导出', startVideo, true));
        return panel;
    }
    async function library(sequence) {
        const data = await helpers.requestJson(API + '/documents');
        if (!current(sequence)) return;
        cachedDocuments = Array.isArray(data.documents) ? data.documents : [];
        const selector = byId('presentation-native-documents');
        const countBadge = byId('presentation-native-docs-count');
        if (countBadge) {
            countBadge.textContent = `${cachedDocuments.length} 份`;
        }
        if (selector) {
            selector.replaceChildren();
            if (cachedDocuments.length === 0) {
                const emptyOpt = new Option('暂无历史原稿（请在左侧导入或载入工作台）', '');
                emptyOpt.disabled = true;
                selector.appendChild(emptyOpt);
                selector.disabled = true;
            } else {
                selector.disabled = false;
                selector.appendChild(new Option(`选择已有原稿（共 ${cachedDocuments.length} 份）...`, ''));
                cachedDocuments.forEach(item => {
                    const timeStr = formatDocTime(item.updated_at || item.created_at);
                    const label = `《${item.title}》 · v${item.current_version}${timeStr ? `（${timeStr}）` : ''}`;
                    selector.appendChild(new Option(label, item.id));
                });
            }
            if (documentValue && cachedDocuments.some(item => String(item.id) === String(documentValue.id))) {
                selector.value = documentValue.id;
            }
        }
        updateDocPreview();
    }
    async function open(source = null) {
        ensureView();
        revisionModelId = source?.modelId || '';
        byId('presentation-native-revise-page').classList.toggle('hidden', !revisionModelId);
        const sequence = ++epoch, modal = byId('presentation-native-modal');
        if (modal.dataset.owner !== actor()) {
            documentValue = null; job = null; selected = ''; readPatch = null; slideIndex = 0;
            byId('presentation-native-status').replaceChildren();
        }
        modal.dataset.owner = actor();
        modal.classList.remove('hidden');
        byId('presentation-native-dialog')?.classList.remove('has-document');
        byId('presentation-native-entry-grid')?.classList.remove('hidden');
        byId('presentation-native-editor')?.classList.add('hidden');
        try { await loadEntry(source, sequence); }
        catch (error) { if (current(sequence)) showError(error); }
    }
    async function loadEntry(source, sequence) {
        const { engine } = await helpers.requestJson(API + '/info');
        if (!current(sequence)) return;
        byId('presentation-native-import').disabled = !engine.enabled;
        const banner = byId('presentation-native-banner');
        if (banner) {
            banner.replaceChildren();
            const pill = node('span', 'presentation-native-mode-pill' + (engine.enabled ? ' is-active' : ''), engine.enabled ? '原稿制作服务就绪' : '原稿服务未连接');
            const msg = node('span', 'presentation-native-mode-text', engine.enabled ? '可编辑原生PPTX对象、保存版本并制作离线页面视频。' : '原稿编辑与视频需要完整制作服务；标准PPT创建、编辑和导出仍可使用。');
            banner.append(pill, msg);
        }
        if (!engine.enabled) { showError(new Error(engine.message)); return; }
        await library(sequence);
        if (!current(sequence)) return;
        const currentBtn = byId('presentation-native-current-btn');
        if (currentBtn) {
            const activeTitle = presentationState?.active?.title;
            currentBtn.title = activeTitle ? `载入工作台当前文稿《${activeTitle}》` : '工作台当前暂未打开任何文稿';
        }
        if (source?.sourceRenditionId || source?.sourceAssetId) { await begin({ kind: 'import', ...source }); return; }
        const data = await helpers.requestJson(API + '/jobs/latest');
        if (!current(sequence)) return;
        if (data.task) { job = data.task; await poll(job.id, sequence); }
        else byId('presentation-native-status').replaceChildren(node('p', 'presentation-empty-hint', '上传原稿或打开已有文稿，无需调用模型或访问互联网。'));
    }
    async function importFile() {
        const sequence = epoch;
        const file = byId('presentation-native-upload').files?.[0];
        if (!file || !/\.pptx$/i.test(file.name)) throw new Error('请选择PPTX原稿。');
        const body = new FormData(); body.append('file', file); body.append('assetType', 'attachment');
        const { asset } = await helpers.requestJson('/api/apps/presentations/assets', { method: 'POST', body });
        if (!current(sequence)) return;
        await begin({ kind: 'import', sourceAssetId: String(asset.id), title: file.name.replace(/\.pptx$/i, '') });
    }
    async function begin(input) {
        const sequence = epoch;
        if (job?.status === 'working') throw new Error('已有原稿任务正在执行，请等待完成或停止后再操作。');
        if (input.kind !== 'patch' && !await discardAllowed()) return;
        if (!current(sequence)) return;
        const data = await helpers.requestJson(API + '/jobs', post(input));
        if (!current(sequence)) return;
        job = data.task; await poll(job.id, sequence);
    }
    async function poll(id, sequence, retries = 0) {
        if (!current(sequence)) return;
        let data;
        try { data = await helpers.requestJson(API + '/jobs/' + encodeURIComponent(id)); }
        catch (error) {
            if (!current(sequence)) return;
            if (retries < 8 && (!error.status || error.status >= 500)) {
                byId('presentation-native-status').appendChild(node('p', 'presentation-empty-note', '暂时无法读取进度，正在重新连接；不会重复创建任务。'));
                window.setTimeout(() => poll(id, sequence, retries + 1).catch(error => { if (current(sequence)) showError(error); }), 3000); return;
            }
            throw error;
        }
        if (!current(sequence)) return;
        job = data.task; renderJob();
        if (job.status === 'working') window.setTimeout(() => poll(id, sequence).catch(error => { if (current(sequence)) showError(error); }), 1500);
        else if (job.status === 'completed' && job.result?.documentId && !job.result.file) {
            const result = job.result; readPatch = null;
            await library(sequence);
            if (current(sequence)) await loadDocument(result.documentId);
        }
    }
    function renderJob() {
        const panel = byId('presentation-native-status'); panel.replaceChildren();
        const busy = job.status === 'working';
        for (const control of byId('presentation-native-modal').querySelectorAll('.presentation-native-toolbar input, .presentation-native-toolbar select, .presentation-native-toolbar button, #presentation-native-editor input, #presentation-native-editor textarea, #presentation-native-editor select, #presentation-native-editor button')) {
            if (busy && control.dataset.nativeBusy === undefined) { control.dataset.nativeBusy = control.disabled ? 'disabled' : 'enabled'; control.disabled = true; }
            else if (!busy && control.dataset.nativeBusy !== undefined) { control.disabled = control.dataset.nativeBusy === 'disabled'; delete control.dataset.nativeBusy; }
        }
        panel.append(node('strong', '', { working: '正在处理', completed: '处理完成', failed: '处理未完成', cancelled: '已停止', expired: '任务已过期' }[job.status] || '原稿任务'), node('p', '', job.error?.message || job.progress?.message || '正在准备。'));
        const jobId = job.id;
        if (job.status === 'working') panel.appendChild(button('停止任务', async () => {
            const sequence = ++epoch;
            try {
                const data = await helpers.requestJson(API + '/jobs/' + jobId + '/cancel', post({}));
                if (current(sequence)) { job = data.task; renderJob(); }
            } catch (error) {
                if (current(sequence)) {
                    panel.appendChild(node('p', 'presentation-empty-note', error.message));
                    window.setTimeout(() => poll(jobId, sequence).catch(failure => { if (current(sequence)) showError(failure); }), 3000);
                }
            }
        }));
        if (job.recoverable) panel.appendChild(button('从检查点继续', async () => {
            const sequence = ++epoch;
            try { await helpers.requestJson(API + '/jobs/' + jobId + '/resume', post({})); await poll(jobId, sequence); }
            catch (error) { if (current(sequence)) panel.appendChild(node('p', 'presentation-empty-note', error.message)); }
        }));
        if (job.result?.file) panel.appendChild(button('下载MP4视频', async () => {
            const sequence = epoch, file = job.result.file, data = await helpers.requestJson('/api/agents/renditions/' + file.renditionId + '/download-token', post({}));
            if (current(sequence)) triggerDownload('/api/agents/renditions/' + file.renditionId + '/download?token=' + encodeURIComponent(data.token), file.filename);
        }));
    }
    async function loadDocument(id, version = null) {
        const sequence = ++epoch;
        if (!current(sequence)) return;
        const suffix = version === null ? '' : '/versions/' + version;
        const url = API + '/documents/' + encodeURIComponent(id);
        let data, history;
        try { [data, history] = await Promise.all([helpers.requestJson(url + suffix), helpers.requestJson(url + '/versions')]); }
        catch (error) { if (current(sequence)) showError(error); return; }
        if (!current(sequence)) return;
        documentValue = data.document;
        byId('presentation-native-dialog')?.classList.add('has-document');
        byId('presentation-native-entry-grid')?.classList.add('hidden');
        byId('presentation-native-documents').value = documentValue.id;
        updateDocPreview();
        selected = ''; slideIndex = Math.min(slideIndex, documentValue.manifest.slides.length - 1); readPatch = null;
        const selector = byId('presentation-native-slide'); selector.replaceChildren();
        documentValue.manifest.slides.forEach(slide => selector.appendChild(new Option('第' + (slide.index + 1) + '页', String(slide.index)))); selector.value = String(slideIndex);
        const versions = byId('presentation-native-version'); versions.replaceChildren();
        history.versions.forEach(item => versions.appendChild(new Option('版本' + item.version, String(item.version)))); versions.value = String(documentValue.version);
        byId('presentation-native-notice').textContent = `${documentValue.title} · v${documentValue.version}。${documentValue.manifest.previewNotice} 拖动对象后点击“保存对象修改”。`;
        byId('presentation-native-editor').classList.remove('hidden');
        const narration = byId('presentation-native-narration'); narration.replaceChildren();
        documentValue.manifest.slides.forEach(slide => { const control = field('第' + (slide.index + 1) + '页旁白（可选）', 'file'); control.input.accept = '.wav,.mp3,.ogg'; control.input.dataset.narrationSlide = String(slide.index); narration.appendChild(control.wrapper); });
        renderSlide();
    }
    function renderSlide() {
        const slide = documentValue.manifest.slides[slideIndex];
        byId('presentation-native-preview').src = slide.previewUrl;
        const selector = byId('presentation-native-object'); selector.replaceChildren(new Option('选择原生对象', ''));
        slide.objects.forEach(object => selector.appendChild(new Option((object.parentId ? '　' : '') + object.name + ' · ' + ({ sp: '形状/文字', pic: '图片', grpSp: '组合', graphicFrame: object.chart ? '图表' : object.table ? '表格' : '原生图形', cxnSp: '连接线' }[object.kind] || '对象'), object.id)));
        selector.value = selected;
        readPatch = window.Pivot.moduleApi('apps.presentations.nativeProperties').render(byId('presentation-native-properties'), slide.objects.find(item => item.id === selected), { node, field });
        byId('presentation-native-save').disabled = documentValue.version !== documentValue.currentVersion;
        renderSelection();
    }
    async function chooseObject(id) {
        const sequence = epoch, page = slideIndex;
        if (id === selected || !await discardAllowed() || !current(sequence) || page !== slideIndex) return;
        selected = id; renderSlide();
    }
    function renderSelection() {
        const svg = byId('presentation-native-selection'), manifest = documentValue.manifest, objects = manifest.slides[slideIndex].objects;
        svg.replaceChildren(); svg.setAttribute('viewBox', `0 0 ${manifest.width} ${manifest.height}`);
        const geometry = window.Pivot.moduleApi('apps.presentations.nativeGeometry'), scene = geometry.scene(objects);
        for (const object of objects) {
            const box = scene.get(object.id); if (!box || object.hidden || box.width <= 0 || box.height <= 0) continue;
            const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
            for (const key of ['x', 'y', 'width', 'height']) rect.setAttribute(key, String(box[key])); rect.classList.add('presentation-native-hit');
            if (object.id === selected) rect.classList.add('is-selected');
            rect.setAttribute('aria-label', object.name);
            rect.addEventListener('pointerdown', event => {
                if (job?.status === 'working') return;
                if (object.id !== selected) { void chooseObject(object.id); return; }
                if (documentValue.version !== documentValue.currentVersion) return;
                event.preventDefault(); rect.setPointerCapture(event.pointerId);
                const start = screenPoint(svg, event.clientX, event.clientY);
                const x = byId('presentation-native-properties').querySelector('[data-native-frame="x"]'), y = byId('presentation-native-properties').querySelector('[data-native-frame="y"]');
                if (!x || !y) return;
                const baseX = Number(x.value), baseY = Number(y.value);
                const move = moveEvent => {
                    const next = screenPoint(svg, moveEvent.clientX, moveEvent.clientY), delta = geometry.localDelta(box.parent, next.x - start.x, next.y - start.y);
                    x.value = String(Math.round((baseX + delta.x) * 10) / 10); y.value = String(Math.round((baseY + delta.y) * 10) / 10);
                    rect.setAttribute('x', String(box.x + next.x - start.x)); rect.setAttribute('y', String(box.y + next.y - start.y));
                };
                const stop = () => { rect.removeEventListener('pointermove', move); rect.removeEventListener('pointerup', stop); rect.removeEventListener('pointercancel', stop); };
                rect.addEventListener('pointermove', move); rect.addEventListener('pointerup', stop); rect.addEventListener('pointercancel', stop);
            }); svg.appendChild(rect);
        }
    }
    function screenPoint(svg, x, y) { const point = svg.createSVGPoint(); point.x = x; point.y = y; return point.matrixTransform(svg.getScreenCTM().inverse()); }
    async function saveObject() {
        const patch = readPatch?.(); if (!patch) throw new Error('当前对象没有待保存的修改。');
        await begin({ kind: 'patch', documentId: documentValue.id, baseVersion: documentValue.version, title: documentValue.title, patches: [{ ...patch, slideIndex }] });
    }
    async function revisePageText() {
        if (!documentValue || documentValue.version !== documentValue.currentVersion || dirty() || job?.status === 'working') {
            throw new Error('请选择最新版本并保存当前编辑后再修改。');
        }
        const sequence = epoch, { id, version, title } = documentValue, page = slideIndex;
        const samePage = () => current(sequence) && documentValue?.id === id && documentValue.version === version && slideIndex === page && !dirty();
        const instruction = await window.Pivot.legacy.showInputPrompt?.({ title: `修改第 ${page + 1} 页文字`, message: '填写修改要求。本次保存为新版本，保留其他页面。', multiline: true, required: true, maxLength: 2000 });
        if (!instruction?.trim() || !samePage()) return;
        const revise = byId('presentation-native-revise-page');
        revise.disabled = true;
        try {
            const { patches } = await helpers.requestJson(API + '/documents/' + encodeURIComponent(id) + '/ai/page-revision',
                post({ baseVersion: version, slideIndex: page, instruction: instruction.trim(), model: revisionModelId }));
            if (samePage()) {
                revise.disabled = false;
                await begin({ kind: 'patch', documentId: id, baseVersion: version, title, patches });
            }
        } finally {
            if (current(sequence) && job?.status !== 'working') revise.disabled = false;
        }
    }
    function triggerDownload(url, filename) { const link = node('a'); link.href = url; link.download = filename; document.body.appendChild(link); link.click(); link.remove(); }
    function downloadPackage() { triggerDownload(API + '/documents/' + documentValue.id + '/download?version=' + documentValue.version, documentValue.title + '.pptx'); }
    async function startVideo() {
        const sequence = epoch;
        if (dirty()) throw new Error('请先保存当前对象修改，再导出视频。');
        if (!byId('presentation-native-video-accept').checked) throw new Error('请先确认页面视频模式及静态预览。');
        const narration = [];
        for (const input of byId('presentation-native-narration').querySelectorAll('input[type="file"]')) if (input.files?.[0]) {
            const body = new FormData(); body.append('file', input.files[0]); body.append('assetType', 'audio');
            const { asset } = await helpers.requestJson('/api/apps/presentations/assets', { method: 'POST', body }); narration.push({ slideIndex: Number(input.dataset.narrationSlide), assetId: String(asset.id) });
            if (!current(sequence)) return;
        }
        await begin({
            kind: 'video', documentId: documentValue.id, baseVersion: documentValue.version, title: documentValue.title, mode: 'page_video', acknowledgeStatic: true,
            duration: Number(byId('presentation-native-video-duration').value), resolution: byId('presentation-native-video-resolution').value, fps: Number(byId('presentation-native-video-fps').value), transition: byId('presentation-native-video-transition').value, narration
        });
    }
    function bind(state, suppliedHelpers) {
        presentationState = state; helpers = suppliedHelpers; if (bound) return; bound = true;
        document.addEventListener('click', event => { if (event.target.closest?.('[data-presentation-native-open]')) void open().catch(showError); });
    }
    window.Pivot.exposeModule('apps.presentations.native', { bind, open });
})();
