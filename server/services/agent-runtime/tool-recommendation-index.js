const { buildRagSearchTerms, normalizeSearchText } = require('../rag-tokenizer');

function terms(text) {
    // 复用项目中英文和符号分词，并保留重复英文词用于词频计算。
    const normalized = normalizeSearchText(text);
    return [...(normalized.match(/[a-z0-9_]+/g) || []), ...buildRagSearchTerms(normalized, 256)];
}

class ToolRecommendationIndex {
    constructor() { this.documents = []; }

    addDocument(text) {
        const counts = new Map();
        for (const term of terms(text)) counts.set(term, (counts.get(term) || 0) + 1);
        this.documents.push(counts);
    }

    tfidfs(query, callback) {
        const queryTerms = [...new Set(terms(query))];
        const frequencies = new Map(queryTerms.map(term => [term, this.documents.filter(doc => doc.has(term)).length]));
        this.documents.forEach((document, index) => {
            const score = queryTerms.reduce((sum, term) => {
                const frequency = document.get(term) || 0;
                const weight = 1 + Math.log((this.documents.length + 1) / ((frequencies.get(term) || 0) + 1));
                return sum + frequency * weight;
            }, 0);
            callback(index, score);
        });
    }
}

module.exports = { ToolRecommendationIndex };
