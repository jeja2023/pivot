'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const deployment = require('../server/services/presentations/master/deployment');
const runtime = require('../server/services/presentations/master/runtime');
async function quiesce(token) {
    if (!/^[a-f0-9]{32}$/.test(token || '')) throw new Error('更新标识无效。');
    const file = deployment.gateFile(), { transaction } = require('../server/db/client'), repository = require('../server/repositories/presentation-engine-deployment');
    await transaction(async client => {
        await repository.lock(client);
        try { await fs.writeFile(file, JSON.stringify({ token, createdAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 }); }
        catch (error) { if (error.code !== 'EEXIST' || JSON.parse(await fs.readFile(file, 'utf8')).token !== token) throw new Error('另一次PPT更新尚未结束，请先恢复原更新。'); }
        if (Number((await repository.active(client)).total) > 0) { await fs.unlink(file); throw new Error('仍有PPT任务正在运行或等待确认，请完成或停止后再更新。'); }
    });
    return { ready: true, phase: 'quiesced', token };
}
async function unquiesce(token) {
    const file = deployment.gateFile();
    const value = await fs.readFile(file, 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
    if (!value) return { ready: true, phase: 'accepting' };
    if (JSON.parse(value).token !== token) throw new Error('更新标识不匹配，不能解除其他更新的维护状态。');
    await fs.unlink(file); return { ready: true, phase: 'accepting' };
}
async function smoke() {
    const user = { id: 1 }, id = 'tooltask_' + crypto.randomBytes(24).toString('base64url'), marker = crypto.randomBytes(24).toString('hex');
    try {
        const health = await runtime.execute(user, id, { action: 'health' });
        if (health.status !== 'ready' || health.contentDigest !== runtime.lock.contentDigest || health.offlineNativeProtocol !== 1) throw new Error('制作镜像与当前应用合同或原稿协议不一致。');
        await runtime.inputFile(user, id, 'deployment-input.txt', Buffer.from(marker));
        const loaded = await runtime.execute(user, id, { action: 'read', path: 'inputs/deployment-input.txt' });
        if (loaded.text !== marker) throw new Error('PPT任务目录没有正确映射到执行节点。');
        await runtime.execute(user, id, { action: 'write', path: 'deployment-output.txt', text: marker });
        if (await fs.readFile(path.join(await runtime.workspace(user, id), 'deployment-output.txt'), 'utf8') !== marker) throw new Error('PPT执行结果没有正确写回任务目录。');
        return { ready: true, revision: health.revision, contentDigest: health.contentDigest, offlineNativeProtocol: health.offlineNativeProtocol, workspaceRoundtrip: true, image: runtime.config().image };
    } finally { await runtime.cleanupWorkspace(user, id); }
}
async function main(args = process.argv.slice(2)) {
    const action = args[0] || 'smoke';
    if (action === 'contract') return deployment.contract();
    if (action === 'quiesce') return quiesce(args[1]);
    if (action === 'unquiesce') return unquiesce(args[1]);
    if (action !== 'smoke') throw new Error('请选择合同查询、维护接纳或实际运行检查。');
    return smoke();
}
if (require.main === module) main().then(result => process.stdout.write(JSON.stringify(result) + '\n')).catch(error => { process.stderr.write(JSON.stringify({ ready: false, message: error.message }) + '\n'); process.exitCode = 1; })
    .finally(async () => { await require('../server/db/pg-connection').closePgPool(); });
module.exports = { main, smoke, quiesce, unquiesce };
