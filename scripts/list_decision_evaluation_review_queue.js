'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const { queryOne } = require('../server/db/client');
const { listDecisionEvaluationCases } = require('../server/services/decision-evaluation-reviews');

function arg(name, fallback = '') {
    const index = process.argv.indexOf(name);
    return index >= 0 ? String(process.argv[index + 1] || fallback) : fallback;
}

function printUsage() {
    console.log('用法：node scripts/list_decision_evaluation_review_queue.js --reviewer-id <管理员ID> [--version v2]');
}

function normalizeCase(value = {}) {
    const context = value.inputContext && typeof value.inputContext === 'object' ? value.inputContext : {};
    const requestState = context.requestState && typeof context.requestState === 'object' ? context.requestState : {};
    const candidates = (Array.isArray(value.candidates) ? value.candidates : []).filter(item => item?.allowed !== false).map(item => ({
        id: String(item.id || ''), description: String(item.description || '')
    }));
    return {
        caseId: String(value.caseId || ''), scenario: String(value.scenario || ''), language: String(value.language || ''),
        reviewStatus: String(value.reviewStatus || ''), expectedActionId: String(value.expectedActionId || ''),
        routingText: String(requestState.routingText || ''), candidates
    };
}

async function main() {
    if (process.argv.includes('--help') || process.argv.includes('-h')) { printUsage(); return; }
    const reviewerId = Number.parseInt(arg('--reviewer-id'), 10);
    const version = arg('--version', 'v2');
    if (!Number.isSafeInteger(reviewerId) || reviewerId <= 0) { printUsage(); throw new Error('decision_review_queue_reviewer_required'); }
    const reviewer = await queryOne("SELECT id, role, status, deleted_at FROM users WHERE id = ?", [reviewerId]);
    if (!reviewer || reviewer.deleted_at || reviewer.status === 'disabled' || reviewer.role !== 'admin') throw new Error('decision_review_queue_admin_required');
    const cases = (await listDecisionEvaluationCases({ version, limit: 500 })).map(normalizeCase);
    process.stdout.write(JSON.stringify({
        version, reviewerId, total: cases.length, pending: cases.filter(item => item.reviewStatus !== 'verified').length, cases
    }, null, 2) + '\n');
}

main().then(() => process.exit(0)).catch(error => {
    console.error(error.stack || error.message);
    process.exit(1);
});

