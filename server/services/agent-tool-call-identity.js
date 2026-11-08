'use strict';

const crypto = require('node:crypto');

function normalizeAgentStepId(value) {
    const original = String(value || '');
    // 旧的短标识保持不变；长标识使用完整摘要，不能截断具有共同前缀的不同调用。
    return original.length <= 64 ? original : crypto.createHash('sha256').update(original).digest('hex');
}

function agentToolStepId(runId, step, callId) {
    return normalizeAgentStepId(`${runId}:${step}:${callId}`);
}

function normalizeAgentOperationKey(value) {
    const original = String(value || '');
    return original.length <= 255 ? original : `operation_${crypto.createHash('sha256').update(original).digest('hex')}`;
}

module.exports = { agentToolStepId, normalizeAgentStepId, normalizeAgentOperationKey };
