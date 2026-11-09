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

function normalizeToolReference(input = {}) {
    return require('./tool-reference-input').canonicalReference(input);
}

async function executeReadOnlyDiscoveredBatch(user, calls, context = {}, deps = {}) {
    const items = Array.isArray(calls) ? calls : [];
    if (!items.length || items.length > MAX_BATCH_READ_CALLS) {
        throw batchReadError(`只读批处理必须包含 1 至 ${MAX_BATCH_READ_CALLS} 个调用。`);
    }
    const state = context?.toolDiscoveryState;
    const {
        assertDescribed, isDiscoveryRecoveryError
    } = require('./agent-tool-progressive-discovery');
    const discovery = require('./tool-discovery');
    const describeToolForUser = deps.toolDiscovery?.describeToolForUser || discovery.describeToolForUser;
    const executeDiscoveredTool = deps.toolDiscovery?.executeDiscoveredTool || discovery.executeDiscoveredTool;
    const listTools = deps.toolDiscovery?.formatToolList || require('./agent-tool-catalog').formatToolList;
    let catalogSnapshot = null;
    const scopedCatalog = { formatToolList: (actor, options) => {
        if (!catalogSnapshot) catalogSnapshot = Promise.resolve(listTools(actor, options))
            .then(tools => require('./agent-tool-discovery-scope').filterRunToolCatalog(tools, context.run || {}, actor));
        return catalogSnapshot;
    } };
    const descriptions = [];
    for (const item of items) {
        const reference = normalizeToolReference(item);
        let description;
        try {
            assertDescribed(state, reference);
            description = await describeToolForUser(user, reference, scopedCatalog, {
                toolPolicy: context.run?.tool_policy || context.run?.toolPolicy || 'all',
                toolAllowlist: context.run?.tool_allowlist || context.run?.toolAllowlist || null
            });
        } catch (error) {
            if (!isDiscoveryRecoveryError(error)) throw error;
            const contracts = [];
            for (const call of items) {
                const recovered = await recoverExecutionReference(normalizeToolReference(call), user, context, deps, error.code);
                contracts.push(recovered.contract);
            }
            return { type: 'tool_contract_required', executed: false, contracts, message: '已读取本批工具的当前契约，本批尚未执行。请核对参数与只读要求后重新提交调用。' };
        }
        if (!isReadOnlyDescription(description)) {
            throw batchReadError(`工具 ${description.name || reference.toolName || '-'} 不是可批处理的只读幂等工具。`, 'TOOL_BATCH_READ_FORBIDDEN', 409);
        }
        descriptions.push(description);
    }
    const { executeToolCallsInOrder } = require('./agent-tool-scheduler');
    const results = await executeToolCallsInOrder(items.map((item, index) => ({ tool: descriptions[index], item })), async entry => {
        const reference = normalizeToolReference(entry.item);
        try {
            return await executeDiscoveredTool(user, {
                toolRef: reference,
                input: entry.item.input && typeof entry.item.input === 'object' ? entry.item.input : {}
            }, { ...context, budgetAlreadyConsumed: false }, { ...deps.toolDiscovery, requireReadOnly: true });
        } catch (error) {
            if (require('./agent-execution-control').isExecutionControlError(error)
                || ['AGENT_POLICY_DENIED', 'TOOL_POLICY_DENIED', 'TOOL_BATCH_READ_FORBIDDEN'].includes(error.code)) throw error;
            const feedback = require('./tool-input-validation').toolInputFeedback(error);
            return { isError: true, code: error.code || 'TOOL_BATCH_ITEM_FAILED',
                message: '本项读取未完成，请核对工具状态与参数后单独重试。', ...(feedback ? { inputValidation: feedback } : {}) };
        }
    }, { signal: context.signal, maxReadConcurrency: context.maxReadConcurrency });
    const knowledgeEvidence = require('./knowledge-evidence-lineage').mergeKnowledgeEvidence(results);
    return {
        type: 'tools_batch_read',
        count: results.length,
        ...(results.some(output => output?.isError) ? { partial: true } : {}),
        ...(knowledgeEvidence ? { knowledgeEvidence } : {}),
        results: results.map((output, index) => ({ toolName: descriptions[index].name, output,
            executedTool: require('./agent-learning-tool-evidence').executedToolEvidence({ name: descriptions[index].name,
                idempotent: descriptions[index].idempotent, side_effect: descriptions[index].sideEffect,
                capabilities: descriptions[index].capabilities, risk_level: descriptions[index].riskLevel }, output) }))
    };
}

async function recoverExecutionReference(reference, user, context, deps, reason) {
    if (context.budgetAlreadyConsumed !== true) context.budget?.consumeTool?.({ name: 'tools.describe', risk_level: 1 });
    const described = await executeToolDiscoveryMeta('tools.describe', { toolRef: reference }, user, context, deps);
    return {
        type: 'tool_contract_required', executed: false, reason,
        toolRef: described.value.toolRef, contract: described.value,
        message: '已补充当前授权工具契约，本次尚未执行业务操作。请阅读输入、风险和审批要求，使用返回的 toolRef 与符合契约的参数再次调用；这些内部步骤不需要用户补充任务要求。'
    };
}

function getToolDiscoveryDefinitions(asJsonSchema) {
    return [
        {
            name: 'tools.search',
            title: '搜索可用工具',
            cacheable: true,
            description: '在当前用户已授权的工具目录中搜索少量候选工具；返回摘要和当前版本的 toolRef。首次通常只填 query 和 limit，不猜测来源、风险或能力筛选。空结果时按 searchFeedback 修正检索；有授权工具不等于关键词或筛选条件正确，不要直接要求用户重新授权。',
            input_schema: asJsonSchema({
                query: { type: 'string', minLength: 2, maxLength: 1000 },
                limit: { type: 'integer', minimum: 1, maximum: 20, default: 5 },
                capability: { type: 'string', maxLength: 160, description: '可选，精确匹配已从候选或 searchFeedback 取得的能力标识，如 network.request；不是任务描述。不确定时省略，把自然语言需求写入 query。' },
                riskLevel: { type: 'string', enum: require('./tool-discovery-filters').DISCOVERY_RISK_LEVELS, description: '可选，精确风险等级，low=1、medium=3、high=4、critical=5，并非风险上限；不确定时省略。' },
                source: { type: 'string', enum: ['builtin', 'mcp', 'api_operation'], description: '可选，精确工具来源。不知道当前工具来源时省略，不默认限定为 builtin。' },
                requireApproval: { type: 'boolean', description: '可选，true 仅查找需审批工具；省略或 false 不限定审批属性，实际执行仍严格审批。' }
            }, ['query']),
            output_schema: {
                type: 'object', required: ['query', 'candidates', 'totalAuthorizedTools'],
                properties: {
                    query: { type: 'string' },
                    candidates: { type: 'array', items: { type: 'object' } },
                    totalAuthorizedTools: { type: 'integer' },
                    catalogVersion: { type: 'string', pattern: '^[a-f0-9]{64}$', description: '当前授权目录、发布版本和工具契约的不可逆摘要；变化时旧发现状态失效。' },
                    searchFeedback: { type: 'object', description: '空结果原因和当前授权范围内的可用筛选值；仅供修正检索，不会放宽权限或执行工具。' }
                }
            }
        },
        {
            name: 'tools.describe',
            title: '读取工具契约',
            cacheable: true,
            description: '读取已授权工具的完整输入输出契约、风险、权限和执行要求。需要多个工具时优先用 toolRefs 一次读取至多8个契约，避免逐个往返；单个引用仍可用 toolRef。旧引用会刷新，随后执行必须使用本次返回的 toolRef，不要猜测版本或摘要。本工具只读契约，不执行业务。',
            input_schema: asJsonSchema({
                toolRef: { type: 'object', properties: { toolName: { type: 'string' }, releaseId: { type: ['integer', 'null'] }, definitionDigest: { type: 'string' } }, required: ['toolName'] },
                toolName: { type: 'string' },
                toolRefs: { type: 'array', minItems: 1, maxItems: require('./agent-tool-descriptions').MAX_DESCRIBE_TOOLS,
                    description: '批量读取时只需本字段；使用 search 返回的引用，按输入顺序返回契约，每项仍计入工具预算。同名单个引用会去重，版本或摘要冲突则拒绝。',
                    items: { type: 'object', properties: { toolName: { type: 'string' }, releaseId: { type: ['integer', 'null'] }, definitionDigest: { type: 'string' } }, required: ['toolName'] } }
            }, []),
            output_schema: { type: 'object', anyOf: [{ required: ['toolRef', 'name', 'inputSchema'] }, { required: ['type', 'count', 'descriptions'] }, { required: ['type', 'executed', 'reason', 'message'] }], properties: { toolRef: { type: 'object' }, name: { type: 'string' }, inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, referenceRefresh: { type: 'object' }, type: { type: 'string' }, count: { type: 'integer', minimum: 1, maximum: 8 }, descriptions: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'object' } }, executed: { type: 'boolean' }, reason: { type: 'string' }, message: { type: 'string' }, candidates: { type: 'array' } } }
        },
        {
            name: 'tools.execute',
            title: '执行已发现工具',
            description: '使用已确认的 toolRef 执行工具。若尚未读取契约或发现状态失效，先返回 executed:false 和当前契约供你确认；该次不会执行业务操作。目标工具继续经过授权、风险、审批、连接、版本和输入输出契约检查。',
            input_schema: asJsonSchema({
                toolRef: { type: 'object', properties: { toolName: { type: 'string' }, releaseId: { type: ['integer', 'null'] }, definitionDigest: { type: 'string' } }, required: ['toolName'] },
                toolName: { type: 'string' },
                input: { type: 'object' }
            }, [])
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
                            toolRef: { type: 'object', properties: { toolName: { type: 'string' }, releaseId: { type: ['integer', 'null'] }, definitionDigest: { type: 'string' } }, required: ['toolName'] },
                            input: { type: 'object' }
                        },
                        required: ['toolRef', 'input']
                    }
                }
            }, ['calls'])
        }
    ];
}

async function executeToolDiscoveryMeta(name, input, user, context = {}, deps = {}) {
    if (['tools.search', 'tools.describe', 'tools.execute', 'tools.batch_read'].includes(name)) {
        await require('./agent-tool-discovery-scope').refreshDiscoveryScope(context.run || {}, user, deps);
    }
    const state = context?.toolDiscoveryState;
    const {
        assertDescribed, isDiscoveryRecoveryError, rememberSearch
    } = require('./agent-tool-progressive-discovery');
    if (name === 'tools.search') {
        const { searchToolsForUser } = require('./tool-discovery');
        const { filterRunToolCatalog } = require('./agent-tool-discovery-scope');
        const listTools = deps.toolDiscovery?.formatToolList || require('./agent-tool-catalog').formatToolList;
        const value = await searchToolsForUser(user, input, {
            formatToolList: async (actor, options) => filterRunToolCatalog(await listTools(actor, options), context.run || {}, actor)
        }, {
            toolPolicy: context.run?.tool_policy || context.run?.toolPolicy || 'all',
            toolAllowlist: context.run?.tool_allowlist || context.run?.toolAllowlist || null,
            // 缓存仅附着当前 Run 的发现状态；每次检索仍先重建用户当前可见
            // 目录并以授权/发布摘要比对，绝不将缓存当成授权事实来源。
            discoveryCache: state?.searchCache,
            cacheTtlMs: state?.ttlMs,
            now: state?.now
        });
        rememberSearch(state, value);
        require('./agent-discovery-progress').recordDiscoverySearch(state, value, context.run || {});
        return { handled: true, value };
    }
    if (name === 'tools.describe') {
        const { describeAuthorizedTools, normalizeDescriptionReferences } = require('./agent-tool-descriptions');
        if (Object.hasOwn(input, 'toolRefs')) {
            const references = normalizeDescriptionReferences(input);
            // 外层已为本次元工具记一次；批量的其余契约仍逐项消耗相同预算。
            for (let index = 1; index < references.length; index++) context.budget?.consumeTool?.({ name, risk_level: 1 });
            const descriptions = await describeAuthorizedTools(references, user, context, deps);
            return { handled: true, value: { type: 'tools_descriptions', executed: false, count: descriptions.length, descriptions } };
        }
        const reference = normalizeToolReference(input);
        if (!reference.toolName) return { handled: true, value: require('./tool-reference-input').missingReferenceResult(state) };
        const [value] = await describeAuthorizedTools([reference], user, context, deps);
        return { handled: true, value };
    }
    if (name === 'tools.execute') {
        const { executeDiscoveredTool } = require('./tool-discovery');
        const reference = normalizeToolReference(input);
        if (!reference.toolName) return { handled: true, value: require('./tool-reference-input').missingReferenceResult(state) };
        const effectiveInput = {
            ...input,
            toolRef: reference,
            input: input?.input && typeof input.input === 'object' ? input.input : {}
        };
        if (context.discoveryRequired) {
            return { handled: true, value: await recoverExecutionReference(reference, user, context, deps, context.discoveryRequired) };
        }
        try { assertDescribed(state, reference); }
        catch (error) {
            if (!isDiscoveryRecoveryError(error)) throw error;
            return { handled: true, value: await recoverExecutionReference(reference, user, context, deps, error.code) };
        }
        const execute = deps.toolDiscovery?.executeDiscoveredTool || executeDiscoveredTool;
        try {
            const value = await execute(user, effectiveInput, context);
            if (state) state.searchProgress = null;
            return { handled: true, value };
        }
        catch (error) {
            // 只有执行前的引用校验失败可恢复，业务工具自身的同名错误不能触发重试。
            if (error.code !== 'TOOL_REFERENCE_STALE' || error.referenceRejected !== true) throw error;
            return { handled: true, value: await recoverExecutionReference(reference, user, context, deps, error.code) };
        }
    }
    if (name === 'tools.batch_read') {
        return { handled: true, value: await executeReadOnlyDiscoveredBatch(user, input.calls || [], context, deps) };
    }
    return { handled: false, value: undefined };
}

module.exports = { executeReadOnlyDiscoveredBatch, executeToolDiscoveryMeta, getToolDiscoveryDefinitions, isReadOnlyDescription, normalizeToolReference };
