// 正文编辑与选区：编辑过程中保持 DOM 稳定。
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
    if (index === lines.findIndex(value => String(value || '').trim())) return { type: 'title', text };
    if (isOfficialWritingSignatureLine(text, index, lines)) return { type: 'signature', text };
    const level = officialWritingFormat.headingLevel(text);
    if (level) return { type: 'heading' + level, text };
    if (/^附件[：:]/.test(text)) return { type: 'attachment-note', text };
    if (isOfficialWritingFooterLabelLine(text)) return { type: 'label', text };
    if (isOfficialWritingRecipientLine(text)) return { type: 'recipient', text };
    return { type: 'paragraph', text };
}

function renderOfficialWritingSurface(target = 'draft', { force = false } = {}) {
    const surface = getOfficialWritingSurface(target);
    const textarea = getOfficialWritingRawEditor(target);
    if (!surface || !textarea) return;
    if (!force && (surface === document.activeElement || surface.dataset.composing === '1')) return;
    if (surface.dataset.editing === '1') { surface.textContent = textarea.value || ''; ensureOfficialWritingCaretTail(surface); return; }
    const value = getOfficialWritingSurfaceText(textarea.value || '');
    const lines = getOfficialWritingParagraphLines(value);
    const activeClass = surface.classList.contains('is-active') ? ' is-active' : '';
    const hiddenClass = surface.classList.contains('is-document-hidden') ? ' is-document-hidden' : '';
    surface.className = `official-writing-document-surface official-writing-editable-surface official-writing-surface-${target}${activeClass}${hiddenClass}`;
    PivotSafeHtml.setHtml(surface, '');
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
            const nextIndex = lines.findIndex((value, position) => position > index && String(value || '').trim());
            const nextType = nextIndex === -1 ? '' : classifyOfficialWritingLine(lines[nextIndex], nextIndex, lines).type;
            if (previousContentType === 'title' || nextType === 'attachment-note' || nextType === 'signature') gap.classList.add('official-writing-surface-format-gap');
            gap.dataset.textStart = String(lineStart);
            gap.dataset.textEnd = String(lineEnd);
            gap.appendChild(document.createElement('br'));
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
        textSpan.textContent = rawLine;
        if (kind.type === 'title' && rawLine === rawLine.trim()) {
            textSpan.replaceChildren();
            const custom = target === 'draft' ? officialWritingState.meta?.titleBreaks || '' : '';
            const title = custom.replace(/\s/g, '') === rawLine.replace(/\s/g, '') ? custom : rawLine;
            let titleLines;
            try { titleLines = officialWritingFormat.arrangeTitle(title); } catch (_) { titleLines = [rawLine]; }
            for (const text of titleLines) {
                const titleLine = document.createElement('span'); titleLine.className = 'official-writing-title-line'; titleLine.textContent = text;
                textSpan.appendChild(titleLine);
            }
        }
        if (kind.type === 'signature') {
            block.dataset.signatureKind = isOfficialWritingDateLine(rawLine) ? 'date' : 'organization';
            if (block.dataset.signatureKind === 'organization') applyOfficialWritingSignatureBox(block, lines, surface);
        }
        block.appendChild(textSpan);
        surface.appendChild(block);
        if (kind.type !== 'minor-heading' && kind.type !== 'major-heading') {
            paragraphIndex += 1;
        }
        previousContentType = kind.type;
    });
}

function applyOfficialWritingSignatureBox(block, lines, surface) {
    const date = lines.findLast(line => isOfficialWritingDateLine(line)) || '';
    const canvas = document.createElement('canvas'), context = canvas.getContext('2d');
    let width = 0;
    for (const segment of officialWritingFormat.splitScripts(date)) {
        context.font = `16pt "${segment.ascii ? 'Times New Roman' : '方正仿宋_GBK'}"`;
        width += context.measureText(segment.text).width;
    }
    const pitch = officialWritingFormat.CHAR_PITCH_PT * 4 / 3;
    const content = surface.clientWidth || 28 * pitch;
    const center = content - 4 * pitch - width / 2;
    const half = Math.max(pitch, Math.min(center, content - center));
    block.style.marginLeft = `${Math.max(0, center - half)}px`;
    block.style.marginRight = `${Math.max(0, content - center - half)}px`;
}

function renderOfficialWritingSurfaces({ force = false } = {}) {
    renderOfficialWritingSurface('source', { force });
    renderOfficialWritingSurface('draft', { force });
}

function syncOfficialWritingSurfaceToTextarea(target = 'draft') {
    const surface = getOfficialWritingSurface(target), textarea = getOfficialWritingRawEditor(target);
    if (!surface || !textarea || surface.dataset.editing !== '1') return;
    textarea.value = readOfficialWritingEditableText(surface);
}

function handleOfficialWritingSurfaceInput(event) {
    const target = event.currentTarget?.dataset?.officialWritingSurface || 'draft';
    syncOfficialWritingSurfaceToTextarea(target);
    if (event.isComposing || event.currentTarget?.dataset?.composing === '1') return;
    officialWritingState[target] = getOfficialWritingRawEditor(target)?.value || '';
    scheduleOfficialWritingAnalysis();
    updateOfficialWritingUndoRedoButtons();
    renderOfficialWritingSaveStatus();
}

function handleOfficialWritingSurfaceBlur(event) {
    const target = event.currentTarget?.dataset?.officialWritingSurface || 'draft';
    if (event.currentTarget?.dataset?.composing === '1') return;
    syncOfficialWritingSurfaceToTextarea(target);
    delete event.currentTarget.dataset.editing;
    renderOfficialWritingSurface(target, { force: true });
    syncOfficialWritingStateFromInputs();
    officialWritingHistoryGroup = { target: '', at: 0 };
}

function handleOfficialWritingSurfacePaste(event) {
    event.preventDefault();
    const text = event.clipboardData?.getData('text/plain') || '';
    pushOfficialWritingUndoSnapshot();
    insertOfficialWritingSurfaceText(event.currentTarget, text);
}

function handleOfficialWritingSurfaceKeydown(event) {
    if (event.isComposing || event.currentTarget?.dataset?.composing === '1') return;
    if ((event.ctrlKey || event.metaKey) && ['z', 'y'].includes(event.key.toLowerCase())) {
        event.preventDefault();
        applyOfficialWritingHistory(event.key.toLowerCase() === 'y' || event.shiftKey ? 'redo' : 'undo');
    } else if (event.key === 'Tab' || event.key === 'Enter') {
        event.preventDefault();
        pushOfficialWritingUndoSnapshot();
        insertOfficialWritingSurfaceText(event.currentTarget, event.key === 'Tab' ? '    ' : '\n');
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
    return String(text || '').replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ');
}

function getOfficialWritingSurfaceSelection(target) {
    const surface = getOfficialWritingSurface(target), selection = window.getSelection?.();
    if (!surface || !selection || !selection.rangeCount) return null;
    const range = selection.getRangeAt(0);
    if (!surface.contains(range.startContainer) || !surface.contains(range.endContainer)) return null;
    if (surface.dataset.editing === '1') {
        const offset = (node, point) => {
            const before = range.cloneRange(); before.selectNodeContents(surface); before.setEnd(node, point);
            const box = document.createElement('div'); box.appendChild(before.cloneContents());
            return readOfficialWritingEditableText(box).length;
        };
        const start = offset(range.startContainer, range.startOffset), end = offset(range.endContainer, range.endOffset);
        return { target, start, end, text: readOfficialWritingEditableText(surface).slice(start, end) };
    }
    const start = getOfficialWritingOffsetFromSurfacePoint(surface, range.startContainer, range.startOffset);
    const end = getOfficialWritingOffsetFromSurfacePoint(surface, range.endContainer, range.endOffset);
    if (start === null || end === null) return null;
    return { target, start, end, text: getOfficialWritingRawEditor(target)?.value.slice(start, end) || '' };
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
    if (surface.dataset.editing === '1') return findOfficialWritingTextPoint(surface, offset);
    const lines = Array.from(surface.querySelectorAll('[data-text-start]'));
    for (const line of lines) {
        if (offset <= Number(line.dataset.textEnd)) return findOfficialWritingTextPoint(line, Math.max(0, offset - Number(line.dataset.textStart)));
    }
    const last = lines[lines.length - 1];
    return last ? findOfficialWritingTextPoint(last, last.textContent.length) : { node: surface, offset: 0 };
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
    beginOfficialWritingSurfaceEditing(target, { start: safeStart, end: safeEnd });
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

function replaceTextareaRange(textarea, start, end, replacement, { skipSnapshot } = {}) {
    if (!textarea) return;
    if (!skipSnapshot) pushOfficialWritingUndoSnapshot();
    const target = getOfficialWritingTargetFromTextarea(textarea);
    const value = textarea.value.slice(0, start) + replacement + textarea.value.slice(end);
    setOfficialWritingTextareaValue(target, value);
    syncOfficialWritingStateFromInputs();
    setTextareaSelection(textarea, start, start + replacement.length);
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


// 兼容 plaintext-only 编辑和浏览器粘贴产生的 div/p/br，不从排版预览反推正文。
function readOfficialWritingEditableText(surface) {
    function children(parent) {
        let result = '', previousBlock = false;
        Array.from(parent.childNodes).forEach((node, index) => {
            if (node.nodeType === Node.ELEMENT_NODE && node.dataset.editSentinel === '1') return;
            const block = node.nodeType === Node.ELEMENT_NODE && /^(DIV|P|LI)$/.test(node.nodeName);
            let value = node.nodeType === Node.TEXT_NODE ? node.nodeValue : node.nodeName === 'BR' ? '\n' : children(node);
            if (block && node.childNodes.length === 1 && node.firstChild.nodeName === 'BR') value = '';
            if (index && (block || previousBlock) && (previousBlock || !result.endsWith('\n'))) result += '\n';
            result += value;
            previousBlock = block;
        });
        return result;
    }
    return normalizeOfficialWritingSurfaceText(children(surface));
}

function beginOfficialWritingSurfaceEditing(target, selected = null) {
    const surface = getOfficialWritingSurface(target), textarea = getOfficialWritingRawEditor(target);
    if (!surface || !textarea || surface.dataset.editing === '1') return;
    const selection = selected || getOfficialWritingSurfaceSelection(target);
    surface.dataset.editing = '1';
    surface.textContent = textarea.value || '';
    ensureOfficialWritingCaretTail(surface);
    delete surface.dataset.empty;
    if (selection) setOfficialWritingSurfaceSelection(target, selection.start, selection.end);
}

function handleOfficialWritingBeforeInput(event) {
    const target = event.currentTarget.dataset.officialWritingSurface || 'draft';
    beginOfficialWritingSurfaceEditing(target);
    if (event.currentTarget.dataset.composing === '1') return;
    pushOfficialWritingUndoSnapshot({ typing: event.inputType === 'insertText' || event.inputType === 'deleteContentBackward', target });
}

function handleOfficialWritingCompositionStart(event) {
    pushOfficialWritingUndoSnapshot();
    event.currentTarget.dataset.composing = '1';
}

function handleOfficialWritingCompositionEnd(event) {
    delete event.currentTarget.dataset.composing;
    handleOfficialWritingSurfaceInput(event);
}

function insertOfficialWritingSurfaceText(surface, text) {
    const target = surface.dataset.officialWritingSurface || 'draft';
    const selection = getOfficialWritingSurfaceSelection(target);
    const editor = getOfficialWritingTextarea(target);
    const start = selection?.start ?? editor.value.length;
    const end = selection?.end ?? start;
    const range = window.getSelection()?.rangeCount ? window.getSelection().getRangeAt(0) : null;
    if (range && surface.contains(range.commonAncestorContainer)) {
        range.deleteContents();
        const node = document.createTextNode(normalizeOfficialWritingSurfaceText(text));
        range.insertNode(node);
        ensureOfficialWritingCaretTail(surface);
        range.setStart(node, node.length); range.collapse(true);
        window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
    } else {
        surface.textContent = editor.value.slice(0, start) + text + editor.value.slice(end);
        setOfficialWritingSurfaceSelection(target, start + text.length);
    }
    handleOfficialWritingSurfaceInput({ currentTarget: surface });
}

function ensureOfficialWritingCaretTail(surface) {
    if (surface.textContent.endsWith('\n') && !surface.querySelector('[data-edit-sentinel]')) {
        const tail = document.createElement('br');
        tail.dataset.editSentinel = '1';
        surface.appendChild(tail);
    }
}
