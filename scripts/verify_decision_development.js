'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const { getDecisionDevelopmentReadiness } = require('../server/services/decision-development-readiness');

async function main() {
    const report = await getDecisionDevelopmentReadiness({ env: process.env });
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    if (report.status !== 'ok') process.exitCode = 1;
}

main().then(() => process.exit(process.exitCode || 0)).catch(error => {
    console.error(error.stack || error.message);
    process.exit(1);
});

