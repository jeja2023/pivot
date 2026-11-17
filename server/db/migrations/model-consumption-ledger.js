'use strict';

module.exports = [{
    id: '202611170002_model_consumption_ledger',
    description: '保留按账号模型日期累计的消费记录，历史删除不返还额度，关键事件幂等落库。',
    async upPg(client) {
        await client.query(`
            CREATE TABLE IF NOT EXISTS model_daily_consumption (
                user_id BIGINT NOT NULL, model_id BIGINT NOT NULL, usage_day DATE NOT NULL,
                token_count BIGINT NOT NULL DEFAULT 0 CHECK (token_count >= 0),
                PRIMARY KEY (user_id, model_id, usage_day)
            );
            ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS delivery_id TEXT;
            ALTER TABLE model_usage_events ADD COLUMN IF NOT EXISTS delivery_id TEXT;
            CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_logs_delivery ON audit_logs(delivery_id);
            CREATE UNIQUE INDEX IF NOT EXISTS idx_model_usage_delivery ON model_usage_events(delivery_id);
            LOCK TABLE messages, model_usage_events IN SHARE ROW EXCLUSIVE MODE;
            INSERT INTO model_daily_consumption(user_id, model_id, usage_day, token_count)
            SELECT user_id, model_id, (created_at AT TIME ZONE 'Asia/Shanghai')::date, SUM(GREATEST(COALESCE(token_count,0),0))
            FROM (SELECT user_id,model_id,created_at,token_count FROM messages
                UNION ALL SELECT user_id,model_id,created_at,token_count FROM model_usage_events) consumption
            WHERE user_id IS NOT NULL AND model_id IS NOT NULL AND created_at IS NOT NULL
            GROUP BY user_id, model_id, (created_at AT TIME ZONE 'Asia/Shanghai')::date
            ON CONFLICT DO NOTHING;
            CREATE OR REPLACE FUNCTION pivot_capture_model_consumption() RETURNS trigger LANGUAGE plpgsql AS $body$
            DECLARE amount BIGINT;
            BEGIN
                IF NEW.user_id IS NULL OR NEW.model_id IS NULL OR NEW.created_at IS NULL THEN RETURN NEW; END IF;
                amount := GREATEST(COALESCE(NEW.token_count,0),0);
                IF TG_OP = 'UPDATE' AND OLD.user_id = NEW.user_id AND OLD.model_id = NEW.model_id
                    AND (OLD.created_at AT TIME ZONE 'Asia/Shanghai')::date = (NEW.created_at AT TIME ZONE 'Asia/Shanghai')::date THEN
                    amount := GREATEST(amount - GREATEST(COALESCE(OLD.token_count,0),0),0);
                END IF;
                IF amount > 0 THEN
                    INSERT INTO model_daily_consumption(user_id,model_id,usage_day,token_count)
                    VALUES(NEW.user_id,NEW.model_id,(NEW.created_at AT TIME ZONE 'Asia/Shanghai')::date,amount)
                    ON CONFLICT(user_id,model_id,usage_day) DO UPDATE
                    SET token_count = model_daily_consumption.token_count + EXCLUDED.token_count;
                END IF;
                RETURN NEW;
            END $body$;
            DROP TRIGGER IF EXISTS pivot_message_consumption ON messages;
            CREATE TRIGGER pivot_message_consumption AFTER INSERT OR UPDATE OF token_count,model_id,user_id,created_at ON messages
                FOR EACH ROW EXECUTE FUNCTION pivot_capture_model_consumption();
            DROP TRIGGER IF EXISTS pivot_event_consumption ON model_usage_events;
            CREATE TRIGGER pivot_event_consumption AFTER INSERT OR UPDATE OF token_count,model_id,user_id,created_at ON model_usage_events
                FOR EACH ROW EXECUTE FUNCTION pivot_capture_model_consumption();
            DROP TRIGGER IF EXISTS pivot_common_recovery_write ON model_daily_consumption;
            CREATE TRIGGER pivot_common_recovery_write BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON model_daily_consumption
                FOR EACH STATEMENT EXECUTE FUNCTION pivot_common_recovery_write_barrier();
        `);
    }
}];
