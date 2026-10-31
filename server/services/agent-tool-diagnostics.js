'use strict';

function object(value) {
    if (typeof value === 'string') { try { return JSON.parse(value) || {}; } catch (_) { return {}; } }
    return value && typeof value === 'object' ? value : {};
}
const identifier = value => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,239}$/.test(value) ? value : '';

// 只导出工具定位和策略诊断字段；不导出业务入参、正文、凭据、URL 或模型思考。
function toolStepDiagnostics(step = {}) {
    const input = object(step.input);
    const output = object(step.output);
    const targets = [input.toolRef?.toolName, input.tool_ref?.tool_name, input.toolName,
        ...(Array.isArray(output.toolCalls) ? output.toolCalls : []).flatMap(call => {
            const args = object(call.arguments);
            return [args.toolRef?.toolName, args.toolName];
        })].map(identifier).filter(Boolean);
    const codes = output.reasonCodes || output.diagnosis?.reasonCodes;
    return { targets: [...new Set(targets)], code: identifier(output.code),
        category: identifier(output.diagnosis?.category), reasonCodes: (Array.isArray(codes) ? codes : []).map(identifier).filter(Boolean) };
}

module.exports = { toolStepDiagnostics };
