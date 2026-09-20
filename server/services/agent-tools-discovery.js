'use strict';

/** Small progressive-disclosure meta tools kept outside the core built-in catalog. */
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
        }
    ];
}

async function executeToolDiscoveryMeta(name, input, user, context) {
    const state = context?.toolDiscoveryState;
    const {
        assertDescribed, assertSearched, rememberDescription, rememberSearch
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
        const value = await describeToolForUser(user, reference, {}, {
            toolPolicy: context.run?.tool_policy || context.run?.toolPolicy || 'all',
            toolAllowlist: context.run?.tool_allowlist || context.run?.toolAllowlist || null
        });
        rememberDescription(state, value.toolRef);
        return { handled: true, value };
    }
    if (name === 'tools.execute') {
        const { executeDiscoveredTool } = require('./tool-discovery');
        assertDescribed(state, input.toolRef || input.tool_ref || {});
        return { handled: true, value: await executeDiscoveredTool(user, input, context) };
    }
    return { handled: false, value: undefined };
}

module.exports = { executeToolDiscoveryMeta, getToolDiscoveryDefinitions };
