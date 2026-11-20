'use strict';

const runtime = require('./runtime');
const { callModelJson, recordAgentModelUsage, AGENT_MODEL_FIRST_RESPONSE_TIMEOUT_MS } = require('../../agent-model');
const { normalizeChatError } = require('../../chat-errors');
const { estimateMessagesTokens } = require('../../context-budget');
const { estimateTokens } = require('../../../llm');
const { messagesForModel, markImagePageRead } = require('./model-input');
const { compactMessages, planRequest, requestLimits, usageRecord } = require('./context');
const { archiveOlderObservations } = require('./history');
const { phaseMessages } = require('./phase-context');
const { ensureModelQuota } = require('../../model-daily-quota');
const { READ_PAGE_CHARS, HISTORY_PAGE_CHARS } = require('./observations');

function hostGuidance(state) {
    const calibratedRoles = state.engine?.textCalibrationRoles === 1;
    const bundledIcons = Array.isArray(state.engine?.tools) && state.engine.tools.includes('icon_sync');
    return [
        'Pivot 宿主协议优先于上游本地命令。使用 inputs/ 中已预处理的材料，源 PPTX 按所选流程使用 import_native 或 project import-sources，无需运行 source_to_md.py。确认统一使用 requestInput，不启动 confirm_ui/server.py，也不创建或轮询该服务的 JSON 回执。跳过 svg_editor/server.py 实时预览和 workflow_log.py 手动日志，使用宿主制作进度及快照。',
        '模板按宿主确认和校验证据安装。使用 apply_template 的正常校验流程，不使用 --skip-validation。',
        calibratedRoles ? 'Default 用 text_measure 参数 ["calibrate", "项目目录", "--outline"]。Quick 无锁文件时，用 ["calibrate", "项目目录", "--role", "名称:字体:字号"]，可重复 --role，并按需用 --sample 提供短文本。'
            : '当前执行服务只允许 text_measure 的 ["calibrate", "项目目录", "--outline"]。无锁文件的 Quick 无法使用该入口，按已选字体和版式保守布局，继续执行适用的 SVG 质量检查。',
        bundledIcons ? '仅当设计选用运行包 SVG 图标时，用已登记的 icon_sync，参数为项目目录及明确的 library/name。'
            : '当前执行服务未登记 icon_sync。使用已提供或已安装的合法素材、原生图形或适用的 emoji。',
        `按当前阶段批量读取明确所需的参考。read/read_runtime 单页至多 ${READ_PAGE_CHARS} 字符，read_history 至多 ${HISTORY_PAGE_CHARS} 字符，较小模型窗口或多项同批读取可能进一步缩小页长。按 nextOffset 继续；正文已归档且仍需要时，可按归档坐标回读。已有可见正文或有效回执时直接推进当前阶段。`
    ].join('\n');
}

function modelFailure(error, timeoutMs) {
    const status = Number(error.response?.status || error.statusCode || error.status);
    const diagnosis = normalizeChatError({ error: error.message, detail: error.response?.data, statusCode: status,
        code: error.code === 'CONTEXT_LENGTH_EXCEEDED' ? error.code : undefined });
    if (diagnosis.code === 'CONTEXT_LENGTH_EXCEEDED') return runtime.error('模型服务拒绝了本轮上下文。请核对模型实际窗口和输入上限，或切换模型后从检查点继续。', 'PPT_MASTER_UPSTREAM_CONTEXT_LIMIT', 422);
    if (['AI_QUEUE_FULL', 'AI_QUEUE_TIMEOUT', 'AI_ENDPOINT_CIRCUIT_OPEN'].includes(error.code)) return error;
    if (!error.response && error.code === 'INSUFFICIENT_QUOTA') return runtime.error(error.message, 'PPT_MASTER_QUOTA_EXCEEDED', 429);
    if (status === 402 || diagnosis.code === 'INSUFFICIENT_QUOTA') return runtime.error('模型服务额度不足，请核对供应商用量和余额后从检查点继续。', 'PPT_MASTER_MODEL_PROVIDER_QUOTA', 429);
    if (status === 429) return runtime.error('模型服务暂时限流，请稍后从检查点继续。', 'PPT_MASTER_MODEL_RATE_LIMIT', 429);
    if (status === 504) return runtime.error('上游模型网关返回 HTTP 504。检查点已保留，请检查模型服务或切换端点后继续。', 'PPT_MASTER_MODEL_TIMEOUT', 504);
    if (['ETIMEDOUT', 'ECONNABORTED', 'AGENT_MODEL_FIRST_RESPONSE_TIMEOUT'].includes(error.code)) {
        return runtime.error(`模型请求超时，本轮请求时限为 ${Math.ceil(timeoutMs / 1000)} 秒。检查点已保留，继续时会优先整理旧工具结果。`, 'PPT_MASTER_MODEL_TIMEOUT', 504);
    }
    if (status === 401 || status === 403) return runtime.error('模型服务拒绝授权，请在模型管理中核对密钥与权限后继续。', 'PPT_MASTER_MODEL_AUTH', status);
    if (status >= 500 || diagnosis.code === 'UPSTREAM_UNAVAILABLE' || ['ECONNRESET', 'EPIPE', 'EAI_AGAIN'].includes(error.code)) {
        return runtime.error('模型服务连接中断或暂不可用，请检查模型服务后从检查点继续。', 'PPT_MASTER_MODEL_CONNECTION', 502);
    }
    if (status >= 400) return runtime.error(`模型服务拒绝请求（HTTP ${status}），请核对模型配置后从检查点继续。`, 'PPT_MASTER_MODEL_REQUEST_REJECTED', 422);
    return error;
}

async function runModelTurn(user, id, state, model, hooks, deps, progressGuidance, citationIssues) {
    const limits = requestLimits(model);
    const makeView = async () => {
        const original = await (deps.messagesForModel || messagesForModel)(user, id, state, model);
        const compacted = compactMessages(original);
        const { messages } = phaseMessages(compacted.messages, state);
        if (messages[0]?.role === 'system' && typeof messages[0].content === 'string') {
            messages[0] = { ...messages[0], content: [messages[0].content, hostGuidance(state), progressGuidance].filter(Boolean).join('\n') };
        }
        if (citationIssues?.length) {
            messages.push({ role: 'user', content: JSON.stringify({ citationRepairEvidence: citationIssues }) });
        }
        return { original, messages, compactedWrites: compacted.compactedWrites, inputEstimate: estimateMessagesTokens(messages) };
    };
    const archive = async options => {
        try {
            if (!await archiveOlderObservations(state, options)) return false;
        } catch (error) {
            // 达到归档容量时仍可发送已符合单轮预算的请求。
            if (error.code === 'PPT_MASTER_HISTORY_LIMIT') return false;
            throw error;
        }
        await hooks.checkpoint(state, { phase: 'authoring', message: '已归档较早的工具结果，正在继续制作。' });
        return true;
    };
    let view = await makeView();
    const original = view.original;
    if (state.focusModelHistory) {
        if (await archive({ force: true, recentTurns: 1 })) view = await makeView();
    } else if (await archive({ force: view.inputEstimate > limits.archiveAt, preserveActive: true })) view = await makeView();
    if (view.inputEstimate > limits.fullOutputInputBudget && await archive({ force: true, recentTurns: 1 })) view = await makeView();

    const remainingTokens = state.request.tokenBudget === 0 ? Infinity : state.request.tokenBudget - state.usedTokens;
    const send = async () => {
        state.modelRequest = { contextWindow: limits.contextWindow, configuredInputLimit: limits.configuredInputLimit,
            inputEstimate: view.inputEstimate, timeoutSeconds: Math.ceil(AGENT_MODEL_FIRST_RESPONSE_TIMEOUT_MS / 1000) };
        const plan = planRequest(view.messages, original, model, remainingTokens, limits);
        state.modelRequest.outputLimit = plan.maxTokens;
        // 为后续模型请求的指引、确认答复和工具元数据留出容量。
        const readResultBudget = Math.max(1000, Math.floor((limits.fullOutputInputBudget - plan.breakdown.initial) / 2));
        await hooks.ensureCurrent();
        const usageRef = {};
        let output, releaseQuota = () => {};
        try {
            if (!deps.callModel) releaseQuota = await ensureModelQuota(user, model, view.messages, plan.maxTokens, { signal: hooks.signal, inputEstimate: plan.inputEstimate });
            output = await (deps.callModel || callModelJson)(model, view.messages, { user, signal: hooks.signal, maxTokens: plan.maxTokens,
                temperature: 0.2, usageRef, quotaManaged: true, enableThinking: false, budget: deps.budget, responseFormat: { type: 'json_object' } });
        } catch (error) {
            releaseQuota();
            hooks.signal?.throwIfAborted();
            const failure = modelFailure(error, AGENT_MODEL_FIRST_RESPONSE_TIMEOUT_MS);
            if (failure.code === 'PPT_MASTER_MODEL_TIMEOUT') state.focusModelHistory = true;
            throw failure;
        }
        delete state.focusModelHistory;
        markImagePageRead(state, view.messages);
        usageRecord(state, plan, usageRef, output, view.compactedWrites, estimateTokens);
        try {
            if (!deps.callModel) await recordAgentModelUsage(user, model, view.messages, output, 'ppt_master_engine', state.request.runId || '', {
                usageRef, budget: deps.budget, estimatedUsage: { inputTokens: plan.inputEstimate, outputTokens: estimateTokens(typeof output === 'string' ? output : JSON.stringify(output)) }
            });
        } finally { releaseQuota(); }
        return { output, usageRef, readResultBudget };
    };
    try {
        return await send();
    } catch (error) {
        if (error.code !== 'PPT_MASTER_UPSTREAM_CONTEXT_LIMIT' || !await archive({ force: true, recentTurns: 1 })) throw error;
        const reduced = await makeView();
        if (reduced.inputEstimate >= view.inputEstimate) throw error;
        view = reduced;
        return send();
    }
}

module.exports = { runModelTurn };
