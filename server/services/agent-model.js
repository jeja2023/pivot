const { queryOne, execute } = require('../db/client');
const { getBeijingTimestamp } = require('../time');
const { recordModelTokenUsage, buildThinkingControlPayload, isChatThinkingEnabled } = require('./models');
const { normalizeTaskBudget } = require('./agent-budget');
const {
    buildChatCompletionsUrl,
    buildModelHeaders
} = require('./model-adapter');
const { aiSemaphore } = require('./concurrency');
const {
    acquireModelSlot,
    recordModelFailure,
    recordModelSuccess
} = require('./model-runtime');
const { createProviderEventStateMachine, createSseEventParser } = require('../streaming');
const { createToolCallAccumulator, buildOpenAiToolsPayload } = require('./streaming-tools');
const { forwardChatCompletion } = require('./model-forwarder');
const { assertProviderSafe, toProviderInput } = require('./agent-provider-envelope');
const { recordAgentRunResourceUsage } = require('./agent-run-resources');
const { estimateProviderUsage, recordProviderUsageCalibration } = require('./provider-usage-calibration');

// Agent 调用的输出上限：优先调用方显式值，其次模型配置的 max_tokens，最后回退 1200。
// 与 chat/openai/apps 一致地尊重模型配置，避免推理型模型（如 Qwen3）被 1200 写死后思考耗尽、正文为空。
const AGENT_DEFAULT_MAX_TOKENS = 1200;
// 显式保留思维链时，思考本身就要吃掉上千 tokens，输出预算必须同步抬高，
// 否则正式结果会被挤没——这正是"思考耗尽、正文为空"的成因。
const AGENT_THINKING_MIN_MAX_TOKENS = Math.max(2048, Math.min(16384, Number.parseInt(process.env.AGENT_THINKING_MIN_MAX_TOKENS || '4096', 10) || 4096));
// 面向用户的完整回复与"规划一步"的输出量级完全不同：1200 兜底会把综合多步观察的
// 答案直接截断。规划调用同样需要这个下限——模型经常在第一步就用
// {"action":"final","answer":"…"} 内联完整答案，那段 answer 同样受本次调用的预算限制。
const AGENT_ANSWER_MIN_MAX_TOKENS = Math.max(1024, Math.min(32768, Number.parseInt(process.env.AGENT_ANSWER_MIN_MAX_TOKENS || '4096', 10) || 4096));
// 单次模型调用不能再固定为 180 秒：运行总时限另有控制，慢模型应在剩余预算内完成。
const AGENT_MODEL_REQUEST_TIMEOUT_MS = Math.max(
    30_000,
    Math.min(Number.parseInt(process.env.AGENT_MODEL_REQUEST_TIMEOUT_MS || '600000', 10) || 600000, 60 * 60 * 1000)
);
// 等待上游真正开始响应与已建立流后的无进展时间分别约束。它们不会限制持续输出的长任务。
const AGENT_MODEL_FIRST_RESPONSE_TIMEOUT_MS = Math.max(
    30_000,
    Math.min(Number.parseInt(process.env.AGENT_MODEL_FIRST_RESPONSE_TIMEOUT_MS || '300000', 10) || 300000, AGENT_MODEL_REQUEST_TIMEOUT_MS)
);
const AGENT_MODEL_STREAM_IDLE_TIMEOUT_MS = Math.max(
    10_000,
    Math.min(Number.parseInt(process.env.AGENT_MODEL_STREAM_IDLE_TIMEOUT_MS || '120000', 10) || 120000, AGENT_MODEL_REQUEST_TIMEOUT_MS)
);
// 工具规划需要稳定的 JSON 与低延迟；默认不把思维链预算消耗在选择工具这一步。
// 最终总结仍沿用用户为模型配置的思考策略。
const AGENT_TOOL_PLANNING_THINKING = ['1', 'true', 'on', 'enabled'].includes(String(process.env.AGENT_TOOL_PLANNING_THINKING || 'false').trim().toLowerCase());

/**
 * 判断本次 Agent 调用是否保留思维链。
 *
 * Agent 靠多步规划实现推理，单次调用内的思维链会污染结构化输出并挤占有限的输出预算，
 * 因此默认关闭。需要思维链时有两条途径：
 *   1) 管理员给这次运行指定一个开启了「聊天中开启思考」的模型条目（无需改代码）；
 *   2) 调用方显式传 enableThinking，用于按步骤精确控制——例如工具参数生成必须严格 JSON
 *      时传 false 强制关闭，即便模型条目开着思考。
 */
function agentThinkingKept(modelCfg, options = {}) {
    if (typeof options.enableThinking === 'boolean') return options.enableThinking;
    return isChatThinkingEnabled(modelCfg);
}

function resolveAgentPlanningThinking(modelCfg, options = {}) {
    if (typeof options.enableThinking === 'boolean') return options.enableThinking;
    return AGENT_TOOL_PLANNING_THINKING && agentThinkingKept(modelCfg);
}

function resolveAgentMaxTokens(modelCfg, options = {}) {
    if (typeof options.maxTokens === 'number') return options.maxTokens;
    const configured = Number(modelCfg?.max_tokens);
    const base = Number.isFinite(configured) && configured > 0 ? configured : AGENT_DEFAULT_MAX_TOKENS;
    // 各场景各有自己的输出下限（面向用户的完整回复、保留思维链），取最大者；
    // 模型自身配置更高时不被压低。
    const floors = [Number.parseInt(options.minMaxTokens, 10) || 0];
    if (agentThinkingKept(modelCfg, options)) floors.push(AGENT_THINKING_MIN_MAX_TOKENS);
    return Math.max(base, ...floors);
}

function resolveAgentRequestTimeoutMs(options = {}) {
    const requested = Number.parseInt(options.timeoutMs, 10);
    const source = Number.isFinite(requested) && requested > 0 ? requested : AGENT_MODEL_REQUEST_TIMEOUT_MS;
    return Math.max(1_000, Math.min(source, 60 * 60 * 1000));
}

function resolveAgentFirstResponseTimeoutMs(options = {}) {
    const requested = Number.parseInt(options.firstResponseTimeoutMs, 10);
    const source = Number.isFinite(requested) && requested > 0 ? requested : AGENT_MODEL_FIRST_RESPONSE_TIMEOUT_MS;
    return Math.max(1_000, Math.min(source, resolveAgentRequestTimeoutMs(options)));
}

function resolveAgentStreamIdleTimeoutMs(options = {}) {
    const requested = Number.parseInt(options.streamIdleTimeoutMs, 10);
    const source = Number.isFinite(requested) && requested > 0 ? requested : AGENT_MODEL_STREAM_IDLE_TIMEOUT_MS;
    return Math.max(1_000, Math.min(source, resolveAgentRequestTimeoutMs(options)));
}

async function forwardStreamingWithFirstResponseDeadline(request, options = {}) {
    const timeoutMs = resolveAgentFirstResponseTimeoutMs(options);
    const controller = new AbortController();
    const sourceSignal = options.signal || null;
    const abortFromSource = () => controller.abort(sourceSignal?.reason);
    if (sourceSignal?.aborted) abortFromSource();
    else sourceSignal?.addEventListener?.('abort', abortFromSource, { once: true });

    let timer = null;
    const cleanup = () => {
        if (timer) clearTimeout(timer);
        sourceSignal?.removeEventListener?.('abort', abortFromSource);
    };
    try {
        const response = await Promise.race([
            forwardChatCompletion({ ...request, stream: true, timeout: 0, signal: controller.signal }),
            new Promise((_, reject) => {
                timer = setTimeout(() => {
                    const error = new Error(`模型在 ${Math.ceil(timeoutMs / 1000)} 秒内未开始响应。`);
                    error.code = 'AGENT_MODEL_FIRST_RESPONSE_TIMEOUT';
                    controller.abort(error);
                    reject(error);
                }, timeoutMs);
            })
        ]);
        if (timer) clearTimeout(timer);
        // 必须持续保留 sourceSignal -> controller 的桥接直到 SSE 结束；
        // 否则首响应之后的用户取消无法中止已经建立的流。
        return { response, cleanup };
    } catch (error) {
        cleanup();
        throw error;
    }
}

function applyAgentThinkingControls(data, modelCfg, options = {}) {
    if (agentThinkingKept(modelCfg, options)) return data;
    return Object.assign(data, buildThinkingControlPayload(modelCfg));
}

async function withAgentModelConcurrency(modelCfg, operation) {
    let globalAcquired = false;
    let endpointRelease = null;
    const startedAt = Date.now();
    try {
        await aiSemaphore.acquire();
        globalAcquired = true;
        endpointRelease = await acquireModelSlot(modelCfg);
        const result = await operation();
        recordModelSuccess(modelCfg, Date.now() - startedAt);
        return result;
    } catch (err) {
        recordModelFailure(modelCfg, err);
        throw err;
    } finally {
        if (endpointRelease) endpointRelease();
        if (globalAcquired) aiSemaphore.release();
    }
}

async function callModelJson(modelCfg, messages, options = {}) {
    return withAgentModelConcurrency(modelCfg, async () => {
        const providerMessages = toProviderInput(messages);
        assertProviderSafe(providerMessages);
        const targetUrl = buildChatCompletionsUrl(modelCfg.url, { appendV1ForLocal: false });
        const temperature = typeof options.temperature === 'number' ? options.temperature : 0.2;
        const maxTokens = resolveAgentMaxTokens(modelCfg, options);
        const data = {
            model: modelCfg.model_name || modelCfg.name,
            messages: providerMessages,
            stream: false,
            temperature,
            max_tokens: maxTokens
        };
        if (options.responseFormat && typeof options.responseFormat === 'object') {
            data.response_format = options.responseFormat;
        }
        applyAgentThinkingControls(data, modelCfg, options);
        const response = await forwardChatCompletion({
            modelCfg,
            user: options.user || null,
            url: targetUrl,
            headers: buildModelHeaders(modelCfg, { acceptJson: true }),
            data,
            timeout: resolveAgentFirstResponseTimeoutMs(options),
            signal: options.signal || null
        });
        const usage = response.data?.usage || response.data?.response?.usage || null;
        const finishReason = String(response.data?.choices?.[0]?.finish_reason || '');
        if (options.usageRef && typeof options.usageRef === 'object') {
            options.usageRef.usage = usage;
            // 回传截断信号：finish_reason='length' 意味着输出预算耗尽、内容不完整。
            // 静默返回半截答案是最难排查的故障，调用方据此告警或改走更大预算重试。
            options.usageRef.finishReason = finishReason;
            options.usageRef.truncated = finishReason === 'length';
            options.usageRef.maxTokens = maxTokens;
        }
        if (usage && typeof options.onUsage === 'function') {
            try { options.onUsage(usage); } catch (_) {}
        }
        return response.data?.choices?.[0]?.message?.content || response.data?.output_text || '';
    });
}

async function callModelText(modelCfg, messages, options = {}) {
    return callModelJson(modelCfg, messages, options);
}

/**
 * 流式 function calling 调用：
 *   - 启用 OpenAI tools 协议（messages + tools 数组）
 *   - SSE 流式解析，工具调用增量进入累加器
 *   - 返回 { content, toolCalls, finishReason, usage } 结构
 *
 * 设计目标：
 *   - 不替换 callModelText / callModelJson，作为可选 API 暴露
 *   - 失败回退由调用方决定（agent-runtime 仍可走旧的回合制 JSON）
 *   - SSE 解析复用 server/streaming.js 的 createSseEventParser，避免重复实现
 */
async function callModelStreamingWithTools(modelCfg, messages, tools = [], options = {}) {
    return withAgentModelConcurrency(modelCfg, async () => {
        const timing = {
            requestedAt: Date.now(),
            firstByteAt: 0,
            firstFrameAt: 0,
            completedAt: 0,
            bytesReceived: 0
        };
        const snapshotTiming = () => ({
            requestedAt: timing.requestedAt,
            firstByteAt: timing.firstByteAt || null,
            firstFrameAt: timing.firstFrameAt || null,
            completedAt: timing.completedAt || null,
            bytesReceived: timing.bytesReceived,
            timeToFirstByteMs: timing.firstByteAt ? Math.max(timing.firstByteAt - timing.requestedAt, 0) : null,
            timeToFirstFrameMs: timing.firstFrameAt ? Math.max(timing.firstFrameAt - timing.requestedAt, 0) : null,
            durationMs: Math.max((timing.completedAt || Date.now()) - timing.requestedAt, 0)
        });
        const publishProgress = phase => {
            try { options.onProgress?.({ phase, timing: snapshotTiming() }); } catch (_) {}
        };
        try {
        const providerMessages = toProviderInput(messages);
        assertProviderSafe(providerMessages);
        const accumulator = createToolCallAccumulator();
        const providerState = createProviderEventStateMachine({ onEvent: options.onProviderEvent });
        const payload = {
            model: modelCfg.model_name || modelCfg.name,
            messages: providerMessages,
            stream: true,
            temperature: typeof options.temperature === 'number' ? options.temperature : 0.2,
            max_tokens: resolveAgentMaxTokens(modelCfg, options)
        };
        const toolsPayload = buildOpenAiToolsPayload(tools);
        if (toolsPayload.length > 0) {
            payload.tools = toolsPayload;
            if (options.toolChoice) payload.tool_choice = options.toolChoice;
        }
        applyAgentThinkingControls(payload, modelCfg, options);
        const sseParser = createSseEventParser({
            onData(payload) {
                if (!payload) return;
                let frame = null;
                try {
                    frame = JSON.parse(payload);
                } catch (e) {
                    return; // 非 JSON 帧忽略，避免被注释/心跳行污染
                }
                if (frame && typeof frame === 'object') {
                    if (!timing.firstFrameAt) {
                        timing.firstFrameAt = Date.now();
                        publishProgress('first_frame');
                    }
                    accumulator.ingest(frame);
                }
                if (frame && typeof frame === 'object') providerState.ingest(frame);
                if (typeof options.onDelta === 'function') {
                    try {
                        options.onDelta(accumulator.snapshot());
                    } catch (cbErr) {
                        // 回调失败不影响主流程
                    }
                }
            }
        });
        const targetUrl = buildChatCompletionsUrl(modelCfg.url, { appendV1ForLocal: false });
        const { response, cleanup: cleanupStreamingRequest } = await forwardStreamingWithFirstResponseDeadline({
            modelCfg,
            user: options.user || null,
            url: targetUrl,
            headers: { ...buildModelHeaders(modelCfg, { acceptJson: false }), Accept: 'text/event-stream' },
            data: payload,
        }, options);
        try {
        await new Promise((resolve, reject) => {
            let settled = false;
            const idleTimeoutMs = resolveAgentStreamIdleTimeoutMs(options);
            let idleTimer = null;
            const finish = (callback, value) => {
                if (settled) return;
                settled = true;
                if (idleTimer) clearTimeout(idleTimer);
                callback(value);
            };
            const armIdleTimer = () => {
                if (idleTimer) clearTimeout(idleTimer);
                idleTimer = setTimeout(() => {
                    const error = new Error(`模型流在 ${Math.ceil(idleTimeoutMs / 1000)} 秒内没有收到新数据。`);
                    error.code = 'AGENT_MODEL_STREAM_IDLE';
                    // 必须先固定领域错误；destroy() 可能同步触发底层 "aborted"
                    // 事件，若顺序相反会掩盖超时诊断码并让恢复策略误判。
                    finish(reject, error);
                    try { response.data.destroy(error); } catch (_) {}
                }, idleTimeoutMs);
                idleTimer.unref?.();
            };
            armIdleTimer();
            response.data.on('data', chunk => {
                try {
                    if (!timing.firstByteAt) {
                        timing.firstByteAt = Date.now();
                        publishProgress('first_byte');
                    }
                    timing.bytesReceived += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk || ''), 'utf8');
                    armIdleTimer();
                    sseParser.write(chunk);
                } catch (parseErr) {
                    finish(reject, parseErr);
                }
            });
            response.data.on('end', () => {
                try { sseParser.end(); } catch (e) {}
                finish(resolve);
            });
            response.data.on('error', error => finish(reject, error));
        });
        } finally {
            cleanupStreamingRequest();
        }
        const result = accumulator.finalize();
        const provider = providerState.finalize();
        timing.completedAt = Date.now();
        if (provider.usage && typeof options.onUsage === 'function') {
            try { options.onUsage(provider.usage.raw || provider.usage); } catch (_) {}
        }
        return { ...result, provider, timing: snapshotTiming() };
        } catch (error) {
            if (error?.code === 'ECONNABORTED' && !timing.firstByteAt) {
                error.code = 'AGENT_MODEL_FIRST_RESPONSE_TIMEOUT';
                error.message = `模型在 ${Math.ceil(resolveAgentFirstResponseTimeoutMs(options) / 1000)} 秒内未开始响应。`;
            }
            if (error && typeof error === 'object') error.agentModelTiming = snapshotTiming();
            throw error;
        }
    });
}

async function recordAgentModelUsage(user, modelCfg, messages, output, source = 'agent', runId = '', options = {}) {
    const usage = options.usage || options.usageRef?.usage || null;
    const usageInput = Number(usage?.input_tokens ?? usage?.prompt_tokens ?? usage?.inputTokens ?? 0) || 0;
    const usageOutput = Number(usage?.output_tokens ?? usage?.completion_tokens ?? usage?.outputTokens ?? 0) || 0;
    const estimated = estimateProviderUsage(messages, output);
    const inputTokens = usageInput > 0 ? usageInput : estimated.inputTokens;
    const outputTokens = usageOutput > 0 ? usageOutput : estimated.outputTokens;
    recordModelTokenUsage(user.id, modelCfg.id, inputTokens + outputTokens, source, inputTokens, outputTokens);
    let calibration = null;
    if (usage) {
        try {
            calibration = await recordProviderUsageCalibration({
                modelId: modelCfg.id,
                protocol: usage.protocol || 'unknown',
                source,
                messages,
                output,
                estimated,
                usage
            });
        } catch (_) {
            // Calibration is an audit metric and must not fail an otherwise valid model response.
        }
    }
    if (runId) {
        await execute(`
            UPDATE agent_runs
            SET input_tokens = COALESCE(input_tokens, 0) + ?,
                output_tokens = COALESCE(output_tokens, 0) + ?,
                total_tokens = COALESCE(total_tokens, 0) + ?,
                last_heartbeat_at = ?,
                updated_at = ?
            WHERE id = ?
        `, [inputTokens, outputTokens, inputTokens + outputTokens, getBeijingTimestamp(), getBeijingTimestamp(), runId]);
        await recordAgentRunResourceUsage(runId, inputTokens + outputTokens);
        const run = await queryOne('SELECT max_token_budget, total_tokens, budget_config FROM agent_runs WHERE id = ?', [runId]);
        let budgetExceeded = false;
        if (run && Number(run.max_token_budget || 0) > 0 && Number(run.total_tokens || 0) > Number(run.max_token_budget || 0)) {
            budgetExceeded = true;
            const err = new Error(`智能体任务已超过模型用量上限 ${run.max_token_budget}`);
            err.code = 'AGENT_BUDGET_EXCEEDED';
            if (!options.allowBudgetExceeded) throw err;
        }
        let budgetConfig = {};
        try { budgetConfig = typeof run?.budget_config === 'string' ? JSON.parse(run.budget_config || '{}') : (run?.budget_config || {}); } catch (_) {}
        const budget = normalizeTaskBudget(budgetConfig);
        if (Number.isFinite(budget.max_tokens_total) && Number(budget.max_tokens_total) >= 0 && Number(run?.total_tokens || 0) > budget.max_tokens_total) {
            budgetExceeded = true;
            const err = new Error(`智能体任务已超过总 Token 预算 ${budget.max_tokens_total}`);
            err.code = 'AGENT_BUDGET_EXCEEDED';
            err.category = 'resource';
            if (!options.allowBudgetExceeded) throw err;
        }
        if (options.budget?.recordTokens) {
            try {
                options.budget.recordTokens(inputTokens + outputTokens);
            } catch (error) {
                if (!options.allowBudgetExceeded || error?.code !== 'AGENT_BUDGET_EXCEEDED') throw error;
                budgetExceeded = true;
            }
        }
        if (budgetExceeded) return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, calibration, budgetExceeded: true };
    }
    return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, calibration };
}

module.exports = {
    callModelJson,
    callModelText,
    callModelStreamingWithTools,
    recordAgentModelUsage,
    withAgentModelConcurrency,
    resolveAgentMaxTokens,
    resolveAgentRequestTimeoutMs,
    resolveAgentFirstResponseTimeoutMs,
    resolveAgentStreamIdleTimeoutMs,
    applyAgentThinkingControls,
    agentThinkingKept,
    resolveAgentPlanningThinking,
    AGENT_ANSWER_MIN_MAX_TOKENS,
    AGENT_MODEL_REQUEST_TIMEOUT_MS,
    AGENT_MODEL_FIRST_RESPONSE_TIMEOUT_MS,
    AGENT_MODEL_STREAM_IDLE_TIMEOUT_MS,
    AGENT_TOOL_PLANNING_THINKING
};
