// --- UI 渲染模块 Render (完整功能版) ---
/* exported appendMessage, renderAttachmentPreviews, rememberThoughtStateBeforeRender, restoreThoughtStateAfterRender */
const ICONS = {
    user: `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="white" stroke-width="2.5"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`,
    ai: `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z"/></svg>`,
    copy: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`,
    delete: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>`,
    fork: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="3"/><circle cx="18" cy="6" r="3"/><circle cx="18" cy="18" r="3"/><path d="M9 6h3a6 6 0 0 1 6 6v3"/><path d="M9 6h9"/></svg>`,
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
    if (!text) return '???????';

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
    const normalizedLanguage = language.toLowerCase();
    const chartLanguages = new Set(['pivot-echart', 'pivot-chart', 'chart', 'charts']);
    if (normalizedLanguage === 'pivot-echart' || (chartLanguages.has(normalizedLanguage) && normalizePivotChartSpec(code))) {
        return `<div class="pivot-echart-block" data-pivot-echart="${escapeAttrValue(code)}"><div class="pivot-echart-title">图表</div><div class="pivot-echart-canvas"></div><canvas height="300"></canvas><pre class="pivot-echart-error-text"></pre></div>`;
    }
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

function normalizePivotChartSpec(raw) {
    let spec = null;
    try {
        spec = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (e) {
        return null;
    }
    if (!spec || typeof spec !== 'object') return null;
    if (spec.type !== 'pivot_chart' && spec.data && typeof spec.data === 'object') {
        spec = coerceSimpleChartSpec(spec);
    }
    if (!spec || spec.type !== 'pivot_chart' || !Array.isArray(spec.labels) || !Array.isArray(spec.series)) return null;
    return {
        chartType: ['bar', 'line', 'area', 'pie'].includes(spec.chartType) ? spec.chartType : 'bar',
        title: String(spec.title || '图表'),
        labels: spec.labels.map(label => String(label ?? '')).slice(0, 80),
        series: spec.series.slice(0, 20).map(item => ({
            name: String(item?.name || '系列'),
            data: Array.isArray(item?.data) ? item.data.map(value => Number(value) || 0).slice(0, 80) : []
        })),
        xAxis: spec.xAxis || null,
        yAxis: spec.yAxis || null,
        echartsOption: spec.echartsOption || spec.option || null,
        source: spec.source || {}
    };
}

function coerceSimpleChartSpec(input) {
    const data = input?.data || {};
    const config = input?.config || {};
    const xValues = Array.isArray(data.x) ? data.x : (Array.isArray(input.labels) ? input.labels : []);
    const yValues = Array.isArray(data.y) ? data.y : (Array.isArray(input.values) ? input.values : []);
    if (!xValues.length || !yValues.length) return null;
    const firstSeries = Array.isArray(yValues[0]) ? yValues[0] : yValues;
    const chartType = String(config.chartType || input.chartType || 'bar').toLowerCase();
    return {
        type: 'pivot_chart',
        chartType: ['bar', 'line', 'area', 'pie'].includes(chartType) ? chartType : 'bar',
        title: config.title || input.title || '图表',
        labels: xValues,
        series: [{
            name: config.yAxisLabel || input.yAxisLabel || '数值',
            data: firstSeries
        }],
        xAxis: { label: config.xAxisLabel || input.xAxisLabel || '分类' },
        yAxis: { label: config.yAxisLabel || input.yAxisLabel || '数值' },
        source: { format: 'simple_chart' }
    };
}

function buildEchartsOptionFromPivotSpec(spec) {
    if (spec.echartsOption && typeof spec.echartsOption === 'object') return polishEchartsLayoutOption(spec.echartsOption);
    const chartType = spec.chartType === 'area' ? 'line' : spec.chartType;
    const baseTitle = { text: spec.title, left: 18, top: 16, textStyle: { fontSize: 15, fontWeight: 700, color: '#334155' } };
    if (chartType === 'pie') {
        const values = spec.series[0]?.data || [];
        return {
            title: baseTitle,
            tooltip: { trigger: 'item' },
            legend: { top: 50, left: 'center', type: 'scroll' },
            series: [{
                name: spec.series[0]?.name || '系列',
                type: 'pie',
                radius: ['35%', '68%'],
                center: ['50%', '58%'],
                data: spec.labels.map((label, index) => ({ name: label, value: values[index] || 0 }))
            }]
        };
    }
    return {
        title: baseTitle,
        color: ['#10a37f', '#2563eb', '#f59e0b', '#ef4444', '#7c3aed', '#0891b2'],
        tooltip: { trigger: 'axis', confine: true },
        legend: { top: 50, right: 18, type: 'scroll' },
        grid: { left: 68, right: 32, top: 96, bottom: 64, containLabel: true },
        xAxis: {
            type: 'category',
            name: spec.xAxis?.label || spec.xAxis?.field || '分类',
            nameLocation: 'middle',
            nameGap: 38,
            nameTextStyle: { color: '#64748b', fontWeight: 600 },
            axisLabel: { hideOverlap: true, margin: 12 },
            data: spec.labels
        },
        yAxis: {
            type: 'value',
            name: spec.yAxis?.label || (spec.yAxis?.field === '__count__' ? '数量' : spec.yAxis?.field || '数值'),
            nameLocation: 'middle',
            nameRotate: 90,
            nameGap: 56,
            nameTextStyle: { color: '#64748b', fontWeight: 600 },
            axisLabel: { margin: 10 },
            splitLine: { lineStyle: { color: '#e2e8f0' } }
        },
        series: spec.series.map(item => ({
            name: item.name,
            type: chartType,
            data: item.data,
            smooth: chartType === 'line',
            areaStyle: spec.chartType === 'area' ? {} : undefined,
            emphasis: { focus: 'series' }
        }))
    };
}

function polishEchartsLayoutOption(option) {
    const polishTitle = (title = {}) => ({
        ...title,
        left: title.left ?? 18,
        top: 16,
        textStyle: { fontSize: 15, fontWeight: 700, color: '#334155', ...(title.textStyle || {}) }
    });
    const polishLegend = (legend = {}) => ({
        ...legend,
        top: 50,
        right: legend.right ?? 18,
        type: legend.type || 'scroll'
    });
    const polishGrid = (grid = {}) => ({
        ...grid,
        left: grid.left ?? 68,
        right: grid.right ?? 32,
        top: 96,
        bottom: grid.bottom ?? 64,
        containLabel: true
    });
    const polishAxis = (axis, type) => ({
        ...axis,
        ...(type === 'x' ? {
            nameLocation: 'middle',
            nameGap: Number(axis?.nameGap || 0) < 36 ? 38 : axis.nameGap,
            nameTextStyle: { color: '#64748b', fontWeight: 600, ...(axis?.nameTextStyle || {}) },
            axisLabel: { hideOverlap: true, margin: 12, ...(axis?.axisLabel || {}) }
        } : {
            nameLocation: 'middle',
            nameRotate: 90,
            nameGap: Number(axis?.nameGap || 0) < 52 ? 56 : axis.nameGap,
            nameTextStyle: { color: '#64748b', fontWeight: 600, ...(axis?.nameTextStyle || {}) },
            axisLabel: { margin: 10, ...(axis?.axisLabel || {}) },
            splitLine: { lineStyle: { color: '#e2e8f0' }, ...(axis?.splitLine || {}) }
        })
    });
    const polishAxes = (axes, type) => Array.isArray(axes)
        ? axes.map(axis => polishAxis(axis || {}, type))
        : polishAxis(axes || {}, type);
    return {
        ...option,
        title: Array.isArray(option.title)
            ? option.title.map(item => polishTitle(item || {}))
            : polishTitle(option.title || {}),
        legend: option.legend
            ? (Array.isArray(option.legend) ? option.legend.map(item => polishLegend(item || {})) : polishLegend(option.legend))
            : option.legend,
        grid: option.grid
            ? (Array.isArray(option.grid) ? option.grid.map(item => polishGrid(item || {})) : polishGrid(option.grid))
            : option.grid,
        xAxis: option.xAxis ? polishAxes(option.xAxis, 'x') : option.xAxis,
        yAxis: option.yAxis ? polishAxes(option.yAxis, 'y') : option.yAxis
    };
}

function renderEcharts(block, spec) {
    const mount = block.querySelector('.pivot-echart-canvas');
    if (!mount || !window.echarts) return false;
    mount.hidden = false;
    mount.style.height = '340px';
    mount.innerHTML = '';
    const chart = window.echarts.init(mount, null, { renderer: 'canvas' });
    chart.setOption(buildEchartsOptionFromPivotSpec(spec), true);
    const onResize = () => chart.resize();
    window.addEventListener('resize', onResize, { passive: true });
    block._pivotEchart = chart;
    block._pivotEchartResize = onResize;
    return true;
}

function drawPivotChart(canvas, spec) {
    const ctx = canvas?.getContext?.('2d');
    if (!ctx || !spec) return;
    const rect = canvas.getBoundingClientRect();
    const parentWidth = canvas.parentElement?.clientWidth || 0;
    const width = Math.max(rect.width || parentWidth || 620, 320);
    const height = Number(canvas.getAttribute('height')) || 300;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = width * ratio;
    canvas.height = height * ratio;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const palette = ['#10a37f', '#2563eb', '#f59e0b', '#ef4444', '#7c3aed', '#0891b2'];
    const padLeft = 72;
    const padRight = 22;
    const padTop = 28;
    const padBottom = 64;
    const chartW = width - padLeft - padRight;
    const chartH = height - padTop - padBottom;
    const allValues = spec.series.flatMap(item => item.data);
    const maxValue = Math.max(...allValues, 0);
    const minValue = Math.min(...allValues, 0);
    const rangeMax = maxValue === minValue ? maxValue + 1 : maxValue;
    const rangeMin = maxValue === minValue ? Math.min(0, minValue - 1) : minValue;
    const valueRange = rangeMax - rangeMin || 1;
    const valueToY = (value) => padTop + chartH - ((value - rangeMin) / valueRange) * chartH;
    const zeroY = valueToY(0);
    const xAxisLabel = String(spec.xAxis?.label || spec.xAxis?.field || '??').trim();
    const yAxisLabel = String(spec.yAxis?.label || (spec.yAxis?.field === '__count__' ? '??' : spec.yAxis?.field || '??')).trim();
    const legendItems = spec.series.slice(0, 4).map((item, index) => ({
        label: String(item.name || '??').trim() || '??',
        color: palette[index % palette.length]
    }));

    if (spec.chartType === 'pie') {
        const values = spec.series[0]?.data || [];
        const total = values.reduce((sum, value) => sum + Math.max(value, 0), 0) || 1;
        const radius = Math.min(chartW, chartH) * 0.36;
        const cx = padLeft + chartW * 0.38;
        const cy = padTop + chartH * 0.5;
        let start = -Math.PI / 2;
        values.forEach((value, index) => {
            const angle = (Math.max(value, 0) / total) * Math.PI * 2;
            ctx.beginPath();
            ctx.moveTo(cx, cy);
            ctx.arc(cx, cy, radius, start, start + angle);
            ctx.closePath();
            ctx.fillStyle = palette[index % palette.length];
            ctx.fill();
            start += angle;
        });
        ctx.font = '12px sans-serif';
        spec.labels.slice(0, 8).forEach((label, index) => {
            const x = padLeft + chartW * 0.72;
            const y = padTop + 18 + index * 22;
            ctx.fillStyle = palette[index % palette.length];
            ctx.fillRect(x, y - 10, 10, 10);
            ctx.fillStyle = '#475569';
            ctx.fillText(`${label}: ${values[index] ?? 0}`, x + 16, y);
        });
        return;
    }

    ctx.strokeStyle = '#e5e7eb';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i += 1) {
        const y = padTop + chartH * (i / 4);
        ctx.beginPath();
        ctx.moveTo(padLeft, y);
        ctx.lineTo(width - padRight, y);
        ctx.stroke();
    }
    ctx.fillStyle = '#64748b';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'right';
    for (let i = 0; i <= 4; i += 1) {
        const value = rangeMax - valueRange * (i / 4);
        ctx.fillText(Number(value.toFixed(1)).toLocaleString(), padLeft - 8, padTop + chartH * (i / 4) + 4);
    }
    if (rangeMin < 0 && rangeMax > 0) {
        ctx.strokeStyle = '#94a3b8';
        ctx.beginPath();
        ctx.moveTo(padLeft, zeroY);
        ctx.lineTo(width - padRight, zeroY);
        ctx.stroke();
    }

    if (yAxisLabel) {
        ctx.save();
        ctx.translate(18, padTop + chartH / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.fillStyle = '#64748b';
        ctx.font = '600 11px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(yAxisLabel, 0, 0);
        ctx.restore();
    }

    if (legendItems.length) {
        ctx.save();
        ctx.font = '11px sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        const legendLabels = legendItems.map(item => ({
            color: item.color,
            label: item.label.toLowerCase() === 'count' ? '??' : item.label
        }));
        const itemWidths = legendLabels.map(item => ctx.measureText(item.label).width + 20);
        let legendX = width - padRight - itemWidths.reduce((sum, value) => sum + value, 0) - Math.max(0, legendItems.length - 1) * 10;
        const legendY = 14;
        legendLabels.forEach((item, index) => {
            const itemWidth = itemWidths[index];
            ctx.fillStyle = item.color;
            ctx.fillRect(legendX, legendY - 4, 8, 8);
            ctx.fillStyle = '#475569';
            ctx.fillText(item.label, legendX + 12, legendY);
            legendX += itemWidth + 10;
        });
        ctx.restore();
    }

    const labels = spec.labels.length ? spec.labels : [''];
    if (spec.chartType === 'line' || spec.chartType === 'area') {
        spec.series.forEach((item, seriesIndex) => {
            const points = labels.map((_, index) => ({
                x: padLeft + (labels.length === 1 ? chartW / 2 : chartW * index / (labels.length - 1)),
                y: valueToY(item.data[index] || 0)
            }));
            if (spec.chartType === 'area' && points.length) {
                ctx.beginPath();
                points.forEach((point, index) => index === 0 ? ctx.moveTo(point.x, zeroY) : null);
                points.forEach((point, index) => index === 0 ? ctx.lineTo(point.x, point.y) : ctx.lineTo(point.x, point.y));
                ctx.lineTo(points[points.length - 1].x, zeroY);
                ctx.closePath();
                ctx.fillStyle = palette[seriesIndex % palette.length] + '2b';
                ctx.fill();
            }
            ctx.beginPath();
            points.forEach((point, index) => index === 0 ? ctx.moveTo(point.x, point.y) : ctx.lineTo(point.x, point.y));
            ctx.strokeStyle = palette[seriesIndex % palette.length];
            ctx.lineWidth = 2;
            ctx.stroke();
            ctx.fillStyle = palette[seriesIndex % palette.length];
            points.forEach(point => {
                ctx.beginPath();
                ctx.arc(point.x, point.y, 3, 0, Math.PI * 2);
                ctx.fill();
            });
        });
    } else {
        const groupCount = Math.max(spec.series.length, 1);
        const slotW = chartW / labels.length;
        const barW = Math.max(Math.min(slotW / groupCount * 0.68, 34), 4);
        labels.forEach((_, labelIndex) => {
            spec.series.forEach((item, seriesIndex) => {
                const value = item.data[labelIndex] || 0;
                const y = valueToY(value);
                const x = padLeft + labelIndex * slotW + slotW / 2 - (groupCount * barW) / 2 + seriesIndex * barW;
                ctx.fillStyle = palette[seriesIndex % palette.length];
                ctx.fillRect(x, Math.min(y, zeroY), Math.max(barW - 2, 2), Math.abs(zeroY - y));
            });
        });
    }

    const labelStep = Math.max(1, Math.ceil(labels.length / Math.max(4, Math.floor(width / 90))));
    ctx.fillStyle = '#64748b';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    labels.forEach((label, index) => {
        if (index % labelStep !== 0 && index !== labels.length - 1) return;
        const x = padLeft + (labels.length === 1 ? chartW / 2 : chartW * index / Math.max(labels.length - 1, 1));
        ctx.fillText(String(label).slice(0, 12), x, height - padBottom + 24);
    });

    if (xAxisLabel) {
        ctx.fillStyle = '#64748b';
        ctx.font = '600 11px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(xAxisLabel, padLeft + chartW / 2, height - 14);
    }
}

function renderPivotCharts(root = document) {
    root.querySelectorAll?.('.pivot-echart-block[data-pivot-echart]').forEach(block => {
        if (block.dataset.rendered === '1') return;
        const spec = normalizePivotChartSpec(block.dataset.pivotEchart || '');
        const canvas = block.querySelector('canvas');
        const title = block.querySelector('.pivot-echart-title');
        const echartMount = block.querySelector('.pivot-echart-canvas');
        if (!spec || !canvas) {
            block.classList.add('is-error');
            if (title) {
                title.hidden = false;
                title.textContent = '图表渲染失败';
            }
            if (echartMount) echartMount.hidden = true;
            if (canvas) canvas.hidden = true;
            const errorText = block.querySelector('.pivot-echart-error-text');
            if (errorText) {
                errorText.textContent = compactChartErrorText(block.dataset.pivotEchart || '');
            }
            return;
        }
        block.classList.remove('is-error');
        const rendered = renderEcharts(block, spec);
        canvas.hidden = rendered;
        if (title) {
            title.hidden = rendered;
            title.textContent = '图表预览';
        }
        if (!rendered) {
            if (echartMount) echartMount.hidden = true;
            drawPivotChart(canvas, spec);
        }
        block.dataset.rendered = '1';
    });
}

window.renderPivotCharts = renderPivotCharts;

function compactChartErrorText(raw) {
    const text = String(raw || '').trim();
    if (!text) return '图表配置为空';
    return text.length > 360 ? `${text.slice(0, 360)}\n...` : text;
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
    if (id) div.dataset.messageId = String(id);
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
        <div class="message-content"${id ? ` data-message-id="${id}"` : ''}>
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
                ${id ? `<button class="action-btn" data-message-action="fork" data-message-id="${id}" title="从这里分叉">${ICONS.fork}</button>` : ''}
                ${role === 'assistant' && id ? `<button class="action-btn" data-message-action="regenerate" data-message-id="${id}" title="重新回答"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><polyline points="23 20 23 14 17 14"/><path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10M23 14l-4.64 4.36A9 9 0 0 1 3.51 15"/></svg></button>` : ''}
                ${id ? `<button class="action-btn" data-message-action="delete" data-message-id="${id}" title="删除">${ICONS.delete}</button>` : ''}
            </div>
        </div>
    `;
    container.appendChild(div);
    if (role === 'assistant') bindThoughtStateTracking(div.querySelector('.text-body'));
    if (role === 'assistant') renderPivotCharts(div);
    window.scrollMessagesToBottom?.();
    return div.querySelector('.message-content');
}

function setMessageActionId(messageContent, id) {
    const messageId = Number.parseInt(id, 10);
    if (!messageContent || !Number.isSafeInteger(messageId)) return;

    const message = messageContent.closest('.message');
    const role = message?.classList.contains('assistant') ? 'assistant' : 'user';
    const actions = messageContent.querySelector('.message-actions');
    const copyButton = actions?.querySelector('[data-message-action="copy"]');
    if (!actions || !copyButton) return;

    message.dataset.messageId = String(messageId);
    messageContent.dataset.messageId = String(messageId);
    actions.querySelectorAll('[data-message-id]').forEach(button => {
        button.dataset.messageId = String(messageId);
    });

    if (!actions.querySelector('[data-message-action="fork"]')) {
        const forkButton = document.createElement('button');
        forkButton.className = 'action-btn';
        forkButton.type = 'button';
        forkButton.dataset.messageAction = 'fork';
        forkButton.dataset.messageId = String(messageId);
        forkButton.title = '从这里分叉';
        forkButton.innerHTML = ICONS.fork;
        copyButton.insertAdjacentElement('afterend', forkButton);
    }

    if (role === 'assistant' && !actions.querySelector('[data-message-action="regenerate"]')) {
        const regenerateButton = document.createElement('button');
        regenerateButton.className = 'action-btn';
        regenerateButton.type = 'button';
        regenerateButton.dataset.messageAction = 'regenerate';
        regenerateButton.dataset.messageId = String(messageId);
        regenerateButton.title = '重新回答';
        regenerateButton.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><polyline points="23 20 23 14 17 14"/><path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10M23 14l-4.64 4.36A9 9 0 0 1 3.51 15"/></svg>';
        const forkButton = actions.querySelector('[data-message-action="fork"]') || copyButton;
        forkButton.insertAdjacentElement('afterend', regenerateButton);
    }

    if (!actions.querySelector('[data-message-action="delete"]')) {
        const deleteButton = document.createElement('button');
        deleteButton.className = 'action-btn';
        deleteButton.type = 'button';
        deleteButton.dataset.messageAction = 'delete';
        deleteButton.dataset.messageId = String(messageId);
        deleteButton.title = '删除';
        deleteButton.innerHTML = ICONS.delete;
        actions.appendChild(deleteButton);
    }
}

window.setMessageActionId = setMessageActionId;

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
        if (action === 'fork' && Number.isSafeInteger(messageId)) window.forkSessionFromMessage?.(messageId);
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
