'use strict';

const fs = require('node:fs');
const path = require('node:path');
const lock = require('../../../../config/ppt-master-engine.json');
function contract() { return { deploymentProtocol: 1, applicationVersion: require('../../../../package.json').version, engine: lock }; }
function gateFile(env = process.env) { return path.resolve(env.DATA_DIR || path.join(__dirname, '../../../../data'), 'ppt-master-maintenance.json'); }
function accepting(env = process.env) { return !fs.existsSync(gateFile(env)); }
function assertAccepting(env = process.env) {
    if (!accepting(env)) throw Object.assign(new Error('PPT制作引擎正在更新，请稍后重新提交。'), { code: 'PPT_MASTER_MAINTENANCE', status: 503, expose: true });
}
function workerEnv(env = process.env) {
    const manifest = env.PIVOT_PPT_MASTER_TRUSTED_MANIFEST, key = env.PIVOT_PPT_MASTER_SIGNING_PUBLIC_KEY_FILE;
    if (!manifest && !key) return env;
    if (!manifest || !key) throw new Error('PPT制作引擎的独立信任清单和公钥文件必须同时配置。');
    const publicKey = fs.readFileSync(key, 'utf8');
    return { ...env, PIVOT_CAPABILITY_WORKER_TRUSTED_MANIFEST: manifest, PIVOT_CAPABILITY_WORKER_SIGNING_PUBLIC_KEY: publicKey, PIVOT_CAPABILITY_WORKER_SIGNATURE_REQUIRED: 'true' };
}
function assertCheckpoint(state, image) {
    if (state.runtimeImage && state.runtimeImage !== image) throw Object.assign(new Error('制作服务连接或运行环境已变化，请新建任务，不能混用旧检查点。'), { code: 'PPT_MASTER_IMAGE_CHANGED', status: 409, expose: true });
    if (image && (state.prepared || state.bootstrapped) && !state.runtimeImage) throw Object.assign(new Error('旧检查点没有可核对的镜像身份，请保留已有结果并新建制作任务。'), { code: 'PPT_MASTER_CHECKPOINT_UNVERIFIED', status: 409, expose: true });
}
module.exports = { contract, gateFile, accepting, assertAccepting, workerEnv, assertCheckpoint };
