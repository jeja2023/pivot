module.exports = [
    {
        id: '202609070001_auth_token_version',
        description: 'Add per-user access token version for immediate revocation.',
        up(db) {
            const columns = db.pragma('table_info(users)');
            if (columns.length && !columns.some(column => column.name === 'token_version')) {
                db.exec('ALTER TABLE users ADD COLUMN token_version INTEGER DEFAULT 0');
            }
        },
        async upPg(client) {
            await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version BIGINT DEFAULT 0');
        }
    }
];
