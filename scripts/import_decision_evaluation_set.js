'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const { importFrozenDecisionEvaluationSet } = require('../server/services/decision-evaluation-reviews');

const userId = Number.parseInt(process.argv[2], 10);
if (!Number.isSafeInteger(userId) || userId <= 0) {
    console.error('用法：node scripts/import_decision_evaluation_set.js <管理员用户ID>');
    process.exit(1);
}

importFrozenDecisionEvaluationSet({ userId })
    .then(result => {
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
        process.exit(0);
    })
    .catch(error => {
        console.error(error.stack || error.message);
        process.exit(1);
    });
