'use strict';

const crypto = require('node:crypto');
const { modelProviderFailureReason } = require('./model-router');
const { CHAT_INTENT_RESPONSE_FORMAT } = require('./chat-intent-schema');
const { createChatIntentBudget } = require('./chat-intent-budget');

const unsupportedFormats = new Map();

async function invokeWithRecovery(invoke, modelCfg, messages, options, stats) {
    for (let attempt = 0; ; attempt++) {
        if (options.signal?.aborted) throw options.signal.reason;
        try {
            stats.modelCalls++;
            return await invoke(modelCfg, messages, { ...options, timeoutMs: Math.max(1, Math.min(options.timeoutMs, (options.deadlineAt || Infinity) - Date.now())) });
        } catch (error) {
            const status = Number(error?.response?.status || error?.status || 0);
            const transient = [408, 429, 500, 502, 503, 504].includes(status) || ['ECONNRESET', 'EAI_AGAIN'].includes(error?.code);
            const remaining = (options.deadlineAt || Date.now() + options.timeoutMs) - Date.now();
            const retryHeader = error?.response?.headers?.['retry-after'];
            const waitMs = retryHeader === undefined ? 150 : /^\d+(?:\.\d+)?$/.test(String(retryHeader)) ? Number(retryHeader) * 1000 : Date.parse(retryHeader) - Date.now();
            // 路由没有副作用，可以在原预算内重试一次明确的瞬时故障；认证、输入、
            // 熔断、调用方取消和超时不重试。Retry-After 超出预算时直接安全降级。
            if (attempt || stats.providerRetries || !transient || options.signal?.aborted || !Number.isFinite(waitMs) || waitMs < 0 || waitMs > 1000 || remaining < waitMs + 2000) throw error;
            const budget = createChatIntentBudget({ signal: options.signal, timeoutMs: remaining, deadlineAt: options.deadlineAt });
            try { await budget.run('retry', () => new Promise(resolve => setTimeout(resolve, waitMs))); } finally { budget.dispose(); }
            stats.providerRetries = (stats.providerRetries || 0) + 1;
        }
    }
}

async function callChatIntentModel(invoke, modelCfg, messages, options, stats) {
    const key = crypto.createHash('sha256').update(JSON.stringify([modelCfg?.id, modelCfg?.url, modelCfg?.model_name])).digest('hex');
    const native = (unsupportedFormats.get(key) || 0) < Date.now();
    stats.structuredOutput = native ? 'native' : 'validated_compatibility';
    try {
        return await invokeWithRecovery(invoke, modelCfg, messages, { ...options, ...(native ? { responseFormat: CHAT_INTENT_RESPONSE_FORMAT } : {}) }, stats);
    } catch (error) {
        // 仅对供应方明确拒绝结构化输出的错误兼容重试；普通 4xx、超时和取消不重试。
        if (!native || options.signal?.aborted || modelProviderFailureReason(error) !== 'structured_output_incompatible') throw error;
        if (unsupportedFormats.size >= 200) unsupportedFormats.delete(unsupportedFormats.keys().next().value);
        unsupportedFormats.set(key, Date.now() + 15 * 60 * 1000);
        stats.structuredOutput = 'validated_compatibility';
        return invokeWithRecovery(invoke, modelCfg, messages, { ...options, timeoutMs: Math.max(1, (options.deadlineAt || Date.now() + options.timeoutMs) - Date.now()) }, stats);
    }
}

module.exports = { callChatIntentModel };
