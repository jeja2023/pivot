'use strict';

module.exports = [{
    id: '202610310004_realtime_channel_delivery',
    description: 'Durably order web-channel deliveries per user for SSE replay.',
    async upPg(client) {
        await client.query(`
            CREATE SEQUENCE IF NOT EXISTS realtime_channel_delivery_id_seq;
            CREATE TABLE IF NOT EXISTS realtime_channel_deliveries (
                id BIGINT PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                delivery_id BIGINT NOT NULL UNIQUE REFERENCES agent_channel_deliveries(id) ON DELETE CASCADE,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), retired_at TIMESTAMPTZ
            );
            CREATE INDEX IF NOT EXISTS idx_realtime_channel_user_id ON realtime_channel_deliveries(user_id, id);
            CREATE INDEX IF NOT EXISTS idx_realtime_channel_retired_at ON realtime_channel_deliveries(retired_at) WHERE retired_at IS NOT NULL;
            CREATE OR REPLACE FUNCTION pivot_channel_delivery_commit() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
            BEGIN
                IF TG_OP = 'INSERT' THEN
                    IF NEW.status = 'queued' AND EXISTS (SELECT 1 FROM agent_channel_bindings b WHERE b.id = NEW.binding_id AND b.channel_type = 'web') THEN
                        PERFORM pg_advisory_xact_lock(hashtext('pivot:channel-event-user'), hashtext(TG_TABLE_SCHEMA || ':' || NEW.user_id::text));
                        INSERT INTO realtime_channel_deliveries (id, user_id, delivery_id)
                        VALUES (nextval('realtime_channel_delivery_id_seq'), NEW.user_id, NEW.id)
                        ON CONFLICT (delivery_id) DO NOTHING;
                        PERFORM pg_notify('pivot_agent_event_v1', json_build_object('schema', TG_TABLE_SCHEMA, 'user', NEW.user_id::text)::text);
                    END IF;
                ELSIF TG_OP = 'UPDATE' AND NEW.status = 'delivered' THEN
                    UPDATE realtime_channel_deliveries SET retired_at = NOW(), created_at = NOW() WHERE delivery_id = NEW.id;
                END IF;
                RETURN NEW;
            END $$;
            DROP TRIGGER IF EXISTS pivot_channel_delivery_commit ON agent_channel_deliveries;
            CREATE TRIGGER pivot_channel_delivery_commit AFTER INSERT ON agent_channel_deliveries
            FOR EACH ROW EXECUTE FUNCTION pivot_channel_delivery_commit();
            DROP TRIGGER IF EXISTS pivot_channel_delivery_retire ON agent_channel_deliveries;
            CREATE TRIGGER pivot_channel_delivery_retire AFTER UPDATE OF status ON agent_channel_deliveries
            FOR EACH ROW WHEN (NEW.status = 'delivered' AND OLD.status IS DISTINCT FROM 'delivered')
            EXECUTE FUNCTION pivot_channel_delivery_commit();
        `);
    },
    async checkPg(client) {
        const result = await client.query(`SELECT EXISTS (
            SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = current_schema() AND c.relname = 'agent_channel_deliveries'
              AND t.tgname = 'pivot_channel_delivery_commit' AND NOT t.tgisinternal AND t.tgenabled <> 'D'
        ) AND to_regclass(format('%I.%I', current_schema(), 'realtime_channel_deliveries')) IS NOT NULL AS ready`);
        return result.rows[0]?.ready === true;
    }
}];
