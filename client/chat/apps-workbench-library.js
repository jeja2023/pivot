// 文档缓存、分页摘要和保存队列。只在成功加载后替换列表，失败保留当前账号的未保存工作。
let officialWritingOwner = '';
let officialWritingPageIds = [];

function getOfficialWritingOwner() {
    return String(typeof currentUser !== 'undefined' ? currentUser?.id || '' : window.Pivot.legacy.currentUser?.id || '');
}

function createEmptyOfficialWritingDoc() {
    return {
        id: generateOfficialWritingDocId(), title: '新公文', manualTitle: false, updatedAt: new Date().toISOString(),
        version: 0, _loaded: true, _owner: getOfficialWritingOwner(), state: createOfficialWritingState()
    };
}

function purgeLegacyOfficialWritingStorage() {
    if (officialWritingLegacyStoragePurged) return;
    officialWritingLegacyStoragePurged = true;
    try { localStorage.removeItem(OFFICIAL_WRITING_LIBRARY_KEY); localStorage.removeItem(OFFICIAL_WRITING_STORAGE_KEY); } catch (_) { }
}

function normalizeOfficialWritingServerDocument(doc) {
    if (!doc?.id) return null;
    return {
        id: String(doc.id), title: String(doc.title || '未命名公文'), manualTitle: doc.manualTitle === true,
        updatedAt: String(doc.updatedAt || new Date().toISOString()), createdAt: doc.createdAt,
        version: Number(doc.version || 1), summary: doc.summary || {}, artifactId: doc.artifactId || '',
        _owner: getOfficialWritingOwner(), _loaded: !!doc.state, ...(doc.state ? { state: sanitizeOfficialWritingState(doc.state) } : {})
    };
}

function ensureOfficialWritingActiveDocument() {
    if (officialWritingLibrary.docs.some(doc => doc.id === officialWritingLibrary.activeId && doc._loaded)) return;
    const fresh = createEmptyOfficialWritingDoc();
    officialWritingLibrary.docs.push(fresh);
    officialWritingLibrary.activeId = fresh.id;
    officialWritingState = fresh.state;
}

function getActiveOfficialWritingDoc() {
    return officialWritingLibrary.docs.find(doc => doc.id === officialWritingLibrary.activeId);
}

function computeOfficialWritingDocFingerprint(doc) {
    if (!doc?.state) return '';
    return officialWritingDocument.digest(JSON.stringify({
        title: doc.title, manualTitle: doc.manualTitle === true,
        state: { ...sanitizeOfficialWritingState(doc.state), artifactId: '' }
    }));
}

function isOfficialWritingStateEmpty(state) {
    return !state || (!String(state.source || '').trim() && !String(state.draft || '').trim() && !String(state.requirements || '').trim()
        && !state.comments?.length && !state.versions?.length && !state.suggestions?.length
        && !Object.values(state.meta || {}).some(value => String(value || '').trim()));
}

async function loadOfficialWritingState() {
    const owner = getOfficialWritingOwner();
    if (officialWritingOwner && owner !== officialWritingOwner) resetOfficialWritingSession();
    officialWritingOwner = owner;
    purgeLegacyOfficialWritingStorage();
    const requestId = ++officialWritingLoadSequence;
    officialWritingUiState.libraryLoading = true;
    setText('official-writing-library-status', '正在加载公文列表…');
    const params = new URLSearchParams({
        view: 'summary', page: String(officialWritingUiState.libraryPage || 1), limit: '10',
        query: officialWritingUiState.libraryQuery || '', docType: officialWritingUiState.libraryType || '', sort: officialWritingUiState.librarySort || 'updated'
    });
    try {
        const res = await apiFetch(`${OFFICIAL_WRITING_DOCUMENTS_API}?${params}`);
        if (!res.ok) throw new Error('加载公文列表失败，请检查网络后重试。');
        const data = await res.json();
        if (requestId !== officialWritingLoadSequence || owner !== getOfficialWritingOwner()) return false;
        const rows = (data.data || []).map(normalizeOfficialWritingServerDocument).filter(Boolean);
        for (const row of rows) {
            const cached = officialWritingLibrary.docs.find(doc => doc.id === row.id);
            if (cached) {
                if (cached._loaded && (computeOfficialWritingDocFingerprint(cached) !== cached._savedFingerprint || officialWritingSaveTasks.has(cached.id))) continue;
                const loaded = cached._loaded && cached.version === row.version;
                Object.assign(cached, row, loaded ? { state: cached.state, _loaded: true } : { state: undefined, _loaded: false });
            } else officialWritingLibrary.docs.push(row);
        }
        officialWritingPageIds = rows.map(row => row.id);
        officialWritingUiState.libraryTotal = Number(data.total || 0);
        officialWritingUiState.libraryPage = Number(data.page || 1);
        ensureOfficialWritingActiveDocument();
        setText('official-writing-library-status', '');
        renderOfficialWritingDocList();
        return true;
    } catch (error) {
        if (requestId !== officialWritingLoadSequence) return false;
        setText('official-writing-library-status', error.message || '公文列表加载失败，已有内容已保留，请重试');
        showToast(error.message || '加载失败，已有内容已保留', 'error');
        return false;
    } finally {
        if (requestId === officialWritingLoadSequence) officialWritingUiState.libraryLoading = false;
    }
}

async function fetchOfficialWritingDocument(id) {
    const owner = getOfficialWritingOwner();
    const res = await apiFetch(`${OFFICIAL_WRITING_DOCUMENTS_API}/${encodeURIComponent(id)}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '公文加载失败');
    if (owner !== getOfficialWritingOwner()) return null;
    const doc = normalizeOfficialWritingServerDocument(data.document);
    if (!doc?._loaded) throw new Error('公文内容格式无效');
    doc._savedFingerprint = computeOfficialWritingDocFingerprint(doc);
    doc._saveStatus = 'saved';
    const index = officialWritingLibrary.docs.findIndex(item => item.id === id);
    if (index < 0) officialWritingLibrary.docs.push(doc); else officialWritingLibrary.docs[index] = doc;
    return doc;
}

function syncActiveOfficialWritingDoc() {
    const doc = getActiveOfficialWritingDoc();
    if (!doc) return;
    doc.state = officialWritingState;
    doc._loaded = true;
    if (!doc.manualTitle) doc.title = deriveOfficialWritingDocTitle(officialWritingState);
    doc.summary = officialWritingDocument.summary(officialWritingState);
}

function officialWritingDocumentPayload(doc) {
    return { title: doc.title || '未命名公文', manualTitle: doc.manualTitle === true, version: Number(doc.version || 0), state: sanitizeOfficialWritingState(doc.state) };
}

async function persistOfficialWritingDocument(doc) {
    if (!doc?._loaded || (doc._owner && doc._owner !== getOfficialWritingOwner()) || officialWritingDeletedDocumentIds.has(doc.id)) return;
    const owner = getOfficialWritingOwner();
    const fingerprint = computeOfficialWritingDocFingerprint(doc);
    if (doc.version && doc._savedFingerprint === fingerprint) return;
    if (!doc.version && !doc.manualTitle && isOfficialWritingStateEmpty(doc.state)) return;
    const payload = officialWritingDocumentPayload(doc);
    if (officialWritingDocument.bytes(payload.state) > officialWritingDocument.MAX_STATE_BYTES) {
        throw new Error('单篇公文超过 4 MiB，请精简材料或清理历史后重试。');
    }
    doc._saveStatus = 'saving';
    renderOfficialWritingSaveStatus();
    const res = await apiFetch(`${OFFICIAL_WRITING_DOCUMENTS_API}/${encodeURIComponent(doc.id)}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        const message = typeof data.error === 'string' ? data.error : data.error?.message;
        const error = new Error(message || '公文保存失败');
        error.status = res.status;
        throw error;
    }
    if (owner !== getOfficialWritingOwner()) return;
    doc.version = Number(data.document.version);
    doc.updatedAt = data.document.updatedAt;
    doc._savedFingerprint = fingerprint;
    doc._saveStatus = computeOfficialWritingDocFingerprint(doc) === fingerprint ? 'saved' : 'dirty';
    doc._saveError = '';
}

function scheduleOfficialWritingDocumentSave(doc, { immediate = false } = {}) {
    if (!doc?._loaded || officialWritingDeletedDocumentIds.has(doc.id)) return Promise.resolve(true);
    if (doc._owner && doc._owner !== getOfficialWritingOwner()) return Promise.resolve(false);
    const owner = getOfficialWritingOwner();
    const dirty = computeOfficialWritingDocFingerprint(doc) !== doc._savedFingerprint;
    if (!dirty || (!doc.version && !doc.manualTitle && isOfficialWritingStateEmpty(doc.state))) return Promise.resolve(true);
    if (doc._saveStatus !== 'conflict') doc._saveStatus = 'dirty';
    renderOfficialWritingSaveStatus();
    const timer = officialWritingSaveTimers.get(doc.id);
    if (timer) clearTimeout(timer);
    officialWritingSaveTimers.delete(doc.id);
    const save = async () => {
        const previous = officialWritingSaveTasks.get(doc.id);
        const task = (async () => {
            if (previous) await previous;
            if (owner !== getOfficialWritingOwner() || officialWritingDeletedDocumentIds.has(doc.id) || doc._saveStatus === 'conflict') return false;
            try { await persistOfficialWritingDocument(doc); return true; }
            catch (error) {
                doc._saveStatus = error.status === 409 ? 'conflict' : 'error';
                doc._saveError = error.message;
                showToast(error.message || '公文保存失败', 'error');
                return false;
            }
        })();
        officialWritingSaveTasks.set(doc.id, task);
        try { return await task; }
        finally {
            if (officialWritingSaveTasks.get(doc.id) === task) officialWritingSaveTasks.delete(doc.id);
            renderOfficialWritingSaveStatus();
        }
    };
    if (immediate) return save();
    officialWritingSaveTimers.set(doc.id, setTimeout(() => { officialWritingSaveTimers.delete(doc.id); void save(); }, 450));
    return Promise.resolve(true);
}

async function flushOfficialWritingSaves() {
    if (getActiveOfficialWritingDoc()?._loaded) syncOfficialWritingStateFromInputs();
    const results = await Promise.all(officialWritingLibrary.docs.filter(doc => doc._loaded).map(doc => scheduleOfficialWritingDocumentSave(doc, { immediate: true })));
    return results.every(Boolean);
}

async function deleteOfficialWritingDocumentFromServer(docId) {
    officialWritingDeletedDocumentIds.add(docId);
    clearTimeout(officialWritingSaveTimers.get(docId));
    officialWritingSaveTimers.delete(docId);
    try {
        await officialWritingSaveTasks.get(docId);
        const res = await apiFetch(`${OFFICIAL_WRITING_DOCUMENTS_API}/${encodeURIComponent(docId)}`, { method: 'DELETE' });
        if (res.status !== 404 && !res.ok) throw new Error('删除公文失败，请重试');
        officialWritingPageIds = officialWritingPageIds.filter(id => id !== docId);
    } catch (error) { officialWritingDeletedDocumentIds.delete(docId); throw error; }
}

function saveOfficialWritingState(options = {}) {
    syncActiveOfficialWritingDoc();
    return scheduleOfficialWritingDocumentSave(getActiveOfficialWritingDoc(), options);
}

function renderOfficialWritingSaveStatus() {
    const doc = getActiveOfficialWritingDoc();
    if (!doc?._loaded) return;
    const dirty = computeOfficialWritingDocFingerprint(doc) !== doc._savedFingerprint && (doc.manualTitle || !isOfficialWritingStateEmpty(doc.state));
    const status = doc._saveStatus === 'saving' ? 'saving' : ['error', 'conflict'].includes(doc._saveStatus) ? doc._saveStatus : dirty ? 'dirty' : 'saved';
    const labels = { saving: '保存中…', dirty: '有修改，等待保存', saved: doc.version ? `已保存 ${formatVersionTime(doc.updatedAt)}` : '尚未创建', error: '保存失败，正文已保留', conflict: '存在其他窗口的新版本，当前正文已保留' };
    const statusEl = document.getElementById('official-writing-save-status');
    if (statusEl) {
        statusEl.textContent = labels[status] || '';
        statusEl.setAttribute('data-status', status);
    }
    const retry = document.getElementById('official-writing-retry-save-btn');
    if (retry) { retry.hidden = status !== 'error'; retry.classList.toggle('hidden', status !== 'error'); }
    const conflict = document.getElementById('official-writing-conflict-actions');
    if (conflict) { conflict.hidden = status !== 'conflict'; conflict.classList.toggle('hidden', status !== 'conflict'); }
}

function exportOfficialWritingBackup() {
    syncOfficialWritingStateFromInputs();
    const doc = getActiveOfficialWritingDoc();
    downloadOfficialWritingFile(`${doc?.title || '公文'}-备份.json`, JSON.stringify({
        format: 'pivot-official-writing', version: 2,
        title: doc?.title, exportedAt: new Date().toISOString(), state: sanitizeOfficialWritingState(officialWritingState)
    }, null, 2), 'application/json;charset=utf-8');
    showToast('已导出当前公文备份');
}

function resetOfficialWritingSession() {
    ++officialWritingLoadSequence;
    for (const timer of officialWritingSaveTimers.values()) clearTimeout(timer);
    officialWritingSaveTimers.clear(); officialWritingSaveTasks.clear(); officialWritingDeletedDocumentIds.clear();
    if (typeof cancelOfficialWritingAiTask === 'function') cancelOfficialWritingAiTask();
    officialWritingLibrary = { activeId: '', docs: [] }; officialWritingPageIds = []; officialWritingOwner = '';
    officialWritingState = createOfficialWritingState();
    officialWritingUndoStack.length = 0; officialWritingRedoStack.length = 0;
    for (const target of ['source', 'draft']) {
        const surface = getOfficialWritingSurface(target), editor = getOfficialWritingTextarea(target);
        if (surface) { surface.replaceChildren(); delete surface.dataset.editing; }
        if (editor) editor.value = '';
    }
    for (const id of ['official-writing-suggestion-list', 'official-writing-reference-list', 'official-writing-doc-list', 'official-writing-home-doc-table-body', 'official-writing-result-text', 'official-writing-result-original']) document.getElementById(id)?.replaceChildren();
    for (const id of ['official-writing-comments-list', 'official-writing-version-list', 'official-writing-material-preview', 'official-writing-material-card-list', 'official-writing-kb-history-results', 'official-writing-attachments-editor']) document.getElementById(id)?.replaceChildren();
    for (const id of ['official-writing-requirements', 'official-writing-material-editor', ...Object.values(OFFICIAL_WRITING_META_FIELD_IDS)]) {
        const node = document.getElementById(id); if (node) node.value = '';
    }
    officialWritingRagResults.history = []; officialWritingRagCollectionsLoaded = false;
    officialWritingReferenceChecks.clear(); officialWritingComplianceCache = null; officialWritingReferenceCache = null;
    closeOfficialWritingResultPreview(); closeOfficialWritingExportPreview();
}

