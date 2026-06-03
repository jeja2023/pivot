function getRequestOrigin(req, publicUrl = '') {
    if (publicUrl) return publicUrl;
    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    return host ? `${proto}://${host}` : '';
}

function normalizeRegenerateFlag(value) {
    return value === true || value === 'true';
}

function flattenMessageContentForQuery(content) {
    if (typeof content === 'string') return content.trim();
    if (Array.isArray(content)) {
        return content.map(part => {
            if (typeof part === 'string') return part;
            if (!part || typeof part !== 'object') return '';
            if (part.type === 'text' && typeof part.text === 'string') return part.text;
            if (typeof part.text === 'string') return part.text;
            if (typeof part.content === 'string') return part.content;
            return '';
        }).filter(Boolean).join('\n').trim();
    }
    if (content && typeof content === 'object') {
        if (typeof content.text === 'string') return content.text.trim();
        if (typeof content.content === 'string') return content.content.trim();
    }
    return '';
}

function resolveRagQueryContent(content, history = []) {
    const currentContent = String(content || '').trim();
    if (currentContent) return currentContent;
    if (!Array.isArray(history)) return '';

    for (let i = history.length - 1; i >= 0; i -= 1) {
        const message = history[i];
        if (message?.role !== 'user') continue;
        const query = flattenMessageContentForQuery(message.content);
        if (!query || query.includes('PIVOT_RAG_CONTEXT_BEGIN')) continue;
        return query;
    }
    return '';
}

function extractModelText(data) {
    const choiceContent = data?.choices?.[0]?.message?.content;
    if (typeof choiceContent === 'string') return choiceContent;
    if (Array.isArray(choiceContent)) {
        return choiceContent.map(part => part?.text || part?.content || '').filter(Boolean).join('\n');
    }
    if (typeof data?.output_text === 'string') return data.output_text;
    if (Array.isArray(data?.output)) {
        return data.output.map(item => {
            if (typeof item?.content === 'string') return item.content;
            if (Array.isArray(item?.content)) {
                return item.content.map(part => part?.text || part?.content || '').filter(Boolean).join('\n');
            }
            return '';
        }).filter(Boolean).join('\n');
    }
    return '';
}

function extractModelTextFromRawResponse(rawText) {
    const text = String(rawText || '').trim();
    if (!text || text.startsWith('data:')) return { content: '', usage: null };
    try {
        const data = JSON.parse(text);
        return {
            content: extractModelText(data),
            usage: data?.usage || null
        };
    } catch (_err) {
        return { content: '', usage: null };
    }
}

function parsePlannerJson(text) {
    const raw = String(text || '').trim();
    if (!raw) return null;
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fenced ? fenced[1].trim() : raw;
    try {
        return JSON.parse(candidate);
    } catch (e) {
        const start = candidate.indexOf('{');
        const end = candidate.lastIndexOf('}');
        if (start >= 0 && end > start) {
            try {
                return JSON.parse(candidate.slice(start, end + 1));
            } catch (_inner) {}
        }
    }
    return null;
}

function cleanCapabilityDisplayName(value) {
    return String(value || '')
        .replace(/\s*MCP$/iu, '')
        .trim();
}

function formatMcpToolsForPlanner(tools) {
    return tools.slice(0, 40).map(tool => ({
        name: tool.fullName,
        server: cleanCapabilityDisplayName(tool.serverName),
        tool: tool.name,
        description: tool.description || '',
        input_schema: tool.input_schema || { type: 'object' }
    }));
}

function isDataResultMcpTool(tool) {
    const name = String(tool.name || tool.fullName || '');
    return name.startsWith('db.')
        || name === 'reports.query_table'
        || name === 'reports.read_file_summary'
        || name === 'reports.compare_files';
}

function extractRowsFromMcpResult(result) {
    const candidates = [
        result?.structuredContent?.rows,
        result?.structuredContent?.sampleRows,
        result?.rows,
        result?.sampleRows,
        Array.isArray(result) ? result : null
    ];
    return candidates.find(rows => Array.isArray(rows) && rows.length && rows.every(row => row && typeof row === 'object')) || [];
}

module.exports = {
    cleanCapabilityDisplayName,
    extractModelText,
    extractModelTextFromRawResponse,
    extractRowsFromMcpResult,
    formatMcpToolsForPlanner,
    getRequestOrigin,
    isDataResultMcpTool,
    normalizeRegenerateFlag,
    parsePlannerJson,
    resolveRagQueryContent
};
