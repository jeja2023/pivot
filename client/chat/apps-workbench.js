// 应用中心工作区：集中承载面向业务场景的轻量应用。
const PIVOT_APP_REGISTRY = [
    {
        id: 'official-writing',
        name: '公文写作',
        category: '办公写作',
        description: '辅助起草、润色、局部修改和审校公文内容。',
        icon: 'file-text',
        status: 'available',
        openMode: 'inline'
    }
];

const OFFICIAL_WRITING_MODES = {
    draft: '起草正文',
    polish: '润色优化',
    rewrite_section: '局部修改',
    review: '格式与表达审校'
};
const OFFICIAL_WRITING_DRAWER_META = {
    suggestions: ['修改建议', '生成可接受、拒绝、替换、插入或转批注的审改建议。'],
    comments: ['批注', '对原文或正文稿添加局部意见。'],
    versions: ['版本对比', '保存正文稿并查看原文、正文稿或历史版本差异。'],
    compliance: ['规范检查', '检查标题、日期、待补充项和事实依据风险。'],
    references: ['材料引用', '查看正文稿与原文材料之间的引用关系。']
};
const OFFICIAL_WRITING_MATERIAL_TAB_TO_SOURCE = {
    outline: '粘贴材料',
    materials: '粘贴材料',
    history: '历史公文',
    standards: '规范条文',
    templates: '常用模板'
};
const OFFICIAL_WRITING_TEMPLATES = {
    notice: {
        type: '通知',
        text: '关于【事项】的通知\n\n【主送机关】：\n\n为【目的/依据】，现就有关事项通知如下。\n\n一、【事项一】\n【具体内容】。\n\n二、【事项二】\n【具体内容】。\n\n三、工作要求\n请各单位结合实际抓好落实，并于【时间】前反馈有关情况。\n\n【发文单位】\n【日期】'
    },
    request: {
        type: '请示',
        text: '关于【事项】的请示\n\n【主送机关】：\n\n为【背景/依据】，现就【事项】请示如下。\n\n一、基本情况\n【说明背景、现状和必要性】。\n\n二、请示事项\n拟【具体事项】。\n\n三、有关说明\n【说明依据、条件、风险或保障措施】。\n\n妥否，请批示。\n\n【发文单位】\n【日期】'
    },
    report: {
        type: '报告',
        text: '关于【事项】的报告\n\n【主送机关】：\n\n根据【依据/要求】，现将有关情况报告如下。\n\n一、工作开展情况\n【概述主要工作】。\n\n二、主要成效\n【列明成效、数据或案例】。\n\n三、存在问题\n【说明问题和原因】。\n\n四、下一步工作\n【提出计划和措施】。\n\n【发文单位】\n【日期】'
    },
    letter: {
        type: '函',
        text: '关于【事项】的函\n\n【主送机关】：\n\n为【背景/依据】，现就【事项】函告如下。\n\n一、有关情况\n【说明事项背景和现状】。\n\n二、协商事项\n【写明需对方支持、确认或办理的事项】。\n\n三、联系方式\n【联系人及联系方式】。\n\n特此函达。\n\n【发文单位】\n【日期】'
    },
    minutes: {
        type: '会议纪要',
        text: '【会议名称】会议纪要\n\n会议时间：【时间】\n会议地点：【地点】\n主持人：【主持人】\n参会人员：【参会人员】\n\n一、会议基本情况\n【概述会议背景和议题】。\n\n二、会议议定事项\n（一）【事项一】\n【具体内容】。\n\n（二）【事项二】\n【具体内容】。\n\n三、工作要求\n【明确责任单位、完成时限和后续安排】。'
    }
};
const OFFICIAL_WRITING_STORAGE_KEY = 'pivot_official_writing_state_v1';
const APPS_ACTIVE_APP_STORAGE_KEY = 'pivot_apps_active_app';
let officialWritingState = {
    source: '',
    draft: '',
    comments: [],
    versions: [],
    suggestions: [],
    autoSaves: []
};
let officialWritingUiState = {
    viewMode: 'document',
    drawerTab: 'suggestions',
    materialTab: 'outline',
    rightCollapsed: false,
    lastSelection: null
};

function escapeAppsHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function getAppIconSvg(icon) {
    if (icon === 'file-text') {
        return `
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                <path d="M14 2v6h6"></path>
                <path d="M8 13h8"></path>
                <path d="M8 17h6"></path>
                <path d="M8 9h2"></path>
            </svg>
        `;
    }
    return `
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true">
            <rect x="3" y="3" width="7" height="7" rx="1.5"></rect>
            <rect x="14" y="3" width="7" height="7" rx="1.5"></rect>
            <rect x="3" y="14" width="7" height="7" rx="1.5"></rect>
            <rect x="14" y="14" width="7" height="7" rx="1.5"></rect>
        </svg>
    `;
}

function renderAppsGrid() {
    const grid = document.getElementById('apps-grid');
    const empty = document.getElementById('apps-empty');
    if (!grid || !empty) return;
    const apps = PIVOT_APP_REGISTRY;
    empty.classList.toggle('hidden', apps.length > 0);
    grid.innerHTML = apps.map(app => `
        <button class="app-card" type="button" data-app-id="${escapeAppsHtml(app.id)}">
            <span class="app-card-icon">${getAppIconSvg(app.icon)}</span>
            <span class="app-card-main">
                <span class="app-card-topline">
                    <strong>${escapeAppsHtml(app.name)}</strong>
                    <em>${app.status === 'available' ? '可用' : '规划中'}</em>
                </span>
                <span class="app-card-category">${escapeAppsHtml(app.category)}</span>
                <span class="app-card-desc">${escapeAppsHtml(app.description)}</span>
            </span>
        </button>
    `).join('');
}

function setAppsTitle(title, desc) {
    const titleEl = document.getElementById('apps-workspace-title');
    const descEl = document.getElementById('apps-workspace-desc');
    if (titleEl) titleEl.textContent = title;
    if (descEl) descEl.textContent = desc;
}

function getStoredAppsActiveApp() {
    try {
        return sessionStorage.getItem(APPS_ACTIVE_APP_STORAGE_KEY) || '';
    } catch (e) {
        return '';
    }
}

function setStoredAppsActiveApp(appId) {
    try {
        if (appId) {
            sessionStorage.setItem(APPS_ACTIVE_APP_STORAGE_KEY, appId);
        } else {
            sessionStorage.removeItem(APPS_ACTIVE_APP_STORAGE_KEY);
        }
    } catch (e) {
        // 浏览器禁用 sessionStorage 时仅退回应用中心首页。
    }
}

function showAppsHome() {
    setStoredAppsActiveApp('');
    document.getElementById('apps-home-view')?.classList.remove('hidden');
    document.getElementById('official-writing-view')?.classList.add('hidden');
    document.getElementById('apps-back-btn')?.classList.add('hidden');
    setAppsTitle('应用中心', '打开面向具体业务场景的工作台，常用能力会沉淀在这里，而不是挤在侧栏里。');
    renderAppsGrid();
}

function showOfficialWritingApp() {
    setStoredAppsActiveApp('official-writing');
    document.getElementById('apps-home-view')?.classList.add('hidden');
    document.getElementById('official-writing-view')?.classList.remove('hidden');
    document.getElementById('apps-back-btn')?.classList.remove('hidden');
    setAppsTitle('公文写作', '正文模式用于正式写作，对照模式用于原文和正文稿并排审改；批注、版本、规范检查和材料引用集中在右侧审改栏。');
    loadOfficialWritingState();
    hydrateOfficialWritingForm();
    applyOfficialWritingViewMode(officialWritingUiState.viewMode);
    openOfficialWritingDrawer(officialWritingUiState.drawerTab);
    renderOfficialWritingWorkspace();
}

function openRegisteredApp(appId) {
    const app = PIVOT_APP_REGISTRY.find(item => item.id === appId);
    if (!app || app.status !== 'available') return;
    if (app.id === 'official-writing') showOfficialWritingApp();
}

function loadOfficialWritingState() {
    try {
        const parsed = JSON.parse(localStorage.getItem(OFFICIAL_WRITING_STORAGE_KEY) || '{}');
        officialWritingState = {
            source: String(parsed.source || ''),
            draft: String(parsed.draft || ''),
            comments: Array.isArray(parsed.comments) ? parsed.comments : [],
            versions: Array.isArray(parsed.versions) ? parsed.versions : [],
            suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
            autoSaves: Array.isArray(parsed.autoSaves) ? parsed.autoSaves : []
        };
    } catch (e) {
        officialWritingState = { source: '', draft: '', comments: [], versions: [], suggestions: [], autoSaves: [] };
    }
}

function saveOfficialWritingState() {
    try {
        localStorage.setItem(OFFICIAL_WRITING_STORAGE_KEY, JSON.stringify(officialWritingState));
    } catch (e) {
        // 本地存储被禁用时，当前页面内状态仍可继续使用。
    }
}

function hydrateOfficialWritingForm() {
    const source = document.getElementById('official-writing-source');
    const draft = document.getElementById('official-writing-draft');
    if (source) source.value = officialWritingState.source || '';
    if (draft) draft.value = officialWritingState.draft || '';
}

function getOfficialWritingText(field) {
    return document.getElementById(field)?.value || '';
}

function syncOfficialWritingStateFromInputs() {
    officialWritingState.source = getOfficialWritingText('official-writing-source');
    officialWritingState.draft = getOfficialWritingText('official-writing-draft');
    recordOfficialWritingAutoSave();
    saveOfficialWritingState();
}

function getTextCount(text) {
    return String(text || '').replace(/\s/g, '').length;
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
    return document.getElementById('official-writing-mode')?.value || 'draft';
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

function setTextareaSelection(textarea, start, end = start) {
    if (!textarea) return;
    const safeStart = Math.max(0, Math.min(textarea.value.length, start));
    const safeEnd = Math.max(safeStart, Math.min(textarea.value.length, end));
    textarea.focus();
    textarea.setSelectionRange(safeStart, safeEnd);
}

function replaceTextareaRange(textarea, start, end, replacement) {
    if (!textarea) return;
    const before = textarea.value.slice(0, start);
    const after = textarea.value.slice(end);
    textarea.value = `${before}${replacement}${after}`;
    setTextareaSelection(textarea, start, start + replacement.length);
    syncOfficialWritingStateFromInputs();
}

function getCurrentOfficialWritingSelection() {
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

function transformOfficialWritingText(text, action) {
    const value = String(text || '').trim();
    if (!value) return '';
    if (action === 'compress') {
        return value
            .replace(/为进一步|切实|扎实|全面/g, '')
            .replace(/，/g, '，')
            .replace(/\s+/g, '')
            .slice(0, Math.max(20, Math.floor(value.length * 0.68)));
    }
    if (action === 'expand') {
        return `${value}\n\n围绕上述事项，建议进一步明确责任分工、时间节点和保障措施，确保相关工作有序推进、取得实效。`;
    }
    if (action === 'formal') {
        return value
            .replace(/我们/g, '本单位')
            .replace(/你们/g, '贵单位')
            .replace(/马上/g, '及时')
            .replace(/很/g, '较为')
            .replace(/特别/g, '重点');
    }
    if (action === 'polish') {
        return value
            .replace(/进行/g, '开展')
            .replace(/做/g, '落实')
            .replace(/得到/g, '取得')
            .replace(/问题/g, '有关问题');
    }
    return value;
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
    return risks;
}

function getOfficialWritingReferenceMatches() {
    const draft = String(officialWritingState.draft || '');
    const source = String(officialWritingState.source || '');
    if (!draft.trim() || !source.trim()) return [];
    const sourceLines = source.split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line.length >= 8);
    const matches = [];
    sourceLines.slice(0, 80).forEach(line => {
        const sample = line.length > 28 ? line.slice(0, 28) : line;
        if (sample.length >= 8 && draft.includes(sample)) {
            matches.push({
                source: compactTextPreview(line, 72),
                draft: compactTextPreview(sample, 48)
            });
        }
    });
    return matches.slice(0, 12);
}

function renderOfficialWritingStats() {
    const sourceCount = getTextCount(officialWritingState.source);
    const draftCount = getTextCount(officialWritingState.draft);
    const risks = getOfficialWritingComplianceRisks();
    setText('official-writing-source-count', `${sourceCount} 字`);
    setText('official-writing-draft-count', `${draftCount} 字`);
    setText('official-writing-comment-count', `${officialWritingState.comments.length} 条`);
    setText('official-writing-version-count', `${officialWritingState.versions.length} 个版本`);
    setText('official-writing-compliance-count', `${risks.length} 项风险`);
    setText('official-writing-comment-badge', String(officialWritingState.comments.length));
    setText('official-writing-version-badge', String(officialWritingState.versions.length));
    setText('official-writing-suggestion-badge', String(officialWritingState.suggestions.filter(item => item.status !== 'accepted' && item.status !== 'rejected').length));
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
        base.value = 'source';
        target.value = 'draft';
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
    list.innerHTML = officialWritingState.suggestions.map(suggestion => `
        <article class="official-writing-suggestion-item is-${escapeAppsHtml(suggestion.status || 'pending')}" data-suggestion-id="${escapeAppsHtml(suggestion.id)}">
            <div>
                <strong>${escapeAppsHtml(suggestion.title || '修改建议')}</strong>
                <span>${escapeAppsHtml(suggestion.type || '建议')}</span>
            </div>
            ${suggestion.original ? `<p class="official-writing-suggestion-original">${escapeAppsHtml(suggestion.original)}</p>` : ''}
            <p class="official-writing-suggestion-text">${escapeAppsHtml(suggestion.replacement || suggestion.detail || '')}</p>
            <div class="official-writing-suggestion-actions">
                <button type="button" class="btn-secondary" data-suggestion-action="replace">替换选区</button>
                <button type="button" class="btn-secondary" data-suggestion-action="insert">插入下方</button>
                <button type="button" class="btn-secondary" data-suggestion-action="comment">作为批注</button>
                <button type="button" class="btn-secondary" data-suggestion-action="version">生成版本</button>
                <button type="button" class="btn-primary" data-suggestion-action="accept">接受</button>
                <button type="button" class="btn-secondary" data-suggestion-action="reject">拒绝</button>
            </div>
        </article>
    `).join('') || '<div class="official-writing-empty-note">暂无修改建议，可从顶部 AI 操作或选区工具生成。</div>';
}

function renderOfficialWritingReferences() {
    const list = document.getElementById('official-writing-reference-list');
    const matches = getOfficialWritingReferenceMatches();
    setText('official-writing-reference-count', `${matches.length} 处引用`);
    if (!list) return;
    list.innerHTML = matches.map(match => `
        <article class="official-writing-reference-item">
            <span>原文材料</span>
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
            <button type="button" class="official-writing-outline-item" data-official-writing-jump="${item.start}" data-official-writing-target="draft">
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
    renderOfficialWritingStats();
    renderOfficialWritingComments();
    renderOfficialWritingVersions();
    renderOfficialWritingCompliance();
    renderOfficialWritingSuggestions();
    renderOfficialWritingReferences();
    renderOfficialWritingMaterials();
}

function applyOfficialWritingViewMode(mode = 'document') {
    const nextMode = ['document', 'compare'].includes(mode) ? mode : 'document';
    officialWritingUiState.viewMode = nextMode;
    const panel = document.querySelector('.official-writing-panel');
    if (panel) panel.dataset.writingViewMode = nextMode;
    document.querySelectorAll('[data-official-writing-view-mode]').forEach(button => {
        button.classList.toggle('active', button.dataset.officialWritingViewMode === nextMode);
    });
    const title = document.getElementById('official-writing-editor-title');
    const subtitle = document.getElementById('official-writing-editor-subtitle');
    if (title) title.textContent = nextMode === 'compare' ? '对照审改' : '正文编辑';
    if (subtitle) {
        subtitle.textContent = nextMode === 'compare'
            ? '左侧原文、右侧正文稿，适合审改和差异核对。'
            : '单页公文编辑器，优先保留正文空间。';
    }
    renderOfficialWritingStats();
}

function openOfficialWritingDrawer(view = 'suggestions') {
    const drawer = document.getElementById('official-writing-drawer');
    const shell = document.querySelector('.official-writing-shell');
    const title = document.getElementById('official-writing-drawer-title');
    const desc = document.getElementById('official-writing-drawer-desc');
    const tab = OFFICIAL_WRITING_DRAWER_META[view] ? view : 'suggestions';
    if (!drawer) return;
    officialWritingUiState.drawerTab = tab;
    officialWritingUiState.rightCollapsed = false;
    drawer.classList.remove('hidden');
    shell?.classList.remove('is-drawer-hidden');
    drawer.setAttribute('aria-hidden', 'false');
    Object.keys(OFFICIAL_WRITING_DRAWER_META).forEach(key => {
        document.getElementById(`official-writing-${key}-drawer`)?.classList.toggle('hidden', key !== tab);
    });
    document.querySelectorAll('[data-official-writing-drawer-tab]').forEach(button => {
        button.classList.toggle('active', button.dataset.officialWritingDrawerTab === tab);
    });
    const meta = OFFICIAL_WRITING_DRAWER_META[tab];
    if (title) title.textContent = meta[0];
    if (desc) desc.textContent = meta[1];
    renderOfficialWritingStats();
    renderOfficialWritingCompliance();
    renderOfficialWritingSuggestions();
    renderOfficialWritingReferences();
    updateOfficialWritingDrawerToggleLabel();
}

function closeOfficialWritingDrawer() {
    const drawer = document.getElementById('official-writing-drawer');
    const shell = document.querySelector('.official-writing-shell');
    if (!drawer) return;
    drawer.classList.add('hidden');
    shell?.classList.add('is-drawer-hidden');
    drawer.setAttribute('aria-hidden', 'true');
    officialWritingUiState.rightCollapsed = true;
    document.querySelectorAll('[data-official-writing-drawer-tab]').forEach(button => button.classList.remove('active'));
    updateOfficialWritingDrawerToggleLabel();
}

function toggleOfficialWritingDrawer() {
    const drawer = document.getElementById('official-writing-drawer');
    if (!drawer) return;
    if (drawer.classList.contains('hidden')) {
        officialWritingUiState.rightCollapsed = false;
        openOfficialWritingDrawer(officialWritingUiState.drawerTab || 'suggestions');
    } else {
        closeOfficialWritingDrawer();
    }
}

function updateOfficialWritingDrawerToggleLabel() {
    setText('official-writing-toggle-right-btn', officialWritingUiState.rightCollapsed ? '显示审改栏' : '隐藏审改栏');
}

function closeOfficialWritingCommandMenu() {
    const menu = document.getElementById('official-writing-command-more-menu');
    if (menu) menu.open = false;
}

function setOfficialWritingMaterialTab(tab) {
    const nextTab = OFFICIAL_WRITING_MATERIAL_TAB_TO_SOURCE[tab] ? tab : 'materials';
    officialWritingUiState.materialTab = nextTab;
    document.querySelectorAll('[data-official-writing-material-tab]').forEach(button => {
        button.classList.toggle('active', button.dataset.officialWritingMaterialTab === nextTab);
    });
    ['outline', 'materials', 'history', 'standards', 'templates'].forEach(key => {
        document.getElementById(`official-writing-${key}-panel`)?.classList.toggle('hidden', key !== nextTab);
    });
    const select = document.getElementById('official-writing-material-source');
    if (select) select.value = OFFICIAL_WRITING_MATERIAL_TAB_TO_SOURCE[nextTab];
}

function setOfficialWritingMaterialSource(source) {
    const entry = Object.entries(OFFICIAL_WRITING_MATERIAL_TAB_TO_SOURCE).find(([, value]) => value === source);
    setOfficialWritingMaterialTab(entry?.[0] || 'materials');
}

function getSelectionFromTextarea(textarea) {
    if (!textarea) return '';
    const start = Number(textarea.selectionStart || 0);
    const end = Number(textarea.selectionEnd || 0);
    return start === end ? '' : textarea.value.slice(start, end).trim();
}

function captureSelection(fieldId, targetId) {
    const selection = getSelectionFromTextarea(document.getElementById(fieldId));
    const target = document.getElementById(targetId);
    if (target) target.value = selection || '全文';
    openOfficialWritingDrawer('comments');
}

function addOfficialWritingComment() {
    const target = document.getElementById('official-writing-comment-target')?.value || 'source';
    const anchor = document.getElementById('official-writing-comment-anchor')?.value.trim() || '全文';
    const textEl = document.getElementById('official-writing-comment-text');
    const text = textEl?.value.trim() || '';
    if (!text) return showToast('请先填写批注内容', 'warning');
    officialWritingState.comments.unshift({
        id: `comment-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        target,
        anchor,
        text,
        createdAt: new Date().toISOString()
    });
    if (textEl) textEl.value = '';
    saveOfficialWritingState();
    renderOfficialWritingWorkspace();
}

function deleteOfficialWritingComment(commentId) {
    officialWritingState.comments = officialWritingState.comments.filter(comment => comment.id !== commentId);
    saveOfficialWritingState();
    renderOfficialWritingWorkspace();
}

function addOfficialWritingSuggestion(payload) {
    officialWritingState.suggestions.unshift({
        id: `suggestion-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        status: 'pending',
        createdAt: new Date().toISOString(),
        ...payload
    });
    saveOfficialWritingState();
    openOfficialWritingDrawer('suggestions');
    renderOfficialWritingWorkspace();
}

function saveOfficialWritingVersion(stage = '') {
    syncOfficialWritingStateFromInputs();
    if (!officialWritingState.draft.trim() && !officialWritingState.source.trim()) {
        showToast('暂无正文或材料，无法保存版本', 'warning');
        return;
    }
    const nameInput = document.getElementById('official-writing-version-name');
    const stageLabel = typeof stage === 'string' ? stage.trim() : '';
    const name = nameInput?.value.trim() || (stageLabel ? `${stageLabel} ${officialWritingState.versions.length + 1}` : `正文稿 ${officialWritingState.versions.length + 1}`);
    officialWritingState.versions.unshift({
        id: `version-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        name,
        stage: stageLabel || '普通版本',
        source: officialWritingState.source,
        draft: officialWritingState.draft,
        createdAt: new Date().toISOString()
    });
    if (nameInput) nameInput.value = '';
    saveOfficialWritingState();
    renderOfficialWritingWorkspace();
    showToast(stageLabel ? `${stageLabel}已生成` : '版本已保存');
}

function loadOfficialWritingVersion(versionId) {
    const version = [...officialWritingState.versions, ...(officialWritingState.autoSaves || [])].find(item => item.id === versionId);
    if (!version) return;
    const draft = document.getElementById('official-writing-draft');
    if (draft) draft.value = version.draft || '';
    syncOfficialWritingStateFromInputs();
    renderOfficialWritingWorkspace();
    showToast('已载入版本到正文稿');
}

function getVersionCompareText(value) {
    if (value === 'source') return officialWritingState.source || '';
    if (value === 'draft') return officialWritingState.draft || '';
    const version = officialWritingState.versions.find(item => item.id === value);
    return version?.draft || '';
}

function buildLineDiff(leftText, rightText) {
    const left = String(leftText || '').split(/\n{2,}/);
    const right = String(rightText || '').split(/\n{2,}/);
    const max = Math.max(left.length, right.length);
    const rows = [];
    let changed = 0;
    for (let index = 0; index < max; index += 1) {
        const before = left[index] ?? '';
        const after = right[index] ?? '';
        if (before === after) {
            rows.push({ type: 'same', before, after, line: index + 1 });
        } else {
            changed += 1;
            const type = before && after ? 'changed' : before ? 'removed' : 'added';
            rows.push({ type, before, after, line: index + 1 });
        }
    }
    return { rows, changed, total: max };
}

function compareOfficialWritingVersions() {
    syncOfficialWritingStateFromInputs();
    const left = getVersionCompareText(document.getElementById('official-writing-base-version')?.value || 'source');
    const right = getVersionCompareText(document.getElementById('official-writing-target-version')?.value || 'draft');
    const diff = buildLineDiff(left, right);
    const summary = document.getElementById('official-writing-diff-summary');
    const result = document.getElementById('official-writing-diff-result');
    if (summary) summary.textContent = `共 ${diff.total} 段，${diff.changed} 段存在差异`;
    if (!result) return;
    result.innerHTML = diff.rows.map(row => `
        <div class="official-writing-diff-row is-${row.type}">
            <span>段 ${row.line}</span>
            <p>${escapeAppsHtml(row.before || ' ')}</p>
            <p>${escapeAppsHtml(row.after || ' ')}</p>
        </div>
    `).join('');
}

async function copyAppsText(text) {
    if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return;
    }
    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.style.position = 'fixed';
    textArea.style.left = '-999999px';
    textArea.style.top = '-999999px';
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    const success = document.execCommand('copy');
    textArea.remove();
    if (!success) throw new Error('copy failed');
}

function downloadOfficialWritingFile(filename, content, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function crc32String(value) {
    let crc = -1;
    for (let index = 0; index < value.length; index += 1) {
        crc ^= value.charCodeAt(index);
        for (let bit = 0; bit < 8; bit += 1) {
            crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
        }
    }
    return (crc ^ -1) >>> 0;
}

function uint16(value) {
    return String.fromCharCode(value & 0xff, (value >>> 8) & 0xff);
}

function uint32(value) {
    return String.fromCharCode(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
}

function encodeZipText(value) {
    return unescape(encodeURIComponent(value));
}

function buildZip(entries) {
    let offset = 0;
    const localParts = [];
    const centralParts = [];
    entries.forEach(entry => {
        const name = encodeZipText(entry.name);
        const data = encodeZipText(entry.content);
        const crc = crc32String(data);
        const size = data.length;
        const localHeader = [
            uint32(0x04034b50), uint16(20), uint16(0), uint16(0), uint16(0), uint16(0),
            uint32(crc), uint32(size), uint32(size), uint16(name.length), uint16(0), name
        ].join('');
        localParts.push(localHeader, data);
        centralParts.push([
            uint32(0x02014b50), uint16(20), uint16(20), uint16(0), uint16(0), uint16(0), uint16(0),
            uint32(crc), uint32(size), uint32(size), uint16(name.length), uint16(0), uint16(0),
            uint16(0), uint16(0), uint32(0), uint32(offset), name
        ].join(''));
        offset += localHeader.length + data.length;
    });
    const central = centralParts.join('');
    const end = [
        uint32(0x06054b50), uint16(0), uint16(0), uint16(entries.length), uint16(entries.length),
        uint32(central.length), uint32(offset), uint16(0)
    ].join('');
    return localParts.join('') + central + end;
}

function buildOfficialWritingDocxBlob() {
    const paragraphs = splitOfficialWritingParagraphs(officialWritingState.draft || '')
        .map((item, index) => {
            const text = escapeAppsHtml(item.text);
            const style = index === 0 ? '<w:pPr><w:jc w:val="center"/><w:rPr><w:b/><w:sz w:val="44"/></w:rPr></w:pPr>' : '<w:pPr><w:firstLineChars w:val="200"/></w:pPr>';
            return `<w:p>${style}<w:r><w:t>${text}</w:t></w:r></w:p>`;
        })
        .join('');
    const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>${paragraphs}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="2097" w:right="1587" w:bottom="1984" w:left="1474"/></w:sectPr></w:body>
</w:document>`;
    const zip = buildZip([
        {
            name: '[Content_Types].xml',
            content: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
        },
        {
            name: '_rels/.rels',
            content: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
        },
        {
            name: 'word/document.xml',
            content: documentXml
        }
    ]);
    const bytes = new Uint8Array(zip.length);
    for (let index = 0; index < zip.length; index += 1) bytes[index] = zip.charCodeAt(index) & 0xff;
    return new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
}

function downloadOfficialWritingBlob(filename, blob) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function buildOfficialWritingExportHtml() {
    const title = getOfficialWritingDocType();
    const body = escapeAppsHtml(officialWritingState.draft || '')
        .split(/\r?\n/)
        .map(line => line.trim() ? `<p>${line}</p>` : '<p>&nbsp;</p>')
        .join('');
    return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${escapeAppsHtml(title)}</title>
<style>
@page { size: A4; margin: 3.7cm 2.8cm 3.5cm 2.6cm; }
body { font-family: FangSong, SimSun, serif; color: #111827; line-height: 1.8; font-size: 16pt; }
p { margin: 0 0 0.65em; text-indent: 2em; }
p:first-child { text-align: center; text-indent: 0; font-family: SimHei, sans-serif; font-size: 22pt; font-weight: 700; margin-bottom: 1.2em; }
</style>
</head>
<body>${body}</body>
</html>`;
}

function buildOfficialWritingPrompt() {
    syncOfficialWritingStateFromInputs();
    const docType = getOfficialWritingDocType();
    const mode = getOfficialWritingMode();
    const modeLabel = OFFICIAL_WRITING_MODES[mode] || '起草正文';
    const requirements = getOfficialWritingRequirements();
    const comments = officialWritingState.comments.map(comment => `- [${comment.target === 'draft' ? '正文稿' : '原文'} / ${comment.anchor || '全文'}] ${comment.text}`).join('\n');
    return [
        `请作为公文写作助手，基于编辑器内容完成「${docType}」的「${modeLabel}」。`,
        '',
        `规范库：${getOfficialWritingStandard()}`,
        `材料来源：${getOfficialWritingMaterialSource()}`,
        '',
        '处理要求：',
        '- 使用规范、准确、克制的公文语体。',
        '- 不编造单位、时间、数据和事实；缺失信息请用【待补充】标注。',
        '- 优先保留原有事实信息，优化结构、语气和表达。',
        mode === 'rewrite_section' ? '- 重点处理用户标注或批注涉及的局部内容。' : '',
        mode === 'review' ? '- 按“问题 / 建议 / 示例修改”输出审校意见。' : '',
        requirements ? `- 用户补充要求：${requirements}` : '',
        '',
        '原文：',
        officialWritingState.source || '【暂无原文】',
        '',
        '当前正文稿：',
        officialWritingState.draft || '【暂无正文稿】',
        comments ? '\n批注：' : '',
        comments
    ].filter(line => line !== '').join('\n');
}

async function copyOfficialWritingPrompt() {
    const prompt = buildOfficialWritingPrompt();
    try {
        await copyAppsText(prompt);
        showToast('提示词已复制');
    } catch (e) {
        showToast('复制失败，请手动选择内容复制', 'error');
    }
}

async function copyOfficialWritingDraft() {
    syncOfficialWritingStateFromInputs();
    try {
        await copyAppsText(officialWritingState.draft || '');
        showToast('正文稿已复制');
    } catch (e) {
        showToast('复制失败，请手动选择内容复制', 'error');
    }
}

function sendOfficialWritingToChat() {
    const prompt = buildOfficialWritingPrompt();
    window.showMainWorkspace?.('chat');
    const input = document.getElementById('user-input');
    if (!input) return;
    input.value = prompt;
    window.resizeUserInput?.();
    input.focus();
    showToast('已带入聊天，请确认后发送');
}

function generateOfficialWritingSuggestion(mode = getOfficialWritingMode()) {
    syncOfficialWritingStateFromInputs();
    const selection = getBestOfficialWritingSelection();
    const baseText = selection.text.trim() || officialWritingState.draft.trim();
    if (!baseText && mode !== 'draft') {
        showToast('请先输入正文或选中一段文字', 'warning');
        return;
    }
    if (mode === 'draft') {
        const templateKey = {
            通知: 'notice',
            请示: 'request',
            报告: 'report',
            函: 'letter',
            会议纪要: 'minutes'
        }[getOfficialWritingDocType()] || 'notice';
        addOfficialWritingSuggestion({
            type: '起草',
            title: `${getOfficialWritingDocType()}结构化初稿`,
            target: 'draft',
            start: selection.start || officialWritingState.draft.length,
            end: selection.end || officialWritingState.draft.length,
            original: selection.text || '',
            replacement: OFFICIAL_WRITING_TEMPLATES[templateKey].text,
            detail: '基于当前文种生成标题、主送机关、正文、落款和日期占位。'
        });
        return;
    }
    if (mode === 'review') {
        getOfficialWritingComplianceRisks().forEach(risk => {
            addOfficialWritingSuggestion({
                type: '审校',
                title: risk.title,
                target: 'draft',
                start: risk.start,
                end: risk.end,
                original: officialWritingState.draft.slice(risk.start, risk.end),
                replacement: risk.suggestion || risk.detail,
                detail: risk.detail
            });
        });
        if (!getOfficialWritingComplianceRisks().length) showToast('当前未识别明显审校问题');
        return;
    }
    const action = mode === 'rewrite_section' ? 'formal' : 'polish';
    const replacement = transformOfficialWritingText(baseText, action);
    addOfficialWritingSuggestion({
        type: OFFICIAL_WRITING_MODES[mode] || '修改',
        title: selection.text ? '选区修改建议' : '全文修改建议',
        target: selection.target || 'draft',
        start: selection.text ? selection.start : 0,
        end: selection.text ? selection.end : officialWritingState.draft.length,
        original: baseText,
        replacement,
        detail: '可选择替换、插入、转为批注或保存为新版本。'
    });
}

function applySuggestionAction(suggestionId, action) {
    const suggestion = officialWritingState.suggestions.find(item => item.id === suggestionId);
    if (!suggestion) return;
    const textarea = getOfficialWritingTextarea(suggestion.target || 'draft');
    const start = normalizeOfficialWritingIndex(suggestion.start, textarea?.value.length || 0);
    const end = normalizeOfficialWritingIndex(suggestion.end, start);
    const replacement = suggestion.replacement || suggestion.detail || '';
    if (action === 'replace' || action === 'accept') {
        replaceTextareaRange(textarea, start, end, replacement);
        suggestion.status = 'accepted';
        showToast('建议已应用');
    } else if (action === 'insert') {
        replaceTextareaRange(textarea, end, end, `\n${replacement}`);
        suggestion.status = 'accepted';
        showToast('建议已插入');
    } else if (action === 'comment') {
        officialWritingState.comments.unshift({
            id: `comment-${Date.now()}-${Math.random().toString(16).slice(2)}`,
            target: suggestion.target || 'draft',
            anchor: suggestion.original ? compactTextPreview(suggestion.original, 30) : '全文',
            text: replacement,
            createdAt: new Date().toISOString()
        });
        suggestion.status = 'accepted';
        showToast('建议已转为批注');
    } else if (action === 'version') {
        saveOfficialWritingVersion();
        suggestion.status = 'accepted';
    } else if (action === 'reject') {
        suggestion.status = 'rejected';
        showToast('已拒绝建议');
    }
    saveOfficialWritingState();
    renderOfficialWritingWorkspace();
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
    addOfficialWritingSuggestion({
        type: '选区修改',
        title: `选区${action === 'formal' ? '公文语气' : action === 'compress' ? '压缩' : action === 'expand' ? '扩写' : '润色'}建议`,
        target: selection.target,
        start: selection.start,
        end: selection.end,
        original: selection.text,
        replacement: transformOfficialWritingText(selection.text, action),
        detail: '来自选区浮动工具条。'
    });
}

function exportOfficialWriting(type) {
    syncOfficialWritingStateFromInputs();
    const text = officialWritingState.draft || '';
    if (!text.trim()) {
        showToast('正文为空，无法导出', 'warning');
        return;
    }
    const safeType = getOfficialWritingDocType().replace(/[\\/:*?"<>|]/g, '');
    const html = buildOfficialWritingExportHtml();
    if (type === 'pdf') {
        const win = window.open('', '_blank', 'noopener,noreferrer');
        if (!win) {
            showToast('浏览器阻止了打印窗口，请允许弹窗后重试', 'warning');
            return;
        }
        win.document.write(html);
        win.document.close();
        win.focus();
        win.print();
        showToast('已打开打印窗口，可另存为 PDF');
        return;
    }
    downloadOfficialWritingBlob(`${safeType || '公文'}-${Date.now()}.docx`, buildOfficialWritingDocxBlob());
    showToast('已按公文版式导出 DOCX');
}

function jumpOfficialWritingRange(target, start, end = start) {
    applyOfficialWritingViewMode(target === 'source' ? 'compare' : officialWritingUiState.viewMode);
    const textarea = getOfficialWritingTextarea(target);
    setTextareaSelection(textarea, start, end);
}

function syncOfficialWritingSourceToDraft() {
    const source = document.getElementById('official-writing-source')?.value || '';
    const draft = document.getElementById('official-writing-draft');
    if (draft) draft.value = source;
    syncOfficialWritingStateFromInputs();
    renderOfficialWritingWorkspace();
}

function resetOfficialWritingForm() {
    const ids = [
        'official-writing-source',
        'official-writing-draft',
        'official-writing-requirements',
        'official-writing-comment-anchor',
        'official-writing-comment-text',
        'official-writing-version-name'
    ];
    ids.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
    const type = document.getElementById('official-writing-type');
    const mode = document.getElementById('official-writing-mode');
    const standard = document.getElementById('official-writing-standard');
    const materialSource = document.getElementById('official-writing-material-source');
    if (type) type.value = '通知';
    if (mode) mode.value = 'draft';
    if (standard) standard.value = '通用公文规范';
    if (materialSource) materialSource.value = '粘贴材料';
    officialWritingState = { source: '', draft: '', comments: [], versions: [], suggestions: [], autoSaves: [] };
    saveOfficialWritingState();
    setOfficialWritingMaterialTab('materials');
    applyOfficialWritingViewMode('document');
    openOfficialWritingDrawer('suggestions');
    renderOfficialWritingWorkspace();
}

function runOfficialWritingMode(mode) {
    const select = document.getElementById('official-writing-mode');
    if (select && OFFICIAL_WRITING_MODES[mode]) select.value = mode;
    if (mode === 'review') {
        syncOfficialWritingStateFromInputs();
        renderOfficialWritingWorkspace();
        openOfficialWritingDrawer('compliance');
        const risks = getOfficialWritingComplianceRisks();
        showToast(risks.length ? `已识别 ${risks.length} 项规范风险` : '当前未识别明显审校问题');
        return;
    }
    generateOfficialWritingSuggestion(mode);
}

function appendOfficialWritingRequirement(text) {
    const input = document.getElementById('official-writing-requirements');
    if (!input) return;
    const value = input.value.trim();
    input.value = value ? `${value}；${text}` : text;
    renderOfficialWritingWorkspace();
    showToast('已加入修改要求');
}

function applyOfficialWritingTemplate(templateId) {
    const template = OFFICIAL_WRITING_TEMPLATES[templateId];
    if (!template) return;
    const type = document.getElementById('official-writing-type');
    const draft = document.getElementById('official-writing-draft');
    if (type) type.value = template.type;
    if (draft && !draft.value.trim()) {
        draft.value = template.text;
    } else if (draft) {
        draft.value = `${draft.value.trim()}\n\n${template.text}`;
    }
    syncOfficialWritingStateFromInputs();
    applyOfficialWritingViewMode('document');
    renderOfficialWritingWorkspace();
    showToast('模板已加入正文稿');
}

function focusOfficialWritingSource() {
    applyOfficialWritingViewMode('compare');
    const source = document.getElementById('official-writing-source');
    source?.focus();
}

function handleOfficialWritingMaterialAction(materialId, action) {
    const segment = getOfficialWritingMaterialSegments().find(item => item.id === materialId);
    if (!segment) return;
    const draft = getOfficialWritingTextarea('draft');
    if (action === 'insert') {
        const insert = `\n\n据材料显示，${segment.text}`;
        const start = draft?.selectionEnd || draft?.value.length || 0;
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
    document.getElementById('official-writing-drawer-close')?.addEventListener('click', closeOfficialWritingDrawer);
    document.getElementById('official-writing-drawer-open-btn')?.addEventListener('click', () => {
        openOfficialWritingDrawer(officialWritingUiState.drawerTab || 'suggestions');
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
    document.getElementById('official-writing-save-version-top-btn')?.addEventListener('click', saveOfficialWritingVersion);
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
    document.getElementById('official-writing-copy-draft-btn')?.addEventListener('click', () => {
        copyOfficialWritingDraft();
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
    document.getElementById('official-writing-mode')?.addEventListener('change', renderOfficialWritingWorkspace);
    document.getElementById('official-writing-type')?.addEventListener('change', renderOfficialWritingWorkspace);
    document.getElementById('official-writing-requirements')?.addEventListener('input', renderOfficialWritingWorkspace);
    ['official-writing-source', 'official-writing-draft'].forEach(id => {
        const editor = document.getElementById(id);
        editor?.addEventListener('input', () => {
            syncOfficialWritingStateFromInputs();
            renderOfficialWritingWorkspace();
        });
        editor?.addEventListener('select', handleOfficialWritingSelectionChange);
        editor?.addEventListener('mouseup', handleOfficialWritingSelectionChange);
        editor?.addEventListener('keyup', handleOfficialWritingSelectionChange);
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
        if (loadVersion) loadOfficialWritingVersion(loadVersion.dataset.versionLoad);
    });
}

window.openAppsWorkbench = function() {
    window.showMainWorkspace?.('apps');
    bindAppsWorkbenchEvents();
    if (getStoredAppsActiveApp() === 'official-writing') {
        showOfficialWritingApp();
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
