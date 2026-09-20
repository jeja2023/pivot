module.exports = [
    {
        id: '202609070001_auth_token_version',
        description: 'Add per-user access token version for immediate revocation.',
        async upPg(client) {
            await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version BIGINT DEFAULT 0');
        }
    }
];
