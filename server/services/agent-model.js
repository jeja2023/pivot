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
            timeout: 180000,
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
                if (frame && typeof frame === 'object') accumulator.ingest(frame);
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
        const response = await forwardChatCompletion({
            modelCfg,
            user: options.user || null,
            url: targetUrl,
            headers: { ...buildModelHeaders(modelCfg, { acceptJson: false }), Accept: 'text/event-stream' },
            data: payload,
            stream: true,
            timeout: 180000,
            signal: options.signal || null
        });
        await new Promise((resolve, reject) => {
            response.data.on('data', chunk => {
                try {
                    sseParser.write(chunk);
                } catch (parseErr) {
                    reject(parseErr);
                }
            });
            response.data.on('end', () => {
                try { sseParser.end(); } catch (e) {}
                resolve();
            });
            response.data.on('error', reject);
        });
        const result = accumulator.finalize();
        const provider = providerState.finalize();
        if (provider.usage && typeof options.onUsage === 'function') {
            try { options.onUsage(provider.usage.raw || provider.usage); } catch (_) {}
        }
        return { ...result, provider };
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
    applyAgentThinkingControls,
    agentThinkingKept,
    AGENT_ANSWER_MIN_MAX_TOKENS
};
