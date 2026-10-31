// 对话任务的快照、事件合并与展示状态，独立于 DOM 和模型协议。
(function initializeChatTaskState() {
    const terminal = new Set(['completed', 'completed_with_errors', 'partial', 'error', 'failed', 'cancelled', 'deleted']);
    const waiting = new Set(['needs_input', 'approval_required', 'waiting_approval', 'awaiting_approval', 'awaiting_commit']);
    const labels = Object.freeze({
        queued: '等待执行', planning: '正在安排执行步骤', running: '正在处理任务', executing: '正在执行操作',
        observing: '正在检查操作结果', diagnosing: '正在检查异常原因', replanning: '正在调整处理方案',
        resuming: '正在恢复任务', verifying: '正在核验结果', needs_input: '等待补充信息或继续',
        approval_required: '等待操作授权', waiting_approval: '等待审批决定', awaiting_approval: '等待审批决定',
        awaiting_commit: '等待确认提交外部操作', completed: '任务已完成', completed_with_errors: '任务完成，部分步骤有异常',
        partial: '任务部分完成', error: '任务执行失败', failed: '任务执行失败', cancelled: '任务已停止', deleted: '任务不可用'
    });

    function timestamp(value) {
        if (!value) return 0;
        const text = String(value);
        const normalized = /[zZ]|[+-]\d\d:\d\d$/.test(text) ? text : `${text.replace(' ', 'T')}+08:00`;
        return Date.parse(normalized) || 0;
    }

    function create(runId, sessionId) {
        return { runId: String(runId), sessionId: String(sessionId || ''), run: { id: String(runId), status: 'queued' },
            records: new Map(), highWater: -1, after: undefined, older: null, approval: null,
            verification: { status: 'unknown' }, artifacts: [], connection: 'loading',
            expanded: null, streaming: null };
    }

    function mergeRecord(state, record) {
        if (!record || !record.id) return;
        const key = record.kind === 'tool' && record.operationId ? `operation:${record.operationId}` : record.id;
        const previous = state.records.get(key);
        const firstAt = previous && timestamp(previous.firstAt) < timestamp(record.at) ? previous.firstAt : record.at;
        const firstSeq = previous?.firstSeq && record.seq ? Math.min(previous.firstSeq, record.seq) : previous?.firstSeq || record.seq || 0;
        if (previous && Number(previous.seq || 0) > Number(record.seq || 0)) {
            state.records.set(key, { ...previous, firstAt, firstSeq });
            return;
        }
        state.records.set(key, { ...previous, ...record, firstAt,
            firstSeq,
            durationMs: Number(record.durationMs || previous?.durationMs || 0) });
    }

    function applyFeed(state, feed, { history = false } = {}) {
        if (String(feed?.run?.id || '') !== state.runId || String(feed.run.session_id || state.sessionId) !== state.sessionId) return false;
        const highWater = Number(feed.cursor?.eventSeq || 0);
        const oldSnapshot = highWater < state.highWater
            || (highWater === state.highWater && timestamp(feed.run.updated_at) < timestamp(state.run.updated_at));
        if (oldSnapshot && !history) return false;
        [...(feed.legacySteps || []), ...(feed.events || [])].forEach(record => mergeRecord(state, record));
        if (!oldSnapshot && !history) {
            state.run = { ...feed.run };
            state.highWater = highWater;
            if (!history) state.after = Number(feed.nextAfter ?? highWater);
            state.approval = feed.approval || null;
            state.verification = feed.verification || { status: 'unknown' };
            state.artifacts = Array.isArray(feed.artifacts) ? feed.artifacts : [];
            state.warnings = Array.isArray(feed.warnings) ? feed.warnings : [];
            state.connection = 'connected';
            state.streaming = null;
        }
        if (history || state.older === null) state.older = feed.older || { hasMore: false };
        return true;
    }

    function records(state) {
        return [...state.records.values()].map(record => terminal.has(state.run.status) && ['running', 'preparing'].includes(record.status)
            ? { ...record, status: 'uncertain', detail: record.detail || '任务结束时尚未收到此操作的最终结果，请在详情中核实实际影响。' } : record).sort((left, right) => {
            if (left.firstSeq && right.firstSeq) return left.firstSeq - right.firstSeq;
            return timestamp(left.firstAt || left.at) - timestamp(right.firstAt || right.at) || String(left.id).localeCompare(String(right.id));
        });
    }

    function summary(state) {
        if (state.connection === 'forbidden') return '任务已删除或当前账号无权查看';
        const status = String(state.run.status || 'queued');
        if (terminal.has(status)) return state.run.statusText || labels[status];
        if (state.connection === 'unavailable') return state.highWater < 0 ? '任务进度暂时无法读取' : '暂时无法确认最新状态，正在重新连接';
        if (terminal.has(status) || waiting.has(status) || status === 'verifying') return state.run.statusText || labels[status];
        const running = records(state).reverse().find(record => record.kind === 'tool' && ['running', 'preparing'].includes(record.status));
        if (running) return `${running.status === 'preparing' ? '正在准备：' : '正在'}${running.title}`;
        return state.run.statusText || labels[status] || '正在确认任务状态';
    }

    function applyStreaming(state, payload) {
        if (state.connection === 'forbidden' || terminal.has(state.run.status) || waiting.has(state.run.status) || state.run.status === 'verifying') return false;
        if (payload.metadataOnly === true && state.streaming && (Number(payload.step || 0) < state.streaming.step
            || (Number(payload.step || 0) === state.streaming.step && state.streaming.completed && !payload.completed))) return false;
        state.streaming = { step: Number(payload.step || 0), preparingTool: Boolean(payload.partialToolCalls?.length), completed: payload.completed === true };
        return true;
    }

    function duration(milliseconds) {
        const value = Math.max(0, Number(milliseconds || 0));
        if (value < 1000) return value ? `${Math.round(value)} 毫秒` : '';
        if (value < 60000) return `${(value / 1000).toFixed(value < 10000 ? 1 : 0)} 秒`;
        return `${(value / 60000).toFixed(1)} 分钟`;
    }

    window.Pivot.exposeModule('chat.taskState', { create, applyFeed, applyStreaming, mergeRecord, records, summary, duration, timestamp,
        isTerminal: status => terminal.has(status), isWaiting: status => waiting.has(status), labels });
})();
