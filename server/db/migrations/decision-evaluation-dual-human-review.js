'use strict';

module.exports = [{
    id: '202610180015_decision_evaluation_dual_human_review',
    description: 'Require two distinct, agreeing human reviewers before a frozen decision evaluation case is verified.',
    async upPg(client) {
        await client.query(`
            WITH latest_reviews AS (
                SELECT DISTINCT ON (set_version, case_id, reviewer_id)
                    set_version, case_id, reviewer_id, expected_action_id
                FROM decision_evaluation_reviews
                WHERE reviewer_id IS NOT NULL
                ORDER BY set_version, case_id, reviewer_id, reviewed_at DESC, id DESC
            ), consensus AS (
                SELECT set_version, case_id, COUNT(*) AS reviewer_count,
                    MIN(expected_action_id) AS selected_action, MAX(expected_action_id) AS largest_action
                FROM latest_reviews
                GROUP BY set_version, case_id
            )
            UPDATE decision_evaluation_cases c
            SET review_status = 'pending_human_review',
                expected_action_id = '',
                reviewed_by = NULL,
                reviewed_at = NULL,
                review_note = '',
                updated_at = NOW()
            FROM consensus s
            WHERE c.set_version = s.set_version
              AND c.case_id = s.case_id
              AND c.review_status = 'verified'
              AND (s.reviewer_count < 2 OR s.selected_action <> s.largest_action);

            UPDATE decision_evaluation_cases c
            SET review_status = 'pending_human_review',
                expected_action_id = '',
                reviewed_by = NULL,
                reviewed_at = NULL,
                review_note = '',
                updated_at = NOW()
            WHERE c.review_status = 'verified'
              AND NOT EXISTS (
                SELECT 1 FROM decision_evaluation_reviews r
                WHERE r.set_version = c.set_version AND r.case_id = c.case_id AND r.reviewer_id IS NOT NULL
            );
        `);
    }
}];
