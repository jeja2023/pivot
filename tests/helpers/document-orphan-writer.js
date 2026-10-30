'use strict';
const { withDocumentJobLock } = require('../../server/repositories/document-job-lock');
const { writePageBuffer } = require('../../server/services/document-processing/renderers');

const jobId = Number(process.argv[2]);
const userId = Number(process.argv[3]);
withDocumentJobLock(jobId, async () => {
    const page = await writePageBuffer({ userId, jobId, pageNumber: 1, buffer: Buffer.from('isolated-test-page') });
    process.stdout.write(`READY:${JSON.stringify(page)}\n`);
    await new Promise(() => {});
}).catch(error => { console.error(error.message); process.exitCode = 1; });
