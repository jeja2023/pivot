// 用户输入、AI 采纳、模板和版本恢复共用可撤销的文本事务；组合输入只提交一个事务。
let officialWritingHistoryApplying = false;
let officialWritingHistoryGroup = { target: '', at: 0 };

function officialWritingTextSnapshot() {
    const selection = getCurrentOfficialWritingSelection();
    return { source: getOfficialWritingTextarea('source')?.value || '', draft: getOfficialWritingTextarea('draft')?.value || '', selection,
        references: structuredClone(officialWritingState.references || []) };
}

function pushOfficialWritingUndoSnapshot({ typing = false, target = '' } = {}) {
    if (officialWritingHistoryApplying) return;
    const now = Date.now();
    if (typing && officialWritingHistoryGroup.target === target && now - officialWritingHistoryGroup.at < 800) {
        officialWritingHistoryGroup.at = now;
        return;
    }
    const snapshot = officialWritingTextSnapshot();
    const previous = officialWritingUndoStack[officialWritingUndoStack.length - 1];
    if (!previous || previous.source !== snapshot.source || previous.draft !== snapshot.draft) officialWritingUndoStack.push(snapshot);
    if (officialWritingUndoStack.length > OFFICIAL_WRITING_HISTORY_LIMIT) officialWritingUndoStack.shift();
    while (officialWritingUndoStack.length > 1 && officialWritingDocument.bytes(officialWritingUndoStack) > 4 * 1024 * 1024) officialWritingUndoStack.shift();
    officialWritingRedoStack.length = 0;
    officialWritingHistoryGroup = { target: typing ? target : '', at: now };
    updateOfficialWritingUndoRedoButtons();
}

function updateOfficialWritingUndoRedoButtons() {
    const undo = document.getElementById('official-writing-undo-btn');
    const redo = document.getElementById('official-writing-redo-btn');
    if (undo) undo.disabled = !officialWritingUndoStack.length;
    if (redo) redo.disabled = !officialWritingRedoStack.length;
}

function applyOfficialWritingHistory(direction) {
    const from = direction === 'redo' ? officialWritingRedoStack : officialWritingUndoStack;
    const to = direction === 'redo' ? officialWritingUndoStack : officialWritingRedoStack;
    if (!from.length) return;
    const current = officialWritingTextSnapshot();
    const snapshot = from.pop();
    to.push(current);
    officialWritingHistoryApplying = true;
    try {
        setOfficialWritingTextareaValue('source', snapshot.source);
        setOfficialWritingTextareaValue('draft', snapshot.draft);
        officialWritingState.references = structuredClone(snapshot.references || []);
        syncOfficialWritingStateFromInputs();
        renderOfficialWritingWorkspace();
        if (snapshot.selection) setTextareaSelection(getOfficialWritingTextarea(snapshot.selection.target), snapshot.selection.start, snapshot.selection.end);
    } finally {
        officialWritingHistoryApplying = false;
        officialWritingHistoryGroup = { target: '', at: 0 };
        updateOfficialWritingUndoRedoButtons();
    }
}

function recordOfficialWritingAutoSave({ force = false } = {}) {
    const draft = String(officialWritingState.draft || '');
    if (!draft.trim()) return;
    const last = officialWritingState.autoSaves?.[0];
    if (last?.draft === draft) return;
    if (!force && last && Date.now() - Date.parse(last.createdAt) < 30000) return;
    const entry = { id: `autosave-${Date.now()}`, name: `${getOfficialWritingDocType()}自动草稿`,
        draft, source: officialWritingState.source, createdAt: new Date().toISOString() };
    const compact = officialWritingDocument.normalize({ ...officialWritingState, autoSaves: [entry, ...(officialWritingState.autoSaves || [])] });
    officialWritingState.autoSaves = compact.autoSaves;
    officialWritingState.versions = compact.versions;
    officialWritingState.materialVersions = compact.materialVersions;
}

function resolveOfficialWritingVersionSource(version) {
    return typeof version?.source === 'string' ? version.source : officialWritingState.materialVersions?.[version?.sourceRef] || '';
}

async function clearOfficialWritingHistory() {
    if (!await window.Pivot.legacy.showConfirm?.('清理历史版本', '保留当前正文和材料，清理全部手动版本与自动草稿？')) return;
    officialWritingState.versions = [];
    officialWritingState.autoSaves = [];
    officialWritingState.materialVersions = {};
    saveOfficialWritingState({ immediate: true });
    renderOfficialWritingVersions();
    showToast('历史版本已清理，当前正文与材料已保留');
}
