/**
 * server/services/document-rendering/docx-renderer.js
 * DOCX 公文渲染器（Document IR → OOXML）
 *
 * 落地方案 v1.2 §7.2、§10.2、阶段 2.3：
 * 1. 服务端此前没有公文版式能力（§2.3-C6）：既有 document-processing/exporters 的 buildDocx 是
 *    手写最小 OOXML，只能输出「标题 + 分页 + 纯段落」，且页码行写成 ASCII 占位符，属既存字符损坏缺陷；
 *    本渲染器是服务端唯一的公文版式实现，版式参数复刻自前端 client/chat/apps-workbench-export.js；
 * 2. 用 docx 库生成：公文版式需要正确的 styles.xml、numbering.xml、sectPr、页眉页脚与页码域、
 *    表格 tblPr/tblGrid/tcPr 以及中文字体的 w:eastAsia 绑定，逻辑量明确超过开发规范第 32 条的自研线；
 * 3. 渲染必须确定性：文档时间戳由 IR 摘要派生，ZIP 由 docx-package.js 重新确定性打包，
 *    同一 IR 连续渲染两次内容摘要必须一致（§10.2 的渲染幂等性指标）；
 * 4. 渲染器不接触 CAS：图片一律通过 options.imageResolver 取字节，取不到就跳过该图片而不报错。
 *
 * 与前端既有实现的一处不一致已核实并按 IR 契约处理：前端 pgMar 把 28 毫米写给了 right、
 * 26 毫米写给了 left，与 GB/T 9704 及 document-ir.js 的 OFFICIAL_PAGE_DEFAULT（left 28、right 26）相反；
 * 渲染器按 IR 的字段名落位，即 left 用 margin_mm.left、right 用 margin_mm.right。
 */
const docx = require('docx');
const { computeIrDigest } = require('../document-ir');
const styleConstants = require('./official-styles');
const { deriveDeterministicTimestamp, repackDeterministic } = require('./docx-package');

/** 渲染器语义版本：参与 rendition 去重键，改版式必须升版本，否则历史交付不可复现。 */
const RENDERER_VERSION = 'docx-1.0.0';

/** DOCX 的 MIME 类型。 */
const MIME_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** 写入 docProps 的创建者标识。 */
const DOCUMENT_CREATOR = 'Pivot 文档渲染器';

/** 页眉与页脚距页边的距离（毫米）。 */
const HEADER_DISTANCE_MM = 20;
const FOOTER_DISTANCE_MM = 20;

/** 图片缺少宽度时的默认宽度（毫米），与 document-ir.js 规范化时的默认值一致。 */
const DEFAULT_IMAGE_WIDTH_MM = 120;

/** 无法解析出图片原始像素尺寸时的高宽比（4:3）。 */
const DEFAULT_IMAGE_ASPECT = 0.75;

/** 支持嵌入的位图类型；docx 库只接受这四种。 */
const IMAGE_TYPES = Object.freeze(['png', 'jpg', 'gif', 'bmp']);

const ALIGNMENT_MAP = Object.freeze({
    left: docx.AlignmentType.LEFT,
    center: docx.AlignmentType.CENTER,
    right: docx.AlignmentType.RIGHT,
    justify: docx.AlignmentType.JUSTIFIED
});

function renderError(message, code = 'DOCX_RENDER_FAILED') {
    const error = new Error(message);
    error.code = code;
    error.status = 500;
    error.statusCode = 500;
    return error;
}

/** IR 的 align 枚举转 OOXML 对齐值。 */
function alignmentOf(align) {
    return ALIGNMENT_MAP[String(align)] || undefined;
}

/** 边框常量转 docx 边框选项。 */
function borderOf(border) {
    return { style: border.style, color: border.color, size: border.size, space: border.space };
}

/**
 * 解析字体绑定：中文写 w:eastAsia，西文与数字写 w:ascii / w:hAnsi。
 * OOXML 的 w:rFonts 每个槽位只能放一个字体名，因此 IR 的 font.family_chain 字体族链
 * 按「第一项→中文、第二项→西文、第三项→复杂文种」降解，其余项无处安放只能忽略。
 */
function resolveFont(baseFont, irFont) {
    const chain = Array.isArray(irFont?.family_chain)
        ? irFont.family_chain.map(name => String(name).trim()).filter(Boolean)
        : [];
    const eastAsia = String(irFont?.eastAsia || chain[0] || baseFont?.eastAsia || styleConstants.FONT_FAMILY.SONG);
    const ascii = String(irFont?.ascii || chain[1] || baseFont?.ascii || styleConstants.ASCII_FALLBACK_FONT);
    const font = { ascii, eastAsia, hAnsi: ascii };
    if (chain[2]) font.cs = chain[2];
    return font;
}

/**
 * 把版式元素规格与 IR 的 style 合并成最终的排版参数。
 * IR 显式给出的值优先于版式默认值；未给出的沿用版式默认值。
 */
function resolveSpec(spec, irStyle) {
    const irFont = irStyle && irStyle.font ? irStyle.font : null;
    const size = irFont && irFont.size_pt !== undefined
        ? styleConstants.ptToHalfPoint(irFont.size_pt)
        : Number(spec.size || styleConstants.FONT_SIZE_HALF_POINT.XIAO_SI);
    return {
        size,
        bold: irFont && irFont.bold !== undefined ? Boolean(irFont.bold) : Boolean(spec.bold),
        color: (irFont && irFont.color) || spec.color || undefined,
        align: (irStyle && irStyle.align) || spec.align || undefined,
        indentChars: irStyle && irStyle.indent_chars !== undefined
            ? Number(irStyle.indent_chars)
            : Number(spec.indent_chars || 0),
        lineHeight: irStyle && irStyle.line_height !== undefined ? Number(irStyle.line_height) : undefined,
        spaceAfterPt: irStyle && irStyle.space_after_pt !== undefined
            ? Number(irStyle.space_after_pt)
            : Number(spec.space_after_pt || 0),
        spaceBeforePt: Number(spec.space_before_pt || 0),
        font: resolveFont(spec.font, irFont)
    };
}

/** 生成一个文字 run；runOverride 是 IR paragraph 里单个 run 的行内属性。 */
function buildTextRun(text, resolved, runOverride) {
    const runFont = runOverride && runOverride.font ? runOverride.font : null;
    const options = {
        text: String(text ?? ''),
        size: runFont && runFont.size_pt !== undefined ? styleConstants.ptToHalfPoint(runFont.size_pt) : resolved.size,
        font: runFont ? resolveFont(resolved.font, runFont) : resolved.font
    };
    const bold = runOverride && runOverride.bold !== undefined
        ? Boolean(runOverride.bold)
        : (runFont && runFont.bold !== undefined ? Boolean(runFont.bold) : resolved.bold);
    if (bold) options.bold = true;
    if (runOverride && runOverride.italic) options.italics = true;
    if (runOverride && runOverride.underline) options.underline = { type: docx.UnderlineType.SINGLE };
    const color = (runOverride && runOverride.color) || (runFont && runFont.color) || resolved.color;
    if (color) options.color = String(color);
    return new docx.TextRun(options);
}

/**
 * 按合并后的排版参数生成段落。
 * 首行缩进同时写 w:firstLineChars 与 w:firstLine，行距写 w:line 配 lineRule=auto。
 */
function buildParagraph(resolved, children, extra = {}) {
    const options = { children, ...extra };
    const alignment = alignmentOf(resolved.align);
    if (alignment) options.alignment = alignment;
    const spacing = {};
    if (Number.isFinite(resolved.lineHeight) && resolved.lineHeight > 0) {
        spacing.line = styleConstants.lineHeightToSpacingLine(resolved.lineHeight);
        spacing.lineRule = docx.LineRuleType.AUTO;
    }
    if (resolved.spaceAfterPt > 0) spacing.after = styleConstants.ptToTwip(resolved.spaceAfterPt);
    if (resolved.spaceBeforePt > 0) spacing.before = styleConstants.ptToTwip(resolved.spaceBeforePt);
    if (Object.keys(spacing).length) options.spacing = spacing;
    if (resolved.indentChars > 0) {
        options.indent = {
            firstLineChars: styleConstants.indentCharsToFirstLineChars(resolved.indentChars),
            firstLine: styleConstants.indentCharsToTwip(resolved.indentChars, resolved.size)
        };
    }
    return new docx.Paragraph(options);
}

/** 单行文本段落：版式元素（大标题、主送机关、落款等）的通用出口。 */
function buildTextParagraph(text, spec, irStyle, extra = {}) {
    const resolved = resolveSpec(spec, irStyle);
    return buildParagraph(resolved, [buildTextRun(text, resolved, null)], extra);
}

/**
 * 仅有边框的空段落：红头下的红线与版记上的分隔线都用这种段落模拟。
 * 段落标记的字号压到 1 磅（w:sz=2），避免空段落占掉一整行行高。
 */
function buildRuleParagraph(spec, side) {
    return new docx.Paragraph({
        children: [],
        border: { [side]: borderOf(spec.border) },
        spacing: spec.space_after_pt
            ? { after: styleConstants.ptToTwip(spec.space_after_pt) }
            : { before: styleConstants.ptToTwip(spec.space_before_pt || 0) },
        run: { size: Number(spec.size || 2) }
    });
}

/** IR heading 块转段落：层级 1-4 分别对应版式的 heading1-heading4。 */
function buildHeadingBlock(block, profile) {
    const level = Math.min(Math.max(Number.parseInt(block.level, 10) || 1, 1), 4);
    const spec = profile[`heading${level}`] || profile.body;
    return buildTextParagraph(block.text, spec, block.style);
}

/** IR paragraph 块转段落：逐个 run 保留行内加粗、倾斜、下划线、颜色与字体。 */
function buildParagraphBlock(block, profile) {
    const resolved = resolveSpec(profile.body, block.style);
    const runs = (block.runs || []).map(run => buildTextRun(run.text, resolved, run));
    return buildParagraph(resolved, runs.length ? runs : [buildTextRun('', resolved, null)]);
}

/**
 * 按 widths_pct 把正文宽度分配成各列的 dxa 列宽。
 * 逐列向下取整、余量给最后一列，保证 tblGrid 各列之和恰好等于表格总宽；
 * 未给出 widths_pct 时等分。
 */
function distributeColumnWidths(widthsPct, columnCount, totalTwip) {
    const source = Array.isArray(widthsPct) && widthsPct.length === columnCount
        ? widthsPct.map(value => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 0))
        : [];
    const total = source.reduce((sum, value) => sum + value, 0);
    const widths = [];
    let used = 0;
    for (let index = 0; index < columnCount; index += 1) {
        if (index === columnCount - 1) {
            widths.push(Math.max(1, totalTwip - used));
            break;
        }
        const ratio = total > 0 ? source[index] / total : 1 / columnCount;
        const width = Math.max(1, Math.floor(totalTwip * ratio));
        widths.push(width);
        used += width;
    }
    return widths;
}

/** 生成一个单元格：内部只放一个段落，段落样式来自表头或表体规格。 */
function buildTableCell(text, spec, irStyle, widthTwip) {
    const resolved = resolveSpec(spec, irStyle);
    return new docx.TableCell({
        width: { size: widthTwip, type: docx.WidthType.DXA },
        verticalAlign: docx.VerticalAlign.CENTER,
        children: [buildParagraph(resolved, [buildTextRun(text, resolved, null)])]
    });
}

/**
 * IR table 块转表格。
 * tblPr 写固定布局与四周及内部边框，tblGrid 列数与 IR 表头列数严格一致，
 * 表头行加粗居中并置 tblHeader，跨页时自动重复。
 */
function buildTableBlock(block, profile, metrics) {
    const header = Array.isArray(block.header) ? block.header : [];
    const columnCount = header.length;
    if (!columnCount) {
        throw renderError('表格块缺少表头，无法确定列数。', 'DOCX_RENDER_TABLE_INVALID');
    }
    const widths = distributeColumnWidths(block.widths_pct, columnCount, metrics.contentWidthTwip);
    const totalWidth = widths.reduce((sum, value) => sum + value, 0);
    const border = borderOf(styleConstants.DEFAULT_TABLE_BORDER);
    const headerRow = new docx.TableRow({
        tableHeader: true,
        children: header.map((text, index) => buildTableCell(text, profile.table_header_cell, block.style, widths[index]))
    });
    const bodyRows = (Array.isArray(block.rows) ? block.rows : []).map(row => new docx.TableRow({
        children: widths.map((width, index) => buildTableCell(Array.isArray(row) ? row[index] : '', profile.table_body_cell, block.style, width))
    }));
    return new docx.Table({
        columnWidths: widths,
        width: { size: totalWidth, type: docx.WidthType.DXA },
        layout: docx.TableLayoutType.FIXED,
        margins: { marginUnitType: docx.WidthType.DXA, ...styleConstants.TABLE_CELL_MARGIN_TWIP },
        borders: {
            top: border,
            bottom: border,
            left: border,
            right: border,
            insideHorizontal: border,
            insideVertical: border
        },
        rows: [headerRow, ...bodyRows]
    });
}

/**
 * IR list 块转段落序列。
 * 有序列表为每个 list 块单独注册一套编号（引用名带块序号），使每个列表从 1 重新开始；
 * 无序列表用 docx 内置项目符号。编号配置只依赖块序号，不引入随机源。
 */
function buildListBlock(block, blockIndex, profile, numberingConfigs) {
    const resolved = resolveSpec(profile.list_item, block.style);
    const items = Array.isArray(block.items) ? block.items : [];
    if (!block.ordered) {
        return items.map(item => buildParagraph(resolved, [buildTextRun(item, resolved, null)], { bullet: { level: 0 } }));
    }
    const reference = `pivot-ordered-list-${blockIndex}`;
    const indentLeft = styleConstants.indentCharsToTwip(2, resolved.size);
    const hanging = styleConstants.indentCharsToTwip(1, resolved.size);
    numberingConfigs.push({
        reference,
        levels: [{
            level: 0,
            format: docx.LevelFormat.DECIMAL,
            text: '%1.',
            alignment: docx.AlignmentType.LEFT,
            style: { paragraph: { indent: { left: indentLeft, hanging } } }
        }]
    });
    return items.map(item => buildParagraph(resolved, [buildTextRun(item, resolved, null)], {
        numbering: { reference, level: 0 }
    }));
}

/** 从字节流识别位图类型；无法识别时返回空字符串。 */
function detectImageType(data) {
    if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'png';
    if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'jpg';
    if (data.length >= 6 && data.slice(0, 3).toString('latin1') === 'GIF') return 'gif';
    if (data.length >= 26 && data[0] === 0x42 && data[1] === 0x4d) return 'bmp';
    return '';
}

/** 解析 JPEG 的 SOF 段，取出原始像素宽高。 */
function readJpegSize(data) {
    let offset = 2;
    while (offset + 9 < data.length) {
        if (data[offset] !== 0xff) {
            offset += 1;
            continue;
        }
        const marker = data[offset + 1];
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
            offset += 2;
            continue;
        }
        const segmentLength = data.readUInt16BE(offset + 2);
        const isStartOfFrame = (marker >= 0xc0 && marker <= 0xc3)
            || (marker >= 0xc5 && marker <= 0xc7)
            || (marker >= 0xc9 && marker <= 0xcb)
            || (marker >= 0xcd && marker <= 0xcf);
        if (isStartOfFrame) {
            return { width: data.readUInt16BE(offset + 7), height: data.readUInt16BE(offset + 5) };
        }
        if (segmentLength < 2) return null;
        offset += 2 + segmentLength;
    }
    return null;
}

/** 解析位图的原始像素尺寸；解析不出来返回 null，由调用方回退到默认比例。 */
function detectImageSize(data, type) {
    try {
        if (type === 'png' && data.length >= 24) return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
        if (type === 'gif') return { width: data.readUInt16LE(6), height: data.readUInt16LE(8) };
        if (type === 'bmp') return { width: Math.abs(data.readInt32LE(18)), height: Math.abs(data.readInt32LE(22)) };
        if (type === 'jpg') return readJpegSize(data);
    } catch (error) {
        return null;
    }
    return null;
}

/**
 * IR image 块转段落。
 * 图片字节只能通过 options.imageResolver 获取，渲染器不直接访问 CAS；
 * 未提供解析器、解析器返回空、或字节不是受支持的位图时跳过该图片且不报错。
 */
async function buildImageBlock(block, profile, metrics, imageResolver) {
    if (typeof imageResolver !== 'function') return null;
    const data = await imageResolver(String(block.asset_ref));
    if (!Buffer.isBuffer(data) || !data.length) return null;
    const type = detectImageType(data);
    if (!IMAGE_TYPES.includes(type)) return null;
    const intrinsic = detectImageSize(data, type);
    const requestedWidth = Number(block.width_mm);
    const widthMm = Math.min(
        Number.isFinite(requestedWidth) && requestedWidth > 0 ? requestedWidth : DEFAULT_IMAGE_WIDTH_MM,
        metrics.contentWidthMm
    );
    const requestedHeight = Number(block.height_mm);
    let heightMm;
    if (Number.isFinite(requestedHeight) && requestedHeight > 0) heightMm = requestedHeight;
    else if (intrinsic && intrinsic.width > 0 && intrinsic.height > 0) heightMm = widthMm * intrinsic.height / intrinsic.width;
    else heightMm = widthMm * DEFAULT_IMAGE_ASPECT;
    return new docx.Paragraph({
        alignment: alignmentOf(profile.image.align),
        children: [new docx.ImageRun({
            type,
            data,
            transformation: {
                width: styleConstants.mmToPixel(widthMm),
                height: styleConstants.mmToPixel(heightMm)
            }
        })]
    });
}

/** 把 IR 的 blocks 逐块转成 docx 的段落与表格。 */
async function buildBlocks(ir, profile, metrics, options, numberingConfigs) {
    const children = [];
    const blocks = Array.isArray(ir.blocks) ? ir.blocks : [];
    for (let index = 0; index < blocks.length; index += 1) {
        const block = blocks[index];
        const type = String(block.type);
        if (type === 'heading') {
            children.push(buildHeadingBlock(block, profile));
        } else if (type === 'paragraph') {
            children.push(buildParagraphBlock(block, profile));
        } else if (type === 'table') {
            children.push(buildTableBlock(block, profile, metrics));
        } else if (type === 'list') {
            buildListBlock(block, index, profile, numberingConfigs).forEach(paragraph => children.push(paragraph));
        } else if (type === 'page_break') {
            children.push(new docx.Paragraph({ children: [new docx.PageBreak()] }));
        } else if (type === 'image') {
            const paragraph = await buildImageBlock(block, profile, metrics, options.imageResolver);
            if (paragraph) children.push(paragraph);
        }
    }
    return children;
}

/**
 * 正文之前的版式元素。
 * 公文按「红头（发文机关标志）+ 红线 + 发文字号 + 大标题 + 副标题 + 主送机关」排布；
 * 通用文档只排「大标题 + 副标题 + 主送机关」，不套红头。
 */
function buildLeadingParagraphs(ir, profile) {
    const meta = ir.meta || {};
    const paragraphs = [];
    if (profile.red_header && String(meta.issuer || '').trim()) {
        paragraphs.push(buildTextParagraph(meta.issuer, profile.red_header, null));
        paragraphs.push(buildRuleParagraph(profile.red_line, 'bottom'));
    }
    if (String(meta.doc_number || '').trim()) {
        paragraphs.push(buildTextParagraph(meta.doc_number, profile.masthead, null));
    }
    if (String(meta.title || '').trim()) {
        paragraphs.push(buildTextParagraph(meta.title, profile.title, null));
    }
    if (String(meta.subtitle || '').trim()) {
        paragraphs.push(buildTextParagraph(meta.subtitle, profile.subtitle, null));
    }
    if (String(meta.recipient || '').trim()) {
        paragraphs.push(buildTextParagraph(meta.recipient, profile.recipient, null));
    }
    return paragraphs;
}

/**
 * 正文之后的版式元素：落款单位、成文日期与公文版记。
 * IR 没有抄送与印发机关字段，版记只用已有的发文机关与成文日期组成，不凭空编造内容；
 * 没有成文日期时不排版记。
 */
function buildTrailingParagraphs(ir, profile) {
    const meta = ir.meta || {};
    const paragraphs = [];
    if (String(meta.signoff || '').trim()) {
        paragraphs.push(buildTextParagraph(meta.signoff, profile.signoff, null));
    }
    const issuedDate = styleConstants.formatChineseDate(meta.issued_at);
    if (issuedDate) {
        paragraphs.push(buildTextParagraph(issuedDate, profile.issued_date, null));
    }
    if (profile.version_record && profile.version_record_separator && issuedDate) {
        paragraphs.push(buildRuleParagraph(profile.version_record_separator, 'top'));
        if (String(meta.issuer || '').trim()) {
            paragraphs.push(buildTextParagraph(`印发机关：${meta.issuer}`, profile.version_record, null));
        }
        paragraphs.push(buildTextParagraph(`印发日期：${issuedDate}`, profile.version_record, null));
    }
    return paragraphs;
}

/**
 * 页眉：非公开文件在每页页眉右上角标注密级。
 * 密级标识随页出现而不是只在首页，是为了避免打印后单页流出时丢失密级（与 §3.3 默认拒绝同向）。
 */
function buildDocumentHeader(ir, profile) {
    const level = String(ir.meta?.security_level || '');
    if (!level || level === 'public') return null;
    const label = styleConstants.SECURITY_LEVEL_LABELS[level];
    if (!label) return null;
    return new docx.Header({ children: [buildTextParagraph(label, profile.security_mark, null)] });
}

/**
 * 页脚：页码用 PAGE 域，格式取 ir.footer.format，把 {page} 替换为域。
 * 拒绝含 ASCII 问号的格式：历史上 exporters 的页码行写成了 ASCII 占位符，
 * 那是「第 N 页」被损坏后的形态（§10.2 的字符完整性指标要回归这个缺陷），
 * 与其渲染出会被 check_text_integrity.js 判为损坏的产物，不如在渲染入口直接拒绝。
 */
function buildDocumentFooter(ir, profile) {
    if (!ir.footer || !ir.footer.page_number) return null;
    const format = String(ir.footer.format || '');
    if (format.includes('?')) {
        throw renderError('页脚格式中不允许出现 ASCII 问号，请改用中文页码格式（例如「第 {page} 页」）。', 'DOCX_RENDER_FOOTER_INVALID');
    }
    const resolved = resolveSpec(profile.footer, null);
    const segments = format.split('{page}');
    const children = [];
    let hasPageField = false;
    segments.forEach((segment, index) => {
        if (segment) children.push(segment);
        if (index < segments.length - 1) {
            children.push(docx.PageNumber.CURRENT);
            hasPageField = true;
        }
    });
    // 格式里没有 {page} 占位时补一个页码域，保证开启页码后页脚一定含 PAGE 域。
    if (!hasPageField) children.push(docx.PageNumber.CURRENT);
    const run = new docx.TextRun({ children, size: resolved.size, font: resolved.font });
    return new docx.Footer({ children: [buildParagraph(resolved, [run])] });
}

/**
 * styles.xml 的文档级默认值：把正文字号与中文字体绑定写进 docDefaults，
 * 使任何未显式设置字体的内容也落在中文字体上，而不是回退到阅读器默认西文字体。
 */
function buildStylesOptions(profile) {
    const resolved = resolveSpec(profile.body, null);
    return {
        default: {
            document: {
                run: { size: resolved.size, font: resolved.font }
            }
        }
    };
}

/**
 * sectPr：纸张、页边距（缇）与页眉页脚距边距离。
 * 纸张传纵向标称尺寸：docx 库在 w:orient=landscape 时会自行交换 w:w 与 w:h，
 * 若这里先换过一次，横向页会被旋转两次退回纵向。
 */
function buildSectionProperties(metrics) {
    return {
        page: {
            size: {
                width: metrics.sheetWidthTwip,
                height: metrics.sheetHeightTwip,
                orientation: metrics.orientation === 'landscape' ? docx.PageOrientation.LANDSCAPE : docx.PageOrientation.PORTRAIT
            },
            margin: {
                top: metrics.marginTwip.top,
                right: metrics.marginTwip.right,
                bottom: metrics.marginTwip.bottom,
                left: metrics.marginTwip.left,
                header: styleConstants.mmToTwip(HEADER_DISTANCE_MM),
                footer: styleConstants.mmToTwip(FOOTER_DISTANCE_MM),
                gutter: 0
            }
        }
    };
}

/**
 * 从 Document IR 渲染 DOCX。
 * 传入的 ir 必须已经过 document-ir.js 规范化（validateDocumentIr 的 ir 字段），
 * 渲染器只处理规范化后的形状，不做「尽力渲染」。
 *
 * options.imageResolver: async (assetRef) => Buffer|null，用于 image 块取图；
 * 未提供或返回空时跳过该图片并不报错，渲染器不直接访问 CAS。
 */
async function renderDocx(ir, options = {}) {
    if (!ir || typeof ir !== 'object' || !Array.isArray(ir.blocks)) {
        throw renderError('待渲染的 Document IR 无效：缺少 blocks 数组。', 'DOCX_RENDER_IR_INVALID');
    }
    const profile = styleConstants.resolveProfile(ir.doc_type);
    const metrics = styleConstants.resolvePageMetrics(ir.meta?.page);
    const numberingConfigs = [];
    const children = [
        ...buildLeadingParagraphs(ir, profile),
        ...await buildBlocks(ir, profile, metrics, options, numberingConfigs),
        ...buildTrailingParagraphs(ir, profile)
    ];
    const header = buildDocumentHeader(ir, profile);
    const footer = buildDocumentFooter(ir, profile);
    const section = { properties: buildSectionProperties(metrics), children };
    if (header) section.headers = { default: header };
    if (footer) section.footers = { default: footer };
    const documentOptions = {
        creator: DOCUMENT_CREATOR,
        lastModifiedBy: DOCUMENT_CREATOR,
        title: String(ir.meta?.title || ''),
        revision: 1,
        // 让阅读器打开时刷新域，页码域才会显示实际页码。
        features: { updateFields: true },
        styles: buildStylesOptions(profile),
        sections: [section]
    };
    if (numberingConfigs.length) documentOptions.numbering = { config: numberingConfigs };
    const packed = await docx.Packer.toBuffer(new docx.Document(documentOptions));
    // docx 库会写入渲染时刻的时间戳，且底层 ZIP 的条目时间与压缩流都不稳定，
    // 因此统一按 IR 摘要派生的确定时间戳重打包，保证同一 IR 的产物摘要恒定。
    const timestamp = deriveDeterministicTimestamp(computeIrDigest(ir));
    return repackDeterministic(packed, timestamp);
}

module.exports = {
    MIME_TYPE,
    RENDERER_VERSION,
    detectImageSize,
    detectImageType,
    distributeColumnWidths,
    renderDocx,
    resolveFont
};
