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
const requestedTestFiles = process.argv.slice(2);
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

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-node-tests-'));
const testSchema = `pivot_test_${process.pid}_${Date.now().toString(36)}`;

const env = {
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
};

let status = 1;
try {
    const setup = cp.spawnSync(process.execPath, [path.join(root, 'scripts', 'setup_pg_test_db.js')], {
        cwd: root,
        env,
        stdio: 'inherit',
        shell: false
    });
    if (setup.error) throw setup.error;
    if (setup.status !== 0) {
        const error = new Error('PostgreSQL test schema setup failed');
        error.exitCode = Number.isInteger(setup.status) ? setup.status : 1;
        throw error;
    }
    const result = cp.spawnSync(process.execPath, [
        '--test',
        '--test-concurrency=1',
        '--test-reporter=spec',
        ...testFiles
    ], {
        cwd: root,
        env,
        stdio: 'inherit',
        shell: false
    });
    if (result.error) throw result.error;
    status = Number.isInteger(result.status) ? result.status : 1;
} catch (error) {
    console.error(error.stack || error.message);
    status = error.exitCode || 1;
} finally {
    const cleanup = cp.spawnSync(process.execPath, [path.join(root, 'scripts', 'setup_pg_test_db.js'), '--cleanup'], {
        cwd: root,
        env,
        stdio: 'inherit',
        shell: false
    });
    if (cleanup.error || cleanup.status !== 0) {
        console.error(cleanup.error?.stack || 'PostgreSQL test schema cleanup failed');
        status = status || (Number.isInteger(cleanup.status) ? cleanup.status : 1);
    }
    fs.rmSync(testRoot, { recursive: true, force: true });
}

process.exit(status);
