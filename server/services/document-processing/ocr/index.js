const http = require('./adapters/http');

const ADAPTERS = Object.freeze({
    http
});

const ENGINE_META = Object.freeze({
    http: {
        label: '外部 OCR 服务',
        description: '通过 HTTP 调用独立 OCR 项目提供的识别服务'
    }
});

function normalizeEngine(value) {
    const engine = String(value || process.env.DOCUMENT_PROCESSING_OCR_ENGINE || 'http').trim().toLowerCase();
    if (ADAPTERS[engine]) return engine;
    return 'http';
}

function engineLabel(engine) {
    return ENGINE_META[engine]?.label || '外部 OCR 服务';
}

function sanitizeOcrError(error, engine) {
    const message = String(error?.message || 'OCR 识别失败').split('\n')[0].slice(0, 500);
    const safe = new Error(`${engineLabel(engine)}识别失败：${message}。请检查外部 OCR 服务是否已部署，并确认 OCR_SERVICE_URL 配置正确。`);
    safe.code = error?.code || 'OCR_FAILED';
    return safe;
}

async function recognizePage(imagePath, options = {}) {
    const engine = normalizeEngine(options.engine);
    const adapter = ADAPTERS[engine];
    try {
        return await adapter.recognizePage(imagePath, { ...options, engine });
    } catch (error) {
        throw sanitizeOcrError(error, engine);
    }
}

async function getOcrEngineStatus() {
    const defaultEngine = normalizeEngine();
    const entries = await Promise.all(Object.entries(ADAPTERS).map(async ([engine, adapter]) => {
        const meta = ENGINE_META[engine] || {};
        try {
            return [engine, {
                engine,
                default: engine === defaultEngine,
                ...meta,
                ...await adapter.checkAvailability()
            }];
        } catch (error) {
            return [engine, {
                engine,
                default: engine === defaultEngine,
                ...meta,
                available: false,
                error: error.message
            }];
        }
    }));
    return Object.fromEntries(entries);
}

module.exports = {
    getOcrEngineStatus,
    normalizeEngine,
    recognizePage
};