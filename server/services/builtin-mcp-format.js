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
            title: '转换 Markdown 表格',
            description: '将数据行数组转换为标准 Markdown 表格块。',
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
            title: '转换 JSON',
            description: '将输入值序列化为紧凑或美化格式的 JSON 字符串。',
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
            title: '提取 JSON',
            description: '从非结构化文本中查找并解析第一个有效 JSON 对象或数组。',
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
            title: '规范化文本',
            description: '规范化文本中的空白字符，并可选转换为指定的大小写模式。',
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
            const err = new Error('文本中未找到合法的 JSON 对象或数组。');
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
    throw new Error(`不支持的格式工具操作: ${name}`);
}

module.exports = {
    listFormatConversionTools,
    findJsonCandidate,
    executeFormatConversionTool
};
