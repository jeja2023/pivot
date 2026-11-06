'use strict';

const { canonicalJson } = require('../canonical-json');
const { normalizePresentation } = require('./presentation-schema');
const { applyTemplateLayoutLayers } = require('./presentation-template-reflow');
const { fitDesignPresentation } = require('./presentation-text-metrics');
const { runRenderedPresentationQuality } = require('./presentation-render-quality');

function payload(slide) {
    return canonicalJson({ notes: slide.speakerNotes, refs: slide.sourceRefs, review: slide.review,
        elements: slide.elements.filter(element => !element.id.startsWith('pivotTemplate_')).map(element => {
            const { x: _x, y: _y, width: _width, height: _height, rotation: _rotation, zIndex: _zIndex, style: _style, ...rest } = element;
            return element.locked ? element : rest;
        }).sort((a, b) => a.id.localeCompare(b.id)) });
}
function score(report) {
    return report.issues.reduce((sum, issue) => sum + (issue.level === 'blocking' ? 100 : issue.code === 'ELEMENT_OVERLAP' || issue.code === 'TEXT_TOO_SMALL' ? 10 : 0), 0);
}

async function optimizeDesignLayout(input, template, options = {}) {
    let content = normalizePresentation(input);
    const changedSlides = [], skippedSlides = [];
    const layouts = (template.definition || template).layouts || [];
    for (let index = 0; index < content.slides.length; index++) {
        options.signal?.throwIfAborted();
        const original = content.slides[index];
        if (original.review?.status === 'approved' || !original.layoutId.startsWith('design-')) { skippedSlides.push(original.id); continue; }
        const expected = payload(original);
        let best = original;
        let bestScore = score(await runRenderedPresentationQuality({ ...content, slides: [original] }, options));
        if (!bestScore) continue;
        const types = new Set(original.elements.filter(element => element.visible && !element.locked).map(element => element.type));
        const candidates = types.has('chart') ? ['design-chart'] : types.has('table') ? ['design-table'] : types.has('image') ? ['design-image-focus']
            : /^design-(?:cover|section|key-metrics|quote)$/.test(original.layoutId) ? [original.layoutId]
                : [original.layoutId, 'design-title-content', 'design-two-column', 'design-executive-summary', 'design-process'];
        for (let round = 0; round < 2 && bestScore > 0; round++) {
            let improved = false;
            for (const layoutId of [...new Set(candidates)]) {
                options.signal?.throwIfAborted();
                if (!layouts.some(layout => layout.id === layoutId)) continue;
                let candidate = applyTemplateLayoutLayers({ ...content, slides: [{ ...best, layoutId }] }, template, { reflow: true, normalizePresentation });
                candidate = await fitDesignPresentation(candidate, options);
                if (payload(candidate.slides[0]) !== expected) continue;
                const candidateScore = score(await runRenderedPresentationQuality(candidate, options));
                if (candidateScore < bestScore) { best = candidate.slides[0]; bestScore = candidateScore; improved = true; }
            }
            if (!improved) break;
        }
        if (canonicalJson(best) !== canonicalJson(original)) {
            content = { ...content, slides: content.slides.map((slide, i) => i === index ? best : slide) };
            changedSlides.push(original.id);
        }
        await options.onProgress?.({ completed: index + 1, total: content.slides.length, phase: 'layout' });
    }
    return { content: normalizePresentation(content), changedSlides, skippedSlides,
        validation: await runRenderedPresentationQuality(content, options) };
}

module.exports = { optimizeDesignLayout };
