// 普通回复按账号和会话持有请求与消息节点；切换视图只重新挂载，不取消生成。
(function () {
    'use strict';
    const entries = new Set();
    const owner = () => String(window.Pivot.legacy.currentUser?.id || 'current-page');
    const session = () => String(window.Pivot.legacy.currentSessionId || '');
    const owned = entry => Boolean(entry && !entry.discarded && entry.userId === owner());
    const active = id => [...entries].reverse().find(entry => owned(entry) && !entry.finished && entry.sessionId === String(id));

    function syncControls() {
        for (const entry of entries) if (!owned(entry)) discard(entry);
        const entry = active(session());
        document.getElementById('send-btn')?.classList.toggle('hidden', Boolean(entry));
        document.getElementById('stop-btn')?.classList.toggle('hidden', !entry);
        window.Pivot.moduleApi('chat.taskSuggestion').setSendBusy?.(Boolean(entry));
        window.Pivot.moduleApi('chat.execution').syncController?.();
    }

    function discard(entry) {
        entry.discarded = true;
        entry.controller?.abort();
        entries.delete(entry);
    }

    async function run(operation) {
        for (const entry of entries) if (!owned(entry)) discard(entry);
        const prior = active(session());
        const entry = { userId: owner(), sessionId: session(), finished: false, superseded: false };
        if (prior) {
            prior.superseded = true;
            if (prior.controller) { prior.controller.pivotSupersededBySend = true; prior.controller.abort(); }
        }
        entries.add(entry);
        syncControls();
        entry.task = (async () => {
            if (prior?.task) { try { await prior.task; } catch (_) {} }
            if (!owned(entry) || entry.superseded || entry.stopped) return;
            await operation(entry);
        })();
        try { return await entry.task; }
        finally {
            entry.finished = true;
            if (!entry.assistant || entry.controller?.pivotAgentRunId || entry.ephemeralVoice || !owned(entry)) entries.delete(entry);
            const completed = [...entries].filter(item => item.finished);
            for (const old of completed.slice(0, Math.max(0, completed.length - 20))) entries.delete(old);
            syncControls();
        }
    }

    function bind(entry, options) {
        if (!entry) return;
        Object.assign(entry, options);
        if (!owned(entry) || entry.superseded || entry.stopped) entry.controller?.abort();
        syncControls();
    }

    function restore(sessionId, records = []) {
        if (String(sessionId) !== session()) return;
        const container = document.getElementById('message-container');
        if (!container) return;
        const ids = new Set(records.map(record => String(record.id)));
        const latestId = Math.max(0, ...records.map(record => Number(record.id) || 0));
        let prepared = false;
        for (const entry of entries) {
            if (!owned(entry) || entry.sessionId !== String(sessionId) || !entry.assistant || entry.ephemeralVoice || entry.controller?.pivotAgentRunId) continue;
            const assistantId = entry.assistant.dataset.messageId;
            const sourceId = String(entry.user?.dataset.messageId || entry.userMessageId || '');
            const sourceIndex = sourceId ? records.findIndex(record => record.role === 'user' && String(record.id) === sourceId) : -1;
            const following = sourceIndex < 0 || entry.regenerate ? [] : records.slice(sourceIndex + 1);
            const nextUser = following.findIndex(record => record.role === 'user');
            // 保存通知与历史请求可乱序；原用户消息之后已有助手记录时，优先保留服务端正文。
            const persisted = following.slice(0, nextUser < 0 ? following.length : nextUser).some(record => record.role === 'assistant');
            if (persisted) { if (entry.finished) entries.delete(entry); continue; }
            if (entry.finished && assistantId && (ids.has(assistantId) || latestId >= Number(assistantId))) { entries.delete(entry); continue; }
            if (!prepared) { window.Pivot.moduleApi('chat.messageVirtualizer').prepareForLiveAppend?.(); prepared = true; }
            for (const content of [entry.user, entry.assistant].filter(Boolean)) {
                const message = content.closest('.message');
                if (!message) continue;
                const id = content.dataset.messageId || message.dataset.messageId;
                if (id) for (const duplicate of container.querySelectorAll('.message')) {
                    if (duplicate !== message && String(duplicate.dataset.messageId || '') === id) duplicate.remove();
                }
                container.appendChild(message);
            }
            entry.restore?.();
        }
        syncControls();
    }

    function discardSession(id) {
        for (const entry of entries) if (entry.sessionId === String(id)) discard(entry);
        syncControls();
    }
    function clear() { for (const entry of entries) discard(entry); syncControls(); }
    window.addEventListener('pagehide', clear);
    window.Pivot.exposeModule('chat.generations', { run, bind, restore, owned, syncControls, discardSession, clear,
        busy: () => Boolean(active(session())), controller: () => active(session())?.controller || null,
        stop() { const entry = active(session()); if (entry) { entry.stopped = true; entry.controller?.abort(); } },
        stopVoiceRequest(id) { if (id) for (const entry of entries) if (owned(entry) && entry.controller?.pivotVoiceRequestId === id) entry.controller.abort(); }
    });
})();
