/**
 * 检查点输出引用复用既有产物 CAS。当运行记录通过数据库级联删除而非服务层删除时，
 * 触发器保持 CAS 引用计数准确。
 */
module.exports = [{
    id: '202609260007_agent_checkpoint_output_references',
    description: '将超大检查点输出存储为 CAS 引用并在检查点删除时释放',
    async upPg(client) {
        await client.query(`
            CREATE OR REPLACE FUNCTION agent_checkpoint_release_output_ref() RETURNS trigger AS $$
            DECLARE
                output_object_id TEXT;
            BEGIN
                output_object_id := REPLACE(COALESCE(pivot_json_extract(OLD.state::text, '{outputRef}'), ''), 'artifact-cas://', '');
                IF output_object_id ~ '^[0-9a-f]{16,64}$' THEN
                    UPDATE agent_artifact_objects
                    SET ref_count = GREATEST(0, ref_count - 1)
                    WHERE id = output_object_id;
                END IF;
                RETURN OLD;
            END;
            $$ LANGUAGE plpgsql;

            DROP TRIGGER IF EXISTS trg_agent_checkpoint_release_output_ref ON agent_run_checkpoints;
            CREATE TRIGGER trg_agent_checkpoint_release_output_ref
                AFTER DELETE ON agent_run_checkpoints
                FOR EACH ROW EXECUTE FUNCTION agent_checkpoint_release_output_ref();
        `);
    }
}];
