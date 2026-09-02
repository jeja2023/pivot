const { validateValueAgainstSchema, normalizeJsonSchema } = require('./agent-dag-contracts');
const { resolveDeclaredToolCapabilities } = require('./agent-capability-registry');
const { resolveRegisteredToolCapabilities } = require('./agent-tool-capabilities');

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

/**
 * 解析工具能力。
 * 落地方案 v1.2 阶段 0.3：不再按名称关键字放大能力，改为
 * 「契约显式声明 → 平台能力登记表 → 最小能力兜底」三层解析。
 * 契约中未在能力注册表登记的能力标识会被丢弃，从而只能得到更窄而非更宽的结果。
 */
function inferCapabilities(name = '', source = 'builtin') {
    return resolveRegisteredToolCapabilities(name, source);
}

function normalizeToolConcurrency(value, sideEffect = false) {
    const requested = String(value || '').trim().toLowerCase();
    if (['read', 'write', 'exclusive'].includes(requested)) return requested;
    return sideEffect ? 'write' : 'read';
}

/**
 * 合并工具契约能力：契约显式声明优先，但只保留已登记能力；
 * 显式声明全部未登记时按登记表解析，避免出现「声明了未登记能力就等于无约束」的旁路。
 */
function resolveToolContractCapabilities(definition = {}, toolName = '', source = 'builtin') {
    if (Array.isArray(definition.capabilities)) {
        const declared = resolveDeclaredToolCapabilities(definition.capabilities, { toolName });
        if (declared.length) return declared;
    }
    return resolveRegisteredToolCapabilities(toolName, source);
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
        capabilities: resolveToolContractCapabilities(definition, toolName, source),
        risk_level: riskLevel,
        idempotent: definition.idempotent === undefined ? inferredIdempotent : Boolean(definition.idempotent),
        side_effect: sideEffect,
        concurrency: normalizeToolConcurrency(definition.concurrency ?? definition.concurrency_mode, sideEffect),
        cancellable: definition.cancellable === undefined ? !sideEffect : Boolean(definition.cancellable),
        // 本机浏览器连接器由桌面端按已授权 Origin 执行网络校验；服务端本身不出网，
        // 因而允许可信调用方显式声明 network:false，避免错误套用任务级服务器网络白名单。
        network: definition.network === false
            ? false
            : Boolean(definition.network || /(?:http|web|browser|network)/i.test(String(definition.name || '')) || source === 'mcp'),
        approval_required: Boolean((definition.approval_required ?? definition.approvalRequired ?? definition.alwaysRequiresApproval) || riskLevel >= 5),
        localBrowserConnector: definition.localBrowserConnector === true,
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
