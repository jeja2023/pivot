module.exports = [
    {
        id: '202609080004_refresh_token_device_binding',
        description: 'Bind refresh token families to a browser device identifier.',
        async upPg(client) {
            await client.query(`
                ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS device_id TEXT DEFAULT '';
                CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_device ON refresh_tokens(user_id, device_id, expires_at);
            `);
        }
    }
];
