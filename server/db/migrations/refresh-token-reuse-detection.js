module.exports = [
    {
        id: '202609070005_refresh_token_reuse_detection',
        description: 'Detect refresh token replay by retaining consumed token family markers.',
        up(db) {
            const columns = db.pragma('table_info(refresh_tokens)');
            if (!columns.length) return;
            if (!columns.some(column => column.name === 'family_id')) db.exec("ALTER TABLE refresh_tokens ADD COLUMN family_id TEXT DEFAULT ''");
            if (!columns.some(column => column.name === 'consumed_at')) db.exec('ALTER TABLE refresh_tokens ADD COLUMN consumed_at DATETIME');
            db.exec('CREATE INDEX IF NOT EXISTS idx_refresh_tokens_family ON refresh_tokens(user_id, family_id, consumed_at)');
        },
        async upPg(client) {
            await client.query(`
                ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS family_id TEXT DEFAULT '';
                ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS consumed_at TIMESTAMPTZ;
                CREATE INDEX IF NOT EXISTS idx_refresh_tokens_family ON refresh_tokens(user_id, family_id, consumed_at);
            `);
        }
    }
];
