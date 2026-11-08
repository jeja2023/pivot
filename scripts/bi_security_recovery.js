'use strict';

require('dotenv').config({ path: require('node:path').resolve(__dirname, '../.env') });
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { canonicalHash } = require('../server/services/data-analysis/bi/canonical');

function option(name) { const index = process.argv.indexOf(name); return index < 0 ? '' : String(process.argv[index + 1] || ''); }
async function readBounded(file, limit = 64 * 1024 * 1024) {
    if (!path.isAbsolute(file)) throw new Error('请指定绝对文件路径。');
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) throw new Error('输入文件类型或大小不符合恢复核对边界。');
    return fs.readFile(file, 'utf8');
}
async function writeNew(file, value) {
    if (!path.isAbsolute(file)) throw new Error('输出必须为绝对路径，且不能覆盖已有文件。');
    const handle = await fs.open(file, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n'); await handle.sync(); } finally { await handle.close(); }
    return { written: true, sha256: canonicalHash(value) };
}

async function main() {
    if (process.argv.includes('--sign-authority')) {
        const body = JSON.parse(await readBounded(option('--sign-authority')));
        if (body.requiresCurrentAuthorityReview !== false || !body.authority || !body.approvedBy || !body.reason || !body.approvedAt || !body.expiresAt) throw new Error('签名前须由当前身份源和业务授权负责人完成逐项核对，填写签认时间与负责人，并明确关闭待核对标记。');
        const key = crypto.createPrivateKey(await readBounded(option('--signing-key'), 8192));
        if (key.asymmetricKeyType !== 'ed25519') throw new Error('签认私钥必须为独立保管的 Ed25519 PEM。');
        return writeNew(option('--output'), { body, signature: crypto.sign(null, Buffer.from(canonicalHash(body)), key).toString('base64url') });
    }
    const recovery = require('../server/services/data-analysis/bi/security-recovery');
    if (process.argv.includes('--replay')) return recovery.replay({ reason: option('--reason') });
    if (process.argv.includes('--prepare-authority')) return writeNew(option('--output'), await recovery.prepareAuthorityDraft());
    if (process.argv.includes('--reconcile')) return recovery.reconcile(JSON.parse(await readBounded(option('--reconcile'))));
    if (process.argv.includes('--flush')) return require('../server/services/data-analysis/bi/security-journal').flush({ force: true, full: process.argv.includes('--full') });
    return require('../server/services/data-analysis/bi/security-journal').health();
}

main().then(result => process.stdout.write(JSON.stringify(result, null, 2) + '\n')).catch(error => {
    process.stderr.write(`安全恢复核查失败：${error.message}\n`); process.exitCode = 1;
}).finally(() => require('../server/db/pg-connection').closePgPool());
