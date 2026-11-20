'use strict';

const crypto = require('node:crypto');
const service = require('./presentation-service');
const { normalizePresentation, presentationError } = require('./presentation-schema');
const { compilePresentationProposal } = require('./presentation-ai');

function assertDraftId(id) {
    if (typeof id !== 'string' || !/^pptgen_[a-f0-9]{32}$/.test(id)) {
        throw presentationError('生成草稿标识无效。', 400, 'PRESENTATION_GENERATION_DRAFT_INVALID');
    }
}

function planFor(request, roster) {
    const { title, topic, outline, templateId, templateVersion, materials, aspectRatio, language, productionProfile, instruction } = request;
    const input = { title, topic, outline, templateId, templateVersion, materials, aspectRatio, language, productionProfile, instruction };
    return { digest: crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex'), input,
        templateDigest: request.template.snapshotDigest, roster: roster.map(page => ({ id: page.outlinePageId, title: page.title })), pages: {} };
}

async function lookup(user, id, required = false) {
    assertDraftId(id);
    const row = await service.getPresentationRow(user, id, { includeContent: true });
    if (row && Number(row.owner_user_id) === Number(user.id) && row.generation_json) return row;
    if (row || required) throw presentationError('生成草稿不存在或无权继续。', 404, 'PRESENTATION_GENERATION_DRAFT_MISSING');
    return null;
}

function selectPending(roster, generation) {
    return roster.filter(page => !Object.hasOwn(generation.pages, page.outlinePageId));
}

function mergeContent(content, compiled, generation) {
    const slides = content.slides.slice();
    const sources = new Map(content.sources.map(source => [source.id, source]));
    const positions = new Map(generation.roster.map(({ id }, index) => [id, index]));
    const owners = new Map(Object.entries(generation.pages).flatMap(([id, physical]) => physical.map(slideId => [slideId, id])));
    const pages = { ...generation.pages };
    for (const item of [...compiled].sort((a, b) => positions.get(a.id) - positions.get(b.id))) {
        if (Object.hasOwn(pages, item.id)) continue;
        const next = slides.findIndex(slide => positions.get(owners.get(slide.id)) > positions.get(item.id));
        slides.splice(next < 0 ? slides.length : next, 0, ...item.content.slides);
        pages[item.id] = item.content.slides.map(slide => slide.id);
        for (const slideId of pages[item.id]) owners.set(slideId, item.id);
        for (const source of item.content.sources) {
            const previous = sources.get(source.id);
            if (!previous) sources.set(source.id, source);
            else if (previous.digest === source.digest && source.evidenceSlices?.length) {
                const evidence = new Map([...(previous.evidenceSlices || []), ...source.evidenceSlices].map(slice => [slice.digest, slice]));
                sources.set(source.id, { ...previous, evidenceSlices: [...evidence.values()].slice(0, 48) });
            }
        }
    }
    return { content: { ...content, slides: slides.map((slide, index) => ({ ...slide, index })), sources: [...sources.values()] }, pages };
}

async function compileGenerationPage(page, confirmed, request, { productionProfile, signal }) {
    const title = request.title || request.outline.title;
    const outlinePosition = Number(page.id.split('_').at(-1)) - 1;
    const raw = { ...page, layout: page.layout || page.layoutId || (outlinePosition === 0 ? 'cover' : 'content') };
    const proposal = await compilePresentationProposal(JSON.stringify({ title, slides: [raw] }), {
        title, templateId: request.templateId, template: request.template, aspectRatio: request.aspectRatio,
        language: request.language, sources: request.materials, productionProfile, outlinePosition, signal
    });
    const known = new Set(request.materials.map(source => source.id));
    const sourceRefs = item => (item.sourceRefs || []).filter(ref => known.has(ref));
    const content = proposal.presentation;
    const dataLayout = String(confirmed.layoutHint || confirmed.layout || '').replace(/^design-/, '');
    const requiredType = dataLayout === 'image-focus' ? 'image' : dataLayout;
    if (['chart', 'table', 'image'].includes(requiredType)
        && !content.slides.some(slide => slide.elements.some(element => element.type === requiredType && element.visible && !element.locked))) {
        throw presentationError('当前页缺少已确认的图表、表格或图片。请根据原材料补齐对应内容。', 422, 'PRESENTATION_GENERATION_REQUIRED_DATA');
    }
    if (content.slides.some(slide => slide.elements.some(element => /^content_placeholder(?:_|$)/.test(element.id)))) {
        throw presentationError('页面未生成有效内容，请按已确认的大纲重新提供。', 422, 'PRESENTATION_GENERATION_EMPTY_PAGE');
    }
    content.slides = content.slides.map((slide, index) => ({
        ...slide, id: index === 0 ? page.id : page.id + '_part_' + (index + 1), sourceRefs: sourceRefs(slide),
        elements: slide.elements.map(element => ({ ...element, sourceRefs: sourceRefs(element) }))
    }));
    const warnings = (proposal.warnings || []).map(warning => warning.replace(/^原第 1 页/, '原第 ' + (outlinePosition + 1) + ' 页'));
    return { id: page.id, content, warnings };
}

async function saveGeneratedBatch(user, id, generation, compiled) {
    for (let attempt = 0; attempt < 3; attempt++) {
        const row = await lookup(user, id);
        const previous = row ? row.generation_json : generation;
        if (previous.digest !== generation.digest) throw presentationError('此草稿绑定了另一份已确认大纲。', 409, 'PRESENTATION_GENERATION_PLAN_CHANGED');
        if (row && String(row.template_digest) !== String(generation.templateDigest)) throw presentationError('草稿模板已变化，请使用原模板后补齐页面。', 409, 'PRESENTATION_GENERATION_TEMPLATE_CHANGED');
        if (compiled.every(item => Object.hasOwn(previous.pages, item.id))) return service.getPresentation(user, id);
        const current = row && service.toPublicPresentation(row, { includeContent: true });
        const merged = mergeContent(current?.content || { ...compiled[0].content, slides: [], sources: [] }, compiled, previous);
        const complete = Object.keys(merged.pages).length === previous.roster.length;
        const next = { ...previous, pages: merged.pages, input: complete ? null : previous.input };
        try {
            if (!current) return await service.createPresentation(user, { id, title: merged.content.title,
                templateId: generation.input.templateId, templateVersion: generation.input.templateVersion,
                content: merged.content, planApproval: { outline: generation.input.outline } }, { generation: next });
            return await service.savePresentationContent(user, id, { baseVersion: current.version, content: merged.content, note: '保存大纲生成页面' },
                { expectedContentDigest: current.contentDigest, generation: next });
        } catch (error) {
            if (!['PRESENTATION_VERSION_CONFLICT', 'PRESENTATION_STORY_STALE', 'PRESENTATION_GENERATION_DRAFT_EXISTS'].includes(error.code) || attempt === 2) throw error;
        }
    }
}

async function generationRequest(user, id) {
    const row = await lookup(user, id, true);
    const generation = row.generation_json;
    if (!generation.input) throw presentationError('大纲中的页面已全部生成。', 409, 'PRESENTATION_GENERATION_ALREADY_COMPLETE');
    if (String(row.template_digest) !== String(generation.templateDigest)) throw presentationError('草稿模板已变化，请使用原模板后补齐页面。', 409, 'PRESENTATION_GENERATION_TEMPLATE_CHANGED');
    return generation;
}

async function startPlan(user, id, request, roster) {
    const row = await lookup(user, id);
    const generation = planFor(request, roster);
    if (!row) return generation;
    if (row.generation_json.digest !== generation.digest) throw presentationError('此草稿绑定了另一份已确认大纲。', 409, 'PRESENTATION_GENERATION_PLAN_CHANGED');
    return row.generation_json;
}

function assembleGeneratedProposal(roster, outcome, title) {
    const { compiled, slides, warnings } = outcome;
    const generation = { roster: roster.map(page => ({ id: page.outlinePageId })), pages: {} };
    const { content } = mergeContent({ ...compiled[0].content, slides: [], sources: [] }, compiled, generation);
    if (content.slides.length > 60) throw presentationError('保持可读字号需要超过六十页，请分成多份文稿。', 422, 'PRESENTATION_DESIGN_PAGE_LIMIT');
    return { title, slides, warnings, presentation: normalizePresentation(content),
        plannedPages: roster.length, generatedPages: content.slides.length };
}

module.exports = { startPlan, generationRequest, selectPending, compileGenerationPage, saveGeneratedBatch, assembleGeneratedProposal, mergeContent };
