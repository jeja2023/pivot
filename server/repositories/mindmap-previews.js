'use strict';
const { queryOne } = require('../db/client');
async function get(id, versionId, renderer) { return queryOne('SELECT content FROM mindmap_thumbnails WHERE artifact_id=? AND version_id=? AND renderer_version=?', [id, versionId, renderer]); }
async function put(id, versionId, renderer, content) {
    return queryOne(`INSERT INTO mindmap_thumbnails(artifact_id,version_id,renderer_version,content) SELECT id,?,?,? FROM agent_artifacts WHERE id=? AND current_version_id=? AND status<>'deleted' ON CONFLICT(artifact_id) DO UPDATE SET version_id=EXCLUDED.version_id,renderer_version=EXCLUDED.renderer_version,content=EXCLUDED.content,created_at=NOW() WHERE mindmap_thumbnails.version_id<=EXCLUDED.version_id RETURNING artifact_id`, [versionId, renderer, content, id, versionId]);
}
module.exports = { get, put };
