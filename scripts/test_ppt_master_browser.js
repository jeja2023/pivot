'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { withIsolatedPostgres } = require('./test_support/isolated_postgres');

async function main() {
    const root = path.resolve(process.argv[2] || '');
    if (!process.argv[2]) throw new Error('请提供已完成容器验收的证据目录。');
    const report = JSON.parse(fs.readFileSync(path.join(root, 'report.json'), 'utf8'));
    if (!report.image || !report.untouchedSlideBytesPreserved || report.generate.status !== 'passed') throw new Error('容器验收报告不完整。');
    Object.assign(process.env, { E2E_PPT_MASTER_EVIDENCE_DIR: path.join(root, 'browser'), PIVOT_PPT_MASTER_ENABLED: 'true', PIVOT_PPT_MASTER_IMAGE: report.image, PIVOT_CAPABILITY_WORKER_ENABLED: 'true',
        PIVOT_CAPABILITY_WORKER_TRUSTED_MANIFEST: path.join(root, 'worker-trust.json'),
        PIVOT_CAPABILITY_WORKER_SIGNING_PUBLIC_KEY: fs.readFileSync(path.join(root, 'public-key.pem'), 'utf8') });
    const code = await withIsolatedPostgres(process.execPath, ['scripts/run_e2e_tests.js', 'tests/e2e/presentation-master.spec.js'], { settings: ['max_locks_per_transaction = 512'], cwd: path.resolve(__dirname, '..') });
    process.exitCode = code;
}
main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
