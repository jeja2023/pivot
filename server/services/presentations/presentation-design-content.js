'use strict';

const { normalizePresentation, presentationError } = require('./presentation-schema');

function text(value, limit = 1200) {
    const result = String(value ?? '').trim();
    if (result.length > limit) throw presentationError('页面文字过长，请拆成更多页；正文不会截断。', 422, 'PRESENTATION_TASK_CONTENT_DENSE');
    return result;
}
function pointText(value) {
    if (!Array.isArray(value) || value.length > 8) throw presentationError('每组要点最多八条，请拆页。');
    return value.map(value => text(value, 280)).filter(Boolean).join('\n\n');
}

function buildDesignPresentation(input, template, sources = []) {
    const definition = template.definition || template;
    const theme = definition.theme, sourceIds = new Set(sources.map(source => source.id));
    const slides = input.slides.map((slide, index) => {
        if (slide.sourceRefs !== undefined && !Array.isArray(slide.sourceRefs)) throw presentationError('逐页来源必须是标识数组。');
        const refs = slide.sourceRefs === undefined ? sources.length === 1 ? [sources[0].id] : [] : [...new Set(slide.sourceRefs)];
        if (refs.some(ref => !sourceIds.has(ref))) throw presentationError('页面引用了不存在的材料来源。', 400, 'PRESENTATION_SOURCE_REF_INVALID');
        if (!text(slide.title, 90)) throw presentationError('页面标题不能为空。');
        let kind = String(slide.layout || (index ? 'content' : 'cover')).replace(/^design-/, '');
        if (kind === 'content') kind = 'title-content';
        const layout = definition.layouts.find(layout => layout.id === `design-${kind}`);
        if (!layout) throw presentationError('当前设计模板不支持此布局，请读取模板目录后重试。');
        const elements = [];
        const add = (role, content) => {
            const slot = layout.placeholders.find(slot => slot.role === role && slot.kind === 'text');
            if (!slot || !content) return;
            const paragraphs = layout.editorial && ['body', 'evidence', 'left', 'right'].includes(role) && layout.editorial.kind !== 'section' ? String(content).split('\n\n') : [content];
            paragraphs.forEach((paragraph, part) => elements.push({ id: part ? `${role}_${part + 1}` : role, type: 'text', x: slot.x, y: slot.y, width: slot.width, height: slot.height, sourceRefs: refs,
                content: { text: text(paragraph, 2400) }, style: { ...slot.style, fontFamily: theme.fonts.body } }));
        };
        const points = slide.points || [];
        if (!Array.isArray(points) || points.length > 8) throw presentationError('每页要点最多八条，请拆页。');
        add(kind === 'quote' ? 'quote' : 'title', text(slide.title, 90));
        const bodySlots = layout.placeholders.filter(slot => slot.kind === 'text' && !['title', 'quote'].includes(slot.role));
        if (slide.diagram) {
            if (!['process', 'timeline', 'roadmap'].includes(kind)) throw presentationError('图示页面请选择流程、时间线或路线图布局。');
            if (points.length || slide.left?.length || slide.right?.length) throw presentationError('图示节点请填写到 diagram 中，详细说明保留到讲稿，避免遗漏额外要点。');
            elements.push({ id: 'diagram', type: 'diagram', diagramType: slide.diagram.type, items: slide.diagram.items, graph: slide.diagram.graph,
                x: 88, y: 224, width: 1112, height: 400, sourceRefs: refs, style: { fill: theme.colors.background, stroke: theme.colors.primary, textColor: theme.colors.text, fontSize: 24 } });
        } else if (['chart', 'table', 'image-focus'].includes(kind)) {
            const role = kind === 'image-focus' ? 'image' : kind;
            const slot = layout.placeholders.find(slot => slot.kind === role);
            let element;
            if (kind === 'chart' && slide.chart) element = { type: 'chart', chartType: slide.chart.type, data: { columns: slide.chart.columns, rows: slide.chart.rows }, options: { showLegend: slide.chart.columns.length > 2, showLabels: true, labelFontSize: 24, colors: theme.chartPalette } };
            if (kind === 'table' && slide.table) element = { type: 'table', columns: slide.table.columns, rows: slide.table.rows, style: { fontSize: 24, headerFill: theme.colors.primary } };
            if (kind === 'image-focus' && slide.image?.assetRef) element = { type: 'image', assetRef: slide.image.assetRef, alt: text(slide.image.caption, 500), fit: 'contain' };
            if (!element) throw presentationError('图表、表格或图片页面缺少真实数据或受控素材，请补充后重试。');
            elements.push({ ...element, id: role, x: slot.x, y: slot.y, width: slot.width, height: slot.height, sourceRefs: refs });
            add('insight', pointText(points) || text(slide.image?.caption, 500));
        } else if (kind === 'key-metrics') {
            const metrics = slide.metrics;
            if (!Array.isArray(metrics) || !metrics.length || metrics.length > 3) throw presentationError('指标页须提供一至三个可核实的 value、label 指标。');
            metrics.forEach((metric, i) => { add(`value${i + 1}`, text(metric.value, 24)); add(`label${i + 1}`, text(metric.label, 160)); });
        } else if (['two-column', 'comparison', 'risk-actions', 'executive-summary'].includes(kind)) {
            const split = Math.ceil(points.length / 2);
            const left = slide.left || points.slice(0, split), right = slide.right || points.slice(split);
            add(bodySlots[0]?.role, pointText(left)); add(bodySlots[1]?.role, pointText(right));
        } else {
            if (points.length && bodySlots.length) {
                const count = Math.ceil(points.length / bodySlots.length);
                bodySlots.forEach((slot, i) => add(slot.role, pointText(points.slice(i * count, (i + 1) * count))));
            }
        }
        if (!elements.length || (kind !== 'cover' && kind !== 'section' && elements.length < 2)) throw presentationError('页面缺少标题或正文，请补充完整内容。');
        return { id: `slide_${index + 1}`, type: ['cover', 'section'].includes(kind) ? kind : 'content', layoutId: layout.id, elements,
            speakerNotes: text(slide.speakerNotes, 4000), sourceRefs: refs,
            ...(slide.intent === undefined ? {} : { intent: slide.intent }), ...(slide.claims === undefined ? {} : { claims: slide.claims }) };
    });
    return normalizePresentation({ title: text(input.title, 160), aspectRatio: '16:9', theme, sources, slides,
        template: { id: template.id, version: template.version, snapshotDigest: template.snapshotDigest },
        metadata: { designSkillVersion: '2.0.0', aiGenerated: true, ...(input.productionProfile ? { productionProfile: input.productionProfile } : {}) } });
}

module.exports = { buildDesignPresentation };
