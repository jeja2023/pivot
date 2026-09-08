module.exports = [{
    id: '202609070003_api_key_scope_expiry',
    description: 'Restrict API keys to OpenAI endpoints and give all keys a finite lifetime.',
    up(db) {
        const columns = db.pragma('table_info(api_keys)');
        if (!columns.length) return;
        if (!columns.some(column => column.name === 'scopes')) db.exec("ALTER TABLE api_keys ADD COLUMN scopes TEXT DEFAULT 'openai'");
        if (!columns.some(column => column.name === 'expires_at')) db.exec('ALTER TABLE api_keys ADD COLUMN expires_at DATETIME');
        db.exec("UPDATE api_keys SET scopes = 'openai' WHERE scopes IS NULL OR TRIM(scopes) = ''");
        db.exec("UPDATE api_keys SET expires_at = datetime(COALESCE(created_at, datetime('now', '+8 hours')), '+90 days') WHERE expires_at IS NULL");
        db.exec('CREATE INDEX IF NOT EXISTS idx_api_keys_expiry ON api_keys(status, expires_at)');
    },
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
