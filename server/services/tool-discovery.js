'use strict';

/** Progressive tool discovery for model contexts. */
const crypto = require('crypto');
const { formatToolList } = require('./agent-tool-catalog');
const { getCapabilityDefinition } = require('./agent-capability-registry');

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

async function searchToolsForUser(user, input = {}, deps = {}, options = {}) {
    const listTools = deps.formatToolList || formatToolList;
    const query = String(input.query || '').trim();
    if (!query) {
        const error = new Error('请提供工具搜索关键词。'); error.status = 400; throw error;
    }
    const limit = Math.min(Math.max(Number(input.limit) || 5, 1), 20);
    const tools = await listTools(user, catalogOptions(input, options));
    return {
        query,
        candidates: rankTools(query, tools.filter(tool => !String(tool?.name || '').startsWith('tools.')), input.filters || input).slice(0, limit).map(toSummary),
        totalAuthorizedTools: tools.filter(tool => !String(tool?.name || '').startsWith('tools.')).length
    };
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
    const description = await describeToolForUser(user, reference, deps, runOptions);
    if (String(description.name).startsWith('tools.')) {
        const error = new Error('工具发现元工具不能递归执行。'); error.status = 400; error.code = 'TOOL_META_RECURSION_FORBIDDEN'; throw error;
    }
    const { executeToolByName } = require('./agent-tool-runtime');
    const tools = await (deps.formatToolList || formatToolList)(user, runOptions);
    return await executeToolByName(description.name, input.input && typeof input.input === 'object' ? input.input : {}, user, tools, {
        ...context,
        source: context.source || 'agent',
        entrypoint: 'tool_meta_execute',
        discoveredExecution: true,
        releaseId: description.toolRef.releaseId,
        definitionDigest: description.toolRef.definitionDigest
    });
}

module.exports = { describeToolForUser, executeDiscoveredTool, rankTools, searchToolsForUser, toolRef };
