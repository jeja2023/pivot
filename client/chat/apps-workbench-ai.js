
function getOfficialWritingSelectedModelId() {
    return document.getElementById('model-selector')?.value || '';
}

function setOfficialWritingAiBusy(busy, label) {
    officialWritingAiBusy = !!busy;
    const buttons = document.querySelectorAll('[data-official-writing-run-mode], #official-writing-generate-suggestions-btn, [data-official-writing-selection-action]');
    buttons.forEach(button => {
        button.disabled = !!busy;
        button.setAttribute('aria-busy', busy ? 'true' : 'false');
    });
    const indicator = document.getElementById('official-writing-ai-indicator');
    if (indicator) {
        indicator.textContent = busy ? (label || 'AI 处理中…') : '';
        indicator.classList.toggle('hidden', !busy);
    }
}

// 统一调用后端公文写作 AI 接口：提示词组装、模型权限/配额/上下文预算与审计均在后端完成，
// 前端只传结构化参数（mode/action/source/draft/requirements/selection 等）。
// 非流式返回解析后的对象（{ content, items? }）；流式经 onDelta 回调累积文本并返回 { content }。
// 失败时返回 null 并提示。模型取聊天页选择器，未选时由后端回退到默认模型。
async function requestOfficialWritingAi(params, { stream = false, onDelta } = {}) {
    if (typeof apiFetch !== 'function') {
        showToast('当前环境不支持调用模型', 'error');
        return null;
    }
    // 环境不支持流式解析时退回为一次性请求。
    const useStream = stream && typeof createBrowserSseParser === 'function';
    const payload = {
        ...params,
        model: getOfficialWritingSelectedModelId() || undefined,
        stream: useStream
    };
    let full = '';
    try {
        const res = await apiFetch('/api/apps/official-writing/ai', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(useStream ? { Accept: 'text/event-stream' } : {}) },
            body: JSON.stringify(payload)
        });
        if (!res.ok || (useStream && !res.body)) {
            const data = await res.clone().json().catch(() => ({}));
            showToast(data?.error?.message || `AI 请求失败（${res.status}）`, 'error');
            return null;
        }
        if (!useStream) {
            const data = await res.json().catch(() => null);
            if (stream && data && typeof onDelta === 'function' && data.content) onDelta(data.content);
            return data || null;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        const parser = createBrowserSseParser({
            onData(p) {
                let data = null;
                try { data = JSON.parse(p); } catch (e) { return; }
                // 服务端转发上游 OpenAI delta；同时容错归一化后的 {content:"..."} 形态。
                const chunk = data?.content ?? data?.choices?.[0]?.delta?.content ?? '';
                if (chunk) {
                    full += chunk;
                    if (typeof onDelta === 'function') onDelta(full);
                }
            }
        });
        while (!parser.isDone()) {
            const { done, value } = await reader.read();
            if (done) {
                parser.write(decoder.decode());
                parser.end();
                break;
            }
            parser.write(decoder.decode(value, { stream: true }));
        }
        return { content: full.trim() };
    } catch (e) {
        showToast(useStream ? 'AI 流式请求异常，请稍后重试' : 'AI 请求异常，请稍后重试', 'error');
        return useStream && full.trim() ? { content: full.trim() } : null;
    }
}

function buildOfficialWritingComments() {
    return officialWritingState.comments
        .map(comment => `- [${comment.target === 'draft' ? '正文稿' : '原文'} / ${comment.anchor || '全文'}] ${comment.text}`)
        .join('\n');
}

// 空正文时的提示文案：被截断（finish_reason=length）时给出可操作建议，否则给通用提示。
function officialWritingNoContentMessage(result) {
    if (result && result.finish_reason === 'length') {
        return '模型输出被截断（已达最大输出长度），请在“模型管理”调高该模型的最大输出 Token，或缩短正文/材料后重试。';
    }
    return 'AI 未返回有效内容，请调整要求后重试';
}

async function runOfficialWritingAiTask(mode, { selection } = {}) {
    if (officialWritingAiBusy) return;
    const docType = getOfficialWritingDocType();
    const requirements = getOfficialWritingRequirements();
    const comments = buildOfficialWritingComments();
    const baseText = (selection?.text || '').trim() || officialWritingState.draft.trim();
    const modeLabel = OFFICIAL_WRITING_MODES[mode] || '处理';

    setOfficialWritingAiBusy(true, `AI ${modeLabel}中…`);
    try {
        const result = await requestOfficialWritingAi({
            mode,
            docType,
            standard: getOfficialWritingStandard(),
            requirements,
            comments,
            source: officialWritingState.source || '',
            draft: officialWritingState.draft || '',
            selection: selection?.text ? { text: selection.text } : null
        });
        if (result == null) return;
        const text = String(result.content || '').trim();
        if (mode === 'review') {
            // 审校结果由后端完成 JSON 提取与校验；无结构化条目时退回整体意见。
            const items = Array.isArray(result.items) ? result.items : [];
            if (!items.length) {
                if (!text) {
                    showToast(officialWritingNoContentMessage(result), 'warning');
                    return;
                }
                addOfficialWritingSuggestion({
                    type: '审校',
                    title: 'AI 审校意见',
                    target: 'draft',
                    start: 0,
                    end: 0,
                    original: '',
                    replacement: text,
                    detail: 'AI 生成的整体审校意见。'
                });
                showToast('已生成 AI 审校意见');
                return;
            }
            items.slice(0, 20).forEach(item => {
                const original = String(item.original || '');
                let start = 0;
                let end = 0;
                if (original) {
                    const idx = officialWritingState.draft.indexOf(original);
                    if (idx >= 0) {
                        start = idx;
                        end = idx + original.length;
                    }
                }
                addOfficialWritingSuggestion({
                    type: '审校',
                    title: String(item.title || 'AI 审校建议'),
                    target: 'draft',
                    start,
                    end,
                    original,
                    replacement: String(item.suggestion || ''),
                    detail: 'AI 审校建议。'
                });
            });
            showToast(`AI 已生成 ${Math.min(items.length, 20)} 条审校建议`);
            return;
        }
        if (!text) {
            showToast(officialWritingNoContentMessage(result), 'warning');
            return;
        }
        if (mode === 'draft') {
            const insertionPoint = selection?.text ? selection.start : officialWritingState.draft.length;
            addOfficialWritingSuggestion({
                type: '起草',
                title: `${docType} AI 初稿`,
                target: 'draft',
                start: insertionPoint,
                end: selection?.text ? selection.end : insertionPoint,
                original: selection?.text || '',
                replacement: text,
                detail: 'AI 基于材料和文种生成的规范初稿。'
            });
            showToast('AI 初稿已生成，可在审改栏接受或调整');
            return;
        }
        addOfficialWritingSuggestion({
            type: modeLabel,
            title: selection?.text ? `选区${modeLabel}建议` : `全文${modeLabel}建议`,
            target: selection?.target || 'draft',
            start: selection?.text ? selection.start : 0,
            end: selection?.text ? selection.end : officialWritingState.draft.length,
            original: baseText,
            replacement: text,
            detail: 'AI 生成，可替换、插入、转为批注或保存为新版本。'
        });
        showToast(`AI ${modeLabel}建议已生成`);
    } finally {
        setOfficialWritingAiBusy(false);
    }
}

async function generateOfficialWritingSuggestion(mode = getOfficialWritingMode()) {
    syncOfficialWritingStateFromInputs();
    const baseText = officialWritingState.draft.trim();
    if (!baseText && mode !== 'draft') {
        showToast('请先输入正文，或选中文字后使用选区工具', 'warning');
        return;
    }
    await runOfficialWritingAiTask(mode);
}

function applySuggestionAction(suggestionId, action) {
    const suggestion = officialWritingState.suggestions.find(item => item.id === suggestionId);
    if (!suggestion) return;
    const textarea = getOfficialWritingTextarea(suggestion.target || 'draft');
    const start = normalizeOfficialWritingIndex(suggestion.start, textarea?.value.length || 0);
    const end = normalizeOfficialWritingIndex(suggestion.end, start);
    const replacement = suggestion.replacement || suggestion.detail || '';
    const finishSuggestion = nextStatus => {
        suggestion.status = nextStatus;
        suggestion.resolvedAt = new Date().toISOString();
        suggestion.resolvedAction = action;
    };
    if (action === 'replace' || action === 'accept') {
        replaceTextareaRange(textarea, start, end, replacement);
        finishSuggestion('accepted');
        showToast('建议已应用');
    } else if (action === 'insert') {
        replaceTextareaRange(textarea, end, end, `\n${replacement}`);
        finishSuggestion('accepted');
        showToast('建议已插入');
    } else if (action === 'comment') {
        officialWritingState.comments.unshift({
            id: `comment-${Date.now()}-${Math.random().toString(16).slice(2)}`,
            target: suggestion.target || 'draft',
            anchor: suggestion.original ? compactTextPreview(suggestion.original, 30) : '全文',
            text: replacement,
            createdAt: new Date().toISOString()
        });
        finishSuggestion('accepted');
        showToast('建议已转为批注');
    } else if (action === 'version') {
        saveOfficialWritingVersion();
        finishSuggestion('accepted');
    } else if (action === 'reject') {
        finishSuggestion('rejected');
        showToast('已拒绝建议');
    }
    saveOfficialWritingState();
    renderOfficialWritingWorkspace();
}

// 选区动作标签（具体指令由后端统一维护，避免前后端重复）。
const OFFICIAL_WRITING_SELECTION_ACTION_LABELS = {
    polish: '润色',
    compress: '压缩',
    expand: '扩写',
    formal: '公文语气'
};

async function runOfficialWritingSelectionAi(action, selection) {
    if (officialWritingAiBusy) return;
    const label = OFFICIAL_WRITING_SELECTION_ACTION_LABELS[action];
    if (!label) return;
    setOfficialWritingAiBusy(true, `AI ${label}中…`);
    try {
        const result = await requestOfficialWritingAi({
            mode: 'selection',
            action,
            docType: getOfficialWritingDocType(),
            standard: getOfficialWritingStandard(),
            requirements: getOfficialWritingRequirements(),
            selection: { text: selection.text }
        });
        if (result == null) return;
        const text = String(result.content || '').trim();
        if (!text) {
            showToast(officialWritingNoContentMessage(result), 'warning');
            return;
        }
        addOfficialWritingSuggestion({
            type: '选区修改',
            title: `选区${label}建议`,
            target: selection.target,
            start: selection.start,
            end: selection.end,
            original: selection.text,
            replacement: text,
            detail: `来自选区浮动工具条的 AI ${label}。`
        });
        showToast(`AI ${label}建议已生成`);
    } finally {
        setOfficialWritingAiBusy(false);
    }
}

function applySelectionAction(action) {
    const selection = getBestOfficialWritingSelection();
    if (!selection.text.trim()) {
        showToast('请先选中正文或原文片段', 'warning');
        return;
    }
    if (action === 'comment') {
        const target = document.getElementById('official-writing-comment-target');
        const anchor = document.getElementById('official-writing-comment-anchor');
        if (target) target.value = selection.target;
        if (anchor) anchor.value = compactTextPreview(selection.text, 40);
        openOfficialWritingDrawer('comments');
        document.getElementById('official-writing-comment-text')?.focus();
        return;
    }
    if (action === 'rewrite-diff') {
        runOfficialWritingStreamRewrite(selection);
        return;
    }
    runOfficialWritingSelectionAi(action, selection);
}

