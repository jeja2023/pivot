'use strict';

const { closePgPool } = require('../../server/db/pg-connection');
const { createBrowserSessionLeaseStore } = require('../../server/services/agent-browser-session-leases');

async function main() {
    const [sessionId, userId, ownerId] = process.argv.slice(2);
    try {
        const result = await createBrowserSessionLeaseStore().acquireBrowserSessionLease({ sessionId, userId: Number(userId), ownerId });
        process.stdout.write(`RESULT:${JSON.stringify({ acquired: result.acquired, reason: result.reason || '' })}\n`);
    } finally {
        await closePgPool().catch(() => {});
    }
}

main().catch(error => { process.stderr.write(`${error.code || 'ERROR'}: ${error.message}\n`); process.exitCode = 1; });
