'use strict';
const { Client } = require('pg');
const { getPgPool } = require('../db/pg-connection');
const { runWithScopedSession } = require('../db/scoped-session');

// 独立连接避免任务锁占满业务连接池；进程退出时 PostgreSQL 自动释放锁。
async function withDocumentJobLock(jobId, run) {
    const client = new Client({ ...getPgPool().options, application_name: `pivot-document-job-${jobId}` });
    let locked = false;
    let broken = false;
    const onError = () => { broken = true; };
    client.on('error', onError);
    try {
        await client.connect();
        const result = await client.query("SELECT pg_try_advisory_lock(hashtext('pivot_document_job'), hashtext($1::text)) AS locked", [String(jobId)]);
        locked = result.rows[0]?.locked === true;
        return locked ? await runWithScopedSession(client, run) : null;
    } finally {
        try {
            if (locked && !broken) await client.query("SELECT pg_advisory_unlock(hashtext('pivot_document_job'), hashtext($1::text))", [String(jobId)]);
        } catch (_) { broken = true; }
        await client.end().catch(() => {});
        client.removeListener('error', onError);
    }
}

module.exports = { withDocumentJobLock };
