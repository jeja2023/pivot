/**
 * server/services/document-rendering/pdf-renderer.js
 * Document IR 的 PDF 渲染器（pdf-lib + CJK 字体子集嵌入）
 *
 * 落地方案 v1.2 §7.2、阶段 2.5、§10.2：
 * 1. pdf-lib 的标准 14 字体不含 CJK，中文必须靠嵌入 TrueType 子集输出；字体自检不通过
 *    时按 fail-closed 抛 503，绝不回退为方块、乱码或静默跳过；
 * 2. 版面全部自算：纸张与页边距来自 meta.page，折行、表格、页码由本模块布局；
 * 3. 渲染必须幂等：/CreationDate 与 /ModDate 固定为从 ir_digest 派生的确定时间，
 *    内嵌字体资源名固定，保存时关闭对象流，同一 IR 两次渲染字节完全一致。
 *
 * 字重与字形说明：部署只分发一个字重的 OFL 字体，加粗用 PDF 文本渲染模式 2（填充 + 描边）
 * 实现，倾斜用文本矩阵斜切实现。两者都只产生一段文本流，不重复绘制，因此复制粘贴与
 * 文本抽取（§10.2 的中文可读性断言）仍能还原原文。
 */
const {
    PDFDocument,
    TextRenderingMode,
    degrees,
    popGraphicsState,
    pushGraphicsState,
    rgb,
    setLineWidth,
    setStrokingRgbColor,
    setTextRenderingMode
} = require('pdf-lib');
const { computeIrDigest } = require('../document-ir');
const { FONT_SUBSET_NAME, createCjkFontkit, getCjkFontBuffer, isCjkFontAvailable } = require('./cjk-fonts');
const layout = require('./pdf-text-layout');

/** 渲染器语义版本。改版式必须升版本，否则历史 rendition 不可复现（§7.3 去重键）。 */
const RENDERER_VERSION = 'pdf-1.0.0';
const MIME_TYPE = 'application/pdf';

const BLACK = rgb(0, 0, 0);
const OFFICIAL_RULE_COLOR = rgb(0.78, 0.09, 0.09);
const TABLE_BORDER_COLOR = rgb(0.35, 0.35, 0.35);
const TABLE_HEADER_FILL = rgb(0.92, 0.92, 0.92);
const META_TEXT_COLOR = rgb(0.25, 0.25, 0.25);

/** 正文默认三号字（16 磅）、1.5 倍行距，符合公文常用版式。 */
const BODY_SIZE_PT = 16;
const BODY_LINE_HEIGHT = 1.5;
const FOOTER_SIZE_PT = 10.5;
const FOOTER_GAP_PT = 14;
const TABLE_SIZE_PT = 12;
const TABLE_LINE_HEIGHT = 1.35;
const TABLE_PADDING_X = 4;
const TABLE_PADDING_Y = 3;
const TABLE_BORDER_WIDTH = 0.75;
const LIST_INDENT_PT = 12;
const IMAGE_SPACE_PT = 8;
const BOLD_STROKE_RATIO = 0.028;
const ITALIC_SKEW_DEGREES = 12;
const UNDERLINE_OFFSET_RATIO = 0.13;
const UNDERLINE_THICKNESS_RATIO = 0.055;

/** 各级标题的默认版式，可被 IR 的 style 覆盖。 */
const HEADING_PRESETS = Object.freeze({
    1: Object.freeze({ size: 22, align: 'center', spaceBefore: 4, spaceAfter: 14, bold: true, lineHeight: 1.4 }),
    2: Object.freeze({ size: 18, align: 'left', spaceBefore: 12, spaceAfter: 8, bold: true, lineHeight: 1.45 }),
    3: Object.freeze({ size: 16, align: 'left', spaceBefore: 10, spaceAfter: 6, bold: true, lineHeight: 1.45 }),
    4: Object.freeze({ size: 15, align: 'left', spaceBefore: 8, spaceAfter: 5, bold: true, lineHeight: 1.45 })
});

/** 密级标识文案。IR 已把 security_level 收敛为这四种取值。 */
const SECURITY_LABELS = Object.freeze({
    public: '公开',
    internal: '内部',
    confidential: '秘密',
    secret: '机密'
});

/** 确定性时间基准：从 ir_digest 派生偏移，落在这个基准之后的十年区间内。 */
const DETERMINISTIC_EPOCH_MS = Date.UTC(2020, 0, 1, 0, 0, 0);
const DETERMINISTIC_RANGE_SECONDS = 10 * 365 * 24 * 3600;

function renderFailure(message, code = 'PDF_RENDER_FAILED', status = 422) {
    const error = new Error(message);
    error.status = status;
    error.statusCode = status;
    error.code = code;
    error.expose = true;
    return error;
}

function clampSize(value, fallback) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(Math.max(parsed, 5), 72);
}

/** 解析 #RRGGBB / RRGGBB / #RGB 颜色；无法解析时返回 null，由调用方回退到基础色。 */
function parseColor(value) {
    const text = String(value || '').trim().replace(/^#/, '');
    const expanded = /^[0-9a-fA-F]{3}$/.test(text)
        ? text.split('').map(char => char + char).join('')
        : text;
    if (!/^[0-9a-fA-F]{6}$/.test(expanded)) return null;
    const channel = index => Number.parseInt(expanded.slice(index, index + 2), 16) / 255;
    return rgb(channel(0), channel(2), channel(4));
}

/**
 * 块级基础样式。
 * PDF 只嵌入一套 CJK 字体子集，IR 的 font.eastAsia / font.ascii / font.family_chain 是
 * DOCX 侧的字体族声明，PDF 侧只取字号、粗细与颜色，不做字体名映射。
 */
function baseStyleFor(ctx, style, fallbackSize) {
    const font = style?.font || {};
    return {
        size: clampSize(font.size_pt, fallbackSize),
        bold: Boolean(font.bold),
        italic: false,
        underline: false,
        color: parseColor(font.color) || BLACK
    };
}

/** run 级样式。同一 run 的所有 token 共享同一个样式对象，绘制时才能合并成一段文本。 */
function resolveRunStyle(run, base) {
    const font = run.font || {};
    return {
        size: clampSize(font.size_pt !== undefined ? font.size_pt : base.size, base.size),
        bold: run.bold !== undefined ? Boolean(run.bold) : Boolean(font.bold || base.bold),
        italic: Boolean(run.italic),
        underline: Boolean(run.underline),
        color: parseColor(run.color !== undefined ? run.color : font.color) || base.color
    };
}

function lineHeightOf(style, fallback) {
    const value = Number(style?.line_height);
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

function spaceAfterOf(style, fallback) {
    const value = Number(style?.space_after_pt);
    return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** 首行缩进：中文按「字符数 × 字号」折算；公文正文默认缩进 2 字符。 */
function indentOf(ctx, style, size) {
    const chars = Number(style?.indent_chars);
    if (Number.isFinite(chars) && chars >= 0) return chars * size;
    return ctx.docType === 'official_document' ? 2 * size : 0;
}

function startPage(ctx) {
    const page = ctx.doc.addPage([ctx.box.width, ctx.box.height]);
    // 每页只登记一次字体资源：pdf-lib 在 drawText 传入 font 时会为每次调用新建一个资源名，
    // 长文档会把页面 /Font 字典撑成上百个指向同一字体的条目，白白增大产物体积。
    page.setFont(ctx.font);
    ctx.pages.push(page);
    ctx.page = page;
    ctx.cursorY = ctx.box.contentTop;
    ctx.pendingBreak = false;
    return page;
}

/** 保证当前有可写页面，并在剩余高度不足时换页。整页都放不下的内容按溢出绘制，不死循环。 */
function ensureSpace(ctx, height) {
    if (!ctx.page || ctx.pendingBreak) return startPage(ctx);
    const atPageTop = ctx.cursorY >= ctx.box.contentTop - 0.001;
    if (!atPageTop && ctx.cursorY - height < ctx.box.contentBottom) return startPage(ctx);
    return ctx.page;
}

/** 在指定基线绘制一段同样式文本。加粗走描边，倾斜走斜切，下划线单独画线。 */
function drawSegmentAt(ctx, segment, x, baseline) {
    const style = segment.style;
    if (!segment.text) return;
    const options = { x, y: baseline, size: style.size, color: style.color };
    if (style.italic) options.xSkew = degrees(ITALIC_SKEW_DEGREES);
    if (style.bold) {
        const stroke = Math.max(style.size * BOLD_STROKE_RATIO, 0.2);
        const { red, green, blue } = style.color;
        ctx.page.pushOperators(
            pushGraphicsState(),
            setTextRenderingMode(TextRenderingMode.FillAndOutline),
            setLineWidth(stroke),
            setStrokingRgbColor(red, green, blue)
        );
        ctx.page.drawText(segment.text, options);
        ctx.page.pushOperators(popGraphicsState());
    } else {
        ctx.page.drawText(segment.text, options);
    }
    if (style.underline) {
        const offset = style.size * UNDERLINE_OFFSET_RATIO;
        const thickness = Math.max(style.size * UNDERLINE_THICKNESS_RATIO, 0.4);
        ctx.page.drawLine({
            start: { x, y: baseline - offset },
            end: { x: x + segment.width, y: baseline - offset },
            thickness,
            color: style.color
        });
    }
}

/** 绘制一行并返回实际基线。行高按行内最大字号计算，多余行距上下均分。 */
function drawTextLine(ctx, line, options) {
    const size = layout.maxSizeOfLine(line, options.baseSize);
    const advance = size * options.lineHeight;
    ensureSpace(ctx, advance);
    const ascent = ctx.measurer.ascentOf(size);
    const height = ctx.measurer.heightOf(size);
    const leading = Math.max(advance - height, 0);
    const baseline = ctx.cursorY - leading / 2 - ascent;
    const segments = layout.composeLineSegments(line, {
        align: options.align,
        maxWidth: ctx.box.contentWidth,
        isLastLine: Boolean(options.isLastLine)
    });
    segments.forEach(segment => drawSegmentAt(ctx, segment, ctx.box.contentLeft + segment.x, baseline));
    ctx.cursorY -= advance;
    return baseline;
}

/** 排一段文本流（可含多个样式片段），返回每一行的基线，供列表标记等对齐使用。 */
function drawTextFlow(ctx, segments, options) {
    const tokens = layout.buildInlineTokens(segments, ctx.measurer);
    const lines = layout.wrapTokens(tokens, {
        measurer: ctx.measurer,
        maxWidth: ctx.box.contentWidth,
        indentPt: options.indentPt || 0
    });
    if (!lines.length) lines.push({ tokens: [], width: 0, indent: options.indentPt || 0, forced: true });
    return lines.map((line, index) => drawTextLine(ctx, line, {
        align: options.align,
        baseSize: options.baseSize,
        lineHeight: options.lineHeight,
        isLastLine: index === lines.length - 1
    }));
}

/** 临时收窄版心（列表悬挂缩进用）。box 只被读取，因此借用后必须还原。 */
function withNarrowedBox(ctx, leftInset, callback) {
    const original = ctx.box;
    ctx.box = {
        ...original,
        contentLeft: original.contentLeft + leftInset,
        contentWidth: Math.max(original.contentWidth - leftInset, 1)
    };
    try {
        return callback(original);
    } finally {
        ctx.box = original;
    }
}

/** 段前空白。页面顶部不再补段前空白，避免换页后正文被顶下去。 */
function addSpaceBefore(ctx, amount) {
    if (!amount) return;
    if (!ctx.page || ctx.pendingBreak) return;
    if (ctx.cursorY >= ctx.box.contentTop - 0.001) return;
    ctx.cursorY -= amount;
}

function renderHeading(ctx, block) {
    const preset = HEADING_PRESETS[block.level] || HEADING_PRESETS[4];
    const base = baseStyleFor(ctx, block.style, preset.size);
    const style = { ...base, bold: block.style?.font?.bold !== undefined ? Boolean(block.style.font.bold) : preset.bold };
    addSpaceBefore(ctx, preset.spaceBefore);
    drawTextFlow(ctx, [{ text: block.text, style }], {
        align: block.style?.align || preset.align,
        baseSize: style.size,
        lineHeight: lineHeightOf(block.style, preset.lineHeight),
        indentPt: 0
    });
    ctx.cursorY -= spaceAfterOf(block.style, preset.spaceAfter);
}

function renderParagraph(ctx, block) {
    const base = baseStyleFor(ctx, block.style, BODY_SIZE_PT);
    const segments = (block.runs || []).map(run => ({ text: run.text, style: resolveRunStyle(run, base) }));
    if (!segments.length) segments.push({ text: '', style: base });
    drawTextFlow(ctx, segments, {
        align: block.style?.align || (ctx.docType === 'official_document' ? 'justify' : 'left'),
        baseSize: base.size,
        lineHeight: lineHeightOf(block.style, BODY_LINE_HEIGHT),
        indentPt: indentOf(ctx, block.style, base.size)
    });
    ctx.cursorY -= spaceAfterOf(block.style, ctx.docType === 'official_document' ? 0 : 6);
}

function renderList(ctx, block) {
    const base = baseStyleFor(ctx, block.style, BODY_SIZE_PT);
    const lineHeight = lineHeightOf(block.style, BODY_LINE_HEIGHT);
    const align = block.style?.align || 'left';
    (block.items || []).forEach((item, index) => {
        const marker = block.ordered ? `${index + 1}. ` : '· ';
        const markerWidth = ctx.measurer.widthOf(marker, base.size);
        const inset = LIST_INDENT_PT + markerWidth;
        withNarrowedBox(ctx, inset, original => {
            const baselines = drawTextFlow(ctx, [{ text: item, style: base }], {
                align,
                baseSize: base.size,
                lineHeight,
                indentPt: 0
            });
            if (baselines.length) {
                drawSegmentAt(ctx, { text: marker, style: base, width: markerWidth },
                    original.contentLeft + LIST_INDENT_PT, baselines[0]);
            }
        });
    });
    ctx.cursorY -= spaceAfterOf(block.style, 6);
}

/** 列宽：widths_pct 按比例归一化到版心宽度；缺失或含非正值时等分。 */
function resolveColumnWidths(block, contentWidth) {
    const count = block.header.length;
    const raw = Array.isArray(block.widths_pct) && block.widths_pct.length === count
        ? block.widths_pct.map(Number)
        : [];
    const usable = raw.every(value => Number.isFinite(value) && value > 0);
    const total = usable ? raw.reduce((sum, value) => sum + value, 0) : 0;
    if (!usable || !total) return new Array(count).fill(contentWidth / count);
    return raw.map(value => (contentWidth * value) / total);
}

function measureTableRow(ctx, cells, columnWidths, style, lineHeight) {
    const advance = style.size * lineHeight;
    const cellLines = columnWidths.map((width, index) => {
        const inner = Math.max(width - TABLE_PADDING_X * 2, 1);
        const tokens = layout.buildInlineTokens([{ text: cells[index] ?? '', style }], ctx.measurer);
        const lines = layout.wrapTokens(tokens, { measurer: ctx.measurer, maxWidth: inner, indentPt: 0 });
        return lines.length ? lines : [{ tokens: [], width: 0, indent: 0, forced: true }];
    });
    const maxLines = cellLines.reduce((max, lines) => Math.max(max, lines.length), 1);
    return { cellLines, advance, height: maxLines * advance + TABLE_PADDING_Y * 2 };
}

function drawTableRow(ctx, measured, columnWidths, options) {
    ensureSpace(ctx, measured.height);
    const top = ctx.cursorY;
    let left = ctx.box.contentLeft;
    measured.cellLines.forEach((lines, index) => {
        const width = columnWidths[index];
        const rectangle = {
            x: left,
            y: top - measured.height,
            width,
            height: measured.height,
            borderWidth: TABLE_BORDER_WIDTH,
            borderColor: TABLE_BORDER_COLOR
        };
        if (options.fill) rectangle.color = options.fill;
        ctx.page.drawRectangle(rectangle);
        const innerWidth = Math.max(width - TABLE_PADDING_X * 2, 1);
        let lineTop = top - TABLE_PADDING_Y;
        lines.forEach(line => {
            const size = layout.maxSizeOfLine(line, options.baseSize);
            const ascent = ctx.measurer.ascentOf(size);
            const leading = Math.max(measured.advance - ctx.measurer.heightOf(size), 0);
            const baseline = lineTop - leading / 2 - ascent;
            const segments = layout.composeLineSegments(line, {
                align: options.align,
                maxWidth: innerWidth,
                isLastLine: true
            });
            segments.forEach(segment => drawSegmentAt(ctx, segment, left + TABLE_PADDING_X + segment.x, baseline));
            lineTop -= measured.advance;
        });
        left += width;
    });
    ctx.cursorY = top - measured.height;
}

function renderTable(ctx, block) {
    const bodyStyle = baseStyleFor(ctx, block.style, TABLE_SIZE_PT);
    const headerStyle = { ...bodyStyle, bold: true };
    const lineHeight = lineHeightOf(block.style, TABLE_LINE_HEIGHT);
    const columnWidths = resolveColumnWidths(block, ctx.box.contentWidth);
    const headerRow = measureTableRow(ctx, block.header, columnWidths, headerStyle, lineHeight);
    const rows = (block.rows || []).map(row => measureTableRow(ctx, row, columnWidths, bodyStyle, lineHeight));
    // 表头不能单独留在页尾：预留表头加首行的高度再决定是否换页。
    ensureSpace(ctx, headerRow.height + (rows[0] ? rows[0].height : 0));
    const drawHeader = () => drawTableRow(ctx, headerRow, columnWidths, {
        fill: TABLE_HEADER_FILL,
        align: block.style?.align || 'center',
        baseSize: headerStyle.size
    });
    drawHeader();
    rows.forEach(measured => {
        const atPageTop = ctx.cursorY >= ctx.box.contentTop - 0.001;
        if (!atPageTop && ctx.cursorY - measured.height < ctx.box.contentBottom) {
            startPage(ctx);
            drawHeader();
        }
        drawTableRow(ctx, measured, columnWidths, {
            align: block.style?.align || 'left',
            baseSize: bodyStyle.size
        });
    });
    ctx.cursorY -= spaceAfterOf(block.style, 8);
}

function isPngBuffer(buffer) {
    return buffer.length > 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47;
}

function isJpegBuffer(buffer) {
    return buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
}

/**
 * 图片块。字节由 options.imageResolver(assetRef) 提供：IR 只允许受控的 artifact-cas 引用，
 * 渲染器自己不碰存储层，也不接受内联 base64。
 */
async function renderImage(ctx, block, options) {
    const assetRef = String(block.asset_ref || '');
    const resolver = options.imageResolver;
    if (typeof resolver !== 'function') {
        throw renderFailure(`渲染包含图片的 IR 需要传入 imageResolver 以读取 ${assetRef}，当前未提供。`, 'PDF_IMAGE_RESOLVER_MISSING', 500);
    }
    const resolved = await resolver(assetRef);
    const buffer = Buffer.isBuffer(resolved) ? resolved : (resolved ? Buffer.from(resolved) : null);
    if (!buffer || !buffer.length) {
        throw renderFailure(`图片资源为空或无法读取：${assetRef}。`, 'PDF_IMAGE_UNREADABLE', 422);
    }
    let image;
    if (isPngBuffer(buffer)) image = await ctx.doc.embedPng(buffer);
    else if (isJpegBuffer(buffer)) image = await ctx.doc.embedJpg(buffer);
    else throw renderFailure(`图片 ${assetRef} 不是 PNG 或 JPEG，PDF 渲染器只支持这两种格式。`, 'PDF_IMAGE_FORMAT_UNSUPPORTED', 422);
    const ratio = image.height / image.width;
    let width = block.width_mm ? layout.mmToPt(block.width_mm) : image.width;
    let height = block.height_mm ? layout.mmToPt(block.height_mm) : width * ratio;
    if (width > ctx.box.contentWidth) {
        height *= ctx.box.contentWidth / width;
        width = ctx.box.contentWidth;
    }
    if (height > ctx.box.contentHeight) {
        width *= ctx.box.contentHeight / height;
        height = ctx.box.contentHeight;
    }
    ensureSpace(ctx, height + IMAGE_SPACE_PT);
    const x = ctx.box.contentLeft + Math.max(ctx.box.contentWidth - width, 0) / 2;
    ctx.page.drawImage(image, { x, y: ctx.cursorY - height, width, height });
    ctx.cursorY -= height + IMAGE_SPACE_PT;
}

/** 文头：密级标识、标题、副标题、发文字号与主送机关，以及公文的红色分隔线。 */
function renderDocumentHead(ctx, ir) {
    const meta = ir.meta || {};
    const official = ctx.docType === 'official_document';
    const securityLabel = SECURITY_LABELS[meta.security_level];
    if (official && meta.security_level && meta.security_level !== 'public' && securityLabel) {
        drawTextFlow(ctx, [{ text: securityLabel, style: { size: 16, bold: true, italic: false, underline: false, color: BLACK } }], {
            align: 'right',
            baseSize: 16,
            lineHeight: 1.4,
            indentPt: 0
        });
        ctx.cursorY -= 4;
    }
    if (meta.title) {
        drawTextFlow(ctx, [{ text: meta.title, style: { size: 22, bold: true, italic: false, underline: false, color: BLACK } }], {
            align: 'center',
            baseSize: 22,
            lineHeight: 1.4,
            indentPt: 0
        });
        ctx.cursorY -= 6;
    }
    if (meta.subtitle) {
        drawTextFlow(ctx, [{ text: meta.subtitle, style: { size: 16, bold: false, italic: false, underline: false, color: META_TEXT_COLOR } }], {
            align: 'center',
            baseSize: 16,
            lineHeight: 1.4,
            indentPt: 0
        });
        ctx.cursorY -= 4;
    }
    const metaLine = [meta.doc_number, official ? '' : meta.issuer, meta.issued_at].filter(Boolean).join('　　');
    if (metaLine) {
        drawTextFlow(ctx, [{ text: metaLine, style: { size: 14, bold: false, italic: false, underline: false, color: META_TEXT_COLOR } }], {
            align: 'center',
            baseSize: 14,
            lineHeight: 1.4,
            indentPt: 0
        });
    }
    if (official) {
        ctx.cursorY -= 6;
        ensureSpace(ctx, 8);
        ctx.page.drawLine({
            start: { x: ctx.box.contentLeft, y: ctx.cursorY },
            end: { x: ctx.box.contentRight, y: ctx.cursorY },
            thickness: 1.6,
            color: OFFICIAL_RULE_COLOR
        });
        ctx.cursorY -= 12;
    } else {
        ctx.cursorY -= 8;
    }
    if (meta.recipient) {
        drawTextFlow(ctx, [{ text: meta.recipient, style: baseStyleFor(ctx, null, BODY_SIZE_PT) }], {
            align: 'left',
            baseSize: BODY_SIZE_PT,
            lineHeight: BODY_LINE_HEIGHT,
            indentPt: 0
        });
        ctx.cursorY -= 4;
    }
}

/** 文尾落款：优先用 meta.signoff；公文缺省时按发文单位 + 成文日期右对齐排版。 */
function renderDocumentTail(ctx, ir) {
    const meta = ir.meta || {};
    const texts = [];
    if (meta.signoff) texts.push(meta.signoff);
    else if (ctx.docType === 'official_document') {
        if (meta.issuer) texts.push(meta.issuer);
        if (meta.issued_at) texts.push(meta.issued_at);
    }
    if (!texts.length) return;
    ctx.cursorY -= 20;
    const style = { size: BODY_SIZE_PT, bold: false, italic: false, underline: false, color: BLACK };
    texts.forEach(text => drawTextFlow(ctx, [{ text, style }], {
        align: 'right',
        baseSize: BODY_SIZE_PT,
        lineHeight: BODY_LINE_HEIGHT,
        indentPt: 0
    }));
}

/**
 * 页脚页码。footer.format 里的 {page} 换成真实页码，{pages} 换成总页数。
 * 页码在全部内容渲染完成后统一绘制，因此总页数是最终值而不是占位符。
 */
function drawFooters(ctx, footer) {
    if (!footer || !footer.page_number) return;
    const format = String(footer.format || '— {page} —');
    const total = ctx.pages.length;
    const baselineY = Math.max(ctx.box.contentBottom - FOOTER_GAP_PT - FOOTER_SIZE_PT, FOOTER_SIZE_PT * 0.5);
    ctx.pages.forEach((page, index) => {
        const text = format.replace(/\{page\}/g, String(index + 1)).replace(/\{pages\}/g, String(total));
        if (!text) return;
        const width = ctx.measurer.widthOf(text, FOOTER_SIZE_PT);
        const x = ctx.box.contentLeft + Math.max(ctx.box.contentWidth - width, 0) / 2;
        page.drawText(text, { x, y: baselineY, size: FOOTER_SIZE_PT, color: BLACK });
    });
}

/**
 * 固定全部时间与标识类元数据。
 * pdf-lib 默认把当前时间写进 /CreationDate 与 /ModDate，会让同一 IR 每次渲染都得到不同
 * 摘要，§10.2 的幂等断言与 rendition 去重键都会失效，因此这里改成从 ir_digest 派生。
 */
function applyDeterministicMetadata(doc, ir) {
    const digest = computeIrDigest(ir);
    const seed = Number.parseInt(digest.slice(0, 8), 16);
    const offsetSeconds = Number.isFinite(seed) ? seed % DETERMINISTIC_RANGE_SECONDS : 0;
    const fixedDate = new Date(DETERMINISTIC_EPOCH_MS + offsetSeconds * 1000);
    if (ir.meta?.title) doc.setTitle(String(ir.meta.title));
    if (ir.meta?.issuer) doc.setAuthor(String(ir.meta.issuer));
    doc.setSubject(`Document IR ${ir.ir_version} / ${ir.doc_type}`);
    doc.setKeywords([`ir_digest:${digest}`, `renderer:${RENDERER_VERSION}`]);
    doc.setCreator(`Pivot Document Renderer ${RENDERER_VERSION}`);
    doc.setProducer(`Pivot Document Renderer ${RENDERER_VERSION}`);
    doc.setLanguage('zh-CN');
    doc.setCreationDate(fixedDate);
    doc.setModificationDate(fixedDate);
}

async function renderBlock(ctx, block, options) {
    const type = String(block?.type || '');
    if (type === 'page_break') {
        ctx.pendingBreak = true;
        return;
    }
    if (type === 'heading') return renderHeading(ctx, block);
    if (type === 'paragraph') return renderParagraph(ctx, block);
    if (type === 'list') return renderList(ctx, block);
    if (type === 'table') return renderTable(ctx, block);
    if (type === 'image') return renderImage(ctx, block, options);
    throw renderFailure(`PDF 渲染器不支持的块类型：${type || '(空)'}。`, 'PDF_BLOCK_UNSUPPORTED', 422);
}

/** PDF 渲染能力可用性。转发字体自检结果，任何异常都按不可用处理，绝不抛给调用方。 */
function isPdfRenderingAvailable() {
    try {
        return isCjkFontAvailable();
    } catch (error) {
        return false;
    }
}

/**
 * 从规范化后的 Document IR 渲染 PDF。
 * options.imageResolver(assetRef) → Buffer | Uint8Array，用于读取 artifact-cas 中的图片。
 * 字体自检未通过时抛出 status=503、code=PDF_FONT_UNAVAILABLE 的中文错误。
 */
async function renderPdf(ir, options = {}) {
    if (!ir || typeof ir !== 'object' || !ir.meta || !Array.isArray(ir.blocks)) {
        throw renderFailure('PDF 渲染要求传入规范化后的 Document IR（至少包含 meta 与 blocks）。', 'PDF_IR_INVALID', 422);
    }
    const fontBuffer = getCjkFontBuffer();
    const doc = await PDFDocument.create();
    doc.registerFontkit(createCjkFontkit());
    const font = await doc.embedFont(fontBuffer, { subset: true, customName: FONT_SUBSET_NAME });
    const box = layout.resolvePageBox(ir.meta.page);
    const ctx = {
        doc,
        font,
        box,
        measurer: layout.createTextMeasurer(font),
        docType: String(ir.doc_type || 'report'),
        pages: [],
        page: null,
        cursorY: box.contentTop,
        pendingBreak: false
    };
    startPage(ctx);
    renderDocumentHead(ctx, ir);
    for (const block of ir.blocks) {
        await renderBlock(ctx, block, options);
    }
    renderDocumentTail(ctx, ir);
    drawFooters(ctx, ir.footer);
    applyDeterministicMetadata(doc, ir);
    const bytes = await doc.save({ useObjectStreams: false, addDefaultPage: false, updateFieldAppearances: false });
    return Buffer.from(bytes);
}

module.exports = {
    MIME_TYPE,
    RENDERER_VERSION,
    isPdfRenderingAvailable,
    renderPdf
};
