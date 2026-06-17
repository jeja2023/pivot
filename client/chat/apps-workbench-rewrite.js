// ===== 流式改写 + 逐句对比接受 =====

// 把文本切成句子（按中文句末标点与换行），保留分隔符，便于重组。
function splitOfficialWritingSentences(text) {
    const result = [];
    const parts = String(text || '').split(/(?<=[。！？!?；;\n])/);
    parts.forEach(part => {
        const trimmed = part.trim();
        if (trimmed) result.push(trimmed);
    });
    return result.length ? result : (String(text || '').trim() ? [String(text).trim()] : []);
}

// 句子级 LCS 对齐，产出对比行：same / changed / removed / added。
function buildOfficialWritingSentenceDiff(originalText, rewrittenText) {
    const a = splitOfficialWritingSentences(originalText);
    const b = splitOfficialWritingSentences(rewrittenText);
    const n = a.length;
    const m = b.length;
    const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i -= 1) {
        for (let j = m - 1; j >= 0; j -= 1) {
            dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
    }
    const rows = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
        if (a[i] === b[j]) {
            rows.push({ type: 'same', original: a[i], rewritten: b[j] });
            i += 1; j += 1;
        } else if (dp[i + 1][j] >= dp[i][j + 1]) {
            // 配对为“改写”：原句 i 与新句 j 视为一对（尽量两两对应）。
            rows.push({ type: 'changed', original: a[i], rewritten: b[j] });
            i += 1; j += 1;
        } else {
            rows.push({ type: 'added', original: '', rewritten: b[j] });
            j += 1;
        }
    }
    while (i < n) { rows.push({ type: 'removed', original: a[i], rewritten: '' }); i += 1; }
    while (j < m) { rows.push({ type: 'added', original: '', rewritten: b[j] }); j += 1; }
    return rows;
}

let officialWritingDiffState = null;

async function runOfficialWritingStreamRewrite(selection) {
    if (officialWritingAiBusy) return;

    openOfficialWritingDiffModal(selection);
    setOfficialWritingDiffStreaming(true);
    setOfficialWritingAiBusy(true, 'AI 流式改写中…');
    try {
        const preview = document.getElementById('official-writing-diff-stream-preview');
        const result = await requestOfficialWritingAi(
            {
                mode: 'rewrite_stream',
                docType: getOfficialWritingDocType(),
                standard: getOfficialWritingStandard(),
                requirements: getOfficialWritingRequirements(),
                selection: { text: selection.text }
            },
            {
                stream: true,
                onDelta(full) {
                    if (preview) preview.textContent = full;
                }
            }
        );
        if (result == null) {
            closeOfficialWritingDiffModal();
            return;
        }
        const rewritten = String(result.content || '').trim();
        if (!rewritten) {
            showToast('AI 未返回有效内容，请重试', 'warning');
            closeOfficialWritingDiffModal();
            return;
        }
        const rows = buildOfficialWritingSentenceDiff(selection.text, rewritten).map((row, index) => ({
            ...row,
            id: `diff-${index}`,
            // 默认：改写/新增句默认接受新版，相同句保留，删除句默认接受删除。
            accepted: row.type !== 'removed'
        }));
        officialWritingDiffState = { selection, rows, rewritten };
        setOfficialWritingDiffStreaming(false);
        renderOfficialWritingDiffRows();
    } finally {
        setOfficialWritingAiBusy(false);
    }
}

function setOfficialWritingDiffStreaming(streaming) {
    document.getElementById('official-writing-diff-stream')?.classList.toggle('hidden', !streaming);
    document.getElementById('official-writing-diff-review')?.classList.toggle('hidden', streaming);
}

function openOfficialWritingDiffModal(selection) {
    officialWritingDiffState = { selection, rows: [], rewritten: '' };
    const modal = document.getElementById('official-writing-diff-modal');
    if (modal) {
        modal.classList.remove('hidden');
        modal.setAttribute('aria-hidden', 'false');
    }
    const preview = document.getElementById('official-writing-diff-stream-preview');
    if (preview) preview.textContent = '';
}

function closeOfficialWritingDiffModal() {
    const modal = document.getElementById('official-writing-diff-modal');
    if (modal) {
        modal.classList.add('hidden');
        modal.setAttribute('aria-hidden', 'true');
    }
    officialWritingDiffState = null;
}

function renderOfficialWritingDiffRows() {
    const list = document.getElementById('official-writing-diff-rows');
    if (!list || !officialWritingDiffState) return;
    const rows = officialWritingDiffState.rows;
    list.innerHTML = rows.map(row => {
        if (row.type === 'same') {
            return `<div class="official-writing-diff-pair is-same"><div class="official-writing-diff-cell"><p>${escapeAppsHtml(row.original)}</p></div></div>`;
        }
        const acceptedClass = row.accepted ? 'is-accepted' : 'is-rejected';
        const original = row.original
            ? `<div class="official-writing-diff-cell is-old"><span>原文</span><p>${escapeAppsHtml(row.original)}</p></div>`
            : '';
        const rewritten = row.rewritten
            ? `<div class="official-writing-diff-cell is-new"><span>改写</span><p>${escapeAppsHtml(row.rewritten)}</p></div>`
            : '';
        return `
            <div class="official-writing-diff-pair ${acceptedClass}" data-official-writing-diff-id="${escapeAppsHtml(row.id)}">
                ${original}${rewritten}
                <div class="official-writing-diff-pair-actions">
                    <button type="button" data-official-writing-diff-accept="${escapeAppsHtml(row.id)}" class="${row.accepted ? 'active' : ''}">接受改写</button>
                    <button type="button" data-official-writing-diff-reject="${escapeAppsHtml(row.id)}" class="${row.accepted ? '' : 'active'}">保留原文</button>
                </div>
            </div>`;
    }).join('') || '<div class="official-writing-empty-note">无差异</div>';
    const changed = rows.filter(r => r.type !== 'same').length;
    const accepted = rows.filter(r => r.type !== 'same' && r.accepted).length;
    setText('official-writing-diff-stat', `${changed} 处差异，已接受 ${accepted} 处`);
}

function setOfficialWritingDiffRowAccepted(rowId, accepted) {
    if (!officialWritingDiffState) return;
    const row = officialWritingDiffState.rows.find(item => item.id === rowId);
    if (!row || row.type === 'same') return;
    row.accepted = accepted;
    renderOfficialWritingDiffRows();
}

// 根据逐句接受状态拼装最终文本：same 保留；changed 接受用改写否则原文；added 接受才纳入；removed 接受即删除（不纳入原文）。
function assembleOfficialWritingDiffResult() {
    if (!officialWritingDiffState) return '';
    const pieces = [];
    officialWritingDiffState.rows.forEach(row => {
        if (row.type === 'same') pieces.push(row.original);
        else if (row.type === 'changed') pieces.push(row.accepted ? row.rewritten : row.original);
        else if (row.type === 'added') { if (row.accepted) pieces.push(row.rewritten); }
        else if (row.type === 'removed') { if (!row.accepted) pieces.push(row.original); }
    });
    return pieces.join('');
}

function applyOfficialWritingDiffResult() {
    if (!officialWritingDiffState) return;
    const { selection } = officialWritingDiffState;
    const finalText = assembleOfficialWritingDiffResult();
    const textarea = getOfficialWritingTextarea(selection.target || 'draft');
    replaceTextareaRange(textarea, selection.start, selection.end, finalText);
    renderOfficialWritingWorkspace();
    closeOfficialWritingDiffModal();
    showToast('已按逐句选择应用改写');
}

function jumpOfficialWritingRange(target, start, end = start) {
    applyOfficialWritingViewMode(target === 'source' ? 'compare' : officialWritingUiState.viewMode);
    const textarea = getOfficialWritingTextarea(target);
    setTextareaSelection(textarea, start, end);
}

function hasOfficialWritingDirtyState() {
    return Boolean(
        String(officialWritingState.source || '').trim() ||
        String(officialWritingState.draft || '').trim() ||
        (officialWritingState.comments || []).length ||
        (officialWritingState.versions || []).length ||
        (officialWritingState.suggestions || []).length ||
        (officialWritingState.autoSaves || []).length
    );
}

function syncOfficialWritingSourceToDraft() {
    pushOfficialWritingUndoSnapshot();
    const source = document.getElementById('official-writing-source')?.value || '';
    setOfficialWritingTextareaValue('draft', source);
    syncOfficialWritingStateFromInputs();
    renderOfficialWritingWorkspace();
}

function resetOfficialWritingForm() {
    if (hasOfficialWritingDirtyState() && !window.confirm('确认清空当前公文工作区？这会移除原文、正文、批注、版本、建议和自动草稿。')) {
        return;
    }
    const ids = [
        'official-writing-requirements',
        'official-writing-comment-anchor',
        'official-writing-comment-text',
        'official-writing-version-name'
    ];
    setOfficialWritingTextareaValue('source', '');
    setOfficialWritingTextareaValue('draft', '');
    ids.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
    const type = document.getElementById('official-writing-type');
    const standard = document.getElementById('official-writing-standard');
    const materialSource = document.getElementById('official-writing-material-source');
    if (type) type.value = '通知';
    if (standard) standard.value = '通用公文规范';
    if (materialSource) materialSource.value = '粘贴材料';
    officialWritingState = createOfficialWritingState();
    officialWritingUiState.lastSelection = null;
    officialWritingUndoStack.length = 0;
    officialWritingRedoStack.length = 0;
    updateOfficialWritingUndoRedoButtons();
    saveOfficialWritingState();
    setOfficialWritingMaterialTab('materials');
    hydrateOfficialWritingMetaForm();
    applyOfficialWritingViewMode('document');
    openOfficialWritingDrawer('suggestions');
    renderOfficialWritingWorkspace();
    renderOfficialWritingDocList();
}

function runOfficialWritingMode(mode) {
    const nextMode = normalizeOfficialWritingMode(mode);
    officialWritingState.mode = nextMode;
    syncOfficialWritingStateFromInputs();
    if (nextMode === 'review') {
        // 规范检查（本地、规范库驱动）始终刷新展示，同时调用 AI 生成审校建议。
        renderOfficialWritingWorkspace();
        const risks = getOfficialWritingComplianceRisks();
        if (risks.length) showToast(`本地规范检查发现 ${risks.length} 项风险，AI 审校进行中…`);
    }
    generateOfficialWritingSuggestion(nextMode);
}

