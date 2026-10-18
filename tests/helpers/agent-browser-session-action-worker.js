'use strict';

const { closePgPool } = require('../../server/db/pg-connection');
const { closeAgentBrowserSession, executeAgentBrowserSessionAction } = require('../../server/services/agent-browser-sessions');

async function main() {
    const [sessionId, userId, profileRoot, action = 'inspect'] = process.argv.slice(2);
    try {
        if (action === 'close') await closeAgentBrowserSession(sessionId, { id: Number(userId) });
        else await executeAgentBrowserSessionAction({ sessionId, user: { id: Number(userId) }, input: { action: 'inspect' }, context: { profileRoot } });
        process.stdout.write(`RESULT:${JSON.stringify({ ok: true })}\n`);
    } catch (error) {
        process.stdout.write(`RESULT:${JSON.stringify({ ok: false, code: error.code || '' })}\n`);
    } finally {
        await closePgPool().catch(() => {});
    }
}

main().catch(error => { process.stderr.write(`${error.code || 'ERROR'}: ${error.message}\n`); process.exitCode = 1; });
