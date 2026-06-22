// ===== 知识库 / 历史公文检索接入 =====

// 缓存两个检索面板（历史 / 规范）的最近一次结果，供插入和引用操作复用。
const officialWritingRagResults = { history: [], standards: [] };
let officialWritingRagCollectionsLoaded = false;

async function ensureOfficialWritingRagCollections() {
    if (officialWritingRagCollectionsLoaded) return;
    if (typeof window.loadKnowledgeCollections !== 'function') return;
    let collections = [];
    try {
        collections = await window.loadKnowledgeCollections();
    } catch (e) {
        // Leave the flag false so a later call retries the load.
        return;
    }
    if (!Array.isArray(collections)) return;
    // Mark as loaded only after a successful fetch so failures can retry.
    officialWritingRagCollectionsLoaded = true;
    ['official-writing-kb-history-collection', 'official-writing-kb-standards-collection'].forEach(id => {
        const select = document.getElementById(id);
        if (!select) return;
        const current = select.value;
        const options = ['<option value="">全部专题库</option>']
            .concat(collections.map(c => `<option value="${escapeAppsHtml(String(c.id))}">${escapeAppsHtml(c.name || ('专题库 ' + c.id))}</option>`));
        select.innerHTML = options.join('');
        if (current) select.value = current;
    });
}

function renderOfficialWritingRagResults(scopeKey) {
    const list = document.getElementById(`official-writing-kb-${scopeKey}-results`);
    if (!list) return;
    const matches = officialWritingRagResults[scopeKey] || [];
    list.innerHTML = matches.map((match, index) => `
        <article class="official-writing-kb-result">
            <div class="official-writing-kb-result-head">
                <span>${escapeAppsHtml(match.source || '知识库')}</span>
                <em>相关度 ${Math.round((match.score || 0) * 100)}%</em>
            </div>
            <p>${escapeAppsHtml(compactTextPreview(match.text, 140))}</p>
            <div class="official-writing-kb-result-actions">
                <button type="button" data-official-writing-rag-insert="${index}" data-official-writing-rag-scope="${escapeAppsHtml(scopeKey)}">引用到正文</button>
                <button type="button" data-official-writing-rag-ref="${index}" data-official-writing-rag-scope="${escapeAppsHtml(scopeKey)}">作为依据</button>
            </div>
        </article>
    `).join('') || '<div class="official-writing-empty-note">输入关键词后点击“检索”，从知识库查找参考资料。</div>';
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
    const key = scopeKey || (officialWritingUiState.materialTab === 'standards' ? 'standards' : 'history');
    const fromScope = (officialWritingRagResults[key] || [])[index];
    if (fromScope) return fromScope;
    return (officialWritingRagResults.history[index] || officialWritingRagResults.standards[index]);
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

function referenceOfficialWritingRagMatch(index, scopeKey) {
    const match = findOfficialWritingRagMatch(index, scopeKey);
    if (!match) return;
    appendOfficialWritingRequirement(`参考资料「${compactTextPreview(match.text, 30)}」（来源：${match.source || '知识库'}）作为事实依据`);
}

function appendOfficialWritingRequirement(text) {
    const input = document.getElementById('official-writing-requirements');
    if (!input) return;
    const value = input.value.trim();
    input.value = value ? `${value}；${text}` : text;
    renderOfficialWritingWorkspace();
    showToast('已加入 AI 指令');
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

function focusOfficialWritingSource() {
    applyOfficialWritingViewMode('compare');
    getOfficialWritingSurface('source')?.focus();
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
        openOfficialWritingDrawer('suggestions');
    } else if (action === 'view') {
        applyOfficialWritingViewMode('compare');
        const source = getOfficialWritingTextarea('source');
        const index = source?.value.indexOf(segment.text) ?? -1;
        if (index >= 0) setTextareaSelection(source, index, index + segment.text.length);
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
    document.getElementById('official-writing-sync-btn')?.addEventListener('click', syncOfficialWritingSourceToDraft);
    document.getElementById('official-writing-reset-btn')?.addEventListener('click', () => {
        resetOfficialWritingForm();
        closeOfficialWritingCommandMenu();
    });
    document.getElementById('official-writing-undo-btn')?.addEventListener('click', undoOfficialWriting);
    document.getElementById('official-writing-redo-btn')?.addEventListener('click', redoOfficialWriting);
    document.getElementById('official-writing-backup-btn')?.addEventListener('click', () => {
        exportOfficialWritingBackup();
        closeOfficialWritingCommandMenu();
    });
    document.getElementById('official-writing-edit-source-btn')?.addEventListener('click', focusOfficialWritingSource);
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
    document.getElementById('official-writing-generate-suggestions-btn')?.addEventListener('click', () => generateOfficialWritingSuggestion(getOfficialWritingMode()));
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
    document.getElementById('official-writing-new-doc-btn')?.addEventListener('click', createOfficialWritingDoc);
    document.getElementById('official-writing-kb-history-search-btn')?.addEventListener('click', () => runOfficialWritingRagSearch('history'));
    document.getElementById('official-writing-kb-standards-search-btn')?.addEventListener('click', () => runOfficialWritingRagSearch('standards'));
    document.getElementById('official-writing-kb-history-query')?.addEventListener('keydown', event => {
        if (event.key === 'Enter') { event.preventDefault(); runOfficialWritingRagSearch('history'); }
    });
    document.getElementById('official-writing-kb-standards-query')?.addEventListener('keydown', event => {
        if (event.key === 'Enter') { event.preventDefault(); runOfficialWritingRagSearch('standards'); }
    });
    document.getElementById('official-writing-proofread-btn')?.addEventListener('click', () => {
        syncOfficialWritingStateFromInputs();
        renderOfficialWritingProofread();
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

    // 审改栏分页 tab 的方向键导航（WAI-ARIA tablist 模式）。
    const drawerTabs = document.querySelector('.official-writing-drawer-tabs');
    drawerTabs?.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        const tabs = Array.from(drawerTabs.querySelectorAll('[data-official-writing-drawer-tab]'));
        if (!tabs.length) return;
        const currentIndex = tabs.findIndex(tab => tab === document.activeElement);
        let nextIndex = currentIndex;
        if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
        else if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % tabs.length;
        else if (event.key === 'Home') nextIndex = 0;
        else if (event.key === 'End') nextIndex = tabs.length - 1;
        event.preventDefault();
        const nextTab = tabs[nextIndex];
        if (nextTab) {
            openOfficialWritingDrawer(nextTab.dataset.officialWritingDrawerTab);
            nextTab.focus();
        }
    });

    // 键盘快捷键：撤销/重做，以及 Esc 收起审改栏。
    panel.addEventListener('keydown', event => {
        if (document.getElementById('official-writing-view')?.classList.contains('hidden')) return;
        const isMod = event.ctrlKey || event.metaKey;
        if (isMod && !event.shiftKey && (event.key === 'z' || event.key === 'Z')) {
            event.preventDefault();
            undoOfficialWriting();
            return;
        }
        if (isMod && ((event.key === 'y' || event.key === 'Y') || (event.shiftKey && (event.key === 'z' || event.key === 'Z')))) {
            event.preventDefault();
            redoOfficialWriting();
            return;
        }
        if (event.key === 'Escape') {
            const diffModal = document.getElementById('official-writing-diff-modal');
            if (diffModal && !diffModal.classList.contains('hidden')) {
                event.preventDefault();
                closeOfficialWritingDiffModal();
                return;
            }
            const drawer = document.getElementById('official-writing-drawer');
            if (drawer && !drawer.classList.contains('hidden')) {
                event.preventDefault();
                closeOfficialWritingDrawer();
                // 收起后将焦点交还给打开按钮，保持键盘焦点不丢失。
                document.getElementById('official-writing-toggle-right-btn')?.focus();
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
