/* 大模型对接逻辑 */
const axios = require('axios');
const db = require('./db');
const { getBeijingTimestamp } = require('./time');

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
        ORDER BY created_at ASC
    `).all(sessionId, userId);

    const totalTokens = messages.reduce((sum, m) => sum + m.token_count, 0);

    // 如果超过阈值且有足够消息，触发压缩
    if (totalTokens > THRESHOLD && messages.length > 8) {
        await compressMemory(sessionId, userId, messages, modelCfg);
        return getContext(sessionId, userId, modelCfg); // 递归获取压缩后的结果
    }

    const fs = require('fs');
    const path = require('path');

    let history = messages.map(m => {
        let content = m.content;
        const imgRegex = /!\[.*?\]\((\/uploads\/.*?)\)/g;
        let match;
        let finalContent = [];
        let lastIndex = 0;

        while ((match = imgRegex.exec(content)) !== null) {
            if (match.index > lastIndex) {
                finalContent.push({ type: "text", text: content.slice(lastIndex, match.index) });
            }
            const localPath = path.join(__dirname, '..', match[1]);
            if (fs.existsSync(localPath)) {
                const base64 = fs.readFileSync(localPath, 'base64');
                const ext = path.extname(localPath).slice(1) || 'jpeg';
                // 使用行业标准的多模态 Payload 格式
                finalContent.push({ type: "image_url", image_url: { url: `data:image/${ext};base64,${base64}` } });
            }
            lastIndex = imgRegex.lastIndex;
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
    });

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
        console.error('Open WebUI 记忆压缩失败:', e.message);
    }
}

// 新增：LLM 驱动的自动标题生成
async function generateTitle(sessionId, userMsg, aiMsg, modelCfg) {
    try {
        const prompt = `请根据这段对话内容生成一个极其简短的标题（5个字以内）。直接输出标题，不要包含标点：\n用户：${userMsg}\n助手：${aiMsg}`;
        const response = await axios.post(modelCfg.url, {
            model: modelCfg.model_name,
            messages: [{ role: 'user', content: prompt }],
            stream: false
        }, {
            headers: { 'Authorization': modelCfg.api_key ? `Bearer ${modelCfg.api_key}` : undefined }
        });
        const title = response.data.choices[0].message.content.replace(/["'#。！？]/g, '').trim();
        if (title && title.length < 20) {
            db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run(title, sessionId);
            return title;
        }
    } catch (e) { console.error('自动标题生成失败'); }
    return null;
}

module.exports = { estimateTokens, getContext, generateTitle, THRESHOLD };
