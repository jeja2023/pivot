/**
 * server/services/agent-tools-artifacts.js
 * 文档渲染类内置工具（artifact.render / artifact.list_renditions）
 *
 * 落地方案 v1.2 §7.1、§7.4 第 1 条：
 * 1. Agent 侧只产出 Document IR，二进制文件一律由服务端 Renderer 渲染；
 * 2. Agent 最多产出 Rendition，**不能**创建交付意图 —— 交付必须由用户在前端点击
 *    「下载」或「保存到本机」触发，这是阻断「模型自行往用户磁盘写文件」的根本机制；
 * 3. tool_call_id 由运行时的确定性步骤标识提供，缺失即渲染失败而非静默（风险 R10）。
 */
const { DOC_TYPES } = require('./document-ir');
const { SUPPORTED_FORMATS } = require('./document-rendering');

function jsonSchema(properties = {}, required = []) {
    return { type: 'object', properties, required, additionalProperties: false };
}

function getArtifactToolDefinitions() {
    return [
        ...require('./agent-tools-presentations').presentationToolDefinitions(),
        { name: 'diagram.render_svg', title: '生成 SVG 图形或页面图片', capabilities: ['viz.render'], idempotent: true, side_effect: true, concurrency: 'write',
            description: '将完整 SVG 源码安全保存为可下载 SVG/PNG 结果，内部完成受控图片登记，无需用户提供 CAS 图片。适合单张结构图、示意图；完整可编辑 PPT 应使用 presentation.create，已有 PPT 页面应使用 presentation.export。禁止脚本、外链、内联图片和动态内容。',
            input_schema: jsonSchema({ svg: { type: 'string', maxLength: 1000000 }, title: { type: 'string', maxLength: 160 }, format: { type: 'string', enum: ['svg', 'png'], default: 'svg' } }, ['svg']) },
        {
            name: 'presentation.create_from_artifact',
            title: '从产物创建演示文稿',
            description: '把当前用户有权访问的文本产物转换为版本化、可编辑的 PPT 演示文稿。只创建受控源稿和后续渲染能力，不会下载、发送或写入本机文件。',
            capabilities: ['document.render'],
            input_schema: jsonSchema({
                artifactId: { type: 'integer', minimum: 1, description: '要转换的文本产物 ID。' },
                title: { type: 'string', maxLength: 160, description: '可选演示文稿标题。' },
                templateId: { type: 'string', maxLength: 96, default: 'business-blue', description: 'Pivot 受控模板 ID。' },
                tags: { type: 'array', items: { type: 'string' }, maxItems: 12 }
            }, ['artifactId'])
        },
        {
            name: 'artifact.render',
            title: '文档渲染 (Word / PDF / Excel)',
            description: '把 Document IR 渲染为 Word、PDF、Excel、HTML 或 Markdown。生成完整可编辑 PPTX 请用 presentation.create，导出现有 PPT 用 presentation.export；从 SVG 源码生成图形请用 diagram.render_svg。此工具的 svg/png 仅转换已有 image 块中的受控图片，不能把段落和标题直接变成图片。结果自动挂载，用户可下载或保存到本机。',
            capabilities: ['document.render'],
            input_schema: jsonSchema({
                artifactId: { type: 'integer', minimum: 1, description: '可选。要挂载渲染结果的产物 ID；若未提供，将自动为当前任务创建文档产物。' },
                format: { type: 'string', enum: [...SUPPORTED_FORMATS], description: `渲染格式，可选 ${SUPPORTED_FORMATS.join('、')}。生成 Word 文档请填 docx。` },
                ir: {
                    type: 'object',
                    description: `Document IR 对象。必须包含 doc_type（${DOC_TYPES.join('、')}，旅行攻略/方案/报告请用 report）、meta（必须包含 title）与 blocks（包含 paragraph, heading, list, table 等内容块）；图片只能引用 artifact-cas:// 地址，禁止内联 base64。`
                }
            }, ['format', 'ir'])
        },
        {
            name: 'artifact.list_renditions',
            title: '渲染结果列表',
            description: '列出某个产物已有的渲染结果及其格式、摘要与大小，用于判断是否需要重新渲染。',
            capabilities: ['artifact.read'],
            input_schema: jsonSchema({
                artifactId: { type: 'integer', minimum: 1, description: '产物 ID。' }
            }, ['artifactId'])
        }
    ];
}

/** 从运行时上下文推导确定性的工具调用标识，与 agent_tool_calls.step_id 一致。 */
function resolveToolCallId(context = {}) {
    const stepId = String(context.stepId || context.toolCallId || context.callId || '').trim();
    if (stepId) return stepId;
    const runId = String(context.run?.id || context.runId || '').trim();
    const stepIndex = Number.parseInt(context.stepIndex, 10);
    if (runId && Number.isSafeInteger(stepIndex)) return `${runId}:${stepIndex}`;
    if (runId) return `${runId}:artifact:${Date.now()}`;
    return `artifact:${Date.now()}`;
}

async function executeArtifactTool(name, input = {}, user, context = {}) {
    if (['presentation.create', 'presentation.export', 'presentation.design_info', 'presentation.review', 'presentation.relayout', 'presentation.review_deck'].includes(name)) return require('./agent-tools-presentations').executePresentationTool(name, input, user, context);
    if (name === 'diagram.render_svg') return require('./tool-result-artifacts').materializeToolArtifact({ structuredContent: { pivotArtifact: {
        kind: 'diagram', title: input.title, svg: input.svg, format: input.format || 'svg' } } }, user, context);
    if (name === 'presentation.create_from_artifact') {
        const { createPresentationFromArtifact } = require('./presentations/presentation-service');
        const presentation = await createPresentationFromArtifact(user, input.artifactId, { title: input.title, templateId: input.templateId, tags: input.tags });
        return { presentationId: presentation.id, artifactId: presentation.artifactId, title: presentation.title, version: presentation.version, deliveryHint: '演示文稿源稿已创建。用户可在 PPT 制作应用中继续编辑并选择导出格式。', text: '已从产物创建可编辑 PPT：' + presentation.title };
    }
    const { createRendition, listRenditionsForArtifact } = require('./agent-artifact-renditions');
    if (name === 'artifact.list_renditions') {
        const rows = await listRenditionsForArtifact(input.artifactId, user);
        if (!rows) {
            const error = new Error('产物不存在或无权访问。');
            error.status = 404;
            error.expose = true;
            throw error;
        }
        return { renditions: rows, count: rows.length, text: `已有 ${rows.length} 个渲染结果。` };
    }
    const toolCallId = resolveToolCallId(context);
    let artifactId = Number.parseInt(input.artifactId, 10);
    const { getAgentArtifactForUser, createOrUpdateRunArtifact, createStandaloneArtifact } = require('./agent-artifacts');
    let artifact = Number.isSafeInteger(artifactId) && artifactId > 0 ? await getAgentArtifactForUser(artifactId, user) : null;
    if (!artifact) {
        const title = String(input.ir?.meta?.title || input.title || '任务结果文档').trim().slice(0, 120);
        const runId = String(context.run?.id || context.runId || '').trim();
        if (runId) {
            artifact = await createOrUpdateRunArtifact({
                runId,
                user,
                type: 'document',
                title,
                content: JSON.stringify(input.ir || {}),
                note: `由 ${name} 自动生成`
            });
        } else {
            artifact = await createStandaloneArtifact(user, {
                type: 'document',
                title,
                content: JSON.stringify(input.ir || {}),
                note: `由 ${name} 自动生成`
            });
        }
    }
    const resolvedArtifactId = artifact.id;
    const result = await createRendition({
        user,
        artifactId: resolvedArtifactId,
        runId: context.run?.id || context.runId || artifact.run_id || '',
        toolCallId,
        ir: input.ir,
        format: input.format
    });
    const rendition = result.rendition;
    return {
        renditionId: rendition.id,
        artifactId: resolvedArtifactId,
        format: rendition.format,
        rendererVersion: rendition.renderer_version,
        mimeType: rendition.mime_type,
        byteSize: Number(rendition.byte_size),
        contentDigest: rendition.content_digest,
        irDigest: rendition.ir_digest,
        reused: result.reused === true,
        deliveryHint: '文档渲染完成，已挂载为任务结果文件。用户可在对话界面中直接下载或一键保存到本地授权目录。',
        text: `已生成 ${rendition.format.toUpperCase()} 文档（${Number(rendition.byte_size)} 字节，文件已挂载为任务结果文件，用户可直接下载或保存到本地）。`
    };
}

const ARTIFACT_TOOL_NAMES = Object.freeze(['presentation.design_info', 'presentation.review', 'presentation.relayout', 'presentation.review_deck', 'presentation.create', 'presentation.export', 'presentation.create_from_artifact', 'diagram.render_svg', 'artifact.render', 'artifact.list_renditions']);

module.exports = {
    ARTIFACT_TOOL_NAMES,
    executeArtifactTool,
    getArtifactToolDefinitions,
    resolveToolCallId
};
