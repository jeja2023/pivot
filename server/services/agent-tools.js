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

async function executeBuiltInTool(name, input = {}, user, context = {}) {
    if (name === 'agent.llm') {
        return executeAgentLlmNode(input, user, context);
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
    executeBuiltInTool,
    getBuiltInToolDefinitions
};
