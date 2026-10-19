/* DAG 执行链路甘特耗时瀑布图与性能度量模块 */

(function () {
    let closeCurrentModal = null;
    function timestamp(value) {
        if (typeof value === 'number') return value;
        if (!value) return null;
        const text = String(value).replace(' ', 'T');
        const parsed = Date.parse(/(?:Z|[+-]\d\d:?\d\d)$/i.test(text) ? text : `${text}+08:00`);
        return Number.isFinite(parsed) ? parsed : null;
    }
    const escapeHtml = (text) => {
        if (!text) return '';
        return String(text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    };

    /**
     * 计算工作流节点的甘特耗时瀑布数据
     */
    function computeTimelineData(nodes = [], runStates = new Map(), { now = Date.now(), defaultStatus = 'pending' } = {}) {
        const list = Array.isArray(nodes) ? nodes : [];
        const stateMap = runStates instanceof Map ? runStates : new Map(Object.entries(runStates || {}));

        let totalDurationMs = 0;
        let cachedCount = 0;
        let completedCount = 0;
        let errorCount = 0;
        let runningCount = 0;

        const items = list.map((node, index) => {
            const state = stateMap.get(node.id) || {};
            const startedAt = timestamp(state.startedAt || state.started_at);
            const completedAt = timestamp(state.completedAt || state.completed_at);
            const status = state.status || defaultStatus;
            const durationMs = Math.max(0, Number(state.durationMs ?? state.duration_ms) ||
                (startedAt !== null ? (status === 'running' ? now : completedAt ?? startedAt) - startedAt : 0));
            const isCached = Boolean(state.cached || state.status === 'cached');

            if (isCached) cachedCount += 1;
            if (status === 'completed' || status === 'cached') completedCount += 1;
            if (status === 'error' || status === 'continued_error') errorCount += 1;
            if (status === 'running') runningCount += 1;

            totalDurationMs += durationMs;

            return {
                id: node.id,
                title: node.title || node.id,
                tool: node.tool || '未配置',
                status,
                isCached,
                durationMs,
                startedAt: startedAt ?? (completedAt !== null ? completedAt - durationMs : null),
                order: index
            };
        });

        const timedItems = items.filter(item => item.startedAt !== null);
        const firstStart = timedItems.length ? Math.min(...timedItems.map(item => item.startedAt)) : 0;
        const elapsedDurationMs = timedItems.length
            ? Math.max(...timedItems.map(item => item.startedAt + item.durationMs)) - firstStart : totalDurationMs;

        // 计算相对占比与瀑布偏移
        let accumulatedMs = 0;
        const waterfallItems = items.map(item => {
            const offsetPercent = elapsedDurationMs > 0 && item.durationMs > 0
                ? Math.max(0, Math.min(((item.startedAt !== null ? item.startedAt - firstStart : accumulatedMs) / elapsedDurationMs) * 100, 100)) : 0;
            const widthPercent = item.durationMs > 0
                ? Math.min(Math.max((item.durationMs / Math.max(elapsedDurationMs, 1)) * 100, 0.5), 100 - offsetPercent) : 0;

            accumulatedMs += item.durationMs;

            return {
                ...item,
                widthPercent: Number(widthPercent.toFixed(1)),
                offsetPercent: Number(offsetPercent.toFixed(1)),
                isSlow: item.durationMs >= 3000
            };
        });

        return {
            totalDurationMs,
            elapsedDurationMs,
            totalNodes: list.length,
            completedCount,
            cachedCount,
            errorCount,
            runningCount,
            slowCount: waterfallItems.filter(i => i.isSlow).length,
            items: waterfallItems
        };
    }

    /**
     * 弹出甘特耗时瀑布图弹层
     */
    function showTimelineWaterfallModal({ nodes = [], runStates = new Map(), onFocusNode, loadState } = {}) {
        const safeHtml = window.Pivot?.html;
        if (typeof safeHtml?.setHtml !== 'function' || typeof document === 'undefined') return;

        closeCurrentModal?.();
        const existing = document.querySelector('.pivot-dag-waterfall-modal-backdrop');
        if (existing) existing.remove();

        const modal = document.createElement('div');
        modal.className = 'pivot-dag-waterfall-modal-backdrop';
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');
        modal.setAttribute('aria-label', '工作流执行耗时甘特瀑布图');
        const controller = new AbortController();
        let timer;
        let inFlight = false;
        let snapshot = { runStates, loading: Boolean(loadState), message: loadState ? '正在加载实际运行记录…' : '' };
        const close = () => { clearInterval(timer); controller.abort(); modal.remove(); if (closeCurrentModal === close) closeCurrentModal = null; };
        closeCurrentModal = close;

        function render() {
        const activeElement = document.activeElement;
        const focusedId = modal.contains(activeElement) ? activeElement?.getAttribute('data-node-id') : null;
        const closeFocused = modal.contains(activeElement) && activeElement?.matches('.pivot-dag-waterfall-close');
        const scrollTop = modal.querySelector('.pivot-dag-waterfall-list')?.scrollTop || 0;
        const terminal = ['completed', 'partial', 'error', 'cancelled'].includes(snapshot.run?.status);
        const data = computeTimelineData(nodes, snapshot.runStates, {
            defaultStatus: snapshot.error ? 'unknown' : snapshot.loading ? 'loading' : snapshot.run === null ? 'not_started' : terminal ? 'not_run' : 'pending'
        });

        const totalSeconds = (data.elapsedDurationMs / 1000).toFixed(2);

        const rowsHtml = data.items.map(item => {
            const labels = { completed: '已完成', running: '运行中', error: '失败', continued_error: '异常后继续',
                pending: '待调度', not_started: '尚未运行', not_run: '未执行', skipped: '已跳过', cancelled: '已取消',
                needs_input: '已暂停', approval_required: '等待审批', awaiting_approval: '等待审批', loading: '加载中', unknown: '未获取数据' };
            const tone = item.isCached ? 'cached' : item.status === 'completed' ? 'completed'
                : item.status === 'running' ? 'running' : ['error', 'continued_error'].includes(item.status) ? 'error' : 'pending';
            const statusBadge = `<span class="waterfall-badge is-${tone}">${item.isCached ? '缓存' : labels[terminal && item.status === 'pending' ? 'not_run' : item.status] || '待调度'}</span>`;

            const durationText = item.isCached
                ? '0ms'
                : item.durationMs >= 1000
                    ? `${(item.durationMs / 1000).toFixed(2)}s`
                    : item.durationMs > 0 ? `${item.durationMs}ms` : '—';

            const barColorClass = item.isCached
                ? 'is-bar-cached'
                : item.isSlow
                    ? 'is-bar-slow'
                    : item.status === 'error'
                        ? 'is-bar-error'
                        : 'is-bar-normal';

            return `
                <div class="pivot-waterfall-row" data-node-id="${escapeHtml(item.id)}" role="button" tabindex="0" title="点击定位至该节点">
                    <div class="pivot-waterfall-row-meta">
                        <span class="pivot-waterfall-node-name">${escapeHtml(item.title)}</span>
                        <span class="pivot-waterfall-tool-tag">${escapeHtml(item.tool)}</span>
                        ${statusBadge}
                    </div>
                    <div class="pivot-waterfall-track">
                        <div class="pivot-waterfall-bar ${barColorClass}" data-bar-width="${item.widthPercent}" data-bar-offset="${item.offsetPercent}"></div>
                    </div>
                    <div class="pivot-waterfall-duration ${item.isSlow ? 'is-slow-text' : ''}">${escapeHtml(durationText)}</div>
                </div>
            `;
        }).join('');

        const markup = `
            <div class="pivot-dag-waterfall-card">
                <div class="pivot-dag-waterfall-header">
                    <div class="pivot-dag-waterfall-title">
                        <span>工作流执行耗时甘特瀑布图</span>
                    </div>
                    <button class="workspace-modal-close pivot-dag-waterfall-close" type="button" aria-label="关闭">×</button>
                </div>
                <div class="pivot-dag-waterfall-summary">
                    <span class="summary-chip">总耗时: <strong>${escapeHtml(totalSeconds)}s</strong></span>
                    <span class="summary-chip">总节点: <strong>${data.totalNodes}</strong></span>
                    <span class="summary-chip is-success">已完成: <strong>${data.completedCount}</strong></span>
                    <span class="summary-chip is-cyan">快取复用: <strong>${data.cachedCount}</strong></span>
                    ${data.slowCount > 0 ? `<span class="summary-chip is-warning">慢节点: <strong>${data.slowCount}</strong></span>` : ''}
                    ${data.errorCount > 0 ? `<span class="summary-chip is-danger">异常: <strong>${data.errorCount}</strong></span>` : ''}
                </div>
                ${snapshot.message ? `<p class="pivot-dag-waterfall-status" role="status">${escapeHtml(snapshot.message)}</p>` : ''}
                <div class="pivot-dag-waterfall-list">
                    ${rowsHtml || '<div class="pivot-waterfall-empty">暂无节点执行数据，试跑工作流后即可查看完整耗时链路。</div>'}
                </div>
            </div>
        `;

        safeHtml.setHtml(modal, markup);

        modal.querySelectorAll('.pivot-waterfall-bar[data-bar-width]').forEach(bar => {
            const width = bar.getAttribute('data-bar-width');
            if (width) bar.style.width = `${width}%`;
            bar.style.marginLeft = `${bar.getAttribute('data-bar-offset') || 0}%`;
        });
        const list = modal.querySelector('.pivot-dag-waterfall-list');
        if (list) list.scrollTop = scrollTop;
        if (closeFocused) modal.querySelector('.pivot-dag-waterfall-close')?.focus();
        if (focusedId) [...modal.querySelectorAll('.pivot-waterfall-row')].find(row => row.getAttribute('data-node-id') === focusedId)?.focus();
        }

        render();
        document.body.appendChild(modal);
        modal.querySelector('.pivot-dag-waterfall-close')?.focus();
        modal.addEventListener('click', (e) => {
            if (e.target === modal || e.target.closest('.pivot-dag-waterfall-close')) { close(); return; }
            const row = e.target.closest('.pivot-waterfall-row');
            const id = row?.getAttribute('data-node-id');
            if (id && typeof onFocusNode === 'function') { onFocusNode(id); close(); }
        });
        modal.addEventListener('keydown', event => {
            if (event.key === 'Escape') close();
            else if (['Enter', ' '].includes(event.key) && event.target.matches('.pivot-waterfall-row')) { event.preventDefault(); event.target.click(); }
        });
        const refresh = async () => {
            if (!modal.isConnected) { close(); return; }
            if (inFlight) return;
            inFlight = true;
            try {
                if (loadState) snapshot = await loadState({ signal: controller.signal });
                if (!controller.signal.aborted) render();
            } catch (error) {
                if (!controller.signal.aborted) { snapshot.loading = false; snapshot.error = true; snapshot.message = error.message || '加载执行耗时失败，请稍后重试。'; render(); }
            } finally { inFlight = false; }
        };
        if (loadState) { void refresh(); timer = setInterval(refresh, 1500); }
    }

    if (typeof window !== 'undefined' && window.Pivot?.registerModule) {
        window.Pivot.registerModule('agent.dagTimeline', {
            computeTimelineData,
            showTimelineWaterfallModal
        });
    }

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = {
            computeTimelineData
        };
    }
})();
