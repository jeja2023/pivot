// 公文写作工作台：文件导出模块。
// 按落地方案 v1.2 §7.2 与阶段 2.4：DOCX 出口全项目唯一，公文版式由服务端统一渲染器输出，
// 前端只做三件事：把编辑器状态映射为 Document IR、调用渲染与下载接口、把返回的字节交给浏览器保存。
// 因此本文件不再包含任何手写 OOXML 与自实现 ZIP 代码，公文版式参数已由
// server/services/document-rendering/official-styles.js 承载。
// Markdown 与带版式纯文本仍在前端本地生成：两者是纯文本降级出口，不产出二进制版式，
// 无需产物沉淀与网络即可使用，方案允许保留。

// 导出提示的级别名集中声明一次，调用处只传中文语义。
const OFFICIAL_WRITING_TOAST_LEVELS = { '提示': '', '警告': 'warning', '错误': 'error' };

// 需要服务端渲染的导出类型，普通与红头版式在预览中明确选择。
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

function showOfficialWritingExportToast(message, level = '提示') {
    const type = OFFICIAL_WRITING_TOAST_LEVELS[level] || '';
    if (type) showToast(message, type);
    else showToast(message);
}

// 识别公文段落层级，用于映射 Document IR 时套用不同块类型与版式。
function classifyOfficialWritingParagraph(text, index, total) {
    if (index === 0) return 'title';
    const value = text.trim();
    if (index <= 2 && /[：:]$/.test(value) && value.length <= 120) return 'recipient';
    const level = officialWritingFormat.headingLevel(value);
    if (level) return 'h' + level;
    if (/^附件[：:]/.test(value)) return 'attachment-note';
    if (index >= total - 3) {
        if (officialWritingDocument.isoDate(value)) return 'date';
        if (value.length <= 60 && /(单位|部门|科室|中心|办公室|公司|集团|党委|支部|政府|局|厅|委)$/.test(value)) return 'signoff';
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
function parseOfficialWritingIsoDate(value) { return officialWritingDocument.isoDate(value); }

// 密级文本转 IR 枚举，返回 { level, hasPeriod, reason }：level 为空表示不能导出，reason 是中文原因。
function resolveOfficialWritingSecurityLevel(secrecy) {
    const text = String(secrecy || '').trim();
    // 未填密级时按公开处理：服务端只给非公开文件逐页加密级标识，避免凭空标注密级。
    if (!text) return { level: 'public', hasPeriod: false, reason: '' };
    const matched = OFFICIAL_WRITING_SECURITY_KEYWORDS.find(item => text.startsWith(item.keyword));
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
    const text = entry.level === 'attachment-note' ? String(entry.text || '') : String(entry.text || '').trim();
    if (!text) return null;
    if (/^h[1-4]$/.test(entry.level)) return { type: 'heading', level: Number(entry.level.slice(1)), text: officialWritingFormat.normalizeHeading(text, Number(entry.level.slice(1))) };
    if (entry.level === 'attachment-note') return buildOfficialWritingIrParagraph(text.replace(/^附件[:：]\s*/, '附件：').replace(/[。；;]+$/, ''), {
        official_role: 'attachment_note', attachment_prefix: entry.attachmentPrefix || /^附件[:：]\s*(?:\d+[.．]\s*)?/.exec(text)?.[0].replace(':', '：') || '附件：'
    });
    return buildOfficialWritingIrParagraph(text, { indent_chars: ['recipient', 'title', 'signoff', 'date'].includes(entry.level) ? 0 : 2 });
}

// 逐段标注层级；分页标记优先于层级识别。
function collectOfficialWritingIrEntries(draft) {
    const items = splitOfficialWritingParagraphs(draft);
    const total = items.length;
    let attachmentNotes = false;
    return items.map((item, index) => {
        const text = item.text.trim();
        const level = isOfficialWritingPageBreak(text) ? 'page-break' : classifyOfficialWritingParagraph(text, index, total);
        if (level === 'attachment-note') attachmentNotes = true;
        else if (attachmentNotes && /^\d+[.．]\s*/.test(text)) {
            const number = /^\d+[.．]\s*/.exec(text)[0];
            return { text: '　　　' + text, level: 'attachment-note', attachmentPrefix: '　　　' + number };
        } else attachmentNotes = false;
        return { text, level };
    });
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
function buildOfficialWritingDocumentIr(state = officialWritingState, { layout = 'plain' } = {}) {
    if ((state.attachments || []).some(item => item.content.trim() && !item.name.trim())) return { ir: null, error: '请填写有正文的附件名称', notes: [] };
    const meta = normalizeOfficialWritingMeta(state.meta);
    const entries = collectOfficialWritingIrEntries(state.draft || '');
    if (!entries.length) return { ir: null, error: '正文为空，无法导出', notes: [] };
    const title = entries.find(entry => entry.level === 'title');
    const recipient = entries.find(entry => entry.level === 'recipient');
    if (title) title.level = 'meta'; if (recipient) recipient.level = 'meta';
    const tail = takeOfficialWritingTailMeta(entries);
    const issuedAt = parseOfficialWritingIsoDate(meta.issuedAt) || tail.issuedAt;
    const printedAt = parseOfficialWritingIsoDate(meta.printDate);
    if (meta.issuedAt && !parseOfficialWritingIsoDate(meta.issuedAt)) return { ir: null, error: '成文日期不是有效日期', notes: [] };
    if (meta.printDate && !printedAt) return { ir: null, error: '印发日期不是有效日期', notes: [] };
    const signoff = meta.signoff || tail.signoff;
    const issuingOrg = meta.issuingOrg || signoff;
    if (layout === 'red_header' && !issuingOrg) return { ir: null, error: '红头公文需要填写发文机关或落款单位', notes: [] };
    const security = resolveOfficialWritingSecurityLevel(meta.secrecy);
    if (!security.level) return { ir: null, error: security.reason, notes: [] };
    const hasAttachments = (state.attachments || []).some(item => item.name.trim());
    const blocks = entries.filter(entry => entry.level !== 'meta' && !(hasAttachments && entry.level === 'attachment-note')).map(buildOfficialWritingIrBlock).filter(Boolean);
    if (!blocks.length) return { ir: null, error: '缺少正文内容', notes: [] };
    const attachments = (state.attachments || []).filter(item => item.name.trim());
    for (const note of officialWritingFormat.attachmentNotes(attachments)) blocks.push(buildOfficialWritingIrParagraph(note.text, { official_role: 'attachment_note', attachment_prefix: note.prefix }));
    for (const [index, attachment] of attachments.entries()) {
        blocks.push({ type: 'page_break' });
        blocks.push(buildOfficialWritingIrParagraph(attachments.length > 1 ? '附件' + (index + 1) : '附件', { official_role: 'attachment_label' }));
        blocks.push(buildOfficialWritingIrParagraph(attachment.name.replace(/[。；;]+$/, ''), { official_role: 'attachment_title' }));
        for (const entry of collectOfficialWritingIrEntries(attachment.content || '')) {
            if (!entry.text) continue;
            const level = officialWritingFormat.headingLevel(entry.text);
            blocks.push(level ? { type: 'heading', level, text: officialWritingFormat.normalizeHeading(entry.text, level) } : buildOfficialWritingIrParagraph(entry.text, { indent_chars: 2 }));
        }
    }
    const notes = [...officialWritingDocument.summary(state).issues];
    const originalTitle = title?.text || state.docType || '公文';
    const customTitle = meta.titleBreaks.trim();
    if (customTitle && customTitle.replace(/\s/g, '') !== originalTitle.replace(/\s/g, '')) return { ir: null, error: '标题分行文字与正文标题不一致，请仅调整换行位置', notes: [] };
    if (attachments.some(item => !item.content.trim())) notes.push('有附件正文未填写，请核对附件内容');
    return { error: '', notes, ir: { ir_version: '1', doc_type: 'official_document', meta: {
        title: customTitle || originalTitle, issuer: issuingOrg, issued_at: issuedAt || '',
        doc_number: meta.issueNumber, signer: meta.issuer, urgency: meta.urgency, security_level: security.level,
        security_period: security.hasPeriod ? meta.secrecy.replace(/^(公开|内部|秘密|机密)/, '').trim() : '',
        recipient: recipient?.text || '', signoff, cc: meta.cc, printer: meta.printer, printed_at: printedAt, layout,
        page: { ...officialWritingFormat.PAGE, margin_mm: { ...officialWritingFormat.PAGE.margin_mm } }
    }, blocks } };
}

// 服务端渲染以 Agent 产物为载体，产物 ID 必须是正整数，其他形态一律视为未绑定。
function normalizeOfficialWritingArtifactId(value) {
    const text = String(value ?? '').trim();
    return /^[1-9]\d*$/.test(text) ? text : '';
}

// 依次从本模块绑定值、当前公文状态与文档库记录里找产物 ID；找不到返回空串。
function resolveOfficialWritingArtifactId() {
    return normalizeOfficialWritingArtifactId(getActiveOfficialWritingDoc()?.artifactId || officialWritingState.artifactId);
}

// 供结果沉淀流程回填：公文与 Agent 产物绑定后，DOCX / PDF 才能走服务端渲染器。
function bindOfficialWritingExportArtifact(artifactId, documentId = officialWritingLibrary.activeId) {
    const doc = officialWritingLibrary.docs.find(item => item.id === documentId);
    if (!doc) return '';
    const normalized = normalizeOfficialWritingArtifactId(artifactId);
    doc.artifactId = normalized;
    if (doc._loaded) doc.state.artifactId = normalized;
    return normalized;
}

/** 导出前把当前本地编辑稿同步为用户独立 Artifact，保证服务端 Renderer 有权威输入。 */
async function ensureOfficialWritingArtifact(doc = getActiveOfficialWritingDoc()) {
    if (!doc?._loaded) throw new Error('请先打开公文');
    const owner = getOfficialWritingOwner();
    if (!await scheduleOfficialWritingDocumentSave(doc, { immediate: true })) throw new Error('请先解决保存失败或版本冲突');
    const res = await apiFetch(OFFICIAL_WRITING_DOCUMENTS_API + '/' + encodeURIComponent(doc.id) + '/export-artifact', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: doc.version })
    });
    if (!res.ok) throw new Error(await readOfficialWritingApiError(res, '公文产物保存失败'));
    const data = await res.json();
    if (owner !== getOfficialWritingOwner() || !officialWritingLibrary.docs.includes(doc)) throw new Error('当前账号或文档已切换，请重新导出');
    const id = normalizeOfficialWritingArtifactId(data.artifactId);
    if (!id) throw new Error('服务端未返回公文产物标识');
    bindOfficialWritingExportArtifact(id, doc.id);
    return id;
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
    return openOfficialWritingExportPreview(target, safeType);
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


let officialWritingExportPreview = null;
let officialWritingExportSequence = 0;

function closeOfficialWritingExportPreview() {
    ++officialWritingExportSequence;
    hideOfficialWritingModal('official-writing-export-modal');
    document.getElementById('official-writing-export-frame')?.replaceChildren();
    officialWritingExportPreview = null;
}

async function openOfficialWritingExportPreview(target, _safeType) {
    syncOfficialWritingStateFromInputs();
    const doc = getActiveOfficialWritingDoc();
    officialWritingExportPreview = { docId: doc.id, title: doc.title, target, state: sanitizeOfficialWritingState(doc.state),
        fingerprint: computeOfficialWritingDocFingerprint(doc), owner: getOfficialWritingOwner() };
    showOfficialWritingModal('official-writing-export-modal');
    await refreshOfficialWritingExportPreview();
}

async function downloadOfficialWritingRendition(rendition) {
    const token = await requestOfficialWritingDownloadToken(rendition.id);
    if (!token) throw new Error('无法获取下载凭证');
    const blob = await fetchOfficialWritingRenditionBlob(rendition.id, token.token);
    if (!blob || !await verifyOfficialWritingRenditionDigest(blob, token.contentDigest || rendition.content_digest)) throw new Error('下载内容摘要不一致');
    return blob;
}

async function refreshOfficialWritingExportPreview() {
    const preview = officialWritingExportPreview;
    if (!preview || officialWritingRenderBusy) return;
    const sequence = ++officialWritingExportSequence;
    officialWritingRenderBusy = true;
    const button = document.getElementById('official-writing-export-confirm-btn');
    if (button) button.disabled = true;
    for (const id of ['official-writing-export-layout', 'official-writing-export-preview-btn']) {
        const control = document.getElementById(id); if (control) control.disabled = true;
    }
    setText('official-writing-export-status', '正在生成实际版式预览…');
    try {
        const layout = document.getElementById('official-writing-export-layout')?.value || 'plain';
        const mapped = buildOfficialWritingDocumentIr(preview.state, { layout });
        if (!mapped.ir) throw new Error(mapped.error);
        preview.ir = mapped.ir;
        setText('official-writing-export-elements', [
            '版式：截图标准 · 22行×28字 · 固定28磅行距',
            '字体：2号方正小标宋 / 3号方正仿宋、黑体、楷体 / 4号宋体页码',
            '标题：' + mapped.ir.meta.title, '发文机关：' + (mapped.ir.meta.issuer || '未填写'),
            '签发人：' + (mapped.ir.meta.signer || '未填写'), '落款：' + (mapped.ir.meta.signoff || '未填写'),
            '成文日期：' + (mapped.ir.meta.issued_at || '未填写'), '抄送：' + (mapped.ir.meta.cc || '未填写'),
            '印发机关：' + (mapped.ir.meta.printer || '未填写'), '印发日期：' + (mapped.ir.meta.printed_at || '未填写'),
            '密级及期限：' + (preview.state.meta.secrecy || '公开'), ...mapped.notes.map(note => '需核对：' + note)
        ].join('\n'));
        const doc = officialWritingLibrary.docs.find(item => item.id === preview.docId);
        if (!doc || preview.owner !== getOfficialWritingOwner() || computeOfficialWritingDocFingerprint(doc) !== preview.fingerprint) throw new Error('正文已变化，请关闭后重新预览');
        const artifactId = await ensureOfficialWritingArtifact(doc);
        if (computeOfficialWritingDocFingerprint(doc) !== preview.fingerprint) throw new Error('正文在预览生成期间变化，请重新预览');
        preview.artifactId = artifactId;
        preview.fingerprint = computeOfficialWritingDocFingerprint(doc);
        const rendition = await createOfficialWritingRendition(artifactId, mapped.ir, 'pdf');
        if (!rendition) throw new Error('PDF 预览生成失败，请检查字体及渲染服务后重试');
        const blob = await downloadOfficialWritingRendition(rendition);
        if (sequence !== officialWritingExportSequence || officialWritingExportPreview !== preview) return;
        preview.pdfBlob = blob;
        const frame = document.getElementById('official-writing-export-frame');
        const pages = frame ? await renderOfficialWritingPdfPreview(blob, frame, sequence) : 0;
        if (sequence !== officialWritingExportSequence) return;
        const note = preview.target.format === 'docx' ? 'Word 参考预览，具体换行以本机 Word 为准。' : 'PDF 实际页面预览。';
        setText('official-writing-export-status', note + (pages > 20 ? '预览前 20 页，下载文件包含全部页面。' : '') + (mapped.notes.length ? '请核对以上待补齐项后下载。' : '可下载文件。'));
        if (button) button.disabled = false;
    } catch (error) {
        if (sequence === officialWritingExportSequence) setText('official-writing-export-status', error.message || '预览失败，请重试');
    } finally {
        officialWritingRenderBusy = false;
        for (const id of ['official-writing-export-layout', 'official-writing-export-preview-btn']) {
            const control = document.getElementById(id); if (control) control.disabled = false;
        }
        if (officialWritingExportPreview && officialWritingExportPreview !== preview) void refreshOfficialWritingExportPreview();
    }
}

async function renderOfficialWritingPdfPreview(blob, container, sequence) {
    const revision = typeof APP_VERSION === 'string' ? encodeURIComponent(APP_VERSION) : 'dev';
    const pdfjs = await import('/common/vendor/pdfjs/pdf.mjs?v=' + revision);
    pdfjs.GlobalWorkerOptions.workerSrc = '/common/vendor/pdfjs/pdf.worker.mjs?v=' + revision;
    const task = pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()), isEvalSupported: false, useSystemFonts: true });
    let pdfDocument = null;
    try {
        pdfDocument = await task.promise;
        container.replaceChildren();
        for (let number = 1; number <= Math.min(pdfDocument.numPages, 20); number++) {
            if (sequence !== officialWritingExportSequence) break;
            const page = await pdfDocument.getPage(number);
            const base = page.getViewport({ scale: 1 });
            const scale = Math.min(1.7, Math.max(0.5, (container.clientWidth || 850) / base.width));
            const viewport = page.getViewport({ scale });
            const canvas = document.createElement('canvas');
            canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
            canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', `公文第 ${number} 页`);
            container.appendChild(canvas);
            await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
            page.cleanup();
        }
        return document.numPages;
    } finally { if (pdfDocument) await pdfDocument.destroy(); else await task.destroy(); }
}

async function downloadOfficialWritingPreview() {
    const preview = officialWritingExportPreview;
    if (!preview?.pdfBlob || officialWritingRenderBusy) return;
    officialWritingRenderBusy = true;
    try {
        const doc = officialWritingLibrary.docs.find(item => item.id === preview.docId);
        if (!doc || preview.owner !== getOfficialWritingOwner() || preview.fingerprint !== computeOfficialWritingDocFingerprint(doc)) throw new Error('正文已变化，请重新预览');
        let blob = preview.pdfBlob;
        if (preview.target.format !== 'pdf') {
            const rendition = await createOfficialWritingRendition(preview.artifactId, preview.ir, preview.target.format);
            if (!rendition) throw new Error('文件生成失败');
            blob = await downloadOfficialWritingRendition(rendition);
        }
        if (preview.owner !== getOfficialWritingOwner() || !officialWritingLibrary.docs.includes(doc) || officialWritingDeletedDocumentIds.has(doc.id)) return;
        const name = preview.title.replace(/[\/:*?"<>|]/g, '').slice(0, 100) || '公文';
        downloadOfficialWritingBlob(name + '.' + preview.target.extension, blob);
        showToast('已导出 ' + preview.target.label);
    } catch (error) { showToast(error.message || '导出失败', 'error'); }
    finally { officialWritingRenderBusy = false; }
}
