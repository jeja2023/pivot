'use strict';

module.exports = {
    id: '202611160001_web_local_helper',
    description: '浏览器本机助手的短期配对、受限凭据与会话撤销。',
    async upPg(client) {
        await client.query('ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS helper_browser_key CHAR(64)');
        await client.query(`CREATE TABLE IF NOT EXISTS web_local_helper_pairs (
            id UUID PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            tenant_id BIGINT NOT NULL, browser_key CHAR(64) NOT NULL, binding_hash CHAR(64) NOT NULL,
            code_hash CHAR(64) NOT NULL UNIQUE, nonce CHAR(64) NOT NULL,
            device_id VARCHAR(64), token_hash CHAR(64) UNIQUE, token_version BIGINT NOT NULL,
            state VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','active','revoked')),
            browser_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), expires_at TIMESTAMPTZ NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), revoked_at TIMESTAMPTZ
        ); CREATE INDEX IF NOT EXISTS idx_web_helper_browser ON web_local_helper_pairs(user_id,browser_key,state);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_web_helper_device ON web_local_helper_pairs(device_id) WHERE device_id IS NOT NULL;`);
        await client.query("CREATE UNIQUE INDEX IF NOT EXISTS idx_web_helper_one_browser ON web_local_helper_pairs(user_id,browser_key) WHERE state IN ('pending','active')");
    },
    async downPg(client) { await client.query('DROP TABLE IF EXISTS web_local_helper_pairs; ALTER TABLE agent_runs DROP COLUMN IF EXISTS helper_browser_key'); }
};
