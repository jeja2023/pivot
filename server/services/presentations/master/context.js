'use strict';

const { estimateMessagesTokens, getModelContextBudget } = require('../../context-budget');
const runtime = require('./runtime');
const { confirmedWrite } = require('./observations');
const MIN_OUTPUT_TOKENS = 2000;
const MAX_OUTPUT_TOKENS = 18000;
const WINDOW_MARGIN = 256;
const HISTORY_REVIEW_TOKENS = 80000;

function requestLimits(model) {
    const budget = getModelContextBudget(model, { maxOutputTokens: MIN_OUTPUT_TOKENS });
    const configuredOutput = Number(model?.max_tokens);
    const outputLimit = configuredOutput > 0 ? Math.min(configuredOutput, MAX_OUTPUT_TOKENS) : MAX_OUTPUT_TOKENS;
    // 大窗口仍需尽早整理旧工具结果，避免长输入拖慢每一轮模型请求。
    const archiveAt = budget.unbounded ? HISTORY_REVIEW_TOKENS
        : Math.min(HISTORY_REVIEW_TOKENS, budget.inputBudget, Math.floor(budget.contextWindow * 0.6));
    const fullOutputInputBudget = budget.unbounded ? Infinity : Math.min(budget.inputBudget, budget.contextWindow - outputLimit - WINDOW_MARGIN);
    return { ...budget, outputLimit, archiveAt, fullOutputInputBudget };
}

// 只压缩已经确认写入的旧文件正文；原始消息仍保存在检查点中。
function compactMessages(messages) {
    const result = messages.map(message => ({ ...message }));
    let compactedWrites = 0;
    const lastAssistant = result.findLastIndex(message => message.role === 'assistant');
    for (let index = 0; index < result.length - 1; index++) {
        if (index === lastAssistant) continue;
        const message = result[index], observation = result[index + 1];
        if (message.role !== 'assistant' || observation.role !== 'user' || typeof message.content !== 'string' || typeof observation.content !== 'string') continue;
        let turn, observations;
        try { turn = JSON.parse(message.content); observations = JSON.parse(observation.content); } catch (_) { continue; }
        if (!Array.isArray(turn?.actions) || !Array.isArray(observations)) continue;
        const actions = turn.actions.map((action, actionIndex) => {
            if (typeof action?.text !== 'string') return action;
            const receipt = confirmedWrite(action, observations[actionIndex]);
            if (!receipt) return action;
            compactedWrites++;
            const { text: _text, ...rest } = action;
            return { ...rest, savedSha256: receipt.sha256, savedContent: '已成功写入；文件可能已变化，需要正文时使用 read 读取当前文件。' };
        });
        if (actions.some((action, actionIndex) => action !== turn.actions[actionIndex])) {
            result[index] = { ...message, content: JSON.stringify({ ...turn, actions }) };
        }
    }
    // 固定运行包中的完全相同页只保留最后一次全文；不同页或不同内容不合并。
    const seen = new Set();
    for (let index = result.length - 1; index >= 0; index--) {
        const message = result[index];
        if (message.role !== 'user' || typeof message.content !== 'string') continue;
        let observations;
        try { observations = JSON.parse(message.content); } catch (_) { continue; }
        if (!Array.isArray(observations)) {
            if (typeof observations?.runtimeDocument === 'string' && typeof observations.text === 'string') {
                const key = JSON.stringify([observations.runtimeDocument, observations.offset ?? 0, observations.nextOffset ?? null, observations.text]);
                if (seen.has(key)) result[index] = { ...message, content: JSON.stringify({ runtimeDocument: observations.runtimeDocument, offset: observations.offset ?? 0, nextOffset: observations.nextOffset ?? null, note: '相同运行包页的全文保留在后续读取结果中。' }) };
                else seen.add(key);
            }
            continue;
        }
        let changed = false;
        const revised = observations.map(item => {
            if (item?.action !== 'read_runtime' || item.error || typeof item.result?.path !== 'string' || typeof item.result?.text !== 'string') return item;
            const key = JSON.stringify([item.result.path, item.result.offset ?? 0, item.result.nextOffset ?? null, item.result.text]);
            if (!seen.has(key)) { seen.add(key); return item; }
            changed = true;
            const { text: _text, ...rest } = item.result;
            return { ...item, result: { ...rest, note: '相同运行包页的全文保留在后续读取结果中。' } };
        });
        if (changed) result[index] = { ...message, content: JSON.stringify(revised) };
    }
    return { messages: result, compactedWrites };
}

function planRequest(messages, originalMessages, model, remainingTokens, limits = requestLimits(model)) {
    const inputEstimate = estimateMessagesTokens(messages);
    const originalEstimate = estimateMessagesTokens(originalMessages);
    const firstAssistant = messages.findIndex(message => message.role === 'assistant');
    const breakdown = { initial: 0, history: 0, toolResults: 0, images: 0 };
    messages.forEach((message, index) => {
        const image = Array.isArray(message.content) && message.content.some(part => part?.type === 'image_url' || part?.type === 'input_image' || part?.image_url);
        let toolResult = false;
        if (message.role === 'user' && typeof message.content === 'string' && index > firstAssistant && firstAssistant >= 0) {
            try { const value = JSON.parse(message.content); toolResult = Array.isArray(value) && value.every(item => item && typeof item.action === 'string' && (Object.hasOwn(item, 'result') || Object.hasOwn(item, 'error'))); } catch (_) { /* 普通用户消息不属于工具结果。 */ }
        }
        const key = image ? 'images' : firstAssistant < 0 || index < firstAssistant ? 'initial' : toolResult ? 'toolResults' : 'history';
        breakdown[key] += estimateMessagesTokens([message]);
    });
    if (limits.outputLimit < MIN_OUTPUT_TOKENS) {
        throw runtime.error('所选模型的输出上限低于完整制作所需的2000令牌，请检查模型配置或选择其他模型。', 'PPT_MASTER_MODEL_OUTPUT_LIMIT', 422);
    }
    const contextOutput = limits.unbounded ? limits.outputLimit : limits.contextWindow - inputEstimate - WINDOW_MARGIN;
    if (!limits.unbounded && (inputEstimate > limits.inputBudget || contextOutput < MIN_OUTPUT_TOKENS)) {
        throw runtime.error(`本轮预计输入 ${inputEstimate.toLocaleString('zh-CN')} 令牌，超过单轮输入可用量 ${limits.inputBudget.toLocaleString('zh-CN')} 令牌。检查点已保留，请核对模型上下文窗口与输入上限，或切换模型后继续。`, 'PPT_MASTER_CONTEXT_LIMIT', 422);
    }
    const maxTokens = Math.floor(Math.min(limits.outputLimit, remainingTokens - inputEstimate, contextOutput));
    if (maxTokens < MIN_OUTPUT_TOKENS) {
        throw runtime.error('剩余模型预算不足以支付下一轮的预计输入及至少2000令牌输出。可增加累计预算或填 0 取消累计上限，再从检查点继续。', 'PPT_MASTER_BUDGET_EXHAUSTED', 429);
    }
    return { inputEstimate, originalEstimate, maxTokens, breakdown };
}

function usageRecord(state, plan, usageRef, output, compactedWrites, estimateTokens) {
    const usage = usageRef.usage || {};
    const rawInput = usage.input_tokens ?? usage.prompt_tokens ?? usage.inputTokens ?? usageRef.inputTokens;
    const rawOutput = usage.output_tokens ?? usage.completion_tokens ?? usage.outputTokens ?? usageRef.outputTokens;
    const valid = value => value !== undefined && value !== null && Number.isFinite(Number(value)) && Number(value) >= 0;
    const inputTokens = valid(rawInput) ? Number(rawInput) : plan.inputEstimate;
    const outputTokens = valid(rawOutput) ? Number(rawOutput) : estimateTokens(typeof output === 'string' ? output : JSON.stringify(output));
    const previous = Array.isArray(state.usageDiagnostics) ? state.usageDiagnostics : [];
    const item = { call: Number(previous.at(-1)?.call || previous.length) + 1, step: Number(state.steps || 0) + 1, inputTokens, outputTokens,
        inputEstimated: !valid(rawInput), outputEstimated: !valid(rawOutput),
        inputEstimate: plan.inputEstimate, originalEstimate: plan.originalEstimate, compactedWrites, breakdown: plan.breakdown };
    state.usedTokens += inputTokens + outputTokens;
    item.cumulativeTokens = state.usedTokens;
    state.usageDiagnostics = [...previous, item].slice(-160);
}

module.exports = { compactMessages, planRequest, requestLimits, usageRecord };
