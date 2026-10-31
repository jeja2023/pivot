'use strict';

module.exports = [{
    id: '202610310003_realtime_agent_wakeup',
    description: 'Notify subscribed nodes after durable Agent events commit.',
    async upPg(client) {
        await client.query(`
            CREATE OR REPLACE FUNCTION pivot_agent_event_wakeup() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
                PERFORM pg_notify('pivot_agent_event_v1', json_build_object('schema', TG_TABLE_SCHEMA, 'user', NEW.user_id::text)::text);
                RETURN NEW;
            END $$;
            DROP TRIGGER IF EXISTS pivot_agent_event_wakeup ON agent_events;
            CREATE TRIGGER pivot_agent_event_wakeup AFTER INSERT ON agent_events
            FOR EACH ROW EXECUTE FUNCTION pivot_agent_event_wakeup();
        `);
    },
    async checkPg(client) {
        const result = await client.query(`SELECT EXISTS (
            SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = current_schema() AND c.relname = 'agent_events'
              AND t.tgname = 'pivot_agent_event_wakeup' AND NOT t.tgisinternal AND t.tgenabled <> 'D'
        ) AS present`);
        return result.rows[0]?.present === true;
    }
}];
