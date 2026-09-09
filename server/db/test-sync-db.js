/**
 * 仅供测试使用的同步适配层，让旧版 db.prepare() 测试夹具可由 PostgreSQL 承载。
 * 使用 SharedArrayBuffer Worker 替代临时 JSON 文件和轮询。
 */
const path = require('node:path');
const { Worker } = require('node:worker_threads');

const REQUEST_TIMEOUT_MS = 30_000;
const TRANSPORT_BYTES = 8 * 1024 * 1024;
const IDLE = 0;
const REQUEST = 1;
const RESPONSE = 2;
const READY = 4;
const STOP = -1;

function transportError(message) {
    const error = new Error(message);
    error.code = 'PG_TEST_SYNC_TRANSPORT_ERROR';
    return error;
}

function wait(control, expected, timeoutMs, label) {
    if (Atomics.wait(control, 0, expected, timeoutMs) === 'timed-out') {
        throw transportError(`等待 ${label} 超时。`);
    }
}

function encode(buffer, value) {
    const bytes = Buffer.from(JSON.stringify(value), 'utf8');
    if (bytes.length > buffer.length) throw transportError(`测试同步数据库请求超过 ${buffer.length} 字节限制。`);
    bytes.copy(buffer);
    return bytes.length;
}

function decode(buffer, length, label) {
    if (!Number.isSafeInteger(length) || length < 0 || length > buffer.length) throw transportError(`${label} 长度无效。`);
    try { return JSON.parse(buffer.subarray(0, length).toString('utf8')); } catch (error) { throw transportError(`${label} 无法解析：${error.message}`); }
}

function createWorker() {
    const control = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2));
    const payload = Buffer.from(new SharedArrayBuffer(TRANSPORT_BYTES));
    const worker = new Worker(path.join(__dirname, 'test-sync-worker-thread.js'), {
        workerData: { controlBuffer: control.buffer, payloadBuffer: payload.buffer }, env: process.env
    });
    worker.unref();
    wait(control, IDLE, 10_000, 'PG 测试 Worker 启动');
    if (Atomics.load(control, 0) !== READY) throw transportError(decode(payload, Atomics.load(control, 1), 'PG 测试 Worker 启动响应')?.error || 'PG 测试 Worker 未能启动。');
    Atomics.store(control, 0, IDLE);
    Atomics.notify(control, 0, 1);
    let closed = false;
    const close = () => {
        if (closed) return;
        closed = true;
        Atomics.store(control, 0, STOP);
        Atomics.notify(control, 0, 1);
        void worker.terminate();
    };
    process.once('exit', close);
    return { control, payload, close };
}

function request(worker, value) {
    if (Atomics.load(worker.control, 0) !== IDLE) throw transportError('PG 测试同步 Worker 正忙，拒绝并发同步请求。');
    Atomics.store(worker.control, 1, encode(worker.payload, value));
    Atomics.store(worker.control, 0, REQUEST);
    Atomics.notify(worker.control, 0, 1);
    wait(worker.control, REQUEST, REQUEST_TIMEOUT_MS, 'PG 测试查询');
    const state = Atomics.load(worker.control, 0);
    const response = decode(worker.payload, Atomics.load(worker.control, 1), 'PG 测试查询响应');
    Atomics.store(worker.control, 0, IDLE);
    Atomics.notify(worker.control, 0, 1);
    if (state !== RESPONSE || !response?.ok) {
        const error = new Error(response?.error || 'PostgreSQL 测试查询失败');
        if (response?.code) error.code = response.code;
        throw error;
    }
    return response;
}

function createTestDb() {
    const worker = createWorker();
    return {
        prepare(sql) {
            return {
                get(...params) { return request(worker, { mode: 'get', sql, params }).rows[0]; },
                all(...params) { return request(worker, { mode: 'all', sql, params }).rows; },
                run(...params) {
                    const result = request(worker, { mode: 'run', sql, params });
                    return { changes: result.rowCount || 0, lastInsertRowid: result.lastInsertRowid || 0 };
                }
            };
        },
        exec(sql) { request(worker, { mode: 'run', sql, params: [] }); },
        transaction(fn) {
            if (typeof fn !== 'function') throw new TypeError('transaction callback must be a function');
            return (...args) => {
                request(worker, { mode: 'run', sql: 'BEGIN', params: [] });
                try {
                    const result = fn(...args);
                    request(worker, { mode: 'run', sql: 'COMMIT', params: [] });
                    return result;
                } catch (error) {
                    request(worker, { mode: 'run', sql: 'ROLLBACK', params: [] });
                    throw error;
                }
            };
        },
        close: worker.close
    };
}

module.exports = { createTestDb };
