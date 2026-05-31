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

function createStreamAccumulator({ includeThoughtTags = false, onContent } = {}) {
    let content = '';
    let usage = null;
    let lastWasThought = false;

    const pushJson = (json) => {
        if (json.usage) usage = json.usage;
        const { delta, isThought, usage: extractedUsage } = extractStreamPayload(json);
        if (extractedUsage) usage = extractedUsage;
        if (!delta) return '';

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
            if (typeof onContent === 'function') onContent(sendContent);
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
            if (typeof onContent === 'function') onContent(closeTag);
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

module.exports = { createSseEventParser, createStreamAccumulator, extractStreamPayload, splitStreamTextForDisplay };
