/**
 * 独立文档 Artifact 迁移。
 *
 * 公文工作台并不总由 Agent run 产生，但其 DOCX/PDF 仍必须进入同一份
 * Artifact → Rendition → Delivery 审计链。因此允许 agent_artifacts.run_id 为空；
 * 有 run 的既有产物不受影响，独立产物只通过 user_id 归属控制访问。
 */

const standaloneArtifactsMigration = {
    id: '202609010001_agent_standalone_artifacts',
    description: 'Allow user-owned standalone artifacts that are not attached to an Agent run.',
    up(db) {
        const columns = db.pragma('table_info(agent_artifacts)');
        const runId = columns.find(column => column.name === 'run_id');
        if (!runId || Number(runId.notnull || 0) === 0) return;
        // SQLite 不支持直接 DROP NOT NULL。连同唯一引用它的版本表重建，
        // 避免 ALTER TABLE rename 后 artifact_versions 外键仍指向旧表。
        db.pragma('foreign_keys = OFF');
        try {
            db.exec(`
            BEGIN;
            ALTER TABLE agent_artifact_versions RENAME TO agent_artifact_versions_legacy;
            ALTER TABLE agent_artifacts RENAME TO agent_artifacts_legacy;

            CREATE TABLE agent_artifacts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                run_id TEXT,
                user_id INTEGER NOT NULL,
                type TEXT DEFAULT 'summary',
                title TEXT NOT NULL,
                content TEXT NOT NULL,
                current_version_id INTEGER,
                note TEXT,
                updated_at DATETIME,
                created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
                FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE,
                FOREIGN KEY (user_id) REFERENCES users(id)
            );

            CREATE TABLE agent_artifact_versions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                artifact_id INTEGER NOT NULL,
                version INTEGER NOT NULL,
                content TEXT NOT NULL,
                note TEXT,
                created_by INTEGER,
                created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
                UNIQUE(artifact_id, version),
                FOREIGN KEY (artifact_id) REFERENCES agent_artifacts(id) ON DELETE CASCADE,
                FOREIGN KEY (created_by) REFERENCES users(id)
            );

            INSERT INTO agent_artifacts
                (id, run_id, user_id, type, title, content, current_version_id, note, updated_at, created_at)
            SELECT id, run_id, user_id, type, title, content, current_version_id, note, updated_at, created_at
            FROM agent_artifacts_legacy;
            INSERT INTO agent_artifact_versions
                (id, artifact_id, version, content, note, created_by, created_at)
            SELECT id, artifact_id, version, content, note, created_by, created_at
            FROM agent_artifact_versions_legacy;

            DROP TABLE agent_artifact_versions_legacy;
            DROP TABLE agent_artifacts_legacy;
            CREATE INDEX IF NOT EXISTS idx_agent_artifacts_user ON agent_artifacts(user_id, created_at);
            COMMIT;
            `);
        } catch (error) {
            try { db.exec('ROLLBACK;'); } catch (_) {}
            throw error;
        } finally {
            db.pragma('foreign_keys = ON');
        }
    },
    async upPg(client) {
        await client.query('ALTER TABLE agent_artifacts ALTER COLUMN run_id DROP NOT NULL;');
    },
    async downPg(client) {
        const nullable = await client.query('SELECT 1 FROM agent_artifacts WHERE run_id IS NULL LIMIT 1');
        if (nullable.rows.length) {
            throw new Error('存在独立 Artifact，不能将 agent_artifacts.run_id 回退为 NOT NULL。');
        }
        await client.query('ALTER TABLE agent_artifacts ALTER COLUMN run_id SET NOT NULL;');
    }
};

module.exports = [standaloneArtifactsMigration];
