'use strict';

module.exports = [{
    id: '202611070005_analysis_model_ownership',
    description: 'Record controlled model handovers with current source permissions and explicit recipient confirmation.',
    async upPg(client) {
        await client.query(`CREATE TABLE IF NOT EXISTS analysis_model_transfers (
            id TEXT PRIMARY KEY,model_id TEXT NOT NULL REFERENCES analysis_data_models(id) ON DELETE RESTRICT,
            owner_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
            initiator_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
            recipient_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
            expected_version BIGINT NOT NULL,impact_hash TEXT NOT NULL,impact_json JSONB NOT NULL,
            business_owner TEXT NOT NULL,maintenance_contact TEXT NOT NULL,reason TEXT NOT NULL,
            request_key TEXT NOT NULL,request_hash TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'requested' CHECK(status IN ('requested','accepted','rejected','cancelled')),
            decision_comment TEXT NOT NULL DEFAULT '',created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW()+INTERVAL '7 days',completed_at TIMESTAMPTZ,
            UNIQUE(model_id,initiator_id,request_key),CHECK(owner_id<>recipient_id)
        )`);
        await client.query('CREATE INDEX IF NOT EXISTS idx_analysis_model_transfer_inbox ON analysis_model_transfers(recipient_id,status,created_at DESC)');
        await client.query(`CREATE OR REPLACE FUNCTION analysis_protect_model_transfer() RETURNS trigger LANGUAGE plpgsql AS $body$
            BEGIN
                IF OLD.status<>'requested' OR NEW.status='requested' OR NEW.completed_at IS NULL OR
                   (to_jsonb(NEW)-'status'-'decision_comment'-'completed_at')<>(to_jsonb(OLD)-'status'-'decision_comment'-'completed_at')
                THEN RAISE EXCEPTION '模型交接证据不可改写'; END IF; RETURN NEW;
            END $body$;
            DROP TRIGGER IF EXISTS analysis_model_transfer_immutable ON analysis_model_transfers;
            CREATE TRIGGER analysis_model_transfer_immutable BEFORE UPDATE ON analysis_model_transfers FOR EACH ROW EXECUTE FUNCTION analysis_protect_model_transfer()`);
    }
}];
