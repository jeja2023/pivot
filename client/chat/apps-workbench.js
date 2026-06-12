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
    elements: ['发文要素', '填写版头（密级、紧急程度、发文字号、签发人）和版记（抄送、印发机关、印发日期），导出时自动排版。'],
    comments: ['批注', '对原文或正文稿添加局部意见。'],
    versions: ['版本对比', '保存正文稿并查看原文、正文稿或历史版本差异。'],
    compliance: ['规范检查', '检查标题、日期、待补充项和事实依据风险。'],
    proofread: ['校对检查', '检查敏感词、易错字、标点规范和标题与文种一致性。'],
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
const APPS_ACTIVE_APP_STORAGE_KEY = 'pivot_apps_active_app';
const OFFICIAL_WRITING_DEFAULT_FORM_STATE = {
    docType: '通知',
    mode: 'draft',
    standard: '通用公文规范',
    materialSource: '粘贴材料',
    requirements: ''
};

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
// library = { activeId, docs: [{ id, title, updatedAt, state }] }
let officialWritingLibrary = { activeId: '', docs: [] };

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
        suggestions: Array.isArray(data.suggestions) ? data.suggestions : [],
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
    viewMode: 'document',
    drawerTab: 'suggestions',
    materialTab: 'outline',
    rightCollapsed: false,
    lastSelection: null
};
let officialWritingAiBusy = false;
const OFFICIAL_WRITING_HISTORY_LIMIT = 50;
const officialWritingUndoStack = [];
const officialWritingRedoStack = [];

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
    setOfficialWritingMaterialSource(officialWritingState.materialSource || OFFICIAL_WRITING_DEFAULT_FORM_STATE.materialSource);
    applyOfficialWritingViewMode(officialWritingUiState.viewMode);
    openOfficialWritingDrawer(officialWritingUiState.drawerTab);
    updateOfficialWritingUndoRedoButtons();
    renderOfficialWritingWorkspace();
    renderOfficialWritingDocList();
}

function openRegisteredApp(appId) {
    const app = PIVOT_APP_REGISTRY.find(item => item.id === appId);
    if (!app || app.status !== 'available') return;
    if (app.id === 'official-writing') showOfficialWritingApp();
}

function loadOfficialWritingLibrary() {
    // 优先读取多文档库；不存在时从旧版单文档 key 迁移为库中第一篇。
    try {
        const rawLib = localStorage.getItem(OFFICIAL_WRITING_LIBRARY_KEY);
        if (rawLib) {
            const parsed = JSON.parse(rawLib);
            const docs = Array.isArray(parsed?.docs) ? parsed.docs : [];
            officialWritingLibrary = {
                activeId: String(parsed?.activeId || ''),
                docs: docs.map(doc => ({
                    id: String(doc?.id || generateOfficialWritingDocId()),
                    title: String(doc?.title || '未命名公文'),
                    updatedAt: String(doc?.updatedAt || new Date().toISOString()),
                    state: sanitizeOfficialWritingState(doc?.state)
                }))
            };
        } else {
            officialWritingLibrary = { activeId: '', docs: [] };
            const rawOld = localStorage.getItem(OFFICIAL_WRITING_STORAGE_KEY);
            if (rawOld) {
                const migrated = sanitizeOfficialWritingState(JSON.parse(rawOld));
                officialWritingLibrary.docs.push({
                    id: generateOfficialWritingDocId(),
                    title: deriveOfficialWritingDocTitle(migrated),
                    updatedAt: new Date().toISOString(),
                    state: migrated
                });
            }
        }
    } catch (e) {
        officialWritingLibrary = { activeId: '', docs: [] };
    }
    if (!officialWritingLibrary.docs.length) {
        officialWritingLibrary.docs.push({
            id: generateOfficialWritingDocId(),
            title: '新公文',
            updatedAt: new Date().toISOString(),
            state: createOfficialWritingState()
        });
    }
    const hasActive = officialWritingLibrary.docs.some(doc => doc.id === officialWritingLibrary.activeId);
    if (!hasActive) officialWritingLibrary.activeId = officialWritingLibrary.docs[0].id;
}

function getActiveOfficialWritingDoc() {
    return officialWritingLibrary.docs.find(doc => doc.id === officialWritingLibrary.activeId) || officialWritingLibrary.docs[0];
}

function loadOfficialWritingState() {
    loadOfficialWritingLibrary();
    const activeDoc = getActiveOfficialWritingDoc();
    officialWritingState = activeDoc ? activeDoc.state : createOfficialWritingState();
}

function estimateStorageBytes(value) {
    // localStorage 以 UTF-16 存储，按每字符约 2 字节估算，再叠加键名占用。
    return (String(value).length + OFFICIAL_WRITING_LIBRARY_KEY.length) * 2;
}

function trimOfficialWritingStateForStorage() {
    // 超限时优先丢弃可重建的体积大户：自动草稿 → 历史版本，保留正文、原文、批注和建议。
    let trimmed = false;
    if ((officialWritingState.autoSaves || []).length > 2) {
        officialWritingState.autoSaves = officialWritingState.autoSaves.slice(0, 2);
        trimmed = true;
    } else if ((officialWritingState.autoSaves || []).length > 0) {
        officialWritingState.autoSaves = [];
        trimmed = true;
    } else if ((officialWritingState.versions || []).length > 3) {
        officialWritingState.versions = officialWritingState.versions.slice(0, 3);
        trimmed = true;
    }
    return trimmed;
}

function syncActiveOfficialWritingDoc() {
    // 把当前 state 回写到活动文档记录，并刷新标题与时间戳。
    const activeDoc = getActiveOfficialWritingDoc();
    if (!activeDoc) return;
    activeDoc.state = officialWritingState;
    activeDoc.title = deriveOfficialWritingDocTitle(officialWritingState);
    activeDoc.updatedAt = new Date().toISOString();
}

function saveOfficialWritingState() {
    // 写入前预估体积，超过软上限（约 3.5MB）先提示并支持导出备份。整库持久化。
    const SOFT_LIMIT_BYTES = 3.5 * 1024 * 1024;
    syncActiveOfficialWritingDoc();
    let attempts = 0;
    while (attempts < 4) {
        attempts += 1;
        let serialized;
        try {
            serialized = JSON.stringify(officialWritingLibrary);
        } catch (e) {
            return;
        }
        if (estimateStorageBytes(serialized) > SOFT_LIMIT_BYTES && trimOfficialWritingStateForStorage()) {
            if (typeof showToast === 'function') {
                showToast('内容较多，已自动精简自动草稿与历史版本以保证保存', 'warning');
            }
            continue;
        }
        try {
            localStorage.setItem(OFFICIAL_WRITING_LIBRARY_KEY, serialized);
            // 迁移完成后清理旧版单文档 key，避免占用空间。
            try { localStorage.removeItem(OFFICIAL_WRITING_STORAGE_KEY); } catch (cleanupError) { /* 忽略清理失败 */ }
            return;
        } catch (e) {
            // QuotaExceededError：逐步精简后重试，无法精简则提示并保留内存内状态。
            const isQuota = e && (e.name === 'QuotaExceededError' || e.code === 22 || e.code === 1014);
            if (isQuota && trimOfficialWritingStateForStorage()) {
                if (typeof showToast === 'function') {
                    showToast('本地存储空间不足，已精简历史数据后重试保存', 'warning');
                }
                continue;
            }
            if (typeof showToast === 'function') {
                showToast('本地存储空间不足，建议导出备份后清理工作区', 'error');
            }
            return;
        }
    }
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

// ===== 多文档库管理 =====

function renderOfficialWritingDocList() {
    const list = document.getElementById('official-writing-doc-list');
    if (!list) return;
    const docs = [...officialWritingLibrary.docs].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    list.innerHTML = docs.map(doc => `
        <div class="official-writing-doc-item ${doc.id === officialWritingLibrary.activeId ? 'active' : ''}" data-official-writing-doc-id="${escapeAppsHtml(doc.id)}" role="listitem">
            <button type="button" class="official-writing-doc-open" data-official-writing-doc-open="${escapeAppsHtml(doc.id)}" title="${escapeAppsHtml(doc.title)}">
                <strong>${escapeAppsHtml(doc.title || '未命名公文')}</strong>
                <small>${escapeAppsHtml(formatVersionTime(doc.updatedAt))}</small>
            </button>
            <span class="official-writing-doc-actions">
                <button type="button" data-official-writing-doc-rename="${escapeAppsHtml(doc.id)}" title="重命名" aria-label="重命名">改名</button>
                <button type="button" data-official-writing-doc-delete="${escapeAppsHtml(doc.id)}" title="删除" aria-label="删除">删除</button>
            </span>
        </div>
    `).join('') || '<div class="official-writing-empty-note">暂无公文，点击“新建公文”开始。</div>';
    setText('official-writing-doc-count', `${officialWritingLibrary.docs.length} 篇`);
}

function switchOfficialWritingDoc(docId) {
    if (!docId || docId === officialWritingLibrary.activeId) return;
    const target = officialWritingLibrary.docs.find(doc => doc.id === docId);
    if (!target) return;
    // 切换前先把当前编辑器内容写回当前活动文档。
    syncOfficialWritingStateFromInputs();
    officialWritingLibrary.activeId = docId;
    officialWritingState = target.state;
    officialWritingUndoStack.length = 0;
    officialWritingRedoStack.length = 0;
    officialWritingUiState.lastSelection = null;
    updateOfficialWritingUndoRedoButtons();
    hydrateOfficialWritingForm();
    saveOfficialWritingState();
    renderOfficialWritingWorkspace();
    renderOfficialWritingDocList();
}

function createOfficialWritingDoc() {
    syncOfficialWritingStateFromInputs();
    const doc = {
        id: generateOfficialWritingDocId(),
        title: '新公文',
        updatedAt: new Date().toISOString(),
        state: createOfficialWritingState()
    };
    officialWritingLibrary.docs.unshift(doc);
    officialWritingLibrary.activeId = doc.id;
    officialWritingState = doc.state;
    officialWritingUndoStack.length = 0;
    officialWritingRedoStack.length = 0;
    officialWritingUiState.lastSelection = null;
    updateOfficialWritingUndoRedoButtons();
    hydrateOfficialWritingForm();
    saveOfficialWritingState();
    renderOfficialWritingWorkspace();
    renderOfficialWritingDocList();
    if (typeof showToast === 'function') showToast('已新建公文');
    document.getElementById('official-writing-draft')?.focus();
}

function renameOfficialWritingDoc(docId) {
    const doc = officialWritingLibrary.docs.find(item => item.id === docId);
    if (!doc) return;
    const next = window.prompt('重命名公文', doc.title || '');
    if (next === null) return;
    const trimmed = next.trim();
    if (!trimmed) return;
    doc.title = compactTextPreview(trimmed, 40);
    doc.updatedAt = new Date().toISOString();
    saveOfficialWritingState();
    renderOfficialWritingDocList();
}

function deleteOfficialWritingDoc(docId) {
    const index = officialWritingLibrary.docs.findIndex(item => item.id === docId);
    if (index < 0) return;
    const doc = officialWritingLibrary.docs[index];
    const hasContent = String(doc.state?.draft || '').trim() || String(doc.state?.source || '').trim();
    if (hasContent && !window.confirm(`确认删除公文「${doc.title || '未命名公文'}」？此操作不可恢复。`)) {
        return;
    }
    officialWritingLibrary.docs.splice(index, 1);
    if (!officialWritingLibrary.docs.length) {
        // 删空后自动新建一篇空白公文，保证始终有活动文档。
        const fresh = {
            id: generateOfficialWritingDocId(),
            title: '新公文',
            updatedAt: new Date().toISOString(),
            state: createOfficialWritingState()
        };
        officialWritingLibrary.docs.push(fresh);
        officialWritingLibrary.activeId = fresh.id;
    } else if (officialWritingLibrary.activeId === docId) {
        officialWritingLibrary.activeId = officialWritingLibrary.docs[0].id;
    }
    officialWritingState = getActiveOfficialWritingDoc().state;
    officialWritingUndoStack.length = 0;
    officialWritingRedoStack.length = 0;
    updateOfficialWritingUndoRedoButtons();
    hydrateOfficialWritingForm();
    saveOfficialWritingState();
    renderOfficialWritingWorkspace();
    renderOfficialWritingDocList();
    if (typeof showToast === 'function') showToast('已删除公文');
}

function hydrateOfficialWritingForm() {
    const source = document.getElementById('official-writing-source');
    const draft = document.getElementById('official-writing-draft');
    const type = document.getElementById('official-writing-type');
    const mode = document.getElementById('official-writing-mode');
    const standard = document.getElementById('official-writing-standard');
    const materialSource = document.getElementById('official-writing-material-source');
    const requirements = document.getElementById('official-writing-requirements');
    if (source) source.value = officialWritingState.source || '';
    if (draft) draft.value = officialWritingState.draft || '';
    if (type) type.value = officialWritingState.docType || OFFICIAL_WRITING_DEFAULT_FORM_STATE.docType;
    if (mode) mode.value = officialWritingState.mode || OFFICIAL_WRITING_DEFAULT_FORM_STATE.mode;
    if (standard) standard.value = officialWritingState.standard || OFFICIAL_WRITING_DEFAULT_FORM_STATE.standard;
    if (materialSource) materialSource.value = officialWritingState.materialSource || OFFICIAL_WRITING_DEFAULT_FORM_STATE.materialSource;
    if (requirements) requirements.value = officialWritingState.requirements || '';
    hydrateOfficialWritingMetaForm();
}

// 发文要素表单（版头 + 版记）字段 id 与 state.meta 键的映射。
const OFFICIAL_WRITING_META_FIELD_IDS = {
    secrecy: 'official-writing-meta-secrecy',
    urgency: 'official-writing-meta-urgency',
    issuer: 'official-writing-meta-issuer',
    issueNumber: 'official-writing-meta-issue-number',
    cc: 'official-writing-meta-cc',
    printer: 'official-writing-meta-printer',
    printDate: 'official-writing-meta-print-date'
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

function getOfficialWritingText(field) {
    return document.getElementById(field)?.value || '';
}

function syncOfficialWritingStateFromInputs() {
    officialWritingState.docType = getOfficialWritingDocType();
    officialWritingState.mode = getOfficialWritingMode();
    officialWritingState.standard = getOfficialWritingStandard();
    officialWritingState.materialSource = getOfficialWritingMaterialSource();
    officialWritingState.requirements = getOfficialWritingRequirements();
    officialWritingState.source = getOfficialWritingText('official-writing-source');
    officialWritingState.draft = getOfficialWritingText('official-writing-draft');
    syncOfficialWritingMetaFromInputs();
    recordOfficialWritingAutoSave();
    saveOfficialWritingState();
}

function getTextCount(text) {
    return String(text || '').replace(/\s/g, '').length;
}

function getOfficialWritingWorkspaceSummary() {
    const sourceCount = getTextCount(officialWritingState.source);
    const draftCount = getTextCount(officialWritingState.draft);
    const risks = getOfficialWritingComplianceRisks();
    const pendingSuggestions = officialWritingState.suggestions.filter(item => item.status !== 'accepted' && item.status !== 'rejected').length;
    const commentCount = officialWritingState.comments.length;
    const versionCount = officialWritingState.versions.length;
    const referenceCount = getOfficialWritingReferenceMatches().length;
    let statusTitle = '待起草';
    let statusDetail = '先粘贴原文材料或直接起草正文。';

    if (draftCount > 0) {
        if (risks.length === 0) {
            statusTitle = pendingSuggestions > 0 ? '可审阅' : '可导出';
            statusDetail = pendingSuggestions > 0
                ? `正文已成稿，还有 ${pendingSuggestions} 条建议待处理。`
                : '正文已成稿，可直接导出或带入聊天复核。';
        } else if (risks.length <= 2) {
            statusTitle = '待确认';
            statusDetail = `正文还有 ${risks.length} 项风险需要处理后再正式流转。`;
        } else {
            statusTitle = '待完善';
            statusDetail = `正文还有 ${risks.length} 项风险，建议先补齐关键信息。`;
        }
    } else if (sourceCount > 0) {
        statusTitle = '可起草';
        statusDetail = '原文材料已就绪，可直接起草正文。';
    }

    return {
        sourceCount,
        draftCount,
        risks,
        pendingSuggestions,
        commentCount,
        versionCount,
        referenceCount,
        statusTitle,
        statusDetail
    };
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

// 撤销/重做：仅快照正文与原文文本，覆盖破坏性操作（建议替换/插入、模板套用、载入版本、同步原文）。
function captureOfficialWritingSnapshot() {
    return {
        source: getOfficialWritingText('official-writing-source'),
        draft: getOfficialWritingText('official-writing-draft')
    };
}

function pushOfficialWritingUndoSnapshot() {
    const snapshot = captureOfficialWritingSnapshot();
    const last = officialWritingUndoStack[officialWritingUndoStack.length - 1];
    if (last && last.source === snapshot.source && last.draft === snapshot.draft) return;
    officialWritingUndoStack.push(snapshot);
    if (officialWritingUndoStack.length > OFFICIAL_WRITING_HISTORY_LIMIT) officialWritingUndoStack.shift();
    officialWritingRedoStack.length = 0;
    updateOfficialWritingUndoRedoButtons();
}

function applyOfficialWritingSnapshot(snapshot) {
    const source = document.getElementById('official-writing-source');
    const draft = document.getElementById('official-writing-draft');
    if (source) source.value = snapshot.source || '';
    if (draft) draft.value = snapshot.draft || '';
    syncOfficialWritingStateFromInputs();
    renderOfficialWritingWorkspace();
}

function undoOfficialWriting() {
    if (!officialWritingUndoStack.length) return;
    officialWritingRedoStack.push(captureOfficialWritingSnapshot());
    const snapshot = officialWritingUndoStack.pop();
    applyOfficialWritingSnapshot(snapshot);
    updateOfficialWritingUndoRedoButtons();
    if (typeof showToast === 'function') showToast('已撤销');
}

function redoOfficialWriting() {
    if (!officialWritingRedoStack.length) return;
    officialWritingUndoStack.push(captureOfficialWritingSnapshot());
    const snapshot = officialWritingRedoStack.pop();
    applyOfficialWritingSnapshot(snapshot);
    updateOfficialWritingUndoRedoButtons();
    if (typeof showToast === 'function') showToast('已重做');
}

function updateOfficialWritingUndoRedoButtons() {
    const undoBtn = document.getElementById('official-writing-undo-btn');
    const redoBtn = document.getElementById('official-writing-redo-btn');
    if (undoBtn) undoBtn.disabled = officialWritingUndoStack.length === 0;
    if (redoBtn) redoBtn.disabled = officialWritingRedoStack.length === 0;
}

function replaceTextareaRange(textarea, start, end, replacement, { skipSnapshot } = {}) {
    if (!textarea) return;
    if (!skipSnapshot) pushOfficialWritingUndoSnapshot();
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
    // 规范库特有规则：按所选规范库追加硬性要素检查。
    const standard = getOfficialWritingStandard();
    const ruleContext = { draftLength: draft.length, sourceLength: source.length, docType: getOfficialWritingDocType() };
    getOfficialWritingStandardRules(standard).forEach(rule => {
        let hit = false;
        try {
            hit = rule.test(draft, ruleContext);
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

function getOfficialWritingReferenceMatches() {
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
    const currentBaseValue = base?.value || 'source';
    const currentTargetValue = target?.value || 'draft';
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
        base.value = Array.from(base.options).some(option => option.value === currentBaseValue) ? currentBaseValue : 'source';
        target.value = Array.from(target.options).some(option => option.value === currentTargetValue) ? currentTargetValue : 'draft';
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
            <div class="official-writing-suggestion-meta">
                <span class="official-writing-suggestion-status is-${escapeAppsHtml(suggestion.status || 'pending')}">${escapeAppsHtml(suggestion.status === 'accepted' ? '已接受' : suggestion.status === 'rejected' ? '已拒绝' : '待处理')}</span>
                <span>${escapeAppsHtml(formatVersionTime(suggestion.resolvedAt || suggestion.createdAt))}</span>
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
            <span>原文材料${match.kind === 'fuzzy' ? `（相近 ${Math.round((match.score || 0) * 100)}%）` : ''}</span>
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
    renderOfficialWritingProofread();
}

// ===== 公文校对检查（敏感词 / 易错字 / 标点规范 / 标题文种一致性）=====

// 常见公文易错词、错别字与不规范表述（错误写法 -> 建议写法）。
const OFFICIAL_WRITING_TYPO_RULES = [
    ['做出决定', '作出决定', '公文固定搭配多用“作出决定”。'],
    ['做出部署', '作出部署', '公文固定搭配多用“作出部署”。'],
    ['截止目前', '截至目前', '表示时间到某点用“截至”，“截止”指停止。'],
    ['截止到', '截至', '表示时间到某点用“截至”。'],
    ['有序的推进', '有序推进', '“的/地/得”误用：状语后多不加“的”。'],
    ['进行研究', '研究', '“进行+双音节动词”啰嗦，可直接用动词。'],
    ['进行讨论', '讨论', '“进行+双音节动词”啰嗦，可直接用动词。'],
    ['汇报', '报告', '向上级行文时文种用“报告”，“汇报”偏口语。'],
    ['第一时间', '及时', '“第一时间”偏口语，公文宜用“及时”“立即”。'],
    ['一定要', '务必', '“一定要”偏口语，公文宜用“务必”“应”。']
].filter(rule => rule[0] && rule[1]);

// 敏感/不当表述提示（仅提示，不强制）。
const OFFICIAL_WRITING_SENSITIVE_WORDS = ['最高级', '最佳', '国家级', '世界级', '绝对', '百分之百', '一律', '严禁一切', '彻底杜绝'];

function getOfficialWritingProofreadIssues() {
    const draft = String(officialWritingState.draft || '');
    const issues = [];
    if (!draft.trim()) return issues;

    // 1. 易错字 / 不规范表述
    OFFICIAL_WRITING_TYPO_RULES.forEach(([from, to, note], ruleIndex) => {
        let index = draft.indexOf(from);
        let guard = 0;
        while (index >= 0 && guard < 50) {
            guard += 1;
            issues.push({
                id: `typo-${ruleIndex}-${index}`,
                kind: '易错字',
                level: '低',
                start: index,
                end: index + from.length,
                excerpt: from,
                suggestion: `建议改为“${to}”${note ? '：' + note : ''}`
            });
            index = draft.indexOf(from, index + from.length);
        }
    });

    // 2. 敏感 / 绝对化措辞
    OFFICIAL_WRITING_SENSITIVE_WORDS.forEach((word, wordIndex) => {
        const index = draft.indexOf(word);
        if (index >= 0) {
            issues.push({
                id: `sensitive-${wordIndex}-${index}`,
                kind: '敏感词',
                level: '中',
                start: index,
                end: index + word.length,
                excerpt: word,
                suggestion: `“${word}”属绝对化或敏感表述，建议核实是否符合事实并改为克制措辞。`
            });
        }
    });

    // 3. 标点规范：连续标点、英文标点混用、成对括号/引号不匹配
    const doublePunct = draft.match(/[，。、；：]{2,}/);
    if (doublePunct) {
        const index = draft.indexOf(doublePunct[0]);
        issues.push({
            id: `punct-double-${index}`,
            kind: '标点',
            level: '低',
            start: index,
            end: index + doublePunct[0].length,
            excerpt: doublePunct[0],
            suggestion: '存在连续标点，建议核对并删除多余标点。'
        });
    }
    const enPunct = draft.match(/[a-zA-Z0-9一-龥][,;:?!](\s|[一-龥])/);
    if (enPunct) {
        const index = enPunct.index;
        issues.push({
            id: `punct-en-${index}`,
            kind: '标点',
            level: '低',
            start: index,
            end: index + enPunct[0].length,
            excerpt: enPunct[0].trim(),
            suggestion: '正文中疑似使用了英文标点，公文建议统一使用中文全角标点。'
        });
    }
    const openQuote = (draft.match(/“/g) || []).length;
    const closeQuote = (draft.match(/”/g) || []).length;
    if (openQuote !== closeQuote) {
        issues.push({
            id: 'punct-quote',
            kind: '标点',
            level: '中',
            start: 0,
            end: 0,
            excerpt: '引号',
            suggestion: `中文引号“”数量不匹配（${openQuote} 对 ${closeQuote}），请检查是否漏配。`
        });
    }
    const openParen = (draft.match(/（/g) || []).length;
    const closeParen = (draft.match(/）/g) || []).length;
    if (openParen !== closeParen) {
        issues.push({
            id: 'punct-paren',
            kind: '标点',
            level: '中',
            start: 0,
            end: 0,
            excerpt: '括号',
            suggestion: `中文括号（）数量不匹配（${openParen} 对 ${closeParen}），请检查是否漏配。`
        });
    }

    // 4. 标题与文种一致性
    const docType = getOfficialWritingDocType();
    const firstLine = draft.split(/\r?\n/).find(line => line.trim()) || '';
    const allTypes = ['通知', '请示', '报告', '函', '会议纪要', '通报', '意见', '决定', '批复', '公告', '通告', '纪要'];
    if (firstLine.trim() && docType !== '其他公文') {
        const titleType = allTypes.find(type => firstLine.includes(type));
        const start = draft.indexOf(firstLine);
        if (titleType && titleType !== docType && !(docType === '会议纪要' && titleType === '纪要')) {
            issues.push({
                id: 'title-doctype',
                kind: '文种一致性',
                level: '中',
                start,
                end: start + firstLine.length,
                excerpt: compactTextPreview(firstLine, 30),
                suggestion: `标题文种“${titleType}”与所选文种“${docType}”不一致，请确认文种或修改标题。`
            });
        } else if (!titleType) {
            issues.push({
                id: 'title-doctype-missing',
                kind: '文种一致性',
                level: '低',
                start,
                end: start + firstLine.length,
                excerpt: compactTextPreview(firstLine, 30),
                suggestion: `标题未体现文种“${docType}”，建议在标题中明确，如“关于……的${docType}”。`
            });
        }
    }
    return issues;
}

function renderOfficialWritingProofread() {
    const list = document.getElementById('official-writing-proofread-list');
    const issues = getOfficialWritingProofreadIssues();
    setText('official-writing-proofread-count', `${issues.length} 项`);
    setText('official-writing-proofread-badge', String(issues.length));
    if (!list) return;
    list.innerHTML = issues.map(issue => `
        <article class="official-writing-check-item" ${issue.end > issue.start ? `data-official-writing-proof-start="${issue.start}" data-official-writing-proof-end="${issue.end}"` : ''}>
            <strong>${escapeAppsHtml(issue.kind)}<span>${escapeAppsHtml(issue.level)}</span></strong>
            <p>${escapeAppsHtml(issue.excerpt || '')}</p>
            <em>${escapeAppsHtml(issue.suggestion)}</em>
        </article>
    `).join('') || '<div class="official-writing-empty-note">未发现敏感词、易错字、标点或文种一致性问题</div>';
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
        const isActive = button.dataset.officialWritingDrawerTab === tab;
        button.classList.toggle('active', isActive);
        button.setAttribute('aria-selected', isActive ? 'true' : 'false');
        button.tabIndex = isActive ? 0 : -1;
    });
    const meta = OFFICIAL_WRITING_DRAWER_META[tab];
    if (title) title.textContent = meta[0];
    if (desc) desc.textContent = meta[1];
    renderOfficialWritingStats();
    renderOfficialWritingCompliance();
    renderOfficialWritingSuggestions();
    renderOfficialWritingReferences();
    renderOfficialWritingProofread();
    if (tab === 'elements') hydrateOfficialWritingMetaForm();
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
    document.querySelectorAll('[data-official-writing-drawer-tab]').forEach(button => {
        button.classList.remove('active');
        button.setAttribute('aria-selected', 'false');
    });
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
    // 进入历史/规范检索 tab 时按需加载知识库专题库列表。
    if (nextTab === 'history' || nextTab === 'standards') {
        ensureOfficialWritingRagCollections();
    }
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
    pushOfficialWritingUndoSnapshot();
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

// 识别公文段落层级，用于导出时套用不同样式。
function classifyOfficialWritingParagraph(text, index, total) {
    if (index === 0) return 'title';
    const trimmed = text.trim();
    // 主送机关：以中文冒号结尾的短行（如“各部门：”）。
    if (index <= 2 && /[：:]\s*$/.test(trimmed) && trimmed.length <= 30) return 'recipient';
    // 一级标题：一、二、… 或（一）（二）…
    if (/^[一二三四五六七八九十]+、/.test(trimmed)) return 'h1';
    if (/^（[一二三四五六七八九十]+）/.test(trimmed)) return 'h2';
    // 三级：1. 2. （阿拉伯数字）
    if (/^\d+[.、]/.test(trimmed)) return 'h3';
    // 落款单位与日期：靠近文末，且形如单位名或日期。
    if (index >= total - 3) {
        if (/^\d{4}\s*年.*[日号]?\s*$|^\d{4}[.-]\d{1,2}[.-]\d{1,2}\s*$/.test(trimmed)) return 'date';
        if (trimmed.length <= 30 && /(单位|部门|科室|中心|办公室|公司|集团|党委|支部|政府|局|厅|委)\s*$/.test(trimmed)) return 'signoff';
    }
    return 'body';
}

function buildOfficialWritingParagraphXml(text, level) {
    const safe = escapeAppsHtml(text);
    switch (level) {
        case 'title':
            return `<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:after="240"/><w:rPr><w:rFonts w:ascii="SimHei" w:eastAsia="SimHei"/><w:b/><w:sz w:val="44"/></w:rPr></w:pPr><w:r><w:rPr><w:rFonts w:ascii="SimHei" w:eastAsia="SimHei"/><w:b/><w:sz w:val="44"/></w:rPr><w:t xml:space="preserve">${safe}</w:t></w:r></w:p>`;
        case 'recipient':
            return `<w:p><w:pPr><w:rPr><w:sz w:val="32"/></w:rPr></w:pPr><w:r><w:rPr><w:sz w:val="32"/></w:rPr><w:t xml:space="preserve">${safe}</w:t></w:r></w:p>`;
        case 'h1':
            return `<w:p><w:pPr><w:firstLineChars w:val="200"/><w:rPr><w:rFonts w:ascii="SimHei" w:eastAsia="SimHei"/><w:b/><w:sz w:val="32"/></w:rPr></w:pPr><w:r><w:rPr><w:rFonts w:ascii="SimHei" w:eastAsia="SimHei"/><w:b/><w:sz w:val="32"/></w:rPr><w:t xml:space="preserve">${safe}</w:t></w:r></w:p>`;
        case 'h2':
            return `<w:p><w:pPr><w:firstLineChars w:val="200"/><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="32"/></w:rPr><w:t xml:space="preserve">${safe}</w:t></w:r></w:p>`;
        case 'h3':
            return `<w:p><w:pPr><w:firstLineChars w:val="200"/><w:rPr><w:sz w:val="32"/></w:rPr></w:pPr><w:r><w:rPr><w:sz w:val="32"/></w:rPr><w:t xml:space="preserve">${safe}</w:t></w:r></w:p>`;
        case 'signoff':
        case 'date':
            // 落款单位与日期右对齐。
            return `<w:p><w:pPr><w:jc w:val="right"/><w:rPr><w:sz w:val="32"/></w:rPr></w:pPr><w:r><w:rPr><w:sz w:val="32"/></w:rPr><w:t xml:space="preserve">${safe}</w:t></w:r></w:p>`;
        default:
            return `<w:p><w:pPr><w:firstLineChars w:val="200"/><w:rPr><w:sz w:val="32"/></w:rPr></w:pPr><w:r><w:rPr><w:sz w:val="32"/></w:rPr><w:t xml:space="preserve">${safe}</w:t></w:r></w:p>`;
    }
}

// 把发文要素整理为版头行（密级/紧急程度、发文字号、签发人）与版记行（抄送、印发机关、印发日期）。
function getOfficialWritingMetaForExport() {
    return normalizeOfficialWritingMeta(officialWritingState.meta);
}

function buildOfficialWritingHeaderLines() {
    const meta = getOfficialWritingMetaForExport();
    const lines = [];
    const topRight = [meta.secrecy, meta.urgency].filter(Boolean).join('　');
    if (topRight) lines.push({ align: 'right', text: topRight });
    if (meta.issuer) lines.push({ align: 'right', text: `签发人：${meta.issuer}` });
    if (meta.issueNumber) lines.push({ align: 'center', text: meta.issueNumber });
    return lines;
}

function buildOfficialWritingFooterLines() {
    const meta = getOfficialWritingMetaForExport();
    const lines = [];
    if (meta.cc) lines.push(`抄送：${meta.cc}`);
    const printLine = [meta.printer, meta.printDate].filter(Boolean).join('　　');
    if (printLine) lines.push(printLine);
    return lines;
}

function buildOfficialWritingParagraphXmlAligned(text, align) {
    const safe = escapeAppsHtml(text);
    const jc = align === 'right' ? '<w:jc w:val="right"/>' : align === 'center' ? '<w:jc w:val="center"/>' : '';
    return `<w:p><w:pPr>${jc}<w:rPr><w:sz w:val="30"/></w:rPr></w:pPr><w:r><w:rPr><w:sz w:val="30"/></w:rPr><w:t xml:space="preserve">${safe}</w:t></w:r></w:p>`;
}

// 红头：用红色（C00000）大号黑体居中显示发文机关名称，下方一条红线（用红色下边框段落模拟）。
function buildOfficialWritingRedHeaderXml() {
    const meta = getOfficialWritingMetaForExport();
    const issuer = meta.printer || '';
    if (!issuer) return '';
    const safe = escapeAppsHtml(issuer);
    const titleP = `<w:p><w:pPr><w:jc w:val="center"/><w:rPr><w:rFonts w:ascii="SimHei" w:eastAsia="SimHei"/><w:b/><w:color w:val="C00000"/><w:sz w:val="52"/></w:rPr></w:pPr><w:r><w:rPr><w:rFonts w:ascii="SimHei" w:eastAsia="SimHei"/><w:b/><w:color w:val="C00000"/><w:sz w:val="52"/></w:rPr><w:t xml:space="preserve">${safe}</w:t></w:r></w:p>`;
    // 红色分隔线：空段落加底部红色边框。
    const lineP = '<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="24" w:space="1" w:color="C00000"/></w:pBdr><w:spacing w:after="240"/><w:rPr><w:sz w:val="2"/></w:rPr></w:pPr></w:p>';
    return titleP + lineP;
}

function buildOfficialWritingDocxBlob(options = {}) {
    const { redHeader = false } = options;
    const items = splitOfficialWritingParagraphs(officialWritingState.draft || '');
    const total = items.length;
    const bodyParas = items
        .map((item, index) => buildOfficialWritingParagraphXml(item.text, classifyOfficialWritingParagraph(item.text, index, total)))
        .join('');
    // 版头 / 红头 / 版记拼接。
    const redHeaderXml = redHeader ? buildOfficialWritingRedHeaderXml() : '';
    const headerXml = buildOfficialWritingHeaderLines()
        .map(line => buildOfficialWritingParagraphXmlAligned(line.text, line.align))
        .join('');
    const footerLines = buildOfficialWritingFooterLines();
    let footerXml = '';
    if (footerLines.length) {
        // 版记前加一条分隔线。
        footerXml = '<w:p><w:pPr><w:pBdr><w:top w:val="single" w:sz="6" w:space="1" w:color="000000"/></w:pBdr><w:spacing w:before="360"/><w:rPr><w:sz w:val="2"/></w:rPr></w:pPr></w:p>'
            + footerLines.map(line => buildOfficialWritingParagraphXmlAligned(line, 'left')).join('');
    }
    const paragraphs = redHeaderXml + headerXml + bodyParas + footerXml;
    const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>${paragraphs}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="2097" w:right="1587" w:bottom="1984" w:left="1474"/></w:sectPr></w:body>
</w:document>`;
    const nowIso = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    const docTitle = escapeAppsHtml(getOfficialWritingDocType());
    const appName = escapeAppsHtml((typeof APP_NAME !== 'undefined' && APP_NAME) ? APP_NAME : 'Pivot 公文写作');
    const coreXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${docTitle}</dc:title><dc:creator>${appName}</dc:creator><cp:lastModifiedBy>${appName}</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${nowIso}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${nowIso}</dcterms:modified></cp:coreProperties>`;
    const appXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>${appName}</Application></Properties>`;
    const zip = buildZip([
        {
            name: '[Content_Types].xml',
            content: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>'
        },
        {
            name: '_rels/.rels',
            content: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>'
        },
        {
            name: 'docProps/core.xml',
            content: coreXml
        },
        {
            name: 'docProps/app.xml',
            content: appXml
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
    const summary = getOfficialWritingWorkspaceSummary();
    const comments = officialWritingState.comments.map(comment => `- [${comment.target === 'draft' ? '正文稿' : '原文'} / ${comment.anchor || '全文'}] ${comment.text}`).join('\n');
    const lines = [
        `请作为公文写作助手，基于编辑器内容完成「${docType}」的「${modeLabel}」。`,
        '',
        `规范库：${getOfficialWritingStandard()}`,
        `材料来源：${getOfficialWritingMaterialSource()}`,
        `工作区状态：${summary.statusTitle}（${summary.statusDetail}）`,
        `待处理建议：${summary.pendingSuggestions} 条，规范风险：${summary.risks.length} 项，材料引用：${summary.referenceCount} 处。`,
        '',
        '处理要求：',
        '- 使用规范、准确、克制的公文语体。',
        '- 不编造单位、时间、数据和事实；缺失信息请用【待补充】标注。',
        '- 优先保留原有事实信息，优化结构、语气和表达。'
    ];
    if (mode === 'rewrite_section') lines.push('- 重点处理用户标注或批注涉及的局部内容。');
    if (mode === 'review') lines.push('- 按“问题 / 建议 / 示例修改”输出审校意见。');
    if (requirements) lines.push(`- 用户补充要求：${requirements}`);
    lines.push('', '原文：', officialWritingState.source || '【暂无原文】', '', '当前正文稿：', officialWritingState.draft || '【暂无正文稿】');
    if (comments) {
        lines.push('', '批注：', comments);
    }
    return lines.join('\n');
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

function exportOfficialWritingText() {
    syncOfficialWritingStateFromInputs();
    const text = officialWritingState.draft || '';
    if (!text.trim()) {
        showToast('正文为空，无法导出', 'warning');
        return;
    }
    const safeType = getOfficialWritingDocType().replace(/[\\/:*?"<>|]/g, '');
    downloadOfficialWritingFile(`${safeType || '公文'}-${Date.now()}.txt`, text, 'text/plain;charset=utf-8');
    showToast('已导出文本');
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

// 调用项目现有的 OpenAI 兼容补全接口，返回模型文本；失败时返回 null 并提示。
async function callOfficialWritingModel(messages, { maxTokens } = {}) {
    const modelId = getOfficialWritingSelectedModelId();
    if (!modelId) {
        showToast('请先在聊天页选择一个模型后再使用 AI 功能', 'warning');
        return null;
    }
    if (typeof apiFetch !== 'function') {
        showToast('当前环境不支持调用模型', 'error');
        return null;
    }
    try {
        const res = await apiFetch(`${API_BASE}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: modelId,
                messages,
                stream: false,
                temperature: 0.4,
                max_tokens: maxTokens || 2000
            })
        });
        if (!res.ok) {
            const data = await res.clone().json().catch(() => ({}));
            showToast(data?.error?.message || `AI 请求失败（${res.status}）`, 'error');
            return null;
        }
        const data = await res.json();
        const content = data?.choices?.[0]?.message?.content;
        const text = Array.isArray(content)
            ? content.map(part => (typeof part === 'string' ? part : part?.text || '')).join('')
            : String(content || '');
        return text.trim();
    } catch (e) {
        showToast('AI 请求异常，请稍后重试', 'error');
        return null;
    }
}

// 流式调用模型：逐块回调 onDelta(累积文本)，复用聊天端的 SSE 解析。返回最终完整文本或 null。
async function streamOfficialWritingModel(messages, { maxTokens, onDelta } = {}) {
    const modelId = getOfficialWritingSelectedModelId();
    if (!modelId) {
        showToast('请先在聊天页选择一个模型后再使用 AI 功能', 'warning');
        return null;
    }
    if (typeof apiFetch !== 'function' || typeof createBrowserSseParser !== 'function') {
        // 环境不支持流式时退回为一次性请求。
        const text = await callOfficialWritingModel(messages, { maxTokens });
        if (text && typeof onDelta === 'function') onDelta(text);
        return text;
    }
    let full = '';
    try {
        const response = await apiFetch(`${API_BASE}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
            body: JSON.stringify({ model: modelId, messages, stream: true, temperature: 0.4, max_tokens: maxTokens || 2000 })
        });
        if (!response.ok || !response.body) {
            const data = await response.clone().json().catch(() => ({}));
            showToast(data?.error?.message || `AI 请求失败（${response.status}）`, 'error');
            return null;
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        const parser = createBrowserSseParser({
            onData(payload) {
                let data = null;
                try { data = JSON.parse(payload); } catch (e) { return; }
                // 服务端把上游 OpenAI delta 归一化为 {content:"..."}；同时容错原始 delta 形态。
                const chunk = data?.content
                    ?? data?.choices?.[0]?.delta?.content
                    ?? '';
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
        return full.trim();
    } catch (e) {
        showToast('AI 流式请求异常，请稍后重试', 'error');
        return full.trim() || null;
    }
}

function buildOfficialWritingSystemPrompt() {
    return [
        '你是资深公文写作助手，熟悉中文党政机关与企事业单位公文规范。',
        `当前遵循的规范库：${getOfficialWritingStandard()}。`,
        '务必使用规范、准确、庄重、克制的公文语体，不编造单位、时间、数据和事实；缺失信息用【待补充】标注。',
        '严格只输出被要求的内容，不要附加解释、寒暄或额外说明。'
    ].join('');
}

function buildOfficialWritingComments() {
    return officialWritingState.comments
        .map(comment => `- [${comment.target === 'draft' ? '正文稿' : '原文'} / ${comment.anchor || '全文'}] ${comment.text}`)
        .join('\n');
}

// 解析审校模式下模型返回的 JSON 数组；兼容包裹在代码块或带前后说明的情况。
function parseOfficialWritingReviewJson(text) {
    if (!text) return [];
    let cleaned = text.replace(/```(?:json)?/gi, '').trim();
    const firstBracket = cleaned.indexOf('[');
    const lastBracket = cleaned.lastIndexOf(']');
    if (firstBracket >= 0 && lastBracket > firstBracket) {
        cleaned = cleaned.slice(firstBracket, lastBracket + 1);
    }
    try {
        const parsed = JSON.parse(cleaned);
        return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
        return [];
    }
}

async function runOfficialWritingAiTask(mode, { selection } = {}) {
    if (officialWritingAiBusy) return;
    const docType = getOfficialWritingDocType();
    const requirements = getOfficialWritingRequirements();
    const comments = buildOfficialWritingComments();
    const baseText = (selection?.text || '').trim() || officialWritingState.draft.trim();
    const modeLabel = OFFICIAL_WRITING_MODES[mode] || '处理';
    const system = buildOfficialWritingSystemPrompt();
    const userLines = [];

    if (mode === 'draft') {
        userLines.push(`请基于以下材料和要求，起草一篇规范的「${docType}」，包含标题、主送机关、正文、落款单位和成文日期。`);
        userLines.push('只输出公文正文本身，不要输出任何说明。');
        if (requirements) userLines.push(`补充要求：${requirements}`);
        userLines.push('', '材料：', officialWritingState.source || '【暂无材料，请基于文种结构生成规范初稿，未知信息用【待补充】标注】');
    } else if (mode === 'review') {
        userLines.push(`请审校以下「${docType}」的格式与表达，逐项指出问题。`);
        userLines.push('以 JSON 数组输出，数组每一项为对象，字段为：title（问题简述）、original（涉及的原文片段，可为空字符串）、suggestion（具体修改建议）。');
        userLines.push('只输出 JSON，不要输出其它内容。');
        if (requirements) userLines.push(`额外关注：${requirements}`);
        userLines.push('', '正文稿：', officialWritingState.draft || '【暂无正文稿】');
    } else {
        const verb = mode === 'rewrite_section' ? '改写为规范的公文语体' : '润色优化';
        userLines.push(`请将以下「${docType}」文本${verb}，保持事实信息不变，使其更规范、准确、克制。`);
        userLines.push('只输出处理后的文本，不要输出任何说明。');
        if (requirements) userLines.push(`补充要求：${requirements}`);
        userLines.push('', '待处理文本：', baseText);
    }
    if (comments && mode !== 'draft') {
        userLines.push('', '相关批注（请一并参考）：', comments);
    }

    setOfficialWritingAiBusy(true, `AI ${modeLabel}中…`);
    try {
        const result = await callOfficialWritingModel(
            [
                { role: 'system', content: system },
                { role: 'user', content: userLines.join('\n') }
            ],
            { maxTokens: mode === 'draft' ? 2600 : 2000 }
        );
        if (result == null) return;
        if (!result) {
            showToast('AI 未返回有效内容，请调整要求后重试', 'warning');
            return;
        }
        if (mode === 'review') {
            const items = parseOfficialWritingReviewJson(result);
            if (!items.length) {
                // 模型未按 JSON 输出时，退回为整体审校意见，避免丢失结果。
                addOfficialWritingSuggestion({
                    type: '审校',
                    title: 'AI 审校意见',
                    target: 'draft',
                    start: 0,
                    end: 0,
                    original: '',
                    replacement: result,
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
        if (mode === 'draft') {
            const insertionPoint = selection?.text ? selection.start : officialWritingState.draft.length;
            addOfficialWritingSuggestion({
                type: '起草',
                title: `${docType} AI 初稿`,
                target: 'draft',
                start: insertionPoint,
                end: selection?.text ? selection.end : insertionPoint,
                original: selection?.text || '',
                replacement: result,
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
            replacement: result,
            detail: 'AI 生成，可替换、插入、转为批注或保存为新版本。'
        });
        showToast(`AI ${modeLabel}建议已生成`);
    } finally {
        setOfficialWritingAiBusy(false);
    }
}

async function generateOfficialWritingSuggestion(mode = getOfficialWritingMode()) {
    syncOfficialWritingStateFromInputs();
    const selection = getBestOfficialWritingSelection();
    const baseText = selection.text.trim() || officialWritingState.draft.trim();
    if (!baseText && mode !== 'draft') {
        showToast('请先输入正文或选中一段文字', 'warning');
        return;
    }
    await runOfficialWritingAiTask(mode, { selection });
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

const OFFICIAL_WRITING_SELECTION_ACTION_META = {
    polish: { label: '润色', instruction: '对以下公文片段进行润色，使表达更规范、准确、流畅，保持原意和事实不变。' },
    compress: { label: '压缩', instruction: '在保留关键信息和事实的前提下，精炼压缩以下公文片段，使其更简洁。' },
    expand: { label: '扩写', instruction: '在不编造事实的前提下，对以下公文片段进行合理扩写，补充必要的表述和逻辑衔接。' },
    formal: { label: '公文语气', instruction: '将以下片段改写为规范、庄重、克制的公文语体，保持事实信息不变。' }
};

async function runOfficialWritingSelectionAi(action, selection) {
    if (officialWritingAiBusy) return;
    const meta = OFFICIAL_WRITING_SELECTION_ACTION_META[action];
    if (!meta) return;
    const requirements = getOfficialWritingRequirements();
    const userLines = [
        meta.instruction,
        '只输出处理后的文本，不要输出任何说明。'
    ];
    if (requirements) userLines.push(`补充要求：${requirements}`);
    userLines.push('', '待处理片段：', selection.text);
    setOfficialWritingAiBusy(true, `AI ${meta.label}中…`);
    try {
        const result = await callOfficialWritingModel([
            { role: 'system', content: buildOfficialWritingSystemPrompt() },
            { role: 'user', content: userLines.join('\n') }
        ]);
        if (result == null) return;
        if (!result) {
            showToast('AI 未返回有效内容，请重试', 'warning');
            return;
        }
        addOfficialWritingSuggestion({
            type: '选区修改',
            title: `选区${meta.label}建议`,
            target: selection.target,
            start: selection.start,
            end: selection.end,
            original: selection.text,
            replacement: result,
            detail: `来自选区浮动工具条的 AI ${meta.label}。`
        });
        showToast(`AI ${meta.label}建议已生成`);
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
    const requirements = getOfficialWritingRequirements();
    const userLines = [
        '请将以下公文片段改写为更规范、准确、克制的公文语体，保持事实信息不变。',
        '逐句改写，尽量与原文句子一一对应，只输出改写后的文本，不要输出说明。'
    ];
    if (requirements) userLines.push(`补充要求：${requirements}`);
    userLines.push('', '待改写片段：', selection.text);

    openOfficialWritingDiffModal(selection);
    setOfficialWritingDiffStreaming(true);
    setOfficialWritingAiBusy(true, 'AI 流式改写中…');
    try {
        const preview = document.getElementById('official-writing-diff-stream-preview');
        const result = await streamOfficialWritingModel(
            [
                { role: 'system', content: buildOfficialWritingSystemPrompt() },
                { role: 'user', content: userLines.join('\n') }
            ],
            {
                maxTokens: 2200,
                onDelta(full) {
                    if (preview) preview.textContent = full;
                }
            }
        );
        if (result == null) {
            closeOfficialWritingDiffModal();
            return;
        }
        if (!result) {
            showToast('AI 未返回有效内容，请重试', 'warning');
            closeOfficialWritingDiffModal();
            return;
        }
        const rows = buildOfficialWritingSentenceDiff(selection.text, result).map((row, index) => ({
            ...row,
            id: `diff-${index}`,
            // 默认：改写/新增句默认接受新版，相同句保留，删除句默认接受删除。
            accepted: row.type !== 'removed'
        }));
        officialWritingDiffState = { selection, rows, rewritten: result };
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

// 导出为 Markdown：标题用 #，一/二/三级标题分别用 ##/###/####，发文要素以引用块呈现。
function buildOfficialWritingMarkdown() {
    const items = splitOfficialWritingParagraphs(officialWritingState.draft || '');
    const total = items.length;
    const lines = [];
    const header = buildOfficialWritingHeaderLines();
    if (header.length) {
        header.forEach(line => lines.push(`> ${line.text}`));
        lines.push('');
    }
    items.forEach((item, index) => {
        const level = classifyOfficialWritingParagraph(item.text, index, total);
        const text = item.text.trim();
        if (level === 'title') lines.push(`# ${text}`, '');
        else if (level === 'h1') lines.push(`## ${text}`);
        else if (level === 'h2') lines.push(`### ${text}`);
        else if (level === 'h3') lines.push(`#### ${text}`);
        else if (level === 'recipient') lines.push('', text, '');
        else if (level === 'signoff' || level === 'date') lines.push('', `<div align="right">${text}</div>`);
        else lines.push('', text);
    });
    const footer = buildOfficialWritingFooterLines();
    if (footer.length) {
        lines.push('', '---');
        footer.forEach(line => lines.push(line));
    }
    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

// 导出为带版式的纯文本：标题居中（用空格近似）、层级缩进、发文要素分区。
function buildOfficialWritingFormattedText() {
    const WIDTH = 38; // 估算的版心字符宽度（按全角字符计）
    const center = text => {
        const len = text.length;
        if (len >= WIDTH) return text;
        const pad = Math.floor((WIDTH - len) / 2);
        return '　'.repeat(Math.max(0, pad)) + text;
    };
    const right = text => {
        const len = text.length;
        if (len >= WIDTH) return text;
        return '　'.repeat(Math.max(0, WIDTH - len)) + text;
    };
    const items = splitOfficialWritingParagraphs(officialWritingState.draft || '');
    const total = items.length;
    const lines = [];
    buildOfficialWritingHeaderLines().forEach(line => {
        lines.push(line.align === 'center' ? center(line.text) : right(line.text));
    });
    if (lines.length) lines.push('');
    items.forEach((item, index) => {
        const level = classifyOfficialWritingParagraph(item.text, index, total);
        const text = item.text.trim();
        if (level === 'title') { lines.push(center(text), ''); }
        else if (level === 'recipient') lines.push(text);
        else if (level === 'signoff' || level === 'date') lines.push(right(text));
        else if (level === 'body' || level === 'h3') lines.push(`　　${text}`);
        else lines.push(text);
    });
    const footer = buildOfficialWritingFooterLines();
    if (footer.length) {
        lines.push('', '─'.repeat(WIDTH));
        footer.forEach(line => lines.push(line));
    }
    return lines.join('\n');
}

function exportOfficialWriting(type) {
    syncOfficialWritingStateFromInputs();
    const text = officialWritingState.draft || '';
    if (!text.trim()) {
        showToast('正文为空，无法导出', 'warning');
        return;
    }
    const safeType = getOfficialWritingDocType().replace(/[\\/:*?"<>|]/g, '');
    if (type === 'markdown') {
        downloadOfficialWritingFile(`${safeType || '公文'}-${Date.now()}.md`, buildOfficialWritingMarkdown(), 'text/markdown;charset=utf-8');
        showToast('已导出 Markdown');
        return;
    }
    if (type === 'formatted-text') {
        downloadOfficialWritingFile(`${safeType || '公文'}-版式-${Date.now()}.txt`, buildOfficialWritingFormattedText(), 'text/plain;charset=utf-8');
        showToast('已导出带版式文本');
        return;
    }
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
    if (type === 'red-header') {
        if (!getOfficialWritingMetaForExport().printer) {
            showToast('红头模板需先在“发文要素”填写印发机关（作为红头机关名称）', 'warning');
            return;
        }
        downloadOfficialWritingBlob(`${safeType || '公文'}-红头-${Date.now()}.docx`, buildOfficialWritingDocxBlob({ redHeader: true }));
        showToast('已导出红头 DOCX');
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
    const draft = document.getElementById('official-writing-draft');
    if (draft) draft.value = source;
    syncOfficialWritingStateFromInputs();
    renderOfficialWritingWorkspace();
}

function resetOfficialWritingForm() {
    if (hasOfficialWritingDirtyState() && !window.confirm('确认清空当前公文工作区？这会移除原文、正文、批注、版本、建议和自动草稿。')) {
        return;
    }
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
    const select = document.getElementById('official-writing-mode');
    if (select && OFFICIAL_WRITING_MODES[mode]) select.value = mode;
    syncOfficialWritingStateFromInputs();
    if (mode === 'review') {
        // 规范检查（本地、规范库驱动）始终刷新展示，同时调用 AI 生成审校建议。
        renderOfficialWritingWorkspace();
        const risks = getOfficialWritingComplianceRisks();
        if (risks.length) showToast(`本地规范检查发现 ${risks.length} 项风险，AI 审校进行中…`);
    }
    generateOfficialWritingSuggestion(mode);
}

// ===== 知识库 / 历史公文检索接入 =====

// 缓存两个检索面板（历史 / 规范）的最近一次结果，供插入和引用操作复用。
const officialWritingRagResults = { history: [], standards: [] };
let officialWritingRagCollectionsLoaded = false;

async function ensureOfficialWritingRagCollections() {
    if (officialWritingRagCollectionsLoaded) return;
    officialWritingRagCollectionsLoaded = true;
    if (typeof window.loadKnowledgeCollections !== 'function') return;
    let collections = [];
    try {
        collections = await window.loadKnowledgeCollections();
    } catch (e) {
        return;
    }
    if (!Array.isArray(collections)) return;
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
    const start = draft?.selectionEnd || draft?.value.length || 0;
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
    showToast('已加入修改要求');
}

function applyOfficialWritingTemplate(templateId) {
    const template = OFFICIAL_WRITING_TEMPLATES[templateId];
    if (!template) return;
    pushOfficialWritingUndoSnapshot();
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
    document.getElementById('official-writing-mode')?.addEventListener('change', renderOfficialWritingWorkspace);
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
