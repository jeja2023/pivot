const crypto = require('crypto');
const fs = require('fs');
const { extractDocumentText, truncateExtractedText } = require('../../../document-text');
const { isAdmin, isSuperAdmin } = require('../../../permissions');
const { getKnowledgeLimits } = require('../../../services/resource-limits');
const {
    analyzeRegulationChangeImpact,
    buildRegulationAiContext,
    buildRegulationQaReport,
    createRegulationAnnotation,
    countActualRegulationArticles,
    createRegulationDocumentFromUpload,
    createSavedSearch,
    deleteRegulationAnnotation,
    deleteRegulationDocument,
    deleteSavedSearch,
    diffRegulationVersions,
    findRegulationDuplicateByHash,
    findSimilarRegulationArticles,
    getRegulationCitationGraph,
    deriveRegulationTitleFromFilename,
    deriveRegulationVersionLabelFromFilename,
    getRegulationDocumentDetail,
    listRegulationAccessLogs,
    listRegulationAnnotations,
    listRegulationDocuments,
    listRegulationFacets,
    listSavedSearches,
    normalizeRegulationId,
    parseRegulationArticles,
    rebuildRegulationCrossLinks,
    recordRegulationAccess,
    resolveRegulationVersionDownloadPath,
    saveRegulationDocumentVersion,
    searchRegulationArticles,
    searchRegulationArticlesHybrid,
    setRegulationArticleStatus,
    updateRegulationAnnotation,
    updateRegulationDocument
} = require('../../../services/regulations');

const SUPPORTED_UPLOAD_LABEL = 'TXT、Markdown、PDF、Word（DOC/DOCX）、Excel（XLS/XLSX）、CSV、JSON、HTML/HTM';

function cleanupTempUpload(file) {
    if (!file?.path) return;
    try {
        fs.rmSync(file.path, { force: true });
    } catch (_err) {
        // ignore cleanup errors for temp files
    }
}

function cleanupTempUploads(files) {
    const list = Array.isArray(files) ? files : (files ? [files] : []);
    list.forEach(cleanupTempUpload);
}

// 计算上传临时文件的 sha256，用于导入前的重复检测（失败时返回空串，不影响导入）
function hashUploadedFile(file) {
    if (!file?.path) return '';
    try {
        return crypto.createHash('sha256').update(fs.readFileSync(file.path)).digest('hex');
    } catch (_err) {
        return '';
    }
}

function requireRegulationsAdmin(req, res) {
    if (isAdmin(req.user)) return true;
    res.status(403).json({ error: { message: '仅管理员可管理法规查询', type: 'forbidden' } });
    return false;
}

function requireRegulationsSuperAdmin(req, res) {
    if (isSuperAdmin(req.user)) return true;
    res.status(403).json({ error: { message: '仅 admin 权限层级可删除法规文档', type: 'forbidden' } });
    return false;
}

function readRegulationMetadata(body = {}) {
    return {
        title: body.title,
        category: body.category,
        issuingBody: body.issuingBody || body.issuing_body,
        jurisdiction: body.jurisdiction,
        summary: body.summary,
        versionLabel: body.versionLabel || body.version_label
    };
}

function normalizeUploadField(value, maxLength = 255) {
    return String(value || '').trim().replace(/\s+/g, ' ').slice(0, maxLength);
}

function normalizeUploadText(value) {
    return String(value || '')
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .replace(/\u0000/g, '')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

const REGULATION_TITLE_HINT_RE = /(?:办法|规定|条例|规则|细则|通知|意见|方案|制度|规范|规章|管理办法|实施办法|实施细则|暂行办法|决定|通告|公告|令|法典|中华人民共和国.*法)/;
const REGULATION_BOOK_TITLE_RE = /《([^》]{2,120})》/;
const REGULATION_DATE_FULL_RE = /((?:19|20)\d{2})[年/.\-](0?[1-9]|1[0-2])[月/.\-](0?[1-9]|[12]\d|3[01])日?/;
const REGULATION_DATE_COMPACT_RE = /((?:19|20)\d{2})(0[1-9]|1[0-2])([0-3]\d)/;
const REGULATION_DATE_HINT_RE = /(?:施行|生效|发布日期|发布|公布|印发|实施|颁布|发文|自)/;
const REGULATION_SKIP_TITLE_RE = /^(附件|目录|目\s*录|编号|文号|发文字号|发布日期|实施日期|生效日期|公布日期|印发日期|页码|第\s*[一二三四五六七八九十百千万\d]+\s*页)/;
const REGULATION_ARTICLE_LINE_RE = /^第[〇零一二三四五六七八九十百千万\d]+条/;

function normalizeUploadDateParts(year, month, day) {
    const safeYear = Number.parseInt(year, 10);
    const safeMonth = Number.parseInt(month, 10);
    const safeDay = Number.parseInt(day, 10);
    if (!Number.isInteger(safeYear) || safeYear < 1900 || safeYear > 2100) return '';
    if (!Number.isInteger(safeMonth) || safeMonth < 1 || safeMonth > 12) return '';
    if (!Number.isInteger(safeDay) || safeDay < 1 || safeDay > 31) return '';
    const date = new Date(Date.UTC(safeYear, safeMonth - 1, safeDay));
    if (date.getUTCFullYear() !== safeYear || date.getUTCMonth() !== safeMonth - 1 || date.getUTCDate() !== safeDay) return '';
    return String(safeYear).padStart(4, '0') + '-' + String(safeMonth).padStart(2, '0') + '-' + String(safeDay).padStart(2, '0');
}

function extractUploadDateCandidate(line) {
    const text = normalizeUploadField(line, 160);
    if (!text) return '';
    let match = text.match(REGULATION_DATE_FULL_RE);
    if (match) return normalizeUploadDateParts(match[1], match[2], match[3]);
    match = text.match(REGULATION_DATE_COMPACT_RE);
    if (match) return normalizeUploadDateParts(match[1], match[2], match[3]);
    return '';
}

function isLikelyUploadTitleLine(line) {
    const text = normalizeUploadField(line, 120);
    if (!text || text.length < 4 || text.length > 120) return false;
    if (REGULATION_SKIP_TITLE_RE.test(text)) return false;
    if (REGULATION_ARTICLE_LINE_RE.test(text)) return false;
    if (REGULATION_DATE_HINT_RE.test(text) && extractUploadDateCandidate(text)) return false;
    if (/^\d+$/.test(text)) return false;
    if (/^[·\-—_\s]+$/.test(text)) return false;
    return true;
}

function deriveUploadTitleFromText(extractedText, fallbackName = '') {
    const filenameTitle = deriveRegulationTitleFromFilename(fallbackName);
    if (filenameTitle) return normalizeUploadField(filenameTitle, 120);
    const text = normalizeUploadText(extractedText);
    const lines = text ? text.split('\n').map(line => line.trim()).filter(Boolean) : [];
    for (const line of lines.slice(0, 30)) {
        const bookMatch = line.match(REGULATION_BOOK_TITLE_RE);
        if (bookMatch) {
            const title = normalizeUploadField(bookMatch[1], 120);
            if (title) return title;
        }
    }
    const hintedLine = lines.slice(0, 30).find(line => isLikelyUploadTitleLine(line) && REGULATION_TITLE_HINT_RE.test(line));
    if (hintedLine) return normalizeUploadField(hintedLine, 120);
    const firstLine = lines.slice(0, 30).find(isLikelyUploadTitleLine);
    if (firstLine) return normalizeUploadField(firstLine, 120);
    return '\u6cd5\u89c4\u6587\u6863';
}

async function extractUploadText(file) {
    if (!file?.path) return '';
    try {
        const text = await extractDocumentText(file.path, '', file.originalname);
        return truncateExtractedText(normalizeUploadText(text), getKnowledgeLimits().extractMaxChars);
    } catch (_err) {
        return '';
    }
}

async function prepareRegulationUploadMetadata(file, baseMetadata = {}) {
    const extractedText = await extractUploadText(file);
    const title = normalizeUploadField(
        baseMetadata.title || deriveUploadTitleFromText(extractedText, file?.originalname || ''),
        120
    ) || '法规文档';
    // 版本号优先取用户填写值，其次从文件名中的 8 位日期（如 公司法20240101.pdf）自动识别
    const versionLabel = normalizeUploadField(
        baseMetadata.versionLabel || baseMetadata.version_label || deriveRegulationVersionLabelFromFilename(file?.originalname || ''),
        80
    );
    return {
        ...baseMetadata,
        title,
        versionLabel,
        extractedText
    };
}

module.exports = {
    fs,
    isAdmin,
    analyzeRegulationChangeImpact,
    buildRegulationAiContext,
    buildRegulationQaReport,
    cleanupTempUpload,
    cleanupTempUploads,
    countActualRegulationArticles,
    createRegulationAnnotation,
    createRegulationDocumentFromUpload,
    createSavedSearch,
    deleteRegulationAnnotation,
    deleteRegulationDocument,
    deleteSavedSearch,
    diffRegulationVersions,
    findRegulationDuplicateByHash,
    findSimilarRegulationArticles,
    getRegulationCitationGraph,
    getRegulationDocumentDetail,
    hashUploadedFile,
    listRegulationAccessLogs,
    listRegulationAnnotations,
    listRegulationDocuments,
    listRegulationFacets,
    listSavedSearches,
    normalizeRegulationId,
    parseRegulationArticles,
    prepareRegulationUploadMetadata,
    readRegulationMetadata,
    rebuildRegulationCrossLinks,
    recordRegulationAccess,
    requireRegulationsAdmin,
    requireRegulationsSuperAdmin,
    resolveRegulationVersionDownloadPath,
    saveRegulationDocumentVersion,
    searchRegulationArticles,
    searchRegulationArticlesHybrid,
    setRegulationArticleStatus,
    SUPPORTED_UPLOAD_LABEL,
    updateRegulationAnnotation,
    updateRegulationDocument
};
