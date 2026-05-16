const { db } = require('../db');
const { getSystemHealthSnapshot } = require('./system-health');
const { getModelEndpointRuntimeStatus } = require('./model-runtime');
const { debugRetrieveContext } = require('./rag-index');
const { getUserRunnableModels } = require('./models');

const MAX_TEXT = 12000;
const isSuperAdmin = (user) => user?.username === 'admin';

function clampText(value, max = MAX_TEXT) {
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    if (!text) return '';
    return text.length > max ? `${text.slice(0, max)}\n...[truncated]` : text;
}

function parsePositiveInt(value, fallback, max = 100) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return Math.min(parsed, max);
}

function assertAdmin(user) {
    if (!isSuperAdmin(user)) {
        const err = new Error('只有 admin 超级管理员可以使用此工具。');
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

async function executeBuiltInTool(name, input = {}, user) {
    if (name === 'rag.search') {
        const query = String(input.query || '').trim();
        if (!query) throw new Error('请填写检索问题。');
        const result = await debugRetrieveContext(user.id, query, {
            topK: parsePositiveInt(input.topK, 5, 10),
            candidateLimit: parsePositiveInt(input.candidateLimit, 80, 200)
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

    if (name === 'models.list') {
        return getUserAccessibleModels(user);
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
