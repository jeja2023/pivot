module.exports = [
    {
        id: '202609080004_refresh_token_device_binding',
        description: 'Bind refresh token families to a browser device identifier.',
        up(db) {
            const columns = db.pragma('table_info(refresh_tokens)');
            if (!columns.length) return;
            if (!columns.some(column => column.name === 'device_id')) db.exec("ALTER TABLE refresh_tokens ADD COLUMN device_id TEXT DEFAULT ''");
            db.exec('CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_device ON refresh_tokens(user_id, device_id, expires_at)');
        },
        async upPg(client) {
            await client.query(`
                ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS device_id TEXT DEFAULT '';
                CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_device ON refresh_tokens(user_id, device_id, expires_at);
            `);
        }
    }
];
