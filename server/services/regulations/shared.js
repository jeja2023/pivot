const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { query, queryOne, execute, transaction } = require('../../db/client');
const { orderNocase, nowExpr } = require('../../db/dialect');
const { extractDocumentTextWithOcrFallback, truncateExtractedText } = require('../document-processing/text-extraction');
const { getKnowledgeLimits } = require('../resource-limits');
const { getBeijingTimestamp } = require('../../time');
const { normalizeUploadedOriginalName } = require('../../upload');
const { buildRagSearchContent, buildRagSearchTerms, normalizeSearchText } = require('../rag-tokenizer');
const { chunkDocument } = require('../rag-chunker');
const { getChunkSizeForDocType } = require('../rag-config');
const { generateEmbeddings, cosineSimilarity } = require('../rag-index/embedding-client');
const { toProjectRelativePath } = require('../../security');
const { clearDirSizeCache } = require('../dir-size-cache');

const projectRoot = path.resolve(__dirname, '../../..');
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
async function saveRegulationAliases(documentId, title) {
    const docId = normalizeRegulationId(documentId);
    if (!docId) return;
    const aliases = deriveRegulationAliases(title);
    await execute('DELETE FROM regulation_aliases WHERE document_id = ? AND is_primary = 0', [docId]);
    // 主名（完整标题去书名号）置 is_primary=1，其余为派生
    const primary = aliases[0] || '';
    const now = getBeijingTimestamp();
    const seen = new Set();
    for (const alias of aliases) {
        const norm = normalizeRegulationAlias(alias);
        if (!norm || seen.has(norm)) continue;
        seen.add(norm);
        await execute(`
            INSERT INTO regulation_aliases (document_id, alias, normalized_alias, is_primary, created_at)
            VALUES (?, ?, ?, ?, ?)
        `, [docId, alias, norm, alias === primary ? 1 : 0, now]);
    }
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
    const text = await extractDocumentTextWithOcrFallback(filePath, '', originalName || filePath, { maxOcrPages: 10, maxChars: getKnowledgeLimits().extractMaxChars });
    return truncateExtractedText(text, getKnowledgeLimits().extractMaxChars);
}

// \u6587\u4ef6\u540d\u5c3e\u90e8\u300c\u7248\u672c\u53f7\u300d\u8bc6\u522b\uff1a\u6cd5\u5f8b\u6587\u6863\u5e38\u4ee5\u300c\u6cd5\u5f8b\u540d\u79f0 + \u7248\u672c\u65e5\u671f\u300d\u547d\u540d\uff08\u5982 \u4e2d\u534e\u4eba\u6c11\u5171\u548c\u56fd\u516c\u53f8\u6cd5_20240101.doc\uff09\u3002
// \u65e5\u671f\u4e3b\u4f53\u540c\u65f6\u652f\u6301\u7d27\u51d1(20240101)\u4e0e\u5206\u9694(2024-01-01 / 2024.01.01 / 2024/01/01 / 2024\u5e7401\u670801\u65e5)\u7b49\u5e38\u89c1\u5199\u6cd5\u3002
const REG_FILENAME_DATE_BODY = '(?:19|20)\\d{2}[-.\\/\\u5e74]?(?:0[1-9]|1[0-2])[-.\\/\\u6708]?(?:0[1-9]|[12]\\d|3[01])\\u65e5?';
const REG_FILENAME_DATE_CAPTURE = '((?:19|20)\\d{2})[-.\\/\\u5e74]?(0[1-9]|1[0-2])[-.\\/\\u6708]?(0[1-9]|[12]\\d|3[01])\\u65e5?';
// \u5c3e\u90e8\u5141\u8bb8\u8ddf\u53f3\u62ec\u53f7\u4e0e\u300c\u4fee\u8ba2/\u4fee\u6b63/\u7248\u672c/\u7248\u300d\u7b49\u7248\u672c\u8bcd
const REG_FILENAME_VERSION_SUFFIX = '\\s*(?:[\\uff09)\\u3011\\]])?\\s*(?:\\u4fee\\u8ba2\\u7248|\\u4fee\\u6b63\\u7248|\\u4fee\\u8ba2|\\u4fee\\u6b63|\\u7248\\u672c|\\u7248)?\\s*$';
// \u65e5\u671f\u524d\u5141\u8bb8\u6709\u5206\u9694\u7b26\u4e0e\u5de6\u62ec\u53f7
const REG_FILENAME_VERSION_PREFIX = '(?:[\\s._\\-\\u2014\\u2013\\/]*(?:[\\uff08(\\u3010\\[]\\s*)?)?';

const REGULATION_FILENAME_VERSION_DATE_TAIL_RE = new RegExp(REG_FILENAME_VERSION_PREFIX + REG_FILENAME_DATE_BODY + REG_FILENAME_VERSION_SUFFIX);
const REGULATION_FILENAME_VERSION_DATE_CAPTURE_RE = new RegExp(REG_FILENAME_DATE_CAPTURE + REG_FILENAME_VERSION_SUFFIX);
const REGULATION_FILENAME_VERSION_WORD_TAIL_RE = /[\s._\-\u2014\u2013/]*(?:\u4fee\u8ba2\u7248|\u4fee\u6b63\u7248|\u4fee\u8ba2|\u4fee\u6b63|\u7248\u672c|\u7248)\s*$/;

function deriveRegulationTitleFromFilename(filename = '') {
    const rawName = String(filename || '').trim();
    if (!rawName) return '';
    const base = path.basename(rawName, path.extname(rawName));
    const title = base
        .replace(REGULATION_FILENAME_VERSION_DATE_TAIL_RE, '')
        .replace(REGULATION_FILENAME_VERSION_WORD_TAIL_RE, '')
        .replace(/[._\-\u2014\u2013_/]+/g, ' ')
        .replace(/[\uff08\uff09()\u3010\u3011\[\]{}]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return normalizeRegulationField(title, 120);
}

// 从文件名尾部的版本日期识别版本号：公司法20240101.doc / 公司法_2024-01-01.pdf → 2024年01月01日
function deriveRegulationVersionLabelFromFilename(filename = '') {
    const base = path.basename(String(filename || ''), path.extname(String(filename || '')));
    const m = base.match(REGULATION_FILENAME_VERSION_DATE_CAPTURE_RE);
    if (!m) return '';
    return buildVersionLabelFromDate(`${m[1]}-${m[2]}-${m[3]}`);
}

module.exports = {
    crypto,
    fs,
    path,
    query,
    queryOne,
    execute,
    transaction,
    orderNocase,
    nowExpr,
    extractDocumentText: extractDocumentTextWithOcrFallback,
    truncateExtractedText,
    getKnowledgeLimits,
    getBeijingTimestamp,
    normalizeUploadedOriginalName,
    buildRagSearchContent,
    buildRagSearchTerms,
    normalizeSearchText,
    chunkDocument,
    getChunkSizeForDocType,
    generateEmbeddings,
    cosineSimilarity,
    toProjectRelativePath,
    clearDirSizeCache,
    projectRoot,
    uploadRoot,
    regulationsSourceRoot,
    allowedExtensions,
    REGULATION_ARTICLE_LABEL_RE,
    PUNCTUATION_SPLIT_RE,
    REGULATION_MD_HEADING_RE,
    REGULATION_CN_SECTION_RE,
    normalizeRegulationId,
    normalizeRegulationText,
    normalizeRegulationField,
    normalizeRegulationSummary,
    normalizeRegulationStatus,
    buildIsoDate,
    normalizeRegulationDateValue,
    buildVersionLabelFromDate,
    normalizeRegulationAlias,
    deriveRegulationAliases,
    saveRegulationAliases,
    ensureRegulationsSourceRoot,
    getSafeRegulationExtension,
    resolveRegulationStoredPath,
    buildRegulationSourcePath,
    saveRegulationUploadedFile,
    readRegulationTextFromPath,
    deriveRegulationTitleFromFilename,
    deriveRegulationVersionLabelFromFilename
};
