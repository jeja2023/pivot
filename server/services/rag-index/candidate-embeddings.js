'use strict';

// 仅为词法候选补取向量；稠密候选已在向量排序路径中解析，图谱候选可能已携带向量。
async function hydrateCandidateEmbeddings(candidates, fetchAuthorizedChunks) {
    const missingIds = [...new Set(candidates
        .filter(chunk => !Object.hasOwn(chunk, 'embedding') && !chunk.__entry)
        .map(chunk => Number(chunk.id))
        .filter(id => Number.isSafeInteger(id) && id > 0))];
    if (!missingIds.length) return candidates;
    const rows = await fetchAuthorizedChunks(missingIds);
    const byId = new Map(rows.map(row => [Number(row.id), row.embedding]));
    const missing = new Set(missingIds);
    return candidates.filter(chunk => !missing.has(Number(chunk.id)) || byId.has(Number(chunk.id)))
        .map(chunk => missing.has(Number(chunk.id)) ? { ...chunk, embedding: byId.get(Number(chunk.id)) } : chunk);
}

async function retainAuthorizedDenseCandidates(candidates, fetchAuthorizedChunks, parseEmbedding) {
    if (!candidates.length) return candidates;
    const rows = await fetchAuthorizedChunks(candidates.map(chunk => chunk.id));
    const byId = new Map(rows.map(row => [Number(row.id), row.embedding]));
    return candidates.filter(chunk => byId.has(Number(chunk.id))).map(chunk => {
        const embedding = byId.get(Number(chunk.id));
        return embedding ? { ...chunk, __entry: parseEmbedding(chunk.id, embedding) } : chunk;
    });
}

module.exports = { hydrateCandidateEmbeddings, retainAuthorizedDenseCandidates };
