module.exports = [
    {
        id: '202609080003_drop_redundant_log_indexes',
        description: 'Remove redundant prefix indexes already covered by composite log indexes.',
        up(db) {
            db.exec('DROP INDEX IF EXISTS idx_api_call_logs_created_at');
            db.exec('DROP INDEX IF EXISTS idx_audit_logs_timestamp');
            db.exec('DROP INDEX IF EXISTS idx_messages_user');
        },
        async upPg(client) {
            await client.query(`
                DROP INDEX IF EXISTS idx_api_call_logs_created_at;
                DROP INDEX IF EXISTS idx_audit_logs_timestamp;
                DROP INDEX IF EXISTS idx_messages_user;
            `);
        }
    }
];
