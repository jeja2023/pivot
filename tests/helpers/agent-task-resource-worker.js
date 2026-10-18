'use strict';

const { closePgPool } = require('../../server/db/pg-connection');
const { stageTaskEffect, updateTaskEffect } = require('../../server/services/agent-task-transactions');

process.on('message', async message => {
    if (message?.type !== 'start') return;
    let keepRunning = false;
    try {
        const user = { id: Number(message.userId) };
        if (message.action === 'claim') {
            const effect = await updateTaskEffect(message.effectId, user, 'executing');
            process.send({ type: 'claimed', effectId: effect.id, pid: process.pid });
            // 保持进程存活，供父测试模拟执行期间的进程崩溃。
            keepRunning = true;
            setInterval(() => {}, 1000);
            return;
        }
        const effect = await stageTaskEffect(message.transactionId, user, {
            effectType: 'agent.http', resourceKeys: [message.resourceKey], idempotencyKey: message.operationKey,
            commitMode: 'after_verify', compensation: { mode: 'none' }
        });
        process.send({ type: 'result', ok: true, effectId: effect.id, pid: process.pid });
    } catch (error) {
        process.send({ type: 'result', ok: false, code: error.code || '', message: error.message || '', pid: process.pid });
    } finally {
        if (!keepRunning) {
            await closePgPool().catch(() => {});
            process.disconnect();
        }
    }
});

process.send({ type: 'ready', pid: process.pid });
