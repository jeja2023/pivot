'use strict';

const { performance } = require('node:perf_hooks');
const { defaultPresentation } = require('../server/services/presentations/presentation-schema');
const { getBuiltInTemplate } = require('../server/services/presentations/presentation-templates');
const { renderPresentation } = require('../server/services/presentations/presentation-renderer');

function percentile(samples, value) {
    if (!samples.length) return 0; const sorted = [...samples].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * value) - 1))];
}

function buildPresentation(slides = 20) {
    const presentation = defaultPresentation({ title: 'PPT 性能基线', template: getBuiltInTemplate('business-blue') });
    const seed = JSON.parse(JSON.stringify(presentation.slides[0]));
    presentation.slides = Array.from({ length: slides }, (_, index) => ({ ...JSON.parse(JSON.stringify(seed)), id: 'benchmark_slide_' + index, index, elements: JSON.parse(JSON.stringify(seed.elements)).map((element, elementIndex) => ({ ...element, id: element.id + '_' + index + '_' + elementIndex, ...(element.content ? { content: { ...element.content, text: (element.content.text || '') + ' ' + index } } : {}) })) }));
    return presentation;
}

async function benchmarkPresentationRendering(options = {}) {
    const iterations = Math.max(1, Math.min(Number.parseInt(options.iterations, 10) || 10, 100));
    const slides = Math.max(1, Math.min(Number.parseInt(options.slides, 10) || 20, 100));
    const formats = Array.isArray(options.formats) ? options.formats : ['pdf', 'pptx'];
    const samples = Object.fromEntries(formats.map(format => [format, []])); const bytes = {}; const presentation = buildPresentation(slides);
    for (let index = 0; index < iterations; index += 1) {
        for (const format of formats) { const start = performance.now(); const rendered = await renderPresentation(presentation, format); samples[format].push(performance.now() - start); bytes[format] = rendered.buffer.length; }
    }
    const result = { slides, iterations, formats: {} };
    formats.forEach(format => { const values = samples[format]; result.formats[format] = { minMs: Math.round(Math.min(...values)), avgMs: Math.round(values.reduce((sum, item) => sum + item, 0) / values.length), p95Ms: Math.round(percentile(values, 0.95)), maxMs: Math.round(Math.max(...values)), bytes: bytes[format] }; });
    return result;
}

async function main() {
    const result = await benchmarkPresentationRendering({ slides: process.env.PIVOT_PRESENTATION_BENCHMARK_SLIDES || 20, iterations: process.env.PIVOT_PRESENTATION_BENCHMARK_ITERATIONS || 10 });
    const failures = []; if ((result.formats.pdf?.p95Ms || 0) > 15000) failures.push('PDF P95 超过 15 秒'); if ((result.formats.pptx?.p95Ms || 0) > 30000) failures.push('PPTX P95 超过 30 秒');
    process.stdout.write(JSON.stringify(result, null, 2) + '\n'); if (failures.length) { process.stderr.write(failures.join('；') + '\n'); process.exitCode = 1; }
}

if (require.main === module) main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
module.exports = { benchmarkPresentationRendering, buildPresentation, percentile };
