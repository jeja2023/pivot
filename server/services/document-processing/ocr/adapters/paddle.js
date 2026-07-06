const { buildRecognitionResult, normalizeConfidence, runCommand, splitEnvArgs } = require('./shared');

function parseJsonLine(line) {
    try {
        const value = JSON.parse(line);
        if (!value || typeof value !== 'object') return null;
        const text = value.text || value.transcription || value.label || '';
        if (!text) return null;
        return {
            text,
            confidence: value.confidence ?? value.score ?? value.probability ?? 0.8,
            bbox: value.bbox || value.box || value.points || []
        };
    } catch (_err) {
        return null;
    }
}

function parseTupleLine(line) {
    const textMatch = line.match(/['"]([^'"]{1,1000})['"]\s*,\s*([0-9]+(?:\.[0-9]+)?)/);
    if (!textMatch) return null;
    const bboxMatch = line.match(/\[\s*\[\s*[-0-9.]+\s*,\s*[-0-9.]+\s*\][\s\S]*?\]/);
    return {
        text: textMatch[1],
        confidence: normalizeConfidence(textMatch[2], 0.8),
        bbox: bboxMatch ? bboxMatch[0] : []
    };
}

function parsePaddleOutput(stdout) {
    const blocks = [];
    String(stdout || '').split(/\r?\n/).forEach(line => {
        const trimmed = line.trim();
        if (!trimmed || /^(Namespace|download|loading|success)/i.test(trimmed)) return;
        const parsed = parseJsonLine(trimmed) || parseTupleLine(trimmed);
        if (parsed?.text) blocks.push(parsed);
    });
    if (blocks.length > 0) return blocks;
    const fallbackText = String(stdout || '')
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line && !/^\[/.test(line))
        .join('\n')
        .trim();
    return fallbackText ? [{ text: fallbackText, confidence: 0.6, bbox: [] }] : [];
}

async function recognizePage(imagePath, options = {}) {
    const command = process.env.PADDLEOCR_CMD || 'paddleocr';
    const language = options.language || process.env.PADDLEOCR_LANG || 'ch';
    const args = [
        ...splitEnvArgs(process.env.PADDLEOCR_ARGS || ''),
        '--image_dir', imagePath,
        '--lang', language,
        '--show_log', 'False'
    ];
    const result = await runCommand(command, args, { timeoutMs: options.timeoutMs });
    return buildRecognitionResult({
        blocks: parsePaddleOutput(result.stdout),
        engine: 'paddle',
        language
    });
}

async function checkAvailability() {
    const command = process.env.PADDLEOCR_CMD || 'paddleocr';
    try {
        await runCommand(command, ['--help'], { timeoutMs: 5000, maxBuffer: 512 * 1024 });
        return { available: true, command };
    } catch (err) {
        return { available: false, command, error: err.message };
    }
}

module.exports = {
    checkAvailability,
    parsePaddleOutput,
    recognizePage
};
