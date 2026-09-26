const { query } = require('../db/client');
const { searchUserSessions } = require('./agent-session-search');
const { getSystemHealthSnapshot } = require('./system-health');
const { getModelEndpointRuntimeStatus } = require('./model-runtime');
const { debugRetrieveContext } = require('./rag-index');
const { queryKnowledgeGraph } = require('./knowledge-graph');
const { callModelText, recordAgentModelUsage } = require('./agent-model');
const { getRunnableModelForUserAsync, getUserRunnableModelsAsync } = require('./models');
const { parsePositiveInt } = require('../number');
const { buildChartSpec, buildTableBlock } = require('./builtin-mcp');
const { isSuperAdmin } = require('../permissions');
const { executeContentReview } = require('./agent-content-review');
const { fitMessagesToContextBudget, getModelContextBudget } = require('./context-budget');
const { normalizeContextConfig } = require('./agent-validators');
const { executeAgentHttp } = require('./agent-http-tool');
const { executeAgentWebSearch, isAgentWebSearchAvailable } = require('./agent-web-search');
const {
    executeAgentImageGeneration,
    executeAgentTextToSpeech,
    isAgentImageGenerationAvailable,
    isAgentTextToSpeechAvailable
} = require('./agent-media-generation');
const { isAgentBrowserRuntimeAvailable } = require('./agent-browser');
const {
    normalizeJsonSchema,
    schemaHasRules,
    validateJsonSchemaDefinition,
    validateValueAgainstSchema
} = require('./agent-dag-contracts');
const {
    executeReportCompose,
    executeWorkflowCondition,
    executeWorkflowDelay,
    executeWorkflowEmbedAudio,
    executeWorkflowEmbedImage,
    executeWorkflowEmbedPage,
    executeWorkflowEmbedVideo,
    executeWorkflowEmbedCode,
    executeWorkflowForeach,
    executeWorkflowIteration,
    executeWorkflowInput,
    executeWorkflowNotify,
    executeWorkflowTemplate,
    executeWorkflowLinkCard,
    executeWorkflowOutput,
    getWorkflowPresentationToolDefinitions,
    renderWorkflowValue
} = require('./agent-tools-workflow-nodes');
const { ARTIFACT_TOOL_NAMES, executeArtifactTool, getArtifactToolDefinitions } = require('./agent-tools-artifacts');
const { createAgentDelegateExecutor } = require('./agent-tools-delegation');
const { executeToolDiscoveryMeta, getToolDiscoveryDefinitions } = require('./agent-tools-discovery');
const { executeTerminalRuntime, isTerminalRuntimeAvailable, terminalToolDefinition } = require('./agent-tools-terminal');
const { executeAgentBrowserSessionAction } = require('./agent-browser-sessions');
const {
    executeAgentCancel,
    executeAgentJoin,
    executeAgentMessage,
    executeAgentSpawn,
    executeAgentWait,
    getAgentCollaborationToolDefinitions
} = require('./agent-tools-collaboration');

const MAX_TEXT = 12000;
// 动态代码只能在独立的桌面 Worker / 受控执行平面中运行。
// Node 的 vm.runInNewContext 不是安全沙箱：恶意代码可以通过构造器链重新取得宿主
// 对象。因此所有直接调用 executeBuiltInTool 的入口（MCP、OpenAI、工具测试 API）
// 都必须在这里统一拒绝，不能依赖调用方自行传入 autonomous 标志。
const IN_PROCESS_DYNAMIC_CODE_TOOLS = new Set(['agent.code', 'workflow.foreach', 'terminal.runtime']);

function assertDynamicCodeExecutionIsSandboxed(toolName, context = {}) {
    const name = String(toolName || '').trim();
    if (!IN_PROCESS_DYNAMIC_CODE_TOOLS.has(name)) return;
    if (name === 'workflow.foreach' && context.sandboxExecution === true && context.approvalGranted === true) return;
    if (name === 'terminal.runtime' && context.approvalGranted === true) return;
    const error = new Error('动态代码只能在独立 Worker 沙箱中执行，当前服务端执行入口已拒绝。');
    error.code = 'AGENT_SANDBOX_REQUIRED';
    error.category = 'policy';
    error.status = 403;
    throw error;
}

function clampText(value, max = MAX_TEXT) {
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    if (!text) return '';
    return text.length > max ? `${text.slice(0, max)}\n...[truncated]` : text;
}

function resolveWorkflowMaxTokens(input, modelCfg, fallback = 1200, hardMax = 32768) {
    const requested = parsePositiveInt(input?.maxTokens ?? input?.max_tokens, fallback, 1, hardMax);
    const configured = parsePositiveInt(modelCfg?.max_tokens, 0, { min: 1, max: hardMax });
    const requestedWithModelCap = configured > 0 ? Math.min(requested, configured) : requested;
    const budget = getModelContextBudget(modelCfg, { maxOutputTokens: requestedWithModelCap });
    return budget.unbounded
        ? requestedWithModelCap
        : Math.max(1, Math.min(requestedWithModelCap, budget.reservedOutputTokens));
}

function assertAdmin(user) {
    if (!isSuperAdmin(user)) {
        const err = new Error('只有 admin 权限层级可以使用此工具。');
        err.status = 403;
        throw err;
    }
}

function asJsonSchema(properties = {}, required = []) {
    return {
        type: 'object',
        properties,
        required,
        additionalProperties: false
    };
}

function getBuiltInToolDefinitions(user) {
    const adminOnly = isSuperAdmin(user);
    const definitions = [
        {
            name: 'agent.llm',
            title: '大模型节点',
            description: '在工作流中调用指定大模型，对上游结果进行分析、改写、抽取或生成内容。',
            input_schema: asJsonSchema({
                prompt: { type: 'string', description: '用户提示词，支持引用 {{goal}}、{{inputs.*}} 和 {{nodes.*.output}}。' },
                systemPrompt: { type: 'string', description: '可选系统提示词，用于限定角色、边界和输出口径。' },
                model: { type: 'string', description: '必填模型 ID 或 model_name；工作流运行会从 LLM 节点读取模型。' },
                maxSteps: { type: 'integer', minimum: 1, maximum: 80, default: 20, description: '本工作流运行允许的最大步骤数。' },
                temperature: { type: 'number', minimum: 0, maximum: 2, default: 0.2 },
                maxTokens: { type: 'integer', minimum: 1, maximum: 32768, default: 1200 },
                responseFormat: { type: 'string', enum: ['markdown', 'text', 'json'], default: 'markdown' }
            }, ['prompt', 'model'])
        },
        {
            name: 'agent.content_review',
            title: '富文本内容校对',
            description: '清洗数据库富文本记录，按模型上下文预算逐条分块校对，并生成结构化结果和完整任务产物。支持传入 records, rows 或 data。',
            input_schema: asJsonSchema({
                records: { description: '待校对记录，支持记录数组、structuredContent、rows、data 或对应的上游变量引用。' },
                rows: { description: '待校对记录数组（records 别名）。' },
                data: { description: '待校对记录数组（records 别名）。' },
                model: { type: 'string', description: '模型 ID 或 model_name；留空时使用当前任务模型。' },
                idField: { type: 'string', default: 'id', maxLength: 128, description: '记录唯一标识字段。' },
                titleField: { type: 'string', default: 'title', maxLength: 128, description: '记录标题字段。' },
                contentField: { type: 'string', default: 'content', maxLength: 128, description: '包含 HTML、富文本或普通正文的字段。' },
                instructions: { type: 'string', maxLength: 6000, description: '业务术语、禁用表达和补充校对规则。' },
                maxRecords: { type: 'integer', minimum: 1, maximum: 200, default: 50, description: '单次最多处理的记录数。' },
                chunkTokens: { type: 'integer', minimum: 512, maximum: 12000, default: 3000, description: '长正文分块的目标输入 Token 数。' },
                overlapTokens: { type: 'integer', minimum: 0, maximum: 256, default: 80, description: '相邻正文分块保留的上下文 Token 数。' },
                maxTokens: { type: 'integer', minimum: 512, maximum: 8000, default: 1800, description: '每次模型调用的最大输出 Token 数。' },
                concurrency: { type: 'integer', minimum: 1, maximum: 6, default: 2, description: '同时校对的记录数。' },
                maxSummaryChars: { type: 'integer', minimum: 4000, maximum: 120000, default: 30000, description: '节点直接返回的结果摘要字符上限。' },
                reportTitle: { type: 'string', default: '新闻内容校对报告', maxLength: 120, description: '完整报告和任务产物标题。' }
            }, ['records', 'model'])
        },
        {
            name: 'agent.delegate',
            title: '委派智能体',
            description: '调用一次独立模型运行具名专家，返回专家结果并自动附带结构化 Handoff；通常无需再连接 agent.handoff。',
            input_schema: asJsonSchema({
                task: { type: 'string', description: '委派给专家智能体的明确任务，支持工作流模板变量。' },
                context: { type: 'string', description: '传给专家的上游事实、证据或其他智能体结果。' },
                agentName: { type: 'string', description: '专家智能体名称。' },
                role: { type: 'string', enum: ['researcher', 'analyst', 'reviewer', 'writer', 'custom'], default: 'analyst' },
                instructions: { type: 'string', description: '角色边界、判断标准和禁止事项。' },
                model: { type: 'string', description: '模型 ID 或 model_name。' },
                temperature: { type: 'number', minimum: 0, maximum: 2, default: 0.2 },
                maxTokens: { type: 'integer', minimum: 1, maximum: 32768, default: 1200 },
                responseFormat: { type: 'string', enum: ['markdown', 'text', 'json'], default: 'markdown' },
                outputSchema: { type: 'object', description: '可选 JSON Schema。设置后会强制 JSON 输出，失败时最多自动修正一次。' }
            }, ['task', 'agentName', 'role', 'model'])
        },
        {
            name: 'agent.handoff',
            title: '智能体交接',
            description: '只把已有结论、证据、风险和待决问题整理为结构化 Handoff，不调用模型；适合统一格式或汇总多个来源后再交给下游。',
            input_schema: asJsonSchema({
                fromAgent: { type: 'string' },
                toAgent: { type: 'string', default: 'Supervisor' },
                summary: { type: 'string' },
                findings: { type: 'array', items: { type: 'string' } },
                evidence: { type: 'array', items: { type: 'string' } },
                risks: { type: 'array', items: { type: 'string' } },
                openQuestions: { type: 'array', items: { type: 'string' } },
                confidence: { type: 'number', minimum: 0, maximum: 1, default: 0.7 }
            }, ['fromAgent', 'summary'])
        },
        ...getAgentCollaborationToolDefinitions(asJsonSchema),
        {
            name: 'agent.code',
            title: '代码执行',
            requiresSandbox: true,
            description: '仅允许在独立受控 Worker 沙箱中执行 JavaScript；服务端进程不直接执行。对上游数据做转换、计算、过滤或格式整理时用 return 返回结果。',
            input_schema: asJsonSchema({
                code: { type: 'string', description: '要执行的 JS 代码，使用 return 返回结果。可直接引用 vars 中定义的变量名。' },
                vars: { type: 'object', description: '注入到代码作用域的变量，支持 {{nodes.*.output}} 等模板引用。' }
            }, ['code'])
        },
        terminalToolDefinition(asJsonSchema),
        {
            name: 'agent.http',
            title: 'HTTP 请求',
            description: '调用外部 REST API 并返回状态码与响应数据。内网地址会被安全策略拦截。',
            input_schema: asJsonSchema({
                url: { type: 'string', description: '请求地址，支持模板变量。' },
                method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'], default: 'GET' },
                headers: { type: 'object', description: '请求头键值对，例如鉴权 Token。' },
                credentialSecret: { type: 'string', description: '凭据引用名，例如 CRM_API；优先读取凭据库，未配置时回退环境变量 PIVOT_WORKFLOW_SECRET_CRM_API。' },
                credentialHeader: { type: 'string', default: 'Authorization', description: '注入凭据的请求头名称。' },
                credentialPrefix: { type: 'string', default: 'Bearer ', description: '凭据值前缀。' },
                body: { type: 'object', description: 'POST/PUT/PATCH 的 JSON 请求体。' },
                timeoutMs: { type: 'integer', minimum: 1000, maximum: 30000, default: 10000 }
            }, ['url']),
            output_schema: {
                type: 'object',
                required: ['statusCode', 'ok', 'headers', 'data', 'text'],
                properties: {
                    statusCode: { type: 'integer' }, ok: { type: 'boolean' },
                    headers: { type: 'object' }, data: {}, text: { type: 'string' }
                }
            }
        },
        {
            name: 'agent.web_search',
            title: '受控网页检索',
            description: '通过管理员配置的检索 Provider 搜索公开网页。每次调用必须命中任务网络白名单，返回结果仅作为只读证据。',
            network: true,
            alwaysRequiresApproval: true,
            input_schema: asJsonSchema({
                query: { type: 'string', minLength: 1, maxLength: 500, description: '要检索的关键词或问题。' },
                limit: { type: 'integer', minimum: 1, maximum: 10, default: 5 },
                locale: { type: 'string', maxLength: 24, default: 'zh-CN' },
                safeSearch: { type: 'boolean', default: true },
                timeoutMs: { type: 'integer', minimum: 1000, maximum: 30000, default: 15000 }
            }, ['query']),
            output_schema: {
                type: 'object',
                required: ['query', 'provider', 'results', 'resultCount', 'text'],
                properties: {
                    query: { type: 'string' }, provider: { type: 'string' }, resultCount: { type: 'integer' }, text: { type: 'string' },
                    results: { type: 'array', items: { type: 'object', properties: { rank: { type: 'integer' }, title: { type: 'string' }, url: { type: 'string' }, snippet: { type: 'string' }, publishedAt: { type: 'string' }, source: { type: 'string' } } } }
                }
            }
        },
        {
            name: 'agent.image_generate',
            title: '受控图片生成',
            description: '通过管理员配置的图片 Provider 生成一张图片。生成与媒体展示 URL 都必须在任务网络白名单内，并且每次均需审批。',
            network: true,
            alwaysRequiresApproval: true,
            input_schema: asJsonSchema({
                prompt: { type: 'string', minLength: 1, maxLength: 2400, description: '图片生成提示词。' },
                size: { type: 'string', maxLength: 32, default: '1024x1024' },
                style: { type: 'string', maxLength: 120 },
                alt: { type: 'string', maxLength: 160, description: '图片无障碍说明。' },
                timeoutMs: { type: 'integer', minimum: 1000, maximum: 120000, default: 30000 }
            }, ['prompt'])
        },
        {
            name: 'agent.text_to_speech',
            title: '受控语音合成',
            description: '通过管理员配置的语音 Provider 合成可播放音频。每次调用均需审批，返回媒体地址必须位于任务网络白名单。',
            network: true,
            alwaysRequiresApproval: true,
            input_schema: asJsonSchema({
                text: { type: 'string', minLength: 1, maxLength: 12000, description: '要朗读的文字。' },
                voice: { type: 'string', maxLength: 120 },
                format: { type: 'string', enum: ['mp3', 'wav', 'ogg'], default: 'mp3' },
                speed: { type: 'number', minimum: 0.5, maximum: 2, default: 1 },
                title: { type: 'string', maxLength: 120 },
                timeoutMs: { type: 'integer', minimum: 1000, maximum: 120000, default: 30000 }
            }, ['text'])
        },
        {
            name: 'agent.browser',
            title: '浏览器自动化',
            description: '在独立浏览器 Profile 中访问白名单页面并执行受控 DOM/视觉定位操作，禁止读取凭证。',
            alwaysRequiresApproval: true,
            network: true,
            input_schema: asJsonSchema({
                url: { type: 'string', description: '新建或导航浏览器会话时必须位于任务网络白名单中的 HTTP/HTTPS 地址。' },
                sessionId: { type: 'string', maxLength: 128, description: '可选的已授权浏览器会话标识，用于连续浏览任务。' },
                action: { type: 'string', enum: ['open', 'new_tab', 'switch_tab', 'navigate', 'inspect', 'snapshot', 'click', 'fill', 'select', 'scroll', 'wait', 'screenshot', 'close_tab', 'close'], default: 'inspect' },
                target: { type: 'object', description: 'DOM/视觉目标，支持 selector、role/name 或 text。' },
                tabId: { type: 'string', maxLength: 80, description: '可选的浏览器标签标识；省略时使用当前标签。' },
                newTab: { type: 'boolean', default: false, description: '导航时是否新建标签页；不适用于写入操作。' },
                value: { description: 'fill 的文本值，或 select 的值、标签或序号对象。' },
                deltaX: { type: 'number', minimum: -5000, maximum: 5000, description: 'scroll 的水平像素位移。' },
                deltaY: { type: 'number', minimum: -5000, maximum: 5000, description: 'scroll 的垂直像素位移。' },
                timeoutMs: { type: 'integer', minimum: 100, maximum: 30000, description: 'wait 的最长等待时间。' },
                waitState: { type: 'string', enum: ['attached', 'detached', 'visible', 'hidden'], description: 'wait 目标状态。' },
                taskId: { type: 'string', maxLength: 80 },
                screenshot: { type: 'boolean', default: false }
            })
        },
        {
            name: 'agent.merge',
            title: '变量聚合',
            cacheable: true,
            description: '把多个上游节点的输出合并成一个对象，便于下游节点用统一的字段名引用。',
            input_schema: asJsonSchema({
                fields: { type: 'object', description: '字段映射，键为目标字段名，值支持 {{nodes.*.output}} 模板引用。' }
            }),
            output_schema: {
                type: 'object',
                required: ['merged', 'keys', 'count'],
                properties: {
                    merged: { type: 'object' }, keys: { type: 'array', items: { type: 'string' } }, count: { type: 'integer' }
                }
            }
        },
        ...getToolDiscoveryDefinitions(asJsonSchema),
        {
            name: 'workflow.input',
            title: '工作流输入',
            description: '声明并读取运行参数，支持必填校验、默认值和基础类型转换。',
            input_schema: asJsonSchema({
                name: { type: 'string', description: '参数名，只允许字母、数字、下划线和短横线。' },
                label: { type: 'string', description: '运行表单中展示的名称。' },
                type: { type: 'string', enum: ['text', 'number', 'boolean', 'object', 'array'], default: 'text' },
                required: { type: 'boolean', default: false },
                defaultValue: { description: '未提供参数时使用的默认值。' },
                description: { type: 'string' }
            }, ['name']),
            output_schema: {
                type: 'object',
                required: ['name', 'label', 'type', 'value', 'supplied', 'text'],
                properties: {
                    name: { type: 'string' }, label: { type: 'string' }, type: { type: 'string' },
                    value: {}, supplied: { type: 'boolean' }, text: { type: 'string' }
                }
            }
        },
        {
            name: 'workflow.template',
            title: '文本模板',
            cacheable: true,
            description: '使用工作流变量拼接确定性文本，不调用模型、不执行代码。',
            input_schema: asJsonSchema({
                template: { type: 'string', maxLength: 50000, description: '支持 {{goal}}、{{inputs.*}} 和 {{nodes.*.output.*}}。' },
                trim: { type: 'boolean', default: true },
                missingVariable: { type: 'string', enum: ['keep', 'empty', 'error'], default: 'keep' }
            }, ['template']),
            output_schema: {
                type: 'object',
                required: ['text', 'charCount', 'missingVariables'],
                properties: {
                    text: { type: 'string' },
                    charCount: { type: 'integer' },
                    missingVariables: { type: 'array', items: { type: 'string' } }
                }
            }
        },
        {
            name: 'workflow.notify',
            title: '受控通知',
            description: '通过已配置的企业微信、飞书或钉钉渠道绑定排队发送文本/Markdown 通知；不接受裸 Webhook URL。',
            side_effect: true,
            network: true,
            alwaysRequiresApproval: true,
            input_schema: asJsonSchema({
                bindingId: { type: 'string', maxLength: 128, description: '已配置的渠道绑定 ID。' },
                platform: { type: 'string', enum: ['wecom', 'feishu', 'dingtalk'] },
                subject: { type: 'string', maxLength: 255 },
                body: { type: 'string', maxLength: 20000, description: '消息正文，支持工作流变量。' },
                format: { type: 'string', enum: ['text', 'markdown'], default: 'text' },
                eventType: { type: 'string', maxLength: 80 },
                idempotencyKey: { type: 'string', maxLength: 255 }
            }, ['bindingId', 'body']),
            output_schema: {
                type: 'object',
                required: ['queued', 'deliveryId', 'bindingId', 'status', 'idempotencyKey'],
                properties: {
                    queued: { type: 'boolean' }, deliveryId: { type: 'integer' }, bindingId: { type: 'string' },
                    status: { type: 'string' }, platform: { type: 'string', enum: ['wecom', 'feishu', 'dingtalk'] }, idempotencyKey: { type: 'string' }
                }
            }
        },
        {
            name: 'workflow.output',
            title: '工作流输出',
            description: '声明工作流最终输出，便于调用方按名称读取交付结果。',
            input_schema: asJsonSchema({
                name: { type: 'string', default: 'result' },
                value: { description: '要作为最终结果返回的值。' },
                format: { type: 'string', enum: ['markdown', 'text', 'json'], default: 'markdown' },
                presentation: { type: 'string', enum: ['default', 'table', 'file'], default: 'default', description: '可选的交付增强方式，底层仍返回 JSON 数据或文件引用。' },
                tableTitle: { type: 'string', description: '表格标题。' },
                tableColumns: { type: 'array', items: { type: 'string' }, description: '表格列名；留空时从首行自动推断。' },
                fileRef: { type: 'object', description: '文件引用，可包含 id、name、mimeType、url 或 downloadUrl。' }
            }, ['name', 'value'])
        },
        {
            name: 'workflow.condition',
            title: '条件路由',
            cacheable: true,
            description: '比较输入值并返回 matched 与 route，供下游 when 条件引用。',
            input_schema: asJsonSchema({
                value: { description: '待判断的值。' },
                operator: { type: 'string', enum: ['equals', 'not_equals', 'contains', 'not_contains', 'greater_than', 'less_than', 'is_empty', 'not_empty', 'is_true', 'is_false'], default: 'not_empty' },
                compareTo: { description: '比较目标值。' }
            }, ['operator']),
            output_schema: {
                type: 'object',
                required: ['matched', 'route', 'text'],
                properties: { matched: { type: 'boolean' }, value: {}, compareTo: {}, operator: { type: 'string' }, route: { type: 'string' }, text: { type: 'string' } }
            }
        },
        {
            name: 'workflow.approval',
            title: '人工审批',
            description: '暂停工作流等待指定用户或部门审批，支持多级串签、超时策略和 IM 回调。',
            alwaysRequiresApproval: true,
            input_schema: asJsonSchema({
                title: { type: 'string', default: '请审批本节点' },
                summary: { description: '需要审批的内容摘要。' },
                instructions: { type: 'string' },
                approvers: { type: 'array', items: { type: 'string' }, description: '审批人用户名或用户 ID 列表。' },
                approverUserIds: { type: 'array', items: { type: 'integer' } },
                approverUnits: { type: 'array', items: { type: 'string' } },
                mode: { type: 'string', enum: ['any', 'all'], default: 'any' },
                approvalLevels: { type: 'array', items: { type: 'object' } },
                timeoutMs: { type: 'integer', minimum: 0, maximum: 2592000000, default: 0 },
                timeoutHours: { type: 'number', minimum: 0, maximum: 720, default: 0 },
                timeoutAction: { type: 'string', enum: ['reject', 'approve', 'cancel'], default: 'reject' },
                imServerId: { type: 'integer' },
                imTargetType: { type: 'string', enum: ['user', 'group'], default: 'user' },
                imTarget: { type: 'string' },
                callbackBaseUrl: { type: 'string' },
                callbackCredential: { type: 'string' }
            }, ['title'])
        },
        {
            name: 'workflow.foreach',
            title: '循环 / 批处理',
            requiresSandbox: true,
            cancellable: true,
            timeout: { default_seconds: 120, max_seconds: 600 },
            description: '仅允许在独立受控 Worker 沙箱中对数组逐项执行 JavaScript 转换，并汇总结果和错误。',
            input_schema: asJsonSchema({
                items: { type: 'array' },
                code: { type: 'string', default: 'return item;' },
                vars: { type: 'object' },
                concurrency: { type: 'integer', minimum: 1, maximum: 20, default: 4 },
                stopOnError: { type: 'boolean', default: true },
                retryLimit: { type: 'integer', minimum: 0, maximum: 3, default: 0 },
                itemTimeoutMs: { type: 'integer', minimum: 50, maximum: 5000, default: 1000 }
            }, ['items', 'code']),
            output_schema: {
                type: 'object',
                required: ['items', 'count', 'inputCount', 'errors', 'audit'],
                properties: {
                    items: { type: 'array' }, count: { type: 'integer' }, inputCount: { type: 'integer' },
                    errors: { type: 'array' }, stoppedOnError: { type: 'boolean' }, worker: { type: 'object' }, audit: { type: 'object' }
                }
            }
        },
        {
            name: 'workflow.subworkflow',
            title: '子工作流',
            description: '调用另一个已发布工作流；运行时限制递归深度并阻止循环调用。',
            input_schema: asJsonSchema({
                workflowId: { type: 'integer' },
                version: { type: 'string', default: 'published' },
                goal: { type: 'string' },
                inputs: { type: 'object' }
            }, ['workflowId'])
        },
        {
            name: 'workflow.iteration',
            title: '逐项调用子工作流',
            description: '对数组中的每一项调用已发布子工作流，保留来源、顺序与单项失败信息。',
            side_effect: true,
            cancellable: true,
            input_schema: asJsonSchema({
                items: { type: 'array', maxItems: 1000 },
                workflowId: { type: 'integer' },
                version: { type: 'string', default: 'published' },
                goal: { type: 'string' },
                inputs: { type: 'object', description: '子工作流输入映射，可使用 {{item}} 与 {{itemIndex}}。' },
                concurrency: { type: 'integer', minimum: 1, maximum: 10, default: 1 },
                onItemError: { type: 'string', enum: ['stop', 'continue', 'drop'], default: 'stop' },
                maxItems: { type: 'integer', minimum: 1, maximum: 1000, default: 1000 }
            }, ['items', 'workflowId']),
            output_schema: {
                type: 'object',
                required: ['items', 'count', 'inputCount', 'errors', 'stoppedOnError'],
                properties: {
                    items: { type: 'array' }, count: { type: 'integer' }, inputCount: { type: 'integer' },
                    errors: { type: 'array' }, stoppedOnError: { type: 'boolean' }, workflowId: { type: 'integer' },
                    version: { type: 'integer' }, processedCount: { type: 'integer' }
                }
            }
        },
        {
            name: 'workflow.delay',
            title: '延时',
            description: '挂起工作流到指定时间后继续，最长 30 天，不占用运行槽。',
            input_schema: asJsonSchema({
                durationMs: { type: 'integer', minimum: 0, maximum: 2592000000, default: 1000 },
                reason: { type: 'string' }
            })
        },
        ...getWorkflowPresentationToolDefinitions(asJsonSchema),
        {
            name: 'report.compose',
            title: '报告编排',
            cacheable: true,
            description: '将摘要和章节组装为结构化 Markdown 报告。',
            input_schema: asJsonSchema({
                title: { type: 'string', default: '工作流报告' },
                summary: { description: '可选摘要。' },
                sections: { type: 'object', description: '章节标题到内容的映射。' },
                includeToc: { type: 'boolean', default: true }
            }, ['title'])
        },
        {
            name: 'rag.search',
            title: '知识库检索',
            description: '检索当前用户的知识库，返回按相关度排序的片段和来源文档。',
            input_schema: asJsonSchema({
                query: { type: 'string', description: '检索问题或关键词。' },
                topK: { type: 'integer', minimum: 1, maximum: 10, default: 5 },
                candidateLimit: { type: 'integer', minimum: 10, maximum: 200, default: 80 }
            }, ['query']),
            output_schema: {
                type: 'object',
                required: ['query', 'matches'],
                properties: {
                    query: { type: 'string' },
                    matches: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                docName: { type: 'string' },
                                score: { type: 'number' },
                                hit: {},
                                content: { type: 'string' }
                            }
                        }
                    },
                    metrics: {}
                }
            }
        },
        {
            name: 'sessions.search',
            title: '会话检索',
            description: '按关键词检索当前用户的历史会话内容，可限定会话与时间范围；结果含可打开的来源引用。',
            input_schema: asJsonSchema({
                query: { type: 'string' },
                sessionId: { type: 'string', description: '可选，仅检索当前用户拥有的指定会话。' },
                from: { type: 'string', description: '可选，ISO 8601 起始时间。' },
                to: { type: 'string', description: '可选，ISO 8601 结束时间。' },
                limit: { type: 'integer', minimum: 1, maximum: 20, default: 8 }
            }, ['query'])
        },
        {
            name: 'sessions.recent',
            title: '最近会话',
            description: '列出当前用户最近的未删除会话。',
            input_schema: asJsonSchema({
                limit: { type: 'integer', minimum: 1, maximum: 20, default: 8 }
            })
        },
        {
            name: 'knowledge.list',
            title: '知识库文档',
            description: '列出当前用户的知识库文档及索引状态。',
            input_schema: asJsonSchema({
                limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 }
            })
        },
        {
            name: 'knowledge.graph.query',
            title: '知识图谱查询',
            description: '按问题查询当前用户知识图谱中的实体、关系路径和来源文档，用于回答责任、依赖、归属、影响等关系型问题。',
            input_schema: asJsonSchema({
                query: { type: 'string' },
                entityLimit: { type: 'integer', minimum: 1, maximum: 10, default: 6 },
                relationLimit: { type: 'integer', minimum: 1, maximum: 20, default: 12 }
            }, ['query'])
        },
        {
            name: 'viz.build_chart',
            title: '图表生成',
            description: '基于输入表格行生成可直接渲染的图表配置。',
            input_schema: asJsonSchema({
                rows: { type: 'array', items: { type: 'object' } },
                chartType: { type: 'string', enum: ['bar', 'line', 'area', 'pie'] },
                title: { type: 'string' },
                xAxis: { type: 'string' },
                yAxis: { type: 'string' },
                groupBy: { type: 'string' },
                aggregation: { type: 'string', enum: ['sum', 'count', 'avg', 'min', 'max'] },
                sortBy: { type: 'string', enum: ['label', 'value'] },
                sortOrder: { type: 'string', enum: ['asc', 'desc'] },
                limit: { type: 'integer', minimum: 1, maximum: 1000, default: 100 }
            }, ['rows', 'xAxis'])
        },
        {
            name: 'viz.build_table',
            title: '表格展示',
            description: '基于输入表格行生成可直接展示的 Markdown 表格。',
            input_schema: asJsonSchema({
                rows: { type: 'array', items: { type: 'object' } },
                columns: { type: 'array', items: { type: 'string' } },
                title: { type: 'string' },
                limit: { type: 'integer', minimum: 1, maximum: 1000, default: 50 }
            }, ['rows'])
        },
        {
            name: 'models.list',
            title: '可用模型',
            description: '列出当前用户可以使用的模型。',
            input_schema: asJsonSchema({})
        },
        {
            name: 'system.health',
            title: '系统健康',
            description: adminOnly
                ? '返回数据库、存储、内存和磁盘健康状态。'
                : '返回有限的系统健康状态。',
            input_schema: asJsonSchema({}),
            admin: true
        },
        {
            name: 'system.modelRuntime',
            title: '模型运行状态',
            description: '返回模型端点队列、熔断器和监控状态。',
            input_schema: asJsonSchema({}),
            admin: true
        },
        ...getArtifactToolDefinitions()
    ].filter(tool => !tool.admin || adminOnly);
    // Docker 服务镜像只携带 Playwright 包，不携带 Chromium；在工具目录层
    // 隐藏不可用能力，避免模型规划后才触发审批再失败。
    return definitions.filter(tool => {
        if (tool.name === 'agent.browser') return isAgentBrowserRuntimeAvailable();
        if (tool.name === 'agent.web_search') return isAgentWebSearchAvailable();
        if (tool.name === 'agent.image_generate') return isAgentImageGenerationAvailable();
        if (tool.name === 'agent.text_to_speech') return isAgentTextToSpeechAvailable();
        if (tool.name === 'terminal.runtime') return isTerminalRuntimeAvailable();
        return true;
    });
}

async function getUserAccessibleModels(user) {
    const models = await getUserRunnableModelsAsync(user);
    return models.map(model => ({
        id: model.id,
        name: model.name,
        model_name: model.model_name,
        user_id: model.user_id,
        daily_token_limit: model.daily_token_limit,
        allowed_units: model.allowed_units,
        supports_vision: model.supports_vision,
        supports_reasoning: model.supports_reasoning,
        status: model.status
    }));
}

async function chooseAgentLlmModel(input = {}, user, context = {}) {
    const requested = String(input.model || context.modelCfg?.id || context.run?.model_id || '').trim();
    if (requested) return await getRunnableModelForUserAsync(requested, user);
    const models = await getUserRunnableModelsAsync(user);
    const first = models.find(model => model.status !== 'usage_only');
    return first ? await getRunnableModelForUserAsync(first.id, user) : null;
}

function parseJsonOutputText(value) {
    if (value && typeof value === 'object') return value;
    const text = String(value || '').trim();
    if (!text) return null;
    const withoutFence = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    try { return JSON.parse(withoutFence); } catch (e) {}
    const first = withoutFence.indexOf('{');
    const last = withoutFence.lastIndexOf('}');
    if (first >= 0 && last > first) {
        try { return JSON.parse(withoutFence.slice(first, last + 1)); } catch (e) {}
    }
    const arrayFirst = withoutFence.indexOf('[');
    const arrayLast = withoutFence.lastIndexOf(']');
    if (arrayFirst >= 0 && arrayLast > arrayFirst) {
        try { return JSON.parse(withoutFence.slice(arrayFirst, arrayLast + 1)); } catch (e) {}
    }
    return null;
}

function structuredOutputName(value) {
    const raw = String(value || 'workflow_output').replace(/[^A-Za-z0-9_-]/g, '_').replace(/^[^A-Za-z_]+/, '');
    return (raw || 'workflow_output').slice(0, 64);
}

function isNativeStructuredOutputUnsupported(error) {
    const status = Number(error?.response?.status || error?.status || 0);
    const payload = error?.response?.data;
    const text = `${error?.message || ''} ${typeof payload === 'string' ? payload : JSON.stringify(payload || {})}`.toLowerCase();
    if ([400, 404, 422].includes(status)) return true;
    return /response_format|json_schema|structured output/.test(text) && /unsupported|unrecognized|unknown|invalid/.test(text);
}

function outputSchemaForNode(context = {}) {
    const schema = normalizeJsonSchema(context.node?.outputSchema || context.node?.output_schema || {});
    return schemaHasRules(schema) ? schema : {};
}

function validateStructuredOutput(content, schema = {}) {
    const parsed = parseJsonOutputText(content);
    if (parsed === null) return { value: null, issues: ['结果不是合法 JSON。'] };
    const definitionIssues = [];
    if (schemaHasRules(schema)) validateJsonSchemaDefinition(schema, '输出契约', definitionIssues);
    if (definitionIssues.length) return { value: parsed, issues: definitionIssues };
    const issues = schemaHasRules(schema)
        ? validateValueAgainstSchema(parsed, schema, {}, '输出', [])
        : [];
    return { value: parsed, issues };
}

async function requestStructuredOutput({ modelCfg, messages, user, temperature, maxTokens, schema, schemaName, signal, usageRef }) {
    const responseFormat = schemaHasRules(schema)
        ? {
            type: 'json_schema',
            json_schema: {
                name: structuredOutputName(schemaName),
                strict: true,
                schema
            }
        }
        : null;
    const content = await callModelText(modelCfg, messages, {
        user,
        temperature,
        maxTokens,
        signal,
        usageRef,
        ...(responseFormat ? { responseFormat } : {})
    });
    return { content, native: Boolean(responseFormat) };
}

async function executeAgentLlmNode(input = {}, user, context = {}) {
    const prompt = String(input.prompt || input.input || input.text || '').trim();
    if (!prompt) throw new Error('大模型节点需要填写提示词。');
    const modelCfg = await chooseAgentLlmModel(input, user, context);
    if (!modelCfg) throw new Error('没有可用于大模型节点的模型，或当前用户无权访问指定模型。');
    const responseFormat = ['markdown', 'text', 'json'].includes(String(input.responseFormat || input.response_format || 'markdown'))
        ? String(input.responseFormat || input.response_format || 'markdown')
        : 'markdown';
    const systemPrompt = String(input.systemPrompt || input.system_prompt || '').trim()
        || '你是 Pivot 工作流中的大模型节点。请严格根据输入和上游结果完成本节点任务，输出使用中文，避免编造未提供的信息。';
    const formatGuide = responseFormat === 'json'
        ? '请只输出合法 JSON，不要包裹 Markdown 代码块。'
        : responseFormat === 'text'
            ? '请输出纯文本。'
            : '请输出清晰的 Markdown。';
    const messages = [
        { role: 'system', content: `${systemPrompt}\n${formatGuide}` },
        { role: 'user', content: prompt }
    ];
    const temperature = Math.max(0, Math.min(Number(input.temperature ?? 0.2), 2));
    const maxTokens = resolveWorkflowMaxTokens(input, modelCfg);
    const fitted = fitMessagesToContextBudget(messages, modelCfg, { maxOutputTokens: maxTokens });
    const modelMessages = fitted.messages;
    const outputSchema = outputSchemaForNode(context);
    let content = '';
    let nativeStructured = false;
    if (responseFormat === 'json') {
        const usageRef = {};
        try {
            const result = await requestStructuredOutput({
                modelCfg,
                messages: modelMessages,
                user,
                temperature,
                maxTokens,
                schema: outputSchema,
                schemaName: context.node?.id || 'workflow_output',
                signal: context.signal || null,
                usageRef
            });
            content = result.content;
            nativeStructured = result.native;
        } catch (error) {
            if (!isNativeStructuredOutputUnsupported(error)) throw error;
            content = await callModelText(modelCfg, modelMessages, { user, temperature, maxTokens, signal: context.signal || null, usageRef });
        }
        await recordAgentModelUsage(user, modelCfg, modelMessages, content, 'agent_llm_node', context.run?.id || context.runId || '', { usageRef });
        let validation = validateStructuredOutput(content, outputSchema);
        if (validation.issues.length) {
            const repairMessages = [
                {
                    role: 'system',
                    content: `${systemPrompt}\n请修复下面的模型结果，只输出合法 JSON，不要输出解释、Markdown 代码块或额外文字。${schemaHasRules(outputSchema) ? `\n输出必须符合以下 JSON Schema：\n${JSON.stringify(outputSchema)}` : ''}`
                },
                {
                    role: 'user',
                    content: `原始结果：\n${String(content || '').slice(0, 16000)}\n\n校验问题：\n${validation.issues.join('\n')}`
                }
            ];
            const repairUsageRef = {};
            const repaired = await callModelText(modelCfg, repairMessages, { user, temperature: 0, maxTokens, signal: context.signal || null, usageRef: repairUsageRef });
            await recordAgentModelUsage(user, modelCfg, repairMessages, repaired, 'agent_llm_node_json_repair', context.run?.id || context.runId || '', { usageRef: repairUsageRef });
            content = repaired;
            validation = validateStructuredOutput(content, outputSchema);
            if (validation.issues.length) {
                const error = new Error(`大模型结构化输出校验失败：${validation.issues[0]}`);
                error.code = 'AGENT_JSON_OUTPUT_INVALID';
                error.contractIssues = validation.issues;
                throw error;
            }
        }
    } else {
        const usageRef = {};
        content = await callModelText(modelCfg, modelMessages, { user, temperature, maxTokens, signal: context.signal || null, usageRef });
        await recordAgentModelUsage(user, modelCfg, modelMessages, content, 'agent_llm_node', context.run?.id || context.runId || '', { usageRef });
    }
    return {
        content,
        text: content,
        model: {
            id: modelCfg.id,
            name: modelCfg.name,
            model_name: modelCfg.model_name
        },
        responseFormat,
        structuredOutput: responseFormat === 'json' ? { native: nativeStructured, schema: outputSchema } : undefined,
        temperature,
        maxTokens,
        contextBudget: fitted.metadata
    };
}

const executeAgentDelegate = createAgentDelegateExecutor({
    callModelText, recordAgentModelUsage, chooseAgentLlmModel, clampText,
    fitMessagesToContextBudget, isNativeStructuredOutputUnsupported,
    normalizeJsonSchema, requestStructuredOutput, resolveWorkflowMaxTokens,
    schemaHasRules, validateJsonSchemaDefinition, validateStructuredOutput
});

function normalizeHandoffList(value, limit = 30) {
    const source = Array.isArray(value) ? value : (value ? [value] : []);
    return source.map(item => clampText(item, 1200).trim()).filter(Boolean).slice(0, limit);
}

function executeAgentHandoff(input = {}) {
    const fromAgent = String(input.fromAgent || input.from_agent || '').trim().slice(0, 80);
    const summary = clampText(input.summary || '', 20000).trim();
    if (!fromAgent || !summary) throw new Error('智能体交接需要来源智能体和交接摘要。');
    return {
        type: 'agent_handoff',
        fromAgent,
        toAgent: String(input.toAgent || input.to_agent || 'Supervisor').trim().slice(0, 80) || 'Supervisor',
        summary,
        findings: normalizeHandoffList(input.findings),
        evidence: normalizeHandoffList(input.evidence),
        risks: normalizeHandoffList(input.risks),
        openQuestions: normalizeHandoffList(input.openQuestions || input.open_questions),
        confidence: Math.max(0, Math.min(Number(input.confidence ?? 0.7), 1)),
        status: 'ready',
        createdAt: new Date().toISOString()
    };
}

async function executeAgentBrowser(input = {}, user = null, context = {}) {
    return await executeAgentBrowserSessionAction({
        sessionId: input.sessionId || input.session_id || '',
        user,
        run: context.run,
        input,
        context
    });
}

// ——————————————————————————————————————————
// agent.merge：将多个上游节点的输出合并为单一对象，支持重命名字段，方便后续节点统一引用。
// ——————————————————————————————————————————
function executeAgentMerge(input = {}) {
    const fields = input.fields && typeof input.fields === 'object' && !Array.isArray(input.fields)
        ? input.fields
        : null;
    if (fields) {
        // 模式一：显式字段映射 { targetKey: actualValue }
        const merged = {};
        Object.entries(fields).forEach(([key, value]) => {
            merged[String(key).trim()] = value ?? null;
        });
        return { merged, keys: Object.keys(merged), count: Object.keys(merged).length };
    }
    // 模式二：平铺所有已解析的 inputs 字段（dag-utils 已在调用前解析模板变量）
    const merged = {};
    Object.entries(input).forEach(([key, value]) => {
        if (['fields', 'title', 'tool'].includes(key)) return;
        merged[String(key).trim()] = value ?? null;
    });
    return { merged, keys: Object.keys(merged), count: Object.keys(merged).length };
}


async function executeBuiltInTool(name, input = {}, user, context = {}) {
    assertDynamicCodeExecutionIsSandboxed(name, context);
    if (ARTIFACT_TOOL_NAMES.includes(name)) return executeArtifactTool(name, input, user, context);
    if (name === 'agent.llm') {
        return executeAgentLlmNode(input, user, context);
    }
    if (name === 'agent.content_review') {
        return executeContentReview(input, user, context);
    }
    if (name === 'agent.delegate') {
        return executeAgentDelegate(input, user, context);
    }
    if (name === 'agent.spawn') return await executeAgentSpawn(input, user, context);
    if (name === 'agent.wait') return await executeAgentWait(input, user, context);
    if (name === 'agent.message') return await executeAgentMessage(input, user, context);
    if (name === 'agent.cancel') return await executeAgentCancel(input, user, context);
    if (name === 'agent.join') return await executeAgentJoin(input, user, context);
    if (name === 'agent.handoff') {
        return executeAgentHandoff(input);
    }
    if (name === 'workflow.input') return executeWorkflowInput(input, context);
    if (name === 'workflow.template') return executeWorkflowTemplate(input);
    if (name === 'workflow.notify') return executeWorkflowNotify(input, user, context);
    if (name === 'workflow.output') return executeWorkflowOutput(input);
    if (name === 'workflow.condition') return executeWorkflowCondition(input);
    if (name === 'workflow.approval') {
        if (context.workflowApprovalResult) return context.workflowApprovalResult;
        return { approved: true, summary: input.summary ?? '', text: renderWorkflowValue(input.summary) };
    }
    if (name === 'workflow.foreach') return executeWorkflowForeach(input, context);
    if (name === 'workflow.subworkflow') {
        if (typeof context.executeSubworkflow !== 'function') throw new Error('当前运行环境不支持子工作流。');
        return context.executeSubworkflow(input);
    }
    if (name === 'workflow.iteration') return executeWorkflowIteration(input, context);
    if (name === 'workflow.delay') {
        if (context.workflowDelayResult) return context.workflowDelayResult;
        return executeWorkflowDelay(input, context);
    }
    if (name === 'workflow.embed_page') return executeWorkflowEmbedPage(input);
    if (name === 'workflow.embed_image') return executeWorkflowEmbedImage(input);
    if (name === 'workflow.embed_video') return executeWorkflowEmbedVideo(input);
    if (name === 'workflow.embed_audio') return executeWorkflowEmbedAudio(input);
    if (name === 'workflow.link_card') return executeWorkflowLinkCard(input);
    if (name === 'workflow.embed_code') return executeWorkflowEmbedCode(input);
    if (name === 'report.compose') return executeReportCompose(input);

    if (name === 'rag.search') {
        const query = String(input.query || '').trim();
        if (!query) throw new Error('请填写检索问题。');
        let chatBridge = context?.run?.metadata?.chatBridge;
        if (typeof chatBridge === 'string') {
            try { chatBridge = JSON.parse(chatBridge); } catch (_) { chatBridge = null; }
        }
        const runContextConfig = normalizeContextConfig(context?.run?.context_config || context?.run?.contextConfig || {});
        // 显式选择的项目资料包优先且只能收窄范围；RAG 内部仍会再次执行当前 ACL。
        const scope = runContextConfig.collectionIds.length
            ? { collectionIds: runContextConfig.collectionIds }
            : (chatBridge?.ragScope && typeof chatBridge.ragScope === 'object' ? chatBridge.ragScope : {});
        const result = await debugRetrieveContext(user.id, query, {
            topK: parsePositiveInt(input.topK, 5, 10),
            candidateLimit: parsePositiveInt(input.candidateLimit, 80, 200),
            scope,
            user
        });
        return {
            query,
            matches: (result.matches || []).map(match => ({
                docName: match.docName,
                score: match.score,
                hit: match.hit,
                content: clampText(match.content, 1600)
            })),
            metrics: result.metrics || null
        };
    }

    if (name === 'sessions.search') {
        return await searchUserSessions(user, input);
    }

    if (name === 'sessions.recent') {
        const limit = parsePositiveInt(input.limit, 8, 20);
        return await query(`
            SELECT id, title, tags, is_pinned, is_archived, created_at, updated_at
            FROM sessions
            WHERE user_id = ? AND deleted_at IS NULL
            ORDER BY is_pinned DESC, updated_at DESC
            LIMIT ?
        `, [user.id, limit]);
    }

    if (name === 'knowledge.list') {
        const limit = parsePositiveInt(input.limit, 20, 50);
        return await query(`
            SELECT id, name, status, is_enabled, chunk_count, indexed_chunks, progress, error_message, updated_at
            FROM knowledge_docs
            WHERE user_id = ? AND deleted_at IS NULL
            ORDER BY updated_at DESC, created_at DESC
            LIMIT ?
        `, [user.id, limit]);
    }

    if (name === 'knowledge.graph.query') {
        const graphQuery = String(input.query || '').trim();
        if (!graphQuery) throw new Error('请填写知识图谱查询问题。');
        return queryKnowledgeGraph({
            userId: user.id,
            query: graphQuery,
            entityLimit: parsePositiveInt(input.entityLimit, 6, 10),
            relationLimit: parsePositiveInt(input.relationLimit, 12, 20)
        });
    }

    if (name === 'models.list') {
        return await getUserAccessibleModels(user);
    }

    if (name === 'viz.build_chart') {
        return buildChartSpec({ rows: Array.isArray(input.rows) ? input.rows : [] }, input);
    }

    if (name === 'viz.build_table') {
        return buildTableBlock(input);
    }


    if (name === 'agent.http') {
        return executeAgentHttp(input, user, context);
    }
    if (name === 'agent.web_search') {
        return executeAgentWebSearch(input, user, context);
    }
    if (name === 'agent.image_generate') {
        return executeAgentImageGeneration(input, user, context);
    }
    if (name === 'agent.text_to_speech') {
        return executeAgentTextToSpeech(input, user, context);
    }

    if (name === 'agent.browser') {
        return executeAgentBrowser(input, user, context);
    }

    if (name === 'terminal.runtime') {
        return executeTerminalRuntime(input, user, context);
    }

    if (name === 'agent.merge') {
        return executeAgentMerge(input);
    }

    const discovery = await executeToolDiscoveryMeta(name, input, user, context);
    if (discovery.handled) return discovery.value;

    if (name === 'system.health') {
        assertAdmin(user);
        return await getSystemHealthSnapshot();
    }

    if (name === 'system.modelRuntime') {
        assertAdmin(user);
        return getModelEndpointRuntimeStatus();
    }

    throw new Error(`未知工具：${name}`);
}

module.exports = {
    clampText,
    executeAgentDelegate,
    executeAgentHandoff,
    executeAgentBrowser,
    executeAgentHttp,
    executeBuiltInTool,
    getBuiltInToolDefinitions
};
