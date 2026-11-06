'use strict';

const { normalizePresentation, presentationError } = require('./presentation-schema');

function checkedText(value, max, label, required = false) {
    const text = String(value || '').trim();
    if ((required && !text) || text.length > max) throw presentationError(`${label}${text ? '过长，请拆分内容后重试' : '不能为空'}。`);
    return text;
}

function textElement(id, text, x, y, width, height, fontSize, theme, sourceRefs, heading = false) {
    return { id, type: 'text', x, y, width, height, sourceRefs, content: { text },
        style: { fontFamily: heading ? theme.fonts.heading : theme.fonts.body, fontSize, fontWeight: heading ? 700 : 400,
            color: theme.colors.text, lineHeight: 1.3, padding: 0, verticalAlign: 'top' } };
}

function pointElements(points, column, theme, refs, prefix, merge = false) {
    if (!Array.isArray(points) || points.length > 8) throw presentationError('每栏要点须为数组，最多 8 条，请拆成更多页面。');
    if (!points.length) return [];
    if (merge) {
        const text = points.map(point => checkedText(point, 280, '页面要点', true)).join('\n\n');
        return [textElement(`${prefix}_body`, text, column.x, column.y, column.width, column.height, 24, theme, refs)];
    }
    const gap = 14, slot = (column.height - gap * (points.length - 1)) / points.length;
    return points.map((point, index) => {
        const text = checkedText(point, 280, '页面要点', true);
        let fontSize = points.length <= 4 ? 26 : 22;
        const lines = size => text.split('\n').reduce((total, line) => total + Math.max(1, Math.ceil(line.length / Math.max(4, Math.floor(column.width / (size * 0.58))))), 0);
        while (fontSize > 20 && lines(fontSize) * fontSize * 1.3 > slot) fontSize--;
        if (lines(fontSize) * fontSize * 1.3 > slot) throw presentationError('页面文字放不下，请减少本页要点或拆成更多页；不会截断正文。', 422, 'PRESENTATION_TASK_CONTENT_DENSE');
        return textElement(`${prefix}_${index + 1}`, text, column.x, column.y + index * (slot + gap), column.width, slot, fontSize, theme, refs);
    });
}

function buildTaskPresentation(input, template, sources = []) {
    if (!Array.isArray(input.slides) || !input.slides.length || input.slides.length > 60) throw presentationError('请提供完整的逐页内容，页数为 1 至 60 页。');
    const title = checkedText(input.title, 160, 'PPT 标题', true);
    if ((template.definition || template).layouts?.some(layout => String(layout.id).startsWith('design-'))) return require('./presentation-design-content').buildDesignPresentation(input, template, sources);
    const theme = (template.definition || template).theme;
    const sourceRefs = sources.map(source => source.id);
    const slides = input.slides.map((slide, index) => {
        const layout = slide.layout || (index === 0 ? 'cover' : 'content');
        if (!['cover', 'content', 'two-column', 'section', 'summary', 'table', 'chart'].includes(layout)) throw presentationError('页面布局无效。');
        const heading = checkedText(slide.title, 90, '页面标题', true);
        const points = slide.points || [];
        const isCover = layout === 'cover' || layout === 'section';
        const elements = [textElement('title', heading, 64, isCover ? 145 : 52, 1152, isCover ? 150 : 95, isCover ? 42 : 32, theme, sourceRefs, true)];
        if (layout === 'two-column') {
            elements.push(...pointElements(slide.left || points.slice(0, Math.ceil(points.length / 2)), { x: 72, y: 180, width: 540, height: 420 }, theme, sourceRefs, 'left', true),
                ...pointElements(slide.right || points.slice(Math.ceil(points.length / 2)), { x: 668, y: 180, width: 540, height: 420 }, theme, sourceRefs, 'right', true));
        } else if (layout === 'summary') {
            const split = Math.ceil(points.length / 2);
            elements.push(...pointElements(points.slice(0, split), { x: 115, y: 160, width: 1050, height: 185 }, theme, sourceRefs, 'summary', true),
                ...pointElements(points.slice(split), { x: 115, y: 420, width: 1050, height: 195 }, theme, sourceRefs, 'next', true));
        } else if (layout === 'table') {
            if (!Array.isArray(slide.table?.columns) || !slide.table.columns.length || slide.table.columns.length > 6 || !Array.isArray(slide.table.rows) || !slide.table.rows.length || slide.table.rows.length > 8
                || slide.table.rows.some(row => !Array.isArray(row) || row.length !== slide.table.columns.length)) throw presentationError('表格页须提供 1 至 6 列、1 至 8 行且列数一致的真实数据。');
            elements.push({ id: 'table', type: 'table', x: 100, y: 180, width: 1080, height: Math.min(420, (slide.table.rows.length + 1) * 64), sourceRefs,
                columns: slide.table.columns.map(value => checkedText(value, 40, '表头', true)), rows: slide.table.rows.map(row => row.map(value => checkedText(value, 100, '单元格'))),
                style: { fontFamily: theme.fonts.body, fontSize: 20 } });
        } else if (layout === 'chart') {
            if (!slide.chart || !['bar', 'line', 'area', 'pie'].includes(slide.chart.type)) throw presentationError('图表页须提供图表类型和可核实的数值数据。');
            elements.push({ id: 'chart', type: 'chart', x: 72, y: 180, width: 1136, height: 420, sourceRefs,
                chartType: slide.chart.type, data: { columns: slide.chart.columns, rows: slide.chart.rows }, options: { showLegend: true } });
        } else elements.push(...pointElements(points, { x: isCover ? 96 : 72, y: isCover ? 340 : 180, width: isCover ? 1088 : 1136, height: isCover ? 245 : 420 }, theme, sourceRefs, 'point'));
        if (!isCover && elements.length < 2) throw presentationError(`第 ${index + 1} 页没有正文内容，请补充后再生成。`);
        return { id: `slide_${index + 1}`, type: isCover ? layout : 'content', layoutId: layout === 'content' || layout === 'table' || layout === 'chart' ? 'title-content' : layout,
            elements, speakerNotes: checkedText(slide.speakerNotes, 4000, '讲稿备注'), sourceRefs };
    });
    return normalizePresentation({ title, aspectRatio: '16:9', theme, template: { id: template.id, version: template.version, snapshotDigest: template.snapshotDigest },
        sources, slides, metadata: { generatedBy: 'presentation.create' } });
}

module.exports = { buildTaskPresentation };
