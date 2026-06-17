// 公文写作工作台：文件导出模块（DOCX / 红头 DOCX / Markdown / 带版式文本 / 打印 PDF / 纯文本）。
// 从 apps-workbench-proofread.js 与 apps-workbench-rewrite.js 按工作流抽出，集中承载导出关注点。
// 纯结构搬移，未改动任何函数实现；依赖的状态与 getter 在运行时（用户点击导出）才调用，加载顺序无要求。

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
