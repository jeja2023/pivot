'use strict';

const express = require('express');
const crypto = require('crypto');
const fs = require('fs/promises');
const { asyncHandler, normalizeLimit } = require('../../http');
const { createSafeUpload, uploadSecurityMiddleware } = require('../../upload');
const { extractDocumentText, truncateExtractedText } = require('../../document-text');
const { callModelTextWithBudget } = require('../../services/model-text-call');
const { queryOne, execute } = require('../../db/client');
const { assertTenantContext } = require('../../services/agent-tenant-context');
const { getModelDailyUsageAsync } = require('../../services/models');
const {
    addPresentationCollaborator,
    createPresentation,
    createPresentationFromArtifact,
    createPresentationRemoteSession,
    setPresentationRemoteSlide,
    closePresentationRemoteSession,
    getPresentationRemoteState,
    getPresentationRemoteAsset,
    setPresentationFavorite,
    createPresentationComment,
    createPresentationExport,
    createPresentationTemplate,
    submitPresentationTemplateForReview,
    reviewPresentationTemplate,
    deletePresentation,
    deletePresentationComment,
    duplicatePresentation,
    exportPresentationTemplate,
    getPresentation,
    getPresentationTemplateStatistics,
    getPresentationAsset,
    listPresentationAssets,
    publishPresentationAsset,
    getPresentationAssetByRef,
    getPresentationVersion,
    listPresentationCollaborators,
    listPresentationComments,
    listPresentationExports,
    listPresentationTemplates,
    listPresentationVersions,
    listPresentations,
    importPresentationTemplate,
    importPresentationTemplateFile,
    removePresentationCollaborator,
    resolvePresentationComment,
    rollbackPresentation,
    savePresentationContent,
    updatePresentationMetadata,
    updatePresentationTemplate,
    uploadPresentationAsset
} = require('../../services/presentations/presentation-service');
const {
    recordPresence,
    listActivePresence,
    leavePresence
} = require('../../services/presentations/presentation-presence');
const { runPresentationValidation } = require('../../services/presentations/presentation-validation');
const { buildOutlineMessages, buildSlidesMessages, buildContinueMessages, buildRewriteMessages, buildValidationMessages, parsePresentationProposal, parseValidationProposal } = require('../../services/presentations/presentation-ai');
const { resolveAppsModel, buildModelSecretErrorPayload } = require('./helpers');
const { buildChart } = require('../../services/data-analysis');
const { normalizePresentation } = require('../../services/presentations/presentation-schema');
const { getPresentationMetricsSnapshot, recordPresentationOutcome } = require('../../services/presentations/presentation-metrics');
const { isAdmin } = require('../../permissions');

const MAX_MATERIAL_TEXT = 120000;

function contentDisposition(filename) {
    const safe = String(filename || 'presentation').replace(/[\\/\r\n"]/g, '_').slice(0, 180);
    const fallback = safe.replace(/[^\x20-\x7E]/g, '_');
    return `inline; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}

async function removeUpload(file) {
    if (file?.path) await fs.rm(file.path, { force: true }).catch(() => {});
}

function normalizeMaterials(body) {
    if (!Array.isArray(body?.materials)) return [];
    return body.materials.slice(0, 20).map((item, index) => ({
        id: String(item?.id || `source_${index + 1}`).trim().slice(0, 96),
        title: String(item?.title || '材料').trim().slice(0, 240),
        text: String(item?.text || '').trim().slice(0, MAX_MATERIAL_TEXT)
    })).filter(item => item.text);
}

async function callPresentationAi({ req, logAction, messages, source, auditAction, maxTokens, signal }) {
    const modelCfg = await resolveAppsModel(String(req.body?.model || '').trim(), req.user);
    if (!modelCfg) {
        const error = new Error('未找到可用模型，请在当前应用中选择模型或设置默认模型后再使用 AI 功能。');
        error.status = 404;
        error.code = 'MODEL_NOT_FOUND';
        throw error;
    }
    if (modelCfg.secret_error) {
        const error = new Error(buildModelSecretErrorPayload(modelCfg).error.message);
        error.status = 400;
        error.code = 'MODEL_SECRET_INVALID';
        throw error;
    }
    if (Number(modelCfg.daily_token_limit) > 0) {
        const used = await getModelDailyUsageAsync(req.user.id, modelCfg.id);
        if (used >= Number(modelCfg.daily_token_limit)) {
            const error = new Error('今日模型调用额度已用尽。');
            error.status = 429;
            error.code = 'INSUFFICIENT_QUOTA';
            throw error;
        }
    }
    logAction(req, auditAction, `模型: ${modelCfg.name}`);
    const result = await callModelTextWithBudget({ modelCfg, user: req.user, messages, source, maxTokens, maxOutputTokensCap: maxTokens, temperature: 0.25, timeout: 180000, signal });
    return { ...result, model: modelCfg.model_name };
}

function requestAbortSignal(req, res) {
    const controller = new AbortController();
    const onAbort = () => { if (!controller.signal.aborted) controller.abort(new Error('PPT AI 请求已取消。')); };
    if (typeof req.once === 'function') req.once('aborted', onAbort);
    if (typeof res?.once === 'function') res.once('close', () => { if (!res.writableEnded) onAbort(); });
    return { signal: controller.signal, cleanup: () => req.removeListener?.('aborted', onAbort) };
}

function aiRequestDigest(body) {
    const clone = { ...(body || {}) }; delete clone.idempotencyKey;
    return crypto.createHash('sha256').update(JSON.stringify(clone)).digest('hex');
}

function aiIdempotencyError(message, code) {
    const error = new Error(message);
    error.status = 409;
    error.code = code;
    return error;
}

function cachedAiResponse(row) {
    try { return row.response_json ? JSON.parse(row.response_json) : null; } catch (_) { return null; }
}

async function inspectAiIdempotencyRow(row, context) {
    if (!row) throw aiIdempotencyError('AI 请求状态未找到，请使用新的 Idempotency-Key 重试。', 'PRESENTATION_AI_REQUEST_MISSING');
    if (String(row.request_digest) !== context.digest) {
        throw aiIdempotencyError('同一 Idempotency-Key 不能用于不同的请求内容。', 'PRESENTATION_AI_IDEMPOTENCY_CONFLICT');
    }
    if (row.status === 'completed') {
        const cached = cachedAiResponse(row);
        if (cached) return { ...context, cached };
        throw aiIdempotencyError('已完成的 AI 请求结果损坏，请使用新的 Idempotency-Key 重试。', 'PRESENTATION_AI_RESULT_INVALID');
    }
    if (row.status === 'processing') {
        throw aiIdempotencyError('相同 AI 请求正在处理中，请稍后重试。', 'PRESENTATION_AI_REQUEST_IN_PROGRESS');
    }
    const reclaimed = await queryOne(`
        UPDATE presentation_ai_requests
        SET status = 'processing', response_json = '', error_code = '', updated_at = NOW()
        WHERE tenant_id = ? AND user_id = ? AND idempotency_key = ? AND request_digest = ? AND status = 'failed'
        RETURNING id
    `, [context.tenantId, context.userId, context.key, context.digest]);
    if (reclaimed) return { ...context, cached: null };
    const latest = await queryOne('SELECT * FROM presentation_ai_requests WHERE tenant_id = ? AND user_id = ? AND idempotency_key = ?', [context.tenantId, context.userId, context.key]);
    return inspectAiIdempotencyRow(latest, context);
}

async function beginAiIdempotency(req, body) {
    const key = String(req.get?.('Idempotency-Key') || body?.idempotencyKey || '').trim().slice(0, 180);
    if (!key) return null;
    const tenant = await assertTenantContext(req.user);
    const context = { key, tenantId: tenant.tenantId, userId: req.user.id, digest: aiRequestDigest(body), cached: null };
    const existing = await queryOne('SELECT * FROM presentation_ai_requests WHERE tenant_id = ? AND user_id = ? AND idempotency_key = ?', [context.tenantId, context.userId, context.key]);
    if (existing) return inspectAiIdempotencyRow(existing, context);
    const inserted = await queryOne(`
        INSERT INTO presentation_ai_requests
            (tenant_id, user_id, idempotency_key, request_digest, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'processing', NOW(), NOW())
        ON CONFLICT (tenant_id, user_id, idempotency_key) DO NOTHING
        RETURNING id
    `, [context.tenantId, context.userId, context.key, context.digest]);
    if (inserted) return context;
    const contested = await queryOne('SELECT * FROM presentation_ai_requests WHERE tenant_id = ? AND user_id = ? AND idempotency_key = ?', [context.tenantId, context.userId, context.key]);
    return inspectAiIdempotencyRow(contested, context);
}

async function finishAiIdempotency(ctx, payload, errorCode = '') {
    if (!ctx?.key) return;
    await execute('UPDATE presentation_ai_requests SET status = ?, response_json = ?, error_code = ?, updated_at = NOW() WHERE tenant_id = ? AND user_id = ? AND idempotency_key = ?', [errorCode ? 'failed' : 'completed', errorCode ? '' : JSON.stringify(payload || {}), errorCode, ctx.tenantId, ctx.userId, ctx.key]);
}

function createPresentationsRouter({ authMiddleware, logAction, uploadLimiter, upload } = {}) {
    const router = express.Router();
    const presentationUpload = createSafeUpload({ extensions: new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ttf', '.otf', '.woff', '.woff2', '.mp3', '.wav', '.ogg', '.aac', '.m4a', '.mp4', '.webm', '.mov', '.pdf', '.pptx', '.pptm', '.ppsm', '.bas', '.vba', '.docx', '.xlsx', '.txt', '.md']), fileSize: 100 * 1024 * 1024, maxFields: 12, errorMessage: 'PPT 素材仅支持图片、字体、音视频、PDF、DOCX、XLSX、TXT 或 Markdown' });
    const presentationFile = field => [presentationUpload.single(field), uploadSecurityMiddleware];
    const writeLog = typeof logAction === 'function' ? logAction : () => {};

    router.get('/apps/presentations/metrics', authMiddleware, asyncHandler(async (req, res) => {
        if (!isAdmin(req.user)) return res.status(403).json({ error: '只有管理员可以查看 PPT 运营指标。', code: 'PRESENTATION_METRICS_ADMIN_REQUIRED' });
        res.json({ metrics: getPresentationMetricsSnapshot() });
    }));
    router.get('/apps/presentations/remote/:token/state', asyncHandler(async (req, res) => {
        const remote = await getPresentationRemoteState(req.params.token);
        if (!remote) return res.status(404).json({ error: '远程演示链接不存在、已关闭或已过期。', code: 'PRESENTATION_REMOTE_SESSION_NOT_FOUND' });
        res.setHeader('Cache-Control', 'no-store');
        res.json({ remote });
    }));
    router.get('/apps/presentations/remote/:token/assets', asyncHandler(async (req, res) => {
        const asset = await getPresentationRemoteAsset(req.params.token, req.query.ref);
        if (!asset) return res.status(404).json({ error: '远程演示素材不存在、无权访问或链接已过期。' });
        res.setHeader('Content-Type', asset.mimeType);
        res.setHeader('Content-Disposition', contentDisposition(asset.filename));
        res.setHeader('Cache-Control', 'private, max-age=60');
        res.send(asset.buffer);
    }));
    router.get('/apps/presentations/templates', authMiddleware, asyncHandler(async (req, res) => {
        res.json({ templates: await listPresentationTemplates(req.user, { includeDrafts: req.query.includeDrafts === 'true' }) });
    }));
    router.post('/apps/presentations/templates', authMiddleware, asyncHandler(async (req, res) => {
        const template = await createPresentationTemplate(req.user, req.body || {});
        writeLog(req, '创建PPT模板', `模板: ${template.id}`);
        res.status(201).json({ success: true, template });
    }));
    router.put('/apps/presentations/templates/:id', authMiddleware, asyncHandler(async (req, res) => {
        const template = await updatePresentationTemplate(req.user, req.params.id, req.body || {});
        writeLog(req, '更新PPT模板', `模板: ${template.id}，版本: ${template.version}`);
        res.json({ success: true, template });
    }));
    router.post('/apps/presentations/templates/:id/submit-review', authMiddleware, asyncHandler(async (req, res) => {
        const template = await submitPresentationTemplateForReview(req.user, req.params.id);
        writeLog(req, '提交PPT模板审核', '模板: ' + template.id);
        res.json({ success: true, template });
    }));
    router.post('/apps/presentations/templates/:id/review', authMiddleware, asyncHandler(async (req, res) => {
        const template = await reviewPresentationTemplate(req.user, req.params.id, req.body || {});
        writeLog(req, '审核PPT模板', '模板: ' + template.id + '，状态: ' + template.status);
        res.json({ success: true, template });
    }));
    router.get('/apps/presentations/templates/statistics', authMiddleware, asyncHandler(async (req, res) => {
        const statistics = await getPresentationTemplateStatistics(req.user);
        res.json({ statistics });
    }));
    router.post('/apps/presentations/templates/import', authMiddleware, uploadLimiter, presentationFile('file'), asyncHandler(async (req, res) => {
        try {
            if (!req.file?.path) return res.status(400).json({ error: '请选择模板包文件。' });
            const template = await importPresentationTemplateFile(req.user, await fs.readFile(req.file.path), { filename: req.file.originalname, mimeType: req.file.mimetype, scope: req.body?.scope, publish: req.body?.publish !== 'false' });
            writeLog(req, '导入PPT模板', `模板: ${template.id}`);
            return res.status(201).json({ success: true, template });
        } finally {
            await removeUpload(req.file);
        }
    }));
    router.get('/apps/presentations/templates/:id/package', authMiddleware, asyncHandler(async (req, res) => {
        const packageData = await exportPresentationTemplate(req.user, req.params.id);
        const filename = `${String(packageData.template.name || 'PPT模板').replace(/[\\/\r\n]/g, '_').slice(0, 100)}.pivot-ppt-template.json`;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Disposition', contentDisposition(filename));
        res.setHeader('Cache-Control', 'no-store');
        return res.send(JSON.stringify(packageData, null, 2));
    }));

    router.get('/apps/presentations', authMiddleware, asyncHandler(async (req, res) => {
        res.json({ presentations: await listPresentations(req.user, {
            limit: normalizeLimit(req.query.limit, 50, 100), search: req.query.search, templateId: req.query.templateId, status: req.query.status, tag: req.query.tag, favorite: req.query.favorite,
            createdBy: req.query.createdBy || req.query.created_by, updatedFrom: req.query.updatedFrom || req.query.updated_from, updatedTo: req.query.updatedTo || req.query.updated_to
        }) });
    }));
    router.post('/apps/presentations/from-artifact/:artifactId', authMiddleware, asyncHandler(async (req, res) => {
        const startedAt = Date.now(); const presentation = await createPresentationFromArtifact(req.user, req.params.artifactId, req.body || {});
        recordPresentationOutcome('from_artifact', { durationMs: Date.now() - startedAt });
        writeLog(req, '从智能体产物创建PPT', '产物: ' + req.params.artifactId + '，文稿: ' + presentation.id);
        res.status(201).json({ success: true, presentation });
    }));
    router.post('/apps/presentations', authMiddleware, asyncHandler(async (req, res) => {
        const startedAt = Date.now();
        try {
            const presentation = await createPresentation(req.user, req.body || {});
            recordPresentationOutcome('create', { outcome: 'success', durationMs: Date.now() - startedAt });
            writeLog(req, '创建PPT演示文稿', `文稿: ${presentation.id}`);
            res.status(201).json({ success: true, presentation });
        } catch (error) { recordPresentationOutcome('create', { outcome: 'failed', durationMs: Date.now() - startedAt }); throw error; }
    }));

    router.post('/apps/presentations/materials/extract', authMiddleware, uploadLimiter, upload.single('file'), asyncHandler(async (req, res) => {
        try {
            if (!req.file?.path) return res.status(400).json({ error: '请选择需要转换的材料文件。' });
            const text = truncateExtractedText(await extractDocumentText(req.file.path, req.file.mimetype, req.file.originalname, { maxChars: MAX_MATERIAL_TEXT }), MAX_MATERIAL_TEXT);
            if (!text.trim()) return res.status(422).json({ error: '未能从材料中提取可用文本，请检查文件内容或先进行 OCR。', code: 'PRESENTATION_MATERIAL_EMPTY' });
            writeLog(req, '提取PPT材料', `文件: ${String(req.file.originalname || '').slice(0, 120)}`);
            return res.json({ material: { id: `source_${Date.now()}`, title: String(req.file.originalname || '材料').slice(0, 240), text, truncated: text.length >= MAX_MATERIAL_TEXT } });
        } finally {
            await removeUpload(req.file);
        }
    }));

    router.get('/apps/presentations/assets', authMiddleware, asyncHandler(async (req, res) => {
        res.json({ assets: await listPresentationAssets(req.user, { type: req.query.type, search: req.query.search, limit: normalizeLimit(req.query.limit, 80, 200) }) });
    }));
    router.post('/apps/presentations/assets', authMiddleware, uploadLimiter, presentationFile('file'), asyncHandler(async (req, res) => {
        try {
            if (!req.file?.path) return res.status(400).json({ error: '请选择图片素材。' });
            const buffer = await fs.readFile(req.file.path);
            const asset = await uploadPresentationAsset(req.user, { ...req.file, buffer }, { assetType: req.body?.assetType || req.body?.asset_type, scope: req.body?.scope, departmentName: req.body?.departmentName || req.body?.department_name });
            writeLog(req, '上传PPT素材', `素材: ${asset.id}，文件: ${asset.filename}`);
            return res.status(201).json({ success: true, asset });
        } finally {
            await removeUpload(req.file);
        }
    }));
    router.post('/apps/presentations/assets/publish', authMiddleware, asyncHandler(async (req, res) => {
        const asset = await publishPresentationAsset(req.user, req.body?.ref, { scope: req.body?.scope, departmentName: req.body?.departmentName || req.body?.department_name });
        writeLog(req, '发布PPT品牌素材', '素材: ' + asset.id + '，范围: ' + asset.scope);
        res.json({ success: true, asset });
    }));
    router.get('/apps/presentations/assets/:assetId/content', authMiddleware, asyncHandler(async (req, res) => {
        const result = await getPresentationAsset(req.user, req.params.assetId);
        if (!result) return res.status(404).json({ error: '素材不存在或无权访问。' });
        res.setHeader('Content-Type', result.asset.mimeType);
        res.setHeader('Content-Disposition', contentDisposition(result.asset.filename));
        res.setHeader('Cache-Control', 'private, max-age=300');
        return res.send(result.buffer);
    }));
    router.get('/apps/presentations/assets/content/by-ref', authMiddleware, asyncHandler(async (req, res) => {
        const result = await getPresentationAssetByRef(req.user, req.query.ref, { presentationId: req.query.presentationId || req.query.presentation_id });
        if (!result) return res.status(404).json({ error: '素材不存在或无权访问。' });
        res.setHeader('Content-Type', result.asset.mimeType);
        res.setHeader('Content-Disposition', contentDisposition(result.asset.filename));
        res.setHeader('Cache-Control', 'private, max-age=300');
        return res.send(result.buffer);
    }));

    async function runAiRequest(req, res, body, messages, options = {}) {
        const startedAt = Date.now();
        const idem = await beginAiIdempotency(req, body);
        if (idem?.cached) return res.json(idem.cached);
        const abort = requestAbortSignal(req, res);
        try {
            const result = await callPresentationAi({ req, logAction: writeLog, messages, source: options.source || 'presentation_ai', auditAction: options.auditAction || 'PPT AI操作', maxTokens: options.maxTokens || 4000, signal: abort.signal });
            const payload = await options.parse(result);
            const response = { ...payload, model: result.model, usage: result.usage, contextBudget: result.contextBudget, requestId: req.id || req.get?.('x-request-id') || '' };
            await finishAiIdempotency(idem, response);
            recordPresentationOutcome(options.source || 'ai', { outcome: 'success', durationMs: Date.now() - startedAt, source: options.source || 'ai' });
            return res.json(response);
        } catch (error) {
            await finishAiIdempotency(idem, null, error.code || 'PRESENTATION_AI_FAILED');
            recordPresentationOutcome(options.source || 'ai', { outcome: abort.signal.aborted ? 'cancelled' : 'failed', durationMs: Date.now() - startedAt, source: options.source || 'ai' });
            if (abort.signal.aborted) return res.status(499).json({ error: 'AI 请求已取消。', code: 'PRESENTATION_AI_CANCELLED' });
            throw error;
        } finally { abort.cleanup(); }
    }

    router.post('/apps/presentations/ai/outline', authMiddleware, asyncHandler(async (req, res) => {
        const body = { ...(req.body || {}), materials: normalizeMaterials(req.body) };
        if (!String(body.topic || '').trim()) return res.status(400).json({ error: '请输入演示主题。', code: 'PRESENTATION_TOPIC_REQUIRED' });
        return runAiRequest(req, res, body, buildOutlineMessages(body), { source: 'presentation_outline', auditAction: 'PPT AI生成大纲', maxTokens: 2600, parse: async result => {
            let outline; try { outline = parsePresentationProposal(result.content, { title: body.topic, templateId: body.templateId, aspectRatio: body.aspectRatio, language: body.language }); } catch (error) { error.status = error.status || 422; throw error; }
            return { outline };
        }});
    }));

    router.post('/apps/presentations/ai/slides', authMiddleware, asyncHandler(async (req, res) => {
        const body = { ...(req.body || {}), materials: normalizeMaterials(req.body) };
        if (!body.outline || typeof body.outline !== 'object') return res.status(400).json({ error: '请先提供已确认的大纲。', code: 'PRESENTATION_OUTLINE_REQUIRED' });
        return runAiRequest(req, res, body, buildSlidesMessages(body), { source: 'presentation_slides', auditAction: 'PPT AI生成页面', maxTokens: 6000, parse: async result => {
            const proposal = parsePresentationProposal(result.content, { title: body.title || body.outline.title, templateId: body.templateId, aspectRatio: body.aspectRatio, language: body.language });
            if (proposal.presentation) {
                const sourceIds = new Set(body.materials.map((item, index) => item.id || 'source_' + (index + 1)));
                proposal.presentation.slides.forEach(slide => { slide.sourceRefs = (slide.sourceRefs || []).filter(ref => sourceIds.has(ref)); (slide.elements || []).forEach(element => { element.sourceRefs = (element.sourceRefs || []).filter(ref => sourceIds.has(ref)); }); });
                proposal.presentation = normalizePresentation({ ...proposal.presentation, sources: body.materials.map((item, index) => ({ id: item.id || 'source_' + (index + 1), title: item.title || '材料', type: 'material', locator: '', digest: '' })) });
            }
            return { proposal, validation: runPresentationValidation(proposal.presentation) };
        }});
    }));

    router.post('/apps/presentations/ai/continue', authMiddleware, asyncHandler(async (req, res) => {
        const body = { ...(req.body || {}), materials: normalizeMaterials(req.body) };
        if (!body.outline && !body.presentation) return res.status(400).json({ error: '请提供当前大纲或演示文稿。', code: 'PRESENTATION_CONTEXT_REQUIRED' });
        const requestedSlides = Math.max(1, Math.min(Number.parseInt(body.additionalSlideCount || body.additional_slide_count, 10) || 1, 10));
        return runAiRequest(req, res, { ...body, additionalSlideCount: requestedSlides }, buildContinueMessages({ ...body, additionalSlideCount: requestedSlides }), { source: 'presentation_continue', auditAction: 'PPT AI继续生成', maxTokens: Math.min(6000, 1100 * requestedSlides), parse: async result => {
            const proposal = parsePresentationProposal(result.content, { title: body.title || body.topic, templateId: body.templateId, aspectRatio: body.aspectRatio, language: body.language });
            if (!Array.isArray(proposal.presentation?.slides) || proposal.presentation.slides.length !== requestedSlides) {
                const error = new Error('AI 返回的新增页数与请求不一致，请重试。'); error.status = 422; error.code = 'PRESENTATION_AI_CONTINUE_COUNT_INVALID'; throw error;
            }
            return { proposal, validation: runPresentationValidation(proposal.presentation) };
        } });
    }));

    router.post('/apps/presentations/ai/rewrite', authMiddleware, asyncHandler(async (req, res) => {
        const body = { ...(req.body || {}), materials: normalizeMaterials(req.body) };
        if (!body.slide || typeof body.slide !== 'object') return res.status(400).json({ error: '请提供要改写的页面。', code: 'PRESENTATION_SLIDE_REQUIRED' });
        return runAiRequest(req, res, body, buildRewriteMessages(body), { source: 'presentation_rewrite', auditAction: 'PPT AI页面改写', maxTokens: 3500, parse: async result => ({ proposal: parsePresentationProposal(result.content, { title: body.title, templateId: body.templateId, aspectRatio: body.aspectRatio, language: body.language }) }) });
    }));

    router.post('/apps/presentations/ai/validate', authMiddleware, asyncHandler(async (req, res) => {
        const body = req.body || {};
        if (!body.presentation || typeof body.presentation !== 'object') return res.status(400).json({ error: '请提供待检查的演示文稿。', code: 'PRESENTATION_REQUIRED' });
        return runAiRequest(req, res, body, buildValidationMessages(body), { source: 'presentation_validate', auditAction: 'PPT AI内容检查', maxTokens: 3000, parse: async result => ({ validation: parseValidationProposal(result.content) }) });
    }));

    router.post('/apps/presentations/data-chart', authMiddleware, asyncHandler(async (req, res) => {
        const body = req.body || {};
        const datasetId = String(body.datasetId || '').trim();
        if (!datasetId) return res.status(400).json({ error: '请选择数据集。', code: 'PRESENTATION_DATASET_REQUIRED' });
        const result = await buildChart(req.user.id, datasetId, body);
        const chart = result.chart;
        const colors = Array.isArray(chart.echartsOption?.color) ? chart.echartsOption.color.slice(0, 12) : [];
        const columns = ['分类', ...(chart.series || []).map(item => String(item.name || '数值'))];
        const rows = (chart.labels || []).map((label, index) => [String(label), ...(chart.series || []).map(series => Number(series.data?.[index]) || 0)]);
        writeLog(req, '插入数据分析图表到PPT', `数据集: ${datasetId}，图表: ${chart.chartType}`);
        return res.json({
            chart: {
                type: 'chart', chartType: chart.chartType, title: chart.title,
                data: { columns, rows },
                options: { showLegend: (chart.series || []).length > 1, showLabels: false, colors },
                binding: { datasetId, queryDigest: `${chart.xAxis?.field || ''}:${chart.yAxis?.field || ''}:${chart.yAxis?.aggregation || ''}` },
                source: chart.source
            }
        });
    }));

    router.get('/apps/presentations/:id', authMiddleware, asyncHandler(async (req, res) => {
        const presentation = await getPresentation(req.user, req.params.id);
        if (!presentation) return res.status(404).json({ error: '演示文稿不存在或无权访问。' });
        return res.json({ presentation });
    }));
    router.patch('/apps/presentations/:id', authMiddleware, asyncHandler(async (req, res) => {
        const presentation = await updatePresentationMetadata(req.user, req.params.id, req.body || {});
        writeLog(req, '更新PPT演示文稿信息', `文稿: ${presentation.id}`);
        res.json({ success: true, presentation });
    }));
    router.put('/apps/presentations/:id/favorite', authMiddleware, asyncHandler(async (req, res) => {
        const result = await setPresentationFavorite(req.user, req.params.id, req.body?.favorite !== false);
        writeLog(req, result.favorite ? '收藏PPT演示文稿' : '取消收藏PPT演示文稿', '文稿: ' + req.params.id);
        res.json({ success: true, ...result });
    }));
    router.put('/apps/presentations/:id/content', authMiddleware, asyncHandler(async (req, res) => {
        const startedAt = Date.now();
        try {
            const presentation = await savePresentationContent(req.user, req.params.id, req.body || {});
            recordPresentationOutcome('save', { outcome: 'success', durationMs: Date.now() - startedAt });
            writeLog(req, '保存PPT演示文稿', `文稿: ${presentation.id}，版本: ${presentation.version}`);
            res.json({ success: true, presentation });
        } catch (error) { recordPresentationOutcome('save', { outcome: 'failed', durationMs: Date.now() - startedAt }); throw error; }
    }));
    router.delete('/apps/presentations/:id', authMiddleware, asyncHandler(async (req, res) => {
        const deleted = await deletePresentation(req.user, req.params.id);
        if (!deleted) return res.status(404).json({ error: '演示文稿不存在或无权访问。' });
        writeLog(req, '删除PPT演示文稿', `文稿: ${req.params.id}`);
        return res.json({ success: true });
    }));
    router.post('/apps/presentations/:id/remote-sessions', authMiddleware, asyncHandler(async (req, res) => {
        const session = await createPresentationRemoteSession(req.user, req.params.id, req.body || {});
        writeLog(req, '创建PPT远程演示会话', '文稿: ' + req.params.id + '，会话: ' + session.id);
        res.status(201).json({ success: true, session, displayUrl: '/presentation-display.html?token=' + encodeURIComponent(session.token) });
    }));
    router.put('/apps/presentations/remote-sessions/:sessionId/slide', authMiddleware, asyncHandler(async (req, res) => {
        const session = await setPresentationRemoteSlide(req.user, req.params.sessionId, req.body?.slideIndex);
        res.json({ success: true, session });
    }));
    router.delete('/apps/presentations/remote-sessions/:sessionId', authMiddleware, asyncHandler(async (req, res) => {
        const session = await closePresentationRemoteSession(req.user, req.params.sessionId);
        writeLog(req, '关闭PPT远程演示会话', '会话: ' + req.params.sessionId);
        res.json({ success: true, session });
    }));
    router.post('/apps/presentations/:id/duplicate', authMiddleware, asyncHandler(async (req, res) => {
        const presentation = await duplicatePresentation(req.user, req.params.id, req.body || {});
        writeLog(req, '复制PPT演示文稿', `源文稿: ${req.params.id}，新文稿: ${presentation.id}`);
        res.status(201).json({ success: true, presentation });
    }));
    router.get('/apps/presentations/:id/validation', authMiddleware, asyncHandler(async (req, res) => {
        const presentation = await getPresentation(req.user, req.params.id);
        if (!presentation) return res.status(404).json({ error: '演示文稿不存在或无权访问。' });
        res.json({ validation: runPresentationValidation(presentation.content) });
    }));
    router.get('/apps/presentations/:id/versions', authMiddleware, asyncHandler(async (req, res) => {
        const versions = await listPresentationVersions(req.user, req.params.id);
        if (!versions) return res.status(404).json({ error: '演示文稿不存在或无权访问。' });
        res.json({ versions });
    }));
    router.get('/apps/presentations/:id/versions/:version', authMiddleware, asyncHandler(async (req, res) => {
        const version = await getPresentationVersion(req.user, req.params.id, req.params.version);
        if (!version) return res.status(404).json({ error: '文稿版本不存在或无权访问。' });
        res.json({ version });
    }));
    router.post('/apps/presentations/:id/rollback', authMiddleware, asyncHandler(async (req, res) => {
        const presentation = await rollbackPresentation(req.user, req.params.id, req.body?.version, req.body?.note);
        writeLog(req, '恢复PPT演示文稿版本', `文稿: ${presentation.id}，版本: ${presentation.version}`);
        res.json({ success: true, presentation });
    }));
    router.post('/apps/presentations/:id/export', authMiddleware, asyncHandler(async (req, res) => {
        const startedAt = Date.now(); const format = req.body?.format || '';
        try {
            const result = await createPresentationExport(req.user, req.params.id, format, { slideIndex: req.body?.slideIndex, includeNotes: req.body?.includeNotes, includePageNumbers: req.body?.includePageNumbers, showSourceRefs: req.body?.showSourceRefs, imageQuality: req.body?.imageQuality, fontStrategy: req.body?.fontStrategy });
            recordPresentationOutcome('export', { outcome: 'success', durationMs: Date.now() - startedAt, format });
            writeLog(req, '导出PPT演示文稿', `文稿: ${req.params.id}，格式: ${format}，复用: ${result.reused ? '是' : '否'}`);
            res.status(result.reused ? 200 : 201).json({ success: true, rendition: result.rendition, reused: result.reused, validation: result.validation, durationMs: result.durationMs || 0 });
        } catch (error) { recordPresentationOutcome('export', { outcome: 'failed', durationMs: Date.now() - startedAt, format }); throw error; }
    }));
    router.get('/apps/presentations/:id/exports', authMiddleware, asyncHandler(async (req, res) => {
        const exports = await listPresentationExports(req.user, req.params.id);
        if (!exports) return res.status(404).json({ error: '演示文稿不存在或无权访问。' });
        res.json({ exports });
    }));
    router.get('/apps/presentations/:id/comments', authMiddleware, asyncHandler(async (req, res) => {
        const result = await listPresentationComments(req.user, req.params.id, {
            slideId: req.query?.slideId,
            status: req.query?.status
        });
        res.json(result);
    }));
    router.post('/apps/presentations/:id/comments', authMiddleware, asyncHandler(async (req, res) => {
        const comment = await createPresentationComment(req.user, req.params.id, req.body || {});
        writeLog(req, '发表PPT评论', `文稿: ${req.params.id}，页: ${comment.slideId || '全稿'}`);
        res.status(201).json({ success: true, comment });
    }));
    router.post('/apps/presentations/:id/comments/:commentId/resolve', authMiddleware, asyncHandler(async (req, res) => {
        const comment = await resolvePresentationComment(req.user, req.params.id, req.params.commentId);
        writeLog(req, '标记PPT评论状态', `文稿: ${req.params.id}，评论: ${req.params.commentId}，状态: ${comment.status}`);
        res.json({ success: true, comment });
    }));
    router.put('/apps/presentations/:id/comments/:commentId', authMiddleware, asyncHandler(async (req, res) => {
        const comment = await resolvePresentationComment(req.user, req.params.id, req.params.commentId);
        writeLog(req, '更新PPT评论状态', `文稿: ${req.params.id}，评论: ${req.params.commentId}，状态: ${comment.status}`);
        res.json({ success: true, comment });
    }));
    router.delete('/apps/presentations/:id/comments/:commentId', authMiddleware, asyncHandler(async (req, res) => {
        const result = await deletePresentationComment(req.user, req.params.id, req.params.commentId);
        writeLog(req, '删除PPT评论', `文稿: ${req.params.id}，评论: ${req.params.commentId}`);
        res.json(result);
    }));
    router.get('/apps/presentations/:id/presence', authMiddleware, asyncHandler(async (req, res) => {
        const activeCollaborators = listActivePresence(req.params.id);
        res.json({ activeCollaborators, presences: activeCollaborators });
    }));
    router.post('/apps/presentations/:id/presence', authMiddleware, asyncHandler(async (req, res) => {
        const activeCollaborators = recordPresence({
            presentationId: req.params.id,
            user: req.user,
            slideId: req.body?.slideId || req.body?.activeSlideId,
            selectedElementId: req.body?.selectedElementId,
            isEditing: req.body?.isEditing
        });
        res.json({ activeCollaborators, presences: activeCollaborators });
    }));
    router.delete('/apps/presentations/:id/presence', authMiddleware, asyncHandler(async (req, res) => {
        const activeCollaborators = leavePresence({
            presentationId: req.params.id,
            user: req.user
        });
        res.json({ activeCollaborators, presences: activeCollaborators });
    }));
    router.get('/apps/presentations/:id/collaborators', authMiddleware, asyncHandler(async (req, res) => {
        const result = await listPresentationCollaborators(req.user, req.params.id);
        res.json(result);
    }));
    router.post('/apps/presentations/:id/collaborators', authMiddleware, asyncHandler(async (req, res) => {
        const collaborator = await addPresentationCollaborator(req.user, req.params.id, req.body || {});
        writeLog(req, '添加PPT协作者', `文稿: ${req.params.id}，协作者: ${collaborator.username}，权限: ${collaborator.role}`);
        res.status(201).json({ success: true, collaborator });
    }));
    router.delete('/apps/presentations/:id/collaborators/:userId', authMiddleware, asyncHandler(async (req, res) => {
        const result = await removePresentationCollaborator(req.user, req.params.id, req.params.userId);
        writeLog(req, '移除PPT协作者', `文稿: ${req.params.id}，用户: ${req.params.userId}`);
        res.json(result);
    }));
    return router;
}

module.exports = { createPresentationsRouter };
