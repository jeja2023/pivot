const { estimateTokens } = require('../../llm');
const { getModelDailyUsageAsync } = require('../models');

/**
 * 全量语义分析的每日额度并发安全职责。
 *
 * getModelDailyUsageAsync 读到的用量已包含待落账队列，但"已发起、尚未返回"的批次
 * 仍是一段空窗：并发批次会同时通过检查，进而超发每日 Token。这里用进程内预留量
 * 补齐这段窗口，让额度受限的模型也能并发批次，而不必把批次并发压回串行。
 */

const inflightQuotaReservations = new Map();
const noopQuotaRelease = () => {};

function reserveInflightQuota(userId, modelId, tokens) {
    const key = `${userId}:${modelId}`;
    const amount = Math.max(0, Number(tokens) || 0);
    inflightQuotaReservations.set(key, (inflightQuotaReservations.get(key) || 0) + amount);
    let released = false;
    return () => {
        if (released) return;
        released = true;
        const rest = (inflightQuotaReservations.get(key) || 0) - amount;
        if (rest > 0) inflightQuotaReservations.set(key, rest);
        else inflightQuotaReservations.delete(key);
    };
}

function getInflightQuota(userId, modelId) {
    return inflightQuotaReservations.get(`${userId}:${modelId}`) || 0;
}

/**
 * 校验每日额度并为本次调用登记预留量。
 * 返回的释放函数必须在模型调用结束后执行，否则预留量会长期占位并误判额度不足。
 */
async function ensureSemanticQuota(user, model, messages, maxOutputTokens) {
    const limit = Number(model?.daily_token_limit || 0);
    if (limit <= 0) return noopQuotaRelease;
    const estimated = estimateTokens(JSON.stringify(messages)) + Math.max(256, Number(maxOutputTokens) || 1200);
    const used = await getModelDailyUsageAsync(user.id, model.id);
    // used 已含待落账队列，inflight 补上"已发起但尚未返回"的并发批次，两者之和才是真实占用。
    if (used + getInflightQuota(user.id, model.id) + estimated > limit) {
        const err = new Error('模型今日额度不足以继续完成全量语义分析，请提高额度或切换模型。');
        err.status = 429;
        err.code = 'INSUFFICIENT_QUOTA';
        throw err;
    }
    return reserveInflightQuota(user.id, model.id, estimated);
}

module.exports = {
    reserveInflightQuota,
    getInflightQuota,
    ensureSemanticQuota
};
