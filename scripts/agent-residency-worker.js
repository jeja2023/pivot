const { closePgPool } = require('../server/db/pg-connection');
const { createAgentResidencyStore } = require('../server/services/agent-residency');

async function main() {
    const userId = Number(process.argv[2]);
    const residentKey = String(process.argv[3] || '');
    const leaseOwner = String(process.argv[4] || `worker-${process.pid}`);
    const store = createAgentResidencyStore({ maxEntries: 4, idleTtlMs: 3600000, leaseMs: 30000 });
    try {
        const resident = await store.acquireResidentLease({ userId, residentKey, leaseOwner });
        process.stdout.write(`RESULT:${JSON.stringify({ pid: process.pid, acquired: Boolean(resident), residentId: resident?.resident_id || null })}\n`);
    } catch (error) {
        process.stderr.write(String(error.stack || error.message || error));
        process.exitCode = 1;
    } finally {
        await closePgPool().catch(() => {});
    }
}

if (require.main === module) main();
