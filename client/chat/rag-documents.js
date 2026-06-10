// RAG 文档列表与操作 RAG document list and actions
// RAG 文档功能从 rag.js 拆分而来。
/* eslint-disable no-undef */
let ragCollections = [];
let ragTags = [];
let ragDocsCache = [];
const ragTagsByCollection = new Map();

function normalizeRagCollectionId(value) {
    const id = Number.parseInt(value, 10);
    return Number.isSafeInteger(id) && id > 0 ? String(id) : '';
}

function normalizeRagTag(value) {
    return String(value || '').trim().replace(/^#+/, '').replace(/\s+/g, ' ').slice(0, 40);
}

function parseRagTags(value) {
    const values = Array.isArray(value) ? value : String(value || '').split(/[,，;；\s\n]+/);
    return [...new Set(values.map(normalizeRagTag).filter(Boolean))].slice(0, 20);
}

function getRagTagCacheKey(collectionId = '') {
    return normalizeRagCollectionId(collectionId);
}

function setRagTagsForCollection(collectionId = '', tags = []) {
    const key = getRagTagCacheKey(collectionId);
    const safeTags = Array.isArray(tags) ? tags : [];
    ragTagsByCollection.set(key, safeTags);
    if (!key) ragTags = safeTags;
    return safeTags;
}

function getRagTagsForCollection(collectionId = '') {
    const key = getRagTagCacheKey(collectionId);
    if (ragTagsByCollection.has(key)) return ragTagsByCollection.get(key);
    return key ? [] : ragTags;
}

function invalidateRagTagCache() {
    ragTags = [];
    ragTagsByCollection.clear();
}

function getRagDocTags(doc = {}) {
    return parseRagTags(Array.isArray(doc.tags) ? doc.tags : String(doc.tags || '').split(','));
}

function getSelectedRagTagCheckboxes(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return [];
    return parseRagTags(Array.from(container.querySelectorAll('input[type="checkbox"]:checked'))
        .map(input => input.value));
}

function renderRagTagCheckboxes(selectedTags = [], collectionId = '') {
    const selected = new Set(parseRagTags(selectedTags));
    const tags = getRagTagsForCollection(collectionId);
    if (!tags.length) {
        return '<div class="knowledge-tag-picker-empty">暂无标签，请先新建标签</div>';
    }
    return tags.map((item, index) => {
        const tag = normalizeRagTag(item.tag || item);
        if (!tag) return '';
        const id = `knowledge-tag-check-${index}-${tag.replace(/[^\w-]+/g, '-')}`;
        const count = Number(item.doc_count || 0);
        const label = `${tag}${count > 0 ? ` (${count})` : ''}`;
        return `
            <label class="knowledge-tag-check" for="${escapeRagAttr(id)}" title="${escapeRagAttr(label)}">
                <input id="${escapeRagAttr(id)}" type="checkbox" value="${escapeRagAttr(tag)}" ${selected.has(tag) ? 'checked' : ''}>
                <span>${escapeRagHtml(label)}</span>
            </label>
        `;
    }).join('');
}

function setRagTagCheckboxes(container, selectedTags = [], collectionId = '') {
    if (!container) return;
    container.innerHTML = renderRagTagCheckboxes(selectedTags, collectionId);
}

function refreshRagTagCheckboxControls() {
    const uploadTags = document.getElementById('knowledge-upload-tags-list');
    const uploadCollectionId = normalizeRagCollectionId(document.getElementById('knowledge-upload-collection')?.value);
    if (uploadTags) setRagTagCheckboxes(uploadTags, getSelectedRagTagCheckboxes('knowledge-upload-tags-list'), uploadCollectionId);
    const metaTags = document.getElementById('knowledge-doc-meta-tags-list');
    const metaCollectionId = normalizeRagCollectionId(document.getElementById('knowledge-doc-meta-collection')?.value);
    if (metaTags) setRagTagCheckboxes(metaTags, getSelectedRagTagCheckboxes('knowledge-doc-meta-tags-list'), metaCollectionId);
}

function renderRagCollectionCell(doc = {}) {
    const name = String(doc.collection_name || '').trim();
    const label = name || '未归类';
    return `<span class="knowledge-collection-pill ${name ? '' : 'is-muted'}" title="${escapeRagAttr(label)}">${escapeRagHtml(label)}</span>`;
}

function renderRagTagsCell(doc = {}) {
    const tags = getRagDocTags(doc);
    if (!tags.length) return '<span class="knowledge-empty-meta">-</span>';
    return `<div class="knowledge-tag-list">${tags.map(tag => `<span class="knowledge-tag-pill" title="${escapeRagAttr(tag)}">${escapeRagHtml(tag)}</span>`).join('')}</div>`;
}

function getCachedKnowledgeDoc(id) {
    const docId = Number.parseInt(id, 10);
    if (!Number.isSafeInteger(docId) || docId <= 0) return null;
    return ragDocsCache.find(doc => Number(doc.id) === docId) || null;
}

function getRagCollectionOptionsHtml(selectedId = '', {
    includeAll = false,
    allLabel = '全部知识库',
    unassignedLabel = '未归类'
} = {}) {
    const selected = normalizeRagCollectionId(selectedId);
    const options = [];
    if (includeAll) {
        options.push(`<option value="" ${selected ? '' : 'selected'}>${escapeRagHtml(allLabel)}</option>`);
    } else {
        options.push(`<option value="" ${selected ? '' : 'selected'}>${escapeRagHtml(unassignedLabel)}</option>`);
    }
    ragCollections.forEach(collection => {
        const id = normalizeRagCollectionId(collection.id);
        if (!id) return;
        const count = Number(collection.doc_count || 0);
        const label = `${collection.name || '专题库'}${count > 0 ? ` (${count})` : ''}`;
        options.push(`<option value="${escapeRagAttr(id)}" ${id === selected ? 'selected' : ''}>${escapeRagHtml(label)}</option>`);
    });
    return options.join('');
}

function setSelectOptions(select, html, fallback = '') {
    if (!select) return;
    const previous = select.value || fallback || '';
    select.innerHTML = html;
    select.value = Array.from(select.options).some(option => option.value === previous) ? previous : fallback;
}

function getRagTagOptionsHtml(selectedTag = '', {
    includeAll = true,
    allLabel = '全部标签',
    collectionId = ''
} = {}) {
    const selected = normalizeRagTag(selectedTag);
    const options = includeAll ? [`<option value="" ${selected ? '' : 'selected'}>${escapeRagHtml(allLabel)}</option>`] : [];
    getRagTagsForCollection(collectionId).forEach(item => {
        const tag = normalizeRagTag(item.tag || item);
        if (!tag) return;
        const count = Number(item.doc_count || 0);
        const label = `${tag}${count > 0 ? ` (${count})` : ''}`;
        options.push(`<option value="${escapeRagAttr(tag)}" ${tag === selected ? 'selected' : ''}>${escapeRagHtml(label)}</option>`);
    });
    return options.join('');
}

function getLinkedRagCollectionId(source = '') {
    const idMap = {
        docs: 'rag-collection-filter',
        debug: 'rag-debug-collection',
        chat: 'chat-rag-collection-scope',
        upload: 'knowledge-upload-collection',
        meta: 'knowledge-doc-meta-collection'
    };
    return normalizeRagCollectionId(document.getElementById(idMap[source])?.value);
}

function updateRagTagSelect(selectId, collectionId = '', allLabel = '全部标签') {
    const select = document.getElementById(selectId);
    if (!select) return;
    setSelectOptions(
        select,
        getRagTagOptionsHtml(select.value, { includeAll: true, allLabel, collectionId })
    );
}

function updateRagCollectionControls() {
    setSelectOptions(
        document.getElementById('rag-collection-filter'),
        getRagCollectionOptionsHtml('', { includeAll: true, allLabel: '全部专题库' })
    );
    setSelectOptions(
        document.getElementById('knowledge-upload-collection'),
        getRagCollectionOptionsHtml('', { includeAll: false, unassignedLabel: '不归类' })
    );
    setSelectOptions(
        document.getElementById('knowledge-doc-meta-collection'),
        getRagCollectionOptionsHtml('', { includeAll: false, unassignedLabel: '不归类' })
    );
    setSelectOptions(
        document.getElementById('rag-debug-collection'),
        getRagCollectionOptionsHtml('', { includeAll: true, allLabel: '全部知识库' })
    );
    setSelectOptions(
        document.getElementById('chat-rag-collection-scope'),
        getRagCollectionOptionsHtml('', { includeAll: true, allLabel: '全部知识库' })
    );
}

function updateRagTagControls() {
    updateRagTagSelect('rag-tag-filter', getLinkedRagCollectionId('docs'));
    updateRagTagSelect('rag-debug-tag', getLinkedRagCollectionId('debug'));
    updateRagTagSelect('chat-rag-tag-scope', getLinkedRagCollectionId('chat'));
    refreshRagTagCheckboxControls();
}

window.getRagScopeSelection = function(source = 'chat') {
    const idMap = {
        chat: 'chat-rag-collection-scope',
        debug: 'rag-debug-collection',
        docs: 'rag-collection-filter',
        upload: 'knowledge-upload-collection'
    };
    const value = normalizeRagCollectionId(document.getElementById(idMap[source] || idMap.chat)?.value);
    const tagIdMap = {
        chat: 'chat-rag-tag-scope',
        debug: 'rag-debug-tag',
        docs: 'rag-tag-filter'
    };
    const tag = normalizeRagTag(document.getElementById(tagIdMap[source] || tagIdMap.chat)?.value);
    return {
        ...(value ? { collectionId: Number(value) } : {}),
        ...(tag ? { tagNames: [tag] } : {})
    };
};

window.applyRagDebugScopeToChat = async function() {
    const debugValue = normalizeRagCollectionId(document.getElementById('rag-debug-collection')?.value);
    const debugTag = normalizeRagTag(document.getElementById('rag-debug-tag')?.value);
    const chatSelect = document.getElementById('chat-rag-collection-scope');
    const chatTagSelect = document.getElementById('chat-rag-tag-scope');
    if (chatSelect) chatSelect.value = debugValue;
    await window.loadKnowledgeTags?.(debugValue, { updateControls: false });
    updateRagTagControls();
    if (chatTagSelect) {
        chatTagSelect.value = Array.from(chatTagSelect.options).some(option => option.value === debugTag) ? debugTag : '';
    }
    window.updateChatToolReadiness?.({ silent: true });
};

window.loadKnowledgeCollections = async function() {
    try {
        const res = await apiFetch(`${API_BASE}/rag/collections`, { headers: authHeaders() });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.error) throw new Error(data.error || '专题库加载失败');
        ragCollections = Array.isArray(data.data) ? data.data : [];
        updateRagCollectionControls();
        window.updateChatToolReadiness?.({ silent: true });
        return ragCollections;
    } catch (e) {
        console.error('加载知识库专题失败', e);
        return ragCollections;
    }
};

function getRagTagCollectionIdsInUse() {
    return [...new Set([
        '',
        getLinkedRagCollectionId('docs'),
        getLinkedRagCollectionId('debug'),
        getLinkedRagCollectionId('chat'),
        getLinkedRagCollectionId('upload'),
        getLinkedRagCollectionId('meta')
    ].map(getRagTagCacheKey))];
}

window.loadKnowledgeTags = async function(collectionId = '', { updateControls = true, force = false } = {}) {
    const key = getRagTagCacheKey(collectionId);
    if (!force && ragTagsByCollection.has(key)) {
        if (updateControls) updateRagTagControls();
        return getRagTagsForCollection(key);
    }
    try {
        const query = key ? `?collectionId=${encodeURIComponent(key)}` : '';
        const res = await apiFetch(`${API_BASE}/rag/tags${query}`, { headers: authHeaders() });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.error) throw new Error(data.error || '标签加载失败');
        setRagTagsForCollection(key, data.data);
        if (updateControls) updateRagTagControls();
        window.updateChatToolReadiness?.({ silent: true });
        return getRagTagsForCollection(key);
    } catch (e) {
        console.error('加载知识库标签失败', e);
        return getRagTagsForCollection(key);
    }
};

window.refreshRagTagControlsForSelectedCollections = async function({ force = false } = {}) {
    const ids = getRagTagCollectionIdsInUse();
    await Promise.all(ids.map(id => window.loadKnowledgeTags(id, { updateControls: false, force })));
    updateRagTagControls();
    window.updateChatToolReadiness?.({ silent: true });
};

window.handleRagCollectionScopeChange = async function(source = '') {
    await window.refreshRagTagControlsForSelectedCollections?.({ force: true });
    if (source === 'docs') {
        window.loadKnowledgeDocs(1);
    } else if (source === 'chat') {
        window.updateChatToolReadiness?.({ silent: true });
    }
};

window.createKnowledgeCollectionFromPrompt = async function() {
    const name = await window.showInputPrompt?.({
        title: '新建专题库',
        message: '专题库用于把知识库文档按业务、项目或制度范围归类。',
        placeholder: '例如：制度规范',
        requiredMessage: '请输入专题库名称'
    });
    if (!name) return;
    try {
        const res = await apiFetch(`${API_BASE}/rag/collections`, {
            method: 'POST',
            headers: { ...authHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ name })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.error) throw new Error(data.error || '专题库创建失败');
        await window.loadKnowledgeCollections?.();
        const collectionId = normalizeRagCollectionId(data.collection?.id);
        const filter = document.getElementById('rag-collection-filter');
        if (filter && collectionId) filter.value = collectionId;
        showToast('专题库已创建');
        window.loadKnowledgeDocs(1);
    } catch (e) {
        showToast(e.message || '专题库创建失败', 'error');
    }
};

window.createKnowledgeTagFromPrompt = async function() {
    const tag = await window.showInputPrompt?.({
        title: '新建标签',
        message: '标签用于在专题库之外补充细粒度检索范围。',
        placeholder: '例如：合同 / 财务 / 运维',
        requiredMessage: '请输入标签名称'
    });
    if (!tag) return;
    try {
        const res = await apiFetch(`${API_BASE}/rag/tags`, {
            method: 'POST',
            headers: { ...authHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ tag })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.error) throw new Error(data.error || '标签创建失败');
        invalidateRagTagCache();
        await window.refreshRagTagControlsForSelectedCollections?.({ force: true });
        const safeTag = normalizeRagTag(data.tag?.tag || tag);
        const filter = document.getElementById('rag-tag-filter');
        if (filter && safeTag && Array.from(filter.options).some(option => option.value === safeTag)) filter.value = safeTag;
        showToast('标签已创建');
        window.loadKnowledgeDocs(1);
    } catch (e) {
        showToast(e.message || '标签创建失败', 'error');
    }
};

function renderRagDocsPagination(total, page, limit) {
    window.renderWorkspacePagination?.('pagination-ragDocs', {
        total,
        page,
        limit,
        onPageChange: targetPage => window.loadKnowledgeDocs(targetPage)
    });
}

function getRagDocDisplayName(name = '') {
    return String(name || '')
        .replace(/\.[^.]+$/, '')
        .trim()
        .slice(0, 24);
}

function updateRagDebugSamples(docs = []) {
    const buttons = Array.from(document.querySelectorAll('[data-rag-debug-sample]'));
    if (!buttons.length) return;
    const readyDoc = docs.find(doc => doc.status === 'ready') || docs[0] || null;
    const docName = getRagDocDisplayName(readyDoc?.name);
    const samples = docName ? [
        { label: `总结《${docName}》`, query: `请总结《${docName}》的主要内容。` },
        { label: '查流程规则', query: `《${docName}》里有哪些流程、规则或注意事项？` },
        { label: '找命中分块', query: `哪些分块可以回答用户关于《${docName}》的常见问题？` }
    ] : [
        { label: '总结文档', query: '请总结已上传文档的主要内容。' },
        { label: '查流程规则', query: '文档里有哪些流程、规则或注意事项？' },
        { label: '找命中分块', query: '哪些分块可以回答用户常见问题？' }
    ];
    buttons.forEach((button, index) => {
        const sample = samples[index] || samples[0];
        button.textContent = sample.label;
        button.dataset.ragDebugSample = sample.query;
    });
}

window.loadKnowledgeDocs = async (page = ragDocsPage) => {
    try {
        ragDocsPage = Math.max(Number(page) || 1, 1);
        await window.loadKnowledgeCollections?.();
        await window.refreshRagTagControlsForSelectedCollections?.();
        const activeCollectionId = normalizeRagCollectionId(document.getElementById('rag-collection-filter')?.value);
        const activeTag = normalizeRagTag(document.getElementById('rag-tag-filter')?.value);
        const collectionQuery = activeCollectionId ? `&collectionId=${encodeURIComponent(activeCollectionId)}` : '';
        const tagQuery = activeTag ? `&tag=${encodeURIComponent(activeTag)}` : '';
        const summaryQuery = new URLSearchParams();
        if (activeCollectionId) summaryQuery.set('collectionId', activeCollectionId);
        if (activeTag) summaryQuery.set('tag', activeTag);
        const summaryUrl = `${API_BASE}/rag/summary${summaryQuery.toString() ? `?${summaryQuery.toString()}` : ''}`;
        const [res, summaryRes, qualityRes, graphSummaryRes] = await Promise.all([
            apiFetch(`${API_BASE}/rag/docs?page=${ragDocsPage}&limit=${RAG_DOCS_PAGE_SIZE}${collectionQuery}${tagQuery}`, { headers: authHeaders() }),
            apiFetch(summaryUrl, { headers: authHeaders() }),
            apiFetch(`${API_BASE}/rag/quality-report`, { headers: authHeaders() }),
            apiFetch(`${API_BASE}/rag/graph/summary`, { headers: authHeaders() })
        ]);
        const payload = await res.json();
        const docs = Array.isArray(payload) ? payload : (payload.data || []);
        ragDocsCache = docs;
        const total = Array.isArray(payload) ? docs.length : Number(payload.total || docs.length);
        const pageSize = Array.isArray(payload) ? RAG_DOCS_PAGE_SIZE : Number(payload.limit || RAG_DOCS_PAGE_SIZE);
        const pageNo = Array.isArray(payload) ? ragDocsPage : Number(payload.page || ragDocsPage);
        const summary = await summaryRes.json().catch(() => null);
        const quality = await qualityRes.json().catch(() => null);
        const graphSummary = await graphSummaryRes.json().catch(() => null);
        renderRagSummary(summary, quality, graphSummary);
        renderRagQualityReport(quality);
        updateRagDebugSamples(docs);
        
        const body = document.getElementById('rag-docs-body');
        body.innerHTML = docs.map((d, index) => `
            <tr>
                <td class="text-center"><input type="checkbox" class="rag-doc-check" value="${d.id}"></td>
                <td class="text-center">${(pageNo - 1) * pageSize + index + 1}</td>
                <td title="${escapeRagHtml(d.name)}">${escapeRagHtml(d.name)}</td>
                <td>${renderRagCollectionCell(d)}</td>
                <td>${renderRagTagsCell(d)}</td>
                <td class="text-center">
                    <span class="status-badge ${escapeRagHtml(d.status)}" title="${escapeRagHtml(d.error_message || '')}">${getRagStatusLabel(d.status)}</span>
                </td>
                <td class="text-center">
                    <input type="checkbox" class="rag-enable-toggle" data-rag-id="${d.id}" ${Number(d.is_enabled ?? 1) === 1 ? 'checked' : ''}>
                </td>
                <td class="text-center">${Number(d.chunk_count || 0)}</td>
                <td class="text-center">${Number(d.progress || (d.status === 'ready' ? 100 : 0))}%</td>
                <td>${escapeRagHtml(formatRagDateToCN(d.created_at))}</td>
                <td>${escapeRagHtml(formatRagDateToCN(d.updated_at || d.processed_at))}</td>
                <td class="text-center">
                    <div class="rag-actions">${renderRagActions(d)}</div>
                </td>
            </tr>
        `).join('') || '<tr><td colspan="12" class="text-center">暂无知识库文档</td></tr>';
        renderRagDocsPagination(total, pageNo, pageSize);
        scheduleRagStatusRefresh(docs);
    } catch (e) {
        console.error('加载知识库失败', e);
    }
};

window.openKnowledgeWorkbench = async function() {
    window.showMainWorkspace?.('knowledge');
    const panel = document.getElementById('knowledge-workbench-modal');
    if (!panel) return;
    try {
        await window.ensureAdminSettingsScript?.();
    } catch (e) {
        console.error('加载知识库配置脚本失败', e);
        showToast('知识库配置脚本加载失败，请刷新页面后重试', 'error');
    }
    ensureKnowledgeUploadModal();
    panel.querySelectorAll('.admin-only').forEach(el => {
        el.classList.toggle('hidden', !isAdminUser());
    });
    panel.querySelectorAll('.admin-root-only').forEach(el => {
        el.classList.toggle('hidden', !isSuperAdminUser());
    });
    window.bindEmbeddingModalEvents?.();
    window.bindRagDebugModalEvents?.();
    await window.loadSettings?.();
    await window.loadKnowledgeDocs?.();
    const restoreGraphDocId = getKnowledgeGraphRestoreDocId();
    if (restoreGraphDocId !== null) {
        await window.openKnowledgeGraph?.(restoreGraphDocId || null);
    }
};

window.closeKnowledgeWorkbench = function() {
    closeKnowledgeGraphModal();
    window.showMainWorkspace?.('chat');
};

function ensureKnowledgeUploadModal() {
    let modal = document.getElementById('knowledge-upload-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'knowledge-upload-modal';
        modal.className = 'modal-overlay hidden rag-detail-modal-overlay knowledge-upload-modal-overlay';
        modal.innerHTML = `
            <div class="modal rag-detail-modal knowledge-upload-modal">
                <div class="rag-detail-header">
                    <div>
                        <h3>上传文档</h3>
                        <p class="model-modal-desc">拖拽文件到下方区域，或点击区域选择文件。上传后系统会自动索引文档内容。</p>
                    </div>
                    <button type="button" id="knowledge-upload-close-btn" class="btn-danger-outline">关闭</button>
                </div>
                <div class="knowledge-upload-meta">
                    <select id="knowledge-upload-collection" class="form-input knowledge-upload-collection" title="上传到专题库">
                        <option value="">不归类</option>
                    </select>
                    <div id="knowledge-upload-tags-list" class="knowledge-tag-picker" aria-label="上传标签"></div>
                </div>
                <button id="knowledge-upload-zone" class="knowledge-upload-zone" type="button">
                    <strong>拖拽文件到这里，或点击选择文件</strong>
                    <span>支持 PDF、Word、Excel、CSV、Markdown、网页文本。</span>
                </button>
            </div>
        `;
        document.body.appendChild(modal);
        modal.addEventListener('click', (event) => {
            if (event.target === modal || event.target.closest('#knowledge-upload-close-btn')) {
                window.closeKnowledgeUploadModal?.();
            }
        });
    }
    bindKnowledgeUploadZone(modal);
    updateRagCollectionControls();
    updateRagTagControls();
    return modal;
}

window.openKnowledgeUploadModal = async function() {
    const modal = ensureKnowledgeUploadModal();
    const collectionId = getLinkedRagCollectionId('upload');
    await window.loadKnowledgeTags?.(collectionId, { updateControls: false });
    updateRagTagControls();
    modal.classList.remove('hidden');
};

window.closeKnowledgeUploadModal = function() {
    const modal = document.getElementById('knowledge-upload-modal');
    modal?.classList.add('hidden');
};

function ensureKnowledgeDocMetaModal() {
    let modal = document.getElementById('knowledge-doc-meta-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'knowledge-doc-meta-modal';
        modal.className = 'modal-overlay hidden rag-detail-modal-overlay knowledge-doc-meta-modal-overlay';
        modal.innerHTML = `
            <div class="modal model-modal knowledge-doc-meta-modal">
                <div class="model-modal-header">
                    <h3>整理文档</h3>
                    <p id="knowledge-doc-meta-name" class="model-modal-desc"></p>
                </div>
                <div class="model-form">
                    <input type="hidden" id="knowledge-doc-meta-id">
                    <div class="form-item">
                        <label for="knowledge-doc-meta-collection">专题库</label>
                        <select id="knowledge-doc-meta-collection" class="form-input" title="专题库">
                            <option value="">不归类</option>
                        </select>
                    </div>
                    <div class="form-item">
                        <label>标签</label>
                        <div id="knowledge-doc-meta-tags-list" class="knowledge-tag-picker" aria-label="文档标签"></div>
                    </div>
                </div>
                <div class="model-modal-actions">
                    <button type="button" id="knowledge-doc-meta-cancel-btn" class="btn-secondary">取消</button>
                    <button type="button" id="knowledge-doc-meta-save-btn" class="btn-primary">保存</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
        modal.addEventListener('click', (event) => {
            if (event.target === modal || event.target.closest('#knowledge-doc-meta-close-btn') || event.target.closest('#knowledge-doc-meta-cancel-btn')) {
                window.closeKnowledgeDocMetaModal?.();
                return;
            }
            if (event.target.closest('#knowledge-doc-meta-save-btn')) {
                window.saveKnowledgeDocMeta?.();
            }
        });
    }
    updateRagCollectionControls();
    updateRagTagControls();
    return modal;
}

window.openKnowledgeDocMetaModal = async function(id) {
    const doc = getCachedKnowledgeDoc(id);
    if (!doc) return showToast('未找到文档，请刷新后重试', 'error');
    const modal = ensureKnowledgeDocMetaModal();
    const idInput = document.getElementById('knowledge-doc-meta-id');
    const nameEl = document.getElementById('knowledge-doc-meta-name');
    const collectionSelect = document.getElementById('knowledge-doc-meta-collection');
    const tagsList = document.getElementById('knowledge-doc-meta-tags-list');
    if (idInput) idInput.value = String(doc.id);
    if (nameEl) nameEl.innerText = doc.name || '';
    if (collectionSelect) {
        collectionSelect.innerHTML = getRagCollectionOptionsHtml(doc.collection_id, { includeAll: false, unassignedLabel: '不归类' });
        collectionSelect.value = normalizeRagCollectionId(doc.collection_id);
    }
    const collectionId = normalizeRagCollectionId(doc.collection_id);
    await window.loadKnowledgeTags?.(collectionId, { updateControls: false });
    setRagTagCheckboxes(tagsList, getRagDocTags(doc), collectionId);
    modal.classList.remove('hidden');
};

window.closeKnowledgeDocMetaModal = function() {
    document.getElementById('knowledge-doc-meta-modal')?.classList.add('hidden');
};

window.saveKnowledgeDocMeta = async function() {
    const docId = normalizeRagCollectionId(document.getElementById('knowledge-doc-meta-id')?.value);
    if (!docId) return showToast('未找到文档，请刷新后重试', 'error');
    const collectionId = normalizeRagCollectionId(document.getElementById('knowledge-doc-meta-collection')?.value);
    const tags = getSelectedRagTagCheckboxes('knowledge-doc-meta-tags-list');
    try {
        const [collectionRes, tagsRes] = await Promise.all([
            apiFetch(`${API_BASE}/rag/docs/${docId}/collection`, {
                method: 'PUT',
                headers: { ...authHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify({ collectionId: collectionId || null })
            }),
            apiFetch(`${API_BASE}/rag/docs/${docId}/tags`, {
                method: 'PUT',
                headers: { ...authHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify({ tags })
            })
        ]);
        const collectionData = await collectionRes.json().catch(() => ({}));
        const tagsData = await tagsRes.json().catch(() => ({}));
        if (!collectionRes.ok || collectionData.error) throw new Error(collectionData.error || '专题库更新失败');
        if (!tagsRes.ok || tagsData.error) throw new Error(tagsData.error || '标签更新失败');
        window.closeKnowledgeDocMetaModal?.();
        invalidateRagTagCache();
        await window.loadKnowledgeCollections?.();
        await window.refreshRagTagControlsForSelectedCollections?.({ force: true });
        showToast('文档整理信息已更新');
        window.loadKnowledgeDocs();
    } catch (e) {
        showToast(e.message || '文档整理失败', 'error');
    }
};

function bindKnowledgeUploadZone(root = document) {
    const uploadZone = root.querySelector?.('#knowledge-upload-zone') || document.getElementById('knowledge-upload-zone');
    if (!uploadZone || uploadZone.dataset.boundKnowledgeDrop === '1') return;
    uploadZone.dataset.boundKnowledgeDrop = '1';
    uploadZone.addEventListener('click', () => document.getElementById('rag-upload-input')?.click());
    ['dragenter', 'dragover'].forEach(eventName => {
        uploadZone.addEventListener(eventName, event => {
            event.preventDefault();
            uploadZone.classList.add('is-dragging');
        });
    });
    ['dragleave', 'drop'].forEach(eventName => {
        uploadZone.addEventListener(eventName, event => {
            event.preventDefault();
            uploadZone.classList.remove('is-dragging');
        });
    });
    uploadZone.addEventListener('drop', event => {
        const file = event.dataTransfer?.files?.[0];
        if (!file) return;
        window.uploadKnowledgeDoc(file);
    });
}

const getSelectedRagDocIds = () => Array.from(document.querySelectorAll('.rag-doc-check:checked'))
    .map(input => Number(input.value))
    .filter(Boolean);

window.batchReindexKnowledgeDocs = async () => {
    const docIds = getSelectedRagDocIds();
    if (docIds.length === 0) return showToast('请选择文档', 'error');
    try {
        const res = await apiFetch(`${API_BASE}/rag/docs/batch-reindex`, {
            method: 'POST',
            headers: { ...authHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ docIds })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.error) throw new Error(data.error || '批量重建失败');
        showToast(`已加入 ${data.scheduled || 0} 个重建任务`);
        window.loadKnowledgeDocs();
    } catch (e) {
        showToast(e.message || '批量重建失败', 'error');
    }
};

window.batchDeleteKnowledgeDocs = async () => {
    const docIds = getSelectedRagDocIds();
    if (docIds.length === 0) return showToast('请选择文档', 'error');
    const confirmed = await ragConfirm('批量删除知识库文档', `确定删除选中的 ${docIds.length} 个知识库文档吗？大模型将不再参考这些文档。`);
    if (!confirmed) return;
    try {
        const res = await apiFetch(`${API_BASE}/rag/docs/batch-delete`, {
            method: 'POST',
            headers: { ...authHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ docIds })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.error) throw new Error(data.error || '批量删除失败');
        showToast(`已删除 ${data.deleted || 0} 个文档`);
        window.loadKnowledgeDocs();
    } catch (e) {
        showToast(e.message || '批量删除失败', 'error');
    }
};

window.toggleKnowledgeDocEnabled = async (id, enabled) => {
    try {
        const res = await apiFetch(`${API_BASE}/rag/docs/${id}/enabled`, {
            method: 'PUT',
            headers: { ...authHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.error) throw new Error(data.error || '启停失败');
        showToast(enabled ? '文档已启用' : '文档已停用');
        window.loadKnowledgeDocs();
    } catch (e) {
        showToast(e.message || '启停失败', 'error');
    }
};

window.showKnowledgeDocDetail = async (id) => {
    try {
        const res = await apiFetch(`${API_BASE}/rag/docs/${id}?limit=50`, { headers: authHeaders() });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.error) throw new Error(data.error || '详情加载失败');
        showRagDetailModal(data);
    } catch (e) {
        showToast(e.message || '详情加载失败', 'error');
    }
};

window.sendRagFeedback = async (button) => {
    try {
        const res = await apiFetch(`${API_BASE}/rag/feedback`, {
            method: 'POST',
            headers: { ...authHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({
                query: button.dataset.query,
                chunkId: button.dataset.chunkId,
                docName: button.dataset.docName,
                score: button.dataset.score,
                helpful: button.dataset.helpful === 'true'
            })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.error) throw new Error(data.error || '反馈失败');
        showToast('反馈已记录');
    } catch (e) {
        showToast(e.message || '反馈失败', 'error');
    }
};

window.debugRagQuery = async () => {
    const input = document.getElementById('rag-debug-query');
    const button = document.getElementById('rag-debug-btn');
    const results = document.getElementById('rag-debug-results');
    if (button?.disabled) return;
    const query = input?.value?.trim();
    if (!query) {
        showToast('请输入要测试的问题', 'error');
        return;
    }

    const originalText = button?.textContent || '开始测试';
    try {
        if (button) {
            button.disabled = true;
            button.textContent = '测试中...';
            button.setAttribute('aria-busy', 'true');
        }
        if (results) {
            results.innerHTML = `
                <div class="rag-debug-loading">
                    <span class="rag-debug-spinner"></span>
                    <strong>正在测试召回效果</strong>
                    <small>正在检索知识库分块，请稍候</small>
                </div>
            `;
        }
        const res = await apiFetch(`${API_BASE}/rag/debug-query`, {
            method: 'POST',
            headers: {
                ...authHeaders(),
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                query,
                ragScope: window.getRagScopeSelection?.('debug') || {},
                scoreThreshold: document.getElementById('rag-debug-score-threshold')?.value,
                topK: document.getElementById('rag-debug-top-k')?.value,
                candidateLimit: document.getElementById('rag-debug-candidate-limit')?.value
            })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.error) throw new Error(data.error || '检索测试失败');
        renderRagDebugResults(data);
    } catch (e) {
        showToast(e.message || '检索测试失败', 'error');
        if (results) {
            results.innerHTML = `<div class="rag-debug-empty">检索测试失败，请调整问题或稍后重试</div>`;
        }
    } finally {
        if (button) {
            button.disabled = false;
            button.textContent = originalText;
            button.removeAttribute('aria-busy');
        }
    }
};

window.retryFailedKnowledgeDocs = async () => {
    try {
        const res = await apiFetch(`${API_BASE}/rag/docs/retry-failed`, {
            method: 'POST',
            headers: authHeaders()
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.error) throw new Error(data.error || '批量重试失败');
        showToast(`已加入 ${data.scheduled || 0} 个重新索引任务`);
        window.loadKnowledgeDocs();
    } catch (e) {
        showToast(e.message || '批量重试失败', 'error');
    }
};

window.uploadKnowledgeDoc = async (selectedFile = null) => {
    const fileInput = document.getElementById('rag-upload-input');
    const file = selectedFile || fileInput?.files?.[0];
    if (!file) return;
    
    const formData = new FormData();
    formData.append('file', file);
    const selectedCollectionId = normalizeRagCollectionId(document.getElementById('knowledge-upload-collection')?.value);
    const uploadTags = getSelectedRagTagCheckboxes('knowledge-upload-tags-list');
    if (selectedCollectionId) formData.append('collectionId', selectedCollectionId);
    if (uploadTags.length) formData.append('tags', uploadTags.join(','));

    showToast('正在上传并向量化文档，请稍候...', 'info');
    if (fileInput) fileInput.value = ''; // 重置 input

    try {
        const res = await apiFetch(`${API_BASE}/rag/upload`, {
            method: 'POST',
            headers: authHeaders(),
            body: formData
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        
        showToast(data.message || '文档已加入后台索引队列');
        document.querySelectorAll('#knowledge-upload-tags-list input[type="checkbox"]').forEach(input => { input.checked = false; });
        window.closeKnowledgeUploadModal?.();
        invalidateRagTagCache();
        await window.loadKnowledgeCollections?.();
        await window.refreshRagTagControlsForSelectedCollections?.({ force: true });
        window.loadKnowledgeDocs();
    } catch (e) {
        showToast(e.message || '文档上传失败', 'error');
    }
};

window.reindexKnowledgeDoc = async (id) => {
    try {
        const res = await apiFetch(`${API_BASE}/rag/docs/${id}/reindex`, {
            method: 'POST',
            headers: authHeaders()
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.error) throw new Error(data.error || '重新索引失败');
        showToast(data.message || '已加入重新索引队列');
        window.loadKnowledgeDocs();
    } catch (e) {
        showToast(e.message || '重新索引失败', 'error');
    }
};

window.deleteKnowledgeDoc = async (id) => {
    const confirmed = await ragConfirm('删除知识库文档', '确定要从知识库中移除该文档吗？大模型将不再参考此文档。');
    if (!confirmed) return;
    
    try {
        const res = await apiFetch(`${API_BASE}/rag/docs/${id}`, {
            method: 'DELETE',
            headers: authHeaders()
        });
        if (res.ok) {
            showToast('文档已移除');
            window.loadKnowledgeDocs();
        }
    } catch (e) {
        showToast('删除失败', 'error');
    }
};

document.addEventListener('change', async (event) => {
    const id = event.target?.id;
    if (id === 'rag-debug-collection') {
        await window.handleRagCollectionScopeChange?.('debug');
        return;
    }
    if (id === 'knowledge-upload-collection') {
        await window.handleRagCollectionScopeChange?.('upload');
        return;
    }
    if (id === 'knowledge-doc-meta-collection') {
        await window.handleRagCollectionScopeChange?.('meta');
    }
});

document.addEventListener('DOMContentLoaded', () => {
    window.loadKnowledgeCollections?.();
    window.refreshRagTagControlsForSelectedCollections?.();
});
