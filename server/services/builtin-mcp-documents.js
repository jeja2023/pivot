/* 内置 MCP 能力 - 文档解析 Built-in Documents MCP
 *
 * 从纯文本/Markdown 内容中提取大纲、键值对或段落分块。
 * 由 builtin-mcp.js 拆分而来，逻辑保持不变。
 */
const { textInput } = require('./builtin-mcp-common');

function listDocumentTools() {
    return [
        {
            name: 'doc.extract_outline',
            title: '提取文档大纲',
            description: '从纯文本或 Markdown 内容中轻量提取标题层级与大纲结构。',
            inputSchema: {
                type: 'object',
                properties: {
                    text: { type: 'string' },
                    maxHeadings: { type: 'number', minimum: 1, maximum: 200 }
                },
                required: ['text']
            }
        },
        {
            name: 'doc.extract_key_values',
            title: '提取关键信息',
            description: '从文档文本中提取键值对风格的关键信息条目。',
            inputSchema: {
                type: 'object',
                properties: {
                    text: { type: 'string' },
                    maxItems: { type: 'number', minimum: 1, maximum: 500 }
                },
                required: ['text']
            }
        },
        {
            name: 'doc.chunk_text',
            title: '切分文档文本',
            description: '按段落感知将长文本智能切分为适合下游分析的文本分块。',
            inputSchema: {
                type: 'object',
                properties: {
                    text: { type: 'string' },
                    maxChars: { type: 'number', minimum: 200, maximum: 8000 }
                },
                required: ['text']
            }
        }
    ];
}

function executeDocumentTool(_server, name, input = {}) {
    const text = textInput(input);
    if (!text.trim()) {
        const err = new Error('文档文本内容不能为空。');
        err.status = 400;
        throw err;
    }
    if (name === 'doc.extract_outline') {
        const maxHeadings = Math.min(Math.max(Number(input.maxHeadings) || 50, 1), 200);
        const headings = [];
        text.split(/\r?\n/).forEach((line, index) => {
            const trimmed = line.trim();
            const markdown = trimmed.match(/^(#{1,6})\s+(.+)$/);
            const numbered = trimmed.match(/^(\d+(?:\.\d+)*[.)、])\s*(.{2,160})$/);
            if (markdown) {
                headings.push({ level: markdown[1].length, title: markdown[2].trim(), line: index + 1 });
            } else if (numbered) {
                headings.push({ level: Math.min(numbered[1].split('.').length, 6), title: numbered[2].trim(), line: index + 1 });
            }
        });
        return {
            type: 'document_outline',
            headings: headings.slice(0, maxHeadings),
            headingCount: headings.length,
            lineCount: text.split(/\r?\n/).length,
            charCount: text.length
        };
    }
    if (name === 'doc.extract_key_values') {
        const maxItems = Math.min(Math.max(Number(input.maxItems) || 100, 1), 500);
        const items = [];
        text.split(/\r?\n/).forEach((line, index) => {
            const match = line.trim().match(/^([^:：]{1,80})[:：]\s*(.{0,1000})$/);
            if (!match) return;
            items.push({ key: match[1].trim(), value: match[2].trim(), line: index + 1 });
        });
        return {
            type: 'document_key_values',
            items: items.slice(0, maxItems),
            itemCount: items.length
        };
    }
    if (name === 'doc.chunk_text') {
        const maxChars = Math.min(Math.max(Number(input.maxChars) || 1200, 200), 8000);
        const chunks = [];
        let current = '';
        for (const paragraph of text.split(/\n\s*\n/).map(item => item.trim()).filter(Boolean)) {
            if (current && current.length + paragraph.length + 2 > maxChars) {
                chunks.push(current);
                current = '';
            }
            if (paragraph.length > maxChars) {
                for (let i = 0; i < paragraph.length; i += maxChars) chunks.push(paragraph.slice(i, i + maxChars));
            } else {
                current = current ? `${current}\n\n${paragraph}` : paragraph;
            }
        }
        if (current) chunks.push(current);
        return {
            type: 'document_chunks',
            maxChars,
            chunks: chunks.map((chunk, index) => ({ index, text: chunk, charCount: chunk.length })),
            chunkCount: chunks.length
        };
    }
    throw new Error(`不支持的文档工具操作: ${name}`);
}

module.exports = {
    listDocumentTools,
    executeDocumentTool
};
