'use strict';

async function lockCurrentKnowledgeLease(trx, { jobId, docId, userId, workerId, attempts }) {
    return trx.queryOne("SELECT id FROM knowledge_ingestion_jobs WHERE id = ? AND doc_id = ? AND user_id = ? AND status = 'running' AND locked_by = ? AND attempts = ? FOR UPDATE", [jobId, docId, userId, workerId, attempts]);
}

module.exports = { lockCurrentKnowledgeLease };
