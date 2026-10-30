'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');
const { spawn } = require('node:child_process');
const { queryOne, execute } = require('../server/db/client');
const { getPgPool } = require('../server/db/pg-connection');
const { documentRoot, pagesRoot, outputsRoot, tempRoot } = require('../server/services/document-processing/paths');
const { cleanupDocumentOrphans } = require('../server/services/document-processing/orphan-cleanup');
const { cleanupExpiredDocumentProcessingFiles } = require('../server/services/document-processing/cleanup');
const { recoverDocumentProcessingJobs } = require('../server/services/document-processing/jobs');

test('只清理过期且无引用的受控页面和输出，保留任务、导出及锁保护的文件', async () => {
    assert.match(String(process.env.PG_TEST_SCHEMA || ''), /^pivot_test_/, '只能在隔离测试 schema 中执行。');
    const suffix = `${process.pid}_${Date.now()}`;
    const user = await queryOne('INSERT INTO users (username, password_hash) VALUES (?, ?) RETURNING id', [`doc_gc_${suffix}`, 'hash']);
    const file = await queryOne("INSERT INTO document_files (user_id, original_name, file_type, file_ext, file_size, source_module, created_at, updated_at) VALUES (?, 'test.txt', 'text', '.txt', 1, 'document_processing', now(), now()) RETURNING id", [user.id]);
    const jobs = [];
    const addJob = async status => {
        const row = await queryOne("INSERT INTO document_jobs (user_id, file_id, job_type, status, source_module, created_at, updated_at) VALUES (?, ?, 'auto', ?, 'document_processing', NOW() - INTERVAL '45 days', NOW() - INTERVAL '45 days') RETURNING id", [user.id, file.id, status]);
        jobs.push(row.id);
        return row.id;
    };
    const userPages = path.join(pagesRoot, String(user.id));
    const userOutputs = path.join(outputsRoot, String(user.id));
    const userTemp = path.join(tempRoot, String(user.id));
    const owner = await getPgPool().connect();
    try {
        await fs.mkdir(userPages, { recursive: true });
        await fs.mkdir(userOutputs, { recursive: true });
        await fs.mkdir(userTemp, { recursive: true });
        const terminal = await addJob('succeeded');
        const processing = await addJob('processing');
        const locked = await addJob('failed');
        const exporting = await addJob('succeeded');
        const recentJob = await addJob('succeeded');
        await execute('UPDATE document_jobs SET updated_at = NOW() WHERE id = ?', [recentJob]);
        const aged = new Date(Date.now() - 40 * 86400000);
        const create = async (root, name, old = true) => {
            const target = path.join(root, name);
            await fs.writeFile(target, 'fixture');
            if (old) await fs.utimes(target, aged, aged);
            return target;
        };
        const pageName = () => `${terminal}-gc1-page-0001-${crypto.randomUUID()}.png`;
        const outputName = id => `${id}-gc1-pdf-${crypto.randomUUID()}.pdf`;
        const orphanPage = await create(userPages, pageName());
        const orphanOutput = await create(userOutputs, outputName(terminal));
        const referencedPage = await create(userPages, pageName());
        const referencedOutput = await create(userOutputs, outputName(terminal));
        const referencedSource = await create(userOutputs, outputName(terminal));
        const recent = await create(userOutputs, outputName(terminal), false);
        const active = await create(userOutputs, outputName(processing));
        const busy = await create(userOutputs, outputName(locked));
        const busyReferenced = await create(userOutputs, outputName(locked));
        const pending = await create(userOutputs, outputName(exporting));
        const recentlyUpdated = await create(userOutputs, outputName(recentJob));
        const missingJob = await create(userOutputs, outputName(2147483647));
        const unknown = await create(userOutputs, `${terminal}-unknown.txt`);
        const legacyOutput = await create(userOutputs, `${terminal}-pdf-${crypto.randomUUID()}.pdf`);
        const legacyPage = await create(userPages, `${terminal}-page-0001-${crypto.randomUUID()}.png`);
        const unlinkedTemp = await create(userTemp, `ocr-region-${crypto.randomUUID()}.png`);
        const pageRef = `document-processing/pages/${user.id}/./${path.basename(referencedPage)}`;
        const outputRef = `document-processing/outputs/${user.id}/./${path.basename(referencedOutput)}`;
        await queryOne("INSERT INTO document_pages (user_id, file_id, job_id, page_number, image_path, created_at, updated_at) VALUES (?, ?, ?, 1, ?, NOW(), NOW()) RETURNING id", [user.id, file.id, terminal, pageRef]);
        await queryOne("INSERT INTO document_outputs (user_id, file_id, job_id, output_type, file_path, file_name, mime_type, file_size, status, created_at) VALUES (?, ?, ?, 'pdf', ?, 'test.pdf', 'application/pdf', 7, 'ready', NOW()) RETURNING id", [user.id, file.id, terminal, outputRef]);
        await execute('UPDATE document_files SET file_path = ? WHERE id = ?', [`document-processing/outputs/${user.id}/${path.basename(referencedSource)}`, file.id]);
        await execute("INSERT INTO document_exports (id, user_id, job_id, output_format, status) VALUES (?, ?, ?, 'txt', 'queued')", [`export_${suffix}`, user.id, exporting]);
        await owner.query("SELECT pg_advisory_lock(hashtext('pivot_document_job'), hashtext($1::text))", [String(locked)]);
        const result = await cleanupDocumentOrphans();
        assert.equal(result.deleted, 2);
        for (const target of [orphanPage, orphanOutput]) await assert.rejects(fs.access(target), { code: 'ENOENT' });
        for (const target of [referencedPage, referencedOutput, referencedSource, recent, recentlyUpdated, active, busy, busyReferenced, pending, missingJob, unknown, legacyOutput, legacyPage, unlinkedTemp]) await fs.access(target);
        await queryOne("INSERT INTO document_outputs (user_id, file_id, job_id, output_type, file_path, file_name, mime_type, file_size, status, created_at) VALUES (?, ?, ?, 'pdf', ?, 'late.pdf', 'application/pdf', 7, 'ready', NOW()) RETURNING id", [user.id, file.id, locked, `document-processing/outputs/${user.id}/${path.basename(busyReferenced)}`]);
        await owner.query("SELECT pg_advisory_unlock(hashtext('pivot_document_job'), hashtext($1::text))", [String(locked)]);
        await execute("UPDATE document_exports SET status = 'failed' WHERE id = ?", [`export_${suffix}`]);
        const next = await cleanupDocumentOrphans();
        assert.equal(next.deleted, 2);
        await assert.rejects(fs.access(busy), { code: 'ENOENT' });
        await assert.rejects(fs.access(pending), { code: 'ENOENT' });
        for (const target of [referencedPage, referencedOutput, referencedSource, busyReferenced, recent, recentlyUpdated, active, missingJob, unknown, legacyOutput, legacyPage, unlinkedTemp]) await fs.access(target);
    } finally {
        owner.release();
        await execute('DELETE FROM document_exports WHERE user_id = ?', [user.id]);
        await execute('DELETE FROM document_outputs WHERE user_id = ?', [user.id]);
        await execute('DELETE FROM document_pages WHERE user_id = ?', [user.id]);
        for (const id of jobs) await execute('DELETE FROM document_jobs WHERE id = ?', [id]);
        await execute('DELETE FROM document_files WHERE id = ?', [file.id]);
        await execute('DELETE FROM users WHERE id = ?', [user.id]);
        for (const dir of [userPages, userOutputs, userTemp]) {
            assert.equal(path.dirname(path.dirname(dir)), documentRoot);
            assert.equal(path.basename(dir), String(user.id));
            assert.equal((await fs.lstat(dir)).isSymbolicLink(), false);
            assert.equal(await fs.realpath(dir), path.resolve(dir));
            await fs.rm(dir, { recursive: true, force: true });
        }
    }
});

test('强制终止执行器后恢复任务，再清理超过保留期的未登记页面', { timeout: 45000 }, async () => {
    assert.match(String(process.env.PG_TEST_SCHEMA || ''), /^pivot_test_/, '只能在隔离测试 schema 中执行。');
    const suffix = `${process.pid}_${Date.now()}_killed`;
    const user = await queryOne('INSERT INTO users (username, password_hash) VALUES (?, ?) RETURNING id', [`doc_gc_${suffix}`, 'hash']);
    const file = await queryOne("INSERT INTO document_files (user_id, original_name, file_type, file_ext, file_size, source_module, created_at, updated_at) VALUES (?, 'missing.txt', 'text', '.txt', 1, 'document_processing', now(), now()) RETURNING id", [user.id]);
    const job = await queryOne("INSERT INTO document_jobs (user_id, file_id, job_type, status, source_module, attempts, max_attempts, lease_owner, locked_at, lease_until, created_at, updated_at) VALUES (?, ?, 'auto', 'processing', 'document_processing', 1, 3, 'scoped-v1:test', NOW(), NOW() + INTERVAL '10 minutes', NOW(), NOW()) RETURNING id", [user.id, file.id]);
    const dir = path.join(pagesRoot, String(user.id));
    const worker = spawn(process.execPath, [path.join(__dirname, 'helpers', 'document-orphan-writer.js'), String(job.id), String(user.id)], { env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = new Promise(resolve => worker.once('exit', resolve));
    let timer;
    try {
        const page = await new Promise((resolve, reject) => {
            let output = '';
            timer = setTimeout(() => reject(new Error('测试执行器未就绪')), 15000);
            worker.once('error', reject);
            worker.once('exit', code => reject(new Error(`测试执行器提前退出：${code}`)));
            worker.stdout.on('data', chunk => {
                output += String(chunk);
                const match = output.match(/READY:(\{[^\r\n]+\})/);
                if (match) resolve(JSON.parse(match[1]));
            });
        });
        clearTimeout(timer);
        const target = path.join(dir, path.basename(page.imagePath));
        const old = new Date(Date.now() - 40 * 86400000);
        await fs.utimes(target, old, old);
        assert.equal((await cleanupDocumentOrphans()).deleted, 0);
        await fs.access(target);
        worker.kill();
        await exited;
        await execute("UPDATE document_jobs SET lease_until = NOW() - INTERVAL '1 second' WHERE id = ?", [job.id]);
        assert.equal((await recoverDocumentProcessingJobs()).requeued, 1);
        const deadline = Date.now() + 10000;
        let status;
        while (Date.now() < deadline) {
            status = (await queryOne('SELECT status FROM document_jobs WHERE id = ?', [job.id])).status;
            if (status === 'failed') break;
            await new Promise(resolve => setTimeout(resolve, 25));
        }
        assert.equal(status, 'failed');
        await execute("UPDATE document_jobs SET updated_at = NOW() - INTERVAL '40 days' WHERE id = ?", [job.id]);
        const maintenance = await cleanupExpiredDocumentProcessingFiles({ retentionDays: 1 });
        assert.equal(maintenance.orphans?.retentionDays, 30);
        assert.equal(maintenance.orphans?.deleted, 1);
        await assert.rejects(fs.access(target), { code: 'ENOENT' });
    } finally {
        clearTimeout(timer);
        if (worker.exitCode === null && worker.signalCode === null) { worker.kill(); await exited; }
        await execute('DELETE FROM document_jobs WHERE id = ?', [job.id]);
        await execute('DELETE FROM document_files WHERE id = ?', [file.id]);
        await execute('DELETE FROM users WHERE id = ?', [user.id]);
        assert.equal(path.dirname(path.dirname(dir)), documentRoot);
        assert.equal(path.basename(dir), String(user.id));
        const present = await fs.lstat(dir).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
        if (present) {
            assert.equal(present.isSymbolicLink(), false);
            assert.equal(await fs.realpath(dir), path.resolve(dir));
            await fs.rm(dir, { recursive: true, force: true });
        }
    }
});

test('目录链接不会使清理离开受控位置', async () => {
    assert.match(String(process.env.PG_TEST_SCHEMA || ''), /^pivot_test_/, '只能在隔离测试 schema 中执行。');
    const suffix = `${process.pid}_${Date.now()}_link`;
    const user = await queryOne('INSERT INTO users (username, password_hash) VALUES (?, ?) RETURNING id', [`doc_gc_${suffix}`, 'hash']);
    const file = await queryOne("INSERT INTO document_files (user_id, original_name, file_type, file_ext, file_size, source_module, created_at, updated_at) VALUES (?, 'test.txt', 'text', '.txt', 1, 'document_processing', now(), now()) RETURNING id", [user.id]);
    const job = await queryOne("INSERT INTO document_jobs (user_id, file_id, job_type, status, source_module, created_at, updated_at) VALUES (?, ?, 'auto', 'failed', 'document_processing', NOW() - INTERVAL '45 days', NOW() - INTERVAL '45 days') RETURNING id", [user.id, file.id]);
    const fixtureRoot = path.resolve(process.env.DATA_DIR, `doc-gc-link-${suffix}`);
    const link = path.join(pagesRoot, String(user.id));
    let linked = false;
    try {
        await fs.mkdir(fixtureRoot, { recursive: true });
        await fs.mkdir(pagesRoot, { recursive: true });
        const target = path.join(fixtureRoot, `${job.id}-gc1-page-0001-${crypto.randomUUID()}.png`);
        await fs.writeFile(target, 'outside');
        const old = new Date(Date.now() - 40 * 86400000);
        await fs.utimes(target, old, old);
        await fs.symlink(fixtureRoot, link, process.platform === 'win32' ? 'junction' : 'dir');
        linked = true;
        assert.equal((await fs.lstat(link)).isSymbolicLink(), true);
        assert.equal((await cleanupDocumentOrphans()).deleted, 0);
        assert.equal(await fs.readFile(target, 'utf8'), 'outside');
    } finally {
        if (linked) {
            assert.equal(path.dirname(link), pagesRoot);
            assert.equal((await fs.lstat(link)).isSymbolicLink(), true);
            if (process.platform === 'win32') await fs.rmdir(link);
            else await fs.unlink(link);
        }
        await execute('DELETE FROM document_jobs WHERE id = ?', [job.id]);
        await execute('DELETE FROM document_files WHERE id = ?', [file.id]);
        await execute('DELETE FROM users WHERE id = ?', [user.id]);
        assert.equal(path.dirname(fixtureRoot), path.resolve(process.env.DATA_DIR));
        assert.equal(path.basename(fixtureRoot), `doc-gc-link-${suffix}`);
        assert.equal(await fs.realpath(fixtureRoot), fixtureRoot);
        await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
});

test('数据库异常时保留文件，恢复后分批推进，不清理短保留期或未知文件', async () => {
    assert.match(String(process.env.PG_TEST_SCHEMA || ''), /^pivot_test_/, '只能在隔离测试 schema 中执行。');
    const suffix = `${process.pid}_${Date.now()}_batch`;
    const user = await queryOne('INSERT INTO users (username, password_hash) VALUES (?, ?) RETURNING id', [`doc_gc_${suffix}`, 'hash']);
    const file = await queryOne("INSERT INTO document_files (user_id, original_name, file_type, file_ext, file_size, source_module, created_at, updated_at) VALUES (?, 'test.txt', 'text', '.txt', 1, 'document_processing', now(), now()) RETURNING id", [user.id]);
    const job = await queryOne("INSERT INTO document_jobs (user_id, file_id, job_type, status, source_module, created_at, updated_at) VALUES (?, ?, 'auto', 'failed', 'document_processing', NOW() - INTERVAL '45 days', NOW() - INTERVAL '45 days') RETURNING id", [user.id, file.id]);
    const dir = path.join(outputsRoot, String(user.id));
    let renamed = false;
    try {
        await fs.mkdir(dir, { recursive: true });
        const old = new Date(Date.now() - 40 * 86400000);
        const recent = new Date(Date.now() - 2 * 86400000);
        const names = [0, 1, 2].map(() => `${job.id}-gc1-pdf-${crypto.randomUUID()}.pdf`);
        for (const name of names) { const target = path.join(dir, name); await fs.writeFile(target, 'old'); await fs.utimes(target, old, old); }
        const fresh = path.join(dir, `${job.id}-gc1-pdf-${crypto.randomUUID()}.pdf`);
        await fs.writeFile(fresh, 'recent'); await fs.utimes(fresh, recent, recent);
        const unknown = path.join(dir, 'unrecognized.tmp');
        await fs.writeFile(unknown, 'unknown'); await fs.utimes(unknown, old, old);
        await execute('ALTER TABLE document_exports RENAME TO document_exports_gc_test');
        renamed = true;
        await assert.rejects(cleanupDocumentOrphans({ limit: 1, retentionDays: 1 }));
        for (const name of names) await fs.access(path.join(dir, name));
        await execute('ALTER TABLE document_exports_gc_test RENAME TO document_exports');
        renamed = false;
        let deleted = 0;
        for (let index = 0; index < 8 && deleted < names.length; index += 1) {
            const result = await cleanupDocumentOrphans({ limit: 1, retentionDays: 1 });
            assert.equal(result.retentionDays, 30);
            deleted += result.deleted;
        }
        assert.equal(deleted, names.length);
        for (const name of names) await assert.rejects(fs.access(path.join(dir, name)), { code: 'ENOENT' });
        await fs.access(fresh);
        await fs.access(unknown);
    } finally {
        if (renamed) await execute('ALTER TABLE document_exports_gc_test RENAME TO document_exports');
        await execute('DELETE FROM document_jobs WHERE id = ?', [job.id]);
        await execute('DELETE FROM document_files WHERE id = ?', [file.id]);
        await execute('DELETE FROM users WHERE id = ?', [user.id]);
        assert.equal(path.dirname(path.dirname(dir)), documentRoot);
        assert.equal(path.basename(dir), String(user.id));
        assert.equal((await fs.lstat(dir)).isSymbolicLink(), false);
        assert.equal(await fs.realpath(dir), path.resolve(dir));
        await fs.rm(dir, { recursive: true, force: true });
    }
});
