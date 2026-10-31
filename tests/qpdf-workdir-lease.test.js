'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fork } = require('node:child_process');
const test = require('node:test');
const { Client } = require('pg');
const { getPgPool } = require('../server/db/pg-connection');
const { tempRoot } = require('../server/services/document-processing/paths');
const { cleanupQpdfWorkdirs, withQpdfLease } = require('../server/services/document-processing/qpdf-workdir-lease');

test('qpdf 目录在持锁进程崩溃后回收，活动和未知目录保留', { skip: !process.env.DATABASE_URL, timeout: 30000 }, async () => {
    const child = fork(path.join(__dirname, 'fixtures/qpdf-lease-holder.js'), [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    let directory;
    let release;
    let activeTask;
    try {
        directory = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('租约进程启动超时')), 10000);
            child.once('message', message => { clearTimeout(timer); message.error ? reject(new Error(message.error)) : resolve(message.directory); });
            child.once('exit', code => { clearTimeout(timer); reject(new Error(`租约进程退出 ${code}`)); });
        });
        const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
        await fs.utimes(directory, old, old);
        const unknown = path.join(tempRoot, 'legacy-qpdf-preserve');
        await fs.mkdir(unknown, { recursive: true });
        await fs.utimes(unknown, old, old);
        let notify;
        const ready = new Promise(resolve => { notify = resolve; });
        const barrier = new Promise(resolve => { release = resolve; });
        activeTask = withQpdfLease(async active => { await fs.utimes(active, old, old); notify(active); await barrier; });
        const active = await ready;
        const first = await cleanupQpdfWorkdirs();
        assert.equal(first.removed, 0);
        assert.ok((await fs.stat(directory)).isDirectory());
        assert.ok((await fs.stat(active)).isDirectory());
        child.kill();
        await new Promise(resolve => child.once('exit', resolve));
        const second = await cleanupQpdfWorkdirs();
        assert.equal(second.removed, 1);
        await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
        assert.ok((await fs.stat(active)).isDirectory());
        assert.ok((await fs.stat(unknown)).isDirectory());
        await fs.rmdir(unknown);
    } finally {
        release?.();
        if (activeTask) await activeTask;
        if (child.exitCode === null && child.signalCode === null) { child.kill(); await new Promise(resolve => child.once('exit', resolve)); }
    }
});

test('数据库租约连接断开时中止在途操作并保留目录', { skip: !process.env.DATABASE_URL, timeout: 30000 }, async () => {
    const admin = new Client(getPgPool().options);
    await admin.connect();
    let directory;
    let pid;
    let notify;
    const ready = new Promise(resolve => { notify = resolve; });
    const task = withQpdfLease(async (dir, signal) => {
        directory = dir;
        const id = path.basename(dir).slice('qpdf-v2-'.length);
        const row = await admin.query("SELECT l.pid FROM pg_locks l WHERE l.locktype = 'advisory' AND l.granted AND l.classid = hashtext('pivot:qpdf-temp')::oid AND l.objid = hashtext(current_schema() || ':' || $1)::oid", [id]);
        pid = row.rows[0]?.pid;
        notify();
        if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    });
    try {
        await ready;
        assert.ok(pid);
        await admin.query('SELECT pg_terminate_backend($1)', [pid]);
        await assert.rejects(task, /租约已失效/);
        assert.ok((await fs.stat(directory)).isDirectory());
        const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
        await fs.utimes(directory, old, old);
        assert.equal((await cleanupQpdfWorkdirs()).removed, 1);
    } finally {
        await admin.end();
    }
});

test('qpdf 清理分批向前扫描，不被较新的目录永久挡住', { skip: !process.env.DATABASE_URL }, async () => {
    await fs.mkdir(tempRoot, { recursive: true });
    const recent = path.join(tempRoot, `qpdf-v2-${'1'.repeat(32)}`);
    const orphan = path.join(tempRoot, `qpdf-v2-${'f'.repeat(32)}`);
    await fs.mkdir(recent);
    await fs.mkdir(orphan);
    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    await fs.utimes(orphan, old, old);
    try {
        assert.equal((await cleanupQpdfWorkdirs({ limit: 1 })).removed, 0);
        assert.equal((await cleanupQpdfWorkdirs({ limit: 1 })).removed, 1);
        assert.ok((await fs.stat(recent)).isDirectory());
        await assert.rejects(fs.stat(orphan), { code: 'ENOENT' });
    } finally {
        await fs.rmdir(recent).catch(() => {});
        await fs.rmdir(orphan).catch(() => {});
    }
});
