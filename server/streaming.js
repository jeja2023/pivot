const { StringDecoder } = require('string_decoder');

function extractStreamPayload(json) {
    let delta = '';
    let isThought = false;

    if (json.type === 'response.output_text.delta' || json.type === 'response.text_delta') {
        delta = json.delta || json.text || '';
    } else if (json.type === 'response.reasoning_text.delta' || json.type === 'response.reasoning_delta') {
        delta = json.delta || json.text || '';
        isThought = true;
    } else if (json.type === 'response.content_part.delta') {
        delta = json.delta?.text || '';
    } else if (json.choices && json.choices[0].delta) {
        const d = json.choices[0].delta;
        if (d.reasoning_content !== undefined && d.reasoning_content !== null) {
            delta = d.reasoning_content;
            isThought = true;
        } else if (d.content !== undefined && d.content !== null) {
            delta = d.content;
            isThought = false;
        }
    } else if (json.choices && json.choices[0].message) {
        const messageContent = json.choices[0].message.content;
        if (typeof messageContent === 'string') {
            delta = messageContent;
        } else if (Array.isArray(messageContent)) {
            delta = messageContent
                .map(part => part?.text || part?.content || '')
                .filter(Boolean)
                .join('\n');
        }
    } else if (json.type === 'response.completed' && json.response?.output) {
        const out = json.response.output.find(o => o.type === 'message');
        if (out) {
            const content = out.content.find(c => c.type === 'output_text' || c.type === 'text');
            delta = content?.text || '';
        }
    }

    return {
        delta,
        isThought,
        usage: json.usage || null
    };
}

function classifyProviderStreamEvent(json = {}) {
    if (!json || typeof json !== 'object') return { type: 'unknown', protocol: 'unknown' };
    const rawType = String(json.type || '').trim();
    if (rawType) {
        if (/^response\.(created|in_progress|queued|completed|failed|incomplete)$/.test(rawType)) {
            return { type: rawType, protocol: 'responses' };
        }
        if (/^response\.(output_text|reasoning_text|content_part|output_item|function_call_arguments)\.(delta|done|added)$/.test(rawType)) {
            return { type: rawType, protocol: 'responses' };
        }
        if (rawType === 'response.error' || rawType === 'error') return { type: 'response.error', protocol: 'responses' };
        if (/usage/i.test(rawType)) return { type: 'response.usage', protocol: 'responses' };
        return { type: rawType, protocol: rawType.startsWith('response.') ? 'responses' : 'unknown' };
    }
    const choice = Array.isArray(json.choices) ? json.choices[0] : null;
    const delta = choice?.delta || choice?.message || {};
    if (json.error) return { type: 'chat.error', protocol: 'chat_completions' };
    if (json.usage) return { type: 'chat.usage', protocol: 'chat_completions' };
    if (Array.isArray(delta.tool_calls) && delta.tool_calls.length) return { type: 'chat.tool_call.delta', protocol: 'chat_completions' };
    if (delta.function_call) return { type: 'chat.tool_call.delta', protocol: 'chat_completions' };
    if (delta.reasoning_content !== undefined || delta.reasoning) return { type: 'chat.reasoning.delta', protocol: 'chat_completions' };
    if (delta.content !== undefined || choice?.finish_reason) {
        return choice?.finish_reason
            ? { type: 'chat.completed', protocol: 'chat_completions' }
            : { type: 'chat.output_text.delta', protocol: 'chat_completions' };
    }
    return { type: 'unknown', protocol: 'unknown' };
}

function createProviderEventStateMachine({ onEvent, maxRecentEvents = 256 } = {}) {
    const state = {
        status: 'idle',
        protocol: 'unknown',
        responseId: '',
        eventCount: 0,
        outputText: '',
        reasoningText: '',
        toolCalls: new Map(),
        toolCallIndexes: new Map(),
        usage: null,
        finishReason: null,
        error: null,
        recentEvents: []
    };

    const safeUsage = usage => usage && typeof usage === 'object' ? {
        inputTokens: Number(usage.input_tokens ?? usage.prompt_tokens ?? usage.inputTokens ?? 0) || 0,
        outputTokens: Number(usage.output_tokens ?? usage.completion_tokens ?? usage.outputTokens ?? 0) || 0,
        totalTokens: Number(usage.total_tokens ?? usage.totalTokens ?? 0) || 0,
        raw: usage
    } : null;

    function ingest(frame) {
        if (!frame || typeof frame !== 'object') return null;
        const classification = classifyProviderStreamEvent(frame);
        const type = classification.type;
        state.eventCount += 1;
        state.protocol = classification.protocol !== 'unknown' ? classification.protocol : state.protocol;
        const response = frame.response || frame;
        if (response.id && !state.responseId) state.responseId = String(response.id);
        if (frame.id && !state.responseId) state.responseId = String(frame.id);
        const extracted = extractStreamPayload(frame);
        if (extracted.delta) {
            if (extracted.isThought) state.reasoningText += String(extracted.delta);
            else state.outputText += String(extracted.delta);
        }
        if (frame.usage) state.usage = safeUsage(frame.usage);
        if (frame.response?.usage) state.usage = safeUsage(frame.response.usage);
        const choice = Array.isArray(frame.choices) ? frame.choices[0] : null;
        const finishReason = choice?.finish_reason || frame.finish_reason;
        if (finishReason) state.finishReason = String(finishReason);
        const outputItems = Array.isArray(frame.output) ? frame.output : (Array.isArray(frame.response?.output) ? frame.response.output : []);
        outputItems.forEach(item => {
            if (item?.type === 'function_call' || item?.type === 'tool_call') {
                const key = String(item.call_id || item.id || state.toolCalls.size);
                const current = state.toolCalls.get(key) || { id: key, name: '', arguments: '' };
                current.name = String(item.name || current.name || '');
                current.arguments = String(item.arguments || item.input || current.arguments || '');
                state.toolCalls.set(key, current);
            }
        });
        const toolDeltas = choice?.delta?.tool_calls || [];
        toolDeltas.forEach((item, index) => {
            const indexKey = item?.index === undefined || item?.index === null ? '' : String(item.index);
            const mappedKey = indexKey ? state.toolCallIndexes.get(indexKey) : '';
            const key = String(item?.id || mappedKey || indexKey || index);
            if (indexKey) state.toolCallIndexes.set(indexKey, key);
            const current = state.toolCalls.get(key) || { id: key, name: '', arguments: '' };
            current.name = String(item?.function?.name || current.name || '');
            current.arguments += String(item?.function?.arguments || '');
            state.toolCalls.set(key, current);
        });
        if (type.endsWith('.failed') || type === 'response.error' || type === 'chat.error') {
            state.status = 'failed';
            state.error = frame.error || frame.response?.error || { message: String(frame.message || 'Provider stream failed') };
        } else if (type.endsWith('.incomplete')) {
            state.status = 'incomplete';
        } else if (type.endsWith('.completed') || type === 'chat.completed') {
            state.status = 'completed';
        } else if (state.status === 'idle' || state.status === 'created') {
            state.status = 'streaming';
        }
        const event = {
            sequence: state.eventCount,
            type,
            protocol: state.protocol,
            responseId: state.responseId,
            status: state.status,
            deltaLength: String(extracted.delta || '').length,
            usage: state.usage,
            finishReason: state.finishReason,
            toolCallCount: state.toolCalls.size
        };
        state.recentEvents.push(event);
        if (state.recentEvents.length > maxRecentEvents) state.recentEvents.splice(0, state.recentEvents.length - maxRecentEvents);
        try { onEvent?.(event); } catch (_) {}
        return event;
    }

    function snapshot() {
        return {
            status: state.status,
            protocol: state.protocol,
            responseId: state.responseId,
            eventCount: state.eventCount,
            outputText: state.outputText,
            reasoningText: state.reasoningText,
            toolCalls: Array.from(state.toolCalls.values()).map(call => ({ ...call })),
            usage: state.usage,
            finishReason: state.finishReason,
            error: state.error,
            recentEvents: state.recentEvents.slice()
        };
    }

    function finalize() {
        if (state.status === 'idle' || state.status === 'streaming') state.status = 'ended';
        return snapshot();
    }

    return { ingest, snapshot, finalize };
}

function splitStreamTextForDisplay(text, { targetLength = 120, maxLength = 360 } = {}) {
    const value = String(text || '');
    if (!value) return [];
    if (value.length <= maxLength || /<\/?thought>?/i.test(value)) return [value];

    const chunks = [];
    let current = '';
    for (const char of Array.from(value)) {
        current += char;
        const softBreak = current.length >= targetLength && /[\s,.;:!?，。；：！？、）)\]\n]/u.test(char);
        const hardBreak = current.length >= maxLength;
        if (softBreak || hardBreak) {
            chunks.push(current);
            current = '';
        }
    }
    if (current) chunks.push(current);
    return chunks;
}

function createSseEventParser({ onData, onDone } = {}) {
    const decoder = new StringDecoder('utf8');
    let buffer = '';
    let dataLines = [];

    const flushEvent = () => {
        if (dataLines.length === 0) return;
        const payload = dataLines.join('\n');
        dataLines = [];
        if (payload === '[DONE]') {
            if (typeof onDone === 'function') onDone();
            return;
        }
        if (typeof onData === 'function') onData(payload);
    };

    const processLines = (lines) => {
        for (const rawLine of lines) {
            const line = rawLine.trim();
            if (!line) {
                flushEvent();
                continue;
            }
            if (line.startsWith('data:')) {
                dataLines.push(line.replace(/^data:\s*/, ''));
            }
        }
    };

    const push = (text) => {
        const lines = text.split(/\r?\n/);
        buffer = lines.pop() || '';
        processLines(lines);
    };

    return {
        write(chunk) {
            push(buffer + decoder.write(chunk));
        },
        end() {
            const tail = decoder.end();
            if (tail) {
                buffer += tail;
            }
            if (buffer) {
                push(buffer + '\n');
                buffer = '';
            }
            flushEvent();
        }
    };
}

function createStreamAccumulator({ includeThoughtTags = false, includeThoughtContent = true, onContent } = {}) {
    let content = '';
    let usage = null;
    let lastWasThought = false;

    const pushJson = (json) => {
        if (json.usage) usage = json.usage;
        const { delta, isThought, usage: extractedUsage } = extractStreamPayload(json);
        if (extractedUsage) usage = extractedUsage;
        if (!delta) return '';
        if (isThought && !includeThoughtContent) return '';

        let sendContent = '';
        if (includeThoughtTags && isThought) {
            if (!lastWasThought) {
                sendContent += '<thought>';
                lastWasThought = true;
            }
            sendContent += delta;
        } else {
            if (includeThoughtTags && lastWasThought) {
                sendContent += '</thought>';
                lastWasThought = false;
            }
            sendContent += delta;
        }

        if (sendContent) {
            content += sendContent;
            if (typeof onContent === 'function') {
                onContent(sendContent, {
                    delta,
                    isThought,
                    usage: extractedUsage || usage
                });
            }
        }
        return sendContent;
    };

    const pushPayload = (payload) => {
        try {
            return pushJson(JSON.parse(payload));
        } catch (e) {
            return '';
        }
    };

    const finish = () => {
        if (includeThoughtTags && lastWasThought) {
            const closeTag = '</thought>';
            content += closeTag;
            lastWasThought = false;
            if (typeof onContent === 'function') {
                onContent(closeTag, {
                    delta: '',
                    isThought: false,
                    isSynthetic: true,
                    usage
                });
            }
            return closeTag;
        }
        return '';
    };

    return {
        pushJson,
        pushPayload,
        finish,
        getContent: () => content,
        getUsage: () => usage
    };
}

module.exports = {
    classifyProviderStreamEvent,
    createProviderEventStateMachine,
    createSseEventParser,
    createStreamAccumulator,
    extractStreamPayload,
    splitStreamTextForDisplay
};
