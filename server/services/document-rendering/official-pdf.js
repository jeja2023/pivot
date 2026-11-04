const { PDFDocument, rgb } = require('pdf-lib');
const format = require('../../../client/common/official-writing-format');
const { embedOfficialFonts, loadOfficialFonts } = require('./official-fonts');
const { splitAttachments, signatureBox, widthOf } = require('./official-layout');
const { formatChineseDate } = require('./official-styles');
const layout = require('./pdf-text-layout');
const { OFFICIAL_PAGE_DEFAULT } = require('../document-ir');

const BLACK = rgb(0, 0, 0), RED = rgb(0.75, 0, 0);
const security = { internal: '内部', confidential: '秘密', secret: '机密' };

function createContext(document, fonts, sources) {
    const box = layout.resolvePageBox(OFFICIAL_PAGE_DEFAULT);
    const ctx = { document, fonts, sources, box, pages: [], page: null, row: 0, pendingBreak: false, activeFont: null };
    ctx.measure = (text, role, size) => widthOf(text, role, sources, size);
    ctx.newPage = () => {
        ctx.page = document.addPage([box.width, box.height]); ctx.pages.push(ctx.page);
        ctx.row = 0; ctx.pendingBreak = false; ctx.activeFont = null;
    };
    ctx.ensure = rows => {
        if (!ctx.page || ctx.pendingBreak || ctx.row + rows > format.LINES) ctx.newPage();
    };
    ctx.gap = count => { ctx.ensure(count + 1); ctx.row += count; };
    ctx.text = (text, x, baseline, role, size = format.BODY_PT, color = BLACK) => {
        for (const segment of format.splitScripts(text)) {
            const fontRole = segment.ascii && role !== 'footer' ? 'ascii' : role;
            const face = sources[fontRole].face;
            for (const char of Array.from(segment.text)) {
                if (!face.hasGlyphForCodePoint(char.codePointAt(0))) throw Object.assign(new Error(`指定字体 ${format.FONT[fontRole]} 缺少字符“${char}”，请核对正文；不能用替代字体冒充规范排版。`), { status: 422, code: 'OFFICIAL_FONT_GLYPH_MISSING' });
            }
            const font = fonts[fontRole];
            if (ctx.activeFont !== font) { ctx.page.setFont(font); ctx.activeFont = font; }
            if (segment.ascii || role === 'title' || role === 'footer' || size !== format.BODY_PT) {
                ctx.page.drawText(segment.text, { x, y: baseline, size, color });
                x += ctx.measure(segment.text, role, size);
            } else {
                for (const char of Array.from(segment.text)) {
                    ctx.page.drawText(char, { x, y: baseline, size, color }); x += ctx.measure(char, role, size);
                }
            }
        }
        return x;
    };
    ctx.wrap = (text, { role = 'body', size = format.BODY_PT, indent = 0, hanging = 0, width = box.contentWidth } = {}) => {
        const measurer = { widthOf: value => ctx.measure(value, role, size) };
        const style = { size };
        const tokens = layout.buildInlineTokens([{ text, style }], measurer);
        const lines = layout.wrapTokens(tokens, { measurer, maxWidth: width, indentPt: indent, continuationIndentPt: hanging });
        return lines.map(line => ({ text: line.tokens.map(token => token.text).join(''), indent: line.indent }));
    };
    ctx.flow = (text, options = {}) => {
        const { role = 'body', size = format.BODY_PT, align = 'left', left = 0, right = 0, indent = 0, hanging = 0, keep = false, color = BLACK } = options;
        const width = box.contentWidth - left - right;
        const lines = ctx.wrap(text, { role, size, width, indent, hanging });
        if (keep && lines.length <= format.LINES) ctx.ensure(lines.length);
        for (const line of lines) {
            ctx.ensure(1);
            const used = ctx.measure(line.text, role, size);
            const shift = align === 'center' ? (width - used) / 2 : align === 'right' ? width - used : line.indent;
            const face = sources[role].face;
            const ascent = face.ascent / face.unitsPerEm * size;
            const baseline = box.contentTop - ctx.row * format.LINE_PT - (format.LINE_PT - size) / 2 - ascent;
            ctx.text(line.text, box.contentLeft + left + Math.max(0, shift), baseline, role, size, color);
            ctx.row++;
        }
        return lines.length;
    };
    ctx.newPage();
    return ctx;
}

function renderHead(ctx, meta) {
    if (meta.layout !== 'plain' && meta.issuer) {
        ctx.flow(meta.issuer, { role: 'heading1', size: 26, align: 'center', color: RED, keep: true });
        const y = ctx.box.contentTop - ctx.row * format.LINE_PT;
        ctx.page.drawLine({ start: { x: ctx.box.contentLeft, y }, end: { x: ctx.box.contentRight, y }, color: RED, thickness: 1.5 });
        ctx.gap(1);
    }
    if (meta.urgency) ctx.flow(meta.urgency, { align: 'center' });
    if (meta.signer) ctx.flow('签发人：' + meta.signer, { align: 'center' });
    if (meta.doc_number) ctx.flow(meta.doc_number, { align: 'center' });
    const titleLines = format.arrangeTitle(meta.title);
    ctx.ensure(titleLines.length + format.GAP_LINES.afterTitle + 1);
    for (const line of titleLines) ctx.flow(line, { role: 'title', size: format.TITLE_PT, align: 'center', keep: true });
    if (meta.subtitle) ctx.flow(meta.subtitle, { align: 'center' });
    if (meta.title || meta.subtitle) ctx.gap(format.GAP_LINES.afterTitle);
    if (meta.recipient) ctx.flow(String(meta.recipient).replace(/[:：]\s*$/, '') + '：');
}

function paragraphText(block) { return (block.runs || []).map(run => String(run.text || '')).join(''); }

async function renderBlock(ctx, block, options) {
    if (block.type === 'page_break') { ctx.pendingBreak = true; return; }
    if (block.type === 'heading') {
        const role = block.level === 1 ? 'heading1' : block.level === 2 ? 'heading2' : 'body';
        ctx.ensure(2); ctx.flow(format.normalizeHeading(block.text, block.level), { role, indent: 2 * format.CHAR_PITCH_PT }); return;
    }
    if (block.type === 'paragraph') {
        const role = block.style?.official_role;
        const text = paragraphText(block);
        if (role === 'attachment_note') {
            const prefix = block.style.attachment_prefix || '附件：';
            if (prefix.startsWith('附件')) ctx.gap(format.GAP_LINES.beforeAttachment);
            const base = 2 * format.CHAR_PITCH_PT;
            const padding = /^　+/.exec(prefix)?.[0] || '';
            const indent = base + ctx.measure(padding, 'body', 16);
            ctx.flow(text.slice(padding.length), { indent, hanging: base + ctx.measure(prefix, 'body', 16) }); return;
        }
        if (role === 'attachment_label') { ctx.ensure(2); ctx.flow(text.replace(/[：:]$/, ''), { role: 'heading1' }); return; }
        if (role === 'attachment_title') {
            const lines = format.arrangeTitle(text); ctx.ensure(lines.length + format.GAP_LINES.afterTitle + 1);
            for (const line of lines) ctx.flow(line, { role: 'title', size: 22, align: 'center', keep: true });
            ctx.gap(format.GAP_LINES.afterTitle);
            return;
        }
        ctx.flow(text, { indent: 2 * format.CHAR_PITCH_PT }); return;
    }
    if (block.type === 'list') {
        for (const [index, text] of block.items.entries()) ctx.flow(`${block.ordered ? index + 1 + '. ' : '· '}${text}`, { indent: 2 * format.CHAR_PITCH_PT });
        return;
    }
    if (block.type === 'table') return renderTable(ctx, block);
    if (block.type === 'image') {
        const bytes = await options.imageResolver?.(block.asset_ref);
        if (!bytes) throw Object.assign(new Error('无法读取公文中的图片资源'), { status: 422 });
        const image = bytes[0] === 0x89 ? await ctx.document.embedPng(bytes) : await ctx.document.embedJpg(bytes);
        const width = Math.min(ctx.box.contentWidth, block.width_mm ? layout.mmToPt(block.width_mm) : image.width);
        const height = block.height_mm ? layout.mmToPt(block.height_mm) : width * image.height / image.width;
        const rows = Math.ceil(height / format.LINE_PT);
        if (rows > format.LINES) throw Object.assign(new Error('图片超过公文正文版心，请缩小图片后导出'), { status: 422 });
        ctx.ensure(rows);
        ctx.page.drawImage(image, { x: ctx.box.contentLeft + (ctx.box.contentWidth - width) / 2, y: ctx.box.contentTop - ctx.row * 28 - height, width, height });
        ctx.row += rows; return;
    }
    throw Object.assign(new Error('公文版式不支持此内容块：' + block.type), { status: 422 });
}

function renderTable(ctx, block) {
    const columns = block.header || [];
    const headers = columns.map(column => typeof column === 'string' ? column : column.label || column.title || column.key || '');
    const rows = [headers, ...(block.rows || [])];
    const total = headers.length || rows[0]?.length || 1;
    const widths = block.widths_pct?.length === total ? block.widths_pct.map(value => ctx.box.contentWidth * value / 100) : Array.from({ length: total }, () => ctx.box.contentWidth / total);
    rows.forEach((row, rowIndex) => {
        const cells = Array.isArray(row) ? row : headers.map(header => row[header] ?? '');
        const role = rowIndex ? 'body' : 'heading1';
        const lines = cells.map((cell, index) => ctx.wrap(String(cell ?? ''), { role, width: widths[index] - 8 }));
        const count = Math.max(...lines.map(value => value.length), 1);
        if (count > format.LINES) throw Object.assign(new Error('表格单行超过一页，请拆分表格内容后重试'), { status: 422 });
        ctx.ensure(count);
        const startRow = ctx.row, top = ctx.box.contentTop - startRow * 28;
        let left = ctx.box.contentLeft;
        cells.forEach((_cell, column) => {
            ctx.row = startRow;
            ctx.flow(lines[column].map(line => line.text).join('\n'), { role, left: left - ctx.box.contentLeft + 4, right: ctx.box.contentRight - left - widths[column] + 4 });
            ctx.page.drawRectangle({ x: left, y: top - count * 28, width: widths[column], height: count * 28, borderWidth: 0.5, borderColor: BLACK });
            left += widths[column];
        });
        ctx.row = startRow + count;
    });
}

function renderTail(ctx, meta, { recordOnly = false, noRecord = false } = {}) {
    if (!recordOnly) {
        const box = signatureBox(meta, ctx.box.contentWidth, ctx.sources);
        if (meta.signoff || box.date) {
            const rows = meta.signoff ? ctx.wrap(meta.signoff, { width: ctx.box.contentWidth - box.left - box.rightInset }).length : 0;
            ctx.ensure(format.GAP_LINES.beforeSignature + rows + (box.date ? 1 : 0));
            ctx.gap(format.GAP_LINES.beforeSignature);
        }
        if (meta.signoff) ctx.flow(meta.signoff, { align: 'center', left: box.left, right: box.rightInset, keep: true });
        if (box.date) ctx.flow(box.date, { align: 'right', right: box.right });
    }
    if (!noRecord && (meta.cc || meta.printer || meta.printed_at)) {
        ctx.gap(1);
        const y = ctx.box.contentTop - ctx.row * 28 + 4;
        ctx.page.drawLine({ start: { x: ctx.box.contentLeft, y }, end: { x: ctx.box.contentRight, y }, thickness: 0.5, color: BLACK });
        if (meta.cc) ctx.flow('抄送：' + meta.cc);
        if (meta.printer) ctx.flow('印发机关：' + meta.printer);
        if (meta.printed_at) ctx.flow('印发日期：' + formatChineseDate(meta.printed_at));
    }
}

async function renderOfficialPdf(ir, options = {}, metadata) {
    const document = await PDFDocument.create();
    const sources = await loadOfficialFonts(), fonts = await embedOfficialFonts(document);
    const ctx = createContext(document, fonts, sources);
    renderHead(ctx, ir.meta);
    const parts = splitAttachments(ir);
    for (const [index, block] of parts.main.entries()) {
        if (block.style?.official_role === 'attachment_note' && block.style?.attachment_prefix?.startsWith('附件')) {
            let rows = format.GAP_LINES.beforeAttachment + (ir.meta.signoff || ir.meta.issued_at ? format.GAP_LINES.beforeSignature : 0)
                + (ir.meta.signoff ? 1 : 0) + (ir.meta.issued_at ? 1 : 0);
            for (const note of parts.main.slice(index).filter(item => item.style?.official_role === 'attachment_note')) {
                const prefix = note.style.attachment_prefix || '附件：';
                const padding = /^　+/.exec(prefix)?.[0] || '';
                rows += ctx.wrap(paragraphText(note).slice(padding.length), { indent: (2 + padding.length) * format.CHAR_PITCH_PT,
                    hanging: 2 * format.CHAR_PITCH_PT + ctx.measure(prefix, 'body', 16) }).length;
            }
            if (rows <= format.LINES) ctx.ensure(rows);
        }
        await renderBlock(ctx, block, options);
    }
    renderTail(ctx, ir.meta, { noRecord: !!parts.attachments.length });
    for (const block of parts.attachments) await renderBlock(ctx, block, options);
    if (parts.attachments.length) renderTail(ctx, ir.meta, { recordOnly: true });
    const mark = security[ir.meta.security_level] ? security[ir.meta.security_level] + (ir.meta.security_period || '') : '';
    for (const [index, page] of ctx.pages.entries()) {
        ctx.page = page; ctx.activeFont = null;
        const number = `— ${index + 1} —`, size = format.FOOTER_PT;
        ctx.text(number, ctx.box.contentLeft + (ctx.box.contentWidth - ctx.measure(number, 'footer', size)) / 2, layout.mmToPt(format.FOOTER_MM), 'footer', size);
        if (mark) ctx.text(mark, ctx.box.contentRight - ctx.measure(mark, 'heading1', 16), ctx.box.height - layout.mmToPt(format.HEADER_MM) - 16, 'heading1');
    }
    metadata(document, ir);
    return Buffer.from(await document.save({ useObjectStreams: false, addDefaultPage: false, updateFieldAppearances: false }));
}

module.exports = { renderOfficialPdf };
