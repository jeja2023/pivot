'use strict';

const migration = {
    id: '202609190002_agent_dag_output_refcounts',
    description: 'Release complete DAG output CAS references when DAG node rows are physically deleted.',
    up() {
        // 完整 CAS 产物和引用计数控制面仅运行于 PostgreSQL 部署；SQLite 保持 JSON 节点输出兼容。
    },
    async upPg(client) {
        await client.query(`
            CREATE OR REPLACE FUNCTION agent_dag_node_release_output_ref() RETURNS trigger AS $$
            DECLARE
                output_object_id TEXT;
            BEGIN
                output_object_id := REPLACE(COALESCE(pivot_json_extract(OLD.output::text, '{outputRef}'), ''), 'artifact-cas://', '');
                IF output_object_id ~ '^[0-9a-f]{16,64}$' THEN
                    UPDATE agent_artifact_objects
                    SET ref_count = GREATEST(0, ref_count - 1)
                    WHERE id = output_object_id;
                END IF;
                RETURN OLD;
            END;
            $$ LANGUAGE plpgsql;

            DROP TRIGGER IF EXISTS trg_agent_dag_nodes_release_output_ref ON agent_dag_nodes;
            CREATE TRIGGER trg_agent_dag_nodes_release_output_ref
                AFTER DELETE ON agent_dag_nodes
                FOR EACH ROW EXECUTE FUNCTION agent_dag_node_release_output_ref();
        `);
    }
};

module.exports = [migration];
