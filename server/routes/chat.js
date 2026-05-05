/* 对话接口路由 Chat API Routes */
const axios = require('axios');
const http = require('http');
const https = require('https');
const express = require('express');
const fs = require('fs');
const path = require('path');
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
const {
    acquireModelSlot,
    recordModelSuccess,
    recordModelFailure
} = require('../services/model-runtime');
const { imageFileToDataUrl, MAX_IMAGES_PER_MESSAGE } = require('../image-safety');

const httpAgent = new http.Agent({ keepAlive: true });
const httpsAgent = new https.Agent({ keepAlive: true });

function getRequestOrigin(req, publicUrl = '') {
    if (publicUrl) return publicUrl;
    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    return host ? `${proto}://${host}` : '';
}

function getImageDataUrl(uploadUrl) {
    const cleanUrl = String(uploadUrl || '').split('?')[0];
    const decodedUrl = decodeURIComponent(cleanUrl);
    if (!decodedUrl.startsWith('/uploads/')) return null;

    const uploadRoot = path.resolve(__dirname, '../../uploads');
    const relativePath = decodedUrl.replace(/^\/uploads\//, '');
    const target = path.resolve(uploadRoot, relativePath);
    if (!target.startsWith(uploadRoot + path.sep) || !fs.existsSync(target)) return null;

    return imageFileToDataUrl(target);
}

function buildVisionHistory(history, origin) {
    if (!origin) return history;
    const imageMarkdown = /!\[([^\]]*)\]\((\/uploads\/[^)\s]+)\)/g;
    return history.map(message => {
        if (message.role !== 'user' || typeof message.content !== 'string' || !message.content.includes('/uploads/')) {
            return message;
        }

        const imageParts = [];
        const text = message.content.replace(imageMarkdown, (match, alt, url) => {
            if (imageParts.length >= MAX_IMAGES_PER_MESSAGE) {
                return alt ? `[图片已跳过: ${alt}]` : '[图片已跳过]';
            }
            const imageUrl = getImageDataUrl(url) || new URL(url, origin).toString();
            imageParts.push({
                type: 'image_url',
                image_url: {
                    url: imageUrl
                }
            });
            return alt ? `[图片: ${alt}]` : '[图片]';
        }).trim();

        if (imageParts.length === 0) return message;
        return {
            ...message,
            content: [
                { type: 'text', text: text || '请分析这张图片。' },
                ...imageParts
            ]
        };
    });
}

function limitVisionImages(history) {
    let usedImages = 0;
    return history.map(message => {
        if (!Array.isArray(message.content)) return message;
        const content = [];
        for (const part of message.content) {
            if (part?.type === 'image_url') {
                if (usedImages >= MAX_IMAGES_PER_MESSAGE) {
                    content.push({ type: 'text', text: '[图片已跳过：当前模型一次只支持解析 1 张图片]' });
                    continue;
                }
                usedImages += 1;
            }
            content.push(part);
        }
        return { ...message, content };
    });
}

async function generateTitle(sessionId, userMsg, aiMsg, modelCfg) {
    try {
        logger.info({ sessionId }, '正在生成会话标题');
        let baseUrl = modelCfg.url.trim().replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
        if (!baseUrl.includes('/v1') && !baseUrl.includes('localhost') && !baseUrl.includes('127.0.0.1')) {
            baseUrl += '/v1';
        }
        const targetUrl = baseUrl + '/chat/completions';

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
            timeout: 60000,
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
    isRagEnabled,
    publicUrl = ''
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
        const { content, displayContent, regenerate } = req.body;
        const sessionId = String(req.body.sessionId || '').trim();
        const modelId = req.body.modelId ? parseInt(req.body.modelId) : null;
        const userId = req.user.id;
        const modelContent = String(content || '').trim();
        const visibleContent = String(displayContent || modelContent).trim();

        req.log.info({ sessionId, userId, modelId, regenerate, contentLength: modelContent.length }, '处理对话请求');

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
            try {
                const userTokens = estimateTokens(modelContent);
                const info = db.prepare('INSERT INTO messages (session_id, user_id, role, content, token_count, model_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
                  .run(sessionId, userId, 'user', modelContent, userTokens, modelCfg.id, getBeijingTimestamp());
                req.log.info({ sessionId, changes: info.changes }, '已插入用户消息');
            } catch (dbErr) {
                req.log.error({ sessionId, err: dbErr.message }, '用户消息入库失败');
                return res.status(500).json({ error: '消息保存失败，请稍后重试' });
            }
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
        let endpointRelease = null;
        const requestStartedAt = Date.now();
        try {
            endpointRelease = await acquireModelSlot(modelCfg);
        } catch (e) {
            aiSemaphore.release();
            const message = e.message || '模型端点当前繁忙，请稍后重试。';
            logAction(req, '模型端点繁忙', `${message} 会话: ${sessionId}`);
            return res.status(e.statusCode || 503).json({
                error: message,
                code: e.code || 'AI_ENDPOINT_OVERLOADED',
                retryable: true
            });
        }
        const releaseSemaphore = () => {
            if (!semaphoreReleased) {
                if (endpointRelease) endpointRelease();
                aiSemaphore.release();
                semaphoreReleased = true;
            }
        };

        let history = await getContext(sessionId, userId, modelCfg);
        if (typeof retrieveContext === 'function' && typeof isRagEnabled === 'function' && isRagEnabled()) {
            const ragContext = await retrieveContext(userId, modelContent);
            if (ragContext) {
                history.push({ role: 'system', content: ragContext });
            }
        }
        let visionHistory = limitVisionImages(buildVisionHistory(history, getRequestOrigin(req, publicUrl)));
        
        if (visionHistory.length === 0) {
            req.log.warn({ sessionId, userId }, '检测到空的消息历史，尝试补救');
            // 如果历史为空，至少把当前消息塞进去（如果是刚发送的消息）
            if (modelContent) {
                req.log.info({ sessionId }, '执行补救措施：将丢失的用户消息存入数据库并加入当前上下文');
                // 补救的消息需要存入数据库
                const userTokens = estimateTokens(modelContent);
                try {
                    db.prepare('INSERT INTO messages (session_id, user_id, role, content, token_count, model_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
                      .run(sessionId, userId, 'user', modelContent, userTokens, modelId, getBeijingTimestamp());
                } catch (dbErr) {
                    req.log.error({ err: dbErr.message }, '补救消息入库失败');
                }

                // 补救的消息也需要经过 buildVisionHistory 处理以支持多模态
                const rescuedHistory = limitVisionImages(buildVisionHistory([{ role: 'user', content: modelContent }], getRequestOrigin(req, publicUrl)));
                visionHistory.push(...rescuedHistory);
            } else {
                releaseSemaphore();
                return res.status(400).json({ error: '对话内容不能为空' });
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

            // 将 Chat Completions 格式转换为 Responses API 格式
            const responsesHistory = visionHistory.map(msg => {
                // system 角色在 Responses API 中需要转为 developer 或 user
                let role = msg.role;
                let content = msg.content;

                if (role === 'system') {
                    role = 'user';
                    // 如果 content 是字符串，添加系统设定前缀
                    if (typeof content === 'string') {
                        content = `[系统设定]: ${content}`;
                    }
                }

                // 如果 content 是数组（多模态），转换为 Responses API 格式
                if (Array.isArray(content)) {
                    content = content.map(part => {
                        if (part.type === 'image_url' && part.image_url?.url) {
                            // Responses API 使用 input_image 类型
                            return {
                                type: 'input_image',
                                image_url: part.image_url.url
                            };
                        }
                        return part;
                    });
                }

                return { role, content };
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
                // 记录多模态内容的结构信息
                const inputSummary = responsesHistory.map(m => ({
                    role: m.role,
                    contentType: Array.isArray(m.content) ? m.content.map(p => p.type).join('+') : 'text'
                }));
                req.log.info({ inputSummary }, '请求体结构');
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
                        requestData.messages = visionHistory;
                        
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
                requestData.messages = visionHistory;
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
                    recordModelSuccess(modelCfg, Date.now() - requestStartedAt);
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
                recordModelFailure(modelCfg, err);
                releaseSemaphore(); // 传输错误释放
            });

            req.on('close', () => {
                if (response.data && typeof response.data.destroy === 'function') response.data.destroy();
                releaseSemaphore(); // 客户端主动断开释放
            });
        } catch (e) {
            const errorData = e.response?.data;
            const statusCode = e.response?.status;
            recordModelFailure(modelCfg, e);

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
