'use strict';
module.exports = [{
    id: '202610250004_analysis_transactions', description: '资金交易分析的映射、规则版本与可恢复任务。',
    async upPg(client) {
        await client.query(`CREATE TABLE IF NOT EXISTS analysis_transaction_runs(id TEXT PRIMARY KEY,user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,dataset_id TEXT NOT NULL REFERENCES analysis_datasets(id) ON DELETE CASCADE,source_revision TEXT NOT NULL,request_key TEXT NOT NULL,input_hash TEXT NOT NULL,config JSONB NOT NULL,status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','succeeded','failed','cancelled')),result JSONB,error TEXT NOT NULL DEFAULT '',lease TEXT,lease_expires_at TIMESTAMPTZ,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),expires_at TIMESTAMPTZ NOT NULL,UNIQUE(user_id,request_key))`);
        await client.query('CREATE INDEX IF NOT EXISTS idx_analysis_transactions_queue ON analysis_transaction_runs(status,lease_expires_at,created_at)');
        await client.query('CREATE INDEX IF NOT EXISTS idx_analysis_transactions_user ON analysis_transaction_runs(user_id,created_at DESC)');
        await client.query('CREATE INDEX IF NOT EXISTS idx_analysis_transactions_expiry ON analysis_transaction_runs(expires_at)');
        await client.query(`CREATE TABLE IF NOT EXISTS analysis_transaction_outputs(id TEXT PRIMARY KEY,analysis_id TEXT NOT NULL REFERENCES analysis_transaction_runs(id) ON DELETE CASCADE,format TEXT NOT NULL CHECK(format IN ('docx','pdf','mindmap')),status TEXT NOT NULL DEFAULT 'queued',artifact_id BIGINT REFERENCES agent_artifacts(id),rendition_id BIGINT REFERENCES agent_artifact_renditions(id),lease TEXT,lease_expires_at TIMESTAMPTZ,error TEXT NOT NULL DEFAULT '',created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),UNIQUE(analysis_id,format))`);
        await client.query('CREATE INDEX IF NOT EXISTS idx_analysis_transaction_outputs_queue ON analysis_transaction_outputs(status,lease_expires_at)');
    },
    async downPg(client) { await client.query('DROP TABLE IF EXISTS analysis_transaction_outputs'); await client.query('DROP TABLE IF EXISTS analysis_transaction_runs'); }
}];
