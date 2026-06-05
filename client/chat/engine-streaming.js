// 聊天流式响应、SSE 解析与助手统计辅助函数 Chat streaming, SSE parsing, and assistant stats helpers
const escapeChatStatusHtml = (value) => {
    if (window.PivotSafeHtml) return window.PivotSafeHtml.escapeHtml(value);
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
};

const STREAM_RENDER_INTERVAL_MS = 80;
const STREAM_LOCAL_REPLAY_INTERVAL_MS = 24;
const STREAM_LOCAL_REPLAY_MAX_WAIT_MS = 3200;
const STREAM_LOCAL_REPLAY_TARGET_CHARS = 48;
const STREAM_LOCAL_REPLAY_MAX_CHARS = 160;
// 内容越长，每帧 marked.parse 成本越高；按累计长度阶梯式放大间隔，降低长回答时的重排开销
const resolveStreamInterval = (contentLength) => {
    if (window.Pivot && typeof window.Pivot.chooseStreamInterval === 'function') {
        return window.Pivot.chooseStreamInterval(contentLength);
    }
    return STREAM_RENDER_INTERVAL_MS;
};

function estimateStreamingTokenCount(content) {
    const text = String(content || '');
    const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
    return Math.ceil(chineseChars * 2 + (text.length - chineseChars) * 0.5);
}

function splitAssistantStreamDelta(delta) {
    const text = String(delta || '');
    if (!text) return [];
    if (text.length <= STREAM_LOCAL_REPLAY_MAX_CHARS || /<\/?thought>?/i.test(text)) return [text];

    const chunks = [];
    let current = '';
    for (const char of Array.from(text)) {
        current += char;
        const softBreak = current.length >= STREAM_LOCAL_REPLAY_TARGET_CHARS && /[\s,.;:!?，。；：！？、）)\]\n]/u.test(char);
        const hardBreak = current.length >= STREAM_LOCAL_REPLAY_MAX_CHARS;
        if (softBreak || hardBreak) {
            chunks.push(current);
            current = '';
        }
    }
    if (current) chunks.push(current);
    return chunks;
}

function createBrowserSseParser({ onData, onDone } = {}) {
    let buffer = '';
    let done = false;

    const flushEvent = (rawEvent) => {
        const dataLines = rawEvent
            .split(/\r?\n/)
            .map(line => line.trimEnd())
            .filter(line => line.startsWith('data:'))
            .map(line => line.replace(/^data:\s?/, ''));
        if (dataLines.length === 0) return;

        const payload = dataLines.join('\n');
        if (payload === '[DONE]') {
            done = true;
            if (typeof onDone === 'function') onDone();
            return;
        }
        if (typeof onData === 'function') onData(payload);
    };

    const write = (text) => {
        if (done) return;
        buffer += String(text || '').replace(/\r\n/g, '\n');
        let boundary = buffer.indexOf('\n\n');
        while (boundary !== -1) {
            const rawEvent = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            flushEvent(rawEvent);
            if (done) return;
            boundary = buffer.indexOf('\n\n');
        }
    };

    const end = () => {
        if (!done && buffer.trim()) {
            flushEvent(buffer);
        }
        buffer = '';
    };

    return { write, end, isDone: () => done };
}

function renderStreamingAssistantContent(textBody, statsEl, content, tokenCount, startTime, firstTokenTime) {
    if (!textBody) return;
    const hasOpenThought = content.includes('<thought>') && !content.includes('</thought>');
    const existingThoughtContent = textBody.querySelector('.thought-block.thinking .thought-content');

    if (hasOpenThought && existingThoughtContent) {
        existingThoughtContent.innerHTML = renderMarkdown(content.replace(/^<thought>/, ''), { deferPivotCharts: true });
        if (existingThoughtContent.closest('.thought-block')?.classList.contains('is-open')) {
            const inner = existingThoughtContent.closest('.thought-content-inner');
            inner.scrollTop = inner.scrollHeight;
        }
    } else {
        const thoughtState = rememberThoughtStateBeforeRender(textBody);
        textBody.innerHTML = renderAiMessage(content, true, thoughtState.openStates);
        restoreThoughtStateAfterRender(textBody, thoughtState);
    }

    const elapsed = (Date.now() - startTime) / 1000;
    const tps = firstTokenTime ? (tokenCount / ((Date.now() - firstTokenTime) / 1000)).toFixed(1) : 0;
    const modelName = String(statsEl?.dataset?.modelName || '').trim();
    const modelHtml = modelName
        ? `<span class="stat-item stat-model" title="模型：${escapeAttrValue(modelName)}">${ICONS.model}${escapeChatStatusHtml(modelName)}</span>`
        : '';
    statsEl.innerHTML = `
        ${modelHtml}
        <span class="stat-item">${ICONS.time}${elapsed.toFixed(1)}s</span>
        <span class="stat-item">${ICONS.token}${tokenCount} Tokens</span>
        <span class="stat-item">${ICONS.speed}${tps} t/s</span>
    `;
}

function renderFinalAssistantStats(statsEl, { modelName = '', costTime = 0, tokenCount = 0, tps = 0 } = {}) {
    if (!statsEl) return;
    const normalizedModelName = String(modelName || statsEl.dataset.modelName || '').trim();
    if (normalizedModelName) statsEl.dataset.modelName = normalizedModelName;
    const currentModelName = String(statsEl.dataset.modelName || '').trim();
    const modelHtml = currentModelName
        ? `<span class="stat-item stat-model" title="模型：${escapeAttrValue(currentModelName)}">${ICONS.model}${escapeChatStatusHtml(currentModelName)}</span>`
        : '';
    const safeCostTime = Number.isFinite(Number(costTime)) ? Number(costTime) : 0;
    const safeTokenCount = Number.isFinite(Number(tokenCount)) ? Math.max(0, Math.round(Number(tokenCount))) : 0;
    const safeTps = Number.isFinite(Number(tps)) ? Number(tps) : 0;
    statsEl.innerHTML = `
        ${modelHtml}
        <span class="stat-item">${ICONS.time}${safeCostTime.toFixed(1)}s</span>
        <span class="stat-item">${ICONS.token}${safeTokenCount} Tokens</span>
        <span class="stat-item">${ICONS.speed}${safeTps.toFixed(1)} t/s</span>
    `;
    const footerEl = statsEl.closest('.message-footer');
    footerEl?.classList.remove('hidden');
    footerEl?.classList.remove('hover-time-only');
}

function isMessageContainerNearBottom(threshold = 160) {
    const container = document.getElementById('message-container');
    if (!container) return false;
    return container.scrollHeight - container.scrollTop - container.clientHeight < threshold;
}

function keepMessageContainerPinnedToBottom(wasNearBottom) {
    if (!wasNearBottom) return;
    window.scrollMessagesToBottom?.();
}

function keepLatestCodeBlockPinned(root, wasNearBottom) {
    if (!wasNearBottom || !root) return;
    const codeBlocks = root.querySelectorAll('.code-block pre');
    const latest = codeBlocks[codeBlocks.length - 1];
    if (latest) latest.scrollTop = latest.scrollHeight;
}

function isMessageContentInDocument(messageContent) {
    return Boolean(messageContent && document.body.contains(messageContent));
}

window.refreshCurrentContextUsage = async function(sessionId = currentSessionId) {
    if (!sessionId || !window.updateContextUsage) return null;
    try {
        const res = await apiFetch(`${API_BASE}/sessions/${encodeURIComponent(sessionId)}/context`);
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
            window.updateContextUsage(data.contextMeta || null);
            return data.contextMeta || null;
        }
    } catch (e) {
        console.warn('刷新上下文用量失败', e);
    }
    return null;
};

async function readChatErrorMessage(response) {
    const fallback = `服务器拒绝 (${response.status})`;
    const responseType = response.headers.get('content-type') || '';
    try {
        if (responseType.includes('application/json')) {
            const data = await response.json();
            const message = data.error?.message || data.error || data.message;
            return message ? String(message) : fallback;
        }
        const text = await response.text();
        return text ? text.slice(0, 300) : fallback;
    } catch (e) {
        return fallback;
    }
}
