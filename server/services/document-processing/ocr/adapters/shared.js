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
    normalizeConfidence
};