const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const testsDir = path.join(root, 'tests');
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-node-tests-'));
const testFiles = fs.readdirSync(testsDir, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.test.js'))
    .map(entry => path.join('tests', entry.name))
    .sort();

const env = {
    ...process.env,
    DATA_DIR: path.join(testRoot, 'data'),
    PIVOT_UPLOAD_DIR: path.join(testRoot, 'uploads'),
    PIVOT_ANALYSIS_DIR: path.join(testRoot, 'analysis'),
    LOG_DIR: path.join(testRoot, 'logs'),
    DEFAULT_ADMIN_PASSWORD: '',
    JWT_SECRET: 'pivot-node-tests-jwt-secret-012345678901234567890123',
    DATA_ENCRYPTION_KEY: 'pivot-node-tests-data-secret-012345678901234567890123'
};

let status = 1;
try {
    const result = cp.spawnSync(process.execPath, [
        '--test',
        '--test-concurrency=1',
        ...testFiles
    ], {
        cwd: root,
        env,
        stdio: 'inherit',
        shell: false
    });
    if (result.error) throw result.error;
    status = Number.isInteger(result.status) ? result.status : 1;
} finally {
    fs.rmSync(testRoot, { recursive: true, force: true });
}

process.exit(status);
