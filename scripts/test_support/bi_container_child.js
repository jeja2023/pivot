'use strict';

// 仅供独立验收容器使用；沿用真实 Schema 初始化和测试，不连接现有应用实例。
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');

async function main() {
    assert.equal(process.platform, 'linux'); assert.ok(process.getuid() > 0);
    assert.equal(process.env.PIVOT_TEST_ANALYSIS_CONTAINER_ACCEPTANCE, 'true');
    assert.match(process.env.PG_TEST_SCHEMA || '', /^pivot_test_container_[a-f0-9]+$/);
    assert.match(process.env.PIVOT_ANALYSIS_DIR || '', /^\/var\/lib\/docker\/volumes\/pivot-bi-acceptance-[a-f0-9]+\/_data\/analysis$/);
    await fs.mkdir(path.dirname(process.env.DATA_ANALYSIS_SECURITY_KEY_FILE), { recursive: true, mode: 0o700 });
    await fs.writeFile(process.env.DATA_ANALYSIS_SECURITY_KEY_FILE, crypto.randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
    const run = args => new Promise((resolve, reject) => {
        const child = spawn(process.execPath, args, { stdio: 'inherit', env: process.env, windowsHide: true });
        child.once('error', reject); child.once('close', code => resolve(code ?? 1));
    });
    try {
        assert.equal(await run(['scripts/setup_pg_test_db.js']), 0);
        process.exitCode = await run(['--test', '--test-concurrency=1', '--test-reporter=spec', 'tests/bi-modeling-container-coordinator.test.js', 'tests/bi-modeling-ingestion.test.js', 'tests/bi-modeling-result-cache.test.js', 'tests/bi-modeling-source-metadata.test.js', 'tests/bi-modeling-increments.test.js']);
        if (process.exitCode === 0) {
            process.exitCode = await run(['scripts/test_support/bi_container_application.js']);
            const proof = JSON.parse(await fs.readFile(path.join(process.env.DATA_DIR, 'container-application-proof.json'), 'utf8'));
            assert.equal(proof.passed, true);
        }
    } finally { assert.equal(await run(['scripts/setup_pg_test_db.js', '--cleanup']), 0); }
}
main().catch(error => { process.stderr.write((error.stack || error.message) + '\n'); process.exitCode = 1; });
