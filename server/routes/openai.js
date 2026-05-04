const express = require('express');
const { asyncHandler } = require('../http');
const { getAccessibleModel, getModelDailyUsage, getUserAccessibleModels } = require('../services/models');
const { estimateTokens } = require('../llm');
const { db } = require('../db');
const { getBeijingTimestamp } = require('../time');
const { logger } = require('../logger');
const axios = require('axios');

function createOpenAIRouter({ authMiddleware, logAction }) {
    const router = express.Router();

    // 1. 获取模型列表 (OpenAI 兼容)
    router.get('/models', authMiddleware, asyncHandler(async (req, res) => {
        const models = getUserAccessibleModels(req.user);
        res.json({
            object: 'list',
            data: models.map(m => ({
                id: m.id.toString(), // 使用数字 ID 或标识符，推荐使用 ID 保证唯一
                object: 'model',
                created: Math.floor(new Date(m.created_at).getTime() / 1000) || 0,
                owned_by: m.user_id ? 'user' : 'system',
                display_name: m.name // 非标扩展，方便部分 UI
            }))
        });
    }));

    // 2. 聊天补全接口
    router.post('/chat/completions', authMiddleware, asyncHandler(async (req, res) => {
        const { model, messages, stream, temperature, max_tokens } = req.body;
        const userId = req.user.id;

        // 1. 获取模型配置 (通过模型标识符或 ID)
        const modelCfg = getAccessibleModel(model, req.user);
        if (!modelCfg) return res.status(404).json({ error: { message: `Model '${model}' not found or no access.`, type: 'invalid_request_error' } });
        
        // 2. 检查配额
        if (modelCfg.daily_token_limit > 0) {
            const usedToday = getModelDailyUsage(userId, modelCfg.id);
            if (usedToday >= modelCfg.daily_token_limit) {
                return res.status(429).json({ error: { message: 'Quota exceeded.', type: 'insufficient_quota' } });
            }
        }

        logAction(req, 'OpenAI 接口调用', `模型: ${model}, 流式: ${!!stream}`);

        // 3. 构建下游请求
        const baseUrl = modelCfg.url.trim().replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
        const targetUrl = baseUrl + (baseUrl.includes('/v1') ? '' : '/v1') + '/chat/completions';

        const payload = {
            model: modelCfg.model_name,
            messages: messages,
            stream: !!stream,
            temperature: temperature ?? modelCfg.temperature ?? 0.7,
            max_tokens: max_tokens ?? modelCfg.max_tokens ?? 2000
        };

        const headers = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${modelCfg.api_key}`
        };

        try {
            const response = await axios({
                method: 'post',
                url: targetUrl,
                data: payload,
                headers: headers,
                responseType: stream ? 'stream' : 'json',
                timeout: 60000
            });

            if (stream) {
                res.setHeader('Content-Type', 'text/event-stream');
                res.setHeader('Cache-Control', 'no-cache');
                res.setHeader('Connection', 'keep-alive');
                
                let totalContent = '';
                response.data.on('data', chunk => {
                    res.write(chunk);
                    // 尝试从流中提取内容进行 Token 统计 (粗略统计)
                    const str = chunk.toString();
                    const matches = str.match(/"content":"(.*?)"/g);
                    if (matches) {
                        matches.forEach(m => {
                            const content = m.match(/"content":"(.*?)"/)[1];
                            totalContent += content;
                        });
                    }
                });

                response.data.on('end', () => {
                    const tokens = estimateTokens(JSON.stringify(messages) + totalContent);
                    // 记录异步审计，不在此处插入 messages 表，仅记录日志
                    res.end();
                });
            } else {
                res.json(response.data);
            }
        } catch (e) {
            const errorMsg = e.response?.data?.error?.message || e.message;
            logger.error({ err: errorMsg, model: modelCfg.name }, 'OpenAI 转发失败');
            res.status(e.response?.status || 500).json({ error: { message: errorMsg, type: 'api_error' } });
        }
    }));

    return router;
}

module.exports = { createOpenAIRouter };
