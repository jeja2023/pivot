'use strict';

// 图谱和词法召回可以独立降级，授权语料核验失败必须整体拒绝。
async function loadInitialCandidates({ graph, lexical, accessible }) {
    const [graphResult, lexicalResult, accessResult] = await Promise.allSettled([graph(), lexical(), accessible()]);
    if (accessResult.status !== 'fulfilled') throw accessResult.reason;
    return {
        graphContext: graphResult.status === 'fulfilled' ? graphResult.value : { chunkIds: [], relations: [], context: '' },
        lexicalCandidates: lexicalResult.status === 'fulfilled' ? lexicalResult.value : [],
        corpusAvailable: accessResult.value,
        degradedPaths: [graphResult.status === 'rejected' ? 'graph' : '', lexicalResult.status === 'rejected' ? 'lexical' : ''].filter(Boolean)
    };
}

module.exports = { loadInitialCandidates };
