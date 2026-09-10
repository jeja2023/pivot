const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const root = path.resolve(__dirname, '..');
const testsDir = path.join(root, 'tests');
const availableTestFiles = fs.readdirSync(testsDir, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.test.js'))
    .map(entry => path.join('tests', entry.name))
    .sort();
// 保留 Node 原生 test 过滤选项，方便在完整 PostgreSQL 隔离装置内稳定复现单个用例。
// 其它参数仍按测试文件名处理，避免静默把拼写错误的文件当作 Node 参数忽略。
const requestedArgs = process.argv.slice(2);
const NODE_TEST_RUNTIME_OPTIONS = new Set(['--experimental-test-coverage']);
const nodeTestOptions = requestedArgs.filter(arg => arg.startsWith('--test-') || NODE_TEST_RUNTIME_OPTIONS.has(arg));
const requestedTestFiles = requestedArgs.filter(arg => !nodeTestOptions.includes(arg));
const testFiles = requestedTestFiles.length
    ? availableTestFiles.filter(file => requestedTestFiles.some(requested => (
        file.replace(/\\/g, '/') === requested.replace(/\\/g, '/') || path.basename(file) === requested
    )))
    : availableTestFiles;

if (!testFiles.length) {
    throw new Error(`No matching test files. Available files: ${availableTestFiles.join(', ')}`);
}

const databaseUrl = String(
    process.env.TEST_DATABASE_URL
    || process.env.DATABASE_URL
    || (process.env.CI ? 'postgres://postgres:password@localhost:5432/pivot_test' : '')
).trim();
if (!databaseUrl) {
    throw new Error('PostgreSQL 自动化测试需要配置 TEST_DATABASE_URL 或 DATABASE_URL 环境变量（CI 或本地测试库示例：postgres://postgres:password@localhost:5432/pivot_test）');
}

function normalizeWorkerCount() {
    const configured = Number.parseInt(process.env.PIVOT_NODE_TEST_WORKERS || '2', 10);
    const requested = Number.isFinite(configured) ? configured : 2;
    // 覆盖率阈值需要在同一 Node 进程聚合，分组运行会把百分比分散为多个不等价的报告。
    if (nodeTestOptions.includes('--experimental-test-coverage')) return 1;
    if (requestedTestFiles.length) return 1;
    return Math.min(Math.max(requested, 1), 4, testFiles.length || 1);
}

function createWorkerEnvironment(workerIndex) {
    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), `pivot-node-tests-${workerIndex}-`));
    const testSchema = `pivot_test_${process.pid}_${workerIndex}_${Date.now().toString(36)}`;
    return {
        testRoot,
        env: {
            ...process.env,
            TZ: 'Asia/Shanghai',
            PG_TIMEZONE: 'Asia/Shanghai',
            DATA_DIR: path.join(testRoot, 'data'),
            PIVOT_UPLOAD_DIR: path.join(testRoot, 'uploads'),
            PIVOT_ANALYSIS_DIR: path.join(testRoot, 'analysis'),
            LOG_DIR: path.join(testRoot, 'logs'),
            DEFAULT_ADMIN_PASSWORD: '',
            JWT_SECRET: 'pivot-node-tests-jwt-secret-012345678901234567890123',
            DATA_ENCRYPTION_KEY: 'pivot-node-tests-data-secret-012345678901234567890123',
            DATABASE_URL: databaseUrl,
            PG_TEST_SCHEMA: testSchema,
            PG_IDLE_TIMEOUT_MS: '100',
            PIVOT_TEST_DB_SYNC: 'postgres',
            PIVOT_DB_WRITE_QUEUE_DISABLED: 'false'
        }
    };
}

function runSetup(args, env) {
    const result = cp.spawnSync(process.execPath, [path.join(root, 'scripts', 'setup_pg_test_db.js'), ...args], {
        cwd: root,
        env,
        stdio: 'inherit',
        shell: false
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
        const error = new Error(args.includes('--cleanup') ? 'PostgreSQL 测试 schema 清理失败' : 'PostgreSQL 测试 schema 创建失败');
        error.exitCode = Number.isInteger(result.status) ? result.status : 1;
        throw error;
    }
}

function runNodeTestProcess(files, env) {
    return new Promise((resolve, reject) => {
        const child = cp.spawn(process.execPath, [
            '--test',
            '--test-timeout=300000',
            '--test-concurrency=1',
            '--test-reporter=spec',
            ...nodeTestOptions,
            ...files
        ], {
            cwd: root,
            env,
            stdio: 'inherit',
            shell: false
        });
        child.once('error', reject);
        child.once('exit', code => resolve(Number.isInteger(code) ? code : 1));
    });
}

async function runTestGroup(files, workerIndex) {
    const { testRoot, env } = createWorkerEnvironment(workerIndex);
    let status = 1;
    try {
        runSetup([], env);
        status = await runNodeTestProcess(files, env);
    } catch (error) {
        console.error(error.stack || error.message);
        status = error.exitCode || 1;
    } finally {
        try {
            runSetup(['--cleanup'], env);
        } catch (error) {
            console.error(error.stack || error.message);
            if (status === 0) status = error.exitCode || 1;
        }
        fs.rmSync(testRoot, { recursive: true, force: true });
    }
    return status;
}

function splitTestGroups(files, workerCount) {
    const groups = Array.from({ length: workerCount }, () => []);
    files.forEach((file, index) => groups[index % workerCount].push(file));
    return groups.filter(group => group.length);
}

async function main() {
    try {
        require('./ensure_sqlite_binary').ensureSqliteBinary();
    } catch (_) {}
    const workerCount = normalizeWorkerCount();
    const groups = splitTestGroups(testFiles, workerCount);
    if (groups.length > 1) console.log(`Node 测试将使用 ${groups.length} 个隔离 PostgreSQL schema 并行分组执行。`);
    const results = await Promise.all(groups.map((files, index) => runTestGroup(files, index + 1)));
    return results.some(status => status !== 0) ? 1 : 0;
}

main()
    .then(status => { process.exitCode = status; })
    .catch(error => {
        console.error(error.stack || error.message);
        process.exitCode = 1;
    });
