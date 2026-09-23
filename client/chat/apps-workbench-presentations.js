(function () {
    if (window.Pivot?.moduleApi?.('apps.presentations')?.ready) return;

    const API = '/api/apps/presentations';
    const state = {
        templates: [],
        documents: [],
        active: null,
        selectedSlideId: '',
        selectedElementId: '',
        panel: 'properties',
        zoom: 0.65,
        history: [],
        historyIndex: -1,
        saveTimer: null,
        saving: false,
        pendingOutline: null,
        pendingCreate: null,
        imageUrls: new Map(),
        drag: null,
        dataSets: [],
        versions: []
    };

    const byId = id => document.getElementById(id);
    const deepClone = value => JSON.parse(JSON.stringify(value));

    function toast(message, type = 'success') {
        if (typeof showToast === 'function') showToast(message, type);
    }

    async function requestJson(url, options = {}) {
        const res = await apiFetch(url, options);
        const data = await res.clone().json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error?.message || data?.error || data?.message || `请求失败（${res.status}）`);
        return data;
    }

    function jsonOptions(body) {
        return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
    }

    function setStatus(message = '', type = '') {
        const element = byId('presentation-library-status');
        if (!element) return;
        element.textContent = message;
        element.dataset.type = type;
        element.classList.toggle('is-visible', Boolean(message));
    }

    function setSaveState(message = '已保存', mode = 'saved') {
        const element = byId('presentation-save-state');
        if (!element) return;
        element.textContent = message;
        element.dataset.state = mode;
    }

    function activeContent() {
        return state.active?.content || null;
    }

    function activeSlide() {
        const content = activeContent();
        return content?.slides?.find(slide => slide.id === state.selectedSlideId) || content?.slides?.[0] || null;
    }

    function selectedElement() {
        return activeSlide()?.elements?.find(element => element.id === state.selectedElementId) || null;
    }

    function resetHistory() {
        state.history = state.active?.content ? [deepClone(state.active.content)] : [];
        state.historyIndex = state.history.length - 1;
        updateUndoRedo();
    }

    function updateUndoRedo() {
        byId('presentation-undo-btn')?.toggleAttribute('disabled', state.historyIndex <= 0);
        byId('presentation-redo-btn')?.toggleAttribute('disabled', state.historyIndex >= state.history.length - 1);
    }

    function recordHistory() {
        if (!state.active?.content) return;
        const snapshot = deepClone(state.active.content);
        const current = state.history[state.historyIndex];
        if (current && JSON.stringify(current) === JSON.stringify(snapshot)) return;
        state.history.splice(state.historyIndex + 1);
        state.history.push(snapshot);
        if (state.history.length > 80) state.history.shift();
        state.historyIndex = state.history.length - 1;
        updateUndoRedo();
        scheduleSave();
    }

    function restoreHistory(index) {
        if (!state.active || !state.history[index]) return;
        state.historyIndex = index;
        state.active.content = deepClone(state.history[index]);
        state.active.title = state.active.content.title;
        renderEditor();
        scheduleSave();
    }

    function scheduleSave() {
        if (!state.active?.id) return;
        clearTimeout(state.saveTimer);
        setSaveState('待保存', 'dirty');
        state.saveTimer = window.setTimeout(() => saveActive().catch(error => {
            setSaveState('保存失败', 'error');
            toast(error.message || '保存失败，内容仍保留在当前页面。', 'error');
        }), 1200);
    }

    async function saveActive({ force = false } = {}) {
        if (!state.active?.id || state.saving) return;
        clearTimeout(state.saveTimer);
        state.saveTimer = null;
        const content = activeContent();
        if (!content) return;
        state.saving = true;
        setSaveState('保存中…', 'saving');
        try {
            const data = await requestJson(`${API}/${encodeURIComponent(state.active.id)}/content`, {
                method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ baseVersion: state.active.version, title: content.title, templateId: content.template?.id, content, note: force ? '用户主动保存' : '自动保存' })
            });
            state.active = data.presentation;
            state.active.content = data.presentation.content || content;
            state.active.validation = data.presentation.validation || state.active.validation;
            state.documents = state.documents.map(item => item.id === state.active.id ? { ...item, ...state.active } : item);
            setSaveState('已保存', 'saved');
            renderIssues();
        } finally {
            state.saving = false;
        }
    }

    function templateById(id) {
        return state.templates.find(template => template.id === id) || state.templates[0] || null;
    }

    function textElement(id, x, y, width, height, text, style = {}) {
        return { id, type: 'text', x, y, width, height, rotation: 0, zIndex: 10, locked: false, visible: true, sourceRefs: [], content: { text }, style: { fontFamily: 'Microsoft YaHei', fontSize: 20, fontWeight: 400, color: '#1F2937', align: 'left', verticalAlign: 'top', lineHeight: 1.35, italic: false, underline: false, bullet: false, padding: 0, ...style } };
    }

    function emptySlide(index) {
        const template = templateById(state.active?.template?.id);
        const theme = template?.definition?.theme || state.active?.content?.theme || {};
        return {
            id: `slide_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            index,
            type: 'content',
            layoutId: 'title-content',
            sectionId: '',
            background: { fill: theme?.colors?.background || '#FFFFFF', imageAssetRef: '', opacity: 1 },
            elements: [
                textElement('title', 80, 58, 1120, 72, '新页面标题', { fontFamily: theme?.fonts?.heading || 'Microsoft YaHei', fontSize: 32, fontWeight: 700, color: theme?.colors?.text || '#1F2937' }),
                textElement('body', 100, 180, 1040, 380, '在此输入页面内容', { fontFamily: theme?.fonts?.body || 'Microsoft YaHei', fontSize: 20, color: theme?.colors?.text || '#1F2937' })
            ],
            speakerNotes: '', sourceRefs: []
        };
    }

    function ensureView() {
        const view = byId('presentations-view');
        if (!view) throw new Error('PPT 工作台视图未加载。');
        if (view.dataset.presentationBound === '1') return view;
        view.dataset.presentationBound = '1';
        bindEvents(view);
        return view;
    }

    function hideOtherAppViews() {
        ['apps-home-view', 'official-writing-view', 'data-analysis-view', 'regulations-view', 'ocr-view', 'pdf-tools-view'].forEach(id => byId(id)?.classList.add('hidden'));
        byId('presentations-view')?.classList.remove('hidden');
        byId('apps-back-btn')?.classList.remove('hidden');
        const title = byId('apps-workspace-title');
        const desc = byId('apps-workspace-desc');
        if (title) title.textContent = 'PPT 制作';
        if (desc) desc.textContent = '从主题、模板、材料与数据生成可编辑演示文稿，并在导出前完成版式检查。';
    }

    async function loadTemplates() {
        const data = await requestJson(`${API}/templates`);
        state.templates = Array.isArray(data.templates) ? data.templates : [];
    }

    async function loadDocuments() {
        setStatus('正在加载演示文稿…');
        const data = await requestJson(`${API}?limit=100`, { cache: 'no-store' });
        state.documents = Array.isArray(data.presentations) ? data.presentations : [];
        setStatus(state.documents.length ? '' : '还没有演示文稿，选择模板后开始创建。');
        renderLibrary();
    }

    function renderTemplates(host, { compact = false } = {}) {
        if (!host) return;
        host.replaceChildren();
        state.templates.forEach(template => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = `presentation-template-card${state.active?.template?.id === template.id ? ' is-active' : ''}${compact ? ' is-compact' : ''}`;
            button.dataset.presentationTemplateId = template.id;
            const color = template.definition?.theme?.colors?.primary || '#1769AA';
            button.style.setProperty('--presentation-template-color', color);
            const title = document.createElement('strong'); title.textContent = template.name;
            const desc = document.createElement('span'); desc.textContent = template.description || '自定义主题模板';
            const tags = document.createElement('small'); tags.textContent = (template.tags || []).slice(0, 3).join(' · ') || '主题模板';
            button.append(title, desc, tags);
            host.appendChild(button);
        });
    }

    function renderLibrary() {
        const list = byId('presentation-library-list');
        renderTemplates(byId('presentation-template-strip'), { compact: true });
        if (!list) return;
        list.replaceChildren();
        if (!state.documents.length) {
            const empty = document.createElement('div'); empty.className = 'presentation-empty-state'; empty.textContent = '暂无演示文稿。可从 AI 创建、空白创建或选择上方模板开始。'; list.appendChild(empty); return;
        }
        state.documents.forEach(documentItem => {
            const card = document.createElement('article'); card.className = 'presentation-doc-card';
            const swatch = document.createElement('div'); swatch.className = 'presentation-doc-swatch'; swatch.style.background = templateById(documentItem.template?.id)?.definition?.theme?.colors?.primary || '#1769AA';
            const main = document.createElement('div'); main.className = 'presentation-doc-main';
            const title = document.createElement('strong'); title.textContent = documentItem.title;
            const meta = document.createElement('span'); meta.textContent = `版本 ${documentItem.version || 1} · ${formatTime(documentItem.updatedAt)} · ${statusLabel(documentItem.status)}`;
            main.append(title, meta);
            const actions = document.createElement('div'); actions.className = 'presentation-doc-actions';
            [['打开', 'open'], ['复制', 'duplicate'], ['删除', 'delete']].forEach(([label, action]) => { const button = document.createElement('button'); button.type = 'button'; button.className = action === 'open' ? 'btn-primary' : 'btn-secondary'; button.textContent = label; button.dataset.presentationAction = action; button.dataset.presentationId = documentItem.id; actions.appendChild(button); });
            card.append(swatch, main, actions); list.appendChild(card);
        });
    }

    function formatTime(value) {
        if (!value) return '刚刚更新';
        const date = new Date(String(value).replace(' ', 'T'));
        return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('zh-CN', { hour12: false });
    }

    function statusLabel(value) {
        return { draft: '草稿', needs_attention: '待检查', ready: '可交付', archived: '已归档' }[value] || value || '草稿';
    }

    async function openPresentation(id) {
        await saveActive({ force: true });
        setStatus('正在打开演示文稿…');
        const data = await requestJson(`${API}/${encodeURIComponent(id)}`);
        state.active = data.presentation;
        state.selectedSlideId = state.active.content?.slides?.[0]?.id || '';
        state.selectedElementId = '';
        resetHistory();
        byId('presentation-library')?.classList.add('hidden');
        byId('presentation-editor')?.classList.remove('hidden');
        setStatus('');
        renderEditor();
    }

    function closeEditor() {
        saveActive({ force: true }).catch(() => {});
        state.active = null; state.selectedSlideId = ''; state.selectedElementId = ''; state.history = []; state.historyIndex = -1;
        state.imageUrls.forEach(url => URL.revokeObjectURL(url)); state.imageUrls.clear();
        byId('presentation-editor')?.classList.add('hidden');
        byId('presentation-library')?.classList.remove('hidden');
        loadDocuments().catch(error => toast(error.message, 'error'));
    }

    function renderEditor() {
        if (!state.active?.content) return;
        const titleInput = byId('presentation-title-input');
        if (titleInput && document.activeElement !== titleInput) titleInput.value = state.active.content.title || state.active.title;
        renderSlideList(); renderStage(); renderProperties(); renderTemplatePanel(); renderIssues(); updateUndoRedo();
    }

    function renderSlideList() {
        const list = byId('presentation-slide-list');
        if (!list) return;
        list.replaceChildren();
        const content = activeContent();
        content.slides.forEach((slide, index) => {
            const button = document.createElement('button'); button.type = 'button'; button.className = `presentation-slide-thumb${slide.id === activeSlide()?.id ? ' is-active' : ''}`; button.dataset.presentationSlideId = slide.id;
            const number = document.createElement('span'); number.className = 'presentation-slide-number'; number.textContent = String(index + 1);
            const preview = document.createElement('div'); preview.className = 'presentation-slide-thumb-preview'; preview.style.background = slide.background.fill;
            const title = slide.elements.find(element => element.type === 'text' && Number(element.style?.fontSize || 0) >= 24)?.content?.text || `第 ${index + 1} 页`;
            const previewTitle = document.createElement('strong'); previewTitle.textContent = String(title).slice(0, 30); preview.appendChild(previewTitle);
            const label = document.createElement('small'); label.textContent = slide.layoutId;
            button.append(number, preview, label); list.appendChild(button);
        });
    }

    function cssElement(element) {
        const zoom = state.zoom;
        return { left: `${element.x * zoom}px`, top: `${element.y * zoom}px`, width: `${element.width * zoom}px`, height: `${element.height * zoom}px`, transform: element.rotation ? `rotate(${element.rotation}deg)` : '' };
    }

    async function renderImage(element, node) {
        const cached = state.imageUrls.get(element.assetRef);
        if (cached) { node.style.backgroundImage = `url("${cached}")`; return; }
        try {
            const res = await apiFetch(`${API}/assets/content/by-ref?ref=${encodeURIComponent(element.assetRef)}`);
            if (!res.ok) return;
            const url = URL.createObjectURL(await res.blob());
            state.imageUrls.set(element.assetRef, url);
            if (node.isConnected) node.style.backgroundImage = `url("${url}")`;
        } catch (_) {}
    }

    function renderStage() {
        const stage = byId('presentation-stage');
        const slide = activeSlide();
        if (!stage || !slide || !state.active?.content) return;
        stage.replaceChildren();
        const content = state.active.content;
        stage.style.width = `${content.width * state.zoom}px`;
        stage.style.height = `${content.height * state.zoom}px`;
        stage.style.background = slide.background.fill;
        stage.dataset.slideId = slide.id;
        if (slide.background.imageAssetRef) renderImage({ assetRef: slide.background.imageAssetRef }, stage);
        slide.elements.filter(element => element.visible).sort((a, b) => a.zIndex - b.zIndex).forEach(element => {
            const node = document.createElement('div');
            node.className = `presentation-canvas-element presentation-canvas-${element.type}${element.id === state.selectedElementId ? ' is-selected' : ''}`;
            node.dataset.presentationElementId = element.id;
            Object.assign(node.style, cssElement(element)); node.style.zIndex = String(element.zIndex || 1);
            if (element.type === 'text') {
                node.textContent = element.content?.text || '';
                node.style.fontFamily = element.style?.fontFamily || 'Microsoft YaHei'; node.style.fontSize = `${Number(element.style?.fontSize || 18) * state.zoom}px`;
                node.style.fontWeight = String(element.style?.fontWeight || 400); node.style.color = element.style?.color || '#1F2937'; node.style.textAlign = element.style?.align || 'left'; node.style.lineHeight = String(element.style?.lineHeight || 1.35); node.style.padding = `${Number(element.style?.padding || 0) * state.zoom}px`;
                node.style.justifyContent = ({ top: 'flex-start', middle: 'center', bottom: 'flex-end' })[element.style?.verticalAlign] || 'flex-start';
            } else if (element.type === 'shape') {
                node.style.background = element.style?.fill || '#FFFFFF'; node.style.borderColor = element.style?.stroke || '#CBD5E1'; node.style.borderWidth = `${Math.max(1, Number(element.style?.strokeWidth || 1) * state.zoom)}px`; node.style.opacity = String(element.style?.opacity ?? 1); node.style.borderRadius = element.shapeType === 'ellipse' ? '50%' : `${Number(element.style?.radius || 0) * state.zoom}px`;
            } else if (element.type === 'image') {
                node.style.backgroundSize = element.fit === 'contain' ? 'contain' : element.fit === 'stretch' ? '100% 100%' : 'cover'; node.style.backgroundPosition = 'center'; node.style.backgroundRepeat = 'no-repeat'; node.style.opacity = String(element.opacity ?? 1); renderImage(element, node);
            } else if (element.type === 'table') {
                renderTableElement(node, element);
            } else if (element.type === 'chart') {
                renderChartElement(node, element);
            }
            stage.appendChild(node);
        });
        const meta = byId('presentation-slide-meta');
        if (meta) meta.textContent = `第 ${slide.index + 1} / ${content.slides.length} 页 · ${slide.layoutId}`;
        populateLayoutSelect(slide);
    }

    function renderTableElement(node, element) {
        const table = document.createElement('table');
        const head = document.createElement('thead'); const body = document.createElement('tbody');
        const makeRow = (cells, header) => { const row = document.createElement('tr'); cells.forEach(cell => { const item = document.createElement(header ? 'th' : 'td'); item.textContent = cell; row.appendChild(item); }); return row; };
        head.appendChild(makeRow(element.columns || [], true)); (element.rows || []).forEach(row => body.appendChild(makeRow(row, false))); table.append(head, body); table.style.setProperty('--presentation-header-fill', element.style?.headerFill || '#1769AA'); table.style.setProperty('--presentation-header-color', element.style?.headerColor || '#FFFFFF'); table.style.setProperty('--presentation-cell-fill', element.style?.cellFill || '#FFFFFF'); table.style.setProperty('--presentation-cell-color', element.style?.cellColor || '#1F2937'); table.style.setProperty('--presentation-border-color', element.style?.borderColor || '#CBD5E1'); table.style.fontSize = `${Number(element.style?.fontSize || 14) * state.zoom}px`; node.appendChild(table);
    }

    function renderChartElement(node, element) {
        const values = (element.data?.rows || []).map(row => Number(row[1]) || 0); const max = Math.max(1, ...values.map(value => Math.abs(value))); const palette = element.options?.colors?.length ? element.options.colors : ['#1769AA', '#5B8FF9', '#61DDAA', '#F59E0B'];
        const title = document.createElement('strong'); title.className = 'presentation-chart-title'; title.textContent = element.title || ''; node.appendChild(title);
        const chart = document.createElement('div'); chart.className = `presentation-chart presentation-chart-${element.chartType}`;
        values.forEach((value, index) => { const item = document.createElement('div'); item.className = 'presentation-chart-item'; const mark = document.createElement('i'); mark.style.background = palette[index % palette.length]; mark.style.setProperty('--chart-value', `${Math.max(4, Math.abs(value) / max * 100)}%`); const label = document.createElement('span'); label.textContent = String(element.data.rows[index]?.[0] || ''); item.append(mark, label); chart.appendChild(item); }); node.appendChild(chart);
    }

    function populateLayoutSelect(slide) {
        const select = byId('presentation-layout-select'); if (!select) return;
        const template = templateById(state.active?.template?.id); const layouts = template?.definition?.layouts || [];
        select.replaceChildren(); layouts.forEach(layout => { const option = document.createElement('option'); option.value = layout.id; option.textContent = layout.name; option.selected = layout.id === slide.layoutId; select.appendChild(option); });
    }

    function applyLayoutToSlide(layoutId) {
        const slide = activeSlide(); if (!slide) return;
        const textElements = slide.elements.filter(element => element.type === 'text').sort((a, b) => (b.style?.fontSize || 0) - (a.style?.fontSize || 0));
        const title = textElements[0]; const body = textElements.filter(element => element !== title);
        const nonTitle = slide.elements.filter(element => element !== title);
        if (layoutId === 'cover' && title) { title.x = 88; title.y = 205; title.width = 1104; title.height = 96; title.style.align = 'center'; body.forEach((element, index) => { element.x = 180; element.y = 345 + index * 72; element.width = 920; element.height = 54; if (element.type === 'text') element.style.align = 'center'; }); }
        if (layoutId === 'section' && title) { title.x = 130; title.y = 280; title.width = 1020; title.height = 100; title.style.align = 'center'; title.style.fontSize = Math.max(36, title.style.fontSize); }
        if (layoutId === 'title-content' && title) { title.x = 80; title.y = 58; title.width = 1120; title.height = 72; title.style.align = 'left'; body.forEach((element, index) => { element.x = 100; element.y = 180 + index * 200; element.width = 1040; element.height = index ? 150 : 390; }); }
        if (layoutId === 'two-column' && title) { title.x = 80; title.y = 54; title.width = 1120; title.height = 72; nonTitle.forEach((element, index) => { const column = index % 2; const row = Math.floor(index / 2); element.x = 80 + column * 570; element.y = 170 + row * 250; element.width = 530; element.height = 220; }); }
        if (layoutId === 'three-card' && title) { title.x = 80; title.y = 54; title.width = 1120; title.height = 72; nonTitle.forEach((element, index) => { element.x = 70 + (index % 3) * 390; element.y = 190 + Math.floor(index / 3) * 240; element.width = 350; element.height = 210; }); }
        if (layoutId === 'image-focus' && title) { title.x = 80; title.y = 54; title.width = 1120; title.height = 72; nonTitle.forEach((element, index) => { element.x = index === 0 ? 80 : 810; element.y = index === 0 ? 160 : 185; element.width = index === 0 ? 670 : 330; element.height = index === 0 ? 420 : 260; }); }
        if ((layoutId === 'chart' || layoutId === 'table') && title) { title.x = 80; title.y = 54; title.width = 1120; title.height = 72; nonTitle.forEach((element, index) => { element.x = index === 0 ? 80 : 930; element.y = index === 0 ? 155 : 185; element.width = index === 0 ? 800 : 240; element.height = index === 0 ? 440 : 290; }); }
        if (layoutId === 'quote') { nonTitle.forEach((element, index) => { element.x = 160; element.y = 190 + index * 220; element.width = 960; element.height = 170; if (element.type === 'text') element.style.align = 'center'; }); }
        if (layoutId === 'summary' && title) { title.x = 80; title.y = 54; title.width = 1120; title.height = 72; nonTitle.forEach((element, index) => { element.x = 110; element.y = 175 + index * 160; element.width = 1010; element.height = 125; }); }
        slide.layoutId = layoutId;
    }

    function renderProperties() {
        const element = selectedElement(); const empty = byId('presentation-selection-empty'); const form = byId('presentation-properties-form');
        empty?.classList.toggle('hidden', Boolean(element)); form?.classList.toggle('hidden', !element);
        if (!element) return;
        setInput('presentation-element-text', element.type === 'text' ? element.content?.text || '' : '');
        ['x', 'y', 'width', 'height', 'rotation'].forEach(key => setInput(`presentation-element-${key}`, element[key]));
        byId('presentation-text-style-fields')?.classList.toggle('hidden', element.type !== 'text');
        if (element.type === 'text') { setInput('presentation-element-font-size', element.style.fontSize); setInput('presentation-element-color', element.style.color); setInput('presentation-element-align', element.style.align); setInput('presentation-element-weight', element.style.fontWeight); }
        byId('presentation-shape-style-fields')?.classList.toggle('hidden', element.type !== 'shape');
        if (element.type === 'shape') { setInput('presentation-shape-fill', element.style.fill); setInput('presentation-shape-stroke', element.style.stroke); setInput('presentation-shape-stroke-width', element.style.strokeWidth); setInput('presentation-shape-opacity', element.style.opacity); }
        byId('presentation-image-style-fields')?.classList.toggle('hidden', element.type !== 'image');
        if (element.type === 'image') { setInput('presentation-image-fit', element.fit); setInput('presentation-image-opacity', element.opacity); }
        const dataField = byId('presentation-element-data-field'); const dataInput = byId('presentation-element-data');
        const supportsData = element.type === 'table' || element.type === 'chart'; dataField?.classList.toggle('hidden', !supportsData);
        if (supportsData && dataInput && document.activeElement !== dataInput) {
            dataInput.value = JSON.stringify(element.type === 'table' ? { columns: element.columns, rows: element.rows } : { title: element.title, chartType: element.chartType, data: element.data, options: element.options }, null, 2);
        }
    }

    function setInput(id, value) { const input = byId(id); if (input && document.activeElement !== input) input.value = value ?? ''; }

    function renderTemplatePanel() {
        renderTemplates(byId('presentation-template-list'));
        const canManage = typeof isAdminUser === 'function' && isAdminUser();
        byId('presentation-save-template-btn')?.classList.toggle('hidden', !canManage);
        byId('presentation-import-template-btn')?.classList.toggle('hidden', !canManage);
    }

    async function saveAsOrganizationTemplate() {
        if (!state.active?.content) return;
        const name = await window.Pivot.legacy.showInputPrompt?.({ title: '保存为组织模板', message: '模板名称', value: `${state.active.content.title} 模板`, required: true, width: 480 });
        if (!name) return;
        const currentTemplate = templateById(state.active.template?.id);
        const definition = { theme: state.active.content.theme, layouts: currentTemplate?.definition?.layouts || [] };
        const data = await requestJson(`${API}/templates`, jsonOptions({ name, description: `由 ${state.active.content.title} 保存的组织模板`, definition, aspectRatio: state.active.content.aspectRatio, scope: 'organization', publish: true }));
        state.templates.push(data.template); renderTemplatePanel(); renderLibrary(); toast('组织模板已发布。');
    }

    async function exportCurrentTemplate() {
        const templateId = state.active?.content?.template?.id || state.active?.template?.id;
        if (!templateId) return;
        const response = await apiFetch(`${API}/templates/${encodeURIComponent(templateId)}/package`);
        if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            throw new Error(data?.error || '导出模板失败。');
        }
        downloadBlob(`${templateById(templateId)?.name || 'PPT模板'}.pivot-ppt-template.json`, await response.blob());
        toast('模板包已开始下载。');
    }

    async function importTemplatePackage(file) {
        if (!file) return;
        const form = new FormData(); form.append('file', file);
        const data = await requestJson(`${API}/templates/import`, { method: 'POST', body: form });
        state.templates.push(data.template); renderTemplatePanel(); renderLibrary(); toast('模板已导入并发布。');
    }

    function renderIssues() {
        const list = byId('presentation-issues-list'); if (!list) return;
        list.replaceChildren(); const validation = state.active?.validation || { issues: [] }; const issues = validation.issues || [];
        if (!issues.length) { const empty = document.createElement('div'); empty.className = 'presentation-empty-note'; empty.textContent = '暂无问题。导出前仍可再次执行质量检查。'; list.appendChild(empty); return; }
        issues.forEach(issue => { const item = document.createElement('button'); item.type = 'button'; item.className = `presentation-issue is-${issue.level || 'info'}`; item.dataset.presentationIssueSlide = issue.slideId || ''; item.dataset.presentationIssueElement = issue.elementId || ''; const title = document.createElement('strong'); title.textContent = issue.message; const tip = document.createElement('span'); tip.textContent = issue.suggestion || ''; item.append(title, tip); list.appendChild(item); });
    }

    function renderVersions() {
        const list = byId('presentation-versions-list'); if (!list) return;
        list.replaceChildren();
        if (!state.versions.length) { const empty = document.createElement('div'); empty.className = 'presentation-empty-note'; empty.textContent = '暂无可恢复版本。保存后会自动在这里留下版本记录。'; list.appendChild(empty); return; }
        state.versions.forEach(version => {
            const row = document.createElement('article'); row.className = 'presentation-version-row';
            const info = document.createElement('div'); const title = document.createElement('strong'); title.textContent = `版本 ${version.version}`; const meta = document.createElement('span'); meta.textContent = `${formatTime(version.createdAt)} · ${version.note || '保存演示文稿'}`; info.append(title, meta);
            const restore = document.createElement('button'); restore.type = 'button'; restore.className = 'btn-secondary'; restore.dataset.presentationRestoreVersion = String(version.version); restore.textContent = '恢复'; row.append(info, restore); list.appendChild(row);
        });
    }

    async function loadVersions() {
        if (!state.active?.id) return;
        const data = await requestJson(`${API}/${encodeURIComponent(state.active.id)}/versions`);
        state.versions = Array.isArray(data.versions) ? data.versions : [];
        renderVersions();
    }

    async function restoreVersion(version) {
        if (!state.active?.id) return;
        const accepted = await window.Pivot.legacy.showConfirm?.('恢复演示文稿版本', `将以历史版本 ${version} 创建一个新的当前版本，当前内容仍会保留在版本历史中。`);
        if (!accepted) return;
        await saveActive({ force: true });
        const data = await requestJson(`${API}/${encodeURIComponent(state.active.id)}/rollback`, jsonOptions({ version, note: `用户恢复版本 ${version}` }));
        state.active = data.presentation; state.selectedSlideId = state.active.content?.slides?.[0]?.id || ''; state.selectedElementId = ''; resetHistory(); renderEditor(); await loadVersions(); toast(`已恢复版本 ${version}。`);
    }

    function switchPanel(name) {
        state.panel = name;
        document.querySelectorAll('[data-presentation-panel]').forEach(button => button.classList.toggle('is-active', button.dataset.presentationPanel === name));
        ['properties', 'template', 'ai', 'issues', 'versions'].forEach(panel => byId(`presentation-${panel}-panel`)?.classList.toggle('hidden', panel !== name));
        if (name === 'versions') loadVersions().catch(error => toast(error.message, 'error'));
    }

    function updateElementFromForm() {
        const element = selectedElement(); if (!element) return;
        ['x', 'y', 'width', 'height', 'rotation'].forEach(key => { const value = Number(byId(`presentation-element-${key}`)?.value); if (Number.isFinite(value)) element[key] = Math.round(value); });
        if (element.type === 'text') {
            element.content.text = byId('presentation-element-text')?.value || '';
            element.style.fontSize = Number(byId('presentation-element-font-size')?.value) || element.style.fontSize;
            element.style.color = byId('presentation-element-color')?.value || element.style.color;
            element.style.align = byId('presentation-element-align')?.value || element.style.align;
            element.style.fontWeight = Number(byId('presentation-element-weight')?.value) || element.style.fontWeight;
        }
        if (element.type === 'shape') {
            element.style.fill = byId('presentation-shape-fill')?.value || element.style.fill;
            element.style.stroke = byId('presentation-shape-stroke')?.value || element.style.stroke;
            element.style.strokeWidth = Number(byId('presentation-shape-stroke-width')?.value) || 0;
            element.style.opacity = Number(byId('presentation-shape-opacity')?.value);
            if (!Number.isFinite(element.style.opacity)) element.style.opacity = 1;
        }
        if (element.type === 'image') {
            element.fit = byId('presentation-image-fit')?.value || element.fit;
            element.opacity = Number(byId('presentation-image-opacity')?.value);
            if (!Number.isFinite(element.opacity)) element.opacity = 1;
        }
        recordHistory(); renderEditor();
    }

    function addText() {
        const slide = activeSlide(); if (!slide) return;
        const id = `text_${Date.now()}`; slide.elements.push(textElement(id, 120, 260, 600, 80, '双击或在右侧编辑文字')); state.selectedElementId = id; recordHistory(); renderEditor();
    }

    function addShape() {
        const slide = activeSlide(); if (!slide) return;
        const template = templateById(state.active.template?.id); const id = `shape_${Date.now()}`; slide.elements.push({ id, type: 'shape', x: 180, y: 260, width: 300, height: 150, rotation: 0, zIndex: 5, locked: false, visible: true, sourceRefs: [], shapeType: 'roundRect', style: { fill: template?.definition?.theme?.colors?.secondary || '#5B8FF9', stroke: template?.definition?.theme?.colors?.primary || '#1769AA', strokeWidth: 1, opacity: 1, radius: 16 } }); state.selectedElementId = id; recordHistory(); renderEditor();
    }

    function addTable() {
        const slide = activeSlide(); if (!slide) return;
        const id = `table_${Date.now()}`;
        slide.elements.push({ id, type: 'table', x: 120, y: 250, width: 760, height: 260, rotation: 0, zIndex: 7, locked: false, visible: true, sourceRefs: [], columns: ['指标', '当前值', '说明'], rows: [['目标', '请填写', '待补充'], ['进度', '请填写', '待补充']], style: { headerFill: '#1769AA', headerColor: '#FFFFFF', cellFill: '#FFFFFF', cellColor: '#1F2937', borderColor: '#CBD5E1', fontSize: 14 } });
        state.selectedElementId = id; recordHistory(); renderEditor();
    }

    function addChart() {
        const slide = activeSlide(); if (!slide) return;
        const id = `chart_${Date.now()}`;
        slide.elements.push({ id, type: 'chart', x: 180, y: 210, width: 720, height: 360, rotation: 0, zIndex: 7, locked: false, visible: true, sourceRefs: [], chartType: 'bar', title: '示例趋势', data: { columns: ['阶段', '数值'], rows: [['第一阶段', 35], ['第二阶段', 62], ['第三阶段', 85]] }, options: { showLegend: false, showLabels: true, colors: ['#1769AA', '#5B8FF9', '#61DDAA'] } });
        state.selectedElementId = id; recordHistory(); renderEditor();
    }

    async function uploadImage(file) {
        if (!file || !activeSlide()) return;
        const form = new FormData(); form.append('file', file);
        setSaveState('正在上传图片…', 'saving');
        try {
            const data = await requestJson(`${API}/assets`, { method: 'POST', body: form }); const id = `image_${Date.now()}`;
            activeSlide().elements.push({ id, type: 'image', x: 180, y: 180, width: 600, height: 360, rotation: 0, zIndex: 8, locked: false, visible: true, sourceRefs: [], assetRef: data.asset.ref, fit: 'cover', opacity: 1, alt: data.asset.filename }); state.selectedElementId = id; recordHistory(); renderEditor(); toast('图片已插入');
        } finally { setSaveState('待保存', 'dirty'); }
    }

    function populateChartDatasetSelect() {
        const select = byId('presentation-chart-dataset'); if (!select) return;
        select.replaceChildren();
        if (!state.dataSets.length) { const option = document.createElement('option'); option.value = ''; option.textContent = '暂无可用数据集'; select.appendChild(option); return; }
        state.dataSets.forEach(dataset => { const option = document.createElement('option'); option.value = dataset.id; option.textContent = dataset.name || dataset.id; select.appendChild(option); });
    }

    function populateChartFields(dataset) {
        const x = byId('presentation-chart-x-field'); const y = byId('presentation-chart-y-field'); if (!x || !y) return;
        x.replaceChildren(); y.replaceChildren();
        const columns = dataset?.columns || [];
        const normalized = columns.map(column => ({ key: column.key || column.name || column, name: column.name || column.key || column, type: column.type || '' }));
        normalized.forEach(column => { const option = document.createElement('option'); option.value = column.key; option.textContent = column.name; x.appendChild(option); });
        const countOption = document.createElement('option'); countOption.value = ''; countOption.textContent = '（计数时无需数值字段）'; y.appendChild(countOption);
        normalized.filter(column => /number|integer|decimal|float|double/i.test(column.type) || column.isNumeric === true).forEach(column => { const option = document.createElement('option'); option.value = column.key; option.textContent = column.name; y.appendChild(option); });
        if (y.options.length === 1) normalized.slice(0, 1).forEach(column => { const option = document.createElement('option'); option.value = column.key; option.textContent = `${column.name}（将尝试转为数值）`; y.appendChild(option); });
    }

    async function loadChartDatasetFields() {
        const id = byId('presentation-chart-dataset')?.value; if (!id) return;
        const data = await requestJson(`/api/apps/data-analysis/datasets/${encodeURIComponent(id)}`);
        populateChartFields(data.dataset);
    }

    async function openDataChartModal() {
        const data = await requestJson('/api/apps/data-analysis/datasets');
        state.dataSets = Array.isArray(data.datasets) ? data.datasets : [];
        if (!state.dataSets.length) { toast('请先在“数据分析”应用中导入数据集。', 'warning'); return; }
        populateChartDatasetSelect();
        await loadChartDatasetFields();
        byId('presentation-data-chart-modal')?.classList.remove('hidden');
    }

    async function importDataChart() {
        const datasetId = byId('presentation-chart-dataset')?.value; const xField = byId('presentation-chart-x-field')?.value; const yField = byId('presentation-chart-y-field')?.value;
        if (!datasetId || !xField) { toast('请选择数据集和分类字段。', 'error'); return; }
        const button = byId('presentation-data-chart-submit-btn'); button?.setAttribute('disabled', ''); if (button) button.textContent = '正在生成…';
        try {
            const data = await requestJson(`${API}/data-chart`, jsonOptions({ datasetId, xField, yField, chartType: byId('presentation-chart-type')?.value || 'bar', aggregation: yField ? (byId('presentation-chart-aggregation')?.value || 'sum') : 'count', title: byId('presentation-chart-title')?.value || '' }));
            const chart = data.chart; const id = `chart_${Date.now()}`; const sourceId = `dataset_${datasetId}`;
            const dataset = state.dataSets.find(item => String(item.id) === String(datasetId));
            const content = activeContent();
            if (!content.sources.some(source => source.id === sourceId)) content.sources.push({ id: sourceId, title: dataset?.name || `数据集 ${datasetId}`, type: 'data_analysis', locator: chart.binding?.queryDigest || '', digest: '' });
            activeSlide().elements.push({ id, ...chart, x: 180, y: 210, width: 720, height: 360, rotation: 0, zIndex: 7, locked: false, visible: true, sourceRefs: [sourceId] }); state.selectedElementId = id; byId('presentation-data-chart-modal')?.classList.add('hidden'); recordHistory(); renderEditor(); toast('数据图表已插入，来源引用已保留。');
        } finally { button?.removeAttribute('disabled'); if (button) button.textContent = '插入图表'; }
    }

    async function createBlank(templateId = '') {
        const template = templateId || state.templates[0]?.id || 'business-blue';
        setStatus('正在创建演示文稿…');
        try { const data = await requestJson(API, jsonOptions({ title: '未命名演示文稿', templateId: template })); await loadDocuments(); await openPresentation(data.presentation.id); }
        finally { setStatus(''); }
    }

    function openCreateModal() {
        populateTemplateSelect(byId('presentation-create-template'));
        byId('presentation-create-modal')?.classList.remove('hidden');
        window.setTimeout(() => byId('presentation-create-topic')?.focus(), 0);
    }

    function closeCreateModal() { byId('presentation-create-modal')?.classList.add('hidden'); }

    function populateTemplateSelect(select) {
        if (!select) return; select.replaceChildren(); state.templates.forEach(template => { const option = document.createElement('option'); option.value = template.id; option.textContent = template.name; select.appendChild(option); });
    }

    function createRequestFromForm() {
        const topic = byId('presentation-create-topic')?.value.trim() || '';
        return { topic, title: topic, pageCount: byId('presentation-create-pages')?.value || 8, audience: byId('presentation-create-audience')?.value || '', purpose: byId('presentation-create-purpose')?.value || '', style: byId('presentation-create-style')?.value || '', templateId: byId('presentation-create-template')?.value || 'business-blue', materials: byId('presentation-create-material')?.value.trim() ? [{ id: 'source_1', title: '用户提供的材料', text: byId('presentation-create-material').value.trim() }] : [] };
    }

    async function generateOutline() {
        const request = createRequestFromForm(); if (!request.topic) { toast('请输入演示主题。', 'error'); return; }
        const button = byId('presentation-create-submit-btn'); button?.setAttribute('disabled', ''); button && (button.textContent = '正在生成…');
        try {
            const file = byId('presentation-create-material-file')?.files?.[0];
            if (file) {
                button && (button.textContent = '正在提取材料…');
                const form = new FormData(); form.append('file', file);
                const extracted = await requestJson(`${API}/materials/extract`, { method: 'POST', body: form });
                request.materials = [...request.materials, extracted.material].slice(0, 20);
            }
            button && (button.textContent = '正在生成大纲…');
            const data = await requestJson(`${API}/ai/outline`, jsonOptions(request)); state.pendingCreate = request; state.pendingOutline = data.outline; byId('presentation-outline-editor').value = JSON.stringify(data.outline, null, 2); byId('presentation-outline-warnings').textContent = (data.outline.warnings || data.outline.assumptions || []).join('\n'); closeCreateModal(); byId('presentation-outline-modal')?.classList.remove('hidden');
        }
        finally { button?.removeAttribute('disabled'); if (button) button.textContent = '生成大纲'; }
    }

    async function generateSlides() {
        let outline;
        try { outline = JSON.parse(byId('presentation-outline-editor')?.value || ''); } catch (_) { toast('大纲 JSON 格式无效，请修正后再生成。', 'error'); return; }
        const button = byId('presentation-outline-confirm-btn'); button?.setAttribute('disabled', ''); if (button) button.textContent = '正在生成页面…';
        try {
            const request = { ...state.pendingCreate, outline, title: outline.title || state.pendingCreate.topic };
            const data = await requestJson(`${API}/ai/slides`, jsonOptions(request));
            const created = await requestJson(API, jsonOptions({ title: data.proposal.presentation.title, templateId: request.templateId, content: data.proposal.presentation }));
            byId('presentation-outline-modal')?.classList.add('hidden'); await loadDocuments(); await openPresentation(created.presentation.id); toast('AI 初稿已生成，可继续在画布中编辑。');
        } finally { button?.removeAttribute('disabled'); if (button) button.textContent = '生成页面'; }
    }

    async function rewriteCurrentSlide() {
        const slide = activeSlide(); if (!slide || !state.active?.content) return;
        const instruction = byId('presentation-ai-instruction')?.value.trim(); if (!instruction) { toast('请先输入改写要求。', 'error'); return; }
        const outline = { title: state.active.content.title, slides: [{ title: slide.elements.find(item => item.type === 'text' && item.style.fontSize >= 24)?.content?.text || '', purpose: instruction, layoutHint: slide.layoutId, keyPoints: slide.elements.filter(item => item.type === 'text').map(item => item.content.text) }] };
        const button = byId('presentation-ai-rewrite-btn'); button?.setAttribute('disabled', ''); if (button) button.textContent = '正在生成建议…';
        try {
            const data = await requestJson(`${API}/ai/slides`, jsonOptions({ title: state.active.content.title, topic: state.active.content.title, templateId: state.active.template?.id, outline, instruction }));
            const proposed = data.proposal.presentation?.slides?.[0]; if (!proposed) throw new Error('AI 未返回可用页面。');
            const accepted = await window.Pivot.legacy.showConfirm?.('应用 AI 页面建议', 'AI 将替换当前页面内容。你可以通过“撤销”恢复原页面。');
            if (accepted) { const index = state.active.content.slides.findIndex(item => item.id === slide.id); proposed.id = slide.id; proposed.index = index; state.active.content.slides[index] = proposed; state.selectedElementId = ''; recordHistory(); renderEditor(); toast('已应用 AI 页面建议。'); }
        } finally { button?.removeAttribute('disabled'); if (button) button.textContent = 'AI 改写当前页'; }
    }

    async function runCheck() {
        if (!state.active?.id) return; setSaveState('正在检查…', 'saving');
        try { await saveActive({ force: true }); const data = await requestJson(`${API}/${encodeURIComponent(state.active.id)}/validation`); state.active.validation = data.validation; switchPanel('issues'); renderIssues(); const label = data.validation.status === 'passed' ? '未发现阻断问题' : `发现 ${data.validation.issues?.length || 0} 项检查结果`; toast(label, data.validation.status === 'blocked' ? 'warning' : 'success'); }
        finally { setSaveState('已保存', 'saved'); }
    }

    function downloadBlob(name, blob) { const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = name; document.body.appendChild(link); link.click(); link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000); }

    async function exportPresentation(format) {
        if (!state.active?.id) return; await saveActive({ force: true }); setSaveState(`正在导出 ${format.toUpperCase()}…`, 'saving');
        try {
            const created = await requestJson(`${API}/${encodeURIComponent(state.active.id)}/export`, jsonOptions({ format, ...(format === 'png' ? { slideIndex: activeSlide()?.index || 0 } : {}) })); const rendition = created.rendition;
            const tokenResult = await requestJson(`/api/agents/renditions/${encodeURIComponent(rendition.id)}/download-token`, jsonOptions({}));
            const response = await apiFetch(`/api/agents/renditions/${encodeURIComponent(rendition.id)}/download?token=${encodeURIComponent(tokenResult.token)}`); if (!response.ok) throw new Error('下载导出文件失败。');
            downloadBlob(`${state.active.content.title || '演示文稿'}.${format}`, await response.blob()); toast(`${format.toUpperCase()} 已生成并开始下载。`);
        } finally { setSaveState('已保存', 'saved'); }
    }

    async function applyTemplate(templateId) {
        if (!state.active?.id || !templateId || templateId === state.active.template?.id) return;
        const template = templateById(templateId); if (!template) return;
        const accepted = await window.Pivot.legacy.showConfirm?.('应用主题模板', '将更新页面的主题色和默认字体；现有元素位置与自定义内容会保留。'); if (!accepted) return;
        state.active.content.template = { id: template.id, version: template.version, snapshotDigest: template.snapshotDigest }; state.active.content.theme = deepClone(template.definition.theme);
        state.active.content.slides.forEach(slide => { slide.background.fill = template.definition.theme.colors.background || slide.background.fill; slide.elements.forEach(element => { if (element.type === 'text') { element.style.fontFamily = element.style.fontSize >= 24 ? template.definition.theme.fonts.heading : template.definition.theme.fonts.body; } }); });
        recordHistory(); await saveActive({ force: true }); renderEditor(); toast('主题模板已应用。');
    }

    function startDrag(event, element) {
        if (event.button !== 0 || element.locked) return;
        event.preventDefault(); state.drag = { elementId: element.id, startX: event.clientX, startY: event.clientY, originX: element.x, originY: element.y };
    }

    function moveSlide(direction) {
        const content = activeContent(); const slide = activeSlide(); if (!content || !slide) return;
        const index = content.slides.findIndex(item => item.id === slide.id); const target = index + direction;
        if (target < 0 || target >= content.slides.length) return;
        [content.slides[index], content.slides[target]] = [content.slides[target], content.slides[index]];
        content.slides.forEach((item, itemIndex) => { item.index = itemIndex; }); recordHistory(); renderEditor();
    }

    function duplicateSlide() {
        const content = activeContent(); const slide = activeSlide(); if (!content || !slide) return;
        const copy = deepClone(slide); copy.id = `slide_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`; copy.elements = copy.elements.map((element, index) => ({ ...element, id: `${element.id}_${Date.now()}_${index}` }));
        const index = content.slides.findIndex(item => item.id === slide.id); content.slides.splice(index + 1, 0, copy); content.slides.forEach((item, itemIndex) => { item.index = itemIndex; }); state.selectedSlideId = copy.id; state.selectedElementId = ''; recordHistory(); renderEditor();
    }

    function deleteSlide() {
        const content = activeContent(); const slide = activeSlide(); if (!content || content.slides.length <= 1 || !slide) { toast('演示文稿至少保留一页。', 'warning'); return; }
        const index = content.slides.findIndex(item => item.id === slide.id); content.slides.splice(index, 1); content.slides.forEach((item, itemIndex) => { item.index = itemIndex; }); state.selectedSlideId = content.slides[Math.max(0, index - 1)]?.id || content.slides[0].id; state.selectedElementId = ''; recordHistory(); renderEditor();
    }

    function changeLayer(delta) {
        const element = selectedElement(); if (!element) return;
        element.zIndex = Math.max(-1000, Math.min(1000, Number(element.zIndex || 0) + delta)); recordHistory(); renderEditor();
    }

    function moveDrag(event) {
        if (!state.drag) return; const element = activeSlide()?.elements?.find(item => item.id === state.drag.elementId); if (!element) return;
        const width = state.active.content.width; const height = state.active.content.height; element.x = Math.max(0, Math.min(width - element.width, Math.round(state.drag.originX + (event.clientX - state.drag.startX) / state.zoom))); element.y = Math.max(0, Math.min(height - element.height, Math.round(state.drag.originY + (event.clientY - state.drag.startY) / state.zoom))); renderStage(); renderProperties();
    }

    function endDrag() { if (!state.drag) return; state.drag = null; recordHistory(); }

    function bindEvents(view) {
        view.addEventListener('click', event => {
            const template = event.target.closest('[data-presentation-template-id]'); if (template) { if (state.active) applyTemplate(template.dataset.presentationTemplateId).catch(error => toast(error.message, 'error')); else createBlank(template.dataset.presentationTemplateId).catch(error => toast(error.message, 'error')); return; }
            const docAction = event.target.closest('[data-presentation-action]'); if (docAction) { const id = docAction.dataset.presentationId; if (docAction.dataset.presentationAction === 'open') openPresentation(id).catch(error => toast(error.message, 'error')); if (docAction.dataset.presentationAction === 'duplicate') duplicateDocument(id).catch(error => toast(error.message, 'error')); if (docAction.dataset.presentationAction === 'delete') deleteDocument(id).catch(error => toast(error.message, 'error')); return; }
            const slideButton = event.target.closest('[data-presentation-slide-id]'); if (slideButton) { state.selectedSlideId = slideButton.dataset.presentationSlideId; state.selectedElementId = ''; renderEditor(); return; }
            const elementNode = event.target.closest('[data-presentation-element-id]'); if (elementNode) { state.selectedElementId = elementNode.dataset.presentationElementId; renderStage(); renderProperties(); return; }
            const panel = event.target.closest('[data-presentation-panel]'); if (panel) { switchPanel(panel.dataset.presentationPanel); return; }
            const issue = event.target.closest('[data-presentation-issue-slide]'); if (issue) { state.selectedSlideId = issue.dataset.presentationIssueSlide || state.selectedSlideId; const elementId = String(issue.dataset.presentationIssueElement || '').split(',')[0]; state.selectedElementId = elementId; renderEditor(); return; }
            if (event.target.closest('#presentation-create-ai-btn')) { openCreateModal(); return; }
            if (event.target.closest('#presentation-create-blank-btn')) { createBlank().catch(error => toast(error.message, 'error')); return; }
            if (event.target.closest('#presentation-refresh-btn')) { loadDocuments().catch(error => toast(error.message, 'error')); return; }
            if (event.target.closest('#presentation-back-to-library-btn')) { closeEditor(); return; }
            if (event.target.closest('#presentation-undo-btn')) { restoreHistory(state.historyIndex - 1); return; }
            if (event.target.closest('#presentation-redo-btn')) { restoreHistory(state.historyIndex + 1); return; }
            if (event.target.closest('#presentation-add-slide-btn')) { const content = activeContent(); const slide = emptySlide(content.slides.length); content.slides.push(slide); state.selectedSlideId = slide.id; state.selectedElementId = ''; recordHistory(); renderEditor(); return; }
            if (event.target.closest('#presentation-duplicate-slide-btn')) { duplicateSlide(); return; }
            if (event.target.closest('#presentation-move-slide-up-btn')) { moveSlide(-1); return; }
            if (event.target.closest('#presentation-move-slide-down-btn')) { moveSlide(1); return; }
            if (event.target.closest('#presentation-delete-slide-btn')) { deleteSlide(); return; }
            if (event.target.closest('#presentation-add-text-btn')) { addText(); return; }
            if (event.target.closest('#presentation-add-shape-btn')) { addShape(); return; }
            if (event.target.closest('#presentation-add-table-btn')) { addTable(); return; }
            if (event.target.closest('#presentation-add-chart-btn')) { addChart(); return; }
            if (event.target.closest('#presentation-import-data-chart-btn')) { openDataChartModal().catch(error => toast(error.message, 'error')); return; }
            if (event.target.closest('#presentation-save-template-btn')) { saveAsOrganizationTemplate().catch(error => toast(error.message, 'error')); return; }
            if (event.target.closest('#presentation-export-template-btn')) { exportCurrentTemplate().catch(error => toast(error.message, 'error')); return; }
            if (event.target.closest('#presentation-import-template-btn')) { byId('presentation-template-package-input')?.click(); return; }
            if (event.target.closest('#presentation-upload-image-btn')) { byId('presentation-image-input')?.click(); return; }
            if (event.target.closest('#presentation-delete-element-btn')) { const slide = activeSlide(); if (slide && state.selectedElementId) { slide.elements = slide.elements.filter(item => item.id !== state.selectedElementId); state.selectedElementId = ''; recordHistory(); renderEditor(); } return; }
            if (event.target.closest('#presentation-layer-up-btn')) { changeLayer(1); return; }
            if (event.target.closest('#presentation-layer-down-btn')) { changeLayer(-1); return; }
            if (event.target.closest('#presentation-check-btn')) { runCheck().catch(error => toast(error.message, 'error')); return; }
            if (event.target.closest('#presentation-export-pptx-btn')) { exportPresentation('pptx').catch(error => toast(error.message, 'error')); return; }
            if (event.target.closest('#presentation-export-pdf-btn')) { exportPresentation('pdf').catch(error => toast(error.message, 'error')); return; }
            if (event.target.closest('#presentation-export-png-btn')) { exportPresentation('png').catch(error => toast(error.message, 'error')); return; }
            if (event.target.closest('#presentation-ai-rewrite-btn')) { rewriteCurrentSlide().catch(error => toast(error.message, 'error')); return; }
            if (event.target.closest('#presentation-create-cancel-btn')) { closeCreateModal(); return; }
            if (event.target.closest('#presentation-data-chart-cancel-btn')) { byId('presentation-data-chart-modal')?.classList.add('hidden'); return; }
            if (event.target.closest('#presentation-refresh-versions-btn')) { loadVersions().catch(error => toast(error.message, 'error')); return; }
            const restore = event.target.closest('[data-presentation-restore-version]'); if (restore) { restoreVersion(Number(restore.dataset.presentationRestoreVersion)).catch(error => toast(error.message, 'error')); return; }
            if (event.target.closest('#presentation-outline-back-btn')) { byId('presentation-outline-modal')?.classList.add('hidden'); openCreateModal(); return; }
            if (event.target.closest('#presentation-outline-confirm-btn')) { generateSlides().catch(error => toast(error.message, 'error')); }
        });
        view.addEventListener('submit', event => { if (event.target?.id === 'presentation-create-form') { event.preventDefault(); generateOutline().catch(error => toast(error.message, 'error')); } if (event.target?.id === 'presentation-data-chart-form') { event.preventDefault(); importDataChart().catch(error => toast(error.message, 'error')); } });
        view.addEventListener('input', event => { if (event.target?.id === 'presentation-title-input' && state.active?.content) { state.active.content.title = event.target.value.slice(0, 160); state.active.title = state.active.content.title; recordHistory(); } if (event.target?.closest('#presentation-properties-form') && event.target?.id !== 'presentation-element-data') updateElementFromForm(); });
        view.addEventListener('change', event => { if (event.target?.id === 'presentation-image-input') uploadImage(event.target.files?.[0]).catch(error => toast(error.message, 'error')); if (event.target?.id === 'presentation-template-package-input') importTemplatePackage(event.target.files?.[0]).catch(error => toast(error.message, 'error')); if (event.target?.id === 'presentation-layout-select') { const slide = activeSlide(); if (slide) { applyLayoutToSlide(event.target.value); recordHistory(); renderEditor(); } } if (event.target?.id === 'presentation-zoom-select') { state.zoom = Number(event.target.value) || 0.65; renderStage(); } if (event.target?.id === 'presentation-chart-dataset') loadChartDatasetFields().catch(error => toast(error.message, 'error')); if (event.target?.id === 'presentation-element-data') { try { const parsed = JSON.parse(event.target.value); const element = selectedElement(); if (element?.type === 'table') { element.columns = parsed.columns; element.rows = parsed.rows; } if (element?.type === 'chart') { element.title = parsed.title || ''; element.chartType = parsed.chartType || 'bar'; element.data = parsed.data; element.options = parsed.options || element.options; } recordHistory(); renderEditor(); } catch (_) { toast('表格或图表数据必须是有效 JSON；当前修改尚未应用。', 'error'); } } });
        view.addEventListener('pointerdown', event => { const node = event.target.closest('[data-presentation-element-id]'); const element = selectedElement(); if (node && element && node.dataset.presentationElementId === element.id) startDrag(event, element); });
        window.addEventListener('pointermove', moveDrag); window.addEventListener('pointerup', endDrag);
    }

    async function duplicateDocument(id) { const data = await requestJson(`${API}/${encodeURIComponent(id)}/duplicate`, jsonOptions({})); await loadDocuments(); await openPresentation(data.presentation.id); toast('已创建演示文稿副本。'); }
    async function deleteDocument(id) { const accepted = await window.Pivot.legacy.showConfirm?.('删除演示文稿', '删除后文稿将归档，不会影响已导出的历史文件。'); if (!accepted) return; await requestJson(`${API}/${encodeURIComponent(id)}`, { method: 'DELETE' }); await loadDocuments(); toast('演示文稿已归档。'); }

    async function showPresentationsApp() {
        ensureView(); hideOtherAppViews();
        await loadTemplates(); await loadDocuments();
        if (!state.active) { byId('presentation-library')?.classList.remove('hidden'); byId('presentation-editor')?.classList.add('hidden'); }
    }

    window.Pivot?.exposeModule?.('apps.presentations', { ready: true, showPresentationsApp, loadDocuments, openPresentation });
})();
