function parsePositiveInt(value, fallback, maxOrOptions = {}) {
    const options = typeof maxOrOptions === 'number' ? { max: maxOrOptions } : maxOrOptions;
    const min = Number.isFinite(options.min) ? options.min : 1;
    const max = Number.isFinite(options.max) ? options.max : Number.MAX_SAFE_INTEGER;
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed < min) return fallback;
    return Math.min(parsed, max);
}

function parseNonNegativeInt(value, fallback, max = Number.MAX_SAFE_INTEGER) {
    return parsePositiveInt(value, fallback, { min: 0, max });
}

module.exports = {
    parseNonNegativeInt,
    parsePositiveInt
};
