// 知识库切片模块：按文档类型路由的结构感知切片 + 面包屑(headingPath)。
//
// 设计目标（面向法律法规 + 杂类混合知识库）：
//  - 法规类按「第X条」边界切片，单条尽量完整，并追踪「第X章/第X节」标题；
//  - markdown 按标题层级切片；表格按行序列化；其它走通用滑窗。
//  - 每个切片附带 headingPath（面包屑），用于上下文增强与精确引用。
//
// 切片本身只负责拆分与定位，不做向量化；headingPath 如何并入 embedding/检索
// 由 rag-index.js 决定（content 存原文，富文本=headingPath+content 参与向量与 FTS）。

const SENTENCE_BOUNDARY_RE = /[。！？!?；;.!?]/;
const HEADING_SEP = ' › ';

// 中文/阿拉伯数字序号字符集（用于章/节/条标题识别）。
const CN_NUM = '一二三四五六七八九十百千零〇两0-9';
const CHAPTER_RE = new RegExp(`^第\\s*[${CN_NUM}]+\\s*[章编]`);
const SECTION_RE = new RegExp(`^第\\s*[${CN_NUM}]+\\s*节`);
const ARTICLE_HEAD_RE = new RegExp(`^第\\s*[${CN_NUM}]+\\s*条`);
const ARTICLE_LABEL_RE = new RegExp(`^第\\s*[${CN_NUM}]+\\s*条`);
// 全文判定用：法规普遍存在「第X条」标记。
const ARTICLE_GLOBAL_RE = new RegExp(`第\\s*[${CN_NUM}]+\\s*条`, 'g');
const LEGAL_NAME_RE = /(办法|条例|规定|细则|规范|标准|准则|政策|法)(?:$|[\s（()）])/;
const MARKDOWN_HEADING_RE = /^#{1,6}\s+\S/;

// ---------- 通用滑窗（原 rag-index.chunkText 迁移至此，行为保持一致） ----------

function findParagraphChunkEnd(text, start, limit) {
    const slice = text.slice(start, limit);
    const boundaryIndex = slice.lastIndexOf('\n\n');
    if (boundaryIndex < 0) return -1;
    let end = start + boundaryIndex + 2;
    while (end < limit && text[end] === '\n') end += 1;
    return end;
}

function findSentenceChunkEnd(text, start, limit) {
    for (let i = limit - 1; i >= start; i -= 1) {
        if (SENTENCE_BOUNDARY_RE.test(text[i])) return i + 1;
    }
    return -1;
}

function findLineChunkEnd(text, start, limit) {
    const newlineIndex = text.lastIndexOf('\n', limit - 1);
    return newlineIndex >= start ? newlineIndex + 1 : -1;
}

// 通用递归滑窗切片：段落 > 句子 > 行 > 硬截断，带 overlap。
// 行为与历史实现保持一致（确定性、保留段落换行），上层用例对此有断言。
function chunkText(text, chunkSize = 500, overlap = 100) {
    const normalizedText = String(text || '').replace(/\r\n?/g, '\n').trim();
    const chunks = [];
    let i = 0;
    const step = Math.max(chunkSize - overlap, 1);
    const maxExtension = Math.max(32, Math.min(Math.max(overlap, 0), 120));
    while (i < normalizedText.length) {
        const hardEnd = Math.min(normalizedText.length, i + chunkSize);
        const searchStart = Math.min(normalizedText.length, i + step);
        const searchLimit = Math.min(normalizedText.length, i + chunkSize + maxExtension);
        let chunkEnd = findParagraphChunkEnd(normalizedText, searchStart, searchLimit);
        if (chunkEnd < 0) chunkEnd = findSentenceChunkEnd(normalizedText, searchStart, searchLimit);
        if (chunkEnd < 0) chunkEnd = findLineChunkEnd(normalizedText, searchStart, searchLimit);
        if (chunkEnd < 0 || chunkEnd <= i) chunkEnd = hardEnd;
        const chunk = normalizedText.slice(i, chunkEnd);
        if (chunk.length > 0) chunks.push(chunk);
        i += step;
    }
    return chunks;
}

// ---------- 面包屑工具 ----------

function deriveDocTitle(docName) {
    let title = String(docName || '').trim();
    title = title.replace(/\.[A-Za-z0-9]{1,8}$/, '');
    title = title.replace(/[_]+/g, ' ').trim();
    return title;
}

function bookTitle(title) {
    if (!title) return '';
    return /^《.*》$/.test(title) ? title : `《${title}》`;
}

function joinHeadingPath(parts) {
    return parts
        .map(part => String(part || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .map(part => (part.length > 80 ? `${part.slice(0, 80)}…` : part))
        .join(HEADING_SEP);
}

// ---------- 文档类型识别 ----------

function detectDocType(docName, text) {
    const name = String(docName || '').toLowerCase();
    const body = String(text || '');
    if (/\.(csv|xls|xlsx)$/.test(name)) return 'table';

    const articleMatches = body.match(ARTICLE_GLOBAL_RE) || [];
    const nameLegal = LEGAL_NAME_RE.test(deriveDocTitle(docName));
    if (articleMatches.length >= 3 || (nameLegal && articleMatches.length >= 1)) {
        return 'legal';
    }

    if (/\.(md|markdown)$/.test(name)) return 'markdown';
    const headingLines = (body.split(/\r\n?|\n/).filter(line => MARKDOWN_HEADING_RE.test(line)) || []).length;
    if (headingLines >= 2) return 'markdown';

    return 'prose';
}

// 单元过长时二次切分，复用通用滑窗并保留同一 headingPath。
function emitUnit(out, content, headingPath, chunkSize, overlap) {
    const trimmed = String(content || '').trim();
    if (!trimmed) return;
    const softLimit = Math.floor(chunkSize * 1.5);
    if (trimmed.length <= softLimit) {
        out.push({ content: trimmed, headingPath });
        return;
    }
    for (const piece of chunkText(trimmed, chunkSize, overlap)) {
        const text = piece.trim();
        if (text) out.push({ content: text, headingPath });
    }
}

// ---------- 法规切片 ----------

function chunkLegal(text, { docTitle, chunkSize, overlap }) {
    const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    const book = bookTitle(docTitle);
    let currentChapter = '';
    let currentSection = '';
    let preamble = [];
    let buffer = [];
    let currentArticle = '';

    const flushArticle = () => {
        if (!currentArticle && buffer.length === 0) return;
        const headingPath = joinHeadingPath([book, currentChapter, currentSection, currentArticle]);
        emitUnit(out, buffer.join('\n'), headingPath, chunkSize, overlap);
        buffer = [];
        currentArticle = '';
    };

    const flushPreamble = () => {
        if (preamble.join('').trim()) {
            const headingPath = joinHeadingPath([book, currentChapter, currentSection, '前言']);
            emitUnit(out, preamble.join('\n'), headingPath, chunkSize, overlap);
        }
        preamble = [];
    };

    for (const rawLine of lines) {
        const line = rawLine.trimStart();
        if (CHAPTER_RE.test(line)) {
            flushArticle();
            flushPreamble();
            currentChapter = line.trim();
            currentSection = '';
            continue;
        }
        if (SECTION_RE.test(line)) {
            flushArticle();
            flushPreamble();
            currentSection = line.trim();
            continue;
        }
        if (ARTICLE_HEAD_RE.test(line)) {
            flushArticle();
            flushPreamble();
            const label = (line.match(ARTICLE_LABEL_RE) || [''])[0].replace(/\s+/g, '');
            currentArticle = label;
            buffer.push(rawLine);
            continue;
        }
        if (currentArticle) {
            buffer.push(rawLine);
        } else {
            preamble.push(rawLine);
        }
    }
    flushArticle();
    flushPreamble();

    if (out.length === 0) {
        // 兜底：未能按条切出内容时退回通用滑窗。
        return chunkText(text, chunkSize, overlap).map(content => ({ content, headingPath: book }));
    }
    return out;
}

// ---------- markdown 切片 ----------

function parseMarkdownHeading(line) {
    const match = /^(#{1,6})\s+(.*\S)\s*$/.exec(line);
    if (!match) return null;
    return { level: match[1].length, title: match[2].trim() };
}

function chunkMarkdown(text, { docTitle, chunkSize, overlap }) {
    const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    const headingStack = [];
    let buffer = [];

    const headingPathOf = () => joinHeadingPath([docTitle, ...headingStack.map(item => item.title)]);
    const flush = () => {
        emitUnit(out, buffer.join('\n'), headingPathOf(), chunkSize, overlap);
        buffer = [];
    };

    for (const line of lines) {
        const heading = parseMarkdownHeading(line.trimStart());
        if (heading) {
            flush();
            while (headingStack.length && headingStack[headingStack.length - 1].level >= heading.level) {
                headingStack.pop();
            }
            headingStack.push(heading);
            continue;
        }
        buffer.push(line);
    }
    flush();

    if (out.length === 0) {
        return chunkText(text, chunkSize, overlap).map(content => ({ content, headingPath: docTitle }));
    }
    return out;
}

// ---------- 表格切片 ----------

function splitTableRow(line) {
    if (line.includes('\t')) return line.split('\t');
    if (line.includes(',')) return line.split(',');
    if (line.includes('，')) return line.split('，');
    return null;
}

function chunkTable(text, { docTitle, chunkSize, overlap }) {
    const lines = String(text || '')
        .replace(/\r\n?/g, '\n')
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean);
    if (lines.length < 2) {
        return chunkText(text, chunkSize, overlap).map(content => ({ content, headingPath: docTitle }));
    }
    const header = splitTableRow(lines[0]);
    if (!header || header.length < 2) {
        return chunkText(text, chunkSize, overlap).map(content => ({ content, headingPath: docTitle }));
    }
    const cols = header.map(col => col.trim());
    const headingPath = joinHeadingPath([docTitle, `表头: ${cols.join(', ')}`]);
    const out = [];
    let buffer = [];
    let bufLen = 0;
    const flush = () => {
        if (!buffer.length) return;
        out.push({ content: buffer.join('\n'), headingPath });
        buffer = [];
        bufLen = 0;
    };
    for (let r = 1; r < lines.length; r += 1) {
        const cells = splitTableRow(lines[r]) || [lines[r]];
        const serialized = cols
            .map((col, idx) => `${col}: ${(cells[idx] ?? '').toString().trim()}`)
            .join(' | ');
        buffer.push(serialized);
        bufLen += serialized.length + 1;
        if (bufLen >= chunkSize) flush();
    }
    flush();
    if (out.length === 0) {
        return chunkText(text, chunkSize, overlap).map(content => ({ content, headingPath: docTitle }));
    }
    return out;
}

// ---------- 统一入口 ----------

// chunkDocument：按文档类型路由切片，返回 [{ content, headingPath }]。
// content 始终为原文片段；headingPath 为面包屑（可能为空字符串）。
function chunkDocument(text, options = {}) {
    const normalized = String(text || '').replace(/\r\n?/g, '\n');
    if (!normalized.trim()) return [];
    const docName = options.docName || '';
    const docTitle = deriveDocTitle(docName);
    const chunkSize = Math.max(Number.parseInt(options.chunkSize, 10) || 500, 64);
    const overlap = Math.max(Math.min(Number.parseInt(options.overlap, 10) || 0, Math.floor(chunkSize / 2)), 0);
    const docType = options.docType || detectDocType(docName, normalized);

    let result;
    if (docType === 'legal') {
        result = chunkLegal(normalized, { docTitle, chunkSize, overlap });
    } else if (docType === 'markdown') {
        result = chunkMarkdown(normalized, { docTitle, chunkSize, overlap });
    } else if (docType === 'table') {
        result = chunkTable(normalized, { docTitle, chunkSize, overlap });
    } else {
        result = chunkText(normalized, chunkSize, overlap).map(content => ({
            content,
            headingPath: docTitle
        }));
    }

    // 防御：任何分支异常返回空时退回通用滑窗，保证非空文本必出片。
    if (!Array.isArray(result) || result.length === 0) {
        result = chunkText(normalized, chunkSize, overlap).map(content => ({ content, headingPath: docTitle }));
    }
    return result.filter(item => item && String(item.content || '').trim());
}

module.exports = {
    chunkText,
    chunkDocument,
    detectDocType,
    deriveDocTitle
};
