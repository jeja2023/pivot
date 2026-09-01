/**
 * Rendition 删除时回收 CAS 引用计数。
 *
 * Rendition 是 CAS 对象的权威引用者。Artifact 被删除或保留期清理时，数据库级
 * AFTER DELETE trigger 也会在级联删除路径执行，避免只在服务层递减而留下永久 blob。
 */

const artifactCasRefcountMigration = {
    id: '202609010002_agent_artifact_rendition_refcounts',
    description: 'Release binary CAS reference counts when immutable rendition rows are deleted.',
    async upPg(client) {
        await client.query(`
            CREATE OR REPLACE FUNCTION agent_artifact_rendition_release_refs() RETURNS trigger AS $$
            DECLARE
                ir_object_id TEXT;
                content_object_id TEXT;
            BEGIN
                ir_object_id := REPLACE(COALESCE(OLD.ir_ref, ''), 'artifact-cas://', '');
                content_object_id := REPLACE(COALESCE(OLD.storage_ref, ''), 'artifact-cas://', '');
                IF ir_object_id ~ '^[0-9a-f]{16,64}$' THEN
                    UPDATE agent_artifact_objects
                    SET ref_count = GREATEST(0, ref_count - 1)
                    WHERE id = ir_object_id;
                END IF;
                IF content_object_id ~ '^[0-9a-f]{16,64}$' THEN
                    UPDATE agent_artifact_objects
                    SET ref_count = GREATEST(0, ref_count - 1)
                    WHERE id = content_object_id;
                END IF;
                RETURN OLD;
            END;
            $$ LANGUAGE plpgsql;

            DROP TRIGGER IF EXISTS trg_agent_artifact_rendition_release_refs ON agent_artifact_renditions;
            CREATE TRIGGER trg_agent_artifact_rendition_release_refs
                AFTER DELETE ON agent_artifact_renditions
                FOR EACH ROW EXECUTE FUNCTION agent_artifact_rendition_release_refs();
        `);
    },
    async downPg(client) {
        await client.query(`
            DROP TRIGGER IF EXISTS trg_agent_artifact_rendition_release_refs ON agent_artifact_renditions;
            DROP FUNCTION IF EXISTS agent_artifact_rendition_release_refs();
        `);
    }
};

module.exports = [artifactCasRefcountMigration];
