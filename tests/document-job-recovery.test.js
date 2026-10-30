'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { execute, queryOne } = require('../server/db/client');
const { getPgPool } = require('../server/db/pg-connection');
const { recoverDocumentProcessingJobs } = require('../server/services/document-processing/jobs');

test('文档任务租约到期时不抢占持锁执行器，锁释放后可以恢复', async () => {
    const suffix = `${process.pid}_${Date.now()}`;
    const user = await queryOne('INSERT INTO users (username, password_hash) VALUES (?, ?) RETURNING id', [`document_recovery_${suffix}`, 'hash']);
    const file = await queryOne("INSERT INTO document_files (user_id, original_name, file_type, file_ext, file_size, source_module, created_at, updated_at) VALUES (?, 'missing.txt', 'text', '.txt', 1, 'document_processing', now(), now()) RETURNING id", [user.id]);
    const job = await queryOne("INSERT INTO document_jobs (user_id, file_id, job_type, status, source_module, attempts, max_attempts, lease_owner, locked_at, lease_until, created_at, updated_at) VALUES (?, ?, 'auto', 'processing', 'document_processing', 1, 3, 'scoped-v1:test', NOW() - INTERVAL '1 minute', NOW() - INTERVAL '1 second', NOW(), NOW()) RETURNING id", [user.id, file.id]);
    const owner = await getPgPool().connect();
    try {
        await owner.query("SELECT pg_advisory_lock(hashtext('pivot_document_job'), hashtext($1::text))", [String(job.id)]);
        await recoverDocumentProcessingJobs();
        assert.equal((await queryOne('SELECT status FROM document_jobs WHERE id = ?', [job.id])).status, 'processing');
        await owner.query("SELECT pg_advisory_unlock(hashtext('pivot_document_job'), hashtext($1::text))", [String(job.id)]);
        const result = await recoverDocumentProcessingJobs();
        assert.equal(result.requeued, 1);
        const deadline = Date.now() + 10000;
        let current;
        while (Date.now() < deadline) {
            current = await queryOne('SELECT status FROM document_jobs WHERE id = ?', [job.id]);
            if (current.status === 'failed') break;
            await new Promise(resolve => setTimeout(resolve, 25));
        }
        assert.equal(current.status, 'failed');
    } finally {
        await owner.query("SELECT pg_advisory_unlock(hashtext('pivot_document_job'), hashtext($1::text))", [String(job.id)]).catch(() => {});
        owner.release();
        await execute('DELETE FROM document_jobs WHERE id = ?', [job.id]);
        await execute('DELETE FROM document_files WHERE id = ?', [file.id]);
        await execute('DELETE FROM users WHERE id = ?', [user.id]);
    }
});

test('旧版本租约保留保守恢复窗口', async () => {
    const suffix = `${process.pid}_${Date.now()}_legacy`;
    const user = await queryOne('INSERT INTO users (username, password_hash) VALUES (?, ?) RETURNING id', [`document_recovery_${suffix}`, 'hash']);
    const file = await queryOne("INSERT INTO document_files (user_id, original_name, file_type, file_ext, file_size, source_module, created_at, updated_at) VALUES (?, 'missing.txt', 'text', '.txt', 1, 'document_processing', now(), now()) RETURNING id", [user.id]);
    const job = await queryOne("INSERT INTO document_jobs (user_id, file_id, job_type, status, source_module, attempts, max_attempts, lease_owner, locked_at, lease_until, created_at, updated_at) VALUES (?, ?, 'auto', 'processing', 'document_processing', 1, 3, 'legacy-worker', NOW() - INTERVAL '16 minutes', NOW() - INTERVAL '1 second', NOW(), NOW()) RETURNING id", [user.id, file.id]);
    try {
        assert.equal((await recoverDocumentProcessingJobs()).requeued, 0);
        assert.equal((await queryOne('SELECT status FROM document_jobs WHERE id = ?', [job.id])).status, 'processing');
        await execute("UPDATE document_jobs SET lease_until = NOW() - INTERVAL '16 minutes' WHERE id = ?", [job.id]);
        assert.equal((await recoverDocumentProcessingJobs()).requeued, 1);
        const deadline = Date.now() + 10000;
        let row;
        while (Date.now() < deadline) {
            row = await queryOne('SELECT status FROM document_jobs WHERE id = ?', [job.id]);
            if (row.status === 'failed') break;
            await new Promise(resolve => setTimeout(resolve, 25));
        }
        assert.equal(row.status, 'failed');
    } finally {
        await execute('DELETE FROM document_jobs WHERE id = ?', [job.id]);
        await execute('DELETE FROM document_files WHERE id = ?', [file.id]);
        await execute('DELETE FROM users WHERE id = ?', [user.id]);
    }
});
