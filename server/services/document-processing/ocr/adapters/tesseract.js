const { buildRecognitionResult, runCommand } = require('./shared');

async function recognizePage(imagePath, options = {}) {
    const command = process.env.TESSERACT_CMD || 'tesseract';
    const language = options.language || process.env.TESSERACT_LANG || 'eng';
    const result = await runCommand(command, [imagePath, 'stdout', '-l', language], { timeoutMs: options.timeoutMs });
    const text = String(result.stdout || '').trim();
    return buildRecognitionResult({
        blocks: text ? [{ text, confidence: 0.55, bbox: [] }] : [],
        engine: 'tesseract',
        language
    });
}

async function checkAvailability() {
    const command = process.env.TESSERACT_CMD || 'tesseract';
    try {
        await runCommand(command, ['--version'], { timeoutMs: 5000, maxBuffer: 512 * 1024 });
        return { available: true, command };
    } catch (err) {
        return { available: false, command, error: err.message };
    }
}

module.exports = {
    checkAvailability,
    recognizePage
};
