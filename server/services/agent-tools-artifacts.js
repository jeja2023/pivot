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
        {
            name: 'artifact.render',
            title: '文档渲染',
            description: '把结构化文档中间表示（Document IR）渲染为可下载的正式文档，支持公文版式 DOCX、CJK PDF、XLSX、HTML 与 Markdown。只产出渲染结果，不会写入用户磁盘。',
            capabilities: ['document.render'],
            input_schema: jsonSchema({
                artifactId: { type: 'integer', minimum: 1, description: '要挂载渲染结果的产物 ID。' },
                format: { type: 'string', enum: [...SUPPORTED_FORMATS], description: `渲染格式，可选 ${SUPPORTED_FORMATS.join('、')}。` },
                ir: {
                    type: 'object',
                    description: `Document IR 对象。必须包含 doc_type（${DOC_TYPES.join('、')}）、meta 与 blocks；图片只能引用 artifact-cas:// 地址，禁止内联 base64。`
                }
            }, ['artifactId', 'format', 'ir'])
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
    const stepId = String(context.stepId || '').trim();
    if (stepId) return stepId;
    const runId = String(context.run?.id || context.runId || '').trim();
    const stepIndex = Number.parseInt(context.stepIndex, 10);
    if (runId && Number.isSafeInteger(stepIndex)) return `${runId}:${stepIndex}`;
    return '';
}

async function executeArtifactTool(name, input = {}, user, context = {}) {
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
    if (!toolCallId) {
        const error = new Error('渲染工具缺少工具调用标识，审计链无法建立，已拒绝渲染。');
        error.status = 500;
        error.code = 'ARTIFACT_RENDITION_TOOL_CALL_REQUIRED';
        error.expose = true;
        throw error;
    }
    const result = await createRendition({
        user,
        artifactId: input.artifactId,
        runId: context.run?.id || context.runId || '',
        toolCallId,
        ir: input.ir,
        format: input.format
    });
    const rendition = result.rendition;
    return {
        renditionId: rendition.id,
        format: rendition.format,
        rendererVersion: rendition.renderer_version,
        mimeType: rendition.mime_type,
        byteSize: Number(rendition.byte_size),
        contentDigest: rendition.content_digest,
        irDigest: rendition.ir_digest,
        reused: result.reused === true,
        deliveryHint: '渲染完成。文档需要由用户在界面上点击下载或保存到本机，Agent 不能直接写入用户磁盘。',
        text: `已生成 ${rendition.format.toUpperCase()} 文档（${Number(rendition.byte_size)} 字节，摘要 ${String(rendition.content_digest).slice(0, 12)}…）。`
    };
}

const ARTIFACT_TOOL_NAMES = Object.freeze(['artifact.render', 'artifact.list_renditions']);

module.exports = {
    ARTIFACT_TOOL_NAMES,
    executeArtifactTool,
    getArtifactToolDefinitions,
    resolveToolCallId
};
