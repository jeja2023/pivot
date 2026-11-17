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

function isolatedStorageEnvironment(root, schema) {
    if (!path.isAbsolute(root) || !/^pivot_(?:test|e2e|restore)_[a-z0-9_]+$/.test(schema)) throw new Error('隔离测试需要受控绝对目录和专用 Schema。');
    const data = path.join(root, 'data');
    return {
        DATA_DIR: data, PIVOT_UPLOAD_DIR: path.join(root, 'uploads'), UPLOAD_DIR: path.join(root, 'uploads'),
        PIVOT_ARTIFACT_CAS_DIR: path.join(data, 'agent-artifact-objects'),
        PIVOT_DOCUMENT_PROCESSING_DIR: path.join(data, 'document-processing'),
        PIVOT_ANALYSIS_DIR: path.join(root, 'analysis'), AGENT_BLOB_DIR: path.join(data, 'agent-blobs'),
        PIVOT_RUNTIME_PACK_ROOT: path.join(data, 'agent-runtime-packs'), AGENT_SKILL_ROOT: path.join(root, 'skill-packages'),
        DATA_ANALYSIS_SECURITY_JOURNAL_DIR: path.join(root, 'independent-security'),
        DATA_ANALYSIS_SECURITY_KEY_FILE: path.join(root, 'security-journal.key'), LOG_DIR: path.join(root, 'logs'),
        DB_BACKUP_DIR: path.join(data, 'backups'), DB_BACKUP_SCHEMA: schema
    };
}

function assertTestStorage(root) {
    const stat = fs.statfsSync(root, { bigint: true }), free = stat.bavail * stat.bsize;
    const minimum = 2n * (8n * 1024n ** 3n + 200n * 1024n ** 2n);
    if (free < minimum) throw new Error(`测试临时目录 ${root} 剩余空间不足 ${Number(minimum / 1024n ** 3n)} GiB；请设置 PIVOT_TEST_TMP_ROOT 指向空间充足的目录。`);
    const total = stat.blocks * stat.bsize;
    if (total > 0n && (total - free) * 100n >= total * 85n) throw new Error(`测试临时目录 ${root} 所在盘占用率达到分析批处理的 85% 限制；请设置 PIVOT_TEST_TMP_ROOT 指向占用率较低的目录。`);
    return free;
}

module.exports = { resolveTestTempRoot, localTestEnvironment, isolatedStorageEnvironment, assertTestStorage };
