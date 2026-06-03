const { normalizePositiveInt } = require('./agent-validators');

function getPathValue(value, path = []) {
    let current = value;
    for (const part of path) {
        if (current === null || current === undefined) return undefined;
        if (Array.isArray(current) && /^\d+$/.test(part)) {
            current = current[Number(part)];
        } else if (typeof current === 'object' && Object.prototype.hasOwnProperty.call(current, part)) {
            current = current[part];
        } else {
            return undefined;
        }
    }
    return current;
}

function stringifyDagTemplateValue(value) {
    if (value === undefined || value === null) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    try {
        return JSON.stringify(value);
    } catch (e) {
        return String(value);
    }
}

function resolveDagTemplateReference(expression, context) {
    const expr = String(expression || '').trim();
    if (!expr) return undefined;
    if (expr === 'goal' || expr === 'run.goal') return context.goal;
    const parts = expr.split('.').map(part => part.trim()).filter(Boolean);
    if (!parts.length) return undefined;
    if (parts[0] === 'inputs' || parts[0] === 'input') {
        return getPathValue(context.inputs || {}, parts.slice(1));
    }
    if (parts[0] === 'run') {
        if (parts[1] === 'goal') return context.goal;
        if (parts[1] === 'inputs' || parts[1] === 'input') return getPathValue(context.inputs || {}, parts.slice(2));
    }
    if (parts[0] === 'nodes' || parts[0] === 'node') {
        const nodeId = parts[1];
        const field = parts[2] || 'output';
        if (!nodeId) return undefined;
        const state = context.states.get(nodeId) || {};
        const node = context.nodeMap.get(nodeId) || {};
        if (field === 'status') return state.status;
        if (field === 'error') return state.error || '';
        if (field === 'title') return node.title || nodeId;
        if (field === 'tool') return node.tool || '';
        if (field === 'input') return getPathValue(state.input ?? node.input ?? {}, parts.slice(3));
        if (field === 'output') {
            const path = parts.slice(3);
            const direct = getPathValue(state.output, path);
            if (direct !== undefined || !path.length) return direct;
            return getPathValue(state.output?.structuredContent, path);
        }
    }
    return undefined;
}

function resolveDagInputValue(value, context) {
    if (typeof value === 'string') {
        const exact = value.match(/^\s*\{\{\s*([^{}]+?)\s*\}\}\s*$/);
        if (exact) {
            const resolved = resolveDagTemplateReference(exact[1], context);
            return resolved === undefined ? value : resolved;
        }
        return value.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (match, expression) => {
            const resolved = resolveDagTemplateReference(expression, context);
            return resolved === undefined ? match : stringifyDagTemplateValue(resolved);
        });
    }
    if (Array.isArray(value)) {
        return value.map(item => resolveDagInputValue(item, context));
    }
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveDagInputValue(item, context)]));
    }
    return value;
}

function resolveDagNodeInput(node, context) {
    const resolved = resolveDagInputValue(node.input || {}, context);
    return resolved && typeof resolved === 'object' && !Array.isArray(resolved) ? resolved : {};
}

function normalizeDagNodePolicy(node, run, defaultToolTimeoutMs) {
    const defaultTimeout = normalizePositiveInt(
        run.tool_timeout_ms,
        defaultToolTimeoutMs,
        30000,
        10 * 60 * 1000
    );
    return {
        retryLimit: normalizePositiveInt(node.retryLimit ?? node.retry_limit, 0, 0, 5),
        timeoutMs: normalizePositiveInt(node.timeoutMs ?? node.timeout_ms, 0, 0, 10 * 60 * 1000) || defaultTimeout,
        onError: ['skip_dependents', 'continue', 'stop'].includes(String(node.onError || node.on_error || 'skip_dependents'))
            ? String(node.onError || node.on_error || 'skip_dependents')
            : 'skip_dependents'
    };
}

module.exports = {
    getPathValue,
    normalizeDagNodePolicy,
    resolveDagInputValue,
    resolveDagNodeInput,
    resolveDagTemplateReference,
    stringifyDagTemplateValue
};
