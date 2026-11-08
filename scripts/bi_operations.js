'use strict';

require('dotenv').config({ path: require('node:path').resolve(__dirname, '../.env') });
const { closePgPool } = require('../server/db/pg-connection');
async function main() {
    const index = process.argv.indexOf('--admin-id'), id = index < 0 ? 0 : Number(process.argv[index + 1]);
    if (!Number.isSafeInteger(id) || id < 1) throw new Error('请用 --admin-id 指定执行核查的系统管理员账号。');
    const user = { id }, operations = require('../server/services/data-analysis/bi/operations');
    await operations.requireOperator(user);
    const reasonIndex = process.argv.indexOf('--reason'), reason = reasonIndex < 0 ? '' : process.argv[reasonIndex + 1];
    const releaseIndex = process.argv.indexOf('--release-action'), revisionIndex = process.argv.indexOf('--expected-revision'), waitIndex = process.argv.indexOf('--wait-seconds');
    const output = releaseIndex >= 0 ? await require('../server/services/data-analysis/bi/release-controls').act(user, { action: process.argv[releaseIndex + 1], reason,
        expectedRevision: revisionIndex < 0 ? 0 : Number(process.argv[revisionIndex + 1]), waitSeconds: waitIndex < 0 ? 0 : Number(process.argv[waitIndex + 1]), cancel: process.argv.includes('--cancel'), reopenWrites: process.argv.includes('--reopen-writes') })
        : process.argv.includes('--release-status') ? await require('../server/services/data-analysis/bi/release-controls').overview(user)
        : process.argv.includes('--preflight') ? await operations.fullPreflight(user) : process.argv.includes('--fence') ? await operations.fence(user, reason) : process.argv.includes('--resume') ? await operations.resume(user, reason)
        : process.argv.includes('--bootstrap-probe') ? await require('../server/services/data-analysis/bi/operation-probe').bootstrap(user)
        : process.argv.includes('--check') ? await operations.tick() : await operations.overview(user);
    process.stdout.write(JSON.stringify(output, null, 2) + '\n');
}
main().catch(error => { process.stderr.write(`数据建模运行核查失败：${error.message}\n`); process.exitCode = 1; }).finally(() => closePgPool());
