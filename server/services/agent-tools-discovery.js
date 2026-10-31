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
    if (!input) return {};
    if (typeof input === 'string') return { toolName: input.trim() };
    const candidate = input.toolRef || input.tool_ref || input.reference || (input.toolName || input.tool_name || input.name ? input : null);
    if (typeof candidate === 'string') return { toolName: candidate.trim() };
    if (candidate && typeof candidate === 'object') {
        const toolName = String(candidate.toolName || candidate.tool_name || candidate.name || '').trim();
        const releaseId = candidate.releaseId ?? candidate.release_id ?? null;
        const definitionDigest = String(candidate.definitionDigest || candidate.definition_digest || '').trim();
        return {
            toolName,
            ...(releaseId !== null && releaseId !== undefined && releaseId !== '' ? { releaseId: Number(releaseId) } : {}),
            ...(definitionDigest ? { definitionDigest } : {})
        };
    }
    return {};
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
        return await executeDiscoveredTool(user, {
            toolRef: reference,
            input: entry.item.input && typeof entry.item.input === 'object' ? entry.item.input : {}
        }, { ...context, budgetAlreadyConsumed: false }, { ...deps.toolDiscovery, requireReadOnly: true });
    }, { signal: context.signal, maxReadConcurrency: context.maxReadConcurrency });
    return {
        type: 'tools_batch_read',
        count: results.length,
        results: results.map((output, index) => ({ toolName: descriptions[index].name, output }))
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
            description: '在当前用户已授权的工具目录中按任务、能力和风险搜索少量候选工具；返回摘要和当前版本的 toolRef，不加载全部完整 Schema。',
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
                properties: {
                    query: { type: 'string' },
                    candidates: { type: 'array', items: { type: 'object' } },
                    totalAuthorizedTools: { type: 'integer' },
                    catalogVersion: { type: 'string', pattern: '^[a-f0-9]{64}$', description: '当前授权目录、发布版本和工具契约的不可逆摘要；变化时旧发现状态失效。' }
                }
            }
        },
        {
            name: 'tools.describe',
            title: '读取工具契约',
            cacheable: true,
            description: '根据 toolRef 读取一个已授权工具的完整输入输出契约、风险、权限和执行要求。旧引用或发现状态过期时会刷新并返回最新契约，随后执行必须使用本次返回的 toolRef，不要猜测 releaseId 或 definitionDigest。',
            input_schema: asJsonSchema({
                toolRef: { type: 'object', properties: { toolName: { type: 'string' }, releaseId: { type: ['integer', 'null'] }, definitionDigest: { type: 'string' } }, required: ['toolName'] },
                toolName: { type: 'string' }
            }, []),
            output_schema: { type: 'object', required: ['toolRef', 'name', 'inputSchema'], properties: { toolRef: { type: 'object' }, name: { type: 'string' }, inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, referenceRefresh: { type: 'object' } } }
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
        assertDescribed, assertSearched, isDiscoveryRecoveryError, rememberDescription, rememberSearch
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
        const { catalogVersion, describeToolForUser } = require('./tool-discovery');
        const reference = normalizeToolReference(input);
        let refreshReason = '';
        try {
            assertSearched(state, reference);
        } catch (searchErr) {
            if (!['TOOL_DISCOVERY_SEARCH_REQUIRED', 'TOOL_DISCOVERY_SEARCH_EXPIRED'].includes(searchErr?.code)) throw searchErr;
            if (searchErr.code === 'TOOL_DISCOVERY_SEARCH_EXPIRED') refreshReason = searchErr.code;
        }
        const options = {
            toolPolicy: context.run?.tool_policy || context.run?.toolPolicy || 'all',
            toolAllowlist: context.run?.tool_allowlist || context.run?.toolAllowlist || null
        };
        // 读取契约允许恢复旧引用，但必须先重建当前授权目录。固定这一次快照，
        // 避免刷新过程中发布切换造成无限重试；execute 仍严格验证模型确认的引用。
        const listTools = deps.toolDiscovery?.formatToolList || require('./agent-tool-catalog').formatToolList;
        const tools = require('./agent-tool-discovery-scope').filterRunToolCatalog(await listTools(user, options), context.run || {}, user)
            .filter(tool => !String(tool.name || '').startsWith('tools.'));
        rememberSearch(state, { catalogVersion: catalogVersion(user, tools, {}, options) });
        const describe = deps.toolDiscovery?.describeToolForUser || describeToolForUser;
        const snapshot = { formatToolList: async () => tools };
        let value;
        try {
            value = await describe(user, reference, snapshot, options);
        } catch (error) {
            if (error.code !== 'TOOL_REFERENCE_STALE') throw error;
            refreshReason = error.code;
            value = await describe(user, { toolName: reference.toolName }, snapshot, options);
        }
        if (refreshReason) {
            value = {
                ...value,
                referenceRefresh: {
                    reason: refreshReason, previousToolRef: { ...reference },
                    message: '已读取当前授权工具的最新契约。请核对输入、风险和审批要求，并使用本次返回的 toolRef 执行。'
                }
            };
        }
        rememberSearch(state, { candidates: [{ toolRef: value.toolRef }] });
        rememberDescription(state, value.toolRef, value);
        return { handled: true, value };
    }
    if (name === 'tools.execute') {
        const { executeDiscoveredTool } = require('./tool-discovery');
        const reference = normalizeToolReference(input);
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
