// ===== 多文档库管理 =====

function renderOfficialWritingDocList() {
    const list = document.getElementById('official-writing-doc-list');
    if (!list) return;
    const docs = [...officialWritingLibrary.docs].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    list.innerHTML = docs.map(doc => `
        <div class="official-writing-doc-item ${doc.id === officialWritingLibrary.activeId ? 'active' : ''}" data-official-writing-doc-id="${escapeAppsHtml(doc.id)}" role="listitem">
            <button type="button" class="official-writing-doc-open" data-official-writing-doc-open="${escapeAppsHtml(doc.id)}" title="${escapeAppsHtml(doc.title)}">
                <strong>${escapeAppsHtml(doc.title || '未命名公文')}</strong>
                <small>${escapeAppsHtml(formatVersionTime(doc.updatedAt))}</small>
            </button>
            <span class="official-writing-doc-actions">
                <button type="button" data-official-writing-doc-rename="${escapeAppsHtml(doc.id)}" title="重命名" aria-label="重命名">改名</button>
                <button type="button" data-official-writing-doc-delete="${escapeAppsHtml(doc.id)}" title="删除" aria-label="删除">删除</button>
            </span>
        </div>
    `).join('') || '<div class="official-writing-empty-note">暂无公文，点击“新建公文”开始。</div>';
    setText('official-writing-doc-count', `${officialWritingLibrary.docs.length} 篇`);
}

function switchOfficialWritingDoc(docId) {
    if (!docId || docId === officialWritingLibrary.activeId) return;
    const target = officialWritingLibrary.docs.find(doc => doc.id === docId);
    if (!target) return;
    // 切换前先把当前编辑器内容写回当前活动文档。
    syncOfficialWritingStateFromInputs();
    officialWritingLibrary.activeId = docId;
    officialWritingState = target.state;
    officialWritingUndoStack.length = 0;
    officialWritingRedoStack.length = 0;
    officialWritingUiState.lastSelection = null;
    updateOfficialWritingUndoRedoButtons();
    hydrateOfficialWritingForm();
    saveOfficialWritingState();
    renderOfficialWritingWorkspace();
    renderOfficialWritingDocList();
}

function createOfficialWritingDoc() {
    syncOfficialWritingStateFromInputs();
    const doc = {
        id: generateOfficialWritingDocId(),
        title: '新公文',
        updatedAt: new Date().toISOString(),
        state: createOfficialWritingState()
    };
    officialWritingLibrary.docs.unshift(doc);
    officialWritingLibrary.activeId = doc.id;
    officialWritingState = doc.state;
    officialWritingUndoStack.length = 0;
    officialWritingRedoStack.length = 0;
    officialWritingUiState.lastSelection = null;
    updateOfficialWritingUndoRedoButtons();
    hydrateOfficialWritingForm();
    saveOfficialWritingState();
    renderOfficialWritingWorkspace();
    renderOfficialWritingDocList();
    if (typeof showToast === 'function') showToast('已新建公文');
    getOfficialWritingSurface('draft')?.focus();
}

async function renameOfficialWritingDoc(docId) {
    const doc = officialWritingLibrary.docs.find(item => item.id === docId);
    if (!doc) return;
    const next = await window.showInputPrompt?.({
        title: '重命名公文',
        message: '请输入新的公文标题：',
        placeholder: '新公文',
        value: doc.title || '',
        requiredMessage: '公文标题不能为空'
    });
    if (next === null) return;
    const trimmed = next.trim();
    if (!trimmed) return;
    doc.title = compactTextPreview(trimmed, 40);
    doc.updatedAt = new Date().toISOString();
    saveOfficialWritingState();
    renderOfficialWritingDocList();
}

function deleteOfficialWritingDoc(docId) {
    const index = officialWritingLibrary.docs.findIndex(item => item.id === docId);
    if (index < 0) return;
    const doc = officialWritingLibrary.docs[index];
    const hasContent = String(doc.state?.draft || '').trim() || String(doc.state?.source || '').trim();
    if (hasContent && !window.confirm(`确认删除公文「${doc.title || '未命名公文'}」？此操作不可恢复。`)) {
        return;
    }
    officialWritingLibrary.docs.splice(index, 1);
    if (!officialWritingLibrary.docs.length) {
        // 删空后自动新建一篇空白公文，保证始终有活动文档。
        const fresh = {
            id: generateOfficialWritingDocId(),
            title: '新公文',
            updatedAt: new Date().toISOString(),
            state: createOfficialWritingState()
        };
        officialWritingLibrary.docs.push(fresh);
        officialWritingLibrary.activeId = fresh.id;
    } else if (officialWritingLibrary.activeId === docId) {
        officialWritingLibrary.activeId = officialWritingLibrary.docs[0].id;
    }
    officialWritingState = getActiveOfficialWritingDoc().state;
    officialWritingUndoStack.length = 0;
    officialWritingRedoStack.length = 0;
    updateOfficialWritingUndoRedoButtons();
    hydrateOfficialWritingForm();
    saveOfficialWritingState();
    renderOfficialWritingWorkspace();
    renderOfficialWritingDocList();
    if (typeof showToast === 'function') showToast('已删除公文');
}

function hydrateOfficialWritingForm() {
    const type = document.getElementById('official-writing-type');
    const standard = document.getElementById('official-writing-standard');
    const materialSource = document.getElementById('official-writing-material-source');
    const requirements = document.getElementById('official-writing-requirements');
    setOfficialWritingTextareaValue('source', officialWritingState.source || '');
    setOfficialWritingTextareaValue('draft', officialWritingState.draft || '');
    if (type) type.value = officialWritingState.docType || OFFICIAL_WRITING_DEFAULT_FORM_STATE.docType;
    if (standard) standard.value = officialWritingState.standard || OFFICIAL_WRITING_DEFAULT_FORM_STATE.standard;
    if (materialSource) materialSource.value = officialWritingState.materialSource || OFFICIAL_WRITING_DEFAULT_FORM_STATE.materialSource;
    if (requirements) requirements.value = officialWritingState.requirements || '';
    hydrateOfficialWritingMetaForm();
    updateOfficialWritingModeControls();
    renderOfficialWritingSurfaces({ force: true });
}

function updateOfficialWritingModeControls() {
    const mode = normalizeOfficialWritingMode(officialWritingState.mode);
    officialWritingState.mode = mode;
    document.querySelectorAll('[data-official-writing-run-mode]').forEach(button => {
        const active = button.dataset.officialWritingRunMode === mode;
        button.classList.toggle('active', active);
        button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    const requirements = document.getElementById('official-writing-requirements');
    if (requirements) {
        requirements.placeholder = OFFICIAL_WRITING_REQUIREMENT_PLACEHOLDERS[mode] || OFFICIAL_WRITING_REQUIREMENT_PLACEHOLDERS.draft;
    }
}

// 发文要素表单（版头 + 版记）字段 id 与 state.meta 键的映射。
const OFFICIAL_WRITING_META_FIELD_IDS = {
    secrecy: 'official-writing-meta-secrecy',
    urgency: 'official-writing-meta-urgency',
    issuer: 'official-writing-meta-issuer',
    issueNumber: 'official-writing-meta-issue-number',
    cc: 'official-writing-meta-cc',
    printer: 'official-writing-meta-printer',
    printDate: 'official-writing-meta-print-date'
};

function hydrateOfficialWritingMetaForm() {
    const meta = normalizeOfficialWritingMeta(officialWritingState.meta);
    officialWritingState.meta = meta;
    Object.entries(OFFICIAL_WRITING_META_FIELD_IDS).forEach(([key, id]) => {
        const el = document.getElementById(id);
        if (el) el.value = meta[key] || '';
    });
}

function syncOfficialWritingMetaFromInputs() {
    const meta = { ...OFFICIAL_WRITING_DEFAULT_META };
    Object.entries(OFFICIAL_WRITING_META_FIELD_IDS).forEach(([key, id]) => {
        const el = document.getElementById(id);
        if (el) meta[key] = String(el.value || '').trim();
    });
    officialWritingState.meta = meta;
    return meta;
}

function getOfficialWritingText(field) {
    if (officialWritingProgrammaticTextUpdate) return document.getElementById(field)?.value || '';
    if (field === 'official-writing-source' && isOfficialWritingSurfaceActive('source')) {
        syncOfficialWritingSurfaceToTextarea('source');
    }
    if (field === 'official-writing-draft' && isOfficialWritingSurfaceActive('draft')) {
        syncOfficialWritingSurfaceToTextarea('draft');
    }
    return document.getElementById(field)?.value || '';
}

function getOfficialWritingSurface(target = 'draft') {
    return document.getElementById(target === 'source' ? 'official-writing-source-surface' : 'official-writing-draft-surface');
}

function getOfficialWritingRawEditor(target = 'draft') {
    return document.getElementById(target === 'source' ? 'official-writing-source' : 'official-writing-draft');
}

function getOfficialWritingSurfaceText(text) {
    return String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function isOfficialWritingSurfaceActive(target) {
    const surface = getOfficialWritingSurface(target);
    return Boolean(surface && (document.activeElement === surface || surface.contains(document.activeElement)));
}

function getOfficialWritingParagraphLines(text) {
    return getOfficialWritingSurfaceText(text)
        .split('\n')
        .map(line => line.trimEnd());
}

function isOfficialWritingDateLine(line) {
    return /^(【日期】|【成文日期】|(?:【待补充】|[0-9０-９]{4}|[一二三四五六七八九十〇零]{4})年(?:【待补充】|[0-9０-９]{1,2}|[一二三四五六七八九十〇零]{1,3})月(?:【待补充】|[0-9０-９]{1,2}|[一二三四五六七八九十〇零]{1,3})日)$/.test(String(line || '').trim());
}

function isOfficialWritingClosingLine(line) {
    return /^(此致|敬礼|谨此|特此|专此|此复|特此函达|特此报告)/.test(String(line || '').trim());
}

function isOfficialWritingFooterLabelLine(line) {
    return /^(附件|抄送|联系人|联系电话|邮编|地址|电话|传真)[:：]/.test(String(line || '').trim());
}

function isOfficialWritingSignatureLine(line, index = 0, lines = []) {
    const text = String(line || '').trim();
    if (/^(【发文单位】|【日期】|【成文日期】)$/.test(text) || isOfficialWritingDateLine(text)) return true;
    const nonEmptyIndexes = lines
        .map((item, itemIndex) => String(item || '').trim() ? itemIndex : -1)
        .filter(itemIndex => itemIndex >= 0);
    const tailIndexes = nonEmptyIndexes.slice(-2);
    const lastIndex = tailIndexes[tailIndexes.length - 1];
    return tailIndexes[0] === index
        && lastIndex !== undefined
        && isOfficialWritingDateLine(lines[lastIndex])
        && !isOfficialWritingNumberedHeading(text)
        && !isOfficialWritingSubHeading(text)
        && !isOfficialWritingRecipientLine(text)
        && !isOfficialWritingClosingLine(text)
        && !isOfficialWritingFooterLabelLine(text)
        && text.length <= 28;
}

function isOfficialWritingRecipientLine(line) {
    return /[:：]$/.test(line) || /^(【主送机关】|主送机关[:：]|各有关单位[:：]?|各部门[:：]?|各单位[:：]?)/.test(line);
}

function isOfficialWritingNumberedHeading(line) {
    return /^[一二三四五六七八九十]+[、.．]/.test(line);
}

function isOfficialWritingSubHeading(line) {
    return /^[（(][一二三四五六七八九十0-9一二三四五六七八九十]+[）)]/.test(line) || /^\d+[、.．]/.test(line);
}

function isOfficialWritingIndentedItem(line) {
    return /^[（(][一二三四五六七八九十0-9]+[）)]/.test(String(line || '').trim());
}

function classifyOfficialWritingLine(line, index, lines) {
    const text = String(line || '').trim();
    if (!text) return { type: 'blank', text: '' };
    const firstNonEmptyIndex = lines.findIndex(item => String(item || '').trim());
    if (index === firstNonEmptyIndex) {
        if (/^[【\[]/.test(text) || /通知|通报|请示|报告|意见|函|纪要|决定|公告|批复|通知$/.test(text)) {
            return { type: 'title', text };
        }
    }
    if (isOfficialWritingSignatureLine(text, index, lines)) return { type: 'signature', text };
    if (isOfficialWritingFooterLabelLine(text)) return { type: 'label', text };
    if (isOfficialWritingRecipientLine(text)) return { type: 'recipient', text };
    if (isOfficialWritingClosingLine(text)) {
        return { type: 'closing', text };
    }
    if (isOfficialWritingNumberedHeading(text)) {
        return { type: 'major-heading', text };
    }
    if (isOfficialWritingIndentedItem(text)) {
        return { type: 'indented-item', text };
    }
    if (/^\d+[、.．]/.test(text)) {
        return { type: 'minor-heading', text };
    }
    if (/^[一二三四五六七八九十]+、/.test(text) || /^[-—]/.test(text)) {
        return { type: 'paragraph-heading', text };
    }
    if (/^【.*】[:：]?$/.test(text)) {
        return { type: 'label', text };
    }
    return { type: 'paragraph', text };
}

function renderOfficialWritingSurface(target = 'draft', { force = false } = {}) {
    const surface = getOfficialWritingSurface(target);
    const textarea = getOfficialWritingRawEditor(target);
    if (!surface || !textarea) return;
    if (!force && surface === document.activeElement) return;
    const value = getOfficialWritingSurfaceText(textarea.value || '');
    const lines = getOfficialWritingParagraphLines(value);
    const activeClass = surface.classList.contains('is-active') ? ' is-active' : '';
    const hiddenClass = surface.classList.contains('is-document-hidden') ? ' is-document-hidden' : '';
    surface.className = `official-writing-document-surface official-writing-editable-surface official-writing-surface-${target}${activeClass}${hiddenClass}`;
    surface.innerHTML = '';
    if (!value.trim()) {
        surface.dataset.empty = 'true';
        surface.dataset.placeholder = textarea.placeholder || surface.dataset.placeholder || '请输入正文';
        return;
    }
    delete surface.dataset.empty;
    let paragraphIndex = 0;
    let cursor = 0;
    let previousContentType = '';
    lines.forEach((line, index) => {
        const rawLine = String(line || '');
        const lineStart = cursor;
        const lineEnd = cursor + rawLine.length;
        const kind = classifyOfficialWritingLine(line, index, lines);
        cursor = lineEnd + (index < lines.length - 1 ? 1 : 0);
        if (kind.type === 'blank') {
            const gap = document.createElement('div');
            gap.className = 'official-writing-surface-blank';
            gap.dataset.textStart = String(lineStart);
            gap.dataset.textEnd = String(lineEnd);
            surface.appendChild(gap);
            paragraphIndex += 1;
            return;
        }
        const block = document.createElement('div');
        block.className = `official-writing-surface-line official-writing-surface-${kind.type}`;
        if (kind.type === 'signature') {
            block.classList.add(previousContentType === 'signature'
                ? 'official-writing-surface-signature-continuation'
                : 'official-writing-surface-signature-start');
        }
        block.dataset.paragraphIndex = String(paragraphIndex);
        block.dataset.textStart = String(lineStart);
        block.dataset.textEnd = String(lineEnd);
        const textSpan = document.createElement('span');
        textSpan.className = 'official-writing-surface-text';
        textSpan.textContent = kind.text;
        block.appendChild(textSpan);
        surface.appendChild(block);
        if (kind.type !== 'minor-heading' && kind.type !== 'major-heading') {
            paragraphIndex += 1;
        }
        previousContentType = kind.type;
    });
}

function renderOfficialWritingSurfaces({ force = false } = {}) {
    renderOfficialWritingSurface('source', { force });
    renderOfficialWritingSurface('draft', { force });
}

function syncOfficialWritingSurfaceToTextarea(target = 'draft') {
    const surface = getOfficialWritingSurface(target);
    const textarea = getOfficialWritingRawEditor(target);
    if (!surface || !textarea) return;
    if (surface.dataset.syncing === '1') return;
    surface.dataset.syncing = '1';
    textarea.value = normalizeOfficialWritingSurfaceText(surface.innerText || surface.textContent || '');
    delete surface.dataset.syncing;
}

function handleOfficialWritingSurfaceInput(event) {
    const target = event.currentTarget?.dataset?.officialWritingSurface || 'draft';
    const selection = getOfficialWritingSurfaceSelection(target);
    // 即时部分：保持文本与光标同步，让键入手感不卡顿。
    syncOfficialWritingSurfaceToTextarea(target);
    renderOfficialWritingSurface(target, { force: true });
    if (selection) {
        const textarea = getOfficialWritingTextarea(target);
        const point = Math.min(selection.end, textarea?.value.length || 0);
        setOfficialWritingSurfaceSelection(target, point, point);
    }
    // 重活（整库持久化 + 校对/合规 + 列表重建 + 回流）去抖执行。
    scheduleOfficialWritingAnalysis();
}

function handleOfficialWritingSurfaceBlur(event) {
    const target = event.currentTarget?.dataset?.officialWritingSurface || 'draft';
    syncOfficialWritingSurfaceToTextarea(target);
    renderOfficialWritingSurface(target);
    // 失焦时立即冲刷待执行的去抖任务，避免离开输入框时丢失最近一次保存。
    flushOfficialWritingAnalysis();
}

function handleOfficialWritingSurfacePaste(event) {
    event.preventDefault();
    const text = event.clipboardData?.getData('text/plain') || '';
    document.execCommand?.('insertText', false, text);
}

function handleOfficialWritingSurfaceKeydown(event) {
    if (event.key === 'Tab') {
        event.preventDefault();
        document.execCommand?.('insertText', false, '    ');
    }
}

function updateOfficialWritingSurfaceVisibility() {
    const panel = document.querySelector('.official-writing-panel');
    if (!panel) return;
    const mode = panel.dataset.writingViewMode || 'document';
    ['source', 'draft'].forEach(target => {
        const surface = getOfficialWritingSurface(target);
        const textarea = getOfficialWritingRawEditor(target);
        if (!surface || !textarea) return;
        surface.classList.toggle('is-active', true);
        textarea.classList.toggle('is-active-editor', false);
        if (mode === 'document' && target === 'source') {
            surface.classList.add('is-document-hidden');
        } else {
            surface.classList.remove('is-document-hidden');
        }
    });
}

function syncOfficialWritingStateFromInputs() {
    // 同步即包含整库持久化，使任何待执行的去抖任务变为冗余，清掉以免重复触发。
    if (officialWritingAnalysisDebounceTimer) {
        clearTimeout(officialWritingAnalysisDebounceTimer);
        officialWritingAnalysisDebounceTimer = null;
    }
    officialWritingState.docType = getOfficialWritingDocType();
    officialWritingState.mode = getOfficialWritingMode();
    officialWritingState.standard = getOfficialWritingStandard();
    officialWritingState.materialSource = getOfficialWritingMaterialSource();
    officialWritingState.requirements = getOfficialWritingRequirements();
    officialWritingState.source = getOfficialWritingText('official-writing-source');
    officialWritingState.draft = getOfficialWritingText('official-writing-draft');
    syncOfficialWritingMetaFromInputs();
    updateOfficialWritingModeControls();
    if (!isOfficialWritingSurfaceActive('source')) renderOfficialWritingSurface('source');
    if (!isOfficialWritingSurfaceActive('draft')) renderOfficialWritingSurface('draft');
    recordOfficialWritingAutoSave();
    saveOfficialWritingState();
}

function getTextCount(text) {
    return String(text || '').replace(/\s/g, '').length;
}

function getOfficialWritingWorkspaceSummary() {
    const sourceCount = getTextCount(officialWritingState.source);
    const draftCount = getTextCount(officialWritingState.draft);
    const risks = getOfficialWritingComplianceRisks();
    const pendingSuggestions = officialWritingState.suggestions.filter(item => item.status !== 'accepted' && item.status !== 'rejected').length;
    const commentCount = officialWritingState.comments.length;
    const versionCount = officialWritingState.versions.length;
    const referenceCount = getOfficialWritingReferenceMatches().length;
    let statusTitle = '待起草';
    let statusDetail = '先粘贴原文材料或直接起草正文。';

    if (draftCount > 0) {
        if (risks.length === 0) {
            statusTitle = pendingSuggestions > 0 ? '可审阅' : '可导出';
            statusDetail = pendingSuggestions > 0
                ? `正文已成稿，还有 ${pendingSuggestions} 条建议待处理。`
                : '正文已成稿，可直接导出或带入聊天复核。';
        } else if (risks.length <= 2) {
            statusTitle = '待确认';
            statusDetail = `正文还有 ${risks.length} 项风险需要处理后再正式流转。`;
        } else {
            statusTitle = '待完善';
            statusDetail = `正文还有 ${risks.length} 项风险，建议先补齐关键信息。`;
        }
    } else if (sourceCount > 0) {
        statusTitle = '可起草';
        statusDetail = '原文材料已就绪，可直接起草正文。';
    }

    return {
        sourceCount,
        draftCount,
        risks,
        pendingSuggestions,
        commentCount,
        versionCount,
        referenceCount,
        statusTitle,
        statusDetail
    };
}

function setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
}

function formatVersionTime(value) {
    if (!value) return '';
    try {
        return new Date(value).toLocaleString('zh-CN', { hour12: false });
    } catch (e) {
        return String(value);
    }
}

function getOfficialWritingDocType() {
    return document.getElementById('official-writing-type')?.value || '通知';
}

function getOfficialWritingMode() {
    return normalizeOfficialWritingMode(officialWritingState.mode);
}

function getOfficialWritingStandard() {
    return document.getElementById('official-writing-standard')?.value || '通用公文规范';
}

function getOfficialWritingMaterialSource() {
    return document.getElementById('official-writing-material-source')?.value || '粘贴材料';
}

function getOfficialWritingRequirements() {
    return document.getElementById('official-writing-requirements')?.value.trim() || '';
}

function getOfficialWritingTemplateKey(docType) {
    return OFFICIAL_WRITING_TYPE_TO_TEMPLATE_KEY[docType] || 'general';
}

function compactTextPreview(text, length = 90) {
    const normalized = String(text || '').replace(/\s+/g, ' ').trim();
    if (!normalized) return '';
    return normalized.length > length ? `${normalized.slice(0, length)}...` : normalized;
}

function splitOfficialWritingParagraphs(text) {
    const paragraphs = [];
    let cursor = 0;
    String(text || '').split(/(\r?\n+)/).forEach(part => {
        if (!part) return;
        const start = cursor;
        const end = cursor + part.length;
        cursor = end;
        if (!/^\r?\n+$/.test(part) && part.trim()) {
            paragraphs.push({
                text: part.trim(),
                start,
                end,
                line: paragraphs.length + 1
            });
        }
    });
    return paragraphs;
}

function normalizeOfficialWritingIndex(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function getOfficialWritingTextarea(target = 'draft') {
    return document.getElementById(target === 'source' ? 'official-writing-source' : 'official-writing-draft');
}

function getOfficialWritingTargetFromTextarea(textarea) {
    return textarea?.id === 'official-writing-source' ? 'source' : 'draft';
}

function normalizeOfficialWritingSurfaceText(text) {
    return String(text || '')
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .replace(/\u00a0/g, ' ')
        .trimEnd();
}

function getOfficialWritingSurfaceSelection(target) {
    const surface = getOfficialWritingSurface(target);
    const selection = window.getSelection?.();
    if (!surface || !selection || selection.rangeCount === 0) return null;
    const range = selection.getRangeAt(0);
    if (!surface.contains(range.startContainer) && surface !== range.startContainer) return null;
    if (!surface.contains(range.endContainer) && surface !== range.endContainer) return null;
    let startPoint = getOfficialWritingOffsetFromSurfacePoint(surface, range.startContainer, range.startOffset);
    let endPoint = getOfficialWritingOffsetFromSurfacePoint(surface, range.endContainer, range.endOffset);
    if (startPoint == null || endPoint == null) {
        const before = range.cloneRange();
        before.selectNodeContents(surface);
        before.setEnd(range.startContainer, range.startOffset);
        startPoint = normalizeOfficialWritingSurfaceText(before.toString()).length;
        endPoint = startPoint + normalizeOfficialWritingSurfaceText(range.toString()).length;
    }
    const start = Math.min(startPoint, endPoint);
    const end = Math.max(startPoint, endPoint);
    const textarea = getOfficialWritingTextarea(target);
    return {
        target,
        start,
        end,
        text: textarea?.value?.slice(start, end) || normalizeOfficialWritingSurfaceText(range.toString())
    };
}

function getActiveOfficialWritingSurfaceSelection() {
    const selection = window.getSelection?.();
    if (!selection || selection.rangeCount === 0) return null;
    return ['source', 'draft']
        .map(target => ({ target, surface: getOfficialWritingSurface(target) }))
        .filter(item => item.surface)
        .map(item => {
            const range = selection.getRangeAt(0);
            const active = document.activeElement === item.surface
                || item.surface.contains(range.startContainer)
                || item.surface.contains(range.endContainer);
            return active ? getOfficialWritingSurfaceSelection(item.target) : null;
        })
        .find(Boolean) || null;
}

function getOfficialWritingTextOffsetWithinLine(line, node, offset) {
    if (!line) return 0;
    if (node === line) return Math.min(offset, line.textContent?.length || 0);
    const range = document.createRange();
    range.selectNodeContents(line);
    range.setEnd(node, offset);
    return range.toString().length;
}

function getOfficialWritingOffsetFromSurfacePoint(surface, node, offset) {
    const elementNode = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    const line = elementNode?.closest?.('.official-writing-surface-line');
    if (!line || !surface.contains(line)) return null;
    const lineStart = Number(line.dataset.textStart || 0);
    const lineEnd = Number(line.dataset.textEnd || lineStart);
    const relative = getOfficialWritingTextOffsetWithinLine(line, node, offset);
    return Math.max(lineStart, Math.min(lineEnd, lineStart + relative));
}

function findOfficialWritingTextPoint(node, offset) {
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    let currentOffset = Math.max(0, offset);
    let lastText = null;
    while (walker.nextNode()) {
        const textNode = walker.currentNode;
        lastText = textNode;
        const length = textNode.nodeValue?.length || 0;
        if (currentOffset <= length) return { node: textNode, offset: currentOffset };
        currentOffset -= length;
    }
    if (lastText) return { node: lastText, offset: lastText.nodeValue?.length || 0 };
    return { node, offset: Math.min(node.childNodes.length, 0) };
}

function getOfficialWritingSurfacePoint(target, offset) {
    const surface = getOfficialWritingSurface(target);
    if (!surface) return null;
    const lines = Array.from(surface.querySelectorAll('.official-writing-surface-line'));
    if (!lines.length) return { node: surface, offset: 0 };
    const safeOffset = Math.max(0, offset);
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        const start = Number(line.dataset.textStart || 0);
        const end = Number(line.dataset.textEnd || start);
        if (safeOffset <= end) return findOfficialWritingTextPoint(line, safeOffset - start);
    }
    const lastLine = lines[lines.length - 1];
    return findOfficialWritingTextPoint(lastLine, lastLine.textContent?.length || 0);
}

function setOfficialWritingSurfaceSelection(target, start, end = start) {
    const surface = getOfficialWritingSurface(target);
    const startPoint = getOfficialWritingSurfacePoint(target, start);
    const endPoint = getOfficialWritingSurfacePoint(target, end);
    if (!surface || !startPoint || !endPoint) return;
    const range = document.createRange();
    range.setStart(startPoint.node, startPoint.offset);
    range.setEnd(endPoint.node, endPoint.offset);
    const selection = window.getSelection?.();
    if (!selection) return;
    selection.removeAllRanges();
    selection.addRange(range);
    surface.focus();
}

function setTextareaSelection(textarea, start, end = start) {
    if (!textarea) return;
    const safeStart = Math.max(0, Math.min(textarea.value.length, start));
    const safeEnd = Math.max(safeStart, Math.min(textarea.value.length, end));
    textarea.setSelectionRange(safeStart, safeEnd);
    const target = getOfficialWritingTargetFromTextarea(textarea);
    renderOfficialWritingSurface(target);
    setOfficialWritingSurfaceSelection(target, safeStart, safeEnd);
}

function setOfficialWritingTextareaValue(target, value) {
    const textarea = getOfficialWritingTextarea(target);
    if (!textarea) return;
    officialWritingProgrammaticTextUpdate = true;
    try {
        textarea.value = String(value || '');
        renderOfficialWritingSurface(target, { force: true });
    } finally {
        officialWritingProgrammaticTextUpdate = false;
    }
}

// 撤销/重做：仅快照正文与原文文本，覆盖破坏性操作（建议替换/插入、模板套用、载入版本、同步原文）。
function captureOfficialWritingSnapshot() {
    return {
        source: getOfficialWritingText('official-writing-source'),
        draft: getOfficialWritingText('official-writing-draft')
    };
}

function pushOfficialWritingUndoSnapshot() {
    const snapshot = captureOfficialWritingSnapshot();
    const last = officialWritingUndoStack[officialWritingUndoStack.length - 1];
    if (last && last.source === snapshot.source && last.draft === snapshot.draft) return;
    officialWritingUndoStack.push(snapshot);
    if (officialWritingUndoStack.length > OFFICIAL_WRITING_HISTORY_LIMIT) officialWritingUndoStack.shift();
    officialWritingRedoStack.length = 0;
    updateOfficialWritingUndoRedoButtons();
}

function applyOfficialWritingSnapshot(snapshot) {
    setOfficialWritingTextareaValue('source', snapshot.source || '');
    setOfficialWritingTextareaValue('draft', snapshot.draft || '');
    syncOfficialWritingStateFromInputs();
    renderOfficialWritingWorkspace();
}

function undoOfficialWriting() {
    if (!officialWritingUndoStack.length) return;
    officialWritingRedoStack.push(captureOfficialWritingSnapshot());
    const snapshot = officialWritingUndoStack.pop();
    applyOfficialWritingSnapshot(snapshot);
    updateOfficialWritingUndoRedoButtons();
    if (typeof showToast === 'function') showToast('已撤销');
}

function redoOfficialWriting() {
    if (!officialWritingRedoStack.length) return;
    officialWritingUndoStack.push(captureOfficialWritingSnapshot());
    const snapshot = officialWritingRedoStack.pop();
    applyOfficialWritingSnapshot(snapshot);
    updateOfficialWritingUndoRedoButtons();
    if (typeof showToast === 'function') showToast('已重做');
}

function updateOfficialWritingUndoRedoButtons() {
    const undoBtn = document.getElementById('official-writing-undo-btn');
    const redoBtn = document.getElementById('official-writing-redo-btn');
    if (undoBtn) undoBtn.disabled = officialWritingUndoStack.length === 0;
    if (redoBtn) redoBtn.disabled = officialWritingRedoStack.length === 0;
}

function replaceTextareaRange(textarea, start, end, replacement, { skipSnapshot } = {}) {
    if (!textarea) return;
    if (!skipSnapshot) pushOfficialWritingUndoSnapshot();
    const before = textarea.value.slice(0, start);
    const after = textarea.value.slice(end);
    officialWritingProgrammaticTextUpdate = true;
    try {
        textarea.value = `${before}${replacement}${after}`;
        setTextareaSelection(textarea, start, start + replacement.length);
    } finally {
        officialWritingProgrammaticTextUpdate = false;
    }
    syncOfficialWritingStateFromInputs();
    renderOfficialWritingSurface(getOfficialWritingTargetFromTextarea(textarea), { force: true });
}

function getCurrentOfficialWritingSelection() {
    const surfaceSelection = getActiveOfficialWritingSurfaceSelection();
    if (surfaceSelection) {
        const textarea = getOfficialWritingTextarea(surfaceSelection.target);
        if (textarea) {
            textarea.selectionStart = surfaceSelection.start;
            textarea.selectionEnd = surfaceSelection.end;
        }
        return surfaceSelection;
    }
    const source = getOfficialWritingTextarea('source');
    const draft = getOfficialWritingTextarea('draft');
    const active = document.activeElement === source ? source : draft;
    const target = active === source ? 'source' : 'draft';
    const start = normalizeOfficialWritingIndex(active?.selectionStart, 0);
    const end = normalizeOfficialWritingIndex(active?.selectionEnd, start);
    const text = active?.value?.slice(start, end) || '';
    return { target, start, end, text };
}

function rememberOfficialWritingSelection() {
    const selection = getCurrentOfficialWritingSelection();
    if (selection.text.trim()) officialWritingUiState.lastSelection = selection;
    return selection;
}

function getBestOfficialWritingSelection() {
    const live = getCurrentOfficialWritingSelection();
    if (live.text.trim()) {
        officialWritingUiState.lastSelection = live;
        return live;
    }
    return officialWritingUiState.lastSelection || live;
}

function getOfficialWritingInsertionPoint(target = 'draft') {
    const surfaceSelection = getOfficialWritingSurfaceSelection(target);
    if (surfaceSelection) return surfaceSelection.end;
    const textarea = getOfficialWritingTextarea(target);
    return textarea?.selectionEnd || textarea?.value.length || 0;
}

function getOfficialWritingMaterialSegments() {
    const source = String(officialWritingState.source || '');
    return source.split(/\r?\n/)
        .map((line, index) => ({ id: `material-${index}`, text: line.trim(), index }))
        .filter(item => item.text.length >= 6)
        .slice(0, 12);
}

function recordOfficialWritingAutoSave() {
    const draft = String(officialWritingState.draft || '');
    if (!draft.trim()) return;
    const last = officialWritingState.autoSaves?.[0];
    if (last?.draft === draft) return;
    officialWritingState.autoSaves = [
        {
            id: `autosave-${Date.now()}`,
            name: `${getOfficialWritingDocType()}自动草稿`,
            draft,
            source: officialWritingState.source,
            createdAt: new Date().toISOString()
        },
        ...(Array.isArray(officialWritingState.autoSaves) ? officialWritingState.autoSaves : [])
    ].slice(0, 8);
}

function getOfficialWritingComplianceRisks() {
    const draft = String(officialWritingState.draft || '').trim();
    const source = String(officialWritingState.source || '').trim();
    const risks = [];
    if (!draft) {
        risks.push({ id: 'empty-draft', level: '提示', title: '正文稿为空', detail: '请先起草或粘贴正文稿，再进行审校和导出。', start: 0, end: 0, suggestion: '可先套用结构化模板或点击 AI 起草。' });
        return risks;
    }
    const firstLine = draft.split(/\r?\n/).find(line => line.trim()) || '';
    const firstLineStart = draft.indexOf(firstLine);
    if (!/关于.+的/.test(firstLine) && firstLine.length < 8) {
        risks.push({ id: 'weak-title', level: '中', title: '标题信息偏弱', detail: '标题建议明确事项和文种，例如“关于……的通知/请示/报告”。', start: firstLineStart, end: firstLineStart + firstLine.length, suggestion: `建议改为“关于【事项】的${getOfficialWritingDocType()}”。` });
    }
    const placeholder = draft.match(/【待补充】|【.+?】/);
    if (placeholder) {
        risks.push({ id: 'placeholder', level: '高', title: '存在待补充占位', detail: '正文中仍有占位内容，正式流转前需要补齐或删除。', start: placeholder.index, end: placeholder.index + placeholder[0].length, suggestion: '请根据材料补齐该处事实信息，无法确认时保留待核实说明。' });
    }
    if (!/[0-9]{4}年[0-9]{1,2}月[0-9]{1,2}日/.test(draft) && !/\d{4}[.-]\d{1,2}[.-]\d{1,2}/.test(draft)) {
        risks.push({ id: 'missing-date', level: '低', title: '未识别成文日期', detail: '如需正式行文，建议在落款处补齐日期。', start: Math.max(0, draft.length - 20), end: draft.length, suggestion: '建议在落款处补充“XXXX年XX月XX日”。' });
    }
    if (draft.length > 80 && source.length > 80 && getTextCount(source) > 0) {
        const overlap = getOfficialWritingReferenceMatches();
        if (!overlap.length) {
            risks.push({ id: 'weak-reference', level: '中', title: '材料引用较弱', detail: '正文稿未明显承接原文材料，建议核对事实依据。', start: 0, end: Math.min(draft.length, 80), suggestion: '建议从材料中引用关键事实、时间、数字或政策依据。' });
        }
    }
    const tone = draft.match(/[!?]|！！|？？|非常|特别|巨大|完美|必须立即/);
    if (tone) {
        risks.push({ id: 'tone-risk', level: '低', title: '语气可能偏口语或偏强', detail: '公文表达建议准确、克制，避免情绪化和绝对化措辞。', start: tone.index, end: tone.index + tone[0].length, suggestion: '建议改为更克制、准确的公文表述。' });
    }
    // 规范库特有规则：按所选规范库追加硬性要素检查。
    const standard = getOfficialWritingStandard();
    const ruleContext = { draftLength: draft.length, sourceLength: source.length, docType: getOfficialWritingDocType() };
    getOfficialWritingStandardRules(standard).forEach(rule => {
        let hit = false;
        try {
            hit = rule.test(draft, ruleContext);
        } catch (e) {
            hit = false;
        }
        if (hit) {
            risks.push({
                id: rule.id,
                level: rule.level,
                title: rule.title,
                detail: rule.detail,
                start: 0,
                end: 0,
                suggestion: rule.suggestion
            });
        }
    });
    return risks;
}

// 提取用于模糊匹配的特征：数字/日期/百分比等强信号，以及 2-gram 字符片段。
function buildOfficialWritingMatchFeatures(text) {
    const normalized = String(text || '').replace(/\s+/g, '');
    const numbers = (text.match(/\d+(?:\.\d+)?%?|[一二三四五六七八九十百千万亿]{2,}/g) || [])
        .filter(token => token.length >= 2);
    const grams = new Set();
    for (let i = 0; i < normalized.length - 1; i += 1) {
        const gram = normalized.slice(i, i + 2);
        if (/[一-龥A-Za-z0-9]{2}/.test(gram)) grams.add(gram);
    }
    return { numbers, grams, normalizedLength: normalized.length };
}

function officialWritingFeatureOverlap(sourceFeatures, draftFeatures) {
    if (!sourceFeatures.grams.size) return { ratio: 0, numberHit: false };
    let shared = 0;
    sourceFeatures.grams.forEach(gram => {
        if (draftFeatures.grams.has(gram)) shared += 1;
    });
    const ratio = shared / sourceFeatures.grams.size;
    const numberHit = sourceFeatures.numbers.some(num => draftFeatures.numbers.includes(num));
    return { ratio, numberHit };
}

function getOfficialWritingReferenceMatches() {
    const draft = String(officialWritingState.draft || '');
    const source = String(officialWritingState.source || '');
    if (!draft.trim() || !source.trim()) return [];
    const draftFeatures = buildOfficialWritingMatchFeatures(draft);
    const sourceLines = source.split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line.length >= 8);
    const matches = [];
    sourceLines.slice(0, 80).forEach(line => {
        // 先用原有精确子串作为强匹配，再用 2-gram 重叠率 + 关键数字命中作为模糊匹配，
        // 避免正文对材料稍作改写后被误判为“未引用”。
        const sample = line.length > 28 ? line.slice(0, 28) : line;
        const exact = sample.length >= 8 && draft.includes(sample);
        let ratio = 0;
        let numberHit = false;
        if (!exact) {
            const overlap = officialWritingFeatureOverlap(buildOfficialWritingMatchFeatures(line), draftFeatures);
            ratio = overlap.ratio;
            numberHit = overlap.numberHit;
        }
        const fuzzy = !exact && (ratio >= 0.45 || (numberHit && ratio >= 0.25));
        if (exact || fuzzy) {
            matches.push({
                source: compactTextPreview(line, 72),
                draft: compactTextPreview(sample, 48),
                kind: exact ? 'exact' : 'fuzzy',
                score: exact ? 1 : Math.round(ratio * 100) / 100
            });
        }
    });
    return matches.slice(0, 12);
}

function renderOfficialWritingStats() {
    const summary = getOfficialWritingWorkspaceSummary();
    setText('official-writing-source-count', `${summary.sourceCount} 字`);
    setText('official-writing-draft-count', `${summary.draftCount} 字`);
    setText('official-writing-comment-count', `${summary.commentCount} 条`);
    setText('official-writing-version-count', `${summary.versionCount} 个版本`);
    setText('official-writing-compliance-count', `${summary.risks.length} 项风险`);
    setText('official-writing-comment-badge', String(summary.commentCount));
    setText('official-writing-version-badge', String(summary.versionCount));
    setText('official-writing-suggestion-badge', String(summary.pendingSuggestions));
    setText('official-writing-status-title', summary.statusTitle);
    setText('official-writing-status-detail', summary.statusDetail);
    setText('official-writing-status-risk', String(summary.risks.length));
    setText('official-writing-status-pending', String(summary.pendingSuggestions));
    setText('official-writing-status-reference', String(summary.referenceCount));
    setText('official-writing-status-version', String(summary.versionCount));
}

function renderOfficialWritingComments() {
    const list = document.getElementById('official-writing-comments-list');
    if (!list) return;
    list.innerHTML = officialWritingState.comments.map(comment => `
        <article class="official-writing-comment" data-comment-id="${escapeAppsHtml(comment.id)}">
            <div>
                <strong>${comment.target === 'draft' ? '正文稿' : '原文'}</strong>
                <span>${escapeAppsHtml(comment.anchor || '全文')}</span>
            </div>
            <p>${escapeAppsHtml(comment.text)}</p>
            <button type="button" class="btn-secondary" data-comment-delete="${escapeAppsHtml(comment.id)}">删除</button>
        </article>
    `).join('') || '<div class="official-writing-empty-note">暂无批注</div>';
}

function versionOption(version, fallbackName) {
    const label = version.name || fallbackName || '未命名版本';
    return `<option value="${escapeAppsHtml(version.id)}">${escapeAppsHtml(label)}</option>`;
}

function renderOfficialWritingVersions() {
    const list = document.getElementById('official-writing-version-list');
    const base = document.getElementById('official-writing-base-version');
    const target = document.getElementById('official-writing-target-version');
    const currentBaseValue = base?.value || 'source';
    const currentTargetValue = target?.value || 'draft';
    if (list) {
        const saved = officialWritingState.versions.map(version => ({ ...version, kind: version.stage || '保存版本' }));
        const auto = (officialWritingState.autoSaves || []).map(version => ({ ...version, kind: '自动草稿' }));
        list.innerHTML = [...saved, ...auto].map(version => `
            <button type="button" class="official-writing-version-item" data-version-load="${escapeAppsHtml(version.id)}">
                <span>
                    <strong>${escapeAppsHtml(version.name || '未命名版本')}</strong>
                    <em>${escapeAppsHtml(version.kind)}</em>
                </span>
                <small>${escapeAppsHtml(formatVersionTime(version.createdAt))}</small>
            </button>
        `).join('') || '<div class="official-writing-empty-note">暂无版本，保存当前正文稿后可进行对比。</div>';
    }
    if (base && target) {
        const sourceOption = '<option value="source">当前原文</option>';
        const draftOption = '<option value="draft">当前正文稿</option>';
        const savedOptions = officialWritingState.versions.map((version, index) => versionOption(version, `版本 ${index + 1}`)).join('');
        base.innerHTML = `${sourceOption}${draftOption}${savedOptions}`;
        target.innerHTML = `${draftOption}${sourceOption}${savedOptions}`;
        base.value = Array.from(base.options).some(option => option.value === currentBaseValue) ? currentBaseValue : 'source';
        target.value = Array.from(target.options).some(option => option.value === currentTargetValue) ? currentTargetValue : 'draft';
    }
}

function renderOfficialWritingCompliance() {
    const list = document.getElementById('official-writing-compliance-list');
    if (!list) return;
    const risks = getOfficialWritingComplianceRisks();
    list.innerHTML = risks.map(risk => `
        <article class="official-writing-check-item" data-official-writing-risk-id="${escapeAppsHtml(risk.id)}">
            <strong>${escapeAppsHtml(risk.title)}<span>${escapeAppsHtml(risk.level)}</span></strong>
            <p>${escapeAppsHtml(risk.detail)}</p>
            <em>${escapeAppsHtml(risk.suggestion || '建议核对该处内容。')}</em>
        </article>
    `).join('') || '<div class="official-writing-empty-note">未识别明显规范风险</div>';
}

function renderOfficialWritingSuggestions() {
    const list = document.getElementById('official-writing-suggestion-list');
    const pending = officialWritingState.suggestions.filter(item => item.status !== 'accepted' && item.status !== 'rejected');
    setText('official-writing-suggestion-count', `${pending.length} 条待处理`);
    if (!list) return;
    list.innerHTML = officialWritingState.suggestions.map(suggestion => {
        // 流式生成中：展示“AI 生成中…”指示，隐藏操作按钮（避免对未完成文本执行接受/替换）。
        const streaming = !!suggestion.streaming;
        const statusLabel = streaming
            ? 'AI 生成中…'
            : (suggestion.status === 'accepted' ? '已接受' : suggestion.status === 'rejected' ? '已拒绝' : '待处理');
        const statusClass = streaming ? 'streaming' : (suggestion.status || 'pending');
        const actions = streaming ? '' : `
            <div class="official-writing-suggestion-actions">
                <button type="button" class="btn-secondary" data-suggestion-action="replace">替换选区</button>
                <button type="button" class="btn-secondary" data-suggestion-action="insert">插入下方</button>
                <button type="button" class="btn-secondary" data-suggestion-action="comment">作为批注</button>
                <button type="button" class="btn-secondary" data-suggestion-action="version">生成版本</button>
                <button type="button" class="btn-primary" data-suggestion-action="accept">接受</button>
                <button type="button" class="btn-secondary" data-suggestion-action="reject">拒绝</button>
            </div>`;
        return `
        <article class="official-writing-suggestion-item is-${escapeAppsHtml(suggestion.status || 'pending')}${streaming ? ' is-streaming' : ''}" data-suggestion-id="${escapeAppsHtml(suggestion.id)}">
            <div>
                <strong>${escapeAppsHtml(suggestion.title || '修改建议')}</strong>
                <span>${escapeAppsHtml(suggestion.type || '建议')}</span>
            </div>
            <div class="official-writing-suggestion-meta">
                <span class="official-writing-suggestion-status is-${escapeAppsHtml(statusClass)}">${escapeAppsHtml(statusLabel)}</span>
                <span>${escapeAppsHtml(formatVersionTime(suggestion.resolvedAt || suggestion.createdAt))}</span>
            </div>
            ${suggestion.original ? `<p class="official-writing-suggestion-original">${escapeAppsHtml(suggestion.original)}</p>` : ''}
            <p class="official-writing-suggestion-text">${escapeAppsHtml(suggestion.replacement || suggestion.detail || '')}</p>
            ${actions}
        </article>`;
    }).join('') || '<div class="official-writing-empty-note">暂无修改建议，可从顶部全文 AI 或选区工具生成。</div>';
}

function renderOfficialWritingReferences() {
    const list = document.getElementById('official-writing-reference-list');
    const matches = getOfficialWritingReferenceMatches();
    setText('official-writing-reference-count', `${matches.length} 处引用`);
    if (!list) return;
    list.innerHTML = matches.map(match => `
        <article class="official-writing-reference-item">
            <span>原文材料${match.kind === 'fuzzy' ? `（相近 ${Math.round((match.score || 0) * 100)}%）` : ''}</span>
            <p>${escapeAppsHtml(match.source)}</p>
            <strong>正文引用：${escapeAppsHtml(match.draft)}</strong>
        </article>
    `).join('') || '<div class="official-writing-empty-note">暂未识别到正文与原文材料的直接引用</div>';
}

function renderOfficialWritingMaterials() {
    const preview = document.getElementById('official-writing-material-preview');
    if (preview) preview.textContent = compactTextPreview(officialWritingState.source, 120) || '暂无材料';
    const outline = document.getElementById('official-writing-outline-list');
    if (outline) {
        const paragraphs = splitOfficialWritingParagraphs(officialWritingState.draft);
        outline.innerHTML = paragraphs.map((item, index) => `
            <button type="button" class="official-writing-outline-item" data-official-writing-jump="${item.start}" data-official-writing-target="draft" title="${escapeAppsHtml(item.text)}" data-full-text="${escapeAppsHtml(item.text)}">
                <span>${index + 1}</span>
                <strong>${escapeAppsHtml(compactTextPreview(item.text, 52))}</strong>
            </button>
        `).join('') || '<div class="official-writing-empty-note">正文生成后自动形成大纲</div>';
    }
    const materialCards = document.getElementById('official-writing-material-card-list');
    if (materialCards) {
        const segments = getOfficialWritingMaterialSegments();
        materialCards.innerHTML = segments.map(segment => `
            <article class="official-writing-material-card" data-material-id="${escapeAppsHtml(segment.id)}">
                <p>${escapeAppsHtml(compactTextPreview(segment.text, 82))}</p>
                <div>
                    <button type="button" data-material-action="insert">引用到正文</button>
                    <button type="button" data-material-action="basis">作为依据</button>
                    <button type="button" data-material-action="view">查看来源</button>
                </div>
            </article>
        `).join('') || '<div class="official-writing-empty-note">粘贴原文材料后可建立引用链</div>';
    }
    const history = document.getElementById('official-writing-history-list');
    if (history) {
        const saved = officialWritingState.versions.map(version => ({ ...version, kind: version.stage || '保存版本' }));
        const auto = (officialWritingState.autoSaves || []).map(version => ({ ...version, kind: '自动草稿' }));
        history.innerHTML = [...saved, ...auto].map(version => `
            <button type="button" class="official-writing-history-item" data-version-load="${escapeAppsHtml(version.id)}">
                <strong>${escapeAppsHtml(version.name || '未命名版本')}</strong>
                <span>${escapeAppsHtml(version.kind)} · ${escapeAppsHtml(formatVersionTime(version.createdAt))}</span>
            </button>
        `).join('') || '<div class="official-writing-empty-note">暂无历史稿件</div>';
    }
}

function renderOfficialWritingWorkspace() {
    syncOfficialWritingStateFromInputs();
    updateOfficialWritingSurfaceVisibility();
    resizeOfficialWritingDraftPage();
    renderOfficialWritingStats();
    renderOfficialWritingComments();
    renderOfficialWritingVersions();
    renderOfficialWritingCompliance();
    renderOfficialWritingSuggestions();
    renderOfficialWritingReferences();
    renderOfficialWritingMaterials();
    renderOfficialWritingProofread();
}

function resizeOfficialWritingDraftPage() {
    const editorStack = document.querySelector('.official-writing-draft-stack');
    const surface = getOfficialWritingSurface('draft');
    const panel = document.querySelector('.official-writing-panel');
    if (!editorStack || !surface || !panel) return;
    if (panel.dataset.writingViewMode !== 'document') {
        editorStack.style.height = '';
        return;
    }
    editorStack.style.height = 'auto';
    const minHeight = Number.parseFloat(getComputedStyle(editorStack).minHeight) || 0;
    editorStack.style.height = `${Math.max(minHeight, surface.scrollHeight + 168)}px`;
}

