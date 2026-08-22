const { validateValueAgainstSchema, normalizeJsonSchema } = require('./agent-dag-contracts');

const RISK_NAMES = Object.freeze({ low: 1, medium: 3, high: 4, critical: 5 });

function normalizeRisk(value, fallback = 1) {
    if (typeof value === 'string' && RISK_NAMES[value.toLowerCase()]) return RISK_NAMES[value.toLowerCase()];
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, Math.min(5, Math.floor(number))) : fallback;
}

function inferRiskLevel(name = '', definition = {}) {
    const value = String(name || '').toLowerCase();
    if (definition.network || /(?:http|web|browser|network|mcp\.)/.test(value)) return 4;
    if (/(?:code|python|shell|execute)/.test(value)) return 3;
    if (/(?:write|upload|delete|export|send|message)/.test(value)) return 2;
    return 1;
}

function inferCapabilities(name = '', source = 'builtin') {
    const value = String(name || '').toLowerCase();
    const capabilities = [];
    if (value.includes('file') || value.includes('report') || value.includes('document')) capabilities.push('filesystem.read_workspace');
    if (value.includes('write') || value.includes('export') || value.includes('upload')) capabilities.push('filesystem.write_workspace');
    if (value.includes('http') || value.includes('web') || source === 'mcp') capabilities.push('network.request');
    if (value.includes('code') || value.includes('python') || value.includes('duckdb')) capabilities.push('code.execute');
    return capabilities.length ? capabilities : ['agent.execute'];
}

function normalizeToolConcurrency(value, sideEffect = false) {
    const requested = String(value || '').trim().toLowerCase();
    if (['read', 'write', 'exclusive'].includes(requested)) return requested;
    return sideEffect ? 'write' : 'read';
}

function normalizeToolContract(definition = {}) {
    const source = String(definition.source || (String(definition.name || '').startsWith('mcp.') ? 'mcp' : 'builtin'));
    const riskLevel = normalizeRisk(definition.risk_level ?? definition.riskLevel ?? definition.risk,
        source === 'mcp' ? 4 : inferRiskLevel(definition.name, definition));
    const inputSchema = normalizeJsonSchema(definition.input_schema || definition.inputSchema || definition.parameters || { type: 'object', properties: {} });
    const timeout = definition.timeout && typeof definition.timeout === 'object' ? definition.timeout : {};
    const toolName = String(definition.name || '');
    const sideEffect = Boolean((definition.side_effect ?? definition.sideEffect) || /(?:write|upload|delete|export|send|message|http)/i.test(toolName));
    // Read-only tools are safe to replay after a worker crash unless a tool
    // explicitly declares otherwise. Mutating tools remain non-idempotent by default.
    const inferredIdempotent = !sideEffect && /(?:read|list|search|query|describe|inspect|metadata|fetch|get|lookup|count|analy[sz]e)/i.test(toolName);
    return {
        name: toolName.trim(),
        version: String(definition.version || '1.0.0'),
        title: String(definition.title || definition.name || '').slice(0, 255),
        description: String(definition.description || '').slice(0, 2000),
        source,
        capabilities: [...new Set((Array.isArray(definition.capabilities) ? definition.capabilities : inferCapabilities(definition.name, source)).map(String).filter(Boolean))],
        risk_level: riskLevel,
        idempotent: definition.idempotent === undefined ? inferredIdempotent : Boolean(definition.idempotent),
        side_effect: sideEffect,
        concurrency: normalizeToolConcurrency(definition.concurrency ?? definition.concurrency_mode, sideEffect),
        cancellable: definition.cancellable === undefined ? !sideEffect : Boolean(definition.cancellable),
        network: Boolean(definition.network || /(?:http|web|browser|network)/i.test(String(definition.name || '')) || source === 'mcp' && definition.network !== false),
        approval_required: Boolean((definition.approval_required ?? definition.approvalRequired ?? definition.alwaysRequiresApproval) || riskLevel >= 5),
        timeout: {
            default_seconds: Math.max(Number(timeout.default_seconds ?? timeout.defaultSeconds ?? definition.timeoutSeconds ?? 30) || 30, 1),
            max_seconds: Math.max(Number(timeout.max_seconds ?? timeout.maxSeconds ?? 120) || 120, 1)
        },
        input_schema: inputSchema,
        output_schema: normalizeJsonSchema(definition.output_schema || definition.outputSchema || { type: 'object' }),
        handler: definition.handler
    };
}

function validateToolInput(contract, input) {
    const issues = [];
    const schema = contract?.input_schema || { type: 'object' };
    validateValueAgainstSchema(input && typeof input === 'object' ? input : {}, schema, {}, `${contract?.name || '工具'} 输入`, issues);
    return issues;
}

class ToolRegistry {
    constructor(definitions = []) {
        this.tools = new Map();
        definitions.forEach(definition => this.register(definition));
    }

    register(definition) {
        const contract = normalizeToolContract(definition);
        if (!contract.name) throw new Error('工具契约必须包含 name。');
        this.tools.set(contract.name, contract);
        return contract;
    }

    get(name) { return this.tools.get(String(name || '').trim()) || null; }
    has(name) { return Boolean(this.get(name)); }
    list() { return [...this.tools.values()].map(({ handler: _handler, ...tool }) => tool); }

    validate(name, input) {
        const contract = this.get(name);
        if (!contract) return [`工具不存在：${name}`];
        return validateToolInput(contract, input);
    }
}

module.exports = {
    RISK_NAMES,
    ToolRegistry,
    inferCapabilities,
    normalizeToolConcurrency,
    normalizeRisk,
    normalizeToolContract,
    validateToolInput
};
