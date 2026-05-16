const axios = require('axios');

const { db } = require('../db');
const { estimateTokens } = require('../llm');
const { getBeijingTimestamp } = require('../time');
const { recordModelTokenUsage } = require('./models');
const { buildChatCompletionsUrl, buildModelHeaders } = require('./model-adapter');

async function callModelJson(modelCfg, messages) {
    const response = await axios.post(buildChatCompletionsUrl(modelCfg.url, { appendV1ForLocal: false }), {
        model: modelCfg.model_name || modelCfg.name,
        messages,
        stream: false,
        temperature: 0.2,
        max_tokens: 1200
    }, {
        headers: buildModelHeaders(modelCfg, { acceptJson: true }),
        timeout: 180000,
        proxy: false
    });
    return response.data?.choices?.[0]?.message?.content || response.data?.output_text || '';
}

async function callModelText(modelCfg, messages) {
    return callModelJson(modelCfg, messages);
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
            const err = new Error(`智能体任务已超过 Token 预算 ${run.max_token_budget}`);
            err.code = 'AGENT_BUDGET_EXCEEDED';
            throw err;
        }
    }
    return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
}

module.exports = {
    callModelJson,
    callModelText,
    recordAgentModelUsage
};
