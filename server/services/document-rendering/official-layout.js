const format = require('../../../client/common/official-writing-format');

function widthOf(text, role, sources, size = format.BODY_PT) {
    return format.splitScripts(text).reduce((width, part) => {
        const face = sources[part.ascii ? (role === 'footer' ? 'footer' : 'ascii') : role].face;
        const advance = face.layout(part.text).glyphs.reduce((sum, glyph) => sum + glyph.advanceWidth, 0);
        const pitch = !part.ascii && role !== 'title' && role !== 'footer' && size === format.BODY_PT
            ? Array.from(part.text).length * (format.CHAR_PITCH_PT - size) : 0;
        return width + advance / face.unitsPerEm * size + pitch;
    }, 0);
}

function splitAttachments(ir) {
    const index = (ir.blocks || []).findIndex(block => block.style?.official_role === 'attachment_label');
    if (index < 0) return { main: ir.blocks || [], attachments: [] };
    const start = index > 0 && ir.blocks[index - 1].type === 'page_break' ? index - 1 : index;
    return { main: ir.blocks.slice(0, start), attachments: ir.blocks.slice(start) };
}

function signatureBox(meta, contentWidth, sources) {
    const date = require('./official-styles').formatChineseDate(meta.issued_at);
    const dateWidth = widthOf(date, 'body', sources);
    const right = 4 * format.CHAR_PITCH_PT;
    const center = contentWidth - right - dateWidth / 2;
    const half = Math.max(format.BODY_PT, Math.min(center, contentWidth - center));
    return { date, right, dateWidth, center, left: Math.max(0, center - half), rightInset: Math.max(0, contentWidth - center - half) };
}

module.exports = { signatureBox, splitAttachments, widthOf };
