'use strict';

const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');

// A distinct event loop enforces the deadline while the backup coordinator is
// hashing/serializing a large inventory. An ordinary timer on that coordinator
// cannot bound a write pause when its JavaScript thread is busy.
if (!isMainThread) {
    const { Client } = require('pg');
    const client = new Client({ connectionString: workerData.connection, application_name: 'pivot-physical-backup-watchdog', connectionTimeoutMillis: 10000 });
    let timer;
    client.on('error', error => parentPort.postMessage({ type: 'failed', message: error.message }));
    client.connect().then(async () => {
        await client.query("SET statement_timeout='2s'");
        parentPort.postMessage({ type: 'ready' });
        parentPort.on('message', async message => {
            if (message.type === 'arm') {
                clearTimeout(timer);
                timer = setTimeout(() => {
                    void client.query('SELECT pg_terminate_backend($1)', [message.pid]).then(() => parentPort.postMessage({ type: 'expired' }),
                        error => parentPort.postMessage({ type: 'failed', message: error.message }));
                }, Math.max(1, message.deadline - Date.now()));
                parentPort.postMessage({ type: 'armed' });
            } else if (message.type === 'stop') {
                clearTimeout(timer); await client.end(); parentPort.postMessage({ type: 'stopped' }); parentPort.close();
            }
        });
    }).catch(error => { parentPort.postMessage({ type: 'failed', message: error.message }); void client.end(); parentPort.close(); });
}

async function createBackupWatchdog(connection, onBackupDeadline) {
    const worker = new Worker(__filename, { workerData: { connection } });
    const waiters = new Map(); let failure, stopping = false;
    function fail(error) {
        failure = error; void onBackupDeadline?.();
        for (const waiter of waiters.values()) { clearTimeout(waiter.timer); waiter.reject(error); }
        waiters.clear();
    }
    worker.on('message', message => {
        if (message.type === 'expired' || message.type === 'failed') {
            fail(new Error('共同恢复点独立看护已超时或失效。'));
        }
        const waiter = waiters.get(message.type);
        if (waiter) { waiters.delete(message.type); clearTimeout(waiter.timer); waiter.resolve(); }
    });
    worker.on('error', error => {
        fail(error);
    });
    worker.on('exit', () => { if (!stopping && !failure) fail(new Error('共同恢复点独立看护提前退出。')); });
    function wait(type) {
        if (failure) return Promise.reject(failure);
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { waiters.delete(type); reject(new Error('独立看护响应超时。')); }, 15000);
            waiters.set(type, { resolve, reject, timer });
        });
    }
    try { await wait('ready'); }
    catch (error) { await worker.terminate(); throw error; }
    return {
        async arm(pid, deadline) { const armed = wait('armed'); worker.postMessage({ type: 'arm', pid, deadline }); await armed; },
        async stop() {
            stopping = true;
            if (failure) { await worker.terminate(); return; }
            try { const stopped = wait('stopped'); worker.postMessage({ type: 'stop' }); await stopped; }
            finally { await worker.terminate(); }
        }
    };
}

module.exports = { createBackupWatchdog };
