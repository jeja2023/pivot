const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { db } = require('../db');
const { extractDocumentText, truncateExtractedText } = require('../document-text');
const { getKnowledgeLimits } = require('./resource-limits');
const { getBeijingTimestamp } = require('../time');
const { normalizeUploadedOriginalName } = require('../upload');
const { buildRagSearchContent, buildRagSearchTerms, normalizeSearchText } = require('./rag-tokenizer');
const { chunkDocument } = require('./rag-chunker');
const { getChunkSizeForDocType } = require('./rag-config');
const { generateEmbeddings, cosineSimilarity } = require('./rag-index/embedding-client');
const { toProjectRelativePath } = require('../security');
const { clearDirSizeCache } = require('./dir-size-cache');

const projectRoot = path.resolve(__dirname, '../..');
const uploadRoot = process.env.PIVOT_UPLOAD_DIR || process.env.UPLOAD_DIR
    ? path.resolve(process.env.PIVOT_UPLOAD_DIR || process.env.UPLOAD_DIR)
    : path.join(projectRoot, 'uploads');
const regulationsSourceRoot = path.join(uploadRoot, 'regulations');
const allowedExtensions = new Set([
    '.txt', '.md', '.pdf',
    '.doc', '.docx',
    '.xls', '.xlsx',
    '.csv', '.json',
    '.html', '.htm'
]);

const REGULATION_ARTICLE_LABEL_RE = /^第([〇零一二三四五六七八九十百千万\d]+)条(?:之([〇零一二三四五六七八九十百千万\d]+))?\s*(.*)$/;
const PUNCTUATION_SPLIT_RE = /[。；;：:，,、\n]/;
// 非「第X条」结构的切分识别：Markdown 标题、中文/数字小节（一、（一）、第X章节、1.）
const REGULATION_MD_HEADING_RE = /^#{1,6}\s+(.+)$/;
const REGULATION_CN_SECTION_RE = /^((?:第[〇零一二三四五六七八九十百千万\d]+[章节篇编])|(?:[〇零一二三四五六七八九十]+[、．.])|(?:（[〇零一二三四五六七八九十]+）)|(?:\([〇零一二三四五六七八九十]+\))|(?:\d{1,3}[、．.]))\s*/;

function normalizeRegulationId(value) {
    const id = Number.parseInt(value, 10);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function normalizeRegulationText(value, fallback = '') {
    return String(value || fallback || '')
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .replace(/\u0000/g, '')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function normalizeRegulationField(value, maxLength = 255) {
    return String(value || '').trim().replace(/\s+/g, ' ').slice(0, maxLength);
}

function normalizeRegulationSummary(value) {
    return String(value || '').trim().replace(/\s+/g, ' ').slice(0, 2000);
}

function normalizeRegulationStatus(value) {
    const status = String(value || '').trim().toLowerCase();
    return status === 'archived' ? 'archived' : 'active';
}

function normalizeRegulationEffectiveDate(value) {
    return String(value || '').trim().slice(0, 40);
}

// 把多种日期写法（ISO、YYYY年M月D日、YYYYMMDD）规范成 YYYY-MM-DD，无法识别返回空串
const REGULATION_DATE_ISO_RE = /((?:19|20)\d{2})-(\d{1,2})-(\d{1,2})/;
const REGULATION_DATE_CN_RE = /((?:19|20)\d{2})[年/.\-](0?[1-9]|1[0-2])[月/.\-](0?[1-9]|[12]\d|3[01])日?/;
const REGULATION_DATE_COMPACT_RE = /((?:19|20)\d{2})(0[1-9]|1[0-2])([0-3]\d)/;

function buildIsoDate(year, month, day) {
    const y = Number.parseInt(year, 10);
    const m = Number.parseInt(month, 10);
    const d = Number.parseInt(day, 10);
    if (!Number.isInteger(y) || y < 1900 || y > 2100) return '';
    if (!Number.isInteger(m) || m < 1 || m > 12) return '';
    if (!Number.isInteger(d) || d < 1 || d > 31) return '';
    const date = new Date(Date.UTC(y, m - 1, d));
    if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return '';
    return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function normalizeRegulationDateValue(value) {
    const text = String(value || '').trim();
    if (!text) return '';
    let m = text.match(REGULATION_DATE_ISO_RE);
    if (m) return buildIsoDate(m[1], m[2], m[3]);
    m = text.match(REGULATION_DATE_CN_RE);
    if (m) return buildIsoDate(m[1], m[2], m[3]);
    m = text.match(REGULATION_DATE_COMPACT_RE);
    if (m) return buildIsoDate(m[1], m[2], m[3]);
    return '';
}

// 依据失效日期推导现行状态：已过失效日 → expired，否则 active
function computeRegulationEffectStatus(doc) {
    const expire = normalizeRegulationDateValue(doc?.expire_date);
    if (!expire) return 'active';
    const today = getBeijingTimestamp().slice(0, 10);
    return expire < today ? 'expired' : 'active';
}

// 法律法规版本通常以施行/修订日期区分，把 ISO 日期转为「YYYY年MM月DD日」版本标签
function buildVersionLabelFromDate(value) {
    const iso = normalizeRegulationDateValue(value);
    if (!iso) return '';
    const [year, month, day] = iso.split('-');
    return `${year}年${month}月${day}日`;
}

// 归一化法律名称用于别名匹配：去书名号、空白、全角符号
function normalizeRegulationAlias(value) {
    return String(value || '')
        .replace(/[《》【】\[\]()（）\s]/g, '')
        .trim()
        .toLowerCase();
}

// 从法规标题派生常见简称：去「中华人民共和国」前缀、取《X》内容等
function deriveRegulationAliases(title) {
    const raw = String(title || '').trim();
    if (!raw) return [];
    const aliases = new Set();
    // 去书名号后的主体
    const core = raw.replace(/^《/, '').replace(/》$/, '').trim();
    if (core) aliases.add(core);
    // 去「中华人民共和国」前缀
    const noPrefix = core.replace(/^中华人民共和国/, '').trim();
    if (noPrefix && noPrefix !== core) aliases.add(noPrefix);
    return [...aliases].filter(a => a.length >= 2 && a.length <= 80);
}

// 落库一部文档的别名（含主名 + 派生简称），覆盖式写入
function saveRegulationAliases(documentId, title) {
    const docId = normalizeRegulationId(documentId);
    if (!docId) return;
    const aliases = deriveRegulationAliases(title);
    db.prepare('DELETE FROM regulation_aliases WHERE document_id = ? AND is_primary = 0').run(docId);
    // 主名（完整标题去书名号）置 is_primary=1，其余为派生
    const primary = aliases[0] || '';
    const now = getBeijingTimestamp();
    const insert = db.prepare(`
        INSERT INTO regulation_aliases (document_id, alias, normalized_alias, is_primary, created_at)
        VALUES (?, ?, ?, ?, ?)
    `);
    const seen = new Set();
    aliases.forEach(alias => {
        const norm = normalizeRegulationAlias(alias);
        if (!norm || seen.has(norm)) return;
        seen.add(norm);
        insert.run(docId, alias, norm, alias === primary ? 1 : 0, now);
    });
}

function ensureRegulationsSourceRoot() {
    fs.mkdirSync(regulationsSourceRoot, { recursive: true });
}

function getSafeRegulationExtension(filename) {
    const ext = path.extname(String(filename || '')).toLowerCase();
    return allowedExtensions.has(ext) ? ext : '.txt';
}

function resolveRegulationStoredPath(relativePath) {
    if (!relativePath) return null;
    const normalized = String(relativePath).replace(/\\/g, '/');
    if (!normalized.startsWith('uploads/regulations/') || normalized.includes('\0')) return null;
    const target = path.resolve(uploadRoot, normalized.slice('uploads/'.length));
    if (target !== regulationsSourceRoot && !target.startsWith(regulationsSourceRoot + path.sep)) return null;
    return target;
}

function buildRegulationSourcePath(documentId, originalName) {
    ensureRegulationsSourceRoot();
    const ext = getSafeRegulationExtension(originalName);
    const targetDir = path.join(regulationsSourceRoot, String(documentId));
    const token = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    return {
        targetDir,
        targetPath: path.join(targetDir, `${token}${ext}`)
    };
}

function saveRegulationUploadedFile(file, documentId) {
    const { targetDir, targetPath } = buildRegulationSourcePath(documentId, file.originalname);
    fs.mkdirSync(targetDir, { recursive: true });
    fs.renameSync(file.path, targetPath);
    clearDirSizeCache();
    return {
        sourcePath: toProjectRelativePath(targetPath),
        sourceSize: fs.statSync(targetPath).size,
        sourceHash: crypto.createHash('sha256').update(fs.readFileSync(targetPath)).digest('hex'),
        absolutePath: targetPath
    };
}

async function readRegulationTextFromPath(filePath, originalName = '') {
    const text = await extractDocumentText(filePath, '', originalName || filePath);
    return truncateExtractedText(text, getKnowledgeLimits().extractMaxChars);
}

function deriveRegulationTitleFromText(extractedText, fallbackName = '') {
    const text = normalizeRegulationText(extractedText);
    const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
    for (const line of lines.slice(0, 24)) {
        if (!REGULATION_ARTICLE_LABEL_RE.test(line) && line.length >= 4 && line.length <= 120) {
            return normalizeRegulationField(line, 120);
        }
    }
    const base = path.basename(String(fallbackName || ''), path.extname(String(fallbackName || '')));
    return normalizeRegulationField(base || '法规文档', 120);
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
            derive: true
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
    for (const rawLine of lines) {
        const line = String(rawLine || '').trim();
        if (!line) {
            if (current) current.lines.push('');
            continue;
        }
        const head = detectRegulationHeadingLine(line, strategy);
        if (head) {
            finalize();
            current = { ...head, lines: [] };
            continue;
        }
        if (current) current.lines.push(line);
    }
    finalize();
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

function parseRegulationArticles(extractedText, { docTitle = '' } = {}) {
    const text = normalizeRegulationText(extractedText);
    if (!text) return [];

    const lines = text.split('\n');
    const strategy = detectRegulationStructure(lines);

    // 「第X条」结构优先复用 RAG 法律切片：按章/节/条切分并带 headingPath，定位更精准
    if (strategy === 'article') {
        try {
            const chunkSize = getChunkSizeForDocType('legal', 600);
            const chunks = chunkDocument(text, {
                docName: docTitle || '法规文档',
                docType: 'legal',
                chunkSize,
                overlap: 0
            });
            const articles = articlesFromLegalChunks(Array.isArray(chunks) ? chunks : []);
            if (articles.length) return articles;
        } catch (_err) {
            // 切片异常时回退到本地多策略切分
        }
    }

    if (strategy) {
        const articles = splitRegulationArticlesByStrategy(lines, strategy);
        if (articles.length) return articles;
    }

    // 无可识别结构时回退：整篇作为单条「全文」
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
const REGULATION_CITE_ARTICLE_RE = /第([〇零一二三四五六七八九十百千万\d]+)条(?:之([〇零一二三四五六七八九十百千万\d]+))?/g;
const REGULATION_CITE_BOOK_RE = /《([^》]{2,80})》(?:第([〇零一二三四五六七八九十百千万\d]+)条(?:之([〇零一二三四五六七八九十百千万\d]+))?)?/g;
// 引用动词 → 关系类型，用于在引用附近判断关系性质
const REGULATION_RELATION_HINTS = [
    { type: 'supersede', re: /(?:废止|替代|取代|修订)/ },
    { type: 'apply', re: /(?:适用于|适用|参照适用)/ },
    { type: 'depend', re: /(?:依据|根据|依照|按照|参照)/ }
];

function classifyCiteRelation(context) {
    for (const hint of REGULATION_RELATION_HINTS) {
        if (hint.re.test(context)) return hint.type;
    }
    return 'cite';
}

// 从已解析的条文中抽取条文间引用关系（条号引用对齐本库条文，书名号跨法引用仅存文本）
function extractRegulationLinks(articles, { documentId, versionId }) {
    const links = [];
    // 自身条号 → 临时序号映射（落库前 article 还没有真实 id，先记 sortOrder，落库时再换 id）
    const labelToOrder = new Map();
    articles.forEach(article => {
        const m = String(article.articleLabel || '').match(/^第([〇零一二三四五六七八九十百千万\d]+)条(?:之([〇零一二三四五六七八九十百千万\d]+))?/);
        if (m) {
            const key = `第${m[1]}条${m[2] ? `之${m[2]}` : ''}`;
            labelToOrder.set(key, article.sortOrder);
        }
    });

    articles.forEach(article => {
        const content = String(article.content || '');
        if (!content) return;
        const selfLabel = String(article.articleLabel || '');
        const seen = new Set();

        // 跨法引用（带书名号）
        REGULATION_CITE_BOOK_RE.lastIndex = 0;
        let bm;
        while ((bm = REGULATION_CITE_BOOK_RE.exec(content))) {
            const book = bm[1].trim();
            const artPart = bm[2] ? `第${bm[2]}条${bm[3] ? `之${bm[3]}` : ''}` : '';
            const targetLabel = artPart ? `《${book}》${artPart}` : `《${book}》`;
            const dedupeKey = `book:${targetLabel}`;
            if (seen.has(dedupeKey)) continue;
            seen.add(dedupeKey);
            const ctx = content.slice(Math.max(0, bm.index - 12), bm.index + 12);
            links.push({
                sourceOrder: article.sortOrder,
                targetLabel,
                targetOrder: null,
                relationType: classifyCiteRelation(ctx),
                confidence: 0.6
            });
        }

        // 同文档内条号引用
        REGULATION_CITE_ARTICLE_RE.lastIndex = 0;
        let am;
        while ((am = REGULATION_CITE_ARTICLE_RE.exec(content))) {
            const label = `第${am[1]}条${am[2] ? `之${am[2]}` : ''}`;
            // 跳过引用自身、跳过紧跟在书名号后已计入的跨法引用
            if (label === selfLabel) continue;
            const before = content.slice(Math.max(0, am.index - 1), am.index);
            if (before === '》') continue; // 已由书名号分支处理
            const targetOrder = labelToOrder.get(label);
            if (!targetOrder) continue; // 引用了本库不存在的条号则忽略（避免噪声）
            const dedupeKey = `art:${label}`;
            if (seen.has(dedupeKey)) continue;
            seen.add(dedupeKey);
            const ctx = content.slice(Math.max(0, am.index - 12), am.index + 12);
            links.push({
                sourceOrder: article.sortOrder,
                targetLabel: label,
                targetOrder,
                relationType: classifyCiteRelation(ctx),
                confidence: 0.75
            });
        }
    });

    return links.map(link => ({ ...link, documentId, versionId }));
}

// 解析「《XX法》第N条」中文条号为标准 article_label
function parseCrossLinkLabel(targetLabel) {
    const m = String(targetLabel || '').match(/^《([^》]{2,80})》(?:第([〇零一二三四五六七八九十百千万\d]+)条(?:之([〇零一二三四五六七八九十百千万\d]+))?)?/);
    if (!m) return null;
    return {
        bookName: m[1].trim(),
        articleLabel: m[2] ? `第${m[2]}条${m[3] ? `之${m[3]}` : ''}` : ''
    };
}

// 跨法引用回连：把指定版本中悬空的「《XX法》第N条」外链，匹配库内文档并对齐到目标条文 id
function resolveRegulationCrossLinks(versionId) {
    const vId = normalizeRegulationId(versionId);
    if (!vId) return { resolved: 0 };
    // 取该版本下尚未连上、且 target_label 带书名号的外链
    const pending = db.prepare(`
        SELECT id, target_label
        FROM regulation_article_links
        WHERE version_id = ? AND target_article_id IS NULL AND target_label LIKE '《%'
    `).all(vId);
    if (!pending.length) return { resolved: 0 };

    const updateLink = db.prepare(`
        UPDATE regulation_article_links
        SET target_document_id = ?, target_article_id = ?, confidence = ?
        WHERE id = ?
    `);
    let resolved = 0;
    pending.forEach(row => {
        const parsed = parseCrossLinkLabel(row.target_label);
        if (!parsed?.bookName) return;
        const norm = normalizeRegulationAlias(parsed.bookName);
        // 通过别名表匹配目标文档（在用、未归档）
        const aliasRow = db.prepare(`
            SELECT a.document_id
            FROM regulation_aliases a
            JOIN regulation_documents d ON d.id = a.document_id
            WHERE a.normalized_alias = ? AND d.deleted_at IS NULL
            ORDER BY a.is_primary DESC
            LIMIT 1
        `).get(norm);
        if (!aliasRow) return;
        const targetDocId = aliasRow.document_id;
        let targetArticleId = null;
        if (parsed.articleLabel) {
            // 在目标文档当前版本里按条号对齐
            const art = db.prepare(`
                SELECT a.id
                FROM regulation_articles a
                JOIN regulation_documents d ON d.id = a.document_id
                WHERE a.document_id = ? AND a.version_id = d.current_version_id AND a.article_label = ?
                LIMIT 1
            `).get(targetDocId, parsed.articleLabel);
            targetArticleId = art?.id || null;
        }
        updateLink.run(targetDocId, targetArticleId, targetArticleId ? 0.8 : 0.65, row.id);
        resolved += 1;
    });
    return { resolved };
}

// 重建：对全库（或指定文档）当前版本重新解析跨法引用回连
function rebuildRegulationCrossLinks(documentId = null) {
    const docId = normalizeRegulationId(documentId);
    const versions = docId
        ? db.prepare('SELECT current_version_id AS id FROM regulation_documents WHERE id = ? AND deleted_at IS NULL').all(docId)
        : db.prepare('SELECT current_version_id AS id FROM regulation_documents WHERE deleted_at IS NULL AND current_version_id IS NOT NULL').all();
    let total = 0;
    versions.forEach(v => {
        if (v.id) total += resolveRegulationCrossLinks(v.id).resolved;
    });
    return { resolved: total, versions: versions.length };
}

function getRegulationDocumentById(docId, { includeArchived = false } = {}) {
    const normalizedId = normalizeRegulationId(docId);
    if (!normalizedId) return null;
    const archivedFilter = includeArchived ? '' : ' AND deleted_at IS NULL';
    return db.prepare(`
        SELECT *
        FROM regulation_documents
        WHERE id = ?${archivedFilter}
    `).get(normalizedId) || null;
}

function getRegulationVersionById(versionId) {
    const normalizedId = normalizeRegulationId(versionId);
    if (!normalizedId) return null;
    return db.prepare('SELECT * FROM regulation_versions WHERE id = ?').get(normalizedId) || null;
}

function listRegulationVersions(docId) {
    const normalizedId = normalizeRegulationId(docId);
    if (!normalizedId) return [];
    return db.prepare(`
        SELECT *
        FROM regulation_versions
        WHERE document_id = ?
        ORDER BY id DESC
    `).all(normalizedId).map(row => ({
        ...row,
        article_count: Number(row.article_count || 0),
        source_size: Number(row.source_size || 0)
    }));
}

function listRegulationDocuments({
    query = '',
    category = '',
    jurisdiction = '',
    status = '',
    includeArchived = false,
    sort = '',
    limit = 50,
    offset = 0
} = {}) {
    const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
    const safeOffset = Math.max(Number.parseInt(offset, 10) || 0, 0);
    const clauses = [];
    const params = [];

    if (!includeArchived) {
        clauses.push('d.deleted_at IS NULL');
    }
    if (status) {
        clauses.push('d.status = ?');
        params.push(normalizeRegulationStatus(status));
    }
    if (category) {
        clauses.push('LOWER(d.category) LIKE LOWER(?)');
        params.push(`%${normalizeRegulationField(category, 255)}%`);
    }
    if (jurisdiction) {
        clauses.push('LOWER(d.jurisdiction) LIKE LOWER(?)');
        params.push(`%${normalizeRegulationField(jurisdiction, 255)}%`);
    }

    const normalizedQuery = normalizeSearchText(query);
    if (normalizedQuery) {
        const like = `%${normalizedQuery}%`;
        clauses.push(`(
            LOWER(d.title) LIKE LOWER(?)
            OR LOWER(d.category) LIKE LOWER(?)
            OR LOWER(d.issuing_body) LIKE LOWER(?)
            OR LOWER(d.jurisdiction) LIKE LOWER(?)
            OR LOWER(d.summary) LIKE LOWER(?)
        )`);
        params.push(like, like, like, like, like);
    }

    const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    let orderSql = 'ORDER BY COALESCE(d.updated_at, d.created_at) DESC, d.id DESC';
    if (sort === 'date') orderSql = 'ORDER BY d.effective_date_normalized DESC, d.id DESC';
    const rows = db.prepare(`
        SELECT
            d.*,
            v.version_label AS current_version_label,
            v.source_name AS current_source_name,
            v.source_size AS current_source_size,
            v.created_at AS current_version_created_at,
            v.updated_at AS current_version_updated_at,
            (
                SELECT a.article_label
                FROM regulation_articles a
                WHERE a.document_id = d.id AND a.version_id = d.current_version_id
                ORDER BY a.sort_order ASC, a.id ASC
                LIMIT 1
            ) AS first_article_label,
            (
                SELECT a.article_title
                FROM regulation_articles a
                WHERE a.document_id = d.id AND a.version_id = d.current_version_id
                ORDER BY a.sort_order ASC, a.id ASC
                LIMIT 1
            ) AS first_article_title,
            (
                SELECT substr(replace(a.content, char(10), ' '), 1, 180)
                FROM regulation_articles a
                WHERE a.document_id = d.id AND a.version_id = d.current_version_id
                ORDER BY a.sort_order ASC, a.id ASC
                LIMIT 1
            ) AS first_article_excerpt
        FROM regulation_documents d
        LEFT JOIN regulation_versions v ON v.id = d.current_version_id
        ${whereSql}
        ${orderSql}
        LIMIT ? OFFSET ?
    `).all(...params, safeLimit, safeOffset);

    const total = db.prepare(`
        SELECT COUNT(*) AS count
        FROM regulation_documents d
        ${whereSql}
    `).get(...params).count;

    return {
        data: rows.map(row => ({
            ...row,
            version_count: Number(row.version_count || 0),
            article_count: Number(row.article_count || 0),
            source_size: Number(row.current_source_size || 0),
            effect_status: computeRegulationEffectStatus(row)
        })),
        total,
        limit: safeLimit,
        offset: safeOffset
    };
}

// 返回库中已有的分类、适用范围去重候选，供前端下拉联想
function listRegulationFacets({ includeArchived = false } = {}) {
    const archivedFilter = includeArchived ? '' : ' AND deleted_at IS NULL';
    const pick = column => db.prepare(`
        SELECT DISTINCT ${column} AS value
        FROM regulation_documents
        WHERE ${column} IS NOT NULL AND TRIM(${column}) <> ''${archivedFilter}
        ORDER BY ${column} COLLATE NOCASE ASC
        LIMIT 200
    `).all().map(row => row.value).filter(Boolean);
    return {
        categories: pick('category'),
        jurisdictions: pick('jurisdiction')
    };
}

function getRegulationDocumentDetail(docId, { versionId = null, includeArchived = false } = {}) {
    const normalizedDocId = normalizeRegulationId(docId);
    if (!normalizedDocId) return null;
    const doc = getRegulationDocumentById(normalizedDocId, { includeArchived });
    if (!doc) return null;

    const versions = listRegulationVersions(normalizedDocId);
    if (versions.length === 0) {
        return {
            document: doc,
            versions: [],
            currentVersion: null,
            articles: [],
            download: null
        };
    }

    const selectedVersionId = normalizeRegulationId(versionId) || doc.current_version_id || versions[0].id;
    const selectedVersion = versions.find(row => Number(row.id) === Number(selectedVersionId)) || versions[0];
    const articles = db.prepare(`
        SELECT *
        FROM regulation_articles
        WHERE document_id = ? AND version_id = ?
        ORDER BY sort_order ASC, id ASC
    `).all(normalizedDocId, selectedVersion.id).map(row => ({
        ...row,
        sort_order: Number(row.sort_order || 0)
    }));

    // #5 附加废止/修订提醒：标记被其它法律 supersede 的条文
    const supersedeNotices = getRegulationSupersedeNotices(normalizedDocId, { versionId: selectedVersion.id });
    const supersedeByArticle = new Map();
    supersedeNotices.forEach(n => {
        if (!supersedeByArticle.has(n.article_id)) supersedeByArticle.set(n.article_id, []);
        supersedeByArticle.get(n.article_id).push({
            sourceDocumentId: n.source_document_id,
            sourceDocumentTitle: n.source_document_title,
            sourceArticleLabel: n.source_article_label
        });
    });
    // #10 附加批注数量
    const annotationCounts = new Map();
    if (articles.length) {
        const ids = articles.map(a => a.id);
        const placeholders = ids.map(() => '?').join(',');
        const rows = db.prepare(`
            SELECT article_id, COUNT(*) as count
            FROM regulation_article_annotations
            WHERE article_id IN (${placeholders})
            GROUP BY article_id
        `).all(...ids);
        rows.forEach(r => annotationCounts.set(r.article_id, r.count));
    }
    const articlesWithNotice = articles.map(a => ({
        ...a,
        supersededBy: supersedeByArticle.get(a.id) || [],
        annotationCount: annotationCounts.get(a.id) || 0
    }));

    return {
        document: { ...doc, effect_status: computeRegulationEffectStatus(doc) },
        versions: versions.map(version => ({
            ...version,
            is_current: Number(version.id) === Number(doc.current_version_id)
        })),
        currentVersion: selectedVersion,
        articles: articlesWithNotice,
        download: selectedVersion.source_path ? {
            fileName: selectedVersion.source_name,
            sourcePath: selectedVersion.source_path
        } : null
    };
}

function searchRegulationArticles({ query, documentId = null, limit = 8, includeArchived = false } = {}) {
    const normalizedQuery = normalizeSearchText(query);
    const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 8, 1), 50);
    const terms = buildRagSearchTerms(normalizedQuery, 12);
    const normalizedDocId = normalizeRegulationId(documentId);
    const filters = ['a.version_id = d.current_version_id'];
    const params = [];
    if (!includeArchived) filters.push('d.deleted_at IS NULL');
    if (normalizedDocId) {
        filters.push('d.id = ?');
        params.push(normalizedDocId);
    }

    const whereBase = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    if (!normalizedQuery) {
        return db.prepare(`
            SELECT
                d.id AS document_id,
                d.title AS document_title,
                d.category,
                d.issuing_body,
                d.jurisdiction,
                d.effective_date,
                d.summary AS document_summary,
                v.id AS version_id,
                v.version_label,
                a.id AS article_id,
                a.sort_order,
                a.article_label,
                a.article_title,
                a.content,
                a.embedding,
                substr(replace(a.content, char(10), ' '), 1, 240) AS excerpt,
                0 AS score
            FROM regulation_documents d
            JOIN regulation_versions v ON v.id = d.current_version_id
            JOIN regulation_articles a ON a.document_id = d.id AND a.version_id = d.current_version_id
            ${whereBase}
            ORDER BY d.updated_at DESC, a.sort_order ASC
            LIMIT ?
        `).all(...params, safeLimit);
    }

    const ftsQuery = terms.map(term => `"${String(term).replace(/"/g, '""')}"`).join(' OR ');
    try {
        return db.prepare(`
            SELECT
                d.id AS document_id,
                d.title AS document_title,
                d.category,
                d.issuing_body,
                d.jurisdiction,
                d.effective_date,
                d.summary AS document_summary,
                v.id AS version_id,
                v.version_label,
                a.id AS article_id,
                a.sort_order,
                a.article_label,
                a.article_title,
                a.content,
                a.embedding,
                substr(replace(a.content, char(10), ' '), 1, 240) AS excerpt,
                bm25(regulation_articles_fts) AS score
            FROM regulation_articles_fts
            JOIN regulation_articles a ON a.id = regulation_articles_fts.rowid
            JOIN regulation_versions v ON v.id = a.version_id
            JOIN regulation_documents d ON d.id = a.document_id
            ${whereBase}
              AND regulation_articles_fts MATCH ?
            ORDER BY score ASC, d.updated_at DESC, a.sort_order ASC
            LIMIT ?
        `).all(...params, ftsQuery, safeLimit);
    } catch (_err) {
        const like = `%${normalizedQuery}%`;
        return db.prepare(`
            SELECT
                d.id AS document_id,
                d.title AS document_title,
                d.category,
                d.issuing_body,
                d.jurisdiction,
                d.effective_date,
                d.summary AS document_summary,
                v.id AS version_id,
                v.version_label,
                a.id AS article_id,
                a.sort_order,
                a.article_label,
                a.article_title,
                a.content,
                a.embedding,
                substr(replace(a.content, char(10), ' '), 1, 240) AS excerpt,
                999 AS score
            FROM regulation_documents d
            JOIN regulation_versions v ON v.id = d.current_version_id
            JOIN regulation_articles a ON a.document_id = d.id AND a.version_id = d.current_version_id
            ${whereBase}
              AND (
                LOWER(d.title) LIKE LOWER(?)
                OR LOWER(d.summary) LIKE LOWER(?)
                OR LOWER(a.article_label) LIKE LOWER(?)
                OR LOWER(a.article_title) LIKE LOWER(?)
                OR LOWER(a.content) LIKE LOWER(?)
              )
            ORDER BY d.updated_at DESC, a.sort_order ASC
            LIMIT ?
        `).all(...params, like, like, like, like, like, safeLimit);
    }
}

// #2 混合检索（BM25 + 向量重排）：先用 BM25 召回候选，再用向量相似度重排
async function searchRegulationArticlesHybrid({ query, documentId = null, limit = 8, includeArchived = false, userId = 0 } = {}) {
    const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 8, 1), 50);
    let queryVector;
    try {
        // 尝试生成查询向量
        const vectors = await generateEmbeddings([String(query || '').trim()], null, null, userId, { source: 'regulations_search', timeoutMs: 10000 });
        queryVector = vectors[0];
    } catch (err) {
        // 向量生成失败，降级为纯 BM25
        console.warn('[regulations] 混合检索降级为 BM25:', err.message);
        return searchRegulationArticles({ query, documentId, limit, includeArchived });
    }
    if (!queryVector || !Array.isArray(queryVector)) {
        return searchRegulationArticles({ query, documentId, limit, includeArchived });
    }
    // BM25 召回候选（数量为 limit*6，保证重排后有足够结果）
    const candidateLimit = Math.min(safeLimit * 6, 300);
    const candidates = searchRegulationArticles({ query, documentId, limit: candidateLimit, includeArchived });
    if (!candidates.length) return [];
    // 筛选有向量的候选，计算相似度并重排
    const withVector = candidates.filter(c => c.embedding && String(c.embedding).trim()).map(c => {
        try {
            const articleVector = JSON.parse(c.embedding);
            const similarity = cosineSimilarity(queryVector, articleVector);
            return { ...c, vectorScore: similarity };
        } catch (_err) {
            return null;
        }
    }).filter(Boolean);
    if (!withVector.length) {
        return candidates.slice(0, safeLimit);
    }
    // 混合打分：向量相似度占 70%，BM25 逆序分占 30%（score 越小 BM25 越好，归一化后取反）
    const maxBM25 = Math.max(...withVector.map(c => c.score || 999), 1);
    withVector.forEach(c => {
        const bm25Normalized = 1 - (c.score || 999) / maxBM25;
        c.hybridScore = (c.vectorScore || 0) * 0.7 + bm25Normalized * 0.3;
    });
    withVector.sort((a, b) => (b.hybridScore || 0) - (a.hybridScore || 0));
    return withVector.slice(0, safeLimit);
}

// #14 相似条文推荐（基于向量近邻，降级为同分类/同颁布机构）
async function findSimilarRegulationArticles({ articleId, limit = 5 } = {}) {
    const aid = normalizeRegulationId(articleId);
    if (!aid) return [];
    const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 5, 1), 20);
    const source = db.prepare('SELECT embedding, document_id, content FROM regulation_articles WHERE id = ?').get(aid);
    if (!source) return [];
    let sourceVector;
    try {
        if (source.embedding && String(source.embedding).trim()) {
            sourceVector = JSON.parse(source.embedding);
        }
    } catch (_err) {
        // 源条文无向量或解析失败，降级为分类推荐
    }
    if (!sourceVector || !Array.isArray(sourceVector)) {
        // 降级：推荐同一文档的其它条文，或同分类/颁布机构的条文
        const doc = db.prepare('SELECT category, issuing_body FROM regulation_documents WHERE id = ?').get(source.document_id);
        const where = doc?.category ? 'AND d.category = ?' : (doc?.issuing_body ? 'AND d.issuing_body = ?' : '');
        const param = doc?.category || doc?.issuing_body || '';
        return db.prepare(`
            SELECT d.id AS document_id, d.title AS document_title, d.category, d.issuing_body,
                   a.id AS article_id, a.article_label, a.article_title,
                   substr(replace(a.content, char(10), ' '), 1, 200) AS excerpt
            FROM regulation_articles a
            JOIN regulation_documents d ON d.id = a.document_id AND a.version_id = d.current_version_id
            WHERE a.id != ? ${where} AND d.deleted_at IS NULL
            ORDER BY d.updated_at DESC
            LIMIT ?
        `).all(aid, ...(param ? [param] : []), safeLimit);
    }
    // 向量近邻：遍历所有有向量的条文，计算相似度，返回 top-k
    const candidates = db.prepare(`
        SELECT a.id, a.document_id, a.article_label, a.article_title, a.embedding,
               substr(replace(a.content, char(10), ' '), 1, 200) AS excerpt,
               d.title AS document_title, d.category, d.issuing_body
        FROM regulation_articles a
        JOIN regulation_documents d ON d.id = a.document_id AND a.version_id = d.current_version_id
        WHERE a.id != ? AND a.embedding != '' AND d.deleted_at IS NULL
        LIMIT 1000
    `).all(aid);
    const withScore = candidates.map(c => {
        try {
            const vec = JSON.parse(c.embedding);
            const sim = cosineSimilarity(sourceVector, vec);
            return { ...c, similarity: sim, article_id: c.id };
        } catch (_err) {
            return null;
        }
    }).filter(Boolean);
    withScore.sort((a, b) => (b.similarity || 0) - (a.similarity || 0));
    return withScore.slice(0, safeLimit);
}

// #14 保存检索 CRUD
function createSavedSearch({ userId, name, query = '', category = '', jurisdiction = '' }) {
    const uid = normalizeRegulationId(userId);
    if (!uid || !String(name || '').trim()) return null;
    const result = db.prepare('INSERT INTO regulation_saved_searches (user_id, name, query, category, jurisdiction) VALUES (?, ?, ?, ?, ?)')
        .run(uid, normalizeRegulationField(name, 100), normalizeRegulationField(query, 500), normalizeRegulationField(category, 50), normalizeRegulationField(jurisdiction, 50));
    return db.prepare('SELECT * FROM regulation_saved_searches WHERE id = ?').get(result.lastInsertRowid);
}

function listSavedSearches({ userId }) {
    const uid = normalizeRegulationId(userId);
    if (!uid) return [];
    return db.prepare('SELECT * FROM regulation_saved_searches WHERE user_id = ? ORDER BY created_at DESC').all(uid);
}

function deleteSavedSearch({ searchId, userId }) {
    const id = normalizeRegulationId(searchId);
    const uid = normalizeRegulationId(userId);
    if (!id || !uid) return false;
    const existing = db.prepare('SELECT user_id FROM regulation_saved_searches WHERE id = ?').get(id);
    if (!existing || Number(existing.user_id) !== Number(uid)) return false;
    db.prepare('DELETE FROM regulation_saved_searches WHERE id = ?').run(id);
    return true;
}

// 行级 LCS diff：返回两文本的行级差异片段 [{type:'eq'|'add'|'del', text}]
function computeLineDiff(textA, textB) {
    const linesA = String(textA || '').split('\n');
    const linesB = String(textB || '').split('\n');
    const m = linesA.length;
    const n = linesB.length;
    const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
    for (let i = 1; i <= m; i += 1) {
        for (let j = 1; j <= n; j += 1) {
            dp[i][j] = linesA[i - 1] === linesB[j - 1]
                ? dp[i - 1][j - 1] + 1
                : Math.max(dp[i - 1][j], dp[i][j - 1]);
        }
    }
    const segments = [];
    let i = m;
    let j = n;
    while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && linesA[i - 1] === linesB[j - 1]) {
            segments.unshift({ type: 'eq', text: linesA[i - 1] });
            i -= 1;
            j -= 1;
        } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
            segments.unshift({ type: 'add', text: linesB[j - 1] });
            j -= 1;
        } else {
            segments.unshift({ type: 'del', text: linesA[i - 1] });
            i -= 1;
        }
    }
    return segments;
}

function diffRegulationVersions({ documentId, fromVersionId, toVersionId }) {
    const docId = normalizeRegulationId(documentId);
    if (!docId) throw new Error('文档 ID 无效');
    const doc = getRegulationDocumentById(docId, { includeArchived: true });
    if (!doc) throw new Error('文档不存在');
    const versions = listRegulationVersions(docId);
    const fromVer = versions.find(v => Number(v.id) === Number(fromVersionId));
    const toVer = versions.find(v => Number(v.id) === Number(toVersionId));
    if (!fromVer || !toVer) throw new Error('版本不存在');

    const fromArticles = db.prepare('SELECT * FROM regulation_articles WHERE document_id=? AND version_id=? ORDER BY sort_order, id').all(docId, fromVer.id);
    const toArticles = db.prepare('SELECT * FROM regulation_articles WHERE document_id=? AND version_id=? ORDER BY sort_order, id').all(docId, toVer.id);

    const fromMap = new Map(fromArticles.map(a => [a.article_label, a]));
    const toMap = new Map(toArticles.map(a => [a.article_label, a]));
    const allLabels = new Set([...fromMap.keys(), ...toMap.keys()]);

    const added = [];
    const removed = [];
    const changed = [];

    allLabels.forEach(label => {
        const a = fromMap.get(label);
        const b = toMap.get(label);
        if (!a && b) {
            added.push({ id: b.id, label: b.article_label, title: b.article_title, content: b.content });
        } else if (a && !b) {
            removed.push({ id: a.id, label: a.article_label, title: a.article_title, content: a.content });
        } else if (a && b && a.content !== b.content) {
            changed.push({
                id: b.id,
                label: b.article_label,
                title: b.article_title,
                before: a.content,
                after: b.content,
                segments: computeLineDiff(a.content, b.content)
            });
        }
    });

    return {
        document: { id: doc.id, title: doc.title },
        from: { id: fromVer.id, version_label: fromVer.version_label, created_at: fromVer.created_at },
        to: { id: toVer.id, version_label: toVer.version_label, created_at: toVer.created_at },
        summary: { added: added.length, removed: removed.length, changed: changed.length },
        added,
        removed,
        changed
    };
}

// 关系类型 → 中文描述
const REGULATION_RELATION_LABELS = {
    cite: '引用',
    depend: '依据',
    apply: '适用',
    supersede: '废止/修订'
};

// 沿引用边扩展命中条文：把直接命中条文所引用、以及引用它们的关联条文补进候选
function expandRegulationMatchesByLinks(matches, { limit = 8 } = {}) {
    const baseIds = matches.map(m => Number(m.article_id)).filter(Boolean);
    if (!baseIds.length) return [];
    const seen = new Set(baseIds);
    const placeholders = baseIds.map(() => '?').join(',');
    // 双向：作为 source 引用出去的目标，以及作为 target 被其它条文引用的来源
    const linkRows = db.prepare(`
        SELECT l.source_article_id, l.target_article_id, l.relation_type,
               sa.id AS sa_id, ta.id AS ta_id
        FROM regulation_article_links l
        LEFT JOIN regulation_articles sa ON sa.id = l.source_article_id
        LEFT JOIN regulation_articles ta ON ta.id = l.target_article_id
        WHERE (l.source_article_id IN (${placeholders}) OR l.target_article_id IN (${placeholders}))
          AND l.target_article_id IS NOT NULL
    `).all(...baseIds, ...baseIds);

    // 收集关联条文 id 及其与命中条文的关系说明
    const relatedInfo = new Map(); // articleId -> {relation}
    linkRows.forEach(row => {
        const rel = REGULATION_RELATION_LABELS[row.relation_type] || '关联';
        if (baseIds.includes(row.source_article_id) && row.target_article_id && !seen.has(row.target_article_id)) {
            relatedInfo.set(row.target_article_id, { relation: `本条${rel}` });
        }
        if (baseIds.includes(row.target_article_id) && row.source_article_id && !seen.has(row.source_article_id)) {
            relatedInfo.set(row.source_article_id, { relation: `被引用（${rel}）` });
        }
    });

    const relatedIds = [...relatedInfo.keys()].slice(0, Math.max(0, limit));
    if (!relatedIds.length) return [];
    const relPlaceholders = relatedIds.map(() => '?').join(',');
    const rows = db.prepare(`
        SELECT
            d.id AS document_id, d.title AS document_title, d.category, d.issuing_body,
            d.jurisdiction, d.effective_date, d.summary AS document_summary,
            v.id AS version_id, v.version_label,
            a.id AS article_id, a.sort_order, a.article_label, a.article_title, a.content,
            substr(replace(a.content, char(10), ' '), 1, 240) AS excerpt
        FROM regulation_articles a
        JOIN regulation_documents d ON d.id = a.document_id
        JOIN regulation_versions v ON v.id = a.version_id
        WHERE a.id IN (${relPlaceholders}) AND d.deleted_at IS NULL
    `).all(...relatedIds);

    return rows.map(row => ({ ...row, viaLink: true, relation: relatedInfo.get(row.article_id)?.relation || '关联' }));
}

// #6 变更影响分析：找出两版本间变更的条文，再反查引用了这些条文的其它条文（被影响方）
function analyzeRegulationChangeImpact({ documentId, fromVersionId, toVersionId }) {
    const diff = diffRegulationVersions({ documentId, fromVersionId, toVersionId });
    // 变更 + 删除的条文标签（这些是可能影响引用方的）
    const impactedLabels = [...diff.changed.map(a => a.label), ...diff.removed.map(a => a.label)];
    if (!impactedLabels.length) {
        return { ...diff, impacts: [] };
    }
    // 在目标版本里找到这些标签对应的 article_id
    const toVerId = normalizeRegulationId(toVersionId);
    const docId = normalizeRegulationId(documentId);
    const impacts = [];
    impactedLabels.forEach(label => {
        // 反查：哪些条文引用了「本文档的这个条号」（同文档内引用）
        const referers = db.prepare(`
            SELECT DISTINCT sa.id AS article_id, sa.article_label, sa.article_title, l.relation_type
            FROM regulation_article_links l
            JOIN regulation_articles sa ON sa.id = l.source_article_id
            WHERE l.target_document_id = ? AND l.target_article_id IN (
                SELECT id FROM regulation_articles WHERE document_id = ? AND article_label = ?
            )
        `).all(docId, docId, label);
        // 跨文档：其它法律引用了本文档（通过 target_document_id 对齐）
        const crossReferers = db.prepare(`
            SELECT DISTINCT sa.id AS article_id, sa.article_label, sa.article_title,
                   d.id AS document_id, d.title AS document_title, l.relation_type
            FROM regulation_article_links l
            JOIN regulation_articles sa ON sa.id = l.source_article_id
            JOIN regulation_documents d ON d.id = sa.document_id
            WHERE l.target_document_id = ? AND d.id != ? AND d.deleted_at IS NULL
              AND l.target_label LIKE ?
        `).all(docId, docId, `%${label}%`);
        if (referers.length || crossReferers.length) {
            impacts.push({ label, internalReferers: referers, crossReferers });
        }
    });
    return { ...diff, impacts, impactVersionId: toVerId };
}

// #4 条文引用网络：聚合一篇文档当前版本（或指定版本）的条文节点与引用边
function getRegulationCitationGraph(documentId, { versionId = null } = {}) {
    const docId = normalizeRegulationId(documentId);
    if (!docId) return { nodes: [], edges: [] };
    const doc = getRegulationDocumentById(docId, { includeArchived: true });
    if (!doc) return { nodes: [], edges: [] };
    const vId = normalizeRegulationId(versionId) || doc.current_version_id;
    if (!vId) return { nodes: [], edges: [] };

    const articles = db.prepare(`
        SELECT id, article_label, article_title, sort_order
        FROM regulation_articles
        WHERE document_id = ? AND version_id = ?
        ORDER BY sort_order, id
    `).all(docId, vId);
    const nodes = articles.map(a => ({
        id: a.id,
        label: a.article_label,
        title: a.article_title || '',
        sortOrder: a.sort_order
    }));
    const nodeIds = new Set(nodes.map(n => n.id));

    // 同文档内的引用边（两端都在本版本）
    const edges = db.prepare(`
        SELECT source_article_id AS source, target_article_id AS target, relation_type AS type,
               target_label, confidence
        FROM regulation_article_links
        WHERE version_id = ?
    `).all(vId).map(e => ({
        source: e.source,
        target: e.target,
        type: e.relation_type || 'cite',
        targetLabel: e.target_label || '',
        confidence: e.confidence,
        // 标记跨法外链（target 不在本文档节点集合内）
        external: !e.target || !nodeIds.has(e.target)
    })).filter(e => nodeIds.has(e.source));

    return { document: { id: doc.id, title: doc.title }, nodes, edges };
}

// #5 查文档中被其它法律废止/修订的条文（supersede 关系指向本文档条文）
function getRegulationSupersedeNotices(documentId, { versionId = null } = {}) {
    const docId = normalizeRegulationId(documentId);
    if (!docId) return [];
    const doc = getRegulationDocumentById(docId, { includeArchived: true });
    if (!doc) return [];
    const vId = normalizeRegulationId(versionId) || doc.current_version_id;
    if (!vId) return [];
    // 其它文档里 relation_type=supersede 且 target 指向本文档当前版本条文
    return db.prepare(`
        SELECT ta.id AS article_id, ta.article_label,
               sd.id AS source_document_id, sd.title AS source_document_title,
               sa.article_label AS source_article_label
        FROM regulation_article_links l
        JOIN regulation_articles ta ON ta.id = l.target_article_id
        JOIN regulation_articles sa ON sa.id = l.source_article_id
        JOIN regulation_documents sd ON sd.id = sa.document_id
        WHERE l.relation_type = 'supersede'
          AND ta.document_id = ? AND ta.version_id = ?
          AND sd.deleted_at IS NULL AND sd.id != ?
    `).all(docId, vId, docId);
}

function buildRegulationAiContext({ query, documentId = null, limit = 12, expandLinks = true, relatedLimit = 8 } = {}) {
    const matches = searchRegulationArticles({ query, documentId, limit });
    const related = expandLinks ? expandRegulationMatchesByLinks(matches, { limit: relatedLimit }) : [];
    const all = [...matches, ...related];

    const sources = all.map((match, index) => ({
        index: index + 1,
        documentId: match.document_id,
        versionId: match.version_id,
        articleId: match.article_id,
        label: `${match.document_title}${match.version_label ? ` / ${match.version_label}` : ''} / ${match.article_label}${match.article_title ? ` ${match.article_title}` : ''}`,
        excerpt: normalizeRegulationSummary(match.excerpt || match.content),
        source: match.document_title,
        viaLink: !!match.viaLink,
        relation: match.relation || ''
    }));

    // 上下文分两组：直接命中 / 经引用关联，便于模型分辨主次
    const directLines = sources.filter(s => !s.viaLink).map(s => `[${s.index}] ${s.label}\n${s.excerpt}`);
    const relatedLines = sources.filter(s => s.viaLink).map(s => `[${s.index}] ${s.label}（${s.relation}）\n${s.excerpt}`);
    const parts = [];
    if (directLines.length) parts.push(`【直接命中条文】\n${directLines.join('\n\n')}`);
    if (relatedLines.length) parts.push(`【经引用关联的条文】\n${relatedLines.join('\n\n')}`);
    const context = parts.join('\n\n');
    return { matches: all, sources, context };
}

async function saveRegulationDocumentVersion({ documentId, userId, file, metadata = {}, providedTitle = '', preloadedText = '' }) {
    const normalizedDocId = normalizeRegulationId(documentId);
    if (!normalizedDocId) {
        const error = new Error('法规文档不存在');
        error.statusCode = 404;
        throw error;
    }
    const doc = getRegulationDocumentById(normalizedDocId, { includeArchived: true });
    if (!doc || doc.deleted_at) {
        const error = new Error('法规文档不存在或已归档');
        error.statusCode = 404;
        throw error;
    }
    if (!file?.path) {
        const error = new Error('请上传法规文档文件');
        error.statusCode = 400;
        throw error;
    }

    const title = normalizeRegulationField(providedTitle || metadata.title || doc.title, 120) || doc.title;
    // 版本标识优先取用户填写值；留空时按法规惯例用施行日期，识别不到再退回 v 序号
    const versionLabel = normalizeRegulationField(metadata.versionLabel || metadata.version_label || '', 80)
        || buildVersionLabelFromDate(metadata.effectiveDate || metadata.effective_date || '')
        || `v${(Number(doc.version_count || 0) || 0) + 1}`;
    const sourceMeta = saveRegulationUploadedFile(file, normalizedDocId);
    const createdAt = getBeijingTimestamp();

    try {
        const extractedText = normalizeRegulationText(preloadedText) || await readRegulationTextFromPath(sourceMeta.absolutePath, file.originalname);
        const articles = parseRegulationArticles(extractedText, { docTitle: title });
        const summary = deriveRegulationSummary({
            title,
            extractedText,
            articles,
            providedSummary: metadata.summary || ''
        });
        const sourceFormat = getSafeRegulationExtension(file.originalname).replace(/^\./, '') || path.extname(file.originalname).replace(/^\./, '');
        const tx = db.transaction(() => {
            const versionInfo = db.prepare(`
                INSERT INTO regulation_versions (
                    document_id, version_label, source_name, source_path, source_size,
                    source_hash, source_format, extracted_text, summary, article_count,
                    uploaded_by_user, created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                normalizedDocId,
                versionLabel,
                normalizeUploadedOriginalName(file.originalname),
                sourceMeta.sourcePath,
                sourceMeta.sourceSize,
                sourceMeta.sourceHash,
                sourceFormat,
                extractedText,
                summary,
                articles.length,
                userId || 0,
                createdAt,
                createdAt
            );
            const versionId = versionInfo.lastInsertRowid;
            const insertArticle = db.prepare(`
                INSERT INTO regulation_articles (
                    document_id, version_id, sort_order, article_label,
                    article_title, content, search_content, heading_path, created_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);
            const orderToArticleId = new Map();
            articles.forEach(article => {
                const info = insertArticle.run(
                    normalizedDocId,
                    versionId,
                    article.sortOrder,
                    article.articleLabel,
                    article.articleTitle,
                    article.content,
                    article.searchContent,
                    article.headingPath || '',
                    createdAt
                );
                orderToArticleId.set(article.sortOrder, info.lastInsertRowid);
            });
            // 抽取并落库条文间引用关系（条号引用对齐到本版本条文 id）
            const links = extractRegulationLinks(articles, { documentId: normalizedDocId, versionId });
            if (links.length) {
                const insertLink = db.prepare(`
                    INSERT INTO regulation_article_links (
                        document_id, version_id, source_article_id, target_label,
                        target_article_id, target_document_id, relation_type, confidence, created_at
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                `);
                links.forEach(link => {
                    const sourceId = orderToArticleId.get(link.sourceOrder);
                    if (!sourceId) return;
                    const targetId = link.targetOrder ? orderToArticleId.get(link.targetOrder) || null : null;
                    insertLink.run(
                        normalizedDocId,
                        versionId,
                        sourceId,
                        link.targetLabel || '',
                        targetId,
                        targetId ? normalizedDocId : null,
                        link.relationType || 'cite',
                        link.confidence || 0.7,
                        createdAt
                    );
                });
            }
            db.prepare(`
                UPDATE regulation_documents
                SET title = ?,
                    summary = ?,
                    status = 'active',
                    current_version_id = ?,
                    version_count = COALESCE(version_count, 0) + 1,
                    article_count = ?,
                    updated_by_user = ?,
                    updated_at = ?
                WHERE id = ? AND deleted_at IS NULL
            `).run(title, summary, versionId, articles.length, userId || 0, createdAt, normalizedDocId);
            return versionId;
        });
        const versionId = tx();
        // 后置任务：更新别名表，解析跨法引用回连，生成向量（均不在事务内，失败不影响入库）
        try {
            saveRegulationAliases(normalizedDocId, title);
            resolveRegulationCrossLinks(versionId);
        } catch (_err) {
            // 别名/跨法回连为增强能力，失败不阻断
        }
        // #2 异步生成条文向量（可选，失败降级为纯 BM25）
        setImmediate(() => {
            const insertedArticles = db.prepare('SELECT id, content FROM regulation_articles WHERE version_id = ? ORDER BY sort_order').all(versionId);
            embedRegulationArticles(insertedArticles, { userId, source: 'regulations_import' }).catch(() => {});
        });
        return {
            document: getRegulationDocumentById(normalizedDocId, { includeArchived: true }),
            version: getRegulationVersionById(versionId),
            articles,
            summary
        };
    } catch (error) {
        try { if (file.path && fs.existsSync(file.path)) fs.rmSync(file.path, { force: true }); } catch (_cleanupErr) {}
        try {
            const target = resolveRegulationStoredPath(sourceMeta.sourcePath);
            if (target && fs.existsSync(target)) {
                fs.rmSync(target, { force: true });
                clearDirSizeCache();
            }
        } catch (_cleanupErr) {}
        throw error;
    }
}

async function createRegulationDocumentFromUpload({ userId, file, metadata = {}, preloadedText = '' }) {
    const now = getBeijingTimestamp();
    const title = normalizeRegulationField(
        metadata.title || deriveRegulationTitleFromText(preloadedText || '', file?.originalname || ''),
        120
    ) || '法规文档';
    const effectiveDate = normalizeRegulationEffectiveDate(metadata.effectiveDate || metadata.effective_date || '');
    const info = db.prepare(`
        INSERT INTO regulation_documents (
            title, category, issuing_body, jurisdiction, effective_date,
            effective_date_normalized, expire_date,
            summary, status, current_version_id, version_count, article_count,
            created_by_user, updated_by_user, deleted_at, deleted_by_user,
            created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, 0, 0, ?, ?, NULL, 0, ?, ?)
    `).run(
        title,
        normalizeRegulationField(metadata.category, 120),
        normalizeRegulationField(metadata.issuingBody || metadata.issuing_body, 120),
        normalizeRegulationField(metadata.jurisdiction, 120),
        effectiveDate,
        normalizeRegulationDateValue(effectiveDate),
        normalizeRegulationDateValue(metadata.expireDate || metadata.expire_date || ''),
        normalizeRegulationSummary(metadata.summary),
        userId || 0,
        userId || 0,
        now,
        now
    );
    const documentId = info.lastInsertRowid;
    try {
        return await saveRegulationDocumentVersion({
            documentId,
            userId,
            file,
            metadata,
            providedTitle: title,
            preloadedText
        });
    } catch (error) {
        db.prepare('DELETE FROM regulation_documents WHERE id = ?').run(documentId);
        throw error;
    }
}

function updateRegulationDocument({ documentId, userId, patch = {} }) {
    const normalizedDocId = normalizeRegulationId(documentId);
    if (!normalizedDocId) return null;
    const doc = getRegulationDocumentById(normalizedDocId, { includeArchived: true });
    if (!doc || doc.deleted_at) return null;
    const effectiveDate = normalizeRegulationEffectiveDate(patch.effectiveDate ?? patch.effective_date ?? doc.effective_date);
    const next = {
        title: normalizeRegulationField(patch.title ?? doc.title, 120) || doc.title,
        category: normalizeRegulationField(patch.category ?? doc.category, 120),
        issuing_body: normalizeRegulationField(patch.issuingBody ?? patch.issuing_body ?? doc.issuing_body, 120),
        jurisdiction: normalizeRegulationField(patch.jurisdiction ?? doc.jurisdiction, 120),
        effective_date: effectiveDate,
        effective_date_normalized: normalizeRegulationDateValue(effectiveDate),
        expire_date: normalizeRegulationDateValue(patch.expireDate ?? patch.expire_date ?? doc.expire_date),
        summary: normalizeRegulationSummary(patch.summary ?? doc.summary),
        status: normalizeRegulationStatus(patch.status ?? doc.status)
    };
    const now = getBeijingTimestamp();
    db.prepare(`
        UPDATE regulation_documents
        SET title = ?,
            category = ?,
            issuing_body = ?,
            jurisdiction = ?,
            effective_date = ?,
            effective_date_normalized = ?,
            expire_date = ?,
            summary = ?,
            status = ?,
            updated_by_user = ?,
            updated_at = ?
        WHERE id = ? AND deleted_at IS NULL
    `).run(
        next.title,
        next.category,
        next.issuing_body,
        next.jurisdiction,
        next.effective_date,
        next.effective_date_normalized,
        next.expire_date,
        next.summary,
        next.status,
        userId || 0,
        now,
        normalizedDocId
    );
    return getRegulationDocumentById(normalizedDocId, { includeArchived: true });
}

// #2 为条文生成向量（可选，失败不阻断）
async function embedRegulationArticles(articles, { userId = 0, source = 'regulations_import' } = {}) {
    if (!Array.isArray(articles) || !articles.length) return;
    try {
        const texts = articles.map(a => String(a.content || '').trim()).filter(Boolean);
        if (!texts.length) return;
        const vectors = await generateEmbeddings(texts, null, null, userId, { source, timeoutMs: 30000 });
        articles.forEach((article, i) => {
            if (vectors[i] && article.id) {
                const embedding = JSON.stringify(vectors[i]);
                db.prepare('UPDATE regulation_articles SET embedding = ? WHERE id = ?').run(embedding, article.id);
            }
        });
    } catch (err) {
        // 向量生成失败不阻断导入，降级为纯 BM25 检索
        console.warn('[regulations] 向量生成失败，降级为 BM25 检索:', err.message);
    }
}

// #8 设置条文级状态（active/amended/repealed）与修订日期
function setRegulationArticleStatus({ articleId, status, amendedDate = '' }) {
    const id = normalizeRegulationId(articleId);
    if (!id) return null;
    const safeStatus = ['active', 'amended', 'repealed'].includes(String(status)) ? status : 'active';
    const safeDate = normalizeRegulationDateValue(amendedDate) || normalizeRegulationField(amendedDate, 40);
    db.prepare('UPDATE regulation_articles SET status = ?, amended_date = ? WHERE id = ?')
        .run(safeStatus, safeStatus === 'active' ? '' : safeDate, id);
    return db.prepare('SELECT id, status, amended_date FROM regulation_articles WHERE id = ?').get(id);
}

// #10 条文批注 CRUD
function createRegulationAnnotation({ articleId, userId, content }) {
    const aid = normalizeRegulationId(articleId);
    const uid = normalizeRegulationId(userId);
    if (!aid || !uid) return null;
    const safeContent = normalizeRegulationField(content, 5000);
    if (!safeContent) return null;
    const result = db.prepare('INSERT INTO regulation_article_annotations (article_id, user_id, content) VALUES (?, ?, ?)')
        .run(aid, uid, safeContent);
    return db.prepare('SELECT * FROM regulation_article_annotations WHERE id = ?').get(result.lastInsertRowid);
}

function listRegulationAnnotations({ articleId }) {
    const aid = normalizeRegulationId(articleId);
    if (!aid) return [];
    return db.prepare(`
        SELECT a.*, u.name as user_name, u.email as user_email
        FROM regulation_article_annotations a
        LEFT JOIN users u ON a.user_id = u.id
        WHERE a.article_id = ?
        ORDER BY a.created_at DESC
    `).all(aid);
}

function updateRegulationAnnotation({ annotationId, userId, content }) {
    const id = normalizeRegulationId(annotationId);
    const uid = normalizeRegulationId(userId);
    if (!id || !uid) return null;
    const safeContent = normalizeRegulationField(content, 5000);
    if (!safeContent) return null;
    const existing = db.prepare('SELECT user_id FROM regulation_article_annotations WHERE id = ?').get(id);
    if (!existing || Number(existing.user_id) !== Number(uid)) return null; // 只能编辑自己的批注
    db.prepare('UPDATE regulation_article_annotations SET content = ?, updated_at = datetime(\'now\', \'+8 hours\') WHERE id = ?')
        .run(safeContent, id);
    return db.prepare('SELECT * FROM regulation_article_annotations WHERE id = ?').get(id);
}

function deleteRegulationAnnotation({ annotationId, userId }) {
    const id = normalizeRegulationId(annotationId);
    const uid = normalizeRegulationId(userId);
    if (!id || !uid) return false;
    const existing = db.prepare('SELECT user_id FROM regulation_article_annotations WHERE id = ?').get(id);
    if (!existing || Number(existing.user_id) !== Number(uid)) return false;
    db.prepare('DELETE FROM regulation_article_annotations WHERE id = ?').run(id);
    return true;
}

// #12 查阅审计：记录查阅/检索/下载/问答行为
function recordRegulationAccess({ userId, documentId = null, action, detail = '' }) {
    const uid = normalizeRegulationId(userId);
    if (!uid || !action) return;
    try {
        db.prepare('INSERT INTO regulation_access_logs (user_id, document_id, action, detail) VALUES (?, ?, ?, ?)')
            .run(uid, normalizeRegulationId(documentId), String(action).slice(0, 40), String(detail || '').slice(0, 500));
    } catch (_err) {
        // 审计失败不影响主流程
    }
}

function listRegulationAccessLogs({ documentId = null, userId = null, limit = 100, offset = 0 } = {}) {
    const clauses = [];
    const params = [];
    const did = normalizeRegulationId(documentId);
    const uid = normalizeRegulationId(userId);
    if (did) { clauses.push('l.document_id = ?'); params.push(did); }
    if (uid) { clauses.push('l.user_id = ?'); params.push(uid); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 100, 1), 500);
    const safeOffset = Math.max(Number.parseInt(offset, 10) || 0, 0);
    const rows = db.prepare(`
        SELECT l.*, u.name as user_name, d.title as document_title
        FROM regulation_access_logs l
        LEFT JOIN users u ON l.user_id = u.id
        LEFT JOIN regulation_documents d ON l.document_id = d.id
        ${where}
        ORDER BY l.created_at DESC
        LIMIT ? OFFSET ?
    `).all(...params, safeLimit, safeOffset);
    const total = db.prepare(`SELECT COUNT(*) as count FROM regulation_access_logs l ${where}`).get(...params).count;
    return { data: rows, total, limit: safeLimit, offset: safeOffset };
}

// #11 生成合规报告（Markdown）：把 AI 问答的问题、回答、依据条文、引用关系汇总
function buildRegulationQaReport({ question, answer, sources = [] }) {
    const lines = [];
    lines.push('# 法规查询合规报告');
    lines.push('');
    lines.push(`**生成时间**：${getBeijingTimestamp()}`);
    lines.push('');
    lines.push('## 咨询问题');
    lines.push('');
    lines.push(String(question || '').trim() || '（未提供问题）');
    lines.push('');
    lines.push('## AI 回答');
    lines.push('');
    lines.push(String(answer || '').trim() || '（无回答内容）');
    lines.push('');
    const direct = sources.filter(s => !s.viaLink);
    const related = sources.filter(s => s.viaLink);
    if (direct.length) {
        lines.push('## 依据法条（直接命中）');
        lines.push('');
        direct.forEach((s, i) => {
            lines.push(`${i + 1}. **${String(s.label || '相关条文').trim()}**`);
            if (s.excerpt) lines.push(`   > ${String(s.excerpt).trim()}`);
        });
        lines.push('');
    }
    if (related.length) {
        lines.push('## 关联法条（经引用关联）');
        lines.push('');
        related.forEach((s, i) => {
            lines.push(`${i + 1}. **${String(s.label || '相关条文').trim()}**${s.relation ? ` _(${s.relation})_` : ''}`);
            if (s.excerpt) lines.push(`   > ${String(s.excerpt).trim()}`);
        });
        lines.push('');
    }
    lines.push('---');
    lines.push('');
    lines.push('> 本报告由法规查询 AI 自动生成，仅供解释与检索辅助，不应替代正式法务意见。');
    return lines.join('\n');
}

function deleteRegulationDocument({ documentId, userId }) {
    const normalizedDocId = normalizeRegulationId(documentId);
    if (!normalizedDocId) return false;
    const doc = getRegulationDocumentById(normalizedDocId, { includeArchived: true });
    if (!doc || doc.deleted_at) return false;
    const now = getBeijingTimestamp();
    const changes = db.prepare(`
        UPDATE regulation_documents
        SET status = 'archived',
            deleted_at = ?,
            deleted_by_user = ?,
            updated_by_user = ?,
            updated_at = ?
        WHERE id = ? AND deleted_at IS NULL
    `).run(now, userId || 0, userId || 0, now, normalizedDocId).changes;
    return changes > 0;
}

// 按文件 sha256 查已存在的同源文档，用于导入时的重复提醒（非阻断）
function findRegulationDuplicateByHash(hash) {
    if (!hash) return null;
    const row = db.prepare(`
        SELECT v.document_id, d.title
        FROM regulation_versions v
        JOIN regulation_documents d ON d.id = v.document_id
        WHERE v.source_hash = ? AND d.deleted_at IS NULL
        ORDER BY v.id DESC
        LIMIT 1
    `).get(hash);
    return row ? { documentId: row.document_id, title: row.title } : null;
}

function resolveRegulationVersionDownloadPath(version) {
    if (!version?.source_path) return null;
    return resolveRegulationStoredPath(version.source_path);
}

module.exports = {
    analyzeRegulationChangeImpact,
    buildRegulationAiContext,
    buildRegulationQaReport,
    createRegulationAnnotation,
    createRegulationDocumentFromUpload,
    createSavedSearch,
    deleteRegulationAnnotation,
    deleteRegulationDocument,
    deleteSavedSearch,
    diffRegulationVersions,
    embedRegulationArticles,
    expandRegulationMatchesByLinks,
    extractRegulationLinks,
    findSimilarRegulationArticles,
    rebuildRegulationCrossLinks,
    resolveRegulationCrossLinks,
    recordRegulationAccess,
    saveRegulationAliases,
    findRegulationDuplicateByHash,
    getRegulationDocumentById,
    getRegulationCitationGraph,
    getRegulationDocumentDetail,
    getRegulationSupersedeNotices,
    getRegulationVersionById,
    listRegulationAccessLogs,
    listRegulationAnnotations,
    listRegulationDocuments,
    listRegulationFacets,
    listRegulationVersions,
    listSavedSearches,
    normalizeRegulationId,
    parseRegulationArticles,
    resolveRegulationVersionDownloadPath,
    saveRegulationDocumentVersion,
    searchRegulationArticles,
    searchRegulationArticlesHybrid,
    setRegulationArticleStatus,
    updateRegulationAnnotation,
    updateRegulationDocument
};
