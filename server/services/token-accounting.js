function toSafeTokenCount(value) {
    return Math.max(Number.parseInt(value, 10) || 0, 0);
}

function normalizeTokenUsage({ inputTokens = 0, outputTokens = 0, totalTokens = 0 } = {}) {
    const input = toSafeTokenCount(inputTokens);
    let output = toSafeTokenCount(outputTokens);
    let total = toSafeTokenCount(totalTokens);

    if (total <= 0) total = input + output;
    if (total < input + output) total = input + output;
    if (output < total - input) output = total - input;

    return {
        inputTokens: input,
        outputTokens: output,
        totalTokens: input + output
    };
}

function estimateEmbeddingTokens(inputs, estimateTokens) {
    const list = Array.isArray(inputs) ? inputs : [inputs];
    return list.reduce((sum, item) => sum + estimateTokens(
        Array.isArray(item) ? item.join(' ') : String(item || '')
    ), 0);
}

module.exports = {
    estimateEmbeddingTokens,
    normalizeTokenUsage,
    toSafeTokenCount
};
