'use strict';

const { getAppSettingValue } = require('../../app-settings');
const { DOCUMENT_PROCESSING_SETTING_KEYS, OCR_MODES, normalizeOcrServiceUrl } = require('../constants');

const VL_ENGINE = 'paddleocr-vl';
const MAX_VL_MARKDOWN_BYTES = 128 * 1024;
const LAYOUT_TAG = /^<(\/?)(table|thead|tbody|tfoot|tr|th|td|caption|br|sup|sub|p|strong|em|b|i)(?=[\s/>])/i;
const CELL_SPAN = /\s(rowspan|colspan)\s*=\s*(?:"(\d{1,3})"|'(\d{1,3})'|(\d{1,3}))(?=\s|\/?>)/gi;

function getOcrVlServiceUrl() {
    const value = String(getAppSettingValue(DOCUMENT_PROCESSING_SETTING_KEYS.vlServiceUrl) || process.env.OCR_VL_SERVICE_URL || '').trim();
    try {
        return value ? normalizeOcrServiceUrl(value) : '';
    } catch (_) {
        return '';
    }
}

function requireOcrVlServiceUrl() {
    const url = getOcrVlServiceUrl();
    if (url) return url;
    const error = new Error('文档解析（VL）服务尚未配置，请联系管理员。');
    error.code = 'OCR_VL_NOT_CONFIGURED';
    error.status = 503;
    throw error;
}

function assertMarkdownSize(markdown) {
    if (Buffer.byteLength(markdown, 'utf8') <= MAX_VL_MARKDOWN_BYTES) return;
    const error = new Error('单页 VL 排版结果超过大小限制，请拆分原页后重试。');
    error.code = 'OCR_VL_RESULT_TOO_LARGE';
    throw error;
}

function normalizeVlResult(data) {
    if (data?.raw?.engine !== VL_ENGINE || typeof data.raw.markdown !== 'string') {
        const error = new Error('外部服务未返回 PaddleOCR-VL 文档解析结果，请检查 VL 服务地址和版本。');
        error.code = 'OCR_VL_INVALID_RESULT';
        throw error;
    }
    const source = data.raw.markdown.trim();
    assertMarkdownSize(source);
    // 原始输出可能包含文件路径或 HTML 属性；只保留排版标签和数字形式的表格合并属性。
    const markdown = source.replace(/<(?=[A-Za-z!?/])[^<>]*>/g, html => {
        const tag = LAYOUT_TAG.exec(html);
        if (!tag) return `&lt;${html.slice(1).replace(/>/g, '&gt;')}`;
        const name = tag[2].toLowerCase();
        if (tag[1]) return `</${name}>`;
        if (name !== 'td' && name !== 'th') return `<${name}>`;
        const spans = new Map(Array.from(html.matchAll(CELL_SPAN), ([, key, quoted, single, unquoted]) => [key.toLowerCase(), quoted || single || unquoted]));
        return `<${name}${Array.from(spans, ([key, value]) => ` ${key}="${value}"`).join('')}>`;
    });
    assertMarkdownSize(markdown);
    return { ocrMode: OCR_MODES.VL, markdown };
}

module.exports = { VL_ENGINE, getOcrVlServiceUrl, normalizeVlResult, requireOcrVlServiceUrl };
