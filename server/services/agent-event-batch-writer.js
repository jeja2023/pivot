'use strict';
// @ts-check

// 将短时间内的审计事件合并，同时保留单条失败时的独立重试能力。
/** @param {{recordBatch?: (events: any[]) => Promise<any>, recordOne?: (event: any) => Promise<any>, onFailure?: (details: {failed: number, attempted: number}) => void, maxBatchSize?: number, intervalMs?: number}} [options] */
function createAgentEventBatchWriter({ recordBatch, recordOne, onFailure, maxBatchSize = 16, intervalMs = 2000 } = {}) {
    const batchSize = Math.max(1, Math.min(Number(maxBatchSize) || 16, 256));
    const delay = Math.max(50, Math.min(Number(intervalMs) || 2000, 10000));
    const pending = [];
    let timer = null;
    let chain = Promise.resolve();
    let closed = false;

    function flush() {
        if (timer) clearTimeout(timer);
        timer = null;
        if (!pending.length) return chain;
        const events = pending.splice(0, pending.length);
        chain = chain.then(async () => {
            if (typeof recordBatch === 'function') {
                try { await recordBatch(events); return; } catch (_) {}
            }
            let failed = 0;
            if (typeof recordOne === 'function') {
                for (const event of events) {
                    try { await recordOne(event); } catch (_) { failed += 1; }
                }
            } else failed = events.length;
            if (failed && typeof onFailure === 'function') {
                try { onFailure({ failed, attempted: events.length }); } catch (_) {}
            }
        });
        return chain;
    }

    function push(event) {
        if (closed) return;
        pending.push(event);
        if (pending.length >= batchSize) { void flush(); return; }
        if (!timer) {
            timer = setTimeout(() => { void flush(); }, delay);
            timer.unref?.();
        }
    }

    function finish() { closed = true; return flush(); }
    return { push, flush, finish };
}

module.exports = { createAgentEventBatchWriter };
