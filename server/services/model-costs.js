function normalizePriceValue(value) {
    const numeric = Number.parseFloat(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return 0;
    return Math.round(numeric * 1e6) / 1e6;
}

function normalizePriceCurrency(value, fallback = 'CNY') {
    const normalized = String(value || fallback || 'CNY')
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9_-]/g, '');
    return normalized || fallback || 'CNY';
}

function calculateUsageCost({
    inputTokens = 0,
    outputTokens = 0,
    inputPricePerMillion = 0,
    outputPricePerMillion = 0
} = {}) {
    const input = Math.max(Number.parseInt(inputTokens, 10) || 0, 0);
    const output = Math.max(Number.parseInt(outputTokens, 10) || 0, 0);
    const inputPrice = normalizePriceValue(inputPricePerMillion);
    const outputPrice = normalizePriceValue(outputPricePerMillion);
    if (input <= 0 && output <= 0) return 0;
    if (inputPrice <= 0 && outputPrice <= 0) return 0;
    const total = ((input * inputPrice) + (output * outputPrice)) / 1000000;
    return Math.round(total * 1e6) / 1e6;
}

module.exports = {
    calculateUsageCost,
    normalizePriceCurrency,
    normalizePriceValue
};
