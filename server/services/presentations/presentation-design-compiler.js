'use strict';

const { buildDesignPresentation } = require('./presentation-design-content');
const { normalizePresentation, presentationError } = require('./presentation-schema');
const { applyTemplateLayoutLayers } = require('./presentation-template-reflow');
const { createTextMetrics, fitDesignPresentation } = require('./presentation-text-metrics');

const DATA_LAYOUTS = new Set(['cover', 'section', 'quote', 'key-metrics', 'chart', 'table', 'image-focus']);

function splitSemanticPage(slide) {
    const kind = String(slide.layout || 'content').replace(/^design-/, '');
    if (DATA_LAYOUTS.has(kind)) return null;
    const arrays = ['points', 'left', 'right'].filter(key => Array.isArray(slide[key]) && slide[key].length);
    const length = Math.max(0, ...arrays.map(key => slide[key].length));
    if (length < 2) return null;
    const middle = Math.ceil(length / 2);
    return [0, 1].map(part => ({ ...slide, ...Object.fromEntries(arrays.map(key => [key, slide[key].slice(part ? middle : 0, part ? undefined : middle)])),
        speakerNotes: part ? '' : slide.speakerNotes }));
}

async function compileDesignPlan(input, template, sources = [], options = {}) {
    if (!Array.isArray(input.slides) || !input.slides.length || input.slides.length > 60) throw presentationError('请提供一至六十页完整内容。');
    if (typeof input.title !== 'string' || !input.title.trim() || input.slides.some(slide => !slide || typeof slide !== 'object' || Array.isArray(slide))) throw presentationError('请提供有效标题与逐页内容对象。');
    const metrics = await createTextMetrics({ theme: (template.definition || template).theme }, options);
    const slides = [], warnings = [], plannedPages = input.slides.length;
    let last;
    for (let index = 0; index < input.slides.length; index++) {
        const pending = [{ slide: { ...input.slides[index], layout: input.slides[index].layout || input.slides[index].layoutId || (index ? 'content' : 'cover') }, depth: 0 }];
        let parts = 0;
        while (pending.length) {
            options.signal?.throwIfAborted();
            const current = pending.shift();
            let content = buildDesignPresentation({ title: input.title, slides: [current.slide] }, template, sources);
            if (options.aspectRatio === '4:3') content = { ...content, aspectRatio: '4:3', width: 960 };
            content = applyTemplateLayoutLayers(content, template, { reflow: true, normalizePresentation });
            content = await fitDesignPresentation(content, options);
            const overflow = content.slides[0].elements.some(element => element.type === 'text' && !element.locked && element.visible
                && metrics.lines(element).length * element.style.fontSize * element.style.lineHeight + element.style.padding * 2 > element.height + 2);
            if (overflow) {
                const split = options.allowSplit !== false && current.depth < 4 ? splitSemanticPage(current.slide) : null;
                if (!split) throw presentationError(`第 ${index + 1} 页正文无法在可读字号下完整显示，请拆分长要点或选择更合适的布局。`, 422, 'PRESENTATION_DESIGN_CAPACITY');
                pending.unshift(...split.map(slide => ({ slide, depth: current.depth + 1 })));
                continue;
            }
            if (slides.length >= 60) throw presentationError('保持可读字号需要超过六十页，请分成多份文稿。', 422, 'PRESENTATION_DESIGN_PAGE_LIMIT');
            parts++;
            slides.push({ ...content.slides[0], id: `slide_${index + 1}_part_${parts}`, index: slides.length });
            last = content;
        }
        if (parts > 1) warnings.push(`原第 ${index + 1} 页为完整保留内容与可读字号，已拆为 ${parts} 页。`);
    }
    return { presentation: normalizePresentation({ ...last, title: input.title, slides, metadata: { ...last.metadata, language: options.language || last.metadata.language, designSkillVersion: '1.1.0', aiGenerated: true } }),
        warnings, plannedPages, generatedPages: slides.length };
}

module.exports = { compileDesignPlan };
