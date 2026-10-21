// 持久任务进度统一读取、实时触发与退避恢复；模型流不决定业务完成状态。
(function initializeChatTaskController() {
    const entries = new Map();
    const cachedStates = new Map();
    const listeners = new Set();
    let source = null;
    let sessionEpoch = 0;
    const model = () => window.Pivot.moduleApi('chat.taskState');
    const current = entry => !entry.disposed && entry.epoch === sessionEpoch && String(currentSessionId || '') === entry.state.sessionId;

    function hasPendingDelivery(entry) {
        return entry.state.artifacts.some(artifact => ['pending', 'claimed'].includes(artifact.delivery?.state));
    }

    function needsSource() {
        return listeners.size || [...entries.values()].some(entry => current(entry) && entry.state.connection !== 'forbidden'
            && (!model().isTerminal(entry.state.run.status) || hasPendingDelivery(entry)));
    }

    function closeSource() {
        source?.close();
        source = null;
    }

    function syncSource() {
        if (!currentUser || !needsSource()) return closeSource();
        if (source || !window.EventSource || !currentUser) return;
        source = new EventSource(`${API_BASE}/events`, { withCredentials: true });
        source.addEventListener('connected', event => {
            listeners.forEach(listener => listener('connected', event));
            for (const entry of entries.values()) if (current(entry)) schedule(entry, 50);
        });
        for (const type of ['agent.event', 'agent.run', 'agent.notification', 'agent.streaming']) {
            source.addEventListener(type, event => {
                listeners.forEach(listener => listener(type, event));
                let payload;
                try { payload = JSON.parse(event.data || '{}'); } catch (_) { return; }
                const runId = String(payload.runId || payload.run?.id || payload.notification?.run_id || '');
                const entry = entries.get(runId);
                if (!entry || !current(entry)) return;
                if (type === 'agent.streaming') return handleStreaming(payload);
                // 持久原始事件可能含模型上下文，仅用标识触发白名单进度读取。
                if (type === 'agent.event' && !/^(?:run\.|tool\.|approval\.|control\.|transaction\.|sandbox\.denied$)/.test(String(payload.eventType || ''))) return;
                if (type === 'agent.event' && Number(payload.eventSeq || 0) <= entry.state.highWater) return;
                schedule(entry, 180);
            });
        }
        source.onerror = event => {
            listeners.forEach(listener => listener('error', event));
            for (const entry of entries.values()) {
                if (!current(entry) || model().isTerminal(entry.state.run.status)) continue;
                entry.state.connection = 'unavailable';
                render(entry);
                schedule(entry, 2500);
            }
        };
    }

    function schedule(entry, milliseconds) {
        clearTimeout(entry.timer);
        entry.timer = null;
        if (!current(entry) || document.hidden || entry.state.connection === 'forbidden') return;
        entry.timer = setTimeout(() => { void refresh(entry); }, milliseconds);
    }

    function renderAnswer(entry) {
        const { state, element } = entry;
        if (!element?.isConnected) return;
        if (state.highWater < 0 && entry.historical && !state.actionFeedback) return;
        const run = state.run;
        const body = element.querySelector('.text-body');
        const showAnswer = model().isTerminal(run.status) || model().isWaiting(run.status);
        const answer = state.connection === 'forbidden' ? '' : showAnswer
            ? (run.status === 'cancelled' || (model().isWaiting(run.status) && run.status !== 'needs_input') ? run.final_answer || ''
                : window.Pivot.legacy.chatAgentResultText?.(run) || run.final_answer || '') : '';
        if (body && entry.renderedAnswer !== answer) {
            window.Pivot.legacy.teardownPivotCharts?.(body);
            PivotSafeHtml.setHtml(body, answer ? renderAiMessage(answer, false) : '');
            entry.renderedAnswer = answer;
            if (answer) window.Pivot.legacy.renderPivotCharts?.(body);
        }
        if (run.messageId) window.Pivot.legacy.setMessageActionId?.(element, run.messageId);
        const footer = element.querySelector('.message-footer');
        if (footer && state.highWater >= 0) {
            let stats = footer.querySelector('.message-stats');
            if (!stats) {
                stats = document.createElement('div');
                stats.className = 'message-stats';
                footer.insertBefore(stats, footer.firstChild);
            }
            const end = model().timestamp(run.completed_at || run.updated_at);
            const start = model().timestamp(run.started_at || run.created_at);
            window.Pivot.moduleApi('chat.streaming').renderAgentTaskStats?.(stats, {
                modelName: run.model_name, costTime: start && end ? Math.max(0, (end - start) / 1000) : 0,
                inputTokens: run.input_tokens, outputTokens: run.output_tokens, totalTokens: run.total_tokens, status: run.status
            });
            footer.classList.remove('hidden', 'hover-time-only');
        }
    }

    function render(entry) {
        if (!current(entry) || document.hidden) return;
        if (entry.element?.isConnected) {
            const container = document.getElementById('message-container');
            const pinBottom = container && container.scrollHeight - container.scrollTop - container.clientHeight < 80;
            window.Pivot.moduleApi('chat.taskRender').render(entry);
            renderAnswer(entry);
            if (pinBottom && container) container.scrollTop = container.scrollHeight;
        }
    }

    async function refresh(entry, { reset = false } = {}) {
        if (!current(entry) || entry.state.connection === 'forbidden') return;
        if (entry.inFlight) {
            entry.refreshAgain = true;
            entry.pendingReset ||= reset;
            return entry.inFlight;
        }
        clearTimeout(entry.timer);
        entry.timer = null;
        const controlRevision = entry.controlRevision || 0;
        const isFreshRequest = () => current(entry) && controlRevision === (entry.controlRevision || 0);
        const fetchController = new AbortController();
        entry.fetchController = fetchController;
        const requestTimeout = setTimeout(() => fetchController.abort(), 15000);
        let nextDelay = null;
        entry.inFlight = (async () => {
            try {
                const params = new URLSearchParams({ limit: '40' });
                if (!reset && entry.state.after !== undefined) params.set('after', String(entry.state.after));
                const response = await apiFetch(`${API_BASE}/agents/runs/${encodeURIComponent(entry.runId)}/chat-feed?${params}`, { signal: fetchController.signal });
                if (!isFreshRequest()) return;
                if ([403, 404].includes(response.status)) {
                    entry.state.connection = 'forbidden';
                    entry.state.run = { id: entry.runId, status: 'deleted' };
                    entry.state.records.clear();
                    entry.state.artifacts = [];
                    entry.state.approval = null;
                    render(entry);
                    return;
                }
                if (response.status === 409 && !reset) {
                    entry.state.highWater = -1;
                    entry.state.after = undefined;
                    entry.state.older = null;
                    entry.state.records.clear();
                    entry.refreshAgain = true;
                    entry.pendingReset = true;
                    return;
                }
                if (!response.ok) throw new Error('任务进度暂时不可用');
                const feed = await response.json();
                if (!isFreshRequest() || !model().applyFeed(entry.state, feed)) return;
                entry.failures = 0;
                render(entry);
                if (feed.run.terminal && entry.finishedStatus !== feed.run.status) {
                    entry.finishedStatus = feed.run.status;
                    window.Pivot.legacy.loadSessions?.();
                    window.Pivot.legacy.refreshCurrentContextUsage?.(entry.state.sessionId);
                }
                nextDelay = feed.hasMore ? 60 : feed.pollAfterMs;
                if (hasPendingDelivery(entry)) nextDelay ||= 4000;
                if (feed.run.terminal && !feed.run.messageId && entry.terminalReadCount++ < 4) nextDelay ||= 1200;
            } catch (_) {
                if (!isFreshRequest()) return;
                entry.state.connection = 'unavailable';
                entry.failures = (entry.failures || 0) + 1;
                render(entry);
                if (!model().isTerminal(entry.state.run.status)) nextDelay = Math.min(1500 * 2 ** Math.min(entry.failures, 5), 30000);
            } finally {
                clearTimeout(requestTimeout);
                if (entry.fetchController === fetchController) entry.fetchController = null;
                entry.inFlight = null;
                if (!current(entry)) return;
                if (entry.refreshAgain) {
                    const pendingReset = entry.pendingReset;
                    entry.refreshAgain = false;
                    entry.pendingReset = false;
                    entry.timer = setTimeout(() => { void refresh(entry, { reset: pendingReset }); }, 50);
                } else if (nextDelay) schedule(entry, nextDelay);
                syncSource();
            }
        })();
        return entry.inFlight;
    }

    function applyControlResult(entry, result, feedback = '') {
        if (!current(entry) || !result?.run?.id) return false;
        if (result.run.id !== entry.runId) replaceRun(entry, result.run.id);
        entry.controlRevision = (entry.controlRevision || 0) + 1;
        entry.fetchController?.abort();
        clearTimeout(entry.timer);
        entry.timer = null;
        const run = result.run;
        const status = String(run.status || '');
        if (!model().labels[status]) return false;
        entry.state.run = { ...entry.state.run, status, statusText: model().labels[status],
            title: run.title || entry.state.run.title, final_answer: run.final_answer || entry.state.run.final_answer || '',
            updated_at: run.updated_at || entry.state.run.updated_at,
            completed_at: run.completed_at || null, terminal: model().isTerminal(status), waiting: model().isWaiting(status) };
        if (status !== 'approval_required') entry.state.approval = null;
        entry.state.actionFeedback = feedback;
        render(entry);
        syncSource();
        return true;
    }

    function attach(element, runId, { sessionId = currentSessionId, status = '', title = '', historical = false } = {}) {
        const id = String(runId || '');
        if (!id || !element || String(sessionId || '') !== String(currentSessionId || '')) return null;
        let entry = entries.get(id);
        if (entry && current(entry)) {
            if (entry.element !== element) {
                entry.element = element;
                entry.renderedHtml = null;
                entry.renderedAnswer = undefined;
            }
        } else {
            const state = cachedStates.get(id) || model().create(id, sessionId);
            if (status && state.highWater < 0) state.run.status = status;
            if (title && !state.run.title) state.run.title = title;
            entry = { runId: id, element, state, epoch: sessionEpoch, disposed: false, terminalReadCount: 0, historical };
            entries.set(id, entry);
            cachedStates.set(id, state);
        }
        for (const [key, item] of entries) {
            if (key !== id && model().isTerminal(item.state.run.status) && !item.element?.isConnected) {
                clearTimeout(item.timer);
                item.disposed = true;
                entries.delete(key);
            }
        }
        if (cachedStates.size > 80) {
            for (const key of cachedStates.keys()) {
                if (!entries.has(key)) cachedStates.delete(key);
                if (cachedStates.size <= 80) break;
            }
        }
        element.dataset.chatAgentRunId = id;
        element.dataset.chatAgentTaskManaged = 'true';
        element.querySelector('.chat-agent-controls')?.remove();
        if (entry.state.highWater >= 0) render(entry);
        if (!entry.inFlight && !entry.timer && (entry.state.highWater < 0 || !model().isTerminal(entry.state.run.status))) schedule(entry, 0);
        return entry;
    }

    function attachHistorical(element, runId) {
        const sessionId = String(currentSessionId || '');
        setTimeout(() => {
            if (element?.isConnected && sessionId === String(currentSessionId || '')) attach(element, runId, { sessionId, historical: true });
        }, 0);
    }

    async function loadOlder(entry) {
        const older = entry.state.older;
        if (!older?.hasMore || !current(entry)) return;
        const params = new URLSearchParams({ limit: '40' });
        if (older.before) params.set('before', String(older.before));
        if (older.beforeStep) params.set('beforeStep', String(older.beforeStep));
        const response = await apiFetch(`${API_BASE}/agents/runs/${encodeURIComponent(entry.runId)}/chat-feed?${params}`);
        if (!response.ok) throw new Error('读取更早的执行记录失败，请稍后重试。');
        const feed = await response.json();
        if (current(entry) && model().applyFeed(entry.state, feed, { history: true })) render(entry);
    }

    function replaceRun(entry, nextRunId) {
        entries.delete(entry.runId);
        clearTimeout(entry.timer);
        const previous = entry.state;
        entry.runId = String(nextRunId);
        entry.state = model().create(entry.runId, previous.sessionId);
        entry.state.records = new Map([...previous.records].map(([key, record]) => [key, { ...record, firstSeq: 0 }]));
        entry.state.expanded = previous.expanded;
        entry.renderedHtml = null;
        entry.finishedStatus = null;
        entry.element.dataset.chatAgentRunId = entry.runId;
        entries.set(entry.runId, entry);
        cachedStates.set(entry.runId, entry.state);
    }

    function detachAll() {
        sessionEpoch += 1;
        for (const entry of entries.values()) {
            entry.disposed = true;
            clearTimeout(entry.timer);
            entry.fetchController?.abort();
        }
        entries.clear();
        cachedStates.clear();
        syncSource();
    }

    function handleStreaming(payload) {
        const entry = entries.get(String(payload?.runId || ''));
        if (entry && current(entry)) model().applyStreaming(entry.state, payload);
    }

    function subscribe(listener) {
        listeners.add(listener);
        syncSource();
        return () => { listeners.delete(listener); syncSource(); };
    }

    document.addEventListener('visibilitychange', () => {
        for (const entry of entries.values()) {
            clearTimeout(entry.timer);
            entry.timer = null;
            if (!document.hidden && current(entry)) schedule(entry, 50);
        }
    });
    window.addEventListener('pagehide', closeSource);
    window.Pivot.exposeModule('chat.tasks', { attach, attachHistorical, refresh, loadOlder, replaceRun, applyControlResult,
        renderEntry: render, detachAll, handleStreaming, subscribe });
})();
