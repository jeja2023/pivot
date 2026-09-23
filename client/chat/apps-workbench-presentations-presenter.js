(function () {
    if (window.Pivot?.moduleApi?.('apps.presentations.presenter')?.ready) return;

    const API = '/api/apps/presentations';
    const byId = id => document.getElementById(id);
    const deepClone = value => JSON.parse(JSON.stringify(value));

    async function requestJson(url, options = {}) {
        const res = await apiFetch(url, options);
        const data = await res.clone().json().catch(() => ({}));
        if (!res.ok) {
            const error = new Error(data?.error?.message || data?.error || data?.message || `请求失败（${res.status}）`);
            error.status = res.status;
            error.code = data?.code || data?.error?.code || '';
            throw error;
        }
        return data;
    }

    function jsonOptions(body) {
        return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
    }

    function downloadBlob(name, blob) {
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = name;
        document.body.appendChild(link);
        link.click();
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    function inferAssetType(file) {
        const mime = String(file?.type || '').toLowerCase();
        const name = String(file?.name || '').toLowerCase();
        if (/^font\//.test(mime) || /\.(ttf|otf|woff2?)$/.test(name)) return 'font';
        if (/^audio\//.test(mime) || /\.(mp3|wav|ogg|aac|m4a)$/.test(name)) return 'audio';
        if (/^video\//.test(mime) || /\.(mp4|webm|mov)$/.test(name)) return 'video';
        if (/\.(pdf|docx|xlsx|txt|md)$/.test(name) || /^(application\/pdf|text\/plain|text\/markdown)/.test(mime)) return 'attachment';
        return 'image';
    }

    function fontFamilyFromFile(file) {
        return String(file?.name || '自定义字体').replace(/\.(ttf|otf|woff2?)$/i, '').replace(/[._-]+/g, ' ').trim().slice(0, 80) || '自定义字体';
    }

    // ==========================================
    // 1. 远程演示与全屏展示会话
    // ==========================================
    async function startRemotePresentation(state, { toast } = {}) {
        if (!state.active?.id || state.active?.isOwner === false) {
            toast?.('只有文稿所有者或管理员可以发起远程投屏。', 'warning');
            return;
        }
        const minutes = await window.Pivot.legacy.showInputPrompt?.({ title: '远程投屏', message: '投屏链接有效分钟数（5–1440）', value: '60', required: true, width: 440 });
        if (!minutes) return;
        const data = await requestJson(API + '/' + encodeURIComponent(state.active.id) + '/remote-sessions', jsonOptions({ ttlMinutes: Number(minutes) || 60 }));
        state.remoteSession = data.session;
        byId('presentation-remote-start-btn')?.classList.add('hidden');
        byId('presentation-remote-stop-btn')?.classList.remove('hidden');
        const url = new URL(data.displayUrl, window.location.origin).toString();
        try { await navigator.clipboard?.writeText(url); } catch (_) {}
        const opened = window.open(url, 'pivot-presentation-display', 'noopener,noreferrer');
        if (!opened) toast?.('远程投屏链接已复制，请在展示设备浏览器中打开。', 'warning');
        else toast?.('远程展示已打开，链接已复制。');
    }

    async function syncRemoteSlide(state) {
        const slide = state.active?.content?.slides?.find(s => s.id === state.selectedSlideId) || state.active?.content?.slides?.[0];
        if (!state.remoteSession?.id || !slide) return;
        await requestJson(API + '/remote-sessions/' + encodeURIComponent(state.remoteSession.id) + '/slide', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ slideIndex: slide.index })
        });
    }

    async function stopRemotePresentation(state, { toast } = {}) {
        if (!state.remoteSession?.id) return;
        await requestJson(API + '/remote-sessions/' + encodeURIComponent(state.remoteSession.id), { method: 'DELETE' });
        state.remoteSession = null;
        byId('presentation-remote-start-btn')?.classList.remove('hidden');
        byId('presentation-remote-stop-btn')?.classList.add('hidden');
        toast?.('远程投屏已结束。');
    }

    // ==========================================
    // 2. 演讲者视图与全屏提词器
    // ==========================================
    function presenterTextElement(element, state) {
        const node = document.createElement(element.type === 'image' ? 'img' : 'div');
        node.className = 'presentation-presenter-element presentation-presenter-' + element.type;
        node.style.left = (Number(element.x || 0) / 12.8) + '%';
        node.style.top = (Number(element.y || 0) / 7.2) + '%';
        node.style.width = (Number(element.width || 0) / 12.8) + '%';
        node.style.height = (Number(element.height || 0) / 7.2) + '%';
        node.style.zIndex = String(element.zIndex || 0);
        if (element.type === 'text') {
            node.textContent = element.content?.text || '';
            node.style.fontFamily = element.style?.fontFamily || 'Microsoft YaHei';
            node.style.fontSize = Math.max(9, Number(element.style?.fontSize || 18) * 0.55) + 'px';
            node.style.fontWeight = String(element.style?.fontWeight || 400);
            node.style.color = element.style?.color || '#1F2937';
            node.style.textAlign = element.style?.align || 'left';
            node.style.lineHeight = String(element.style?.lineHeight || 1.3);
        } else if (element.type === 'shape') {
            node.style.background = element.style?.fill || '#FFFFFF';
            node.style.border = Math.max(1, Number(element.style?.strokeWidth || 1)) + 'px solid ' + (element.style?.stroke || '#CBD5E1');
            node.style.borderRadius = (element.shapeType === 'ellipse' ? '50%' : Math.max(0, Number(element.style?.radius || 0) * 0.55) + 'px');
        } else if (element.type === 'image') {
            node.src = API + '/assets/content/by-ref?ref=' + encodeURIComponent(element.assetRef) + '&presentationId=' + encodeURIComponent(state.active?.id || '');
            node.alt = element.alt || '';
            node.style.objectFit = element.fit === 'contain' ? 'contain' : element.fit === 'stretch' ? 'fill' : 'cover';
        } else {
            node.textContent = element.title || (element.type === 'chart' ? '图表' : '表格');
            node.style.fontSize = '14px';
            node.style.padding = '10px';
            node.style.border = '1px solid #CBD5E1';
            node.style.background = '#FFFFFF';
        }
        return node;
    }

    function renderPresenterMode(state) {
        const content = state.active?.content;
        if (!content?.slides?.length) return;
        state.presenterIndex = Math.max(0, Math.min(state.presenterIndex, content.slides.length - 1));
        const slide = content.slides[state.presenterIndex];
        const preview = byId('presentation-presenter-preview');
        if (preview) {
            preview.replaceChildren();
            const canvas = document.createElement('div');
            canvas.className = 'presentation-presenter-canvas';
            canvas.style.background = slide.background?.fill || '#FFFFFF';
            (slide.elements || []).filter(item => item.visible !== false).sort((a, b) => Number(a.zIndex || 0) - Number(b.zIndex || 0)).forEach(item => canvas.appendChild(presenterTextElement(item, state)));
            preview.appendChild(canvas);
        }
        const notes = byId('presentation-presenter-notes-text');
        if (notes) notes.textContent = slide.speakerNotes || '本页暂无备注。';
        const counter = byId('presentation-presenter-counter');
        if (counter) counter.textContent = '第 ' + (state.presenterIndex + 1) + ' / ' + content.slides.length + ' 页';
        byId('presentation-presenter-prev-btn')?.toggleAttribute('disabled', state.presenterIndex <= 0);
        byId('presentation-presenter-next-btn')?.toggleAttribute('disabled', state.presenterIndex >= content.slides.length - 1);
    }

    function updatePresenterTimer(state) {
        const target = byId('presentation-presenter-timer');
        if (!target || !state.presenterStartedAt) return;
        const seconds = Math.max(0, Math.floor((Date.now() - state.presenterStartedAt) / 1000));
        target.textContent = String(Math.floor(seconds / 60)).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0');
    }

    async function openPresenterMode(state, { saveActive, syncRemoteSlide } = {}) {
        const content = state.active?.content;
        if (!content) return;
        await saveActive?.({ force: true });
        const slide = content.slides?.find(s => s.id === state.selectedSlideId) || content.slides?.[0];
        state.presenterIndex = Math.max(0, content.slides.findIndex(item => item.id === slide?.id));
        state.presenterStartedAt = Date.now();
        clearInterval(state.presenterTimer);
        state.presenterTimer = window.setInterval(() => updatePresenterTimer(state), 1000);
        updatePresenterTimer(state);
        renderPresenterMode(state);
        byId('presentation-presenter-modal')?.classList.remove('hidden');
    }

    function closePresenterMode(state) {
        clearInterval(state.presenterTimer);
        state.presenterTimer = null;
        state.presenterStartedAt = 0;
        byId('presentation-presenter-modal')?.classList.add('hidden');
    }

    function movePresenterSlide(delta, state, { syncRemoteSlide } = {}) {
        const slides = state.active?.content?.slides || [];
        const next = state.presenterIndex + delta;
        if (next < 0 || next >= slides.length) return;
        state.presenterIndex = next;
        state.selectedSlideId = slides[next].id;
        state.selectedElementId = '';
        renderPresenterMode(state);
        syncRemoteSlide?.().catch(() => {});
    }

    function renderSpeakerNotes(state) {
        const input = byId('presentation-speaker-notes');
        const slide = state.active?.content?.slides?.find(s => s.id === state.selectedSlideId) || state.active?.content?.slides?.[0];
        if (input && document.activeElement !== input) input.value = slide?.speakerNotes || '';
    }

    // ==========================================
    // 3. 组织/部门模板管理、审核与导入导出
    // ==========================================
    function renderTemplatePanel(state, { templateById, renderTemplates } = {}) {
        renderTemplates?.(byId('presentation-template-list'));
        const canManage = typeof isAdminUser === 'function' && isAdminUser();
        byId('presentation-save-template-btn')?.classList.toggle('hidden', !canManage);
        byId('presentation-save-department-template-btn')?.classList.toggle('hidden', !canManage);
        const currentTemplate = templateById?.(state.active?.content?.template?.id || state.active?.template?.id);
        byId('presentation-submit-template-review-btn')?.classList.toggle('hidden', !canManage || !currentTemplate || currentTemplate.ownerType === 'system' || !['draft', 'unpublished'].includes(currentTemplate.status));
        byId('presentation-review-template-btn')?.classList.toggle('hidden', !canManage || currentTemplate?.status !== 'pending_review');
        byId('presentation-import-template-btn')?.classList.toggle('hidden', !canManage);
    }

    async function saveAsTemplate(scope = 'organization', state, { templateById, renderTemplatePanel, renderLibrary, selectedElement, toast } = {}) {
        if (!state.active?.content) return;
        const scopeLabel = scope === 'department' ? '部门' : '组织';
        const name = await window.Pivot.legacy.showInputPrompt?.({ title: '保存为' + scopeLabel + '模板', message: '模板名称', value: state.active.content.title + ' 模板', required: true, width: 480 });
        if (!name) return;
        let departmentName = '';
        if (scope === 'department') {
            departmentName = await window.Pivot.legacy.showInputPrompt?.({ title: '部门模板范围', message: '部门名称', value: '', required: true, width: 480 });
            if (!departmentName) return;
        }
        const currentTemplate = templateById?.(state.active.template?.id);
        const useBrandControls = await window.Pivot.legacy.showConfirm?.('品牌控制', '是否将当前选中的图片作为锁定 Logo，并为模板设置锁定页脚、页码和字体？') === true;
        let brandControls = currentTemplate?.definition?.brandControls || {};
        if (useBrandControls) {
            const footerText = await window.Pivot.legacy.showInputPrompt?.({ title: '品牌页脚', message: '页脚文字（可留空）', value: brandControls.footerText || '', width: 520 }) || '';
            const element = selectedElement?.();
            const selectedLogo = element?.type === 'image' ? element.assetRef : '';
            if (selectedLogo) await requestJson(API + '/assets/publish', jsonOptions({ ref: selectedLogo, scope, departmentName }));
            brandControls = { footerText, logoAssetRef: selectedLogo || brandControls.logoAssetRef || '', lockBrandElements: true, lockFonts: true, showPageNumber: true };
        }
        const definition = { theme: state.active.content.theme, layouts: currentTemplate?.definition?.layouts || [], brandControls };
        const data = await requestJson(API + '/templates', jsonOptions({ name, description: '由 ' + state.active.content.title + ' 保存的' + scopeLabel + '模板', definition, aspectRatio: state.active.content.aspectRatio, scope, departmentName, publish: true }));
        state.templates.push(data.template);
        renderTemplatePanel?.();
        renderLibrary?.();
        toast?.(scopeLabel + '模板已提交审核，审核通过后对授权用户可见。');
    }

    async function submitCurrentTemplateReview(state, { templateById, renderTemplatePanel, toast } = {}) {
        const templateId = state.active?.content?.template?.id || state.active?.template?.id;
        const template = templateById?.(templateId);
        if (!template || template.ownerType === 'system') return;
        const data = await requestJson(API + '/templates/' + encodeURIComponent(templateId) + '/submit-review', { method: 'POST' });
        state.templates = state.templates.map(item => item.id === templateId ? data.template : item);
        renderTemplatePanel?.();
        toast?.('模板已提交审核。');
    }

    async function reviewCurrentTemplate(state, { templateById, renderTemplatePanel, toast } = {}) {
        const templateId = state.active?.content?.template?.id || state.active?.template?.id;
        const template = templateById?.(templateId);
        if (!template || template.status !== 'pending_review') return;
        const note = await window.Pivot.legacy.showInputPrompt?.({ title: '审核模板', message: '审核说明', value: '已完成素材、字体和布局检查', required: true, width: 520 });
        if (!note) return;
        const data = await requestJson(API + '/templates/' + encodeURIComponent(templateId) + '/review', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ approved: true, note }) });
        state.templates = state.templates.map(item => item.id === templateId ? data.template : item);
        renderTemplatePanel?.();
        toast?.('模板已审核通过。');
    }

    async function exportCurrentTemplate(state, { templateById, toast } = {}) {
        const templateId = state.active?.content?.template?.id || state.active?.template?.id;
        if (!templateId) return;
        const response = await apiFetch(`${API}/templates/${encodeURIComponent(templateId)}/package`);
        if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            throw new Error(data?.error || '导出模板失败。');
        }
        downloadBlob(`${templateById?.(templateId)?.name || 'PPT模板'}.pivot-ppt-template.json`, await response.blob());
        toast?.('模板包已开始下载。');
    }

    async function importTemplatePackage(file, state, { renderTemplatePanel, renderLibrary, toast } = {}) {
        if (!file) return;
        const form = new FormData();
        form.append('file', file);
        const data = await requestJson(`${API}/templates/import`, { method: 'POST', body: form });
        state.templates.push(data.template);
        renderTemplatePanel?.();
        renderLibrary?.();
        const warnings = Array.isArray(data.template?.importWarnings) ? data.template.importWarnings : [];
        toast?.(warnings.length ? '模板已导入并提交审核；有 ' + warnings.length + ' 项兼容性提示。' : '模板已导入并提交审核，审核通过后对组织用户可见。', warnings.length ? 'warning' : 'success');
    }

    // ==========================================
    // 4. 素材、字体与富媒体管理
    // ==========================================
    async function loadAssets(state) {
        const data = await requestJson(API + '/assets?limit=120', { cache: 'no-store' });
        state.assets = Array.isArray(data.assets) ? data.assets : [];
        renderAssetsPanel(state);
    }

    function renderAssetsPanel(state) {
        const list = byId('presentation-assets-list');
        if (!list) return;
        list.replaceChildren();
        if (!state.assets.length) {
            const empty = document.createElement('div');
            empty.className = 'presentation-empty-note';
            empty.textContent = '暂无可访问素材。可通过字体、音视频、附件或图片按钮添加。';
            list.appendChild(empty);
            return;
        }
        state.assets.forEach(asset => {
            const row = document.createElement('article');
            row.className = 'presentation-asset-row';
            const info = document.createElement('div');
            const title = document.createElement('strong');
            title.textContent = ({ image: '图片', font: '字体', audio: '音频', video: '视频', attachment: '附件' }[asset.assetType] || '素材') + ' · ' + asset.filename;
            const meta = document.createElement('small');
            meta.textContent = Math.max(1, Math.round(asset.byteSize / 1024)) + ' KB · ' + (asset.scope === 'department' ? '部门' : asset.scope === 'organization' ? '组织' : '个人');
            info.append(title, meta);
            const actions = document.createElement('div');
            if (asset.assetType === 'font') {
                ['heading', 'body'].forEach(kind => {
                    const btn = document.createElement('button');
                    btn.type = 'button';
                    btn.className = 'btn-secondary';
                    btn.textContent = kind === 'heading' ? '设为标题' : '设为正文';
                    btn.dataset.presentationAssetAction = 'font-' + kind;
                    btn.dataset.presentationAssetRef = asset.ref;
                    actions.appendChild(btn);
                });
            } else {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'btn-secondary';
                btn.textContent = '插入';
                btn.dataset.presentationAssetAction = 'insert';
                btn.dataset.presentationAssetRef = asset.ref;
                actions.appendChild(btn);
            }
            row.append(info, actions);
            list.appendChild(row);
        });
    }

    function applyFontAsset(asset, kind, state, { recordHistory, renderEditor, toast } = {}) {
        const content = state.active?.content;
        if (!content) return;
        const family = fontFamilyFromFile({ name: asset.filename });
        content.theme.fonts[kind] = family;
        content.theme.fontAssets = { ...(content.theme.fontAssets || {}), [kind]: asset.ref };
        recordHistory?.();
        renderEditor?.();
        toast?.('已应用 ' + asset.filename + ' 为' + (kind === 'heading' ? '标题' : '正文') + '字体。');
    }

    function insertAssetFromLibrary(asset, state, { recordHistory, renderEditor } = {}) {
        const slide = state.active?.content?.slides?.find(s => s.id === state.selectedSlideId) || state.active?.content?.slides?.[0];
        if (!slide) return;
        const id = asset.assetType + '_' + Date.now();
        if (asset.assetType === 'audio' || asset.assetType === 'video') {
            slide.elements.push({ id, type: 'media', mediaType: asset.assetType, assetRef: asset.ref, posterAssetRef: '', x: 160, y: 220, width: asset.assetType === 'video' ? 720 : 420, height: asset.assetType === 'video' ? 405 : 90, rotation: 0, zIndex: 9, locked: false, visible: true, sourceRefs: [], autoPlay: false, loop: false, showControls: true, alt: asset.filename });
        } else if (asset.assetType === 'attachment') {
            slide.elements.push({ id, type: 'attachment', assetRef: asset.ref, filename: asset.filename, description: '', x: 160, y: 420, width: 480, height: 70, rotation: 0, zIndex: 9, locked: false, visible: true, sourceRefs: [] });
        } else if (asset.assetType === 'image') {
            slide.elements.push({ id, type: 'image', assetRef: asset.ref, x: 180, y: 180, width: 600, height: 360, rotation: 0, zIndex: 8, locked: false, visible: true, sourceRefs: [], fit: 'cover', opacity: 1, intrinsicWidth: Number(asset.pixelWidth || 0), intrinsicHeight: Number(asset.pixelHeight || 0), alt: asset.filename });
        } else return;
        state.selectedElementId = id;
        recordHistory?.();
        renderEditor?.();
    }

    async function uploadRichAsset(file, state, { setSaveState, recordHistory, renderEditor, toast } = {}) {
        const slide = state.active?.content?.slides?.find(s => s.id === state.selectedSlideId) || state.active?.content?.slides?.[0];
        if (!file || !slide) return;
        const detectedType = inferAssetType(file);
        const assetType = state.pendingAssetType === 'media' ? detectedType : (state.pendingAssetType || detectedType);
        const form = new FormData();
        form.append('file', file);
        form.append('assetType', assetType);
        setSaveState?.('正在上传素材…', 'saving');
        try {
            const data = await requestJson(API + '/assets', { method: 'POST', body: form });
            const asset = data.asset;
            const id = assetType + '_' + Date.now();
            if (assetType === 'font') {
                const family = await window.Pivot.legacy.showInputPrompt?.({ title: '应用自定义字体', message: '字体名称', value: fontFamilyFromFile(file), required: true, width: 480 });
                if (!family) return;
                const heading = await window.Pivot.legacy.showConfirm?.('字体用途', '将此字体应用于标题？选择“取消”则应用于正文。');
                const kind = heading ? 'heading' : 'body';
                state.active.content.theme.fonts[kind] = family;
                state.active.content.theme.fontAssets = { ...(state.active.content.theme.fontAssets || {}), [kind]: asset.ref };
                recordHistory?.();
                renderEditor?.();
                toast?.('已将字体应用于' + (heading ? '标题' : '正文') + '。');
                return;
            }
            if (assetType === 'audio' || assetType === 'video') {
                slide.elements.push({ id, type: 'media', mediaType: assetType, assetRef: asset.ref, posterAssetRef: '', x: 160, y: 220, width: assetType === 'video' ? 720 : 420, height: assetType === 'video' ? 405 : 90, rotation: 0, zIndex: 9, locked: false, visible: true, sourceRefs: [], autoPlay: false, loop: false, showControls: true, alt: asset.filename });
            } else if (assetType === 'attachment') {
                slide.elements.push({ id, type: 'attachment', assetRef: asset.ref, filename: asset.filename, description: '', x: 160, y: 420, width: 480, height: 70, rotation: 0, zIndex: 9, locked: false, visible: true, sourceRefs: [] });
            } else {
                slide.elements.push({ id, type: 'image', x: 180, y: 180, width: 600, height: 360, rotation: 0, zIndex: 8, locked: false, visible: true, sourceRefs: [], assetRef: asset.ref, fit: 'cover', opacity: 1, intrinsicWidth: Number(asset.pixelWidth || 0), intrinsicHeight: Number(asset.pixelHeight || 0), alt: asset.filename });
            }
            state.selectedElementId = id;
            recordHistory?.();
            renderEditor?.();
            toast?.('素材已插入。');
        } finally {
            state.pendingAssetType = '';
            setSaveState?.('待保存', 'dirty');
        }
    }

    // ==========================================
    // 5. 性能与运维指标面板
    // ==========================================
    async function loadPresentationMetrics() {
        const data = await requestJson(API + '/metrics', { cache: 'no-store' });
        const counters = Array.isArray(data.metrics?.counters) ? data.metrics.counters : [];
        const durations = Array.isArray(data.metrics?.histograms) ? data.metrics.histograms : [];
        const summary = byId('presentation-metrics-summary');
        if (summary) summary.textContent = '操作计数 ' + counters.reduce((sum, item) => sum + Number(item.value || 0), 0) + ' · 耗时样本 ' + durations.reduce((sum, item) => sum + Number(item.count || 0), 0);
        const list = byId('presentation-metrics-list');
        if (!list) return;
        list.replaceChildren();
        [...counters.map(item => ({ title: (item.labels.operation || item.name) + ' · ' + (item.labels.outcome || 'count'), body: String(item.value) })), ...durations.map(item => ({ title: (item.labels.operation || item.name) + ' · 平均耗时', body: item.count ? Math.round(item.sumMs / item.count) + ' ms（' + item.count + ' 次）' : '暂无样本' }))].forEach(item => {
            const row = document.createElement('div');
            row.className = 'presentation-issue';
            const title = document.createElement('strong');
            title.textContent = item.title;
            const body = document.createElement('span');
            body.textContent = item.body;
            row.append(title, body);
            list.appendChild(row);
        });
        if (!list.children.length) {
            const empty = document.createElement('div');
            empty.className = 'presentation-empty-note';
            empty.textContent = '暂无指标样本。';
            list.appendChild(empty);
        }
    }

    // ==========================================
    // 6. 数据分析图表生成与绑定
    // ==========================================
    function populateChartDatasetSelect(state) {
        const select = byId('presentation-chart-dataset');
        if (!select) return;
        select.replaceChildren();
        if (!state.dataSets.length) {
            const option = document.createElement('option');
            option.value = '';
            option.textContent = '暂无可用数据集';
            select.appendChild(option);
            return;
        }
        state.dataSets.forEach(dataset => {
            const option = document.createElement('option');
            option.value = dataset.id;
            option.textContent = dataset.name || dataset.id;
            select.appendChild(option);
        });
    }

    function populateChartFields(dataset) {
        const x = byId('presentation-chart-x-field');
        const y = byId('presentation-chart-y-field');
        if (!x || !y) return;
        x.replaceChildren();
        y.replaceChildren();
        const columns = dataset?.columns || [];
        const normalized = columns.map(column => ({ key: column.key || column.name || column, name: column.name || column.key || column, type: column.type || '' }));
        normalized.forEach(column => {
            const option = document.createElement('option');
            option.value = column.key;
            option.textContent = column.name;
            x.appendChild(option);
        });
        const countOption = document.createElement('option');
        countOption.value = '';
        countOption.textContent = '（计数时无需数值字段）';
        y.appendChild(countOption);
        normalized.filter(column => /number|integer|decimal|float|double/i.test(column.type) || column.isNumeric === true).forEach(column => {
            const option = document.createElement('option');
            option.value = column.key;
            option.textContent = column.name;
            y.appendChild(option);
        });
        if (y.options.length === 1) {
            normalized.slice(0, 1).forEach(column => {
                const option = document.createElement('option');
                option.value = column.key;
                option.textContent = `${column.name}（将尝试转为数值）`;
                y.appendChild(option);
            });
        }
    }

    async function loadChartDatasetFields() {
        const id = byId('presentation-chart-dataset')?.value;
        if (!id) return;
        const data = await requestJson(`/api/apps/data-analysis/datasets/${encodeURIComponent(id)}`);
        populateChartFields(data.dataset);
    }

    async function openDataChartModal(state, { toast } = {}) {
        const data = await requestJson('/api/apps/data-analysis/datasets');
        state.dataSets = Array.isArray(data.datasets) ? data.datasets : [];
        if (!state.dataSets.length) {
            toast?.('请先在“数据分析”应用中导入数据集。', 'warning');
            return;
        }
        populateChartDatasetSelect(state);
        await loadChartDatasetFields();
        byId('presentation-data-chart-modal')?.classList.remove('hidden');
    }

    async function importDataChart(state, { recordHistory, renderEditor, toast } = {}) {
        const datasetId = byId('presentation-chart-dataset')?.value;
        const xField = byId('presentation-chart-x-field')?.value;
        const yField = byId('presentation-chart-y-field')?.value;
        if (!datasetId || !xField) {
            toast?.('请选择数据集和分类字段。', 'error');
            return;
        }
        const button = byId('presentation-data-chart-submit-btn');
        button?.setAttribute('disabled', '');
        if (button) button.textContent = '正在生成…';
        try {
            const data = await requestJson(`${API}/data-chart`, jsonOptions({
                datasetId,
                xField,
                yField,
                chartType: byId('presentation-chart-type')?.value || 'bar',
                aggregation: yField ? (byId('presentation-chart-aggregation')?.value || 'sum') : 'count',
                title: byId('presentation-chart-title')?.value || ''
            }));
            const chart = data.chart;
            const id = `chart_${Date.now()}`;
            const sourceId = `dataset_${datasetId}`;
            const dataset = state.dataSets.find(item => String(item.id) === String(datasetId));
            const content = state.active?.content;
            if (content && !content.sources.some(source => source.id === sourceId)) {
                content.sources.push({ id: sourceId, title: dataset?.name || `数据集 ${datasetId}`, type: 'data_analysis', locator: chart.binding?.queryDigest || '', digest: '' });
            }
            const slide = content?.slides?.find(s => s.id === state.selectedSlideId) || content?.slides?.[0];
            if (slide) {
                slide.elements.push({ id, ...chart, x: 180, y: 210, width: 720, height: 360, rotation: 0, zIndex: 7, locked: false, visible: true, sourceRefs: [sourceId] });
            }
            state.selectedElementId = id;
            byId('presentation-data-chart-modal')?.classList.add('hidden');
            recordHistory?.();
            renderEditor?.();
            toast?.('数据图表已插入，来源引用已保留。');
        } finally {
            button?.removeAttribute('disabled');
            if (button) button.textContent = '插入图表';
        }
    }

    // ==========================================
    // 7. 版本列表与回滚
    // ==========================================
    function renderVersions(state, { formatTime } = {}) {
        const list = byId('presentation-versions-list');
        if (!list) return;
        list.replaceChildren();
        if (!state.versions.length) {
            const empty = document.createElement('div');
            empty.className = 'presentation-empty-note';
            empty.textContent = '暂无可恢复版本。保存后会自动在这里留下版本记录。';
            list.appendChild(empty);
            return;
        }
        state.versions.forEach(version => {
            const row = document.createElement('article');
            row.className = 'presentation-version-row';
            const info = document.createElement('div');
            const title = document.createElement('strong');
            title.textContent = `版本 ${version.version}`;
            const meta = document.createElement('span');
            meta.textContent = `${formatTime?.(version.createdAt) || version.createdAt} · ${version.note || '保存演示文稿'}`;
            info.append(title, meta);
            const restore = document.createElement('button');
            restore.type = 'button';
            restore.className = 'btn-secondary';
            restore.dataset.presentationRestoreVersion = String(version.version);
            restore.textContent = '恢复';
            row.append(info, restore);
            list.appendChild(row);
        });
    }

    async function loadVersions(state, { formatTime } = {}) {
        if (!state.active?.id) return;
        const data = await requestJson(`${API}/${encodeURIComponent(state.active.id)}/versions`);
        state.versions = Array.isArray(data.versions) ? data.versions : [];
        renderVersions(state, { formatTime });
    }

    async function restoreVersion(version, state, { saveActive, resetHistory, renderEditor, formatTime, toast } = {}) {
        if (!state.active?.id) return;
        const accepted = await window.Pivot.legacy.showConfirm?.('恢复演示文稿版本', `将以历史版本 ${version} 创建一个新的当前版本，当前内容仍会保留在版本历史中。`);
        if (!accepted) return;
        await saveActive?.({ force: true });
        const data = await requestJson(`${API}/${encodeURIComponent(state.active.id)}/rollback`, jsonOptions({ version, note: `用户恢复版本 ${version}` }));
        state.active = data.presentation;
        state.selectedSlideId = state.active.content?.slides?.[0]?.id || '';
        state.selectedElementId = '';
        resetHistory?.();
        renderEditor?.();
        await loadVersions(state, { formatTime });
        toast?.(`已恢复版本 ${version}。`);
    }

    // ==========================================
    // 8. 产物导出 PPTX / PDF / PNG
    // ==========================================
    async function exportPresentation(format, state, { saveActive, setSaveState, activeSlide, toast } = {}) {
        if (!state.active?.id) return;
        await saveActive?.({ force: true });
        setSaveState?.(`正在导出 ${format.toUpperCase()}…`, 'saving');
        try {
            const options = state.exportOptions || {};
            const created = await requestJson(`${API}/${encodeURIComponent(state.active.id)}/export`, jsonOptions({
                format, aspectRatio: options.aspectRatio || state.active.content?.aspectRatio || '16:9', includeNotes: options.includeNotes !== false, includePageNumbers: options.includePageNumbers !== false, showSourceRefs: options.showSourceRefs !== false, imageQuality: options.imageQuality || 'standard', fontStrategy: options.fontStrategy || 'embed',
                ...(format === 'png' ? { slideIndex: activeSlide?.()?.index || 0 } : {})
            }));
            const rendition = created.rendition;
            const tokenResult = await requestJson(`/api/agents/renditions/${encodeURIComponent(rendition.id)}/download-token`, jsonOptions({}));
            const response = await apiFetch(`/api/agents/renditions/${encodeURIComponent(rendition.id)}/download?token=${encodeURIComponent(tokenResult.token)}`);
            if (!response.ok) throw new Error('下载导出文件失败。');
            downloadBlob(`${state.active.content.title || '演示文稿'}.${format}`, await response.blob());
            toast?.(`${format.toUpperCase()} 已生成并开始下载。`);
        } finally {
            setSaveState?.('已保存', 'saved');
        }
    }

    // ==========================================
    // 9. 智能布局与版式调整
    // ==========================================
    function populateLayoutSelect(slide, state, templateById) {
        const select = byId('presentation-layout-select');
        if (!select) return;
        const template = templateById?.(state.active?.template?.id);
        const layouts = template?.definition?.layouts || [];
        select.replaceChildren();
        layouts.forEach(layout => {
            const option = document.createElement('option');
            option.value = layout.id;
            option.textContent = layout.name;
            option.selected = layout.id === slide?.layoutId;
            select.appendChild(option);
        });
    }

    function applyLayoutToSlide(layoutId, state) {
        const slide = state.active?.content?.slides?.find(s => s.id === state.selectedSlideId) || state.active?.content?.slides?.[0];
        if (!slide) return;
        const textElements = slide.elements.filter(element => element.type === 'text').sort((a, b) => (b.style?.fontSize || 0) - (a.style?.fontSize || 0));
        const title = textElements[0];
        const body = textElements.filter(element => element !== title);
        const nonTitle = slide.elements.filter(element => element !== title);
        if (layoutId === 'cover' && title) {
            title.x = 88; title.y = 205; title.width = 1104; title.height = 96; title.style.align = 'center';
            body.forEach((element, index) => { element.x = 180; element.y = 345 + index * 72; element.width = 920; element.height = 54; if (element.type === 'text') element.style.align = 'center'; });
        }
        if (layoutId === 'section' && title) { title.x = 130; title.y = 280; title.width = 1020; title.height = 100; title.style.align = 'center'; title.style.fontSize = Math.max(36, title.style.fontSize); }
        if (layoutId === 'title-content' && title) {
            title.x = 80; title.y = 58; title.width = 1120; title.height = 72; title.style.align = 'left';
            body.forEach((element, index) => { element.x = 100; element.y = 180 + index * 200; element.width = 1040; element.height = index ? 150 : 390; });
        }
        if (layoutId === 'two-column' && title) {
            title.x = 80; title.y = 54; title.width = 1120; title.height = 72;
            nonTitle.forEach((element, index) => { const column = index % 2; const row = Math.floor(index / 2); element.x = 80 + column * 570; element.y = 170 + row * 250; element.width = 530; element.height = 220; });
        }
        if (layoutId === 'three-card' && title) {
            title.x = 80; title.y = 54; title.width = 1120; title.height = 72;
            nonTitle.forEach((element, index) => { element.x = 70 + (index % 3) * 390; element.y = 190 + Math.floor(index / 3) * 240; element.width = 350; element.height = 210; });
        }
        if (layoutId === 'image-focus' && title) {
            title.x = 80; title.y = 54; title.width = 1120; title.height = 72;
            nonTitle.forEach((element, index) => { element.x = index === 0 ? 80 : 810; element.y = index === 0 ? 160 : 185; element.width = index === 0 ? 670 : 330; element.height = index === 0 ? 420 : 260; });
        }
        if ((layoutId === 'chart' || layoutId === 'table') && title) {
            title.x = 80; title.y = 54; title.width = 1120; title.height = 72;
            nonTitle.forEach((element, index) => { element.x = index === 0 ? 80 : 930; element.y = index === 0 ? 155 : 185; element.width = index === 0 ? 800 : 240; element.height = index === 0 ? 440 : 290; });
        }
        if (layoutId === 'quote') {
            nonTitle.forEach((element, index) => { element.x = 160; element.y = 190 + index * 220; element.width = 960; element.height = 170; if (element.type === 'text') element.style.align = 'center'; });
        }
        if (layoutId === 'summary' && title) {
            title.x = 80; title.y = 54; title.width = 1120; title.height = 72;
            nonTitle.forEach((element, index) => { element.x = 110; element.y = 175 + index * 160; element.width = 1010; element.height = 125; });
        }
        slide.layoutId = layoutId;
    }

    // ==========================================
    // 10. Agent 产物转 PPT
    // ==========================================
    async function openArtifactCreateModal(populateTemplateSelect, toast) {
        const data = await requestJson('/api/agents/artifacts?limit=100');
        const artifacts = Array.isArray(data.data) ? data.data : [];
        const select = byId('presentation-artifact-select');
        if (!select) return;
        select.replaceChildren();
        artifacts.forEach(artifact => {
            const option = document.createElement('option');
            option.value = artifact.id;
            option.textContent = (artifact.type || '产物') + ' · ' + (artifact.title || ('产物 ' + artifact.id));
            select.appendChild(option);
        });
        populateTemplateSelect?.(byId('presentation-artifact-template'));
        if (!artifacts.length) {
            toast?.('当前没有可转换的 Agent 文本产物。', 'warning');
            return;
        }
        byId('presentation-artifact-modal')?.classList.remove('hidden');
    }

    async function createFromArtifact(state, { loadDocuments, openPresentation, toast } = {}) {
        const artifactId = byId('presentation-artifact-select')?.value;
        if (!artifactId) return;
        const title = byId('presentation-artifact-title-input')?.value.trim() || '';
        const templateId = byId('presentation-artifact-template')?.value || 'business-blue';
        const data = await requestJson(API + '/from-artifact/' + encodeURIComponent(artifactId), jsonOptions({ title, templateId }));
        byId('presentation-artifact-modal')?.classList.add('hidden');
        await loadDocuments?.();
        await openPresentation?.(data.presentation.id);
        toast?.('已从 Agent 产物创建可编辑 PPT。');
    }

    // ==========================================
    // 11. 表格与图表渲染
    // ==========================================
    function renderTableElement(node, element, zoom = 0.65) {
        const table = document.createElement('table');
        const head = document.createElement('thead'); const body = document.createElement('tbody');
        const makeRow = (cells, header) => { const row = document.createElement('tr'); cells.forEach(cell => { const item = document.createElement(header ? 'th' : 'td'); item.textContent = cell; row.appendChild(item); }); return row; };
        head.appendChild(makeRow(element.columns || [], true));
        (element.rows || []).forEach(row => body.appendChild(makeRow(row, false)));
        table.append(head, body);
        table.style.setProperty('--presentation-header-fill', element.style?.headerFill || '#1769AA');
        table.style.setProperty('--presentation-header-color', element.style?.headerColor || '#FFFFFF');
        table.style.setProperty('--presentation-cell-fill', element.style?.cellFill || '#FFFFFF');
        table.style.setProperty('--presentation-cell-color', element.style?.cellColor || '#1F2937');
        table.style.setProperty('--presentation-border-color', element.style?.borderColor || '#CBD5E1');
        table.style.fontSize = `${Number(element.style?.fontSize || 14) * zoom}px`;
        node.appendChild(table);
    }

    function renderChartElement(node, element) {
        const values = (element.data?.rows || []).map(row => Number(row[1]) || 0);
        const max = Math.max(1, ...values.map(value => Math.abs(value)));
        const palette = element.options?.colors?.length ? element.options.colors : ['#1769AA', '#5B8FF9', '#61DDAA', '#F59E0B'];
        const title = document.createElement('strong'); title.className = 'presentation-chart-title'; title.textContent = element.title || ''; node.appendChild(title);
        const chart = document.createElement('div'); chart.className = `presentation-chart presentation-chart-${element.chartType}`;
        values.forEach((value, index) => {
            const item = document.createElement('div'); item.className = 'presentation-chart-item';
            const mark = document.createElement('i'); mark.style.background = palette[index % palette.length];
            mark.style.setProperty('--chart-value', `${Math.max(4, Math.abs(value) / max * 100)}%`);
            const label = document.createElement('span'); label.textContent = String(element.data.rows[index]?.[0] || '');
            item.append(mark, label); chart.appendChild(item);
        });
        node.appendChild(chart);
    }

    window.Pivot?.exposeModule?.('apps.presentations.presenter', {
        ready: true,
        startRemotePresentation,
        syncRemoteSlide,
        stopRemotePresentation,
        presenterTextElement,
        renderPresenterMode,
        updatePresenterTimer,
        openPresenterMode,
        closePresenterMode,
        movePresenterSlide,
        renderSpeakerNotes,
        renderTemplatePanel,
        saveAsTemplate,
        submitCurrentTemplateReview,
        reviewCurrentTemplate,
        exportCurrentTemplate,
        importTemplatePackage,
        loadAssets,
        renderAssetsPanel,
        applyFontAsset,
        insertAssetFromLibrary,
        uploadRichAsset,
        loadPresentationMetrics,
        populateChartDatasetSelect,
        populateChartFields,
        loadChartDatasetFields,
        openDataChartModal,
        importDataChart,
        renderVersions,
        loadVersions,
        restoreVersion,
        exportPresentation,
        populateLayoutSelect,
        applyLayoutToSlide,
        openArtifactCreateModal,
        createFromArtifact,
        renderTableElement,
        renderChartElement
    });
})();
