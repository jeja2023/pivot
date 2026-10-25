'use strict';
const { query, queryOne, transaction } = require('../db/client');
const crypto = require('node:crypto');
async function create(userId, id, format) {
    return queryOne("INSERT INTO analysis_transaction_outputs(id,analysis_id,format) SELECT ?,id,? FROM analysis_transaction_runs WHERE id=? AND user_id=? AND status='succeeded' AND expires_at>NOW() ON CONFLICT(analysis_id,format) DO UPDATE SET status=CASE WHEN analysis_transaction_outputs.status='failed' THEN 'queued' ELSE analysis_transaction_outputs.status END RETURNING *", [crypto.randomUUID(), format, id, userId]);
}
async function list(id) { return query('SELECT id,format,status,artifact_id,rendition_id,error FROM analysis_transaction_outputs WHERE analysis_id=? ORDER BY created_at', [id]); }
async function claim() {
    return transaction(async db => {
        const output = await db.queryOne("SELECT d.*,r.user_id FROM analysis_transaction_outputs d JOIN analysis_transaction_runs r ON r.id=d.analysis_id WHERE (d.status='queued' OR (d.status='running' AND d.lease_expires_at<NOW())) AND r.status='succeeded' AND r.expires_at>NOW() ORDER BY d.created_at FOR UPDATE OF d SKIP LOCKED LIMIT 1");
        if (!output) return null; const updated = await db.queryOne("UPDATE analysis_transaction_outputs SET status='running',lease=?,lease_expires_at=NOW()+INTERVAL '2 minutes',error='' WHERE id=? RETURNING *", [crypto.randomUUID(), output.id]); return { ...updated, user_id: output.user_id };
    });
}
async function attach(output, artifactId) {
    return queryOne("UPDATE analysis_transaction_outputs SET artifact_id=? WHERE id=? AND status='running' AND lease=? AND lease_expires_at>NOW() AND EXISTS(SELECT 1 FROM analysis_transaction_runs r WHERE r.id=analysis_id AND r.expires_at>NOW()) RETURNING id", [artifactId, output.id, output.lease]);
}
async function finish(output, renditionId = null, error = '') { return queryOne("UPDATE analysis_transaction_outputs SET status=?,rendition_id=?,error=?,lease=NULL,lease_expires_at=NULL WHERE id=? AND status='running' AND lease=? AND lease_expires_at>NOW() RETURNING id", [error ? 'failed' : 'succeeded', renditionId, error, output.id, output.lease]); }
module.exports = { create, list, claim, attach, finish };
