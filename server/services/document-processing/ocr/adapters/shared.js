function normalizeConfidence(value, fallback = null) {
    if (value === null || value === undefined || value === '') return fallback;
    const n = Number.parseFloat(value);
    if (!Number.isFinite(n)) return fallback;
    if (n > 1 && n <= 100) return n / 100;
    return Math.max(0, Math.min(n, 1));
}

function normalizeBlock(block, index, defaults = {}) {
    return {
        text: String(block?.text || '').trim(),
        confidence: normalizeConfidence(block?.confidence, defaults.confidence ?? null),
        bbox: Array.isArray(block?.bbox) ? block.bbox : [],
        sortOrder: Number.isFinite(Number(block?.sortOrder)) ? Number(block.sortOrder) : index,
        blockType: block?.blockType || 'line',
        language: block?.language || defaults.language || '',
        engine: block?.engine || defaults.engine || ''
    };
}

function normalizeTableCell(cell, rowIndex, columnIndex) {
    return {
        rowIndex: Math.max(Number.parseInt(cell?.rowIndex ?? cell?.row, 10) || rowIndex, 0),
        columnIndex: Math.max(Number.parseInt(cell?.columnIndex ?? cell?.column, 10) || columnIndex, 0),
        rowSpan: Math.max(Number.parseInt(cell?.rowSpan, 10) || 1, 1),
        columnSpan: Math.max(Number.parseInt(cell?.columnSpan, 10) || 1, 1),
        text: String(cell?.text ?? cell?.content ?? '').slice(0, 100000),
        confidence: normalizeConfidence(cell?.confidence, null),
        bbox: Array.isArray(cell?.bbox) ? cell.bbox : []
    };
}

function normalizeTables(tables = []) {
    return (Array.isArray(tables) ? tables : []).slice(0, 100).map((table, index) => {
        const rawCells = Array.isArray(table?.cells) ? table.cells : [];
        const cells = rawCells.map((cell, cellIndex) => normalizeTableCell(cell, Math.floor(cellIndex / Math.max(Number(table?.columnCount || 1), 1)), cellIndex % Math.max(Number(table?.columnCount || 1), 1)));
        return {
            id: String(table?.id || `table-${index + 1}`).slice(0, 120),
            rowCount: Math.max(Number.parseInt(table?.rowCount ?? table?.rows, 10) || 0, ...cells.map(cell => cell.rowIndex + cell.rowSpan), 0),
            columnCount: Math.max(Number.parseInt(table?.columnCount ?? table?.columns, 10) || 0, ...cells.map(cell => cell.columnIndex + cell.columnSpan), 0),
            bbox: Array.isArray(table?.bbox) ? table.bbox : [],
            cells
        };
    });
}

function buildRecognitionResult({ blocks, engine, language, tables = [], quality = null, model = null }) {
    const normalizedBlocks = (blocks || [])
        .map((block, index) => normalizeBlock(block, index, { engine, language, confidence: null }))
        .filter(block => block.text)
        .sort((left, right) => left.sortOrder - right.sortOrder);
    const text = normalizedBlocks.map(block => block.text).join('\n').trim();
    const confidenceValues = normalizedBlocks
        .map(block => block.confidence)
        .filter(value => Number.isFinite(value));
    const confidence = confidenceValues.length
        ? confidenceValues.reduce((sum, value) => sum + value, 0) / confidenceValues.length
        : null;
    return { text, blocks: normalizedBlocks, confidence, engine, language, tables: normalizeTables(tables), quality: quality && typeof quality === 'object' ? quality : null, model: model && typeof model === 'object' ? model : null };
}

module.exports = {
    buildRecognitionResult,
    normalizeBlock,
    normalizeConfidence
    ,normalizeTables
};
