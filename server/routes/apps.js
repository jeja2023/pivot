// 应用中心后端接口：当前承载“公文写作”AI 调用。
// 前端只传结构化参数（mode/action/source/draft/requirements/selection 等），
// 由后端负责提示词组装、模型权限/配额/上下文预算、上游转发、用量统计与审计标签。
const express = require('express');
const { asyncHandler } = require('../http');
const { logger } = require('../logger');
const { estimateTokens } = require('../llm');
const {
    getAccessibleModel,
    getModelDailyUsage,
    recordModelTokenUsage,
    modelSupportsReasoning
} = require('../services/models');
const { extractModelText } = require('../services/chat-route-helpers');
const { aiSemaphore } = require('../services/concurrency');
const {
    acquireModelSlot,
    recordModelSuccess,
    recordModelFailure
} = require('../services/model-runtime');
const { createSseEventParser, createStreamAccumulator } = require('../streaming');
const {
    buildChatCompletionsUrl,
    buildModelHeaders
} = require('../services/model-adapter');
const { forwardChatCompletion } = require('../services/model-forwarder');
const { normalizeTokenUsage } = require('../services/token-accounting');
const {
    ContextLengthExceededError,
    fitMessagesToContextBudget
} = require('../services/context-budget');
const {
    buildOfficialWritingMessages,
    parseOfficialWritingReviewItems,
    OFFICIAL_WRITING_MODE_LABELS,
    OFFICIAL_WRITING_STREAMABLE_MODES
} = require('../services/official-writing');
const {
    buildAiContext,
    buildChart,
    compareDatasets,
    exportDataset,
    getDatasetDetail,
    importDataset,
    importFromDatabase,
    listDatasetArtifacts,
    listDatasets,
    runPivot,
    runSummary,
    runUserQuery,
    softDeleteDataset
} = require('../services/data-analysis');

// 剥离推理型模型可能内联在正文里的思考块（<think>…</think>）。
// 兼容未闭合的 <think>（被 max_tokens 截断时只剩开标签）情形。
function stripThinkTags(text) {
    return String(text || '')
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/<think>[\s\S]*$/i, '')
        .trim();
}

// 解析非流式补全响应中的正文：复用聊天侧的健壮解析（兼容字符串/数组 content、
// Responses 风格 output_text/output[]），再剥离思考块。
// 不把 reasoning_content 当作正文返回——它是思考过程而非成稿，空正文交由上层给出明确提示。
function extractCompletionContent(data) {
    return stripThinkTags(extractModelText(data));
}

// 从模型文本中尽力解析一个 JSON 对象：剥离 ```json 代码围栏后取首个 { 到末个 }。
// 解析失败返回 null（调用方据此把整段文本当作普通回答兜底）。
function parseJsonObject(text) {
    const raw = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
    try {
        const direct = JSON.parse(raw);
        return direct && typeof direct === 'object' && !Array.isArray(direct) ? direct : null;
    } catch (_e) { /* fall through to brace extraction */ }
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) {
        try {
            const parsed = JSON.parse(raw.slice(start, end + 1));
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
        } catch (_e2) { /* not JSON */ }
    }
    return null;
}

function clampText(value, max = 4000) {
    const text = String(value ?? '');
    return text.length > max ? `${text.slice(0, max)}…（已截断）` : text;
}

// 判断是否应为该模型关闭“思考”模式：公文起草/润色/审校属工具型任务，无需思维链。
// 依据管理员设置的 supports_reasoning，或常见推理型模型名（Qwen3 / QwQ / DeepSeek-R1）兜底识别。
function shouldDisableThinking(modelCfg) {
    if (modelSupportsReasoning(modelCfg)) return true;
    const name = String(modelCfg?.model_name || modelCfg?.name || '');
    return /qwen-?3|qwq|deepseek-?r1/i.test(name);
}

// 对推理型模型在最后一条 user 消息追加 /no_think 软开关（Qwen3 等的 chat template 原生支持）。
function applyNoThinkSoftSwitch(messages) {
    const lastUserIndex = messages.map(m => m.role).lastIndexOf('user');
    if (lastUserIndex < 0) return messages;
    return messages.map((message, index) => {
        if (index !== lastUserIndex || typeof message.content !== 'string') return message;
        return { ...message, content: `${message.content}\n/no_think` };
    });
}

// 解析公文写作可用模型：优先显式选择，其次个人默认模型，最后系统默认模型。
function resolveOfficialWritingModel(requestedModel, user) {
    if (requestedModel) {
        const selected = getAccessibleModel(requestedModel, user);
        if (selected) return selected;
    }
    if (user?.default_model_id) {
        const personal = getAccessibleModel(user.default_model_id, user);
        if (personal) return personal;
    }
    return getAccessibleModel(null, user);
}

function resolveAppsModel(requestedModel, user) {
    return resolveOfficialWritingModel(requestedModel, user);
}

async function runAppsAiCompletion({ req, res, logAction, source, auditAction, messages, maxTokens = 1200, temperature = 0.35, stream = false }) {
    const modelCfg = resolveAppsModel(String(req.body?.model || '').trim(), req.user);
    if (!modelCfg) {
        return res.status(404).json({
            error: {
                message: '未找到可用模型，请在聊天页选择模型或设置默认模型后再使用 AI 功能。',
                type: 'invalid_request_error',
                code: 'model_not_found'
            }
        });
    }
    if (modelCfg.secret_error) {
        return res.status(400).json({ error: { message: modelCfg.secret_error, type: 'invalid_request_error' } });
    }

    const userId = req.user.id;
    let upstreamMessages = messages;
    const outputTokens = Math.max(maxTokens, Number(modelCfg.max_tokens) || 0);
    try {
        const budgetResult = fitMessagesToContextBudget(messages, modelCfg, { maxOutputTokens: outputTokens });
        upstreamMessages = budgetResult.messages;
    } catch (e) {
        if (e instanceof ContextLengthExceededError || e.code === 'CONTEXT_LENGTH_EXCEEDED') {
            return res.status(400).json({
                error: {
                    message: e.message,
                    type: 'invalid_request_error',
                    code: 'context_length_exceeded',
                    context_budget: e.metadata || {}
                }
            });
        }
        throw e;
    }

    if (modelCfg.daily_token_limit > 0) {
        const usedToday = getModelDailyUsage(userId, modelCfg.id);
        if (usedToday >= modelCfg.daily_token_limit) {
            return res.status(429).json({ error: { message: 'Quota exceeded.', type: 'insufficient_quota' } });
        }
    }

    logAction(req, auditAction, `模型: ${modelCfg.name}`);

    try {
        await aiSemaphore.acquire();
    } catch (e) {
        return res.status(e.statusCode || 503).json({
            error: { message: e.message || 'Model service is busy. Please retry later.', type: 'server_overloaded', code: e.code || 'AI_OVERLOADED' }
        });
    }
    let endpointRelease = null;
    let released = false;
    const releaseSlots = () => {
        if (released) return;
        released = true;
        if (endpointRelease) endpointRelease();
        aiSemaphore.release();
    };
    const requestStartedAt = Date.now();
    const upstreamPayloadMessages = shouldDisableThinking(modelCfg) ? applyNoThinkSoftSwitch(upstreamMessages) : upstreamMessages;
    try {
        endpointRelease = await acquireModelSlot(modelCfg);
        const response = await forwardChatCompletion({
            modelCfg,
            user: req.user,
            url: buildChatCompletionsUrl(modelCfg.url, { appendV1ForLocal: true }),
            data: {
                model: modelCfg.model_name,
                messages: upstreamPayloadMessages,
                stream,
                temperature,
                max_tokens: outputTokens
            },
            headers: buildModelHeaders(modelCfg),
            stream
        });

        if (stream) {
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            const accumulator = createStreamAccumulator();
            const parser = createSseEventParser({ onData(p) { accumulator.pushPayload(p); } });
            response.data.on('data', chunk => {
                res.write(chunk);
                parser.write(chunk);
            });
            response.data.on('end', () => {
                parser.end();
                accumulator.finish();
                const totalContent = accumulator.getContent();
                const apiUsage = accumulator.getUsage();
                const usage = normalizeTokenUsage({
                    inputTokens: apiUsage?.prompt_tokens || estimateTokens(JSON.stringify(upstreamMessages)),
                    outputTokens: apiUsage?.completion_tokens || estimateTokens(totalContent),
                    totalTokens: apiUsage?.total_tokens
                });
                recordModelTokenUsage(userId, modelCfg.id, usage.totalTokens, source, usage.inputTokens, usage.outputTokens);
                recordModelSuccess(modelCfg, Date.now() - requestStartedAt);
                if (!res.writableEnded) res.end();
                releaseSlots();
            });
            response.data.on('error', err => {
                logger.error({ err: err.message, model: modelCfg.name, source }, '应用中心 AI 流式转发中断');
                recordModelFailure(modelCfg, err);
                if (!res.writableEnded) res.end();
                releaseSlots();
            });
            req.on('close', () => {
                if (response.data && typeof response.data.destroy === 'function') response.data.destroy();
                releaseSlots();
            });
            return undefined;
        }

        const content = extractCompletionContent(response.data);
        const usage = normalizeTokenUsage({
            inputTokens: response.data?.usage?.prompt_tokens || estimateTokens(JSON.stringify(upstreamMessages)),
            outputTokens: response.data?.usage?.completion_tokens || estimateTokens(content),
            totalTokens: response.data?.usage?.total_tokens
        });
        recordModelTokenUsage(userId, modelCfg.id, usage.totalTokens, source, usage.inputTokens, usage.outputTokens);
        recordModelSuccess(modelCfg, Date.now() - requestStartedAt);
        releaseSlots();
        return res.json({ content, model: modelCfg.model_name });
    } catch (e) {
        const errorMsg = e.response?.data?.error?.message || e.message;
        logger.error({ err: errorMsg, model: modelCfg.name, source }, '应用中心 AI 调用失败');
        recordModelFailure(modelCfg, e);
        releaseSlots();
        if (!res.headersSent) {
            return res.status(e.response?.status || 500).json({ error: { message: errorMsg, type: 'api_error' } });
        }
        if (!res.writableEnded) res.end();
        return undefined;
    }
}

// 单次非流式模型调用，返回正文文本（供 AI 工具调用循环多轮使用）。
// 自带配额/上下文预算/并发与用量统计，调用方负责循环与工具执行。
async function callAppsModelText({ modelCfg, user, messages, source, maxTokens = 900, temperature = 0.2 }) {
    const outputTokens = Math.max(maxTokens, Number(modelCfg.max_tokens) || 0);
    let upstreamMessages = messages;
    const budgetResult = fitMessagesToContextBudget(messages, modelCfg, { maxOutputTokens: outputTokens });
    upstreamMessages = budgetResult.messages;
    const payloadMessages = shouldDisableThinking(modelCfg) ? applyNoThinkSoftSwitch(upstreamMessages) : upstreamMessages;

    await aiSemaphore.acquire();
    let endpointRelease = null;
    const startedAt = Date.now();
    try {
        endpointRelease = await acquireModelSlot(modelCfg);
        const response = await forwardChatCompletion({
            modelCfg,
            user,
            url: buildChatCompletionsUrl(modelCfg.url, { appendV1ForLocal: true }),
            data: { model: modelCfg.model_name, messages: payloadMessages, stream: false, temperature, max_tokens: outputTokens },
            headers: buildModelHeaders(modelCfg),
            stream: false
        });
        const content = extractCompletionContent(response.data);
        const usage = normalizeTokenUsage({
            inputTokens: response.data?.usage?.prompt_tokens || estimateTokens(JSON.stringify(upstreamMessages)),
            outputTokens: response.data?.usage?.completion_tokens || estimateTokens(content),
            totalTokens: response.data?.usage?.total_tokens
        });
        recordModelTokenUsage(user.id, modelCfg.id, usage.totalTokens, source, usage.inputTokens, usage.outputTokens);
        recordModelSuccess(modelCfg, Date.now() - startedAt);
        return content;
    } catch (e) {
        recordModelFailure(modelCfg, e);
        throw e;
    } finally {
        if (endpointRelease) endpointRelease();
        aiSemaphore.release();
    }
}

const ANALYSIS_AGENT_MAX_STEPS = 3;

function buildAnalysisAgentSystemPrompt(context) {
    return [
        '你是数据分析工作台的智能分析师，可以调用工具查询真实数据、生成图表，再据此回答。',
        '',
        '【可用工具】',
        '1) run_sql：对当前数据集执行只读 SQL。表名固定为 data，列名为下方字段名。仅支持 SELECT/WITH，会自动限制返回行数。',
        '   写 SQL 时中文字段名必须用双引号；上下文标为数值的字段可直接做 SUM/AVG/MAX/MIN 和加减运算，其他字段需要先 TRY_CAST("字段名" AS DOUBLE)。',
        '2) make_chart：生成图表。参数 chartType(bar|line|area|pie)、xField(分类字段名)、yField(数值字段名，可选)、groupField(分组字段名，可选)、aggregation(sum|count|avg|min|max)。',
        '',
        '【数据集上下文】',
        context,
        '',
        '【回答协议】每一步只输出一个 JSON 对象，不要输出多余文字：',
        '- 调用工具：{"thought":"简要思考","action":"tool","tool":"run_sql","input":{"sql":"SELECT ..."}}',
        '  或 {"thought":"...","action":"tool","tool":"make_chart","input":{"chartType":"bar","xField":"字段名","yField":"字段名","aggregation":"sum"}}',
        '- 给出最终回答：{"action":"final","answer":"基于数据的中文结论，简洁给出洞察与建议"}',
        '不要编造字段或数值；需要数据时先用 run_sql 查询。最多可调用工具若干次后必须给出 final。'
    ].join('\n');
}

function formatAgentToolError(error) {
    const message = String(error?.message || '工具执行失败');
    return message
        .replace(/^查询执行失败[:：]\s*/, '')
        .split('\n')[0]
        .slice(0, 500);
}

// 数据分析 AI 工具调用（深度分析）：JSON-planner ReAct 循环，模型回结构化 JSON，
// 后端执行 run_sql / make_chart 并把观测回灌，直至 final 或达步数上限。兼容不支持原生 function-calling 的模型。
async function runDataAnalysisAgent({ req, res, logAction }) {
    const body = req.body || {};
    const datasetId = String(body.datasetId || '').trim();
    const userPrompt = String(body.prompt || '').trim();
    if (!datasetId || !userPrompt) {
        return res.status(400).json({ error: { message: '缺少数据集或问题。', type: 'invalid_request_error' } });
    }
    const modelCfg = resolveAppsModel(String(body.model || '').trim(), req.user);
    if (!modelCfg) {
        return res.status(404).json({ error: { message: '未找到可用模型，请在聊天页选择模型或设置默认模型后再使用 AI 功能。', type: 'invalid_request_error', code: 'model_not_found' } });
    }
    if (modelCfg.secret_error) {
        return res.status(400).json({ error: { message: modelCfg.secret_error, type: 'invalid_request_error' } });
    }
    if (modelCfg.daily_token_limit > 0 && getModelDailyUsage(req.user.id, modelCfg.id) >= modelCfg.daily_token_limit) {
        return res.status(429).json({ error: { message: 'Quota exceeded.', type: 'insufficient_quota' } });
    }

    const userId = req.user.id;
    const context = await buildAiContext(userId, datasetId);
    const messages = [
        { role: 'system', content: buildAnalysisAgentSystemPrompt(context) },
        { role: 'user', content: userPrompt }
    ];
    const steps = [];
    const charts = [];
    let answer = '';

    logAction(req, '数据分析 AI 深度分析', `数据集: ${datasetId}，模型: ${modelCfg.name}`);

    try {
        for (let step = 0; step < ANALYSIS_AGENT_MAX_STEPS; step += 1) {
            const text = await callAppsModelText({ modelCfg, user: req.user, messages, source: 'data_analysis_agent', maxTokens: 900, temperature: 0.2 });
            const plan = parseJsonObject(text);
            if (!plan) { answer = text.trim(); break; } // 非 JSON：当作普通回答兜底
            if (plan.action === 'final' || !plan.tool) { answer = String(plan.answer || '').trim(); break; }

            let observation;
            try {
                if (plan.tool === 'run_sql') {
                    const sql = String(plan.input?.sql || plan.input?.query || '').trim();
                    const result = await runUserQuery(userId, datasetId, { sql, limit: 50 });
                    observation = JSON.stringify({ columns: result.columns, rows: result.rows.slice(0, 30), rowCount: result.rowCount, truncated: result.truncated });
                    steps.push({ tool: 'run_sql', input: { sql }, summary: `返回 ${result.rowCount} 行`, status: 'success' });
                } else if (plan.tool === 'make_chart') {
                    const result = await buildChart(userId, datasetId, plan.input || {});
                    charts.push(result.chart);
                    observation = JSON.stringify({ ok: true, title: result.chart.title, chartType: result.chart.chartType });
                    steps.push({ tool: 'make_chart', input: plan.input || {}, summary: result.chart.title, status: 'success' });
                } else {
                    observation = `未知工具：${plan.tool}`;
                    steps.push({ tool: String(plan.tool), input: plan.input || {}, summary: '未知工具', status: 'error', error: '未知工具' });
                }
            } catch (toolErr) {
                const errorText = formatAgentToolError(toolErr);
                observation = JSON.stringify({ ok: false, error: errorText });
                steps.push({
                    tool: String(plan.tool || ''),
                    input: plan.input || {},
                    summary: `失败：${errorText}`,
                    status: 'error',
                    error: errorText
                });
            }
            messages.push({ role: 'assistant', content: text });
            messages.push({ role: 'user', content: `工具 ${plan.tool} 结果：\n${clampText(observation, 4000)}\n请据此继续：输出下一步 JSON，或用 action=final 给出最终中文回答。` });
        }

        if (!answer) {
            // 达到步数上限仍未 final：要求模型据已有观测收尾。
            const closing = await callAppsModelText({
                modelCfg,
                user: req.user,
                source: 'data_analysis_agent',
                messages: [...messages, { role: 'user', content: '请基于以上工具结果，用 {"action":"final","answer":"..."} 给出最终中文回答。' }],
                maxTokens: 900,
                temperature: 0.2
            });
            answer = String(parseJsonObject(closing)?.answer || closing || '').trim();
        }
        return res.json({ answer: answer || '未能得出结论，请调整问题后重试。', steps, charts });
    } catch (e) {
        const errorMsg = e.response?.data?.error?.message || e.message;
        logger.error({ err: errorMsg, model: modelCfg.name }, '数据分析 AI 深度分析失败');
        if (!res.headersSent) {
            return res.status(e.response?.status || e.status || 500).json({ error: { message: errorMsg, type: 'api_error' } });
        }
        return undefined;
    }
}

function createAppsRouter({ authMiddleware, logAction, uploadLimiter, upload }) {
    const router = express.Router();

    router.get('/apps/data-analysis/datasets', authMiddleware, asyncHandler(async (req, res) => {
        res.json({ datasets: listDatasets(req.user.id) });
    }));

    router.post('/apps/data-analysis/datasets', authMiddleware, uploadLimiter, upload.single('file'), asyncHandler(async (req, res) => {
        try {
            const dataset = await importDataset({
                user: req.user,
                file: req.file,
                name: req.body?.name
            });
            logAction(req, '数据分析-上传数据集', `数据集: ${dataset.name} (${dataset.rowCount} 行)`);
            res.json({ dataset });
        } catch (e) {
            if (req.file?.path) {
                try { require('fs').rmSync(req.file.path, { force: true }); } catch (_err) { /* noop */ }
            }
            throw e;
        }
    }));

    router.get('/apps/data-analysis/datasets/:id', authMiddleware, asyncHandler(async (req, res) => {
        res.json({ dataset: await getDatasetDetail(req.user.id, req.params.id) });
    }));

    router.delete('/apps/data-analysis/datasets/:id', authMiddleware, asyncHandler(async (req, res) => {
        const dataset = softDeleteDataset(req.user.id, req.params.id);
        logAction(req, '数据分析-删除数据集', `数据集: ${dataset.name}`);
        res.json({ success: true });
    }));

    router.post('/apps/data-analysis/datasets/:id/summary', authMiddleware, asyncHandler(async (req, res) => {
        res.json(await runSummary(req.user.id, req.params.id));
    }));

    router.post('/apps/data-analysis/datasets/:id/chart', authMiddleware, asyncHandler(async (req, res) => {
        const result = await buildChart(req.user.id, req.params.id, req.body || {});
        logAction(req, '数据分析-生成图表', `数据集: ${req.params.id}`);
        res.json(result);
    }));

    router.post('/apps/data-analysis/compare', authMiddleware, asyncHandler(async (req, res) => {
        const result = await compareDatasets(req.user.id, req.body || {});
        logAction(req, '数据分析-数据比对', `左侧: ${req.body?.leftDatasetId || ''}, 右侧: ${req.body?.rightDatasetId || ''}`);
        res.json(result);
    }));

    router.post('/apps/data-analysis/compare/export', authMiddleware, asyncHandler(async (req, res) => {
        const { exportCompareExcel } = require('../services/data-analysis');
        const buffer = exportCompareExcel(req.body || {});
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename="data_compare.xlsx"');
        res.send(buffer);
    }));

    router.post('/apps/data-analysis/datasets/:id/query', authMiddleware, asyncHandler(async (req, res) => {
        const result = await runUserQuery(req.user.id, req.params.id, req.body || {});
        logAction(req, '数据分析-SQL 查询', `数据集: ${req.params.id}`);
        res.json(result);
    }));

    router.post('/apps/data-analysis/datasets/:id/pivot', authMiddleware, asyncHandler(async (req, res) => {
        const result = await runPivot(req.user.id, req.params.id, req.body || {});
        logAction(req, '数据分析-透视表', `数据集: ${req.params.id}`);
        res.json(result);
    }));

    router.get('/apps/data-analysis/datasets/:id/artifacts', authMiddleware, asyncHandler(async (req, res) => {
        const limit = Number.parseInt(req.query.limit, 10) || 30;
        res.json({ artifacts: listDatasetArtifacts(req.user.id, req.params.id, { limit }) });
    }));

    router.get('/apps/data-analysis/datasets/:id/export.csv', authMiddleware, asyncHandler(async (req, res) => {
        const exported = await exportDataset(req.user.id, req.params.id, 'csv');
        logAction(req, '数据分析-导出 CSV', `数据集: ${req.params.id}`);
        res.download(exported.filePath, exported.fileName);
    }));

    // 多格式导出：format 取 csv|xlsx|parquet，默认 csv。
    router.get('/apps/data-analysis/datasets/:id/export', authMiddleware, asyncHandler(async (req, res) => {
        const format = String(req.query.format || 'csv').toLowerCase();
        const exported = await exportDataset(req.user.id, req.params.id, format);
        logAction(req, '数据分析-导出数据', `数据集: ${req.params.id}，格式: ${format}`);
        res.download(exported.filePath, exported.fileName);
    }));

    router.post('/apps/data-analysis/import-database', authMiddleware, asyncHandler(async (req, res) => {
        const body = req.body || {};
        const dataset = await importFromDatabase({
            user: req.user,
            mcpServerId: body.mcpServerId || body.serverId,
            sql: body.sql,
            table: body.table,
            schema: body.schema,
            limit: body.limit,
            name: body.name
        });
        logAction(req, '数据分析-数据库导入', `连接: ${body.mcpServerId || body.serverId || ''}，数据集: ${dataset.name} (${dataset.rowCount} 行)`);
        res.json({ dataset });
    }));

    router.post('/apps/data-analysis/ai', authMiddleware, asyncHandler(async (req, res) => {
        const body = req.body || {};
        // 深度分析模式：走工具调用（ReAct）循环，可查询真实数据与生成图表。
        if (body.mode === 'agent') {
            return runDataAnalysisAgent({ req, res, logAction });
        }
        const datasetId = String(body.datasetId || '').trim();
        const userPrompt = String(body.prompt || '').trim();
        if (!datasetId || !userPrompt) {
            return res.status(400).json({ error: { message: '缺少数据集或问题。', type: 'invalid_request_error' } });
        }
        const context = await buildAiContext(req.user.id, datasetId);
        return runAppsAiCompletion({
            req,
            res,
            logAction,
            source: 'data_analysis',
            auditAction: '数据分析 AI',
            messages: [
                {
                    role: 'system',
                    content: [
                        '你是数据分析工作台的辅助分析师。',
                        '只能基于给定的数据集摘要、字段画像和统计结果回答。',
                        '不要编造不存在的字段或精确数值；如果需要进一步查询，给出可执行的分析建议。',
                        '输出应简洁，优先给出洞察、风险、推荐图表和下一步操作。'
                    ].join('\n')
                },
                {
                    role: 'user',
                    content: `数据集上下文：\n${context}\n\n用户问题：${userPrompt}`
                }
            ],
            maxTokens: 1200,
            temperature: 0.3,
            stream: !!body.stream
        });
    }));

    router.post('/apps/official-writing/ai', authMiddleware, asyncHandler(async (req, res) => {
        const body = req.body || {};
        const mode = String(body.mode || '').trim();

        let built;
        try {
            built = buildOfficialWritingMessages(body);
        } catch (e) {
            return res.status(400).json({ error: { message: e.message, type: 'invalid_request_error' } });
        }

        // 文本类模式（起草/润色/全文改写/选区/逐句改写）均可流式；
        // review 模式需要在后端把整段输出解析为结构化 JSON 条目，必须拿到完整文本，故不参与流式。
        const wantStream = !!body.stream && OFFICIAL_WRITING_STREAMABLE_MODES.has(mode);
        const modelCfg = resolveOfficialWritingModel(String(body.model || '').trim(), req.user);
        if (!modelCfg) {
            return res.status(404).json({
                error: {
                    message: '未找到可用模型，请在聊天页选择模型或设置默认模型后再使用 AI 功能。',
                    type: 'invalid_request_error',
                    code: 'model_not_found'
                }
            });
        }
        if (modelCfg.secret_error) {
            return res.status(400).json({ error: { message: modelCfg.secret_error, type: 'invalid_request_error' } });
        }

        const userId = req.user.id;
        // 获取模型配置的最大输出 Token 限制
        const modelMaxTokens = Number(modelCfg.max_tokens) || 0;
        // 输出长度完全由模型决定：公文不再设内置默认上限。
        // 预算检查时，若模型未配置最大输出限制，则传 null，由全局上下文预算用默认预留量裁剪输入。
        const maxTokens = modelMaxTokens > 0 ? modelMaxTokens : null;
        // 推理型模型：公文工具任务关闭思考，避免思考耗尽 token 导致正文为空（Qwen3 等）。
        const disableThinking = shouldDisableThinking(modelCfg);
        const requestMessages = disableThinking ? applyNoThinkSoftSwitch(built.messages) : built.messages;

        // 上下文预算检查（与聊天/OpenAI 兼容接口同一套口径）。
        let upstreamMessages = requestMessages;
        try {
            const budgetResult = fitMessagesToContextBudget(requestMessages, modelCfg, { maxOutputTokens: maxTokens });
            upstreamMessages = budgetResult.messages;
            if (budgetResult.metadata?.adjusted) {
                logger.warn({ userId, model: modelCfg.name, contextBudget: budgetResult.metadata }, '公文写作请求上下文已裁剪');
            }
        } catch (e) {
            if (e instanceof ContextLengthExceededError || e.code === 'CONTEXT_LENGTH_EXCEEDED') {
                return res.status(400).json({
                    error: {
                        message: e.message,
                        type: 'invalid_request_error',
                        code: 'context_length_exceeded',
                        context_budget: e.metadata || {}
                    }
                });
            }
            throw e;
        }

        // 配额检查。
        if (modelCfg.daily_token_limit > 0) {
            const usedToday = getModelDailyUsage(userId, modelCfg.id);
            if (usedToday >= modelCfg.daily_token_limit) {
                return res.status(429).json({ error: { message: 'Quota exceeded.', type: 'insufficient_quota' } });
            }
        }

        const auditLabel = OFFICIAL_WRITING_MODE_LABELS[mode] || mode || '处理';
        const auditAction = body.action ? `/${String(body.action).slice(0, 20)}` : '';
        logAction(req, '公文写作 AI', `操作: ${auditLabel}${auditAction}，模型: ${modelCfg.name}，流式: ${wantStream}`);

        // --- 并发控制 ---
        try {
            await aiSemaphore.acquire();
        } catch (e) {
            return res.status(e.statusCode || 503).json({
                error: { message: e.message || 'Model service is busy. Please retry later.', type: 'server_overloaded', code: e.code || 'AI_OVERLOADED' }
            });
        }
        let semaphoreReleased = false;
        let endpointRelease = null;
        const requestStartedAt = Date.now();
        try {
            endpointRelease = await acquireModelSlot(modelCfg);
        } catch (e) {
            aiSemaphore.release();
            return res.status(e.statusCode || 503).json({
                error: { message: e.message || 'Model endpoint is busy. Please retry later.', type: 'server_overloaded', code: e.code || 'AI_ENDPOINT_OVERLOADED' }
            });
        }
        const releaseSemaphore = () => {
            if (!semaphoreReleased) {
                if (endpointRelease) endpointRelease();
                aiSemaphore.release();
                semaphoreReleased = true;
            }
        };

        const targetUrl = buildChatCompletionsUrl(modelCfg.url, { appendV1ForLocal: true });
        const payload = {
            model: modelCfg.model_name,
            messages: upstreamMessages,
            stream: wantStream,
            temperature: modelCfg.temperature ?? 0.4
        };
        if (modelMaxTokens > 0) {
            payload.max_tokens = modelMaxTokens;
        }
        if (modelCfg.max_input_tokens !== null && modelCfg.max_input_tokens !== undefined) {
            payload.max_input_tokens = modelCfg.max_input_tokens;
        }
        const headers = buildModelHeaders(modelCfg);

        try {
            const response = await forwardChatCompletion({
                modelCfg,
                user: req.user,
                url: targetUrl,
                data: payload,
                headers,
                stream: wantStream
            });

            if (wantStream) {
                res.setHeader('Content-Type', 'text/event-stream');
                res.setHeader('Cache-Control', 'no-cache');
                res.setHeader('Connection', 'keep-alive');

                const accumulator = createStreamAccumulator();
                const parser = createSseEventParser({ onData(p) { accumulator.pushPayload(p); } });
                response.data.on('data', chunk => {
                    res.write(chunk);
                    parser.write(chunk);
                });
                response.data.on('end', () => {
                    parser.end();
                    accumulator.finish();
                    const totalContent = accumulator.getContent();
                    const apiUsage = accumulator.getUsage();
                    const usage = normalizeTokenUsage({
                        inputTokens: apiUsage?.prompt_tokens || estimateTokens(JSON.stringify(upstreamMessages)),
                        outputTokens: apiUsage?.completion_tokens || estimateTokens(totalContent),
                        totalTokens: apiUsage?.total_tokens
                    });
                    recordModelTokenUsage(userId, modelCfg.id, usage.totalTokens, 'official_writing', usage.inputTokens, usage.outputTokens);
                    recordModelSuccess(modelCfg, Date.now() - requestStartedAt);
                    res.end();
                    releaseSemaphore();
                });
                response.data.on('error', err => {
                    logger.error({ err: err.message, model: modelCfg.name }, '公文写作流式转发中断');
                    recordModelFailure(modelCfg, err);
                    if (!res.writableEnded) res.end();
                    releaseSemaphore();
                });
                req.on('close', () => {
                    if (response.data && typeof response.data.destroy === 'function') response.data.destroy();
                    releaseSemaphore();
                });
            } else {
                const choice = response.data?.choices?.[0];
                const finishReason = choice?.finish_reason || null;
                const content = extractCompletionContent(response.data);
                const usage = normalizeTokenUsage({
                    inputTokens: response.data?.usage?.prompt_tokens || estimateTokens(JSON.stringify(upstreamMessages)),
                    outputTokens: response.data?.usage?.completion_tokens || estimateTokens(content),
                    totalTokens: response.data?.usage?.total_tokens
                });
                recordModelTokenUsage(userId, modelCfg.id, usage.totalTokens, 'official_writing', usage.inputTokens, usage.outputTokens);
                recordModelSuccess(modelCfg, Date.now() - requestStartedAt);
                releaseSemaphore();

                // 空正文诊断：记录 finish_reason / usage / 是否含 reasoning_content，便于定位“返回 200 但无正文”。
                if (!content) {
                    logger.warn({
                        model: modelCfg.name,
                        modelName: modelCfg.model_name,
                        mode,
                        finishReason,
                        hasReasoningContent: !!choice?.message?.reasoning_content,
                        disableThinking,
                        maxTokens,
                        usage: response.data?.usage || null
                    }, '公文写作 AI 返回空正文');
                }

                const result = { content, model: modelCfg.model_name, finish_reason: finishReason };
                // 审校模式在后端完成 JSON 提取与校验，前端直接使用结构化结果。
                if (mode === 'review') result.items = parseOfficialWritingReviewItems(content);
                res.json(result);
            }
        } catch (e) {
            const errorMsg = e.response?.data?.error?.message || e.message;
            logger.error({ err: errorMsg, model: modelCfg.name }, '公文写作 AI 转发失败');
            recordModelFailure(modelCfg, e);
            if (!res.headersSent) {
                res.status(e.response?.status || 500).json({ error: { message: errorMsg, type: 'api_error' } });
            } else if (!res.writableEnded) {
                res.end();
            }
            releaseSemaphore();
        }
    }));

    return router;
}

module.exports = {
    createAppsRouter,
    // 导出纯函数便于单测
    stripThinkTags,
    extractCompletionContent,
    shouldDisableThinking,
    applyNoThinkSoftSwitch
};
