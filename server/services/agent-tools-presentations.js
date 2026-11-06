'use strict';

const crypto = require('node:crypto');
const { buildTaskPresentation } = require('./presentations/presentation-task-content');

function schema(properties, required = []) { return { type: 'object', properties, required, additionalProperties: false }; }
const points = { type: 'array', maxItems: 8, items: { type: 'string', maxLength: 280 } };

function presentationToolDefinitions() {
    return [
        { name: 'presentation.design_info', title: '读取 PPT 设计技能与模板', capabilities: ['document.render'], idempotent: true,
            description: '读取内置中文演示设计技能，以及当前账号可用模板和语义布局。制作完整PPT前先阅读；模板清单不代表任意布局能容纳任意正文。', input_schema: schema({}) },
        { name: 'presentation.review', title: '视觉复核 PPT 指定页', capabilities: ['document.render', 'model.invoke'], idempotent: false, cancellable: true,
            description: '使用当前账号可用且支持图像输入的模型，对指定页面的真实渲染图检查截断、遮挡、对比和焦点，返回具体元素与建议。一次只检查一页，不能将其他页面宣称已通过；不可用时明确返回unavailable。',
            input_schema: schema({ presentationId: { type: 'string' }, slideIndex: { type: 'integer', minimum: 0 }, modelId: { type: 'string' } }, ['presentationId', 'slideIndex']) },
        { name: 'presentation.relayout', title: '按语义布局重排 PPT 单页', capabilities: ['document.render'], idempotent: true, side_effect: true, concurrency: 'write',
            description: '按当前设计模板中已有layoutId重排一页，保留文字、数值、来源与锁定元素，保存新版本。拒绝已批准页面。重排后重新检查，最多两轮，不可把换布局当作已完成视觉复核。',
            input_schema: schema({ presentationId: { type: 'string' }, slideIndex: { type: 'integer', minimum: 0 }, layoutId: { type: 'string' } }, ['presentationId', 'slideIndex', 'layoutId']) },
        { name: 'presentation.create', title: '生成完整 PPTX 演示文稿', capabilities: ['document.render'], idempotent: true, side_effect: true, concurrency: 'write', cancellable: true,
            description: '读取用户文档并规划整稿后，一次提交完整 slides 内容，生成可编辑 PPT 源稿并导出包含全部页面的 PPTX 文件，自动挂载当前任务结果。先用 chat.read_source 完整读取附件；标题、要点、讲稿和数值必须依据材料。安排封面、必要目录/章节、内容页和总结；不要只传大纲或一页示例。支持正文、双栏、表格、图表，不需要代码执行或联网。返回 presentationId 后可通过 presentation.export 导出 PDF 或指定页面 SVG/PNG。版式阻断会返回具体问题，修正 slides 后重新生成，不能反复提交同一失败输入。',
            input_schema: schema({ title: { type: 'string', maxLength: 160 }, templateId: { type: 'string', default: 'executive-clean' },
                sourceMessageId: { type: 'integer', minimum: 1, description: '仅使用当前任务已授权的用户来源消息编号；省略时读取创建任务的原始消息。' },
                slides: { type: 'array', minItems: 1, maxItems: 60, items: schema({ title: { type: 'string', maxLength: 90 },
                    layout: { type: 'string', enum: ['cover', 'content', 'two-column', 'section', 'summary', 'table', 'chart', 'agenda', 'executive-summary', 'comparison', 'three-card', 'key-metrics', 'timeline', 'process', 'roadmap', 'risk-actions', 'image-focus', 'quote'] }, points, left: points, right: points,
                    metrics: { type: 'array', minItems: 1, maxItems: 3, items: schema({ value: { type: 'string', maxLength: 24 }, label: { type: 'string', maxLength: 160 } }, ['value', 'label']) },
                    image: schema({ assetRef: { type: 'string', pattern: '^artifact-cas://' }, caption: { type: 'string', maxLength: 500 } }, ['assetRef']),
                    speakerNotes: { type: 'string', maxLength: 4000 }, table: schema({ columns: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 6 }, rows: { type: 'array', maxItems: 8, items: { type: 'array', items: { type: 'string' } } } }, ['columns', 'rows']),
                    chart: schema({ type: { type: 'string', enum: ['bar', 'line', 'area', 'pie'] }, columns: { type: 'array', items: { type: 'string' } }, rows: { type: 'array', items: { type: 'array' } } }, ['type', 'columns', 'rows']) }, ['title']) }
            }, ['title', 'slides']) },
        { name: 'presentation.export', title: '导出 PPTX、PDF 或页面 SVG', capabilities: ['document.render'], idempotent: true, side_effect: true, concurrency: 'write', cancellable: true,
            description: '导出 presentation.create 或 PPT 制作应用中已有的演示文稿。pptx/pdf 包含全部页面；svg/png 只导出 slideIndex 指定的一页（从 0 开始），不得将单页图片当作完整 PPTX。无需用户提供图片 CAS 对象。文件通过当前任务结果卡下载或保存，不能自动写入本机。',
            input_schema: schema({ presentationId: { type: 'string' }, format: { type: 'string', enum: ['pptx', 'pdf', 'svg', 'png'], default: 'pptx' },
                slideIndex: { type: 'integer', minimum: 0, description: 'SVG/PNG 的页面编号，从 0 开始。' } }, ['presentationId']) }
    ];
}

async function executePresentationTool(name, input, user, context = {}) {
    if (name === 'presentation.design_info') return require('./presentations/presentation-design-actions').designInfo(user);
    if (name === 'presentation.review') return require('./presentations/presentation-design-actions').review(user, input, context);
    if (name === 'presentation.relayout') return require('./presentations/presentation-design-actions').relayout(user, input, context);
    const service = require('./presentations/presentation-service');
    const runId = context.run?.id || context.runId;
    context.signal?.throwIfAborted();
    let presentation;
    if (name === 'presentation.create') {
        const identity = `${user.id}:${runId || context.stepId || context.toolCallId || ''}:${JSON.stringify(input)}`;
        const id = 'taskppt_' + crypto.createHash('sha256').update(identity).digest('hex').slice(0, 40);
        let sources = [];
        if (runId && context.run?.session_id) {
            const source = await require('../repositories/chat-conversation-turns').readTaskSource(runId, user.id, input.sourceMessageId);
            if (!source || source.requestedMessageFallback) throw new Error('PPT 来源不属于当前任务或已不可访问，请重新选择材料。');
            sources = [{ id: 'task_source', title: '用户上传材料及任务要求', type: 'user_message', locator: `message:${source.id}`,
                digest: crypto.createHash('sha256').update(source.content).digest('hex'), excerpt: source.content.slice(0, 2400), excerptTruncated: source.content.length > 2400 }];
        }
        presentation = await service.getPresentation(user, id);
        if (!presentation) {
            const template = await service.resolveTemplateForUser(user, input.templateId || 'executive-clean');
            if (!template) throw new Error('所选 PPT 模板不存在或无权使用。');
            const content = buildTaskPresentation(input, template, sources);
            presentation = await service.createPresentation(user, { id, title: input.title, templateId: template.id, templateVersion: template.version,
                content, tags: ['聊天生成'] });
        }
    } else presentation = await service.getPresentation(user, input.presentationId);
    if (!presentation) throw new Error('演示文稿不存在或无权导出，请先生成源稿。');
    const assets = await service.resolvePresentationAssets(user, presentation.content, { presentationId: presentation.id });
    const validation = await require('./presentations/presentation-render-quality').runRenderedPresentationQuality(presentation.content, { assetResolver: async ref => assets.get(ref) || null });
    if (validation.status === 'blocked') return { status: 'needs_revision', presentationId: presentation.id, slideCount: presentation.content.slides.length,
        validation, text: 'PPT 源稿已保留，但版式检查未通过，尚未生成文件。请按具体问题修改页面内容后重试，或到 PPT 制作应用编辑。' };
    const format = name === 'presentation.create' ? 'pptx' : input.format || 'pptx';
    const result = await service.createPresentationExport(user, presentation.id, format, { slideIndex: input.slideIndex || 0, showSourceRefs: false },
        { runId, signal: context.signal, toolCallId: context.stepId || context.toolCallId });
    const rendition = result.rendition;
    return { status: 'completed', presentationId: presentation.id, artifactId: rendition.artifact_id, renditionId: rendition.id,
        format, slideCount: presentation.content.slides.length, ...(format === 'svg' || format === 'png' ? { slideIndex: input.slideIndex || 0 } : {}),
        byteSize: Number(rendition.byte_size), contentDigest: rendition.content_digest, validation,
        text: `已生成 ${format.toUpperCase()} 文件${format === 'pptx' || format === 'pdf' ? `（共 ${presentation.content.slides.length} 页）` : `（第 ${(input.slideIndex || 0) + 1} 页）`}，已挂载为任务结果，可下载或保存到本机；源稿可在 PPT 制作应用继续编辑。` };
}

module.exports = { presentationToolDefinitions, executePresentationTool };
