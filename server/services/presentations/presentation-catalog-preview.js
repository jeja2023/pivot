'use strict';

const { runtimeTemplate } = require('./presentation-template-catalog');
const { buildStyleExample } = require('./presentation-style-examples');
const { defaultPresentation, normalizePresentation, presentationError } = require('./presentation-schema');
const { applyTemplateLayoutLayers, applyTemplateBrandControls } = require('./presentation-template-reflow');
const { renderPresentation } = require('./presentation-renderer');

const labels = {
    subtitle: '汇报人 · 部门', section: '第一部分 · 项目进展', body: '目前已完成阶段目标。\n下一步将核对数据并落实后续安排。',
    left: '现状与发现', right: '下一步安排', card1: '进展概览', card2: '问题与风险', card3: '应对措施',
    quote: '「明确目标，再选择合适的方法。」', attribution: '引述来源', summary: '总结与成果回顾', nextSteps: '落实行动计划'
};
const visualLabels = { image: '图片', chart: '图表', table: '表格', diagram: '示意图', media: '媒体' };
const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(value);

function buildLayoutExample(template, requestedLayout) {
    const layouts = template.definition?.layouts || [];
    const cover = layouts.find(layout => layout.legacyLayoutId === 'cover' || /封面|cover/i.test(layout.name)) || layouts[0];
    const layout = requestedLayout ? layouts.find(item => item.id === requestedLayout) : cover;
    if (requestedLayout && !layout) throw presentationError('当前模板版本没有此版式。', 404, 'PRESENTATION_LAYOUT_NOT_FOUND');

    let content = defaultPresentation({ title: '项目进展汇报', template, aspectRatio: template.aspectRatio });
    const slide = content.slides[0];
    if (layout) {
        slide.type = layout === cover ? 'cover' : 'content';
        slide.layoutId = layout.id;
        slide.elements = (layout.placeholders || []).flatMap((slot, index) => {
            const bounds = { x: slot.x, y: slot.y, width: slot.width, height: slot.height };
            if (slot.kind === 'text') return [{ ...bounds, id: 'sample_text_' + index, type: 'text',
                content: { text: slot.role === 'title' ? (layout === cover ? '项目进展汇报' : '阶段目标与进展') : labels[slot.role] || '示例内容' },
                style: slot.style }];
            const label = visualLabels[slot.kind];
            if (!label) return [];
            return [{ ...bounds, id: 'sample_frame_' + index, type: 'shape', shapeType: 'rect',
                style: { fill: '', stroke: content.theme.colors.secondary, strokeWidth: 1 } },
            { ...bounds, id: 'sample_label_' + index, type: 'text', content: { text: label },
                style: { color: content.theme.colors.text, fontSize: 16, align: 'center', verticalAlign: 'middle' } }];
        });
    }
    content = applyTemplateLayoutLayers(content, template);
    return normalizePresentation(applyTemplateBrandControls(content, template));
}

async function preview(user, id, { version, layout } = {}) {
    if (!validId(id) || typeof version !== 'string' || !/^\d{1,9}(?:\.\d{1,5}\.\d{1,5})?$/.test(version)
        || (layout !== undefined && !validId(layout))) {
        throw presentationError('模板预览参数无效。', 400, 'PRESENTATION_TEMPLATE_PREVIEW_INVALID');
    }
    const style = runtimeTemplate(id);
    if (style && style.version === version) {
        const example = !layout && buildStyleExample(id);
        if (example) return renderPresentation(example, 'png');
    }
    const service = require('./presentation-service');
    const template = /^\d+$/.test(version) && await service.resolveTemplateForUser(user, id);
    if (!template || template.id !== id || String(template.version) !== version) {
        throw presentationError('该模板版本不可预览。请重新打开模板库。', 404, 'PRESENTATION_TEMPLATE_NOT_FOUND');
    }
    const content = buildLayoutExample(template, layout);
    let remainingBytes = 12 * 1024 * 1024;
    const images = new Map();
    return renderPresentation(content, 'png', {
        async assetResolver(ref) {
            if (!images.has(ref)) {
                if (images.size >= 12 || remainingBytes <= 0) return null;
                const result = await service.getPresentationAssetByRef(user, ref);
                const asset = result && /^image\/(?:png|jpeg|webp|gif)$/.test(result.asset.mimeType) && result.buffer.length <= remainingBytes
                    ? { buffer: result.buffer, mimeType: result.asset.mimeType } : null;
                if (asset) remainingBytes -= asset.buffer.length;
                images.set(ref, asset);
            }
            return images.get(ref);
        }
    });
}

module.exports = { preview };
