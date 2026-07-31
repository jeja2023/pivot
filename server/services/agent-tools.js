const { db } = require('../db');
const { getSystemHealthSnapshot } = require('./system-health');
const { getModelEndpointRuntimeStatus } = require('./model-runtime');
const { debugRetrieveContext } = require('./rag-index');
const { queryKnowledgeGraph } = require('./knowledge-graph');
const { callModelText, recordAgentModelUsage } = require('./agent-model');
const { getRunnableModelForUser, getUserRunnableModels } = require('./models');
const { parsePositiveInt } = require('../number');
const { buildChartSpec, buildTableBlock } = require('./builtin-mcp');
const { isSuperAdmin } = require('../permissions');
const { safeJsonRequest } = require('./safe-http-client');
const vm = require('vm');

const MAX_TEXT = 12000;

function clampText(value, max = MAX_TEXT) {
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    if (!text) return '';
    return text.length > max ? `${text.slice(0, max)}\n...[truncated]` : text;
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
                maxTokens: { type: 'integer', minimum: 1, maximum: 8000, default: 1200 },
                responseFormat: { type: 'string', enum: ['markdown', 'text', 'json'], default: 'markdown' }
            }, ['prompt', 'model'])
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
                maxTokens: { type: 'integer', minimum: 1, maximum: 8000, default: 1200 },
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
                body: { type: 'object', description: 'POST/PUT/PATCH 的 JSON 请求体。' },
                timeoutMs: { type: 'integer', minimum: 1000, maximum: 30000, default: 10000 }
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

function getUserAccessibleModels(user) {
    return getUserRunnableModels(user).map(model => ({
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

function chooseAgentLlmModel(input = {}, user, context = {}) {
    const requested = String(input.model || context.modelCfg?.id || context.run?.model_id || '').trim();
    if (requested) return getRunnableModelForUser(requested, user);
    const first = getUserRunnableModels(user).find(model => model.status !== 'usage_only');
    return first ? getRunnableModelForUser(first.id, user) : null;
}

async function executeAgentLlmNode(input = {}, user, context = {}) {
    const prompt = String(input.prompt || input.input || input.text || '').trim();
    if (!prompt) throw new Error('大模型节点需要填写提示词。');
    const modelCfg = chooseAgentLlmModel(input, user, context);
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
    const maxTokens = parsePositiveInt(input.maxTokens ?? input.max_tokens, 1200, 8000);
    const content = await callModelText(modelCfg, messages, { user, temperature, maxTokens });
    recordAgentModelUsage(user, modelCfg, messages, content, 'agent_llm_node', context.run?.id || context.runId || '');
    return {
        content,
        text: content,
        model: {
            id: modelCfg.id,
            name: modelCfg.name,
            model_name: modelCfg.model_name
        },
        responseFormat,
        temperature,
        maxTokens
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
    const modelCfg = chooseAgentLlmModel(input, user, context);
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
    const maxTokens = parsePositiveInt(input.maxTokens ?? input.max_tokens, 1200, 8000);
    const content = await callModelText(modelCfg, messages, { user, temperature, maxTokens });
    recordAgentModelUsage(user, modelCfg, messages, content, 'agent_delegate', context.run?.id || context.runId || '');
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
        responseFormat
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
async function executeAgentHttp(input = {}, user) {
    const url = String(input.url || '').trim();
    if (!url) throw new Error('HTTP 节点需要填写请求 URL。');
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
    if (name === 'agent.llm') {
        return executeAgentLlmNode(input, user, context);
    }
    if (name === 'agent.delegate') {
        return executeAgentDelegate(input, user, context);
    }
    if (name === 'agent.handoff') {
        return executeAgentHandoff(input);
    }

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
        const query = String(input.query || '').trim();
        if (!query) throw new Error('请填写检索关键词。');
        const like = `%${query}%`;
        const limit = parsePositiveInt(input.limit, 8, 20);
        return db.prepare(`
            SELECT m.id, m.session_id, s.title, m.role, substr(m.content, 1, 1200) AS content, m.created_at
            FROM messages m
            JOIN sessions s ON s.id = m.session_id
            WHERE m.user_id = ? AND m.deleted_at IS NULL AND s.deleted_at IS NULL
              AND m.content LIKE ?
            ORDER BY m.created_at DESC
            LIMIT ?
        `).all(user.id, like, limit);
    }

    if (name === 'sessions.recent') {
        const limit = parsePositiveInt(input.limit, 8, 20);
        return db.prepare(`
            SELECT id, title, tags, is_pinned, is_archived, created_at, updated_at
            FROM sessions
            WHERE user_id = ? AND deleted_at IS NULL
            ORDER BY is_pinned DESC, updated_at DESC
            LIMIT ?
        `).all(user.id, limit);
    }

    if (name === 'knowledge.list') {
        const limit = parsePositiveInt(input.limit, 20, 50);
        return db.prepare(`
            SELECT id, name, status, is_enabled, chunk_count, indexed_chunks, progress, error_message, updated_at
            FROM knowledge_docs
            WHERE user_id = ? AND deleted_at IS NULL
            ORDER BY updated_at DESC, created_at DESC
            LIMIT ?
        `).all(user.id, limit);
    }

    if (name === 'knowledge.graph.query') {
        const query = String(input.query || '').trim();
        if (!query) throw new Error('请填写知识图谱查询问题。');
        return queryKnowledgeGraph({
            userId: user.id,
            query,
            entityLimit: parsePositiveInt(input.entityLimit, 6, 10),
            relationLimit: parsePositiveInt(input.relationLimit, 12, 20)
        });
    }

    if (name === 'models.list') {
        return getUserAccessibleModels(user);
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
        return executeAgentHttp(input, user);
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
    executeBuiltInTool,
    getBuiltInToolDefinitions
};
