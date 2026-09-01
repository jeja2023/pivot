/**
 * server/services/document-rendering/text-renderers.js
 * Document IR → Markdown / HTML 渲染器
 *
 * 落地方案 v1.2 §7.2 依赖决策表：HTML / Markdown 由服务端模板字符串自研，
 * 逻辑量小，属于开发规范第 32 条「应当自研」的范围，不引入模板引擎或 Markdown 库。
 *
 * 三条硬约束：
 * 1. 确定性（§10.2 渲染幂等性）：输出只由规范化后的 IR 决定，不写入时间戳、
 *    随机数或环境相关内容，同一 IR 两次渲染的 sha256 必须一致；
 * 2. 防注入：IR 文本是不可信输入，一律先经 escapeHtml / escapeMarkdown 转义
 *    才能进入标签、属性或结构字符位置，禁止把 IR 文本直接拼进标签；
 * 3. Air-Gapped：产物不引用任何外部资源（无公共 CDN、无远端字体、无外链图片），
 *    字体只写字体族名交由终端本机解析，不分发字体文件（§7.2 字体授权约束）。
 *
 * 这里不复用 document-processing/exporters 的 escapeHtml：那个模块会连带引入
 * 数据库与输出目录依赖，且按 §7.2 的迁移次序它将来要反向调用本渲染器，
 * 直接引用会形成循环依赖，因此本文件自带一份纯函数转义实现。
 */
const { CAS_REF_PATTERN } = require('../document-ir');

const MARKDOWN_RENDERER_VERSION = 'md-1.0.0';
const HTML_RENDERER_VERSION = 'html-1.0.0';
const MARKDOWN_MIME_TYPE = 'text/markdown; charset=utf-8';
const HTML_MIME_TYPE = 'text/html; charset=utf-8';

/** 密级枚举到中文标签。 */
const SECURITY_LEVEL_LABELS = Object.freeze({
    public: '公开',
    internal: '内部',
    confidential: '秘密',
    secret: '机密'
});

/** CSS @page 的纸张关键字（CSS 中 letter 为小写）。 */
const PAGE_SIZE_KEYWORDS = Object.freeze({ A4: 'A4', A3: 'A3', Letter: 'letter' });

/** 纸张尺寸（毫米），用于屏幕预览时还原页宽。 */
const PAGE_SIZE_MM = Object.freeze({
    A4: Object.freeze({ width: 210, height: 297 }),
    A3: Object.freeze({ width: 297, height: 420 }),
    Letter: Object.freeze({ width: 215.9, height: 279.4 })
});

/** 公文字体族链：只写字体名，不分发字体文件。 */
const FONT_CHAINS = Object.freeze({
    song: Object.freeze(['SimSun', '宋体', 'Songti SC', 'Noto Serif CJK SC', 'serif']),
    fangsong: Object.freeze(['FangSong_GB2312', '仿宋_GB2312', 'FangSong', '仿宋', 'Noto Serif CJK SC', 'serif']),
    hei: Object.freeze(['SimHei', '黑体', 'Heiti SC', 'Noto Sans CJK SC', 'sans-serif']),
    title: Object.freeze(['FZXiaoBiaoSong-B05S', '方正小标宋简体', 'STZhongsong', 'SimSun', '宋体', 'serif'])
});

const GENERIC_FONT_FAMILIES = Object.freeze(new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy']));
const ALIGN_WHITELIST = Object.freeze(new Set(['left', 'center', 'right', 'justify']));

/** IR 的 heading.level 1-4 映射到 h2-h5：h1 留给 meta.title，标题层级不跳级。 */
const HEADING_TAGS = Object.freeze(['h2', 'h3', 'h4', 'h5']);

/** 页码格式串上限，避免异常 IR 把 CSS 撑大。 */
const MAX_FOOTER_FORMAT_LENGTH = 200;

/** 统一换行符，保证同一语义文本在不同来源下渲染结果一致。 */
function normalizeNewlines(value) {
    return String(value ?? '').replace(/\r\n?/g, '\n');
}

/** HTML 转义：< > & " ' 全部转义，是防注入的唯一入口。 */
function escapeHtml(value) {
    return normalizeNewlines(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/** 行内 HTML 转义：转义后再把换行还原为 <br>，避免正文里的换行被压成空格。 */
function escapeHtmlInline(value) {
    return escapeHtml(value).replace(/\n/g, '<br>');
}

/** 合并 paragraph 的 runs 为纯文本，供 Markdown 之外的渲染器（如 XLSX）复用。 */
function mergeRunsToPlainText(runs) {
    if (!Array.isArray(runs)) return '';
    return runs.map(run => normalizeNewlines(run && run.text)).join('');
}

/** 只接受 IR 校验通过的 artifact-cas 受控引用，其他一律丢弃。 */
function safeAssetRef(value) {
    const ref = String(value ?? '');
    return CAS_REF_PATTERN.test(ref) ? ref : '';
}

/** 渲染前的最低形状校验：渲染器只接受 validateDocumentIr 规范化后的 IR。 */
function assertRenderableIr(ir) {
    if (!ir || typeof ir !== 'object' || Array.isArray(ir)) {
        throw new Error('渲染失败：IR 必须是对象，请先调用 validateDocumentIr 校验并取规范化结果。');
    }
    if (!ir.meta || typeof ir.meta !== 'object' || !ir.meta.page) {
        throw new Error('渲染失败：IR 缺少规范化后的 meta 或 meta.page，请先调用 validateDocumentIr。');
    }
    if (!Array.isArray(ir.blocks) || !ir.blocks.length) {
        throw new Error('渲染失败：IR 的 blocks 为空，没有可渲染的内容。');
    }
}

/**
 * Markdown 转义：只处理会改变结构、或被下游 Markdown→HTML 渲染当作裸 HTML 的字符。
 * CommonMark 允许对 ASCII 标点做反斜杠转义，因此 \< 会被还原为字面量 <，
 * 不会形成可执行标签。
 */
function escapeMarkdown(value) {
    return normalizeNewlines(value).replace(/([\\`*_[\]<>|&])/g, '\\$1');
}

/** 压成单行：表格单元格与元数据列表不允许换行，否则会破坏行结构。 */
function markdownSingleLine(value) {
    return escapeMarkdown(value).replace(/[\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim();
}

/** 行首的结构字符会把正文变成标题、引用或列表，逐行加反斜杠隔断。 */
function guardMarkdownLineStart(line) {
    return line
        .replace(/^(\s*)([#+=~:-])/, '$1\\$2')
        .replace(/^(\s*)(\d+)([.)])/, '$1$2\\$3');
}

/** run 的行内样式：Markdown 没有原生下划线语法，用下划线字符包裹作为说明性写法。 */
function markdownInline(run) {
    const text = escapeMarkdown(run && run.text);
    if (!text.trim()) return text;
    let decorated = text;
    if (run.underline) decorated = `_${decorated}_`;
    if (run.italic) decorated = `*${decorated}*`;
    if (run.bold) decorated = `**${decorated}**`;
    return decorated;
}

/**
 * GFM 分隔行。Markdown 无法表达列宽，widths_pct 在此被忽略（与列宽无关），
 * 对齐只取 style.align。
 */
function markdownAlignRow(columnCount, align) {
    let marker = '---';
    if (align === 'center') marker = ':---:';
    else if (align === 'right') marker = '---:';
    else if (align === 'left') marker = ':---';
    return `| ${new Array(columnCount).fill(marker).join(' | ')} |`;
}

/** 文档头：标题用 #，发文单位/发文字号/成文日期等元数据用列表。 */
function markdownMetaLines(ir) {
    const meta = ir.meta;
    const lines = [`# ${markdownSingleLine(meta.title) || '未命名文档'}`, ''];
    const items = [
        ['发文单位', meta.issuer],
        ['发文字号', meta.doc_number],
        ['成文日期', meta.issued_at],
        ['密级', SECURITY_LEVEL_LABELS[meta.security_level] || meta.security_level],
        ['副标题', meta.subtitle],
        ['主送机关', meta.recipient]
    ].filter(item => String(item[1] ?? '').trim());
    items.forEach(item => lines.push(`- ${item[0]}：${markdownSingleLine(item[1])}`));
    if (items.length) lines.push('');
    return lines;
}

/** 单个 block 追加为 Markdown 行。 */
function markdownBlock(block, lines) {
    if (block.type === 'heading') {
        const level = Math.min(Math.max(Number(block.level) || 1, 1), 4);
        lines.push(`${'#'.repeat(level + 1)} ${markdownSingleLine(block.text)}`, '');
        return;
    }
    if (block.type === 'paragraph') {
        const text = block.runs.map(markdownInline).join('');
        // 逐行隔断：段落内的换行后若紧跟结构字符，同样会被当成标题或列表。
        if (text.trim()) text.split('\n').forEach(line => lines.push(guardMarkdownLineStart(line)));
        lines.push('');
        return;
    }
    if (block.type === 'table') {
        const header = block.header.map(markdownSingleLine);
        lines.push(`| ${header.join(' | ')} |`);
        lines.push(markdownAlignRow(header.length, block.style && block.style.align));
        block.rows.forEach(row => lines.push(`| ${row.map(markdownSingleLine).join(' | ')} |`));
        lines.push('');
        return;
    }
    if (block.type === 'list') {
        block.items.forEach((item, index) => {
            const prefix = block.ordered ? `${index + 1}. ` : '- ';
            lines.push(`${prefix}${markdownSingleLine(item)}`);
        });
        lines.push('');
        return;
    }
    if (block.type === 'page_break') {
        lines.push('---', '');
        return;
    }
    if (block.type === 'image') {
        const ref = safeAssetRef(block.asset_ref);
        if (ref) lines.push(`![](${ref})`, '');
    }
}

/** 落款：发文单位与成文日期已在文档头列出，此处只补 signoff 文本。 */
function markdownSignoffLines(ir) {
    const signoff = String(ir.meta.signoff ?? '').trim();
    return signoff ? [markdownSingleLine(signoff), ''] : [];
}

/** IR → Markdown（GFM）。输出为 UTF-8 Buffer，末尾固定一个换行。 */
function renderMarkdown(ir) {
    assertRenderableIr(ir);
    const lines = markdownMetaLines(ir);
    ir.blocks.forEach(block => markdownBlock(block, lines));
    lines.push(...markdownSignoffLines(ir));
    const text = `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
    return Buffer.from(text, 'utf8');
}

/** 字体名白名单化：只保留字母、数字、下划线、空格、连字符与中日韩字符。 */
function sanitizeFontName(value) {
    return String(value ?? '').replace(/[^0-9A-Za-z\u3400-\u9fff_ -]/g, '').trim().slice(0, 40);
}

/** 生成 CSS font-family 值；通用族不加引号，具体字体名加引号。 */
function cssFontFamily(names) {
    const seen = new Set();
    const parts = [];
    (Array.isArray(names) ? names : []).forEach(name => {
        const clean = sanitizeFontName(name);
        if (!clean || seen.has(clean)) return;
        seen.add(clean);
        parts.push(GENERIC_FONT_FAMILIES.has(clean) ? clean : `"${clean}"`);
    });
    return parts.join(', ');
}

/** 数值夹取并限定小数位，保证同一 IR 生成同一串 CSS。 */
function cssNumber(value, fallback, min, max) {
    const parsed = Number(value);
    const base = Number.isFinite(parsed) ? parsed : fallback;
    return Math.round(Math.min(Math.max(base, min), max) * 1000) / 1000;
}

/** 只接受 #RGB / #RRGGBB，其他一律丢弃，避免颜色值成为 CSS 注入点。 */
function cssColor(value) {
    const text = String(value ?? '').trim();
    return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(text) ? text : '';
}

/**
 * CSS 字符串字面量转义，用于 @page 页码格式等 content 取值。
 * 除了转义反斜杠与双引号，还必须去掉尖括号：内联 <style> 里的 </style>
 * 会被 HTML 解析器提前闭合样式块，从而把后续文本当作标签处理。
 */
function cssString(value) {
    const text = normalizeNewlines(value)
        .slice(0, MAX_FOOTER_FORMAT_LENGTH)
        .replace(/[<>]/g, '')
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\n/g, ' ');
    return `"${text}"`;
}

/** IR font → CSS 声明；西文族在前、中日韩族在后，浏览器按字符自动回退。 */
function fontDeclarations(font) {
    const declarations = [];
    if (!font || typeof font !== 'object') return declarations;
    const chain = [];
    if (font.ascii) chain.push(font.ascii);
    if (font.eastAsia) chain.push(font.eastAsia);
    if (Array.isArray(font.family_chain)) chain.push(...font.family_chain);
    const family = cssFontFamily(chain);
    if (family) declarations.push(`font-family:${family}`);
    if (font.size_pt !== undefined) declarations.push(`font-size:${cssNumber(font.size_pt, 16, 5, 72)}pt`);
    if (font.bold !== undefined) declarations.push(`font-weight:${font.bold ? 700 : 400}`);
    const color = cssColor(font.color);
    if (color) declarations.push(`color:${color}`);
    return declarations;
}

/** IR style → CSS 声明，全部为白名单枚举或夹取后的数值，不含任何原始文本。 */
function styleDeclarations(style) {
    const declarations = [];
    if (!style || typeof style !== 'object') return declarations;
    if (style.indent_chars !== undefined) declarations.push(`text-indent:${cssNumber(style.indent_chars, 0, 0, 20)}em`);
    if (style.line_height !== undefined) declarations.push(`line-height:${cssNumber(style.line_height, 1.5, 0.5, 5)}`);
    if (style.space_after_pt !== undefined) declarations.push(`margin-bottom:${cssNumber(style.space_after_pt, 0, 0, 200)}pt`);
    if (style.align !== undefined && ALIGN_WHITELIST.has(String(style.align))) declarations.push(`text-align:${String(style.align)}`);
    declarations.push(...fontDeclarations(style.font));
    return declarations;
}

function styleAttribute(style) {
    const declarations = styleDeclarations(style);
    return declarations.length ? ` style="${escapeHtml(declarations.join(';'))}"` : '';
}

/** run → HTML：语义标签承载强调，颜色与字体走白名单后的行内样式。 */
function htmlRun(run) {
    const text = escapeHtmlInline(run && run.text);
    if (!text) return '';
    const declarations = fontDeclarations(run && run.font);
    const color = cssColor(run && run.color);
    if (color) declarations.push(`color:${color}`);
    let html = text;
    if (run.underline) html = `<u>${html}</u>`;
    if (run.italic) html = `<em>${html}</em>`;
    if (run.bold) html = `<strong>${html}</strong>`;
    if (declarations.length) html = `<span style="${escapeHtml(declarations.join(';'))}">${html}</span>`;
    return html;
}

/** 单个 block → HTML 片段。所有文本一律转义，不存在裸拼接路径。 */
function htmlBlock(block) {
    if (block.type === 'heading') {
        const level = Math.min(Math.max(Number(block.level) || 1, 1), 4);
        const tag = HEADING_TAGS[level - 1];
        return `<${tag} class="doc-heading doc-heading-${level}"${styleAttribute(block.style)}>${escapeHtmlInline(block.text)}</${tag}>`;
    }
    if (block.type === 'paragraph') {
        const inner = block.runs.map(htmlRun).join('');
        return `<p class="doc-paragraph"${styleAttribute(block.style)}>${inner || '&nbsp;'}</p>`;
    }
    if (block.type === 'table') {
        const widths = Array.isArray(block.widths_pct) ? block.widths_pct : [];
        const cols = block.header.map((cell, index) => {
            const width = cssNumber(widths[index], 0, 0, 100);
            return width > 0 ? `<col style="width:${width}%">` : '<col>';
        }).join('');
        const head = block.header.map(cell => `<th scope="col">${escapeHtmlInline(cell)}</th>`).join('');
        const body = block.rows
            .map(row => `<tr>${row.map(cell => `<td>${escapeHtmlInline(cell)}</td>`).join('')}</tr>`)
            .join('');
        return [
            `<table class="doc-table"${styleAttribute(block.style)}>`,
            `<colgroup>${cols}</colgroup>`,
            `<thead><tr>${head}</tr></thead>`,
            `<tbody>${body}</tbody>`,
            '</table>'
        ].join('');
    }
    if (block.type === 'list') {
        const tag = block.ordered ? 'ol' : 'ul';
        const items = block.items.map(item => `<li>${escapeHtmlInline(item)}</li>`).join('');
        return `<${tag} class="doc-list"${styleAttribute(block.style)}>${items}</${tag}>`;
    }
    if (block.type === 'page_break') {
        return '<div class="doc-page-break" aria-hidden="true"></div>';
    }
    if (block.type === 'image') {
        const ref = safeAssetRef(block.asset_ref);
        if (!ref) return '';
        const declarations = [];
        if (block.width_mm !== undefined) declarations.push(`width:${cssNumber(block.width_mm, 120, 1, 400)}mm`);
        if (block.height_mm !== undefined) declarations.push(`height:${cssNumber(block.height_mm, 0, 1, 400)}mm`);
        const attribute = declarations.length ? ` style="${escapeHtml(declarations.join(';'))}"` : '';
        // Air-Gapped 约束下不外链图片：只保留受控引用，由交付管线在授权后替换为实际图片。
        return [
            `<figure class="doc-figure" data-asset-ref="${escapeHtml(ref)}"${attribute}>`,
            `<figcaption class="doc-figure-caption">图片引用：${escapeHtml(ref)}（需授权后由交付管线内联）</figcaption>`,
            '</figure>'
        ].join('');
    }
    return '';
}

/** 页脚页码：用 CSS 分页媒体的 @page 边距框加页计数器，格式串取自 IR footer.format。 */
function buildFooterRule(format) {
    const raw = normalizeNewlines(format || '— {page} —').slice(0, MAX_FOOTER_FORMAT_LENGTH);
    const index = raw.indexOf('{page}');
    const prefix = index >= 0 ? raw.slice(0, index) : raw;
    const suffix = index >= 0 ? raw.slice(index + '{page}'.length) : '';
    const pieces = [];
    if (prefix) pieces.push(cssString(prefix));
    pieces.push('counter(page)');
    if (suffix) pieces.push(cssString(suffix));
    return [
        '@page {',
        `    @bottom-center { content: ${pieces.join(' ')}; font-family: ${cssFontFamily(FONT_CHAINS.song)}; font-size: 10.5pt; }`,
        '}'
    ].join('\n');
}

/** 内联样式表：复刻公文版式，且不引用任何外部资源。 */
function buildStyleSheet(ir) {
    const page = ir.meta.page;
    const sizeKeyword = PAGE_SIZE_KEYWORDS[page.size] || PAGE_SIZE_KEYWORDS.A4;
    const orientation = page.orientation === 'landscape' ? 'landscape' : 'portrait';
    const paper = PAGE_SIZE_MM[page.size] || PAGE_SIZE_MM.A4;
    const paperWidth = orientation === 'landscape' ? paper.height : paper.width;
    const paperHeight = orientation === 'landscape' ? paper.width : paper.height;
    const top = cssNumber(page.margin_mm.top, 25, 0, 100);
    const bottom = cssNumber(page.margin_mm.bottom, 25, 0, 100);
    const left = cssNumber(page.margin_mm.left, 25, 0, 100);
    const right = cssNumber(page.margin_mm.right, 25, 0, 100);
    const footerRule = ir.footer && ir.footer.page_number ? buildFooterRule(ir.footer.format) : '';
    return [
        ':root {',
        `    --doc-font-song: ${cssFontFamily(FONT_CHAINS.song)};`,
        `    --doc-font-fangsong: ${cssFontFamily(FONT_CHAINS.fangsong)};`,
        `    --doc-font-hei: ${cssFontFamily(FONT_CHAINS.hei)};`,
        `    --doc-font-title: ${cssFontFamily(FONT_CHAINS.title)};`,
        '}',
        `@page { size: ${sizeKeyword} ${orientation}; margin: ${top}mm ${right}mm ${bottom}mm ${left}mm; }`,
        footerRule,
        'html { background: #f0f0f0; }',
        'body { margin: 0; color: #000000; font-family: var(--doc-font-fangsong); font-size: 16pt; line-height: 1.5; }',
        '.doc-page {',
        '    box-sizing: border-box;',
        `    width: ${paperWidth}mm;`,
        `    min-height: ${paperHeight}mm;`,
        `    padding: ${top}mm ${right}mm ${bottom}mm ${left}mm;`,
        '    margin: 0 auto;',
        '    background: #ffffff;',
        '}',
        '.doc-security { margin: 0 0 12pt; font-family: var(--doc-font-hei); font-size: 16pt; }',
        '.doc-issuer { margin: 0 0 6pt; font-family: var(--doc-font-hei); font-size: 18pt; text-align: center; color: #c00000; }',
        '.doc-number { margin: 0 0 6pt; font-size: 16pt; text-align: center; }',
        '.doc-red-line { margin: 0 0 18pt; border-top: 2pt solid #c00000; }',
        '.doc-title { margin: 0 0 18pt; font-family: var(--doc-font-title); font-size: 22pt; font-weight: 400; line-height: 1.4; text-align: center; }',
        '.doc-subtitle { margin: 0 0 12pt; font-family: var(--doc-font-hei); font-size: 16pt; text-align: center; }',
        '.doc-recipient { margin: 0 0 12pt; font-size: 16pt; }',
        '.doc-paragraph { margin: 0 0 6pt; text-indent: 2em; }',
        '.doc-heading { margin: 12pt 0 6pt; font-family: var(--doc-font-hei); font-weight: 400; }',
        '.doc-heading-1 { font-size: 16pt; text-indent: 2em; }',
        '.doc-heading-2 { font-size: 16pt; text-indent: 2em; }',
        '.doc-heading-3 { font-size: 15pt; text-indent: 2em; }',
        '.doc-heading-4 { font-size: 14pt; text-indent: 2em; }',
        '.doc-list { margin: 0 0 6pt; padding-left: 3em; }',
        '.doc-table { width: 100%; margin: 6pt 0 12pt; border-collapse: collapse; table-layout: fixed; font-size: 14pt; }',
        '.doc-table th, .doc-table td { padding: 3pt 5pt; border: 0.75pt solid #000000; vertical-align: middle; word-break: break-word; }',
        '.doc-table th { font-family: var(--doc-font-hei); font-weight: 700; text-align: center; }',
        '.doc-page-break { height: 0; break-after: page; page-break-after: always; }',
        '.doc-figure { margin: 12pt auto; text-align: center; }',
        '.doc-figure-caption { font-family: var(--doc-font-song); font-size: 12pt; color: #404040; }',
        '.doc-signoff { margin-top: 24pt; text-align: right; }',
        '.doc-signoff-line { margin: 0 0 6pt; font-size: 16pt; }',
        '@media print {',
        '    html { background: #ffffff; }',
        '    .doc-page { width: auto; min-height: 0; padding: 0; margin: 0; }',
        '}'
    ].filter(rule => rule !== '').join('\n');
}

/** 文档头：密级、发文机关标志、发文字号、红线、标题、副标题、主送机关。 */
function htmlDocumentHead(ir) {
    const meta = ir.meta;
    const parts = [];
    const securityLabel = SECURITY_LEVEL_LABELS[meta.security_level] || meta.security_level;
    if (String(securityLabel ?? '').trim()) parts.push(`<p class="doc-security">${escapeHtmlInline(securityLabel)}</p>`);
    if (String(meta.issuer ?? '').trim()) parts.push(`<p class="doc-issuer">${escapeHtmlInline(meta.issuer)}</p>`);
    if (String(meta.doc_number ?? '').trim()) parts.push(`<p class="doc-number">${escapeHtmlInline(meta.doc_number)}</p>`);
    if (ir.doc_type === 'official_document') parts.push('<div class="doc-red-line" aria-hidden="true"></div>');
    parts.push(`<h1 class="doc-title">${escapeHtmlInline(meta.title) || '未命名文档'}</h1>`);
    if (String(meta.subtitle ?? '').trim()) parts.push(`<p class="doc-subtitle">${escapeHtmlInline(meta.subtitle)}</p>`);
    if (String(meta.recipient ?? '').trim()) parts.push(`<p class="doc-recipient">${escapeHtmlInline(meta.recipient)}</p>`);
    return `<header class="doc-head">${parts.join('')}</header>`;
}

/** 落款：signoff 与成文日期；发文单位已在文档头呈现，不重复输出。 */
function htmlSignoff(ir) {
    const meta = ir.meta;
    const parts = [];
    if (String(meta.signoff ?? '').trim()) parts.push(`<p class="doc-signoff-line">${escapeHtmlInline(meta.signoff)}</p>`);
    if (String(meta.issued_at ?? '').trim()) parts.push(`<p class="doc-signoff-line">${escapeHtmlInline(meta.issued_at)}</p>`);
    return parts.length ? `<footer class="doc-signoff">${parts.join('')}</footer>` : '';
}

/** IR → 完整 HTML5 文档。输出为 UTF-8 Buffer，不含任何外部资源引用。 */
function renderHtml(ir) {
    assertRenderableIr(ir);
    const title = escapeHtml(ir.meta.title).trim() || '未命名文档';
    const body = ir.blocks.map(htmlBlock).filter(Boolean).join('');
    const parts = [
        '<!DOCTYPE html>',
        '<html lang="zh-CN">',
        '<head>',
        '<meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
        `<meta name="generator" content="Pivot 文档渲染器 ${HTML_RENDERER_VERSION}">`,
        `<title>${title}</title>`,
        '<style>',
        buildStyleSheet(ir),
        '</style>',
        '</head>',
        '<body>',
        '<article class="doc-page">',
        htmlDocumentHead(ir),
        `<section class="doc-body">${body}</section>`,
        htmlSignoff(ir),
        '</article>',
        '</body>',
        '</html>'
    ].filter(part => part !== '');
    return Buffer.from(`${parts.join('\n')}\n`, 'utf8');
}

module.exports = {
    HTML_MIME_TYPE,
    HTML_RENDERER_VERSION,
    MARKDOWN_MIME_TYPE,
    MARKDOWN_RENDERER_VERSION,
    SECURITY_LEVEL_LABELS,
    assertRenderableIr,
    escapeHtml,
    mergeRunsToPlainText,
    renderHtml,
    renderMarkdown
};
