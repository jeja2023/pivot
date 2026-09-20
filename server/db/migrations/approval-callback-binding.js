module.exports = [
    {
        id: '202609070002_signed_approval_callback_binding',
        description: 'Bind approval callbacks to one requirement and remove unsigned callback tokens.',
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
