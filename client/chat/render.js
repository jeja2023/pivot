// --- UI 渲染模块 Render (完整功能版) ---
/* exported appendMessage, renderAttachmentPreviews, rememberThoughtStateBeforeRender, restoreThoughtStateAfterRender */
const ICONS = {
    user: `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="white" stroke-width="2.5"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`,
    ai: `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z"/></svg>`,
    copy: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`,
    delete: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>`,
    time: `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
    token: `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>`,
    speed: `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>`
};

const escapeCodeHtml = (value) => window.PivotSafeHtml
    ? window.PivotSafeHtml.escapeHtml(value)
    : String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttrValue = (value) => window.PivotSafeHtml
    ? window.PivotSafeHtml.escapeAttr(value)
    : escapeCodeHtml(value).replace(/"/g, '&quot;');

function parseChatDateTime(value) {
    if (!value) return '';
    if (value instanceof Date) return value;

    const text = String(value).trim();
    if (!text) return '';

    let normalized = text.replace(' ', 'T');
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(normalized)) {
        normalized += '+08:00';
    }

    const date = new Date(normalized);
    return Number.isNaN(date.getTime()) ? '' : date;
}

function formatChatDateTime(value) {
    const parsed = parseChatDateTime(value);
    if (!parsed) return value ? String(value).trim() : '';

    return parsed.toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
    });
}

function formatChatCompactDateTime(value) {
    const parsed = parseChatDateTime(value);
    if (!parsed) return value ? String(value).trim() : '';

    const now = new Date();
    const dayKey = (date) => new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).format(date);
    const timeText = parsed.toLocaleTimeString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
    });

    if (dayKey(parsed) === dayKey(now)) return `今天 ${timeText}`;

    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    if (dayKey(parsed) === dayKey(yesterday)) return `昨天 ${timeText}`;

    const parts = new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric'
    }).formatToParts(parsed).reduce((acc, part) => {
        acc[part.type] = part.value;
        return acc;
    }, {});
    const currentYear = new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric'
    }).format(now);

    return parts.year === currentYear
        ? `${parts.month}月${parts.day}日 ${timeText}`
        : `${parts.year}年${parts.month}月${parts.day}日 ${timeText}`;
}

function formatSessionListTime(value) {
    const parsed = parseChatDateTime(value);
    if (!parsed) return value ? String(value).trim() : '';

    const now = new Date();
    const diffMs = Math.max(0, now.getTime() - parsed.getTime());
    const minuteMs = 60 * 1000;
    const hourMs = 60 * minuteMs;
    if (diffMs < minuteMs) return '刚刚';
    if (diffMs < hourMs) return `${Math.floor(diffMs / minuteMs)} 分钟`;
    if (diffMs < 24 * hourMs) return `${Math.floor(diffMs / hourMs)} 小时`;

    const dayKey = (date) => new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).format(date);

    const todayStart = new Date(dayKey(now) + 'T00:00:00+08:00');
    const parsedStart = new Date(dayKey(parsed) + 'T00:00:00+08:00');
    const dayDiff = Math.max(1, Math.round((todayStart - parsedStart) / (24 * 60 * 60 * 1000)));
    if (dayDiff === 1) return '昨天';
    if (dayDiff <= 6) return `${dayDiff} 天`;
    if (dayDiff <= 27) return `${Math.floor(dayDiff / 7)} 周`;

    const parts = new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric'
    }).formatToParts(parsed).reduce((acc, part) => {
        acc[part.type] = part.value;
        return acc;
    }, {});
    const currentYear = new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric'
    }).format(now);
    return parts.year === currentYear ? `${parts.month}/${parts.day}` : `${parts.year}/${parts.month}/${parts.day}`;
}
function formatSessionGroupDate(value) {
    const parsed = parseChatDateTime(value);
    if (!parsed) return '更早';

    const now = new Date();
    const dayKey = (date) => new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).format(date);

    if (dayKey(parsed) === dayKey(now)) return '今天';

    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    if (dayKey(parsed) === dayKey(yesterday)) return '昨天';

    const parts = new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric'
    }).formatToParts(parsed).reduce((acc, part) => {
        acc[part.type] = part.value;
        return acc;
    }, {});
    const currentYear = new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric'
    }).format(now);

    return parts.year === currentYear
        ? `${parts.month}月${parts.day}日`
        : `${parts.year}年${parts.month}月${parts.day}日`;
}

window.formatChatDateTime = formatChatDateTime;
window.formatChatCompactDateTime = formatChatCompactDateTime;
window.formatSessionListTime = formatSessionListTime;
window.formatSessionGroupDate = formatSessionGroupDate;

window.scrollMessagesToBottom = function() {
    const container = document.getElementById('message-container');
    if (!container) return;
    const apply = () => { container.scrollTop = container.scrollHeight; };
    apply();
    requestAnimationFrame(apply);
    setTimeout(apply, 80);
};

const customRenderer = new marked.Renderer();
customRenderer.code = (code, infostring, _escaped) => {
    if (typeof code === 'object' && code !== null) {
        infostring = code.lang || code.info || '';
        code = code.text || code.raw || '';
    }
    const language = String(infostring || '').trim().split(/\s+/)[0];
    const languageLabel = language || 'code';
    let codeHtml;
    if (language && typeof hljs !== 'undefined' && hljs.getLanguage(language)) {
        try { codeHtml = hljs.highlight(code, { language }).value; } catch (e) { codeHtml = escapeCodeHtml(code); }
    } else if (typeof hljs !== 'undefined') {
        try { codeHtml = hljs.highlightAuto(code).value; } catch (e) { codeHtml = escapeCodeHtml(code); }
    } else { codeHtml = escapeCodeHtml(code); }

    return `
        <div class="code-block">
            <div class="code-toolbar">
                <span class="code-language">${escapeCodeHtml(languageLabel)}</span>
                <button type="button" class="code-copy-btn" title="复制代码">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                    <span>复制</span>
                </button>
            </div>
            <pre><code class="hljs ${language ? `language-${escapeAttrValue(language)}` : ''}">${codeHtml}</code></pre>
        </div>
    `;
};

customRenderer.link = (href, title, text) => {
    if (typeof href === 'object' && href !== null) { text = href.text; title = href.title; href = href.href; }
    const safeText = text || ''; const safeHref = escapeAttrValue(href || '#'); const safeTitle = escapeAttrValue(title || '');
    const isDoc = safeText.includes('附件:') || safeText.includes('文件:') || /\.(pdf|doc|docx|xls|xlsx|txt|zip|rar)$/i.test(safeText);
    if (isDoc) {
        const docName = escapeCodeHtml(safeText.replace('附件:', '').replace('文件:', '').trim());
        return `
            <a href="${safeHref}" target="_blank" rel="noopener noreferrer" class="doc-card-link" data-attachment-preview data-attachment-url="${safeHref}" data-attachment-name="${escapeAttrValue(safeText)}">
                <div class="doc-card">
                    <div class="doc-icon"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg></div>
                    <div class="doc-info"><div class="doc-name">${docName}</div><div class="doc-action">点击下载/预览</div></div>
                </div>
            </a>
        `;
    }
    return `<a href="${safeHref}" target="_blank" rel="noopener noreferrer" title="${safeTitle}">${escapeCodeHtml(safeText)}</a>`;
};

// 移除 customRenderer.table，让 marked 默认处理表格生成

function stripInternalReferenceText(content) {
    return String(content ?? '').replace(/\n{0,2}---\n【参考文档:[^\n]*】\n[\s\S]*?\n---(?=\n|$)/g, '').trim();
}

function getDisplayContent(role, content) {
    return role === 'user' ? stripInternalReferenceText(content) : content;
}

function normalizeMarkdown(content) {
    const normalizeText = (text) => text
        .replace(/\*\*[ \t]+([^*\n][^*\n]*?)[ \t]+\*\*/g, (_, inner) => `**${inner.trim()}**`)
        .replace(/__[ \t]+([^_\n][^_\n]*?)[ \t]+__/g, (_, inner) => `__${inner.trim()}__`);
    return String(content).split(/(```[\s\S]*?```|~~~[\s\S]*?~~~)/g).map((block) => {
        if (/^(```|~~~)/.test(block)) return block;
        return block.split(/(`[^`\n]*`)/g).map((part) => {
            if (/^`[^`\n]*`$/.test(part)) return part;
            return normalizeText(part);
        }).join('');
    }).join('');
}

// --- 数学公式与思考块扩展配置 (KaTeX + Marked) ---
if (typeof marked !== 'undefined') {
    // 1. 行内数学公式 $...$
    const inlineMath = {
        name: 'inlineMath',
        level: 'inline',
        start(src) { return src.indexOf('$'); },
        tokenizer(src) {
            const rule = /^\$((?:\\\$|[^\$\n])+?)\$/;
            const match = rule.exec(src);
            if (match) {
                return { type: 'inlineMath', raw: match[0], text: match[1].replace(/\\(\$)/g, '$').trim() };
            }
        },
        renderer(token) {
            if (typeof katex === 'undefined') return token.raw;
            try {
                return katex.renderToString(token.text, { displayMode: false, throwOnError: false });
            } catch (e) { return token.raw; }
        }
    };

    // 2. 块级数学公式 $$...$$
    const blockMath = {
        name: 'blockMath',
        level: 'block',
        start(src) { return src.indexOf('$$'); },
        tokenizer(src) {
            const rule = /^\$\$\s*([\s\S]+?)\s*\$\$/;
            const match = rule.exec(src);
            if (match) {
                return { type: 'blockMath', raw: match[0], text: match[1].trim() };
            }
        },
        renderer(token) {
            if (typeof katex === 'undefined') return token.raw;
            try {
                return `<div class="math-block">${katex.renderToString(token.text, { displayMode: true, throwOnError: false })}</div>`;
            } catch (e) { return token.raw; }
        }
    };

    // 3. 思考块 <thought>...</thought>
    const thoughtBlock = {
        name: 'thought',
        level: 'block',
        start(src) { return src.indexOf('<thought>'); },
        tokenizer(src) {
            const rule = /^<thought>([\s\S]*?)(?:<\/thought>|$)/;
            const match = rule.exec(src);
            if (match) {
                return { type: 'thought', raw: match[0], text: match[1].trim(), isClosed: match[0].includes('</thought>') };
            }
        },
        renderer(token) {
            const isOpen = window._tempThoughtStates && window._tempThoughtStates[window._tempThoughtCounter++];
            const thinkingClass = token.isClosed ? '' : ' thinking';
            const summary = token.isClosed ? '模型思考内容' : '模型正在思考';
            return `<div class="thought-block${thinkingClass}${isOpen ? ' is-open' : ''}"><div class="thought-summary">${summary}</div><div class="thought-content-wrapper"><div class="thought-content-inner"><div class="thought-content">${renderMarkdown(token.text)}</div></div></div></div>`;
        }
    };

    marked.use({ extensions: [inlineMath, blockMath, thoughtBlock] });
}

function renderMarkdown(content) {
    if (!content) return '';
    const normalizedContent = normalizeMarkdown(content);
    let rawHtml = marked.parse(normalizedContent, { renderer: customRenderer, breaks: true, gfm: true });

    // 为生成的表格统一包裹外部滚动容器，彻底规避 marked 渲染器 API 版本兼容性问题
    rawHtml = rawHtml.replace(/<table>/g, '<div class="table-wrapper"><table>').replace(/<\/table>/g, '</table></div>');

    if (window.PivotSafeHtml) {
        return window.PivotSafeHtml.sanitizeHtml(rawHtml, {
            ADD_TAGS: [
                'details', 'summary', 'thought', 
                'math', 'annotation', 'semantics', 'mrow', 'mi', 'mn', 'mo', 'msup', 'msub', 'mfrac', 'mover', 'munder', 'munderover', 'mtable', 'mtr', 'mtd', 'msqrt', 'mroot', 'mspace', 'mtext', 'mstyle', 'merror'
            ], 
            ADD_ATTR: ['class', 'open', 'type', 'title', 'aria-label', 'encoding', 'display', 'viewBox', 'd', 'xmlns', 'src', 'alt', 'href', 'target', 'rel'] 
        });
    }
    if (window.DOMPurify) {
        return DOMPurify.sanitize(rawHtml);
    }
    return rawHtml;
}

function renderAiMessage(content, _isStreaming = false, thoughtOpenStates = []) {
    if (!content) return '';
    // 使用全局变量传递状态给 marked 渲染器
    window._tempThoughtCounter = 0;
    window._tempThoughtStates = thoughtOpenStates;
    return renderMarkdown(content);
}

function appendMessage(role, content, id = null, stats = null) {
    const container = document.getElementById('message-container');
    const div = document.createElement('div');
    div.className = `message ${role}`;
    const displayContent = getDisplayContent(role, content);
    const displayHtml = role === 'assistant' ? renderAiMessage(displayContent, false) : renderMarkdown(displayContent);
    const createdAt = stats?.createdAt || stats?.created_at || stats?.created_at_text;
    const messageTime = formatChatDateTime(createdAt);
    const messageTimeTitle = formatChatDateTime(createdAt);
    const messageTimeHtml = messageTime ? `<span class="message-meta" title="${escapeAttrValue(messageTimeTitle)}">${escapeCodeHtml(messageTime)}</span>` : '';
    const statsHtml = (role === 'assistant' && stats && stats.costTime !== undefined) ? `
        <div class="message-stats">
            <span class="stat-item">${ICONS.time}${Number(stats.costTime).toFixed(1)}s</span>
            <span class="stat-item">${ICONS.token}${stats.tokenCount || 0} Tokens</span>
            <span class="stat-item">${ICONS.speed}${Number(stats.tps).toFixed(1)} t/s</span>
        </div>
    ` : '';
    const footerClass = [
        'message-footer',
        (!messageTimeHtml && !statsHtml) ? 'hidden' : '',
        (messageTimeHtml && !statsHtml) ? 'hover-time-only' : ''
    ].filter(Boolean).join(' ');
    
    div.innerHTML = `
        <div class="avatar">${role === 'user' ? ICONS.user : ICONS.ai}</div>
        <div class="message-content">
            <div class="text-body">${displayHtml}</div>
            ${role === 'assistant' ? `
            <div class="${footerClass}">
                ${statsHtml}
                ${messageTimeHtml}
            </div>
            ` : ''}
            <div class="message-actions">
                ${role === 'user' ? messageTimeHtml : ''}
                <button class="action-btn" data-message-action="copy" title="复制">${ICONS.copy}</button>
                ${role === 'assistant' && id ? `<button class="action-btn" data-message-action="regenerate" data-message-id="${id}" title="重新回答"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><polyline points="23 20 23 14 17 14"/><path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10M23 14l-4.64 4.36A9 9 0 0 1 3.51 15"/></svg></button>` : ''}
                ${id ? `<button class="action-btn" data-message-action="delete" data-message-id="${id}" title="删除">${ICONS.delete}</button>` : ''}
            </div>
        </div>
    `;
    container.appendChild(div);
    if (role === 'assistant') bindThoughtStateTracking(div.querySelector('.text-body'));
    window.scrollMessagesToBottom?.();
    return div.querySelector('.message-content');
}

function renderAttachmentPreviews() {
    const previewArea = document.getElementById('attachment-preview');
    if (pendingAttachments.length === 0) { previewArea.classList.add('hidden'); previewArea.innerHTML = ''; return; }
    const maxAttachments = window.MAX_PENDING_ATTACHMENTS || 5;
    if (pendingAttachments.length > maxAttachments) pendingAttachments.splice(maxAttachments);
    previewArea.classList.remove('hidden');
    const hasImage = pendingAttachments.some(file => String(file.type || '').startsWith('image/'));
    const notice = hasImage ? '<div class="attachment-limit-note">当前模型每次仅解析 1 张图片</div>' : '';
    previewArea.innerHTML = notice + pendingAttachments.map((file, index) => {
        if (file.type.startsWith('image/')) {
            return `<div class="preview-card"><img src="${escapeAttrValue(file.url)}"><button type="button" class="remove-preview" data-remove-attachment="${index}" aria-label="移除附件">&times;</button></div>`;
        }
        return `<div class="preview-card file-card"><div class="file-icon"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg></div><div class="file-name">${escapeCodeHtml(file.name)}</div><button type="button" class="remove-preview" data-remove-attachment="${index}" aria-label="移除附件">&times;</button></div>`;
    }).join('');
}

document.addEventListener('click', (event) => {
    const messageButton = event.target.closest('[data-message-action]');
    if (messageButton) {
        const action = messageButton.dataset.messageAction;
        const messageId = Number.parseInt(messageButton.dataset.messageId || '', 10);
        if (action === 'copy') window.copyMsg(messageButton);
        if (action === 'regenerate' && Number.isSafeInteger(messageId)) window.regenerateMsg(messageId);
        if (action === 'delete' && Number.isSafeInteger(messageId)) window.deleteMsg(messageId, messageButton);
        return;
    }

    const removeButton = event.target.closest('[data-remove-attachment]');
    if (removeButton) {
        const index = Number.parseInt(removeButton.dataset.removeAttachment || '', 10);
        if (Number.isSafeInteger(index)) window.removeAttachment(index);
    }
});

// --- 思考块状态深度追踪 ---
function getThoughtOpenStates(root) {
    if (!root) return [];
    return Array.from(root.querySelectorAll('.thought-block')).map(block => block.classList.contains('is-open'));
}
function getThoughtScrollStates(root) {
    if (!root) return [];
    return Array.from(root.querySelectorAll('.thought-content-inner')).map(wrapper => ({
        top: wrapper.scrollTop,
        nearBottom: wrapper.scrollHeight - wrapper.scrollTop - wrapper.clientHeight < 24
    }));
}
function restoreThoughtScrollStates(root, states = []) {
    if (!root || !states.length) return;
    const wrappers = Array.from(root.querySelectorAll('.thought-content-inner'));
    wrappers.forEach((wrapper, index) => {
        const state = states[index]; if (!state) return;
        wrapper.scrollTop = state.nearBottom ? wrapper.scrollHeight : state.top;
    });
}
function bindThoughtStateTracking(root) {
    if (!root || root.dataset.thoughtTrackingBound === '1') return;
    root.dataset.thoughtTrackingBound = '1'; root._thoughtOpenStates = []; root._thoughtScrollStates = [];
    root.addEventListener('click', (event) => {
        const summary = event.target.closest('.thought-summary'); if (!summary) return;
        const block = summary.closest('.thought-block'); if (!block) return;
        const blocks = Array.from(root.querySelectorAll('.thought-block'));
        const index = blocks.indexOf(block);
        if (index >= 0) {
            const willBeOpen = !block.classList.contains('is-open');
            block.classList.toggle('is-open', willBeOpen);
            root._thoughtOpenStates[index] = willBeOpen;
            root._thoughtScrollStates = getThoughtScrollStates(root);
        }
    }, true);
    root.addEventListener('scroll', (event) => {
        if (!event.target.closest?.('.thought-content-inner')) return;
        root._thoughtScrollStates = getThoughtScrollStates(root);
    }, true);
}
function rememberThoughtStateBeforeRender(root) {
    if (!root) return { openStates: [], scrollStates: [] };
    const openStates = getThoughtOpenStates(root);
    const scrollStates = getThoughtScrollStates(root);
    root._thoughtOpenStates = openStates; root._thoughtScrollStates = scrollStates;
    return { openStates, scrollStates };
}
function restoreThoughtStateAfterRender(root, state) {
    if (!root || !state) return;
    root._thoughtOpenStates = state.openStates || [];
    root._thoughtScrollStates = state.scrollStates || [];
    restoreThoughtScrollStates(root, root._thoughtScrollStates);
}

// --- 代码块复制功能实现 ---
document.addEventListener('click', async (e) => {
    const btn = e.target.closest('.code-copy-btn');
    if (!btn) return;
    
    const codeBlock = btn.closest('.code-block');
    const code = codeBlock ? codeBlock.querySelector('code')?.innerText : '';
    if (!code) return;

    try {
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(code);
        } else {
            // 回退方案：使用隐藏 textarea
            const textArea = document.createElement("textarea");
            textArea.value = code;
            textArea.style.position = "fixed";
            textArea.style.left = "-999999px";
            textArea.style.top = "-999999px";
            document.body.appendChild(textArea);
            textArea.focus();
            textArea.select();
            const success = document.execCommand('copy');
            textArea.remove();
            if (!success) throw new Error('execCommand copy failed');
        }

        if (window.showToast) showToast('代码已复制到剪贴板');
        
        // 按钮文字反馈
        const span = btn.querySelector('span');
        if (span) {
            const oldText = span.innerText;
            span.innerText = '已复制';
            btn.classList.add('copied');
            setTimeout(() => {
                span.innerText = oldText;
                btn.classList.remove('copied');
            }, 2000);
        }
    } catch (err) {
        console.error('复制失败:', err);
        if (window.showToast) showToast('复制失败，请手动选择复制', 'error');
    }
});
