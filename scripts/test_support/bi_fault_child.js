'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Readable } = require('node:stream');

assert.match(process.env.PG_TEST_SCHEMA || '', /^pivot_test_/);
const input = JSON.parse(process.argv[2]);
const parked = () => new Promise(resolve => process.once('message', resolve));

async function main() {
    if (input.mode === 'object') {
        const objects = require('../../server/services/data-analysis/bi/objects');
        if (input.phase === 'partial_write') {
            const stream = Readable.from((async function* bytes() {
                yield Buffer.alloc(65536, 'p');
                await new Promise(resolve => setTimeout(resolve, 100));
                const directory = path.join(objects.store.casRoot(), objects.store.TEMP_DIR_NAME);
                const name = (await fs.readdir(directory)).find(file => file.startsWith(`${process.pid}-`));
                assert.equal((await fs.stat(path.join(directory, name))).size, 65536);
                process.send({ phase: input.phase });
                await parked();
            })());
            await objects.store.writeStreamToTemp(stream, 1024 ** 2);
            return;
        }
        await objects.importFile({ file: input.file, userId: input.userId, fault: async phase => {
            if (phase === input.phase) { process.send({ phase }); await parked(); }
        } });
    } else if (input.mode === 'publish') {
        await require('../../server/services/data-analysis/bi/jobs').publishModel(input.request);
        process.send({ phase: 'committed' });
        await parked();
    } else if (input.mode === 'lease') {
        const jobs = require('../../server/repositories/analysis-model-jobs');
        const claim = await jobs.claim({ owner: `fault_child_${process.pid}` });
        assert.equal(claim.id, input.jobId);
        process.send({ phase: 'claimed', epoch: claim.execution_epoch });
        await parked();
        const renewed = await jobs.renew(claim);
        const completed = await jobs.complete(claim, { report: { passed: true, complete: true }, authorize: () => { throw new Error('过期进程不得进入授权或提交'); } });
        process.send({ phase: 'old_resumed', renewed, completed });
    }
    await require('../../server/db/pg-connection').closePgPool();
    process.disconnect();
}

main().catch(error => { process.send?.({ failure: error.code || error.message }); process.exitCode = 1; process.disconnect?.(); });
