// 公文工作台的恢复、预览、筛选及输入事务接线。
let officialWritingFilterTimer = null;
const officialWritingModalFocus = new Map();

function showOfficialWritingModal(id) {
    const modal = document.getElementById(id);
    if (!modal) return;
    if (modal.classList.contains('hidden')) officialWritingModalFocus.set(id, document.activeElement);
    modal.classList.remove('hidden'); modal.setAttribute('aria-hidden', 'false');
    window.setTimeout(() => modal.querySelector('button:not([disabled]), input, select, textarea')?.focus(), 0);
}

function hideOfficialWritingModal(id) {
    const modal = document.getElementById(id);
    if (!modal || modal.classList.contains('hidden')) return;
    modal.classList.add('hidden'); modal.setAttribute('aria-hidden', 'true');
    const previous = officialWritingModalFocus.get(id);
    if (previous?.isConnected) previous.focus?.();
    officialWritingModalFocus.delete(id);
}

function bindOfficialWritingProductEvents(panel) {
    bindOfficialWritingAttachmentEvents();
    const click = (id, fn) => document.getElementById(id)?.addEventListener('click', fn);
    click('official-writing-retry-save-btn', () => { void flushOfficialWritingSaves(); });
    click('official-writing-conflict-copy-btn', () => { void saveOfficialWritingConflictCopy(); });
    click('official-writing-conflict-compare-btn', () => { void compareOfficialWritingServerVersion(); });
    click('official-writing-conflict-copy-text-btn', () => { void copyAppsText(officialWritingState.draft).then(() => showToast('当前稿已复制')); });
    click('official-writing-undo-btn', () => applyOfficialWritingHistory('undo'));
    click('official-writing-redo-btn', () => applyOfficialWritingHistory('redo'));
    click('official-writing-stop-ai-btn', cancelOfficialWritingAiTask);
    click('official-writing-import-backup-btn', () => document.getElementById('official-writing-backup-input')?.click());
    document.getElementById('official-writing-backup-input')?.addEventListener('change', event => { void importOfficialWritingBackup(event.target.files?.[0]); event.target.value = ''; });
    click('official-writing-reference-check-btn', () => { void checkOfficialWritingReferenceSources(); });
    click('official-writing-clear-history-btn', () => { void clearOfficialWritingHistory(); });
    click('official-writing-result-close-btn', closeOfficialWritingResultPreview);
    click('official-writing-result-stop-btn', cancelOfficialWritingAiTask);
    click('official-writing-result-apply-btn', () => applySuggestionAction(officialWritingPreviewId, 'replace'));
    click('official-writing-result-copy-btn', () => { void copyAppsText(document.getElementById('official-writing-result-text')?.textContent || '').then(() => showToast('结果已复制')); });
    click('official-writing-export-close-btn', closeOfficialWritingExportPreview);
    click('official-writing-export-preview-btn', () => { void refreshOfficialWritingExportPreview(); });
    click('official-writing-export-confirm-btn', () => { void downloadOfficialWritingPreview(); });
    document.getElementById('official-writing-export-layout')?.addEventListener('change', () => { void refreshOfficialWritingExportPreview(); });
    const filter = () => {
        officialWritingUiState.libraryPage = 1;
        officialWritingUiState.libraryQuery = document.getElementById('official-writing-library-query')?.value || '';
        officialWritingUiState.libraryType = document.getElementById('official-writing-library-type')?.value || '';
        officialWritingUiState.librarySort = document.getElementById('official-writing-library-sort')?.value || 'updated';
        void loadOfficialWritingState();
    };
    document.getElementById('official-writing-library-query')?.addEventListener('input', () => { clearTimeout(officialWritingFilterTimer); officialWritingFilterTimer = setTimeout(filter, 300); });
    for (const id of ['official-writing-library-type', 'official-writing-library-sort']) document.getElementById(id)?.addEventListener('change', filter);
    for (const target of ['source', 'draft']) {
        const surface = getOfficialWritingSurface(target);
        surface?.setAttribute('contenteditable', 'plaintext-only');
        surface?.addEventListener('focus', () => beginOfficialWritingSurfaceEditing(target));
        surface?.addEventListener('beforeinput', handleOfficialWritingBeforeInput);
        surface?.addEventListener('compositionstart', handleOfficialWritingCompositionStart);
        surface?.addEventListener('compositionend', handleOfficialWritingCompositionEnd);
    }
    panel.addEventListener('click', event => {
        const viewSource = event.target.closest('[data-official-writing-reference-view]');
        if (viewSource) void checkOfficialWritingReferenceSources({ previewId: viewSource.dataset.officialWritingReferenceView });
        const remove = event.target.closest('[data-official-writing-reference-remove]');
        if (remove) removeOfficialWritingReference(remove.dataset.officialWritingReferenceRemove);
        if (event.target.closest('[data-official-writing-drawer-tab]')) event.target.closest('details')?.removeAttribute('open');
    });
    panel.addEventListener('keydown', event => {
        if (event.key === 'Tab') {
            const modal = ['official-writing-export-modal', 'official-writing-result-modal'].map(id => document.getElementById(id)).find(node => node && !node.classList.contains('hidden'));
            if (modal) {
                const items = [...modal.querySelectorAll('button:not([disabled]), input, select, textarea, iframe')].filter(node => node.getClientRects().length);
                const first = items[0], last = items[items.length - 1];
                if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
                else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
            }
        }
        if (event.key !== 'Escape') return;
        closeOfficialWritingResultPreview(); closeOfficialWritingExportPreview();
    });
    window.addEventListener('beforeunload', event => {
        if (!getActiveOfficialWritingDoc()?._loaded) return;
        syncOfficialWritingStateFromInputs({ immediate: true });
        const dirty = officialWritingLibrary.docs.some(doc => doc._loaded && (doc.manualTitle || !isOfficialWritingStateEmpty(doc.state))
            && computeOfficialWritingDocFingerprint(doc) !== doc._savedFingerprint);
        if (dirty) { event.preventDefault(); event.returnValue = ''; }
    });
    window.addEventListener('pagehide', () => { cancelOfficialWritingAiTask(); void flushOfficialWritingSaves(); });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') void flushOfficialWritingSaves(); });
}

window.Pivot.exposeModule('apps.officialWriting', { flush: flushOfficialWritingSaves, reset: resetOfficialWritingSession,
    suspend: () => { cancelOfficialWritingAiTask(); return flushOfficialWritingSaves(); } });
