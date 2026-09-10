module.exports = [
    {
        id: '202609100002_api_call_logs_fkey_soften',
        description: 'Update foreign key constraint on api_call_logs(api_key_id) to ON DELETE SET NULL to decouple audit log history from api key deletion.',
        up(_db) {
            // SQLite 无 ALTER TABLE DROP CONSTRAINT 语法；DDL 已同步至 tables-core.js。
        },
        async upPg(client) {
            await client.query(`
                ALTER TABLE api_call_logs DROP CONSTRAINT IF EXISTS api_call_logs_api_key_id_fkey;
                ALTER TABLE api_call_logs ADD CONSTRAINT api_call_logs_api_key_id_fkey FOREIGN KEY (api_key_id) REFERENCES api_keys(id) ON DELETE SET NULL;
            `);
        }
    }
];
