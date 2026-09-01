// 公文写作工作台：文件导出模块。
// 按落地方案 v1.2 §7.2 与阶段 2.4：DOCX 出口全项目唯一，公文版式由服务端统一渲染器输出，
// 前端只做三件事：把编辑器状态映射为 Document IR、调用渲染与下载接口、把返回的字节交给浏览器保存。
// 因此本文件不再包含任何手写 OOXML 与自实现 ZIP 代码，公文版式参数已由
// server/services/document-rendering/official-styles.js 承载。
// Markdown 与带版式纯文本仍在前端本地生成：两者是纯文本降级出口，不产出二进制版式，
// 无需产物沉淀与网络即可使用，方案允许保留。

// 导出提示的级别名集中声明一次，调用处只传中文语义。
const OFFICIAL_WRITING_TOAST_LEVELS = { '提示': '', '警告': 'warning', '错误': 'error' };

// 需要服务端渲染的导出类型。服务端公文版式对 official_document 固定套红头，
// 因此「导出 DOCX」与「红头模板」走同一条渲染路径，只是提示文案不同。
const OFFICIAL_WRITING_RENDER_TARGETS = {
    doc: { format: 'docx', extension: 'docx', label: 'DOCX' },
    'red-header': { format: 'docx', extension: 'docx', label: '红头 DOCX' },
    pdf: { format: 'pdf', extension: 'pdf', label: 'PDF' }
};

// 正文中的分页标记：整行只写「分页」「分页符」「---分页---」「[分页]」时映射为 page_break 块。
const OFFICIAL_WRITING_PAGE_BREAK_PATTERN = /^[-—–=]*\s*[[【]?\s*分\s*页\s*符?\s*[\]】]?\s*[-—–=]*$/;

// 密级关键词到 IR security_level 的映射。服务端密级标识只有公开、内部、秘密、机密四档，
// 只按关键词精确映射：宁可拒绝导出，也不把高密级错标成低密级。
const OFFICIAL_WRITING_SECURITY_KEYWORDS = [
    { keyword: '绝密', level: '' },
    { keyword: '机密', level: 'secret' },
    { keyword: '秘密', level: 'confidential' },
    { keyword: '内部', level: 'internal' },
    { keyword: '公开', level: 'public' }
];

// 渲染与下载都要等服务端出字节，超时放宽到两分钟。
const OFFICIAL_WRITING_RENDER_TIMEOUT_MS = 120000;

// 同一时刻只允许一个导出任务，避免连点触发重复渲染与重复令牌。
let officialWritingRenderBusy = false;

// 本模块内的产物绑定值，由结果沉淀流程通过 bindOfficialWritingExportArtifact 回填。
let officialWritingExportArtifactId = '';

function showOfficialWritingExportToast(message, level = '提示') {
    const type = OFFICIAL_WRITING_TOAST_LEVELS[level] || '';
    if (type) showToast(message, type);
    else showToast(message);
}

// 识别公文段落层级，用于映射 Document IR 时套用不同块类型与版式。
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

// 把「2026年6月12日」「2026-6-12」「2026.6.12」归一化为 IR 要求的 YYYY-MM-DD；无法识别时返回空串。
function parseOfficialWritingIsoDate(value) {
    const matched = /^(\d{4})\s*[年.\-/]\s*(\d{1,2})\s*[月.\-/]\s*(\d{1,2})\s*[日号]?$/.exec(String(value || '').trim());
    if (!matched) return '';
    const month = Number(matched[2]);
    const day = Number(matched[3]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return '';
    return `${matched[1]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// 密级文本转 IR 枚举，返回 { level, hasPeriod, reason }：level 为空表示不能导出，reason 是中文原因。
function resolveOfficialWritingSecurityLevel(secrecy) {
    const text = String(secrecy || '').trim();
    // 未填密级时按公开处理：服务端只给非公开文件逐页加密级标识，避免凭空标注密级。
    if (!text) return { level: 'public', hasPeriod: false, reason: '' };
    const matched = OFFICIAL_WRITING_SECURITY_KEYWORDS.find(item => text.includes(item.keyword));
    if (!matched) {
        return { level: '', hasPeriod: false, reason: '密级只能填写公开、内部、秘密或机密（可附保密期限），请修改“密级与保密期限”后重试' };
    }
    if (!matched.level) {
        return { level: '', hasPeriod: false, reason: '服务端公文版式没有“绝密”密级标识，为避免降级标注已阻止导出，绝密公文请走线下流程' };
    }
    return { level: matched.level, hasPeriod: Boolean(text.replace(matched.keyword, '').trim()), reason: '' };
}

function isOfficialWritingPageBreak(text) {
    return OFFICIAL_WRITING_PAGE_BREAK_PATTERN.test(String(text || '').trim());
}

// 正文段落：首行缩进 2 字符、1.5 倍行距（方案 §7.1 的公文正文样式）。
function buildOfficialWritingIrParagraph(text, style) {
    return { type: 'paragraph', runs: [{ text }], style };
}

// 单个段落转 IR 块：一级「一、」为 heading 1，二级「（一）」为 heading 2，三级「1.」为 heading 3，其余为 paragraph。
function buildOfficialWritingIrBlock(entry) {
    if (entry.level === 'page-break') return { type: 'page_break' };
    const text = String(entry.text || '').trim();
    if (!text) return null;
    if (entry.level === 'h1') return { type: 'heading', level: 1, text };
    if (entry.level === 'h2') return { type: 'heading', level: 2, text };
    if (entry.level === 'h3') return { type: 'heading', level: 3, text };
    // 未被 meta 收走的落款与成文日期右对齐且不缩进；标题行与主送机关不缩进。
    if (entry.level === 'signoff' || entry.level === 'date') {
        return buildOfficialWritingIrParagraph(text, { indent_chars: 0, line_height: 1.5, align: 'right' });
    }
    if (entry.level === 'recipient' || entry.level === 'title') {
        return buildOfficialWritingIrParagraph(text, { indent_chars: 0, line_height: 1.5 });
    }
    return buildOfficialWritingIrParagraph(text, { indent_chars: 2, line_height: 1.5 });
}

// 逐段标注层级；分页标记优先于层级识别。
function collectOfficialWritingIrEntries(draft) {
    const items = splitOfficialWritingParagraphs(draft);
    const total = items.length;
    return items.map((item, index) => ({
        text: item.text.trim(),
        level: isOfficialWritingPageBreak(item.text)
            ? 'page-break'
            : classifyOfficialWritingParagraph(item.text, index, total)
    }));
}

// 从文末回收落款单位与成文日期，各只取一处。日期必须能解析为 YYYY-MM-DD，
// 否则留在正文里右对齐排版，绝不改写用户写下的日期文字。
function takeOfficialWritingTailMeta(entries) {
    const result = { signoff: '', issuedAt: '' };
    for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index];
        if (entry.level === 'date' && !result.issuedAt) {
            const iso = parseOfficialWritingIsoDate(entry.text);
            if (!iso) break;
            result.issuedAt = iso;
            entry.level = 'meta';
            continue;
        }
        if (entry.level === 'signoff' && !result.signoff) {
            result.signoff = entry.text;
            entry.level = 'meta';
            continue;
        }
        break;
    }
    return result;
}

// 编辑器状态映射为 Document IR（doc_type 固定 official_document）。
// 返回 { ir, error, notes }：error 非空表示要素不全、不提交渲染；notes 是需要一并告知用户的中文说明。
function buildOfficialWritingDocumentIr() {
    const meta = getOfficialWritingMetaForExport();
    const entries = collectOfficialWritingIrEntries(officialWritingState.draft || '');
    if (!entries.length) return { ir: null, error: '正文为空，无法导出', notes: [] };
    const notes = [];
    // 标题取正文首段，主送机关取靠前的「……：」行，两者都移出正文块，交给服务端版式排布。
    const titleEntry = entries.find(item => item.level === 'title');
    const recipientEntry = entries.find(item => item.level === 'recipient');
    if (titleEntry) titleEntry.level = 'meta';
    if (recipientEntry) recipientEntry.level = 'meta';
    const tail = takeOfficialWritingTailMeta(entries);
    let issuedAt = tail.issuedAt;
    if (!issuedAt && meta.printDate) {
        issuedAt = parseOfficialWritingIsoDate(meta.printDate);
        if (!issuedAt) notes.push('印发日期格式无法识别，已按无成文日期排版');
    }
    // 服务端把 meta.issuer 同时用作红头机关与版记印发机关，与旧版红头模板取“印发机关”一致；
    // 未填印发机关时退回落款单位，两者都没有就不能出 official_document。
    const issuingOrg = meta.printer || tail.signoff || '';
    if (!issuingOrg) {
        return {
            ir: null,
            error: '服务端公文版式需要发文机关名称，请在“发文要素”填写印发机关，或在正文末尾写明落款单位',
            notes
        };
    }
    if (!meta.printer) notes.push('红头机关取自落款单位');
    const security = resolveOfficialWritingSecurityLevel(meta.secrecy);
    if (!security.level) return { ir: null, error: security.reason, notes };
    if (security.hasPeriod) notes.push('保密期限未纳入服务端密级标识');
    if (meta.cc) notes.push('抄送机关未纳入服务端版记');
    // IR 版头只有 doc_number 一个字段，按公文习惯把紧急程度、发文字号与签发人排在同一行，避免要素丢失。
    const docNumber = [meta.urgency, meta.issueNumber, meta.issuer ? `签发人：${meta.issuer}` : '']
        .filter(Boolean)
        .join('　');
    const blocks = entries
        .filter(item => item.level !== 'meta')
        .map(buildOfficialWritingIrBlock)
        .filter(Boolean);
    if (!blocks.length) return { ir: null, error: '正文只有标题或落款，缺少正文内容，无法导出', notes };
    const ir = {
        ir_version: '1',
        doc_type: 'official_document',
        meta: {
            title: titleEntry ? titleEntry.text : getOfficialWritingDocType(),
            doc_number: docNumber,
            issuer: issuingOrg,
            issued_at: issuedAt,
            security_level: security.level,
            recipient: recipientEntry ? recipientEntry.text : '',
            signoff: tail.signoff
        },
        blocks
    };
    return { ir, error: '', notes };
}

// 服务端渲染以 Agent 产物为载体，产物 ID 必须是正整数，其他形态一律视为未绑定。
function normalizeOfficialWritingArtifactId(value) {
    const text = String(value ?? '').trim();
    return /^[1-9]\d*$/.test(text) ? text : '';
}

// 依次从本模块绑定值、当前公文状态与文档库记录里找产物 ID；找不到返回空串。
function resolveOfficialWritingArtifactId() {
    const candidates = [
        officialWritingExportArtifactId,
        officialWritingState?.artifactId,
        officialWritingState?.agentArtifactId
    ];
    if (typeof getActiveOfficialWritingDoc === 'function') {
        const doc = getActiveOfficialWritingDoc();
        candidates.push(doc?.artifactId, doc?.state?.artifactId);
    }
    return candidates.map(normalizeOfficialWritingArtifactId).find(Boolean) || '';
}

// 供结果沉淀流程回填：公文与 Agent 产物绑定后，DOCX / PDF 才能走服务端渲染器。
function bindOfficialWritingExportArtifact(artifactId) {
    officialWritingExportArtifactId = normalizeOfficialWritingArtifactId(artifactId);
    if (officialWritingState) officialWritingState.artifactId = officialWritingExportArtifactId;
    if (typeof saveOfficialWritingState === 'function') saveOfficialWritingState();
    return officialWritingExportArtifactId;
}

/** 导出前把当前本地编辑稿同步为用户独立 Artifact，保证服务端 Renderer 有权威输入。 */
async function ensureOfficialWritingArtifact() {
    if (typeof apiFetch !== 'function') return '';
    const currentId = resolveOfficialWritingArtifactId();
    const res = await apiFetch(`${API_BASE}/agents/artifacts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            artifactId: currentId || undefined,
            type: 'official_writing',
            title: getOfficialWritingDocType() || '未命名公文',
            content: JSON.stringify({ draft: officialWritingState.draft || '', source: officialWritingState.source || '', meta: officialWritingState.meta || {} }),
            note: '公文工作台导出前自动沉淀'
        })
    });
    if (!res.ok) throw new Error(await readOfficialWritingApiError(res, '公文产物保存失败'));
    const data = await res.json().catch(() => ({}));
    const artifactId = normalizeOfficialWritingArtifactId(data?.artifact?.id);
    if (!artifactId) throw new Error('服务端未返回有效的公文产物标识。');
    bindOfficialWritingExportArtifact(artifactId);
    return artifactId;
}

// 统一取服务端给出的中文错误说明；服务端未给说明时退回带状态码的中文提示。
async function readOfficialWritingApiError(res, fallback) {
    const data = await res.json().catch(() => ({}));
    const message = String(data?.error || data?.message || '').trim();
    return message || `${fallback}（状态码 ${res.status}）`;
}

// 第一步：把 Document IR 交给服务端渲染，成功后返回 rendition 记录。
async function createOfficialWritingRendition(artifactId, ir, format) {
    try {
        const res = await apiFetch(`${API_BASE}/agents/artifacts/${encodeURIComponent(artifactId)}/renditions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ir, format }),
            timeoutMs: OFFICIAL_WRITING_RENDER_TIMEOUT_MS
        });
        if (!res.ok) {
            showOfficialWritingExportToast(await readOfficialWritingApiError(res, '服务端渲染失败'), '错误');
            return null;
        }
        const data = await res.json().catch(() => ({}));
        if (!data?.rendition?.id) {
            showOfficialWritingExportToast('服务端未返回渲染结果，请稍后重试', '错误');
            return null;
        }
        return data.rendition;
    } catch (error) {
        showOfficialWritingExportToast('渲染请求异常，请检查网络后重试', '错误');
        return null;
    }
}

// 第二步：为渲染结果换取一次性下载令牌。
async function requestOfficialWritingDownloadToken(renditionId) {
    try {
        const res = await apiFetch(`${API_BASE}/agents/renditions/${encodeURIComponent(renditionId)}/download-token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({})
        });
        if (!res.ok) {
            showOfficialWritingExportToast(await readOfficialWritingApiError(res, '获取下载令牌失败'), '错误');
            return null;
        }
        const data = await res.json().catch(() => ({}));
        if (!data?.token) {
            showOfficialWritingExportToast('服务端未返回下载令牌，请稍后重试', '错误');
            return null;
        }
        return data;
    } catch (error) {
        showOfficialWritingExportToast('获取下载令牌异常，请检查网络后重试', '错误');
        return null;
    }
}

// 第三步：用一次性令牌下载渲染结果。令牌只能用一次，失败必须重新签发。
async function fetchOfficialWritingRenditionBlob(renditionId, token) {
    const url = `${API_BASE}/agents/renditions/${encodeURIComponent(renditionId)}/download?token=${encodeURIComponent(token)}`;
    try {
        const res = await apiFetch(url, { timeoutMs: OFFICIAL_WRITING_RENDER_TIMEOUT_MS });
        if (!res.ok) {
            showOfficialWritingExportToast(await readOfficialWritingApiError(res, '下载渲染结果失败'), '错误');
            return null;
        }
        const blob = await res.blob();
        if (!blob || !blob.size) {
            showOfficialWritingExportToast('下载到的文件为空，请重新导出', '错误');
            return null;
        }
        return blob;
    } catch (error) {
        showOfficialWritingExportToast('下载请求异常，请检查网络后重试', '错误');
        return null;
    }
}

// 内容校验：与服务端摘要不一致即拒绝保存；浏览器不支持摘要计算时跳过校验（服务端已按令牌校验归属）。
async function verifyOfficialWritingRenditionDigest(blob, expectedDigest) {
    const expected = String(expectedDigest || '').toLowerCase();
    if (!expected || !window.crypto?.subtle || typeof blob.arrayBuffer !== 'function') return true;
    try {
        const digest = await window.crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
        return Array.from(new Uint8Array(digest)).map(item => item.toString(16).padStart(2, '0')).join('') === expected;
    } catch (error) {
        return true;
    }
}

// DOCX 与 PDF 导出：渲染、换令牌、下载三步，任一步失败都给中文提示，不静默失败。
async function exportOfficialWritingByRenderer(target, safeType) {
    if (officialWritingRenderBusy) {
        showOfficialWritingExportToast('正在生成导出文件，请稍候', '警告');
        return;
    }
    const mapped = buildOfficialWritingDocumentIr();
    if (!mapped.ir) {
        showOfficialWritingExportToast(mapped.error || '公文要素不完整，无法导出', '警告');
        return;
    }
    officialWritingRenderBusy = true;
    showOfficialWritingExportToast(`正在按服务端公文版式生成 ${target.label}，请稍候`);
    try {
        const artifactId = await ensureOfficialWritingArtifact();
        if (!artifactId) throw new Error('无法创建公文产物。');
        const rendition = await createOfficialWritingRendition(artifactId, mapped.ir, target.format);
        if (!rendition) return;
        const issued = await requestOfficialWritingDownloadToken(rendition.id);
        if (!issued) return;
        const blob = await fetchOfficialWritingRenditionBlob(rendition.id, issued.token);
        if (!blob) return;
        const digestMatched = await verifyOfficialWritingRenditionDigest(blob, issued.contentDigest || rendition.content_digest);
        if (!digestMatched) {
            showOfficialWritingExportToast('下载内容与服务端摘要不一致，已取消保存，请重新导出', '错误');
            return;
        }
        downloadOfficialWritingBlob(`${safeType || '公文'}-${Date.now()}.${target.extension}`, blob);
        const note = mapped.notes.length ? `（${mapped.notes.join('；')}）` : '';
        showOfficialWritingExportToast(`已按服务端公文版式导出 ${target.label}${note}`);
    } catch (error) {
        showOfficialWritingExportToast(error?.message || '公文产物保存失败，请稍后重试', '错误');
    } finally {
        officialWritingRenderBusy = false;
    }
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
    // DOCX 与 PDF 一律走服务端渲染器；未知类型按 DOCX 处理，前端不再保留第二套版式出口。
    void exportOfficialWritingByRenderer(OFFICIAL_WRITING_RENDER_TARGETS[type] || OFFICIAL_WRITING_RENDER_TARGETS.doc, safeType);
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

// 对外能力：结果沉淀流程绑定产物、自动化侧复用 IR 映射与导出入口。
window.Pivot?.exposeModule?.('apps.officialWritingExport', {
    bindArtifact: bindOfficialWritingExportArtifact,
    resolveArtifactId: resolveOfficialWritingArtifactId,
    buildDocumentIr: buildOfficialWritingDocumentIr,
    exportDocument: exportOfficialWriting
});
