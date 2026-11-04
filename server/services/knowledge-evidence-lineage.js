'use strict';

const { parseJsonObject } = require('./agent-validators');

function parseValue(value) { return typeof value === 'string' ? parseJsonObject(value) || value : value; }
function evidenceOf(value) {
    value = parseValue(value);
    return value?.knowledgeEvidence || value?.knowledge_evidence || (value?.knowledgeSourceVersion === 1 ? value : null);
}

function mergeKnowledgeEvidence(...values) {
    const sources = new Map();
    let incomplete = false, tracked = false;
    for (const value of values.flat()) {
        const manifest = evidenceOf(value);
        if (!manifest) continue;
        tracked = true;
        if (manifest.knowledgeSourceVersion !== 1 || !Array.isArray(manifest.sources) || manifest.knowledgeEvidenceIncomplete) incomplete = true;
        for (const source of Array.isArray(manifest.sources) ? manifest.sources : []) {
            const key = JSON.stringify([source.chunkId, source.citationKey, source.contentDigest, source.indexVersion]);
            if (sources.size >= 1000 && !sources.has(key)) { incomplete = true; continue; }
            sources.set(key, source);
        }
    }
    return tracked ? { knowledgeSourceVersion: 1, sources: [...sources.values()], ...(incomplete ? { knowledgeEvidenceIncomplete: true } : {}) } : null;
}

// 持久化信封保持来源与值同时落盘，运行时解包后仍保留原始值类型和输出契约。
function packKnowledgeOutput(value, evidence) {
    return evidence ? { __pivotKnowledgeEnvelope: 1, value, knowledgeEvidence: evidence } : value;
}
function unpackKnowledgeOutput(value) {
    value = parseValue(value);
    return value?.__pivotKnowledgeEnvelope === 1
        ? { value: value.value, knowledgeEvidence: value.knowledgeEvidence }
        : { value, knowledgeEvidence: evidenceOf(value) };
}
function inheritDagEvidence(node, states, output, evidence = null) {
    return mergeKnowledgeEvidence(output, evidence, (node.dependsOn || []).map(id => states.get(id)?.knowledgeEvidence || states.get(id)?.output));
}

module.exports = { evidenceOf, inheritDagEvidence, mergeKnowledgeEvidence, packKnowledgeOutput, unpackKnowledgeOutput };
