'use strict';

const { getDeploymentProfile } = require('../server/services/deployment-profile');

const json = process.argv.includes('--json');
const requireMultiNode = process.argv.includes('--require-multi-node');
const profile = getDeploymentProfile(process.env);
const ready = requireMultiNode ? profile.capabilities.multiNodeReady === true : true;

if (json) {
    process.stdout.write(`${JSON.stringify({ ready, profile }, null, 2)}\n`);
} else {
    console.log(`部署模式：请求 ${profile.requestedMode}，生效 ${profile.effectiveMode}`);
    console.log(`数据库：${profile.database.provider} (${profile.database.ready ? 'ready' : 'not ready'})`);
    console.log(`共享存储：${profile.objectStorage.provider} (${profile.objectStorage.ready ? 'ready' : 'not ready'})`);
    console.log(`任务队列：${profile.queue.provider} (${profile.queue.ready ? 'ready' : 'not ready'})`);
    console.log(`分布式锁：${profile.locks.provider} (${profile.locks.ready ? 'ready' : 'not ready'})`);
    if (profile.warnings.length) console.log(`告警：${profile.warnings.join(', ')}`);
    if (requireMultiNode) console.log(`多节点预检：${ready ? '通过' : '未通过'}`);
}

if (!ready) process.exitCode = 1;
