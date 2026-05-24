/* 流式 function calling 累加器 Streaming Function Calls
 *
 * OpenAI Chat Completions 的 streaming 协议在工具调用阶段会以增量形式下发：
 *   data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a","type":"function","function":{"name":"search","arguments":"{\"q\":\""}}]},...}]}
 *   data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"hello\"}"}}]}}]}
 *   data: {"choices":[{"finish_reason":"tool_calls"}]}
 *
 * 累加器职责：
 *   - 维护多个 tool_calls（按 index）的 name 与 arguments 字符串累加
 *   - 同时累加 assistant 文本内容（content delta）
 *   - 在 finish_reason 出现后给出最终结果，包含解析后的 arguments JSON
 *   - 错误隔离：单个工具调用的 arguments JSON 解析失败不会拖垮整个流，保留原始字符串供调用方降级
 *
 * 设计目标：
 *   - 纯函数 + 状态对象，便于单测（不依赖 axios、SSE 框架）
 *   - 与 server/streaming.js 的 createSseEventParser 互补：本累加器只处理已经被解析出 JSON 的"逻辑帧"
 *   - 不引入新依赖，保持私有化部署友好
 *
 * 使用方式：
 *   const acc = createToolCallAccumulator();
 *   for await (const chunk of sseFrames) acc.ingest(chunk);
 *   const result = acc.finalize();
 *   // result = { content: string, toolCalls: [{ id, name, arguments, argumentsRaw, parsed }], finishReason }
 */

const TOOL_CALL_LIMIT = 16; // 安全上限：超出认为是异常增量

function createToolCallAccumulator() {
    const state = {
        content: '',
        toolCallsByIndex: new Map(),
        finishReason: null,
        usage: null,
        errors: []
    };

    function ensureCall(index) {
        const key = Number.isFinite(Number(index)) ? Number(index) : 0;
        if (!state.toolCallsByIndex.has(key)) {
            if (state.toolCallsByIndex.size >= TOOL_CALL_LIMIT) {
                state.errors.push(`tool_calls 数量超过上限 ${TOOL_CALL_LIMIT}，新增项被忽略`);
                return null;
            }
            state.toolCallsByIndex.set(key, {
                index: key,
                id: '',
                name: '',
                argumentsRaw: ''
            });
        }
        return state.toolCallsByIndex.get(key);
    }

    // 接收一个已解析为对象的 OpenAI streaming 帧
    function ingest(frame) {
        if (!frame || typeof frame !== 'object') return;
        if (frame.usage && typeof frame.usage === 'object') {
            state.usage = frame.usage;
        }
        const choice = Array.isArray(frame.choices) ? frame.choices[0] : null;
        if (!choice) return;
        if (choice.finish_reason) state.finishReason = String(choice.finish_reason);
        const delta = choice.delta || choice.message || {};
        if (typeof delta.content === 'string' && delta.content.length > 0) {
            state.content += delta.content;
        }
        const toolCallsDelta = Array.isArray(delta.tool_calls) ? delta.tool_calls : null;
        if (toolCallsDelta) {
            toolCallsDelta.forEach((entry, fallbackIndex) => {
                if (!entry || typeof entry !== 'object') return;
                const call = ensureCall(entry.index ?? fallbackIndex);
                if (!call) return;
                if (entry.id && !call.id) call.id = String(entry.id);
                const fn = entry.function || {};
                if (fn.name && !call.name) call.name = String(fn.name);
                if (typeof fn.arguments === 'string') {
                    call.argumentsRaw += fn.arguments;
                }
            });
        }
        // legacy function_call delta（旧接口兼容）
        if (delta.function_call && typeof delta.function_call === 'object') {
            const call = ensureCall(0);
            if (call) {
                if (delta.function_call.name && !call.name) call.name = String(delta.function_call.name);
                if (typeof delta.function_call.arguments === 'string') {
                    call.argumentsRaw += delta.function_call.arguments;
                }
            }
        }
    }

    function finalize() {
        const toolCalls = Array.from(state.toolCallsByIndex.values())
            .sort((a, b) => a.index - b.index)
            .map(call => {
                let parsed = null;
                let parseError = '';
                if (call.argumentsRaw && call.argumentsRaw.trim()) {
                    try {
                        parsed = JSON.parse(call.argumentsRaw);
                    } catch (e) {
                        parseError = e.message || 'arguments JSON 解析失败';
                    }
                }
                return {
                    id: call.id || '',
                    name: call.name || '',
                    argumentsRaw: call.argumentsRaw,
                    arguments: parsed,
                    parseError
                };
            });
        return {
            content: state.content,
            toolCalls,
            finishReason: state.finishReason,
            usage: state.usage,
            hasToolCalls: toolCalls.length > 0,
            errors: state.errors.slice()
        };
    }

    function snapshot() {
        return {
            content: state.content,
            partialToolCalls: Array.from(state.toolCallsByIndex.values()).map(call => ({
                id: call.id,
                name: call.name,
                argumentsRaw: call.argumentsRaw
            })),
            finishReason: state.finishReason
        };
    }

    return { ingest, finalize, snapshot };
}

// 把工具列表序列化成 OpenAI 期望的 tools 数组（function calling 协议）
function buildOpenAiToolsPayload(tools = []) {
    return tools
        .filter(tool => tool && tool.name)
        .map(tool => ({
            type: 'function',
            function: {
                name: String(tool.name).slice(0, 64),
                description: String(tool.description || tool.title || '').slice(0, 1024),
                parameters: tool.input_schema && typeof tool.input_schema === 'object'
                    ? tool.input_schema
                    : { type: 'object', properties: {} }
            }
        }));
}

// 把累加器返回的 toolCalls 转成可直接喂回 chat completions 的 messages 片段
function buildAssistantToolMessage(result) {
    if (!result || !result.hasToolCalls) {
        return { role: 'assistant', content: result?.content || '' };
    }
    return {
        role: 'assistant',
        content: result.content || '',
        tool_calls: result.toolCalls.map(call => ({
            id: call.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            type: 'function',
            function: {
                name: call.name,
                arguments: call.argumentsRaw
            }
        }))
    };
}

function buildToolResultMessage(callId, content) {
    const text = typeof content === 'string' ? content : JSON.stringify(content ?? null);
    return {
        role: 'tool',
        tool_call_id: callId || '',
        content: text
    };
}

module.exports = {
    TOOL_CALL_LIMIT,
    createToolCallAccumulator,
    buildOpenAiToolsPayload,
    buildAssistantToolMessage,
    buildToolResultMessage
};
