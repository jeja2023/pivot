'use strict';

function intentTimeout() {
    return Object.assign(new Error('任务理解超过等待时间，本轮仅提供文本回复，请稍后重试实际操作。'), { code: 'CHAT_INTENT_TIMEOUT' });
}

function createChatIntentBudget({ signal, timeoutMs = 30000, deadlineAt } = {}) {
    const startedAt = Date.now();
    const deadline = Math.min(Number(deadlineAt) || Infinity, startedAt + Math.max(1, Number(timeoutMs) || 30000));
    const controller = new AbortController();
    const timings = {};
    const stages = new Map();
    let timeoutStage = '';
    const cancel = () => controller.abort(signal.reason instanceof Error ? signal.reason : new Error('任务理解已取消'));
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    const timer = setTimeout(() => {
        timeoutStage = [...stages.values()].at(-1)?.stage || '';
        controller.abort(intentTimeout());
    }, Math.max(0, deadline - Date.now()));
    const remainingMs = () => Math.max(0, deadline - Date.now());

    async function run(stage, invoke, options = {}) {
        if (controller.signal.aborted) throw controller.signal.reason;
        const began = Date.now();
        // 可选读取必须留出收尾时间，不能在总截止到达时推翻已完成的语义判断。
        const available = remainingMs() - (options.optional ? Math.max(25, Number(options.reserveMs) || 100) : 0);
        if (options.optional && available <= 0) return options.fallback;
        const stageKey = Symbol(stage);
        stages.set(stageKey, { stage, began });
        const child = new AbortController();
        let stageTimer;
        let onAbort;
        try {
            const result = await new Promise((resolve, reject) => {
                onAbort = () => { child.abort(controller.signal.reason); reject(controller.signal.reason); };
                controller.signal.addEventListener('abort', onAbort, { once: true });
                if (controller.signal.aborted) { onAbort(); return; }
                if (!remainingMs()) { controller.abort(intentTimeout()); return; }
                if (options.timeoutMs !== undefined || options.optional) stageTimer = setTimeout(() => {
                    const error = Object.assign(new Error('任务理解的可选上下文暂不可用'), { code: 'CHAT_INTENT_STAGE_TIMEOUT' });
                    child.abort(error); reject(error);
                }, Math.max(1, Math.min(Number(options.timeoutMs) || available, available)));
                Promise.resolve().then(() => {
                    if (child.signal.aborted) throw child.signal.reason;
                    return invoke(child.signal);
                }).then(resolve, reject);
            });
            return result;
        } catch (error) {
            if (options.optional && !controller.signal.aborted) return options.fallback;
            throw error;
        } finally {
            timings[stage] = (timings[stage] || 0) + Date.now() - began;
            stages.delete(stageKey);
            clearTimeout(stageTimer);
            controller.signal.removeEventListener('abort', onAbort);
        }
    }

    return { signal: controller.signal, deadlineAt: deadline, remainingMs, run, timings,
        snapshot() { return { stage: timeoutStage || [...stages.values()].at(-1)?.stage || '', timings: { ...timings,
            ...Object.fromEntries([...stages.values()].map(item => [item.stage, (timings[item.stage] || 0) + Date.now() - item.began])) } }; },
        dispose() { clearTimeout(timer); signal?.removeEventListener('abort', cancel); } };
}

module.exports = { createChatIntentBudget };
