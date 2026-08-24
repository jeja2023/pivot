const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { assertSafeOutboundHost, createSafeHttpAgents, isLoopbackHost } = require('../../../../security');
const { getAppSettingValue } = require('../../../app-settings');
const {
    DEFAULT_OCR_SERVICE_URL,
    DOCUMENT_PROCESSING_SETTING_KEYS,
    normalizeOcrServiceUrl
} = require('../../constants');
const { buildRecognitionResult } = require('./shared');

function getServiceUrl() {
    return normalizeOcrServiceUrl(getAppSettingValue(DOCUMENT_PROCESSING_SETTING_KEYS.serviceUrl) || process.env.OCR_SERVICE_URL || DEFAULT_OCR_SERVICE_URL);
}

const DEFAULT_MAX_IMAGE_BYTES = 50 * 1024 * 1024;

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

function buildUrl(pathname) {
    return `${getServiceUrl()}${pathname}`;
}

async function buildSafeOcrRequestOptions(timeoutMs, maxContentLength) {
    const serviceUrl = new URL(getServiceUrl());
    const allowExplicitLoopback = isLoopbackHost(serviceUrl.hostname);
    await assertSafeOutboundHost(serviceUrl.hostname, { blockPrivate: false, allowExplicitLoopback });
    return {
        timeout: timeoutMs,
        maxContentLength,
        proxy: false,
        ...createSafeHttpAgents({ blockPrivate: false, allowExplicitLoopback })
    };
}

function getHealthTimeoutMs() {
    const value = Number.parseInt(process.env.OCR_SERVICE_HEALTH_TIMEOUT_MS || '3000', 10);
    return Math.min(Math.max(Number.isFinite(value) ? value : 3000, 1000), 30000);
}

function normalizeHttpError(error) {
    const data = error?.response?.data;
    if (typeof data === 'string' && data.trim()) return data.trim();
    if (data?.detail) {
        if (typeof data.detail === 'string') return data.detail;
        if (data.detail?.error) return String(data.detail.error);
        return JSON.stringify(data.detail).slice(0, 500);
    }
    if (data?.error) return String(data.error);
    if (error?.code === 'ECONNREFUSED') return `外部 OCR 服务连接失败：${getServiceUrl()}`;
    if (error?.code === 'ETIMEDOUT' || error?.code === 'ECONNABORTED') return '外部 OCR 服务请求超时';
    return String(error?.message || '外部 OCR 服务调用失败').split('\n')[0].slice(0, 500);
}

function normalizeBlocks(data) {
    const blocks = Array.isArray(data?.blocks) ? data.blocks : [];
    if (blocks.length > 0) {
        return blocks.map((block, index) => ({
            ...block,
            engine: 'http',
            sortOrder: Number.isFinite(Number(block?.sortOrder)) ? Number(block.sortOrder) : index
        }));
    }
    return String(data?.text || '')
        .split(/\r?\n/)
        .map((text, index) => ({ text: text.trim(), confidence: data?.confidence || 0.8, bbox: [], sortOrder: index, engine: 'http' }))
        .filter(block => block.text);
}

async function recognizePage(imagePath, options = {}) {
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
        const requestOptions = await buildSafeOcrRequestOptions(timeoutMs + 5000, responseMaxBytes);
        const response = await axios.post(buildUrl('/ocr'), {
            imageBase64: buffer.toString('base64'),
            fileName: path.basename(imagePath),
            language,
            timeoutMs
        }, {
            ...requestOptions,
            maxBodyLength: requestBodyMaxBytes,
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json'
            },
            signal: options.signal || null,
            validateStatus: status => status >= 200 && status < 300
        });
        return buildRecognitionResult({
            blocks: normalizeBlocks(response.data),
            engine: 'http',
            language: response.data?.language || language
        });
    } catch (error) {
        error.message = normalizeHttpError(error);
        throw error;
    }
}

async function checkAvailability() {
    const serviceUrl = getServiceUrl();
    try {
        const response = await axios.get(buildUrl('/health'), {
            ...(await buildSafeOcrRequestOptions(getHealthTimeoutMs(), 1024 * 1024)),
            headers: { Accept: 'application/json' },
            validateStatus: status => status >= 200 && status < 300
        });
        return {
            available: true,
            serviceUrl,
            remoteEngine: response.data?.engine || response.data?.remoteEngine || 'external',
            status: response.data?.status || 'ok'
        };
    } catch (error) {
        return {
            available: false,
            serviceUrl,
            error: normalizeHttpError(error)
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
