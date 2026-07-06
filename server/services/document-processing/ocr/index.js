const paddle = require('./adapters/paddle');
const tesseract = require('./adapters/tesseract');
const vision = require('./adapters/vision');

const ADAPTERS = Object.freeze({
    paddle,
    tesseract,
    vision
});

function normalizeEngine(value) {
    const engine = String(value || process.env.DOCUMENT_PROCESSING_OCR_ENGINE || 'paddle').trim().toLowerCase();
    if (ADAPTERS[engine]) return engine;
    return 'paddle';
}

function sanitizeOcrError(error, engine) {
    const message = String(error?.message || 'OCR 识别失败').split('\n')[0].slice(0, 500);
    const safe = new Error(`${engine === 'paddle' ? 'PaddleOCR' : engine} 识别失败：${message}。请检查 OCR 引擎是否已安装并配置命令。`);
    safe.code = error?.code || 'OCR_FAILED';
    return safe;
}

async function recognizePage(imagePath, options = {}) {
    const engine = normalizeEngine(options.engine);
    const adapter = ADAPTERS[engine];
    try {
        return await adapter.recognizePage(imagePath, options);
    } catch (error) {
        throw sanitizeOcrError(error, engine);
    }
}

async function getOcrEngineStatus() {
    const entries = await Promise.all(Object.entries(ADAPTERS).map(async ([engine, adapter]) => {
        try {
            return [engine, await adapter.checkAvailability()];
        } catch (error) {
            return [engine, { available: false, error: error.message }];
        }
    }));
    return Object.fromEntries(entries);
}

module.exports = {
    getOcrEngineStatus,
    normalizeEngine,
    recognizePage
};
