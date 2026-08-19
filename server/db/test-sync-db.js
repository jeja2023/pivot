/** Test-only synchronous facade for legacy db.prepare() fixtures backed by PG. */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');

const waitArray = new Int32Array(new SharedArrayBuffer(4));

function waitForFile(filePath, timeoutMs, description) {
    const deadline = Date.now() + timeoutMs;
    while (!fs.existsSync(filePath)) {
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
        Atomics.wait(waitArray, 0, 0, 5);
    }
}

function createWorker() {
    const bridgeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-pg-sync-'));
    const requestPath = path.join(bridgeDir, 'request.json');
    const responsePath = path.join(bridgeDir, 'response.json');
    const worker = spawn(process.execPath, [path.join(__dirname, 'test-sync-worker.js')], {
        cwd: path.resolve(__dirname, '../..'),
        env: { ...process.env, PIVOT_TEST_SYNC_BRIDGE_DIR: bridgeDir },
        stdio: 'ignore',
        windowsHide: true
    });
    worker.unref();
    waitForFile(path.join(bridgeDir, 'ready'), 10000, 'PG test worker startup');

    function close() {
        try { worker.kill(); } catch (error) { /* process already closed */ }
        fs.rmSync(bridgeDir, { recursive: true, force: true });
    }

    process.once('exit', close);
    return { bridgeDir, requestPath, responsePath, worker, close };
}

function request(worker, payload) {
    fs.rmSync(worker.responsePath, { force: true });
    const tempPath = path.join(worker.bridgeDir, `request.${process.pid}.tmp`);
    fs.writeFileSync(tempPath, JSON.stringify(payload));
    fs.renameSync(tempPath, worker.requestPath);
    waitForFile(worker.responsePath, 30000, 'PG test query');
    const response = JSON.parse(fs.readFileSync(worker.responsePath, 'utf8'));
    fs.rmSync(worker.responsePath, { force: true });
    if (!response.ok) {
        const error = new Error(response.error || 'PG test query failed');
        if (response.code) error.code = response.code;
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
        exec(sql) {
            request(worker, { mode: 'run', sql, params: [] });
        },
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
        close() {
            worker.close();
        }
    };
}

module.exports = { createTestDb };
