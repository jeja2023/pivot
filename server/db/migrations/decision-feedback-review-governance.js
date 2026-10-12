'use strict';

module.exports = [{
    id: '202610120001_decision_feedback_review_governance',
    description: 'Add an idempotent pending-review lifecycle for user-submitted route feedback.',
    async upPg(client) {
        await client.query(`
            ALTER TABLE decision_outcomes
                ADD COLUMN IF NOT EXISTS review_status VARCHAR(24) NOT NULL DEFAULT 'pending';
            ALTER TABLE decision_outcomes
                ADD COLUMN IF NOT EXISTS reviewed_by BIGINT REFERENCES users(id) ON DELETE SET NULL;
            ALTER TABLE decision_outcomes
                ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;
            ALTER TABLE decision_outcomes
                ADD COLUMN IF NOT EXISTS review_note TEXT NOT NULL DEFAULT '';

            UPDATE decision_outcomes
            SET review_status = 'not_required'
            WHERE event_type <> 'feedback' AND review_status = 'pending';

            WITH ranked_feedback AS (
                SELECT id,
                    ROW_NUMBER() OVER (PARTITION BY decision_id ORDER BY occurred_at DESC, id DESC) AS row_number
                FROM decision_outcomes
                WHERE event_type = 'feedback' AND source = 'user' AND review_status = 'pending'
            )
            UPDATE decision_outcomes outcome
            SET review_status = 'superseded'
            FROM ranked_feedback ranked
            WHERE outcome.id = ranked.id AND ranked.row_number > 1;

            CREATE INDEX IF NOT EXISTS idx_decision_outcomes_feedback_review
                ON decision_outcomes(review_status, occurred_at DESC)
                WHERE event_type = 'feedback' AND source = 'user';
            CREATE UNIQUE INDEX IF NOT EXISTS idx_decision_outcomes_one_pending_user_feedback
                ON decision_outcomes(decision_id)
                WHERE event_type = 'feedback' AND source = 'user' AND review_status = 'pending';
        `);
    }
}];
