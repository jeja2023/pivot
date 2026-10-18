'use strict';

const childProcess = require('child_process');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const { buildWorkerDockerArguments, normalizeDefinition, verifyWorkerSignature } = require('../server/services/agent-capability-worker');

function drillError(message, code = 'CAPABILITY_WORKER_ISOLATION_DRILL_INVALID') {
    const error = new Error(message); error.code = code; return error;
}
function codeWorkerDefinition(env = process.env) {
    return normalizeDefinition({ image: env.PIVOT_AGENT_CODE_WORKER_IMAGE, command: String(env.PIVOT_AGENT_CODE_WORKER_COMMAND || 'node,/runner/runner.js').split(',').map(item => item.trim()).filter(Boolean), limits: { cpu: env.PIVOT_AGENT_CODE_WORKER_CPU, memoryMb: env.PIVOT_AGENT_CODE_WORKER_MEMORY_MB, timeoutMs: env.PIVOT_AGENT_CODE_WORKER_TIMEOUT_MS, maxOutputBytes: env.PIVOT_AGENT_CODE_WORKER_MAX_OUTPUT_BYTES } });
}
function buildIsolationDrillArguments(definition, containerName) {
    const spec = normalizeDefinition(definition);
    return buildWorkerDockerArguments(spec, { containerName, limits: { ...spec.limits, pids: 64 } });
}
function run(command, args, input, spawnSync = childProcess.spawnSync) {
    const result = spawnSync(command, args, { input, encoding: 'utf8', windowsHide: true, timeout: 30_000, env: { PATH: process.env.PATH || '' } });
    if (result.error) throw drillError(`Docker 演练无法启动：${result.error.message}`, 'CAPABILITY_WORKER_ISOLATION_DRILL_START_FAILED');
    if (result.status !== 0) throw drillError(`Docker 演练失败：${String(result.stderr || '').trim().slice(0, 1000)}`, 'CAPABILITY_WORKER_ISOLATION_DRILL_FAILED');
    try { return JSON.parse(String(result.stdout || '')); } catch (_) { throw drillError('Docker 演练未返回 JSON。', 'CAPABILITY_WORKER_ISOLATION_DRILL_OUTPUT_INVALID'); }
}
function validateStaging(env = process.env, args = process.argv) {
    if (String(env.NODE_ENV || '').toLowerCase() === 'production') throw drillError('隔离演练禁止在 production 环境运行。', 'CAPABILITY_WORKER_ISOLATION_DRILL_PRODUCTION_FORBIDDEN');
    if (!args.includes('--confirm-staging')) throw drillError('必须显式传入 --confirm-staging。', 'CAPABILITY_WORKER_ISOLATION_DRILL_CONFIRMATION_REQUIRED');
    if (String(env.PIVOT_CAPABILITY_WORKER_ENABLED || '').toLowerCase() !== 'true') throw drillError('必须先启用受控 Capability Worker。', 'CAPABILITY_WORKER_ISOLATION_DRILL_WORKER_DISABLED');
    if (String(env.PIVOT_CAPABILITY_WORKER_SIGNATURE_REQUIRED || '').toLowerCase() !== 'true') throw drillError('staging 演练必须强制 Worker 签名清单。', 'CAPABILITY_WORKER_ISOLATION_DRILL_SIGNATURE_REQUIRED');
}
function runIsolationDrill(env = process.env, deps = {}) {
    validateStaging(env, deps.args || process.argv);
    const definition = codeWorkerDefinition(env);
    const trust = verifyWorkerSignature(definition, { env });
    const command = String(env.PIVOT_CAPABILITY_WORKER_DOCKER || 'docker').trim() || 'docker';
    const imageCheck = (deps.spawnSync || childProcess.spawnSync)(command, ['image', 'inspect', definition.image], { encoding: 'utf8', windowsHide: true, env: { PATH: process.env.PATH || '' } });
    if (imageCheck.status !== 0) throw drillError('签名 Worker 镜像未预置到当前节点。', 'CAPABILITY_WORKER_ISOLATION_DRILL_IMAGE_MISSING');
    const result = run(command, buildIsolationDrillArguments(definition, `pivot-isolation-${Date.now()}`), JSON.stringify({ version: 1, action: 'isolation_probe' }), deps.spawnSync || childProcess.spawnSync);
    const checks = result?.ok === true && result?.result && Object.values(result.result).every(value => value === true);
    if (!checks) throw drillError(`隔离探针未全部通过：${JSON.stringify(result?.result || {})}`, 'CAPABILITY_WORKER_ISOLATION_DRILL_PROBE_FAILED');
    return { ready: true, trustMode: trust.mode, image: definition.image, checks: result.result };
}
if (require.main === module) {
    try { process.stdout.write(`${JSON.stringify(runIsolationDrill(), null, 2)}\n`); }
    catch (error) { process.stderr.write(`${JSON.stringify({ ready: false, code: error.code || 'CAPABILITY_WORKER_ISOLATION_DRILL_FAILED', error: error.message })}\n`); process.exitCode = 1; }
}
module.exports = { buildIsolationDrillArguments, runIsolationDrill, validateStaging };
