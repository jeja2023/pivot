'use strict';

module.exports = [{
    id: '202610310005_realtime_stream_snapshot',
    description: 'Keep encrypted, lease-fenced recent Agent streaming snapshots for cross-node recovery.',
    async upPg(client) {
        await client.query('ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS realtime_lease_epoch BIGINT NOT NULL DEFAULT 0');
        await client.query(`CREATE TABLE IF NOT EXISTS realtime_stream_snapshots (
            run_id VARCHAR(128) PRIMARY KEY REFERENCES agent_runs(id) ON DELETE CASCADE,
            user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            lease_owner TEXT NOT NULL, lease_epoch BIGINT NOT NULL, step INTEGER NOT NULL, snapshot_ciphertext TEXT NOT NULL, byte_length INTEGER NOT NULL,
            revision BIGINT NOT NULL DEFAULT 1, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
        await client.query('ALTER TABLE realtime_stream_snapshots ADD COLUMN IF NOT EXISTS lease_epoch BIGINT NOT NULL DEFAULT 0');
        await client.query('ALTER TABLE realtime_stream_snapshots ADD COLUMN IF NOT EXISTS byte_length INTEGER NOT NULL DEFAULT 0');
        await client.query('CREATE INDEX IF NOT EXISTS idx_realtime_stream_snapshot_updated ON realtime_stream_snapshots(updated_at)');
        await client.query(`
            CREATE OR REPLACE FUNCTION pivot_agent_lease_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
                IF NEW.locked_by IS NOT NULL AND NEW.locked_by <> ''
                   AND (OLD.locked_by IS DISTINCT FROM NEW.locked_by OR OLD.locked_by IS NULL OR OLD.locked_by = ''
                        OR (NEW.status = 'running' AND OLD.status = 'queued')) THEN
                    NEW.realtime_lease_epoch := COALESCE(OLD.realtime_lease_epoch, 0) + 1;
                END IF;
                RETURN NEW;
            END $$;
            DROP TRIGGER IF EXISTS pivot_agent_lease_epoch ON agent_runs;
            CREATE TRIGGER pivot_agent_lease_epoch BEFORE UPDATE OF locked_by ON agent_runs
            FOR EACH ROW EXECUTE FUNCTION pivot_agent_lease_epoch();
        `);
    },
    async checkPg(client) {
        const result = await client.query(`SELECT to_regclass(format('%I.%I', current_schema(), 'realtime_stream_snapshots')) IS NOT NULL
            AND EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = current_schema() AND c.relname = 'agent_runs' AND t.tgname = 'pivot_agent_lease_epoch' AND NOT t.tgisinternal AND t.tgenabled <> 'D') AS ready`);
        return result.rows[0]?.ready === true;
    }
}];
