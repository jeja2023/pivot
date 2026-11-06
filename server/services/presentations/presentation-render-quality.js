'use strict';

const sharp = require('sharp');
const { normalizePresentation } = require('./presentation-schema');
const { renderPresentation } = require('./presentation-renderer');
const { runPresentationValidation } = require('./presentation-validation');

function makeIssue(level, code, slideId, message, suggestion = '') {
    return { level, code, slideId, elementId: null, message, suggestion };
}

async function runRenderedPresentationQuality(input, { assetResolver, signal } = {}) {
    const presentation = normalizePresentation(input);
    const structural = runPresentationValidation(presentation);
    const renderIssues = [];
    const metrics = await require('./presentation-text-metrics').createTextMetrics(presentation, { assetResolver });
    for (const slide of presentation.slides) {
        signal?.throwIfAborted();
        if (String(slide.layoutId).startsWith('design-')) for (const element of slide.elements.filter(element => element.type === 'text' && element.visible)) {
            const height = metrics.lines(element).length * element.style.fontSize * element.style.lineHeight + element.style.padding * 2;
            if (height > element.height + 2) renderIssues.push({ ...makeIssue('blocking', 'MEASURED_TEXT_OVERFLOW', slide.id, '实际字体测量发现文字放不下。', '请调整布局、拆页或将详细内容放入讲稿，不要继续缩小正文。'), elementId: element.id });
        }
        try {
            const output = await renderPresentation(presentation, 'png', { slideIndex: slide.index, assetResolver });
            const image = await sharp(output.buffer).metadata();
            if (image.width !== presentation.width || image.height !== presentation.height) {
                renderIssues.push(makeIssue('blocking', 'RENDER_DIMENSION_MISMATCH', slide.id, '渲染页面尺寸与文稿比例不一致。', '请检查页面比例、素材和导出渲染配置。'));
            }
            if (image.format !== 'png' || !Number(image.size || output.buffer.length)) {
                renderIssues.push(makeIssue('blocking', 'RENDER_OUTPUT_INVALID', slide.id, '页面渲染结果无效。', '请检查页面内容和素材后重试。'));
            }
        } catch (_) {
            renderIssues.push(makeIssue('blocking', 'RENDER_FAILED', slide.id, '页面无法完成渲染。', '请检查受控素材、页面对象和字体后重试。'));
        }
    }
    const issues = [...structural.issues, ...renderIssues];
    const blocking = issues.filter(issue => issue.level === 'blocking').length;
    const warnings = issues.filter(issue => issue.level === 'warning').length;
    return {
        status: blocking ? 'blocked' : warnings ? 'warning' : 'passed',
        summary: { slides: presentation.slides.length, renderedSlides: presentation.slides.length - renderIssues.filter(issue => issue.code === 'RENDER_FAILED').length, blocking, warnings, info: issues.length - blocking - warnings },
        issues,
        textMeasurement: metrics.measured ? 'controlled_font' : 'estimated',
        visualReview: { status: 'not_requested', message: '已完成结构与渲染检查，尚未进行视觉模型复核。' }
    };
}

module.exports = { runRenderedPresentationQuality };
