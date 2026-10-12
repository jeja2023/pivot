'use strict';

module.exports = [{
    id: '202610120002_refresh_token_single_ip_binding',
    description: 'Bind browser refresh token sessions to one user source IP at a time.',
    async upPg(client) {
        await client.query(`
            ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS login_ip TEXT DEFAULT '';
            CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_login_ip
                ON refresh_tokens(user_id, login_ip, expires_at DESC);
        `);
    }
}];
