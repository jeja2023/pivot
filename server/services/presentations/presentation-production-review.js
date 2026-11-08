'use strict';

const crypto = require('node:crypto');
const { normalizePresentation, computePresentationDigest, collectPresentationAssetRefs } = require('./presentation-schema');
const { runRenderedPresentationQuality } = require('./presentation-render-quality');
const { renderPresentation, PRESENTATION_RENDERER_VERSION } = require('./presentation-renderer');
const { verifyPptxExport } = require('./presentation-export-verification');

const CHECKER_VERSION = 'ppt-production-2.0.0';
function currentVisualStatus(presentation, report) {
    const digest = computePresentationDigest(presentation);
    if (!report) return { status: 'not_checked', checkedSlides: 0 };
    if (report.checkedContentDigest !== digest) return { status: 'stale', checkedSlides: 0 };
    const reviews = (report.reviews || []).filter(review => review.contentDigest === digest && presentation.slides.some(slide => slide.id === review.slideId));
    const checked = new Set(reviews.filter(review => ['passed', 'warning', 'blocked'].includes(review.status)).map(review => review.slideId));
    const status = reviews.some(review => review.status === 'blocked') ? 'blocked' : checked.size !== presentation.slides.length ? 'incomplete' : reviews.some(review => review.status === 'warning') ? 'warning' : 'passed';
    return { status, checkedSlides: checked.size };
}

async function reviewPresentationProduction(input, options = {}, deps = {}) {
    options.signal?.throwIfAborted();
    const presentation = normalizePresentation(input), profile = presentation.metadata.productionProfile || {};
    const digest = computePresentationDigest(presentation);
    const render = deps.render || renderPresentation;
    const structural = await (deps.renderQuality || runRenderedPresentationQuality)(presentation, options);
    await options.onProgress?.({ completed: presentation.slides.length, total: presentation.slides.length, phase: 'package', message: '正在回读最终PPTX与嵌入数据' });
    const issues = structural.issues.map(issue => ({ ...issue, domain: 'content_layout' }));
    const refs = collectPresentationAssetRefs(presentation), assets = [];
    for (const ref of refs) {
        options.signal?.throwIfAborted();
        const asset = await options.assetResolver?.(ref);
        const available = Boolean(asset?.buffer?.length && asset?.mimeType);
        assets.push({ ref, status: available ? 'available' : 'missing' });
        if (!available) issues.push({ level: 'blocking', code: 'PRODUCTION_ASSET_MISSING', slideId: null, elementId: null, message: '文稿引用的素材或字体不可读取。', suggestion: '重新上传有权素材或恢复对应资源后再次检查。', domain: 'assets', assetRef: ref });
    }
    const minimum = Number(profile.minimumBodyFontPt || (profile.consumptionMode === 'reading' ? 12 : 18));
    for (const slide of presentation.slides) {
        for (const element of slide.elements.filter(item => item.visible && !item.locked)) {
            const size = ['text', 'table', 'diagram'].includes(element.type) ? element.style.fontSize * 0.75 : element.type === 'chart' ? element.options.labelFontSize * 0.75 : null;
            if (size !== null && size < minimum) issues.push({ level: 'warning', code: 'PRODUCTION_READABILITY', slideId: slide.id, elementId: element.id, domain: 'readability',
                message: `本页对象字号${Math.round(size * 10) / 10}pt，低于当前制作目标的${minimum}pt。`, suggestion: '增加对象尺寸、调整构图或拆页；阅读材料可单独设置适当的字号目标。' });
        }
    }
    let native, nativeBuffer = null, outputDigest = '';
    try {
        options.signal?.throwIfAborted();
        const output = await render(presentation, 'pptx', options);
        nativeBuffer = output.buffer; outputDigest = crypto.createHash('sha256').update(nativeBuffer).digest('hex');
        native = await (deps.inspectNative || verifyPptxExport)(output.buffer, presentation, options);
        issues.push(...native.issues.map(issue => ({ ...issue, level: 'blocking', domain: 'native_export' })));
    } catch (error) {
        options.signal?.throwIfAborted();
        native = { status: 'blocked', issues: [], message: '最终PPTX无法生成或回读。' };
        issues.push({ level: 'blocking', code: 'PRODUCTION_NATIVE_EXPORT_FAILED', slideId: null, elementId: null, domain: 'native_export', message: '最终PPTX无法完成原生对象核验。', suggestion: '检查素材、对象支持及导出问题后重试。' });
    }
    const visual = currentVisualStatus(presentation, options.visualReport);
    const office = deps.officeReview && nativeBuffer ? await deps.officeReview(nativeBuffer, presentation, { ...options, contentDigest: digest, outputDigest }) : { status: 'not_checked', engine: '', message: '尚未针对最终文件执行独立Office渲染。' };
    if (profile.requireVisualReview && !['passed', 'warning'].includes(visual.status)) issues.push({ level: 'blocking', code: 'PRODUCTION_VISUAL_PENDING', slideId: null, elementId: null, domain: 'visual', message: '制作要求中的整稿视觉复核尚未完成。', suggestion: '使用可用视觉模型复核当前版本的全部页面。' });
    const officeCurrent = office.contentDigest === digest && office.outputDigest === outputDigest && ['passed', 'warning'].includes(office.status);
    if (profile.requireOfficeReview && !officeCurrent) issues.push({ level: 'blocking', code: 'PRODUCTION_OFFICE_PENDING', slideId: null, elementId: null, domain: 'office', message: '制作要求中的最终Office渲染核验尚未完成。', suggestion: '在支持的Office环境核验当前文件，保留文件摘要及检查证据。' });
    options.signal?.throwIfAborted();
    const blocking = issues.filter(issue => issue.level === 'blocking').length, warnings = issues.filter(issue => issue.level === 'warning').length;
    return { checkerVersion: CHECKER_VERSION, rendererVersion: PRESENTATION_RENDERER_VERSION, contentDigest: digest, checkedAt: new Date().toISOString(),
        status: blocking ? 'blocked' : warnings ? 'warning' : 'passed', outputDigest,
        summary: { slides: presentation.slides.length, blocking, warnings, claims: structural.semantics?.summary?.claims || 0, assets: assets.length, minimumBodyFontPt: minimum },
        checks: { layout: { status: structural.status, textMeasurement: structural.textMeasurement }, evidence: structural.semantics, assets, native, visual, office },
        issues, scope: '结构、真实字体容量、证据片段/计算、素材和最终文件原生对象；视觉与Office核验分别列出实际完成状态。' };
}

module.exports = { currentVisualStatus, reviewPresentationProduction };
