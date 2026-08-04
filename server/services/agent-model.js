const { db } = require('../db');
const { estimateTokens } = require('../llm');
const { getBeijingTimestamp } = require('../time');
const { recordModelTokenUsage } = require('./models');
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
const { createSseEventParser } = require('../streaming');
const { createToolCallAccumulator, buildOpenAiToolsPayload } = require('./streaming-tools');
const { forwardChatCompletion } = require('./model-forwarder');

// Agent 调用的输出上限：优先调用方显式值，其次模型配置的 max_tokens，最后回退 1200。
// 与 chat/openai/apps 一致地尊重模型配置，避免推理型模型（如 Qwen3）被 1200 写死后思考耗尽、正文为空。
const AGENT_DEFAULT_MAX_TOKENS = 1200;
function resolveAgentMaxTokens(modelCfg, options = {}) {
    if (typeof options.maxTokens === 'number') return options.maxTokens;
    const configured = Number(modelCfg?.max_tokens);
    return Number.isFinite(configured) && configured > 0 ? configured : AGENT_DEFAULT_MAX_TOKENS;
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
        const targetUrl = buildChatCompletionsUrl(modelCfg.url, { appendV1ForLocal: false });
        const temperature = typeof options.temperature === 'number' ? options.temperature : 0.2;
        const maxTokens = resolveAgentMaxTokens(modelCfg, options);
        const response = await forwardChatCompletion({
            modelCfg,
            user: options.user || null,
            url: targetUrl,
            headers: buildModelHeaders(modelCfg, { acceptJson: true }),
            data: {
                model: modelCfg.model_name || modelCfg.name,
                messages,
                stream: false,
                temperature,
                max_tokens: maxTokens
            },
            timeout: 180000
        });
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
        const accumulator = createToolCallAccumulator();
        const payload = {
            model: modelCfg.model_name || modelCfg.name,
            messages,
            stream: true,
            temperature: typeof options.temperature === 'number' ? options.temperature : 0.2,
            max_tokens: resolveAgentMaxTokens(modelCfg, options)
        };
        const toolsPayload = buildOpenAiToolsPayload(tools);
        if (toolsPayload.length > 0) {
            payload.tools = toolsPayload;
            if (options.toolChoice) payload.tool_choice = options.toolChoice;
        }
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
            timeout: 180000
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
        return accumulator.finalize();
    });
}

function recordAgentModelUsage(user, modelCfg, messages, output, source = 'agent', runId = '') {
    const inputTokens = estimateTokens(JSON.stringify(messages || []));
    const outputTokens = estimateTokens(output || '');
    recordModelTokenUsage(user.id, modelCfg.id, inputTokens + outputTokens, source, inputTokens, outputTokens);
    if (runId) {
        db.prepare(`
            UPDATE agent_runs
            SET input_tokens = COALESCE(input_tokens, 0) + ?,
                output_tokens = COALESCE(output_tokens, 0) + ?,
                total_tokens = COALESCE(total_tokens, 0) + ?,
                last_heartbeat_at = ?,
                updated_at = ?
            WHERE id = ?
        `).run(inputTokens, outputTokens, inputTokens + outputTokens, getBeijingTimestamp(), getBeijingTimestamp(), runId);
        const run = db.prepare('SELECT max_token_budget, total_tokens FROM agent_runs WHERE id = ?').get(runId);
        if (run && Number(run.max_token_budget || 0) > 0 && Number(run.total_tokens || 0) > Number(run.max_token_budget || 0)) {
            const err = new Error(`智能体任务已超过模型用量上限 ${run.max_token_budget}`);
            err.code = 'AGENT_BUDGET_EXCEEDED';
            throw err;
        }
    }
    return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
}

module.exports = {
    callModelJson,
    callModelText,
    callModelStreamingWithTools,
    recordAgentModelUsage,
    withAgentModelConcurrency,
    resolveAgentMaxTokens
};
