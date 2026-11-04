'use strict';

const crypto = require('crypto');
const { redactDiagnostic } = require('./diagnostic-redaction');
const { evidenceOf } = require('./knowledge-evidence-lineage');

function auditStep(step) {
    const manifest = step.knowledge_evidence || evidenceOf(step.output);
    return { id: step.id, step_index: step.step_index, node_key: step.node_key, type: step.type,
        title: step.type === 'tool' || step.tool_name ? '工具执行记录' : '任务执行记录', tool_name: step.tool_name,
        status: step.status, duration_ms: step.duration_ms, input: { omitted: true },
        output: { omitted: true, digest: crypto.createHash('sha256').update(JSON.stringify(step.output ?? null)).digest('hex'),
            sources: manifest?.sources?.map(source => ({ chunkId: source.chunkId, documentId: source.documentId, versionId: source.versionId,
                citationKey: source.citationKey, contentDigest: source.contentDigest })) || [] },
        error_message: step.status === 'error' ? '执行未完成，请使用关联标识检查原因。' : '' };
}

function projectRunAudit(detail) {
    const run = detail.run;
    return redactDiagnostic({ exportedAt: new Date().toISOString(), run: { id: run.id, title: run.title, goal: run.goal, status: run.status,
        run_mode: run.run_mode, model_id: run.model_id, model_name: run.model_name, total_tokens: run.total_tokens,
        final_answer: run.final_answer, error_message: run.error_message, created_at: run.created_at, completed_at: run.completed_at },
    progress: detail.progress, knowledgeAccess: detail.knowledgeAccess,
    steps: (detail.steps || []).map(auditStep), dagNodes: (detail.dagNodes || []).map(auditStep) });
}

module.exports = { projectRunAudit };
