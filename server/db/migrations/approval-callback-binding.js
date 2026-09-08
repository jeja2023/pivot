module.exports = [
    {
        id: '202609070002_signed_approval_callback_binding',
        description: 'Bind approval callbacks to one requirement and remove unsigned callback tokens.',
        up(db) {
            const columns = db.pragma('table_info(agent_approval_requests)');
            if (columns.length && !columns.some(column => column.name === 'callback_requirement_key')) {
                db.exec("ALTER TABLE agent_approval_requests ADD COLUMN callback_requirement_key TEXT DEFAULT ''");
            }
            db.exec("UPDATE agent_approval_requests SET callback_token_hash = NULL, callback_token_hint = '' WHERE COALESCE(callback_signature_required, 0) = 0");
        },
        async upPg(client) {
            await client.query(`
                ALTER TABLE agent_approval_requests ADD COLUMN IF NOT EXISTS callback_requirement_key TEXT DEFAULT '';
                UPDATE agent_approval_requests
                SET callback_token_hash = NULL, callback_token_hint = ''
                WHERE COALESCE(callback_signature_required, 0) = 0;
            `);
        }
    }
];
