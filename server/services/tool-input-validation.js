'use strict';

const SCHEMA_KEYS = ['type', 'required', 'enum', 'const', 'minimum', 'maximum', 'minLength', 'maxLength', 'pattern', 'minItems', 'maxItems', 'uniqueItems', 'additionalProperties'];

/** 只返回校验规则，不带参数实值、默认凭据、示例或工具正文。 */
function repairSchema(schema, state = { nodes: 0, truncated: false }, depth = 0) {
    if (typeof schema === 'boolean') return schema;
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return {};
    if (depth > 8 || ++state.nodes > 120) { state.truncated = true; return {}; }
    const result = {};
    for (const key of SCHEMA_KEYS) {
        const value = schema[key];
        if (value === undefined || (value && typeof value === 'object' && !Array.isArray(value))) continue;
        if (JSON.stringify(value).length > 2000) { state.truncated = true; continue; }
        result[key] = value;
    }
    if (schema.properties && typeof schema.properties === 'object') {
        const entries = Object.entries(schema.properties);
        if (entries.length > 40) state.truncated = true;
        result.properties = Object.fromEntries(entries.slice(0, 40).map(([key, child]) => [key, repairSchema(child, state, depth + 1)]));
    }
    if (schema.items) result.items = repairSchema(schema.items, state, depth + 1);
    for (const key of ['anyOf', 'oneOf', 'allOf']) {
        if (Array.isArray(schema[key])) {
            if (schema[key].length > 10) state.truncated = true;
            result[key] = schema[key].slice(0, 10).map(child => repairSchema(child, state, depth + 1));
        }
    }
    if (schema.additionalProperties && typeof schema.additionalProperties === 'object') result.additionalProperties = repairSchema(schema.additionalProperties, state, depth + 1);
    return result;
}

class ToolInputValidationError extends Error {
    constructor(tool = {}, issues = []) {
        super(`工具参数不符合输入契约：${String(issues[0] || '请核对字段名称与类型。').slice(0, 600)} 本次尚未执行，请修正参数后重试。`);
        this.name = 'ToolInputValidationError';
        this.code = 'TOOL_INPUT_INVALID';
        this.category = 'schema';
        this.status = 400;
        this.statusCode = 400;
        const state = { nodes: 0, truncated: false };
        let inputSchema = repairSchema(tool.input_schema || tool.inputSchema || tool.parameters || {}, state);
        if (JSON.stringify(inputSchema).length > 12000) { inputSchema = {}; state.truncated = true; }
        this.details = { reasonCodes: ['tool_input_invalid'], inputValidation: {
            code: this.code, executed: false, retryable: false, repairable: true, toolName: String(tool.name || ''),
            issues: issues.slice(0, 10).map(issue => String(issue).slice(0, 600)), inputSchema, schemaTruncated: state.truncated,
            message: `${state.truncated ? '契约较大，当前仅展示部分规则，可用 tools.describe 读取当前工具契约。' : ''}按字段问题和当前契约修正参数，不要原样重试。参数修正仍受任务轮次与用量限制；缺少业务事实时应询问或说明缺口，不能猜测。修正后仍须通过权限、审批及执行前校验。`
        } };
    }
}

function inputErrorForDecision(decision = {}) {
    const codes = decision.reasonCodes || [];
    return codes.length && codes.every(code => code === 'tool_input_invalid')
        ? new ToolInputValidationError(decision.tool, decision.inputIssues || decision.reasons || []) : null;
}

function toolInputFeedback(error) {
    // 业务工具可能在产生副作用后抛同名错误；仅信任本进程执行前创建的实例。
    return error instanceof ToolInputValidationError ? error.details.inputValidation : null;
}

function inputErrorForNormalization(error, tool) {
    return ['TOOL_DISCOVERY_REFERENCE_CONFLICT', 'TOOL_DISCOVERY_DESCRIBE_BATCH_INVALID'].includes(error?.code)
        ? new ToolInputValidationError(tool, [error.message]) : error;
}

module.exports = { ToolInputValidationError, inputErrorForDecision, inputErrorForNormalization, toolInputFeedback };
