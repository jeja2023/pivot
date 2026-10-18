'use strict';

const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');
const { execute, queryOne } = require('../server/db/client');
const { createTaskTransaction, getTaskTransactionForUser, recordTaskTransactionVerification, stageTaskEffect, transitionTaskTransaction } = require('../server/services/agent-task-transactions');

async function createFixture(label) {
    const user = await queryOne('SELECT id FROM users ORDER BY id LIMIT 1');
    const runId = `resource-process-${label}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    await execute("INSERT INTO agent_runs (id, user_id, title, goal, status, metadata, created_at, updated_at) VALUES (?, ?, '资源租约测试', '测试跨进程互斥', 'running', '{}', NOW(), NOW())", [runId, user.id]);
    const run = { id: runId, user_id: user.id, goal: '测试跨进程互斥' };
    const transaction = await createTaskTransaction({ run, user });
    await transitionTaskTransaction(transaction.id, user, 'executing');
    return { run, user, transaction };
}

function startWorker() {
    const child = fork(path.join(__dirname, 'helpers', 'agent-task-resource-worker.js'), [], {
        cwd: path.join(__dirname, '..'), env: process.env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc']
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    return { child, exited, stderr: () => stderr };
}

function waitMessage(worker, type) {
    return new Promise((resolve, reject) => {
        if (worker.child.exitCode !== null || worker.child.signalCode !== null) {
            reject(new Error(`子进程已退出：${worker.stderr()}`));
            return;
        }
        const timeout = setTimeout(() => { cleanup(); reject(new Error(`子进程等待 ${type} 超时。`)); }, 20000);
        const onMessage = message => { if (message?.type === type) { cleanup(); resolve(message); } };
        const onExit = code => { cleanup(); reject(new Error(`子进程提前退出：${code} ${worker.stderr()}`)); };
        const onError = error => { cleanup(); reject(error); };
        const cleanup = () => { clearTimeout(timeout); worker.child.off('message', onMessage); worker.child.off('exit', onExit); worker.child.off('error', onError); };
        worker.child.on('message', onMessage);
        worker.child.once('exit', onExit);
        worker.child.once('error', onError);
    });
}

async function stopWorkers(workers) {
    for (const worker of workers) {
        if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill();
    }
    await Promise.all(workers.map(worker => worker.exited));
}

test('独立进程同时申请同一资源时只有一个事务取得租约', async () => {
    const fixtures = [];
    const workers = [];
    try {
        for (let index = 0; index < 6; index += 1) fixtures.push(await createFixture(`contend-${index}`));
        const ready = fixtures.map(() => { const worker = startWorker(); workers.push(worker); return waitMessage(worker, 'ready'); });
        await Promise.all(ready);
        const results = workers.map(worker => waitMessage(worker, 'result'));
        const resourceKey = `http-origin:https://multiprocess-${process.pid}-${Date.now()}.example`;
        workers.forEach((worker, index) => worker.child.send({ type: 'start', action: 'stage', userId: fixtures[index].user.id,
            transactionId: fixtures[index].transaction.id, resourceKey, operationKey: `${fixtures[index].run.id}:http` }));
        const settled = await Promise.all(results);
        assert.equal(new Set(settled.map(item => item.pid)).size, 6);
        assert.equal(settled.filter(item => item.ok).length, 1);
        assert.equal(settled.filter(item => item.code === 'AGENT_RESOURCE_LEASE_CONFLICT').length, 5);
        const states = await Promise.all(fixtures.map(item => getTaskTransactionForUser(item.transaction.id, item.user)));
        assert.equal(states.reduce((count, item) => count + item.effects.length, 0), 1);
    } finally {
        await stopWorkers(workers);
        for (const item of fixtures) await execute('DELETE FROM agent_runs WHERE id = ?', [item.run.id]);
    }
});

test('执行进程崩溃后租约到期仍不能被其他进程抢占', async () => {
    const holder = await createFixture('crash-holder');
    const waiter = await createFixture('crash-waiter');
    const workers = [];
    try {
        const resourceKey = `http-origin:https://crash-${process.pid}-${Date.now()}.example`;
        const effect = await stageTaskEffect(holder.transaction.id, holder.user, {
            effectType: 'agent.http', resourceKeys: [resourceKey], idempotencyKey: `${holder.run.id}:http`,
            commitMode: 'after_verify', compensation: { mode: 'none' }
        });
        await recordTaskTransactionVerification(holder.transaction.id, holder.user, { outcomeStatus: 'verified' });
        const owner = startWorker(); workers.push(owner);
        await waitMessage(owner, 'ready');
        const claimed = waitMessage(owner, 'claimed');
        owner.child.send({ type: 'start', action: 'claim', userId: holder.user.id, effectId: effect.id });
        await claimed;
        owner.child.kill();
        await owner.exited;
        assert.equal((await getTaskTransactionForUser(holder.transaction.id, holder.user)).effects[0].status, 'executing');
        await execute("UPDATE agent_task_resource_leases SET lease_expires_at = NOW() - INTERVAL '1 minute' WHERE effect_id = ?", [effect.id]);
        const contender = startWorker(); workers.push(contender);
        await waitMessage(contender, 'ready');
        const result = waitMessage(contender, 'result');
        contender.child.send({ type: 'start', action: 'stage', userId: waiter.user.id,
            transactionId: waiter.transaction.id, resourceKey, operationKey: `${waiter.run.id}:http` });
        assert.equal((await result).code, 'AGENT_RESOURCE_LEASE_CONFLICT');
        assert.equal((await getTaskTransactionForUser(waiter.transaction.id, waiter.user)).effects.length, 0);
    } finally {
        await stopWorkers(workers);
        await execute('DELETE FROM agent_runs WHERE id IN (?, ?)', [holder.run.id, waiter.run.id]);
    }
});
