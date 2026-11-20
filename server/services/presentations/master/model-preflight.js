'use strict';

const { createHash } = require('node:crypto');
const sharp = require('sharp');
const { error } = require('./runtime');
const { getRunnableModelForUserAsync, modelSupportsVision } = require('../../models');
const { callModelJson, recordAgentModelUsage } = require('../../agent-model');
const { ensureModelQuota } = require('../../model-daily-quota');
const { estimateMessagesTokens } = require('../../context-budget');
const { requestLimits } = require('./context');

const MODEL_HEADROOM = { default: 42000, quick: 38000, beautify: 30000, image_to_pptx: 30000, create_template: 35000, edit_native: 35000 };
const successful = new Map();
const probing = new Map();
const TTL_MS = 90_000;

async function sendCompatibilityProbe(user, model, vision) {
    const marker = 'PPT_MASTER_PREFLIGHT_V1';
    const signal = AbortSignal.timeout(20_000);
    const prompt = `这是不含业务资料的 PPT 模型兼容性预检。只输出 JSON 对象，result 写 "${marker}"。`
        + (vision ? 'color 填图片主色，选项为红、绿、蓝。' : '');
    let content = prompt;
    if (vision) {
        const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#164bcc' } }).png().toBuffer();
        content = [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: 'data:image/png;base64,' + png.toString('base64') } }];
    }
    const messages = [{ role: 'system', content: '你是 JSON 兼容性诊断器。' }, { role: 'user', content }];
    const usageRef = {};
    const releaseQuotaReservation = await ensureModelQuota(user, model, messages, 120, { signal, inputEstimate: estimateMessagesTokens(messages) });
    let raw;
    try {
        try {
            raw = await callModelJson(model, messages, { user, signal, maxTokens: 120, timeoutMs: 18000, enableThinking: false,
                temperature: 0, usageRef, quotaManaged: true, responseFormat: { type: 'json_object' } });
        } catch (cause) {
            if (cause?.code === 'AI_ENDPOINT_CIRCUIT_OPEN') throw cause;
            throw error('模型端点未通过 JSON 或图片兼容性预检，请核对服务状态、接口协议与模型能力。', 'PPT_MASTER_MODEL_PREFLIGHT_FAILED', 422);
        }
        await recordAgentModelUsage(user, model, messages, raw, 'ppt_master_preflight', '', { usageRef });
    } finally { releaseQuotaReservation(); }
    let parsed;
    try { parsed = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (_) {}
    if (usageRef.truncated || parsed?.result !== marker || (vision && parsed.color !== '蓝')) {
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
    if (!limits.unbounded && limits.inputBudget < MODEL_HEADROOM[mode]) {
        throw error(`当前模式预检需要约 ${MODEL_HEADROOM[mode]} 令牌输入空间，请检查模型上下文窗口与输入上限。`, 'PPT_MASTER_CONTEXT_LIMIT', 422);
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
