const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');

const MAX_HASH_WORKERS = 8;

function normalizeWorkerCount(value, itemCount) {
    const available = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
    const fallback = Math.min(Math.max(available - 1, 1), 4);
    return Math.min(Math.max(Number.parseInt(value, 10) || fallback, 1), MAX_HASH_WORKERS, Math.max(itemCount, 1));
}

function runHashWorker(entries, rounds) {
    const workerPath = path.join(__dirname, 'password-hash-worker.js');
    return new Promise((resolve, reject) => {
        const worker = new Worker(workerPath, { resourceLimits: { maxOldGenerationSizeMb: 64 } });
        let settled = false;
        const finish = (error, value) => {
            if (settled) return;
            settled = true;
            worker.terminate().catch(() => {});
            error ? reject(error) : resolve(value);
        };
        worker.once('message', message => {
            if (!message?.ok) return finish(new Error(message?.error || '密码哈希 Worker 执行失败'));
            return finish(null, message.results || []);
        });
        worker.once('error', error => finish(error));
        worker.once('exit', code => {
            if (!settled && code !== 0) finish(new Error(`密码哈希 Worker 异常退出：${code}`));
        });
        worker.postMessage({ entries, rounds });
    });
}

async function hashPasswordsOffThread(passwords, options = {}) {
    const values = Array.isArray(passwords) ? passwords.map(value => String(value || '')) : [];
    if (values.length === 0) return [];
    const workerCount = normalizeWorkerCount(options.workerCount ?? process.env.ADMIN_USER_IMPORT_HASH_WORKERS, values.length);
    const partitions = Array.from({ length: workerCount }, () => []);
    values.forEach((password, index) => partitions[index % workerCount].push({ index, password }));
    const groups = await Promise.all(partitions.filter(group => group.length).map(group => runHashWorker(group, options.rounds || 10)));
    const hashes = new Array(values.length);
    for (const item of groups.flat()) hashes[item.index] = item.hash;
    if (hashes.some(value => !value)) throw new Error('密码哈希结果不完整');
    return hashes;
}

module.exports = { MAX_HASH_WORKERS, hashPasswordsOffThread, normalizeWorkerCount };
