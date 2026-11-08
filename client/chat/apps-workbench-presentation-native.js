(function () {
    'use strict';
    const API = '/api/apps/presentations/native';
    let bound = false, helpers, presentationState, documentValue = null, slideIndex = 0, selected = '', readPatch = null, job = null, epoch = 0;
    const byId = id => document.getElementById(id);
    function node(tag, className = '', text = '') { const item = document.createElement(tag); item.className = className; item.textContent = text; return item; }
    function button(text, action, primary = false) { const item = node('button', primary ? 'btn-primary' : 'btn-secondary', text); item.type = 'button'; item.addEventListener('click', () => Promise.resolve(action()).catch(showError)); return item; }
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
            if (await discardAllowed()) {
                overlay.classList.add('hidden');
                modal.classList.remove('has-document');
                epoch++;
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
        const docs = field('已有原稿', 'select'); docs.input.id = 'presentation-native-documents';
        const existingActions = node('div', 'presentation-native-existing-actions');
        const openBtn = button('打开原稿', async () => { if (await discardAllowed() && docs.input.value) await loadDocument(docs.input.value); });
        const currentBtn = button('打开当前工作台文稿', async () => { if (!presentationState.active?.id) throw new Error('请先在工作台打开一份文稿。'); await begin({ kind: 'import', presentationId: presentationState.active.id, title: presentationState.active.title }); });
        existingActions.append(openBtn, currentBtn);
        cardExisting.append(cardExistingHead, cardExistingDesc, docs.wrapper, existingActions);

        entryGrid.append(cardUpload, cardExisting);
        body.appendChild(entryGrid);

        const status = node('div', 'presentation-evidence-card'); status.id = 'presentation-native-status'; status.setAttribute('aria-live', 'polite');
        body.appendChild(status);

        // 原稿编辑器主体
        const editor = node('div', 'presentation-native-editor hidden'); editor.id = 'presentation-native-editor';
        const top = node('div', 'presentation-native-toolbar'), slides = field('页面', 'select'), versions = field('版本', 'select');
        slides.input.id = 'presentation-native-slide'; versions.input.id = 'presentation-native-version';
        slides.input.addEventListener('change', async () => { if (await discardAllowed()) { slideIndex = Number(slides.input.value); selected = ''; renderSlide(); } });
        versions.input.addEventListener('change', async () => { if (await discardAllowed()) await loadDocument(documentValue.id, Number(versions.input.value)); });
        const download = button('下载此版本PPTX', () => downloadPackage());
        const restore = button('恢复所选历史版本', async () => {
            if (documentValue.version === documentValue.currentVersion) throw new Error('当前已是最新版本。');
            await begin({ kind: 'restore', documentId: documentValue.id, baseVersion: documentValue.currentVersion, sourceVersion: documentValue.version, title: documentValue.title });
        });
        const video = button('离线导出MP4', () => byId('presentation-native-video').classList.toggle('hidden'));
        top.append(slides.wrapper, versions.wrapper, download, restore, video);
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
    async function library() {
        const data = await helpers.requestJson(API + '/documents'), selector = byId('presentation-native-documents'); selector.replaceChildren(new Option('选择已有原稿', ''));
        data.documents.forEach(item => selector.appendChild(new Option(`${item.title} · v${item.current_version}`, item.id)));
        if (documentValue) selector.value = documentValue.id;
    }
    async function open(source = null) {
        ensureView();
        byId('presentation-native-modal').classList.remove('hidden');
        byId('presentation-native-dialog')?.classList.remove('has-document');
        byId('presentation-native-entry-grid')?.classList.remove('hidden');
        byId('presentation-native-editor')?.classList.add('hidden');
        const { engine } = await helpers.requestJson(API + '/info');
        byId('presentation-native-import').disabled = !engine.enabled;
        const banner = byId('presentation-native-banner');
        if (banner) {
            banner.replaceChildren();
            const pill = node('span', 'presentation-native-mode-pill' + (engine.enabled ? ' is-active' : ''), engine.enabled ? '高阶制作引擎就绪' : '离线原生模式');
            const msg = node('span', 'presentation-native-mode-text', engine.enabled ? '支持云端完整重构制作与本地原生编辑双模式。' : '当前使用本地原生引擎解析 PPTX 对象、图层微调与离线视频导出（无需云端模型）。');
            banner.append(pill, msg);
        }
        if (!engine.enabled) { showError(new Error(engine.message)); return; }
        await library();
        if (source?.sourceRenditionId) { await begin({ kind: 'import', ...source }); return; }
        const data = await helpers.requestJson(API + '/jobs/latest');
        if (data.task) { job = data.task; await poll(job.id, ++epoch); }
        else byId('presentation-native-status').replaceChildren(node('p', 'presentation-empty-hint', '上传原稿或打开已有文稿，无需调用模型或访问互联网。'));
    }
    async function importFile() {
        const file = byId('presentation-native-upload').files?.[0];
        if (!file || !/\.pptx$/i.test(file.name)) throw new Error('请选择PPTX原稿。');
        const body = new FormData(); body.append('file', file); body.append('assetType', 'attachment');
        const { asset } = await helpers.requestJson('/api/apps/presentations/assets', { method: 'POST', body });
        await begin({ kind: 'import', sourceAssetId: String(asset.id), title: file.name.replace(/\.pptx$/i, '') });
    }
    async function begin(input) {
        if (job?.status === 'working') throw new Error('已有原稿任务正在执行，请等待完成或停止后再操作。');
        if (input.kind !== 'patch' && !await discardAllowed()) return;
        const data = await helpers.requestJson(API + '/jobs', post(input)); job = data.task; await poll(job.id, ++epoch);
    }
    async function poll(id, sequence, retries = 0) {
        let data;
        try { data = await helpers.requestJson(API + '/jobs/' + encodeURIComponent(id)); }
        catch (error) {
            if (sequence === epoch && retries < 8 && (!error.status || error.status >= 500) && !byId('presentation-native-modal').classList.contains('hidden')) {
                byId('presentation-native-status').appendChild(node('p', 'presentation-empty-note', '暂时无法读取进度，正在重新连接；不会重复创建任务。'));
                window.setTimeout(() => poll(id, sequence, retries + 1).catch(showError), 3000); return;
            }
            throw error;
        }
        if (sequence !== epoch) return;
        job = data.task; renderJob();
        if (job.status === 'working' && !byId('presentation-native-modal').classList.contains('hidden')) window.setTimeout(() => poll(id, sequence).catch(showError), 1500);
        else if (job.status === 'completed' && job.result?.documentId && !job.result.file) { readPatch = null; await library(); await loadDocument(job.result.documentId); }
    }
    function renderJob() {
        const panel = byId('presentation-native-status'); panel.replaceChildren();
        const busy = job.status === 'working';
        for (const control of byId('presentation-native-modal').querySelectorAll('.presentation-native-toolbar input, .presentation-native-toolbar select, .presentation-native-toolbar button, #presentation-native-editor input, #presentation-native-editor textarea, #presentation-native-editor select, #presentation-native-editor button')) {
            if (busy && control.dataset.nativeBusy === undefined) { control.dataset.nativeBusy = control.disabled ? 'disabled' : 'enabled'; control.disabled = true; }
            else if (!busy && control.dataset.nativeBusy !== undefined) { control.disabled = control.dataset.nativeBusy === 'disabled'; delete control.dataset.nativeBusy; }
        }
        panel.append(node('strong', '', { working: '正在处理', completed: '处理完成', failed: '处理未完成', cancelled: '已停止', expired: '任务已过期' }[job.status] || '原稿任务'), node('p', '', job.error?.message || job.progress?.message || '正在准备。'));
        if (job.status === 'working') panel.appendChild(button('停止任务', async () => { const data = await helpers.requestJson(API + '/jobs/' + job.id + '/cancel', post({})); job = data.task; renderJob(); }));
        if (job.recoverable) panel.appendChild(button('从检查点继续', async () => { await helpers.requestJson(API + '/jobs/' + job.id + '/resume', post({})); await poll(job.id, ++epoch); }));
        if (job.result?.file) panel.appendChild(button('下载MP4视频', async () => {
            const file = job.result.file, data = await helpers.requestJson('/api/agents/renditions/' + file.renditionId + '/download-token', post({}));
            triggerDownload('/api/agents/renditions/' + file.renditionId + '/download?token=' + encodeURIComponent(data.token), file.filename);
        }));
    }
    async function loadDocument(id, version = null) {
        const suffix = version === null ? '' : '/versions/' + version;
        const data = await helpers.requestJson(API + '/documents/' + encodeURIComponent(id) + suffix); documentValue = data.document;
        byId('presentation-native-dialog')?.classList.add('has-document');
        byId('presentation-native-entry-grid')?.classList.add('hidden');
        byId('presentation-native-documents').value = documentValue.id;
        selected = ''; slideIndex = Math.min(slideIndex, documentValue.manifest.slides.length - 1); readPatch = null;
        const selector = byId('presentation-native-slide'); selector.replaceChildren();
        documentValue.manifest.slides.forEach(slide => selector.appendChild(new Option('第' + (slide.index + 1) + '页', String(slide.index)))); selector.value = String(slideIndex);
        const history = await helpers.requestJson(API + '/documents/' + id + '/versions'), versions = byId('presentation-native-version'); versions.replaceChildren();
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
    async function chooseObject(id) { if (id === selected || !await discardAllowed()) return; selected = id; renderSlide(); }
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
    function triggerDownload(url, filename) { const link = node('a'); link.href = url; link.download = filename; document.body.appendChild(link); link.click(); link.remove(); }
    function downloadPackage() { triggerDownload(API + '/documents/' + documentValue.id + '/download?version=' + documentValue.version, documentValue.title + '.pptx'); }
    async function startVideo() {
        if (dirty()) throw new Error('请先保存当前对象修改，再导出视频。');
        if (!byId('presentation-native-video-accept').checked) throw new Error('请先确认页面视频模式及静态预览。');
        const narration = [];
        for (const input of byId('presentation-native-narration').querySelectorAll('input[type="file"]')) if (input.files?.[0]) {
            const body = new FormData(); body.append('file', input.files[0]); body.append('assetType', 'audio');
            const { asset } = await helpers.requestJson('/api/apps/presentations/assets', { method: 'POST', body }); narration.push({ slideIndex: Number(input.dataset.narrationSlide), assetId: String(asset.id) });
        }
        await begin({ kind: 'video', documentId: documentValue.id, baseVersion: documentValue.version, title: documentValue.title, mode: 'page_video', acknowledgeStatic: true,
            duration: Number(byId('presentation-native-video-duration').value), resolution: byId('presentation-native-video-resolution').value, fps: Number(byId('presentation-native-video-fps').value), transition: byId('presentation-native-video-transition').value, narration });
    }
    function bind(state, suppliedHelpers) {
        presentationState = state; helpers = suppliedHelpers; if (bound) return; bound = true;
        document.addEventListener('click', event => { if (event.target.closest?.('[data-presentation-native-open]')) void open().catch(showError); });
    }
    window.Pivot.exposeModule('apps.presentations.native', { bind, open });
})();
