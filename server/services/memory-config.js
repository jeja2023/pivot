const MEMORY_CONFIG_KEYS = Object.freeze({
    threshold: 'memory_threshold'
});

const MIN_MEMORY_THRESHOLD = 256;
const MAX_MEMORY_THRESHOLD = 10000000;

function parseTokenAmount(value) {
    const text = String(value ?? '').trim();
    if (!text) return 0;
    const match = text.replace(/,/g, '').match(/^(\d+(?:\.\d+)?)\s*([kKmMbB]?)\s*(?:tokens?)?$/);
    if (!match) return Number.parseInt(text.replace(/[^\d]/g, ''), 10) || 0;
    const num = Number(match[1]) || 0;
    const unit = match[2].toLowerCase();
    const multiplier = unit === 'k' ? 1000
        : unit === 'm' ? 1000000
        : unit === 'b' ? 1000000000
        : 1;
    return Math.round(num * multiplier);
}

function normalizeMemoryThreshold(value, fallback = 12000) {
    const fallbackValue = Math.max(MIN_MEMORY_THRESHOLD, Math.min(MAX_MEMORY_THRESHOLD, parseTokenAmount(fallback) || 12000));
    const parsed = parseTokenAmount(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallbackValue;
    return Math.max(MIN_MEMORY_THRESHOLD, Math.min(MAX_MEMORY_THRESHOLD, parsed));
}

const DEFAULT_MEMORY_THRESHOLD = normalizeMemoryThreshold(process.env.MEMORY_THRESHOLD, 12000);

function toMemorySettingValue(key, value) {
    if (key === MEMORY_CONFIG_KEYS.threshold) {
        return String(normalizeMemoryThreshold(value, DEFAULT_MEMORY_THRESHOLD));
    }
    return String(value ?? '');
}

function getMemoryConfig(settings = {}) {
    const rawThreshold = settings[MEMORY_CONFIG_KEYS.threshold]?.value ?? settings[MEMORY_CONFIG_KEYS.threshold];
    return {
        thresholdTokens: normalizeMemoryThreshold(rawThreshold, DEFAULT_MEMORY_THRESHOLD),
        defaultThresholdTokens: DEFAULT_MEMORY_THRESHOLD,
        minThresholdTokens: MIN_MEMORY_THRESHOLD,
        maxThresholdTokens: MAX_MEMORY_THRESHOLD
    };
}

module.exports = {
    MEMORY_CONFIG_KEYS,
    DEFAULT_MEMORY_THRESHOLD,
    MIN_MEMORY_THRESHOLD,
    MAX_MEMORY_THRESHOLD,
    getMemoryConfig,
    normalizeMemoryThreshold,
    toMemorySettingValue
};
