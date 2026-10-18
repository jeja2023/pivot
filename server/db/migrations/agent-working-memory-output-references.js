'use strict';

module.exports = [{
    id: '202610180010_agent_working_memory_output_references',
    description: 'Release ACL-scoped CAS outputs when Working Memory revisions are deleted.',
    async upPg(client) {
        await client.query(`
            CREATE OR REPLACE FUNCTION agent_working_memory_release_output_refs() RETURNS trigger AS $$
            DECLARE object_id TEXT;
            BEGIN
                FOR object_id IN
                    SELECT DISTINCT REPLACE(item->>'rawOutputRef', 'artifact-cas://', '')
                    FROM jsonb_array_elements(COALESCE(OLD.state->'evidence', '[]'::jsonb)) AS item
                    WHERE item->>'rawOutputRef' ~ '^artifact-cas://[0-9a-f]{16,64}$'
                LOOP
                    UPDATE agent_artifact_objects
                    SET ref_count = GREATEST(0, ref_count - 1)
                    WHERE id = object_id AND owner_user_id = OLD.user_id;
                END LOOP;
                RETURN OLD;
            END;
            $$ LANGUAGE plpgsql;
            DROP TRIGGER IF EXISTS trg_agent_working_memory_release_output_refs ON agent_working_memory_revisions;
            CREATE TRIGGER trg_agent_working_memory_release_output_refs
                AFTER DELETE ON agent_working_memory_revisions
                FOR EACH ROW EXECUTE FUNCTION agent_working_memory_release_output_refs();
        `);
    }
}];
