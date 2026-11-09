'use strict';

function projectMcpOutput(value) {
    if (!value || typeof value !== 'object' || value.structuredContent || !Array.isArray(value.content)
        || value.content.length !== 1 || value.content[0]?.type !== 'text' || typeof value.content[0].text !== 'string') return value;
    try {
        const parsed = JSON.parse(value.content[0].text);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return value;
        const structuredContent = { ...parsed };
        // 只作模型侧无损解包，完整审计与原文仍保留原协议；不把资料字段提升为可信的知识来源标识。
        if (typeof structuredContent.content === 'string') {
            try { structuredContent.content = JSON.parse(structuredContent.content); structuredContent.contentEncoding = 'json'; } catch (_) { /* 普通文本保留原值。 */ }
        }
        const { content: _content, ...metadata } = value;
        return { ...metadata, structuredContent };
    } catch (_) { return value; }
}

function truncateJsonStrings(value, maxChars, depth = 0) {
    if (depth > 12) return value;
    if (typeof value === 'string') return value.length > maxChars ? `${value.slice(0, maxChars)}…[本字段未完整传入模型，原文见rawOutputRef]` : value;
    if (Array.isArray(value)) return value.map(item => truncateJsonStrings(item, maxChars, depth + 1));
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, truncateJsonStrings(item, maxChars, depth + 1)]));
}

function compactBatchOutput(value, targetTokens, compact) {
    const results = value.results.map(item => ({ toolName: item.toolName,
        output: compact(item.output, Math.max(256, Math.floor((targetTokens - 200) / value.results.length))) }));
    return { ...value, results, ...(results.some(item => item.output?.__partial || item.output?.structuredContent?.__partial) ? { __partial: true } : {}) };
}

function observationSummaries(preview) {
    const items = preview?.type === 'tools_batch_read' && Array.isArray(preview.results)
        ? preview.results.map(item => ({ tool: item.toolName, output: item.output })) : [{ output: preview }];
    return items.map(item => ({ ...item, summary: String(JSON.stringify(truncateJsonStrings(item.output?.structuredContent || item.output, 240)) || '').slice(0, 2000) }));
}

module.exports = { compactBatchOutput, observationSummaries, projectMcpOutput, truncateJsonStrings };
