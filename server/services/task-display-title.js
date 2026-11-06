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

module.exports = { taskDisplayTitle, requestedPresentationFormats };
