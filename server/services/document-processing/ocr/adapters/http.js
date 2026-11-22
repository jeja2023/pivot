const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { assertSafeOutboundHost, createSafeHttpAgents, isLoopbackHost } = require('../../../../security');
const { getAppSettingValue } = require('../../../app-settings');
const {
    DEFAULT_OCR_SERVICE_URL,
    DOCUMENT_PROCESSING_SETTING_KEYS,
    OCR_MODES,
    normalizeOcrServiceUrl
} = require('../../constants');
const { buildRecognitionResult } = require('./shared');
const { VL_ENGINE, getOcrVlServiceUrl, normalizeVlResult, requireOcrVlServiceUrl } = require('../vl');
const { readTypedEnv } = require('../../../../config/env-registry');

function getServiceUrl() {
    return normalizeOcrServiceUrl(getAppSettingValue(DOCUMENT_PROCESSING_SETTING_KEYS.serviceUrl) || process.env.OCR_SERVICE_URL || DEFAULT_OCR_SERVICE_URL);
}

const DEFAULT_MAX_IMAGE_BYTES = 50 * 1024 * 1024;
const MAX_OCR_BLOCKS = readTypedEnv('OCR_SERVICE_MAX_BLOCKS');

function formatBytes(value) {
    const size = Number(value || 0);
    if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
    if (size >= 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${size} B`;
}

function getMaxImageBytes() {
    const value = Number.parseInt(process.env.OCR_SERVICE_MAX_IMAGE_BYTES || String(DEFAULT_MAX_IMAGE_BYTES), 10);
    return Math.min(Math.max(Number.isFinite(value) ? value : DEFAULT_MAX_IMAGE_BYTES, 1), 200 * 1024 * 1024);
}

function assertImageWithinLimit(size, maxImageBytes) {
    if (size <= maxImageBytes) return;
    const error = new Error(`OCR 页面图片超过外部服务请求上限（${formatBytes(maxImageBytes)}），请降低 DPI 或拆分文件后重试。`);
    error.code = 'OCR_IMAGE_TOO_LARGE';
    throw error;
}

function getTimeoutMs(options = {}) {
    const value = Number.parseInt(options.timeoutMs || process.env.DOCUMENT_PROCESSING_OCR_TIMEOUT_MS || process.env.OCR_SERVICE_TIMEOUT_MS || '120000', 10);
    return Math.min(Math.max(Number.isFinite(value) ? value : 120000, 5000), 600000);
}

function normalizeLanguage(options = {}) {
    return String(options.language || process.env.OCR_SERVICE_LANG || 'ch').trim() || 'ch';
}

async function buildSafeOcrRequestOptions(baseUrl, { timeoutMs, maxContentLength, useVl, serviceOverride }) {
    const { hostname } = new URL(baseUrl);
    const settingKey = useVl ? DOCUMENT_PROCESSING_SETTING_KEYS.vlServiceUrl : DOCUMENT_PROCESSING_SETTING_KEYS.serviceUrl;
    const blockPrivate = process.env.ALLOW_PRIVATE_MODEL_URLS === 'false' && Boolean(serviceOverride || getAppSettingValue(settingKey));
    const outboundOptions = { blockPrivate, allowExplicitLoopback: !blockPrivate && isLoopbackHost(hostname) };
    await assertSafeOutboundHost(hostname, outboundOptions);
    return {
        timeout: timeoutMs,
        maxContentLength,
        proxy: false,
        ...createSafeHttpAgents(outboundOptions)
    };
}

function getHealthTimeoutMs() {
    const value = Number.parseInt(process.env.OCR_SERVICE_HEALTH_TIMEOUT_MS || '3000', 10);
    return Math.min(Math.max(Number.isFinite(value) ? value : 3000, 1000), 30000);
}

function normalizeHttpError(error, serviceUrl = '') {
    const data = error?.response?.data;
    if (typeof data === 'string' && data.trim()) return data.trim();
    if (data?.detail) {
        if (typeof data.detail === 'string') return data.detail;
        if (data.detail?.error) return String(data.detail.error);
        return JSON.stringify(data.detail).slice(0, 500);
    }
    if (data?.error) return String(data.error);
    if (error?.code === 'ECONNREFUSED') return serviceUrl ? `外部 OCR 服务连接失败：${serviceUrl}` : '外部 OCR 服务连接失败';
    if (error?.code === 'ETIMEDOUT' || error?.code === 'ECONNABORTED') return '外部 OCR 服务请求超时';
    return String(error?.message || '外部 OCR 服务调用失败').split('\n')[0].slice(0, 500);
}

function normalizeBlocks(data) {
    const blocks = Array.isArray(data?.blocks) ? data.blocks : [];
    if (blocks.length > MAX_OCR_BLOCKS) {
        const error = new Error(`OCR 服务返回的文字块数量超过 ${MAX_OCR_BLOCKS} 个限制。`);
        error.code = 'OCR_RESULT_TOO_LARGE';
        throw error;
    }
    if (blocks.length > 0) {
        return blocks.map((block, index) => ({
            ...block,
            engine: 'http',
            sortOrder: Number.isFinite(Number(block?.sortOrder)) ? Number(block.sortOrder) : index
        }));
    }
    return String(data?.text || '')
        .split(/\r?\n/)
        .map((text, index) => ({ text: text.trim(), confidence: data?.confidence ?? null, bbox: [], sortOrder: index, engine: 'http' }))
        .filter(block => block.text);
}

async function recognizePage(imagePath, options = {}) {
    const useVl = options.ocrMode === OCR_MODES.VL;
    const serviceUrl = useVl ? requireOcrVlServiceUrl() : getServiceUrl();
    const language = normalizeLanguage(options);
    const timeoutMs = getTimeoutMs(options);
    const maxImageBytes = getMaxImageBytes();
    const stat = await fs.promises.stat(imagePath);
    assertImageWithinLimit(stat.size, maxImageBytes);
    const buffer = await fs.promises.readFile(imagePath);
    assertImageWithinLimit(buffer.length, maxImageBytes);
    const requestBodyMaxBytes = Math.ceil(maxImageBytes * 1.5) + 65536;
    const responseMaxBytes = Math.min(Math.max(Number.parseInt(process.env.OCR_SERVICE_MAX_RESPONSE_BYTES || String(16 * 1024 * 1024), 10) || 16 * 1024 * 1024, 1024 * 1024), 128 * 1024 * 1024);
    try {
        const requestOptions = await buildSafeOcrRequestOptions(serviceUrl, { timeoutMs: timeoutMs + 5000, maxContentLength: responseMaxBytes, useVl });
        const response = await axios.post(`${serviceUrl}/ocr`, {
            imageBase64: buffer.toString('base64'),
            fileName: path.basename(imagePath),
            language,
            timeoutMs,
            ...(useVl ? { engine: VL_ENGINE } : {})
        }, {
            ...requestOptions,
            ...(useVl ? { maxRedirects: 0 } : {}),
            maxBodyLength: requestBodyMaxBytes,
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json'
            },
            signal: options.signal || null,
            validateStatus: status => status >= 200 && status < 300
        });
        const normalized = normalizeBlocks(response.data);
        const structured = useVl ? normalizeVlResult(response.data) : {};
        return { ...buildRecognitionResult({
            blocks: normalized,
            engine: 'http',
            language: response.data?.language || language,
            tables: response.data?.tables,
            quality: response.data?.quality || response.data?.imageQuality || null,
            model: response.data?.model || (response.data?.modelVersion ? { version: response.data.modelVersion } : null)
        }), ...structured };
    } catch (error) {
        error.message = normalizeHttpError(error);
        throw error;
    }
}

async function checkAvailability(options = {}) {
    let serviceUrl = '';
    try {
        const useVl = options.ocrMode === OCR_MODES.VL;
        serviceUrl = options.serviceUrl ? normalizeOcrServiceUrl(options.serviceUrl) : useVl ? getOcrVlServiceUrl() : getServiceUrl();
        if (!serviceUrl) return { available: false, configured: false, error: '文档解析（VL）服务尚未配置。' };
        const requestOptions = await buildSafeOcrRequestOptions(serviceUrl, { timeoutMs: getHealthTimeoutMs(), maxContentLength: 1024 * 1024, useVl, serviceOverride: options.serviceUrl });
        const response = await axios.get(`${serviceUrl}/health`, {
            ...requestOptions,
            ...(useVl ? { maxRedirects: 0 } : {}),
            headers: { Accept: 'application/json' },
            validateStatus: status => status >= 200 && status < 300
        });
        if (useVl && (response.data?.engine !== VL_ENGINE || response.data?.ready === false)) {
            return { available: false, configured: true, error: 'VL 服务引擎或模型未就绪，请检查 PaddleOCR-VL 部署。' };
        }
        return {
            available: true,
            configured: true,
            serviceUrl,
            remoteEngine: response.data?.engine || response.data?.remoteEngine || 'external',
            status: response.data?.status || 'ok'
        };
    } catch (error) {
        return {
            available: false,
            configured: true,
            serviceUrl,
            error: normalizeHttpError(error, serviceUrl)
        };
    }
}

module.exports = {
    checkAvailability,
    getMaxImageBytes,
    getServiceUrl,
    normalizeHttpError,
    recognizePage
};
