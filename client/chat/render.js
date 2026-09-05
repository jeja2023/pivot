// --- UI 渲染模块 Render (完整功能版) ---
/* exported appendMessage, renderAttachmentPreviews, rememberThoughtStateBeforeRender, restoreThoughtStateAfterRender, setMessageModelName */
const ICONS = {
    user: `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="white" stroke-width="2.5"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`,
    ai: `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z"/></svg>`,
    copy: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`,
    delete: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>`,
    fork: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="3"/><circle cx="18" cy="6" r="3"/><circle cx="18" cy="18" r="3"/><path d="M9 6h3a6 6 0 0 1 6 6v3"/><path d="M9 6h9"/></svg>`,
    time: `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
    model: `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2 3 7l9 5 9-5-9-5Z"/><path d="m3 12 9 5 9-5"/><path d="m3 17 9 5 9-5"/></svg>`,
    token: `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>`,
    speed: `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>`
};

const escapeCodeHtml = (value) => window.Pivot.legacy.PivotSafeHtml
    ? window.Pivot.legacy.PivotSafeHtml.escapeHtml(value)
    : String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttrValue = (value) => window.Pivot.legacy.PivotSafeHtml
    ? window.Pivot.legacy.PivotSafeHtml.escapeAttr(value)
    : escapeCodeHtml(value).replace(/"/g, '&quot;');
const PROSE_CODE_LANGUAGES = new Set([
    'markdown', 'md', 'mdown', 'gfm', 'commonmark',
    'text', 'txt', 'plain', 'plaintext', 'text/plain'
]);
const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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

window.Pivot.legacy.formatChatDateTime = formatChatDateTime;
window.Pivot.legacy.formatChatCompactDateTime = formatChatCompactDateTime;
window.Pivot.legacy.formatSessionListTime = formatSessionListTime;
window.Pivot.legacy.formatSessionGroupDate = formatSessionGroupDate;

let scrollMessagesToBottomTimer = null;
let scrollMessagesToBottomUntil = 0;
let scrollMessagesToBottomObserver = null;
let scrollMessagesToBottomObserved = null;

function disconnectScrollMessagesToBottomObserver() {
    if (scrollMessagesToBottomObserver) scrollMessagesToBottomObserver.disconnect();
    scrollMessagesToBottomObserver = null;
    scrollMessagesToBottomObserved = null;
}

function observeScrollMessagesToBottom(container) {
    if (!container || typeof ResizeObserver === 'undefined') return;
    if (scrollMessagesToBottomObserver && scrollMessagesToBottomObserved === container) return;
    disconnectScrollMessagesToBottomObserver();
    scrollMessagesToBottomObserved = container;
    scrollMessagesToBottomObserver = new ResizeObserver(() => {
        if (Date.now() > scrollMessagesToBottomUntil) return;
        const currentContainer = document.getElementById('message-container');
        if (currentContainer) currentContainer.scrollTop = currentContainer.scrollHeight;
    });
    scrollMessagesToBottomObserver.observe(container);
    Array.from(container.children || []).forEach(child => scrollMessagesToBottomObserver.observe(child));
}

window.Pivot.legacy.scrollMessagesToBottom = function(options = {}) {
    const container = document.getElementById('message-container');
    if (!container) return;
    const apply = () => {
        const currentContainer = document.getElementById('message-container');
        if (currentContainer) currentContainer.scrollTop = currentContainer.scrollHeight;
    };
    apply();
    requestAnimationFrame(apply);
    requestAnimationFrame(() => requestAnimationFrame(apply));
    setTimeout(apply, 80);
    setTimeout(apply, 240);

    const duration = Number.isFinite(Number(options.duration)) ? Math.max(0, Number(options.duration)) : 120;
    if (duration <= 0) return;
    scrollMessagesToBottomUntil = Math.max(scrollMessagesToBottomUntil, Date.now() + duration);
    observeScrollMessagesToBottom(container);
    if (scrollMessagesToBottomTimer) return;
    scrollMessagesToBottomTimer = setInterval(() => {
        apply();
        if (Date.now() < scrollMessagesToBottomUntil) return;
        clearInterval(scrollMessagesToBottomTimer);
        scrollMessagesToBottomTimer = null;
        disconnectScrollMessagesToBottomObserver();
    }, 80);
};
const customRenderer = new marked.Renderer();
customRenderer.code = (code, infostring, _escaped) => {
    if (typeof code === 'object' && code !== null) {
        infostring = code.lang || code.info || '';
        code = code.text || code.raw || '';
    }
    const language = String(infostring || '').trim().split(/\s+/)[0];
    const normalizedLanguage = language.toLowerCase();
    const chartLanguages = new Set(['pivot-echart', 'pivot-chart', 'chart', 'charts']);
    const isRenderableChart = normalizedLanguage === 'pivot-echart' || (chartLanguages.has(normalizedLanguage) && normalizePivotChartSpec(code));
    if (isRenderableChart) {
        if (window.Pivot.legacy._deferPivotCharts) return '';
        return `<div class="pivot-echart-block" data-pivot-echart="${escapeAttrValue(code)}"><div class="pivot-echart-title">图表</div><div class="pivot-echart-canvas"></div><canvas height="300"></canvas><pre class="pivot-echart-error-text"></pre></div>`;
    }
    const languageLabel = language || 'code';
    let codeHtml;
    const wrapProseCode = PROSE_CODE_LANGUAGES.has(normalizedLanguage);
    if (wrapProseCode) {
        codeHtml = escapeCodeHtml(code);
    } else if (language && typeof hljs !== 'undefined' && hljs.getLanguage(language)) {
        try { codeHtml = hljs.highlight(code, { language }).value; } catch (e) { codeHtml = escapeCodeHtml(code); }
    } else if (typeof hljs !== 'undefined') {
        try { codeHtml = hljs.highlightAuto(code).value; } catch (e) { codeHtml = escapeCodeHtml(code); }
    } else { codeHtml = escapeCodeHtml(code); }

    return `
        <div class="code-block${wrapProseCode ? ' code-block-wrap' : ''}" data-code-language="${escapeAttrValue(normalizedLanguage || 'code')}">
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

customRenderer.image = (href, title, text) => {
    if (typeof href === 'object' && href !== null) { text = href.text; title = href.title; href = href.href; }
    const safeHref = escapeAttrValue(href || '');
    const safeTitle = escapeAttrValue(title || '');
    const safeText = escapeAttrValue(text || '图片附件');
    const titleAttr = safeTitle ? ` title="${safeTitle}"` : '';
    return `<img class="message-image" src="${safeHref}" alt="${safeText}" loading="lazy"${titleAttr}>`;
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

function unwrapSingleMarkdownFence(content) {
    const original = String(content || '');
    const text = original.trim();
    const opening = text.match(/^(`{3,}|~{3,})[ \t]*([^\r\n]*)\r?\n?/);
    if (!opening) return original;

    const language = String(opening[2] || '').trim().split(/\s+/)[0].toLowerCase();
    if (!PROSE_CODE_LANGUAGES.has(language)) return original;

    const marker = opening[1][0];
    const fenceLength = opening[1].length;
    const body = text.slice(opening[0].length);
    const closingFence = new RegExp(`\\r?\\n${escapeRegExp(marker)}{${fenceLength},}[ \\t]*$`);
    const closing = closingFence.exec(body);
    if (closing) return body.slice(0, closing.index).trim();

    const anyClosingFence = new RegExp(`(^|\\r?\\n)${escapeRegExp(marker)}{${fenceLength},}[ \\t]*(\\r?\\n|$)`);
    if (anyClosingFence.test(body)) return original;
    return body.trim();
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
            const isOpen = window.Pivot.legacy._tempThoughtStates && window.Pivot.legacy._tempThoughtStates[window.Pivot.legacy._tempThoughtCounter++];
            const thinkingClass = token.isClosed ? '' : ' thinking';
            const summary = token.isClosed ? '模型思考内容' : '模型正在思考';
            return `<div class="thought-block${thinkingClass}${isOpen ? ' is-open' : ''}"><div class="thought-summary">${summary}</div><div class="thought-content-wrapper"><div class="thought-content-inner"><div class="thought-content">${renderMarkdown(token.text)}</div></div></div></div>`;
        }
    };

    marked.use({ extensions: [inlineMath, blockMath, thoughtBlock] });
}

function renderMarkdown(content, options = {}) {
    if (!content) return '';
    const hasDeferOption = options && Object.prototype.hasOwnProperty.call(options, 'deferPivotCharts');
    const previousDefer = window.Pivot.legacy._deferPivotCharts;
    if (hasDeferOption) window.Pivot.legacy._deferPivotCharts = Boolean(options.deferPivotCharts);
    const normalizedContent = normalizeMarkdown(unwrapSingleMarkdownFence(content));
    let rawHtml = marked.parse(normalizedContent, { renderer: customRenderer, breaks: true, gfm: true });

    // 为生成的表格统一包裹外部滚动容器，彻底规避 marked 渲染器 API 版本兼容性问题
    rawHtml = rawHtml.replace(/<table>/g, '<div class="table-wrapper"><table>').replace(/<\/table>/g, '</table></div>');

    if (window.Pivot.legacy.PivotSafeHtml) {
        const sanitizedHtml = window.Pivot.legacy.PivotSafeHtml.sanitizeHtml(rawHtml, {
            ADD_TAGS: [
                'details', 'summary', 'thought', 
                'math', 'annotation', 'semantics', 'mrow', 'mi', 'mn', 'mo', 'msup', 'msub', 'mfrac', 'mover', 'munder', 'munderover', 'mtable', 'mtr', 'mtd', 'msqrt', 'mroot', 'mspace', 'mtext', 'mstyle', 'merror'
            ], 
            ADD_ATTR: ['class', 'open', 'type', 'title', 'aria-label', 'encoding', 'display', 'viewBox', 'd', 'xmlns', 'src', 'alt', 'href', 'target', 'rel'] 
        });
        if (hasDeferOption) window.Pivot.legacy._deferPivotCharts = previousDefer;
        return sanitizedHtml;
    }
    if (window.DOMPurify) {
        const sanitizedHtml = DOMPurify.sanitize(rawHtml);
        if (hasDeferOption) window.Pivot.legacy._deferPivotCharts = previousDefer;
        return sanitizedHtml;
    }
    if (hasDeferOption) window.Pivot.legacy._deferPivotCharts = previousDefer;
    return rawHtml;
}


