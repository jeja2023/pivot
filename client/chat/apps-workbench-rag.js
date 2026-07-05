// ===== 知识库检索接入 =====

// 缓存知识库最近一次检索结果，供插入和引用操作复用。
const officialWritingRagResults = { history: [] };
let officialWritingRagCollectionsLoaded = false;

async function ensureOfficialWritingRagCollections() {
    if (officialWritingRagCollectionsLoaded) return;
    if (typeof window.loadKnowledgeCollections !== 'function') return;
    let collections = [];
    try {
        collections = await window.loadKnowledgeCollections();
    } catch (e) {
        // 加载失败时保持标记为 false，便于后续调用重试。
        return;
    }
    if (!Array.isArray(collections)) return;
    // 仅在 fetch 成功后标记已加载，失败后仍可重试。
    officialWritingRagCollectionsLoaded = true;
    ['official-writing-kb-history-collection'].forEach(id => {
        const select = document.getElementById(id);
        if (!select) return;
        const current = select.value;
        const options = ['<option value="">全部专题库</option>']
            .concat(collections.map(c => `<option value="${escapeAppsHtml(String(c.id))}">${escapeAppsHtml(c.name || ('专题库 ' + c.id))}</option>`));
        PivotSafeHtml.setHtml(select, options.join(''));
        if (current) select.value = current;
    });
}

function renderOfficialWritingRagResults(scopeKey) {
    const list = document.getElementById(`official-writing-kb-${scopeKey}-results`);
    if (!list) return;
    const matches = officialWritingRagResults[scopeKey] || [];
    PivotSafeHtml.setHtml(list, matches.map((match, index) => `
        <article class="official-writing-kb-result">
            <div class="official-writing-kb-result-head">
                <span>${escapeAppsHtml(match.source || '知识库')}</span>
                <em>相关度 ${Math.round((match.score || 0) * 100)}%</em>
            </div>
            <p>${escapeAppsHtml(compactTextPreview(match.text, 140))}</p>
            <div class="official-writing-kb-result-actions">
                <button type="button" data-official-writing-rag-insert="${index}" data-official-writing-rag-scope="${escapeAppsHtml(scopeKey)}">引用到正文</button>
                <button type="button" data-official-writing-rag-ref="${index}" data-official-writing-rag-scope="${escapeAppsHtml(scopeKey)}">加入AI依据</button>
            </div>
        </article>
    `).join('') || '<div class="official-writing-empty-note">输入关键词后点击“检索”，从知识库查找参考资料。</div>');
}

async function runOfficialWritingRagSearch(scopeKey) {
    const query = document.getElementById(`official-writing-kb-${scopeKey}-query`)?.value.trim() || '';
    if (!query) {
        showToast('请输入检索关键词', 'warning');
        return;
    }
    if (typeof apiFetch !== 'function') {
        showToast('当前环境不支持知识库检索', 'error');
        return;
    }
    const button = document.getElementById(`official-writing-kb-${scopeKey}-search-btn`);
    const collectionId = document.getElementById(`official-writing-kb-${scopeKey}-collection`)?.value || '';
    const ragScope = collectionId ? { collectionId: Number(collectionId) } : {};
    if (button) {
        button.disabled = true;
        button.textContent = '检索中…';
    }
    try {
        const res = await apiFetch(`${API_BASE}/rag/debug-query`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query, ragScope, topK: 6, scoreThreshold: 0.3 })
        });
        if (!res.ok) {
            const data = await res.clone().json().catch(() => ({}));
            showToast(data?.error?.message || `检索失败（${res.status}）`, 'error');
            return;
        }
        const data = await res.json();
        officialWritingRagResults[scopeKey] = Array.isArray(data?.matches) ? data.matches : [];
        renderOfficialWritingRagResults(scopeKey);
        if (!officialWritingRagResults[scopeKey].length) {
            showToast('未检索到相关内容，可调整关键词或专题库范围');
        }
    } catch (e) {
        showToast('知识库检索异常，请稍后重试', 'error');
    } finally {
        if (button) {
            button.disabled = false;
            button.textContent = '检索';
        }
    }
}

function findOfficialWritingRagMatch(index, scopeKey) {
    const key = scopeKey || 'history';
    return (officialWritingRagResults[key] || officialWritingRagResults.history || [])[index];
}

function insertOfficialWritingRagMatch(index, scopeKey) {
    const match = findOfficialWritingRagMatch(index, scopeKey);
    if (!match) return;
    const draft = getOfficialWritingTextarea('draft');
    const text = String(match.text || '').trim();
    if (!text) return;
    const insert = `\n\n据${match.source ? `《${match.source}》` : '相关材料'}，${text}`;
    const start = getOfficialWritingInsertionPoint('draft');
    replaceTextareaRange(draft, start, start, insert);
    renderOfficialWritingWorkspace();
    showToast('已引用到正文');
}

function appendOfficialWritingReferenceToMaterials(match) {
    const text = String(match?.text || '').trim();
    if (!text) return 'empty';
    const sourceLabel = String(match?.source || '知识库').trim() || '知识库';
    const block = `【知识库引用：${sourceLabel}】\n${text}`;
    const materialEditorCard = document.getElementById('official-writing-material-editor-card');
    const materialEditor = document.getElementById('official-writing-material-editor');
    const editorOpen = Boolean(materialEditorCard && !materialEditorCard.classList.contains('hidden'));
    const current = String((editorOpen ? materialEditor?.value : '') || getOfficialWritingTextarea('source')?.value || officialWritingState.source || '').trim();
    if (current.includes(text)) return 'exists';
    const next = [current, block].filter(Boolean).join('\n\n');
    pushOfficialWritingUndoSnapshot();
    setOfficialWritingTextareaValue('source', next);
    officialWritingState.source = next;
    setOfficialWritingMaterialTab('materials');
    syncOfficialWritingStateFromInputs();
    saveOfficialWritingState();
    renderOfficialWritingWorkspace();
    syncOfficialWritingMaterialEditor(next, { force: true });
    return 'added';
}

function referenceOfficialWritingRagMatch(index, scopeKey) {
    const match = findOfficialWritingRagMatch(index, scopeKey);
    if (!match) return;
    const status = appendOfficialWritingReferenceToMaterials(match);
    if (status === 'empty') return;
    const sourceLabel = String(match.source || '知识库').trim() || '知识库';
    appendOfficialWritingRequirement(`优先参考本篇材料中的“知识库引用：${sourceLabel}”`, { silent: true });
    showToast(status === 'exists' ? '该知识库内容已在本篇材料中，AI 会自动参考' : '已加入本篇材料，AI 会自动参考');
}

function appendOfficialWritingRequirement(text, options = {}) {
    const input = document.getElementById('official-writing-requirements');
    if (!input) return;
    const value = input.value.trim();
    input.value = value ? `${value}；${text}` : text;
    renderOfficialWritingWorkspace();
    if (!options.silent) showToast('已加入 AI 指令');
}

function applyOfficialWritingTemplate(templateId) {
    const template = OFFICIAL_WRITING_TEMPLATES[templateId];
    if (!template) return;
    pushOfficialWritingUndoSnapshot();
    const type = document.getElementById('official-writing-type');
    const draft = getOfficialWritingTextarea('draft');
    if (type) type.value = template.type;
    const currentDraft = draft?.value || '';
    setOfficialWritingTextareaValue('draft', currentDraft.trim() ? `${currentDraft.trim()}\n\n${template.text}` : template.text);
    syncOfficialWritingStateFromInputs();
    applyOfficialWritingViewMode('document');
    renderOfficialWritingWorkspace();
    showToast('模板已加入正文稿');
}

async function importOfficialWritingMaterialFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    const chunks = [];
    for (const file of files) {
        try {
            const text = await file.text();
            const clean = String(text || '').trim();
            if (clean) chunks.push(`【${file.name || '素材'}】\n${clean}`);
        } catch (e) {
            // 单个文件读取失败不阻断其他素材导入。
        }
    }
    if (!chunks.length) {
        showToast('未读取到可用文本，请上传 TXT、Markdown、CSV 或 JSON 等文本文件', 'warning');
        return;
    }
    pushOfficialWritingUndoSnapshot();
    const materialEditorCard = document.getElementById('official-writing-material-editor-card');
    const materialEditor = document.getElementById('official-writing-material-editor');
    const editorOpen = Boolean(materialEditorCard && !materialEditorCard.classList.contains('hidden'));
    const current = String((editorOpen ? materialEditor?.value : '') || getOfficialWritingTextarea('source')?.value || officialWritingState.source || '').trim();
    const next = [current, ...chunks].filter(Boolean).join('\n\n');
    setOfficialWritingTextareaValue('source', next);
    officialWritingState.source = next;
    setOfficialWritingMaterialTab('materials');
    syncOfficialWritingStateFromInputs();
    saveOfficialWritingState();
    renderOfficialWritingWorkspace();
    syncOfficialWritingMaterialEditor(next, { force: true });
    showToast(`已导入 ${chunks.length} 个本篇材料`);
}
function focusOfficialWritingSource() {
    closeOfficialWritingMaterialModal();
    applyOfficialWritingViewMode('compare');
    window.setTimeout(() => getOfficialWritingSurface('source')?.focus(), 0);
}

function handleOfficialWritingMaterialAction(materialId, action) {
    const segment = getOfficialWritingMaterialSegments().find(item => item.id === materialId);
    if (!segment) return;
    const draft = getOfficialWritingTextarea('draft');
    if (action === 'insert') {
        const insert = `\n\n据材料显示，${segment.text}`;
        const start = getOfficialWritingInsertionPoint('draft');
        replaceTextareaRange(draft, start, start, insert);
        showToast('已引用到正文');
    } else if (action === 'basis') {
        appendOfficialWritingRequirement(`将材料“${compactTextPreview(segment.text, 30)}”作为事实依据`);
    } else if (action === 'view') {
        closeOfficialWritingMaterialModal();
        applyOfficialWritingViewMode('compare');
        const source = getOfficialWritingTextarea('source');
        const index = source?.value.indexOf(segment.text) ?? -1;
        if (index >= 0) setTextareaSelection(source, index, index + segment.text.length);
        window.setTimeout(() => getOfficialWritingSurface('source')?.focus(), 0);
    }
    renderOfficialWritingWorkspace();
}

function handleOfficialWritingSelectionChange() {
    const selection = rememberOfficialWritingSelection();
    const toolbar = document.getElementById('official-writing-selection-toolbar');
    if (!toolbar) return;
    const hasSelection = Boolean(selection.text.trim());
    toolbar.classList.toggle('hidden', !hasSelection);
    toolbar.setAttribute('aria-hidden', hasSelection ? 'false' : 'true');
}

function handleOfficialWritingRiskClick(riskId) {
    const risk = getOfficialWritingComplianceRisks().find(item => item.id === riskId);
    if (!risk) return;
    jumpOfficialWritingRange('draft', risk.start, risk.end);
}

function bindAppsWorkbenchEvents() {
    const panel = document.getElementById('apps-workbench-modal');
    if (!panel || panel.dataset.appsBound === '1') return;
    panel.dataset.appsBound = '1';
    document.getElementById('apps-back-btn')?.addEventListener('click', showAppsHome);
    document.getElementById('apps-modal-close')?.addEventListener('click', () => window.closeAppsWorkbench?.());
    document.getElementById('official-writing-toggle-left-btn')?.addEventListener('click', () => {
        toggleOfficialWritingLeftRail();
        closeOfficialWritingCommandMenu();
    });
    document.getElementById('official-writing-toggle-right-btn')?.addEventListener('click', () => {
        toggleOfficialWritingDrawer();
        closeOfficialWritingCommandMenu();
    });
    document.getElementById('official-writing-open-draft-modal-btn')?.addEventListener('click', () => {
        openOfficialWritingDraftDialog();
        closeOfficialWritingCommandMenu();
    });
    document.getElementById('official-writing-draft-form')?.addEventListener('submit', submitOfficialWritingDraftDialog);
    document.getElementById('official-writing-draft-cancel-btn')?.addEventListener('click', closeOfficialWritingDraftDialog);
    document.getElementById('official-writing-draft-modal')?.addEventListener('click', event => {
        if (event.target?.id === 'official-writing-draft-modal') closeOfficialWritingDraftDialog();
    });
    const draftInstruction = document.getElementById('official-writing-draft-instruction');
    draftInstruction?.addEventListener('input', () => setOfficialWritingDraftDialogError(''));
    draftInstruction?.addEventListener('focus', () => {
        const initialHint = draftInstruction.dataset.officialWritingInitialHint || '';
        const shouldClear = draftInstruction.dataset.officialWritingClearOnFocus === 'true';
        if (shouldClear && initialHint && draftInstruction.value.trim() === initialHint.trim()) {
            draftInstruction.value = '';
            draftInstruction.dataset.officialWritingClearOnFocus = 'false';
        }
        draftInstruction.dataset.officialWritingFocusPlaceholder = draftInstruction.placeholder || draftInstruction.dataset.officialWritingDefaultPlaceholder || '';
        draftInstruction.placeholder = '';
        setOfficialWritingDraftDialogError('');
    });
    draftInstruction?.addEventListener('blur', () => {
        if (!draftInstruction.value.trim()) {
            draftInstruction.placeholder = draftInstruction.dataset.officialWritingInitialHint
                || draftInstruction.dataset.officialWritingFocusPlaceholder
                || draftInstruction.dataset.officialWritingDefaultPlaceholder
                || '';
        }
    });
    document.getElementById('official-writing-review-suggestions-btn')?.addEventListener('click', () => {
        handleOfficialWritingReviewSuggestions();
        closeOfficialWritingCommandMenu();
    });
    document.getElementById('official-writing-drawer-close-btn')?.addEventListener('click', closeOfficialWritingDrawer);
    document.getElementById('official-writing-material-close-btn')?.addEventListener('click', closeOfficialWritingMaterialModal);
    document.getElementById('official-writing-sync-btn')?.addEventListener('click', syncOfficialWritingSourceToDraft);
    document.getElementById('official-writing-reset-btn')?.addEventListener('click', () => {
        resetOfficialWritingForm();
        closeOfficialWritingCommandMenu();
    });
    document.getElementById('official-writing-backup-btn')?.addEventListener('click', () => {
        exportOfficialWritingBackup();
        closeOfficialWritingCommandMenu();
    });
    document.getElementById('official-writing-edit-source-btn')?.addEventListener('click', openOfficialWritingMaterialEditor);
    document.getElementById('official-writing-upload-material-btn')?.addEventListener('click', () => document.getElementById('official-writing-material-upload-input')?.click());
    document.getElementById('official-writing-material-save-btn')?.addEventListener('click', saveOfficialWritingMaterialEditor);
    document.getElementById('official-writing-material-clear-btn')?.addEventListener('click', clearOfficialWritingMaterialEditor);
    document.getElementById('official-writing-material-editor-close-btn')?.addEventListener('click', closeOfficialWritingMaterialEditor);
    document.getElementById('official-writing-material-editor')?.addEventListener('input', event => {
        syncOfficialWritingMaterialEditorStats(event.target.value);
    });
    document.getElementById('official-writing-material-upload-input')?.addEventListener('change', event => {
        void importOfficialWritingMaterialFiles(event.target.files);
        event.target.value = '';
    });
    document.getElementById('official-writing-source-selection-btn')?.addEventListener('click', () => {
        captureSelection('official-writing-source', 'official-writing-comment-anchor');
        const target = document.getElementById('official-writing-comment-target');
        if (target) target.value = 'source';
    });
    document.getElementById('official-writing-draft-selection-btn')?.addEventListener('click', () => {
        captureSelection('official-writing-draft', 'official-writing-comment-anchor');
        const target = document.getElementById('official-writing-comment-target');
        if (target) target.value = 'draft';
    });
    document.getElementById('official-writing-export-text-btn')?.addEventListener('click', () => {
        exportOfficialWritingText();
        closeOfficialWritingCommandMenu();
    });
    document.getElementById('official-writing-generate-suggestions-btn')?.addEventListener('click', runOfficialWritingReview);
    document.getElementById('official-writing-add-comment-btn')?.addEventListener('click', addOfficialWritingComment);
    document.getElementById('official-writing-clear-comments-btn')?.addEventListener('click', () => {
        officialWritingState.comments = [];
        saveOfficialWritingState();
        renderOfficialWritingWorkspace();
    });
    document.getElementById('official-writing-save-version-btn')?.addEventListener('click', saveOfficialWritingVersion);
    document.getElementById('official-writing-compare-btn')?.addEventListener('click', compareOfficialWritingVersions);
    document.getElementById('official-writing-copy-btn')?.addEventListener('click', () => {
        copyOfficialWritingPrompt();
        closeOfficialWritingCommandMenu();
    });
    document.getElementById('official-writing-chat-btn')?.addEventListener('click', () => {
        sendOfficialWritingToChat();
        closeOfficialWritingCommandMenu();
    });
    document.getElementById('official-writing-material-source')?.addEventListener('change', event => {
        setOfficialWritingMaterialSource(event.target.value);
        renderOfficialWritingWorkspace();
    });
    document.getElementById('official-writing-standard')?.addEventListener('change', renderOfficialWritingWorkspace);
    document.getElementById('official-writing-type')?.addEventListener('change', renderOfficialWritingWorkspace);
    document.getElementById('official-writing-requirements')?.addEventListener('input', renderOfficialWritingWorkspace);
    document.getElementById('official-writing-new-doc-btn')?.addEventListener('click', openOfficialWritingCreateDialog);
    document.getElementById('official-writing-create-doc-btn')?.addEventListener('click', openOfficialWritingCreateDialog);
    document.getElementById('official-writing-create-form')?.addEventListener('submit', submitOfficialWritingCreateDialog);
    document.getElementById('official-writing-create-cancel-btn')?.addEventListener('click', closeOfficialWritingCreateDialog);
    document.getElementById('official-writing-create-modal')?.addEventListener('click', event => {
        if (event.target?.id === 'official-writing-create-modal') closeOfficialWritingCreateDialog();
    });
    document.getElementById('official-writing-create-title')?.addEventListener('input', () => setOfficialWritingCreateDialogError(''));
    document.getElementById('official-writing-refresh-docs-btn')?.addEventListener('click', renderOfficialWritingDocList);
    document.getElementById('official-writing-back-to-library-btn')?.addEventListener('click', showOfficialWritingLibrary);
    document.getElementById('official-writing-kb-history-search-btn')?.addEventListener('click', () => runOfficialWritingRagSearch('history'));
    document.getElementById('official-writing-kb-history-query')?.addEventListener('keydown', event => {
        if (event.key === 'Enter') { event.preventDefault(); runOfficialWritingRagSearch('history'); }
    });
    document.getElementById('official-writing-diff-close')?.addEventListener('click', closeOfficialWritingDiffModal);
    document.getElementById('official-writing-diff-cancel')?.addEventListener('click', closeOfficialWritingDiffModal);
    document.getElementById('official-writing-diff-apply')?.addEventListener('click', applyOfficialWritingDiffResult);
    document.getElementById('official-writing-diff-accept-all')?.addEventListener('click', () => {
        if (!officialWritingDiffState) return;
        officialWritingDiffState.rows.forEach(row => { if (row.type !== 'same') row.accepted = true; });
        renderOfficialWritingDiffRows();
    });
    document.getElementById('official-writing-diff-reject-all')?.addEventListener('click', () => {
        if (!officialWritingDiffState) return;
        officialWritingDiffState.rows.forEach(row => { if (row.type !== 'same') row.accepted = false; });
        renderOfficialWritingDiffRows();
    });
    // 发文要素输入：写回 state 并持久化（不触发整页重渲染，避免打断输入）。
    Object.values(OFFICIAL_WRITING_META_FIELD_IDS).forEach(id => {
        const el = document.getElementById(id);
        el?.addEventListener('input', () => {
            syncOfficialWritingMetaFromInputs();
            saveOfficialWritingState();
        });
        el?.addEventListener('change', () => {
            syncOfficialWritingMetaFromInputs();
            saveOfficialWritingState();
        });
    });
    ['official-writing-source', 'official-writing-draft'].forEach(id => {
        const editor = document.getElementById(id);
        editor?.addEventListener('input', () => {
            // 去抖整库持久化与校对/合规分析，避免每次按键都触发重活。
            scheduleOfficialWritingAnalysis();
        });
        editor?.addEventListener('blur', () => flushOfficialWritingAnalysis());
        editor?.addEventListener('select', handleOfficialWritingSelectionChange);
        editor?.addEventListener('mouseup', handleOfficialWritingSelectionChange);
        editor?.addEventListener('keyup', handleOfficialWritingSelectionChange);
    });
    ['source', 'draft'].forEach(target => {
        const surface = getOfficialWritingSurface(target);
        surface?.addEventListener('input', handleOfficialWritingSurfaceInput);
        surface?.addEventListener('blur', handleOfficialWritingSurfaceBlur);
        surface?.addEventListener('paste', handleOfficialWritingSurfacePaste);
        surface?.addEventListener('keydown', handleOfficialWritingSurfaceKeydown);
        surface?.addEventListener('mouseup', handleOfficialWritingSelectionChange);
        surface?.addEventListener('keyup', handleOfficialWritingSelectionChange);
        surface?.addEventListener('select', handleOfficialWritingSelectionChange);
    });
    panel.addEventListener('click', event => {
        const commandMenu = event.target.closest('#official-writing-command-more-menu');
        if (!commandMenu) closeOfficialWritingCommandMenu();
        const commandMenuItem = event.target.closest('.official-writing-command-menu-item');
        const selectionAction = event.target.closest('[data-official-writing-selection-action]');
        if (selectionAction) {
            applySelectionAction(selectionAction.dataset.officialWritingSelectionAction);
            return;
        }
        const exportAction = event.target.closest('[data-official-writing-export]');
        if (exportAction) {
            exportOfficialWriting(exportAction.dataset.officialWritingExport);
            if (commandMenuItem) closeOfficialWritingCommandMenu();
            return;
        }
        const flowVersion = event.target.closest('[data-official-writing-flow-version]');
        if (flowVersion) {
            saveOfficialWritingVersion(flowVersion.dataset.officialWritingFlowVersion);
            if (commandMenuItem) closeOfficialWritingCommandMenu();
            return;
        }
        const suggestionButton = event.target.closest('[data-suggestion-action]');
        if (suggestionButton) {
            const item = suggestionButton.closest('[data-suggestion-id]');
            applySuggestionAction(item?.dataset?.suggestionId, suggestionButton.dataset.suggestionAction);
            return;
        }
        const riskItem = event.target.closest('[data-official-writing-risk-id]');
        if (riskItem) {
            handleOfficialWritingRiskClick(riskItem.dataset.officialWritingRiskId);
            return;
        }
        const jumpItem = event.target.closest('[data-official-writing-jump]');
        if (jumpItem) {
            jumpOfficialWritingRange(jumpItem.dataset.officialWritingTarget || 'draft', Number(jumpItem.dataset.officialWritingJump || 0));
            return;
        }
        const materialAction = event.target.closest('[data-material-action]');
        if (materialAction) {
            const card = materialAction.closest('[data-material-id]');
            handleOfficialWritingMaterialAction(card?.dataset?.materialId, materialAction.dataset.materialAction);
            return;
        }
        const viewMode = event.target.closest('[data-official-writing-view-mode]');
        if (viewMode) {
            applyOfficialWritingViewMode(viewMode.dataset.officialWritingViewMode);
            return;
        }
        const drawerTab = event.target.closest('[data-official-writing-drawer-tab]');
        if (drawerTab) {
            openOfficialWritingDrawer(drawerTab.dataset.officialWritingDrawerTab);
            return;
        }
        const materialTab = event.target.closest('[data-official-writing-material-tab]');
        if (materialTab) {
            setOfficialWritingMaterialTab(materialTab.dataset.officialWritingMaterialTab);
            renderOfficialWritingWorkspace();
            return;
        }
        const runMode = event.target.closest('[data-official-writing-run-mode]');
        if (runMode) {
            runOfficialWritingMode(runMode.dataset.officialWritingRunMode);
            return;
        }
        const requirement = event.target.closest('[data-official-writing-requirement]');
        if (requirement) {
            appendOfficialWritingRequirement(requirement.dataset.officialWritingRequirement);
            return;
        }
        const template = event.target.closest('[data-official-writing-template]');
        if (template) {
            applyOfficialWritingTemplate(template.dataset.officialWritingTemplate);
            return;
        }
        const appCard = event.target.closest('[data-app-id]');
        if (appCard) {
            openRegisteredApp(appCard.dataset.appId);
            return;
        }
        const deleteComment = event.target.closest('[data-comment-delete]');
        if (deleteComment) {
            deleteOfficialWritingComment(deleteComment.dataset.commentDelete);
            return;
        }
        const loadVersion = event.target.closest('[data-version-load]');
        if (loadVersion) {
            loadOfficialWritingVersion(loadVersion.dataset.versionLoad);
            return;
        }
        const docOpen = event.target.closest('[data-official-writing-doc-open]');
        if (docOpen) {
            switchOfficialWritingDoc(docOpen.dataset.officialWritingDocOpen);
            return;
        }
        const docRename = event.target.closest('[data-official-writing-doc-rename]');
        if (docRename) {
            renameOfficialWritingDoc(docRename.dataset.officialWritingDocRename);
            return;
        }
        const docDelete = event.target.closest('[data-official-writing-doc-delete]');
        if (docDelete) {
            deleteOfficialWritingDoc(docDelete.dataset.officialWritingDocDelete);
            return;
        }
        const ragInsert = event.target.closest('[data-official-writing-rag-insert]');
        if (ragInsert) {
            insertOfficialWritingRagMatch(Number(ragInsert.dataset.officialWritingRagInsert), ragInsert.dataset.officialWritingRagScope);
            return;
        }
        const ragRef = event.target.closest('[data-official-writing-rag-ref]');
        if (ragRef) {
            referenceOfficialWritingRagMatch(Number(ragRef.dataset.officialWritingRagRef), ragRef.dataset.officialWritingRagScope);
            return;
        }
        const proofJump = event.target.closest('[data-official-writing-proof-start]');
        if (proofJump) {
            jumpOfficialWritingRange('draft', Number(proofJump.dataset.officialWritingProofStart || 0), Number(proofJump.dataset.officialWritingProofEnd || 0));
            return;
        }
        const diffAccept = event.target.closest('[data-official-writing-diff-accept]');
        if (diffAccept) {
            setOfficialWritingDiffRowAccepted(diffAccept.dataset.officialWritingDiffAccept, true);
            return;
        }
        const diffReject = event.target.closest('[data-official-writing-diff-reject]');
        if (diffReject) {
            setOfficialWritingDiffRowAccepted(diffReject.dataset.officialWritingDiffReject, false);
            return;
        }
    });


    // 键盘快捷键：Esc 收起弹窗或辅助面板。
    panel.addEventListener('keydown', event => {
        if (document.getElementById('official-writing-view')?.classList.contains('hidden')) return;
        if (event.key === 'Escape') {
            const diffModal = document.getElementById('official-writing-diff-modal');
            if (diffModal && !diffModal.classList.contains('hidden')) {
                event.preventDefault();
                closeOfficialWritingDiffModal();
                return;
            }
            const draftModal = document.getElementById('official-writing-draft-modal');
            if (draftModal && !draftModal.classList.contains('hidden')) {
                event.preventDefault();
                closeOfficialWritingDraftDialog();
                document.getElementById('official-writing-open-draft-modal-btn')?.focus();
                return;
            }
            const workbench = document.querySelector('.official-writing-workbench');
            if (workbench && !workbench.classList.contains('is-left-rail-hidden')) {
                event.preventDefault();
                closeOfficialWritingMaterialModal();
                document.getElementById('official-writing-toggle-left-btn')?.focus();
                return;
            }
            const drawer = document.getElementById('official-writing-drawer');
            if (drawer && !drawer.classList.contains('hidden')) {
                event.preventDefault();
                closeOfficialWritingDrawer();
                document.getElementById('official-writing-review-suggestions-btn')?.focus();
            }
        }
    });
}

window.openAppsWorkbench = function() {
    window.showMainWorkspace?.('apps');
    bindAppsWorkbenchEvents();
    if (getStoredAppsActiveApp() === 'official-writing') {
        showOfficialWritingApp();
    } else if (getStoredAppsActiveApp() === 'data-analysis') {
        showDataAnalysisAppFromRegistry().catch(() => showAppsHome());
    } else if (getStoredAppsActiveApp() === 'regulations') {
        if (typeof window.showRegulationsAppFromRegistry === 'function') {
            window.showRegulationsAppFromRegistry().catch(() => showAppsHome());
        } else {
            showAppsHome();
        }
    } else {
        showAppsHome();
    }
};

window.closeAppsWorkbench = function() {
    setStoredAppsActiveApp('');
    showAppsHome();
    window.showMainWorkspace?.('chat');
};

window.PIVOT_APP_REGISTRY = PIVOT_APP_REGISTRY;
