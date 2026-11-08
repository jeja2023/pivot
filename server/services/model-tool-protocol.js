'use strict';

const crypto = require('node:crypto');
const SAFE_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const ALIAS_PREFIX = 'pivot_fn_';

function providerToolName(name) {
    const original = String(name || '');
    if (SAFE_NAME.test(original) && !original.startsWith(ALIAS_PREFIX)) return original;
    const prefix = original.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 24);
    return `${ALIAS_PREFIX}${prefix}_${crypto.createHash('sha256').update(original).digest('hex').slice(0, 24)}`;
}

function createModelToolProtocol(tools = [], messages = []) {
    const canonicalByAlias = new Map();
    const remember = name => {
        if (!name) return;
        const canonical = String(name), alias = providerToolName(canonical);
        if (canonicalByAlias.has(alias) && canonicalByAlias.get(alias) !== canonical) {
            throw new Error('模型工具名称映射冲突，请检查工具目录后重试。');
        }
        canonicalByAlias.set(alias, canonical);
    };
    tools.forEach(tool => remember(tool?.name));
    messages.forEach(message => {
        (message?.tool_calls || []).forEach(call => remember(call?.function?.name));
        remember(message?.function_call?.name);
        if (message?.role === 'function') remember(message.name);
    });
    // 历史和工具目录采用同一稳定映射；调用ID和工具参数保留原值，避免破坏恢复与授权关联。
    const mapFunction = fn => fn?.name ? { ...fn, name: providerToolName(fn.name) } : fn;
    return {
        name: providerToolName,
        canonicalName: name => canonicalByAlias.get(String(name)) || String(name || ''),
        messages: messages.map(message => ({
            ...message,
            ...(message.tool_calls ? { tool_calls: message.tool_calls.map(call => ({ ...call, function: mapFunction(call.function) })) } : {}),
            ...(message.function_call ? { function_call: mapFunction(message.function_call) } : {}),
            ...(message.role === 'function' && message.name ? { name: providerToolName(message.name) } : {})
        })),
        toolChoice: choice => choice?.function?.name ? { ...choice, function: mapFunction(choice.function) } : choice
    };
}

module.exports = { createModelToolProtocol, providerToolName };
