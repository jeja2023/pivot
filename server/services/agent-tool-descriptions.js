'use strict';

const { canonicalReference } = require('./tool-reference-input');
const { assertSearched, rememberSearch, rememberDescription } = require('./agent-tool-progressive-discovery');
const MAX_DESCRIBE_TOOLS = 8;

function normalizeDescriptionReferences(input) {
    if (!Array.isArray(input.toolRefs) || !input.toolRefs.length || input.toolRefs.length > MAX_DESCRIBE_TOOLS) {
        throw Object.assign(new Error(`批量读取契约必须传入 1 至 ${MAX_DESCRIBE_TOOLS} 个 toolRefs。`),
            { code: 'TOOL_DISCOVERY_DESCRIBE_BATCH_INVALID', status: 400, category: 'validation' });
    }
    const references = input.toolRefs.map(reference => canonicalReference({ toolRef: reference }));
    const single = canonicalReference(input);
    if (single.toolName) references.push(single);
    const unique = new Map();
    for (const reference of references) {
        if (!reference.toolName) throw Object.assign(new Error('批量契约引用必须包含 toolName，请使用搜索返回的引用。'),
            { code: 'TOOL_DISCOVERY_DESCRIBE_BATCH_INVALID', status: 400, category: 'validation' });
        const prior = unique.get(reference.toolName);
        // 模型可能同时填写单个和批量字段；只合并同名且无冲突的引用，不猜测版本或摘要。
        unique.set(reference.toolName, prior ? canonicalReference({ toolRef: prior, reference }) : reference);
    }
    if (unique.size > MAX_DESCRIBE_TOOLS) {
        throw Object.assign(new Error(`批量契约最多读取 ${MAX_DESCRIBE_TOOLS} 个工具，请减少引用后重试。`),
            { code: 'TOOL_DISCOVERY_DESCRIBE_BATCH_INVALID', status: 400, category: 'validation' });
    }
    return [...unique.values()];
}

async function describeAuthorizedTools(references, user, context, deps = {}) {
    const { catalogVersion, describeToolForUser } = require('./tool-discovery');
    const { filterRunToolCatalog } = require('./agent-tool-discovery-scope');
    const state = context.toolDiscoveryState;
    const searchReasons = references.map(reference => {
        try { assertSearched(state, reference); return ''; }
        catch (error) {
            if (!['TOOL_DISCOVERY_SEARCH_REQUIRED', 'TOOL_DISCOVERY_SEARCH_EXPIRED'].includes(error.code)) throw error;
            return error.code === 'TOOL_DISCOVERY_SEARCH_EXPIRED' ? error.code : '';
        }
    });
    const options = { toolPolicy: context.run?.tool_policy || context.run?.toolPolicy || 'all',
        toolAllowlist: context.run?.tool_allowlist || context.run?.toolAllowlist || null };
    const listTools = deps.toolDiscovery?.formatToolList || require('./agent-tool-catalog').formatToolList;
    const tools = filterRunToolCatalog(await listTools(user, options), context.run || {}, user)
        .filter(tool => !String(tool.name || '').startsWith('tools.'));
    const describe = deps.toolDiscovery?.describeToolForUser || describeToolForUser;
    const snapshot = { formatToolList: async () => tools };
    const version = catalogVersion(user, tools, {}, options);
    // 目录变化先撤销旧发现状态；新契约只在整批读取成功后记忆。
    rememberSearch(state, { catalogVersion: version });
    const values = [];
    for (const [index, reference] of references.entries()) {
        context.signal?.throwIfAborted();
        let reason = searchReasons[index];
        let value;
        try { value = await describe(user, reference, snapshot, options); }
        catch (error) {
            if (error.code !== 'TOOL_REFERENCE_STALE') throw error;
            reason = error.code;
            value = await describe(user, { toolName: reference.toolName }, snapshot, options);
        }
        if (reason) value = { ...value, referenceRefresh: { reason, previousToolRef: { ...reference },
            message: '已读取当前授权工具的最新契约。请核对输入、风险和审批要求，并使用本次返回的 toolRef 执行。' } };
        values.push(value);
    }
    // 全部通过预检才记忆契约；任一引用不可见或取消都不留下半批可执行的发现状态。
    context.signal?.throwIfAborted();
    rememberSearch(state, { catalogVersion: version, candidates: values.map(value => ({ toolRef: value.toolRef })) });
    for (const value of values) rememberDescription(state, value.toolRef, value);
    return values;
}

module.exports = { MAX_DESCRIBE_TOOLS, describeAuthorizedTools, normalizeDescriptionReferences };
