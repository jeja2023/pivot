/* 对话接口路由 Chat API Routes */
const axios = require('axios');
const http = require('http');
const https = require('https');
const express = require('express');
const { asyncHandler } = require('../http');
const { StringDecoder } = require('string_decoder');
const { db } = require('../db');
const {
    detectUnsupportedCapability,
    buildCapabilityFallbackMessage
} = require('../capabilities');
const { estimateTokens, getContext } = require('../llm');
const { getBeijingTimestamp } = require('../time');
const {
    getAccessibleModel,
    getModelDailyUsage
} = require('../services/models');
const { logger } = require('../logger');
const { aiSemaphore } = require('../services/concurrency');

const httpAgent = new http.Agent({ keepAlive: true });
const httpsAgent = new https.Agent({ keepAlive: true });

async function generateTitle(sessionId, userMsg, aiMsg, modelCfg) {
    try {
        logger.info({ sessionId }, '正在生成会话标题');
        const baseUrl = modelCfg.url.trim().replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
        const targetUrl = baseUrl + (baseUrl.includes('/v1') ? '' : '/v1') + '/chat/completions';

        const response = await axios({
            method: 'post',
            url: targetUrl,
            headers: {
                'Authorization': modelCfg.api_key ? `Bearer ${modelCfg.api_key}` : undefined,
                'Content-Type': 'application/json'
            },
            data: {
                model: modelCfg.model_name,
                messages: [
                    { role: 'user', content: `请根据以下对话内容，生成一个非常简短的标题（5-10个字），直接输出标题内容，不要带引号或任何解释。\n\n用户: ${userMsg}\n助手: ${aiMsg.slice(0, 100)}` }
                ],
                max_tokens: 20
            },
            timeout: 30000,
            proxy: false
        });

        const newTitle = response.data.choices[0]?.message?.content?.trim() || '新对话';
        db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run(newTitle, sessionId);
        logger.info({ sessionId, newTitle }, '会话标题已更新');
    } catch (e) {
        logger.error({ sessionId, err: e.message }, '会话标题生成失败');
    }
}

function createChatRouter({
    authMiddleware,
    chatLimiter,
    logAction,
    retrieveContext,
    isRagEnabled
}) {
    const router = express.Router();

    router.post('/chat/stats', authMiddleware, asyncHandler(async (req, res) => {
        const { sessionId, costTime, tps } = req.body;
        const userId = req.user.id;

        const lastMsg = db.prepare(`
            SELECT id FROM messages
            WHERE session_id = ? AND user_id = ? AND role = 'assistant'
            ORDER BY id DESC LIMIT 1
        `).get(sessionId, userId);

        if (lastMsg) {
            db.prepare('UPDATE messages SET cost_time = ?, tokens_per_sec = ? WHERE id = ?')
              .run(costTime, tps, lastMsg.id);
        }
        res.json({ success: true });
    }));

    router.post('/chat', authMiddleware, chatLimiter, asyncHandler(async (req, res) => {
        const { sessionId, content, displayContent, modelId, regenerate } = req.body;
        const userId = req.user.id;
        const modelContent = String(content || '').trim();
        const visibleContent = String(displayContent || modelContent).trim();

        const session = db.prepare('SELECT id FROM sessions WHERE id = ? AND user_id = ?').get(sessionId, userId);
        if (!session) return res.status(403).json({ error: '无权访问或会话不存在' });

        const modelCfg = getAccessibleModel(modelId, req.user);

        if (!modelCfg) return res.status(400).json({ error: '未找到可用的模型配置' });
        if (modelCfg.secret_error) return res.status(400).json({ error: `${modelCfg.secret_error}，请重新保存该模型的 API Key` });
        if (modelCfg.daily_token_limit && modelCfg.daily_token_limit > 0) {
            const usedToday = getModelDailyUsage(userId, modelCfg.id);
            if (usedToday >= modelCfg.daily_token_limit) {
                logAction(req, '模型额度拦截', `模型: ${modelCfg.name}，今日已用: ${usedToday}/${modelCfg.daily_token_limit}`);
                return res.status(429).json({ error: `该模型今日额度已用完（${usedToday}/${modelCfg.daily_token_limit} Tokens）` });
            }
        }

        if (!regenerate) {
            const userTokens = estimateTokens(modelContent);
            db.prepare('INSERT INTO messages (session_id, user_id, role, content, token_count, model_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
              .run(sessionId, userId, 'user', visibleContent, userTokens, modelCfg.id, getBeijingTimestamp());
        }

        db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(getBeijingTimestamp(), sessionId);
        
        logAction(req, regenerate ? '重新生成回答' : '发送消息', `${regenerate ? '重新生成' : '发送消息到'}会话: ${sessionId}`);

        const unsupportedCapability = detectUnsupportedCapability(modelContent);
        if (unsupportedCapability) {
            const assistantContent = buildCapabilityFallbackMessage(unsupportedCapability);
            const assistantTokens = estimateTokens(assistantContent);
            db.prepare('INSERT INTO messages (session_id, user_id, role, content, token_count, model_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
              .run(sessionId, userId, 'assistant', assistantContent, assistantTokens, modelCfg.id, getBeijingTimestamp());

            const msgCount = db.prepare('SELECT COUNT(*) as count FROM messages WHERE session_id = ?').get(sessionId).count;
            if (msgCount <= 2) {
                generateTitle(sessionId, visibleContent, assistantContent, modelCfg);
            }

            logAction(req, '能力不支持提示', `能力: ${unsupportedCapability.code}, 会话: ${sessionId}`);
            return res.json({
                unsupportedCapability: unsupportedCapability.code,
                content: assistantContent
            });
        }

        // --- 进入并发控制 ---
        try {
            await aiSemaphore.acquire();
        } catch (e) {
            const message = e.message || '模型服务当前繁忙，请稍后重试。';
            logAction(req, '模型服务繁忙', `${message} 会话: ${sessionId}`);
            return res.status(e.statusCode || 503).json({
                error: message,
                code: e.code || 'AI_OVERLOADED',
                retryable: true
            });
        }
        let semaphoreReleased = false;
        const releaseSemaphore = () => {
            if (!semaphoreReleased) {
                aiSemaphore.release();
                semaphoreReleased = true;
            }
        };

        let history = await getContext(sessionId, userId, modelCfg);
        if (modelContent && modelContent !== visibleContent) {
            const lastUserIndex = history.map(msg => msg.role).lastIndexOf('user');
            if (lastUserIndex >= 0) {
                history[lastUserIndex] = { ...history[lastUserIndex], content: modelContent };
            }
        }
        if (typeof retrieveContext === 'function' && typeof isRagEnabled === 'function' && isRagEnabled()) {
            const ragContext = await retrieveContext(userId, modelContent);
            if (ragContext) {
                history.push({ role: 'system', content: ragContext });
            }
        }

        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.setHeader('Content-Encoding', 'identity');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.socket?.setNoDelay?.(true);
        res.socket?.setKeepAlive?.(true);
        res.flushHeaders?.();

        const writeSse = (payload) => {
            if (res.writableEnded) return;
            res.write(`data: ${payload}\n\n`);
            res.flush?.();
        };
        res.write(': stream-ready\n\n');
        res.flush?.();

        let baseUrl = modelCfg.url.trim().replace(/\/+$/, '');
        if (!baseUrl.includes('/v1') && !baseUrl.includes('localhost') && !baseUrl.includes('127.0.0.1')) {
            baseUrl = baseUrl + '/v1';
        }

        const modelName = modelCfg.model_name || 'default';
        const isResponsesApi = modelName.includes('gpt-5') || modelName.includes('o1') || modelName.includes('o3') || modelName.includes('o4');

        let targetUrl;
        if (isResponsesApi) {
            targetUrl = baseUrl.replace(/\/chat\/completions$/, '').replace(/\/+$/, '') + '/responses';
        } else {
            targetUrl = baseUrl.replace(/\/+$/, '');
            if (!targetUrl.endsWith('/chat/completions')) {
                targetUrl += '/chat/completions';
            }
        }

        req.log.info({
            userId,
            model: modelCfg.name,
            modelName,
            targetUrl,
            mode: isResponsesApi ? 'Responses API' : 'Chat Completions API'
        }, '发起对话请求');

        const headers = {
            'Authorization': modelCfg.api_key ? `Bearer ${modelCfg.api_key}` : undefined,
            'x-api-key': modelCfg.api_key || undefined,
            'Content-Type': 'application/json',
            'User-Agent': 'Pivot-AI-Client/1.0',
            'Accept': 'application/json'
        };

        try {
            let response;
            const responsesHistory = history.map(msg => {
                if (msg.role === 'system') return { role: 'user', content: `[系统设定]: ${msg.content}` };
                return msg;
            });

            const requestData = { 
                model: modelName, 
                stream: true 
            };
            if (modelCfg.temperature !== null && modelCfg.temperature !== undefined) {
                requestData.temperature = modelCfg.temperature;
            }
            if (modelCfg.max_tokens !== null && modelCfg.max_tokens !== undefined) {
                requestData.max_completion_tokens = modelCfg.max_tokens;
                requestData.max_tokens = modelCfg.max_tokens; // Some APIs use this instead
            }

            if (isResponsesApi) {
                req.log.info('正在建立连接 (Responses API, 流式)');
                try {
                    requestData.input = responsesHistory;
                    response = await axios({
                        method: 'post', url: targetUrl, headers,
                        data: requestData,
                        responseType: 'stream', timeout: 180000, proxy: false
                    });
                    req.log.info('连接成功 (Responses API)');
                } catch (err) {
                    const status = err.response?.status;
                    if ([404, 405, 502, 503].includes(status)) {
                        req.log.warn({ status }, 'Responses API 暂不可用，正在自动回退到常规接口');
                        targetUrl = baseUrl.replace(/\/+$/, '');
                        if (!targetUrl.endsWith('/chat/completions')) targetUrl += '/chat/completions';
                        
                        delete requestData.input;
                        requestData.messages = history;
                        
                        response = await axios({
                            method: 'post', url: targetUrl, headers,
                            data: requestData,
                            responseType: 'stream', timeout: 300000, proxy: false,
                            httpAgent, httpsAgent
                        });
                        req.log.info('降级连接成功 (Chat Completions)');
                    } else {
                        throw err;
                    }
                }
            } else {
                req.log.info('正在建立连接 (Chat Completions API, 流式)');
                requestData.messages = history;
                response = await axios({
                    method: 'post', url: targetUrl, headers,
                    data: requestData,
                    responseType: 'stream', timeout: 300000, proxy: false,
                    httpAgent, httpsAgent
                });
                req.log.info('连接成功');
            }

            const decoder = new StringDecoder('utf8');
            let buffer = '';
            let assistantContent = '';
            let lastWasThought = false;
            let apiUsage = null;

            response.data.on('data', chunk => {
                buffer += decoder.write(chunk);
                let lines = buffer.split('\n');
                buffer = lines.pop();

                for (let line of lines) {
                    line = line.trim();
                    if (!line || !line.startsWith('data:')) continue;

                    const dataStr = line.replace(/^data:\s*/, '');
                    if (dataStr === '[DONE]') continue;

                    try {
                        const json = JSON.parse(dataStr);
                        if (json.usage) apiUsage = json.usage;
                        
                        let delta = '';
                        let isThought = false;

                        if (json.type === 'response.output_text.delta' || json.type === 'response.text_delta') {
                            delta = json.delta || json.text || '';
                        } else if (json.type === 'response.reasoning_text.delta' || json.type === 'response.reasoning_delta') {
                            delta = json.delta || json.text || '';
                            isThought = true;
                        } else if (json.type === 'response.content_part.delta') {
                            delta = json.delta?.text || '';
                        } else if (json.choices && json.choices[0].delta) {
                            const d = json.choices[0].delta;
                            if (d.reasoning_content !== undefined && d.reasoning_content !== null) {
                                delta = d.reasoning_content;
                                isThought = true;
                            } else if (d.content !== undefined && d.content !== null) {
                                delta = d.content;
                                isThought = false;
                            }
                        } else if (json.type === 'response.completed' && !assistantContent && json.response?.output) {
                            const out = json.response.output.find(o => o.type === 'message');
                            if (out) {
                                const content = out.content.find(c => c.type === 'output_text' || c.type === 'text');
                                delta = content?.text || '';
                            }
                        }

                        if (delta) {
                            let sendContent = '';
                            if (isThought) {
                                if (!lastWasThought) {
                                    sendContent += '<thought>';
                                    lastWasThought = true;
                                }
                                sendContent += delta;
                            } else {
                                if (lastWasThought) {
                                    sendContent += '</thought>';
                                    lastWasThought = false;
                                }
                                sendContent += delta;
                            }

                            if (sendContent) {
                                assistantContent += sendContent;
                                writeSse(JSON.stringify({ content: sendContent }));
                            }
                        }
                    } catch (e) {
                        // 忽略无效行
                    }
                }
            });

            response.data.on('end', async () => {
                try {
                    if (lastWasThought) {
                        const closeTag = '</thought>';
                        assistantContent += closeTag;
                        writeSse(JSON.stringify({ content: closeTag }));
                        lastWasThought = false;
                    }

                    const assistantTokens = (apiUsage && apiUsage.completion_tokens) 
                        ? apiUsage.completion_tokens 
                        : estimateTokens(assistantContent);
                    db.prepare('INSERT INTO messages (session_id, user_id, role, content, token_count, model_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
                      .run(sessionId, userId, 'assistant', assistantContent, assistantTokens, modelCfg.id, getBeijingTimestamp());

                    const msgCount = db.prepare('SELECT COUNT(*) as count FROM messages WHERE session_id = ?').get(sessionId).count;
                    if (msgCount <= 2) {
                        generateTitle(sessionId, visibleContent, assistantContent, modelCfg);
                    }

                    req.log.info({ length: assistantContent.length }, '生成结束');
                    writeSse('[DONE]');
                    res.end();
                    releaseSemaphore(); // 正常结束释放
                } catch (e) {
                    req.log.error({ err: e.message }, '流结束处理失败');
                    if (!res.writableEnded) {
                        writeSse(JSON.stringify({ error: '保存模型回复失败', detail: e.message }));
                        res.end();
                    }
                    releaseSemaphore(); // 报错释放
                }
            });

            response.data.on('error', err => {
                if (res.writableEnded) return; // 如果已经结束，忽略后续网络层错误
                
                if (err.code === 'ECONNRESET' || err.message.includes('aborted')) {
                    req.log.warn('流传输提醒: 连接被重置或中止，但可能已完成大部分接收');
                } else {
                    req.log.error({ err: err.message }, '流传输错误');
                }

                if (!res.writableEnded) {
                    writeSse(JSON.stringify({ error: '流传输中断', detail: err.message }));
                    res.end();
                }
                releaseSemaphore(); // 传输错误释放
            });

            req.on('close', () => {
                if (response.data && typeof response.data.destroy === 'function') response.data.destroy();
                releaseSemaphore(); // 客户端主动断开释放
            });
        } catch (e) {
            const errorData = e.response?.data;
            const statusCode = e.response?.status;

            req.log.error({ statusCode, err: e.message }, '模型响应错误');
            if (errorData) {
                if (typeof errorData.on === 'function') {
                    errorData.on('data', d => {
                        req.log.error({ streamError: d.toString() }, '模型流式报错详情');
                    });
                } else {
                    req.log.error({ errorData }, '模型报错详情');
                }
            }

            let safeDetail = e.message;
            if (errorData) {
                if (typeof errorData === 'string') {
                    safeDetail = errorData;
                } else if (typeof errorData.on === 'function') {
                    safeDetail = '上游服务返回了流式错误，请检查 API 配置或余额';
                } else {
                    try {
                        safeDetail = JSON.stringify(errorData);
                    } catch (jsonErr) {
                        safeDetail = '无法解析的错误对象';
                    }
                }
            }

            writeSse(JSON.stringify({
                error: '模型响应异常',
                detail: safeDetail,
                statusCode: statusCode
            }));
            res.end();
            releaseSemaphore(); // 捕获异常释放
        }
    }));

    return router;
}

module.exports = { createChatRouter };
