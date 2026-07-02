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

function normalizeAssistantTraceTone(tone = '') {
    const value = String(tone || '').toLowerCase();
    if (['ready', 'info', 'warning', 'error', 'quiet'].includes(value)) return value;
    return 'info';
}

function normalizeAssistantTraceMcpToolName(value = '') {
    const raw = String(value || '').trim();
    const match = raw.match(/^mcp\.\d+\.(.+)$/);
    return match ? match[1] : raw;
}

function getAssistantTraceMcpActionName(event = {}) {
    const explicit = String(event?.actionName || '').trim();
    if (explicit) return explicit;

    const toolName = normalizeAssistantTraceMcpToolName(event?.toolName || event?.tool || event?.toolFullName || '');
    if (!toolName) return '';
    if (typeof mcpToolTitle === 'function') {
        try {
            const title = mcpToolTitle({
                name: toolName,
                fullName: event?.toolFullName || event?.tool || toolName,
                serverName: event?.serverName || ''
            });
            if (title && title !== '工具') return title;
        } catch (_) {}
    }
    return toolName.split('.').pop().replace(/[_-]+/g, ' ').trim();
}

function formatAssistantTraceMcpActionText(event = {}, prefix = '正在使用工具箱', fallback = '') {
    const serverName = String(event?.serverName || '').trim();
    const actionName = getAssistantTraceMcpActionName(event);
    const target = [serverName, actionName].filter(Boolean).join(' / ');
    if (target) return `${prefix}：${target}。`;
    return String(event?.message || '').trim() || fallback;
}

function getAssistantTraceEventCopy(event = {}) {
    const type = String(event?.type || '').toLowerCase();
    const status = String(event?.status || '').toLowerCase();
    const message = String(event?.message || '').trim();
    const sources = Array.isArray(event?.sources)
        ? event.sources.map(item => String(item || '').trim()).filter(Boolean).slice(0, 3)
        : [];
    const sourceCount = Number(event?.sourceCount || sources.length || 0);
    const citationCount = Number(event?.citationCount || 0);

    if (type === 'rag') {
        if (status === 'hit') {
            const sourceText = sources.length ? `：${sources.join('、')}` : '';
            const scopeText = event?.scoped ? '当前范围' : '';
            const hitPrefix = scopeText ? `知识库${scopeText}已命中` : '知识库已命中';
            const citationText = citationCount > sourceCount ? `（${citationCount} 条引用片段）` : '';
            return {
                tool: 'rag',
                label: '知识库',
                tone: 'ready',
                text: sourceCount > 0
                    ? `${hitPrefix} ${sourceCount} 份可引用文档${sourceText}${citationText}，会优先依据知识库回答。`
                    : `${hitPrefix}相关文档，会优先依据知识库回答。`
            };
        }
        if (status === 'empty') {
            return {
                tool: 'rag',
                label: '知识库',
                tone: 'warning',
                text: '知识库未命中足够相关内容，本轮会按普通聊天继续。',
                action: 'rag',
                actionLabel: '补充资料'
            };
        }
        return {
            tool: 'rag',
            label: '知识库',
            tone: status === 'error' ? 'error' : 'info',
            text: message || '正在查找知识库资料。',
            action: status === 'error' ? 'rag' : '',
            actionLabel: status === 'error' ? '检查知识库' : ''
        };
    }

    if (type === 'mcp') {
        if (status === 'planning') {
            return {
                tool: 'mcp',
                label: '工具箱',
                tone: 'info',
                text: '正在判断本轮是否需要使用工具箱。'
            };
        }
        if (status === 'running') {
            return {
                tool: 'mcp',
                label: '工具箱',
                tone: 'info',
                text: formatAssistantTraceMcpActionText(event, '正在使用工具箱', '正在使用工具箱工具。')
            };
        }
        if (status === 'done') {
            const doneText = getAssistantTraceMcpActionName(event)
                ? formatAssistantTraceMcpActionText(event, '工具箱工具已完成').replace(/。$/u, '，正在整理结果回答你。')
                : (message || '工具箱工具已完成，正在整理结果回答你。');
            return {
                tool: 'mcp',
                label: '工具箱',
                tone: 'ready',
                text: doneText
            };
        }
        if (status === 'empty') {
            return {
                tool: 'mcp',
                label: '工具箱',
                tone: 'warning',
                text: message || '工具箱还没有可用工具。',
                action: 'mcp',
                actionLabel: '检查工具箱'
            };
        }
        if (status === 'skipped') {
            const needsAction = /没有匹配|没有适合|无法完成|没有可用/.test(message);
            return {
                tool: 'mcp',
                label: '工具箱',
                tone: needsAction ? 'warning' : 'quiet',
                text: message || '本轮不需要调用工具箱。',
                action: needsAction ? 'mcp' : '',
                actionLabel: needsAction ? '检查工具箱' : ''
            };
        }
        if (status === 'error') {
            return {
                tool: 'mcp',
                label: '工具箱',
                tone: 'error',
                text: message || '工具箱工具调用失败。',
                action: 'mcp',
                actionLabel: '检查工具箱'
            };
        }
        return {
            tool: 'mcp',
            label: '工具箱',
            tone: 'info',
            text: message || '工具箱正在处理本轮请求。'
        };
    }

    return null;
}

function ensureAssistantTracePanel(messageContent) {
    if (!messageContent) return null;
    let panel = messageContent.querySelector('.chat-answer-trace');
    if (panel) return panel;

    panel = document.createElement('div');
    panel.className = 'chat-answer-trace hidden';
    panel.setAttribute('aria-label', '回答依据和能力状态');
    panel.setAttribute('aria-live', 'polite');

    const textBody = messageContent.querySelector('.text-body');
    if (textBody) {
        messageContent.insertBefore(panel, textBody);
    } else {
        messageContent.prepend(panel);
    }
    return panel;
}

function renderAssistantTraceEvent(messageContent, event = {}) {
    const copy = getAssistantTraceEventCopy(event);
    if (!copy) return;

    const panel = ensureAssistantTracePanel(messageContent);
    if (!panel) return;

    let item = panel.querySelector(`[data-chat-trace-item="${copy.tool}"]`);
    if (!item) {
        item = document.createElement('div');
        item.dataset.chatTraceItem = copy.tool;
        panel.appendChild(item);
    }

    item.className = `chat-answer-trace-item is-${normalizeAssistantTraceTone(copy.tone)}`;
    item.innerHTML = '';

    const label = document.createElement('strong');
    label.textContent = copy.label;
    const text = document.createElement('span');
    text.textContent = copy.text;
    item.append(label, text);

    if (copy.action && copy.actionLabel) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'chat-answer-trace-action';
        button.dataset.chatTraceAction = copy.action;
        button.textContent = copy.actionLabel;
        item.appendChild(button);
    }

    panel.classList.remove('hidden');
}

function handleAssistantTraceAction(event) {
    const action = event.target.closest?.('[data-chat-trace-action]');
    if (!action) return;
    event.preventDefault();
    const target = action.dataset.chatTraceAction;
    if (target === 'rag') window.openKnowledgeWorkbench?.();
    if (target === 'mcp') window.openMcpWorkbench?.();
}

document.addEventListener('click', handleAssistantTraceAction);
window.renderAssistantTraceEvent = renderAssistantTraceEvent;

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

function stripStreamingThoughtContent(content = '') {
    return String(content || '')
        .replace(/<thought\b[^>]*>[\s\S]*?<\/thought>/gi, '\n')
        .replace(/<thinking\b[^>]*>[\s\S]*?<\/thinking>/gi, '\n')
        .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '\n')
        .replace(/<thought\b[^>]*>[\s\S]*$/gi, '')
        .replace(/<thinking\b[^>]*>[\s\S]*$/gi, '')
        .replace(/<think\b[^>]*>[\s\S]*$/gi, '')
        .replace(/<\/?(thought|thinking|think)\b[^>]*>/gi, '')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function estimateStreamingAnswerTokenCount(content) {
    return estimateStreamingTokenCount(stripStreamingThoughtContent(content));
}

window.stripStreamingThoughtContent = stripStreamingThoughtContent;
window.estimateStreamingAnswerTokenCount = estimateStreamingAnswerTokenCount;

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

function renderStreamingAssistantContent(textBody, statsEl, content, tokenCount, startTime) {
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

    const elapsed = Math.max((Date.now() - startTime) / 1000, 0.001);
    // 速率按完整请求窗口计算，分子使用包含思考在内的总 token 数，避免只按可见答案导致虚高。
    const safeTokenCount = Number.isFinite(Number(tokenCount)) ? Math.max(0, Number(tokenCount)) : 0;
    const tps = safeTokenCount > 0 ? (safeTokenCount / elapsed).toFixed(1) : 0;
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
