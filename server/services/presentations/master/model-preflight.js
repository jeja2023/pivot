'use strict';

const { createHash } = require('node:crypto');
const sharp = require('sharp');
const { error } = require('./runtime');
const { getRunnableModelForUserAsync, modelSupportsVision } = require('../../models');
const { callModelJson, recordAgentModelUsage, AGENT_MODEL_REQUEST_TIMEOUT_MS } = require('../../agent-model');
const { readTypedEnv } = require('../../../config/env-registry');
const { initialMessages, hostGuidance } = require('./host-protocol');
const { prepareRevisionSources } = require('./user-supplements');
const { runtimeTemplate } = require('../presentation-template-catalog');
const { ensureModelQuota } = require('../../model-daily-quota');
const { estimateMessagesTokens } = require('../../context-budget');
const { requestLimits } = require('./context');
const { parsedOutput } = require('./actions');

const successful = new Map();
const probing = new Map();
const TTL_MS = 90_000;

async function sendCompatibilityProbe(user, model, vision) {
    const marker = 'PPT_MASTER_PREFLIGHT_V1';
    const timeoutMs = Math.min(readTypedEnv('PIVOT_PPT_MASTER_MODEL_PREFLIGHT_TIMEOUT_MS'), AGENT_MODEL_REQUEST_TIMEOUT_MS);
    const signal = AbortSignal.timeout(timeoutMs);
    const prompt = `这是不含业务资料的 PPT 模型兼容性预检。只输出 JSON 对象，result 写 "${marker}"。`
        + (vision ? 'color 填图片主色，选项为红、绿、蓝。' : '');
    let content = prompt;
    if (vision) {
        const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#164bcc' } }).png().toBuffer();
        content = [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: 'data:image/png;base64,' + png.toString('base64') } }];
    }
    const messages = [{ role: 'system', content: '你是 JSON 兼容性诊断器。' }, { role: 'user', content }];
    const usageRef = {};
    let releaseQuotaReservation;
    let raw;
    try {
        try {
            releaseQuotaReservation = await ensureModelQuota(user, model, messages, 120, { signal, inputEstimate: estimateMessagesTokens(messages) });
            raw = await callModelJson(model, messages, { user, signal, maxTokens: 120, timeoutMs, firstResponseTimeoutMs: timeoutMs, enableThinking: false,
                temperature: 0, usageRef, quotaManaged: true, responseFormat: { type: 'json_object' } });
        } catch (cause) {
            if (signal.aborted || ['ECONNABORTED', 'ETIMEDOUT', 'AGENT_MODEL_FIRST_RESPONSE_TIMEOUT'].includes(cause?.code) || cause?.response?.status === 504) {
                throw error(`模型预检等待超时（本次上限 ${Math.ceil(timeoutMs / 1000)} 秒）。请检查排队和模型响应时间后重试。`,
                    'PPT_MASTER_MODEL_PREFLIGHT_TIMEOUT', 504);
            }
            if (['AI_ENDPOINT_CIRCUIT_OPEN', 'AI_QUEUE_TIMEOUT', 'AI_QUEUE_FULL', 'INSUFFICIENT_QUOTA'].includes(cause?.code)) throw cause;
            throw error('模型端点未通过 JSON 或图片兼容性预检，请核对服务状态、接口协议与模型能力。', 'PPT_MASTER_MODEL_PREFLIGHT_FAILED', 422);
        }
        await recordAgentModelUsage(user, model, messages, raw, 'ppt_master_preflight', '', { usageRef });
    } finally { releaseQuotaReservation?.(); }
    let parsed;
    try { parsed = parsedOutput(raw); } catch (_) {}
    const color = typeof parsed?.color === 'string' ? parsed.color.normalize('NFKC').trim().toLowerCase() : '';
    if (usageRef.truncated || parsed?.result !== marker || (vision && !['蓝', '蓝色', '藍', '藍色', 'blue'].includes(color))) {
        throw error('模型未返回完整的预检 JSON，请选择能稳定输出 JSON 的模型。', 'PPT_MASTER_MODEL_PREFLIGHT_FAILED', 422);
    }
}

async function checkModel(user, request, { visionRequired = false, probeModel = sendCompatibilityProbe, loadModel = getRunnableModelForUserAsync } = {}) {
    const operation = request?.operation || 'generate', profile = request?.profile || 'default';
    const modelId = request?.modelId;
    const mode = operation === 'generate' && ['default', 'quick', 'beautify', 'image_to_pptx'].includes(profile)
        ? profile : (['create_template', 'edit_native'].includes(operation) && profile === 'default' ? operation : '');
    if (!mode || typeof modelId !== 'string' || !modelId.trim() || modelId.length > 160) throw error('请选择有效的制作方式与模型。');
    const model = await loadModel(modelId, user);
    if (!model || model.secret_error) throw error('所选制作模型不可用，请检查当前账号授权与模型配置。', 'PPT_MASTER_MODEL_UNAVAILABLE', 403);
    const vision = visionRequired || profile === 'image_to_pptx';
    if (vision && !modelSupportsVision(model)) throw error('当前任务包含需要读取的图片，请选择支持图片输入的模型。', 'PPT_MASTER_VISION_REQUIRED', 422);
    const limits = requestLimits(model);
    if (limits.outputLimit < 2000) throw error('模型单轮输出上限至少为2000令牌，请检查所选模型。', 'PPT_MASTER_MODEL_OUTPUT_LIMIT', 422);
    // 运行包指引可分页加载，准入只计算制作请求中不可省略的内容。
    const messages = initialMessages(request);
    messages[0].content += '\n' + hostGuidance({ request: { ...request, draftFirst: operation !== 'create_template' } });
    prepareRevisionSources({ messages, previousPlan: request.previousPlan, userSupplements: request.inheritedSupplements,
        inheritedSupplementCount: request.inheritedSupplements?.length });
    let minimumInput = estimateMessagesTokens(messages);
    if (request.template?.type === 'runtime') {
        const selected = runtimeTemplate(request.template.id);
        if (!selected) throw error('所选模板不属于当前运行包，请刷新模板库。');
        const pageCount = request.pageCount ?? 8;
        if (!Number.isInteger(pageCount) || pageCount < 1 || pageCount > 40) throw error('模板制作请指定一至四十页。');
        minimumInput += selected.specInputTokens;
    }
    if (!limits.unbounded && limits.inputBudget < minimumInput) {
        throw error(`当前制作要求和必要资料预计需要 ${minimumInput} 令牌输入空间，模型可用 ${limits.inputBudget}。请调整模型窗口或制作要求。`, 'PPT_MASTER_CONTEXT_LIMIT', 422);
    }
    const key = createHash('sha256').update(JSON.stringify([user.id, model.id, model.model_name, model.url, model.api_key, model.supports_vision,
        limits.contextWindow, limits.configuredInputLimit, limits.outputLimit, vision])).digest('hex');
    if (probeModel !== sendCompatibilityProbe) await probeModel(user, model, vision);
    else if ((successful.get(key) || 0) <= Date.now()) {
        if (!probing.has(key)) probing.set(key, sendCompatibilityProbe(user, model, vision).then(() => {
            if (successful.size >= 128) successful.delete(successful.keys().next().value);
            successful.set(key, Date.now() + TTL_MS);
        }).finally(() => probing.delete(key)));
        await probing.get(key);
    }
    return { contextWindow: limits.contextWindow, inputBudget: limits.inputBudget, outputLimit: limits.outputLimit, vision };
}

module.exports = { checkModel };
