'use strict';

const { normalizePresentation } = require('./presentation-schema');
const { hasSensitiveContent } = require('../long-term-memory/memory-utils');

// 记忆治理规则覆盖常见凭据与证件格式；演示场景再补充中文字段标签，
// 避免“密码：***”这类面向展示的文本因 Unicode 单词边界而漏报。
const PRESENTATION_SENSITIVE_LABEL_RE = /(?:密码|密钥|令牌|访问令牌|授权码|API\s*(?:密钥|Key)|身份证(?:号)?|银行卡(?:号)?|手机号|手机号码)\s*[:：=]/i;

function hasPresentationSensitiveContent(value) {
    const text = String(value || '');
    return hasSensitiveContent(text) || PRESENTATION_SENSITIVE_LABEL_RE.test(text);
}

function makeIssue(level, code, slideId, elementId, message, suggestion) {
    return { level, code, slideId, elementId: elementId || null, message, suggestion: suggestion || '' };
}

function overlapArea(a, b) {
    const width = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
    const height = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
    return width * height;
}

function hexLuminance(color) {
    const hex = String(color || '#000000').replace('#', '');
    if (!/^[0-9a-f]{6}$/i.test(hex)) return 0;
    const channels = [0, 2, 4].map(index => Number.parseInt(hex.slice(index, index + 2), 16) / 255)
        .map(value => value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(foreground, background) {
    const fg = hexLuminance(foreground);
    const bg = hexLuminance(background);
    return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
}

function estimatedTextLines(element) {
    const text = String(element.content?.text || '');
    const charsPerLine = Math.max(4, Math.floor(element.width / Math.max(1, element.style.fontSize * 0.58)));
    return text.split('\n').reduce((total, line) => total + Math.max(1, Math.ceil(line.length / charsPerLine)), 0);
}

function runPresentationValidation(input) {
    const presentation = normalizePresentation(input);
    const issues = [];
    presentation.slides.forEach(slide => {
        if (!slide.elements.length) {
            issues.push(makeIssue('warning', 'EMPTY_SLIDE', slide.id, null, '页面为空。', '请添加内容或删除该页面。'));
        }
        const visible = slide.elements.filter(element => element.visible);
        const textElements = visible.filter(element => element.type === 'text');
        const hasTitle = textElements.some(element => element.style.fontSize >= 24 && String(element.content.text || '').trim());
        if (slide.type !== 'cover' && !hasTitle) {
            issues.push(makeIssue('info', 'TITLE_MISSING', slide.id, null, '页面缺少明显标题。', '建议添加标题以便观众理解当前页面重点。'));
        }
        if (slide.transition?.type && slide.transition.type !== 'none' && slide.transition.durationMs > 5000) {
            issues.push(makeIssue('warning', 'TRANSITION_TOO_LONG', slide.id, null, '页面转场时间过长。', '建议将转场控制在 5 秒以内。'));
        }
        visible.forEach(element => {
            if (element.type === 'text') {
                const lines = estimatedTextLines(element);
                const requiredHeight = lines * element.style.fontSize * element.style.lineHeight + element.style.padding * 2;
                if (requiredHeight > element.height + 2) {
                    issues.push(makeIssue('blocking', 'TEXT_OVERFLOW', slide.id, element.id, '文本可能超出文本框边界。', '请缩短文本、增加文本框高度或减小字号。'));
                }
                if (element.style.fontSize < 12) {
                    issues.push(makeIssue('warning', 'TEXT_TOO_SMALL', slide.id, element.id, '字号低于 12px，可读性较弱。', '建议将正文字号调整到 16px 以上。'));
                }
                if (/\b(?:xxx|todo|tbd)\b|请填写|待补充|\[.*?\]|【.*?】/i.test(String(element.content.text || ''))) {
                    issues.push(makeIssue('warning', 'PLACEHOLDER_REMAINS', slide.id, element.id, '页面仍包含待替换占位内容。', '请在导出前补全占位内容。'));
                }
                if (!slide.background.imageAssetRef && contrastRatio(element.style.color, slide.background.fill) < 3) {
                    issues.push(makeIssue('warning', 'LOW_CONTRAST', slide.id, element.id, '文字与背景对比度不足。', '请调整文字颜色或背景色以增强可读性。'));
                }
            }
            if (element.type === 'image' && !element.assetRef) {
                issues.push(makeIssue('blocking', 'IMAGE_MISSING', slide.id, element.id, '图片素材缺失。', '请重新上传或替换图片。'));
            }
            if (element.type === 'media' && !element.assetRef) {
                issues.push(makeIssue('blocking', 'MEDIA_MISSING', slide.id, element.id, '音视频素材缺失。', '请重新上传或替换媒体。'));
            }
            if (element.type === 'attachment' && !element.assetRef) {
                issues.push(makeIssue('blocking', 'ATTACHMENT_MISSING', slide.id, element.id, '附件素材缺失。', '请重新上传或替换附件。'));
            }
            if (element.type === 'diagram' && (element.items || []).length < 2) {
                issues.push(makeIssue('blocking', 'DIAGRAM_INVALID', slide.id, element.id, '图示节点不足。', '请至少保留两个图示节点。'));
            }
            if (element.animation?.type !== 'none' && element.animation.durationMs > 5000) {
                issues.push(makeIssue('warning', 'ANIMATION_TOO_LONG', slide.id, element.id, '元素动画时间过长，可能影响演示节奏。', '建议将单个元素动画控制在 5 秒以内。'));
            }
            const contentText = element.type === 'text'
                ? element.content?.text
                : element.type === 'table' ? [element.columns, ...element.rows].flat().join('\n') : '';
            if (contentText && hasPresentationSensitiveContent(contentText)) {
                issues.push(makeIssue('warning', 'SENSITIVE_CONTENT', slide.id, element.id, '页面可能包含敏感信息。', '请在导出或共享前人工核对并删除不应展示的内容。'));
            }
        });
        if (slide.speakerNotes && hasPresentationSensitiveContent(slide.speakerNotes)) {
            issues.push(makeIssue('warning', 'SENSITIVE_NOTES', slide.id, null, '演讲者备注可能包含敏感信息。', '请在导出含备注的文件前人工核对。'));
        }
        for (let first = 0; first < visible.length; first += 1) {
            for (let second = first + 1; second < visible.length; second += 1) {
                const a = visible[first];
                const b = visible[second];
                if (a.type === 'shape' && a.zIndex < b.zIndex) continue;
                const area = overlapArea(a, b);
                const smaller = Math.min(a.width * a.height, b.width * b.height);
                if (smaller > 0 && area / smaller > 0.45) {
                    issues.push(makeIssue('warning', 'ELEMENT_OVERLAP', slide.id, `${a.id},${b.id}`, '两个页面元素存在大面积重叠。', '请检查是否需要调整元素位置或层级。'));
                }
            }
        }
        if (textElements.reduce((count, element) => count + String(element.content.text || '').length, 0) > 1800) {
            issues.push(makeIssue('warning', 'CONTENT_DENSE', slide.id, null, '页面文字较多，可能不适合现场演示。', '建议提炼为要点或拆分为两页。'));
        }
    });
    const blocking = issues.filter(issue => issue.level === 'blocking').length;
    const warnings = issues.filter(issue => issue.level === 'warning').length;
    return {
        status: blocking ? 'blocked' : warnings ? 'warning' : 'passed',
        summary: { slides: presentation.slides.length, blocking, warnings, info: issues.length - blocking - warnings },
        issues
    };
}

module.exports = { runPresentationValidation };
