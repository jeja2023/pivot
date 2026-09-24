(function () {
    if (window.Pivot?.moduleApi?.('apps.presentations')?.ready) return;
    const API = '/api/apps/presentations';
    const state = {
        templates: [], documents: [], assets: [], pendingAssetType: '', fontFaceUrls: new Map(), coverUrls: new Map(), imageUrls: new Map(), dataSets: [], versions: [],
        libraryFilters: { search: '', tag: '', favorite: false, templateId: '', status: '', createdBy: '', updatedFrom: '', updatedTo: '' }, libraryFilterTimer: null,
        libraryPage: 1, libraryLimit: 10,
        active: null, selectedSlideId: '', selectedElementId: '', selectedElementIds: [], elementClipboard: null, panel: 'properties', zoom: 0.65,
        history: [], historyIndex: -1, saveTimer: null, savePromise: null, saving: false, dirty: false, editRevision: 0, syncing: false, remoteVersionAvailable: false, remoteSession: null, drag: null,
        pendingOutline: null, pendingCreate: null, aiAbortController: null, aiRequestKey: '',
        presenterIndex: 0, presenterStartedAt: 0, presenterTimer: null, syncTimer: null, realtimeSource: null,
        exportOptions: { aspectRatio: '', includeNotes: true, includePageNumbers: true, showSourceRefs: true, imageQuality: 'standard', fontStrategy: 'embed' }
    };
    const byId = id => document.getElementById(id);
    const deepClone = value => JSON.parse(JSON.stringify(value));
    function toast(message, type = 'success') { if (typeof showToast === 'function') showToast(message, type); }
    async function requestJson(url, options = {}) {
        const res = await apiFetch(url, options); const data = await res.clone().json().catch(() => ({}));
        if (!res.ok) {
            const error = new Error(data?.error?.message || data?.error || data?.message || `请求失败（${res.status}）`);
            error.status = res.status; error.code = data?.code || data?.error?.code || ''; throw error;
        }
        return data;
    }
    function jsonOptions(body) { return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }; }
    function newAiRequestKey() { return 'ppt-ai-' + (globalThis.crypto?.randomUUID?.() || (Date.now().toString(36) + Math.random().toString(36).slice(2))); }
    function beginAiRequest() { state.aiAbortController?.abort(); state.aiAbortController = new AbortController(); state.aiRequestKey = newAiRequestKey(); return state.aiAbortController; }
    function endAiRequest(controller) { if (state.aiAbortController === controller) { state.aiAbortController = null; state.aiRequestKey = ''; } }
    function abortAiRequest() { if (!state.aiAbortController) return false; state.aiAbortController.abort(); return true; }
    function aiJsonOptions(body, controller) { return { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': state.aiRequestKey || newAiRequestKey() }, body: JSON.stringify(body), signal: controller.signal }; }
    function isAiAbort(error, controller = null) { return controller?.signal?.aborted === true || error?.name === 'AbortError' || /aborted|取消/i.test(String(error?.message || '')); }
    function setStatus(message = '', type = '') { const element = byId('presentation-library-status-banner') || byId('presentation-library-status-message'); if (element) { element.textContent = message; element.dataset.type = type; element.classList.toggle('is-visible', Boolean(message)); } }
    function setSaveState(message = '已保存', mode = 'saved') { const element = byId('presentation-save-state'); if (element) { element.textContent = message; element.dataset.state = mode; } }
    function canEditActivePresentation() { return state.active?.isOwner !== false || state.active?.collaboratorRole === 'editor' || (typeof isAdminUser === 'function' && isAdminUser()); }
    async function ensureThemeFonts() {
        const content = activeContent(); if (!content?.theme?.fontAssets || typeof FontFace === 'undefined') return;
        for (const [kind, ref] of Object.entries(content.theme.fontAssets)) {
            if (!ref || state.fontFaceUrls.has(ref)) continue;
            try {
                const response = await apiFetch(API + '/assets/content/by-ref?ref=' + encodeURIComponent(ref) + '&presentationId=' + encodeURIComponent(state.active?.id || ''));
                if (!response.ok) continue;
                const url = URL.createObjectURL(await response.blob()); const family = kind === 'heading' ? content.theme.fonts.heading : content.theme.fonts.body;
                const font = new FontFace(family, 'url(' + JSON.stringify(url) + ')'); await font.load(); document.fonts.add(font); state.fontFaceUrls.set(ref, url); renderStage();
            } catch (_) {}
        }
    }
    function syncExportOptionsForm() {
        const options = state.exportOptions; const content = activeContent();
        setInput('presentation-export-aspect-ratio', options.aspectRatio || content?.aspectRatio || '16:9');
        const notes = byId('presentation-export-include-notes'); if (notes) notes.checked = options.includeNotes !== false;
        const pages = byId('presentation-export-include-page-numbers'); if (pages) pages.checked = options.includePageNumbers !== false;
        const refs = byId('presentation-export-show-source-refs'); if (refs) refs.checked = options.showSourceRefs !== false;
        setInput('presentation-export-image-quality', options.imageQuality || 'standard'); setInput('presentation-export-font-strategy', options.fontStrategy || 'embed');
    }
    function saveExportOptions() {
        state.exportOptions = { aspectRatio: byId('presentation-export-aspect-ratio')?.value || activeContent()?.aspectRatio || '16:9', includeNotes: Boolean(byId('presentation-export-include-notes')?.checked), includePageNumbers: Boolean(byId('presentation-export-include-page-numbers')?.checked), showSourceRefs: Boolean(byId('presentation-export-show-source-refs')?.checked), imageQuality: byId('presentation-export-image-quality')?.value || 'standard', fontStrategy: byId('presentation-export-font-strategy')?.value || 'embed' };
        byId('presentation-export-options-modal')?.classList.add('hidden'); toast('导出选项已保存。');
    }
    function activeContent() { return state.active?.content || null; }
    function activeSlide() { const content = activeContent(); return content?.slides?.find(slide => slide.id === state.selectedSlideId) || content?.slides?.[0] || null; }
    function selectedElement() { return activeSlide()?.elements?.find(element => element.id === state.selectedElementId) || null; }
    function resetHistory() { state.history = state.active?.content ? [deepClone(state.active.content)] : []; state.historyIndex = state.history.length - 1; updateUndoRedo(); }
    function updateUndoRedo() { byId('presentation-undo-btn')?.toggleAttribute('disabled', state.historyIndex <= 0); byId('presentation-redo-btn')?.toggleAttribute('disabled', state.historyIndex >= state.history.length - 1); }
    function recordHistory() { if (!state.active?.content) return; const snapshot = deepClone(state.active.content); const current = state.history[state.historyIndex]; if (current && JSON.stringify(current) === JSON.stringify(snapshot)) return; state.history.splice(state.historyIndex + 1); state.history.push(snapshot); if (state.history.length > 80) state.history.shift(); state.historyIndex = state.history.length - 1; updateUndoRedo(); scheduleSave(); }
    function restoreHistory(index) { if (!state.active || !state.history[index]) return; state.historyIndex = index; state.active.content = deepClone(state.history[index]); state.active.title = state.active.content.title; renderEditor(); scheduleSave(); }
    function scheduleSave() { if (!state.active?.id || !canEditActivePresentation()) return; clearTimeout(state.saveTimer); state.editRevision += 1; state.dirty = true; setSaveState('待保存', 'dirty'); state.saveTimer = window.setTimeout(() => saveActive().catch(error => { setSaveState('保存失败', 'error'); toast(error.message || '保存失败，内容仍保留在当前页面。', 'error'); }), 1200); }
    async function saveActive({ force = false } = {}) {
        if (!state.active?.id || !canEditActivePresentation()) return false;
        if (state.saving) { await state.savePromise; return state.dirty ? saveActive({ force }) : true; }
        if (!state.dirty && !force) return true;
        clearTimeout(state.saveTimer); state.saveTimer = null;
        const content = activeContent(); if (!content) return;
        const presentationId = state.active.id;
        const contentSnapshot = deepClone(content);
        const saveRevision = state.editRevision;
        state.saving = true;
        setSaveState('保存中…', 'saving');
        const save = (async () => {
            const data = await requestJson(`${API}/${encodeURIComponent(state.active.id)}/content`, {
                method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ baseVersion: state.active.version, title: contentSnapshot.title, templateId: contentSnapshot.template?.id, content: contentSnapshot, note: force ? '用户主动保存' : '自动保存' })
            });
            if (state.active?.id !== presentationId) return true;
            const changedWhileSaving = state.editRevision !== saveRevision;
            const currentContent = activeContent();
            state.active = data.presentation;
            state.active.content = changedWhileSaving ? currentContent : (data.presentation.content || contentSnapshot);
            state.active.validation = data.presentation.validation || state.active.validation;
            state.documents = state.documents.map(item => item.id === state.active.id ? { ...item, ...state.active } : item);
            state.dirty = changedWhileSaving;
            state.remoteVersionAvailable = false;
            setSaveState(changedWhileSaving ? '待保存' : '已保存', changedWhileSaving ? 'dirty' : 'saved');
            renderIssues();
            return true;
        })();
        state.savePromise = save;
        try { return await save; }
        finally {
            state.saving = false;
            if (state.savePromise === save) state.savePromise = null;
        }
    }
    async function refreshRemotePresentation({ force = false } = {}) {
        if (!state.active?.id || state.saving) return false;
        const data = await requestJson(API + '/' + encodeURIComponent(state.active.id), { cache: 'no-store' });
        const remote = data.presentation;
        if (!remote || (!force && Number(remote.version || 0) <= Number(state.active.version || 0))) return false;
        if (state.dirty && !force) {
            if (!state.remoteVersionAvailable) { state.remoteVersionAvailable = true; setSaveState('远端有更新', 'dirty'); toast('协作者已保存新版本。请先保存、恢复版本或点击“同步”后再继续编辑。', 'warning'); }
            return true;
        }
        const keepSlideId = state.selectedSlideId; state.active = remote; state.selectedSlideId = remote.content?.slides?.some(slide => slide.id === keepSlideId) ? keepSlideId : remote.content?.slides?.[0]?.id || ''; state.selectedElementId = ''; state.remoteVersionAvailable = false; state.dirty = false; resetHistory(); renderEditor(); setSaveState('已同步远端版本', 'saved'); toast('已同步协作者的最新版本。'); return true;
    }
    function revokePresentationAccess() {
        if (!state.active?.id) return;
        closePresenterMode(); stopPresentationRealtime(); stopPresentationSync(); collab()?.stopPresenceHeartbeat();
        state.active = null; state.selectedSlideId = ''; state.selectedElementId = ''; state.history = []; state.historyIndex = -1; state.dirty = false;
        byId('presentation-editor')?.classList.add('hidden'); byId('presentation-library')?.classList.remove('hidden');
        toast('你已被移出该演示文稿，当前访问已撤销。', 'warning'); loadDocuments().catch(() => {});
    }
    function stopPresentationRealtime() {
        if (state.realtimeSource) { state.realtimeSource.close(); state.realtimeSource = null; }
    }
    function startPresentationRealtime() {
        stopPresentationRealtime();
        if (!state.active?.id || !window.EventSource) return;
        const source = new EventSource('/api/events', { withCredentials: true });
        state.realtimeSource = source;
        const onPresentationEvent = event => {
            let payload; try { payload = JSON.parse(event.data || '{}'); } catch (_) { return; }
            if (String(payload.presentationId || '') !== String(state.active?.id || '')) return;
            if (payload.type === 'presentation.access_revoked') { revokePresentationAccess(); return; }
            if (payload.type === 'presentation.updated') refreshRemotePresentation().catch(() => {});
            if (payload.type === 'presentation.comments') collab()?.loadComments(state.active?.id);
            if (payload.type === 'presentation.collaborators') { collab()?.loadCollaborators?.(); refreshRemotePresentation().catch(() => {}); }
        };
        ['presentation.updated', 'presentation.comments', 'presentation.collaborators', 'presentation.access_revoked'].forEach(type => source.addEventListener(type, onPresentationEvent));
        source.onerror = () => { /* polling remains the reconnect-safe fallback */ };
    }
    function startPresentationSync() {
        clearInterval(state.syncTimer); state.syncTimer = window.setInterval(() => refreshRemotePresentation().catch(() => {}), 5000);
    }
    function stopPresentationSync() { clearInterval(state.syncTimer); state.syncTimer = null; state.remoteVersionAvailable = false; }
    async function syncRemotePresentation() {
        if (!state.active?.id || state.syncing) return false;
        state.syncing = true;
        byId('presentation-sync-btn')?.setAttribute('disabled', '');
        try {
            if (state.dirty) {
                const message = state.saving
                    ? '当前修改正在保存。保存完成后将加载服务器上的最新版本；已开始保存的修改无法撤销。'
                    : '当前有尚未保存的本地修改。同步会丢弃这些本地修改；请先保存或从版本历史恢复。';
                const confirm = window.Pivot?.legacy?.showConfirm;
                const accepted = typeof confirm === 'function' ? await confirm('同步协作者版本', message) : window.confirm(message);
                if (!accepted) return false;
                clearTimeout(state.saveTimer);
                state.saveTimer = null;
                if (state.saving) await state.savePromise;
            }
            const refreshed = await refreshRemotePresentation({ force: true });
            if (!refreshed) toast('当前已经是服务器上的最新版本。');
            return refreshed;
        } finally {
            state.syncing = false;
            byId('presentation-sync-btn')?.removeAttribute('disabled');
        }
    }
    function templateById(id) {
        return state.templates.find(template => template.id === id) || state.templates[0] || null;
    }
    function textElement(id, x, y, width, height, text, style = {}) {
        return { id, type: 'text', x, y, width, height, rotation: 0, zIndex: 10, locked: false, visible: true, sourceRefs: [], content: { text }, style: { fontFamily: 'Microsoft YaHei', fontSize: 20, fontWeight: 400, color: '#1F2937', align: 'left', verticalAlign: 'top', lineHeight: 1.35, italic: false, underline: false, bullet: false, padding: 0, ...style } };
    }
    const PRESENTATION_LAYOUT_LABELS = Object.freeze({
        cover: '封面页',
        section: '章节过渡页',
        'title-content': '标题与正文',
        'two-column': '双栏图文',
        'three-card': '三栏卡片',
        'image-focus': '大图重点页',
        chart: '数据图表页',
        'data-chart': '数据图表页',
        table: '数据表格页',
        'data-table': '数据表格页',
        quote: '引用重点页',
        summary: '总结行动页'
    });
    function presentationLayoutLabel(layoutId) {
        const id = String(layoutId || '').trim();
        if (PRESENTATION_LAYOUT_LABELS[id]) return PRESENTATION_LAYOUT_LABELS[id];
        const layouts = templateById(state.active?.template?.id)?.definition?.layouts || [];
        const configuredName = layouts.find(layout => layout.id === id)?.name?.trim();
        return configuredName || '自定义布局';
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
        const filter = byId('presentation-library-template');
        if (filter) { const selected = state.libraryFilters.templateId; filter.replaceChildren(new Option('全部模板', '')); state.templates.forEach(template => filter.add(new Option(template.name, template.id))); filter.value = selected; }
    }
    async function loadDocuments() {
        setStatus('正在加载演示文稿…');
        const params = new URLSearchParams({ limit: '100' });
        if (state.libraryFilters.search) params.set('search', state.libraryFilters.search);
        if (state.libraryFilters.tag) params.set('tag', state.libraryFilters.tag);
        if (state.libraryFilters.templateId) params.set('templateId', state.libraryFilters.templateId);
        if (state.libraryFilters.status) params.set('status', state.libraryFilters.status);
        if (state.libraryFilters.createdBy) params.set('createdBy', state.libraryFilters.createdBy);
        if (state.libraryFilters.updatedFrom) params.set('updatedFrom', state.libraryFilters.updatedFrom);
        if (state.libraryFilters.updatedTo) params.set('updatedTo', state.libraryFilters.updatedTo);
        if (state.libraryFilters.favorite) params.set('favorite', 'true');
        const data = await requestJson(API + '?' + params.toString(), { cache: 'no-store' });
        state.documents = Array.isArray(data.presentations) ? data.presentations : [];
        setStatus(state.documents.length ? '' : '还没有匹配的演示文稿，可调整搜索或新建。');
        renderLibrary();
    }
    function syncLibraryFilters() {
        state.libraryFilters.search = byId('presentation-library-search')?.value.trim() || '';
        state.libraryFilters.tag = byId('presentation-library-tag')?.value.trim() || '';
        state.libraryFilters.templateId = byId('presentation-library-template')?.value || '';
        state.libraryFilters.status = byId('presentation-library-status')?.value || '';
        state.libraryFilters.createdBy = byId('presentation-library-created-by')?.value.trim() || '';
        state.libraryFilters.updatedFrom = byId('presentation-library-updated-from')?.value || '';
        state.libraryFilters.updatedTo = byId('presentation-library-updated-to')?.value || '';
    }
    function scheduleLibraryFilter() {
        state.libraryPage = 1;
        syncLibraryFilters(); clearTimeout(state.libraryFilterTimer);
        state.libraryFilterTimer = window.setTimeout(() => loadDocuments().catch(error => toast(error.message, 'error')), 250);
    }
    function resetLibraryFilters() {
        state.libraryPage = 1;
        ['presentation-library-search', 'presentation-library-created-by', 'presentation-library-template', 'presentation-library-status', 'presentation-library-updated-from', 'presentation-library-updated-to', 'presentation-library-tag'].forEach(id => setInput(id, ''));
        const fav = byId('presentation-library-favorite-only'); if (fav) fav.checked = false;
        syncLibraryFilters(); state.libraryFilters.favorite = false;
        loadDocuments().catch(error => toast(error.message, 'error'));
    }
    async function updateDocumentTags(id, currentTags) {
        const tags = await window.Pivot.legacy.showInputPrompt?.({ title: '编辑文稿标签', message: '用逗号分隔，最多 12 个', value: (currentTags || []).join(', '), width: 520 });
        if (tags === undefined || tags === null) return;
        await requestJson(API + '/' + encodeURIComponent(id), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tags: tags.split(/[，,]/).map(item => item.trim()).filter(Boolean) }) });
        await loadDocuments();
    }
    async function toggleFavoriteDocument(id, favorite) {
        await requestJson(API + '/' + encodeURIComponent(id) + '/favorite', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ favorite: !favorite }) });
        await loadDocuments();
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
        if (!(state.coverUrls instanceof Map)) state.coverUrls = new Map();
        state.coverUrls.forEach(url => URL.revokeObjectURL(url)); state.coverUrls.clear();
        const tableBody = byId('presentation-library-table-body'), legacyList = byId('presentation-library-list');
        renderTemplates(byId('presentation-template-strip'), { compact: true });
        if (legacyList) legacyList.replaceChildren();
        if (!tableBody) return;
        tableBody.replaceChildren();
        const total = state.documents.length, limit = Math.max(Number(state.libraryLimit) || 10, 1);
        const totalPages = Math.max(Math.ceil(total / limit), 1);
        state.libraryPage = Math.min(Math.max(Number(state.libraryPage) || 1, 1), totalPages);
        const startIndex = (state.libraryPage - 1) * limit;
        const pageDocs = state.documents.slice(startIndex, startIndex + limit);
        if (!total) {
            const tr = document.createElement('tr'), td = document.createElement('td');
            td.colSpan = 9; td.className = 'text-center presentation-table-empty';
            td.textContent = '暂无演示文稿。可从 AI 创建、空白创建或调整筛选条件开始。';
            tr.appendChild(td); tableBody.appendChild(tr);
            renderLibraryPagination(0, limit, 1);
            return;
        }
        pageDocs.forEach((doc, idx) => {
            const tr = document.createElement('tr'); tr.dataset.presentationDocId = doc.id;
            if (doc.favorite) tr.classList.add('is-favorite');
            const tdIdx = document.createElement('td'); tdIdx.className = 'text-center'; tdIdx.textContent = String(startIndex + idx + 1);
            const tdTitle = document.createElement('td'), wrap = document.createElement('div'); wrap.className = 'presentation-table-title-cell';
            const dot = document.createElement('span'); dot.className = 'presentation-theme-dot';
            dot.style.backgroundColor = templateById(doc.template?.id)?.definition?.theme?.colors?.primary || '#1769AA';
            dot.title = templateById(doc.template?.id)?.name || doc.template?.name || '默认主题';
            wrap.appendChild(dot);
            const titleBtn = document.createElement('button'); titleBtn.type = 'button'; titleBtn.className = 'presentation-table-title-btn'; titleBtn.dataset.presentationAction = 'open'; titleBtn.dataset.presentationId = doc.id; titleBtn.textContent = doc.title || '未命名演示文稿'; titleBtn.title = doc.title || '未命名演示文稿';
            wrap.appendChild(titleBtn);
            if (doc.favorite) { const fav = document.createElement('span'); fav.className = 'presentation-favorite-badge'; fav.textContent = '★'; fav.title = '已收藏'; wrap.appendChild(fav); }
            tdTitle.appendChild(wrap);
            const tdTpl = document.createElement('td'); const tplName = templateById(doc.template?.id)?.name || doc.template?.name || '自定义主题'; tdTpl.textContent = tplName; tdTpl.title = tplName;
            const tdVer = document.createElement('td'); tdVer.className = 'text-center'; tdVer.textContent = 'v' + (doc.version || 1);
            const tdSt = document.createElement('td'); tdSt.className = 'text-center'; const pill = document.createElement('span'); const sk = doc.status || 'draft'; pill.className = 'presentation-status-pill ' + sk; pill.textContent = statusLabel(sk); tdSt.appendChild(pill);
            const tdRole = document.createElement('td'); tdRole.className = 'text-center'; const badge = document.createElement('span');
            if (doc.isOwner !== false) { badge.className = 'presentation-role-badge is-owner'; badge.textContent = '我创建的'; }
            else { badge.className = 'presentation-role-badge is-shared'; const rt = ({ editor: '可编辑', commenter: '可评论', viewer: '只读' }[doc.collaboratorRole] || '协作者'); badge.textContent = '共享 · ' + rt; badge.title = '共享文档（' + rt + '）'; }
            tdRole.appendChild(badge);
            const tdTags = document.createElement('td'); const tags = Array.isArray(doc.tags) ? doc.tags : [];
            if (tags.length) { const sp = document.createElement('span'); sp.className = 'presentation-tag-text'; sp.textContent = tags.map(t => '#' + t).join(' '); sp.title = tags.join(', '); tdTags.appendChild(sp); }
            else { const em = document.createElement('span'); em.className = 'presentation-empty-dash'; em.textContent = '-'; tdTags.appendChild(em); }
            const tdTime = document.createElement('td'); const ft = formatTime(doc.updatedAt); tdTime.textContent = ft; tdTime.title = ft;
            const tdAct = document.createElement('td'); tdAct.className = 'text-center'; const acts = document.createElement('div'); acts.className = 'presentation-row-actions';
            [['打开', 'open', 'btn-primary'], [doc.favorite ? '取消收藏' : '收藏', 'favorite', 'btn-secondary'], ...((doc.isOwner !== false || doc.collaboratorRole === 'editor') ? [['标签', 'tags', 'btn-secondary']] : []), ...(doc.isOwner !== false ? [['复制', 'duplicate', 'btn-secondary'], ['删除', 'delete', 'btn-secondary btn-danger-hover']] : [])].forEach(([lbl, act, cls]) => {
                const btn = document.createElement('button'); btn.type = 'button'; btn.className = cls; btn.textContent = lbl; btn.dataset.presentationAction = act; btn.dataset.presentationId = doc.id; btn.dataset.presentationFavorite = doc.favorite ? 'true' : 'false'; btn.dataset.presentationTags = JSON.stringify(tags); acts.appendChild(btn);
            });
            tdAct.appendChild(acts);
            tr.append(tdIdx, tdTitle, tdTpl, tdVer, tdSt, tdRole, tdTags, tdTime, tdAct); tableBody.appendChild(tr);
            if (doc.coverAssetRef) {
                apiFetch(API + '/assets/content/by-ref?ref=' + encodeURIComponent(doc.coverAssetRef) + '&presentationId=' + encodeURIComponent(doc.id)).then(res => res.ok ? res.blob() : null).then(blob => {
                    if (!blob || !tr.isConnected) return; const url = URL.createObjectURL(blob); state.coverUrls.set(doc.id, url); dot.style.backgroundImage = 'url(\"' + url + '\")'; dot.style.backgroundSize = 'cover'; dot.style.backgroundPosition = 'center';
                }).catch(() => {});
            }
        });
        renderLibraryPagination(total, limit, state.libraryPage);
    }
    function renderLibraryPagination(total, limit, page) {
        const pager = byId('presentation-library-pagination');
        if (!pager) return;
        const fn = window.Pivot?.legacy?.renderWorkspacePagination || window.Pivot?.moduleApi?.('chat.ui', {})?.renderWorkspacePagination;
        if (typeof fn !== 'function') { pager.replaceChildren(); return; }
        fn(pager, { total, limit, page, onPageChange: p => { state.libraryPage = p; renderLibrary(); } });
    }
    function formatTime(value) {
        if (!value) return '刚刚更新';
        const date = new Date(String(value).replace(' ', 'T'));
        return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('zh-CN', { hour12: false });
    }
    function statusLabel(value) {
        return { draft: '草稿', needs_attention: '待检查', ready: '可交付', archived: '已归档' }[value] || value || '草稿';
    }
    const collab = () => window.Pivot?.moduleApi?.('apps.presentations.collab');
    const presenter = () => window.Pivot?.moduleApi?.('apps.presentations.presenter');
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
        collab()?.startPresenceHeartbeat(id, () => state.selectedSlideId);
        startPresentationSync();
        startPresentationRealtime();
        collab()?.loadComments(id);
    }
    function closeEditor() {
        closePresenterMode();
        if (state.remoteSession?.id) stopRemotePresentation().catch(() => {});
        stopPresentationRealtime();
        stopPresentationSync();
        collab()?.stopPresenceHeartbeat();
        saveActive({ force: true }).catch(() => {});
        state.active = null; state.selectedSlideId = ''; state.selectedElementId = ''; state.history = []; state.historyIndex = -1;
        state.imageUrls.forEach(url => URL.revokeObjectURL(url)); state.imageUrls.clear(); state.fontFaceUrls.forEach(url => URL.revokeObjectURL(url)); state.fontFaceUrls.clear(); if (state.coverUrls instanceof Map) { state.coverUrls.forEach(url => URL.revokeObjectURL(url)); state.coverUrls.clear(); }
        byId('presentation-editor')?.classList.add('hidden');
        byId('presentation-library')?.classList.remove('hidden');
        loadDocuments().catch(error => toast(error.message, 'error'));
    }
    async function startRemotePresentation() { return presenter()?.startRemotePresentation?.(state, { toast }); }
    async function syncRemoteSlide() { return presenter()?.syncRemoteSlide?.(state); }
    async function stopRemotePresentation() { return presenter()?.stopRemotePresentation?.(state, { toast }); }
    function renderEditor() {
        if (!state.active?.content) return;
        const titleInput = byId('presentation-title-input');
        if (titleInput && document.activeElement !== titleInput) titleInput.value = state.active.content.title || state.active.title;
        ensureThemeFonts().catch(() => {});
        renderSlideList(); renderStage(); renderProperties(); renderSpeakerNotes(); renderTemplatePanel(); renderIssues(); updateUndoRedo();
        const editable = canEditActivePresentation();
        const admin = typeof isAdminUser === 'function' && isAdminUser();
        document.querySelector('[data-presentation-panel="metrics"]')?.classList.toggle('hidden', !admin);
        byId('presentation-title-input')?.toggleAttribute('readonly', !editable);
        byId('presentation-speaker-notes')?.toggleAttribute('disabled', !editable);
        ['presentation-add-slide-btn', 'presentation-duplicate-slide-btn', 'presentation-move-slide-up-btn', 'presentation-move-slide-down-btn', 'presentation-delete-slide-btn', 'presentation-undo-btn', 'presentation-redo-btn', 'presentation-check-btn', 'presentation-layer-down-btn', 'presentation-layer-up-btn', 'presentation-delete-element-btn', 'presentation-copy-element-btn', 'presentation-paste-element-btn', 'presentation-group-elements-btn', 'presentation-ungroup-elements-btn', 'presentation-align-left-btn', 'presentation-align-center-btn', 'presentation-distribute-horizontal-btn', 'presentation-replace-image-btn', 'presentation-table-add-row-btn', 'presentation-table-remove-row-btn', 'presentation-table-add-column-btn', 'presentation-table-remove-column-btn', 'presentation-add-text-btn', 'presentation-add-shape-btn', 'presentation-add-table-btn', 'presentation-add-chart-btn', 'presentation-import-data-chart-btn', 'presentation-upload-image-btn', 'presentation-ai-rewrite-btn', 'presentation-ai-continue-btn'].forEach(id => byId(id)?.toggleAttribute('disabled', !editable));
        const canExport = state.active?.isOwner !== false || (typeof isAdminUser === 'function' && isAdminUser());
        ['presentation-export-pptx-btn', 'presentation-export-pdf-btn', 'presentation-export-png-btn'].forEach(id => byId(id)?.toggleAttribute('disabled', !canExport));
        byId('presentation-remote-start-btn')?.toggleAttribute('disabled', !canExport);
        byId('presentation-remote-start-btn')?.classList.toggle('hidden', Boolean(state.remoteSession?.id));
        byId('presentation-remote-stop-btn')?.classList.toggle('hidden', !state.remoteSession?.id);
        document.querySelectorAll('#presentation-properties-form input, #presentation-properties-form textarea, #presentation-properties-form select').forEach(input => input.toggleAttribute('disabled', !editable));
        collab()?.renderPresenceBar();
        collab()?.renderComments();
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
            const label = document.createElement('small'); label.textContent = presentationLayoutLabel(slide.layoutId);
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
            const res = await apiFetch(`${API}/assets/content/by-ref?ref=${encodeURIComponent(element.assetRef)}&presentationId=${encodeURIComponent(state.active?.id || '')}`);
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
            node.className = `presentation-canvas-element presentation-canvas-${element.type}${(state.selectedElementIds || []).includes(element.id) ? ' is-selected' : ''}`;
            node.dataset.presentationElementId = element.id;
            Object.assign(node.style, cssElement(element)); node.style.zIndex = String(element.zIndex || 1); if (element.animation?.type && element.animation.type !== 'none') { node.classList.add('presentation-animate-' + element.animation.type); node.style.animationDuration = String(element.animation.durationMs || 500) + 'ms'; node.style.animationDelay = String(element.animation.delayMs || 0) + 'ms'; }
            if (element.type === 'text') {
                node.textContent = element.content?.text || '';
                node.style.fontFamily = element.style?.fontFamily || 'Microsoft YaHei'; node.style.fontSize = `${Number(element.style?.fontSize || 18) * state.zoom}px`;
                node.style.fontWeight = String(element.style?.fontWeight || 400); node.style.color = element.style?.color || '#1F2937'; node.style.textAlign = element.style?.align || 'left'; node.style.lineHeight = String(element.style?.lineHeight || 1.35); node.style.padding = `${Number(element.style?.padding || 0) * state.zoom}px`;
                node.style.justifyContent = ({ top: 'flex-start', middle: 'center', bottom: 'flex-end' })[element.style?.verticalAlign] || 'flex-start';
            } else if (element.type === 'shape') {
                node.style.background = element.style?.fill || '#FFFFFF'; node.style.borderColor = element.style?.stroke || '#CBD5E1'; node.style.borderWidth = `${Math.max(1, Number(element.style?.strokeWidth || 1) * state.zoom)}px`; node.style.opacity = String(element.style?.opacity ?? 1); node.style.borderRadius = element.shapeType === 'ellipse' ? '50%' : `${Number(element.style?.radius || 0) * state.zoom}px`;
            } else if (element.type === 'image') {
                node.style.backgroundSize = element.fit === 'contain' ? 'contain' : element.fit === 'stretch' ? '100% 100%' : 'cover'; node.style.backgroundPosition = `${Math.max(0, Math.min(100, Number(element.cropX || 0))) + 50}% ${Math.max(0, Math.min(100, Number(element.cropY || 0))) + 50}%`; node.style.backgroundRepeat = 'no-repeat'; node.style.opacity = String(element.opacity ?? 1); renderImage(element, node);
            } else if (element.type === 'table') {
                renderTableElement(node, element);
            } else if (element.type === 'chart') {
                renderChartElement(node, element);
            } else if (element.type === 'diagram') {
                renderDiagramElement(node, element);
            } else if (element.type === 'media') {
                renderMediaElement(node, element);
            } else if (element.type === 'attachment') {
                renderAttachmentElement(node, element);
            }
            stage.appendChild(node);
        });
        const meta = byId('presentation-slide-meta');
        if (meta) meta.textContent = `第 ${slide.index + 1} / ${content.slides.length} 页 · ${presentationLayoutLabel(slide.layoutId)}`;
        populateLayoutSelect(slide);
        const transitionSelect = byId('presentation-transition-select'); if (transitionSelect) transitionSelect.value = slide.transition?.type || 'none';
    }
    function renderDiagramElement(node, element) {
        node.classList.add('presentation-diagram-element');
        const items = element.items || []; const horizontal = element.diagramType !== 'hierarchy';
        items.forEach((text, index) => { const chip = document.createElement('span'); chip.textContent = text; chip.style.background = element.style?.fill || '#EFF6FF'; chip.style.borderColor = element.style?.stroke || '#2563EB'; chip.style.color = element.style?.textColor || '#1E3A8A'; chip.style.fontSize = (Number(element.style?.fontSize || 16) * state.zoom) + 'px'; node.appendChild(chip); if (index < items.length - 1) { const arrow = document.createElement('i'); arrow.textContent = horizontal ? '→' : '↓'; node.appendChild(arrow); } });
        node.classList.toggle('is-vertical', !horizontal);
    }
    function renderMediaElement(node, element) {
        node.classList.add('presentation-media-element'); node.textContent = element.mediaType === 'audio' ? '音频媒体' : '视频媒体';
        if (element.posterAssetRef) { node.style.backgroundSize = 'cover'; node.style.backgroundPosition = 'center'; renderImage({ assetRef: element.posterAssetRef }, node); }
    }
    function renderAttachmentElement(node, element) {
        node.classList.add('presentation-attachment-element'); node.textContent = '附件: ' + (element.filename || '受控资源');
    }
    function renderTableElement(node, element) { return presenter()?.renderTableElement?.(node, element, state.zoom); }
    function renderChartElement(node, element) { return presenter()?.renderChartElement?.(node, element); }
    function populateLayoutSelect(slide) { return presenter()?.populateLayoutSelect?.(slide, state, templateById); }
    function applyLayoutToSlide(layoutId) { return presenter()?.applyLayoutToSlide?.(layoutId, state); }
    function renderProperties() {
        const element = selectedElement(); const empty = byId('presentation-selection-empty'); const form = byId('presentation-properties-form');
        empty?.classList.toggle('hidden', Boolean(element)); form?.classList.toggle('hidden', !element);
        if (!element) return;
        setInput('presentation-element-text', element.type === 'text' ? element.content?.text || '' : '');
        ['x', 'y', 'width', 'height', 'rotation'].forEach(key => setInput(`presentation-element-${key}`, element[key]));
        setInput('presentation-element-animation', element.animation?.type || 'none'); setInput('presentation-element-animation-duration', element.animation?.durationMs || 500);
        byId('presentation-text-style-fields')?.classList.toggle('hidden', element.type !== 'text');
        if (element.type === 'text') { setInput('presentation-element-font-size', element.style.fontSize); setInput('presentation-element-color', element.style.color); setInput('presentation-element-align', element.style.align); setInput('presentation-element-weight', element.style.fontWeight); }
        byId('presentation-shape-style-fields')?.classList.toggle('hidden', element.type !== 'shape');
        if (element.type === 'shape') { setInput('presentation-shape-fill', element.style.fill); setInput('presentation-shape-stroke', element.style.stroke); setInput('presentation-shape-stroke-width', element.style.strokeWidth); setInput('presentation-shape-opacity', element.style.opacity); }
        byId('presentation-image-style-fields')?.classList.toggle('hidden', element.type !== 'image');
        if (element.type === 'image') { setInput('presentation-image-fit', element.fit); setInput('presentation-image-opacity', element.opacity); setInput('presentation-image-crop-x', element.cropX || 0); setInput('presentation-image-crop-y', element.cropY || 0); }
        const dataField = byId('presentation-element-data-field'); const dataInput = byId('presentation-element-data');
        const supportsData = element.type === 'table' || element.type === 'chart'; dataField?.classList.toggle('hidden', !supportsData);
        if (supportsData && dataInput && document.activeElement !== dataInput) {
            dataInput.value = JSON.stringify(element.type === 'table' ? { columns: element.columns, rows: element.rows } : { title: element.title, chartType: element.chartType, data: element.data, options: element.options }, null, 2);
        }
    }
    function setInput(id, value) { const input = byId(id); if (input && document.activeElement !== input) input.value = value ?? ''; }
    async function loadAssets() { return presenter()?.loadAssets?.(state); }
    function applyFontAsset(asset, kind) { return presenter()?.applyFontAsset?.(asset, kind, state, { recordHistory, renderEditor, toast }); }
    function insertAssetFromLibrary(asset) { return presenter()?.insertAssetFromLibrary?.(asset, state, { recordHistory, renderEditor }); }
    function assetByRef(ref) { return state.assets?.find(asset => asset.ref === ref) || null; }
    async function loadPresentationMetrics() { return presenter()?.loadPresentationMetrics?.(); }
    function renderTemplatePanel() { return presenter()?.renderTemplatePanel?.(state, { templateById, renderTemplates }); }
    async function saveAsOrganizationTemplate() { return presenter()?.saveAsTemplate?.('organization', state, { templateById, renderTemplatePanel, renderLibrary, selectedElement, toast }); }
    async function saveAsDepartmentTemplate() { return presenter()?.saveAsTemplate?.('department', state, { templateById, renderTemplatePanel, renderLibrary, selectedElement, toast }); }
    async function submitCurrentTemplateReview() { return presenter()?.submitCurrentTemplateReview?.(state, { templateById, renderTemplatePanel, toast }); }
    async function reviewCurrentTemplate() { return presenter()?.reviewCurrentTemplate?.(state, { templateById, renderTemplatePanel, toast }); }
    async function exportCurrentTemplate() { return presenter()?.exportCurrentTemplate?.(state, { templateById, toast }); }
    async function importTemplatePackage(file) { return presenter()?.importTemplatePackage?.(file, state, { renderTemplatePanel, renderLibrary, toast }); }
    function renderSpeakerNotes() { return presenter()?.renderSpeakerNotes?.(state); }
    function renderPresenterMode() { return presenter()?.renderPresenterMode?.(state); }
    async function openPresenterMode() { return presenter()?.openPresenterMode?.(state, { saveActive, syncRemoteSlide }); }
    function closePresenterMode() { return presenter()?.closePresenterMode?.(state); }
    function movePresenterSlide(delta) { return presenter()?.movePresenterSlide?.(delta, state, { syncRemoteSlide }); }
    function renderIssues() {
        const list = byId('presentation-issues-list'); if (!list) return;
        list.replaceChildren(); const validation = state.active?.validation || { issues: [] }; const issues = validation.issues || [];
        if (!issues.length) { const empty = document.createElement('div'); empty.className = 'presentation-empty-note'; empty.textContent = '暂无问题。导出前仍可再次执行质量检查。'; list.appendChild(empty); return; }
        issues.forEach(issue => { const item = document.createElement('button'); item.type = 'button'; item.className = `presentation-issue is-${issue.level || 'info'}`; item.dataset.presentationIssueSlide = issue.slideId || ''; item.dataset.presentationIssueElement = issue.elementId || ''; const title = document.createElement('strong'); title.textContent = issue.message; const tip = document.createElement('span'); tip.textContent = issue.suggestion || ''; item.append(title, tip); list.appendChild(item); });
    }
    async function loadVersions() { return presenter()?.loadVersions?.(state, { formatTime }); }
    async function restoreVersion(version) { return presenter()?.restoreVersion?.(version, state, { saveActive, resetHistory, renderEditor, formatTime, toast }); }
    function switchPanel(name) {
        state.panel = name;
        document.querySelectorAll('[data-presentation-panel]').forEach(button => button.classList.toggle('is-active', button.dataset.presentationPanel === name));
        ['properties', 'template', 'ai', 'assets', 'metrics', 'notes', 'comments', 'issues', 'versions'].forEach(panel => byId(`presentation-${panel}-panel`)?.classList.toggle('hidden', panel !== name));
        if (name === 'versions') loadVersions().catch(error => toast(error.message, 'error'));
        if (name === 'comments') collab()?.loadComments(state.active?.id);
        if (name === 'notes') renderSpeakerNotes();
        if (name === 'assets') loadAssets().catch(error => toast(error.message, 'error'));
        if (name === 'metrics') loadPresentationMetrics().catch(error => toast(error.message, 'error'));
    }
function setSelectedImageAsCover() {
        const element = selectedElement(); const content = activeContent();
        if (!element || element.type !== 'image' || !content) { toast('请先选择图片元素。', 'warning'); return; }
        content.metadata = { ...(content.metadata || {}), coverAssetRef: element.assetRef }; recordHistory(); renderEditor(); toast('已将所选图片设为文稿封面。');
    }
    function updateElementFromForm() {
        const element = selectedElement(); if (!element) return;
        if (element.locked) { toast('该元素由组织品牌模板锁定，不能编辑。', 'warning'); return; }
        ['x', 'y', 'width', 'height', 'rotation'].forEach(key => { const value = Number(byId(`presentation-element-${key}`)?.value); if (Number.isFinite(value)) element[key] = Math.round(value); });
        const animationType = byId('presentation-element-animation')?.value || element.animation?.type || 'none'; const animationDuration = Number(byId('presentation-element-animation-duration')?.value); element.animation = { type: animationType, durationMs: animationType === 'none' ? 0 : (Number.isFinite(animationDuration) ? animationDuration : 500), delayMs: 0, direction: '' };
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
            element.cropX = Math.max(0, Math.min(100, Number(byId('presentation-image-crop-x')?.value) || 0));
            element.cropY = Math.max(0, Math.min(100, Number(byId('presentation-image-crop-y')?.value) || 0));
        }
        recordHistory(); renderEditor();
    }
    function addText() {
        const slide = activeSlide(); if (!slide) return;
        const id = `text_${Date.now()}`; slide.elements.push(textElement(id, 120, 260, 600, 80, '双击或在右侧编辑文字')); state.selectedElementId = id; recordHistory(); renderEditor();
    }
    function addShape() { const s = activeSlide(); if (!s) return; const t = templateById(state.active.template?.id); const id = `shape_${Date.now()}`; s.elements.push({ id, type: 'shape', x: 180, y: 260, width: 300, height: 150, rotation: 0, zIndex: 5, locked: false, visible: true, sourceRefs: [], shapeType: 'roundRect', style: { fill: t?.definition?.theme?.colors?.secondary || '#5B8FF9', stroke: t?.definition?.theme?.colors?.primary || '#1769AA', strokeWidth: 1, opacity: 1, radius: 16 } }); state.selectedElementId = id; recordHistory(); renderEditor(); }
    function addTable() { const s = activeSlide(); if (!s) return; const id = `table_${Date.now()}`; s.elements.push({ id, type: 'table', x: 120, y: 250, width: 760, height: 260, rotation: 0, zIndex: 7, locked: false, visible: true, sourceRefs: [], columns: ['指标', '当前值', '说明'], rows: [['目标', '请填写', '待补充'], ['进度', '请填写', '待补充']], style: { headerFill: '#1769AA', headerColor: '#FFFFFF', cellFill: '#FFFFFF', cellColor: '#1F2937', borderColor: '#CBD5E1', fontSize: 14 } }); state.selectedElementId = id; recordHistory(); renderEditor(); }
    function addChart() { const s = activeSlide(); if (!s) return; const id = `chart_${Date.now()}`; s.elements.push({ id, type: 'chart', x: 180, y: 210, width: 720, height: 360, rotation: 0, zIndex: 7, locked: false, visible: true, sourceRefs: [], chartType: 'bar', title: '示例趋势', data: { columns: ['阶段', '数值'], rows: [['第一阶段', 35], ['第二阶段', 62], ['第三阶段', 85]] }, options: { showLegend: false, showLabels: true, colors: ['#1769AA', '#5B8FF9', '#61DDAA'] } }); state.selectedElementId = id; recordHistory(); renderEditor(); }
    function addDiagram() { const s = activeSlide(); if (!s) return; const id = 'diagram_' + Date.now(); const t = templateById(state.active?.template?.id); const c = t?.definition?.theme?.colors || {}; s.elements.push({ id, type: 'diagram', x: 120, y: 240, width: 920, height: 180, rotation: 0, zIndex: 9, locked: false, visible: true, sourceRefs: [], diagramType: 'process', items: ['规划', '执行', '复盘'], style: { fill: c.background || '#EFF6FF', stroke: c.primary || '#2563EB', textColor: c.text || '#1E3A8A', fontSize: 16 } }); state.selectedElementId = id; recordHistory(); renderEditor(); }
    async function uploadRichAsset(file) { return presenter()?.uploadRichAsset?.(file, state, { setSaveState, recordHistory, renderEditor, toast }); }
    async function uploadImage(file) {
        if (!file || !activeSlide()) return;
        const form = new FormData(); form.append('file', file);
        setSaveState('正在上传图片…', 'saving');
        try {
            const data = await requestJson(`${API}/assets`, { method: 'POST', body: form }); const id = `image_${Date.now()}`;
            activeSlide().elements.push({ id, type: 'image', x: 180, y: 180, width: 600, height: 360, rotation: 0, zIndex: 8, locked: false, visible: true, sourceRefs: [], assetRef: data.asset.ref, fit: 'cover', opacity: 1, intrinsicWidth: Number(data.asset.pixelWidth || 0), intrinsicHeight: Number(data.asset.pixelHeight || 0), alt: data.asset.filename }); state.selectedElementId = id; state.selectedElementIds = [id]; recordHistory(); renderEditor(); toast('图片已插入');
        } finally { setSaveState('待保存', 'dirty'); }
    }
    async function loadChartDatasetFields() { return presenter()?.loadChartDatasetFields?.(); }
    async function openDataChartModal() { return presenter()?.openDataChartModal?.(state, { toast }); }
    async function importDataChart() { return presenter()?.importDataChart?.(state, { recordHistory, renderEditor, toast }); }
    async function exportPresentation(format) {
        const exportModule = presenter();
        if (typeof exportModule?.exportPresentation !== 'function') throw new Error('导出模块尚未就绪，请稍后重试。');
        return exportModule.exportPresentation(format, state, { saveActive, setSaveState, activeSlide, toast });
    }
    async function createBlank(templateId = '') {
        const template = templateId || state.templates[0]?.id || 'business-blue';
        setStatus('正在创建演示文稿…');
        try { const data = await requestJson(API, jsonOptions({ title: '未命名演示文稿', templateId: template })); await loadDocuments(); await openPresentation(data.presentation.id); }
        finally { setStatus(''); }
    }
    async function openArtifactCreateModal() { return presenter()?.openArtifactCreateModal?.(populateTemplateSelect, toast); }
    async function createFromArtifact() { return presenter()?.createFromArtifact?.(state, { loadDocuments, openPresentation, toast }); }
    function getPresentationAiModelId() {
        return window.Pivot?.legacy?.PivotAppModels?.getSelectedModel?.('presentations', 'presentation-create-model')
            || byId('presentation-create-model')?.value
            || byId('presentation-ai-model')?.value
            || '';
    }
    function requirePresentationAiModel() {
        const modelId = getPresentationAiModelId();
        if (!modelId) toast('请先选择可用的 AI 模型；若列表为空，请在“模型管理”配置并启用模型。', 'error');
        return modelId;
    }
    async function refreshPresentationAiModelSelectors() {
        const appModels = window.Pivot?.legacy?.PivotAppModels;
        await Promise.all([
            appModels?.refresh?.('presentations', 'presentation-create-model'),
            appModels?.refresh?.('presentations', 'presentation-ai-model')
        ]);
    }
    function openCreateModal() {
        populateTemplateSelect(byId('presentation-create-template'));
        byId('presentation-create-modal')?.classList.remove('hidden');
        void refreshPresentationAiModelSelectors();
        window.setTimeout(() => byId('presentation-create-topic')?.focus(), 0);
    }
    function closeCreateModal() { abortAiRequest(); byId('presentation-create-modal')?.classList.add('hidden'); }
    function populateTemplateSelect(select) {
        if (!select) return; select.replaceChildren(); state.templates.forEach(template => { const option = document.createElement('option'); option.value = template.id; option.textContent = template.name; select.appendChild(option); });
    }
    function createRequestFromForm() {
        const topic = byId('presentation-create-topic')?.value.trim() || '';
        return {
            topic, title: topic, pageCount: byId('presentation-create-pages')?.value || 8, audience: byId('presentation-create-audience')?.value || '', purpose: byId('presentation-create-purpose')?.value || '',
            duration: byId('presentation-create-duration')?.value ? byId('presentation-create-duration').value + ' 分钟' : '', language: byId('presentation-create-language')?.value || 'zh-CN', style: byId('presentation-create-style')?.value || '', templateId: byId('presentation-create-template')?.value || 'business-blue', model: getPresentationAiModelId(),
            needsCharts: Boolean(byId('presentation-create-needs-charts')?.checked), retainSourceRefs: Boolean(byId('presentation-create-retain-sources')?.checked),
            mustInclude: byId('presentation-create-must-include')?.value.trim() || '', prohibitedContent: byId('presentation-create-prohibited-content')?.value.trim() || '',
            materials: byId('presentation-create-material')?.value.trim() ? [{ id: 'source_1', title: '用户提供的材料', text: byId('presentation-create-material').value.trim() }] : []
        };
    }
    async function generateOutline() {
        const request = createRequestFromForm(); if (!request.topic) { toast('请输入演示主题。', 'error'); return; }
        if (!request.model) { requirePresentationAiModel(); return; }
        const button = byId('presentation-create-submit-btn'); const controller = beginAiRequest();
        button?.setAttribute('disabled', ''); if (button) button.textContent = '正在生成大纲…';
        try {
            const file = byId('presentation-create-material-file')?.files?.[0];
            if (file) {
                button && (button.textContent = '正在提取材料…');
                const form = new FormData(); form.append('file', file);
                const extracted = await requestJson(API + '/materials/extract', { method: 'POST', body: form, signal: controller.signal });
                request.materials = [...request.materials, extracted.material].slice(0, 20);
            }
            button && (button.textContent = '正在生成大纲…');
            const data = await requestJson(API + '/ai/outline', aiJsonOptions(request, controller));
            state.pendingCreate = request; state.pendingOutline = data.outline; byId('presentation-outline-editor').value = JSON.stringify(data.outline, null, 2); byId('presentation-outline-warnings').textContent = (data.outline.warnings || data.outline.assumptions || []).join('\n'); closeCreateModal(); byId('presentation-outline-modal')?.classList.remove('hidden');
        } catch (error) {
            if (isAiAbort(error, controller)) { toast('AI 大纲生成已取消。', 'warning'); return; }
            throw error;
        } finally { endAiRequest(controller); button?.removeAttribute('disabled'); if (button) button.textContent = '生成大纲'; }
    }
    async function generateSlides() {
        let outline;
        try { outline = JSON.parse(byId('presentation-outline-editor')?.value || ''); } catch (_) { toast('大纲 JSON 格式无效，请修正后再生成。', 'error'); return; }
        const button = byId('presentation-outline-confirm-btn'); const controller = beginAiRequest();
        button?.setAttribute('disabled', ''); if (button) button.textContent = '正在生成页面…';
        try {
            const request = { ...state.pendingCreate, outline, title: outline.title || state.pendingCreate.topic };
            const data = await requestJson(API + '/ai/slides', aiJsonOptions(request, controller));
            const created = await requestJson(API, jsonOptions({ title: data.proposal.presentation.title, templateId: request.templateId, content: data.proposal.presentation }));
            byId('presentation-outline-modal')?.classList.add('hidden'); await loadDocuments(); await openPresentation(created.presentation.id); toast('AI 初稿已生成，可继续在画布中编辑。');
        } catch (error) {
            if (isAiAbort(error, controller)) { toast('AI 页面生成已取消。', 'warning'); return; }
            throw error;
        } finally { endAiRequest(controller); button?.removeAttribute('disabled'); if (button) button.textContent = '生成页面'; }
    }
    async function rewriteCurrentSlide() {
        const slide = activeSlide(); if (!slide || !state.active?.content) return;
        const instruction = byId('presentation-ai-instruction')?.value.trim(); if (!instruction) { toast('请先输入改写要求。', 'error'); return; }
        const model = requirePresentationAiModel(); if (!model) return;
        const button = byId('presentation-ai-rewrite-btn'); const controller = beginAiRequest();
        button?.setAttribute('disabled', ''); if (button) button.textContent = '正在生成建议…';
        try {
            const data = await requestJson(API + '/ai/rewrite', aiJsonOptions({ title: state.active.content.title, topic: state.active.content.title, templateId: state.active.template?.id, model, slide, instruction, materials: state.active.content.sources || [] }, controller));
            const proposed = data.proposal.presentation?.slides?.[0]; if (!proposed) throw new Error('AI 未返回可用页面。');
            const accepted = await window.Pivot.legacy.showConfirm?.('应用 AI 页面建议', 'AI 将替换当前页面内容。你可以通过“撤销”恢复原页面。');
            if (accepted) { const index = state.active.content.slides.findIndex(item => item.id === slide.id); proposed.id = slide.id; proposed.index = index; state.active.content.slides[index] = proposed; state.selectedElementId = ''; recordHistory(); renderEditor(); toast('已应用 AI 页面建议。'); }
        } catch (error) {
            if (isAiAbort(error, controller)) { toast('AI 页面改写已取消。', 'warning'); return; }
            throw error;
        } finally { endAiRequest(controller); button?.removeAttribute('disabled'); if (button) button.textContent = 'AI 改写当前页'; }
    }
    function nextPresentationElementId(prefix, index) {
        return prefix + '_' + Date.now() + '_' + index + '_' + Math.random().toString(36).slice(2, 7);
    }
    async function continuePresentation() {
        const content = activeContent(); const current = activeSlide();
        if (!content || !current) return;
        const model = requirePresentationAiModel(); if (!model) return;
        const rawCount = await window.Pivot.legacy.showInputPrompt?.({ title: '继续生成页面', message: '新增页数（1–10）', value: '1', required: true, width: 420 });
        if (!rawCount) return;
        const additionalSlideCount = Math.max(1, Math.min(Number.parseInt(rawCount, 10) || 1, 10));
        const instruction = byId('presentation-ai-instruction')?.value.trim() || '延续当前结构补充后续内容。';
        const button = byId('presentation-ai-continue-btn'); const controller = beginAiRequest();
        button?.setAttribute('disabled', ''); if (button) button.textContent = '正在生成…';
        try {
            const data = await requestJson(API + '/ai/continue', aiJsonOptions({ title: content.title, topic: content.title, templateId: content.template?.id, model, presentation: content, additionalSlideCount, instruction, materials: [] }, controller));
            const generated = data.proposal?.presentation?.slides || [];
            if (generated.length !== additionalSlideCount) throw new Error('AI 未返回请求数量的新增页面。');
            const accepted = await window.Pivot.legacy.showConfirm?.('插入 AI 新增页面', '将把 ' + generated.length + ' 页插入当前页之后；可通过“撤销”恢复。');
            if (!accepted) return;
            const insertionIndex = content.slides.findIndex(item => item.id === current.id) + 1;
            const inserted = generated.map((slide, slideIndex) => ({ ...slide, id: nextPresentationElementId('slide', slideIndex), index: insertionIndex + slideIndex, elements: (slide.elements || []).map((element, elementIndex) => ({ ...element, id: nextPresentationElementId('element', slideIndex + '_' + elementIndex) })) }));
            content.slides.splice(insertionIndex, 0, ...inserted); content.slides.forEach((slide, index) => { slide.index = index; });
            state.selectedSlideId = inserted[0]?.id || state.selectedSlideId; state.selectedElementId = ''; recordHistory(); renderEditor(); toast('已插入 ' + inserted.length + ' 页 AI 内容。');
        } catch (error) {
            if (isAiAbort(error, controller)) { toast('AI 继续生成已取消。', 'warning'); return; }
            throw error;
        } finally { endAiRequest(controller); button?.removeAttribute('disabled'); if (button) button.textContent = '继续生成页面'; }
    }
    async function runAiContentValidation() {
        const content = activeContent(); if (!content) return;
        const model = requirePresentationAiModel(); if (!model) return;
        const button = byId('presentation-ai-validate-btn'); const controller = beginAiRequest();
        button?.setAttribute('disabled', ''); if (button) button.textContent = '正在检查…';
        try {
            await saveActive({ force: true });
            const data = await requestJson(API + '/ai/validate', aiJsonOptions({ model, presentation: content, materials: [] }, controller));
            const deterministic = state.active?.validation?.issues || [];
            const aiIssues = (data.validation?.issues || []).map(issue => ({ ...issue, level: issue.severity === 'blocking' ? 'blocking' : issue.severity === 'warning' ? 'warning' : 'info', message: 'AI 内容检查：' + (issue.message || '发现待核实问题') }));
            const assumptions = (data.validation?.assumptions || []).map((text, index) => ({ level: 'warning', code: 'AI_ASSUMPTION_' + index, slideId: '', elementId: '', message: 'AI 待核实假设：' + text, suggestion: '补充来源或人工确认。' }));
            const level = aiIssues.some(issue => issue.level === 'blocking') ? 'blocked' : aiIssues.some(issue => issue.level === 'warning') || assumptions.length ? 'warning' : (state.active.validation?.status || 'passed');
            state.active.validation = { ...(state.active.validation || {}), status: level, issues: [...deterministic, ...aiIssues, ...assumptions], aiValidation: { status: data.validation?.status || 'passed', checkedAt: new Date().toISOString() } };
            switchPanel('issues'); renderIssues(); toast(aiIssues.length || assumptions.length ? 'AI 内容检查发现 ' + (aiIssues.length + assumptions.length) + ' 项待处理事项。' : 'AI 内容检查未发现新增问题。', aiIssues.some(issue => issue.level === 'blocking') ? 'warning' : 'success');
        } catch (error) {
            if (isAiAbort(error, controller)) { toast('AI 内容检查已取消。', 'warning'); return; }
            throw error;
        } finally { endAiRequest(controller); button?.removeAttribute('disabled'); if (button) button.textContent = 'AI 内容检查'; }
    }
    async function runCheck() {
        if (!state.active?.id) return; setSaveState('正在检查…', 'saving');
        try { await saveActive({ force: true }); const data = await requestJson(`${API}/${encodeURIComponent(state.active.id)}/validation`); state.active.validation = data.validation; switchPanel('issues'); renderIssues(); const label = data.validation.status === 'passed' ? '未发现阻断问题' : `发现 ${data.validation.issues?.length || 0} 项检查结果`; toast(label, data.validation.status === 'blocked' ? 'warning' : 'success'); }
        finally { setSaveState('已保存', 'saved'); }
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
    function selectedElements() {
        const slide = activeSlide();
        if (!slide) return [];
        const ids = state.selectedElementIds?.length ? state.selectedElementIds : state.selectedElementId ? [state.selectedElementId] : [];
        return slide.elements.filter(element => ids.includes(element.id));
    }
    function selectPresentationElement(id, { additive = false } = {}) {
        const current = new Set(state.selectedElementIds || []);
        if (additive) current.has(id) ? current.delete(id) : current.add(id);
        else { current.clear(); current.add(id); }
        state.selectedElementIds = [...current]; state.selectedElementId = state.selectedElementIds.at(-1) || ''; renderStage(); renderProperties();
    }
    function copySelectedElements() {
        const elements = selectedElements();
        if (!elements.length) { toast('请先选择要复制的元素。', 'warning'); return; }
        state.elementClipboard = deepClone(elements); toast('已复制 ' + elements.length + ' 个元素。');
    }
    function pasteSelectedElements() {
        const slide = activeSlide(); const copied = state.elementClipboard;
        if (!slide || !Array.isArray(copied) || !copied.length) { toast('剪贴板中没有可粘贴的元素。', 'warning'); return; }
        const created = copied.map((element, index) => ({ ...deepClone(element), id: element.id + '_copy_' + Date.now() + '_' + index, x: Math.min(state.active.content.width - element.width, Math.max(0, Number(element.x || 0) + 24)), y: Math.min(state.active.content.height - element.height, Math.max(0, Number(element.y || 0) + 24)), groupId: '' }));
        slide.elements.push(...created); state.selectedElementIds = created.map(element => element.id); state.selectedElementId = state.selectedElementIds.at(-1) || ''; recordHistory(); renderEditor(); toast('已粘贴 ' + created.length + ' 个元素。');
    }
    function groupSelectedElements() {
        const elements = selectedElements().filter(element => !element.locked);
        if (elements.length < 2) { toast('请至少选择两个未锁定元素后再组合。', 'warning'); return; }
        const groupId = 'group_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
        elements.forEach(element => { element.groupId = groupId; }); recordHistory(); renderEditor(); toast('已组合所选元素。');
    }
    function ungroupSelectedElements() {
        const elements = selectedElements().filter(element => element.groupId && !element.locked);
        if (!elements.length) { toast('请选择已组合的元素。', 'warning'); return; }
        const groupIds = new Set(elements.map(element => element.groupId)); activeSlide().elements.forEach(element => { if (groupIds.has(element.groupId) && !element.locked) element.groupId = ''; }); recordHistory(); renderEditor(); toast('已取消组合。');
    }
    function alignSelectedElements(mode) {
        const elements = selectedElements().filter(element => !element.locked);
        if (elements.length < 2) { toast('请至少选择两个未锁定元素后再对齐。', 'warning'); return; }
        const left = Math.min(...elements.map(element => element.x)); const right = Math.max(...elements.map(element => element.x + element.width));
        if (mode === 'left') elements.forEach(element => { element.x = left; });
        if (mode === 'center') elements.forEach(element => { element.x = Math.round((left + right - element.width) / 2); });
        if (mode === 'distribute') { const ordered = [...elements].sort((a, b) => a.x - b.x); const occupied = ordered.reduce((sum, element) => sum + element.width, 0); const gap = ordered.length > 1 ? Math.max(0, (right - left - occupied) / (ordered.length - 1)) : 0; let cursor = left; ordered.forEach(element => { element.x = Math.round(cursor); cursor += element.width + gap; }); }
        recordHistory(); renderEditor();
    }
    function adjustTableStructure(action) {
        const element = selectedElement(); if (!element || element.type !== 'table' || element.locked) { toast('请先选择可编辑的表格。', 'warning'); return; }
        const columns = Array.isArray(element.columns) ? element.columns : []; const rows = Array.isArray(element.rows) ? element.rows : [];
        if (action === 'add-row' && rows.length < 100) rows.push(columns.map(() => ''));
        if (action === 'remove-row' && rows.length) rows.pop();
        if (action === 'add-column' && columns.length < 20) { columns.push('字段 ' + (columns.length + 1)); rows.forEach(row => row.push('')); }
        if (action === 'remove-column' && columns.length > 1) { columns.pop(); rows.forEach(row => row.pop()); }
        element.columns = columns; element.rows = rows; recordHistory(); renderEditor();
    }
    async function replaceSelectedImage(file) {
        const element = selectedElement(); if (!file || !element || element.type !== 'image' || element.locked) { toast('请先选择可编辑的图片元素。', 'warning'); return; }
        const form = new FormData(); form.append('file', file); setSaveState('正在替换图片…', 'saving');
        try { const data = await requestJson(API + '/assets', { method: 'POST', body: form }); element.assetRef = data.asset.ref; element.intrinsicWidth = Number(data.asset.pixelWidth || 0); element.intrinsicHeight = Number(data.asset.pixelHeight || 0); element.alt = data.asset.filename || element.alt; recordHistory(); renderEditor(); toast('图片已替换。'); }
        finally { setSaveState('待保存', 'dirty'); }
    }
    function changeLayer(delta) {
        const element = selectedElement(); if (!element) return;
        if (element.locked) { toast('该元素由组织品牌模板锁定，不能调整层级。', 'warning'); return; }
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
            const docAction = event.target.closest('[data-presentation-action]'); if (docAction) { const id = docAction.dataset.presentationId; const action = docAction.dataset.presentationAction; if (action === 'open') openPresentation(id).catch(error => toast(error.message, 'error')); if (action === 'duplicate') duplicateDocument(id).catch(error => toast(error.message, 'error')); if (action === 'delete') deleteDocument(id).catch(error => toast(error.message, 'error')); if (action === 'favorite') toggleFavoriteDocument(id, docAction.dataset.presentationFavorite === 'true').catch(error => toast(error.message, 'error')); if (action === 'tags') { let tags = []; try { tags = JSON.parse(docAction.dataset.presentationTags || '[]'); } catch (_) {} updateDocumentTags(id, tags).catch(error => toast(error.message, 'error')); } return; }
            const slideButton = event.target.closest('[data-presentation-slide-id]'); if (slideButton) { state.selectedSlideId = slideButton.dataset.presentationSlideId; state.selectedElementId = ''; state.selectedElementIds = []; renderEditor(); collab()?.sendPresenceHeartbeat?.(); syncRemoteSlide().catch(() => {}); return; }
            const elementNode = event.target.closest('[data-presentation-element-id]'); if (elementNode) { selectPresentationElement(elementNode.dataset.presentationElementId, { additive: event.shiftKey || event.ctrlKey || event.metaKey }); return; }
            const panel = event.target.closest('[data-presentation-panel]'); if (panel) { switchPanel(panel.dataset.presentationPanel); return; }
            const issue = event.target.closest('[data-presentation-issue-slide]'); if (issue) { state.selectedSlideId = issue.dataset.presentationIssueSlide || state.selectedSlideId; const elementId = String(issue.dataset.presentationIssueElement || '').split(',')[0]; state.selectedElementId = elementId; renderEditor(); return; }
            if (collab()?.handleCollabClick?.(event)) return;
            if (event.target.closest('#presentation-create-ai-btn')) { openCreateModal(); return; }
            if (event.target.closest('#presentation-create-blank-btn')) { createBlank().catch(error => toast(error.message, 'error')); return; }
            if (event.target.closest('#presentation-create-from-artifact-btn')) { openArtifactCreateModal().catch(error => toast(error.message, 'error')); return; }
            if (event.target.closest('#presentation-artifact-cancel-btn')) { byId('presentation-artifact-modal')?.classList.add('hidden'); return; }
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
        if (event.target.closest('#presentation-save-department-template-btn')) { saveAsDepartmentTemplate().catch(error => toast(error.message, 'error')); return; }
        if (event.target.closest('#presentation-submit-template-review-btn')) { submitCurrentTemplateReview().catch(error => toast(error.message, 'error')); return; }
        if (event.target.closest('#presentation-review-template-btn')) { reviewCurrentTemplate().catch(error => toast(error.message, 'error')); return; }
            if (event.target.closest('#presentation-export-template-btn')) { exportCurrentTemplate().catch(error => toast(error.message, 'error')); return; }
            if (event.target.closest('#presentation-import-template-btn')) { byId('presentation-template-package-input')?.click(); return; }
            if (event.target.closest('#presentation-upload-image-btn')) { byId('presentation-image-input')?.click(); return; }
            if (event.target.closest('#presentation-add-diagram-btn')) { addDiagram(); return; }
            if (event.target.closest('#presentation-insert-media-btn')) { state.pendingAssetType = 'media'; byId('presentation-rich-asset-input')?.click(); return; }
            if (event.target.closest('#presentation-insert-attachment-btn')) { state.pendingAssetType = 'attachment'; byId('presentation-rich-asset-input')?.click(); return; }
            if (event.target.closest('#presentation-upload-font-btn')) { state.pendingAssetType = 'font'; byId('presentation-rich-asset-input')?.click(); return; }
            if (event.target.closest('#presentation-assets-refresh-btn')) { loadAssets().catch(error => toast(error.message, 'error')); return; }
            if (event.target.closest('#presentation-metrics-refresh-btn')) { loadPresentationMetrics().catch(error => toast(error.message, 'error')); return; }
            const assetAction = event.target.closest('[data-presentation-asset-action]'); if (assetAction) { const asset = assetByRef(assetAction.dataset.presentationAssetRef); if (!asset) return; if (assetAction.dataset.presentationAssetAction === 'insert') insertAssetFromLibrary(asset); else if (assetAction.dataset.presentationAssetAction === 'font-heading') applyFontAsset(asset, 'heading'); else if (assetAction.dataset.presentationAssetAction === 'font-body') applyFontAsset(asset, 'body'); return; }
            if (event.target.closest('#presentation-set-cover-btn')) { setSelectedImageAsCover(); return; }
            if (event.target.closest('#presentation-delete-element-btn')) { const slide = activeSlide(); const element = selectedElement(); if (element?.locked) { toast('该元素由组织品牌模板锁定，不能删除。', 'warning'); return; } if (slide && state.selectedElementId) { slide.elements = slide.elements.filter(item => item.id !== state.selectedElementId); state.selectedElementId = ''; recordHistory(); renderEditor(); } return; }
            if (event.target.closest('#presentation-copy-element-btn')) { copySelectedElements(); return; }
            if (event.target.closest('#presentation-paste-element-btn')) { pasteSelectedElements(); return; }
            if (event.target.closest('#presentation-group-elements-btn')) { groupSelectedElements(); return; }
            if (event.target.closest('#presentation-ungroup-elements-btn')) { ungroupSelectedElements(); return; }
            if (event.target.closest('#presentation-align-left-btn')) { alignSelectedElements('left'); return; }
            if (event.target.closest('#presentation-align-center-btn')) { alignSelectedElements('center'); return; }
            if (event.target.closest('#presentation-distribute-horizontal-btn')) { alignSelectedElements('distribute'); return; }
            if (event.target.closest('#presentation-table-add-row-btn')) { adjustTableStructure('add-row'); return; }
            if (event.target.closest('#presentation-table-remove-row-btn')) { adjustTableStructure('remove-row'); return; }
            if (event.target.closest('#presentation-table-add-column-btn')) { adjustTableStructure('add-column'); return; }
            if (event.target.closest('#presentation-table-remove-column-btn')) { adjustTableStructure('remove-column'); return; }
            if (event.target.closest('#presentation-replace-image-btn')) { byId('presentation-replace-image-input')?.click(); return; }
            if (event.target.closest('#presentation-layer-up-btn')) { changeLayer(1); return; }
            if (event.target.closest('#presentation-layer-down-btn')) { changeLayer(-1); return; }
            if (event.target.closest('#presentation-check-btn')) { runCheck().catch(error => toast(error.message, 'error')); return; }
            if (event.target.closest('#presentation-presenter-btn') || event.target.closest('#presentation-notes-presenter-btn')) { openPresenterMode().catch(error => toast(error.message, 'error')); return; }
            if (event.target.closest('#presentation-remote-start-btn')) { startRemotePresentation().catch(error => toast(error.message, 'error')); return; }
            if (event.target.closest('#presentation-remote-stop-btn')) { stopRemotePresentation().catch(error => toast(error.message, 'error')); return; }
            if (event.target.closest('#presentation-presenter-prev-btn')) { movePresenterSlide(-1); return; }
            if (event.target.closest('#presentation-presenter-next-btn')) { movePresenterSlide(1); return; }
            if (event.target.closest('#presentation-presenter-close-btn')) { closePresenterMode(); return; }
            if (event.target.closest('#presentation-export-options-btn')) { syncExportOptionsForm(); byId('presentation-export-options-modal')?.classList.remove('hidden'); return; }
            if (event.target.closest('#presentation-export-options-cancel-btn')) { byId('presentation-export-options-modal')?.classList.add('hidden'); return; }
            if (event.target.closest('#presentation-export-options-save-btn')) { saveExportOptions(); return; }
            if (event.target.closest('#presentation-export-pptx-btn')) { exportPresentation('pptx').catch(error => toast(error.message, 'error')); return; }
            if (event.target.closest('#presentation-export-pdf-btn')) { exportPresentation('pdf').catch(error => toast(error.message, 'error')); return; }
            if (event.target.closest('#presentation-export-png-btn')) { exportPresentation('png').catch(error => toast(error.message, 'error')); return; }
            if (event.target.closest('#presentation-ai-rewrite-btn')) { rewriteCurrentSlide().catch(error => toast(error.message, 'error')); return; }
        if (event.target.closest('#presentation-ai-continue-btn')) { continuePresentation().catch(error => toast(error.message, 'error')); return; }
        if (event.target.closest('#presentation-ai-validate-btn')) { runAiContentValidation().catch(error => toast(error.message, 'error')); return; }
        if (event.target.closest('#presentation-ai-stop-btn')) { if (abortAiRequest()) toast('正在停止 AI 任务…', 'warning'); return; }
            if (event.target.closest('#presentation-create-cancel-btn') || event.target.closest('#presentation-create-header-close-btn') || event.target.id === 'presentation-create-modal') { closeCreateModal(); return; }
        if (event.target.closest('#presentation-create-stop-btn') || event.target.closest('#presentation-outline-stop-btn')) { if (abortAiRequest()) toast('正在停止 AI 任务…', 'warning'); return; }
            if (event.target.closest('#presentation-data-chart-cancel-btn')) { byId('presentation-data-chart-modal')?.classList.add('hidden'); return; }
            if (event.target.closest('#presentation-refresh-versions-btn')) { loadVersions().catch(error => toast(error.message, 'error')); return; }
            const restore = event.target.closest('[data-presentation-restore-version]'); if (restore) { restoreVersion(Number(restore.dataset.presentationRestoreVersion)).catch(error => toast(error.message, 'error')); return; }
            if (event.target.closest('#presentation-outline-back-btn')) { byId('presentation-outline-modal')?.classList.add('hidden'); openCreateModal(); return; }
            if (event.target.closest('#presentation-outline-confirm-btn')) { generateSlides().catch(error => toast(error.message, 'error')); return; }
            if (event.target.closest('#presentation-library-reset-btn')) { resetLibraryFilters(); return; }
            if (event.target.closest('#presentation-sync-btn') || event.target.closest('#presentation-save-state')) { syncRemotePresentation().catch(error => toast(error.message, 'error')); return; }
        });
        view.addEventListener('submit', event => {
            if (collab()?.handleCollabSubmit?.(event)) return;
            if (event.target?.id === 'presentation-create-form') { event.preventDefault(); generateOutline().catch(error => toast(error.message, 'error')); }
        if (event.target?.id === 'presentation-artifact-form') { event.preventDefault(); createFromArtifact().catch(error => toast(error.message, 'error')); }
            if (event.target?.id === 'presentation-data-chart-form') { event.preventDefault(); importDataChart().catch(error => toast(error.message, 'error')); }
        });
        view.addEventListener('input', event => { if (['presentation-library-search', 'presentation-library-tag', 'presentation-library-created-by'].includes(event.target?.id)) { scheduleLibraryFilter(); return; } if (event.target?.id === 'presentation-title-input' && state.active?.content) { state.active.content.title = event.target.value.slice(0, 160); state.active.title = state.active.content.title; recordHistory(); } if (event.target?.id === 'presentation-speaker-notes') { const slide = activeSlide(); if (slide) { slide.speakerNotes = event.target.value.slice(0, 8000); scheduleSave(); } } if (event.target?.closest('#presentation-properties-form') && event.target?.id !== 'presentation-element-data') updateElementFromForm(); });
        view.addEventListener('change', event => { if (['presentation-library-template', 'presentation-library-status', 'presentation-library-updated-from', 'presentation-library-updated-to'].includes(event.target?.id)) { scheduleLibraryFilter(); return; } if (event.target?.id === 'presentation-library-favorite-only') { state.libraryPage = 1; state.libraryFilters.favorite = Boolean(event.target.checked); loadDocuments().catch(error => toast(error.message, 'error')); return; } if (event.target?.id === 'presentation-speaker-notes') { recordHistory(); return; } if (event.target?.id === 'presentation-image-input') uploadImage(event.target.files?.[0]).catch(error => toast(error.message, 'error')); if (event.target?.id === 'presentation-replace-image-input') replaceSelectedImage(event.target.files?.[0]).catch(error => toast(error.message, 'error')); if (event.target?.id === 'presentation-template-package-input') importTemplatePackage(event.target.files?.[0]).catch(error => toast(error.message, 'error')); if (event.target?.id === 'presentation-rich-asset-input') uploadRichAsset(event.target.files?.[0]).catch(error => toast(error.message, 'error')); if (event.target?.id === 'presentation-layout-select') { const slide = activeSlide(); if (slide) { applyLayoutToSlide(event.target.value); recordHistory(); renderEditor(); } } if (event.target?.id === 'presentation-zoom-select') { state.zoom = Number(event.target.value) || 0.65; renderStage(); } if (event.target?.id === 'presentation-chart-dataset') loadChartDatasetFields().catch(error => toast(error.message, 'error')); if (event.target?.id === 'presentation-element-data') { try { const parsed = JSON.parse(event.target.value); const element = selectedElement(); if (element?.type === 'table') { element.columns = parsed.columns; element.rows = parsed.rows; } if (element?.type === 'chart') { element.title = parsed.title || ''; element.chartType = parsed.chartType || 'bar'; element.data = parsed.data; element.options = parsed.options || element.options; } recordHistory(); renderEditor(); } catch (_) { toast('表格或图表数据必须是有效 JSON；当前修改尚未应用。', 'error'); } } });
        view.addEventListener('pointerdown', event => { const node = event.target.closest('[data-presentation-element-id]'); const element = selectedElement(); if (node && element && node.dataset.presentationElementId === element.id) startDrag(event, element); });
        window.addEventListener('pointermove', moveDrag); window.addEventListener('pointerup', endDrag);
        view.addEventListener('keydown', event => {
            const modal = byId('presentation-presenter-modal');
            if (!modal || modal.classList.contains('hidden')) return;
            if (event.key === 'Escape') { event.preventDefault(); closePresenterMode(); }
            if (event.key === 'ArrowLeft') { event.preventDefault(); movePresenterSlide(-1); }
            if (event.key === 'ArrowRight' || event.key === ' ') { event.preventDefault(); movePresenterSlide(1); }
        });
        window.addEventListener('beforeunload', () => { stopPresentationRealtime(); stopPresentationSync(); collab()?.stopPresenceHeartbeat?.(); closePresenterMode(); });
    }
    async function duplicateDocument(id) { const data = await requestJson(`${API}/${encodeURIComponent(id)}/duplicate`, jsonOptions({})); await loadDocuments(); await openPresentation(data.presentation.id); toast('已创建演示文稿副本。'); }
    async function deleteDocument(id) { const accepted = await window.Pivot.legacy.showConfirm?.('删除演示文稿', '删除后文稿将归档，不会影响已导出的历史文件。'); if (!accepted) return; await requestJson(`${API}/${encodeURIComponent(id)}`, { method: 'DELETE' }); await loadDocuments(); toast('演示文稿已归档。'); }
    async function showPresentationsApp(options = {}) {
        ensureView(); hideOtherAppViews();
        try { await loadTemplates(); } catch (error) { throw new Error('加载 PPT 模板失败：' + (error.message || '未知错误')); }
        try { await loadDocuments(); } catch (error) { throw new Error('加载 PPT 文稿库失败：' + (error.message || '未知错误')); }
        await refreshPresentationAiModelSelectors();
        if (options?.presentationId) {
            await openPresentation(options.presentationId);
            return;
        }
        if (!state.active) { byId('presentation-library')?.classList.remove('hidden'); byId('presentation-editor')?.classList.add('hidden'); }
    }
    window.Pivot?.exposeModule?.('apps.presentations', { ready: true, showPresentationsApp, loadDocuments, openPresentation, renderPresenterMode, syncRemotePresentation });
})();
