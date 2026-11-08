'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { withIsolatedPostgres } = require('./test_support/isolated_postgres');
process.env.E2E_PPT_TEMPLATE_EVIDENCE_DIR = path.resolve('artifacts/ppt-template-catalog-acceptance/browser');
process.env.PIVOT_E2E_WEBSERVER_TIMEOUT_MS ||= '180000';
if (process.argv[2]) {
    const root = path.resolve(process.argv[2]), report = JSON.parse(fs.readFileSync(path.join(root, 'report.json'), 'utf8'));
    if (report.templateApply !== 'passed') throw new Error('请提供包含真实上游模板应用验收的证据目录。');
    Object.assign(process.env, { PIVOT_PPT_MASTER_ENABLED: 'true', PIVOT_PPT_MASTER_IMAGE: report.image, PIVOT_CAPABILITY_WORKER_ENABLED: 'true', PIVOT_CAPABILITY_WORKER_TRUSTED_MANIFEST: path.join(root, 'worker-trust.json'), PIVOT_CAPABILITY_WORKER_SIGNING_PUBLIC_KEY: fs.readFileSync(path.join(root, 'public-key.pem'), 'utf8') });
}
withIsolatedPostgres(process.execPath, ['scripts/run_e2e_tests.js', 'tests/e2e/presentation-template-catalog.spec.js'], { settings: ['max_locks_per_transaction = 512'] })
    .then(code => { process.exitCode = code; }).catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
