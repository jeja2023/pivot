'use strict';

const { parseJsonObject } = require('./agent-validators');
const { mergeKnowledgeEvidence } = require('./knowledge-evidence-lineage');

function knowledgeScopeRevision(run = {}) {
    return Number(parseJsonObject(run.metadata)?.chatKnowledgeScope?.revision || 0);
}

function stampKnowledgeResult(result, run = {}) {
    const revision = knowledgeScopeRevision(run);
    if (!revision) return result;
    for (const source of result.sources || []) Object.assign(source, { scopeRunId: run.id, scopeRevision: revision });
    return result;
}

function isPriorKnowledgeObservation(item, run) {
    const revision = knowledgeScopeRevision(run);
    if (!revision || item?.knowledgeScopeSuperseded === true) return false;
    const output = typeof item.output === 'string' ? parseJsonObject(item.output) : item.output;
    if (output?.knowledgeContextVersion === 1) return true;
    const evidence = mergeKnowledgeEvidence(item.knowledgeEvidence, output);
    return Boolean(evidence?.sources?.some(source => source.scopeRunId !== run.id || Number(source.scopeRevision) !== revision));
}

function projectKnowledgeObservation(item, run) {
    if (!isPriorKnowledgeObservation(item, run)) return item;
    // 历史证据原文仍留在持久记录中并复核权限；模型与本轮验收只接收失效说明。
    const { output: _output, knowledgeEvidence: _evidence, input: _input, ...record } = item;
    return { ...record, knowledgeScopeSuperseded: true, input: {}, output: { knowledgeScopeSuperseded: true, executed: false,
        message: '此项属于更换资料范围前的历史结果，不能作为本轮依据；请按当前资料范围重新检索。' } };
}

module.exports = { knowledgeScopeRevision, stampKnowledgeResult, isPriorKnowledgeObservation, projectKnowledgeObservation };
