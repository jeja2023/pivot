const { execFile } = require('child_process');

function runCommand(command, args, options = {}) {
    return new Promise((resolve, reject) => {
        execFile(command, args, {
            timeout: options.timeoutMs || 120000,
            windowsHide: true,
            maxBuffer: options.maxBuffer || 10 * 1024 * 1024,
            env: { ...process.env, ...(options.env || {}) }
        }, (error, stdout, stderr) => {
            if (error) {
                const message = error.code === 'ENOENT'
                    ? `OCR 引擎命令不存在：${command}`
                    : String(stderr || error.message || 'OCR 引擎执行失败').split('\n')[0].slice(0, 500);
                const err = new Error(message);
                err.code = error.code || 'OCR_COMMAND_FAILED';
                err.stdout = String(stdout || '');
                err.stderr = String(stderr || '');
                reject(err);
                return;
            }
            resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
        });
    });
}

function splitEnvArgs(value) {
    return String(value || '')
        .match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)
        ?.map(item => item.replace(/^['"]|['"]$/g, '')) || [];
}

function normalizeConfidence(value, fallback = 0) {
    const n = Number.parseFloat(value);
    if (!Number.isFinite(n)) return fallback;
    if (n > 1 && n <= 100) return n / 100;
    return Math.max(0, Math.min(n, 1));
}

function normalizeBlock(block, index, defaults = {}) {
    return {
        text: String(block?.text || '').trim(),
        confidence: normalizeConfidence(block?.confidence, defaults.confidence ?? 0),
        bbox: Array.isArray(block?.bbox) ? block.bbox : [],
        sortOrder: Number.isFinite(Number(block?.sortOrder)) ? Number(block.sortOrder) : index,
        blockType: block?.blockType || 'line',
        language: block?.language || defaults.language || '',
        engine: block?.engine || defaults.engine || ''
    };
}

function buildRecognitionResult({ blocks, engine, language }) {
    const normalizedBlocks = (blocks || [])
        .map((block, index) => normalizeBlock(block, index, { engine, language, confidence: 0.8 }))
        .filter(block => block.text);
    const text = normalizedBlocks.map(block => block.text).join('\n').trim();
    const confidence = normalizedBlocks.length
        ? normalizedBlocks.reduce((sum, block) => sum + Number(block.confidence || 0), 0) / normalizedBlocks.length
        : 0;
    return { text, blocks: normalizedBlocks, confidence, engine, language };
}

module.exports = {
    buildRecognitionResult,
    normalizeBlock,
    normalizeConfidence,
    runCommand,
    splitEnvArgs
};
