'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const { queryOne } = require('../server/db/client');
const { reviewDecisionEvaluationCase } = require('../server/services/decision-evaluation-reviews');

function arg(name, fallback = '') {
    const index = process.argv.indexOf(name);
    return index >= 0 ? String(process.argv[index + 1] || fallback) : fallback;
}

function printUsage() {
    console.log('用法：node scripts/review_decision_evaluation_case.js --reviewer-id <管理员ID> --version v2 --case-id <案例ID> --expected-action-id <允许动作ID> [--note <审核说明>]');
}

async function main() {
    if (process.argv.includes('--help') || process.argv.includes('-h')) {
        printUsage();
        return;
    }
    const reviewerId = Number.parseInt(arg('--reviewer-id'), 10);
    const version = arg('--version');
    const caseId = arg('--case-id');
    const expectedActionId = arg('--expected-action-id');
    const reviewNote = arg('--note');
    if (!Number.isSafeInteger(reviewerId) || reviewerId <= 0 || !version || !caseId || !expectedActionId) {
        printUsage();
        throw new Error('decision_review_cli_arguments_invalid');
    }
    const reviewer = await queryOne("SELECT id, username, role, status, deleted_at FROM users WHERE id = ?", [reviewerId]);
    if (!reviewer || reviewer.deleted_at || reviewer.status === 'disabled' || reviewer.role !== 'admin') {
        throw new Error('decision_review_cli_admin_required');
    }
    const review = await reviewDecisionEvaluationCase({
        version, caseId, expectedActionId, reviewNote, reviewerId
    });
    if (!review) throw new Error('decision_review_case_not_found');
    process.stdout.write(JSON.stringify({ success: true, review }, null, 2) + '\n');
}

main().then(() => process.exit(0)).catch(error => {
    console.error(error.stack || error.message);
    process.exit(1);
});

