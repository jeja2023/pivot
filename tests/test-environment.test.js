'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveTestTempRoot, localTestEnvironment } = require('../scripts/test_support/test-environment');

test('测试临时根使用明确目录，拒绝相对路径且不改变原环境', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-test-environment-'));
    try {
        assert.equal(resolveTestTempRoot({ PIVOT_TEST_TMP_ROOT: directory }), fs.realpathSync(directory));
        assert.throws(() => resolveTestTempRoot({ PIVOT_TEST_TMP_ROOT: 'relative/path' }), /绝对路径/);
        const inherited = { DATA_ANALYSIS_MODEL_RUNTIME: 'docker', PIVOT_PPT_MASTER_SERVICE_URL: 'http://external.invalid', PIVOT_ALERT_WEBHOOK_URL: 'https://alert.invalid' };
        assert.equal(localTestEnvironment(inherited).DATA_ANALYSIS_MODEL_RUNTIME, 'development_process');
        assert.equal(localTestEnvironment(inherited).PIVOT_PPT_MASTER_SERVICE_URL, '');
        assert.equal(localTestEnvironment(inherited).PIVOT_ALERT_WEBHOOK_URL, '');
        assert.equal(localTestEnvironment({ ...inherited, PIVOT_TEST_ANALYSIS_RUNTIME: 'docker' }).DATA_ANALYSIS_MODEL_RUNTIME, 'docker');
        assert.equal(inherited.DATA_ANALYSIS_MODEL_RUNTIME, 'docker');
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
