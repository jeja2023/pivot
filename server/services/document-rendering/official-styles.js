/**
 * server/services/document-rendering/official-styles.js
 * 公文版式常量与单位换算
 *
 * 落地方案 v1.2 §7.2、§10.2、阶段 2.3：
 * 1. 服务端此前没有公文版式能力，事实实现散落在前端 client/chat/apps-workbench-export.js；
 *    本文件把前端硬编码的版式参数集中复刻为服务端常量，避免形成第二套版式体系（开发规范第 8 条）；
 * 2. 只放常量与纯函数，不依赖 docx 库，便于单独断言度量值（§10.2 的度量断言）；
 * 3. DOCX 只写字体名、不嵌入字体文件，因此这里出现的中文字体名是「排版意图」而非分发的字体资产，
 *    不涉及 §7.2 的字体授权约束；
 * 4. 所有换算一律取整为整数，保证同一输入恒得同一 twip 值（渲染幂等的前提）。
 */

/** 一英寸等于 25.4 毫米。 */
const MM_PER_INCH = 25.4;
/** 一英寸等于 1440 缇（twip），即 20 缇每磅。 */
const TWIP_PER_INCH = 1440;
/** 一英寸按 96 像素折算，供 docx 图片尺寸（像素）换算使用。 */
const PIXEL_PER_INCH = 96;
/** 单倍行距对应的 w:line 基准值。 */
const LINE_SPACING_BASE = 240;

/**
 * 毫米转缇，向下取整。
 * 取整方式与前端导出以及 docx 库的 convertMillimetersToTwip 保持一致，
 * 否则同一页边距会在两套实现里得到相差 1 缇的结果。
 */
function mmToTwip(millimeters) {
    const value = Number(millimeters);
    if (!Number.isFinite(value)) return 0;
    return Math.floor(value / MM_PER_INCH * TWIP_PER_INCH);
}

/** 毫米转像素（96 DPI），供图片宽高换算使用。 */
function mmToPixel(millimeters) {
    const value = Number(millimeters);
    if (!Number.isFinite(value)) return 0;
    return Math.max(1, Math.round(value / MM_PER_INCH * PIXEL_PER_INCH));
}

/** 磅转半磅（OOXML 的 w:sz 单位是半磅）。 */
function ptToHalfPoint(points) {
    const value = Number(points);
    if (!Number.isFinite(value)) return 0;
    return Math.round(value * 2);
}

/** 磅转缇（1 磅 = 20 缇），用于段前段后间距。 */
function ptToTwip(points) {
    const value = Number(points);
    if (!Number.isFinite(value)) return 0;
    return Math.round(value * 20);
}

/** 倍数行距转 w:line 值（配合 lineRule=auto 使用）。 */
function lineHeightToSpacingLine(lineHeight) {
    const value = Number(lineHeight);
    if (!Number.isFinite(value) || value <= 0) return LINE_SPACING_BASE;
    return Math.round(LINE_SPACING_BASE * value);
}

/** 首行缩进字符数转 w:firstLineChars（单位是百分之一字符）。 */
function indentCharsToFirstLineChars(chars) {
    const value = Number(chars);
    if (!Number.isFinite(value) || value <= 0) return 0;
    return Math.round(value * 100);
}

/**
 * 首行缩进字符数转 w:firstLine（缇）。
 * 字符宽度按当前字号折算：缇数 = 字符数 × 字号磅值 × 20。
 * 同时写出 firstLineChars 与 firstLine，兼容按字符缩进与按绝对值缩进的两类阅读器。
 */
function indentCharsToTwip(chars, sizeHalfPoint) {
    const count = Number(chars);
    const size = Number(sizeHalfPoint);
    if (!Number.isFinite(count) || count <= 0 || !Number.isFinite(size) || size <= 0) return 0;
    return Math.round(count * (size / 2) * 20);
}

/**
 * 纸张尺寸（缇）。
 * A4 取 Word 惯用的 11906 × 16838，与前端导出的 w:pgSz 完全一致；
 * 直接用 mmToTwip(210)/mmToTwip(297) 会得到 11905/16837，会与既有产物产生 1 缇偏差。
 */
const PAGE_SIZE_TWIP = Object.freeze({
    A4: Object.freeze({ width: 11906, height: 16838 }),
    A3: Object.freeze({ width: 16838, height: 23811 }),
    Letter: Object.freeze({ width: 12240, height: 15840 })
});

/** 公文字号对应的 w:sz 半磅值。 */
const FONT_SIZE_HALF_POINT = Object.freeze({
    YI_HAO: 52,
    ER_HAO: 44,
    XIAO_ER: 36,
    SAN_HAO: 32,
    XIAO_SAN: 30,
    SI_HAO: 28,
    XIAO_SI: 24,
    WU_HAO: 21
});

/**
 * 字体名。
 * 这些是写入 w:rFonts 的字体名称，渲染端不分发字体文件；
 * 中文走 w:eastAsia，西文与数字走 w:ascii / w:hAnsi，形成 §7.2 要求的备用族绑定。
 */
const FONT_FAMILY = Object.freeze({
    HEI: 'SimHei',
    FANG_SONG: 'FangSong',
    SONG: 'SimSun',
    KAI: 'KaiTi'
});

/** 西文备用字体，与中文字体成对写入 w:ascii / w:hAnsi。 */
const ASCII_FALLBACK_FONT = 'Times New Roman';

/** 公文红色（红头与红线）。 */
const OFFICIAL_RED = 'C00000';

/** 红线：空段落的下边框，粗 3 磅（w:sz=24 为八分之一磅单位）。 */
const RED_LINE_BORDER = Object.freeze({ style: 'single', size: 24, space: 1, color: OFFICIAL_RED });

/** 版记分隔线：空段落的上边框，细线。 */
const VERSION_RECORD_BORDER = Object.freeze({ style: 'single', size: 6, space: 1, color: '000000' });

/** 表格默认边框：四周与内部均为 0.5 磅细实线。 */
const DEFAULT_TABLE_BORDER = Object.freeze({ style: 'single', size: 4, color: '000000' });

/** 表格单元格内边距（缇）。 */
const TABLE_CELL_MARGIN_TWIP = Object.freeze({ top: 40, bottom: 40, left: 100, right: 100 });

/** 密级标识文案；IR 的 security_level 是枚举，这里给出中文标识。 */
const SECURITY_LEVEL_LABELS = Object.freeze({
    public: '公开',
    internal: '内部',
    confidential: '秘密',
    secret: '机密'
});

/** 中文字体与西文备用字体成对绑定。 */
function fontPair(eastAsia, ascii = ASCII_FALLBACK_FONT) {
    return Object.freeze({ eastAsia, ascii });
}

const HEI_FONT = fontPair(FONT_FAMILY.HEI, FONT_FAMILY.HEI);
const FANG_SONG_FONT = fontPair(FONT_FAMILY.FANG_SONG);
const SONG_FONT = fontPair(FONT_FAMILY.SONG);

/**
 * 公文版式（doc_type=official_document）。
 * 各元素的对齐、字体、字号、首行缩进逐条复刻 client/chat/apps-workbench-export.js 的既有实现：
 * 大标题居中黑体加粗二号、主送机关左对齐三号、一级标题首行缩进 2 字符黑体加粗三号、
 * 二级标题加粗三号、三级标题与正文三号、落款与成文日期右对齐三号、版头与版记小三。
 * 行距不设默认值：前端未设置行距（沿用阅读器单倍行距），仅当 IR 的 style.line_height 显式给出时才写 w:spacing。
 */
const OFFICIAL_PROFILE = Object.freeze({
    doc_type: 'official_document',
    body_font: FANG_SONG_FONT,
    heading_font: HEI_FONT,
    red_header: Object.freeze({ size: FONT_SIZE_HALF_POINT.YI_HAO, bold: true, color: OFFICIAL_RED, align: 'center', font: HEI_FONT }),
    red_line: Object.freeze({ size: 2, space_after_pt: 12, border: RED_LINE_BORDER }),
    masthead: Object.freeze({ size: FONT_SIZE_HALF_POINT.XIAO_SAN, align: 'center', font: FANG_SONG_FONT }),
    security_mark: Object.freeze({ size: FONT_SIZE_HALF_POINT.XIAO_SAN, align: 'right', font: HEI_FONT }),
    title: Object.freeze({ size: FONT_SIZE_HALF_POINT.ER_HAO, bold: true, align: 'center', space_after_pt: 12, font: HEI_FONT }),
    subtitle: Object.freeze({ size: FONT_SIZE_HALF_POINT.SAN_HAO, align: 'center', space_after_pt: 6, font: FANG_SONG_FONT }),
    recipient: Object.freeze({ size: FONT_SIZE_HALF_POINT.SAN_HAO, align: 'left', font: FANG_SONG_FONT }),
    heading1: Object.freeze({ size: FONT_SIZE_HALF_POINT.SAN_HAO, bold: true, indent_chars: 2, font: HEI_FONT }),
    heading2: Object.freeze({ size: FONT_SIZE_HALF_POINT.SAN_HAO, bold: true, indent_chars: 2, font: FANG_SONG_FONT }),
    heading3: Object.freeze({ size: FONT_SIZE_HALF_POINT.SAN_HAO, indent_chars: 2, font: FANG_SONG_FONT }),
    heading4: Object.freeze({ size: FONT_SIZE_HALF_POINT.SAN_HAO, indent_chars: 2, font: FANG_SONG_FONT }),
    body: Object.freeze({ size: FONT_SIZE_HALF_POINT.SAN_HAO, indent_chars: 2, font: FANG_SONG_FONT }),
    list_item: Object.freeze({ size: FONT_SIZE_HALF_POINT.SAN_HAO, font: FANG_SONG_FONT }),
    signoff: Object.freeze({ size: FONT_SIZE_HALF_POINT.SAN_HAO, align: 'right', font: FANG_SONG_FONT }),
    issued_date: Object.freeze({ size: FONT_SIZE_HALF_POINT.SAN_HAO, align: 'right', font: FANG_SONG_FONT }),
    version_record_separator: Object.freeze({ size: 2, space_before_pt: 18, border: VERSION_RECORD_BORDER }),
    version_record: Object.freeze({ size: FONT_SIZE_HALF_POINT.XIAO_SAN, align: 'left', font: FANG_SONG_FONT }),
    table_header_cell: Object.freeze({ size: FONT_SIZE_HALF_POINT.XIAO_SI, bold: true, align: 'center', font: HEI_FONT }),
    table_body_cell: Object.freeze({ size: FONT_SIZE_HALF_POINT.XIAO_SI, align: 'left', font: FANG_SONG_FONT }),
    footer: Object.freeze({ size: FONT_SIZE_HALF_POINT.SI_HAO, align: 'center', font: SONG_FONT }),
    image: Object.freeze({ align: 'center' })
});

/**
 * 通用版式（doc_type=report/table/memo）。
 * 通用文档不套红头与版记，正文不强制首行缩进，标题层级按小二至小四递减。
 */
const GENERAL_PROFILE = Object.freeze({
    doc_type: 'general',
    body_font: SONG_FONT,
    heading_font: HEI_FONT,
    red_header: null,
    red_line: null,
    masthead: Object.freeze({ size: FONT_SIZE_HALF_POINT.WU_HAO, align: 'center', font: SONG_FONT }),
    security_mark: Object.freeze({ size: FONT_SIZE_HALF_POINT.WU_HAO, align: 'right', font: HEI_FONT }),
    title: Object.freeze({ size: FONT_SIZE_HALF_POINT.XIAO_ER, bold: true, align: 'center', space_after_pt: 12, font: HEI_FONT }),
    subtitle: Object.freeze({ size: FONT_SIZE_HALF_POINT.XIAO_SI, align: 'center', space_after_pt: 6, font: SONG_FONT }),
    recipient: Object.freeze({ size: FONT_SIZE_HALF_POINT.XIAO_SI, align: 'left', font: SONG_FONT }),
    heading1: Object.freeze({ size: FONT_SIZE_HALF_POINT.SAN_HAO, bold: true, space_before_pt: 6, space_after_pt: 6, font: HEI_FONT }),
    heading2: Object.freeze({ size: FONT_SIZE_HALF_POINT.XIAO_SAN, bold: true, space_before_pt: 6, space_after_pt: 6, font: HEI_FONT }),
    heading3: Object.freeze({ size: FONT_SIZE_HALF_POINT.SI_HAO, bold: true, space_after_pt: 6, font: HEI_FONT }),
    heading4: Object.freeze({ size: FONT_SIZE_HALF_POINT.XIAO_SI, bold: true, space_after_pt: 6, font: HEI_FONT }),
    body: Object.freeze({ size: FONT_SIZE_HALF_POINT.XIAO_SI, font: SONG_FONT }),
    list_item: Object.freeze({ size: FONT_SIZE_HALF_POINT.XIAO_SI, font: SONG_FONT }),
    signoff: Object.freeze({ size: FONT_SIZE_HALF_POINT.XIAO_SI, align: 'right', font: SONG_FONT }),
    issued_date: Object.freeze({ size: FONT_SIZE_HALF_POINT.XIAO_SI, align: 'right', font: SONG_FONT }),
    version_record_separator: null,
    version_record: null,
    table_header_cell: Object.freeze({ size: FONT_SIZE_HALF_POINT.WU_HAO, bold: true, align: 'center', font: HEI_FONT }),
    table_body_cell: Object.freeze({ size: FONT_SIZE_HALF_POINT.WU_HAO, align: 'left', font: SONG_FONT }),
    footer: Object.freeze({ size: FONT_SIZE_HALF_POINT.WU_HAO, align: 'center', font: SONG_FONT }),
    image: Object.freeze({ align: 'center' })
});

/** 按 doc_type 选版式：只有公文走公文版式，其余走通用版式。 */
function resolveProfile(docType) {
    return String(docType) === 'official_document' ? OFFICIAL_PROFILE : GENERAL_PROFILE;
}

/**
 * 计算页面度量：纸张（缇）、页边距（缇）与正文可用宽度（缇）。
 * sheetWidthTwip / sheetHeightTwip 是纸张的纵向标称尺寸，横向时不在这里交换：
 * OOXML 的 w:pgSz 在 w:orient=landscape 时由写出方负责交换长宽，docx 库已经做了这一步，
 * 这里再换一次会得到旋转两次的结果。widthTwip / heightTwip 是版面实际的宽高，
 * 用于表格列宽与图片宽度上限的换算。
 */
function resolvePageMetrics(page) {
    const size = PAGE_SIZE_TWIP[String(page?.size)] || PAGE_SIZE_TWIP.A4;
    const landscape = String(page?.orientation) === 'landscape';
    const width = landscape ? size.height : size.width;
    const height = landscape ? size.width : size.height;
    const marginSource = page?.margin_mm || {};
    const margin = {
        top: mmToTwip(marginSource.top),
        bottom: mmToTwip(marginSource.bottom),
        left: mmToTwip(marginSource.left),
        right: mmToTwip(marginSource.right)
    };
    const contentWidth = Math.max(1, width - margin.left - margin.right);
    return {
        sheetWidthTwip: size.width,
        sheetHeightTwip: size.height,
        widthTwip: width,
        heightTwip: height,
        orientation: landscape ? 'landscape' : 'portrait',
        marginTwip: margin,
        contentWidthTwip: contentWidth,
        contentWidthMm: contentWidth / TWIP_PER_INCH * MM_PER_INCH
    };
}

/** 把 YYYY-MM-DD 的成文日期格式化为中文日期；格式不符时原样返回。 */
function formatChineseDate(value) {
    const text = String(value || '').trim();
    const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
    if (!matched) return text;
    return `${matched[1]}年${Number(matched[2])}月${Number(matched[3])}日`;
}

module.exports = {
    ASCII_FALLBACK_FONT,
    DEFAULT_TABLE_BORDER,
    FONT_FAMILY,
    FONT_SIZE_HALF_POINT,
    GENERAL_PROFILE,
    LINE_SPACING_BASE,
    MM_PER_INCH,
    OFFICIAL_PROFILE,
    OFFICIAL_RED,
    PAGE_SIZE_TWIP,
    PIXEL_PER_INCH,
    RED_LINE_BORDER,
    SECURITY_LEVEL_LABELS,
    TABLE_CELL_MARGIN_TWIP,
    TWIP_PER_INCH,
    VERSION_RECORD_BORDER,
    formatChineseDate,
    indentCharsToFirstLineChars,
    indentCharsToTwip,
    lineHeightToSpacingLine,
    mmToPixel,
    mmToTwip,
    ptToHalfPoint,
    ptToTwip,
    resolvePageMetrics,
    resolveProfile
};
