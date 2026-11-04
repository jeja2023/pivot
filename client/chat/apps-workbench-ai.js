// AI 结果属于发起文档的正文快照，生成只创建预览，用户采纳才修改正文。
let officialWritingActiveTask = null;
let officialWritingPreviewId = '';

function formatOfficialWritingAiErrorMessage(data, status) {
    return String(data?.error?.message || data?.error || `AI 请求失败（${status}）`);
}

function getOfficialWritingTaskModelId(task = 'selection') {
    const scopes = { draft: ['official-writing-draft', 'official-writing-draft-model'], review: ['official-writing-review', 'official-writing-review-model'], selection: ['official-writing-selection', 'official-writing-selection-model'] };
    const [scope, selectorId] = scopes[task] || scopes.selection;
    return window.Pivot.legacy.PivotAppModels?.getSelectedModel?.(scope, selectorId) || document.getElementById(selectorId)?.value || '';
}

function isOfficialWritingDrawerOpen() {
    return document.getElementById('official-writing-drawer')?.getAttribute('aria-hidden') === 'false';
}

function syncOfficialWritingAiIndicators() {
    for (const id of ['official-writing-ai-indicator', 'official-writing-drawer-ai-indicator']) {
        const node = document.getElementById(id);
        if (node) { node.textContent = officialWritingAiBusyLabel; node.classList.toggle('hidden', !officialWritingAiBusy); }
    }
}

function setOfficialWritingAiBusy(busy, label = '', mode = '') {
    officialWritingAiBusy = !!busy;
    officialWritingAiBusyLabel = busy ? label || 'AI 处理中…' : '';
    officialWritingAiTaskMode = busy ? mode : '';
    document.querySelectorAll('[data-official-writing-run-mode], #official-writing-open-draft-modal-btn, #official-writing-draft-confirm-btn, #official-writing-generate-suggestions-btn, [data-official-writing-selection-action], [data-pivot-app-model^="official-writing"]').forEach(node => {
        node.disabled = !!busy || (node.tagName === 'SELECT' && !node.value);
        node.setAttribute('aria-busy', busy ? 'true' : 'false');
    });
    for (const id of ['official-writing-stop-review-btn', 'official-writing-stop-ai-btn', 'official-writing-result-stop-btn']) document.getElementById(id)?.classList.toggle('hidden', !busy);
    syncOfficialWritingAiIndicators();
}

function cancelOfficialWritingAiTask() {
    if (officialWritingAiAbortController) officialWritingAiAbortController.abort();
}

function stopOfficialWritingReview() { cancelOfficialWritingAiTask(); }

function visibleOfficialWritingAiText(value) {
    return String(value || '').replace(/<think\b[^>]*>[\s\S]*?(?:<\/think\s*>|$)/gi, '')
        .replace(/<(?:t(?:h(?:i(?:n(?:k)?)?)?)?)?$/i, '').trim();
}

async function requestOfficialWritingAi(params, { stream = false, onDelta, signal, modelId } = {}) {
    const useStream = stream && typeof createBrowserSseParser === 'function';
    let full = '', finishReason = null, reader = null, finished = false;
    const result = (status, error = '') => ({ status, content: visibleOfficialWritingAiText(full), finish_reason: finishReason,
        partial: status !== 'complete', aborted: status === 'cancelled', error });
    try {
        const res = await apiFetch(`${API_BASE}/apps/official-writing/ai`, { method: 'POST', signal,
            headers: { 'Content-Type': 'application/json', ...(useStream ? { Accept: 'text/event-stream' } : {}) },
            body: JSON.stringify({ ...params, model: modelId || undefined, stream: useStream }) });
        if (!res.ok) throw new Error(formatOfficialWritingAiErrorMessage(await res.json().catch(() => ({})), res.status));
        if (!useStream) {
            const data = await res.json();
            full = String(data.content || '');
            finishReason = data.finish_reason;
            const status = data.status || (finishReason === 'length' || finishReason === 'content_filter' ? 'partial' : 'complete');
            return { ...data, ...result(status, data.error || '') };
        }
        if (!res.body) throw new Error('AI 响应没有可读取的正文');
        reader = res.body.getReader();
        const decoder = new TextDecoder();
        const parser = createBrowserSseParser({
            onDone() { finished = true; },
            onData(payload) {
                let data;
                try { data = JSON.parse(payload); } catch (_) { return; }
                if (data.error) throw new Error(data.error.message || 'AI 生成中断');
                const choice = data.choices?.[0];
                if (choice?.finish_reason) finishReason = choice.finish_reason;
                if (data.finish_reason) finishReason = data.finish_reason;
                const delta = data.content ?? choice?.delta?.content ?? '';
                if (typeof delta === 'string') full += delta;
                if (onDelta) onDelta(visibleOfficialWritingAiText(full));
            }
        });
        while (!parser.isDone()) {
            const { done, value } = await reader.read();
            if (done) { parser.write(decoder.decode()); parser.end(); break; }
            parser.write(decoder.decode(value, { stream: true }));
        }
        if (finishReason === 'length') return result('partial', '输出达到长度上限，已保留部分结果，请调整长度后重试');
        if (finishReason === 'content_filter') return result('partial', '模型未完整生成正文');
        if (!finished && !['stop', 'end_turn'].includes(finishReason)) return result('partial', '连接在生成完成前断开，已保留部分结果');
        return result('complete');
    } catch (error) {
        if (signal?.aborted || error.name === 'AbortError') return result('cancelled', '已取消生成');
        showToast(error.message || 'AI 请求失败', 'error');
        return result('error', error.message || 'AI 请求失败');
    } finally {
        if (reader) { try { await reader.cancel(); } catch (_) {} reader.releaseLock(); }
    }
}

function buildOfficialWritingComments() {
    return (officialWritingState.comments || []).map(comment => `${comment.anchor || '全文'}：${comment.text}`).join('\n');
}

function officialWritingNoContentMessage(result) { return result?.error || 'AI 未返回有效内容，请调整要求后重试'; }

function addOfficialWritingTaskSuggestions(context, suggestions) {
    const doc = officialWritingLibrary.docs.find(item => item.id === context.docId);
    if (!doc?._loaded || officialWritingDeletedDocumentIds.has(doc.id) || context.owner !== getOfficialWritingOwner()) return [];
    const created = suggestions.map(payload => ({ id: `suggestion-${Date.now()}-${Math.random().toString(16).slice(2)}`, status: 'pending', createdAt: new Date().toISOString(), ...payload }));
    doc.state.suggestions.unshift(...created);
    doc.state.suggestions = doc.state.suggestions.slice(0, OFFICIAL_WRITING_SUGGESTION_LIMIT);
    void scheduleOfficialWritingDocumentSave(doc, { immediate: true });
    if (doc.id === officialWritingLibrary.activeId) renderOfficialWritingWorkspace();
    return created;
}

async function runOfficialWritingAiTask(mode, { selection, action, instruction } = {}) {
    if (officialWritingAiBusy) return;
    syncOfficialWritingStateFromInputs();
    const doc = getActiveOfficialWritingDoc();
    if (!doc?._loaded) return;
    const target = selection?.target || 'draft';
    const original = selection?.text || doc.state.draft;
    if (!original.trim() && mode !== 'draft') return showToast('请先输入正文或选中片段', 'warning');
    const context = { docId: doc.id, owner: getOfficialWritingOwner(), state: doc.state, original, baseText: doc.state[target],
        digest: officialWritingDocument.digest(doc.state[target]), target, start: selection?.start || 0, end: selection?.end ?? doc.state.draft.length };
    const abortController = new AbortController();
    officialWritingAiAbortController = abortController;
    officialWritingActiveTask = context;
    setOfficialWritingAiBusy(true, mode === 'review' ? 'AI 审校中…' : 'AI 正在生成预览…', mode);
    const modelId = getOfficialWritingTaskModelId(mode === 'draft' ? 'draft' : mode === 'review' ? 'review' : 'selection');
    if (mode !== 'review') openOfficialWritingResultPreview('', original, '正在生成，完成后可预览采纳');
    try {
        const result = await requestOfficialWritingAi({ mode, action, instruction, title: doc.title, docType: doc.state.docType, standard: doc.state.standard,
            requirements: doc.state.requirements, comments: buildOfficialWritingComments(),
            source: doc.state.source, draft: doc.state.draft, selection: selection ? { text: selection.text } : null },
        { stream: mode !== 'review', signal: abortController?.signal, modelId,
            onDelta(full) { if (officialWritingActiveTask === context && officialWritingLibrary.activeId === context.docId) setText('official-writing-result-text', full); } });
        if (context.owner !== getOfficialWritingOwner() || officialWritingDeletedDocumentIds.has(context.docId)) return;
        let text = String(result?.content || '').trim();
        if (selection && text) text = (context.original.match(/^\s*/)?.[0] || '') + text + (context.original.match(/\s*$/)?.[0] || '');
        if (!text && mode !== 'review') { if (!result?.aborted) showToast(officialWritingNoContentMessage(result), 'warning'); closeOfficialWritingResultPreview(); return; }
        if (mode === 'review') {
            const items = Array.isArray(result.items) ? result.items : [];
            context.state.review = { status: result.status || 'error', digest: officialWritingDocument.digest(context.original), checkedAt: new Date().toISOString(), error: result.error || '' };
            if (result.status !== 'complete') { void scheduleOfficialWritingDocumentSave(doc, { immediate: true }); showToast(result.error || '审校未完成，请重试', 'warning'); return; }
            addOfficialWritingTaskSuggestions(context, items.slice(0, 20).map(item => {
                const index = context.original.indexOf(item.original || '');
                const unique = item.original && index !== -1 && context.original.indexOf(item.original, index + 1) === -1;
                const anchor = unique ? officialWritingDocument.anchor(context.original, index, index + item.original.length) : { original: item.original || '', start: 0, end: 0, digest: context.digest };
                return { ...anchor, target: 'draft', type: '审校', title: item.title || '审校意见', detail: item.explanation || item.suggestion || '',
                    replacement: item.replacement || '', canApply: !!unique && typeof item.replacement === 'string', severity: item.severity || '提示' };
            }));
            if (!items.length) { void scheduleOfficialWritingDocumentSave(doc, { immediate: true }); showToast('AI 审校完成，未发现需修改项'); }
            else showToast(`已生成 ${Math.min(items.length, 20)} 条审校意见`);
            return;
        }
        const complete = result.status === 'complete';
        const anchor = officialWritingDocument.anchor(context.baseText, context.start, context.end);
        // 任务开始后的任何编辑都不能改变本次结果的原文锚点。
        Object.assign(anchor, { original: context.original, digest: context.digest });
        const [suggestion] = addOfficialWritingTaskSuggestions(context, [{ ...anchor, type: mode === 'draft' ? '初稿预览' : '改写预览',
            title: mode === 'draft' ? 'AI 全文初稿' : 'AI 改写结果', target, wholeDocument: !selection,
            replacement: text, detail: complete ? '预览后采纳，采纳前会核对原文是否变化。' : result.error || '生成未完成，部分结果仅供参考',
            canApply: complete, partial: !complete }]);
        if (suggestion && officialWritingLibrary.activeId === context.docId) openOfficialWritingResultPreview(suggestion.id, original, suggestion.detail);
    } finally {
        if (officialWritingActiveTask === context) {
            officialWritingActiveTask = null;
            officialWritingAiAbortController = null;
            setOfficialWritingAiBusy(false);
            renderOfficialWritingWorkspace();
        }
    }
}

async function generateOfficialWritingSuggestion(mode = getOfficialWritingMode()) { return runOfficialWritingAiTask(mode); }

function applySuggestionAction(suggestionId, action) {
    const suggestion = officialWritingState.suggestions.find(item => item.id === suggestionId);
    if (!suggestion || suggestion.status !== 'pending') return;
    const textarea = getOfficialWritingTextarea(suggestion.target || 'draft');
    if (!textarea) return;
    if (['replace', 'accept', 'insert'].includes(action)) {
        if (!suggestion.canApply || suggestion.partial) return showToast('此项为说明或未完成结果，不能直接替换正文', 'warning');
        syncOfficialWritingStateFromInputs();
        const range = suggestion.wholeDocument
            ? (officialWritingDocument.digest(textarea.value) === suggestion.digest ? { start: 0, end: textarea.value.length } : null)
            : officialWritingDocument.locate(textarea.value, suggestion);
        if (!range) {
            suggestion.status = 'stale'; saveOfficialWritingState(); renderOfficialWritingWorkspace();
            return showToast('原文已变化或无法唯一定位，请核对后重新生成', 'warning');
        }
        recordOfficialWritingAutoSave({ force: true });
        replaceTextareaRange(textarea, action === 'insert' ? range.end : range.start, range.end,
            action === 'insert' ? `\n${suggestion.replacement}` : suggestion.replacement);
        suggestion.status = 'accepted';
        showToast('已采纳，可撤销本次修改');
    } else if (action === 'comment') {
        officialWritingState.comments.unshift({ id: `comment-${Date.now()}`, target: suggestion.target, anchor: suggestion.original || '全文', text: suggestion.detail || suggestion.replacement, createdAt: new Date().toISOString() });
        suggestion.status = 'accepted';
    } else if (action === 'reject') suggestion.status = 'rejected';
    else if (action === 'preview') { openOfficialWritingResultPreview(suggestion.id, suggestion.original, suggestion.detail); return; }
    else return;
    suggestion.resolvedAt = new Date().toISOString();
    saveOfficialWritingState(); renderOfficialWritingWorkspace(); closeOfficialWritingResultPreview();
}

function openOfficialWritingResultPreview(id, original = '', message = '') {
    officialWritingPreviewId = id;
    const suggestion = officialWritingState.suggestions.find(item => item.id === id);
    setText('official-writing-result-original', original);
    setText('official-writing-result-text', suggestion?.replacement || '');
    setText('official-writing-result-status', message);
    const apply = document.getElementById('official-writing-result-apply-btn');
    if (apply) apply.disabled = !suggestion?.canApply || suggestion?.status !== 'pending';
    const difference = document.getElementById('official-writing-result-diff');
    if (difference && suggestion?.replacement) {
        const after = suggestion?.replacement || '';
        let prefix = 0, suffix = 0;
        while (prefix < original.length && prefix < after.length && original[prefix] === after[prefix]) prefix++;
        while (suffix < original.length - prefix && suffix < after.length - prefix && original[original.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
        PivotSafeHtml.setHtml(difference, `<h4>修改对照</h4><pre>${escapeAppsHtml(original.slice(0, prefix))}<del>${escapeAppsHtml(original.slice(prefix, original.length - suffix))}</del><ins>${escapeAppsHtml(after.slice(prefix, after.length - suffix))}</ins>${escapeAppsHtml(suffix ? original.slice(-suffix) : '')}</pre>`);
    } else if (difference) PivotSafeHtml.setHtml(difference, '');
    showOfficialWritingModal('official-writing-result-modal');
}

function closeOfficialWritingResultPreview() {
    hideOfficialWritingModal('official-writing-result-modal');
    officialWritingPreviewId = '';
}

async function promptOfficialWritingSelectionCustom(selection) {
    const instruction = await window.Pivot.legacy.showInputPrompt?.({ title: '按要求改写', message: '填写片段改写要求', requiredMessage: '请输入修改要求', width: 520 });
    if (instruction?.trim()) return runOfficialWritingSelectionCustomAi(selection, instruction.trim());
}
async function runOfficialWritingSelectionCustomAi(selection, instruction) { return runOfficialWritingAiTask('selection', { selection, action: 'custom', instruction }); }
async function runOfficialWritingSelectionAi(action, selection) { return runOfficialWritingAiTask('selection', { selection, action }); }

function applySelectionAction(action) {
    syncOfficialWritingStateFromInputs();
    const selection = getBestOfficialWritingSelection();
    if (!selection.text.trim()) return showToast('请先选中正文片段', 'warning');
    if (action === 'custom') return promptOfficialWritingSelectionCustom(selection);
    if (action === 'comment') { captureSelection(`official-writing-${selection.target}`, 'official-writing-comment-anchor'); return; }
    if (action === 'rewrite-diff') return runOfficialWritingStreamRewrite(selection);
    return runOfficialWritingSelectionAi(action, selection);
}
