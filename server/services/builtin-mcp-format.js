/* 内置 MCP 能力 - 格式转换 Built-in Format Conversion MCP
 *
 * 将值在不同格式间转换（Markdown 表格、JSON 序列化、JSON 提取、文本规范化）。
 * 由 builtin-mcp.js 拆分而来，逻辑保持不变。
 */
const { buildTableBlock, textInput } = require('./builtin-mcp-common');

function listFormatConversionTools() {
    return [
        {
            name: 'format.to_markdown_table',
            description: 'Convert rows into a Markdown table block.',
            inputSchema: {
                type: 'object',
                properties: {
                    rows: { type: 'array', items: { type: 'object' } },
                    columns: { type: 'array', items: { type: 'string' } },
                    title: { type: 'string' },
                    limit: { type: 'number', minimum: 1, maximum: 1000 }
                },
                required: ['rows']
            }
        },
        {
            name: 'format.to_json',
            description: 'Serialize a value as compact or pretty JSON.',
            inputSchema: {
                type: 'object',
                properties: {
                    value: {},
                    pretty: { type: 'boolean' }
                },
                required: ['value']
            }
        },
        {
            name: 'format.extract_json',
            description: 'Extract and parse the first JSON object or array from text.',
            inputSchema: {
                type: 'object',
                properties: {
                    text: { type: 'string' }
                },
                required: ['text']
            }
        },
        {
            name: 'format.normalize_text',
            description: 'Normalize whitespace and optionally convert text case.',
            inputSchema: {
                type: 'object',
                properties: {
                    text: { type: 'string' },
                    mode: { type: 'string', enum: ['plain', 'lower', 'upper'] }
                },
                required: ['text']
            }
        }
    ];
}

function findJsonCandidate(text) {
    const raw = String(text || '');
    const starts = [];
    ['{', '['].forEach(char => {
        const index = raw.indexOf(char);
        if (index >= 0) starts.push(index);
    });
    starts.sort((a, b) => a - b);
    for (const start of starts) {
        const open = raw[start];
        const close = open === '{' ? '}' : ']';
        let depth = 0;
        let inString = false;
        let escaped = false;
        for (let index = start; index < raw.length; index += 1) {
            const char = raw[index];
            if (inString) {
                escaped = char === '\\' && !escaped;
                if (char === '"' && !escaped) inString = false;
                if (char !== '\\') escaped = false;
                continue;
            }
            if (char === '"') {
                inString = true;
                continue;
            }
            if (char === open) depth += 1;
            if (char === close) depth -= 1;
            if (depth === 0) {
                const candidate = raw.slice(start, index + 1);
                try {
                    return { value: JSON.parse(candidate), json: candidate };
                } catch (e) {
                    break;
                }
            }
        }
    }
    return null;
}

function executeFormatConversionTool(_server, name, input = {}) {
    if (name === 'format.to_markdown_table') {
        const table = buildTableBlock(input);
        return { type: 'format_markdown_table', markdown: table.markdown, columns: table.columns, rowCount: table.rowCount };
    }
    if (name === 'format.to_json') {
        return {
            type: 'format_json',
            json: JSON.stringify(input.value, null, input.pretty === false ? 0 : 2)
        };
    }
    if (name === 'format.extract_json') {
        const result = findJsonCandidate(input.text);
        if (!result) {
            const err = new Error('No JSON object or array was found in the text.');
            err.status = 400;
            throw err;
        }
        return { type: 'format_extracted_json', value: result.value, json: result.json };
    }
    if (name === 'format.normalize_text') {
        const mode = String(input.mode || 'plain').toLowerCase();
        let text = textInput(input).replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
        if (mode === 'lower') text = text.toLowerCase();
        if (mode === 'upper') text = text.toUpperCase();
        return { type: 'format_normalized_text', text, charCount: text.length };
    }
    throw new Error(`Unsupported format MCP tool: ${name}`);
}

module.exports = {
    listFormatConversionTools,
    findJsonCandidate,
    executeFormatConversionTool
};
