'use strict';

const crypto = require('node:crypto');
const { buildTaskPresentation } = require('./presentations/presentation-task-content');
const semanticContract = require('./presentations/presentation-semantic-contract');

function schema(properties, required = []) { return { type: 'object', properties, required, additionalProperties: false }; }
const points = { type: 'array', maxItems: 8, items: { type: 'string', maxLength: 280 } };

function presentationToolDefinitions() {
    return [
        { name: 'presentation.from_analysis', title: '从分析图表生成汇报PPT', capabilities: ['document.render'], idempotent: true, side_effect: true, concurrency: 'write', cancellable: true,
            description: '用当前账号已生成的分析图表快照直接创建并导出可编辑汇报PPTX，保留图表数值、统计口径、来源版本和全部展示数据明细，无需重新抄写数值或调用模型生成页面。artifactId必须来自真实分析图表结果；数据或字段权限变化时需重新生成图表。支持柱形、折线、面积和饼图。版式阻断时返回源稿与具体缺口，不代表已交付。',
            input_schema: schema({ artifactId: { type: 'string', pattern: '^art_[A-Za-z0-9_]{1,100}$' }, title: { type: 'string', maxLength: 90 } }, ['artifactId']) },
        { name: 'presentation.master', title: '完整PPT制作引擎', capabilities: ['document.render', 'model.invoke'], idempotent: false, side_effect: true, concurrency: 'write', cancellable: true,
            description: '使用固定版本PPT Master完整工作流生成PPT、创建模板或保留原稿设计地编辑PPTX。action=start登记后台任务，status查询真实进度，respond提交用户对具体确认的实际答复，cancel停止。需要平台已准备运行镜像。返回任务登记不是制作完成；最终交付原生PPTX与项目源包，复杂对象不自动变成Pivot画布。材料必须来自已授权来源，不编造确认或事实。',
            input_schema: schema({ action: { type: 'string', enum: ['start', 'status', 'respond', 'cancel', 'resume'], default: 'start' }, taskId: { type: 'string' },
                operation: { type: 'string', enum: ['generate', 'create_template', 'edit_native'] }, profile: { type: 'string', enum: ['default', 'quick', 'beautify', 'image_to_pptx'] },
                title: { type: 'string', maxLength: 120 }, instruction: { type: 'string', maxLength: 16000 }, modelId: { type: 'string' }, pageCount: { type: 'integer', minimum: 1, maximum: 40 },
                presentationId: { type: 'string' }, sourceAssetId: { type: 'string' }, assetIds: { type: 'array', maxItems: 20, items: { type: 'string' } }, answer: { type: 'string', maxLength: 12000 },
                template: schema({ type: { type: 'string', enum: ['runtime', 'organization'] }, id: { type: 'string', maxLength: 96 }, version: { type: 'integer', minimum: 1 } }, ['type', 'id']),
                materials: { type: 'array', maxItems: 20, items: schema({ title: { type: 'string' }, text: { type: 'string', maxLength: 120000 } }, ['text']) },
                maxSteps: { type: 'integer', minimum: 5, maximum: 160 }, tokenBudget: { type: 'integer', minimum: 10000, maximum: 500000 } }) },
        { name: 'presentation.review_deck', title: '整稿检查与排版优化任务', capabilities: ['document.render', 'model.invoke'], idempotent: true, side_effect: true, concurrency: 'write', cancellable: true,
            description: '启动整稿视觉复核、保留内容的排版优化或mode=production交付检查。production核对事实证据/计算、真实字体、素材和最终PPTX原生对象/嵌入工作簿，不调用模型。后台返回taskId后用operation=status查询，operation=cancel停止。layout只提出排版建议，visual_repair复核建议稿。原稿变化或所属Agent停止时终止。结构/原生检查不等于视觉或Office通过。',
            input_schema: schema({ presentationId: { type: 'string' }, operation: { type: 'string', enum: ['start', 'status', 'cancel'], default: 'start' },
                mode: { type: 'string', enum: ['visual', 'layout', 'visual_repair', 'production'], default: 'visual' }, taskId: { type: 'string' }, modelId: { type: 'string' } }, ['presentationId']) },
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
                productionProfile: semanticContract.productionProfile,
                sourceMessageId: { type: 'integer', minimum: 1, description: '仅使用当前任务已授权的用户来源消息编号；省略时读取创建任务的原始消息。' },
                slides: { type: 'array', minItems: 1, maxItems: 60, items: schema({ title: { type: 'string', maxLength: 90 },
                    sourceRefs: semanticContract.sourceRefs, intent: semanticContract.intent, claims: semanticContract.claims, diagram: semanticContract.diagram,
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
    if (name === 'presentation.master') {
        const tasks = require('./presentations/master/tasks'), action = input.action || 'start';
        if (action !== 'start' && !input.taskId) throw new Error('请提供完整制作任务的taskId。');
        const task = action === 'start' ? await tasks.start(user, { ...input, modelId: input.modelId || String(context.run?.chosen_model_id || context.run?.model_id || '') }, context)
            : action === 'respond' ? await tasks.respond(user, input.taskId, input.answer) : action === 'cancel' ? await tasks.cancel(user, input.taskId) : action === 'resume' ? await tasks.resume(user, input.taskId, input) : await tasks.get(user, input.taskId);
        if (!task) throw new Error('制作任务不存在或无权访问。');
        return { ...task, taskId: task.id, text: task.result?.message || task.progress?.message || '任务已登记，请查询实际制作结果。' };
    }
    if (name === 'presentation.review_deck') {
        const tasks = require('./presentations/presentation-quality-tasks');
        const operation = input.operation || 'start';
        if (operation === 'cancel' && !input.taskId) throw new Error('停止整稿检查时请提供明确的taskId。');
        const task = operation === 'start' ? await tasks.createQualityTask(user, { ...input, modelId: input.modelId || context.run?.chosen_model_id || context.run?.model_id || '' }, context)
            : operation === 'cancel' ? await tasks.cancelQualityTask(user, input.presentationId, input.taskId) : await tasks.getQualityTask(user, input.presentationId, input.taskId);
        if (!task) throw new Error('整稿检查任务不存在或无权访问。');
        return { ...task, taskId: task.id, text: task.result?.message || '检查任务已登记，请查询进度，不能把登记成功当作检查通过。' };
    }
    if (name === 'presentation.design_info') return require('./presentations/presentation-design-actions').designInfo(user);
    if (name === 'presentation.review') return require('./presentations/presentation-design-actions').review(user, input, context);
    if (name === 'presentation.relayout') return require('./presentations/presentation-design-actions').relayout(user, input, context);
    const service = require('./presentations/presentation-service');
    const runId = context.run?.id || context.runId;
    context.signal?.throwIfAborted();
    let presentation;
    let designWarnings = [];
    if (name === 'presentation.from_analysis') {
        const requestKey = crypto.createHash('sha256').update(`${user.id}:${runId || context.stepId || context.toolCallId || ''}:${JSON.stringify(input)}`).digest('hex');
        presentation = (await require('./presentations/presentation-analysis-report').createAnalysisReport(user, { ...input, requestKey }, { signal: context.signal })).presentation;
        context.signal?.throwIfAborted();
    } else if (name === 'presentation.create') {
        const identity = `${user.id}:${runId || context.stepId || context.toolCallId || ''}:${JSON.stringify(input)}`;
        const id = 'taskppt_' + crypto.createHash('sha256').update(identity).digest('hex').slice(0, 40);
        let sources = [];
        if (runId && context.run?.session_id) {
            const source = await require('../repositories/chat-conversation-turns').readTaskSource(runId, user.id, input.sourceMessageId);
            if (!source || source.requestedMessageFallback) throw new Error('PPT 来源不属于当前任务或已不可访问，请重新选择材料。');
            sources = [{ id: 'task_source', title: '用户上传材料及任务要求', type: 'user_message', locator: `message:${source.id}`,
                digest: crypto.createHash('sha256').update(source.content).digest('hex'), text: source.content, excerpt: source.content.slice(0, 2400), excerptTruncated: source.content.length > 2400 }];
        }
        presentation = await service.getPresentation(user, id);
        if (!presentation) {
            const template = await service.resolveTemplateForUser(user, input.templateId || 'executive-clean');
            if (!template) throw new Error('所选 PPT 模板不存在或无权使用。');
            const design = template.definition?.layouts?.some(layout => String(layout.id).startsWith('design-'))
                ? await require('./presentations/presentation-design-compiler').compileDesignPlan(input, template, sources, { signal: context.signal }) : null;
            const content = design ? design.presentation : buildTaskPresentation(input, template, sources);
            designWarnings = design?.warnings || [];
            presentation = await service.createPresentation(user, { id, title: input.title, templateId: template.id, templateVersion: template.version,
                content, tags: ['聊天生成'] });
        }
    } else presentation = await service.getPresentation(user, input.presentationId);
    if (!presentation) throw new Error('演示文稿不存在或无权导出，请先生成源稿。');
    const assets = await service.resolvePresentationAssets(user, presentation.content, { presentationId: presentation.id });
    const validation = await require('./presentations/presentation-render-quality').runRenderedPresentationQuality(presentation.content, { assetResolver: async ref => assets.get(ref) || null });
    if (validation.status === 'blocked') return { status: 'needs_revision', presentationId: presentation.id, slideCount: presentation.content.slides.length,
        validation, text: 'PPT 源稿已保留，但版式检查未通过，尚未生成文件。请按具体问题修改页面内容后重试，或到 PPT 制作应用编辑。' };
    const format = ['presentation.create', 'presentation.from_analysis'].includes(name) ? 'pptx' : input.format || 'pptx';
    const result = await service.createPresentationExport(user, presentation.id, format, { slideIndex: input.slideIndex || 0, showSourceRefs: false },
        { runId, signal: context.signal, toolCallId: context.stepId || context.toolCallId });
    const rendition = result.rendition;
    return { status: 'completed', presentationId: presentation.id, artifactId: rendition.artifact_id, renditionId: rendition.id,
        format, slideCount: presentation.content.slides.length, ...(format === 'svg' || format === 'png' ? { slideIndex: input.slideIndex || 0 } : {}),
        byteSize: Number(rendition.byte_size), contentDigest: rendition.content_digest, validation, designWarnings, exportChecks: result.exportChecks || null,
        text: `已生成 ${format.toUpperCase()} 文件${format === 'pptx' || format === 'pdf' ? `（共 ${presentation.content.slides.length} 页）` : `（第 ${(input.slideIndex || 0) + 1} 页）`}，已挂载为任务结果，可下载或保存到本机；源稿可在 PPT 制作应用继续编辑。` };
}

module.exports = { presentationToolDefinitions, executePresentationTool };
