'use strict';

const { buildResponsesUrl } = require('./model-adapter');
const { createModelToolProtocol } = require('./model-tool-protocol');
const { toProviderInput } = require('./agent-provider-envelope');
const reasoningByCalls = new WeakMap();
const outputByResult = new WeakMap();
const modelIdentity = model => `${model.url}\n${model.model_name || model.name}`;

function usesAgentResponses(model) {
    try {
        const url = new URL(model.url);
        return /\/responses\/?$/.test(url.pathname) || url.hostname === 'api.openai.com' && /^(gpt-[56]|o[134])(?:[.\s-]|$)/i.test(model.model_name || model.name || '');
    } catch (_) { return false; }
}

function retainResponsesOutput(result, message) {
    const output = outputByResult.get(result);
    if (output && message.tool_calls) reasoningByCalls.set(message.tool_calls, output);
    return message;
}

function responsesRequest(model, messages, tools, options = {}) {
    const protocol = createModelToolProtocol(tools, toProviderInput(messages));
    const input = [];
    for (let index = 0; index < messages.length; index++) {
        const message = protocol.messages[index];
        const retained = reasoningByCalls.get(messages[index].tool_calls);
        if (retained && retained.model === modelIdentity(model)) { input.push(...retained.output); continue; }
        if (message.role === 'tool') {
            input.push({ type: 'function_call_output', call_id: message.tool_call_id, output: typeof message.content === 'string' ? message.content : JSON.stringify(message.content) }); continue;
        }
        if (message.content && (!Array.isArray(message.content) || message.content.length)) {
            const parts = Array.isArray(message.content) ? message.content : [{ type: 'text', text: message.content }];
            input.push({ role: message.role, content: parts.map(part => {
                if (part.type === 'image_url') return { type: 'input_image', image_url: part.image_url.url };
                return { type: message.role === 'assistant' ? 'output_text' : 'input_text', text: String(part.text || '') };
            }) });
        }
        for (const call of message.tool_calls || []) input.push({ type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments });
    }
    const data = { model: model.model_name || model.name, input, store: false, stream: options.stream === true,
        max_output_tokens: options.maxTokens, include: ['reasoning.encrypted_content'] };
    if (tools.length) data.tools = tools.map(tool => ({ type: 'function', name: protocol.name(tool.name), description: tool.description || tool.title || '', parameters: tool.input_schema || { type: 'object', properties: {} }, strict: false }));
    if (options.toolChoice) data.tool_choice = typeof options.toolChoice === 'string' ? options.toolChoice : { type: 'function', name: protocol.name(options.toolChoice.function?.name) };
    if (options.responseFormat) data.text = { format: options.responseFormat.type === 'json_schema' ? { type: 'json_schema', ...options.responseFormat.json_schema } : options.responseFormat };
    return { url: /\/responses\/?$/.test(new URL(model.url).pathname) ? model.url : buildResponsesUrl(model.url, { appendV1ForLocal: false }), data, protocol };
}

function responsesResult(response, model, protocol) {
    if (!response || !['completed', 'incomplete'].includes(response.status)) throw Object.assign(new Error('模型未返回完整的 Responses 结束状态。'), { code: 'AGENT_RESPONSES_INCOMPLETE_STREAM' });
    const output = Array.isArray(response.output) ? response.output : [];
    const calls = output.filter(item => item.type === 'function_call');
    if (calls.length > require('./streaming-tools').TOOL_CALL_LIMIT || new Set(calls.map(item => item.call_id)).size !== calls.length) throw new Error('Responses 工具调用数量超限或标识重复，已拒绝执行。');
    if (response.status !== 'completed' && calls.length) throw Object.assign(new Error('模型工具参数尚未完成，已阻止执行。'), { code: 'AGENT_RESPONSES_INCOMPLETE_STREAM' });
    const result = { content: output.filter(item => item.type === 'message').flatMap(item => item.content || []).filter(part => part.type === 'output_text').map(part => part.text).join(''),
        toolCalls: calls.map(item => {
            let args; try { args = JSON.parse(item.arguments); } catch (_) { throw new Error('Responses 工具参数不是有效 JSON。'); }
            if (!item.call_id || !item.name || !args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Responses 工具调用缺少有效标识或参数。');
            return { id: item.call_id, name: protocol.canonicalName(item.name), arguments: args, argumentsRaw: item.arguments, parseError: '' };
        }), hasToolCalls: calls.length > 0, finishReason: response.status === 'incomplete' ? 'length' : calls.length ? 'tool_calls' : 'stop', usage: response.usage || null, errors: [] };
    outputByResult.set(result, { model: modelIdentity(model), output: output.filter(item => ['reasoning', 'message', 'function_call'].includes(item.type)) });
    return result;
}

function responsesAccumulator(model, protocol) {
    let terminal = null, content = '';
    return {
        ingest(frame) {
            if (frame.type === 'error' || frame.type === 'response.failed') throw Object.assign(new Error('Responses 模型调用失败。'), { code: 'AGENT_RESPONSES_FAILED' });
            if (frame.type === 'response.output_text.delta') content += frame.delta || '';
            if (['response.completed', 'response.incomplete'].includes(frame.type)) terminal = frame.response;
        },
        snapshot: () => ({ content, partialToolCalls: [], finishReason: '' }),
        finalize: () => responsesResult(terminal, model, protocol)
    };
}

module.exports = { usesAgentResponses, responsesRequest, responsesResult, responsesAccumulator, retainResponsesOutput };
