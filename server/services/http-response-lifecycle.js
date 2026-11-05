'use strict';

const observers = new WeakMap();

// 同一响应的指标、看门狗和交付观察共用结束监听，避免流式下载叠加大量 close 监听。
function onResponseSettled(response, listener) {
    let active = true;
    if (response.writableFinished || response.destroyed) {
        Promise.resolve().then(() => { if (active) listener(Boolean(response.writableFinished)); });
        return () => { active = false; };
    }
    let state = observers.get(response);
    if (!state) {
        const callbacks = new Set();
        const cleanup = () => {
            response.removeListener?.('finish', finish);
            response.removeListener?.('close', close);
            response.removeListener?.('error', close);
            observers.delete(response);
        };
        const settle = complete => {
            cleanup();
            const pending = [...callbacks]; callbacks.clear();
            for (const callback of pending) {
                try { callback(complete); }
                catch (_) { require('../logger').logger.warn('响应结束观察器处理失败'); }
            }
        };
        const finish = () => settle(true);
        const close = () => settle(Boolean(response.writableFinished));
        state = { callbacks, cleanup };
        observers.set(response, state);
        response.once('finish', finish); response.once('close', close); response.once('error', close);
    }
    const callback = complete => { if (active) listener(complete); };
    state.callbacks.add(callback);
    return () => { active = false; state.callbacks.delete(callback); if (!state.callbacks.size) state.cleanup(); };
}

module.exports = { onResponseSettled };
