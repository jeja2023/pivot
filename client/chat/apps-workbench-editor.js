/* global createEmptyOfficialWritingDoc, deleteOfficialWritingDocumentFromServer, scheduleOfficialWritingDocumentSave */
// ===== 多文档库管理 =====

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
    titleBreaks: 'official-writing-meta-title-breaks',
    secrecy: 'official-writing-meta-secrecy',
    urgency: 'official-writing-meta-urgency',
    issuer: 'official-writing-meta-issuer',
    issueNumber: 'official-writing-meta-issue-number',
    cc: 'official-writing-meta-cc',
    printer: 'official-writing-meta-printer',
    printDate: 'official-writing-meta-print-date',
    issuingOrg: 'official-writing-meta-issuing-org', signoff: 'official-writing-meta-signoff', issuedAt: 'official-writing-meta-issued-at'
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

function syncOfficialWritingStateFromInputs(options = {}) {
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
    saveOfficialWritingState(options);
}

function getTextCount(text) {
    return String(text || '').replace(/\s/g, '').length;
}

function getOfficialWritingWorkspaceSummary() {
    const summary = officialWritingDocument.summary(officialWritingState);
    return { ...summary, risks: getOfficialWritingComplianceRisks(), commentCount: officialWritingState.comments.length,
        versionCount: officialWritingState.versions.length, referenceCount: (officialWritingState.references || []).length,
        statusTitle: summary.status, statusDetail: summary.issues.join('；') || (summary.reviewed ? '当前正文已完成 AI 审校，请人工复核后流转。' : '可继续编辑、审校或预览导出。') };
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

// 文本事务和历史限额由 apps-workbench-history.js 统一管理。

function getOfficialWritingMaterialSegments() {
    const source = String(officialWritingState.source || '');
    return source.split(/\r?\n/)
        .map((line, index) => ({ id: `material-${index}`, text: line.trim(), index }))
        .filter(item => item.text.length >= 6)
        .slice(0, 12);
}

function computeOfficialWritingComplianceRisks() {
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
    if (!officialWritingDocument.isoDate(officialWritingState.meta?.issuedAt) && !/[0-9]{4}年[0-9]{1,2}月[0-9]{1,2}日/.test(draft) && !/\d{4}[.-]\d{1,2}[.-]\d{1,2}/.test(draft)) {
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
            hit = rule.test([draft, officialWritingState.meta?.issueNumber, officialWritingState.meta?.issuer ? '签发人：' + officialWritingState.meta.issuer : '', officialWritingState.meta?.urgency].filter(Boolean).join('\n'), ruleContext);
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

function computeOfficialWritingReferenceMatches() {
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
    PivotSafeHtml.setHtml(list, officialWritingState.comments.map(comment => `
        <article class="official-writing-comment" data-comment-id="${escapeAppsHtml(comment.id)}">
            <div>
                <strong>${comment.target === 'draft' ? '正文稿' : '原文'}</strong>
                <span>${escapeAppsHtml(comment.anchor || '全文')}</span>
            </div>
            <p>${escapeAppsHtml(comment.text)}</p>
            <button type="button" class="btn-secondary" data-comment-delete="${escapeAppsHtml(comment.id)}">删除</button>
        </article>
    `).join('') || '<div class="official-writing-empty-note">暂无批注</div>');
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
        PivotSafeHtml.setHtml(list, [...saved, ...auto].map(version => `
            <button type="button" class="official-writing-version-item" data-version-load="${escapeAppsHtml(version.id)}">
                <span>
                    <strong>${escapeAppsHtml(version.name || '未命名版本')}</strong>
                    <em>${escapeAppsHtml(version.kind)}</em>
                </span>
                <small>${escapeAppsHtml(formatVersionTime(version.createdAt))}</small>
            </button>
        `).join('') || '<div class="official-writing-empty-note">暂无版本，保存当前正文稿后可进行对比。</div>');
    }
    if (base && target) {
        const sourceOption = '<option value="source">当前原文</option>';
        const draftOption = '<option value="draft">当前正文稿</option>';
        const savedOptions = officialWritingState.versions.map((version, index) => versionOption(version, `版本 ${index + 1}`)).join('');
        PivotSafeHtml.setHtml(base, `${sourceOption}${draftOption}${savedOptions}`);
        PivotSafeHtml.setHtml(target, `${draftOption}${sourceOption}${savedOptions}`);
        base.value = Array.from(base.options).some(option => option.value === currentBaseValue) ? currentBaseValue : 'source';
        target.value = Array.from(target.options).some(option => option.value === currentTargetValue) ? currentTargetValue : 'draft';
    }
}

function renderOfficialWritingCompliance() {
    const list = document.getElementById('official-writing-compliance-list');
    if (!list) return;
    const risks = getOfficialWritingComplianceRisks();
    PivotSafeHtml.setHtml(list, risks.map(risk => `
        <article class="official-writing-check-item" data-official-writing-risk-id="${escapeAppsHtml(risk.id)}">
            <strong>${escapeAppsHtml(risk.title)}<span>${escapeAppsHtml(risk.level)}</span></strong>
            <p>${escapeAppsHtml(risk.detail)}</p>
            <em>${escapeAppsHtml(risk.suggestion || '建议核对该处内容。')}</em>
        </article>
    `).join('') || '<div class="official-writing-empty-note">未识别明显规范风险</div>');
}





function setOfficialWritingMaterialEditorOpenState(isOpen) {
    document.getElementById('official-writing-left-rail')?.classList.toggle('is-material-editor-open', Boolean(isOpen));
}

function syncOfficialWritingMaterialEditorStats(value = '') {
    setText('official-writing-material-editor-count', `${getTextCount(value)} 字`);
}

function syncOfficialWritingMaterialEditor(sourceText = officialWritingState.source, { force = false } = {}) {
    const editor = document.getElementById('official-writing-material-editor');
    if (!editor) return;
    const nextValue = String(sourceText || '');
    if (force || document.activeElement !== editor) {
        editor.value = nextValue;
    }
    syncOfficialWritingMaterialEditorStats(editor.value);
}

function openOfficialWritingMaterialEditor() {
    setOfficialWritingMaterialTab('materials');
    const card = document.getElementById('official-writing-material-editor-card');
    const currentSource = getOfficialWritingText('official-writing-source') || officialWritingState.source || '';
    if (card) card.classList.remove('hidden');
    setOfficialWritingMaterialEditorOpenState(true);
    syncOfficialWritingMaterialEditor(currentSource, { force: true });
    window.setTimeout(() => document.getElementById('official-writing-material-editor')?.focus(), 0);
}

function closeOfficialWritingMaterialEditor() {
    document.getElementById('official-writing-material-editor-card')?.classList.add('hidden');
    setOfficialWritingMaterialEditorOpenState(false);
}

function clearOfficialWritingMaterialEditor() {
    const editor = document.getElementById('official-writing-material-editor');
    if (!editor) return;
    editor.value = '';
    syncOfficialWritingMaterialEditorStats('');
    editor.focus();
}

function saveOfficialWritingMaterialEditor() {
    const editor = document.getElementById('official-writing-material-editor');
    if (!editor) return;
    const next = String(editor.value || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
    pushOfficialWritingUndoSnapshot();
    setOfficialWritingTextareaValue('source', next);
    officialWritingState.source = next;
    syncOfficialWritingStateFromInputs();
    renderOfficialWritingWorkspace();
    syncOfficialWritingMaterialEditor(next, { force: true });
    showToast(next ? '本篇材料已保存' : '本篇材料已清空');
}

function renderOfficialWritingMaterials() {
    const sourceText = String(officialWritingState.source || '');
    const segments = getOfficialWritingMaterialSegments();
    setText('official-writing-material-char-count', String(getTextCount(sourceText)));
    setText('official-writing-material-segment-count', String(segments.length));
    const preview = document.getElementById('official-writing-material-preview');
    if (preview) preview.textContent = compactTextPreview(sourceText, 120) || '暂无材料';
    syncOfficialWritingMaterialEditor(sourceText);
    const materialCards = document.getElementById('official-writing-material-card-list');
    if (materialCards) {
        PivotSafeHtml.setHtml(materialCards, segments.map(segment => `
            <article class="official-writing-material-card" data-material-id="${escapeAppsHtml(segment.id)}">
                <p>${escapeAppsHtml(compactTextPreview(segment.text, 82))}</p>
                <div>
                    <button type="button" data-material-action="insert">引用到正文</button>
                    <button type="button" data-material-action="basis">作为依据</button>
                    <button type="button" data-material-action="view">查看来源</button>
                </div>
            </article>
        `).join('') || '<div class="official-writing-empty-note">本篇材料为空。可粘贴材料或上传文件，AI 全文起草会优先参考这里的内容</div>');
    }
}

function renderOfficialWritingWorkspace() {
    updateOfficialWritingSurfaceVisibility(); resizeOfficialWritingDraftPage();
    renderOfficialWritingStats(); renderOfficialWritingSaveStatus(); renderOfficialWritingDetailHeader();
    if (isOfficialWritingDrawerOpen()) {
        const renderers = { suggestions: () => { renderOfficialWritingProofread(); renderOfficialWritingSuggestions(); }, comments: renderOfficialWritingComments,
            versions: renderOfficialWritingVersions, compliance: renderOfficialWritingCompliance, references: renderOfficialWritingReferences };
        renderers[officialWritingUiState.drawerTab]?.();
    }
    if (!officialWritingUiState.leftCollapsed) renderOfficialWritingMaterials();
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


let officialWritingComplianceCache = null;
let officialWritingReferenceCache = null;
function getOfficialWritingComplianceRisks() {
    const keys = [officialWritingState.draft, officialWritingState.source, getOfficialWritingDocType(), getOfficialWritingStandard(), JSON.stringify(officialWritingState.meta)];
    if (officialWritingComplianceCache && keys.every((key, index) => key === officialWritingComplianceCache.keys[index])) return officialWritingComplianceCache.value;
    const value = computeOfficialWritingComplianceRisks();
    officialWritingComplianceCache = { keys, value };
    return value;
}
function getOfficialWritingReferenceMatches() {
    const keys = [officialWritingState.draft, officialWritingState.source];
    if (officialWritingReferenceCache && keys.every((key, index) => key === officialWritingReferenceCache.keys[index])) return officialWritingReferenceCache.value;
    const value = computeOfficialWritingReferenceMatches();
    officialWritingReferenceCache = { keys, value };
    return value;
}
