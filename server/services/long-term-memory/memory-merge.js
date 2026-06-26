const { buildKeywordCandidates } = require('../rag-index');
const { normalizeComparableText, normalizeMemoryContent } = require('./memory-utils');

function tokenSetForSimilarity(text) {
    return new Set(buildKeywordCandidates(text, 32)
        .map(term => String(term || '').toLowerCase().trim())
        .filter(term => term.length >= 2));
}

function characterNgramDice(textA, textB, size = 2) {
    const aText = normalizeComparableText(textA);
    const bText = normalizeComparableText(textB);
    if (aText.length < size || bText.length < size) return 0;
    const build = (text) => {
        const grams = new Map();
        for (let i = 0; i <= text.length - size; i += 1) {
            const gram = text.slice(i, i + size);
            grams.set(gram, (grams.get(gram) || 0) + 1);
        }
        return grams;
    };
    const aGrams = build(aText);
    const bGrams = build(bText);
    let overlap = 0;
    let totalA = 0;
    let totalB = 0;
    aGrams.forEach((count, gram) => {
        totalA += count;
        overlap += Math.min(count, bGrams.get(gram) || 0);
    });
    bGrams.forEach(count => {
        totalB += count;
    });
    return totalA + totalB > 0 ? (2 * overlap) / (totalA + totalB) : 0;
}

function memoryPairSimilarity(a, b) {
    const aText = normalizeComparableText(a.content);
    const bText = normalizeComparableText(b.content);
    if (!aText || !bText) return 0;
    if (aText === bText) return 1;
    if (aText.includes(bText) || bText.includes(aText)) return 0.92;
    const aTerms = tokenSetForSimilarity(a.content);
    const bTerms = tokenSetForSimilarity(b.content);
    let intersection = 0;
    aTerms.forEach(term => {
        if (bTerms.has(term)) intersection += 1;
    });
    const union = new Set([...aTerms, ...bTerms]).size;
    const keywordScoreValue = union > 0 ? intersection / union : 0;
    return Math.max(keywordScoreValue, characterNgramDice(a.content, b.content));
}

function mergeMemoryContent(target, source) {
    const targetContent = normalizeMemoryContent(target.content);
    const sourceContent = normalizeMemoryContent(source.content);
    const targetComparable = normalizeComparableText(targetContent);
    const sourceComparable = normalizeComparableText(sourceContent);
    if (targetComparable.includes(sourceComparable)) return targetContent;
    if (sourceComparable.includes(targetComparable)) return sourceContent;
    return normalizeMemoryContent(`${targetContent}; ${sourceContent}`);
}

module.exports = {
    tokenSetForSimilarity,
    characterNgramDice,
    memoryPairSimilarity,
    mergeMemoryContent
};
