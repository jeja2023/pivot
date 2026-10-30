const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');
const { ConcurrencySemaphore } = require('./concurrency');

const MAX_HASH_WORKERS = 8;
const authHashSemaphore = new ConcurrencySemaphore({ maxConcurrent: Math.min(Math.max((os.availableParallelism?.() || 2) - 1, 1), 4), maxQueueSize: 100, queueTimeoutMs: 30000 });

function normalizeWorkerCount(value, itemCount) {
    const available = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
    const fallback = Math.min(Math.max(available - 1, 1), 4);
    return Math.min(Math.max(Number.parseInt(value, 10) || fallback, 1), MAX_HASH_WORKERS, Math.max(itemCount, 1));
}

function runPasswordWorker(payload, { timeoutMs = 0 } = {}) {
    const workerPath = path.join(__dirname, 'password-hash-worker.js');
    return new Promise((resolve, reject) => {
        const worker = new Worker(workerPath, { resourceLimits: { maxOldGenerationSizeMb: 64 } });
        let settled = false;
        let timer = null;
        const finish = (error, value) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            worker.terminate().catch(() => {});
            error ? reject(error) : resolve(value);
        };
        worker.once('message', message => {
            if (!message?.ok) return finish(new Error(message?.error || '密码哈希 Worker 执行失败'));
            return finish(null, message);
        });
        worker.once('error', error => finish(error));
        worker.once('exit', code => {
            if (!settled) finish(new Error(`密码哈希 Worker 异常退出：${code}`));
        });
        if (timeoutMs > 0) timer = setTimeout(() => finish(new Error('密码哈希 Worker 超时')), timeoutMs);
        worker.postMessage(payload);
    });
}

async function hashPasswordsOffThread(passwords, options = {}) {
    const values = Array.isArray(passwords) ? passwords.map(value => String(value || '')) : [];
    if (values.length === 0) return [];
    const workerCount = normalizeWorkerCount(options.workerCount ?? process.env.ADMIN_USER_IMPORT_HASH_WORKERS, values.length);
    const partitions = Array.from({ length: workerCount }, () => []);
    values.forEach((password, index) => partitions[index % workerCount].push({ index, password }));
    const groups = await Promise.all(partitions.filter(group => group.length).map(group => runPasswordWorker({ entries: group, rounds: options.rounds || 10 })));
    const hashes = new Array(values.length);
    for (const item of groups.flatMap(group => group.results || [])) hashes[item.index] = item.hash;
    if (hashes.some(value => !value)) throw new Error('密码哈希结果不完整');
    return hashes;
}

async function runAuthHash(payload) {
    try { await authHashSemaphore.acquire(); }
    catch (_) { throw Object.assign(new Error('密码验证服务繁忙，请稍后重试。'), { code: 'AUTH_HASH_BUSY', status: 503 }); }
    try { return await runPasswordWorker(payload, { timeoutMs: 30000 }); }
    catch (_) { throw Object.assign(new Error('密码验证服务暂不可用，请稍后重试。'), { code: 'AUTH_HASH_UNAVAILABLE', status: 503 }); }
    finally { authHashSemaphore.release(); }
}

async function hashPasswordOffThread(password, rounds) {
    const result = await runAuthHash({ entries: [{ index: 0, password }], rounds });
    if (!result.results?.[0]?.hash) throw new Error('密码哈希结果不完整');
    return result.results[0].hash;
}

async function comparePasswordOffThread(password, hash) {
    const result = await runAuthHash({ action: 'compare', password, hash });
    return result.match === true;
}

module.exports = { MAX_HASH_WORKERS, hashPasswordsOffThread, hashPasswordOffThread, comparePasswordOffThread, normalizeWorkerCount };
