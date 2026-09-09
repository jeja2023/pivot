const cp = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
require('dotenv').config({ path: path.join(root, '.env') });
const playwrightArgs = process.argv.slice(2);

function reserveAvailablePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.unref();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            const port = address && typeof address === 'object' ? address.port : 0;
            server.close(error => error ? reject(error) : resolve(port));
        });
    });
}

function runNodeScript(args, env) {
    const result = cp.spawnSync(process.execPath, args, {
        cwd: root,
        env,
        stdio: 'inherit',
        shell: false
    });
    if (result.error) throw result.error;
    return Number.isInteger(result.status) ? result.status : 1;
}

async function startFakeModelServer(logPath = '') {
    const port = await reserveAvailablePort();
    const child = cp.spawn(process.execPath, [path.join(root, 'scripts', 'e2e_fake_model.js')], {
        cwd: root,
        env: { ...process.env, E2E_FAKE_MODEL_PORT: String(port), E2E_FAKE_MODEL_LOG: logPath },
        stdio: ['ignore', 'pipe', 'inherit']
    });
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('E2E 假模型服务启动超时')), 5000);
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.stdout.once('data', chunk => {
            clearTimeout(timer);
            if (String(chunk).includes('ready')) resolve();
            else reject(new Error('E2E 假模型服务未进入就绪状态'));
        });
    });
    return { child, url: `http://127.0.0.1:${port}/v1` };
}

async function main() {
    const databaseUrl = String(
        process.env.TEST_DATABASE_URL
        || process.env.DATABASE_URL
        || (process.env.CI ? 'postgres://postgres:password@localhost:5432/pivot_test' : '')
    ).trim();
    if (!databaseUrl) {
        throw new Error('Playwright E2E 测试需要配置 TEST_DATABASE_URL 或 DATABASE_URL 环境变量（CI 或本地测试库示例：postgres://postgres:password@localhost:5432/pivot_test）');
    }

    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-e2e-tests-'));
    const fakeModelLogPath = path.join(testRoot, 'fake-model.log');
    const testSchema = `pivot_e2e_${process.pid}_${Date.now().toString(36)}`;
    const port = await reserveAvailablePort();
    const fakeModel = await startFakeModelServer(fakeModelLogPath);
    if (process.env.PIVOT_E2E_DEBUG === 'true') console.error(`[e2e-debug] 假模型地址：${fakeModel.url}`);
    const playwrightCli = path.join(root, 'node_modules', '@playwright', 'test', 'cli.js');
    const setupScript = path.join(root, 'scripts', 'setup_pg_test_db.js');
    const env = {
        ...process.env,
        TZ: 'Asia/Shanghai',
        PG_TIMEZONE: 'Asia/Shanghai',
        DATA_DIR: path.join(testRoot, 'data'),
        PIVOT_UPLOAD_DIR: path.join(testRoot, 'uploads'),
        PIVOT_ANALYSIS_DIR: path.join(testRoot, 'analysis'),
        LOG_DIR: path.join(testRoot, 'logs'),
        PIVOT_E2E_OUTPUT_DIR: path.join(testRoot, 'results'),
        PIVOT_E2E_BASE_URL: `http://127.0.0.1:${port}`,
        PIVOT_E2E_ISOLATED: 'true',
        PORT: String(port),
        DATABASE_URL: databaseUrl,
        PG_TEST_SCHEMA: testSchema,
        PG_IDLE_TIMEOUT_MS: '100',
        PIVOT_TEST_DB_SYNC: 'postgres',
        PIVOT_DB_WRITE_QUEUE_DISABLED: 'false',
        PIVOT_LOGIN_RATE_LIMIT_MAX: '100',
        DEFAULT_ADMIN_PASSWORD: 'E2eAdmin123',
        JWT_SECRET: 'pivot-e2e-tests-jwt-secret-012345678901234567890123',
        DATA_ENCRYPTION_KEY: 'pivot-e2e-tests-data-secret-012345678901234567890123'
        ,E2E_MODEL_URL: fakeModel.url
    };

    let status = 1;
    try {
        const setupStatus = runNodeScript([setupScript], env);
        if (setupStatus !== 0) {
            const error = new Error('PostgreSQL E2E schema setup failed');
            error.exitCode = setupStatus;
            throw error;
        }

        status = runNodeScript([
            playwrightCli,
            'test',
            '--config',
            path.join('tests', 'e2e', 'playwright.config.js'),
            ...playwrightArgs
        ], env);
    } catch (error) {
        console.error(error.stack || error.message);
        status = error.exitCode || 1;
    } finally {
        if (process.env.PIVOT_E2E_DEBUG === 'true') {
            try { console.error('[e2e-debug] 假模型日志：\n' + fs.readFileSync(fakeModelLogPath, 'utf8')); } catch (_) {}
            try { console.error('[e2e-debug] 服务端日志：\n' + fs.readFileSync(path.join(testRoot, 'logs', 'pivot.log'), 'utf8').slice(-20000)); } catch (_) {}
        }
        if (fakeModel.child && !fakeModel.child.killed) {
            fakeModel.child.kill();
            await new Promise(resolve => fakeModel.child.once('exit', resolve));
        }
        try {
            const cleanupStatus = runNodeScript([setupScript, '--cleanup'], env);
            if (cleanupStatus !== 0 && status === 0) status = cleanupStatus;
        } catch (error) {
            console.error(error.stack || error.message);
            if (status === 0) status = 1;
        } finally {
            fs.rmSync(testRoot, { recursive: true, force: true });
        }
    }

    return status;
}

main()
    .then(status => process.exit(status))
    .catch(error => {
        console.error(error.stack || error.message);
        process.exit(1);
    });
