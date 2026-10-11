'use strict';

const sharp = require('sharp');
const { normalizePresentation } = require('./presentation-schema');
const { renderPresentation } = require('./presentation-renderer');
const { runPresentationValidation } = require('./presentation-validation');

function makeIssue(level, code, slideId, message, suggestion = '') {
    return { level, code, slideId, elementId: null, message, suggestion };
}

async function runRenderedPresentationQuality(input, { assetResolver } = {}) {
    const presentation = normalizePresentation(input);
    const structural = runPresentationValidation(presentation);
    const renderIssues = [];
    for (const slide of presentation.slides) {
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
        issues
    };
}

module.exports = { runRenderedPresentationQuality };
