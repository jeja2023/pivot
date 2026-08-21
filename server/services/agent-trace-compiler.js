const crypto = require('crypto');

function parseValue(value) {
    if (value && typeof value === 'object') return value;
    try { return value ? JSON.parse(value) : {}; } catch (_) { return value || {}; }
}

function inputHash(input) { return crypto.createHash('sha256').update(JSON.stringify(input || {})).digest('hex'); }

function normalizeTrace(toolCalls = [], options = {}) {
    const calls = (Array.isArray(toolCalls) ? toolCalls : []).map((call, index) => ({
        ...call,
        index,
        tool_name: String(call.tool_name || call.toolName || call.tool || '').trim(),
        input_payload: parseValue(call.input_payload ?? call.input ?? {}),
        output_payload: parseValue(call.output_payload ?? call.output ?? {}),
        status: String(call.status || 'success'),
        idempotent: Boolean(call.idempotent),
        input_hash: call.input_hash || inputHash(call.input_payload ?? call.input ?? {})
    })).filter(call => call.tool_name);
    const successfulHashes = new Set(calls.filter(call => ['success', 'completed'].includes(call.status)).map(call => `${call.tool_name}:${call.input_hash}`));
    const normalized = [];
    calls.forEach(call => {
        const key = `${call.tool_name}:${call.input_hash}`;
        if (['error', 'failed'].includes(call.status) && successfulHashes.has(key)) return;
        if (options.filterExploration !== false && !call.side_effect && /(?:list|describe|schema|metadata|inspect|head|probe|count)/i.test(call.tool_name) && !call.downstreamUsed) return;
        if (normalized.some(item => item.tool_name === call.tool_name && item.input_hash === call.input_hash && item.status === call.status)) return;
        normalized.push(call);
    });
    return normalized.map((call, index) => ({ ...call, normalized_index: index }));
}

function extractSemanticSteps(calls = []) {
    return calls.map((call, index) => ({
        id: `step_${index + 1}`,
        title: call.title || call.tool_name,
        tool: call.tool_name,
        input: call.input_payload || {},
        outputSchema: call.output_schema || undefined,
        dependsOn: referencedNodeIds(call.input_payload || {}, index),
        condition: call.condition || 'success',
        forEach: call.forEach || call.foreach || undefined,
        approvalRequired: Boolean(call.approval_required || call.approvalRequired || call.policy_decision === 'approval_required' || Number(call.risk_level || call.riskLevel || 0) >= 5),
        sideEffect: Boolean(call.side_effect || call.sideEffect),
        idempotent: Boolean(call.idempotent),
        riskLevel: Number(call.risk_level || call.riskLevel || 0) || undefined,
        retryLimit: call.retryLimit || 0,
        sourceTraceId: call.id || null
    }));
}

function referencedNodeIds(value, index) {
    const found = new Set();
    const scan = item => {
        if (typeof item === 'string') {
            const pattern = /\{\{\s*nodes\.([a-zA-Z0-9._-]+)(?:\.|\s|\}|$)/g;
            let match;
            while ((match = pattern.exec(item))) found.add(match[1]);
        } else if (Array.isArray(item)) item.forEach(scan);
        else if (item && typeof item === 'object') Object.values(item).forEach(scan);
    };
    scan(value);
    if (!found.size && index > 0) found.add(`step_${index}`);
    return [...found].filter(id => id !== `step_${index + 1}`);
}

function parameterize(value, variables = {}) {
    if (typeof value === 'string') {
        let result = value;
        Object.entries(variables).forEach(([name, original]) => {
            if (typeof original === 'string' && original.length > 2) result = result.split(original).join(`{{inputs.${name}}}`);
        });
        return result;
    }
    if (Array.isArray(value)) return value.map(item => parameterize(item, variables));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, parameterize(item, variables)]));
    return value;
}

function compileTraceToWorkflow(toolCalls, options = {}) {
    const normalized = normalizeTrace(toolCalls, options);
    const variables = options.variables && typeof options.variables === 'object' ? options.variables : {};
    const steps = extractSemanticSteps(normalized).map(step => ({ ...step, input: parameterize(step.input, variables) }));
    return {
        version: '1.0',
        title: options.title || '由 Agent Trace 编译的工作流草稿',
        description: '由标准化工具执行轨迹生成，发布前必须人工审核。',
        draft: true,
        nodes: steps,
        variables: Object.keys(variables),
        trace: { sourceCount: Array.isArray(toolCalls) ? toolCalls.length : 0, normalizedCount: normalized.length }
    };
}

module.exports = { compileTraceToWorkflow, extractSemanticSteps, normalizeTrace, parameterize, referencedNodeIds };
