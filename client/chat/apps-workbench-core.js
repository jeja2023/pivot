// 应用中心工作区：集中承载面向业务场景的轻量应用。
const PIVOT_APP_REGISTRY = [
    {
        id: 'official-writing',
        name: '公文写作',
        category: '办公写作',
        description: '辅助起草、润色、局部修改和审校公文内容，支持发文要素与红头版记规范排版。',
        icon: 'file-text',
        tags: ['规范起草', '红头版头', '合规审校'],
        status: 'available',
        openMode: 'inline'
    },
    {
        id: 'data-analysis',
        name: '数据分析',
        category: '数据工具',
        description: '上传表格数据，完成字段画像、数据比对、统计分析、图表生成和 AI 辅助洞察。',
        icon: 'bar-chart',
        tags: ['字段画像', '数据透视', 'AI 图表洞察'],
        status: 'available',
        openMode: 'inline'
    },
    {
        id: 'regulations',
        name: '法规查询',
        category: '法规检索',
        description: '查询法规制度文档，按条文分级检索、查看历史版本，并基于命中条文进行智能问答。',
        icon: 'book-open',
        tags: ['条文检索', '版本追溯', '依据问答'],
        status: 'available',
        openMode: 'inline'
    },
    {
        id: 'ocr',
        name: '文字识别',
        category: '文档处理',
        description: '上传图片或扫描件 PDF，识别正文、复核低置信度页面并导出高精结构化结果。',
        icon: 'scan-text',
        tags: ['双栏复核', '表格提取', '结构化导出'],
        status: 'available',
        openMode: 'inline'
    },
    {
        id: 'pdf-tools',
        name: 'PDF 工具',
        category: '文档处理',
        description: '合并、拆分、旋转、删除、重排 PDF 页面，并支持高精度批量导出图片或文本。',
        icon: 'file-cog',
        tags: ['页面重排', '快速拆合', '图文提取'],
        status: 'available',
        openMode: 'inline'
    }
];

const OFFICIAL_WRITING_MODES = {
    draft: '起草正文',
    polish: '润色优化',
    rewrite_section: '全文改写',
    review: '格式与表达审校'
};
const OFFICIAL_WRITING_DRAWER_META = {
    suggestions: ['审校建议', '汇总基础校对和 AI 审校产生的可应用建议。'],
    elements: ['发文要素', '填写版头（密级、紧急程度、发文字号、签发人）和版记（抄送、印发机关、印发日期），导出时自动排版。'],
    comments: ['批注', '对原文或正文稿添加局部意见。'],
    versions: ['版本对比', '保存正文稿并查看原文、正文稿或历史版本差异。'],
    compliance: ['规范检查', '检查标题、日期、待补充项和事实依据风险。'],
    references: ['材料引用', '查看正文稿与原文材料之间的引用关系。']
};
const OFFICIAL_WRITING_MATERIAL_TAB_TO_SOURCE = {
    materials: '粘贴材料',
    history: '知识库',
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
    },
    announcement: {
        type: '通报',
        text: '关于【事项】的通报\n\n【主送机关】：\n\n现将有关情况通报如下。\n\n一、主要情况\n【说明事实经过、背景和结果】。\n\n二、处理情况\n【说明已采取措施、阶段结论或典型做法】。\n\n三、工作要求\n【写明后续要求、注意事项或学习借鉴要点】。\n\n【发文单位】\n【日期】'
    },
    opinion: {
        type: '意见',
        text: '关于【事项】的意见\n\n【主送机关】：\n\n为【目的/依据】，现提出如下意见。\n\n一、总体要求\n【说明指导思想、基本原则和目标要求】。\n\n二、主要内容\n【分条写明工作举措、制度安排或政策要求】。\n\n三、组织实施\n【明确责任分工、推进步骤和保障措施】。\n\n【发文单位】\n【日期】'
    },
    general: {
        type: '其他公文',
        text: '【公文标题】\n\n【主送机关】：\n\n【正文第一部分】\n【正文第二部分】\n【正文第三部分】\n\n【发文单位】\n【日期】'
    }
};
const OFFICIAL_WRITING_TYPE_TO_TEMPLATE_KEY = {
    通知: 'notice',
    请示: 'request',
    报告: 'report',
    函: 'letter',
    会议纪要: 'minutes',
    通报: 'announcement',
    意见: 'opinion',
    其他公文: 'general'
};
const OFFICIAL_WRITING_STORAGE_KEY = 'pivot_official_writing_state_v1';
const OFFICIAL_WRITING_LIBRARY_KEY = 'pivot_official_writing_library_v2';
const OFFICIAL_WRITING_DOCUMENTS_API = `${API_BASE}/apps/official-writing/documents`;
const APPS_ACTIVE_APP_STORAGE_KEY = 'pivot_apps_active_app';
let appsWorkbenchFocus = null;
let appsWorkbenchRetryApp = '';
const OFFICIAL_WRITING_DEFAULT_FORM_STATE = {
    docType: '通知',
    mode: 'draft',
    standard: '通用公文规范',
    materialSource: '粘贴材料',
    requirements: ''
};
const OFFICIAL_WRITING_REQUIREMENT_PLACEHOLDERS = {
    draft: '起草要求、结构、字数或重点',
    polish: '全文润色方向，如更正式、更精炼',
    rewrite_section: '全文改写要求，如调整结构、压缩篇幅',
    review: '审校重点，如格式、表达、规范性'
};

function normalizeOfficialWritingMode(mode) {
    const key = String(mode || '');
    return OFFICIAL_WRITING_MODES[key] ? key : OFFICIAL_WRITING_DEFAULT_FORM_STATE.mode;
}

// 发文要素（版头 + 版记）默认值。版头：密级、紧急程度、发文字号、签发人；版记：抄送、印发机关、印发日期。
const OFFICIAL_WRITING_DEFAULT_META = {
    secrecy: '',
    urgency: '',
    issuer: '',
    issueNumber: '',
    cc: '',
    printer: '',
    printDate: ''
};

// 各规范库对应的附加检查规则。通用规则（标题、占位、日期、引用、语气）始终生效，
// 这里定义的是不同规范库特有的硬性要素，使“规范库”选择真正驱动检查结果。
const OFFICIAL_WRITING_STANDARD_RULES = {
    党政机关公文格式: [
        {
            id: 'gov-issue-number',
            level: '中',
            title: '缺少发文字号',
            detail: '党政机关正式公文一般应包含发文字号，例如“〔2026〕5号”。',
            suggestion: '建议在标题下方或版头补充发文字号，如“XX〔2026〕X号”。',
            test: text => !/〔\s*\d{4}\s*〕\s*\d+\s*号/.test(text) && !/\[\s*\d{4}\s*\]\s*\d+\s*号/.test(text)
        },
        {
            id: 'gov-issuer',
            level: '低',
            title: '建议核对签发人',
            detail: '上行文（如请示、报告）应在版头标注签发人姓名。',
            suggestion: '上行文请在版头右上方标注“签发人：XXX”。',
            test: text => /请示|报告/.test(text) && !/签发人[:：]/.test(text)
        },
        {
            id: 'gov-urgency',
            level: '提示',
            title: '未标注紧急程度',
            detail: '如属紧急公文，应标注“特急”“加急”等紧急程度。',
            suggestion: '紧急公文可在版头标注“特急”或“加急”，非紧急可忽略。',
            test: text => !/特急|加急|紧急/.test(text)
        }
    ],
    会议纪要规范: [
        {
            id: 'minutes-meta',
            level: '中',
            title: '会议要素不完整',
            detail: '会议纪要应包含时间、地点、主持人、参会人员等基本要素。',
            suggestion: '建议补齐“会议时间 / 会议地点 / 主持人 / 参会人员”等要素。',
            test: text => {
                const hits = ['时间', '地点', '主持', '参会', '出席'].filter(key => text.includes(key)).length;
                return hits < 2;
            }
        },
        {
            id: 'minutes-decision',
            level: '中',
            title: '缺少议定事项',
            detail: '会议纪要应明确写出会议议定或决定事项。',
            suggestion: '建议增加“会议议定事项”一节，逐条列明决定内容。',
            test: text => !/议定|决定|商定|研究决定|会议认为/.test(text)
        }
    ],
    单位内部规范: [
        {
            id: 'internal-issuer',
            level: '低',
            title: '缺少落款单位',
            detail: '内部行文也应在文末标注发文单位，便于归档和追溯。',
            suggestion: '建议在正文末尾补充发文单位名称。',
            test: (text, ctx) => {
                const tail = text.slice(-60);
                return !/(单位|部门|科室|中心|办公室|公司|集团|党委|支部)/.test(tail) && ctx.draftLength > 60;
            }
        }
    ]
};

function getOfficialWritingStandardRules(standard) {
    return OFFICIAL_WRITING_STANDARD_RULES[standard] || [];
}

function createOfficialWritingState(overrides = {}) {
    return {
        ...OFFICIAL_WRITING_DEFAULT_FORM_STATE,
        source: '',
        draft: '',
        meta: { ...OFFICIAL_WRITING_DEFAULT_META },
        comments: [],
        versions: [],
        suggestions: [],
        autoSaves: [],
        ...overrides
    };
}

// 多文档库：每篇公文为一条记录，包含独立的正文、原文、版本、批注、建议、发文要素等。
// 文档库结构：{ activeId, docs: [{ id, title, updatedAt, state }] }
let officialWritingLibrary = { activeId: '', docs: [] };
const officialWritingSaveTimers = new Map();
const officialWritingDeletedDocumentIds = new Set();
let officialWritingLoadSequence = 0;
let officialWritingLegacyStoragePurged = false;

function normalizeOfficialWritingMeta(meta) {
    const safe = meta && typeof meta === 'object' ? meta : {};
    return {
        secrecy: String(safe.secrecy || ''),
        urgency: String(safe.urgency || ''),
        issuer: String(safe.issuer || ''),
        issueNumber: String(safe.issueNumber || ''),
        cc: String(safe.cc || ''),
        printer: String(safe.printer || ''),
        printDate: String(safe.printDate || '')
    };
}

// 把任意来源（旧 v1、备份、库记录）的散数据归一化为合法 state。
function sanitizeOfficialWritingState(parsed) {
    const data = parsed && typeof parsed === 'object' ? parsed : {};
    return createOfficialWritingState({
        docType: String(data.docType || OFFICIAL_WRITING_DEFAULT_FORM_STATE.docType),
        mode: String(data.mode || OFFICIAL_WRITING_DEFAULT_FORM_STATE.mode),
        standard: String(data.standard || OFFICIAL_WRITING_DEFAULT_FORM_STATE.standard),
        materialSource: String(data.materialSource || OFFICIAL_WRITING_DEFAULT_FORM_STATE.materialSource),
        requirements: String(data.requirements || ''),
        source: String(data.source || ''),
        draft: String(data.draft || ''),
        meta: normalizeOfficialWritingMeta(data.meta),
        comments: Array.isArray(data.comments) ? data.comments : [],
        versions: Array.isArray(data.versions) ? data.versions : [],
        // 清理上次会话遗留的流式占位卡片：丢弃无内容的占位，其余清除 streaming 标记恢复为正常待处理建议。
        suggestions: (Array.isArray(data.suggestions) ? data.suggestions : [])
            .filter(item => !(item && item.streaming && !String(item.replacement || '').trim()))
            .map(item => (item && item.streaming ? { ...item, streaming: false } : item)),
        autoSaves: Array.isArray(data.autoSaves) ? data.autoSaves : []
    });
}

function generateOfficialWritingDocId() {
    return `doc-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function deriveOfficialWritingDocTitle(state) {
    const draft = String(state?.draft || '').trim();
    const firstLine = draft.split(/\r?\n/).find(line => line.trim()) || '';
    if (firstLine.trim()) return compactTextPreview(firstLine, 24);
    const source = String(state?.source || '').trim();
    if (source) return compactTextPreview(source.split(/\r?\n/)[0] || '', 24);
    return `${state?.docType || '公文'}草稿`;
}

let officialWritingState = createOfficialWritingState();
let officialWritingUiState = {
    screen: 'library',
    libraryPage: 1,
    libraryPageSize: 10,
    viewMode: 'document',
    drawerTab: 'suggestions',
    materialTab: 'materials',
    leftCollapsed: true,
    rightCollapsed: true,
    lastSelection: null,
    proofreadCheckedAt: '',
    proofreadDraftSnapshot: ''
};
let officialWritingAiBusy = false;
let officialWritingAiBusyLabel = '';
let officialWritingAiTaskMode = '';
let officialWritingAiAbortController = null;
let officialWritingProgrammaticTextUpdate = false;
const OFFICIAL_WRITING_HISTORY_LIMIT = 50;
// 批注 / 修改建议为只增不减的 unshift 列表，配额裁剪不会触及它们，
// 这里按“保留最近 N 条”封顶，与 autoSaves / versions 的裁剪策略保持一致。
const OFFICIAL_WRITING_COMMENT_LIMIT = 200;
const OFFICIAL_WRITING_SUGGESTION_LIMIT = 200;
const officialWritingUndoStack = [];
const officialWritingRedoStack = [];

// 键入时仅即时更新可编辑文本，重活（整库持久化 + 校对/合规扫描 + 列表重建 + 强制回流）
// 统一去抖 250ms，避免每次按键都触发 JSON.stringify 整库与多处 innerHTML 重建。
const OFFICIAL_WRITING_ANALYSIS_DEBOUNCE_MS = 250;
let officialWritingAnalysisDebounceTimer = null;

function scheduleOfficialWritingAnalysis() {
    if (officialWritingAnalysisDebounceTimer) clearTimeout(officialWritingAnalysisDebounceTimer);
    officialWritingAnalysisDebounceTimer = setTimeout(() => {
        officialWritingAnalysisDebounceTimer = null;
        syncOfficialWritingStateFromInputs();
        renderOfficialWritingWorkspace();
    }, OFFICIAL_WRITING_ANALYSIS_DEBOUNCE_MS);
}

// 在失焦 / 导出 / 持久化等动作前立即冲刷待执行的去抖任务，确保不丢数据。
function flushOfficialWritingAnalysis() {
    if (!officialWritingAnalysisDebounceTimer) return;
    clearTimeout(officialWritingAnalysisDebounceTimer);
    officialWritingAnalysisDebounceTimer = null;
    syncOfficialWritingStateFromInputs();
    renderOfficialWritingWorkspace();
}

function escapeAppsHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function getAppsSessionValue(key) {
    try { return sessionStorage.getItem(String(key || '')) || ''; } catch (e) { return ''; }
}

function setAppsSessionValue(key, value) {
    try {
        if (value) sessionStorage.setItem(String(key || ''), String(value));
        else sessionStorage.removeItem(String(key || ''));
    } catch (e) {
        // 隐私模式或浏览器禁用存储时，当前应用仍应可用。
    }
}

function setAppsWorkbenchState(state = '', message = '', { retryApp = '' } = {}) {
    const el = document.getElementById('apps-workbench-state');
    if (el) {
        appsWorkbenchRetryApp = retryApp || '';
        el.dataset.state = state || '';
        el.hidden = true;
        PivotSafeHtml.setHtml(el, '');
    }
    if (message && state === 'error') {
        if (typeof showToast === 'function') {
            showToast(message, 'error');
        } else if (typeof window.Pivot.legacy.showToast === 'function') {
            window.Pivot.legacy.showToast(message, 'error');
        }
    }
}

function setAppsWorkbenchVisibility(open) {
    const panel = document.getElementById('apps-workbench-modal');
    if (!panel) return;
    if (open) {
        if (!appsWorkbenchFocus && document.activeElement && document.activeElement !== document.body) appsWorkbenchFocus = document.activeElement;
        panel.setAttribute('aria-hidden', 'false');
        return;
    }
    panel.setAttribute('aria-hidden', 'true');
    if (appsWorkbenchFocus?.isConnected) appsWorkbenchFocus.focus?.();
    appsWorkbenchFocus = null;
}

function getAppIconSvg(icon) {
    if (icon === 'file-text') {
        return `
            <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                <path d="M14 2v6h6"></path>
                <path d="M8 13h8"></path>
                <path d="M8 17h6"></path>
                <path d="M8 9h2"></path>
            </svg>
        `;
    }

    if (icon === 'book-open') {
        return `
            <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v16H6.5A2.5 2.5 0 0 0 4 21.5z"></path>
                <path d="M4 5.5v16"></path>
                <path d="M8 7h8"></path>
                <path d="M8 11h7"></path>
            </svg>
        `;
    }
    if (icon === 'bar-chart') {
        return `
            <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <path d="M3 3v18h18"></path>
                <path d="M7 16V9"></path>
                <path d="M12 16V5"></path>
                <path d="M17 16v-4"></path>
            </svg>
        `;
    }
    if (icon === 'scan-text') {
        return `
            <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <path d="M4 7V5a1 1 0 0 1 1-1h2"></path>
                <path d="M17 4h2a1 1 0 0 1 1 1v2"></path>
                <path d="M20 17v2a1 1 0 0 1-1 1h-2"></path>
                <path d="M7 20H5a1 1 0 0 1-1-1v-2"></path>
                <path d="M7 9h10"></path>
                <path d="M7 13h7"></path>
                <path d="M7 17h5"></path>
            </svg>
        `;
    }
    if (icon === 'file-cog') {
        return `
            <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                <path d="M14 2v6h6"></path>
                <circle cx="12" cy="15" r="2"></circle>
                <path d="M12 11.5v1"></path>
                <path d="M12 17.5v1"></path>
                <path d="M8.97 13.25l.86.5"></path>
                <path d="M14.17 16.25l.86.5"></path>
                <path d="M15.03 13.25l-.86.5"></path>
                <path d="M9.83 16.25l-.86.5"></path>
            </svg>
        `;
    }
    return `
        <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
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
    PivotSafeHtml.setHtml(grid, apps.map(app => `
        <button class="app-card" type="button" data-app-id="${escapeAppsHtml(app.id)}" aria-label="打开${escapeAppsHtml(app.name)}">
            <div class="app-card-head">
                <span class="app-card-icon">${getAppIconSvg(app.icon)}</span>
                <div class="app-card-badges">
                    <span class="app-card-category">${escapeAppsHtml(app.category)}</span>
                    <em class="app-card-status">${app.status === 'available' ? '可用' : '规划中'}</em>
                </div>
            </div>
            <div class="app-card-main">
                <strong class="app-card-title">${escapeAppsHtml(app.name)}</strong>
                <p class="app-card-desc">${escapeAppsHtml(app.description)}</p>
                ${Array.isArray(app.tags) && app.tags.length ? `
                    <div class="app-card-tags">
                        ${app.tags.map(tag => `<span class="app-card-tag">${escapeAppsHtml(tag)}</span>`).join('')}
                    </div>
                ` : ''}
            </div>
        </button>
    `).join(''));
}

function setAppsTitle(title, desc) {
    const titleEl = document.getElementById('apps-workspace-title');
    const descEl = document.getElementById('apps-workspace-desc');
    if (titleEl) titleEl.textContent = title;
    if (descEl) descEl.textContent = desc;
}

function getStoredAppsActiveApp() {
    return getAppsSessionValue(APPS_ACTIVE_APP_STORAGE_KEY);
}

function setStoredAppsActiveApp(appId) {
    setAppsSessionValue(APPS_ACTIVE_APP_STORAGE_KEY, appId);
}

function showAppsHome() {
    setStoredAppsActiveApp('');
    window.Pivot.legacy.PivotDataAnalysis?.resetAiWorkspace?.();
    document.getElementById('apps-home-view')?.classList.remove('hidden');
    document.getElementById('official-writing-view')?.classList.add('hidden');
    document.getElementById('data-analysis-view')?.classList.add('hidden');
    document.getElementById('regulations-view')?.classList.add('hidden');
    document.getElementById('ocr-view')?.classList.add('hidden');
    document.getElementById('pdf-tools-view')?.classList.add('hidden');
    document.getElementById('apps-back-btn')?.classList.add('hidden');
    setAppsTitle('应用中心', '打开面向具体业务场景的工作台，常用能力会沉淀在这里，而不是挤在侧栏里。');
    setAppsWorkbenchState();
    renderAppsGrid();
}

async function showOfficialWritingApp() {
    setStoredAppsActiveApp('official-writing');
    window.Pivot.legacy.PivotDataAnalysis?.resetAiWorkspace?.();
    document.getElementById('apps-home-view')?.classList.add('hidden');
    document.getElementById('official-writing-view')?.classList.remove('hidden');
    document.getElementById('data-analysis-view')?.classList.add('hidden');
    document.getElementById('regulations-view')?.classList.add('hidden');
    document.getElementById('ocr-view')?.classList.add('hidden');
    document.getElementById('pdf-tools-view')?.classList.add('hidden');
    document.getElementById('apps-back-btn')?.classList.remove('hidden');
    setAppsTitle('公文写作', '管理已创建公文，选择文种和名称后进入单篇编辑。');
    await loadOfficialWritingState();
    await window.Pivot.legacy.PivotAppModels?.refresh?.('official-writing-selection', 'official-writing-selection-model');
    if (typeof setOfficialWritingScreen === 'function') setOfficialWritingScreen('library');
    hydrateOfficialWritingForm();
    setOfficialWritingMaterialSource(officialWritingState.materialSource || OFFICIAL_WRITING_DEFAULT_FORM_STATE.materialSource);
    applyOfficialWritingViewMode(officialWritingUiState.viewMode);
    applyOfficialWritingLeftRailState();
    if (officialWritingUiState.rightCollapsed) {
        closeOfficialWritingDrawer();
    } else {
        openOfficialWritingDrawer(officialWritingUiState.drawerTab);
    }
    updateOfficialWritingUndoRedoButtons();
    renderOfficialWritingWorkspace();
    renderOfficialWritingDocList();
    if (typeof setOfficialWritingScreen === 'function') setOfficialWritingScreen('library');
}
async function showDataAnalysisAppFromRegistry() {
    if (typeof window.Pivot.legacy.showDataAnalysisApp === 'function') {
        await window.Pivot.legacy.showDataAnalysisApp();
        return;
    }
    await window.Pivot?.loadScriptOnce?.('/chat/apps-workbench-data-analysis.js');
    await window.Pivot.legacy.showDataAnalysisApp?.();
}

async function showRegulationsAppFromRegistry() {
    if (typeof window.Pivot.legacy.showRegulationsApp === 'function') {
        await window.Pivot.legacy.showRegulationsApp();
        return;
    }
    await window.Pivot?.loadScriptOnce?.('/chat/apps-workbench-regulations.js');
    await window.Pivot.legacy.showRegulationsApp?.();
}

async function showOcrAppFromRegistry() {
    if (typeof window.Pivot.legacy.showOcrApp === 'function') {
        await window.Pivot.legacy.showOcrApp();
        return;
    }
    await window.Pivot?.loadScriptOnce?.('/chat/apps-workbench-ocr.js');
    await window.Pivot.legacy.showOcrApp?.();
}

async function showPdfToolsAppFromRegistry() {
    if (typeof window.Pivot.legacy.showPdfToolsApp === 'function') {
        await window.Pivot.legacy.showPdfToolsApp();
        return;
    }
    await window.Pivot?.loadScriptOnce?.('/chat/apps-workbench-pdf-tools.js');
    await window.Pivot.legacy.showPdfToolsApp?.();
}

function openRegisteredApp(appId) {
    const app = PIVOT_APP_REGISTRY.find(item => item.id === appId);
    if (!app || app.status !== 'available') return;
    setAppsWorkbenchState('loading', '正在打开' + app.name + '…');
    const handleFailure = () => {
        showAppsHome();
        setAppsWorkbenchState('error', app.name + '暂时无法打开，请检查网络或稍后重试。', { retryApp: app.id });
    };
    if (app.id === 'official-writing') {
        showOfficialWritingApp()
            .then(() => setAppsWorkbenchState())
            .catch(() => {
                handleFailure();
            });
    }
    if (app.id === 'data-analysis') {
        showDataAnalysisAppFromRegistry()
            .then(() => setAppsWorkbenchState())
            .catch(() => {
                handleFailure();
            });
    }
    if (app.id === 'regulations') {
        showRegulationsAppFromRegistry()
            .then(() => setAppsWorkbenchState())
            .catch(() => {
                handleFailure();
            });
    }
    if (app.id === 'ocr') {
        showOcrAppFromRegistry()
            .then(() => setAppsWorkbenchState())
            .catch(() => {
                handleFailure();
            });
    }
    if (app.id === 'pdf-tools') {
        showPdfToolsAppFromRegistry()
            .then(() => setAppsWorkbenchState())
            .catch(() => {
                handleFailure();
            });
    }
}

window.Pivot?.exposeModule?.('workspaces.apps', {
    getAppsSessionValue,
    setAppsSessionValue,
    setAppsWorkbenchState,
    setAppsWorkbenchVisibility,
    getStoredAppsActiveApp,
    setStoredAppsActiveApp
}, [
    { globalName: 'getAppsSessionValue', exportName: 'getAppsSessionValue' },
    { globalName: 'setAppsSessionValue', exportName: 'setAppsSessionValue' },
    { globalName: 'setAppsWorkbenchState', exportName: 'setAppsWorkbenchState' },
    { globalName: 'setAppsWorkbenchVisibility', exportName: 'setAppsWorkbenchVisibility' },
    { globalName: 'showRegulationsAppFromRegistry', exportName: 'showRegulationsAppFromRegistry' }
]);

function createEmptyOfficialWritingDoc() {
    return {
        id: generateOfficialWritingDocId(),
        title: '新公文',
        manualTitle: false,
        updatedAt: new Date().toISOString(),
        version: 0,
        state: createOfficialWritingState()
    };
}

function purgeLegacyOfficialWritingStorage() {
    if (officialWritingLegacyStoragePurged) return;
    officialWritingLegacyStoragePurged = true;
    // 旧版本用固定键保存所有账号的正文，无法可靠判断原归属。安全升级不能
    // 把这份无归属缓存导入当前登录用户，否则仍会造成跨账号数据泄露。
    try {
        localStorage.removeItem(OFFICIAL_WRITING_LIBRARY_KEY);
        localStorage.removeItem(OFFICIAL_WRITING_STORAGE_KEY);
    } catch (_) {}
}

function normalizeOfficialWritingServerDocument(doc) {
    const id = String(doc?.id || '').trim();
    if (!id) return null;
    return {
        id,
        title: String(doc?.title || '未命名公文'),
        manualTitle: Boolean(doc?.manualTitle),
        updatedAt: String(doc?.updatedAt || new Date().toISOString()),
        version: Number(doc?.version || 1),
        state: sanitizeOfficialWritingState(doc?.state)
    };
}

function ensureOfficialWritingActiveDocument() {
    if (!officialWritingLibrary.docs.length) officialWritingLibrary.docs.push(createEmptyOfficialWritingDoc());
    const hasActive = officialWritingLibrary.docs.some(doc => doc.id === officialWritingLibrary.activeId);
    if (!hasActive) officialWritingLibrary.activeId = officialWritingLibrary.docs[0].id;
}

function getActiveOfficialWritingDoc() {
    return officialWritingLibrary.docs.find(doc => doc.id === officialWritingLibrary.activeId) || officialWritingLibrary.docs[0];
}

async function loadOfficialWritingState() {
    const requestId = ++officialWritingLoadSequence;
    purgeLegacyOfficialWritingStorage();
    try {
        const res = await apiFetch(OFFICIAL_WRITING_DOCUMENTS_API);
        if (!res.ok) throw new Error(`加载公文库失败（${res.status}）`);
        const data = await res.json();
        if (requestId !== officialWritingLoadSequence) return false;
        officialWritingLibrary = {
            activeId: '',
            docs: (Array.isArray(data?.data) ? data.data : [])
                .map(normalizeOfficialWritingServerDocument)
                .filter(Boolean)
        };
    } catch (_) {
        if (requestId !== officialWritingLoadSequence) return false;
        officialWritingLibrary = { activeId: '', docs: [] };
        showToast?.('公文库加载失败，未展示任何本地残留数据。请检查网络后重试。', 'error');
    }
    ensureOfficialWritingActiveDocument();
    const activeDoc = getActiveOfficialWritingDoc();
    officialWritingState = activeDoc ? activeDoc.state : createOfficialWritingState();
    if (!activeDoc?.version) scheduleOfficialWritingDocumentSave(activeDoc, { immediate: true });
    return true;
}

function syncActiveOfficialWritingDoc() {
    // 把当前 state 回写到活动文档记录，并刷新标题与时间戳。
    const activeDoc = getActiveOfficialWritingDoc();
    if (!activeDoc) return;
    activeDoc.state = officialWritingState;
    if (!activeDoc.manualTitle) activeDoc.title = deriveOfficialWritingDocTitle(officialWritingState);
    activeDoc.updatedAt = new Date().toISOString();
}

function officialWritingDocumentPayload(doc) {
    return {
        title: String(doc?.title || '未命名公文'),
        manualTitle: doc?.manualTitle === true,
        state: sanitizeOfficialWritingState(doc?.state)
    };
}

async function persistOfficialWritingDocument(doc) {
    if (!doc?.id || typeof apiFetch !== 'function') return;
    const res = await apiFetch(`${OFFICIAL_WRITING_DOCUMENTS_API}/${encodeURIComponent(doc.id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(officialWritingDocumentPayload(doc))
    });
    if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(String(data?.error || '公文保存失败'));
    }
    const data = await res.json().catch(() => ({}));
    const saved = normalizeOfficialWritingServerDocument(data?.document);
    const current = saved && officialWritingLibrary.docs.find(item => item.id === saved.id);
    if (current) {
        current.version = saved.version;
        current.updatedAt = saved.updatedAt;
    }
}

function scheduleOfficialWritingDocumentSave(doc, { immediate = false } = {}) {
    if (!doc?.id || officialWritingDeletedDocumentIds.has(doc.id)) return;
    const previous = officialWritingSaveTimers.get(doc.id);
    if (previous) clearTimeout(previous);
    const save = async () => {
        officialWritingSaveTimers.delete(doc.id);
        try {
            await persistOfficialWritingDocument(doc);
        } catch (error) {
            if (!officialWritingDeletedDocumentIds.has(doc.id)) {
                showToast?.(error?.message || '公文保存失败，请稍后重试', 'error');
            }
        }
    };
    if (immediate) {
        void save();
        return;
    }
    officialWritingSaveTimers.set(doc.id, setTimeout(() => { void save(); }, 450));
}

async function deleteOfficialWritingDocumentFromServer(docId) {
    officialWritingDeletedDocumentIds.add(docId);
    const timer = officialWritingSaveTimers.get(docId);
    if (timer) {
        clearTimeout(timer);
        officialWritingSaveTimers.delete(docId);
    }
    try {
        if (typeof apiFetch !== 'function') return;
        const res = await apiFetch(`${OFFICIAL_WRITING_DOCUMENTS_API}/${encodeURIComponent(docId)}`, { method: 'DELETE' });
        // 新建后立即删除的文档可能尚未发送保存请求；404 可安全视为删除完成。
        if (res.status === 404) return;
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(String(data?.error || '删除公文失败'));
        }
    } catch (error) {
        officialWritingDeletedDocumentIds.delete(docId);
        throw error;
    }
}

function saveOfficialWritingState(options = {}) {
    syncActiveOfficialWritingDoc();
    scheduleOfficialWritingDocumentSave(getActiveOfficialWritingDoc(), options);
}

function exportOfficialWritingBackup() {
    syncOfficialWritingStateFromInputs();
    const payload = {
        version: 1,
        exportedAt: new Date().toISOString(),
        state: officialWritingState
    };
    const safeType = getOfficialWritingDocType().replace(/[\\/:*?"<>|]/g, '');
    downloadOfficialWritingFile(
        `${safeType || '公文'}-备份-${Date.now()}.json`,
        JSON.stringify(payload, null, 2),
        'application/json;charset=utf-8'
    );
    if (typeof showToast === 'function') showToast('已导出工作区备份');
}
