module.exports = [{
    id: '202609070003_api_key_scope_expiry',
    description: 'Restrict API keys to OpenAI endpoints and give all keys a finite lifetime.',
    async upPg(client) {
        await client.query(`
            ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS scopes TEXT DEFAULT 'openai';
            ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
            UPDATE api_keys SET scopes = 'openai' WHERE scopes IS NULL OR BTRIM(scopes) = '';
            UPDATE api_keys SET expires_at = COALESCE(created_at, NOW()) + INTERVAL '90 days' WHERE expires_at IS NULL;
            CREATE INDEX IF NOT EXISTS idx_api_keys_expiry ON api_keys(status, expires_at);
        `);
    }
}];
