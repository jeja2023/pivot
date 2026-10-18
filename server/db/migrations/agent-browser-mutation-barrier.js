'use strict';

module.exports = [{
    id: '202610180012_agent_browser_mutation_barrier',
    description: 'Persist browser mutation recovery barriers before actions and conservatively protect existing active sessions.',
    async upPg(client) {
        await client.query(`
            ALTER TABLE agent_browser_sessions
            ADD COLUMN IF NOT EXISTS mutation_pending_recovery BOOLEAN NOT NULL DEFAULT FALSE;
            UPDATE agent_browser_sessions s SET mutation_pending_recovery = TRUE
            WHERE s.status IN ('active', 'needs_user_recovery')
              AND (s.last_action IN ('click', 'fill', 'select', 'mutation_intent') OR EXISTS (
                  SELECT 1 FROM agent_browser_action_evidence e
                  WHERE e.session_id = s.id AND e.action IN ('click', 'fill', 'select')
              ));
        `);
    }
}];
