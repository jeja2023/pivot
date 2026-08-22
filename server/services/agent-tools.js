const { query } = require('../db/client');
const { getSystemHealthSnapshot } = require('./system-health');
const { getModelEndpointRuntimeStatus } = require('./model-runtime');
const { debugRetrieveContext } = require('./rag-index');
const { queryKnowledgeGraph } = require('./knowledge-graph');
const { callModelText, recordAgentModelUsage } = require('./agent-model');
const { getRunnableModelForUserAsync, getUserRunnableModelsAsync } = require('./models');
const { parsePositiveInt } = require('../number');
const { buildChartSpec, buildTableBlock } = require('./builtin-mcp');
const { isSuperAdmin } = require('../permissions');
const { safeJsonRequest } = require('./safe-http-client');
const { resolveCredentialSecret } = require('./workflow-credentials');
const { executeContentReview } = require('./agent-content-review');
const { fitMessagesToContextBudget, getModelContextBudget } = require('./context-budget');
const { assertNetworkPolicyUrl, normalizeNetworkPolicy } = require('./agent-network-policy');
const {
    clickBrowserTarget,
    closeAgentBrowserContext,
    createAgentBrowserContext,
    locateBrowserTarget
} = require('./agent-browser');
const {
    normalizeJsonSchema,
    schemaHasRules,
    validateJsonSchemaDefinition,
    validateValueAgainstSchema
} = require('./agent-dag-contracts');
const vm = require('vm');

const MAX_TEXT = 12000;

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
    return [
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
                responseFormat: { type: 'string', enum: ['markdown', 'text', 'json'], default: 'markdown' }
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
        {
            name: 'agent.code',
            title: '代码执行',
            description: '在受限沙箱中执行一段 JavaScript，对上游数据做转换、计算、过滤或格式整理。用 return 返回结果。',
            input_schema: asJsonSchema({
                code: { type: 'string', description: '要执行的 JS 代码，使用 return 返回结果。可直接引用 vars 中定义的变量名。' },
                vars: { type: 'object', description: '注入到代码作用域的变量，支持 {{nodes.*.output}} 等模板引用。' }
            }, ['code'])
        },
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
            }, ['url'])
        },
        {
            name: 'agent.browser',
            title: '浏览器自动化',
            description: '在独立浏览器 Profile 中访问白名单页面并执行受控 DOM/视觉定位操作，禁止读取凭证。',
            alwaysRequiresApproval: true,
            network: true,
            input_schema: asJsonSchema({
                url: { type: 'string', description: '必须位于任务网络白名单中的 HTTP/HTTPS 地址。' },
                action: { type: 'string', enum: ['inspect', 'click'], default: 'inspect' },
                target: { type: 'object', description: 'DOM/视觉目标，支持 selector、role/name 或 text。' },
                taskId: { type: 'string', maxLength: 80 },
                screenshot: { type: 'boolean', default: false }
            }, ['url'])
        },
        {
            name: 'agent.merge',
            title: '变量聚合',
            description: '把多个上游节点的输出合并成一个对象，便于下游节点用统一的字段名引用。',
            input_schema: asJsonSchema({
                fields: { type: 'object', description: '字段映射，键为目标字段名，值支持 {{nodes.*.output}} 模板引用。' }
            })
        },
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
            }, ['name'])
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
            description: '比较输入值并返回 matched 与 route，供下游 when 条件引用。',
            input_schema: asJsonSchema({
                value: { description: '待判断的值。' },
                operator: { type: 'string', enum: ['equals', 'not_equals', 'contains', 'not_contains', 'greater_than', 'less_than', 'is_empty', 'not_empty', 'is_true', 'is_false'], default: 'not_empty' },
                compareTo: { description: '比较目标值。' }
            }, ['operator'])
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
            description: '对数组逐项执行受限 JavaScript 转换，并汇总结果和错误。',
            input_schema: asJsonSchema({
                items: { type: 'array' },
                code: { type: 'string', default: 'return item;' },
                vars: { type: 'object' },
                concurrency: { type: 'integer', minimum: 1, maximum: 20, default: 4 },
                stopOnError: { type: 'boolean', default: true }
            }, ['items', 'code'])
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
            name: 'workflow.delay',
            title: '延时',
            description: '挂起工作流到指定时间后继续，最长 30 天，不占用运行槽。',
            input_schema: asJsonSchema({
                durationMs: { type: 'integer', minimum: 0, maximum: 2592000000, default: 1000 },
                reason: { type: 'string' }
            })
        },
        {
            name: 'report.compose',
            title: '报告编排',
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
            }, ['query'])
        },
        {
            name: 'sessions.search',
            title: '会话检索',
            description: '按关键词检索当前用户的历史会话内容。',
            input_schema: asJsonSchema({
                query: { type: 'string' },
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
        }
    ].filter(tool => !tool.admin || adminOnly);
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

async function requestStructuredOutput({ modelCfg, messages, user, temperature, maxTokens, schema, schemaName, signal }) {
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
        try {
            const result = await requestStructuredOutput({
                modelCfg,
                messages: modelMessages,
                user,
                temperature,
                maxTokens,
                schema: outputSchema,
                schemaName: context.node?.id || 'workflow_output',
                signal: context.signal || null
            });
            content = result.content;
            nativeStructured = result.native;
        } catch (error) {
            if (!isNativeStructuredOutputUnsupported(error)) throw error;
            content = await callModelText(modelCfg, modelMessages, { user, temperature, maxTokens, signal: context.signal || null });
        }
        await recordAgentModelUsage(user, modelCfg, modelMessages, content, 'agent_llm_node', context.run?.id || context.runId || '');
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
            const repaired = await callModelText(modelCfg, repairMessages, { user, temperature: 0, maxTokens, signal: context.signal || null });
            await recordAgentModelUsage(user, modelCfg, repairMessages, repaired, 'agent_llm_node_json_repair', context.run?.id || context.runId || '');
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
        content = await callModelText(modelCfg, modelMessages, { user, temperature, maxTokens, signal: context.signal || null });
        await recordAgentModelUsage(user, modelCfg, modelMessages, content, 'agent_llm_node', context.run?.id || context.runId || '');
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

const DELEGATE_ROLE_LABELS = {
    researcher: '研究员',
    analyst: '分析员',
    reviewer: '审阅员',
    writer: '撰写员',
    custom: '领域专家'
};

async function executeAgentDelegate(input = {}, user, context = {}) {
    const task = String(input.task || '').trim();
    const agentName = String(input.agentName || input.agent_name || '').trim().slice(0, 80);
    const role = Object.hasOwn(DELEGATE_ROLE_LABELS, input.role) ? input.role : 'custom';
    if (!task) throw new Error('委派智能体需要填写明确任务。');
    if (!agentName) throw new Error('委派智能体需要填写名称。');
    const modelCfg = await chooseAgentLlmModel(input, user, context);
    if (!modelCfg) throw new Error('没有可用于委派智能体的模型，或当前用户无权访问指定模型。');
    const responseFormat = ['markdown', 'text', 'json'].includes(String(input.responseFormat || input.response_format || 'markdown'))
        ? String(input.responseFormat || input.response_format || 'markdown')
        : 'markdown';
    const roleLabel = DELEGATE_ROLE_LABELS[role];
    const instructions = String(input.instructions || '').trim();
    const contextText = clampText(input.context || '', 20000);
    const formatGuide = responseFormat === 'json'
        ? '只输出合法 JSON，不要使用 Markdown 代码块。'
        : responseFormat === 'text'
            ? '输出简洁纯文本。'
            : '输出结构清晰的 Markdown。';
    const messages = [
        {
            role: 'system',
            content: [
                `你是 Pivot 多智能体团队中的“${agentName}”，职责是${roleLabel}。`,
                '你只处理当前委派任务，不擅自扩展目标；明确区分事实、推断和未知信息。',
                instructions,
                formatGuide
            ].filter(Boolean).join('\n')
        },
        {
            role: 'user',
            content: [
                `委派任务：\n${task}`,
                contextText ? `可用上下文：\n${contextText}` : '',
                '请给出可直接交给 Supervisor 审核的结果，并指出关键依据、风险和仍待确认的问题。'
            ].filter(Boolean).join('\n\n')
        }
    ];
    const temperature = Math.max(0, Math.min(Number(input.temperature ?? 0.2), 2));
    const maxTokens = resolveWorkflowMaxTokens(input, modelCfg);
    const fitted = fitMessagesToContextBudget(messages, modelCfg, { maxOutputTokens: maxTokens });
    const content = await callModelText(modelCfg, fitted.messages, { user, temperature, maxTokens, signal: context.signal || null });
    await recordAgentModelUsage(user, modelCfg, fitted.messages, content, 'agent_delegate', context.run?.id || context.runId || '');
    return {
        content,
        text: content,
        agent: { name: agentName, role, roleLabel, modelId: modelCfg.id, modelName: modelCfg.name },
        handoff: {
            fromAgent: agentName,
            toAgent: 'Supervisor',
            summary: content,
            status: 'ready',
            createdAt: new Date().toISOString()
        },
        responseFormat,
        contextBudget: fitted.metadata
    };
}

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

// ——————————————————————————————————————————
// agent.code：在隔离 VM 沙箱中执行用户内联 JS，并返回 return 语句的值。
// 安全策略：vm.runInNewContext 禁止访问 require/process/global；超时 5s。
// ——————————————————————————————————————————
function executeAgentCode(input = {}) {
    const code = String(input.code || '').trim();
    if (!code) throw new Error('代码节点需要填写要执行的 JS 代码。');
    const rawVars = input.vars && typeof input.vars === 'object' && !Array.isArray(input.vars)
        ? input.vars
        : {};
    const sandbox = {
        vars: rawVars,
        ...rawVars,
        JSON,
        Math,
        Number,
        String: globalThis.String,
        Array: globalThis.Array,
        Object: globalThis.Object,
        Boolean: globalThis.Boolean,
        Date: globalThis.Date,
        console: { log: () => {}, error: () => {} }
    };
    let result;
    try {
        const wrapped = `(function() { ${code} })()`;
        result = vm.runInNewContext(wrapped, vm.createContext(sandbox), { timeout: 5000 });
    } catch (e) {
        throw new Error(`代码执行失败：${e.message}`);
    }
    const output = result === undefined ? null : result;
    return {
        output,
        text: typeof output === 'string'
            ? output
            : output === null || output === undefined
                ? ''
                : JSON.stringify(output),
        type: Array.isArray(output) ? 'array' : (output !== null && typeof output === 'object' ? 'object' : typeof output)
    };
}

// ——————————————————————————————————————————
// agent.http：通过已有的安全 HTTP 客户端调用外部 REST API，支持 GET/POST/PUT/DELETE/PATCH。
// ——————————————————————————————————————————
async function executeAgentHttp(input = {}, user, context = {}) {
    const url = String(input.url || '').trim();
    if (!url) throw new Error('HTTP 节点需要填写请求 URL。');
    let networkPolicy = context.run?.network_policy || context.run?.networkPolicy;
    if (typeof networkPolicy === 'string') {
        try { networkPolicy = JSON.parse(networkPolicy); } catch (_) { networkPolicy = null; }
    }
    if (context.autonomous === true && (!networkPolicy || typeof networkPolicy !== 'object')) {
        const error = new Error('自主 Agent 网络请求必须绑定任务级网络白名单。');
        error.code = 'AGENT_NETWORK_POLICY_REQUIRED';
        error.category = 'policy';
        throw error;
    }
    if (networkPolicy || input.networkPolicy || input.network_policy) {
        await assertNetworkPolicyUrl(url, normalizeNetworkPolicy(networkPolicy || input.networkPolicy || input.network_policy), {
            requireAllowlist: context.autonomous === true
        });
    }
    const method = String(input.method || 'GET').trim().toLowerCase();
    const allowedMethods = ['get', 'post', 'put', 'delete', 'patch'];
    if (!allowedMethods.includes(method)) {
        throw new Error(`HTTP 节点不支持该方法：${method}，允许的方法为 GET/POST/PUT/DELETE/PATCH。`);
    }
    const rawHeaders = input.headers && typeof input.headers === 'object' && !Array.isArray(input.headers)
        ? input.headers
        : {};
    const headers = Object.fromEntries(
        Object.entries(rawHeaders).map(([k, v]) => [String(k).trim(), String(v ?? '').trim()]).filter(([k]) => k)
    );
    const credentialSecret = String(input.credentialSecret || input.credential_secret || '').trim();
    if (credentialSecret) {
        if (!/^[A-Za-z0-9_]+$/.test(credentialSecret)) {
            throw new Error('HTTP 凭据引用只能包含字母、数字和下划线。');
        }
        // 优先读取凭据库（支持免重启轮换和按部门授权），未命中时回退到历史环境变量方式
        const envName = `PIVOT_WORKFLOW_SECRET_${credentialSecret.toUpperCase()}`;
        const stored = await resolveCredentialSecret(credentialSecret, user);
        const secret = stored?.value || process.env[envName];
        if (!secret) {
            throw new Error(`未找到 HTTP 凭据「${credentialSecret}」，请在凭据库创建，或配置环境变量 ${envName}。`);
        }
        const header = String(input.credentialHeader || input.credential_header || 'Authorization').trim();
        if (!header || /[\r\n:]/.test(header)) throw new Error('HTTP 凭据请求头名称无效。');
        headers[header] = `${String(input.credentialPrefix ?? input.credential_prefix ?? 'Bearer ')}${secret}`;
    }
    const hasBody = ['post', 'put', 'patch'].includes(method);
    const bodyRaw = hasBody ? (input.body ?? input.data ?? null) : undefined;
    const body = bodyRaw !== undefined && bodyRaw !== null && typeof bodyRaw !== 'object'
        ? { value: bodyRaw }
        : bodyRaw;
    let response;
    try {
        response = await safeJsonRequest({
            method,
            url,
            data: body,
            headers,
            user,
            timeout: Math.min(parsePositiveInt(input.timeoutMs ?? input.timeout_ms, 10000, 30000), 30000),
            signal: context.signal || null,
            validateStatus: () => true
        });
    } catch (e) {
        throw new Error(`HTTP 请求失败：${e.message}`);
    }
    const responseData = response.data;
    const responseText = typeof responseData === 'string'
        ? responseData
        : (responseData !== null && responseData !== undefined ? JSON.stringify(responseData) : '');
    return {
        statusCode: response.status,
        ok: response.status >= 200 && response.status < 300,
        headers: response.headers || {},
        data: responseData,
        text: clampText(responseText, 8000)
    };
}

async function executeAgentBrowser(input = {}, context = {}) {
    const url = String(input.url || '').trim();
    if (!url) throw new Error('浏览器节点需要填写 URL。');
    const networkPolicy = normalizeNetworkPolicy(context.run?.network_policy || context.run?.networkPolicy || input.networkPolicy || input.network_policy || {});
    const browserContext = await createAgentBrowserContext({
        taskId: input.taskId || context.run?.id || 'agent-browser',
        profileRoot: context.browserProfileRoot,
        networkPolicy,
        executablePath: context.browserExecutablePath
    });
    try {
        const page = await browserContext.newPage();
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: Math.min(Number(input.timeoutMs) || 30000, 120000) });
        let action = 'inspect';
        let targetResult = null;
        if (String(input.action || 'inspect') === 'click') {
            targetResult = await clickBrowserTarget(page, input.target || {}, { visionLocator: context.visionLocator });
            action = 'click';
        } else if (input.target) {
            targetResult = await locateBrowserTarget(page, input.target, { visionLocator: context.visionLocator });
            targetResult = { method: targetResult.method };
        }
        const output = { action, url: page.url(), title: await page.title(), text: String(await page.locator('body').innerText()).slice(0, 12000), target: targetResult };
        if (input.screenshot === true) output.screenshot = (await page.screenshot({ type: 'png', fullPage: false })).toString('base64');
        return output;
    } finally {
        await closeAgentBrowserContext(browserContext);
    }
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

function renderWorkflowValue(value) {
    if (typeof value === 'string') return value;
    if (value === undefined || value === null) return '';
    try { return JSON.stringify(value, null, 2); } catch (e) { return String(value); }
}

function coerceWorkflowInput(value, type, name) {
    if (type === 'text') return typeof value === 'string' ? value : renderWorkflowValue(value);
    if (type === 'number') {
        const parsed = Number(value);
        if (!Number.isFinite(parsed)) throw new Error(`工作流输入“${name}”必须是数字。`);
        return parsed;
    }
    if (type === 'boolean') {
        if (typeof value === 'boolean') return value;
        if (['true', '1', 'yes', 'on'].includes(String(value).toLowerCase())) return true;
        if (['false', '0', 'no', 'off'].includes(String(value).toLowerCase())) return false;
        throw new Error(`工作流输入“${name}”必须是布尔值。`);
    }
    if (type === 'object' || type === 'array') {
        let parsed = value;
        if (typeof value === 'string') {
            try { parsed = JSON.parse(value); } catch (e) { throw new Error(`工作流输入“${name}”必须是合法 JSON。`); }
        }
        if (type === 'array' ? !Array.isArray(parsed) : (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))) {
            throw new Error(`工作流输入“${name}”必须是${type === 'array' ? '数组' : '对象'}。`);
        }
        return parsed;
    }
    return value;
}

function executeWorkflowInput(input = {}, context = {}) {
    const name = String(input.name || '').trim();
    if (!/^[A-Za-z_][A-Za-z0-9_-]{0,79}$/.test(name)) throw new Error('工作流输入参数名无效。');
    const values = context.dagInputs && typeof context.dagInputs === 'object' ? context.dagInputs : {};
    const supplied = Object.hasOwn(values, name);
    let value = supplied ? values[name] : input.defaultValue;
    if ((value === undefined || value === null || value === '') && input.required) {
        throw new Error(`缺少必填工作流输入：${input.label || name}`);
    }
    const type = ['text', 'number', 'boolean', 'object', 'array'].includes(input.type) ? input.type : 'text';
    if (value !== undefined && value !== null && value !== '') value = coerceWorkflowInput(value, type, name);
    return { name, label: String(input.label || name), type, value: value ?? null, supplied, text: renderWorkflowValue(value) };
}

function executeWorkflowOutput(input = {}) {
    const name = String(input.name || 'result').trim() || 'result';
    const value = input.value;
    const format = ['markdown', 'text', 'json'].includes(String(input.format || 'markdown'))
        ? String(input.format || 'markdown')
        : 'markdown';
    const presentation = ['default', 'table', 'file'].includes(String(input.presentation || 'default'))
        ? String(input.presentation || 'default')
        : 'default';
    const result = { name, value, format, presentation, text: renderWorkflowValue(value) };
    if (presentation === 'table') {
        const rows = Array.isArray(value)
            ? value
            : (value && typeof value === 'object'
                ? (Array.isArray(value.rows) ? value.rows : (Array.isArray(value.data) ? value.data : (Array.isArray(value.items) ? value.items : [])))
                : []);
        const normalizedRows = rows.filter(row => row && typeof row === 'object' && !Array.isArray(row)).slice(0, 500);
        const explicitColumns = Array.isArray(input.tableColumns)
            ? input.tableColumns.map(column => String(column || '').trim()).filter(Boolean).slice(0, 50)
            : [];
        const columns = explicitColumns.length
            ? explicitColumns
            : [...new Set(normalizedRows.flatMap(row => Object.keys(row)))].slice(0, 50);
        result.table = {
            title: String(input.tableTitle || '').trim() || '工作流结果',
            columns,
            rows: normalizedRows,
            rowCount: normalizedRows.length,
            truncated: rows.length > normalizedRows.length
        };
        result.text = result.table.title + (normalizedRows.length ? `（${normalizedRows.length} 行）` : '（暂无数据）');
    }
    if (presentation === 'file') {
        const source = input.fileRef && typeof input.fileRef === 'object' ? input.fileRef : value;
        if (!source || typeof source !== 'object' || Array.isArray(source)) {
            throw new Error('文件产物需要提供文件引用对象。');
        }
        const file = {};
        ['id', 'fileId', 'name', 'mimeType', 'size', 'url', 'downloadUrl', 'path', 'storageKey'].forEach(key => {
            if (source[key] !== undefined && source[key] !== null && source[key] !== '') file[key] = source[key];
        });
        if (!Object.keys(file).some(key => ['id', 'fileId', 'url', 'downloadUrl', 'path', 'storageKey'].includes(key))) {
            throw new Error('文件引用至少需要 id、url、downloadUrl、path 或 storageKey。');
        }
        result.file = file;
        result.text = `文件产物：${file.name || file.fileId || file.id || '已生成文件'}`;
    }
    return result;
}

function executeWorkflowCondition(input = {}) {
    const value = input.value;
    const compareTo = input.compareTo;
    const operator = String(input.operator || 'not_empty');
    const empty = value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);
    let matched;
    if (operator === 'equals') matched = value === compareTo || String(value) === String(compareTo);
    else if (operator === 'not_equals') matched = !(value === compareTo || String(value) === String(compareTo));
    else if (operator === 'contains') matched = Array.isArray(value) ? value.includes(compareTo) : String(value ?? '').includes(String(compareTo ?? ''));
    else if (operator === 'not_contains') matched = Array.isArray(value) ? !value.includes(compareTo) : !String(value ?? '').includes(String(compareTo ?? ''));
    else if (operator === 'greater_than') matched = Number(value) > Number(compareTo);
    else if (operator === 'less_than') matched = Number(value) < Number(compareTo);
    else if (operator === 'is_empty') matched = empty;
    else if (operator === 'is_true') matched = value === true || String(value).toLowerCase() === 'true';
    else if (operator === 'is_false') matched = value === false || String(value).toLowerCase() === 'false';
    else matched = !empty;
    return { matched, value, compareTo, operator, route: matched ? 'matched' : 'unmatched', text: matched ? 'matched' : 'unmatched' };
}

async function executeWorkflowForeach(input = {}) {
    const items = Array.isArray(input.items) ? input.items : [];
    if (items.length > 500) throw new Error('循环节点单次最多处理 500 项。');
    const code = String(input.code || 'return item;').trim();
    const commonVars = input.vars && typeof input.vars === 'object' && !Array.isArray(input.vars) ? input.vars : {};
    const output = new Array(items.length);
    const errors = [];
    const concurrency = Math.max(1, Math.min(Number.parseInt(input.concurrency, 10) || 4, 20));
    const runItem = async (item, index) => {
        try {
            const sandbox = { item, index, items, vars: commonVars, JSON, Math, Number, String, Array, Object, Boolean, Date };
            const result = vm.runInNewContext(`(function() { ${code} })()`, vm.createContext(sandbox), { timeout: 1000 });
            output[index] = await new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('单项异步执行超时')), 1000);
                Promise.resolve(result).then(
                    value => { clearTimeout(timer); resolve(value); },
                    error => { clearTimeout(timer); reject(error); }
                );
            });
        } catch (e) {
            errors.push({ index, message: e.message });
            if (input.stopOnError !== false) throw new Error(`循环第 ${index + 1} 项执行失败：${e.message}`);
            output[index] = null;
        }
    };
    for (let start = 0; start < items.length; start += concurrency) {
        const batch = items.slice(start, start + concurrency);
        await Promise.all(batch.map((item, offset) => runItem(item, start + offset)));
    }
    return { items: output, count: output.length, errors, concurrency, text: renderWorkflowValue(output) };
}

async function executeWorkflowDelay(input = {}, context = {}) {
    if (typeof context.waitForWorkflowDelay === 'function' && context.run) {
        const node = context.node || {
            id: context.delayKey || 'workflow.delay',
            title: 'Workflow delay',
            tool: 'workflow.delay'
        };
        return context.waitForWorkflowDelay({
            run: context.run,
            node,
            input,
            key: context.delayKey || ''
        });
    }
    const durationMs = Math.max(0, Math.min(Number.parseInt(input.durationMs ?? input.duration_ms, 10) || 0, 600000));
    if (durationMs) await new Promise(resolve => setTimeout(resolve, durationMs));
    return { durationMs, reason: String(input.reason || ''), completedAt: new Date().toISOString() };
}

function executeReportCompose(input = {}) {
    const title = String(input.title || '工作流报告').trim() || '工作流报告';
    const sections = input.sections && typeof input.sections === 'object' && !Array.isArray(input.sections) ? input.sections : {};
    const headings = Object.keys(sections);
    const blocks = [`# ${title}`];
    if (input.includeToc !== false && headings.length) blocks.push(`## 目录\n${headings.map((name, index) => `${index + 1}. ${name}`).join('\n')}`);
    if (input.summary !== undefined && input.summary !== null && input.summary !== '') blocks.push(`## 摘要\n${renderWorkflowValue(input.summary)}`);
    headings.forEach(name => blocks.push(`## ${name}\n${renderWorkflowValue(sections[name])}`));
    const markdown = blocks.join('\n\n');
    return { markdown, text: markdown, sectionCount: headings.length, title };
}

async function executeBuiltInTool(name, input = {}, user, context = {}) {
    if (name === 'agent.llm') {
        return executeAgentLlmNode(input, user, context);
    }
    if (name === 'agent.content_review') {
        return executeContentReview(input, user, context);
    }
    if (name === 'agent.delegate') {
        return executeAgentDelegate(input, user, context);
    }
    if (name === 'agent.handoff') {
        return executeAgentHandoff(input);
    }
    if (name === 'workflow.input') return executeWorkflowInput(input, context);
    if (name === 'workflow.output') return executeWorkflowOutput(input);
    if (name === 'workflow.condition') return executeWorkflowCondition(input);
    if (name === 'workflow.approval') {
        if (context.workflowApprovalResult) return context.workflowApprovalResult;
        return { approved: true, summary: input.summary ?? '', text: renderWorkflowValue(input.summary) };
    }
    if (name === 'workflow.foreach') return executeWorkflowForeach(input);
    if (name === 'workflow.subworkflow') {
        if (typeof context.executeSubworkflow !== 'function') throw new Error('当前运行环境不支持子工作流。');
        return context.executeSubworkflow(input);
    }
    if (name === 'workflow.delay') {
        if (context.workflowDelayResult) return context.workflowDelayResult;
        return executeWorkflowDelay(input, context);
    }
    if (name === 'report.compose') return executeReportCompose(input);

    if (name === 'rag.search') {
        const query = String(input.query || '').trim();
        if (!query) throw new Error('请填写检索问题。');
        const result = await debugRetrieveContext(user.id, query, {
            topK: parsePositiveInt(input.topK, 5, 10),
            candidateLimit: parsePositiveInt(input.candidateLimit, 80, 200),
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
        const searchQuery = String(input.query || '').trim();
        if (!searchQuery) throw new Error('请填写检索关键词。');
        const like = `%${searchQuery}%`;
        const limit = parsePositiveInt(input.limit, 8, 20);
        return await query(`
            SELECT m.id, m.session_id, s.title, m.role, substring(m.content from 1 for 1200) AS content, m.created_at
            FROM messages m
            JOIN sessions s ON s.id = m.session_id
            WHERE m.user_id = ? AND m.deleted_at IS NULL AND s.deleted_at IS NULL
              AND m.content LIKE ?
            ORDER BY m.created_at DESC
            LIMIT ?
        `, [user.id, like, limit]);
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

    if (name === 'agent.code') {
        return executeAgentCode(input);
    }

    if (name === 'agent.http') {
        return executeAgentHttp(input, user, context);
    }

    if (name === 'agent.browser') {
        return executeAgentBrowser(input, context);
    }

    if (name === 'agent.merge') {
        return executeAgentMerge(input);
    }

    if (name === 'system.health') {
        assertAdmin(user);
        return getSystemHealthSnapshot();
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
    executeBuiltInTool,
    getBuiltInToolDefinitions
};
