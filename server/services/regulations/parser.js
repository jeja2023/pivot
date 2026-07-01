const {
    REGULATION_ARTICLE_LABEL_RE,
    PUNCTUATION_SPLIT_RE,
    REGULATION_MD_HEADING_RE,
    REGULATION_CN_SECTION_RE,
    normalizeRegulationText,
    normalizeRegulationField,
    normalizeRegulationSummary,
    buildRagSearchContent,
    chunkDocument,
    getChunkSizeForDocType,
    deriveRegulationTitleFromFilename
} = require('./shared');

function deriveRegulationTitleFromText(extractedText, fallbackName = '') {
    const filenameTitle = deriveRegulationTitleFromFilename(fallbackName);
    if (filenameTitle) return filenameTitle;
    const text = normalizeRegulationText(extractedText);
    const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
    for (const line of lines.slice(0, 24)) {
        if (!REGULATION_ARTICLE_LABEL_RE.test(line) && line.length >= 4 && line.length <= 120) {
            return normalizeRegulationField(line, 120);
        }
    }
    return '\u6cd5\u89c4\u6587\u6863';
}

function deriveRegulationSummary({ title, extractedText, articles, providedSummary = '' }) {
    const safeSummary = normalizeRegulationSummary(providedSummary);
    if (safeSummary) return safeSummary;
    const text = normalizeRegulationText(extractedText);
    const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
    const intro = lines
        .filter(line => !REGULATION_ARTICLE_LABEL_RE.test(line))
        .slice(0, 3)
        .join(' ')
        .trim();
    if (intro) return normalizeRegulationSummary(intro);
    const firstArticle = articles[0];
    if (firstArticle) {
        return normalizeRegulationSummary([
            title,
            firstArticle.articleLabel,
            firstArticle.articleTitle,
            firstArticle.content.slice(0, 180)
        ].filter(Boolean).join(' '));
    }
    return normalizeRegulationSummary(title || '法规文档');
}

function deriveArticleTitle(articleLabel, content, fallbackTitle = '') {
    const safeFallback = normalizeRegulationField(fallbackTitle, 80);
    if (safeFallback) return safeFallback;
    const normalized = normalizeRegulationText(content);
    const firstLine = normalized.split('\n').find(Boolean) || '';
    const stripped = firstLine.replace(new RegExp(`^${articleLabel}\\s*`), '').trim();
    const candidate = stripped || firstLine;
    if (!candidate) return articleLabel;
    const head = candidate.split(PUNCTUATION_SPLIT_RE)[0].trim();
    return normalizeRegulationField(head || candidate, 80);
}

// 判定文档主体结构：优先「第X条」，其次 Markdown 标题，再次中文/数字小节
function detectRegulationStructure(lines) {
    let article = 0;
    let heading = 0;
    let section = 0;
    for (const rawLine of lines) {
        const line = String(rawLine || '').trim();
        if (!line) continue;
        if (REGULATION_ARTICLE_LABEL_RE.test(line)) article += 1;
        else if (REGULATION_MD_HEADING_RE.test(line)) heading += 1;
        else if (REGULATION_CN_SECTION_RE.test(line)) section += 1;
    }
    if (article >= 1) return 'article';
    if (heading >= 2) return 'heading';
    if (section >= 3) return 'section';
    return null;
}

// 按所选结构识别一行是否为新条文/小节的起始，返回标签与标题信息
function detectRegulationHeadingLine(line, strategy) {
    if (strategy === 'article') {
        const m = line.match(REGULATION_ARTICLE_LABEL_RE);
        if (!m) return null;
        return {
            label: `第${m[1]}条${m[2] ? `之${m[2]}` : ''}`,
            title: normalizeRegulationField(m[3], 80),
            derive: true,
            includeHeadingLine: true
        };
    }
    if (strategy === 'heading') {
        const m = line.match(REGULATION_MD_HEADING_RE);
        if (!m) return null;
        const headingText = normalizeRegulationField(m[1], 80);
        if (!headingText) return null;
        return { label: headingText, title: '', derive: false };
    }
    if (strategy === 'section') {
        const m = line.match(REGULATION_CN_SECTION_RE);
        if (!m) return null;
        const marker = m[1];
        return {
            label: normalizeRegulationField(marker, 40),
            title: normalizeRegulationField(line.slice(m[0].length), 80),
            derive: false
        };
    }
    return null;
}

function splitRegulationArticlesByStrategy(lines, strategy) {
    const articles = [];
    let current = null;
    let preambleLines = [];
    const finalize = () => {
        if (!current) return;
        const content = normalizeRegulationText(current.lines.join('\n'));
        if (!content) return;
        const order = articles.length + 1;
        const label = normalizeRegulationField(current.label || `第${order}节`, 40) || `第${order}节`;
        const title = current.derive
            ? deriveArticleTitle(current.label || '', content, current.title)
            : normalizeRegulationField(current.title, 80);
        articles.push({
            sortOrder: order,
            articleLabel: label,
            articleTitle: title,
            content,
            headingPath: '',
            searchContent: buildRagSearchContent([current.label, current.title, content].filter(Boolean).join(' '))
        });
    };
    // 首条正文之前的内容（标题、颁布信息、目录、序言等）单列为「前言」保留，避免解析后整块丢失。
    // 该「前言」不带「第X条」标签，故不计入实际条数（见 countActualRegulationArticles）。
    const finalizePreamble = () => {
        const content = normalizeRegulationText(preambleLines.join('\n'));
        preambleLines = [];
        if (!content) return;
        articles.push({
            sortOrder: articles.length + 1,
            articleLabel: '前言',
            articleTitle: '',
            content,
            headingPath: '',
            searchContent: buildRagSearchContent(content)
        });
    };
    for (const rawLine of lines) {
        const line = String(rawLine || '').trim();
        if (!line) {
            if (current) current.lines.push('');
            else preambleLines.push('');
            continue;
        }
        const head = detectRegulationHeadingLine(line, strategy);
        if (head) {
            if (current) finalize();
            else finalizePreamble();
            current = { ...head, lines: head.includeHeadingLine ? [line] : [] };
            continue;
        }
        if (current) current.lines.push(line);
        else preambleLines.push(line);
    }
    if (current) finalize();
    else finalizePreamble();
    return articles;
}

// 从 chunkLegal 的分片（含 headingPath）映射为法规条文结构。
// headingPath 形如「《公司法》>第三章>第十条」，取末段判断是否为「第X条」。
function articlesFromLegalChunks(chunks) {
    const articles = [];
    chunks.forEach(chunk => {
        const content = normalizeRegulationText(chunk.content);
        if (!content) return;
        const headingPath = String(chunk.headingPath || '').trim();
        const lastSeg = headingPath.split('›').map(s => s.trim()).filter(Boolean).pop() || '';
        // 优先用 heading 末段里的「第X条」，否则从正文首行识别
        const firstLine = content.split('\n').find(Boolean) || '';
        const labelMatch = lastSeg.match(REGULATION_ARTICLE_LABEL_RE) || firstLine.match(REGULATION_ARTICLE_LABEL_RE);
        const order = articles.length + 1;
        let articleLabel;
        let titleTail = '';
        if (labelMatch) {
            articleLabel = `第${labelMatch[1]}条${labelMatch[2] ? `之${labelMatch[2]}` : ''}`;
            titleTail = normalizeRegulationField(labelMatch[3], 80);
        } else {
            articleLabel = normalizeRegulationField(lastSeg || `第${order}节`, 40) || `第${order}节`;
        }
        articles.push({
            sortOrder: order,
            articleLabel,
            articleTitle: deriveArticleTitle(articleLabel, content, titleTail),
            content,
            headingPath,
            searchContent: buildRagSearchContent([headingPath, content].filter(Boolean).join(' '))
        });
    });
    return articles;
}

function countActualRegulationArticles(articles = []) {
    const legalKeys = new Set();
    const fallbackKeys = new Set();
    (Array.isArray(articles) ? articles : []).forEach((article, index) => {
        const label = normalizeRegulationField(article?.articleLabel ?? article?.article_label, 80);
        const headingPath = normalizeRegulationField(article?.headingPath ?? article?.heading_path, 255);
        if (!label) return;
        const key = (headingPath || '') + '\u001f' + label;
        if (REGULATION_ARTICLE_LABEL_RE.test(label)) {
            legalKeys.add(key);
        } else {
            fallbackKeys.add(key || 'row:' + index);
        }
    });
    return legalKeys.size || fallbackKeys.size || 0;
}

function parseRegulationArticles(extractedText, { docTitle = '' } = {}) {
    const text = normalizeRegulationText(extractedText);
    if (!text) return [];

    const lines = text.split('\n');
    const strategy = detectRegulationStructure(lines);

    if (strategy) {
        const articles = splitRegulationArticlesByStrategy(lines, strategy);
        if (articles.length) return articles;
    }

    // Fallback to the RAG legal chunker only when local structure parsing fails.
    if (strategy === 'article') {
        try {
            const chunkSize = getChunkSizeForDocType('legal', 600);
            const chunks = chunkDocument(text, {
                docName: docTitle || '\u6cd5\u89c4\u6587\u6863',
                docType: 'legal',
                chunkSize,
                overlap: 0
            });
            const articles = articlesFromLegalChunks(Array.isArray(chunks) ? chunks : []);
            if (articles.length) return articles;
        } catch (_err) {
            // Fall through to whole-document fallback.
        }
    }

    const fallbackContent = normalizeRegulationText(text);
    if (!fallbackContent) return [];
    return [{
        sortOrder: 1,
        articleLabel: '全文',
        articleTitle: deriveArticleTitle('全文', fallbackContent, ''),
        content: fallbackContent,
        headingPath: '',
        searchContent: buildRagSearchContent(fallbackContent)
    }];
}

// 条文引用解析：匹配「第X条」「第X条之X」「《书名号》(第X条)」及引用动词

module.exports = {
    countActualRegulationArticles,
    deriveArticleTitle,
    deriveRegulationSummary,
    deriveRegulationTitleFromText,
    detectRegulationHeadingLine,
    detectRegulationStructure,
    parseRegulationArticles,
    splitRegulationArticlesByStrategy
};
