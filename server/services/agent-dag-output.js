const { clampText } = require('./agent-tool-runtime');
const { parseJsonObject } = require('./agent-validators');

const DAG_PERSISTED_OUTPUT_MAX_CHARS = Math.max(
    120000,
    Math.min(Number.parseInt(process.env.AGENT_DAG_OUTPUT_MAX_CHARS || '8000000', 10) || 8000000, 20000000)
);

function preparePersistedDagOutput(value) {
    let text = '';
    let serialized = '';
    try {
        serialized = JSON.stringify(value);
        if (serialized === undefined) serialized = 'null';
        text = typeof value === 'string' ? value : serialized;
    } catch (error) {
        const fallback = clampText(value, DAG_PERSISTED_OUTPUT_MAX_CHARS);
        return { value: fallback, serialized: JSON.stringify(fallback) };
    }
    if (text.length <= DAG_PERSISTED_OUTPUT_MAX_CHARS) return { value, serialized };
    const payload = value?.structuredContent && typeof value.structuredContent === 'object'
        ? value.structuredContent
        : value;
    const rows = Array.isArray(payload?.rows) ? payload.rows : [];
    if (!rows.length) {
        const truncated = {
            __partial: true,
            originalChars: text.length,
            text: `${text.slice(0, DAG_PERSISTED_OUTPUT_MAX_CHARS)}\n...[truncated]`,
            warning: '节点完整输出超过持久化上限，恢复运行时只能使用截断预览。'
        };
        return { value: truncated, serialized: JSON.stringify(truncated) };
    }
    const keptRows = [];
    let used = 0;
    let oversizedRowCount = 0;
    for (const row of rows) {
        const rowText = JSON.stringify(row);
        if (rowText.length > DAG_PERSISTED_OUTPUT_MAX_CHARS - 2000) {
            oversizedRowCount += 1;
            continue;
        }
        if (used + rowText.length > DAG_PERSISTED_OUTPUT_MAX_CHARS - 2000) break;
        keptRows.push(row);
        used += rowText.length;
    }
    const truncated = {
        structuredContent: {
            ...payload,
            rows: keptRows,
            __partial: true,
            originalRowCount: rows.length,
            persistedRowCount: keptRows.length,
            oversizedRowCount
        },
        text: '节点输出过大，已按完整记录保留前 ' + keptRows.length + '/' + rows.length + ' 条。',
        warning: '恢复运行时只能使用已持久化的完整记录。'
    };
    return { value: truncated, serialized: JSON.stringify(truncated) };
}

function persistedDagOutput(value) {
    return preparePersistedDagOutput(value).value;
}

function compactPreparedDagOutput(value, serialized, max = 12000) {
    const text = typeof value === 'string' ? value : String(serialized || '');
    if (!text) return '';
    return text.length > max ? `${text.slice(0, max)}\n...[truncated]` : text;
}

function parseMaybeJsonPayload(value) {
    if (!value) return value;
    if (typeof value === 'object') return value;
    if (typeof value !== 'string') return value;
    const text = value.trim();
    if (!text) return '';
    const parsed = parseJsonObject(text);
    return parsed || text;
}

function firstReadableString(...values) {
    return values
        .map(value => String(value || '').trim())
        .find(Boolean) || '';
}

function extractTextFromContentArray(content) {
    if (!Array.isArray(content)) return '';
    return content
        .map(item => {
            if (typeof item === 'string') return item;
            if (!item || typeof item !== 'object') return '';
            return firstReadableString(item.text, item.content, item.markdown);
        })
        .filter(Boolean)
        .join('\n')
        .trim();
}

function summarizeStructuredDagOutput(payload) {
    if (!payload || typeof payload !== 'object') return '';
    const structured = payload.structuredContent && typeof payload.structuredContent === 'object'
        ? payload.structuredContent
        : payload;
    if (!structured || typeof structured !== 'object') return '';
    const type = String(structured.type || '').trim();
    const markdown = String(structured.markdown || '').trim();
    if (markdown && ['pivot_table', 'pivot_report', 'format_markdown_table'].includes(type)) return markdown;
    if (type === 'pivot_chart') {
        const title = String(structured.title || '').trim();
        const points = Math.max(
            Array.isArray(structured.labels) ? structured.labels.length : 0,
            ...(Array.isArray(structured.series)
                ? structured.series.map(item => Array.isArray(item?.data) ? item.data.length : 0)
                : [0])
        );
        return `已生成图表${title ? `：${title}` : ''}${points ? `，包含 ${points} 个数据点` : ''}。`;
    }
    const rows = Array.isArray(structured.rows)
        ? structured.rows
        : Array.isArray(structured.data)
            ? structured.data
            : Array.isArray(structured.items)
                ? structured.items
                : [];
    if (rows.length) return `查询完成，返回 ${rows.length} 行数据。`;
    return '';
}

function extractReadableDagOutput(output) {
    const payload = parseMaybeJsonPayload(output);
    if (!payload) return '';
    if (typeof payload === 'string') return payload.trim();
    if (typeof payload !== 'object') return String(payload || '').trim();
    const contentText = extractTextFromContentArray(payload.content);
    return firstReadableString(
        typeof payload.content === 'string' ? payload.content : '',
        payload.text,
        payload.markdown,
        payload.answer,
        payload.message,
        payload.summary,
        summarizeStructuredDagOutput(payload),
        contentText
    );
}

module.exports = {
    DAG_PERSISTED_OUTPUT_MAX_CHARS,
    preparePersistedDagOutput,
    persistedDagOutput,
    compactPreparedDagOutput,
    summarizeStructuredDagOutput,
    extractReadableDagOutput
};
