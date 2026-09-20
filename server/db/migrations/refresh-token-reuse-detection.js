module.exports = [
    {
        id: '202609070005_refresh_token_reuse_detection',
        description: 'Detect refresh token replay by retaining consumed token family markers.',
        async upPg(client) {
            await client.query(`
                ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS family_id TEXT DEFAULT '';
                ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS consumed_at TIMESTAMPTZ;
                CREATE INDEX IF NOT EXISTS idx_refresh_tokens_family ON refresh_tokens(user_id, family_id, consumed_at);
            `);
        }
    }
];
