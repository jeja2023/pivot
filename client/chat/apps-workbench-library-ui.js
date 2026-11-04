// 公文列表、创建与文档切换。
let officialWritingOpenSequence = 0;
function getOfficialWritingDocSummary(doc) {
    return doc?._loaded ? officialWritingDocument.summary(doc.state) : { docType: '通知', draftCount: 0, sourceCount: 0, pendingSuggestions: 0, status: '待起草', ...doc?.summary };
}

function renderOfficialWritingDocItems(docs) {
    return docs.map(doc => {
        const summary = getOfficialWritingDocSummary(doc);
        const active = doc.id === officialWritingLibrary.activeId;
        const itemClass = ['official-writing-doc-item', active ? 'active' : '']
            .filter(Boolean)
            .join(' ');
        const meta = `${summary.docType} · ${summary.status} · ${formatVersionTime(doc.updatedAt)}`;
        return `
        <div class="${itemClass}" data-official-writing-doc-id="${escapeAppsHtml(doc.id)}" role="listitem">
            <button type="button" class="btn-secondary official-writing-doc-open" data-official-writing-doc-open="${escapeAppsHtml(doc.id)}" title="${escapeAppsHtml(doc.title)}">
                <strong>${escapeAppsHtml(doc.title || '未命名公文')}</strong>
                <small>${escapeAppsHtml(meta)}</small>
            </button>
            <span class="official-writing-doc-actions">
                <button type="button" class="btn-secondary" data-official-writing-doc-rename="${escapeAppsHtml(doc.id)}" title="重命名" aria-label="重命名">重命名</button>
                <button type="button" class="btn-secondary" data-official-writing-doc-delete="${escapeAppsHtml(doc.id)}" title="删除" aria-label="删除">删除</button>
            </span>
        </div>`;
    }).join('');
}

function getOfficialWritingStatusClass(summary) {
    if (summary.draftCount > 0 && summary.pendingSuggestions > 0) return 'review';
    if (summary.draftCount > 0) return 'ready';
    if (summary.sourceCount > 0) return 'draftable';
    return 'empty';
}

function getOfficialWritingLibraryPageInfo(total) {
    const limit = Math.max(Number(officialWritingUiState.libraryPageSize || 10), 1);
    const totalPages = Math.max(Math.ceil(total / limit), 1);
    const page = Math.min(Math.max(Number(officialWritingUiState.libraryPage || 1), 1), totalPages);
    officialWritingUiState.libraryPage = page;
    officialWritingUiState.libraryPageSize = limit;
    return {
        total,
        limit,
        totalPages,
        page,
        startIndex: (page - 1) * limit
    };
}

function renderOfficialWritingHomeSummary(_docs, pageDocs) {
    const summaryEl = document.getElementById('official-writing-home-summary');
    if (!summaryEl) return;
    const total = Number(officialWritingUiState.libraryTotal || 0);
    const pageLength = Array.isArray(pageDocs) ? pageDocs.length : 0;
    if (total === 0) {
        PivotSafeHtml.setHtml(summaryEl, '<span class="official-writing-stat-badge empty">暂无公文</span><span class="official-writing-stat-hint">可点击右上角“创建公文”或“导入备份”开始写作</span>');
        return;
    }
    PivotSafeHtml.setHtml(summaryEl, `<span class="official-writing-stat-badge">共 <b>${total}</b> 篇公文</span><span class="official-writing-stat-detail">本页 <b>${pageLength}</b> 篇</span><span class="official-writing-stat-hint">· 按需加载正文</span>`);
}

function renderOfficialWritingDocTableRows(docs, startIndex = 0) {
    if (!docs.length) {
        return '<tr><td colspan="9" class="text-center official-writing-table-empty">暂无公文</td></tr>';
    }
    return docs.map((doc, index) => {
        const summary = getOfficialWritingDocSummary(doc);
        const statusClass = getOfficialWritingStatusClass(summary);
        const saveLabel = doc._saveStatus === 'conflict' ? '版本冲突' : doc._saveStatus === 'error' ? '保存失败' : doc._saveStatus === 'dirty' || doc._saveStatus === 'saving' ? '未保存' : '';
        return `
            <tr data-official-writing-doc-id="${escapeAppsHtml(doc.id)}">
                <td class="text-center">${startIndex + index + 1}</td>
                <td><span class="official-writing-table-name">${escapeAppsHtml(doc.title || '未命名公文')}</span>${saveLabel ? `<span class="official-writing-status-pill">${saveLabel}</span>` : ''}</td>
                <td>${escapeAppsHtml(summary.docType)}</td>
                <td class="text-center"><span class="official-writing-status-pill ${statusClass}">${escapeAppsHtml(summary.status)}</span></td>
                <td class="text-center">${summary.draftCount} 字</td>
                <td class="text-center">${summary.sourceCount} 字</td>
                <td class="text-center">${summary.pendingSuggestions} 建议</td>
                <td>${escapeAppsHtml(formatVersionTime(doc.updatedAt))}</td>
                <td class="text-center">
                    <span class="official-writing-row-actions">
                        <button type="button" class="btn-secondary official-writing-row-action" data-official-writing-doc-open="${escapeAppsHtml(doc.id)}">编辑</button>
                        <button type="button" class="btn-secondary official-writing-row-action" data-official-writing-doc-rename="${escapeAppsHtml(doc.id)}">重命名</button>
                        <button type="button" class="btn-secondary official-writing-row-action" data-official-writing-doc-delete="${escapeAppsHtml(doc.id)}">删除</button>
                    </span>
                </td>
            </tr>`;
    }).join('');
}

function renderOfficialWritingDocPagination(pageInfo) {
    const pager = document.getElementById('official-writing-pagination');
    if (!pager) return;
    if (typeof window.Pivot.legacy.renderWorkspacePagination !== 'function') {
        pager.replaceChildren();
        return;
    }
    window.Pivot.legacy.renderWorkspacePagination(pager, {
        total: pageInfo.total,
        page: pageInfo.page,
        limit: pageInfo.limit,
        onPageChange: targetPage => {
            officialWritingUiState.libraryPage = targetPage;
            void loadOfficialWritingState();
        }
    });
}

function renderOfficialWritingDetailHeader() {
    const doc = getActiveOfficialWritingDoc();
    if (!doc) return;
    const summary = getOfficialWritingDocSummary(doc);
    setText('official-writing-active-doc-title', doc.title || '未命名公文');
    setText('official-writing-active-doc-meta', `${summary.docType} · ${summary.status} · ${summary.draftCount} 字正文`);
    const renameBtn = document.getElementById('official-writing-current-rename-btn');
    const deleteBtn = document.getElementById('official-writing-current-delete-btn');
    if (renameBtn) renameBtn.dataset.officialWritingDocRename = doc.id;
    if (deleteBtn) deleteBtn.dataset.officialWritingDocDelete = doc.id;
}

function renderOfficialWritingDocList() {
    const pageDocs = officialWritingPageIds.map(id => officialWritingLibrary.docs.find(doc => doc.id === id)).filter(Boolean);
    const total = officialWritingUiState.libraryTotal || 0, limit = 10, page = officialWritingUiState.libraryPage || 1;
    const info = { total, limit, page, startIndex: (page - 1) * limit, totalPages: Math.max(1, Math.ceil(total / limit)) };
    const list = document.getElementById('official-writing-doc-list');
    if (list) PivotSafeHtml.setHtml(list, renderOfficialWritingDocItems(pageDocs));
    const table = document.getElementById('official-writing-home-doc-table-body');
    if (table) PivotSafeHtml.setHtml(table, renderOfficialWritingDocTableRows(pageDocs, info.startIndex));
    renderOfficialWritingHomeSummary(pageDocs, pageDocs);
    renderOfficialWritingDocPagination(info);
    setText('official-writing-doc-count', total + ' 篇');
    renderOfficialWritingDetailHeader();
}

function setOfficialWritingScreen(screen) {
    const normalized = screen === 'editor' ? 'editor' : 'library';
    officialWritingUiState.screen = normalized;
    const panel = document.querySelector('.official-writing-panel');
    if (panel) panel.dataset.officialWritingScreen = normalized;
    if (normalized === 'library') {
        renderOfficialWritingDocList();
        return;
    }
    renderOfficialWritingDetailHeader();
    resizeOfficialWritingDraftPage();
}

async function showOfficialWritingLibrary() {
    cancelOfficialWritingAiTask(); closeOfficialWritingResultPreview();
    if (officialWritingUiState.screen === 'editor') syncOfficialWritingStateFromInputs({ immediate: true });
    setOfficialWritingScreen('library');
    await flushOfficialWritingSaves();
    await loadOfficialWritingState();
}

function setOfficialWritingCreateDialogError(message = '') {
    const error = document.getElementById('official-writing-create-error');
    if (!error) return;
    error.textContent = message || '公文名称不能为空';
    error.classList.toggle('hidden', !message);
}

function openOfficialWritingCreateDialog() {
    const modal = document.getElementById('official-writing-create-modal');
    if (!modal) return;
    const activeState = getActiveOfficialWritingDoc()?.state || officialWritingState || OFFICIAL_WRITING_DEFAULT_FORM_STATE;
    const title = document.getElementById('official-writing-create-title');
    const type = document.getElementById('official-writing-create-type');
    const standard = document.getElementById('official-writing-create-standard');
    if (title) title.value = '';
    if (type) type.value = activeState.docType || OFFICIAL_WRITING_DEFAULT_FORM_STATE.docType;
    if (standard) standard.value = activeState.standard || OFFICIAL_WRITING_DEFAULT_FORM_STATE.standard;
    setOfficialWritingCreateDialogError('');
    modal.classList.remove('hidden');
    window.setTimeout(() => title?.focus(), 0);
}

function closeOfficialWritingCreateDialog() {
    document.getElementById('official-writing-create-modal')?.classList.add('hidden');
    setOfficialWritingCreateDialogError('');
}

function setOfficialWritingDraftDialogError(message = '') {
    const error = document.getElementById('official-writing-draft-error');
    if (!error) return;
    error.textContent = message || '请输入起草要求';
    error.classList.toggle('hidden', !message);
}

function openOfficialWritingDraftDialog() {
    const modal = document.getElementById('official-writing-draft-modal');
    const input = document.getElementById('official-writing-draft-instruction');
    if (!modal) return;
    syncOfficialWritingStateFromInputs();
    if (input) {
        const defaultPlaceholder = input.dataset.officialWritingDefaultPlaceholder || input.getAttribute('placeholder') || '';
        const requirements = officialWritingState.requirements || '';
        const standardHints = Array.from(document.querySelectorAll('[data-official-writing-requirement]'))
            .map(button => String(button.dataset.officialWritingRequirement || '').trim())
            .filter(Boolean);
        const shouldClearOnFocus = !!requirements.trim() && standardHints.includes(requirements.trim());
        input.dataset.officialWritingDefaultPlaceholder = defaultPlaceholder;
        input.dataset.officialWritingInitialHint = shouldClearOnFocus ? requirements : '';
        input.dataset.officialWritingClearOnFocus = shouldClearOnFocus ? 'true' : 'false';
        input.value = requirements;
        input.placeholder = defaultPlaceholder;
    }
    setOfficialWritingDraftDialogError('');
    modal.classList.remove('hidden');
    void window.Pivot.legacy.PivotAppModels?.refresh?.('official-writing-draft', 'official-writing-draft-model');
    window.setTimeout(() => input?.focus(), 0);
}

function closeOfficialWritingDraftDialog() {
    document.getElementById('official-writing-draft-modal')?.classList.add('hidden');
    setOfficialWritingDraftDialogError('');
}

function submitOfficialWritingDraftDialog(event) {
    if (event) event.preventDefault();
    const input = document.getElementById('official-writing-draft-instruction');
    const requirements = String(input?.value || '').trim();
    if (!requirements) {
        setOfficialWritingDraftDialogError('请输入起草要求');
        input?.focus();
        return;
    }
    const target = document.getElementById('official-writing-requirements');
    if (target) target.value = requirements;
    closeOfficialWritingDraftDialog();
    closeOfficialWritingDrawer();
    runOfficialWritingMode('draft');
}

function submitOfficialWritingCreateDialog(event) {
    if (event) event.preventDefault();
    const title = document.getElementById('official-writing-create-title');
    const docType = document.getElementById('official-writing-create-type');
    const standard = document.getElementById('official-writing-create-standard');
    const rawTitle = String(title?.value || '').trim();
    if (!rawTitle) {
        setOfficialWritingCreateDialogError('请输入公文名称');
        title?.focus();
        return;
    }
    closeOfficialWritingCreateDialog();
    createOfficialWritingDoc({
        title: rawTitle,
        docType: docType?.value,
        standard: standard?.value
    });
}

async function switchOfficialWritingDoc(docId, options = {}) {
    if (!docId) return;
    const sequence = ++officialWritingOpenSequence;
    const owner = getOfficialWritingOwner();
    cancelOfficialWritingAiTask(); closeOfficialWritingResultPreview();
    if (getActiveOfficialWritingDoc()?._loaded) syncOfficialWritingStateFromInputs({ immediate: true });
    try {
        let target = officialWritingLibrary.docs.find(doc => doc.id === docId);
        if (!target?._loaded) target = await fetchOfficialWritingDocument(docId);
        if (!target || sequence !== officialWritingOpenSequence || owner !== getOfficialWritingOwner()) return;
        officialWritingLibrary.activeId = docId;
        officialWritingState = target.state;
        resumeOfficialWritingMaterialJobs(target);
        officialWritingUndoStack.length = 0; officialWritingRedoStack.length = 0;
        officialWritingHistoryGroup = { target: '', at: 0 };
        officialWritingUiState.lastSelection = null;
        for (const field of ['source', 'draft']) delete getOfficialWritingSurface(field)?.dataset.editing;
        hydrateOfficialWritingForm();
        renderOfficialWritingWorkspace(); renderOfficialWritingDocList();
        if (options.openEditor !== false) setOfficialWritingScreen('editor');
        renderOfficialWritingSaveStatus(); updateOfficialWritingUndoRedoButtons();
    } catch (error) { showToast(error.message || '公文加载失败，当前内容已保留', 'error'); }
}

function createOfficialWritingDoc(options = {}) {
    ++officialWritingOpenSequence;
    cancelOfficialWritingAiTask(); closeOfficialWritingResultPreview();
    if (officialWritingLibrary.docs.length) syncOfficialWritingStateFromInputs();
    const docType = String(options.docType || OFFICIAL_WRITING_DEFAULT_FORM_STATE.docType).trim() || OFFICIAL_WRITING_DEFAULT_FORM_STATE.docType;
    const standard = String(options.standard || OFFICIAL_WRITING_DEFAULT_FORM_STATE.standard).trim() || OFFICIAL_WRITING_DEFAULT_FORM_STATE.standard;
    const rawTitle = String(options.title ?? '').trim();
    const title = String(rawTitle || `${docType}草稿`).slice(0, 120);
    const doc = {
        id: generateOfficialWritingDocId(), title, manualTitle: Boolean(rawTitle),
        updatedAt: new Date().toISOString(), version: 0,
        _loaded: true, _owner: getOfficialWritingOwner(), state: options.state ? sanitizeOfficialWritingState({ ...options.state, artifactId: '' }) : createOfficialWritingState({ docType, standard })
    };
    officialWritingLibrary.docs.unshift(doc);
    officialWritingPageIds.unshift(doc.id);
    officialWritingUiState.libraryTotal += 1;
    officialWritingUiState.libraryPage = 1;
    officialWritingLibrary.activeId = doc.id;
    officialWritingState = doc.state;
    for (const target of ['source', 'draft']) { const surface = getOfficialWritingSurface(target); if (surface) delete surface.dataset.editing; }
    officialWritingUndoStack.length = 0;
    officialWritingRedoStack.length = 0;
    officialWritingUiState.lastSelection = null;
    updateOfficialWritingUndoRedoButtons();
    hydrateOfficialWritingForm();
    scheduleOfficialWritingDocumentSave(doc, { immediate: true });
    renderOfficialWritingWorkspace();
    renderOfficialWritingDocList();
    setOfficialWritingScreen('editor');
    if (typeof showToast === 'function') showToast('已新建公文');
    getOfficialWritingSurface('draft')?.focus();
    return doc;
}

async function renameOfficialWritingDoc(docId) {
    const owner = getOfficialWritingOwner();
    let doc = officialWritingLibrary.docs.find(item => item.id === docId);
    if (!doc) return;
    if (!doc._loaded) { try { doc = await fetchOfficialWritingDocument(docId); } catch (error) { return showToast(error.message, 'error'); } }
    const next = await window.Pivot.legacy.showInputPrompt?.({
        title: '重命名公文',
        message: '请输入新的公文标题：',
        placeholder: '新公文',
        value: doc.title || '',
        requiredMessage: '公文标题不能为空',
        width: 520
    });
    if (owner !== getOfficialWritingOwner()) return;
    if (next == null) return;
    const trimmed = next.trim();
    if (!trimmed) return;
    doc.title = trimmed.slice(0, 120);
    doc.manualTitle = true;
    doc.updatedAt = new Date().toISOString();
    scheduleOfficialWritingDocumentSave(doc, { immediate: true });
    renderOfficialWritingDocList();
}

async function deleteOfficialWritingDoc(docId) {
    const owner = getOfficialWritingOwner();
    const index = officialWritingLibrary.docs.findIndex(item => item.id === docId);
    if (index < 0) return;
    const doc = officialWritingLibrary.docs[index];
    if (!doc._loaded) { try { Object.assign(doc, await fetchOfficialWritingDocument(docId)); } catch (error) { return showToast(error.message, 'error'); } }
    const hasContent = String(doc.state?.draft || '').trim() || String(doc.state?.source || '').trim();
    if (hasContent) {
        const confirmed = await (window.Pivot.legacy.showConfirm?.('删除公文', `确认删除公文「${doc.title || '未命名公文'}」？此操作不可恢复。`)
            ?? Promise.resolve(window.confirm(`确认删除公文「${doc.title || '未命名公文'}」？此操作不可恢复。`)));
        if (!confirmed) return;
    }
    if (owner !== getOfficialWritingOwner()) return;
    try {
        await deleteOfficialWritingDocumentFromServer(docId);
    } catch (error) {
        showToast?.(error?.message || '删除公文失败，请稍后重试', 'error');
        return;
    }
    if (owner !== getOfficialWritingOwner()) return;
    cancelOfficialWritingAiTask();
    const wasActive = officialWritingLibrary.activeId === docId;
    officialWritingLibrary.docs = officialWritingLibrary.docs.filter(item => item.id !== docId);
    officialWritingUiState.libraryTotal = Math.max(0, officialWritingUiState.libraryTotal - 1);
    if (!officialWritingLibrary.docs.length) {
        const fresh = createEmptyOfficialWritingDoc();
        officialWritingLibrary.docs.push(fresh);
        officialWritingLibrary.activeId = fresh.id;
    } else if (wasActive) {
        officialWritingLibrary.activeId = officialWritingLibrary.docs[0].id;
    }
    ensureOfficialWritingActiveDocument();
    officialWritingState = getActiveOfficialWritingDoc().state;
    officialWritingUndoStack.length = 0;
    officialWritingRedoStack.length = 0;
    updateOfficialWritingUndoRedoButtons();
    hydrateOfficialWritingForm();
    saveOfficialWritingState({ immediate: true });
    renderOfficialWritingWorkspace();
    renderOfficialWritingDocList();
    if (wasActive) setOfficialWritingScreen('library');
    if (typeof showToast === 'function') showToast('已删除公文');
}


async function importOfficialWritingBackup(file) {
    if (!file) return;
    const owner = getOfficialWritingOwner();
    if (file.size > officialWritingDocument.MAX_STATE_BYTES) return showToast('备份文件不得超过 4 MiB', 'warning');
    try {
        const data = JSON.parse(await file.text());
        if (owner !== getOfficialWritingOwner()) return;
        if (![1, 2].includes(data.version) || !data.state || typeof data.state !== 'object' || Array.isArray(data.state)
            || (data.version === 2 && data.format !== 'pivot-official-writing')) throw new Error('备份格式无效');
        const state = sanitizeOfficialWritingState(data.state);
        state.artifactId = '';
        createOfficialWritingDoc({ title: String(data.title || '恢复的公文').slice(0, 100), state });
        showToast('备份已导入为新公文');
    } catch (error) { showToast(error.message || '备份无法读取', 'error'); }
}

async function saveOfficialWritingConflictCopy() {
    const original = getActiveOfficialWritingDoc();
    if (!original) return;
    const copy = createOfficialWritingDoc({ title: original.title + '-副本', state: original.state });
    if (await scheduleOfficialWritingDocumentSave(copy, { immediate: true })) {
        await fetchOfficialWritingDocument(original.id).catch(() => {});
        showToast('已保存为独立副本，原文档未被覆盖');
    }
}

async function compareOfficialWritingServerVersion() {
    const doc = getActiveOfficialWritingDoc();
    if (!doc) return;
    try {
        const response = await apiFetch(OFFICIAL_WRITING_DOCUMENTS_API + '/' + encodeURIComponent(doc.id));
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || '读取服务端版本失败');
        openOfficialWritingResultPreview('', doc.state.draft, '左侧为当前未保存正文，右侧为服务端最新正文；可复制或另存副本');
        setText('official-writing-result-text', data.document.state.draft);
    } catch (error) { showToast(error.message, 'error'); }
}
