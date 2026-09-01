/**
 * server/services/document-rendering/xlsx-renderer.js
 * Document IR → XLSX 渲染器
 *
 * 落地方案 v1.2 §7.2 依赖决策表：XLSX 直接复用已在库的 @e965/xlsx，
 * 禁止另起一套电子表格实现（开发规范第 8 条：不允许形成第二套体系）。
 *
 * 映射规则：
 * 1. 每个 table 块渲染为一个工作表，表名取 meta.title 清洗截断后加序号；
 * 2. heading / paragraph / list / image 等非 table 块汇总到首个「说明」工作表，
 *    每行一条文本；page_break 在电子表格中没有对应语义，直接跳过；
 * 3. 表头行加粗，列宽按 widths_pct 换算为 Excel 字符宽。
 *
 * 确定性（§10.2 渲染幂等性）：
 * - @e965/xlsx 的 zip 条目时间戳恒为 0（DOS 零时间），本身不引入非确定字段；
 * - 但 docProps/core.xml 的创建/修改时间来自 wb.Props，必须显式设成从 ir_digest
 *   派生的固定时间，否则一旦有人补上 Props 就会破坏幂等；
 * - 表头加粗需要改写 styles.xml，改写走 @e965/xlsx 自带的 zip 读写（XLSX.CFB），
 *   不引入第三方 zip 依赖，重打包结果对同一输入字节一致。
 * - 边界：deflate 由 Node 内置 zlib 完成，同一运行环境输出稳定；跨 Node/zlib 版本
 *   可能变化，该场景由 renderer_version 参与去重键覆盖，不影响同环境幂等断言。
 */
const XLSX = require('@e965/xlsx');
const { CAS_REF_PATTERN, computeIrDigest } = require('../document-ir');
const { assertRenderableIr, mergeRunsToPlainText } = require('./text-renderers');

const XLSX_RENDERER_VERSION = 'xlsx-1.0.0';
const XLSX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const NOTES_SHEET_NAME = '说明';
const NOTES_SHEET_HEADER = '说明内容';
const FALLBACK_SHEET_BASE = '表格';
const RESERVED_SHEET_NAME = 'history';
const MAX_SHEET_NAME_LENGTH = 31;
const MAX_CELL_TEXT_LENGTH = 32767;

/** Excel 工作表名非法字符：[ ] : * ? / 与反斜杠。 */
const ILLEGAL_SHEET_NAME_CHARS = Object.freeze(['[', ']', ':', '*', '?', '/', '\\']);

/** 纸张尺寸（毫米），用于把 widths_pct 换算成列宽。 */
const PAGE_SIZE_MM = Object.freeze({
    A4: Object.freeze({ width: 210, height: 297 }),
    A3: Object.freeze({ width: 297, height: 420 }),
    Letter: Object.freeze({ width: 215.9, height: 279.4 })
});

/** Excel 默认字体下一个字符宽约 2.2mm，用于毫米与字符宽互换。 */
const MM_PER_CHARACTER = 2.2;
const MIN_COLUMN_WIDTH = 6;
const MAX_COLUMN_WIDTH = 120;
const COLUMN_WIDTH_PADDING = 2;

/** 中日韩字符起始码位：显示宽度按 2 个字符计。 */
const WIDE_CHAR_START = 0x2e80;

const ZIP_COMPRESSION = true;
const DIGEST_TIME_BASE_MS = Date.UTC(2020, 0, 1, 0, 0, 0);
const DIGEST_TIME_RANGE_SECONDS = 10 * 365 * 24 * 3600;
const DEFAULT_BOLD_FONT_XML = '<font><b/><sz val="12"/><color theme="1"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font>';

/** 单元格文本：Excel 单格上限 32767 字符，超出即截断，避免产物被 Excel 判为损坏。 */
function cellText(value) {
    const text = String(value ?? '').replace(/\r\n?/g, '\n');
    return text.length > MAX_CELL_TEXT_LENGTH ? text.slice(0, MAX_CELL_TEXT_LENGTH) : text;
}

/** 说明工作表要求每行一条文本，因此把换行与制表符压成空格。 */
function singleLineText(value) {
    return cellText(value).replace(/[\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim();
}

/** 去掉控制字符：工作表名带控制字符会被 Excel 转义成 _x0007_ 之类的乱名。 */
function stripControlChars(text) {
    let output = '';
    for (const char of String(text ?? '')) {
        const code = char.codePointAt(0);
        if (code >= 0x20 && code !== 0x7f) output += char;
    }
    return output;
}

/** 显示宽度：中日韩字符按 2 个字符宽计算，用于内容自适应列宽。 */
function textDisplayWidth(value) {
    let width = 0;
    for (const char of String(value ?? '')) {
        width += char.codePointAt(0) >= WIDE_CHAR_START ? 2 : 1;
    }
    return width;
}

function clampColumnWidth(value) {
    const parsed = Number.isFinite(Number(value)) ? Number(value) : MIN_COLUMN_WIDTH;
    return Math.min(Math.max(Math.round(parsed), MIN_COLUMN_WIDTH), MAX_COLUMN_WIDTH);
}

function replaceIllegalSheetChars(text) {
    return ILLEGAL_SHEET_NAME_CHARS.reduce((accumulator, char) => accumulator.split(char).join('_'), text);
}

/**
 * 清洗工作表名：Excel 禁止 [ ] : * ? / 反斜杠，禁止首尾单引号与保留名 History，
 * 长度上限 31 字符。序号必须保留，因此先截断标题部分再拼序号；重名时追加重试标记。
 */
function sanitizeSheetName(rawTitle, ordinal, usedNames) {
    const used = usedNames instanceof Set ? usedNames : new Set();
    let base = replaceIllegalSheetChars(stripControlChars(singleLineText(rawTitle))).split("'").join('_').trim();
    if (!base) base = FALLBACK_SHEET_BASE;
    const suffix = `-${ordinal}`;
    if (base.length + suffix.length > MAX_SHEET_NAME_LENGTH) {
        base = base.slice(0, MAX_SHEET_NAME_LENGTH - suffix.length).trim();
    }
    if (!base) base = FALLBACK_SHEET_BASE;
    let name = `${base}${suffix}`;
    let retry = 2;
    while (used.has(name.toLowerCase()) || name.toLowerCase() === RESERVED_SHEET_NAME) {
        const mark = `${suffix}-${retry}`;
        name = `${base.slice(0, MAX_SHEET_NAME_LENGTH - mark.length).trim()}${mark}`;
        retry += 1;
    }
    used.add(name.toLowerCase());
    return name;
}

/** 可用页宽（毫米）：纸张宽减左右页边距，横向时交换长短边。 */
function pageContentWidthMm(page) {
    const paper = PAGE_SIZE_MM[page && page.size] || PAGE_SIZE_MM.A4;
    const width = page && page.orientation === 'landscape' ? paper.height : paper.width;
    const margins = (page && page.margin_mm) || {};
    const usable = width - (Number(margins.left) || 0) - (Number(margins.right) || 0);
    return usable > 20 ? usable : width;
}

/** 列宽：widths_pct 按可用页宽换算；未声明列宽时按内容显示宽度自适应。 */
function tableColumnWidths(block, pageWidthMm) {
    const columnCount = block.header.length;
    const totalWidth = Math.max(pageWidthMm / MM_PER_CHARACTER, MIN_COLUMN_WIDTH * columnCount);
    const percents = Array.isArray(block.widths_pct) ? block.widths_pct : [];
    const percentTotal = percents.reduce((sum, value) => sum + (Number(value) || 0), 0);
    return block.header.map((headerCell, index) => {
        if (percentTotal > 0) {
            const share = (Number(percents[index]) || 0) / percentTotal;
            return { wch: clampColumnWidth(share * totalWidth) };
        }
        const contentWidth = block.rows.reduce(
            (widest, row) => Math.max(widest, textDisplayWidth(row[index])),
            textDisplayWidth(headerCell)
        );
        return { wch: clampColumnWidth(contentWidth + COLUMN_WIDTH_PADDING) };
    });
}

/** 非 table 块汇总为「说明」工作表的文本行，每行一条。 */
function collectNoteRows(ir) {
    const rows = [];
    ir.blocks.forEach(block => {
        if (block.type === 'heading') {
            const text = singleLineText(block.text);
            if (text) rows.push(text);
            return;
        }
        if (block.type === 'paragraph') {
            const text = singleLineText(mergeRunsToPlainText(block.runs));
            if (text) rows.push(text);
            return;
        }
        if (block.type === 'list') {
            block.items.forEach((item, index) => {
                const text = singleLineText(item);
                if (!text) return;
                rows.push(`${block.ordered ? `${index + 1}. ` : '• '}${text}`);
            });
            return;
        }
        if (block.type === 'image' && CAS_REF_PATTERN.test(String(block.asset_ref))) {
            rows.push(`图片引用：${block.asset_ref}`);
        }
    });
    return rows;
}

/**
 * 从 ir_digest 派生固定时间戳写入 wb.Props：core.xml 因此不含真实时钟，
 * 同一 IR 两次渲染的字节完全一致；不同 IR 的产物元数据仍互不相同。
 */
function deterministicProps(ir) {
    const digest = computeIrDigest(ir);
    const offsetSeconds = Number.parseInt(digest.slice(0, 8), 16) % DIGEST_TIME_RANGE_SECONDS;
    const stamp = new Date(DIGEST_TIME_BASE_MS + offsetSeconds * 1000);
    return { CreatedDate: stamp, ModifiedDate: stamp };
}

/** 在 zip 容器里按包内路径定位条目。 */
function findPackageEntry(container, packagePath) {
    const suffix = `/${packagePath}`;
    for (let index = 0; index < container.FullPaths.length; index += 1) {
        if (container.FullPaths[index].endsWith(suffix)) return container.FileIndex[index];
    }
    return null;
}

function readEntryText(entry) {
    return Buffer.from(entry.content).toString('utf8');
}

function writeEntryText(entry, text) {
    const content = Buffer.from(text, 'utf8');
    entry.content = content;
    entry.size = content.length;
}

/**
 * @e965/xlsx 的写入端把 styles.xml 的 fonts 固定成单个常规字体（fontId 恒为 0），
 * 无法用 cell.s 表达加粗。这里在它生成的样式表上追加一个加粗字体与对应 cellXfs 记录，
 * 返回新样式索引。改写是纯字符串追加，不引入任何时间或随机内容。
 */
function patchStylesForBoldHeader(xml) {
    const fontsMatch = xml.match(/<fonts count="(\d+)"([^>]*)>([\s\S]*?)<\/fonts>/);
    const cellXfsMatch = xml.match(/<cellXfs count="(\d+)"([^>]*)>([\s\S]*?)<\/cellXfs>/);
    if (!fontsMatch || !cellXfsMatch) return null;
    const boldFontId = Number.parseInt(fontsMatch[1], 10);
    const boldStyleIndex = Number.parseInt(cellXfsMatch[1], 10);
    if (!Number.isSafeInteger(boldFontId) || !Number.isSafeInteger(boldStyleIndex)) return null;
    const baseFont = fontsMatch[3].match(/<font>[\s\S]*?<\/font>/);
    const boldFont = baseFont ? baseFont[0].replace('<font>', '<font><b/>') : DEFAULT_BOLD_FONT_XML;
    const fonts = `<fonts count="${boldFontId + 1}"${fontsMatch[2]}>${fontsMatch[3]}${boldFont}</fonts>`;
    const boldXf = `<xf numFmtId="0" fontId="${boldFontId}" fillId="0" borderId="0" xfId="0" applyFont="1"/>`;
    const cellXfs = `<cellXfs count="${boldStyleIndex + 1}"${cellXfsMatch[2]}>${cellXfsMatch[3]}${boldXf}</cellXfs>`;
    return {
        xml: xml.replace(fontsMatch[0], () => fonts).replace(cellXfsMatch[0], () => cellXfs),
        styleIndex: boldStyleIndex
    };
}

/** 给首行（表头）单元格挂上加粗样式索引。 */
function applyBoldToFirstRow(xml, styleIndex) {
    return xml.replace(/<row r="1"([^>]*)>([\s\S]*?)<\/row>/, (whole, rowAttributes, cells) => {
        const boldCells = cells.replace(/<c ([^>]*?)(\/?)>/g, (cellWhole, cellAttributes, selfClose) => {
            if (/(^| )s="/.test(cellAttributes)) return cellWhole;
            return `<c ${cellAttributes} s="${styleIndex}"${selfClose}>`;
        });
        return `<row r="1"${rowAttributes}>${boldCells}</row>`;
    });
}

/** 用 @e965/xlsx 自带的 zip 读写能力给表头加粗后重新打包，不引入第三方 zip 依赖。 */
function applyHeaderBold(rawBuffer, headerSheetOrdinals) {
    if (!headerSheetOrdinals.length) return rawBuffer;
    const container = XLSX.CFB.read(rawBuffer, { type: 'buffer' });
    const stylesEntry = findPackageEntry(container, 'xl/styles.xml');
    if (!stylesEntry) return rawBuffer;
    const patched = patchStylesForBoldHeader(readEntryText(stylesEntry));
    if (!patched) return rawBuffer;
    writeEntryText(stylesEntry, patched.xml);
    headerSheetOrdinals.forEach(ordinal => {
        const sheetEntry = findPackageEntry(container, `xl/worksheets/sheet${ordinal}.xml`);
        if (!sheetEntry) return;
        writeEntryText(sheetEntry, applyBoldToFirstRow(readEntryText(sheetEntry), patched.styleIndex));
    });
    return XLSX.CFB.write(container, { type: 'buffer', fileType: 'zip', compression: ZIP_COMPRESSION });
}

/** 说明工作表：首行是表头，其余每行一条文本。 */
function appendNotesSheet(workbook, noteRows, usedNames) {
    const sheet = XLSX.utils.aoa_to_sheet([[NOTES_SHEET_HEADER], ...noteRows.map(text => [text])]);
    const contentWidth = noteRows.reduce(
        (widest, text) => Math.max(widest, textDisplayWidth(text)),
        textDisplayWidth(NOTES_SHEET_HEADER)
    );
    sheet['!cols'] = [{ wch: clampColumnWidth(contentWidth + COLUMN_WIDTH_PADDING) }];
    usedNames.add(NOTES_SHEET_NAME.toLowerCase());
    XLSX.utils.book_append_sheet(workbook, sheet, NOTES_SHEET_NAME);
}

/**
 * IR → XLSX（Buffer）。每个 table 块一个工作表，非 table 块汇总到首个「说明」工作表。
 * doc_type=table 但没有 table 块时直接拒绝，不产出空表格文件。
 */
function renderXlsx(ir) {
    assertRenderableIr(ir);
    const tables = ir.blocks.filter(block => block.type === 'table');
    if (!tables.length && ir.doc_type === 'table') {
        throw new Error('渲染失败：doc_type=table 的文档必须至少包含一个 table 块，当前没有可写入的表格。');
    }
    const pageWidthMm = pageContentWidthMm(ir.meta.page);
    const noteRows = collectNoteRows(ir);
    const workbook = XLSX.utils.book_new();
    const usedNames = new Set();
    const headerSheetOrdinals = [];
    if (noteRows.length) {
        appendNotesSheet(workbook, noteRows, usedNames);
        headerSheetOrdinals.push(workbook.SheetNames.length);
    }
    tables.forEach((block, index) => {
        const rows = [block.header.map(cellText)].concat(block.rows.map(row => row.map(cellText)));
        const sheet = XLSX.utils.aoa_to_sheet(rows);
        sheet['!cols'] = tableColumnWidths(block, pageWidthMm);
        XLSX.utils.book_append_sheet(workbook, sheet, sanitizeSheetName(ir.meta.title, index + 1, usedNames));
        headerSheetOrdinals.push(workbook.SheetNames.length);
    });
    if (!workbook.SheetNames.length) {
        throw new Error('渲染失败：IR 中没有可写入工作表的内容，XLSX 至少需要一个工作表。');
    }
    workbook.Props = deterministicProps(ir);
    const raw = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx', compression: ZIP_COMPRESSION });
    return applyHeaderBold(raw, headerSheetOrdinals);
}

module.exports = {
    NOTES_SHEET_HEADER,
    NOTES_SHEET_NAME,
    XLSX_MIME_TYPE,
    XLSX_RENDERER_VERSION,
    renderXlsx,
    sanitizeSheetName
};
