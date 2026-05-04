/* 对话接口路由 Chat API Routes */
const axios = require('axios');
const express = require('express');
const { StringDecoder } = require('string_decoder');
const db = require('../db');
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

async function generateTitle(sessionId, userMsg, aiMsg, modelCfg) {
    try {
        console.log(`[标题生成] 正在为会话 ${sessionId} 生成标题...`);
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
            timeout: 10000,
            proxy: false
        });

        const newTitle = response.data.choices[0]?.message?.content?.trim() || '新对话';
        db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run(newTitle, sessionId);
        console.log(`[标题生成] 已更新标题: ${newTitle}`);
    } catch (e) {
        console.error(`[标题生成] 失败: ${e.message}`);
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

    router.post('/chat/stats', authMiddleware, (req, res) => {
        const { sessionId, costTime, tps } = req.body;
        const userId = req.user.id;

        try {
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
        } catch (e) {
            res.status(500).json({ error: '更新指标失败' });
        }
    });

    router.post('/chat', authMiddleware, chatLimiter, async (req, res) => {
        const { sessionId, content, displayContent, modelId } = req.body;
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

        const userTokens = estimateTokens(modelContent);
        db.prepare('INSERT INTO messages (session_id, user_id, role, content, token_count, model_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(sessionId, userId, 'user', visibleContent, userTokens, modelCfg.id, getBeijingTimestamp());

        logAction(req, '发送消息', `发送消息到会话: ${sessionId}`);

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

        console.log(`\n[对话请求] 用户ID: ${userId} | 目标模型: ${modelCfg.name} (${modelName})`);
        console.log(`[目标URL] ${targetUrl}`);
        console.log(`[API模式] ${isResponsesApi ? 'Responses API' : 'Chat Completions API'}`);

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

            if (isResponsesApi) {
                console.log('[请求状态] 正在建立连接 (Responses API, 流式)...');
                try {
                    response = await axios({
                        method: 'post', url: targetUrl, headers,
                        data: { model: modelName, input: responsesHistory, stream: true },
                        responseType: 'stream', timeout: 180000, proxy: false
                    });
                    console.log('[请求状态] 连接成功 (Responses API)');
                } catch (err) {
                    const status = err.response?.status;
                    if ([404, 405, 502, 503].includes(status)) {
                        console.warn(`[API 降级] Responses API 暂不可用 (${status})，正在自动回退到常规接口...`);
                        targetUrl = baseUrl.replace(/\/+$/, '');
                        if (!targetUrl.endsWith('/chat/completions')) targetUrl += '/chat/completions';
                        response = await axios({
                            method: 'post', url: targetUrl, headers,
                            data: { model: modelName, messages: history, stream: true },
                            responseType: 'stream', timeout: 90000, proxy: false
                        });
                        console.log('[请求状态] 降级连接成功 (Chat Completions)');
                    } else {
                        throw err;
                    }
                }
            } else {
                console.log('[请求状态] 正在建立连接 (Chat Completions API, 流式)...');
                response = await axios({
                    method: 'post', url: targetUrl, headers,
                    data: { model: modelName, messages: history, stream: true },
                    responseType: 'stream', timeout: 90000, proxy: false
                });
                console.log('[请求状态] 连接成功');
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

                    console.log(`[请求状态] 生成结束，字数: ${assistantContent.length}`);
                    writeSse('[DONE]');
                    res.end();
                } catch (e) {
                    console.error('[流结束处理失败]', e);
                    if (!res.writableEnded) {
                        writeSse(JSON.stringify({ error: '保存模型回复失败', detail: e.message }));
                        res.end();
                    }
                }
            });

            response.data.on('error', err => {
                console.error('[流传输错误]', err);
                if (!res.writableEnded) {
                    writeSse(JSON.stringify({ error: '流传输中断', detail: err.message }));
                    res.end();
                }
            });

            req.on('close', () => {
                if (response.data && typeof response.data.destroy === 'function') response.data.destroy();
            });
        } catch (e) {
            const errorData = e.response?.data;
            const statusCode = e.response?.status;

            console.error(`\n[模型响应错误] 状态码: ${statusCode}`);
            if (errorData) {
                if (typeof errorData.on === 'function') {
                    errorData.on('data', d => {
                        const msg = d.toString();
                        console.error(`[报错详情 (Stream)]: ${msg}`);
                    });
                } else {
                    console.error('[报错详情]:', JSON.stringify(errorData, null, 2));
                }
            } else {
                console.error(`[错误简述]: ${e.message}`);
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
        }
    });

    return router;
}

module.exports = { createChatRouter };
