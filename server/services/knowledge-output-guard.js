'use strict';

function holdKnowledgeOutput(run = {}, observations = []) {
    let metadata = run.metadata || {};
    if (typeof metadata === 'string') { try { metadata = JSON.parse(metadata); } catch (_) { metadata = {}; } }
    return Boolean(metadata.chatBridge?.ragContext || metadata.capabilityConstraints?.capabilities?.some(cap => String(cap).startsWith('knowledge.'))
        || observations.some(item => ['rag.search', 'knowledge.graph.query'].includes(item.tool) || item.knowledgeEvidence || item.output?.knowledgeEvidence || item.output?.knowledgeSourceVersion === 1));
}

function safeFinalAnswer(answer, verification) {
    return verification?.semanticVerification?.reason === 'source_revoked'
        ? '本次资料来源已变化或不可访问，请重新选择资料后继续。已生成文件的可用状态请在结果文件中查看。' : answer;
}

module.exports = { holdKnowledgeOutput, safeFinalAnswer };
