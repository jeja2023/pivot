'use strict';

const express = require('express');
const fs = require('fs/promises');
const { asyncHandler, normalizeLimit } = require('../../http');
const { extractDocumentText, truncateExtractedText } = require('../../document-text');
const { callModelTextWithBudget } = require('../../services/model-text-call');
const { getModelDailyUsageAsync } = require('../../services/models');
const {
    createPresentation,
    createPresentationExport,
    createPresentationTemplate,
    deletePresentation,
    duplicatePresentation,
    exportPresentationTemplate,
    getPresentation,
    getPresentationAsset,
    getPresentationAssetByRef,
    getPresentationVersion,
    listPresentationExports,
    listPresentationTemplates,
    listPresentationVersions,
    listPresentations,
    importPresentationTemplate,
    rollbackPresentation,
    savePresentationContent,
    updatePresentationMetadata,
    updatePresentationTemplate,
    uploadPresentationAsset
} = require('../../services/presentations/presentation-service');
const { runPresentationValidation } = require('../../services/presentations/presentation-validation');
const { buildOutlineMessages, buildSlidesMessages, parsePresentationProposal } = require('../../services/presentations/presentation-ai');
const { resolveAppsModel, buildModelSecretErrorPayload } = require('./helpers');
const { buildChart } = require('../../services/data-analysis');
const { normalizePresentation } = require('../../services/presentations/presentation-schema');

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

async function callPresentationAi({ req, logAction, messages, source, auditAction, maxTokens }) {
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
    const result = await callModelTextWithBudget({ modelCfg, user: req.user, messages, source, maxTokens, maxOutputTokensCap: maxTokens, temperature: 0.25, timeout: 180000 });
    return { ...result, model: modelCfg.model_name };
}

function createPresentationsRouter({ authMiddleware, logAction, uploadLimiter, upload } = {}) {
    const router = express.Router();
    const writeLog = typeof logAction === 'function' ? logAction : () => {};

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
    router.post('/apps/presentations/templates/import', authMiddleware, uploadLimiter, upload.single('file'), asyncHandler(async (req, res) => {
        try {
            if (!req.file?.path) return res.status(400).json({ error: '请选择模板包文件。' });
            const template = await importPresentationTemplate(req.user, await fs.readFile(req.file.path), { scope: req.body?.scope, publish: req.body?.publish !== 'false' });
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
        res.json({ presentations: await listPresentations(req.user, { limit: normalizeLimit(req.query.limit, 50, 100) }) });
    }));
    router.post('/apps/presentations', authMiddleware, asyncHandler(async (req, res) => {
        const presentation = await createPresentation(req.user, req.body || {});
        writeLog(req, '创建PPT演示文稿', `文稿: ${presentation.id}`);
        res.status(201).json({ success: true, presentation });
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

    router.post('/apps/presentations/assets', authMiddleware, uploadLimiter, upload.single('file'), asyncHandler(async (req, res) => {
        try {
            if (!req.file?.path) return res.status(400).json({ error: '请选择图片素材。' });
            const buffer = await fs.readFile(req.file.path);
            const asset = await uploadPresentationAsset(req.user, { ...req.file, buffer });
            writeLog(req, '上传PPT素材', `素材: ${asset.id}，文件: ${asset.filename}`);
            return res.status(201).json({ success: true, asset });
        } finally {
            await removeUpload(req.file);
        }
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
        const result = await getPresentationAssetByRef(req.user, req.query.ref);
        if (!result) return res.status(404).json({ error: '素材不存在或无权访问。' });
        res.setHeader('Content-Type', result.asset.mimeType);
        res.setHeader('Content-Disposition', contentDisposition(result.asset.filename));
        res.setHeader('Cache-Control', 'private, max-age=300');
        return res.send(result.buffer);
    }));

    router.post('/apps/presentations/ai/outline', authMiddleware, asyncHandler(async (req, res) => {
        const body = { ...(req.body || {}), materials: normalizeMaterials(req.body) };
        if (!String(body.topic || '').trim()) return res.status(400).json({ error: '请输入演示主题。', code: 'PRESENTATION_TOPIC_REQUIRED' });
        const result = await callPresentationAi({ req, logAction: writeLog, messages: buildOutlineMessages(body), source: 'presentation_outline', auditAction: 'PPT AI生成大纲', maxTokens: 2600 });
        let outline;
        try { outline = parsePresentationProposal(result.content, { title: body.topic, templateId: body.templateId, aspectRatio: body.aspectRatio }); }
        catch (error) { return res.status(error.status || 422).json({ error: error.message, code: error.code || 'PRESENTATION_AI_JSON_INVALID' }); }
        return res.json({ outline, model: result.model, usage: result.usage, contextBudget: result.contextBudget });
    }));
    router.post('/apps/presentations/ai/slides', authMiddleware, asyncHandler(async (req, res) => {
        const body = { ...(req.body || {}), materials: normalizeMaterials(req.body) };
        if (!body.outline || typeof body.outline !== 'object') return res.status(400).json({ error: '请先提供已确认的大纲。', code: 'PRESENTATION_OUTLINE_REQUIRED' });
        const result = await callPresentationAi({ req, logAction: writeLog, messages: buildSlidesMessages(body), source: 'presentation_slides', auditAction: 'PPT AI生成页面', maxTokens: 6000 });
        let proposal;
        try {
            proposal = parsePresentationProposal(result.content, { title: body.title || body.outline.title, templateId: body.templateId, aspectRatio: body.aspectRatio });
            if (proposal.presentation) {
                const sourceIds = new Set(body.materials.map((item, index) => item.id || `source_${index + 1}`));
                proposal.presentation.slides.forEach(slide => {
                    slide.sourceRefs = (slide.sourceRefs || []).filter(ref => sourceIds.has(ref));
                    (slide.elements || []).forEach(element => {
                        element.sourceRefs = (element.sourceRefs || []).filter(ref => sourceIds.has(ref));
                    });
                });
                proposal.presentation = normalizePresentation({
                    ...proposal.presentation,
                    sources: body.materials.map((item, index) => ({ id: item.id || `source_${index + 1}`, title: item.title || '材料', type: 'material', locator: '', digest: '' }))
                });
            }
        }
        catch (error) { return res.status(error.status || 422).json({ error: error.message, code: error.code || 'PRESENTATION_AI_JSON_INVALID' }); }
        return res.json({ proposal, validation: runPresentationValidation(proposal.presentation), model: result.model, usage: result.usage, contextBudget: result.contextBudget });
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
    router.put('/apps/presentations/:id/content', authMiddleware, asyncHandler(async (req, res) => {
        const presentation = await savePresentationContent(req.user, req.params.id, req.body || {});
        writeLog(req, '保存PPT演示文稿', `文稿: ${presentation.id}，版本: ${presentation.version}`);
        res.json({ success: true, presentation });
    }));
    router.delete('/apps/presentations/:id', authMiddleware, asyncHandler(async (req, res) => {
        const deleted = await deletePresentation(req.user, req.params.id);
        if (!deleted) return res.status(404).json({ error: '演示文稿不存在或无权访问。' });
        writeLog(req, '删除PPT演示文稿', `文稿: ${req.params.id}`);
        return res.json({ success: true });
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
        const result = await createPresentationExport(req.user, req.params.id, req.body?.format, { slideIndex: req.body?.slideIndex });
        writeLog(req, '导出PPT演示文稿', `文稿: ${req.params.id}，格式: ${req.body?.format}，复用: ${result.reused ? '是' : '否'}`);
        res.status(result.reused ? 200 : 201).json({ success: true, rendition: result.rendition, reused: result.reused, validation: result.validation, durationMs: result.durationMs || 0 });
    }));
    router.get('/apps/presentations/:id/exports', authMiddleware, asyncHandler(async (req, res) => {
        const exports = await listPresentationExports(req.user, req.params.id);
        if (!exports) return res.status(404).json({ error: '演示文稿不存在或无权访问。' });
        res.json({ exports });
    }));
    return router;
}

module.exports = { createPresentationsRouter };
