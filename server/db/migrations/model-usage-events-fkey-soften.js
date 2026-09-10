module.exports = [
    {
        id: '202609100001_model_usage_events_fkey_soften',
        description: 'Drop strict foreign key constraints on model_usage_events to decouple async append-only usage logs from entity lifecycle.',
        up(_db) {
            // SQLite 无 ALTER TABLE DROP CONSTRAINT 语法；SQLite 仅作为历史测试兼容，DDL 已由 tables-core.js 同步剥离。
        },
        async upPg(client) {
            await client.query(`
                ALTER TABLE model_usage_events DROP CONSTRAINT IF EXISTS model_usage_events_user_id_fkey;
                ALTER TABLE model_usage_events DROP CONSTRAINT IF EXISTS model_usage_events_model_id_fkey;
            `);
        }
    }
];
