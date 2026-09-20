'use strict';

module.exports = [{
    id: '202608220008_workflow_credential_user_visibility',
    description: 'Persist individual user targets for shared workflow credentials.',
    async upPg(client) {
        await client.query(`
            ALTER TABLE workflow_credentials
            ADD COLUMN IF NOT EXISTS allowed_user_ids TEXT DEFAULT '';
            UPDATE workflow_credentials
            SET allowed_user_ids = ''
            WHERE allowed_user_ids IS NULL;
        `);
    }
}];
