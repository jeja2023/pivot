'use strict';

/** Small progressive-disclosure meta tools kept outside the core built-in catalog. */
const MAX_BATCH_READ_CALLS = 8;

function batchReadError(message, code = 'TOOL_BATCH_READ_INVALID', status = 400) {
    const error = new Error(message);
    error.code = code;
    error.status = status;
    error.statusCode = status;
    error.category = 'policy';
    return error;
}

function isReadOnlyDescription(description = {}) {
    return description.idempotent === true
        && description.sideEffect !== true
        && String(description.concurrency || 'read') === 'read'
        && description.requiresApproval !== true;
}

async function executeReadOnlyDiscoveredBatch(user, calls, context = {}, deps = {}) {
    const items = Array.isArray(calls) ? calls : [];
    if (!items.length || items.length > MAX_BATCH_READ_CALLS) {
        throw batchReadError(`只读批处理必须包含 1 至 ${MAX_BATCH_READ_CALLS} 个调用。`);
    }
    const state = context?.toolDiscoveryState;
    const {
        assertDescribed, getRememberedDescription
    } = require('./agent-tool-progressive-discovery');
    const { describeToolForUser, executeDiscoveredTool } = deps.toolDiscovery || require('./tool-discovery');
    const descriptions = [];
    for (const item of items) {
        const reference = item?.toolRef || item?.tool_ref || {};
        assertDescribed(state, reference);
        const description = getRememberedDescription(state, reference) || await describeToolForUser(user, reference, {}, {
            toolPolicy: context.run?.tool_policy || context.run?.toolPolicy || 'all',
            toolAllowlist: context.run?.tool_allowlist || context.run?.toolAllowlist || null
        });
        if (!isReadOnlyDescription(description)) {
            throw batchReadError(`工具 ${description.name || reference.toolName || '-'} 不是可批处理的只读幂等工具。`, 'TOOL_BATCH_READ_FORBIDDEN', 409);
        }
        descriptions.push(description);
    }
    const { executeToolCallsInOrder } = require('./agent-tool-scheduler');
    const results = await executeToolCallsInOrder(items.map((item, index) => ({ tool: descriptions[index], item })), async entry => {
        const reference = entry.item.toolRef || entry.item.tool_ref || {};
        return await executeDiscoveredTool(user, {
            toolRef: reference,
            input: entry.item.input && typeof entry.item.input === 'object' ? entry.item.input : {}
        }, context, deps.toolDiscovery || {});
    }, { signal: context.signal, maxReadConcurrency: context.maxReadConcurrency });
    return {
        type: 'tools_batch_read',
        count: results.length,
        results: results.map((output, index) => ({ toolName: descriptions[index].name, output }))
    };
}

function getToolDiscoveryDefinitions(asJsonSchema) {
    return [
        {
            name: 'tools.search',
            title: '搜索可用工具',
            cacheable: true,
            description: '在当前用户已授权的工具目录中按任务、能力和风险搜索少量候选工具；返回摘要和稳定 toolRef，不加载全部完整 Schema。',
            input_schema: asJsonSchema({
                query: { type: 'string', minLength: 2, maxLength: 1000 },
                limit: { type: 'integer', minimum: 1, maximum: 20, default: 5 },
                capability: { type: 'string', maxLength: 160 },
                riskLevel: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
                source: { type: 'string', enum: ['builtin', 'mcp', 'api_operation'] },
                requireApproval: { type: 'boolean' }
            }, ['query']),
            output_schema: {
                type: 'object', required: ['query', 'candidates', 'totalAuthorizedTools'],
                properties: { query: { type: 'string' }, candidates: { type: 'array', items: { type: 'object' } }, totalAuthorizedTools: { type: 'integer' } }
            }
        },
        {
            name: 'tools.describe',
            title: '读取工具契约',
            cacheable: true,
            description: '根据 toolRef 读取一个已授权工具的完整输入输出契约、风险、权限和执行要求。',
            input_schema: asJsonSchema({
                toolRef: { type: 'object', properties: { toolName: { type: 'string' }, releaseId: { type: 'integer' }, definitionDigest: { type: 'string' } }, required: ['toolName'] }
            }, ['toolRef']),
            output_schema: { type: 'object', required: ['toolRef', 'name', 'inputSchema'], properties: { toolRef: { type: 'object' }, name: { type: 'string' }, inputSchema: { type: 'object' }, outputSchema: { type: 'object' } } }
        },
        {
            name: 'tools.execute',
            title: '执行已发现工具',
            description: '使用已确认的 toolRef 执行工具。目标工具会再次经过授权、风险、审批、连接、版本和输入输出契约检查。',
            input_schema: asJsonSchema({
                toolRef: { type: 'object', properties: { toolName: { type: 'string' }, releaseId: { type: 'integer' }, definitionDigest: { type: 'string' } }, required: ['toolName'] },
                input: { type: 'object' }
            }, ['toolRef', 'input'])
        },
        {
            name: 'tools.batch_read',
            title: '批量读取已发现工具',
            cacheable: false,
            description: '并行执行少量已确认的只读幂等工具。每个工具都必须先经 search 和 describe，并在每一次调用中继续通过权限、预算、审计与取消检查。',
            input_schema: asJsonSchema({
                calls: {
                    type: 'array', minItems: 1, maxItems: MAX_BATCH_READ_CALLS,
                    items: {
                        type: 'object',
                        properties: {
                            toolRef: { type: 'object', properties: { toolName: { type: 'string' }, releaseId: { type: 'integer' }, definitionDigest: { type: 'string' } }, required: ['toolName'] },
                            input: { type: 'object' }
                        },
                        required: ['toolRef', 'input']
                    }
                }
            }, ['calls'])
        }
    ];
}

async function executeToolDiscoveryMeta(name, input, user, context) {
    const state = context?.toolDiscoveryState;
    const {
        assertDescribed, assertSearched, getRememberedDescription, rememberDescription, rememberSearch
    } = require('./agent-tool-progressive-discovery');
    if (name === 'tools.search') {
        const { searchToolsForUser } = require('./tool-discovery');
        const value = await searchToolsForUser(user, input, {}, {
            toolPolicy: context.run?.tool_policy || context.run?.toolPolicy || 'all',
            toolAllowlist: context.run?.tool_allowlist || context.run?.toolAllowlist || null
        });
        rememberSearch(state, value);
        return { handled: true, value };
    }
    if (name === 'tools.describe') {
        const { describeToolForUser } = require('./tool-discovery');
        const reference = input.toolRef || input.tool_ref || {};
        assertSearched(state, reference);
        const cached = getRememberedDescription(state, reference);
        if (cached) return { handled: true, value: cached, cached: true };
        const value = await describeToolForUser(user, reference, {}, {
            toolPolicy: context.run?.tool_policy || context.run?.toolPolicy || 'all',
            toolAllowlist: context.run?.tool_allowlist || context.run?.toolAllowlist || null
        });
        rememberDescription(state, value.toolRef, value);
        return { handled: true, value };
    }
    if (name === 'tools.execute') {
        const { executeDiscoveredTool } = require('./tool-discovery');
        assertDescribed(state, input.toolRef || input.tool_ref || {});
        return { handled: true, value: await executeDiscoveredTool(user, input, context) };
    }
    if (name === 'tools.batch_read') {
        return { handled: true, value: await executeReadOnlyDiscoveredBatch(user, input.calls || [], context) };
    }
    return { handled: false, value: undefined };
}

module.exports = { executeReadOnlyDiscoveredBatch, executeToolDiscoveryMeta, getToolDiscoveryDefinitions, isReadOnlyDescription };
