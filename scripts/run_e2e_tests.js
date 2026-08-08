const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-e2e-tests-'));
const playwrightCli = path.join(root, 'node_modules', '@playwright', 'test', 'cli.js');
const env = {
    ...process.env,
    DATA_DIR: path.join(testRoot, 'data'),
    PIVOT_UPLOAD_DIR: path.join(testRoot, 'uploads'),
    PIVOT_ANALYSIS_DIR: path.join(testRoot, 'analysis'),
    LOG_DIR: path.join(testRoot, 'logs'),
    PIVOT_E2E_OUTPUT_DIR: path.join(testRoot, 'results'),
    DEFAULT_ADMIN_PASSWORD: 'E2eAdmin123',
    JWT_SECRET: 'pivot-e2e-tests-jwt-secret-012345678901234567890123',
    DATA_ENCRYPTION_KEY: 'pivot-e2e-tests-data-secret-012345678901234567890123'
};

let status = 1;
try {
    const result = cp.spawnSync(process.execPath, [
        playwrightCli,
        'test',
        '--config',
        path.join('tests', 'e2e', 'playwright.config.js')
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
