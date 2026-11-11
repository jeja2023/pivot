'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function resolveTestTempRoot(env = process.env) {
    const requested = String(env.PIVOT_TEST_TMP_ROOT || '').trim();
    if (!requested) return fs.realpathSync(os.tmpdir());
    if (!path.isAbsolute(requested)) throw new Error('PIVOT_TEST_TMP_ROOT 必须是明确的绝对路径。');
    fs.mkdirSync(requested, { recursive: true, mode: 0o700 });
    return fs.realpathSync(requested);
}

function localTestEnvironment(env = process.env) {
    // 测试默认使用受控进程；真实容器验收必须显式选择测试执行器。
    return { ...env, DATA_ANALYSIS_MODEL_RUNTIME: env.PIVOT_TEST_ANALYSIS_RUNTIME || 'development_process',
        PIVOT_PPT_MASTER_SERVICE_URL: '', PIVOT_PPT_MASTER_SERVICE_TOKEN: '', PIVOT_ALERT_WEBHOOK_URL: '' };
}

function assertTestStorage(root) {
    const stat = fs.statfsSync(root, { bigint: true }), free = stat.bavail * stat.bsize;
    const minimum = 2n * (8n * 1024n ** 3n + 200n * 1024n ** 2n);
    if (free < minimum) throw new Error(`测试临时目录 ${root} 剩余空间不足 ${Number(minimum / 1024n ** 3n)} GiB；请设置 PIVOT_TEST_TMP_ROOT 指向空间充足的目录。`);
    return free;
}

module.exports = { resolveTestTempRoot, localTestEnvironment, assertTestStorage };
