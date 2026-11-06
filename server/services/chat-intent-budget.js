'use strict';

function intentTimeout() {
    return Object.assign(new Error('任务理解超过等待时间，本轮仅提供文本回复，请稍后重试实际操作。'), { code: 'CHAT_INTENT_TIMEOUT' });
}

function createChatIntentBudget({ signal, timeoutMs = 30000, deadlineAt } = {}) {
    const startedAt = Date.now();
    const deadline = Math.min(Number(deadlineAt) || Infinity, startedAt + Math.max(1, Number(timeoutMs) || 30000));
    const controller = new AbortController();
    const timings = {};
    const cancel = () => controller.abort(signal.reason instanceof Error ? signal.reason : new Error('任务理解已取消'));
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    const timer = setTimeout(() => controller.abort(intentTimeout()), Math.max(0, deadline - Date.now()));
    const remainingMs = () => Math.max(0, deadline - Date.now());

    async function run(stage, invoke, options = {}) {
        const began = Date.now();
        const child = new AbortController();
        let stageTimer;
        let onAbort;
        try {
            const result = await new Promise((resolve, reject) => {
                onAbort = () => { child.abort(controller.signal.reason); reject(controller.signal.reason); };
                controller.signal.addEventListener('abort', onAbort, { once: true });
                if (controller.signal.aborted) { onAbort(); return; }
                if (!remainingMs()) { controller.abort(intentTimeout()); return; }
                if (options.timeoutMs !== undefined) stageTimer = setTimeout(() => {
                    const error = Object.assign(new Error('任务理解的可选上下文暂不可用'), { code: 'CHAT_INTENT_STAGE_TIMEOUT' });
                    child.abort(error); reject(error);
                }, Math.max(1, Math.min(options.timeoutMs, remainingMs())));
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
            clearTimeout(stageTimer);
            controller.signal.removeEventListener('abort', onAbort);
        }
    }

    return { signal: controller.signal, deadlineAt: deadline, remainingMs, run, timings,
        dispose() { clearTimeout(timer); signal?.removeEventListener('abort', cancel); } };
}

module.exports = { createChatIntentBudget };
