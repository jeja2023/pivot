/* 大模型对接逻辑 */
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { db } = require('./db');
const { getBeijingTimestamp } = require('./time');
const { extractDocumentText, truncateExtractedText } = require('./document-text');
const { imageFileToDataUrl, MAX_IMAGES_PER_MESSAGE } = require('./image-safety');

const THRESHOLD = parseInt(process.env.MEMORY_THRESHOLD) || 12000;

// 精确估算 Token (区分中英文加权)
function estimateTokens(text) {
    if (!text) return 0;
    const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
    const otherChars = text.length - chineseChars;
    // 中文平均 2 token/字，非中文平均 0.5 token/字符
    return Math.ceil(chineseChars * 2 + otherChars * 0.5);
}

// 获取并构建上下文 (支持动态模型配置)
async function getContext(sessionId, userId, modelCfg) {
    const session = db.prepare('SELECT system_prompt FROM sessions WHERE id = ?').get(sessionId);
    const messages = db.prepare(`
        SELECT * FROM messages 
        WHERE session_id = ? AND user_id = ? 
        ORDER BY id ASC
    `).all(sessionId, userId);

    const { logger } = require('./logger');
    logger.info({ sessionId, messageCount: messages.length }, '检索会话历史');

    const totalTokens = messages.reduce((sum, m) => sum + m.token_count, 0);
    let totalImageCount = 0;

    // 如果超过阈值且有足够消息，触发压缩
    if (totalTokens > THRESHOLD && messages.length > 8) {
        await compressMemory(sessionId, userId, messages, modelCfg);
        return await getContext(sessionId, userId, modelCfg); // 递归获取压缩后的结果
    }

    let history = await Promise.all(messages.map(async m => {
        let content = m.content;
        // 匹配图片: ![]() 或 附件: []()
        const imgRegex = /!\[.*?\]\((\/uploads\/[^)\s]+)\)/g;
        const fileRegex = /\[附件:\s*([^\]]+)\]\((\/uploads\/[^)\s]+)\)/g;
        
        let match;
        let finalContent = [];
        let lastIndex = 0;

        // 处理图片
        let imageCount = 0;
        while ((match = imgRegex.exec(content)) !== null) {
            if (match.index > lastIndex) {
                finalContent.push({ type: "text", text: content.slice(lastIndex, match.index) });
            }
            if (imageCount >= MAX_IMAGES_PER_MESSAGE) {
                finalContent.push({ type: "text", text: '[图片已跳过：数量超过限制]' });
                lastIndex = imgRegex.lastIndex;
                continue;
            }
            const cleanUrl = decodeURIComponent(match[1].split('?')[0]);
            const relativePath = cleanUrl.startsWith('/') ? cleanUrl.slice(1) : cleanUrl;
            const localPath = path.resolve(__dirname, '..', relativePath);
            if (fs.existsSync(localPath)) {
                const imageUrl = imageFileToDataUrl(localPath);
                if (imageUrl && totalImageCount < MAX_IMAGES_PER_MESSAGE) {
                    finalContent.push({ type: "image_url", image_url: { url: imageUrl } });
                    imageCount += 1;
                    totalImageCount += 1;
                } else {
                    finalContent.push({ type: "text", text: totalImageCount >= MAX_IMAGES_PER_MESSAGE ? '[图片已跳过：当前模型一次只支持解析 1 张图片]' : '[图片已跳过：文件过大或格式不支持]' });
                }
            } else {
                finalContent.push({ type: "text", text: match[0] });
            }
            lastIndex = imgRegex.lastIndex;
        }

        // 处理非图片附件 (PDF, TXT, MD, CSV)
        if (lastIndex === 0) { // 只有在没有处理图片的情况下才处理附件，或者可以合并逻辑
             // 重新重置索引，因为我们可能需要多次扫描或合并正则
             // 这里简单起见，我们重新遍历字符串处理附件
             let fileContent = content;
             let fileMatch;
             let fileFinalContent = [];
             let fileLastIndex = 0;

             while ((fileMatch = fileRegex.exec(fileContent)) !== null) {
                 if (fileMatch.index > fileLastIndex) {
                     fileFinalContent.push({ type: "text", text: fileContent.slice(fileLastIndex, fileMatch.index) });
                 }
                 const fileName = fileMatch[1];
                 const cleanUrl = decodeURIComponent(fileMatch[2].split('?')[0]);
                 const relativePath = cleanUrl.startsWith('/') ? cleanUrl.slice(1) : cleanUrl;
                 const localPath = path.resolve(__dirname, '..', relativePath);
                 
                 if (fs.existsSync(localPath)) {
                     try {
                         let text = truncateExtractedText(await extractDocumentText(localPath, '', fileName), 20000);

                         if (text) {
                             fileFinalContent.push({ type: "text", text: `\n\n--- 附件内容 (${fileName}) ---\n${text}\n--- 结束 ---\n\n` });
                         } else {
                             fileFinalContent.push({ type: "text", text: fileMatch[0] });
                         }
                     } catch (err) {
                         logger.error({ err: err.message, localPath }, '读取附件内容失败');
                         fileFinalContent.push({ type: "text", text: fileMatch[0] });
                     }
                 } else {
                     fileFinalContent.push({ type: "text", text: fileMatch[0] });
                 }
                 fileLastIndex = fileRegex.lastIndex;
             }
             if (fileLastIndex < fileContent.length) {
                 fileFinalContent.push({ type: "text", text: fileContent.slice(fileLastIndex) });
             }
             
             if (fileFinalContent.length > 0) {
                 finalContent = fileFinalContent;
                 lastIndex = fileContent.length;
             }
        }

        if (lastIndex < content.length) {
            finalContent.push({ type: "text", text: content.slice(lastIndex) });
        }

        if (finalContent.length === 1 && finalContent[0].type === "text") {
            finalContent = finalContent[0].text;
        } else if (finalContent.length === 0) {
            finalContent = content;
        }

        return { role: m.role, content: finalContent };
    }));

    if (session && session.system_prompt) {
        history.unshift({ role: 'system', content: session.system_prompt });
    }

    return history;
}

// 记忆压缩：使用当前模型总结旧消息
async function compressMemory(sessionId, userId, messages, modelCfg) {
    // 保留最后 6 条对话以维持即时上下文，其余压缩
    const toSummarize = messages.slice(0, -6);
    if (toSummarize.length < 4) return;

    const summaryPrompt = "你是一个记忆压缩专家。请将以下对话内容提炼为一段极简的摘要（300字以内），保留所有关键事实、决定和背景信息。输出必须直接开始摘要内容：\n\n" + 
                          toSummarize.map(m => `${m.role}: ${m.content}`).join('\n');

    try {
        const response = await axios.post(modelCfg.url, {
            model: modelCfg.model_name,
            messages: [{ role: 'system', content: '你负责将冗长的对话历史压缩为关键记忆片段。' }, { role: 'user', content: summaryPrompt }],
            stream: false
        }, {
            headers: { 'Authorization': modelCfg.api_key ? `Bearer ${modelCfg.api_key}` : undefined }
        });

        const summaryText = "【长期记忆摘要】： " + response.data.choices[0].message.content;

        const transaction = db.transaction(() => {
            // 删除被总结的消息 (使用参数化查询防御注入)
            const ids = toSummarize.filter(m => !m.is_summary).map(m => m.id);
            if (ids.length > 0) {
                const placeholders = ids.map(() => '?').join(',');
                db.prepare(`DELETE FROM messages WHERE id IN (${placeholders})`).run(...ids);
            }
            // 插入新的摘要作为系统记忆
            db.prepare('INSERT INTO messages (session_id, user_id, role, content, token_count, is_summary, model_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
              .run(sessionId, userId, 'system', summaryText, estimateTokens(summaryText), 1, modelCfg.id, getBeijingTimestamp());
        });
        transaction();
    } catch (e) {
        const { logger } = require('./logger');
        logger.error({ err: e.message }, '记忆压缩失败');
    }
}

module.exports = { estimateTokens, getContext, THRESHOLD };
