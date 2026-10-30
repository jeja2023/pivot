'use strict';
const { queryOne } = require('../../server/db/client');
const { closePgPool } = require('../../server/db/pg-connection');
const { refreshAppSettingsCache } = require('../../server/services/app-settings');
const { recoverDocumentProcessingJobs } = require('../../server/services/document-processing/jobs');

(async () => {
    const id = Number(process.argv[2]);
    await refreshAppSettingsCache();
    await recoverDocumentProcessingJobs();
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
        const row = await queryOne('SELECT status FROM document_jobs WHERE id = ?', [id]);
        if (row?.status === 'succeeded') {
            await new Promise(resolve => setTimeout(resolve, 200));
            await closePgPool();
            return;
        }
        if (row?.status === 'failed') throw new Error('恢复任务失败');
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('恢复任务超时');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
