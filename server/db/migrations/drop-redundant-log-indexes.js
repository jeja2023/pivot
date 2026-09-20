module.exports = [
    {
        id: '202609080003_drop_redundant_log_indexes',
        description: 'Remove redundant prefix indexes already covered by composite log indexes.',
        async upPg(client) {
            await client.query(`
                DROP INDEX IF EXISTS idx_api_call_logs_created_at;
                DROP INDEX IF EXISTS idx_audit_logs_timestamp;
                DROP INDEX IF EXISTS idx_messages_user;
            `);
        }
    }
];
