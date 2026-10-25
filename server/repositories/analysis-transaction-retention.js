'use strict';
const { transaction } = require('../db/client');
async function scrubArtifact(db, artifactId) {
    const objects = await db.query("SELECT ir_ref,storage_ref FROM agent_artifact_renditions WHERE artifact_id=? AND status<>'expired' FOR UPDATE", [artifactId]);
    for (const rendition of objects) for (const reference of [rendition.ir_ref, rendition.storage_ref]) {
        const match = /^artifact-cas:\/\/([0-9a-f]{16,64})$/.exec(reference || '');
        if (match) await db.execute('UPDATE agent_artifact_objects SET ref_count=GREATEST(ref_count-1,0),expires_at=NOW() WHERE id=?', [match[1]]);
    }
    await db.execute("UPDATE agent_artifact_renditions SET status='expired',failure_reason='资金分析已删除或保留期到期' WHERE artifact_id=?", [artifactId]);
    await db.execute("UPDATE agent_artifacts SET status='deleted',content='',title='已清理的资金分析产物',updated_at=NOW() WHERE id=?", [artifactId]);
    await db.execute("UPDATE agent_artifact_versions SET content='',note='资金分析保留期清理' WHERE artifact_id=?", [artifactId]);
    await db.execute('DELETE FROM mindmap_workspaces WHERE artifact_id=?', [artifactId]);
    await db.execute('DELETE FROM mindmap_members WHERE artifact_id=?', [artifactId]);
    await db.execute('DELETE FROM mindmap_thumbnails WHERE artifact_id=?', [artifactId]);
}
async function discardArtifact(artifactId) { return transaction(db => scrubArtifact(db, artifactId)); }
async function purge({ userId = null, id = null, datasetId = null, expired = false } = {}) {
    return transaction(async db => {
        const runs = await db.query('SELECT id FROM analysis_transaction_runs WHERE (?::bigint IS NULL OR user_id=?) AND (?::text IS NULL OR id=?) AND (?::text IS NULL OR dataset_id=?) AND (?=FALSE OR expires_at<=NOW()) FOR UPDATE', [userId, userId, id, id, datasetId, datasetId, expired]);
        for (const run of runs) {
            const outputs = await db.query('SELECT artifact_id FROM analysis_transaction_outputs WHERE analysis_id=? AND artifact_id IS NOT NULL FOR UPDATE', [run.id]);
            for (const output of outputs) await scrubArtifact(db, output.artifact_id);
            await db.execute('DELETE FROM analysis_transaction_runs WHERE id=?', [run.id]);
        }
        return runs.length;
    });
}
module.exports = { purge, discardArtifact };
