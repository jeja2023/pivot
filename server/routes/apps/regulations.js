const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { extractDocumentText, truncateExtractedText } = require('../../document-text');
const { asyncHandler } = require('../../http');
const { isAdmin, isSuperAdmin } = require('../../permissions');
const { getKnowledgeLimits } = require('../../services/resource-limits');
const {
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
    findRegulationDuplicateByHash,
    findSimilarRegulationArticles,
    getRegulationCitationGraph,
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
} = require('../../services/regulations');

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
        effectiveDate: body.effectiveDate || body.effective_date,
        expireDate: body.expireDate || body.expire_date,
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

function deriveUploadEffectiveDateFromText(extractedText, fallbackName = '') {
    const text = normalizeUploadText(extractedText);
    const fallback = normalizeUploadText(fallbackName);
    const candidates = [];
    if (text) {
        const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
        candidates.push(...lines.slice(0, 100));
        candidates.push(text.slice(0, 3000));
    }
    if (fallback) candidates.push(fallback);
    const preferred = candidates.filter(line => REGULATION_DATE_HINT_RE.test(line));
    for (const line of preferred.concat(candidates)) {
        const date = extractUploadDateCandidate(line);
        if (date) return date;
    }
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
    const base = path.basename(String(fallbackName || ''), path.extname(String(fallbackName || '')));
    return normalizeUploadField(base || '法规文档', 120);
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
    const effectiveDate = normalizeUploadField(
        baseMetadata.effectiveDate || baseMetadata.effective_date || deriveUploadEffectiveDateFromText(extractedText, file?.originalname || ''),
        40
    );
    return {
        ...baseMetadata,
        title,
        effectiveDate,
        extractedText
    };
}

function createRegulationsRouter({ authMiddleware, logAction, uploadLimiter, upload, runAppsAiCompletion }) {
    const router = express.Router();

    router.get('/documents', authMiddleware, asyncHandler(async (req, res) => {
        const includeArchived = isAdmin(req.user) && req.query.includeArchived === 'true';
        const result = listRegulationDocuments({
            query: req.query.query || '',
            category: req.query.category || '',
            jurisdiction: req.query.jurisdiction || '',
            status: req.query.status || '',
            includeArchived,
            limit: req.query.limit,
            offset: req.query.offset
        });
        res.json(result);
    }));

    router.get('/documents/search', authMiddleware, asyncHandler(async (req, res) => {
        const query = String(req.query.query || req.query.q || '').trim();
        if (!query) return res.json({ matches: [] });
        const includeArchived = isAdmin(req.user) && req.query.includeArchived === 'true';
        const documentId = normalizeRegulationId(req.query.documentId || req.query.document_id);
        const matches = searchRegulationArticles({
            query,
            documentId,
            limit: req.query.limit,
            includeArchived
        });
        res.json({ matches });
    }));

    router.get('/facets', authMiddleware, asyncHandler(async (req, res) => {
        const includeArchived = isAdmin(req.user) && req.query.includeArchived === 'true';
        const facets = listRegulationFacets({ includeArchived });
        res.json(facets);
    }));

    router.get('/documents/:id', authMiddleware, asyncHandler(async (req, res) => {
        const includeArchived = isAdmin(req.user);
        const detail = getRegulationDocumentDetail(req.params.id, {
            versionId: req.query.versionId || req.query.version_id,
            includeArchived
        });
        if (!detail || (!includeArchived && detail.document.status === 'archived')) {
            return res.status(404).json({ error: { message: '法规文档不存在或已归档', type: 'invalid_request_error' } });
        }
        recordRegulationAccess({ userId: req.user.id, documentId: detail.document.id, action: 'view', detail: detail.document.title });
        res.json({ detail });
    }));

    router.get('/documents/:id/diff', authMiddleware, asyncHandler(async (req, res) => {
        const fromVersionId = normalizeRegulationId(req.query.from);
        const toVersionId = normalizeRegulationId(req.query.to);
        if (!fromVersionId || !toVersionId) {
            return res.status(400).json({ error: { message: '需要提供 from 和 to 版本 ID', type: 'invalid_request_error' } });
        }
        try {
            const diff = diffRegulationVersions({ documentId: req.params.id, fromVersionId, toVersionId });
            logAction(req, '法规查询版本对比', `${diff.document.title} (v${diff.from.id} → v${diff.to.id})`);
            res.json({ diff });
        } catch (error) {
            res.status(404).json({ error: { message: error.message || '版本对比失败', type: 'not_found' } });
        }
    }));

    router.get('/documents/:id/change-impact', authMiddleware, asyncHandler(async (req, res) => {
        const fromVersionId = normalizeRegulationId(req.query.from);
        const toVersionId = normalizeRegulationId(req.query.to);
        if (!fromVersionId || !toVersionId) {
            return res.status(400).json({ error: { message: '需要提供 from 和 to 版本 ID', type: 'invalid_request_error' } });
        }
        try {
            const impact = analyzeRegulationChangeImpact({ documentId: req.params.id, fromVersionId, toVersionId });
            res.json({ impact });
        } catch (error) {
            res.status(404).json({ error: { message: error.message || '影响分析失败', type: 'not_found' } });
        }
    }));

    router.get('/documents/:id/citation-graph', authMiddleware, asyncHandler(async (req, res) => {
        const graph = getRegulationCitationGraph(req.params.id, {
            versionId: req.query.versionId || req.query.version_id
        });
        res.json({ graph });
    }));

    router.post('/cross-links/rebuild', authMiddleware, asyncHandler(async (req, res) => {
        if (!requireRegulationsAdmin(req, res)) return;
        const documentId = req.body?.documentId || req.body?.document_id || null;
        const result = rebuildRegulationCrossLinks(documentId);
        logAction(req, '法规查询重建跨法关联', `回连 ${result.resolved} 条 / 共 ${result.versions} 版本`);
        res.json(result);
    }));

    router.get('/documents/:id/download', authMiddleware, asyncHandler(async (req, res) => {
        if (!requireRegulationsAdmin(req, res)) return;
        const includeArchived = isAdmin(req.user);
        const detail = getRegulationDocumentDetail(req.params.id, {
            versionId: req.query.versionId || req.query.version_id,
            includeArchived
        });
        if (!detail || (!includeArchived && detail.document.status === 'archived') || !detail.currentVersion) {
            return res.status(404).json({ error: { message: '法规源文件不存在', type: 'invalid_request_error' } });
        }
        const filePath = resolveRegulationVersionDownloadPath(detail.currentVersion);
        if (!filePath || !fs.existsSync(filePath)) {
            return res.status(404).json({ error: { message: '源文件已被移动或删除', type: 'not_found' } });
        }
        recordRegulationAccess({ userId: req.user.id, documentId: detail.document.id, action: 'download', detail: detail.document.title });
        res.download(filePath, detail.currentVersion.source_name || `${detail.document.title}.txt`);
    }));

    router.post('/documents/batch', authMiddleware, uploadLimiter, upload.array('file', 300), asyncHandler(async (req, res) => {
        if (!requireRegulationsAdmin(req, res)) {
            cleanupTempUploads(req.files);
            return;
        }
        const files = Array.isArray(req.files) ? req.files : [];
        if (!files.length) {
            return res.status(400).json({ error: { message: `请选择要导入的法规文档，支持 ${SUPPORTED_UPLOAD_LABEL}`, type: 'invalid_request_error' } });
        }
        const sharedMetadata = readRegulationMetadata(req.body || {});
        const created = [];
        const failed = [];
        for (const file of files) {
            try {
                const duplicateOf = findRegulationDuplicateByHash(hashUploadedFile(file));
                const prepared = await prepareRegulationUploadMetadata(file, sharedMetadata);
                const result = await createRegulationDocumentFromUpload({
                    userId: req.user.id,
                    file,
                    metadata: prepared,
                    preloadedText: prepared.extractedText
                });
                created.push({
                    document: result.document ? { id: result.document.id, title: result.document.title } : null,
                    version: result.version ? { id: result.version.id, version_label: result.version.version_label } : null,
                    summary: result.summary || '',
                    sourceName: file.originalname || '',
                    duplicateOf: duplicateOf || null
                });
            } catch (error) {
                failed.push({
                    fileName: file.originalname || '',
                    message: error.message || '导入失败'
                });
                cleanupTempUpload(file);
            }
        }
        logAction(req, '法规查询批量导入', `成功 ${created.length} / 共 ${files.length}${failed.length ? `，失败 ${failed.length}` : ''}`);
        res.json({
            total: files.length,
            created,
            failed
        });
    }));

    router.post('/documents', authMiddleware, uploadLimiter, upload.single('file'), asyncHandler(async (req, res) => {
        if (!requireRegulationsAdmin(req, res)) {
            cleanupTempUpload(req.file);
            return;
        }
        if (!req.file) {
            return res.status(400).json({ error: { message: `请选择要导入的法规文档，支持 ${SUPPORTED_UPLOAD_LABEL}`, type: 'invalid_request_error' } });
        }
        try {
            const duplicateOf = findRegulationDuplicateByHash(hashUploadedFile(req.file));
            const prepared = await prepareRegulationUploadMetadata(req.file, readRegulationMetadata(req.body || {}));
            const result = await createRegulationDocumentFromUpload({
                userId: req.user.id,
                file: req.file,
                metadata: prepared,
                preloadedText: prepared.extractedText
            });
            logAction(req, '法规查询导入文档', `文档：${result.document?.title || req.file.originalname}`);
            res.json({
                document: result.document,
                version: result.version,
                articles: result.articles,
                duplicateOf: duplicateOf || null,
                summary: result.summary
            });
        } catch (error) {
            cleanupTempUpload(req.file);
            throw error;
        }
    }));

    // #7 导入前预览：只解析不落库，返回切出的条文列表供管理员校正
    router.post('/documents/preview', authMiddleware, uploadLimiter, upload.single('file'), asyncHandler(async (req, res) => {
        if (!requireRegulationsAdmin(req, res)) {
            cleanupTempUpload(req.file);
            return;
        }
        if (!req.file) {
            return res.status(400).json({ error: { message: `请选择要预览的法规文档，支持 ${SUPPORTED_UPLOAD_LABEL}`, type: 'invalid_request_error' } });
        }
        try {
            const prepared = await prepareRegulationUploadMetadata(req.file, readRegulationMetadata(req.body || {}));
            const articles = parseRegulationArticles(prepared.extractedText || '', { docTitle: prepared.title });
            res.json({
                title: prepared.title || '',
                effectiveDate: prepared.effectiveDate || '',
                articleCount: articles.length,
                articles: articles.map((a, i) => ({
                    index: i,
                    articleLabel: a.articleLabel,
                    articleTitle: a.articleTitle,
                    headingPath: a.headingPath || '',
                    content: a.content
                }))
            });
        } finally {
            cleanupTempUpload(req.file);
        }
    }));

    // #8 设置条文级状态（管理员）
    router.put('/articles/:articleId/status', authMiddleware, asyncHandler(async (req, res) => {
        if (!requireRegulationsAdmin(req, res)) return;
        const updated = setRegulationArticleStatus({
            articleId: req.params.articleId,
            status: req.body?.status,
            amendedDate: req.body?.amendedDate || req.body?.amended_date || ''
        });
        if (!updated) {
            return res.status(404).json({ error: { message: '条文不存在', type: 'invalid_request_error' } });
        }
        logAction(req, '法规查询设置条文状态', `条文 ${req.params.articleId} → ${updated.status}`);
        res.json({ article: updated });
    }));

    // #10 条文批注 CRUD
    router.get('/articles/:articleId/annotations', authMiddleware, asyncHandler(async (req, res) => {
        const annotations = listRegulationAnnotations({ articleId: req.params.articleId });
        res.json({ annotations });
    }));

    router.post('/articles/:articleId/annotations', authMiddleware, asyncHandler(async (req, res) => {
        const annotation = createRegulationAnnotation({
            articleId: req.params.articleId,
            userId: req.user.id,
            content: req.body?.content
        });
        if (!annotation) {
            return res.status(400).json({ error: { message: '批注内容不能为空或条文不存在', type: 'invalid_request_error' } });
        }
        logAction(req, '法规查询新增批注', `条文 ${req.params.articleId}`);
        res.json({ annotation });
    }));

    router.put('/annotations/:annotationId', authMiddleware, asyncHandler(async (req, res) => {
        const annotation = updateRegulationAnnotation({
            annotationId: req.params.annotationId,
            userId: req.user.id,
            content: req.body?.content
        });
        if (!annotation) {
            return res.status(403).json({ error: { message: '批注不存在或无权编辑', type: 'forbidden' } });
        }
        res.json({ annotation });
    }));

    router.delete('/annotations/:annotationId', authMiddleware, asyncHandler(async (req, res) => {
        const ok = deleteRegulationAnnotation({
            annotationId: req.params.annotationId,
            userId: req.user.id
        });
        if (!ok) {
            return res.status(403).json({ error: { message: '批注不存在或无权删除', type: 'forbidden' } });
        }
        res.json({ success: true });
    }));

    // #11 AI 回答导出为合规报告（Markdown）
    router.post('/report', authMiddleware, asyncHandler(async (req, res) => {
        const body = req.body || {};
        const markdown = buildRegulationQaReport({
            question: body.question,
            answer: body.answer,
            sources: Array.isArray(body.sources) ? body.sources : []
        });
        logAction(req, '法规查询导出合规报告', `问题：${String(body.question || '').slice(0, 40)}`);
        res.json({ markdown });
    }));

    // #12 查阅审计日志（管理员）
    router.get('/access-logs', authMiddleware, asyncHandler(async (req, res) => {
        if (!requireRegulationsAdmin(req, res)) return;
        const result = listRegulationAccessLogs({
            documentId: req.query.documentId,
            userId: req.query.userId,
            limit: req.query.limit,
            offset: req.query.offset
        });
        res.json(result);
    }));

    // #2 混合检索（可选，向量端点未配置时自动降级为 BM25）
    router.get('/search/hybrid', authMiddleware, asyncHandler(async (req, res) => {
        const matches = await searchRegulationArticlesHybrid({
            query: req.query.q || req.query.query,
            documentId: req.query.documentId || req.query.document_id,
            limit: req.query.limit,
            includeArchived: isAdmin(req.user) && req.query.includeArchived === 'true',
            userId: req.user.id
        });
        res.json({ matches });
    }));

    // #14 相似条文推荐
    router.get('/articles/:articleId/similar', authMiddleware, asyncHandler(async (req, res) => {
        const similar = await findSimilarRegulationArticles({
            articleId: req.params.articleId,
            limit: req.query.limit
        });
        res.json({ similar });
    }));

    // #14 保存检索 CRUD
    router.get('/saved-searches', authMiddleware, asyncHandler(async (req, res) => {
        const searches = listSavedSearches({ userId: req.user.id });
        res.json({ searches });
    }));

    router.post('/saved-searches', authMiddleware, asyncHandler(async (req, res) => {
        const search = createSavedSearch({
            userId: req.user.id,
            name: req.body?.name,
            query: req.body?.query,
            category: req.body?.category,
            jurisdiction: req.body?.jurisdiction
        });
        if (!search) {
            return res.status(400).json({ error: { message: '名称不能为空', type: 'invalid_request_error' } });
        }
        res.json({ search });
    }));

    router.delete('/saved-searches/:searchId', authMiddleware, asyncHandler(async (req, res) => {
        const ok = deleteSavedSearch({
            searchId: req.params.searchId,
            userId: req.user.id
        });
        if (!ok) {
            return res.status(403).json({ error: { message: '检索不存在或无权删除', type: 'forbidden' } });
        }
        res.json({ success: true });
    }));

    router.post('/documents/:id/versions', authMiddleware, uploadLimiter, upload.single('file'), asyncHandler(async (req, res) => {
        if (!requireRegulationsAdmin(req, res)) {
            cleanupTempUpload(req.file);
            return;
        }
        if (!req.file) {
            return res.status(400).json({ error: { message: '请选择要上传的新版本文件', type: 'invalid_request_error' } });
        }
        try {
            const prepared = await prepareRegulationUploadMetadata(req.file, readRegulationMetadata(req.body || {}));
            const result = await saveRegulationDocumentVersion({
                documentId: req.params.id,
                userId: req.user.id,
                file: req.file,
                metadata: prepared,
                providedTitle: req.body?.title || req.body?.name || prepared.title || '',
                preloadedText: prepared.extractedText
            });
            logAction(req, '法规查询追加版本', `文档：${result.document?.title || req.params.id}`);
            res.json({
                document: result.document,
                version: result.version,
                articles: result.articles,
                summary: result.summary
            });
        } catch (error) {
            cleanupTempUpload(req.file);
            throw error;
        }
    }));

    router.put('/documents/:id', authMiddleware, asyncHandler(async (req, res) => {
        if (!requireRegulationsAdmin(req, res)) return;
        const updated = updateRegulationDocument({
            documentId: req.params.id,
            userId: req.user.id,
            patch: req.body || {}
        });
        if (!updated) {
            return res.status(404).json({ error: { message: '法规文档不存在或已归档', type: 'invalid_request_error' } });
        }
        logAction(req, '法规查询更新信息', `文档：${updated.title}`);
        res.json({ document: updated });
    }));

    router.delete('/documents/:id', authMiddleware, asyncHandler(async (req, res) => {
        if (!requireRegulationsSuperAdmin(req, res)) return;
        const deleted = deleteRegulationDocument({
            documentId: req.params.id,
            userId: req.user.id
        });
        if (!deleted) {
            return res.status(404).json({ error: { message: '法规文档不存在或已归档', type: 'invalid_request_error' } });
        }
        logAction(req, '法规查询归档文档', `文档 ID：${req.params.id}`);
        res.json({ success: true });
    }));

    router.post('/ai', authMiddleware, asyncHandler(async (req, res) => {
        const body = req.body || {};
        const query = String(body.query || body.prompt || body.question || '').trim();
        if (!query) {
            return res.status(400).json({ error: { message: '请输入要咨询的问题', type: 'invalid_request_error' } });
        }
        const documentId = normalizeRegulationId(body.documentId || body.document_id);
        const limit = Number.parseInt(body.limit, 10) || 12;
        const built = buildRegulationAiContext({ query, documentId, limit, expandLinks: true });
        recordRegulationAccess({ userId: req.user.id, documentId, action: 'ai_query', detail: query.slice(0, 200) });
        const context = built.context || '当前检索没有命中条文。';
        // 把命中条文的来源精简后随回答一并返回，便于前端展示「依据条文」并可点击跳转
        const sources = (built.sources || []).map(source => ({
            index: source.index,
            documentId: source.documentId,
            articleId: source.articleId,
            label: source.label,
            excerpt: String(source.excerpt || '').slice(0, 200),
            viaLink: !!source.viaLink,
            relation: source.relation || ''
        }));
        // 多轮问答：把最近若干轮历史展开为对话消息，保持上下文连贯
        const history = Array.isArray(body.history) ? body.history.slice(-4) : [];
        const historyMessages = [];
        history.forEach(turn => {
            const q = String(turn?.question || '').trim().slice(0, 2000);
            const a = String(turn?.answer || '').trim().slice(0, 4000);
            if (q) historyMessages.push({ role: 'user', content: q });
            if (a) historyMessages.push({ role: 'assistant', content: a });
        });
        return runAppsAiCompletion({
            req,
            res,
            logAction,
            source: 'regulations',
            auditAction: '法规查询 AI 问答',
            maxTokens: 1200,
            temperature: 0.25,
            stream: !!body.stream,
            extraPayload: { sources },
            messages: [
                {
                    role: 'system',
                    content: [
                        '你是法规查询助手，回答必须基于给定的法规条文依据。',
                        '依据分为「直接命中条文」和「经引用关联的条文」两组：前者是与问题直接相关的条文，后者是被前者引用或引用前者的关联法条。',
                        '请按以下结构组织回答：',
                        '1. 【核心法条】：列出与问题直接相关的关键条文及其要点；',
                        '2. 【关联法条】：列出经引用关联的条文，并说明其与核心法条的引用关系（如“第三条依照第一条”）；若无关联条文则说明“无”；',
                        '3. 【适用建议】：基于上述条文给出简洁、可执行的建议。',
                        '关联法条必须基于提供的引用关系，不得臆造未给出的条文或引用关系。',
                        '如果依据不足，请明确说明当前检索没有找到足够依据，不要编造条文。',
                        '可以结合上文对话进行追问式回答，但仍以本轮提供的条文依据为准。',
                        '不要输出与问题无关的免责声明。'
                    ].join('\n')
                },
                ...historyMessages,
                {
                    role: 'user',
                    content: `法规条文依据：\n${context}\n\n问题：${query}`
                }
            ]
        });
    }));

    return router;
}

module.exports = {
    createRegulationsRouter
};

