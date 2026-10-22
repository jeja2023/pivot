'use strict';

/** Progressive tool discovery for model contexts. */
const crypto = require('crypto');
const { formatToolList } = require('./agent-tool-catalog');
const { getCapabilityDefinition } = require('./agent-capability-registry');

const DEFAULT_DISCOVERY_CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_DISCOVERY_CACHE_ENTRIES = 100;

function normalizeTerms(value) {
    const source = String(value || '').toLowerCase();
    const words = source
        .split(/[\s,，。；;、/\\|()[\]{}]+/)
        .map(item => item.trim())
        .filter(item => item.length > 1);
    const cjkBigrams = [...source.matchAll(/[\u3400-\u9fff]{2,}/g)]
        .flatMap(match => Array.from(match[0]).map((_char, index, chars) => chars.slice(index, index + 2).join('')).filter(item => item.length === 2));
    return [...new Set([...words, ...cjkBigrams])].slice(0, 30);
}

function matchesFilters(tool, filters = {}) {
    const risk = String(filters.riskLevel || filters.risk_level || '').trim();
    if (risk && String(tool.risk_level || tool.risk || '') !== risk) return false;
    const source = String(filters.source || '').trim();
    if (source && String(tool.source || '') !== source) return false;
    const capability = String(filters.capability || '').trim();
    if (capability && !(tool.capabilities || []).some(item => String(item) === capability)) return false;
    const requireApproval = filters.requireApproval ?? filters.require_approval;
    if (requireApproval === true && !Boolean(tool.approval_required || tool.requiresApproval)) return false;
    return true;
}

function rankTools(query, tools = [], filters = {}) {
    const keywords = normalizeTerms(query);
    return (tools || []).filter(tool => matchesFilters(tool, filters)).map(tool => {
        const capTitles = (tool.capabilities || []).map(cap => getCapabilityDefinition(cap)?.title || '').filter(Boolean);
        const corpus = [tool.name, tool.title, tool.description, tool.serverName, ...(tool.capabilities || []), ...capTitles].join(' ').toLowerCase();
        const matchedTerms = keywords.filter(term => corpus.includes(term));
        const title = `${tool.title || ''} ${tool.name || ''}`.toLowerCase();
        const score = matchedTerms.length + matchedTerms.filter(term => title.includes(term)).length * 0.5;
        return { tool, score, matchedTerms };
    }).filter(item => item.score > 0).sort((left, right) => right.score - left.score || String(left.tool.name).localeCompare(String(right.tool.name)));
}

function toolRef(tool = {}) {
    return {
        toolName: tool.name || tool.fullName || '',
        releaseId: tool.catalogReleaseId || null,
        definitionDigest: tool.definitionDigest || tool.definition_digest || crypto.createHash('sha256').update(JSON.stringify({
            name: tool.name || tool.fullName || '', version: tool.version || '',
            inputSchema: tool.input_schema || tool.inputSchema || {}, outputSchema: tool.output_schema || tool.outputSchema || {},
            capabilities: tool.capabilities || [], risk: tool.risk_level || tool.risk || '', source: tool.source || ''
        })).digest('hex')
    };
}

function toSummary(entry = {}) {
    const tool = entry.tool || entry;
    return {
        toolRef: toolRef(tool),
        title: tool.title || tool.name,
        description: String(tool.description || '').slice(0, 800),
        source: tool.source || 'builtin',
        serverName: tool.serverName || '',
        riskLevel: tool.risk_level || tool.risk || 'low',
        capabilities: tool.capabilities || [],
        requiresApproval: Boolean(tool.approval_required || tool.requiresApproval),
        requiresConnection: Boolean(tool.authScopes?.length),
        score: entry.score ?? null,
        reason: entry.matchedTerms?.length ? `命中：${entry.matchedTerms.slice(0, 8).join('、')}` : ''
    };
}

function catalogOptions(input = {}, options = {}) {
    return {
        toolPolicy: options.toolPolicy || options.tool_policy || input.toolPolicy || input.tool_policy,
        toolAllowlist: options.toolAllowlist || options.tool_allowlist || input.toolAllowlist || input.tool_allowlist
    };
}

function stableJson(value) {
    if (Array.isArray(value)) return `[${value.map(item => stableJson(item)).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value ?? null);
}

function digest(value) {
    return crypto.createHash('sha256').update(stableJson(value)).digest('hex');
}

function normalizedDiscoveryScope(user = {}, input = {}, options = {}) {
    const catalog = catalogOptions(input, options);
    return {
        userId: String(user?.id || ''),
        role: String(user?.role || ''),
        toolPolicy: String(catalog.toolPolicy || 'all'),
        toolAllowlist: Array.isArray(catalog.toolAllowlist) ? [...new Set(catalog.toolAllowlist.map(String))].sort() : []
    };
}

function catalogVersion(user, tools = [], input = {}, options = {}) {
    const refs = (tools || [])
        .filter(tool => !String(tool?.name || '').startsWith('tools.'))
        .map(tool => ({
            reference: toolRef(tool),
            source: String(tool?.source || 'builtin'),
            riskLevel: String(tool?.risk_level || tool?.risk || 'low'),
            approvalRequired: Boolean(tool?.approval_required || tool?.requiresApproval || tool?.alwaysRequiresApproval),
            sideEffect: Boolean(tool?.side_effect),
            idempotent: Boolean(tool?.idempotent),
            concurrency: String(tool?.concurrency || 'read'),
            network: Boolean(tool?.network),
            capabilities: Array.isArray(tool?.capabilities) ? [...tool.capabilities].map(String).sort() : [],
            authScopes: Array.isArray(tool?.authScopes) ? [...tool.authScopes].map(String).sort() : [],
            databaseConnections: Array.isArray(tool?.databaseConnections)
                ? tool.databaseConnections.map(item => String(item?.fullName || item?.serverId || '')).filter(Boolean).sort()
                : []
        }))
        .sort((left, right) => `${left.reference.toolName}|${left.reference.releaseId}|${left.reference.definitionDigest}`.localeCompare(`${right.reference.toolName}|${right.reference.releaseId}|${right.reference.definitionDigest}`));
    return digest({ scope: normalizedDiscoveryScope(user, input, options), refs });
}

function discoveryCacheTtl(options = {}) {
    return Math.min(Math.max(Number(options.cacheTtlMs ?? options.cache_ttl_ms) || DEFAULT_DISCOVERY_CACHE_TTL_MS, 1_000), 30 * 60 * 1000);
}

function discoveryCacheKey(input = {}, version = '', scope = {}) {
    return digest({
        version,
        scope,
        query: String(input.query || '').trim(),
        limit: Math.min(Math.max(Number(input.limit) || 5, 1), 20),
        filters: input.filters && typeof input.filters === 'object' ? input.filters : {
            capability: input.capability || '', riskLevel: input.riskLevel || input.risk_level || '', source: input.source || '',
            requireApproval: input.requireApproval ?? input.require_approval ?? null
        }
    });
}

function cloneDiscoveryValue(value) {
    return JSON.parse(JSON.stringify(value));
}

function readSearchCache(cache, key, now) {
    if (!(cache instanceof Map)) return null;
    const entry = cache.get(key);
    if (!entry) return null;
    if (Number(entry.expiresAt || 0) <= now) {
        cache.delete(key);
        return null;
    }
    return cloneDiscoveryValue(entry.value);
}

function writeSearchCache(cache, key, value, now, ttlMs) {
    if (!(cache instanceof Map)) return;
    cache.set(key, { value: cloneDiscoveryValue(value), expiresAt: now + ttlMs });
    while (cache.size > MAX_DISCOVERY_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
}

async function searchToolsForUser(user, input = {}, deps = {}, options = {}) {
    const listTools = deps.formatToolList || formatToolList;
    const rank = deps.rankTools || rankTools;
    const query = String(input.query || '').trim();
    if (!query) {
        const error = new Error('请提供工具搜索关键词。'); error.status = 400; throw error;
    }
    const limit = Math.min(Math.max(Number(input.limit) || 5, 1), 20);
    const tools = await listTools(user, catalogOptions(input, options));
    // 先重新解析当前用户可见目录，再用其授权/发布摘要命中缓存。缓存永远不是授权
    // 决策来源：权限、allowlist 或 release/digest 改变时 catalogVersion 会变化而立即失效。
    const version = catalogVersion(user, tools, input, options);
    const scope = normalizedDiscoveryScope(user, input, options);
    const cacheKey = discoveryCacheKey(input, version, scope);
    const nowValue = Number(options.now?.()) || Date.now();
    const cache = options.discoveryCache || options.discovery_cache;
    const cached = readSearchCache(cache, cacheKey, nowValue);
    if (cached) return cached;
    const value = {
        query,
        candidates: rank(query, tools.filter(tool => !String(tool?.name || '').startsWith('tools.')), input.filters || input).slice(0, limit).map(toSummary),
        totalAuthorizedTools: tools.filter(tool => !String(tool?.name || '').startsWith('tools.')).length,
        catalogVersion: version
    };
    writeSearchCache(cache, cacheKey, value, nowValue, discoveryCacheTtl(options));
    return value;
}

async function describeToolForUser(user, reference = {}, deps = {}, options = {}) {
    const listTools = deps.formatToolList || formatToolList;
    const toolName = String(reference.toolName || reference.tool_name || reference.name || '').trim();
    if (!toolName) {
        const error = new Error('请提供 toolRef.toolName。'); error.status = 400; throw error;
    }
    const tools = await listTools(user, catalogOptions({}, options));
    const tool = tools.find(item => item.name === toolName || item.fullName === toolName);
    if (!tool) {
        const error = new Error('工具不存在或无权访问。'); error.status = 404; throw error;
    }
    const resolvedRef = toolRef(tool);
    const expectedRelease = reference.releaseId ?? reference.release_id;
    if (expectedRelease != null && String(expectedRelease) !== String(resolvedRef.releaseId ?? '')) {
        const error = new Error('工具发布版本已更新，请重新搜索并确认最新版本。'); error.status = 409; error.code = 'TOOL_REFERENCE_STALE'; throw error;
    }
    const expectedDigest = String(reference.definitionDigest || reference.definition_digest || '').trim();
    if (expectedDigest && expectedDigest !== resolvedRef.definitionDigest) {
        const error = new Error('工具定义已更新，请重新搜索并确认最新版本。'); error.status = 409; error.code = 'TOOL_REFERENCE_STALE'; throw error;
    }
    return {
        toolRef: resolvedRef, name: tool.name, title: tool.title || tool.name, description: tool.description || '',
        inputSchema: tool.input_schema || tool.inputSchema || {}, outputSchema: tool.output_schema || tool.outputSchema || {},
        capabilities: tool.capabilities || [], riskLevel: tool.risk_level || tool.risk || 'low',
        idempotent: Boolean(tool.idempotent), sideEffect: Boolean(tool.side_effect), cacheable: Boolean(tool.cacheable),
        cancellable: Boolean(tool.cancellable), network: Boolean(tool.network), concurrency: tool.concurrency || 'read',
        timeout: tool.timeout || {}, requiresApproval: Boolean(tool.approval_required || tool.requiresApproval),
        serverName: tool.serverName || '', connectionRequirements: tool.authScopes || []
    };
}

async function executeDiscoveredTool(user, input = {}, context = {}, deps = {}) {
    const reference = input.toolRef || input.tool_ref || {};
    const runOptions = {
        toolPolicy: context.run?.tool_policy || context.run?.toolPolicy || 'all',
        toolAllowlist: context.run?.tool_allowlist || context.run?.toolAllowlist || null
    };
    const tools = await (deps.formatToolList || formatToolList)(user, catalogOptions({}, runOptions));
    const description = await describeToolForUser(user, reference, { formatToolList: async () => tools }, runOptions);
    if (String(description.name).startsWith('tools.')) {
        const error = new Error('工具发现元工具不能递归执行。'); error.status = 400; error.code = 'TOOL_META_RECURSION_FORBIDDEN'; throw error;
    }
    if (deps.requireReadOnly && !require('./agent-tools-discovery').isReadOnlyDescription(description)) {
        const error = new Error('工具当前不是可批处理的只读幂等工具。');
        error.status = 409; error.code = 'TOOL_BATCH_READ_FORBIDDEN'; throw error;
    }
    const executeToolByName = deps.executeToolByName || require('./agent-tool-runtime').executeToolByName;
    return await executeToolByName(description.name, input.input && typeof input.input === 'object' ? input.input : {}, user, tools, {
        ...context,
        source: context.source || 'agent',
        entrypoint: 'tool_meta_execute',
        discoveredExecution: true,
        releaseId: description.toolRef.releaseId,
        definitionDigest: description.toolRef.definitionDigest
    });
}

module.exports = {
    catalogVersion,
    describeToolForUser,
    executeDiscoveredTool,
    rankTools,
    searchToolsForUser,
    toolRef
};
