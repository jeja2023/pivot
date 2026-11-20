'use strict';

function taskDisplayTitle(value, fallback = '对话任务') {
    const text = String(value || '').split(/\n---\s*\n【参考文档/)[0]
        .replace(/!?\[([^\]]*)\]\(\/(?:uploads|downloads)\/[^\n)]*(?:\)|$)/g, '$1')
        .replace(/\/(?:uploads|downloads)\/[^\s<>"\n]+/g, '')
        .replace(/(?:[A-Za-z]:[\\/]|\\\\)[^\r\n<>"|]+/g, '')
        .replace(/\/(?:home|root|Users|tmp|var|srv|opt|mnt)\/[^\s<>"']+/g, '')
        .replace(/\s+/g, ' ').trim();
    return (text || fallback).slice(0, 160);
}

function requestedPresentationFormats(value = '') {
    const text = String(value).split(/\n---\s*\n【参考文档/)[0];
    const create = /(?:生成|制作|创建|做|输出|交付|导出|转成|转换为|转为|create|generate|make|export)[^。！？\n；;]{0,30}(?:\b(?:pptx?|powerpoint)\b|幻灯片|演示文稿)/i.test(text);
    const otherOnly = /(?:只(?:要|需|生成|输出|导出)|仅(?:需|要|生成|输出|导出))[^。！？\n]{0,14}\b(?:svg|png|pdf)\b/i.test(text);
    return create && !otherOnly && !/(?:不要|不用|无需|不生成).{0,8}(?:PPTX?|PowerPoint)/i.test(text) ? ['pptx'] : [];
}

function requestedDeliveryFormats(value = '') {
    const text = require('./chat-request-constraints').currentRequestText(value);
    const create = /(?:生成|制作|创建|输出|交付|导出|下载|保存|转成|转换为|create|generate|make|deliver|export|download)[^。！？\n；;，,]{0,60}/giu;
    const candidates = ['pdf', 'docx', 'xlsx', 'csv', 'svg', 'png', 'html'];
    const clauses = [...text.matchAll(create)].map(match => match[0]);
    const formats = candidates.filter(format => {
        const name = new RegExp('\\b' + format + '\\b', 'iu');
        const excluded = new RegExp('(?:不要|不用|无需|禁止|不需要|不必|不|without\\s+|no\\s+)(?:(?:生成|输出|导出|交付|下载|制作|提供|使用|\\s)){0,3}' + format + '\\b', 'iu');
        return clauses.some(clause => name.test(clause) && !/(?:参考|依据|基于|读取|使用|附件|原文|来源)\s*\b(?:pdf|docx|xlsx|csv|svg|png|html)\b/iu.test(clause)) && !excluded.test(text);
    });
    return [...requestedPresentationFormats(text), ...formats];
}

module.exports = { taskDisplayTitle, requestedPresentationFormats, requestedDeliveryFormats };
