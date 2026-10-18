'use strict';

const childProcess = require('child_process');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const { normalizeDefinition, verifyWorkerSignature } = require('../server/services/agent-capability-worker');

const WORKERS = Object.freeze([
    ['code', 'PIVOT_AGENT_CODE_WORKER_IMAGE', 'PIVOT_AGENT_CODE_WORKER_COMMAND', 'node,/runner/runner.js'],
    ['terminal', 'PIVOT_AGENT_TERMINAL_WORKER_IMAGE', 'PIVOT_AGENT_TERMINAL_WORKER_COMMAND', 'node,/runner/runner.js'],
    ['foreach', 'PIVOT_AGENT_FOREACH_WORKER_IMAGE', 'PIVOT_AGENT_FOREACH_WORKER_COMMAND', 'node,/runner/agent-foreach-worker.js']
]);

function parseCommand(value, fallback) { return String(value || fallback).split(',').map(item => item.trim()).filter(Boolean).slice(0, 8); }
function inspectImage(command, image, spawnSync = childProcess.spawnSync) {
    const result = spawnSync(command, ['image', 'inspect', image], { encoding: 'utf8', windowsHide: true, env: { PATH: process.env.PATH || '' } });
    return { present: result.status === 0, stderr: String(result.stderr || '').trim().slice(0, 300) };
}

function preflightCapabilityWorkers(env = process.env, deps = {}) {
    const enabled = String(env.PIVOT_CAPABILITY_WORKER_ENABLED || '').toLowerCase() === 'true';
    const production = String(env.NODE_ENV || '').toLowerCase() === 'production';
    if (!enabled) return { ready: !production, enabled: false, workers: [], blockers: production ? ['worker_disabled'] : [] };
    const command = String(env.PIVOT_CAPABILITY_WORKER_DOCKER || 'docker').trim() || 'docker';
    const workers = [];
    const blockers = [];
    for (const [name, imageKey, commandKey, fallbackCommand] of WORKERS) {
        const image = String(env[imageKey] || '').trim();
        if (!image) { workers.push({ name, configured: false, ready: false }); continue; }
        let trust;
        try { trust = verifyWorkerSignature(normalizeDefinition({ image, command: parseCommand(env[commandKey], fallbackCommand) }), { env }); }
        catch (error) { workers.push({ name, configured: true, ready: false, errorCode: error.code || 'worker_untrusted' }); blockers.push(`${name}:signature`); continue; }
        const inspected = (deps.inspectImage || inspectImage)(command, image, deps.spawnSync);
        const ready = inspected.present === true;
        workers.push({ name, configured: true, ready, image, trustMode: trust.mode, manifestVersion: trust.manifestVersion || null, ...(ready ? {} : { errorCode: 'worker_image_missing' }) });
        if (!ready) blockers.push(`${name}:image_missing`);
    }
    const configured = workers.filter(item => item.configured);
    if (production && configured.length === 0) blockers.push('worker_images_unconfigured');
    return { ready: blockers.length === 0, enabled: true, production, workers, blockers };
}

if (require.main === module) {
    const result = preflightCapabilityWorkers();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.ready) process.exitCode = 1;
}

module.exports = { preflightCapabilityWorkers };
