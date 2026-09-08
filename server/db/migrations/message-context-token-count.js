module.exports = [
    {
        id: '202609080005_message_context_token_count',
        description: 'Persist context-safe token counts so session usage reads do not reload assistant bodies.',
        up(db) {
            const columns = db.pragma('table_info(messages)');
            if (columns.length && !columns.some(column => column.name === 'context_token_count')) {
                db.exec('ALTER TABLE messages ADD COLUMN context_token_count INTEGER');
            }
        },
        async upPg(client) {
            await client.query('ALTER TABLE messages ADD COLUMN IF NOT EXISTS context_token_count BIGINT');
        }
    }
];
