'use strict';

const service = require('./presentation-service');
const { normalizePresentation, presentationError } = require('./presentation-schema');
const { applyTemplateLayoutLayers } = require('./presentation-template-reflow');
const { fitDesignPresentation } = require('./presentation-text-metrics');

async function designInfo(user) {
    const templates = await service.listPresentationTemplates(user);
    const catalog = await require('./presentation-template-catalog').list(user);
    const skill = require('./presentation-design-skill').getPresentationDesignSkill();
    return { skill: { manifest: skill.manifest, instructions: skill.instructions, source: skill.source }, templates: templates.map(template => ({
        id: template.id, name: template.name, version: template.version, description: template.description,
        layouts: (template.definition?.layouts || template.layouts || []).map(layout => ({ id: layout.id, name: layout.name }))
    })), catalog: { defaultMode: catalog.defaultMode, engine: catalog.engine, templates: catalog.templates.map(({ definition: _definition, masters: _masters, ...template }) => template) },
    text: '默认按材料自由设计；需要单位品牌或固定版式时再选择当前账号可用模板。目录区分在线编辑和完整制作方式，来源、版本和权限需保持。视觉复核按页执行，不得把未检查页面标为通过。' };
}

async function review(user, input, context = {}) {
    const presentation = await service.getPresentation(user, input.presentationId);
    if (!presentation) throw presentationError('演示文稿不存在或无权访问。', 404, 'PRESENTATION_NOT_FOUND');
    const assets = await service.resolvePresentationAssets(user, presentation.content, { presentationId: presentation.id });
    return require('./presentation-design-review').reviewPresentationSlide(presentation.content, user, {
        slideIndex: input.slideIndex, modelId: input.modelId || context.run?.chosen_model_id || context.run?.model_id,
        signal: context.signal, budget: context.budget, runId: context.run?.id, assetResolver: async ref => assets.get(ref) || null
    });
}

async function relayout(user, input, context = {}) {
    context.signal?.throwIfAborted();
    const presentation = await service.getPresentation(user, input.presentationId);
    if (!presentation) throw new Error('演示文稿不存在或无权访问。');
    const index = Number(input.slideIndex), slide = presentation.content.slides[index];
    if (!Number.isInteger(index) || !slide) throw new Error('重排页码不存在。');
    if (slide.review?.status === 'approved') throw new Error('页面已批准，请先解除批准后再重排。');
    const template = await service.resolveTemplateVersionForUser(user, presentation.template.id, presentation.template.version, { historical: true });
    const layout = template?.definition?.layouts?.find(layout => layout.id === input.layoutId);
    if (!layout || !String(layout.id).startsWith('design-')) throw new Error('请选择当前设计模板支持的语义布局。');
    const changed = applyTemplateLayoutLayers({ ...presentation.content, slides: [{ ...slide, layoutId: layout.id }] }, template, { reflow: true, normalizePresentation });
    const content = await fitDesignPresentation({ ...presentation.content, slides: presentation.content.slides.map((item, i) => i === index ? changed.slides[0] : item) });
    const saved = await service.savePresentationContent(user, presentation.id, { baseVersion: presentation.version, title: presentation.title, content, note: `重新排版第 ${index + 1} 页：${layout.name}` });
    return { presentationId: saved.id, version: saved.version, slideIndex: index, validation: saved.validation, text: '已保留内容与来源重新排版，请再次执行版式和视觉检查后导出。' };
}

module.exports = { designInfo, review, relayout };
