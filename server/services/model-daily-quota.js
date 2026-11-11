'use strict';
const { estimateTokens } = require('../llm');
const { ConcurrencySemaphore } = require('./concurrency');
const reservations = new Map();
const admissions = new Map();

function getInflightQuota(userId, modelId) { return reservations.get(`${userId}:${modelId}`) || 0; }

function reserveInflightQuota(userId, modelId, tokens) {
    const key = `${userId}:${modelId}`, amount = Math.max(0, Number(tokens) || 0);
    reservations.set(key, (reservations.get(key) || 0) + amount);
    let released = false;
    return () => {
        if (released) return;
        released = true;
        const remaining = (reservations.get(key) || 0) - amount;
        if (remaining > 0) reservations.set(key, remaining); else reservations.delete(key);
        const admission = admissions.get(key);
        if (admission) admission.settlementRevision++;
    };
}

async function ensureModelQuota(user, model, messages, maxOutputTokens, { signal } = {}) {
    const limit = Number(model?.daily_token_limit || 0);
    if (limit <= 0) return () => {};
    const key = `${user.id}:${model.id}`;
    let admission = admissions.get(key);
    if (!admission) {
        admission = { semaphore: new ConcurrencySemaphore({ maxConcurrent: 1, maxQueueSize: 256, queueTimeoutMs: 60000 }), references: 0, settlementRevision: 0 };
        admissions.set(key, admission);
    }
    admission.references++;
    let acquired = false;
    try {
        await admission.semaphore.acquire({ signal });
        acquired = true;
        let used, revision;
        do {
            revision = admission.settlementRevision;
            used = await require('./models').getModelDailyUsageAsync(user.id, model.id);
            signal?.throwIfAborted();
        } while (revision !== admission.settlementRevision);
        const estimated = estimateTokens(JSON.stringify(messages)) + Math.max(1, Number(maxOutputTokens) || 1200);
        if (used + getInflightQuota(user.id, model.id) + estimated > limit) {
            throw Object.assign(new Error('模型今日额度不足以继续调用，请提高额度或切换模型。'), { status: 429, statusCode: 429, code: 'INSUFFICIENT_QUOTA' });
        }
        // 接纳串行化到预留登记为止；上游调用继续按原模型并发执行。
        return reserveInflightQuota(user.id, model.id, estimated);
    } finally {
        if (acquired) admission.semaphore.release();
        if (--admission.references === 0) admissions.delete(key);
    }
}

module.exports = { ensureModelQuota, getInflightQuota, reserveInflightQuota };
