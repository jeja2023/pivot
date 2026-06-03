const { db } = require('../db');
const { imageFileToDataUrl, MAX_IMAGES_PER_MESSAGE } = require('../image-safety');
const { resolveUploadUrlPath, toProjectRelativePath } = require('../security');

async function getImageDataUrl(uploadUrl, userId, sessionId) {
    const target = resolveUploadUrlPath(uploadUrl);
    const filePath = target ? toProjectRelativePath(target) : '';
    if (!filePath) return null;
    const attachment = db.prepare(`
        SELECT id FROM attachments
        WHERE user_id = ? AND session_id = ? AND file_path = ?
          AND deleted_at IS NULL
    `).get(userId, sessionId, filePath);
    if (!attachment) return null;
    return imageFileToDataUrl(target);
}

async function buildVisionHistory(history, origin, userId, sessionId) {
    if (!origin) return history;
    const uploadUrlPattern = String.raw`\/uploads\/(?:[^()]|\([^)]*\))+`;
    const imageMarkdown = new RegExp(String.raw`!\[([^\]]*)\]\((${uploadUrlPattern})\)`, 'g');
    const nextHistory = [];
    for (const message of history) {
        if (message.role !== 'user' || typeof message.content !== 'string' || !message.content.includes('/uploads/')) {
            nextHistory.push(message);
            continue;
        }

        const imageParts = [];
        let text = '';
        let lastIndex = 0;
        let match;
        while ((match = imageMarkdown.exec(message.content)) !== null) {
            const [, alt, url] = match;
            text += message.content.slice(lastIndex, match.index);
            lastIndex = imageMarkdown.lastIndex;
            if (imageParts.length >= MAX_IMAGES_PER_MESSAGE) {
                text += alt ? `[图片已跳过: ${alt}]` : '[图片已跳过]';
                continue;
            }
            const imageUrl = await getImageDataUrl(url, userId, sessionId);
            if (!imageUrl) {
                text += alt ? `[图片不可用: ${alt}]` : '[图片不可用]';
                continue;
            }
            imageParts.push({
                type: 'image_url',
                image_url: {
                    url: imageUrl
                }
            });
            text += alt ? `[图片: ${alt}]` : '[图片]';
        }
        text += message.content.slice(lastIndex);
        text = text.trim();

        if (imageParts.length === 0) {
            nextHistory.push(message);
            continue;
        }
        nextHistory.push({
            ...message,
            content: [
                { type: 'text', text: text || '请分析这张图片。' },
                ...imageParts
            ]
        });
    }
    return nextHistory;
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

function buildVisionUnsupportedMessage(modelCfg) {
    const name = modelCfg?.name || modelCfg?.model_name || '当前模型';
    return `${name} 未配置视觉输入能力，不能处理图片或扫描件内容。请切换到已开启“视觉输入（图片/扫描件）”的模型，或联系管理员在模型配置中启用该能力。普通文档会先抽取文本，不受此限制。`;
}

module.exports = {
    buildVisionHistory,
    buildVisionUnsupportedMessage,
    limitVisionImages
};
